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
	"errors"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service/objectstore"
	"gorm.io/gorm"
)

const (
	// PlaygroundUploadPartitionSession marks a reservation whose partition is a
	// conversation.
	PlaygroundUploadPartitionSession = "session"
	// PlaygroundUploadPartitionCanvas marks a reservation whose partition is a
	// canvas project.
	PlaygroundUploadPartitionCanvas = "canvas"
	// playgroundUploadReservationTTL is the minimum lifetime of a reservation.
	// The presigned URL may expire sooner, but a reservation is only released by
	// the scheduled cleanup once both windows have passed, so a slow but valid
	// completion still commits.
	playgroundUploadReservationTTL = time.Hour
	// playgroundUploadExpiryGrace keeps a reservation alive a little past its
	// upload window, covering presign lifetimes longer than the reservation
	// floor and clock skew between the client and the gateway.
	playgroundUploadExpiryGrace = 5 * time.Minute
	// playgroundUploadSniffBytes is how many leading bytes of a stored object
	// are checked against the declared media type.
	playgroundUploadSniffBytes = 512
	// playgroundUploadCleanupBatch bounds how many objects one cleanup run
	// releases.
	playgroundUploadCleanupBatch = 200
)

var (
	// ErrPlaygroundUploadNotFound reports an unknown, foreign or already
	// finished upload reservation.
	ErrPlaygroundUploadNotFound = errors.New("Playground upload not found.")
	// ErrPlaygroundUploadIncomplete reports a reservation whose bytes never
	// arrived or arrived with a size that does not match the declared one.
	ErrPlaygroundUploadIncomplete = errors.New("The uploaded file is missing or has the wrong size.")
	// ErrPlaygroundUploadContentMismatch reports bytes that are not the media
	// type the reservation declared.
	ErrPlaygroundUploadContentMismatch = errors.New("The uploaded file does not match the declared media type.")
)

// PlaygroundUpload is one in-flight upload reservation. The row exists exactly
// while the account's budgets reserve room for its declared size: the create
// path inserts it, completing it turns it into a PlaygroundAttachment in the
// same transaction that deletes it, and canceling or the scheduled cleanup
// releases it. The bytes may never have arrived (a direct presigned upload that
// was never issued), so a reservation is quota, not data.
type PlaygroundUpload struct {
	ID     string `gorm:"size:32;primaryKey"`
	UserID int    `gorm:"not null;uniqueIndex:uk_playground_upload_client,priority:1"`
	// SessionID is the reservation's partition: the conversation id of a chat
	// upload or the canvas id of a workspace upload. Ownership is always the
	// UserID row, so a partition that no longer resolves never completes.
	SessionID string `gorm:"size:128;not null;index"`
	// Partition names the partition kind so completing the upload locks the
	// same owning row the classic upload path locks.
	Partition      string `gorm:"size:16;not null"`
	MediaType      string `gorm:"size:100;not null"`
	Filename       string `gorm:"size:255;not null"`
	ByteSize       int64  `gorm:"not null"`
	ClientKeyHash  string `gorm:"size:64;not null;uniqueIndex:uk_playground_upload_client,priority:2"`
	StorageBackend string `gorm:"size:32"`
	ObjectKey      string `gorm:"size:512"`
	CreatedAt      int64  `gorm:"not null;index"`
	ExpiresAt      int64  `gorm:"not null;index"`
	UpdatedAt      int64  `gorm:"not null"`
}

// TableName pins the table name the plan defines; GORM would otherwise
// pluralize the model name.
func (PlaygroundUpload) TableName() string {
	return "playground_uploads"
}

// PlaygroundUploadRequest is one reservation request. Only metadata arrives:
// the bytes go straight to the object store through the presigned URL, or
// through the relay route when the backend cannot hand one out.
type PlaygroundUploadRequest struct {
	ClientKey string
	MediaType string
	Filename  string
	ByteSize  int64
}

