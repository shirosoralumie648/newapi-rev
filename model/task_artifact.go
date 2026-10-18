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

// TaskArtifactState is the lifecycle of one generated result in the object
// store. An artifact is discovered after its task succeeds (pending), then
// either persisted (stored) or left with its provider reference (expired)
// when the bytes cannot be kept — quota, upstream failure, or an expired
// provider link. Nothing is silently dropped: the record and its upstream
// reference stay until the retention window ends, and the read path reports
// the state to the owner.
type TaskArtifactState string

const (
	TaskArtifactStatePending TaskArtifactState = "pending"
	TaskArtifactStateStored  TaskArtifactState = "stored"
	TaskArtifactStateExpired TaskArtifactState = "expired"
)

// Pin sources. The asset library pins one artifact the owner chose to keep;
// a canvas pins every artifact its nodes reference.
const (
	PlaygroundTaskArtifactPinSourceAsset  = "asset"
	PlaygroundTaskArtifactPinSourceCanvas = "canvas"
)

var ErrPlaygroundTaskArtifactInvalid = errors.New("invalid Playground task artifact request.")

// PlaygroundTaskArtifactSeed identifies one artifact a completed task exposes.
type PlaygroundTaskArtifactSeed struct {
	Key      string
	Type     string
	MimeType string
}

// PlaygroundTaskArtifact is the durable metadata of one generated result. The
// bytes live in the object store; the database keeps ownership, the object
// key, the content hash, and the retention state. UpstreamRef is an operator
// diagnostic only (it may embed a signed provider URL), so it is never
// serialized to an API response.
type PlaygroundTaskArtifact struct {
	ID           int64             `json:"id" gorm:"primary_key"`
	UserID       int               `json:"user_id" gorm:"not null;index:idx_playground_task_artifact_user_state,priority:1"`
	TaskID       string            `json:"task_id" gorm:"type:varchar(191);not null;uniqueIndex:uk_playground_task_artifact,priority:1"`
	ArtifactKey  string            `json:"artifact_key" gorm:"type:varchar(128);not null;uniqueIndex:uk_playground_task_artifact,priority:2"`
	ArtifactType string            `json:"artifact_type" gorm:"type:varchar(32);not null"`
	State        TaskArtifactState `json:"state" gorm:"type:varchar(16);not null;index:idx_playground_task_artifact_user_state,priority:2"`
	MimeType     string            `json:"mime_type" gorm:"type:varchar(255)"`
	Backend      string            `json:"backend" gorm:"type:varchar(32)"`
	ObjectKey    string            `json:"object_key" gorm:"type:varchar(1024)"`
	ByteSize     int64             `json:"byte_size"`
	ContentHash  string            `json:"content_hash" gorm:"type:varchar(64)"`
	UpstreamRef  string            `json:"-" gorm:"type:text"`
	ExpiresAt    int64             `json:"expires_at" gorm:"index"`
	StoredAt     int64             `json:"stored_at"`
	Attempts     int               `json:"attempts"`
	LastError    string            `json:"last_error" gorm:"type:varchar(255)"`
	CreatedAt    int64             `json:"created_at"`
	UpdatedAt    int64             `json:"updated_at"`
}

// PlaygroundTaskArtifactPin keeps one stored artifact alive past its retention
// window while the owner still uses it. Source names why the pin exists; a
// canvas pin carries the canvas id so deleting the canvas (or saving a
// document that no longer references the artifact) releases it.
type PlaygroundTaskArtifactPin struct {
	ID          int64  `json:"id" gorm:"primary_key"`
	UserID      int    `json:"user_id" gorm:"not null;uniqueIndex:uk_playground_task_artifact_pin,priority:1"`
	TaskID      string `json:"task_id" gorm:"type:varchar(191);not null;uniqueIndex:uk_playground_task_artifact_pin,priority:2"`
	ArtifactKey string `json:"artifact_key" gorm:"type:varchar(128);not null;uniqueIndex:uk_playground_task_artifact_pin,priority:3"`
	Source      string `json:"source" gorm:"type:varchar(16);not null;uniqueIndex:uk_playground_task_artifact_pin,priority:4"`
	SourceID    string `json:"source_id" gorm:"type:varchar(64);not null;uniqueIndex:uk_playground_task_artifact_pin,priority:5"`
	CreatedAt   int64  `json:"created_at" gorm:"not null"`
}

