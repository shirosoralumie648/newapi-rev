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
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service/objectstore"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"gorm.io/gorm"
)

const (
	// playgroundAttachmentStorageDatabase marks rows whose canonical base64
	// payload is still inline in the data column instead of the object store.
	playgroundAttachmentStorageDatabase = system_setting.ObjectStoreBackendDB
	// playgroundAttachmentObjectTimeout bounds one object store operation so a
	// hung backend cannot hold a request or a system task forever.
	playgroundAttachmentObjectTimeout = 30 * time.Second
	// playgroundAttachmentMigrateSelectBatch is how many rows one migration
	// statement reads.
	playgroundAttachmentMigrateSelectBatch = 50
)

var (
	ErrPlaygroundAttachmentInvalid  = errors.New("Invalid Playground attachment.")
	ErrPlaygroundAttachmentNotFound = errors.New("Playground attachment not found.")
	ErrPlaygroundAttachmentConflict = errors.New("Playground attachment request ID was already used for different content.")
	ErrPlaygroundAttachmentLimit    = errors.New("Playground attachment storage limit exceeded.")
	ErrPlaygroundAttachmentInUse    = errors.New("Playground attachment is still referenced by a conversation message.")
	// ErrPlaygroundAttachmentStorage reports that no process-wide object store
	// is configured, so new bytes cannot be persisted.
	ErrPlaygroundAttachmentStorage = errors.New("Playground attachment storage is unavailable.")
	// errPlaygroundAttachmentMigrationConflict reports that the migration guard
	// no longer matched the row: another worker switched it or deleted it.
	errPlaygroundAttachmentMigrationConflict = errors.New("attachment was migrated or deleted concurrently")
	playgroundAttachmentMediaTypes           = map[string]bool{
		"image/png":  true,
		"image/jpeg": true,
		"image/webp": true,
		"image/gif":  true,
	}
	playgroundAttachmentExtensions = map[string]string{
		"image/png":  ".png",
		"image/jpeg": ".jpg",
		"image/webp": ".webp",
		"image/gif":  ".gif",
	}
)

// PlaygroundAttachment stores one uploaded file of a conversation or of the
// canvas workspace. The bytes live in the process-wide object store and only
// ownership and metadata stay in the database: rows written before the object
// store existed keep their canonical base64 payload in Data, and rows switched
// back by the rollback path do the same. The per-account byte budget keeps the
// table bounded.
type PlaygroundAttachment struct {
	ID     string `gorm:"size:32;primaryKey"`
	UserID int    `gorm:"not null;uniqueIndex:uk_playground_attachment_client,priority:1"`
	// SessionID is the attachment's partition: the conversation id of a chat
	// upload, or the canvas id of a workspace upload. Ownership is always the
	// UserID row, so a partition that no longer resolves never exposes bytes
	// of a different account.
	SessionID   string `gorm:"size:128;not null;index"`
	MediaType   string `gorm:"size:100;not null"`
	Filename    string `gorm:"size:255;not null"`
	ByteSize    int64  `gorm:"not null"`
	ContentHash string `gorm:"size:64;not null"`
	// Hashing the client ID makes uniqueness case-sensitive even with MySQL's default collation.
	ClientKeyHash string `gorm:"size:64;not null;uniqueIndex:uk_playground_attachment_client,priority:2"`
	// StorageBackend names where the bytes live: the backend of the object
	// store that accepted them, or "db" while they are inline in Data.
	StorageBackend string `gorm:"size:32"`
	// ObjectKey is the backend-relative key of the stored bytes. It is empty
	// for database-backed rows.
	ObjectKey string `gorm:"size:512"`
	// Data is the canonical base64 encoding of a database-backed attachment.
	// New uploads leave it NULL; the column stays readable so pre-migration
	// rows and a rollback keep working.
	Data *LongText
	// ReferencedAt is zero while no conversation message references the
	// attachment; the cleanup task deletes long-orphaned rows.
	ReferencedAt int64 `gorm:"not null;index"`
	CreatedAt    int64 `gorm:"not null;index"`
	UpdatedAt    int64 `gorm:"not null"`
}