// PlaygroundUploadReservation is the outcome of CreatePlaygroundUpload: either
// Upload, a fresh reservation that still has to receive its bytes, or
// Attachment, when the client key already finished an upload of the same file
// and the request is a replay.
type PlaygroundUploadReservation struct {
	Upload     *PlaygroundUpload
	Attachment *PlaygroundAttachment
}

// lockPartition locks the owning resource of the reservation inside the
// surrounding transaction, so a foreign or missing partition is rejected before
// anything is written and a concurrent delete serializes against the upload.
func (upload *PlaygroundUpload) lockPartition(tx *gorm.DB, userID int) error {
	switch upload.Partition {
	case PlaygroundUploadPartitionSession:
		_, err := lockPlaygroundSession(tx, userID, upload.SessionID)
		return err
	case PlaygroundUploadPartitionCanvas:
		return lockPlaygroundCanvasProject(tx, userID, upload.SessionID)
	default:
		return ErrPlaygroundUploadNotFound
	}
}

// playgroundUploadExpiresAt resolves when a reservation inserted now is
// released if nothing completes it. The resource pre-check and the
// transactional validation share it, so the scheduled cleanup can never drop a
// reservation that a still-valid presigned URL is serving.
func playgroundUploadExpiresAt(now int64) int64 {
	ttl := objectstore.DefaultPresignTTL()
	if ttl < playgroundUploadReservationTTL {
		ttl = playgroundUploadReservationTTL
	}
	return now + int64(ttl.Seconds()) + int64(playgroundUploadExpiryGrace.Seconds())
}

// playgroundUploadRandomKey is the random suffix a reservation shares with the
// attachment id completing it creates, so the object key stays the layout of
// every other attachment.
func playgroundUploadRandomKey(uploadID string) string {
	return strings.TrimPrefix(uploadID, "pgu_")
}

func findPlaygroundUploadByClientKey(userID int, clientKeyHash string) (*PlaygroundUpload, error) {
	var upload PlaygroundUpload
	if err := DB.Where("user_id = ? AND client_key_hash = ?", userID, clientKeyHash).First(&upload).Error; err != nil {
		return nil, err
	}
	return &upload, nil
}

func playgroundUploadMatchesRequest(upload *PlaygroundUpload, partition, partitionID, mediaType, filename string, byteSize int64) bool {
	return upload.Partition == partition && upload.SessionID == partitionID &&
		upload.MediaType == mediaType && upload.Filename == filename && upload.ByteSize == byteSize
}

func playgroundAttachmentMatchesUploadRequest(attachment *PlaygroundAttachment, partitionID, mediaType, filename string, byteSize int64) bool {
	return attachment.SessionID == partitionID && attachment.MediaType == mediaType &&
		attachment.Filename == filename && attachment.ByteSize == byteSize
}

