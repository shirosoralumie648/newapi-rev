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
		// Speech is the cached read-aloud audio reference of a version.
		Speech *struct {
			ID string `json:"id"`
		} `json:"speech"`
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
	ContextSummary string `json:"-" gorm:"type:text"`
	// DeletedAt is the trash tombstone: 0 means the conversation is active, and
	// a positive value is the timestamp it was soft-deleted. A trashed
	// conversation keeps its messages, attachments and artifacts — and its
	// share of the account budgets — until the trash cleanup purges it after
	// the configured retention window, so a restore never exceeds a limit the
	// account already enforced.
	DeletedAt       int64 `json:"deleted_at" gorm:"not null;default:0;index"`
	Revision        int64 `json:"revision" gorm:"not null"`
	MessageRevision int64 `json:"message_revision" gorm:"not null"`
	CreatedAt       int64 `json:"created_at" gorm:"not null;index"`
	UpdatedAt       int64 `json:"updated_at" gorm:"not null;index"`
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
		// A trashed conversation keeps its client key so it can be restored.
		// A client that creates a conversation with that key again (a replay
		// from a device whose local copy was already removed) gets a fresh
		// conversation, so the trashed row gives the key up instead of blocking
		// the unique index.
		if session.ClientID != nil {
			if err := tx.Model(&PlaygroundSession{}).
				Where("user_id = ? AND client_id = ? AND deleted_at > 0", userID, *session.ClientID).
				Update("client_id", nil).Error; err != nil {
				return err
			}
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

// GetPlaygroundSession loads one active conversation of an account. A trashed
// conversation is hidden from every conversation endpoint; use
// GetPlaygroundSessionAnyState for the export path.
func GetPlaygroundSession(userID int, id string) (*PlaygroundSession, error) {
	var session PlaygroundSession
	if err := DB.Where("id = ? AND user_id = ? AND deleted_at = 0", id, userID).First(&session).Error; err != nil {
		return nil, err
	}
	return &session, nil
}

// GetPlaygroundSessionAnyState loads one conversation of an account whether it
// is active or trashed. Export uses it so a user can still download a
// conversation that was moved to the trash; restore uses the trash listing to
// keep the ownership rules in one place.
func GetPlaygroundSessionAnyState(userID int, id string) (*PlaygroundSession, error) {
	var session PlaygroundSession
	if err := DB.Where("id = ? AND user_id = ?", id, userID).First(&session).Error; err != nil {
		return nil, err
	}
	return &session, nil
}

// Every Playground child resource (messages, artifacts, attachments) acquires
// its parent session first. This serializes capacity checks, CAS writes and
// session deletion against each other, and a trashed conversation rejects new
// writes so nothing is appended to a conversation its owner deleted.
func lockPlaygroundSession(tx *gorm.DB, userID int, sessionID string) (*PlaygroundSession, error) {
	if userID <= 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var session PlaygroundSession
	if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND deleted_at = 0", sessionID, userID).First(&session).Error; err != nil {
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
	if err := DB.Where("user_id = ? AND client_id = ? AND deleted_at = 0", userID, clientID).First(&session).Error; err != nil {
		return nil, err
	}
	return &session, nil
}

func ListPlaygroundSessions(userID int, offset, limit int) ([]PlaygroundSession, int64, error) {
	sessions := make([]PlaygroundSession, 0)
	var count int64
	query := DB.Model(&PlaygroundSession{}).Where("user_id = ? AND deleted_at = 0", userID)
	if err := query.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	err := query.Order("updated_at DESC, id DESC").Offset(offset).Limit(limit).Find(&sessions).Error
	return sessions, count, err
}

func UpdatePlaygroundSessionFields(userID int, id string, revision int64, updates map[string]any) (*PlaygroundSession, error) {
	var session PlaygroundSession
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND deleted_at = 0", id, userID).First(&session).Error; err != nil {
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

// DeletePlaygroundSession moves one conversation to the trash: the row, its
// messages, attachments and artifacts stay stored, and the account budgets keep
// counting them, until the trash cleanup purges the conversation after the
// configured retention window. RestorePlaygroundSession brings it back.
func DeletePlaygroundSession(userID int, id string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		session, err := lockPlaygroundSession(tx, userID, id)
		if err != nil {
			return err
		}
		return tx.Model(&PlaygroundSession{}).
			Where("id = ? AND user_id = ? AND deleted_at = 0", session.ID, userID).
			Update("deleted_at", common.GetTimestamp()).Error
	})
}

