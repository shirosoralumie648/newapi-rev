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
	"time"

	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
)

// PlaygroundTaskQueueKind identifies the two request shapes the optional
// workspace queue accepts. Both are JSON generations that create a durable
// asynchronous task; multipart image edits and live workflow-budget requests
// stay on the synchronous rejection path because their live budget cannot be
// preserved while the entry waits.
const (
	PlaygroundTaskQueueKindImage = "image"
	PlaygroundTaskQueueKindVideo = "video"
)

// PlaygroundTaskQueueStatus is the lifecycle of one queued submission. Only a
// queued entry may be canceled or moved to the front. Claiming is a CAS from
// queued to submitting, so two workers can never submit the same entry. A
// submitted entry keeps the durable task id for the recent-submission view.
const (
	PlaygroundTaskQueueStatusQueued     = "queued"
	PlaygroundTaskQueueStatusSubmitting = "submitting"
	PlaygroundTaskQueueStatusSubmitted  = "submitted"
	PlaygroundTaskQueueStatusCanceled   = "canceled"
	PlaygroundTaskQueueStatusFailed     = "failed"
)

const (
	// PlaygroundTaskQueueMaxAttempts bounds automatic retries of a transient
	// submission failure. The entry moves to failed once the limit is reached,
	// so a permanently broken channel or payload cannot spin forever.
	PlaygroundTaskQueueMaxAttempts = 3
	// PlaygroundTaskQueueRecentSubmittedSeconds keeps a dequeue visible in the
	// queue view long enough for the browser to refresh the durable task list.
	PlaygroundTaskQueueRecentSubmittedSeconds int64 = 10 * 60
	// playgroundTaskQueueMaxPriority caps how far a single "move to front"
	// request may raise one entry. Ties fall back to submission time, so the
	// cap only prevents unbounded integer growth.
	playgroundTaskQueueMaxPriority = 1_000_000
)

var (
	// ErrPlaygroundTaskQueueNotFound reports that no queue entry of the caller
	// matches the requested id.
	ErrPlaygroundTaskQueueNotFound = errors.New("playground task queue entry not found")
	// ErrPlaygroundTaskQueueNotCancelable reports that the entry exists but is
	// no longer queued, so cancel or move-to-front lost the race with a worker.
	ErrPlaygroundTaskQueueNotCancelable = errors.New("playground task queue entry is not queued")
	// ErrPlaygroundTaskQueueFull reports that the account already has the
	// configured number of active queue entries.
	ErrPlaygroundTaskQueueFull = errors.New("playground task queue is full")
	// ErrPlaygroundTaskQueueTaskMissing reports that a replay returned a task
	// id whose durable Playground task row is missing. The entry is not marked
	// submitted without that row: the queue view and task list would otherwise
	// disagree about a submission that never existed.
	ErrPlaygroundTaskQueueTaskMissing = errors.New("playground task queue replay task missing")
)

// PlaygroundTaskQueueEntry is one owner-scoped async generation waiting for a
// free account concurrency slot. It stores the validated canonical JSON request
// so a worker can replay the ordinary /pg submission path, including channel
// selection and pre-charge, after the slot opens. No quota is reserved while
// the entry is queued.
type PlaygroundTaskQueueEntry struct {
	ID      int64  `json:"-" gorm:"primaryKey;autoIncrement"`
	QueueID string `json:"id" gorm:"size:48;not null;uniqueIndex"`
	UserID  int    `json:"-" gorm:"not null;index:idx_pg_task_queue_owner_status,priority:1"`
	Kind    string `json:"kind" gorm:"size:16;not null"`
	Status  string `json:"status" gorm:"size:20;not null;index:idx_pg_task_queue_owner_status,priority:2;index:idx_pg_task_queue_order,priority:1"`
	// Priority is higher-is-earlier. A normal submission starts at zero; the
	// explicit move-to-front action raises it above the current queue head.
	Priority    int    `json:"priority" gorm:"not null;index:idx_pg_task_queue_order,priority:2"`
	RequestPath string `json:"-" gorm:"size:128;not null"`
	Group       string `json:"group" gorm:"size:64;not null"`
	// ContentType is replayed with the stored JSON body. Only application/json
	// requests are queueable, but keeping the exact value avoids changing the
	// canonical generation pipeline on dequeue.
	ContentType   string   `json:"-" gorm:"size:128;not null"`
	RequestBody   LongText `json:"-" gorm:"not null"`
	RequestBytes  int64    `json:"request_bytes" gorm:"not null"`
	Model         string   `json:"model" gorm:"size:191"`
	PromptPreview string   `json:"prompt_preview" gorm:"size:512"`
	TaskID        string   `json:"task_id,omitempty" gorm:"size:191"`
	ErrorCode     string   `json:"error_code,omitempty" gorm:"size:64"`
	ErrorMessage  string   `json:"error_message,omitempty" gorm:"size:1024"`
	Attempts      int      `json:"-" gorm:"not null"`
	CreatedAt     int64    `json:"created_at" gorm:"not null;index:idx_pg_task_queue_order,priority:3"`
	UpdatedAt     int64    `json:"updated_at" gorm:"not null"`
	StartedAt     int64    `json:"started_at" gorm:"not null"`
	FinishedAt    int64    `json:"finished_at" gorm:"not null"`
}

