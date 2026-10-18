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
package service

import (
	"context"
	"errors"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service/objectstore"
)

const (
	// playgroundObjectOutboxEvery is the retry cadence of the object delete
	// outbox. The handler only schedules a run while a queued deletion exists.
	playgroundObjectOutboxEvery = 15 * time.Minute
	// playgroundObjectOutboxBatch bounds how many queued deletions one run
	// attempts.
	playgroundObjectOutboxBatch = 200
)

// playgroundObjectOutboxHandler retries deleting stored objects whose owning
// database row is gone. The queue entry is written in the same transaction as
// the row deletion, and the request path clears entries whose object it already
// deleted, so this handler only ever sees failures, crashes between the commit
// and the store call, and deletions queued while no store was configured.
type playgroundObjectOutboxHandler struct{}

func (playgroundObjectOutboxHandler) Type() string {
	return model.SystemTaskTypePlaygroundObjectOutbox
}

func (playgroundObjectOutboxHandler) Enabled() bool {
	pending, err := model.CountPendingPlaygroundObjectDeletes()
	return err == nil && pending > 0
}

func (playgroundObjectOutboxHandler) Interval() time.Duration {
	return playgroundObjectOutboxEvery
}

func (playgroundObjectOutboxHandler) NewPayload() any { return nil }

func (playgroundObjectOutboxHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	store := objectstore.DefaultStore()
	if store == nil {
		failSystemTask(task, runnerID, errors.New("object store is not configured"))
		return
	}
	result, err := model.ProcessPlaygroundObjectDeleteOutbox(ctx, store, playgroundObjectOutboxBatch)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if result.Failed > 0 {
		common.SysError(common.LogText("retried Playground object deletes failed: %d of %d", result.Failed, result.Attempted))
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, result, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(playgroundObjectOutboxHandler{})
}
