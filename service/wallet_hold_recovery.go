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
	// walletHoldRetention keeps closed holds for reconciliation and support
	// lookups before the sweep prunes them.
	walletHoldRetention = 7 * 24 * time.Hour
	// walletHoldCleanupBatch caps how many closed holds one sweep prunes.
	walletHoldCleanupBatch = 500
)

// walletHoldRecoveryHandler refunds wallet holds left active by a stopped or
// crashed process and prunes holds that were closed long ago. The refund moves
// quota with the wallet ledger in one transaction, so a partially failed sweep
// can simply be retried on the next pass.
type walletHoldRecoveryHandler struct{}

func (walletHoldRecoveryHandler) Type() string { return model.SystemTaskTypeWalletHoldRecovery }

func (walletHoldRecoveryHandler) Enabled() bool { return true }

func (walletHoldRecoveryHandler) Interval() time.Duration { return walletHoldRecoveryEvery }

func (walletHoldRecoveryHandler) NewPayload() any { return nil }

func (walletHoldRecoveryHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	now := common.GetTimestamp()
	expired, err := model.RefundExpiredWalletHolds(now, walletHoldRecoveryBatch)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if expired.ExpiredCount > 0 || expired.FailedCount > 0 {
		common.SysLog(common.LogText("wallet hold recovery refunded %d expired holds (%d failed)", expired.ExpiredCount, expired.FailedCount))
	}
	cleaned, cleanupErr := model.CleanupClosedWalletHolds(now-int64(walletHoldRetention.Seconds()), walletHoldCleanupBatch)
	if cleanupErr != nil {
		common.SysError(common.LogText("failed to prune closed wallet holds: %s", cleanupErr.Error()))
	}
	result := map[string]any{
		"scanned_count":  expired.ScannedCount,
		"expired_count":  expired.ExpiredCount,
		"failed_count":   expired.FailedCount,
		"refunded_quota": expired.RefundedQuota,
		"cleaned_count":  cleaned,
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, result, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(walletHoldRecoveryHandler{})
}
