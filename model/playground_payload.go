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
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service/objectstore"
)

const (
	// playgroundPayloadExternalizeBytes is the size above which an artifact
	// version body or a canvas document leaves its database column. The body is
	// gzip-compressed into the shared object store and the row keeps only
	// ownership metadata plus the logical (uncompressed) byte size, so the
	// quota arithmetic is unchanged. Smaller payloads stay inline.
	playgroundPayloadExternalizeBytes = 64 << 10
	// playgroundPayloadGzipEncoding marks object bytes that are
	// gzip-compressed; readers must decompress before use.
	playgroundPayloadGzipEncoding = "gzip"
	// playgroundPayloadObjectTimeout bounds one object-store operation so a
	// hung backend cannot hold a request or a system task forever.
	playgroundPayloadObjectTimeout = 30 * time.Second
)

var (
	// ErrPlaygroundPayloadStorage reports that no process-wide object store is
	// configured, so an externalized payload cannot be read or written.
	ErrPlaygroundPayloadStorage = errors.New("Playground payload storage is unavailable.")
)

// playgroundStoredObject names one object that a committed database change no
// longer owns. Callers delete the collected objects best-effort after their
// transaction commits; the database stays the authority.
type playgroundStoredObject struct {
	ObjectKey string
}

// playgroundPayloadHash fingerprints a document so history deduplicates and
// object reads can verify their bytes.
func playgroundPayloadHash(payload []byte) string {
	hash := sha256.Sum256(payload)
	return hex.EncodeToString(hash[:])
}

// playgroundObjectMonth lays objects out by calendar month under the shared
// pg/{user_id}/{kind}/{yyyy}/{mm}/... key space.
func playgroundObjectMonth(createdAt int64) string {
	return time.Unix(createdAt, 0).UTC().Format("2006/01")
}

// playgroundArtifactVersionObjectKey is the stable key of one version body.
// Versions are immutable, so the key never changes after creation.
func playgroundArtifactVersionObjectKey(userID int, createdAt int64, versionID string) string {
	return fmt.Sprintf("pg/%d/artifacts/%s/%s", userID, playgroundObjectMonth(createdAt), versionID)
}

// playgroundCanvasDocumentObjectKey pins a stored document to the revision
// that wrote it; a replacement save names a new key and releases the old one.
func playgroundCanvasDocumentObjectKey(userID int, createdAt int64, canvasID string, revision int64) string {
	return fmt.Sprintf("pg/%d/canvases/%s/%s/r%d", userID, playgroundObjectMonth(createdAt), canvasID, revision)
}

// playgroundCanvasSnapshotObjectKey is the key of one canvas history entry.
func playgroundCanvasSnapshotObjectKey(userID int, createdAt int64, canvasID, snapshotID string) string {
	return fmt.Sprintf("pg/%d/canvas-snapshots/%s/%s/%s", userID, playgroundObjectMonth(createdAt), canvasID, snapshotID)
}

// writePlaygroundPayloadObject gzip-compresses payload into the process-wide
// object store under objectKey and returns the stored metadata; ok=false means
// the bytes were not stored (no store configured or a store failure). Canvas
// history always uses it, because a snapshot row holds metadata only.
func writePlaygroundPayloadObject(objectKey string, payload []byte) (backend string, key string, encoding string, ok bool) {
	store := objectstore.DefaultStore()
	if store == nil {
		common.SysError(common.LogText("failed to store Playground payload %s: object store is not configured", objectKey))
		return "", "", "", false
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(payload); err != nil {
		common.SysError(common.LogText("failed to compress Playground payload %s: %s", objectKey, err.Error()))
		return "", "", "", false
	}
	if err := writer.Close(); err != nil {
		common.SysError(common.LogText("failed to compress Playground payload %s: %s", objectKey, err.Error()))
		return "", "", "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), playgroundPayloadObjectTimeout)
	defer cancel()
	info, err := store.Put(ctx, objectKey, bytes.NewReader(compressed.Bytes()))
	if err != nil {
		common.SysError(common.LogText("failed to store Playground payload %s: %s", objectKey, err.Error()))
		return "", "", "", false
	}
	if info.Size != int64(compressed.Len()) {
		deletePlaygroundObject(store, objectKey)
		common.SysError(common.LogText("failed to store Playground payload %s: object store wrote an unexpected size", objectKey))
		return "", "", "", false
	}
	return store.Backend(), objectKey, playgroundPayloadGzipEncoding, true
}

// externalizePlaygroundPayload gzip-compresses payload into the process-wide
// object store when it is larger than the externalization threshold. The
// returned fields describe the stored object; ok=false means the caller must
// keep the payload inline. A missing store and a store failure only log: the
// surrounding write keeps the bytes inline rather than failing or losing them.
func externalizePlaygroundPayload(objectKey string, payload []byte) (backend string, key string, encoding string, ok bool) {
	if len(payload) <= playgroundPayloadExternalizeBytes {
		return "", "", "", false
	}
	return writePlaygroundPayloadObject(objectKey, payload)
}

// readPlaygroundStoredPayload reads one externalized payload back and verifies
// the decompressed size against the stored metadata. A row that names an
// object is unreadable without it, so failures are returned to the caller.
func readPlaygroundStoredPayload(store objectstore.Store, objectKey, encoding string, byteSize int64) ([]byte, error) {
	if store == nil {
		store = objectstore.DefaultStore()
	}
	if store == nil {
		return nil, ErrPlaygroundPayloadStorage
	}
	ctx, cancel := context.WithTimeout(context.Background(), playgroundPayloadObjectTimeout)
	defer cancel()
	reader, _, err := store.Get(ctx, objectKey)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	var body io.Reader = reader
	if encoding == playgroundPayloadGzipEncoding {
		decompressed, err := gzip.NewReader(reader)
		if err != nil {
			return nil, err
		}
		defer decompressed.Close()
		body = decompressed
	}
	payload, err := io.ReadAll(io.LimitReader(body, byteSize+1))
	if err != nil {
		return nil, err
	}
	if int64(len(payload)) != byteSize {
		return nil, fmt.Errorf("stored payload %s size does not match its metadata", objectKey)
	}
	return payload, nil
}

// deletePlaygroundObject removes stored bytes after their row is gone. Failure
// is logged, never returned: a leftover object is reconciled by later
// maintenance instead of failing a request whose database state committed.
func deletePlaygroundObject(store objectstore.Store, objectKey string) {
	if objectKey == "" {
		return
	}
	if store == nil {
		store = objectstore.DefaultStore()
	}
	if store == nil {
		common.SysError(common.LogText("failed to delete Playground object %s: object store is not configured", objectKey))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), playgroundPayloadObjectTimeout)
	defer cancel()
	if err := store.Delete(ctx, objectKey); err != nil && !errors.Is(err, objectstore.ErrObjectNotFound) {
		common.SysError(common.LogText("failed to delete Playground object %s: %s", objectKey, err.Error()))
	}
}

// deletePlaygroundObjects drains the objects one committed change replaced,
// pruned or purged.
func deletePlaygroundObjects(objects []playgroundStoredObject) {
	for index := range objects {
		deletePlaygroundObject(nil, objects[index].ObjectKey)
	}
}
