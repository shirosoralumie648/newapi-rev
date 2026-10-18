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
	"cmp"
	"errors"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	ErrPlaygroundSessionNotFound = gorm.ErrRecordNotFound
	ErrPlaygroundConflict        = errors.New("Playground changed on another device. Reload before saving.")
	// ErrPlaygroundSessionLimit and ErrPlaygroundMessageLimit are the stable
	// capacity errors the resource quota policy produces for conversations.
	ErrPlaygroundSessionLimit = errors.New("Playground conversation limit exceeded.")
	ErrPlaygroundMessageLimit = errors.New("Playground message limit exceeded.")
	// ErrPlaygroundParallelLimit is raised when a message group compares more
	// models than the owner's policy allows. The group is rejected as a whole,
	// so a stored snapshot never holds a comparison the policy forbids.
	ErrPlaygroundParallelLimit = errors.New("Playground parallel comparison limit exceeded.")
	// ErrPlaygroundContextSummaryLimit is raised when a client tries to persist
	// a compression node bigger than the stored contract allows.
	ErrPlaygroundContextSummaryLimit = errors.New("Playground context summary limit exceeded.")
	// errPlaygroundMessageSequence only guards the internal ordering contract of
	// the snapshot compatibility writer; request handlers validate their own
	// input before reaching it.
	errPlaygroundMessageSequence = errors.New("playground message sequence does not match the stored messages")
)

// playgroundMessagePositionStride spaces stored message positions so an
// incremental write can append a message without renumbering the rows that
// already exist. Only the snapshot compatibility path renumbers, and only when
// the requested sequence no longer matches the stored one.
const playgroundMessagePositionStride = 1024

// PlaygroundMessageDelta is one incremental message write: Upserts carry the
// canonical payloads the client added or changed, Deletes names the client keys
// it removed, and Order optionally pins the complete resulting sequence. A nil
// Order leaves the stored sequence alone, while a non-nil Order — even an empty
// one — is the complete snapshot, so every stored key outside it is removed
// (the deprecated snapshot endpoint always sets it).
type PlaygroundMessageDelta struct {
	Upserts []PlaygroundMessage
	Deletes []string
	Order   []string
}

// playgroundStoredMessageReferences decodes only the attachment references of a
// stored payload. The message contract itself is validated on write, so the
// recomputation of attachment reference state does not re-validate it.
type playgroundStoredMessageReferences struct {
	Versions []struct {
		Attachments []struct {
			ID string `json:"id"`
		} `json:"attachments"`
	} `json:"versions"`
}

type PlaygroundSession struct {
	CreatedNow       bool    `json:"-" gorm:"-"`
	ID               string  `json:"id" gorm:"size:128;primaryKey"`
	UserID           int     `json:"user_id" gorm:"not null;index;uniqueIndex:uk_playground_session_user_client,priority:1"`
	ClientID         *string `json:"client_id,omitempty" gorm:"size:128;uniqueIndex:uk_playground_session_user_client,priority:2"`
	Title            string  `json:"title" gorm:"size:200;not null"`
	Config           string  `json:"-" gorm:"type:text;not null"`
	ParameterEnabled string  `json:"-" gorm:"type:text;not null"`
	// SystemPrompt is the conversation-level instruction injected as the first
	// `system` message of every request. The column stays nullable so an
	// existing installation can add it on every supported database; a NULL
	// value reads back as an empty prompt.
	SystemPrompt string `json:"-" gorm:"type:text"`
	// ContextConfig holds the conversation's context management settings — the
	// history message limit, the estimated token budget, the automatic summary
	// flag and the model that produces summaries — as JSON. The column is
	// nullable like SystemPrompt; a NULL value reads back as an empty object
	// and the client applies its defaults.
	ContextConfig string `json:"-" gorm:"type:text"`
	// ContextSummary is the persisted compression node: the summary that
	// replaces the oldest messages of the conversation in a request. An empty
	// value means the conversation sends its stored history uncompressed.
	ContextSummary  string `json:"-" gorm:"type:text"`
	Revision        int64  `json:"revision" gorm:"not null"`
	MessageRevision int64  `json:"message_revision" gorm:"not null"`
	CreatedAt       int64  `json:"created_at" gorm:"not null;index"`
	UpdatedAt       int64  `json:"updated_at" gorm:"not null;index"`
}