// EnqueuePlaygroundTaskQueueEntry inserts one owner-scoped entry after checking
// the account's active queue count under the user-row lock. A non-positive
// maxActive means the queue count is unlimited. The queue itself is free: this
// path never reads or writes User.Quota.
func EnqueuePlaygroundTaskQueueEntry(entry *PlaygroundTaskQueueEntry, maxActive int) (*PlaygroundTaskQueueEntry, error) {
	if entry == nil || entry.UserID <= 0 {
		return nil, ErrPlaygroundTaskQueueNotFound
	}
	if entry.QueueID == "" {
		key, err := common.GenerateRandomCharsKey(32)
		if err != nil {
			return nil, err
		}
		entry.QueueID = "pgq_" + key
	}
	now := common.GetTimestamp()
	entry.Status = PlaygroundTaskQueueStatusQueued
	entry.Priority = 0
	entry.Attempts = 0
	entry.TaskID = ""
	entry.ErrorCode = ""
	entry.ErrorMessage = ""
	entry.CreatedAt = now
	entry.UpdatedAt = now
	entry.StartedAt = 0
	entry.FinishedAt = 0

	err := DB.Transaction(func(tx *gorm.DB) error {
		if maxActive > 0 {
			var user User
			if err := lockForUpdate(tx).Select("id").Where("id = ?", entry.UserID).First(&user).Error; err != nil {
				return err
			}
			count, err := countActivePlaygroundTaskQueueEntries(tx, entry.UserID)
			if err != nil {
				return err
			}
			if count >= int64(maxActive) {
				return ErrPlaygroundTaskQueueFull
			}
		}
		return tx.Create(entry).Error
	})
	if err != nil {
		return nil, err
	}
	return entry, nil
}

// CountActivePlaygroundTaskQueueEntries reports how many entries the account
// currently holds in queued or submitting state. Submitted and terminal rows
// stay outside the count because they already consume a durable task slot or
// no longer represent waiting work.
func CountActivePlaygroundTaskQueueEntries(userID int) (int64, error) {
	if userID <= 0 {
		return 0, nil
	}
	return countActivePlaygroundTaskQueueEntries(DB, userID)
}

func countActivePlaygroundTaskQueueEntries(tx *gorm.DB, userID int) (int64, error) {
	var count int64
	err := tx.Model(&PlaygroundTaskQueueEntry{}).
		Where("user_id = ? AND status IN ?", userID, []string{PlaygroundTaskQueueStatusQueued, PlaygroundTaskQueueStatusSubmitting}).
		Count(&count).Error
	return count, err
}

// HasQueuedPlaygroundTaskQueueEntries reports whether any account has a
// queued entry. The scheduled worker uses it to avoid creating empty system
// task rows. Entries left while the administrator later disabled queueing are
// still drained, so disabling the feature never strands accepted work.
func HasQueuedPlaygroundTaskQueueEntries() (bool, error) {
	var count int64
	err := DB.Model(&PlaygroundTaskQueueEntry{}).
		Where("status = ?", PlaygroundTaskQueueStatusQueued).
		Limit(1).Count(&count).Error
	return count > 0, err
}

// ListQueuedPlaygroundTaskQueueCandidates returns the next queued entries in
// priority and submission order. The worker filters out owners whose account is
// already at its concurrency limit, so a blocked account never stalls another
// account's request.
func ListQueuedPlaygroundTaskQueueCandidates(limit int) ([]PlaygroundTaskQueueEntry, error) {
	if limit <= 0 {
		limit = 100
	}
	var entries []PlaygroundTaskQueueEntry
	err := DB.Where("status = ?", PlaygroundTaskQueueStatusQueued).
		Order("priority DESC, created_at ASC, id ASC").
		Limit(limit).Find(&entries).Error
	return entries, err
}