// StoredInDatabase reports whether the attachment bytes are still inline in
// the data column: true for rows written before the object store migration
// and for rows restored during a rollback.
func (attachment *PlaygroundAttachment) StoredInDatabase() bool {
	return attachment.StorageBackend == "" || attachment.StorageBackend == playgroundAttachmentStorageDatabase
}

type PlaygroundAttachmentInput struct {
	ClientKey string
	MediaType string
	Filename  string
	Data      []byte
}

// PlaygroundAttachmentStorageMigrationResult reports what one bounded batch of
// attachment storage migration work changed.
type PlaygroundAttachmentStorageMigrationResult struct {
	Moved  int64
	Failed int64
}

func IsPlaygroundAttachmentMediaType(mediaType string) bool {
	return playgroundAttachmentMediaTypes[mediaType]
}

// ValidatePlaygroundAttachmentInput normalizes user text and rejects payloads
// whose declared media type does not match their signature, so an upload can
// never be stored under a renderable type it is not. maxFileBytes is the
// effective per-file budget from the owner's resource quota policy.
func ValidatePlaygroundAttachmentInput(input *PlaygroundAttachmentInput, maxFileBytes int64) error {
	input.ClientKey = strings.TrimSpace(input.ClientKey)
	input.MediaType = strings.ToLower(strings.TrimSpace(input.MediaType))
	input.Filename = strings.TrimSpace(input.Filename)
	if input.ClientKey == "" || len(input.ClientKey) > 200 || !utf8.ValidString(input.ClientKey) || strings.ContainsRune(input.ClientKey, 0) {
		return ErrPlaygroundAttachmentInvalid
	}
	if !IsPlaygroundAttachmentMediaType(input.MediaType) {
		return ErrPlaygroundAttachmentInvalid
	}
	if input.Filename == "" {
		input.Filename = "attachment" + playgroundAttachmentExtensions[input.MediaType]
	}
	if utf8.RuneCountInString(input.Filename) > 255 || !utf8.ValidString(input.Filename) || strings.ContainsRune(input.Filename, 0) {
		return ErrPlaygroundAttachmentInvalid
	}
	if len(input.Data) == 0 || int64(len(input.Data)) > maxFileBytes {
		return ErrPlaygroundAttachmentLimit
	}
	if !playgroundAttachmentMatchesMediaType(input.MediaType, input.Data) {
		return ErrPlaygroundAttachmentInvalid
	}
	return nil
}