type PlaygroundMessage struct {
	ID        int64    `json:"id" gorm:"primaryKey"`
	SessionID string   `json:"session_id" gorm:"size:128;not null;index:idx_playground_message_session_position,priority:1;uniqueIndex:uk_playground_message_session_client,priority:1"`
	UserID    int      `json:"user_id" gorm:"not null;index"`
	ClientKey string   `json:"client_key" gorm:"size:200;not null;uniqueIndex:uk_playground_message_session_client,priority:2"`
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
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		// The account counter row serializes the conversation count for the
		// whole account, so concurrent creates cannot both slip past the limit
		// and the relay's quota settlement on the users row stays untouched.
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if usage.Sessions >= int64(policy.SessionMaxCount) {
			return ErrPlaygroundSessionLimit
		}
		if err := tx.Create(session).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{Sessions: 1})
		if err := savePlaygroundUserUsage(tx, usage); err != nil {
			return err
		}
		return insertPlaygroundMessages(tx, userID, session.ID, messages, policy)
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
	var removedAttachments []PlaygroundAttachment
	err := DB.Transaction(func(tx *gorm.DB) error {
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
		// so a later canvas read reports the node as "source deleted". The
		// stored objects are deleted after the database commit.
		if err := tx.Select("id", "storage_backend", "object_key").
			Where("session_id = ? AND user_id = ?", id, userID).Find(&removedAttachments).Error; err != nil {
			return err
		}
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
		if err := tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundSession{}).Error; err != nil {
			return err
		}
		// The cascade released conversations, attachments, artifacts and
		// messages at once, so the account counters are remeasured from the
		// remaining rows instead of mirroring every per-table step.
		return refreshPlaygroundUserUsage(tx, userID)
	})
	if err != nil {
		return err
	}
	for index := range removedAttachments {
		deletePlaygroundAttachmentObject(nil, &removedAttachments[index])
	}
	return nil
}

func insertPlaygroundMessages(tx *gorm.DB, userID int, sessionID string, messages []PlaygroundMessage, policy playground_setting.PlaygroundQuotaPolicy) error {
	// Capacity is re-checked inside the session-locked transaction so a
	// concurrent writer cannot slip a snapshot past the limit.
	if len(messages) > policy.MessageMaxCount {
		return ErrPlaygroundMessageLimit
	}
	var storedBytes int64
	for index := range messages {
		storedBytes += int64(len(messages[index].Payload))
	}
	if storedBytes > policy.MessageMaxBytes {
		return ErrPlaygroundMessageLimit
	}
	now := common.GetTimestamp()
	for index := range messages {
		messages[index].ID = 0
		messages[index].SessionID = sessionID
		messages[index].UserID = userID
		messages[index].Position = (index + 1) * playgroundMessagePositionStride
		messages[index].CreatedAt = now
		messages[index].UpdatedAt = now
	}
	if len(messages) == 0 {
		return nil
	}
	return tx.CreateInBatches(messages, 25).Error
}

// ApplyPlaygroundMessagesDelta writes only the rows a client actually changed.
// The session row is locked first and the caller's MessageRevision must still
// match, so concurrent writers serialize: the winner bumps the revision and the
// loser gets ErrPlaygroundConflict. A delta that changes nothing keeps the
// revision and leaves every stored row untouched.
func ApplyPlaygroundMessagesDelta(userID int, sessionID string, revision int64, delta PlaygroundMessageDelta) (int64, error) {
	applied := revision
	err := DB.Transaction(func(tx *gorm.DB) error {
		var session PlaygroundSession
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", sessionID, userID).First(&session).Error; err != nil {
			return err
		}
		if session.MessageRevision != revision {
			return ErrPlaygroundConflict
		}
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		changed, err := applyPlaygroundMessageDelta(tx, userID, sessionID, policy, delta)
		if err != nil {
			return err
		}
		if !changed {
			return nil
		}
		result := tx.Model(&PlaygroundSession{}).Where("id = ? AND user_id = ? AND message_revision = ?", sessionID, userID, revision).
			Updates(map[string]any{"updated_at": common.GetTimestamp(), "message_revision": revision + 1})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrPlaygroundConflict
		}
		applied = revision + 1
		return nil
	})
	return applied, err
}

