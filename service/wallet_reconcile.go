package service

import (
	"context"
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
)

const (
	// walletReconcileEvery is the daily cadence of the wallet ledger check.
	walletReconcileEvery = 24 * time.Hour
	// walletReconcileDeviationLimit caps how many deviating users a run lists.
	walletReconcileDeviationLimit = 50
)

// walletReconcileHandler compares every wallet balance with the sum of its
// append-only ledger. It never modifies a balance: deviating users are reported
// through the system task result, the server log, and a root-user notification.
type walletReconcileHandler struct{}

func (walletReconcileHandler) Type() string { return model.SystemTaskTypeWalletReconcile }

func (walletReconcileHandler) Enabled() bool { return true }

func (walletReconcileHandler) Interval() time.Duration { return walletReconcileEvery }

func (walletReconcileHandler) NewPayload() any { return nil }

func (walletReconcileHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	report, err := model.ReconcileWalletLedgers(walletReconcileDeviationLimit)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if report.DeviationCount > 0 {
		common.SysError(common.LogText("wallet ledger reconciliation found %d deviating users", report.DeviationCount))
		model.RecordLog(0, model.LogTypeSystem, common.NewMessage("Wallet ledger reconciliation found {{count}} deviating users; see the wallet_reconcile system task result", map[string]any{"count": report.DeviationCount}))
		NotifyRootUser(
			dto.NotifyTypeChannelUpdate,
			"Wallet ledger reconciliation found deviations",
			fmt.Sprintf("%d user wallets differ from their ledger sum. Review the wallet_reconcile system task result; balances were not modified.", report.DeviationCount),
		)
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, report, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(walletReconcileHandler{})
}