func playgroundAttachmentMatchesMediaType(mediaType string, data []byte) bool {
	switch mediaType {
	case "image/png":
		return bytes.HasPrefix(data, []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	case "image/jpeg":
		return bytes.HasPrefix(data, []byte{0xff, 0xd8, 0xff})
	case "image/gif":
		return bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a"))
	case "image/webp":
		return len(data) >= 12 && bytes.Equal(data[0:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP"))
	}
	return false
}

func playgroundAttachmentClientKeyHash(clientKey string) string {
	hash := sha256.Sum256([]byte(clientKey))
	return hex.EncodeToString(hash[:])
}

func playgroundAttachmentContentHash(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// playgroundAttachmentObjectKey lays out one user's objects under the shared
// object store. The random attachment ID makes concurrent uploads collide-free
// within the same month.
func playgroundAttachmentObjectKey(userID int, createdAt int64, id string) string {
	month := time.Unix(createdAt, 0).UTC().Format("2006/01")
	return fmt.Sprintf("pg/%d/attachment/%s/%s", userID, month, id)
}

// playgroundAttachmentObjectBytes reports how many bytes of one attachment row
// live in the object store; a database-backed legacy row contributes none.
func playgroundAttachmentObjectBytes(attachment *PlaygroundAttachment) int64 {
	if attachment == nil || attachment.StoredInDatabase() {
		return 0
	}
	return attachment.ByteSize
}

func findPlaygroundAttachmentByClientKey(userID int, clientKeyHash string) (*PlaygroundAttachment, error) {
	var attachment PlaygroundAttachment
	if err := DB.Where("user_id = ? AND client_key_hash = ?", userID, clientKeyHash).First(&attachment).Error; err != nil {
		return nil, err
	}
	return &attachment, nil
}

func playgroundAttachmentMatchesRequest(attachment *PlaygroundAttachment, sessionID, mediaType, filename, contentHash string) bool {
	return attachment.SessionID == sessionID && attachment.MediaType == mediaType &&
		attachment.Filename == filename && attachment.ContentHash == contentHash
}

// deletePlaygroundAttachmentObject removes stored bytes after their row is
// gone. Failure is logged, never returned: the database is the authority, and
// a leftover object is reconciled by later maintenance instead of failing a
// request whose database state already committed.
func deletePlaygroundAttachmentObject(store objectstore.Store, attachment *PlaygroundAttachment) {
	if attachment == nil || attachment.ObjectKey == "" || attachment.StoredInDatabase() {
		return
	}
	if store == nil {
		store = objectstore.DefaultStore()
	}
	if store == nil {
		common.SysError(common.LogText("failed to delete Playground attachment object %s: object store is not configured", attachment.ObjectKey))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), playgroundAttachmentObjectTimeout)
	defer cancel()
	if err := store.Delete(ctx, attachment.ObjectKey); err != nil && !errors.Is(err, objectstore.ErrObjectNotFound) {
		common.SysError(common.LogText("failed to delete Playground attachment object %s: %s", attachment.ObjectKey, err.Error()))
	}
}

// readPlaygroundAttachmentObject reads one stored object back and verifies its
// size and content hash before the caller trusts it.
func readPlaygroundAttachmentObject(ctx context.Context, store objectstore.Store, key string, byteSize int64, contentHash string) ([]byte, error) {
	reader, info, err := store.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	if info.Size != byteSize {
		return nil, fmt.Errorf("stored attachment %s size does not match its metadata", key)
	}
	data, err := io.ReadAll(io.LimitReader(reader, byteSize+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != byteSize || playgroundAttachmentContentHash(data) != contentHash {
		return nil, fmt.Errorf("stored attachment %s content hash does not match its metadata", key)
	}
	return data, nil
}

// CreatePlaygroundAttachment stores the bytes of a new conversation upload in
// the process-wide object store and only records metadata in the database. The
// client ID is an idempotency key: a retry after a lost response returns the
// stored row without writing another object.
func CreatePlaygroundAttachment(ctx context.Context, userID int, sessionID string, input PlaygroundAttachmentInput) (*PlaygroundAttachment, bool, error) {
	return createPlaygroundAttachment(ctx, userID, sessionID, input, func(tx *gorm.DB) error {
		_, err := lockPlaygroundSession(tx, userID, sessionID)
		return err
	})
}

// CreatePlaygroundCanvasAttachment stores one upload of the canvas workspace.
// The canvas id is the attachment's partition: the row and its bytes belong to
// the account, the canvas is locked in the same transaction so capacity checks
// and project deletion serialize against the upload, and the pin table of the
// saved document keeps the attachment alive while a node references it.
func CreatePlaygroundCanvasAttachment(ctx context.Context, userID int, canvasID string, input PlaygroundAttachmentInput) (*PlaygroundAttachment, bool, error) {
	return createPlaygroundAttachment(ctx, userID, canvasID, input, func(tx *gorm.DB) error {
		return lockPlaygroundCanvasProject(tx, userID, canvasID)
	})
}

// createPlaygroundAttachment is the shared upload path of every attachment
// partition. partitionID names the owning resource (a conversation or a
// canvas); lockParent runs inside the write transaction and must lock that
// resource for the account, so a foreign or missing partition is rejected
// before any row is written.
func createPlaygroundAttachment(ctx context.Context, userID int, partitionID string, input PlaygroundAttachmentInput, lockParent func(tx *gorm.DB) error) (*PlaygroundAttachment, bool, error) {
	if userID <= 0 {
		return nil, false, gorm.ErrRecordNotFound
	}
	policy, err := PlaygroundQuotaPolicyForUser(userID)
	if err != nil {
		return nil, false, err
	}
	if err := ValidatePlaygroundAttachmentInput(&input, policy.AttachmentMaxFileBytes); err != nil {
		return nil, false, err
	}
	store := objectstore.DefaultStore()
	if store == nil {
		return nil, false, ErrPlaygroundAttachmentStorage
	}
	clientKeyHash := playgroundAttachmentClientKeyHash(input.ClientKey)
	contentHash := playgroundAttachmentContentHash(input.Data)

	// Client IDs are idempotency keys: retries after a lost response must not
	// store the same bytes twice.
	if existing, err := findPlaygroundAttachmentByClientKey(userID, clientKeyHash); err == nil {
		if !playgroundAttachmentMatchesRequest(existing, partitionID, input.MediaType, input.Filename, contentHash) {
			return nil, false, ErrPlaygroundAttachmentConflict
		}
		return existing, false, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, err
	}

	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return nil, false, err
	}
	now := common.GetTimestamp()
	objectKey := playgroundAttachmentObjectKey(userID, now, key)
	info, err := store.Put(ctx, objectKey, bytes.NewReader(input.Data))
	if err != nil {
		return nil, false, err
	}
	written := &PlaygroundAttachment{StorageBackend: store.Backend(), ObjectKey: objectKey}
	if info.Size != int64(len(input.Data)) {
		deletePlaygroundAttachmentObject(store, written)
		return nil, false, errors.New("Playground attachment object store wrote an unexpected size.")
	}

	var attachment PlaygroundAttachment
	err = DB.Transaction(func(tx *gorm.DB) error {
		if err := lockParent(tx); err != nil {
			return err
		}
		// The account counter row is the single serialization point for the
		// per-account file and byte budgets, so uploads for different
		// partitions cannot overrun them and the relay's quota settlement on
		// the users row stays untouched.
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		size := int64(len(input.Data))
		if size > policy.AttachmentMaxFileBytes {
			return ErrPlaygroundAttachmentLimit
		}
		if usage.AttachmentCount >= int64(policy.AttachmentUserMaxCount) {
			return ErrPlaygroundAttachmentLimit
		}
		if usage.AttachmentBytes+size > policy.AttachmentUserMaxBytes {
			return ErrPlaygroundAttachmentLimit
		}
		// The object-store budget is the account's storage entitlement: the
		// same counter row serializes it, so concurrent uploads cannot push
		// the stored bytes past the limit. Existing objects stay readable.
		if usage.ObjectBytes+size > policy.ObjectUserMaxBytes {
			return ErrPlaygroundAttachmentLimit
		}
		attachment = PlaygroundAttachment{
			ID: "pgf_" + key, UserID: userID, SessionID: partitionID,
			MediaType: input.MediaType, Filename: input.Filename,
			ByteSize: size, ContentHash: contentHash,
			ClientKeyHash:  clientKeyHash,
			StorageBackend: store.Backend(), ObjectKey: objectKey,
			ReferencedAt: 0, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(&attachment).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{AttachmentCount: 1, AttachmentBytes: size, ObjectBytes: playgroundAttachmentObjectBytes(&attachment)})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		// The bytes never became a durable row; retrying the database write
		// rewrites the same object key, so the copy can be dropped now.
		deletePlaygroundAttachmentObject(store, written)
		// A concurrent upload with the same client ID may have won the unique
		// index; a replay of identical content acknowledges that winner.
		if existing, findErr := findPlaygroundAttachmentByClientKey(userID, clientKeyHash); findErr == nil {
			if !playgroundAttachmentMatchesRequest(existing, partitionID, input.MediaType, input.Filename, contentHash) {
				return nil, false, ErrPlaygroundAttachmentConflict
			}
			return existing, false, nil
		}
		return nil, false, err
	}
	return &attachment, true, nil
}

func GetPlaygroundAttachment(userID int, sessionID, id string) (*PlaygroundAttachment, error) {
	var attachment PlaygroundAttachment
	err := DB.Where("id = ? AND user_id = ? AND session_id = ?", id, userID, sessionID).First(&attachment).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundAttachmentNotFound
	}
	if err != nil {
		return nil, err
	}
	return &attachment, nil
}

// GetPlaygroundAttachmentsByIDs resolves message references without loading bytes.
func GetPlaygroundAttachmentsByIDs(userID int, sessionID string, ids []string) (map[string]PlaygroundAttachment, error) {
	attachments := make(map[string]PlaygroundAttachment, len(ids))
	if len(ids) == 0 {
		return attachments, nil
	}
	var stored []PlaygroundAttachment
	if err := DB.Select("id, user_id, session_id, media_type, filename, byte_size").
		Where("user_id = ? AND session_id = ? AND id IN ?", userID, sessionID, ids).
		Find(&stored).Error; err != nil {
		return nil, err
	}
	for _, attachment := range stored {
		attachments[attachment.ID] = attachment
	}
	return attachments, nil
}

func ListPlaygroundAttachments(userID int, sessionID string, offset, limit int) ([]PlaygroundAttachment, int64, error) {
	if offset < 0 || limit < 1 {
		return nil, 0, ErrPlaygroundAttachmentInvalid
	}
	attachments := make([]PlaygroundAttachment, 0)
	var count int64
	err := DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundSession(tx, userID, sessionID); err != nil {
			return err
		}
		query := tx.Model(&PlaygroundAttachment{}).Where("user_id = ? AND session_id = ?", userID, sessionID)
		if err := query.Count(&count).Error; err != nil {
			return err
		}
		return query.Select("id, user_id, session_id, media_type, filename, byte_size, referenced_at, created_at, updated_at").
			Order("created_at DESC, id DESC").Offset(offset).Limit(limit).Find(&attachments).Error
	})
	if err != nil {
		return nil, 0, err
	}
	return attachments, count, nil
}

func DeletePlaygroundAttachment(userID int, sessionID, id string) error {
	var removed PlaygroundAttachment
	err := DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundSession(tx, userID, sessionID); err != nil {
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		var attachment PlaygroundAttachment
		err = lockForUpdate(tx).Where("id = ? AND user_id = ? AND session_id = ?", id, userID, sessionID).First(&attachment).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundAttachmentNotFound
		}
		if err != nil {
			return err
		}
		if attachment.ReferencedAt > 0 {
			return ErrPlaygroundAttachmentInUse
		}
		var pinned int64
		if err := tx.Model(&PlaygroundCanvasAsset{}).Where("attachment_id = ? AND user_id = ?", id, userID).Count(&pinned).Error; err != nil {
			return err
		}
		if pinned > 0 {
			return ErrPlaygroundAttachmentInUse
		}
		if err := tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundAttachment{}).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{
			AttachmentCount: -1,
			AttachmentBytes: -attachment.ByteSize,
			ObjectBytes:     -playgroundAttachmentObjectBytes(&attachment),
		})
		if err := savePlaygroundUserUsage(tx, usage); err != nil {
			return err
		}
		removed = attachment
		return nil
	})
	if err != nil {
		return err
	}
	deletePlaygroundAttachmentObject(nil, &removed)
	return nil
}