// CreatePlaygroundUpload reserves the account's attachment and object budgets
// for one declared file and returns the reservation a client uploads into. The
// reservation, the capacity checks and the counter update commit together, so
// concurrent uploads of any partition cannot overrun the account. The client
// key is the idempotency key of the whole upload: a retry returns the same
// reservation, and a key that already completed returns the stored attachment
// instead of uploading the same file twice.
func CreatePlaygroundUpload(userID int, partition, partitionID string, request PlaygroundUploadRequest) (PlaygroundUploadReservation, error) {
	if userID <= 0 {
		return PlaygroundUploadReservation{}, gorm.ErrRecordNotFound
	}
	input := PlaygroundAttachmentInput{
		ClientKey: request.ClientKey, MediaType: request.MediaType, Filename: request.Filename,
	}
	// The declared media type must be known before its per-file budget exists:
	// normalize the text, resolve the budget, then validate the payload size.
	if err := normalizePlaygroundAttachmentText(&input); err != nil {
		return PlaygroundUploadReservation{}, err
	}
	policy, err := PlaygroundQuotaPolicyForUser(userID)
	if err != nil {
		return PlaygroundUploadReservation{}, err
	}
	if request.ByteSize <= 0 || request.ByteSize > policy.AttachmentMediaMaxFileBytes(input.MediaType) {
		return PlaygroundUploadReservation{}, ErrPlaygroundAttachmentLimit
	}
	store := objectstore.DefaultStore()
	if store == nil {
		return PlaygroundUploadReservation{}, ErrPlaygroundAttachmentStorage
	}
	clientKeyHash := playgroundAttachmentClientKeyHash(input.ClientKey)
	if existing, err := findPlaygroundAttachmentByClientKey(userID, clientKeyHash); err == nil {
		if !playgroundAttachmentMatchesUploadRequest(existing, partitionID, input.MediaType, input.Filename, request.ByteSize) {
			return PlaygroundUploadReservation{}, ErrPlaygroundAttachmentConflict
		}
		return PlaygroundUploadReservation{Attachment: existing}, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return PlaygroundUploadReservation{}, err
	}
	if existing, err := findPlaygroundUploadByClientKey(userID, clientKeyHash); err == nil {
		if !playgroundUploadMatchesRequest(existing, partition, partitionID, input.MediaType, input.Filename, request.ByteSize) {
			return PlaygroundUploadReservation{}, ErrPlaygroundAttachmentConflict
		}
		return PlaygroundUploadReservation{Upload: existing}, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return PlaygroundUploadReservation{}, err
	}

	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return PlaygroundUploadReservation{}, err
	}
	now := common.GetTimestamp()
	upload := PlaygroundUpload{
		ID: "pgu_" + key, UserID: userID, SessionID: partitionID, Partition: partition,
		MediaType: input.MediaType, Filename: input.Filename, ByteSize: request.ByteSize,
		ClientKeyHash: clientKeyHash, StorageBackend: store.Backend(),
		ObjectKey: playgroundAttachmentObjectKey(userID, now, key),
		CreatedAt: now, ExpiresAt: playgroundUploadExpiresAt(now), UpdatedAt: now,
	}
	err = DB.Transaction(func(tx *gorm.DB) error {
		if err := upload.lockPartition(tx, userID); err != nil {
			return err
		}
		// The account counter row is the single serialization point, exactly as
		// on the classic upload path, so pending reservations and stored
		// attachments are checked in one place.
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		size := upload.ByteSize
		if size > policy.AttachmentMediaMaxFileBytes(upload.MediaType) {
			return ErrPlaygroundAttachmentLimit
		}
		// Pending reservations count against every budget they will occupy
		// once completed, so concurrent uploads cannot overrun an account.
		if usage.AttachmentCount+usage.AttachmentPendingCount >= int64(policy.AttachmentUserMaxCount) {
			return ErrPlaygroundAttachmentLimit
		}
		if usage.AttachmentBytes+usage.AttachmentPendingBytes+size > policy.AttachmentUserMaxBytes {
			return ErrPlaygroundAttachmentLimit
		}
		if usage.ObjectBytes+usage.AttachmentPendingBytes+size > policy.ObjectUserMaxBytes {
			return ErrPlaygroundAttachmentLimit
		}
		if err := tx.Create(&upload).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{AttachmentPendingCount: 1, AttachmentPendingBytes: size})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		// A concurrent reservation with the same client key may have won the
		// unique index; a replay of identical metadata acknowledges it.
		if existing, findErr := findPlaygroundUploadByClientKey(userID, clientKeyHash); findErr == nil {
			if !playgroundUploadMatchesRequest(existing, partition, partitionID, input.MediaType, input.Filename, request.ByteSize) {
				return PlaygroundUploadReservation{}, ErrPlaygroundAttachmentConflict
			}
			return PlaygroundUploadReservation{Upload: existing}, nil
		}
		return PlaygroundUploadReservation{}, err
	}
	return PlaygroundUploadReservation{Upload: &upload}, nil
}

