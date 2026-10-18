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
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service/objectstore"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Object deletion origins. The origin names the resource whose row owned the
// object; the retry worker uses it to release the bytes the same way the
// request path would have (an upload key also aborts its multipart parts).
const (
	playgroundObjectOriginAttachment = "attachment"
	playgroundObjectOriginUpload     = "upload"
	playgroundObjectOriginArtifact   = "artifact"
	playgroundObjectOriginCanvas     = "canvas"
	playgroundObjectOriginSnapshot   = "canvas_snapshot"
	playgroundObjectOriginTaskResult = "task_result"
)

const (
	// playgroundObjectDeleteOutboxBatch bounds how many queued deletions one
	// retry pass attempts.
	playgroundObjectDeleteOutboxBatch = 200
	// playgroundObjectDeleteBackoffBaseSeconds and the cap below space out
	// retries of a key the store keeps rejecting: 1m, 2m, 4m, ... up to 6h.
	playgroundObjectDeleteBackoffBaseSeconds = 60
	playgroundObjectDeleteBackoffCapSeconds  = 6 * 60 * 60
	// playgroundObjectDeleteErrorLength bounds the recorded failure text so a
	// backend answer can never overflow its column.
	playgroundObjectDeleteErrorLength = 200
)

// PlaygroundObjectDeleteOutbox is one object whose owning database row is
// gone. The row is written in the same transaction that deletes the owner, so
// the deletion survives a crash between commit and the object-store call; the
// request path deletes the object right after the commit and clears the entry,
// and the scheduled worker retries whatever is left with backoff.
type PlaygroundObjectDeleteOutbox struct {
	ID int64 `json:"id" gorm:"primary_key"`
	// ObjectKey is the logical store key; ObjectKeyHash is its SHA-256 and
	// carries the uniqueness, because a MySQL index cannot span the full key
	// length on every supported version.
	ObjectKey     string `json:"object_key" gorm:"size:512;not null"`
	ObjectKeyHash string `json:"object_key_hash" gorm:"size:64;not null;uniqueIndex"`
	Origin        string `json:"origin" gorm:"size:32;not null"`
	Attempts      int    `json:"attempts" gorm:"not null"`
	LastError     string `json:"last_error" gorm:"size:255;not null"`
	NextAttemptAt int64  `json:"next_attempt_at" gorm:"not null;index"`
	CreatedAt     int64  `json:"created_at" gorm:"not null"`
	UpdatedAt     int64  `json:"updated_at" gorm:"not null"`
}

// TableName pins the table name the plan defines.
func (PlaygroundObjectDeleteOutbox) TableName() string {
	return "object_delete_outbox"
}

// playgroundQueuedObjectDelete is one entry a writer drains right after its
// transaction commits: the bytes to remove and the origin that decides how.
type playgroundQueuedObjectDelete struct {
	ObjectKey string
	Origin    string
}

// playgroundObjectDeleteKeyHash fingerprints an object key for the outbox
// uniqueness index.
func playgroundObjectDeleteKeyHash(objectKey string) string {
	hash := sha256.Sum256([]byte(objectKey))
	return hex.EncodeToString(hash[:])
}

// playgroundObjectDeleteErrorText trims and bounds one failure message.
func playgroundObjectDeleteErrorText(err error) string {
	if err == nil {
		return ""
	}
	text := strings.TrimSpace(err.Error())
	if runes := []rune(text); len(runes) > playgroundObjectDeleteErrorLength {
		text = string(runes[:playgroundObjectDeleteErrorLength])
	}
	return text
}

// playgroundObjectDeleteBackoffSeconds spaces the retry of one failed key.
func playgroundObjectDeleteBackoffSeconds(attempts int) int64 {
	seconds := int64(playgroundObjectDeleteBackoffBaseSeconds)
	for attempt := 1; attempt < attempts; attempt++ {
		seconds *= 2
		if seconds >= playgroundObjectDeleteBackoffCapSeconds {
			return playgroundObjectDeleteBackoffCapSeconds
		}
	}
	return seconds
}

// enqueuePlaygroundObjectDeletes records the objects one committed change
// releases in the delete outbox, inside the writer's transaction, so the row
// deletion and the pending object deletion commit or roll back together. The
// returned entries are the caller's fast path: each is deleted right after the
// commit and its outbox row cleared, while a key the store cannot delete stays
// queued for the scheduled worker.
func enqueuePlaygroundObjectDeletes(tx *gorm.DB, objects []playgroundStoredObject, origin string) ([]playgroundQueuedObjectDelete, error) {
	queued := make([]playgroundQueuedObjectDelete, 0, len(objects))
	if tx == nil || len(objects) == 0 {
		return queued, nil
	}
	now := common.GetTimestamp()
	rows := make([]PlaygroundObjectDeleteOutbox, 0, len(objects))
	seen := make(map[string]struct{}, len(objects))
	for index := range objects {
		objectKey := strings.TrimSpace(objects[index].ObjectKey)
		if objectKey == "" {
			continue
		}
		hash := playgroundObjectDeleteKeyHash(objectKey)
		if _, found := seen[hash]; found {
			continue
		}
		seen[hash] = struct{}{}
		queued = append(queued, playgroundQueuedObjectDelete{ObjectKey: objectKey, Origin: origin})
		rows = append(rows, PlaygroundObjectDeleteOutbox{
			ObjectKey: objectKey, ObjectKeyHash: hash, Origin: origin,
			NextAttemptAt: now, CreatedAt: now, UpdatedAt: now,
		})
	}
	if len(rows) == 0 {
		return queued, nil
	}
	// A key may already be queued (a previous delete failed): deleting twice is
	// idempotent, and the existing row already carries its retry state, so the
	// insert yields to it.
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&rows).Error; err != nil {
		return nil, err
	}
	return queued, nil
}

