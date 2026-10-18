package service

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	// playgroundTrashCleanupEvery and playgroundTrashCleanupBatch bound the
	// scheduled purge of trashed conversations and canvases. The sweep runs
	// several times a day so an entry never outlives its recovery window by
	// much, while the batch keeps one run bounded.
	playgroundTrashCleanupEvery = 6 * time.Hour
	playgroundTrashCleanupBatch = 200
)

// playgroundTrashCleanupHandler permanently removes the conversations and
// canvases whose configured trash retention window elapsed, releasing their
// rows and bytes back to the account budgets. The model layer re-checks the
// owner's policy under a row lock, so a policy raised between the sweep and
// the lock keeps the entry instead of purging it early.
type playgroundTrashCleanupHandler struct{}

func (playgroundTrashCleanupHandler) Type() string {
	return model.SystemTaskTypePlaygroundTrashCleanup
}

func (playgroundTrashCleanupHandler) Enabled() bool { return true }

func (playgroundTrashCleanupHandler) Interval() time.Duration {
	return playgroundTrashCleanupEvery
}

func (playgroundTrashCleanupHandler) NewPayload() any { return nil }

func (playgroundTrashCleanupHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	result, err := model.PurgeExpiredPlaygroundTrash(playgroundTrashCleanupBatch)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if result.Sessions > 0 || result.Canvases > 0 {
		common.SysLog(common.LogText("playground trash cleanup purged %d conversations and %d canvases", result.Sessions, result.Canvases))
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, result, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(playgroundTrashCleanupHandler{})
}
