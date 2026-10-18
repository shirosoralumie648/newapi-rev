/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
package service

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

const (
	// referralCommissionSettlementEvery is how often the sweep locks and
	// issues referral commissions. Commissions wait out a window of at least
	// two weeks, so an hourly pass keeps the delay after the window small
	// without polling the event table hard.
	referralCommissionSettlementEvery = time.Hour
	// referralCommissionSettlementBatch caps how many commissions one pass
	// locks and how many it issues.
	referralCommissionSettlementBatch = 200
)

// referralCommissionSettlementHandler locks recorded referral commissions
// whose refund window elapsed and issues the locked ones to the inviter. One
// commission is one transaction: the lock and settle state, the credit grant
// and its wallet ledger entry commit together, and a partially failed pass
// simply retries on the next run. Cash settlement, when the administrator
// enabled it and the payment compliance terms are confirmed, records the
// commission as payable instead of crediting the wallet.
type referralCommissionSettlementHandler struct{}

func (referralCommissionSettlementHandler) Type() string {
	return model.SystemTaskTypeReferralCommissionSettlement
}

func (referralCommissionSettlementHandler) Enabled() bool { return true }

func (referralCommissionSettlementHandler) Interval() time.Duration {
	return referralCommissionSettlementEvery
}

func (referralCommissionSettlementHandler) NewPayload() any { return nil }

func (referralCommissionSettlementHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	now := common.GetTimestamp()
	result, err := model.ProcessReferralCommissionSettlement(now, referralCommissionSettlementBatch)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if result.LockedCount > 0 || result.SettledCount > 0 || result.FailedCount > 0 {
		common.SysLog(common.LogText("referral commission settlement locked %d and settled %d commissions (%d failed, %d quota credited, %d quota cash)", result.LockedCount, result.SettledCount, result.FailedCount, result.CreditedQuota, result.CashQuota))
	}
	payload := map[string]any{
		"locked_count":   result.LockedCount,
		"scanned_count":  result.ScannedCount,
		"settled_count":  result.SettledCount,
		"failed_count":   result.FailedCount,
		"settled_quota":  result.SettledQuota,
		"credited_quota": result.CreditedQuota,
		"cash_quota":     result.CashQuota,
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, payload, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(referralCommissionSettlementHandler{})
}