// PlaygroundTaskArtifactSync records that the artifact projection of one task
// was already persisted, so the scheduled store pass never re-lists a task it
// finished. The marker is created only after every artifact reached a terminal
// state (stored or expired), which keeps transient failures retryable.
type PlaygroundTaskArtifactSync struct {
	TaskID    string `json:"task_id" gorm:"type:varchar(191);primary_key"`
	UserID    int    `json:"user_id" gorm:"not null;index"`
	CreatedAt int64  `json:"created_at" gorm:"not null"`
}

// TaskArtifactOwner identifies one task whose artifacts still need attention.
type TaskArtifactOwner struct {
	UserID int    `json:"user_id"`
	TaskID string `json:"task_id"`
}

// EnsurePlaygroundTaskArtifacts registers the artifacts a completed task
// exposes. Existing rows keep their state, so a retry after a transient
// failure never resets a stored object or an expired decision.
func EnsurePlaygroundTaskArtifacts(userID int, taskID string, seeds []PlaygroundTaskArtifactSeed) ([]PlaygroundTaskArtifact, error) {
	if userID <= 0 || strings.TrimSpace(taskID) == "" {
		return nil, ErrPlaygroundTaskArtifactInvalid
	}
	now := common.GetTimestamp()
	rows := make([]PlaygroundTaskArtifact, 0, len(seeds))
	for _, seed := range seeds {
		key := strings.TrimSpace(seed.Key)
		artifactType := strings.TrimSpace(seed.Type)
		if key == "" || artifactType == "" {
			return nil, ErrPlaygroundTaskArtifactInvalid
		}
		rows = append(rows, PlaygroundTaskArtifact{
			UserID:       userID,
			TaskID:       taskID,
			ArtifactKey:  key,
			ArtifactType: artifactType,
			MimeType:     seed.MimeType,
			State:        TaskArtifactStatePending,
			CreatedAt:    now,
			UpdatedAt:    now,
		})
	}
	if len(rows) > 0 {
		if err := DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&rows).Error; err != nil {
			return nil, err
		}
	}
	return PlaygroundTaskArtifactsForTask(userID, taskID)
}

// PlaygroundTaskArtifactsForTask lists the stored metadata of one task's
// artifacts, owner-scoped.
func PlaygroundTaskArtifactsForTask(userID int, taskID string) ([]PlaygroundTaskArtifact, error) {
	rows := make([]PlaygroundTaskArtifact, 0)
	if userID <= 0 || taskID == "" {
		return rows, nil
	}
	err := DB.Where("user_id = ? AND task_id = ?", userID, taskID).
		Order("artifact_key ASC").Find(&rows).Error
	return rows, err
}