// ReplacePlaygroundMessages is the deprecated full-snapshot writer kept for one
// release. It is translated into the incremental path, so a snapshot that
// matches the stored rows writes nothing and only a changed sequence renumbers
// positions. An empty snapshot removes every stored message. Callers should move
// to ApplyPlaygroundMessagesDelta.
func ReplacePlaygroundMessages(userID int, sessionID string, revision int64, messages []PlaygroundMessage) (int64, error) {
	// make keeps the order non-nil even for an empty snapshot, which is what
	// tells the incremental engine to delete every stored key.
	order := make([]string, 0, len(messages))
	for index := range messages {
		order = append(order, messages[index].ClientKey)
	}
	return ApplyPlaygroundMessagesDelta(userID, sessionID, revision, PlaygroundMessageDelta{Upserts: messages, Order: order})
}

// applyPlaygroundMessageDelta reconciles the stored rows with one delta: stored
// rows keep their identity and position, changed or new rows are written, keys
// the client removed (or that the requested sequence no longer contains) are
// deleted, and the attachment references of the resulting snapshot are
// recomputed on the same connection. It reports whether anything was written.
func applyPlaygroundMessageDelta(tx *gorm.DB, userID int, sessionID string, policy playground_setting.PlaygroundQuotaPolicy, delta PlaygroundMessageDelta) (bool, error) {
	stored := make([]PlaygroundMessage, 0)
	if err := tx.Where("session_id = ? AND user_id = ?", sessionID, userID).
		Order(clause.OrderByColumn{Column: clause.Column{Name: "position"}}).
		Order(clause.OrderByColumn{Column: clause.Column{Name: "id"}}).
		Find(&stored).Error; err != nil {
		return false, err
	}
	// byKey mirrors the stored rows. A database written before the unique index
	// existed can still hold a duplicate (session_id, client_key); the migration
	// removes it and the first row in sequence stays authoritative here.
	byKey := make(map[string]*PlaygroundMessage, len(stored))
	sequence := make([]*PlaygroundMessage, 0, len(stored))
	for index := range stored {
		message := &stored[index]
		if _, duplicate := byKey[message.ClientKey]; duplicate {
			continue
		}
		byKey[message.ClientKey] = message
		sequence = append(sequence, message)
	}

	changed := false
	if delta.Order != nil {
		wanted := make(map[string]bool, len(delta.Order))
		for _, key := range delta.Order {
			if key == "" || wanted[key] {
				return false, errPlaygroundMessageSequence
			}
			wanted[key] = true
		}
		for _, message := range sequence {
			if wanted[message.ClientKey] {
				continue
			}
			if err := deletePlaygroundMessageRow(tx, userID, sessionID, message); err != nil {
				return false, err
			}
			delete(byKey, message.ClientKey)
			changed = true
		}
	}
	for _, key := range delta.Deletes {
		message, ok := byKey[key]
		if !ok {
			// Removing an already absent key is a no-op, so a retried delta stays
			// safe to replay.
			continue
		}
		if err := deletePlaygroundMessageRow(tx, userID, sessionID, message); err != nil {
			return false, err
		}
		delete(byKey, key)
		changed = true
	}

	now := common.GetTimestamp()
	nextPosition := playgroundNextMessagePosition(byKey)
	for index := range delta.Upserts {
		upsert := delta.Upserts[index]
		if existing, ok := byKey[upsert.ClientKey]; ok {
			if existing.Payload == upsert.Payload {
				continue
			}
			if err := tx.Model(&PlaygroundMessage{}).
				Where("id = ? AND session_id = ? AND user_id = ?", existing.ID, sessionID, userID).
				Updates(map[string]any{"payload": string(upsert.Payload), "updated_at": now}).Error; err != nil {
				return false, err
			}
			existing.Payload = upsert.Payload
			existing.UpdatedAt = now
			changed = true
			continue
		}
		upsert.ID = 0
		upsert.SessionID = sessionID
		upsert.UserID = userID
		upsert.Position = nextPosition
		upsert.CreatedAt = now
		upsert.UpdatedAt = now
		nextPosition += playgroundMessagePositionStride
		if err := tx.Create(&upsert).Error; err != nil {
			return false, err
		}
		byKey[upsert.ClientKey] = &upsert
		changed = true
	}

	// The stored snapshot is measured after the delta is applied, so a write
	// that would exceed the budget rolls back as a whole.
	if len(byKey) > policy.MessageMaxCount {
		return false, ErrPlaygroundMessageLimit
	}
	var storedBytes int64
	for _, message := range byKey {
		storedBytes += int64(len(message.Payload))
	}
	if storedBytes > policy.MessageMaxBytes {
		return false, ErrPlaygroundMessageLimit
	}

	if delta.Order != nil {
		ordered := make([]*PlaygroundMessage, 0, len(delta.Order))
		for _, key := range delta.Order {
			message, ok := byKey[key]
			if !ok {
				return false, errPlaygroundMessageSequence
			}
			ordered = append(ordered, message)
		}
		if len(ordered) != len(byKey) {
			return false, errPlaygroundMessageSequence
		}
		current := playgroundMessagesByPosition(byKey)
		matches := true
		for index, message := range current {
			if message != ordered[index] {
				matches = false
				break
			}
		}
		// Only a snapshot whose sequence actually changed is renumbered; a
		// compatible client that repeats the stored order writes nothing.
		if !matches {
			for index, message := range ordered {
				position := (index + 1) * playgroundMessagePositionStride
				if message.Position == position {
					continue
				}
				if err := tx.Model(&PlaygroundMessage{}).
					Where("id = ? AND session_id = ? AND user_id = ?", message.ID, sessionID, userID).
					Updates(map[string]any{"position": position, "updated_at": now}).Error; err != nil {
					return false, err
				}
				message.Position = position
				changed = true
			}
		}
	}

	referencesChanged, err := syncPlaygroundAttachmentReferences(tx, userID, sessionID, playgroundMessageAttachmentReferences(byKey))
	if err != nil {
		return false, err
	}
	return changed || referencesChanged, nil
}

