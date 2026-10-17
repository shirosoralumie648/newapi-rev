package service

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	// playgroundUsageReconcileEvery is the daily cadence of the Playground
	// resource counter check.
	playgroundUsageReconcileEvery = 24 * time.Hour
	// playgroundUsageReconcileReportLimit caps how many repaired accounts one
	// run lists in its report.
	playgroundUsageReconcileReportLimit = 50
)

// playgroundUsageReconcileHandler recomputes the account counters of the
// Playground workspace and repairs the rows that drifted. The counters are
// derived state, so a repair only rewrites the numbers; it never touches,
// deletes or moves a stored resource, and the next write keeps enforcing the
// repaired budget.
type playgroundUsageReconcileHandler struct{}

func (playgroundUsageReconcileHandler) Type() string {
	return model.SystemTaskTypePlaygroundUsageReconcile
}

func (playgroundUsageReconcileHandler) Enabled() bool { return true }

func (playgroundUsageReconcileHandler) Interval() time.Duration {
	return playgroundUsageReconcileEvery
}

func (playgroundUsageReconcileHandler) NewPayload() any { return nil }

func (playgroundUsageReconcileHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	report, err := model.ReconcilePlaygroundUserUsage(playgroundUsageReconcileReportLimit)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if report.RepairedCount > 0 {
		common.SysError(common.LogText("playground usage reconciliation repaired %d accounts", report.RepairedCount))
		model.RecordLog(0, model.LogTypeSystem, common.NewMessage("Playground usage reconciliation repaired {{count}} accounts; see the playground_usage_reconcile system task result", map[string]any{"count": report.RepairedCount}))
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, report, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(playgroundUsageReconcileHandler{})
}
