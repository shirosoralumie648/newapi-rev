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
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
)

const (
	// legacyReferralReconcileEvery is the daily cadence of the legacy import
	// audit.
	legacyReferralReconcileEvery = 24 * time.Hour
	// legacyReferralReconcileAnomalyLimit caps how many deviating accounts a
	// run lists.
	legacyReferralReconcileAnomalyLimit = 50
)

// legacyReferralReconcileHandler audits the imported legacy referral data:
// bindings backfilled from users.inviter_id, affiliate balances moved into the
// wallet, and the credit grants created with them. It never modifies a balance;
// anomalies are reported through the system task result, the server log, and a
// root-user notification.
type legacyReferralReconcileHandler struct{}

func (legacyReferralReconcileHandler) Type() string {
	return model.SystemTaskTypeLegacyReferralReconcile
}

func (legacyReferralReconcileHandler) Enabled() bool { return true }

func (legacyReferralReconcileHandler) Interval() time.Duration { return legacyReferralReconcileEvery }

func (legacyReferralReconcileHandler) NewPayload() any { return nil }

func (legacyReferralReconcileHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	report, err := model.ReconcileLegacyReferralData(legacyReferralReconcileAnomalyLimit)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if report.AnomalyCount > 0 {
		common.SysError(common.LogText("legacy referral reconciliation found %d deviating accounts", report.AnomalyCount))
		model.RecordLog(0, model.LogTypeSystem, common.NewMessage("Legacy referral reconciliation found {{count}} deviating accounts; see the legacy_referral_reconcile system task result", map[string]any{"count": report.AnomalyCount}))
		notifyAdmins(dto.NotifyTypeChannelUpdate, func(role int, _ dto.UserSetting) bool {
			return role == common.RoleRootUser
		}, func(string) (string, string) {
			return "Legacy referral reconciliation found deviations",
				fmt.Sprintf("%d accounts deviate from the imported referral relation or affiliate balance. Review the legacy_referral_reconcile system task result; balances were not modified.", report.AnomalyCount)
		})
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, report, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(legacyReferralReconcileHandler{})
}
