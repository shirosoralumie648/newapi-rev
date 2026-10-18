/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
package model

import (
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

var (
	// ErrPlaygroundCanvasSnapshotNotFound reports a snapshot id that does not
	// belong to the account's canvas.
	ErrPlaygroundCanvasSnapshotNotFound = errors.New("Playground canvas snapshot not found.")
)

// playgroundCanvasSnapshotIntervalUnit converts the policy interval in minutes
// to the stored second timestamps.
const playgroundCanvasSnapshotIntervalUnit = 60

// PlaygroundCanvasSnapshot is one stored history entry of a canvas document.
// The document bytes are gzip-compressed in the object store and only the
// metadata — revision, size, hash, backend, key — stays in the database, so a
// board's history never inflates the primary database. Snapshots are written by
// the canvas save transaction and count against the account's snapshot count
// and byte budgets; a purge removes the rows and their objects together.
type PlaygroundCanvasSnapshot struct {
	ID       string `gorm:"size:32;primaryKey"`
	CanvasID string `gorm:"size:32;not null;index:idx_playground_canvas_snapshot_canvas,priority:1"`
	UserID   int    `gorm:"not null;index:idx_playground_canvas_snapshot_canvas,priority:2"`
	Revision int64  `gorm:"not null"`
	// NodeCount and EdgeCount come from the snapshotted document, so a history
	// listing can describe an entry without reading its object.
	NodeCount       int    `gorm:"not null"`
	EdgeCount       int    `gorm:"not null"`
	ByteSize        int64  `gorm:"not null"`
	StorageBackend  string `gorm:"size:32;not null"`
	ObjectKey       string `gorm:"size:512;not null"`
	ContentEncoding string `gorm:"size:16;not null"`
	ContentHash     string `gorm:"size:64;not null"`
	CreatedAt       int64  `gorm:"not null;index"`
}

// TableName pins the table name the plan defines; GORM would otherwise
// pluralize the model name.
func (PlaygroundCanvasSnapshot) TableName() string {
	return "playground_canvas_snapshots"
}

// PlaygroundCanvasSnapshotSummary describes one history entry to the owner.
// The document itself is only returned by the restore/read path.
type PlaygroundCanvasSnapshotSummary struct {
	ID        string `json:"id"`
	CanvasID  string `json:"canvas_id"`
	Revision  int64  `json:"revision"`
	NodeCount int    `json:"node_count"`
	EdgeCount int    `json:"edge_count"`
	ByteSize  int64  `json:"byte_size"`
	CreatedAt int64  `json:"created_at"`
}

func playgroundCanvasSnapshotSummary(snapshot *PlaygroundCanvasSnapshot) PlaygroundCanvasSnapshotSummary {
	return PlaygroundCanvasSnapshotSummary{
		ID: snapshot.ID, CanvasID: snapshot.CanvasID, Revision: snapshot.Revision,
		NodeCount: snapshot.NodeCount, EdgeCount: snapshot.EdgeCount,
		ByteSize: snapshot.ByteSize, CreatedAt: snapshot.CreatedAt,
	}
}

// capturePlaygroundCanvasSnapshot records one history entry of a document
// inside the caller's write transaction. The document is gzip-compressed into
// the shared object store; the row keeps only metadata, and the account
// counters move in the same transaction.
//
// The policy decides when a save deserves an entry: the first snapshot of a
// board always counts, afterwards one per CanvasSnapshotEverySaves saves or per
// CanvasSnapshotIntervalMinutes, whichever comes first. A forced capture (the
// state a restore replaces) bypasses those triggers. A document identical to
// the newest snapshot (same content hash) is never stored twice.
//
// Entries beyond the per-board cap are pruned to make room; when the account
// budget cannot take the new entry it is skipped, so a full budget never
// deletes existing history. The returned objects lost their rows and must be
// deleted after the transaction commits.
func capturePlaygroundCanvasSnapshot(tx *gorm.DB, project *PlaygroundCanvasProject, document string, force bool) ([]playgroundStoredObject, error) {
	if document == "" {
		return nil, nil
	}
	policy, err := playgroundPolicyForUser(tx, project.UserID)
	if err != nil {
		return nil, err
	}
	newest := PlaygroundCanvasSnapshot{}
	// Revision is the tiebreaker for captures inside the same second: it is
	// monotonic per board, so "newest" is always the latest stored state.
	err = tx.Where("canvas_id = ? AND user_id = ?", project.ID, project.UserID).
		Order("created_at DESC, revision DESC, id DESC").First(&newest).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		newest = PlaygroundCanvasSnapshot{}
	} else if err != nil {
		return nil, err
	}
	contentHash := playgroundPayloadHash([]byte(document))
	now := common.GetTimestamp()
	if newest.ID != "" {
		if newest.ContentHash == contentHash {
			return nil, nil
		}
		if !force && project.Revision-newest.Revision < int64(policy.CanvasSnapshotEverySaves) &&
			now-newest.CreatedAt < int64(policy.CanvasSnapshotIntervalMinutes)*playgroundCanvasSnapshotIntervalUnit {
			return nil, nil
		}
	}
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return nil, err
	}
	snapshotID := "pgs_" + key
	backend, objectKey, encoding, stored := writePlaygroundPayloadObject(
		playgroundCanvasSnapshotObjectKey(project.UserID, now, project.ID, snapshotID), []byte(document))
	if !stored {
		// A missing or failing object store means the history entry cannot be
		// written; the save itself proceeds without it.
		return nil, nil
	}
	usage, err := lockPlaygroundUserUsage(tx, project.UserID)
	if err != nil {
		deletePlaygroundObject(nil, objectKey)
		return nil, err
	}
	size := int64(len(document))
	if usage.CanvasSnapshotCount >= int64(policy.CanvasSnapshotUserMaxCount) ||
		usage.CanvasSnapshotBytes+size > policy.CanvasSnapshotUserMaxBytes {
		deletePlaygroundObject(nil, objectKey)
		return nil, nil
	}
	removed := make([]playgroundStoredObject, 0)
	removedBytes := int64(0)
	if policy.CanvasSnapshotPerCanvasMaxCount > 0 {
		var stored int64
		if err := tx.Model(&PlaygroundCanvasSnapshot{}).Where("canvas_id = ? AND user_id = ?", project.ID, project.UserID).
			Count(&stored).Error; err != nil {
			deletePlaygroundObject(nil, objectKey)
			return nil, err
		}
		if prune := stored + 1 - int64(policy.CanvasSnapshotPerCanvasMaxCount); prune > 0 {
			oldest := make([]PlaygroundCanvasSnapshot, 0, prune)
			if err := tx.Where("canvas_id = ? AND user_id = ?", project.ID, project.UserID).
				Order("created_at ASC, revision ASC, id ASC").Limit(int(prune)).Find(&oldest).Error; err != nil {
				deletePlaygroundObject(nil, objectKey)
				return nil, err
			}
			for index := range oldest {
				row := &oldest[index]
				if err := tx.Where("id = ?", row.ID).Delete(&PlaygroundCanvasSnapshot{}).Error; err != nil {
					deletePlaygroundObject(nil, objectKey)
					return nil, err
				}
				removed = append(removed, playgroundStoredObject{ObjectKey: row.ObjectKey})
				removedBytes += row.ByteSize
			}
		}
	}
	snapshot := PlaygroundCanvasSnapshot{
		ID: snapshotID, CanvasID: project.ID, UserID: project.UserID,
		Revision: project.Revision, NodeCount: project.NodeCount, EdgeCount: project.EdgeCount,
		ByteSize: size, StorageBackend: backend, ObjectKey: objectKey,
		ContentEncoding: encoding, ContentHash: contentHash, CreatedAt: now,
	}
	if err := tx.Create(&snapshot).Error; err != nil {
		deletePlaygroundObject(nil, objectKey)
		return nil, err
	}
	usage.apply(playgroundUserUsageDelta{
		CanvasSnapshotCount: 1 - int64(len(removed)),
		CanvasSnapshotBytes: size - removedBytes,
	})
	if err := savePlaygroundUserUsage(tx, usage); err != nil {
		return nil, err
	}
	return removed, nil
}

