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
package model_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service/objectstore"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// failingDeleteStore answers every wrapped store operation except Delete, which
// always fails, so the outbox retry path is exercised without a broken backend.
type failingDeleteStore struct {
	objectstore.Store
	err error
}

func (store failingDeleteStore) Delete(context.Context, string) error {
	return store.err
}

// listinglessStore hides the listing capability of the wrapped store, which is
// what a backend without enumeration looks like to the reconciliation.
type listinglessStore struct {
	objectstore.Store
}

// installPlaygroundOutboxStore points the process-wide store at a fresh local
// directory and returns the backend with its root, so tests can probe objects,
// age them with os.Chtimes, and keep single operations failing.
func installPlaygroundOutboxStore(t *testing.T) (*objectstore.Local, string) {
	t.Helper()
	root := t.TempDir()
	store, err := objectstore.NewLocal(system_setting.ObjectStoreConfig{
		Backend:           system_setting.ObjectStoreBackendLocal,
		LocalDir:          root,
		PresignTTLSeconds: 60,
	})
	require.NoError(t, err)
	previousStore := objectstore.DefaultStore()
	previousTTL := objectstore.DefaultPresignTTL()
	objectstore.SetDefaultStore(store, time.Minute)
	t.Cleanup(func() {
		objectstore.SetDefaultStore(previousStore, previousTTL)
		_ = store.Close()
	})
	return store, root
}

func assertPlaygroundObjectStored(t *testing.T, store objectstore.Store, objectKey string, stored bool) {
	t.Helper()
	_, err := store.Head(context.Background(), objectKey)
	if stored {
		require.NoError(t, err, objectKey)
		return
	}
	assert.ErrorIs(t, err, objectstore.ErrObjectNotFound, objectKey)
}