// GetPlaygroundTaskArtifact returns one artifact record for its owner. A
// missing row reports (nil, nil): the artifact was simply never persisted and
// the caller keeps proxying the provider reference.
func GetPlaygroundTaskArtifact(userID int, taskID, artifactKey string) (*PlaygroundTaskArtifact, error) {
	if userID <= 0 || taskID == "" || artifactKey == "" {
		return nil, nil
	}
	var row PlaygroundTaskArtifact
	err := DB.Where("user_id = ? AND task_id = ? AND artifact_key = ?", userID, taskID, artifactKey).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// MarkPlaygroundTaskArtifactStored switches a pending artifact to its stored
// object. Only a pending row is transitioned, so a retry after a partial
// failure cannot overwrite the metadata of bytes that are already persisted.
// The provider reference stays in UpstreamRef for operators, exactly as on the
// expired transition, so every record keeps where its bytes came from.
func MarkPlaygroundTaskArtifactStored(recordID int64, backend, objectKey, mimeType string, byteSize int64, contentHash string, expiresAt int64, upstreamRef string) error {
	if recordID <= 0 {
		return ErrPlaygroundTaskArtifactInvalid
	}
	now := common.GetTimestamp()
	return DB.Model(&PlaygroundTaskArtifact{}).
		Where("id = ? AND state = ?", recordID, TaskArtifactStatePending).
		Updates(map[string]any{
			"state":        TaskArtifactStateStored,
			"backend":      backend,
			"object_key":   objectKey,
			"mime_type":    mimeType,
			"byte_size":    byteSize,
			"content_hash": contentHash,
			"upstream_ref": truncateTaskArtifactReason(upstreamRef, 2048),
			"expires_at":   expiresAt,
			"stored_at":    now,
			"updated_at":   now,
			"last_error":   "",
		}).Error
}

// MarkPlaygroundTaskArtifactExpired records that the bytes could not be kept.
// The provider reference stays in UpstreamRef so the content read path can
// still proxy it while the link lives, and the artifact is reported as expired
// instead of being dropped.
func MarkPlaygroundTaskArtifactExpired(recordID int64, upstreamRef, reason string) error {
	if recordID <= 0 {
		return ErrPlaygroundTaskArtifactInvalid
	}
	return DB.Model(&PlaygroundTaskArtifact{}).
		Where("id = ? AND state <> ?", recordID, TaskArtifactStateStored).
		Updates(map[string]any{
			"state":        TaskArtifactStateExpired,
			"upstream_ref": truncateTaskArtifactReason(upstreamRef, 2048),
			"last_error":   truncateTaskArtifactReason(reason, 255),
			"byte_size":    0,
			"object_key":   "",
			"content_hash": "",
			"expires_at":   0,
			"attempts":     gorm.Expr("attempts + 1"),
			"updated_at":   common.GetTimestamp(),
		}).Error
}

// MarkPlaygroundTaskArtifactFailure records one retryable failure without
// changing the state, so the next store pass tries again.
func MarkPlaygroundTaskArtifactFailure(recordID int64, reason string) error {
	if recordID <= 0 {
		return ErrPlaygroundTaskArtifactInvalid
	}
	return DB.Model(&PlaygroundTaskArtifact{}).
		Where("id = ? AND state = ?", recordID, TaskArtifactStatePending).
		Updates(map[string]any{
			"last_error": truncateTaskArtifactReason(reason, 255),
			"attempts":   gorm.Expr("attempts + 1"),
			"updated_at": common.GetTimestamp(),
		}).Error
}

// truncateTaskArtifactReason bounds a diagnostic string so a provider message
// can never overflow the column or the error payload.
func truncateTaskArtifactReason(value string, maxRunes int) string {
	value = strings.TrimSpace(value)
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}

// PlaygroundTaskArtifactStoredBytes reports how many bytes the owner's
// persisted generation results hold. It is part of the independent
// `TaskUserResultMaxBytes` budget and never reads or writes User.Quota.
func PlaygroundTaskArtifactStoredBytes(userID int) (int64, error) {
	if userID <= 0 {
		return 0, nil
	}
	var stored struct {
		UsedBytes int64
	}
	err := DB.Model(&PlaygroundTaskArtifact{}).
		Where("user_id = ? AND state = ?", userID, TaskArtifactStateStored).
		Select("COALESCE(SUM(byte_size), 0) AS used_bytes").Scan(&stored).Error
	if err != nil {
		return 0, err
	}
	return stored.UsedBytes, nil
}

// PendingTaskArtifactOwners lists the tasks that still have artifacts waiting
// for their bytes, oldest first, so the scheduled store pass retries them.
func PendingTaskArtifactOwners(limit int) ([]TaskArtifactOwner, error) {
	if limit <= 0 {
		limit = 20
	}
	rows := make([]TaskArtifactOwner, 0, limit)
	err := DB.Model(&PlaygroundTaskArtifact{}).
		Select("user_id, task_id").
		Where("state = ?", TaskArtifactStatePending).
		Group("user_id, task_id").
		Order("MIN(updated_at) ASC").
		Limit(limit).
		Find(&rows).Error
	return rows, err
}

// ListExpiredPlaygroundTaskArtifacts returns stored artifacts whose retention
// window ended and that no pin keeps alive. The caller deletes the object
// first and the row second, so a failed object deletion keeps the record for
// the next run instead of leaking bytes.
func ListExpiredPlaygroundTaskArtifacts(expiredBefore int64, batchSize int) ([]PlaygroundTaskArtifact, error) {
	if batchSize <= 0 {
		batchSize = 200
	}
	candidates := make([]PlaygroundTaskArtifact, 0, batchSize)
	if err := DB.Where("state = ? AND expires_at > 0 AND expires_at < ?", TaskArtifactStateStored, expiredBefore).
		Order("expires_at ASC, id ASC").Limit(batchSize).Find(&candidates).Error; err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return candidates, nil
	}
	pinned, err := playgroundTaskArtifactPinSet(candidates)
	if err != nil {
		return nil, err
	}
	expired := make([]PlaygroundTaskArtifact, 0, len(candidates))
	for index := range candidates {
		if pinned[playgroundTaskArtifactPinKey(candidates[index].UserID, candidates[index].TaskID, candidates[index].ArtifactKey)] {
			continue
		}
		expired = append(expired, candidates[index])
	}
	return expired, nil
}