// syncPlaygroundAttachmentReferences recomputes which attachments the stored
// message snapshot references. Only rows whose reference state actually changes
// are written, so an unrelated message save never resets the orphan countdown of
// an attachment it still (or still does not) reference. It reports whether any
// row changed.
func syncPlaygroundAttachmentReferences(tx *gorm.DB, userID int, sessionID string, referencedIDs []string) (bool, error) {
	var attachments []PlaygroundAttachment
	if err := tx.Select("id", "referenced_at").
		Where("user_id = ? AND session_id = ?", userID, sessionID).Find(&attachments).Error; err != nil {
		return false, err
	}
	wanted := make(map[string]bool, len(referencedIDs))
	for _, id := range referencedIDs {
		wanted[id] = true
	}
	changed := false
	now := common.GetTimestamp()
	for index := range attachments {
		attachment := &attachments[index]
		if wanted[attachment.ID] == (attachment.ReferencedAt > 0) {
			continue
		}
		referencedAt := int64(0)
		if wanted[attachment.ID] {
			referencedAt = now
		}
		if err := tx.Model(&PlaygroundAttachment{}).
			Where("id = ? AND user_id = ?", attachment.ID, userID).
			Updates(map[string]any{"referenced_at": referencedAt, "updated_at": now}).Error; err != nil {
			return false, err
		}
		changed = true
	}
	return changed, nil
}