// ListPlaygroundTaskQueueEntries returns the owner's active entries followed by
// recently submitted entries. Recently submitted entries let the queue panel
// observe the dequeue transition and refresh the durable task list; older
// submitted rows stay in the database only as an audit trail.
func ListPlaygroundTaskQueueEntries(userID int) ([]PlaygroundTaskQueueEntry, error) {
	if userID <= 0 {
		return nil, nil
	}
	var active []PlaygroundTaskQueueEntry
	if err := DB.Where("user_id = ? AND status IN ?", userID, []string{PlaygroundTaskQueueStatusQueued, PlaygroundTaskQueueStatusSubmitting}).
		Order("priority DESC, created_at ASC, id ASC").
		Find(&active).Error; err != nil {
		return nil, err
	}
	cutoff := common.GetTimestamp() - PlaygroundTaskQueueRecentSubmittedSeconds
	var submitted []PlaygroundTaskQueueEntry
	if err := DB.Where("user_id = ? AND status = ? AND updated_at >= ?", userID, PlaygroundTaskQueueStatusSubmitted, cutoff).
		Order("updated_at DESC, id DESC").
		Limit(10).Find(&submitted).Error; err != nil {
		return nil, err
	}
	return append(active, submitted...), nil
}

// GetPlaygroundTaskQueueEntry returns one owner-scoped entry regardless of its
// status. Cross-user and unknown ids deliberately look identical.
func GetPlaygroundTaskQueueEntry(userID int, queueID string) (*PlaygroundTaskQueueEntry, error) {
	if userID <= 0 || queueID == "" {
		return nil, ErrPlaygroundTaskQueueNotFound
	}
	var entry PlaygroundTaskQueueEntry
	err := DB.Where("user_id = ? AND queue_id = ?", userID, queueID).First(&entry).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundTaskQueueNotFound
	}
	if err != nil {
		return nil, err
	}
	return &entry, nil
}

// PlaygroundTaskQueuePosition returns the one-based global queue position of a
// queued entry. A non-queued or unknown entry has no position.
func PlaygroundTaskQueuePosition(entry *PlaygroundTaskQueueEntry) (int64, error) {
	if entry == nil || entry.QueueID == "" || entry.Status != PlaygroundTaskQueueStatusQueued {
		return 0, nil
	}
	var ahead int64
	err := DB.Model(&PlaygroundTaskQueueEntry{}).
		Where("status = ?", PlaygroundTaskQueueStatusQueued).
		Where("priority > ? OR (priority = ? AND (created_at < ? OR (created_at = ? AND id < ?)))",
			entry.Priority, entry.Priority, entry.CreatedAt, entry.CreatedAt, entry.ID).
		Count(&ahead).Error
	if err != nil {
		return 0, err
	}
	return ahead + 1, nil
}

// CancelPlaygroundTaskQueueEntry transitions one owner-scoped queued entry to
// canceled. Only queued entries can be canceled: a submitting entry is already
// inside the relay and must be canceled through the durable task endpoint, and
// a submitted entry already has a task row.
func CancelPlaygroundTaskQueueEntry(userID int, queueID string) (*PlaygroundTaskQueueEntry, error) {
	if userID <= 0 || queueID == "" {
		return nil, ErrPlaygroundTaskQueueNotFound
	}
	now := common.GetTimestamp()
	result := DB.Model(&PlaygroundTaskQueueEntry{}).
		Where("user_id = ? AND queue_id = ? AND status = ?", userID, queueID, PlaygroundTaskQueueStatusQueued).
		Updates(map[string]any{
			"status":      PlaygroundTaskQueueStatusCanceled,
			"updated_at":  now,
			"finished_at": now,
		})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		if _, err := GetPlaygroundTaskQueueEntry(userID, queueID); err != nil {
			return nil, err
		}
		return nil, ErrPlaygroundTaskQueueNotCancelable
	}
	return GetPlaygroundTaskQueueEntry(userID, queueID)
}

// PrioritizePlaygroundTaskQueueEntry raises one owner-scoped queued entry above
// the current global head. The row lock keeps concurrent moves from reading the
// same head and assigning the same priority; ties still order by submitted
// time. Only queued entries can move.
func PrioritizePlaygroundTaskQueueEntry(userID int, queueID string) (*PlaygroundTaskQueueEntry, error) {
	if userID <= 0 || queueID == "" {
		return nil, ErrPlaygroundTaskQueueNotFound
	}
	var entry PlaygroundTaskQueueEntry
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("user_id = ? AND queue_id = ?", userID, queueID).First(&entry).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundTaskQueueNotFound
			}
			return err
		}
		if entry.Status != PlaygroundTaskQueueStatusQueued {
			return ErrPlaygroundTaskQueueNotCancelable
		}
		var head int
		if err := tx.Model(&PlaygroundTaskQueueEntry{}).
			Where("status = ?", PlaygroundTaskQueueStatusQueued).
			Select("COALESCE(MAX(priority), 0)").Scan(&head).Error; err != nil {
			return err
		}
		next := min(head+1, playgroundTaskQueueMaxPriority)
		now := common.GetTimestamp()
		if err := tx.Model(&PlaygroundTaskQueueEntry{}).
			Where("id = ? AND status = ?", entry.ID, PlaygroundTaskQueueStatusQueued).
			Updates(map[string]any{"priority": next, "updated_at": now}).Error; err != nil {
			return err
		}
		entry.Priority = next
		entry.UpdatedAt = now
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &entry, nil
}