// DeletePlaygroundTaskArtifact removes one expired, unpinned artifact row
// after its object was deleted. The state, expiry, and pin guards are re-read
// inside the transaction, so a pin created after the expiry listing wins and
// the row (and its object) survives.
func DeletePlaygroundTaskArtifact(recordID int64) (bool, error) {
	if recordID <= 0 {
		return false, nil
	}
	deleted := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		var record PlaygroundTaskArtifact
		err := tx.Where("id = ?", recordID).First(&record).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if record.State != TaskArtifactStateStored || record.ExpiresAt <= 0 || record.ExpiresAt >= common.GetTimestamp() {
			return nil
		}
		var pins int64
		if err := tx.Model(&PlaygroundTaskArtifactPin{}).
			Where("user_id = ? AND task_id = ? AND (artifact_key = ? OR artifact_key = '')", record.UserID, record.TaskID, record.ArtifactKey).
			Count(&pins).Error; err != nil {
			return err
		}
		if pins > 0 {
			return nil
		}
		result := tx.Where("id = ?", record.ID).Delete(&PlaygroundTaskArtifact{})
		if result.Error != nil {
			return result.Error
		}
		deleted = result.RowsAffected == 1
		return nil
	})
	return deleted, err
}

func playgroundTaskArtifactPinKey(userID int, taskID, artifactKey string) string {
	return taskID + "\x00" + artifactKey
}

// playgroundTaskArtifactPinSet reports which of the given artifacts are kept
// alive by an asset-library or canvas pin.
func playgroundTaskArtifactPinSet(artifacts []PlaygroundTaskArtifact) (map[string]bool, error) {
	pinned := make(map[string]bool, len(artifacts))
	if len(artifacts) == 0 {
		return pinned, nil
	}
	taskIDs := make([]string, 0, len(artifacts))
	seen := make(map[string]bool, len(artifacts))
	for index := range artifacts {
		if !seen[artifacts[index].TaskID] {
			seen[artifacts[index].TaskID] = true
			taskIDs = append(taskIDs, artifacts[index].TaskID)
		}
	}
	rows := make([]PlaygroundTaskArtifactPin, 0)
	if err := DB.Where("task_id IN ?", taskIDs).Find(&rows).Error; err != nil {
		return nil, err
	}
	for index := range rows {
		pinned[playgroundTaskArtifactPinKey(rows[index].UserID, rows[index].TaskID, rows[index].ArtifactKey)] = true
	}
	return pinned, nil
}

