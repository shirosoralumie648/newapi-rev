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
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

var ErrPlaygroundShareNotFound = errors.New("Shared conversation not found.")

// PlaygroundSessionShare is one revocable public link to a conversation or a
// canvas document. The plaintext token is returned to its owner exactly once;
// only its SHA-256 hash is stored, so a database read cannot reconstruct a
// working link. A row is looked up by hash equality, which keeps a random
// 128-bit token non-enumerable while avoiding a timing comparison against
// stored secrets. Conversation links set SessionID; canvas links leave it
// empty and set CanvasID, so a link can never resolve as the other kind.
type PlaygroundSessionShare struct {
	ID        int64  `json:"-" gorm:"primaryKey"`
	SessionID string `json:"-" gorm:"size:128;not null;index:idx_playground_session_share_owner,priority:1"`
	CanvasID  string `json:"-" gorm:"size:32;not null;default:'';index:idx_playground_canvas_share_owner,priority:1"`
	UserID    int    `json:"-" gorm:"not null;index:idx_playground_session_share_owner,priority:2;index:idx_playground_canvas_share_owner,priority:2"`
	TokenHash string `json:"-" gorm:"size:64;not null;uniqueIndex"`
	// ExpiresAt is the Unix second the link stops resolving; zero means no
	// expiry. RevokedAt is set when the owner revokes the link or the
	// conversation enters the trash.
	ExpiresAt int64 `json:"-" gorm:"not null;default:0"`
	RevokedAt int64 `json:"-" gorm:"not null;default:0;index"`
	CreatedAt int64 `json:"-" gorm:"not null"`
}

const playgroundShareTokenBytes = 16

// generatePlaygroundShareToken returns a plaintext URL-safe token carrying
// exactly 128 random bits. crypto/rand is the only source: a predictable token
// would defeat the hash-only storage.
func generatePlaygroundShareToken() (string, error) {
	raw := make([]byte, playgroundShareTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func playgroundShareTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// newPlaygroundShareRecord mints the secret and the row shared by both link
// kinds. The plaintext token is returned to the caller and never stored.
func newPlaygroundShareRecord(userID int, sessionID, canvasID string, expiresInDays int) (*PlaygroundSessionShare, string, error) {
	token, err := generatePlaygroundShareToken()
	if err != nil {
		return nil, "", err
	}
	now := common.GetTimestamp()
	share := PlaygroundSessionShare{
		SessionID: sessionID,
		CanvasID:  canvasID,
		UserID:    userID,
		TokenHash: playgroundShareTokenHash(token),
		CreatedAt: now,
	}
	if expiresInDays > 0 {
		share.ExpiresAt = now + int64(expiresInDays)*24*60*60
	}
	return &share, token, nil
}

// CreatePlaygroundSessionShare creates a new link to one active conversation
// of the account. Creating a link revokes every older active link of the same
// conversation in the same transaction: the plaintext of an old link is not
// recoverable, so keeping several active links would make the oldest ones
// impossible to display or audit.
func CreatePlaygroundSessionShare(userID int, sessionID string, expiresInDays int) (*PlaygroundSessionShare, string, error) {
	if userID <= 0 || expiresInDays < 0 {
		return nil, "", ErrPlaygroundSessionNotFound
	}
	share, token, err := newPlaygroundShareRecord(userID, sessionID, "", expiresInDays)
	if err != nil {
		return nil, "", err
	}
	now := share.CreatedAt
	err = DB.Transaction(func(tx *gorm.DB) error {
		// Locking the conversation serializes create against revoke and the
		// trash transition, and the owner filter rejects a foreign id before a
		// token is written.
		if _, err := lockPlaygroundSession(tx, userID, sessionID); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundSessionNotFound
			}
			return err
		}
		if err := tx.Model(&PlaygroundSessionShare{}).
			Where("user_id = ? AND session_id = ? AND revoked_at = 0", userID, sessionID).
			Update("revoked_at", now).Error; err != nil {
			return err
		}
		return tx.Create(share).Error
	})
	if err != nil {
		return nil, "", err
	}
	return share, token, nil
}

// CreatePlaygroundCanvasShare creates a new link to one active canvas of the
// account, revoking every older active link of the same canvas in the same
// transaction. Like a conversation link, the plaintext token is displayed once
// and cannot be recovered later.
func CreatePlaygroundCanvasShare(userID int, canvasID string, expiresInDays int) (*PlaygroundSessionShare, string, error) {
	if userID <= 0 || expiresInDays < 0 {
		return nil, "", ErrPlaygroundCanvasNotFound
	}
	share, token, err := newPlaygroundShareRecord(userID, "", canvasID, expiresInDays)
	if err != nil {
		return nil, "", err
	}
	now := share.CreatedAt
	err = DB.Transaction(func(tx *gorm.DB) error {
		// Locking the canvas serializes create against revoke and the trash
		// transition, and the owner filter rejects a foreign id before a token
		// is written.
		if err := lockPlaygroundCanvasProject(tx, userID, canvasID); err != nil {
			return err
		}
		if err := tx.Model(&PlaygroundSessionShare{}).
			Where("user_id = ? AND canvas_id = ? AND revoked_at = 0", userID, canvasID).
			Update("revoked_at", now).Error; err != nil {
			return err
		}
		return tx.Create(share).Error
	})
	if err != nil {
		return nil, "", err
	}
	return share, token, nil
}

