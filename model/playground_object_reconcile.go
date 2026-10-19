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
	"errors"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service/objectstore"
)

const (
	// playgroundObjectKeyRootPrefix is the logical key space every Playground
	// object lives below; the comparison only ever looks inside it.
	playgroundObjectKeyRootPrefix = "pg"
	// playgroundObjectReconcileGraceSeconds protects objects younger than the
	// window. A database row deleted moments ago may still be in flight between
	// its commit and the post-commit drain, and an upload reservation is only
	// released after its own reservation window, so a fixed day of grace keeps
	// the comparison from racing any writer.
	playgroundObjectReconcileGraceSeconds = 24 * 60 * 60
	// playgroundObjectReconcileDeleteBatch bounds how many aged orphans one run
	// removes; the rest wait for the next run, so a bug in the ownership query
	// can never wipe the whole key space in one pass.
	playgroundObjectReconcileDeleteBatch = 200
	// playgroundObjectReconcileSampleLimit bounds how many orphans the report
	// names.
	playgroundObjectReconcileSampleLimit = 20
)

// ErrPlaygroundObjectReconcileUnsupported reports that the configured object
// store cannot enumerate stored objects, so the comparison cannot run.
var ErrPlaygroundObjectReconcileUnsupported = errors.New("the configured object store cannot list objects.")

// PlaygroundObjectOrphan describes one stored object no database row owns.
type PlaygroundObjectOrphan struct {
	ObjectKey string `json:"object_key"`
	Bytes     int64  `json:"bytes"`
	StoredAt  int64  `json:"stored_at"`
}

// PlaygroundObjectReconcileOptions bounds one comparison pass. Zero values
// resolve to the package defaults.
type PlaygroundObjectReconcileOptions struct {
	// Prefix is the logical key space compared.
	Prefix string
	// GraceSeconds protects objects younger than the window.
	GraceSeconds int64
	// DeleteBatch bounds how many aged orphans one run removes.
	DeleteBatch int
	// DryRun reports without deleting; every run produces the report, and the
	// first run of a new installation can be reviewed before any bytes go.
	DryRun bool
	// SampleLimit bounds how many orphans the report names.
	SampleLimit int
}

// PlaygroundObjectReconcileReport is the outcome of one comparison between the
// stored objects below the Playground prefix and the database rows that own
// them. The counters describe the dry-run report, DeletedCount and the byte
// total the bounded cleanup that follows it.
type PlaygroundObjectReconcileReport struct {
	CheckedAt       int64                    `json:"checked_at"`
	Backend         string                   `json:"backend"`
	Prefix          string                   `json:"prefix"`
	DryRun          bool                     `json:"dry_run"`
	ListedCount     int64                    `json:"listed_count"`
	OwnedCount      int64                    `json:"owned_count"`
	PendingCount    int64                    `json:"pending_count"`
	GraceCount      int64                    `json:"grace_count"`
	OrphanCount     int64                    `json:"orphan_count"`
	OrphanBytes     int64                    `json:"orphan_bytes"`
	DeletedCount    int64                    `json:"deleted_count"`
	DeletedBytes    int64                    `json:"deleted_bytes"`
	FailedCount     int64                    `json:"failed_count"`
	DeferredCount   int64                    `json:"deferred_count"`
	Sample          []PlaygroundObjectOrphan `json:"sample"`
	SampleTruncated bool                     `json:"sample_truncated"`
}