// GetPlaygroundUpload resolves one owned reservation without locking it.
// Another account's upload id answers exactly like a missing one.
func GetPlaygroundUpload(userID int, uploadID string) (*PlaygroundUpload, error) {
	if userID <= 0 || uploadID == "" {
		return nil, ErrPlaygroundUploadNotFound
	}
	var upload PlaygroundUpload
	err := DB.Where("id = ? AND user_id = ?", uploadID, userID).First(&upload).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundUploadNotFound
	}
	if err != nil {
		return nil, err
	}
	return &upload, nil
}

// PlaygroundUploadPresignedPut returns a short-lived signed PUT for the
// reservation, or an empty string when the configured backend cannot hand one
// out: the caller then relays the bytes through the gateway. The declared media
// type travels with the signed request where the backend supports it, and
// completing the upload re-verifies the stored bytes either way.
func PlaygroundUploadPresignedPut(ctx context.Context, upload *PlaygroundUpload) (string, error) {
	if upload == nil || upload.ObjectKey == "" {
		return "", ErrPlaygroundUploadNotFound
	}
	store := objectstore.DefaultStore()
	if store == nil {
		return "", ErrPlaygroundAttachmentStorage
	}
	presigner, ok := store.(objectstore.PresignPutter)
	if !ok {
		return "", nil
	}
	location, err := presigner.PresignPutWithContentType(ctx, upload.ObjectKey, upload.MediaType, objectstore.DefaultPresignTTL())
	if errors.Is(err, objectstore.ErrPresignUnsupported) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	// Only an absolute http(s) link may leave the gateway; anything else falls
	// back to the relay route instead of handing the client an unusable URL.
	parsed, err := url.Parse(location)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", nil
	}
	return location, nil
}

// WritePlaygroundUploadContent stores the relayed bytes of one reservation
// under the key it already owns. The caller bounds the transport; this function
// additionally refuses anything that is not exactly the declared size, so a
// truncated or padded upload is dropped instead of becoming an attachment.
func WritePlaygroundUploadContent(ctx context.Context, upload *PlaygroundUpload, body io.Reader) (int64, error) {
	if upload == nil || upload.ObjectKey == "" {
		return 0, ErrPlaygroundUploadNotFound
	}
	store := objectstore.DefaultStore()
	if store == nil {
		return 0, ErrPlaygroundAttachmentStorage
	}
	// One byte of slack lets the copy observe an overlong body as a size
	// mismatch instead of truncating it silently.
	info, err := store.Put(ctx, upload.ObjectKey, io.LimitReader(body, upload.ByteSize+1))
	if err != nil {
		return 0, err
	}
	if info.Size != upload.ByteSize {
		// The body did not match the reservation: drop it so a retry starts
		// from a clean object, and keep the reservation for that retry.
		deletePlaygroundUploadObject(store, upload)
		if info.Size > upload.ByteSize {
			return 0, ErrPlaygroundAttachmentLimit
		}
		return 0, ErrPlaygroundUploadIncomplete
	}
	return info.Size, nil
}

// CompletePlaygroundUpload verifies the stored object against the reservation
// and turns it into an attachment. HEAD proves the size without reading the
// body; one streaming pass then re-checks the length, hashes the bytes, and
// sniffs the leading bytes against the declared media type. Any failure drops
// the object and releases the reservation, so a rejected upload never leaves
// bytes or reserved quota behind.
func CompletePlaygroundUpload(ctx context.Context, userID int, uploadID string) (*PlaygroundAttachment, bool, error) {
	upload, err := GetPlaygroundUpload(userID, uploadID)
	if err != nil {
		return nil, false, err
	}
	store := objectstore.DefaultStore()
	if store == nil {
		return nil, false, ErrPlaygroundAttachmentStorage
	}
	objectCtx, cancel := context.WithTimeout(ctx, playgroundAttachmentObjectTimeout)
	defer cancel()
	contentHash, err := verifyPlaygroundUploadObject(objectCtx, store, upload)
	if err != nil {
		releaseFailedPlaygroundUpload(store, upload)
		return nil, false, err
	}
	attachment, created, err := commitPlaygroundUpload(upload, contentHash)
	if err == nil {
		return attachment, created, nil
	}
	return resolveFailedPlaygroundUploadCommit(store, upload, contentHash, err)
}