// DeleteOrphanedPlaygroundAttachments removes unreferenced attachments whose
// last state change predates the cutoff, together with their stored objects.
// Referenced rows and attachments pinned by a canvas are never touched. Each
// row is deleted under the same guards it was selected with, so bytes are only
// dropped after their row is really gone.
func DeleteOrphanedPlaygroundAttachments(updatedBefore int64, batchSize int) (int64, error) {
	if batchSize <= 0 {
		batchSize = 200
	}
	var total int64
	for {
		rows := make([]PlaygroundAttachment, 0, batchSize)
		if err := DB.Select("id", "user_id", "byte_size", "storage_backend", "object_key").
			Where("referenced_at = 0 AND updated_at < ? AND id NOT IN (?)", updatedBefore,
				DB.Model(&PlaygroundCanvasAsset{}).Select("attachment_id")).
			Order("updated_at ASC, id ASC").Limit(batchSize).Find(&rows).Error; err != nil {
			return total, err
		}
		for index := range rows {
			row := &rows[index]
			deleted := false
			err := DB.Transaction(func(tx *gorm.DB) error {
				usage, err := lockPlaygroundUserUsage(tx, row.UserID)
				if err != nil {
					return err
				}
				result := tx.Where("id = ? AND referenced_at = 0 AND updated_at < ? AND id NOT IN (?)", row.ID, updatedBefore,
					tx.Model(&PlaygroundCanvasAsset{}).Select("attachment_id")).Delete(&PlaygroundAttachment{})
				if result.Error != nil {
					return result.Error
				}
				if result.RowsAffected == 0 {
					// The row was referenced or pinned after the batch read, so
					// it no longer matches and must keep its bytes.
					return nil
				}
				usage.apply(playgroundUserUsageDelta{
					AttachmentCount: -1,
					AttachmentBytes: -row.ByteSize,
					ObjectBytes:     -playgroundAttachmentObjectBytes(row),
				})
				if err := savePlaygroundUserUsage(tx, usage); err != nil {
					return err
				}
				deleted = true
				return nil
			})
			if err != nil {
				return total, err
			}
			if !deleted {
				continue
			}
			total++
			deletePlaygroundAttachmentObject(nil, row)
		}
		if len(rows) < batchSize {
			return total, nil
		}
	}
}

