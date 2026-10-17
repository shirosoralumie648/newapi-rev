package service

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	// walletHoldRecoveryEvery is how often the sweep looks for reservations
	// whose lifetime elapsed without a settlement or refund.
	walletHoldRecoveryEvery = 10 * time.Minute
	// walletHoldRecoveryBatch caps how many expired holds one sweep refunds.
	walletHoldRecoveryBatch = 200
)

// walletHoldRecoveryHandler refunds wallet holds left active by a stopped or
// crashed process. The refund moves quota with the wallet ledger in one
// transaction, so a partially failed sweep can simply be retried.
type walletHoldRecoveryHandler struct{}

func (walletHoldRecoveryHandler) Type() string { return model.SystemTaskTypeWalletHoldRecovery }

func (walletHoldRecoveryHandler) Enabled() bool { return true }

func (walletHoldRecoveryHandler) Interval() time.Duration { return walletHoldRecoveryEvery }

func (walletHoldRecoveryHandler) NewPayload() any { return nil }

func (walletHoldRecoveryHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	result, err := model.RefundExpiredWalletHolds(common.GetTimestamp(), walletHoldRecoveryBatch)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if result.ExpiredCount > 0 || result.FailedCount > 0 {
		common.SysLog(common.LogText("wallet hold recovery refunded %d expired holds (%d failed)", result.ExpiredCount, result.FailedCount))
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, result, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(walletHoldRecoveryHandler{})
}
