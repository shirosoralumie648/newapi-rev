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
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"gorm.io/gorm"
)

var (
	ErrPlaygroundAttachmentInvalid  = errors.New("Invalid Playground attachment.")
	ErrPlaygroundAttachmentNotFound = errors.New("Playground attachment not found.")
	ErrPlaygroundAttachmentConflict = errors.New("Playground attachment request ID was already used for different content.")
	ErrPlaygroundAttachmentLimit    = errors.New("Playground attachment storage limit exceeded.")
	ErrPlaygroundAttachmentInUse    = errors.New("Playground attachment is still referenced by a conversation message.")
	playgroundAttachmentMediaTypes  = map[string]bool{
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

// PlaygroundAttachment stores the bytes of one conversation attachment. Bytes
// live in the database for the same reason artifact snapshots do: the gateway
// has no separate object store, and backups must stay self-contained. The
// per-account byte budget keeps the table bounded.
type PlaygroundAttachment struct {
	ID          string `gorm:"size:32;primaryKey"`
	UserID      int    `gorm:"not null;uniqueIndex:uk_playground_attachment_client,priority:1"`
	SessionID   string `gorm:"size:128;not null;index"`
	MediaType   string `gorm:"size:100;not null"`
	Filename    string `gorm:"size:255;not null"`
	ByteSize    int64  `gorm:"not null"`
	ContentHash string `gorm:"size:64;not null"`
	// Hashing the client ID makes uniqueness case-sensitive even with MySQL's default collation.
	ClientKeyHash string `gorm:"size:64;not null;uniqueIndex:uk_playground_attachment_client,priority:2"`
	// Data is the canonical base64 encoding of the uploaded bytes.
	Data LongText `gorm:"not null"`
	// ReferencedAt is zero while no conversation message references the
	// attachment; the cleanup task deletes long-orphaned rows.
	ReferencedAt int64 `gorm:"not null;index"`
	CreatedAt    int64 `gorm:"not null;index"`
	UpdatedAt    int64 `gorm:"not null"`
}

type PlaygroundAttachmentInput struct {
	ClientKey string
	MediaType string
	Filename  string
	Data      []byte
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

func CreatePlaygroundAttachment(userID int, sessionID string, input PlaygroundAttachmentInput) (*PlaygroundAttachment, bool, error) {
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
	clientKeyHash := playgroundAttachmentClientKeyHash(input.ClientKey)
	contentHash := playgroundAttachmentContentHash(input.Data)

	// Client IDs are idempotency keys: retries after a lost response must not
	// store the same bytes twice.
	if existing, err := findPlaygroundAttachmentByClientKey(userID, clientKeyHash); err == nil {
		if !playgroundAttachmentMatchesRequest(existing, sessionID, input.MediaType, input.Filename, contentHash) {
			return nil, false, ErrPlaygroundAttachmentConflict
		}
		return existing, false, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, err
	}

	var attachment PlaygroundAttachment
	err = DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundSession(tx, userID, sessionID); err != nil {
			return err
		}
		// Locking the owner row makes the per-account byte and file budgets
		// exact even when uploads for different sessions race.
		var user User
		if err := lockForUpdate(tx).Where("id = ?", userID).First(&user).Error; err != nil {
			return err
		}
		policy := playground_setting.GetPlaygroundQuotaPolicy(user.Group)
		if int64(len(input.Data)) > policy.AttachmentMaxFileBytes {
			return ErrPlaygroundAttachmentLimit
		}
		var count, stored int64
		if err := tx.Model(&PlaygroundAttachment{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
			return err
		}
		if count >= int64(policy.AttachmentUserMaxCount) {
			return ErrPlaygroundAttachmentLimit
		}
		if err := tx.Model(&PlaygroundAttachment{}).Where("user_id = ?", userID).
			Select("COALESCE(SUM(byte_size), 0)").Scan(&stored).Error; err != nil {
			return err
		}
		if stored+int64(len(input.Data)) > policy.AttachmentUserMaxBytes {
			return ErrPlaygroundAttachmentLimit
		}
		key, err := common.GenerateRandomCharsKey(24)
		if err != nil {
			return err
		}
		now := common.GetTimestamp()
		attachment = PlaygroundAttachment{
			ID: "pgf_" + key, UserID: userID, SessionID: sessionID,
			MediaType: input.MediaType, Filename: input.Filename,
			ByteSize: int64(len(input.Data)), ContentHash: contentHash,
			ClientKeyHash: clientKeyHash,
			Data:          LongText(base64.StdEncoding.EncodeToString(input.Data)),
			ReferencedAt:  0, CreatedAt: now, UpdatedAt: now,
		}
		return tx.Create(&attachment).Error
	})
	if err != nil {
		// A concurrent upload with the same client ID may have won the unique
		// index; a replay of identical content acknowledges that winner.
		if existing, findErr := findPlaygroundAttachmentByClientKey(userID, clientKeyHash); findErr == nil {
			if !playgroundAttachmentMatchesRequest(existing, sessionID, input.MediaType, input.Filename, contentHash) {
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
	return DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundSession(tx, userID, sessionID); err != nil {
			return err
		}
		var attachment PlaygroundAttachment
		err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND session_id = ?", id, userID, sessionID).First(&attachment).Error
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
		return tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundAttachment{}).Error
	})
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
// last state change predates the cutoff. Referenced rows and attachments pinned
// by a canvas are never touched.
func DeleteOrphanedPlaygroundAttachments(updatedBefore int64, batchSize int) (int64, error) {
	if batchSize <= 0 {
		batchSize = 200
	}
	var total int64
	for {
		var ids []string
		if err := DB.Model(&PlaygroundAttachment{}).
			Where("referenced_at = 0 AND updated_at < ? AND id NOT IN (?)", updatedBefore,
				DB.Model(&PlaygroundCanvasAsset{}).Select("attachment_id")).
			Order("updated_at ASC, id ASC").Limit(batchSize).Pluck("id", &ids).Error; err != nil {
			return total, err
		}
		if len(ids) == 0 {
			return total, nil
		}
		result := DB.Where("id IN ? AND referenced_at = 0 AND updated_at < ? AND id NOT IN (?)", ids, updatedBefore,
			DB.Model(&PlaygroundCanvasAsset{}).Select("attachment_id")).Delete(&PlaygroundAttachment{})
		if result.Error != nil {
			return total, result.Error
		}
		total += result.RowsAffected
		if len(ids) < batchSize {
			return total, nil
		}
	}
}