// RestorePlaygroundSession returns a trashed conversation to the active list.
// The row never left the account budgets, so no capacity check is needed; the
// conversation simply becomes writable again.
func RestorePlaygroundSession(userID int, id string) (*PlaygroundSession, error) {
	var session PlaygroundSession
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND deleted_at > 0", id, userID).First(&session).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundSessionNotFound
			}
			return err
		}
		now := common.GetTimestamp()
		if err := tx.Model(&PlaygroundSession{}).Where("id = ? AND user_id = ?", session.ID, userID).
			Updates(map[string]any{"deleted_at": 0, "updated_at": now}).Error; err != nil {
			return err
		}
		session.DeletedAt = 0
		session.UpdatedAt = now
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &session, nil
}

// PurgePlaygroundSession permanently removes one trashed conversation and every
// row it owns, mirroring what the retention job does once the trash window
// elapses. Only the trash cleanup and tests use it; the API only ever soft
// deletes. The stored attachment objects are deleted after the database commit.
func PurgePlaygroundSession(userID int, id string) error {
	var queued []playgroundQueuedObjectDelete
	err := DB.Transaction(func(tx *gorm.DB) error {
		var session PlaygroundSession
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND deleted_at > 0", id, userID).First(&session).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundSessionNotFound
			}
			return err
		}
		removed, err := purgePlaygroundSessionTx(tx, userID, &session)
		queued = removed
		return err
	})
	if err != nil {
		return err
	}
	drainPlaygroundObjectDeletes(nil, queued)
	return nil
}

// purgePlaygroundSessionTx removes the conversation and everything it owns
// inside the caller's transaction. The caller holds the row lock, so a restore
// or a child write cannot slip in, and the account counters are remeasured from
// the remaining rows because the cascade released conversations, attachments,
// artifacts and messages at once. The returned queued deletions lost their rows
// and must be drained after the transaction commits.
func purgePlaygroundSessionTx(tx *gorm.DB, userID int, session *PlaygroundSession) ([]playgroundQueuedObjectDelete, error) {
	removedAttachments := make([]PlaygroundAttachment, 0)
	removedObjects := make([]playgroundStoredObject, 0)
	// Artifact tombstones are included explicitly; deleting a session removes
	// its deduplication keys. Externalized version bodies leave with their rows
	// and are collected for deletion after the commit.
	artifactIDs := tx.Model(&PlaygroundArtifact{}).Select("id").Where("session_id = ? AND user_id = ?", session.ID, userID)
	storedVersions := make([]PlaygroundArtifactVersion, 0)
	if err := tx.Select("object_key").Where("artifact_id IN (?)", artifactIDs).Find(&storedVersions).Error; err != nil {
		return nil, err
	}
	for index := range storedVersions {
		if storedVersions[index].ObjectKey != "" {
			removedObjects = append(removedObjects, playgroundStoredObject{ObjectKey: storedVersions[index].ObjectKey})
		}
	}
	if err := tx.Where("artifact_id IN (?)", artifactIDs).Delete(&PlaygroundArtifactVersion{}).Error; err != nil {
		return nil, err
	}
	if err := tx.Where("session_id = ? AND user_id = ?", session.ID, userID).Delete(&PlaygroundArtifact{}).Error; err != nil {
		return nil, err
	}
	// The pins of this conversation's attachments go with the attachments, so
	// a later canvas read reports the node as "source deleted". The stored
	// objects are deleted after the database commit.
	if err := tx.Select("id", "storage_backend", "object_key").
		Where("session_id = ? AND user_id = ?", session.ID, userID).Find(&removedAttachments).Error; err != nil {
		return nil, err
	}
	attachmentIDs := tx.Model(&PlaygroundAttachment{}).Select("id").Where("session_id = ? AND user_id = ?", session.ID, userID)
	if err := tx.Where("attachment_id IN (?)", attachmentIDs).Delete(&PlaygroundCanvasAsset{}).Error; err != nil {
		return nil, err
	}
	if err := tx.Where("session_id = ? AND user_id = ?", session.ID, userID).Delete(&PlaygroundAttachment{}).Error; err != nil {
		return nil, err
	}
	if err := tx.Where("session_id = ? AND user_id = ?", session.ID, userID).Delete(&PlaygroundMessage{}).Error; err != nil {
		return nil, err
	}
	// Memories outlive the conversation they were extracted from, but a purged
	// conversation can no longer be opened as their source. Keep the note and
	// drop only the dangling pointer.
	if err := tx.Model(&PlaygroundMemory{}).Where("user_id = ? AND source_session_id = ?", userID, session.ID).
		Update("source_session_id", nil).Error; err != nil {
		return nil, err
	}
	if err := tx.Where("id = ? AND user_id = ?", session.ID, userID).Delete(&PlaygroundSession{}).Error; err != nil {
		return nil, err
	}
	queuedArtifacts, err := enqueuePlaygroundObjectDeletes(tx, removedObjects, playgroundObjectOriginArtifact)
	if err != nil {
		return nil, err
	}
	queuedAttachments, err := enqueuePlaygroundObjectDeletes(tx, playgroundAttachmentObjects(removedAttachments), playgroundObjectOriginAttachment)
	if err != nil {
		return nil, err
	}
	if err := refreshPlaygroundUserUsage(tx, userID); err != nil {
		return nil, err
	}
	return append(queuedArtifacts, queuedAttachments...), nil
}

