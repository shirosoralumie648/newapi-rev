package service

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	// playgroundAttachmentOrphanTTL bounds how long an unreferenced attachment
	// survives before the scheduled cleanup deletes it.
	playgroundAttachmentOrphanTTL    = 48 * time.Hour
	playgroundAttachmentCleanupEvery = 6 * time.Hour
	playgroundAttachmentCleanupBatch = 200
)

// playgroundAttachmentCleanupHandler deletes attachments no conversation
// message references anymore after the orphan TTL has passed.
type playgroundAttachmentCleanupHandler struct{}

func (playgroundAttachmentCleanupHandler) Type() string {
	return model.SystemTaskTypePlaygroundAttachmentCleanup
}

func (playgroundAttachmentCleanupHandler) Enabled() bool { return true }

func (playgroundAttachmentCleanupHandler) Interval() time.Duration {
	return playgroundAttachmentCleanupEvery
}

func (playgroundAttachmentCleanupHandler) NewPayload() any { return nil }

func (playgroundAttachmentCleanupHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	cutoff := common.GetTimestamp() - int64(playgroundAttachmentOrphanTTL.Seconds())
	deleted, err := model.DeleteOrphanedPlaygroundAttachments(cutoff, playgroundAttachmentCleanupBatch)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, map[string]any{"deleted_count": deleted}, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(playgroundAttachmentCleanupHandler{})
}