// TestPlaygroundObjectDeleteOutboxMatrix proves on every supported database
// that deleting a row queues its object in the same transaction, that the
// post-commit drain removes the bytes and clears the entry, and that a failed
// store delete stays queued with bounded backoff until a retry succeeds.
func TestPlaygroundObjectDeleteOutboxMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			store, _ := installPlaygroundOutboxStore(t)
			sessionID := createPlayground(t, 7, "object-outbox")["id"].(string)
			now := common.GetTimestamp()
			seedAttachment := func(id, clientKey, objectKey string, data []byte) {
				require.NoError(t, db.Create(&model.PlaygroundAttachment{
					ID: id, UserID: 7, SessionID: sessionID, MediaType: "image/png", Filename: "image.png",
					ByteSize: int64(len(data)), ContentHash: playgroundContentHashHex(data),
					ClientKeyHash:  playgroundContentHashHex([]byte(clientKey)),
					StorageBackend: store.Backend(), ObjectKey: objectKey, CreatedAt: now, UpdatedAt: now,
				}).Error)
				_, err := store.Put(context.Background(), objectKey, bytes.NewReader(data))
				require.NoError(t, err)
			}

			// The fast path: the committed delete removes the object right away
			// and leaves nothing for the worker.
			fastKey := "pg/7/attachments/2026/10/outbox-fast"
			seedAttachment("pga_outbox_fast", "outbox-fast", fastKey, []byte("fast"))
			require.NoError(t, model.DeletePlaygroundAttachment(7, sessionID, "pga_outbox_fast"))
			assertPlaygroundObjectStored(t, store, fastKey, false)
			var pending int64
			require.NoError(t, db.Model(&model.PlaygroundObjectDeleteOutbox{}).Count(&pending).Error)
			assert.Zero(t, pending)

			// A store outage keeps the deletion queued: its database row already
			// committed, so the pending object delete must outlive the failed call.
			retryKey := "pg/7/attachments/2026/10/outbox-retry"
			seedAttachment("pga_outbox_retry", "outbox-retry", retryKey, []byte("retry"))
			outage := failingDeleteStore{Store: store, err: errors.New("object store unavailable")}
			objectstore.SetDefaultStore(outage, time.Minute)
			require.NoError(t, model.DeletePlaygroundAttachment(7, sessionID, "pga_outbox_retry"))
			objectstore.SetDefaultStore(store, time.Minute)
			assertPlaygroundObjectStored(t, store, retryKey, true)
			var queued model.PlaygroundObjectDeleteOutbox
			require.NoError(t, db.Where("object_key = ?", retryKey).First(&queued).Error)
			assert.Equal(t, "attachment", queued.Origin)
			assert.Zero(t, queued.Attempts)

			// The worker records the failure and spaces the next attempt out.
			result, err := model.ProcessPlaygroundObjectDeleteOutbox(t.Context(), outage, 20)
			require.NoError(t, err)
			assert.EqualValues(t, 1, result.Attempted)
			assert.EqualValues(t, 1, result.Failed)
			assert.Zero(t, result.Deleted)
			assert.EqualValues(t, 1, result.Pending)
			require.NoError(t, db.Where("object_key = ?", retryKey).First(&queued).Error)
			assert.Equal(t, 1, queued.Attempts)
			assert.NotEmpty(t, queued.LastError)
			assert.Greater(t, queued.NextAttemptAt, result.CheckedAt)
			assertPlaygroundObjectStored(t, store, retryKey, true)

			// An entry inside its backoff window is skipped, not retried early.
			result, err = model.ProcessPlaygroundObjectDeleteOutbox(t.Context(), store, 20)
			require.NoError(t, err)
			assert.Zero(t, result.Attempted)
			assert.EqualValues(t, 1, result.Pending)

			// Once the window has passed, a healthy store deletes the object and
			// the entry leaves the queue.
			require.NoError(t, db.Model(&model.PlaygroundObjectDeleteOutbox{}).
				Where("object_key = ?", retryKey).Update("next_attempt_at", 0).Error)
			result, err = model.ProcessPlaygroundObjectDeleteOutbox(t.Context(), store, 20)
			require.NoError(t, err)
			assert.EqualValues(t, 1, result.Deleted)
			assert.Zero(t, result.Pending)
			assertPlaygroundObjectStored(t, store, retryKey, false)
			require.NoError(t, db.Model(&model.PlaygroundObjectDeleteOutbox{}).Count(&pending).Error)
			assert.Zero(t, pending)
		})
	}
}