// verifyPlaygroundUploadObject proves that the stored object is complete and
// really carries the declared media type, returning the content hash the
// attachment row records.
func verifyPlaygroundUploadObject(ctx context.Context, store objectstore.Store, upload *PlaygroundUpload) (string, error) {
	info, err := store.Head(ctx, upload.ObjectKey)
	if err != nil {
		if errors.Is(err, objectstore.ErrObjectNotFound) {
			return "", ErrPlaygroundUploadIncomplete
		}
		return "", err
	}
	if info.Size != upload.ByteSize {
		return "", ErrPlaygroundUploadIncomplete
	}
	reader, _, err := store.Get(ctx, upload.ObjectKey)
	if err != nil {
		if errors.Is(err, objectstore.ErrObjectNotFound) {
			return "", ErrPlaygroundUploadIncomplete
		}
		return "", err
	}
	defer reader.Close()
	hash := sha256.New()
	head := make([]byte, 0, playgroundUploadSniffBytes)
	buffer := make([]byte, 32<<10)
	var total int64
	for {
		read, readErr := reader.Read(buffer)
		if read > 0 {
			total += int64(read)
			if total > upload.ByteSize {
				return "", ErrPlaygroundUploadIncomplete
			}
			_, _ = hash.Write(buffer[:read])
			if remaining := playgroundUploadSniffBytes - len(head); remaining > 0 {
				head = append(head, buffer[:min(read, remaining)]...)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return "", readErr
		}
	}
	if total != upload.ByteSize {
		return "", ErrPlaygroundUploadIncomplete
	}
	if !playgroundAttachmentMatchesMediaType(upload.MediaType, head) {
		return "", ErrPlaygroundUploadContentMismatch
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// commitPlaygroundUpload writes the attachment row and deletes the reservation
// in one transaction, moving the counters from reserved to committed. Deleting
// the reservation is the claim: only the transaction that removes the row may
// move the counters, so completing, canceling and the scheduled cleanup can
// never both act on one reservation.
func commitPlaygroundUpload(upload *PlaygroundUpload, contentHash string) (*PlaygroundAttachment, bool, error) {
	var attachment PlaygroundAttachment
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := upload.lockPartition(tx, upload.UserID); err != nil {
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, upload.UserID)
		if err != nil {
			return err
		}
		// The reservation already holds the budget, but an administrator may
		// have lowered a limit while the bytes were in flight.
		policy, err := playgroundPolicyForUser(tx, upload.UserID)
		if err != nil {
			return err
		}
		size := upload.ByteSize
		if usage.AttachmentCount+1 > int64(policy.AttachmentUserMaxCount) {
			return ErrPlaygroundAttachmentLimit
		}
		if usage.AttachmentBytes+size > policy.AttachmentUserMaxBytes {
			return ErrPlaygroundAttachmentLimit
		}
		if usage.ObjectBytes+size > policy.ObjectUserMaxBytes {
			return ErrPlaygroundAttachmentLimit
		}
		claimed := tx.Where("id = ? AND user_id = ?", upload.ID, upload.UserID).Delete(&PlaygroundUpload{})
		if claimed.Error != nil {
			return claimed.Error
		}
		if claimed.RowsAffected != 1 {
			return ErrPlaygroundUploadNotFound
		}
		attachment = PlaygroundAttachment{
			ID: "pgf_" + playgroundUploadRandomKey(upload.ID), UserID: upload.UserID, SessionID: upload.SessionID,
			MediaType: upload.MediaType, Filename: upload.Filename, ByteSize: size, ContentHash: contentHash,
			ClientKeyHash: upload.ClientKeyHash, StorageBackend: upload.StorageBackend, ObjectKey: upload.ObjectKey,
			ReferencedAt: 0, CreatedAt: upload.CreatedAt, UpdatedAt: common.GetTimestamp(),
		}
		if err := tx.Create(&attachment).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{
			AttachmentCount: 1, AttachmentBytes: size, ObjectBytes: playgroundAttachmentObjectBytes(&attachment),
			AttachmentPendingCount: -1, AttachmentPendingBytes: -size,
		})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		return nil, false, err
	}
	return &attachment, true, nil
}

// resolveFailedPlaygroundUploadCommit cleans up after a commit that could not
// finish. A reservation that another writer already claimed is never released
// here: its object may belong to the attachment that won the race, so only an
// identical replay is acknowledged and the object is left untouched.
func resolveFailedPlaygroundUploadCommit(store objectstore.Store, upload *PlaygroundUpload, contentHash string, commitErr error) (*PlaygroundAttachment, bool, error) {
	if errors.Is(commitErr, ErrPlaygroundUploadNotFound) {
		if existing, findErr := findPlaygroundAttachmentByClientKey(upload.UserID, upload.ClientKeyHash); findErr == nil {
			if playgroundAttachmentMatchesUploadRequest(existing, upload.SessionID, upload.MediaType, upload.Filename, upload.ByteSize) &&
				existing.ContentHash == contentHash {
				return existing, false, nil
			}
			return nil, false, ErrPlaygroundAttachmentConflict
		}
		return nil, false, commitErr
	}
	releaseFailedPlaygroundUpload(store, upload)
	// A concurrent complete of the same client key may have won the unique
	// index; identical content acknowledges that winner.
	if existing, findErr := findPlaygroundAttachmentByClientKey(upload.UserID, upload.ClientKeyHash); findErr == nil {
		if playgroundAttachmentMatchesUploadRequest(existing, upload.SessionID, upload.MediaType, upload.Filename, upload.ByteSize) &&
			existing.ContentHash == contentHash {
			return existing, false, nil
		}
		return nil, false, ErrPlaygroundAttachmentConflict
	}
	return nil, false, commitErr
}

// releaseFailedPlaygroundUpload drops the bytes of a rejected reservation and
// releases the quota it held. The object goes first: if the release itself
// fails, the scheduled cleanup finds the reservation and releases it later.
func releaseFailedPlaygroundUpload(store objectstore.Store, upload *PlaygroundUpload) {
	deletePlaygroundUploadObject(store, upload)
	if err := ReleasePlaygroundUpload(upload.UserID, upload.ID); err != nil && !errors.Is(err, ErrPlaygroundUploadNotFound) {
		common.SysError(common.LogText("failed to release Playground upload reservation %s: %s", upload.ID, err.Error()))
	}
}

// ReleasePlaygroundUpload cancels one reservation: the row and its quota are
// released in one transaction and the object (a partial direct upload included)
// is removed afterwards. Releasing an unknown, foreign or already finished
// upload answers exactly like a missing one.
func ReleasePlaygroundUpload(userID int, uploadID string) error {
	released, err := claimPlaygroundUpload(userID, uploadID)
	if err != nil {
		return err
	}
	deletePlaygroundUploadObject(nil, released)
	return nil
}

// claimPlaygroundUpload deletes one reservation and releases the quota it
// reserved, returning the removed row so the caller can drop its bytes.
func claimPlaygroundUpload(userID int, uploadID string) (*PlaygroundUpload, error) {
	var released PlaygroundUpload
	err := DB.Transaction(func(tx *gorm.DB) error {
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		var upload PlaygroundUpload
		err = lockForUpdate(tx).Where("id = ? AND user_id = ?", uploadID, userID).First(&upload).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundUploadNotFound
		}
		if err != nil {
			return err
		}
		if err := tx.Where("id = ? AND user_id = ?", upload.ID, userID).Delete(&PlaygroundUpload{}).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{AttachmentPendingCount: -1, AttachmentPendingBytes: -upload.ByteSize})
		if err := savePlaygroundUserUsage(tx, usage); err != nil {
			return err
		}
		released = upload
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &released, nil
}

// DeleteExpiredPlaygroundUploads releases reservations whose upload window
// elapsed without a complete, together with any object the client wrote. Each
// row is deleted under the same expiry guard it was selected with, so a
// completion that wins the race keeps its bytes.
func DeleteExpiredPlaygroundUploads(expiredBefore int64, batchSize int) (int64, error) {
	if batchSize <= 0 {
		batchSize = playgroundUploadCleanupBatch
	}
	var total int64
	for {
		rows := make([]PlaygroundUpload, 0, batchSize)
		if err := DB.Where("expires_at < ?", expiredBefore).
			Order("expires_at ASC, id ASC").Limit(batchSize).Find(&rows).Error; err != nil {
			return total, err
		}
		for index := range rows {
			released, err := claimExpiredPlaygroundUpload(&rows[index], expiredBefore)
			if err != nil {
				return total, err
			}
			if released == nil {
				continue
			}
			total++
			deletePlaygroundUploadObject(nil, released)
		}
		if len(rows) < batchSize {
			return total, nil
		}
	}
}

// claimExpiredPlaygroundUpload deletes one expired reservation under its expiry
// guard and releases its quota, returning nil when another writer already
// claimed the row.
func claimExpiredPlaygroundUpload(row *PlaygroundUpload, expiredBefore int64) (*PlaygroundUpload, error) {
	var released *PlaygroundUpload
	err := DB.Transaction(func(tx *gorm.DB) error {
		usage, err := lockPlaygroundUserUsage(tx, row.UserID)
		if err != nil {
			return err
		}
		result := tx.Where("id = ? AND user_id = ? AND expires_at < ?", row.ID, row.UserID, expiredBefore).
			Delete(&PlaygroundUpload{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		usage.apply(playgroundUserUsageDelta{AttachmentPendingCount: -1, AttachmentPendingBytes: -row.ByteSize})
		if err := savePlaygroundUserUsage(tx, usage); err != nil {
			return err
		}
		released = row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return released, nil
}

// deletePlaygroundUploadObject drops the bytes a reservation wrote and aborts
// every multipart upload that still targets the same key, so an interrupted
// direct upload releases its parts too. Failure is logged, never returned: the
// database is the authority, and a leftover object is reconciled by later
// maintenance instead of failing a request whose database state already
// committed.
func deletePlaygroundUploadObject(store objectstore.Store, upload *PlaygroundUpload) {
	if upload == nil || upload.ObjectKey == "" {
		return
	}
	if store == nil {
		store = objectstore.DefaultStore()
	}
	if store == nil {
		common.SysError(common.LogText("failed to delete Playground upload object %s: object store is not configured", upload.ObjectKey))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), playgroundAttachmentObjectTimeout)
	defer cancel()
	if err := store.Delete(ctx, upload.ObjectKey); err != nil && !errors.Is(err, objectstore.ErrObjectNotFound) {
		common.SysError(common.LogText("failed to delete Playground upload object %s: %s", upload.ObjectKey, err.Error()))
	}
	aborter, ok := store.(objectstore.MultipartAborter)
	if !ok {
		return
	}
	if err := aborter.AbortMultipartUploads(ctx, upload.ObjectKey); err != nil {
		common.SysError(common.LogText("failed to abort multipart uploads of %s: %s", upload.ObjectKey, err.Error()))
	}
}