// playgroundNextMessagePosition appends after the highest stored position so a
// new message never has to renumber its neighbours.
func playgroundNextMessagePosition(messages map[string]*PlaygroundMessage) int {
	highest := 0
	for _, message := range messages {
		highest = max(highest, message.Position)
	}
	return highest + playgroundMessagePositionStride
}

// playgroundMessagesByPosition returns the stored rows in their persisted order.
func playgroundMessagesByPosition(messages map[string]*PlaygroundMessage) []*PlaygroundMessage {
	ordered := make([]*PlaygroundMessage, 0, len(messages))
	for _, message := range messages {
		ordered = append(ordered, message)
	}
	slices.SortFunc(ordered, func(a, b *PlaygroundMessage) int {
		if a.Position != b.Position {
			return cmp.Compare(a.Position, b.Position)
		}
		return cmp.Compare(a.ID, b.ID)
	})
	return ordered
}

func deletePlaygroundMessageRow(tx *gorm.DB, userID int, sessionID string, message *PlaygroundMessage) error {
	return tx.Where("id = ? AND session_id = ? AND user_id = ?", message.ID, sessionID, userID).Delete(&PlaygroundMessage{}).Error
}

// playgroundMessageAttachmentReferences collects the attachment IDs the stored
// snapshot still references. The result is ordered so the reference update is
// deterministic.
func playgroundMessageAttachmentReferences(messages map[string]*PlaygroundMessage) []string {
	seen := make(map[string]bool)
	references := make([]string, 0)
	for _, message := range messages {
		var stored playgroundStoredMessageReferences
		if err := common.Unmarshal([]byte(message.Payload), &stored); err != nil {
			continue
		}
		for _, version := range stored.Versions {
			for _, attachment := range version.Attachments {
				if attachment.ID == "" || seen[attachment.ID] {
					continue
				}
				seen[attachment.ID] = true
				references = append(references, attachment.ID)
			}
		}
	}
	slices.Sort(references)
	return references
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