// TestPlaygroundObjectReconcileMatrix proves on every supported database that
// the comparison separates owned, queued, young and orphaned objects, that a
// dry run deletes nothing, and that the cleanup removes only aged orphans
// within its batch bound.
func TestPlaygroundObjectReconcileMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			store, root := installPlaygroundOutboxStore(t)
			ctx := t.Context()
			now := common.GetTimestamp()
			storeObject := func(objectKey string, size int, storedAt time.Time) {
				_, err := store.Put(ctx, objectKey, strings.NewReader(strings.Repeat("x", size)))
				require.NoError(t, err)
				require.NoError(t, os.Chtimes(filepath.Join(root, filepath.FromSlash(objectKey)), storedAt, storedAt))
			}

			// A row owns one object; a queued delete already covers another.
			ownedKey := "pg/7/attachments/2026/10/owned"
			storeObject(ownedKey, 8, time.Now().Add(-48*time.Hour))
			require.NoError(t, db.Create(&model.PlaygroundAttachment{
				ID: "pga_reconcile", UserID: 7, SessionID: "reconcile", MediaType: "image/png",
				Filename: "image.png", ByteSize: 8, ContentHash: playgroundContentHashHex([]byte("owned")),
				ClientKeyHash:  playgroundContentHashHex([]byte("reconcile-owned")),
				StorageBackend: store.Backend(), ObjectKey: ownedKey,
				CreatedAt: now, UpdatedAt: now,
			}).Error)
			pendingKey := "pg/7/attachments/2026/10/pending"
			storeObject(pendingKey, 8, time.Now().Add(-48*time.Hour))
			require.NoError(t, db.Create(&model.PlaygroundObjectDeleteOutbox{
				ObjectKey: pendingKey, ObjectKeyHash: playgroundContentHashHex([]byte(pendingKey)),
				Origin: "attachment", NextAttemptAt: now, CreatedAt: now, UpdatedAt: now,
			}).Error)

			// A fresh object is inside the grace window; the aged ones are the
			// only cleanup candidates.
			youngKey := "pg/7/attachments/2026/10/young"
			storeObject(youngKey, 4, time.Now())
			agedKeys := []string{"pg/7/attachments/2026/10/aged-a", "pg/7/attachments/2026/10/aged-b"}
			for _, objectKey := range agedKeys {
				storeObject(objectKey, 6, time.Now().Add(-48*time.Hour))
			}

			// Every run starts as a dry-run report: the sample is bounded, and
			// nothing is deleted.
			report, err := model.ReconcilePlaygroundObjects(ctx, store, model.PlaygroundObjectReconcileOptions{DryRun: true, SampleLimit: 1})
			require.NoError(t, err)
			assert.True(t, report.DryRun)
			assert.Equal(t, "pg", report.Prefix)
			assert.Equal(t, store.Backend(), report.Backend())
			assert.EqualValues(t, 5, report.ListedCount)
			assert.EqualValues(t, 1, report.OwnedCount)
			assert.EqualValues(t, 1, report.PendingCount)
			assert.EqualValues(t, 1, report.GraceCount)
			assert.EqualValues(t, 2, report.OrphanCount)
			assert.EqualValues(t, 12, report.OrphanBytes)
			assert.Zero(t, report.DeletedCount)
			require.Len(t, report.Sample, 1)
			assert.True(t, report.SampleTruncated)
			for _, objectKey := range append([]string{ownedKey, pendingKey, youngKey}, agedKeys...) {
				assertPlaygroundObjectStored(t, store, objectKey, true)
			}

			// The cleanup removes only aged orphans, and only as many as its
			// batch bound allows.
			report, err = model.ReconcilePlaygroundObjects(ctx, store, model.PlaygroundObjectReconcileOptions{DeleteBatch: 1})
			require.NoError(t, err)
			assert.False(t, report.DryRun)
			assert.EqualValues(t, 1, report.DeletedCount)
			assert.EqualValues(t, 6, report.DeletedBytes)
			assert.Zero(t, report.FailedCount)
			assert.EqualValues(t, 1, report.DeferredCount)
			assertPlaygroundObjectStored(t, store, agedKeys[0], false)
			assertPlaygroundObjectStored(t, store, agedKeys[1], true)
			assertPlaygroundObjectStored(t, store, ownedKey, true)
			assertPlaygroundObjectStored(t, store, pendingKey, true)
			assertPlaygroundObjectStored(t, store, youngKey, true)

			// The next run finishes the deferred orphan.
			report, err = model.ReconcilePlaygroundObjects(ctx, store, model.PlaygroundObjectReconcileOptions{})
			require.NoError(t, err)
			assert.EqualValues(t, 1, report.DeletedCount)
			assert.Zero(t, report.DeferredCount)
			assertPlaygroundObjectStored(t, store, agedKeys[1], false)

			// A backend without listing cannot run the comparison at all.
			_, err = model.ReconcilePlaygroundObjects(ctx, listinglessStore{Store: store}, model.PlaygroundObjectReconcileOptions{})
			assert.ErrorIs(t, err, model.ErrPlaygroundObjectReconcileUnsupported)
		})
	}
}

