package service

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	// creditGrantExpiryEvery is how often the sweep voids credit grants whose
	// validity elapsed. It runs often so a user's spendable balance matches the
	// buckets shown on the wallet page: an expired remainder is no longer
	// spendable even before the sweep runs, but only the sweep writes it off.
	creditGrantExpiryEvery = 5 * time.Minute
	// creditGrantExpiryBatch caps how many grants one sweep voids.
	creditGrantExpiryBatch = 200
)

// creditGrantExpiryHandler voids the unspent remainder of expired credit
// grants (sign-in, invitation, redemption, promotion, gift and administrator
// credits). One grant is one transaction: the balance reduction and its wallet
// ledger entry commit together, the deduction never takes the balance below
// zero, and a partially failed sweep simply retries on the next pass.
type creditGrantExpiryHandler struct{}

func (creditGrantExpiryHandler) Type() string { return model.SystemTaskTypeCreditGrantExpiry }

func (creditGrantExpiryHandler) Enabled() bool { return true }

func (creditGrantExpiryHandler) Interval() time.Duration { return creditGrantExpiryEvery }

func (creditGrantExpiryHandler) NewPayload() any { return nil }

func (creditGrantExpiryHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	now := common.GetTimestamp()
	result, err := model.VoidExpiredCreditGrants(now, creditGrantExpiryBatch)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if result.VoidedCount > 0 || result.FailedCount > 0 {
		common.SysLog(common.LogText("credit grant expiry voided %d grants (%d failed, %d quota)", result.VoidedCount, result.FailedCount, result.VoidedQuota))
	}
	payload := map[string]any{
		"scanned_count":  result.ScannedCount,
		"voided_count":   result.VoidedCount,
		"failed_count":   result.FailedCount,
		"voided_quota":   result.VoidedQuota,
		"deducted_quota": result.DeductedQuota,
		"clamped_count":  result.ClampedCount,
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, payload, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(creditGrantExpiryHandler{})
}
