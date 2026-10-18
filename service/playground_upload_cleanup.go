package service

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	// playgroundUploadCleanupEvery bounds how long a reservation survives
	// after its upload window passed; the batch keeps one run small.
	playgroundUploadCleanupEvery = 15 * time.Minute
	playgroundUploadCleanupBatch = 200
)

// playgroundUploadCleanupHandler releases presigned upload reservations whose
// upload window elapsed without a completion, together with any bytes the
// client already wrote. Releasing the row returns its reserved quota to the
// account, so an abandoned upload never blocks the per-account budgets until
// an operator notices.
type playgroundUploadCleanupHandler struct{}

func (playgroundUploadCleanupHandler) Type() string {
	return model.SystemTaskTypePlaygroundUploadCleanup
}

func (playgroundUploadCleanupHandler) Enabled() bool { return true }

func (playgroundUploadCleanupHandler) Interval() time.Duration {
	return playgroundUploadCleanupEvery
}

func (playgroundUploadCleanupHandler) NewPayload() any { return nil }

func (playgroundUploadCleanupHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	released, err := model.DeleteExpiredPlaygroundUploads(common.GetTimestamp(), playgroundUploadCleanupBatch)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, map[string]any{"released_count": released}, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(playgroundUploadCleanupHandler{})
}
