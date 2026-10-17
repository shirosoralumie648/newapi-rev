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

	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
)

// PlaygroundTaskCanceledReason is the fail reason written when the workspace
// cancels a running task. The same English sentence is a key in the frontend
// locale files, so the task list can translate it for the owner.
const PlaygroundTaskCanceledReason = "Task canceled"

var (
	// ErrPlaygroundTaskNotFound reports that no Playground-origin task of the
	// caller matches the requested id.
	ErrPlaygroundTaskNotFound = errors.New("playground task not found")
	// ErrPlaygroundTaskNotCancelable reports that the task exists but is
	// already in a terminal state, so cancellation lost the race.
	ErrPlaygroundTaskNotCancelable = errors.New("playground task not cancelable")
)

// CountActivePlaygroundTasks reports how many async generation tasks the
// account still has running. It backs the Playground task concurrency budget
// (`TaskMaxConcurrency`), which is an independent resource limit: the count
// reads the durable task rows and never touches User.Quota, UsedQuota or the
// token billing settlement path.
//
// A task is active until it reaches a terminal state, so a task whose result
// is being polled still consumes one slot.
func CountActivePlaygroundTasks(userID int) (int64, error) {
	if userID <= 0 {
		return 0, nil
	}
	var count int64
	err := DB.Model(&Task{}).
		Where("user_id = ?", userID).
		Where("status NOT IN ?", []TaskStatus{TaskStatusFailure, TaskStatusSuccess}).
		Count(&count).Error
	if err != nil {
		return 0, err
	}
	return count, nil
}

// playgroundTaskOriginCondition returns the dialect-specific SQL predicate
// that matches task rows submitted from the Playground workspace. The marker
// lives in the JSON `private_data` column, so each supported database reads it
// with its own JSON operator.
func playgroundTaskOriginCondition() string {
	switch {
	case common.UsingMainDatabase(common.DatabaseTypePostgreSQL):
		return "private_data->>'playground_origin' = 'true'"
	case common.UsingMainDatabase(common.DatabaseTypeMySQL):
		return "JSON_UNQUOTE(JSON_EXTRACT(private_data, '$.playground_origin')) = 'true'"
	default:
		return "json_extract(private_data, '$.playground_origin') = 1"
	}
}

// playgroundTaskResultBytesQuery returns the dialect-specific aggregate over
// the stored result snapshot bytes of a `tasks` query.
func playgroundTaskResultBytesQuery() string {
	switch {
	case common.UsingMainDatabase(common.DatabaseTypePostgreSQL):
		return "COALESCE(SUM(OCTET_LENGTH(CAST(data AS TEXT))), 0)"
	case common.UsingMainDatabase(common.DatabaseTypeMySQL):
		return "COALESCE(SUM(OCTET_LENGTH(CAST(data AS CHAR))), 0)"
	default:
		return "COALESCE(SUM(LENGTH(CAST(data AS BLOB))), 0)"
	}
}

// PlaygroundTaskResultStorageBytes reports how many retained result snapshot
// bytes the account's Playground-origin async tasks hold. The value backs the
// `TaskUserResultMaxBytes` budget, an independent resource limit that never
// reads or writes User.Quota.
func PlaygroundTaskResultStorageBytes(userID int) (int64, error) {
	if userID <= 0 {
		return 0, nil
	}
	var stored struct {
		UsedBytes int64
	}
	err := DB.Model(&Task{}).
		Where("user_id = ?", userID).
		Where(playgroundTaskOriginCondition()).
		Select(playgroundTaskResultBytesQuery() + " AS used_bytes").
		Scan(&stored).Error
	if err != nil {
		return 0, err
	}
	return stored.UsedBytes, nil
}

// DeleteExpiredPlaygroundTasks hard-deletes terminal Playground-origin tasks
// whose finish time predates the cutoff, freeing the result snapshots they
// retain. Only rows that reached a terminal state before the cutoff are
// eligible, so rows still being polled are never removed; polling updates use
// a status CAS and cannot resurrect a deleted row.
func DeleteExpiredPlaygroundTasks(finishedBefore int64, batchSize int) (int64, error) {
	if batchSize <= 0 {
		batchSize = 200
	}
	var total int64
	for {
		var ids []int64
		if err := DB.Model(&Task{}).
			Where("status IN ?", []TaskStatus{TaskStatusFailure, TaskStatusSuccess}).
			Where("finish_time > 0 AND finish_time < ?", finishedBefore).
			Where(playgroundTaskOriginCondition()).
			Order("finish_time ASC, id ASC").Limit(batchSize).Pluck("id", &ids).Error; err != nil {
			return total, err
		}
		if len(ids) == 0 {
			return total, nil
		}
		result := DB.Where("id IN ?", ids).
			Where("status IN ?", []TaskStatus{TaskStatusFailure, TaskStatusSuccess}).
			Where("finish_time > 0 AND finish_time < ?", finishedBefore).
			Where(playgroundTaskOriginCondition()).
			Delete(&Task{})
		if result.Error != nil {
			return total, result.Error
		}
		total += result.RowsAffected
		if len(ids) < batchSize {
			return total, nil
		}
	}
}

// CancelPlaygroundTask transitions one owner-scoped, unfinished Playground
// task to FAILURE and returns the canceled row. The status CAS keeps the
// transition from overwriting a concurrent success, and the caller refunds the
// reserved quota only after this function reports the win.
func CancelPlaygroundTask(userID int, taskID string) (*Task, error) {
	if userID <= 0 || taskID == "" {
		return nil, ErrPlaygroundTaskNotFound
	}
	var task Task
	err := DB.Where("user_id = ? AND task_id = ?", userID, taskID).
		Where(playgroundTaskOriginCondition()).
		First(&task).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlaygroundTaskNotFound
		}
		return nil, err
	}
	if task.Status == TaskStatusFailure || task.Status == TaskStatusSuccess {
		return nil, ErrPlaygroundTaskNotCancelable
	}

	oldStatus := task.Status
	task.Status = TaskStatusFailure
	task.Progress = "100%"
	task.FinishTime = common.GetTimestamp()
	task.FailReason = PlaygroundTaskCanceledReason
	won, err := task.UpdateWithStatus(oldStatus)
	if err != nil {
		return nil, err
	}
	if !won {
		return nil, ErrPlaygroundTaskNotCancelable
	}
	return &task, nil
}