// PlaygroundTrashItem is one conversation or canvas waiting in the trash. A
// purge_at of zero means the configured retention window has no bound.
type PlaygroundTrashItem struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	Title     string `json:"title"`
	DeletedAt int64  `json:"deleted_at"`
	PurgeAt   int64  `json:"purge_at"`
}

// PlaygroundTrashListing is the owner's complete trash view. RetentionDays is
// the window that applies to the account, so the client can show when each
// entry disappears without resolving the policy itself.
type PlaygroundTrashListing struct {
	RetentionDays int                   `json:"retention_days"`
	Items         []PlaygroundTrashItem `json:"items"`
}

// playgroundTrashPageLimit bounds one trash listing; the trash is a recovery
// buffer, not a second workspace.
const playgroundTrashPageLimit = 200

func ListPlaygroundTrash(userID int) (*PlaygroundTrashListing, error) {
	policy, err := playgroundPolicyForUser(DB, userID)
	if err != nil {
		return nil, err
	}
	retention := policy.TrashRetentionSeconds()
	listing := &PlaygroundTrashListing{RetentionDays: max(policy.TrashRetentionDays, 1), Items: make([]PlaygroundTrashItem, 0)}
	appendTrash := func(kind string, id, title string, deletedAt int64) {
		listing.Items = append(listing.Items, PlaygroundTrashItem{
			Kind: kind, ID: id, Title: title, DeletedAt: deletedAt, PurgeAt: deletedAt + retention,
		})
	}
	sessions := make([]PlaygroundSession, 0)
	if err := DB.Select("id, title, deleted_at").Where("user_id = ? AND deleted_at > 0", userID).
		Order("deleted_at DESC, id DESC").Limit(playgroundTrashPageLimit).Find(&sessions).Error; err != nil {
		return nil, err
	}
	for index := range sessions {
		appendTrash("session", sessions[index].ID, sessions[index].Title, sessions[index].DeletedAt)
	}
	canvases := make([]PlaygroundCanvasProject, 0)
	if err := DB.Select("id, title, deleted_at").Where("user_id = ? AND deleted_at > 0", userID).
		Order("deleted_at DESC, id DESC").Limit(playgroundTrashPageLimit).Find(&canvases).Error; err != nil {
		return nil, err
	}
	for index := range canvases {
		appendTrash("canvas", canvases[index].ID, canvases[index].Title, canvases[index].DeletedAt)
	}
	slices.SortFunc(listing.Items, func(a, b PlaygroundTrashItem) int {
		if a.DeletedAt != b.DeletedAt {
			return cmp.Compare(b.DeletedAt, a.DeletedAt)
		}
		return cmp.Compare(a.ID, b.ID)
	})
	return listing, nil
}

// PlaygroundTrashPurgeResult reports one retention sweep.
type PlaygroundTrashPurgeResult struct {
	Sessions int64 `json:"sessions"`
	Canvases int64 `json:"canvases"`
}

// playgroundTrashCandidateAge is the age above which a trashed row may be
// expired on the owner's group policy. The policy floors the retention window
// at one day, so nothing younger than this can ever be due.
const playgroundTrashCandidateAge = 24 * 60 * 60

