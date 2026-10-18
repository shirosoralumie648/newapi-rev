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
	// playgroundObjectReconcileEvery is the weekly cadence of the stored-object
	// comparison.
	playgroundObjectReconcileEvery = 7 * 24 * time.Hour
	// playgroundObjectReconcileGrace protects objects whose database row could
	// have been deleted recently; only objects older than the window count as
	// orphans.
	playgroundObjectReconcileGrace = 24 * time.Hour
	// playgroundObjectReconcileBatch bounds how many aged orphans one run
	// removes; the rest wait for the next run.
	playgroundObjectReconcileBatch = 200
)

// playgroundObjectReconcileHandler lists the objects stored below the
// Playground key space and compares them with the database rows that own them.
// Every run records the dry-run report — what was listed, owned, already queued
// and found orphaned, with a bounded sample — and then removes only orphans
// older than the grace window, at most the batch bound, so a wrong result is
// visible in the task record while a single run can never wipe the key space.
type playgroundObjectReconcileHandler struct{}

func (playgroundObjectReconcileHandler) Type() string {
	return model.SystemTaskTypePlaygroundObjectReconcile
}

func (playgroundObjectReconcileHandler) Enabled() bool {
	return objectstore.DefaultStore() != nil
}

func (playgroundObjectReconcileHandler) Interval() time.Duration {
	return playgroundObjectReconcileEvery
}

func (playgroundObjectReconcileHandler) NewPayload() any { return nil }

func (playgroundObjectReconcileHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	store := objectstore.DefaultStore()
	if store == nil {
		failSystemTask(task, runnerID, errors.New("object store is not configured"))
		return
	}
	report, err := model.ReconcilePlaygroundObjects(ctx, store, model.PlaygroundObjectReconcileOptions{
		GraceSeconds: int64(playgroundObjectReconcileGrace.Seconds()),
		DeleteBatch:  playgroundObjectReconcileBatch,
	})
	if err != nil {
		// A backend that cannot list objects cannot run the comparison; the
		// task records that fact instead of failing on every schedule.
		if errors.Is(err, model.ErrPlaygroundObjectReconcileUnsupported) {
			if finishErr := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, map[string]any{
				"supported": false, "reason": err.Error(),
			}, ""); finishErr != nil {
				logSystemTaskLockError(ctx, task, finishErr)
			}
			return
		}
		failSystemTask(task, runnerID, err)
		return
	}
	if report.DeletedCount > 0 {
		common.SysError(common.LogText("playground object reconciliation removed %d orphaned objects", report.DeletedCount))
		model.RecordLog(0, model.LogTypeSystem, common.NewMessage("Playground object reconciliation removed {{count}} orphaned objects; see the playground_object_reconcile system task result", map[string]any{"count": report.DeletedCount}))
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, report, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(playgroundObjectReconcileHandler{})
}