// MigratePlaygroundAttachmentsToObjectStore moves up to maxRows
// database-backed attachments into store, one attachment at a time: the
// base64 payload is decoded and verified against content_hash, the object is
// written and read back for verification, and only then is the row atomically
// switched to the object backend with data cleared. A failed row keeps its
// bytes untouched and is retried by the next run. The rollback path is
// RestorePlaygroundAttachmentsToDatabase.
func MigratePlaygroundAttachmentsToObjectStore(store objectstore.Store, maxRows int) (PlaygroundAttachmentStorageMigrationResult, error) {
	if store == nil {
		return PlaygroundAttachmentStorageMigrationResult{}, ErrPlaygroundAttachmentStorage
	}
	if maxRows <= 0 {
		maxRows = playgroundAttachmentMigrateSelectBatch
	}
	result := PlaygroundAttachmentStorageMigrationResult{}
	cursor := ""
	for scanned := 0; scanned < maxRows; {
		limit := playgroundAttachmentMigrateSelectBatch
		if remaining := maxRows - scanned; remaining < limit {
			limit = remaining
		}
		rows := make([]PlaygroundAttachment, 0, limit)
		if err := DB.Where("storage_backend IS NULL OR storage_backend = ? OR storage_backend = ''", playgroundAttachmentStorageDatabase).
			Where("id > ?", cursor).Order("id ASC").Limit(limit).Find(&rows).Error; err != nil {
			return result, err
		}
		if len(rows) == 0 {
			return result, nil
		}
		for index := range rows {
			scanned++
			if err := migratePlaygroundAttachmentRow(store, &rows[index]); err != nil {
				result.Failed++
				continue
			}
			result.Moved++
		}
		cursor = rows[len(rows)-1].ID
		if len(rows) < limit {
			return result, nil
		}
	}
	return result, nil
}

