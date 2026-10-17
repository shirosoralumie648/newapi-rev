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
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrPlaygroundSessionNotFound = gorm.ErrRecordNotFound
	ErrPlaygroundConflict        = errors.New("Playground changed on another device. Reload before saving.")
)

const PlaygroundMessageMaxCount = 100

// PlaygroundMessageMaxVersions bounds the branch history stored per message.
// Every edit or regeneration appends a version, so the limit is enforced with
// the rest of the snapshot inside the session-locked write transaction.
const PlaygroundMessageMaxVersions = 100

type PlaygroundSession struct {
	CreatedNow       bool    `json:"-" gorm:"-"`
	ID               string  `json:"id" gorm:"size:128;primaryKey"`
	UserID           int     `json:"user_id" gorm:"not null;index;uniqueIndex:uk_playground_session_user_client,priority:1"`
	ClientID         *string `json:"client_id,omitempty" gorm:"size:128;uniqueIndex:uk_playground_session_user_client,priority:2"`
	Title            string  `json:"title" gorm:"size:200;not null"`
	Config           string  `json:"-" gorm:"type:text;not null"`
	ParameterEnabled string  `json:"-" gorm:"type:text;not null"`
	Revision         int64   `json:"revision" gorm:"not null"`
	MessageRevision  int64   `json:"message_revision" gorm:"not null"`
	CreatedAt        int64   `json:"created_at" gorm:"not null;index"`
	UpdatedAt        int64   `json:"updated_at" gorm:"not null;index"`
}

type PlaygroundMessage struct {
	ID        int64    `json:"id" gorm:"primaryKey"`
	SessionID string   `json:"session_id" gorm:"size:128;not null;index:idx_playground_message_session_position,priority:1"`
	UserID    int      `json:"user_id" gorm:"not null;index"`
	ClientKey string   `json:"client_key" gorm:"size:200;not null"`
	Position  int      `json:"position" gorm:"not null;index:idx_playground_message_session_position,priority:2"`
	Payload   LongText `json:"payload" gorm:"not null"`
	CreatedAt int64    `json:"created_at" gorm:"not null"`
	UpdatedAt int64    `json:"updated_at" gorm:"not null"`
}

// Migration client IDs are scoped to the owner, and retries never overwrite history.
func CreatePlaygroundSession(userID int, session *PlaygroundSession, messages []PlaygroundMessage) error {
	if userID <= 0 || session == nil {
		return errors.New("invalid playground session")
	}
	if session.ClientID != nil {
		existing, err := FindPlaygroundSessionByClientID(userID, *session.ClientID)
		if err == nil {
			*session = *existing
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
	}
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return err
	}
	now := common.GetTimestamp()
	session.ID = "pgs_" + key
	session.UserID = userID
	session.CreatedAt = now
	session.UpdatedAt = now
	if session.Title == "" {
		session.Title = "New conversation"
	}
	err = DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(session).Error; err != nil {
			return err
		}
		return insertPlaygroundMessages(tx, userID, session.ID, messages)
	})
	if err != nil && session.ClientID != nil {
		existing, findErr := FindPlaygroundSessionByClientID(userID, *session.ClientID)
		if findErr == nil {
			*session = *existing
			return nil
		}
	}
	session.CreatedNow = err == nil
	return err
}

func GetPlaygroundSession(userID int, id string) (*PlaygroundSession, error) {
	var session PlaygroundSession
	if err := DB.Where("id = ? AND user_id = ?", id, userID).First(&session).Error; err != nil {
		return nil, err
	}
	return &session, nil
}

// Every Playground child resource (messages, artifacts, attachments) acquires
// its parent session first. This serializes capacity checks, CAS writes and
// session deletion against each other.
func lockPlaygroundSession(tx *gorm.DB, userID int, sessionID string) (*PlaygroundSession, error) {
	if userID <= 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var session PlaygroundSession
	if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
		return nil, err
	}
	if session.ID != sessionID {
		return nil, gorm.ErrRecordNotFound
	}
	return &session, nil
}

func FindPlaygroundSessionByClientID(userID int, clientID string) (*PlaygroundSession, error) {
	if strings.TrimSpace(clientID) == "" {
		return nil, ErrPlaygroundSessionNotFound
	}
	var session PlaygroundSession
	if err := DB.Where("user_id = ? AND client_id = ?", userID, clientID).First(&session).Error; err != nil {
		return nil, err
	}
	return &session, nil
}

func ListPlaygroundSessions(userID int, offset, limit int) ([]PlaygroundSession, int64, error) {
	sessions := make([]PlaygroundSession, 0)
	var count int64
	query := DB.Model(&PlaygroundSession{}).Where("user_id = ?", userID)
	if err := query.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	err := query.Order("updated_at DESC, id DESC").Offset(offset).Limit(limit).Find(&sessions).Error
	return sessions, count, err
}

