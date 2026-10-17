package service

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	// playgroundTaskResultTTL is how long a finished Playground task keeps its
	// durable row and retained result snapshot after reaching a terminal state.
	playgroundTaskResultTTL    = 7 * 24 * time.Hour
	playgroundTaskCleanupEvery = 6 * time.Hour
	playgroundTaskCleanupBatch = 200
)

// playgroundTaskCleanupHandler deletes terminal Playground-origin tasks whose
// results have outlived the retention window, freeing the account result
// storage budget. Direct-API tasks are never touched.
type playgroundTaskCleanupHandler struct{}

func (playgroundTaskCleanupHandler) Type() string {
	return model.SystemTaskTypePlaygroundTaskCleanup
}

func (playgroundTaskCleanupHandler) Enabled() bool { return true }

func (playgroundTaskCleanupHandler) Interval() time.Duration {
	return playgroundTaskCleanupEvery
}

func (playgroundTaskCleanupHandler) NewPayload() any { return nil }

func (playgroundTaskCleanupHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	cutoff := common.GetTimestamp() - int64(playgroundTaskResultTTL.Seconds())
	deleted, err := model.DeleteExpiredPlaygroundTasks(cutoff, playgroundTaskCleanupBatch)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, map[string]any{"deleted_count": deleted}, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(playgroundTaskCleanupHandler{})
}