// RevokePlaygroundSessionShare revokes every active link of one conversation.
// Revocation is idempotent: a conversation with no active link still succeeds,
// while a conversation of another account reports not found. A trashed
// conversation may still be revoked so the owner can finish cleaning up after
// deleting it.
func RevokePlaygroundSessionShare(userID int, sessionID string) error {
	if userID <= 0 {
		return ErrPlaygroundSessionNotFound
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var session PlaygroundSession
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundSessionNotFound
			}
			return err
		}
		return tx.Model(&PlaygroundSessionShare{}).
			Where("user_id = ? AND session_id = ? AND revoked_at = 0", userID, sessionID).
			Update("revoked_at", common.GetTimestamp()).Error
	})
}

// RevokePlaygroundCanvasShare revokes every active link of one canvas.
// Revocation is idempotent and also succeeds for a trashed canvas, so the
// owner can finish cleaning up after deleting it.
func RevokePlaygroundCanvasShare(userID int, canvasID string) error {
	if userID <= 0 {
		return ErrPlaygroundCanvasNotFound
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var project PlaygroundCanvasProject
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", canvasID, userID).First(&project).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundCanvasNotFound
			}
			return err
		}
		return tx.Model(&PlaygroundSessionShare{}).
			Where("user_id = ? AND canvas_id = ? AND revoked_at = 0", userID, canvasID).
			Update("revoked_at", common.GetTimestamp()).Error
	})
}

// PlaygroundSharedTarget is the sanitized-resource selector of one public
// token. Exactly one payload is set according to Kind.
type PlaygroundSharedTarget struct {
	Kind    string
	Session *PlaygroundSessionExport
	Canvas  *PlaygroundCanvasProject
}

const (
	PlaygroundShareKindConversation = "conversation"
	PlaygroundShareKindCanvas       = "canvas"
)

// ResolvePlaygroundSharedToken resolves a plaintext token to the stored
// conversation or canvas snapshot. A missing, revoked, expired, trashed or
// otherwise unpublished link all produce ErrPlaygroundShareNotFound, so an
// anonymous caller cannot distinguish a revoked link from one that never
// existed. A canvas link can only resolve as a canvas, and vice versa.
func ResolvePlaygroundSharedToken(token string) (*PlaygroundSharedTarget, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrPlaygroundShareNotFound
	}
	var share PlaygroundSessionShare
	err := DB.Where(
		"token_hash = ? AND revoked_at = 0 AND (expires_at = 0 OR expires_at > ?)",
		playgroundShareTokenHash(token),
		common.GetTimestamp(),
	).First(&share).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundShareNotFound
	}
	if err != nil {
		return nil, err
	}
	if share.CanvasID != "" {
		var project PlaygroundCanvasProject
		err = DB.Where("id = ? AND user_id = ? AND deleted_at = 0", share.CanvasID, share.UserID).First(&project).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlaygroundShareNotFound
		}
		if err != nil {
			return nil, err
		}
		if err := hydratePlaygroundCanvasProject(&project); err != nil {
			return nil, err
		}
		return &PlaygroundSharedTarget{Kind: PlaygroundShareKindCanvas, Canvas: &project}, nil
	}
	var session PlaygroundSession
	err = DB.Where("id = ? AND user_id = ? AND deleted_at = 0", share.SessionID, share.UserID).First(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundShareNotFound
	}
	if err != nil {
		return nil, err
	}
	var messages []PlaygroundMessage
	if err := DB.Where("session_id = ? AND user_id = ?", session.ID, share.UserID).
		Order("position ASC").
		Order("id ASC").
		Find(&messages).Error; err != nil {
		return nil, err
	}
	return &PlaygroundSharedTarget{
		Kind:    PlaygroundShareKindConversation,
		Session: &PlaygroundSessionExport{Session: session, Messages: messages},
	}, nil
}

// LoadPlaygroundSharedSession resolves a plaintext token to the stored
// conversation snapshot. It rejects a token that belongs to a canvas link.
func LoadPlaygroundSharedSession(token string) (*PlaygroundSessionExport, error) {
	target, err := ResolvePlaygroundSharedToken(token)
	if err != nil {
		return nil, err
	}
	if target.Kind != PlaygroundShareKindConversation || target.Session == nil {
		return nil, ErrPlaygroundShareNotFound
	}
	return target.Session, nil
}