func UpdatePlaygroundSessionFields(userID int, id string, revision int64, updates map[string]any) (*PlaygroundSession, error) {
	var session PlaygroundSession
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&session).Error; err != nil {
			return err
		}
		if session.Revision != revision {
			return ErrPlaygroundConflict
		}
		updates["updated_at"] = common.GetTimestamp()
		updates["revision"] = revision + 1
		result := tx.Model(&PlaygroundSession{}).Where("id = ? AND user_id = ? AND revision = ?", id, userID, revision).Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrPlaygroundConflict
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).First(&session).Error
	})
	return &session, err
}

func DeletePlaygroundSession(userID int, id string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var session PlaygroundSession
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&session).Error; err != nil {
			return err
		}
		// Parent locking serializes this cleanup with every artifact write. Include
		// tombstones explicitly; deleting a session removes its deduplication keys.
		artifactIDs := tx.Model(&PlaygroundArtifact{}).Select("id").Where("session_id = ? AND user_id = ?", id, userID)
		if err := tx.Where("artifact_id IN (?)", artifactIDs).Delete(&PlaygroundArtifactVersion{}).Error; err != nil {
			return err
		}
		if err := tx.Where("session_id = ? AND user_id = ?", id, userID).Delete(&PlaygroundArtifact{}).Error; err != nil {
			return err
		}
		// The pins of this conversation's attachments go with the attachments,
		// so a later canvas read reports the node as "source deleted".
		attachmentIDs := tx.Model(&PlaygroundAttachment{}).Select("id").Where("session_id = ? AND user_id = ?", id, userID)
		if err := tx.Where("attachment_id IN (?)", attachmentIDs).Delete(&PlaygroundCanvasAsset{}).Error; err != nil {
			return err
		}
		if err := tx.Where("session_id = ? AND user_id = ?", id, userID).Delete(&PlaygroundAttachment{}).Error; err != nil {
			return err
		}
		if err := tx.Where("session_id = ? AND user_id = ?", id, userID).Delete(&PlaygroundMessage{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundSession{}).Error
	})
}

func insertPlaygroundMessages(tx *gorm.DB, userID int, sessionID string, messages []PlaygroundMessage) error {
	// Capacity is re-checked inside the session-locked transaction so a
	// concurrent writer cannot slip a snapshot past the limit.
	if len(messages) > PlaygroundMessageMaxCount {
		return common.NewMessage("Playground conversations support at most 100 messages.")
	}
	now := common.GetTimestamp()
	for index := range messages {
		messages[index].ID = 0
		messages[index].SessionID = sessionID
		messages[index].UserID = userID
		messages[index].Position = index
		messages[index].CreatedAt = now
		messages[index].UpdatedAt = now
	}
	if len(messages) == 0 {
		return nil
	}
	return tx.CreateInBatches(messages, 25).Error
}

// referencedAttachmentIDs are the attachment IDs the stored snapshot still
// references; the same transaction recomputes attachment reference state.
func ReplacePlaygroundMessages(userID int, sessionID string, revision int64, messages []PlaygroundMessage, referencedAttachmentIDs []string) (int64, error) {
	err := DB.Transaction(func(tx *gorm.DB) error {
		var session PlaygroundSession
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
			return err
		}
		if session.MessageRevision != revision {
			return ErrPlaygroundConflict
		}
		result := tx.Model(&PlaygroundSession{}).Where("id = ? AND user_id = ? AND message_revision = ?", sessionID, userID, revision).
			Updates(map[string]any{"updated_at": common.GetTimestamp(), "message_revision": revision + 1})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrPlaygroundConflict
		}
		if err := tx.Where("session_id = ? AND user_id = ?", sessionID, userID).Delete(&PlaygroundMessage{}).Error; err != nil {
			return err
		}
		if err := insertPlaygroundMessages(tx, userID, sessionID, messages); err != nil {
			return err
		}
		return syncPlaygroundAttachmentReferences(tx, userID, sessionID, referencedAttachmentIDs)
	})
	return revision + 1, err
}

func ListPlaygroundMessages(userID int, sessionID string) ([]PlaygroundMessage, int64, error) {
	messages := make([]PlaygroundMessage, 0)
	var session PlaygroundSession
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
			return err
		}
		return tx.Where("session_id = ? AND user_id = ?", sessionID, userID).
			Order(clause.OrderByColumn{Column: clause.Column{Name: "position"}}).Find(&messages).Error
	})
	return messages, session.MessageRevision, err
}