func migratePlaygroundAttachmentRow(store objectstore.Store, attachment *PlaygroundAttachment) error {
	if attachment.Data == nil {
		return errors.New("attachment has no database payload to migrate")
	}
	data, err := base64.StdEncoding.DecodeString(string(*attachment.Data))
	if err != nil {
		return fmt.Errorf("decode attachment %s: %w", attachment.ID, err)
	}
	if int64(len(data)) != attachment.ByteSize || playgroundAttachmentContentHash(data) != attachment.ContentHash {
		return fmt.Errorf("attachment %s content hash does not match its stored bytes", attachment.ID)
	}
	key := playgroundAttachmentObjectKey(attachment.UserID, attachment.CreatedAt, attachment.ID)
	ctx, cancel := context.WithTimeout(context.Background(), playgroundAttachmentObjectTimeout)
	defer cancel()
	if _, err := store.Put(ctx, key, bytes.NewReader(data)); err != nil {
		return err
	}
	if _, err := readPlaygroundAttachmentObject(ctx, store, key, attachment.ByteSize, attachment.ContentHash); err != nil {
		deletePlaygroundAttachmentObject(store, &PlaygroundAttachment{StorageBackend: store.Backend(), ObjectKey: key})
		return err
	}
	// UpdateColumns skips the UpdatedAt auto-touch: moving bytes must not reset
	// the orphan countdown of an unreferenced attachment. The database switch
	// and the counter change commit together, so the object footprint never
	// drifts from the rows.
	err = DB.Transaction(func(tx *gorm.DB) error {
		usage, err := lockPlaygroundUserUsage(tx, attachment.UserID)
		if err != nil {
			return err
		}
		updated := tx.Model(&PlaygroundAttachment{}).
			Where("id = ? AND (storage_backend IS NULL OR storage_backend = ? OR storage_backend = '')", attachment.ID, playgroundAttachmentStorageDatabase).
			UpdateColumns(map[string]any{"storage_backend": store.Backend(), "object_key": key, "data": nil})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return errPlaygroundAttachmentMigrationConflict
		}
		usage.apply(playgroundUserUsageDelta{ObjectBytes: attachment.ByteSize})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err == nil {
		return nil
	}
	if errors.Is(err, errPlaygroundAttachmentMigrationConflict) {
		// Another worker finished or removed this row first. Only drop the copy
		// when the row is gone; a row already switched to the same backend and
		// key is owned by the winner and must keep the bytes.
		var count int64
		if countErr := DB.Model(&PlaygroundAttachment{}).Where("id = ?", attachment.ID).Count(&count).Error; countErr == nil && count == 0 {
			deletePlaygroundAttachmentObject(store, &PlaygroundAttachment{StorageBackend: store.Backend(), ObjectKey: key})
		}
		return err
	}
	// The transaction rolled back, so the row still reads its database payload
	// and this copy is redundant.
	deletePlaygroundAttachmentObject(store, &PlaygroundAttachment{StorageBackend: store.Backend(), ObjectKey: key})
	return err
}

// RestorePlaygroundAttachmentsToDatabase copies up to maxRows object-backed
// attachments back into the data column and marks them database-backed again.
// It is the rollback path for MigratePlaygroundAttachmentsToObjectStore: the
// bytes are verified against content_hash before the row is switched, and the
// object is removed only after the database write committed.
func RestorePlaygroundAttachmentsToDatabase(store objectstore.Store, maxRows int) (PlaygroundAttachmentStorageMigrationResult, error) {
	if store == nil {
		return PlaygroundAttachmentStorageMigrationResult{}, ErrPlaygroundAttachmentStorage
	}
	if maxRows <= 0 {
		maxRows = playgroundAttachmentMigrateSelectBatch
	}
	result := PlaygroundAttachmentStorageMigrationResult{}
	cursor := ""
	for scanned := 0; scanned < maxRows; {
		limit := playgroundAttachmentMigrateSelectBatch
		if remaining := maxRows - scanned; remaining < limit {
			limit = remaining
		}
		rows := make([]PlaygroundAttachment, 0, limit)
		if err := DB.Where("storage_backend IS NOT NULL AND storage_backend <> ? AND storage_backend <> '' AND object_key IS NOT NULL AND object_key <> ''", playgroundAttachmentStorageDatabase).
			Where("id > ?", cursor).Order("id ASC").Limit(limit).Find(&rows).Error; err != nil {
			return result, err
		}
		if len(rows) == 0 {
			return result, nil
		}
		for index := range rows {
			scanned++
			if err := restorePlaygroundAttachmentRow(store, &rows[index]); err != nil {
				result.Failed++
				continue
			}
			result.Moved++
		}
		cursor = rows[len(rows)-1].ID
		if len(rows) < limit {
			return result, nil
		}
	}
	return result, nil
}

func restorePlaygroundAttachmentRow(store objectstore.Store, attachment *PlaygroundAttachment) error {
	ctx, cancel := context.WithTimeout(context.Background(), playgroundAttachmentObjectTimeout)
	defer cancel()
	data, err := readPlaygroundAttachmentObject(ctx, store, attachment.ObjectKey, attachment.ByteSize, attachment.ContentHash)
	if err != nil {
		return err
	}
	err = DB.Transaction(func(tx *gorm.DB) error {
		usage, err := lockPlaygroundUserUsage(tx, attachment.UserID)
		if err != nil {
			return err
		}
		updated := tx.Model(&PlaygroundAttachment{}).
			Where("id = ? AND storage_backend = ? AND object_key = ?", attachment.ID, attachment.StorageBackend, attachment.ObjectKey).
			UpdateColumns(map[string]any{
				"data":            base64.StdEncoding.EncodeToString(data),
				"storage_backend": playgroundAttachmentStorageDatabase,
				"object_key":      "",
			})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return errors.New("attachment was restored or deleted concurrently")
		}
		usage.apply(playgroundUserUsageDelta{ObjectBytes: -attachment.ByteSize})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		return err
	}
	// The row is database-backed again; drop the object with the backend/key
	// captured before the row changed.
	deletePlaygroundAttachmentObject(store, &PlaygroundAttachment{StorageBackend: attachment.StorageBackend, ObjectKey: attachment.ObjectKey})
	return nil
}
