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
	// playgroundAttachmentOrphanTTL bounds how long an unreferenced attachment
	// survives before the scheduled cleanup deletes it.
	playgroundAttachmentOrphanTTL    = 48 * time.Hour
	playgroundAttachmentCleanupEvery = 6 * time.Hour
	playgroundAttachmentCleanupBatch = 200

	// playgroundAttachmentMigrateEvery and playgroundAttachmentMigrateRows
	// bound how often and how much the background migration moves from the
	// database into the object store per run.
	playgroundAttachmentMigrateEvery = 15 * time.Minute
	playgroundAttachmentMigrateRows  = 200
)

// playgroundAttachmentCleanupHandler deletes attachments no conversation
// message references anymore after the orphan TTL has passed, together with
// their stored objects.
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

// playgroundAttachmentMigrateHandler moves attachment bytes that still live in
// the database into the configured object store. Every row is verified against
// its content hash before the database switches to the object key, and failed
// rows keep their database bytes for the next run.
type playgroundAttachmentMigrateHandler struct{}

func (playgroundAttachmentMigrateHandler) Type() string {
	return model.SystemTaskTypePlaygroundAttachmentMigrate
}

func (playgroundAttachmentMigrateHandler) Enabled() bool { return true }

func (playgroundAttachmentMigrateHandler) Interval() time.Duration {
	return playgroundAttachmentMigrateEvery
}

func (playgroundAttachmentMigrateHandler) NewPayload() any { return nil }

func (playgroundAttachmentMigrateHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	store := objectstore.DefaultStore()
	if store == nil {
		failSystemTask(task, runnerID, errors.New("object store is not configured"))
		return
	}
	result, err := model.MigratePlaygroundAttachmentsToObjectStore(store, playgroundAttachmentMigrateRows)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, map[string]any{
		"moved_count": result.Moved, "failed_count": result.Failed,
	}, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(playgroundAttachmentCleanupHandler{})
	RegisterSystemTaskHandler(playgroundAttachmentMigrateHandler{})
}