// ClaimPlaygroundTaskQueueEntry claims the next queued entry for one worker
// with a CAS. It increments the attempt count in the same statement, so a
// crash after the claim leaves an attempt recorded and the stale-submitting
// recovery in the worker can decide whether to retry.
func ClaimPlaygroundTaskQueueEntry(queueID string) (bool, error) {
	if queueID == "" {
		return false, nil
	}
	now := common.GetTimestamp()
	result := DB.Model(&PlaygroundTaskQueueEntry{}).
		Where("queue_id = ? AND status = ?", queueID, PlaygroundTaskQueueStatusQueued).
		Updates(map[string]any{
			"status":     PlaygroundTaskQueueStatusSubmitting,
			"attempts":   gorm.Expr("attempts + 1"),
			"updated_at": now,
			"started_at": now,
		})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}

// CompletePlaygroundTaskQueueEntry atomically marks a claimed entry submitted
// and verifies that the replay produced an owner-scoped Playground task row.
// The check is inside the same transaction as the status change, so the queue
// view can never display a task id that does not exist in the task list.
func CompletePlaygroundTaskQueueEntry(userID int, queueID, taskID string) error {
	if userID <= 0 || queueID == "" || taskID == "" {
		return ErrPlaygroundTaskQueueTaskMissing
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var entry PlaygroundTaskQueueEntry
		if err := lockForUpdate(tx).
			Where("user_id = ? AND queue_id = ? AND status = ?", userID, queueID, PlaygroundTaskQueueStatusSubmitting).
			First(&entry).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundTaskQueueNotFound
			}
			return err
		}
		var task Task
		if err := tx.Where("user_id = ? AND task_id = ?", userID, taskID).First(&task).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundTaskQueueTaskMissing
			}
			return err
		}
		if !task.PrivateData.PlaygroundOrigin {
			return ErrPlaygroundTaskQueueTaskMissing
		}
		now := common.GetTimestamp()
		return tx.Model(&PlaygroundTaskQueueEntry{}).Where("id = ?", entry.ID).Updates(map[string]any{
			"status":        PlaygroundTaskQueueStatusSubmitted,
			"task_id":       taskID,
			"error_code":    "",
			"error_message": "",
			"updated_at":    now,
			"finished_at":   now,
		}).Error
	})
}