// IsPlaygroundTaskArtifactPinned reports whether the owner (asset library) or
// a canvas keeps one artifact's bytes alive past their retention window.
func IsPlaygroundTaskArtifactPinned(userID int, taskID, artifactKey string) (bool, error) {
	if userID <= 0 || taskID == "" || artifactKey == "" {
		return false, nil
	}
	var count int64
	err := DB.Model(&PlaygroundTaskArtifactPin{}).
		Where("user_id = ? AND task_id = ? AND (artifact_key = ? OR artifact_key = '')", userID, taskID, artifactKey).
		Count(&count).Error
	return count > 0, err
}

// SetPlaygroundTaskArtifactPin keeps or releases the artifacts of one owned
// task. Pinning is idempotent; releasing removes only the asset-library pin,
// so a canvas that still references the result keeps it.
func SetPlaygroundTaskArtifactPin(userID int, taskID, artifactKey string, pinned bool) error {
	if userID <= 0 || strings.TrimSpace(taskID) == "" || strings.TrimSpace(artifactKey) == "" {
		return ErrPlaygroundTaskArtifactInvalid
	}
	taskID = strings.TrimSpace(taskID)
	artifactKey = strings.TrimSpace(artifactKey)
	if pinned {
		row := PlaygroundTaskArtifactPin{
			UserID:      userID,
			TaskID:      taskID,
			ArtifactKey: artifactKey,
			Source:      PlaygroundTaskArtifactPinSourceAsset,
			SourceID:    "",
			CreatedAt:   common.GetTimestamp(),
		}
		return DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error
	}
	return DB.Where("user_id = ? AND task_id = ? AND artifact_key = ? AND source = ?",
		userID, taskID, artifactKey, PlaygroundTaskArtifactPinSourceAsset).
		Delete(&PlaygroundTaskArtifactPin{}).Error
}

// PlaygroundTaskArtifactPinKeys lists the artifact keys of one task the asset
// library keeps, so the artifact listing can report the pinned state.
func PlaygroundTaskArtifactPinKeys(userID int, taskID string) ([]string, error) {
	keys := make([]string, 0)
	if userID <= 0 || taskID == "" {
		return keys, nil
	}
	err := DB.Model(&PlaygroundTaskArtifactPin{}).
		Where("user_id = ? AND task_id = ?", userID, taskID).
		Pluck("artifact_key", &keys).Error
	return keys, err
}

// PlaygroundTaskArtifactPinnedForTasks reports whether any artwork of the
// given tasks is pinned. The scheduled task cleanup uses it to keep a task row
// (and therefore its readable results) while the owner still references it.
func PlaygroundTaskArtifactPinnedForTasks(userID int, taskIDs []string) (map[string]bool, error) {
	pinned := make(map[string]bool, len(taskIDs))
	if userID <= 0 || len(taskIDs) == 0 {
		return pinned, nil
	}
	rows := make([]PlaygroundTaskArtifactPin, 0)
	if err := DB.Where("user_id = ? AND task_id IN ?", userID, taskIDs).Find(&rows).Error; err != nil {
		return nil, err
	}
	for index := range rows {
		pinned[rows[index].TaskID] = true
	}
	return pinned, nil
}

// PlaygroundCanvasTaskArtifactRef names one generated result a canvas node
// keeps alive. The document already stores the task id and artifact key; this
// keeps the pin table the canvas writer maintains in sync with it.
type PlaygroundCanvasTaskArtifactRef struct {
	TaskID      string
	ArtifactKey string
}