// deletePlaygroundQueuedObject releases one queued object's bytes. An upload
// key also aborts the multipart parts an interrupted direct upload left behind.
func deletePlaygroundQueuedObject(store objectstore.Store, objectKey, origin string) error {
	if origin == playgroundObjectOriginUpload {
		return deletePlaygroundUploadObject(store, &PlaygroundUpload{ObjectKey: objectKey})
	}
	return deletePlaygroundObject(store, objectKey)
}

// drainPlaygroundObjectDeletes removes the objects one committed change
// released and clears their outbox rows. A key that cannot be deleted stays
// queued: the scheduled worker retries it with backoff, so a store outage never
// loses a deletion whose database row already committed.
func drainPlaygroundObjectDeletes(store objectstore.Store, queued []playgroundQueuedObjectDelete) {
	if len(queued) == 0 {
		return
	}
	if store == nil {
		store = objectstore.DefaultStore()
	}
	if store == nil {
		// The queued rows keep the pending deletion until a store is
		// configured again and the worker runs.
		return
	}
	for index := range queued {
		entry := &queued[index]
		if entry.ObjectKey == "" {
			continue
		}
		if err := deletePlaygroundQueuedObject(store, entry.ObjectKey, entry.Origin); err != nil {
			continue
		}
		if err := DB.Where("object_key_hash = ?", playgroundObjectDeleteKeyHash(entry.ObjectKey)).
			Delete(&PlaygroundObjectDeleteOutbox{}).Error; err != nil {
			common.SysError(common.LogText("failed to clear Playground object delete outbox row %s: %s", entry.ObjectKey, err.Error()))
		}
	}
}

// PlaygroundObjectDeleteOutboxResult reports one retry pass of the object
// delete outbox.
type PlaygroundObjectDeleteOutboxResult struct {
	CheckedAt int64 `json:"checked_at"`
	Attempted int64 `json:"attempted"`
	Deleted   int64 `json:"deleted"`
	Failed    int64 `json:"failed"`
	Pending   int64 `json:"pending"`
}

// CountPendingPlaygroundObjectDeletes reports how many queued deletions still
// wait for a retry, due now or after their backoff.
func CountPendingPlaygroundObjectDeletes() (int64, error) {
	var count int64
	if err := DB.Model(&PlaygroundObjectDeleteOutbox{}).Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

// ProcessPlaygroundObjectDeleteOutbox retries up to batchSize due deletions
// with the configured store. A success removes the outbox row; a failure keeps
// it with an incremented attempt count, the bounded failure text and an
// exponential backoff. The pass is safe to repeat: every store delete is
// idempotent and an entry only ever leaves the queue after its bytes are gone.
func ProcessPlaygroundObjectDeleteOutbox(ctx context.Context, store objectstore.Store, batchSize int) (*PlaygroundObjectDeleteOutboxResult, error) {
	if store == nil {
		store = objectstore.DefaultStore()
	}
	if store == nil {
		return nil, ErrPlaygroundPayloadStorage
	}
	if batchSize <= 0 {
		batchSize = playgroundObjectDeleteOutboxBatch
	}
	result := &PlaygroundObjectDeleteOutboxResult{CheckedAt: common.GetTimestamp()}
	rows := make([]PlaygroundObjectDeleteOutbox, 0, batchSize)
	if err := DB.Where("next_attempt_at <= ?", result.CheckedAt).
		Order("next_attempt_at ASC, id ASC").Limit(batchSize).Find(&rows).Error; err != nil {
		return nil, err
	}
	for index := range rows {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		row := &rows[index]
		result.Attempted++
		if err := deletePlaygroundQueuedObject(store, row.ObjectKey, row.Origin); err != nil {
			result.Failed++
			attempts := row.Attempts + 1
			update := map[string]any{
				"attempts":        attempts,
				"last_error":      playgroundObjectDeleteErrorText(err),
				"next_attempt_at": result.CheckedAt + playgroundObjectDeleteBackoffSeconds(attempts),
				"updated_at":      common.GetTimestamp(),
			}
			if updateErr := DB.Model(&PlaygroundObjectDeleteOutbox{}).Where("id = ?", row.ID).Updates(update).Error; updateErr != nil {
				return result, updateErr
			}
			continue
		}
		if err := DB.Where("id = ?", row.ID).Delete(&PlaygroundObjectDeleteOutbox{}).Error; err != nil {
			return result, err
		}
		result.Deleted++
	}
	pending, err := CountPendingPlaygroundObjectDeletes()
	if err != nil {
		return result, err
	}
	result.Pending = pending
	return result, nil
}