// TestPlaygroundSessionPurgeQueuesObjectDeletes proves a purge queues every
// stored object its rows owned — attachments and externalized artifact bodies —
// in the deleting transaction, and that the worker releases them after a store
// outage.
func TestPlaygroundSessionPurgeQueuesObjectDeletes(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	store, _ := installPlaygroundOutboxStore(t)
	ctx := t.Context()
	sessionID := createPlayground(t, 7, "purge-outbox")["id"].(string)
	now := common.GetTimestamp()

	attachmentKey := "pg/7/attachments/2026/10/purge-outbox"
	require.NoError(t, db.Create(&model.PlaygroundAttachment{
		ID: "pga_purge_outbox", UserID: 7, SessionID: sessionID, MediaType: "image/png",
		Filename: "image.png", ByteSize: 4, ContentHash: playgroundContentHashHex([]byte("body")),
		ClientKeyHash:  playgroundContentHashHex([]byte("purge-outbox")),
		StorageBackend: store.Backend(), ObjectKey: attachmentKey, CreatedAt: now, UpdatedAt: now,
	}).Error)
	artifactKey := "pg/7/artifacts/2026/10/purge-outbox"
	require.NoError(t, db.Create(&model.PlaygroundArtifact{
		ID: "pga_purge_doc", UserID: 7, SessionID: sessionID, Kind: "markdown", Revision: 1,
		CurrentVersionID: "pgv_purge_doc", Title: "Doc", Language: "markdown", Source: "source",
		CreateRequestID: "create_purge", CreateRequestKey: playgroundContentHashHex([]byte("create_purge")),
		CreateRequestHash: playgroundContentHashHex([]byte("create_purge_hash")),
		CreatedAt:         now, UpdatedAt: now,
	}).Error)
	require.NoError(t, db.Create(&model.PlaygroundArtifactVersion{
		ID: "pgv_purge_doc", ArtifactID: "pga_purge_doc", Number: 1, Title: "Doc", Language: "markdown",
		Content: "", ByteSize: 4, CreatedAt: now, RequestID: "save_purge",
		RequestKey: playgroundContentHashHex([]byte("save_purge")), RequestHash: playgroundContentHashHex([]byte("save_purge_hash")),
		StorageBackend: store.Backend(), ObjectKey: artifactKey, ContentEncoding: "gzip",
	}).Error)
	for _, objectKey := range []string{attachmentKey, artifactKey} {
		_, err := store.Put(ctx, objectKey, strings.NewReader("body"))
		require.NoError(t, err)
	}
	require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ?", sessionID).
		Update("deleted_at", now).Error)

	// The purge commits while the store is down: both objects survive and stay
	// queued with their origins.
	outage := failingDeleteStore{Store: store, err: errors.New("object store unavailable")}
	objectstore.SetDefaultStore(outage, time.Minute)
	require.NoError(t, model.PurgePlaygroundSession(7, sessionID))
	objectstore.SetDefaultStore(store, time.Minute)
	assertPlaygroundObjectStored(t, store, attachmentKey, true)
	assertPlaygroundObjectStored(t, store, artifactKey, true)
	var queued []model.PlaygroundObjectDeleteOutbox
	require.NoError(t, db.Find(&queued).Error)
	require.Len(t, queued, 2)
	assert.ElementsMatch(t, []string{"artifact", "attachment"}, []string{queued[0].Origin, queued[1].Origin})

	// The worker releases both objects and clears the queue.
	result, err := model.ProcessPlaygroundObjectDeleteOutbox(ctx, store, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 2, result.Deleted)
	assert.Zero(t, result.Pending)
	assertPlaygroundObjectStored(t, store, attachmentKey, false)
	assertPlaygroundObjectStored(t, store, artifactKey, false)

	// The purge also removed the owning rows.
	var rows int64
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("session_id = ?", sessionID).Count(&rows).Error)
	assert.Zero(t, rows)
	require.NoError(t, db.Model(&model.PlaygroundArtifactVersion{}).Where("artifact_id = ?", "pga_purge_doc").Count(&rows).Error)
	assert.Zero(t, rows)
}