// syncPlaygroundCanvasTaskArtifactPins replaces the canvas pins of one canvas
// inside the canvas write transaction, so deleting the canvas is the only way
// its board stops keeping a result alive.
func syncPlaygroundCanvasTaskArtifactPins(tx *gorm.DB, userID int, canvasID string, refs []PlaygroundCanvasTaskArtifactRef) error {
	if err := tx.Where("source = ? AND source_id = ? AND user_id = ?", PlaygroundTaskArtifactPinSourceCanvas, canvasID, userID).
		Delete(&PlaygroundTaskArtifactPin{}).Error; err != nil {
		return err
	}
	now := common.GetTimestamp()
	seen := make(map[string]bool, len(refs))
	rows := make([]PlaygroundTaskArtifactPin, 0, len(refs))
	for _, ref := range refs {
		taskID := strings.TrimSpace(ref.TaskID)
		artifactKey := strings.TrimSpace(ref.ArtifactKey)
		if taskID == "" || artifactKey == "" {
			continue
		}
		key := taskID + "\x00" + artifactKey
		if seen[key] {
			continue
		}
		seen[key] = true
		rows = append(rows, PlaygroundTaskArtifactPin{
			UserID:      userID,
			TaskID:      taskID,
			ArtifactKey: artifactKey,
			Source:      PlaygroundTaskArtifactPinSourceCanvas,
			SourceID:    canvasID,
			CreatedAt:   now,
		})
	}
	if len(rows) == 0 {
		return nil
	}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&rows).Error
}

// HasPlaygroundTasksAwaitingArtifacts reports whether the store pass has work:
// an artifact still waiting for its bytes, or a successful workspace task that
// was never projected. The scheduler folds this into its enablement so an idle
// deployment creates no system task rows.
func HasPlaygroundTasksAwaitingArtifacts(finishedAfter int64) (bool, error) {
	var pending int64
	if err := DB.Model(&PlaygroundTaskArtifact{}).
		Where("state = ?", TaskArtifactStatePending).Limit(1).Count(&pending).Error; err != nil {
		return false, err
	}
	if pending > 0 {
		return true, nil
	}
	var unprojected int64
	err := DB.Model(&Task{}).
		Where("status = ?", TaskStatusSuccess).
		Where("finish_time >= ? AND finish_time > 0", finishedAfter).
		Where(playgroundTaskOriginCondition()).
		Where("task_id NOT IN (?)", DB.Model(&PlaygroundTaskArtifactSync{}).Select("task_id")).
		Limit(1).Count(&unprojected).Error
	return unprojected > 0, err
}

// MarkPlaygroundTaskArtifactsSynced records that every artifact of one task
// reached a terminal state, so the store pass stops listing it.
func MarkPlaygroundTaskArtifactsSynced(userID int, taskID string) error {
	if userID <= 0 || strings.TrimSpace(taskID) == "" {
		return ErrPlaygroundTaskArtifactInvalid
	}
	marker := PlaygroundTaskArtifactSync{TaskID: taskID, UserID: userID, CreatedAt: common.GetTimestamp()}
	return DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&marker).Error
}

// DeletePlaygroundTaskArtifactSyncMarkers forgets the projections of deleted
// task rows, so their task ids can never collide with a reused id.
func DeletePlaygroundTaskArtifactSyncMarkers(taskIDs []string) error {
	if len(taskIDs) == 0 {
		return nil
	}
	return DB.Where("task_id IN ?", taskIDs).Delete(&PlaygroundTaskArtifactSync{}).Error
}

// ListPlaygroundTasksMissingArtifactSync returns successful workspace tasks
// that finished inside the retention window and were not projected yet.
func ListPlaygroundTasksMissingArtifactSync(finishedAfter int64, limit int) ([]*Task, error) {
	if limit <= 0 {
		limit = 20
	}
	tasks := make([]*Task, 0, limit)
	err := DB.Model(&Task{}).
		Where("status = ?", TaskStatusSuccess).
		Where("finish_time >= ? AND finish_time > 0", finishedAfter).
		Where(playgroundTaskOriginCondition()).
		Where("task_id NOT IN (?)", DB.Model(&PlaygroundTaskArtifactSync{}).Select("task_id")).
		Order("finish_time DESC, id DESC").
		Limit(limit).
		Find(&tasks).Error
	return tasks, err
}