// PurgeExpiredPlaygroundTrash permanently removes the trashed conversations and
// canvases whose retention window has elapsed, releasing their rows and bytes
// back to the account budgets. The owner's group policy decides the exact
// window, so a group with a longer retention keeps its entries even while the
// global default has already expired them.
func PurgeExpiredPlaygroundTrash(batchSize int) (*PlaygroundTrashPurgeResult, error) {
	if batchSize <= 0 {
		return nil, errors.New("invalid Playground trash purge batch size")
	}
	now := common.GetTimestamp()
	result := &PlaygroundTrashPurgeResult{}
	candidates := make([]PlaygroundSession, 0)
	if err := DB.Select("id, user_id, deleted_at").
		Where("deleted_at > 0 AND deleted_at <= ?", now-playgroundTrashCandidateAge).
		Order("deleted_at ASC, id ASC").Limit(batchSize).Find(&candidates).Error; err != nil {
		return nil, err
	}
	for index := range candidates {
		purged, err := purgeExpiredPlaygroundSession(&candidates[index], now)
		if err != nil {
			return nil, err
		}
		result.Sessions += purged
	}
	canvasCandidates := make([]PlaygroundCanvasProject, 0)
	if err := DB.Select("id, user_id, deleted_at").
		Where("deleted_at > 0 AND deleted_at <= ?", now-playgroundTrashCandidateAge).
		Order("deleted_at ASC, id ASC").Limit(batchSize).Find(&canvasCandidates).Error; err != nil {
		return nil, err
	}
	for index := range canvasCandidates {
		purged, err := purgeExpiredPlaygroundCanvasProject(&canvasCandidates[index], now)
		if err != nil {
			return nil, err
		}
		result.Canvases += purged
	}
	return result, nil
}

// purgeExpiredPlaygroundSession removes one candidate inside a row-locked
// transaction, re-checking the owner's retention window so raising the policy
// between the sweep query and the lock skips the row instead of purging it
// early. A candidate that was restored in the meantime is skipped too.
func purgeExpiredPlaygroundSession(candidate *PlaygroundSession, now int64) (int64, error) {
	var queued []playgroundQueuedObjectDelete
	purged := int64(0)
	err := DB.Transaction(func(tx *gorm.DB) error {
		var session PlaygroundSession
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND deleted_at > 0", candidate.ID, candidate.UserID).First(&session).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		retention, err := playgroundTrashRetentionSeconds(tx, session.UserID)
		if err != nil {
			return err
		}
		if now-session.DeletedAt < retention {
			return nil
		}
		removed, err := purgePlaygroundSessionTx(tx, session.UserID, &session)
		if err != nil {
			return err
		}
		queued = removed
		purged = 1
		return nil
	})
	if err != nil {
		return 0, err
	}
	drainPlaygroundObjectDeletes(nil, queued)
	return purged, nil
}

// playgroundTrashRetentionSeconds resolves the retention window of one account
// on the caller's connection.
func playgroundTrashRetentionSeconds(tx *gorm.DB, userID int) (int64, error) {
	policy, err := playgroundPolicyForUser(tx, userID)
	if err != nil {
		return 0, err
	}
	return policy.TrashRetentionSeconds(), nil
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
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND deleted_at = 0", sessionID, userID).First(&session).Error; err != nil {
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
	add := func(id string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		references = append(references, id)
	}
	for _, message := range messages {
		var stored playgroundStoredMessageReferences
		if err := common.Unmarshal([]byte(message.Payload), &stored); err != nil {
			continue
		}
		for _, version := range stored.Versions {
			for _, attachment := range version.Attachments {
				add(attachment.ID)
			}
			if version.Speech != nil {
				add(version.Speech.ID)
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
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND deleted_at = 0", sessionID, userID).First(&session).Error; err != nil {
			return err
		}
		return tx.Where("session_id = ? AND user_id = ?", sessionID, userID).
			Order(clause.OrderByColumn{Column: clause.Column{Name: "position"}}).Find(&messages).Error
	})
	return messages, session.MessageRevision, err
}

// PlaygroundSessionExport is one export snapshot: the conversation (active or
// trashed) plus its stored messages in order. The message payloads already
// carry their attachment references, so the export never reads attachment
// bytes and never exposes another account's resources.
type PlaygroundSessionExport struct {
	Session  PlaygroundSession
	Messages []PlaygroundMessage
}

// LoadPlaygroundSessionExport reads one owned conversation and its message
// snapshot. It is owner-scoped like every other Playground read, and it accepts
// a trashed conversation so a user can still export something they deleted.
func LoadPlaygroundSessionExport(userID int, sessionID string) (*PlaygroundSessionExport, error) {
	session, err := GetPlaygroundSessionAnyState(userID, sessionID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlaygroundSessionNotFound
		}
		return nil, err
	}
	var messages []PlaygroundMessage
	if err := DB.Where("session_id = ? AND user_id = ?", session.ID, userID).
		Order(clause.OrderByColumn{Column: clause.Column{Name: "position"}}).
		Order(clause.OrderByColumn{Column: clause.Column{Name: "id"}}).
		Find(&messages).Error; err != nil {
		return nil, err
	}
	return &PlaygroundSessionExport{Session: *session, Messages: messages}, nil
}
