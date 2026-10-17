package service

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	// playgroundTaskCleanupEvery and playgroundTaskCleanupBatch bound the
	// scheduled cleanup of finished workspace tasks and their stored results.
	playgroundTaskCleanupEvery = 6 * time.Hour
	playgroundTaskCleanupBatch = 200
	// playgroundTaskArtifactCleanupBatch bounds how many expired stored
	// results one run collects.
	playgroundTaskArtifactCleanupBatch = 200
)

// playgroundTaskCleanupHandler deletes terminal Playground-origin tasks whose
// results have outlived the configured retention window, freeing the account
// result storage budget. The stored artifact bytes are collected first, and
// tasks (or artifacts) still pinned by the asset library or a canvas are
// never touched. Direct-API tasks are never touched.
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
	_, _ = DeleteExpiredTaskArtifactObjects(ctx, playgroundTaskArtifactCleanupBatch)

	cutoff := common.GetTimestamp() - int64(TaskArtifactRetention().Seconds())
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
