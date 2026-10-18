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
	"github.com/QuantumNous/new-api/setting/playground_setting"
)

const (
	// playgroundStorageSampleEvery is the hourly cadence of the peak-footprint
	// sampling. Hourly is dense enough that a short-lived upload still lands in
	// the day's peak while keeping the write load at one row per account.
	playgroundStorageSampleEvery = time.Hour
	// playgroundStorageSettleEvery is the hourly cadence of the daily
	// settlement. A day becomes settleable right after midnight; the hourly
	// pass bounds how late its charge can be recorded.
	playgroundStorageSettleEvery = time.Hour
	// playgroundStorageSettleBatchLimit bounds how many finished days one
	// settlement pass commits, so a large backlog drains over several passes
	// instead of one long transaction chain.
	playgroundStorageSettleBatchLimit = 200
)

// playgroundStorageSampleHandler folds every account's stored bytes into
// today's metered-storage ledger row as a running peak. It is a scheduled
// handler that only runs while the optional storage billing tier is enabled,
// and the run itself is a no-op when no account stores Playground bytes.
type playgroundStorageSampleHandler struct{}

func (playgroundStorageSampleHandler) Type() string {
	return model.SystemTaskTypePlaygroundStorageSample
}

func (playgroundStorageSampleHandler) Enabled() bool {
	return playground_setting.GetPlaygroundStorageBillingSetting().IsEnabled()
}

func (playgroundStorageSampleHandler) Interval() time.Duration {
	return playgroundStorageSampleEvery
}

func (playgroundStorageSampleHandler) NewPayload() any { return nil }

func (playgroundStorageSampleHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	sampled, err := model.SamplePlaygroundStoragePeaks(common.GetTimestamp())
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	report := map[string]any{"sampled_accounts": sampled, "checked_at": common.GetTimestamp()}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, report, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

// playgroundStorageSettleHandler charges every finished storage day to the
// wallet exactly once: the covered part leaves the wallet, the rest becomes
// wallet debt that locks the account read-only until it is paid. Stored data
// is never deleted, and an unpaid account recovers automatically when its
// wallet is recharged.
type playgroundStorageSettleHandler struct{}

func (playgroundStorageSettleHandler) Type() string {
	return model.SystemTaskTypePlaygroundStorageSettle
}

func (playgroundStorageSettleHandler) Enabled() bool {
	return playground_setting.GetPlaygroundStorageBillingSetting().IsEnabled()
}

func (playgroundStorageSettleHandler) Interval() time.Duration {
	return playgroundStorageSettleEvery
}

func (playgroundStorageSettleHandler) NewPayload() any { return nil }

func (playgroundStorageSettleHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	report, err := model.SettlePlaygroundStorageLedgers(common.GetTimestamp(), playgroundStorageSettleBatchLimit)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if report.GraceCount > 0 {
		common.SysError(common.LogText("playground storage settlement left %d accounts read-only with %d quota uncovered", report.GraceCount, report.GraceQuota))
		model.RecordLog(0, model.LogTypeSystem, common.NewMessage("Playground storage settlement left {{count}} accounts read-only with {{quota}} quota uncovered; see the playground_storage_settle system task result", map[string]any{"count": report.GraceCount, "quota": report.GraceQuota}))
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, report, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(playgroundStorageSampleHandler{})
	RegisterSystemTaskHandler(playgroundStorageSettleHandler{})
}