// playgroundOwnedObjectKeySets returns every object key a database row still
// owns and every key with a queued deletion. Listed objects are only orphans
// when they are in neither set.
func playgroundOwnedObjectKeySets() (map[string]struct{}, map[string]struct{}, error) {
	owned := make(map[string]struct{})
	pending := make(map[string]struct{})
	stores := []any{
		&PlaygroundAttachment{},
		&PlaygroundUpload{},
		&PlaygroundArtifactVersion{},
		&PlaygroundCanvasProject{},
		&PlaygroundCanvasSnapshot{},
		&PlaygroundTaskArtifact{},
		&PlaygroundKnowledgeDocument{},
	}
	for _, store := range stores {
		keys := make([]string, 0)
		if err := DB.Model(store).Where("object_key IS NOT NULL AND object_key <> ''").Pluck("object_key", &keys).Error; err != nil {
			return nil, nil, err
		}
		for _, key := range keys {
			owned[key] = struct{}{}
		}
	}
	queued := make([]string, 0)
	if err := DB.Model(&PlaygroundObjectDeleteOutbox{}).Where("object_key IS NOT NULL AND object_key <> ''").Pluck("object_key", &queued).Error; err != nil {
		return nil, nil, err
	}
	for _, key := range queued {
		pending[key] = struct{}{}
	}
	return owned, pending, nil
}

// ReconcilePlaygroundObjects lists the stored objects below the Playground key
// space and compares them with the database rows that own them. Every call
// produces the dry-run report first: what was listed, what a row owns, what a
// queued delete already covers, and what the comparison found — for orphans
// older than the grace window the report also names a bounded sample. Unless
// DryRun is set, the aged orphans are then removed, at most DeleteBatch per
// call; only bytes no row and no queued delete can account for are ever
// touched.
func ReconcilePlaygroundObjects(ctx context.Context, store objectstore.Store, options PlaygroundObjectReconcileOptions) (*PlaygroundObjectReconcileReport, error) {
	if store == nil {
		store = objectstore.DefaultStore()
	}
	if store == nil {
		return nil, ErrPlaygroundPayloadStorage
	}
	lister, ok := store.(objectstore.ObjectLister)
	if !ok {
		return nil, ErrPlaygroundObjectReconcileUnsupported
	}
	if options.Prefix == "" {
		options.Prefix = playgroundObjectKeyRootPrefix
	}
	if options.GraceSeconds <= 0 {
		options.GraceSeconds = playgroundObjectReconcileGraceSeconds
	}
	if options.DeleteBatch <= 0 {
		options.DeleteBatch = playgroundObjectReconcileDeleteBatch
	}
	if options.SampleLimit <= 0 {
		options.SampleLimit = playgroundObjectReconcileSampleLimit
	}
	owned, pending, err := playgroundOwnedObjectKeySets()
	if err != nil {
		return nil, err
	}
	now := common.GetTimestamp()
	report := &PlaygroundObjectReconcileReport{
		CheckedAt: now,
		Backend:   store.Backend(),
		Prefix:    options.Prefix,
		DryRun:    options.DryRun,
		Sample:    make([]PlaygroundObjectOrphan, 0),
	}
	aged := make([]PlaygroundObjectOrphan, 0, options.DeleteBatch)
	err = lister.List(ctx, options.Prefix, func(info objectstore.ObjectInfo) error {
		report.ListedCount++
		if _, found := owned[info.Key]; found {
			report.OwnedCount++
			return nil
		}
		if _, found := pending[info.Key]; found {
			report.PendingCount++
			return nil
		}
		if info.ModTime.IsZero() || now-info.ModTime.Unix() < options.GraceSeconds {
			report.GraceCount++
			return nil
		}
		orphan := PlaygroundObjectOrphan{ObjectKey: info.Key, Bytes: info.Size, StoredAt: info.ModTime.Unix()}
		report.OrphanCount++
		report.OrphanBytes += info.Size
		if len(report.Sample) < options.SampleLimit {
			report.Sample = append(report.Sample, orphan)
		} else {
			report.SampleTruncated = true
		}
		if len(aged) < options.DeleteBatch {
			aged = append(aged, orphan)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	report.DeferredCount = report.OrphanCount - int64(len(aged))
	if options.DryRun {
		return report, nil
	}
	for index := range aged {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		orphan := &aged[index]
		if err := deletePlaygroundObject(store, orphan.ObjectKey); err != nil {
			report.FailedCount++
			continue
		}
		report.DeletedCount++
		report.DeletedBytes += orphan.Bytes
	}
	return report, nil
}