// FailPlaygroundTaskQueueEntry marks a claimed entry failed with the stable
// error code and English source message shown in the queue view. A failed
// entry is terminal; the user submits a new request to try again.
func FailPlaygroundTaskQueueEntry(queueID, errorCode, errorMessage string) error {
	if queueID == "" {
		return ErrPlaygroundTaskQueueNotFound
	}
	now := common.GetTimestamp()
	result := DB.Model(&PlaygroundTaskQueueEntry{}).
		Where("queue_id = ? AND status = ?", queueID, PlaygroundTaskQueueStatusSubmitting).
		Updates(map[string]any{
			"status":        PlaygroundTaskQueueStatusFailed,
			"error_code":    errorCode,
			"error_message": errorMessage,
			"updated_at":    now,
			"finished_at":   now,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrPlaygroundTaskQueueNotFound
	}
	return nil
}

// ReleasePlaygroundTaskQueueEntry returns a claimed entry to the queue after a
// transient failure, or fails it when the attempt limit is reached. The CAS only
// touches a row still in submitting state, so a late worker cannot overwrite a
// success or a cancellation.
func ReleasePlaygroundTaskQueueEntry(queueID string, attempts, maxAttempts int, errorCode, errorMessage string) (string, error) {
	if queueID == "" {
		return "", ErrPlaygroundTaskQueueNotFound
	}
	if maxAttempts <= 0 {
		maxAttempts = PlaygroundTaskQueueMaxAttempts
	}
	now := common.GetTimestamp()
	nextStatus := PlaygroundTaskQueueStatusQueued
	updates := map[string]any{
		"status":        nextStatus,
		"error_code":    "",
		"error_message": "",
		"updated_at":    now,
		"started_at":    0,
	}
	if attempts >= maxAttempts {
		nextStatus = PlaygroundTaskQueueStatusFailed
		updates["status"] = nextStatus
		updates["error_code"] = errorCode
		updates["error_message"] = errorMessage
		updates["finished_at"] = now
	}
	result := DB.Model(&PlaygroundTaskQueueEntry{}).
		Where("queue_id = ? AND status = ?", queueID, PlaygroundTaskQueueStatusSubmitting).
		Updates(updates)
	if result.Error != nil {
		return "", result.Error
	}
	if result.RowsAffected == 0 {
		return "", ErrPlaygroundTaskQueueNotFound
	}
	return nextStatus, nil
}

// RecoverStalePlaygroundTaskQueueEntries returns entries abandoned in
// submitting state by a crashed worker to the queue (or fails them once the
// attempt limit is reached). The system task runner guarantees a single worker,
// but a process can stop between claiming and completing, so recovery is needed
// for the queue to make progress after a restart.
func RecoverStalePlaygroundTaskQueueEntries(staleBefore int64) (int64, error) {
	if staleBefore <= 0 {
		return 0, nil
	}
	var entries []PlaygroundTaskQueueEntry
	if err := DB.Where("status = ? AND updated_at < ?", PlaygroundTaskQueueStatusSubmitting, staleBefore).
		Limit(100).Find(&entries).Error; err != nil {
		return 0, err
	}
	var recovered int64
	for index := range entries {
		entry := &entries[index]
		code := "PLAYGROUND_TASK_QUEUE_INTERRUPTED"
		message := "The queued submission was interrupted before it finished."
		if _, err := ReleasePlaygroundTaskQueueEntry(entry.QueueID, entry.Attempts, PlaygroundTaskQueueMaxAttempts, code, message); err != nil {
			if errors.Is(err, ErrPlaygroundTaskQueueNotFound) {
				continue
			}
			return recovered, err
		}
		recovered++
	}
	return recovered, nil
}

// DeleteTerminalPlaygroundTaskQueueEntries removes old canceled, failed and
// submitted queue rows. Queued and submitting rows are never deleted: they are
// accepted work that must still be processed. The scheduled Playground cleanup
// calls this alongside task expiry so the queue audit trail stays bounded.
func DeleteTerminalPlaygroundTaskQueueEntries(updatedBefore int64, batchSize int) (int64, error) {
	if updatedBefore <= 0 {
		return 0, nil
	}
	if batchSize <= 0 {
		batchSize = 200
	}
	statuses := []string{
		PlaygroundTaskQueueStatusCanceled,
		PlaygroundTaskQueueStatusFailed,
		PlaygroundTaskQueueStatusSubmitted,
	}
	var total int64
	for {
		var ids []int64
		if err := DB.Model(&PlaygroundTaskQueueEntry{}).
			Where("status IN ? AND updated_at < ?", statuses, updatedBefore).
			Order("id ASC").Limit(batchSize).Pluck("id", &ids).Error; err != nil {
			return total, err
		}
		if len(ids) == 0 {
			return total, nil
		}
		result := DB.Where("id IN ? AND status IN ?", ids, statuses).Delete(&PlaygroundTaskQueueEntry{})
		if result.Error != nil {
			return total, result.Error
		}
		total += result.RowsAffected
		if len(ids) < batchSize {
			return total, nil
		}
	}
}

// AveragePlaygroundTaskDurationSeconds estimates one queued submission's run
// time from the account's recent successful Playground tasks. It is advisory:
// the queue view labels the value as an estimate, and no billing or scheduling
// decision depends on it. A new account falls back to one minute.
func AveragePlaygroundTaskDurationSeconds(userID int) (int64, error) {
	if userID <= 0 {
		return 60, nil
	}
	var rows []Task
	if err := DB.Select("submit_time", "finish_time").
		Where("user_id = ? AND status = ? AND finish_time > submit_time", userID, TaskStatusSuccess).
		Where(playgroundTaskOriginCondition()).
		Order("finish_time DESC").Limit(20).Find(&rows).Error; err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 60, nil
	}
	var total int64
	for index := range rows {
		total += max(rows[index].FinishTime-rows[index].SubmitTime, int64(1))
	}
	average := total / int64(len(rows))
	if average < 1 {
		average = 1
	}
	// Clamp an implausibly long historical run so one outlier cannot make the
	// displayed wait grow without bound.
	return min(average, int64(24*time.Hour/time.Second)), nil
}