// ListPlaygroundCanvasSnapshots returns the history of one active canvas,
// newest first. The canvas ownership check runs first, so another account can
// never enumerate snapshots of a board it does not own.
func ListPlaygroundCanvasSnapshots(userID int, canvasID string, offset, limit int) ([]PlaygroundCanvasSnapshotSummary, int64, error) {
	items := make([]PlaygroundCanvasSnapshotSummary, 0)
	if offset < 0 || limit < 1 {
		return items, 0, ErrPlaygroundCanvasInvalid
	}
	if _, err := GetPlaygroundCanvasProject(userID, canvasID); err != nil {
		return items, 0, err
	}
	var count int64
	query := DB.Model(&PlaygroundCanvasSnapshot{}).Where("canvas_id = ? AND user_id = ?", canvasID, userID)
	if err := query.Count(&count).Error; err != nil {
		return items, 0, err
	}
	rows := make([]PlaygroundCanvasSnapshot, 0, limit)
	if err := query.Order("created_at DESC, revision DESC, id DESC").Offset(offset).Limit(limit).Find(&rows).Error; err != nil {
		return items, 0, err
	}
	for index := range rows {
		items = append(items, playgroundCanvasSnapshotSummary(&rows[index]))
	}
	return items, count, nil
}

// GetPlaygroundCanvasSnapshot reads one stored history entry of an active
// canvas and returns its decompressed document. The row's content hash is
// re-checked so a corrupted object is reported instead of restored.
func GetPlaygroundCanvasSnapshot(userID int, canvasID, snapshotID string) (*PlaygroundCanvasSnapshot, string, error) {
	if _, err := GetPlaygroundCanvasProject(userID, canvasID); err != nil {
		return nil, "", err
	}
	var snapshot PlaygroundCanvasSnapshot
	err := DB.Where("id = ? AND canvas_id = ? AND user_id = ?", snapshotID, canvasID, userID).First(&snapshot).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, "", ErrPlaygroundCanvasSnapshotNotFound
	}
	if err != nil {
		return nil, "", err
	}
	document, err := readPlaygroundStoredPayload(nil, snapshot.ObjectKey, snapshot.ContentEncoding, snapshot.ByteSize)
	if err != nil {
		return nil, "", err
	}
	if playgroundPayloadHash(document) != snapshot.ContentHash {
		return nil, "", fmt.Errorf("stored snapshot %s content hash does not match its metadata", snapshot.ID)
	}
	return &snapshot, string(document), nil
}
