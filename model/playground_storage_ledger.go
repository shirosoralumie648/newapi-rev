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
package model

import (
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"

	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Optional metered storage billing (plan section 9.3, BL-02).
//
// One row per account and day records the account's peak stored bytes, the
// free allowance applied, the served attachment egress and the settled charge.
// The day's charge leaves the same wallet the relay consumes from and is
// recorded in the unified wallet ledger (kind=storage_daily), so this table is
// only the daily detail and never a second ledger. While a charge stays
// uncovered the account is read-only through the shared wallet debt lock and
// recovers automatically on recharge; stored data is never deleted.

// Ledger row states. A row starts pending while its day accrues, then becomes
// settled (nothing left unpaid) or grace (part of the charge became wallet
// debt, so the account is read-only until the wallet covers it).
const (
	PlaygroundStorageLedgerStatusPending = "pending"
	PlaygroundStorageLedgerStatusSettled = "settled"
	PlaygroundStorageLedgerStatusGrace   = "grace"
)

const (
	// playgroundStorageSettlementDaysPerMonth prices one GB-day at a
	// thirtieth of the configured monthly GB price, the plan's GB-day rule.
	playgroundStorageSettlementDaysPerMonth = 30
	// playgroundStorageLedgerDateLayout is the day key of the ledger. The day
	// boundary follows the server clock, like every other daily task.
	playgroundStorageLedgerDateLayout = "2006-01-02"
)

// PlaygroundStorageBillingModelName labels the consume-log row the daily
// settlement writes, so the wallet movement is visible in the ordinary usage
// log next to relay consumption.
const PlaygroundStorageBillingModelName = "playground_storage"

// ErrPlaygroundEgressLimitExceeded reports that one download would cross the
// account's daily egress budget. The transfer is refused before a byte is
// served; the stored data stays untouched.
var ErrPlaygroundEgressLimitExceeded = errors.New("playground egress limit exceeded")

// PlaygroundStorageLedger is one account's storage billing day.
type PlaygroundStorageLedger struct {
	Id     int `json:"id" gorm:"primaryKey;autoIncrement"`
	UserId int `json:"user_id" gorm:"not null;uniqueIndex:idx_playground_storage_ledger_user_date,priority:1;index"`
	// Date is the UTC-offset free server day (YYYY-MM-DD). The unique
	// (user_id, date) index makes sampling, egress accounting and settlement
	// idempotent: every writer converges on the same row.
	Date string `json:"date" gorm:"type:varchar(10);not null;uniqueIndex:idx_playground_storage_ledger_user_date,priority:2"`
	// PeakBytes is the highest measured footprint of the day. The peak is the
	// billable quantity: a resource kept for a moment still occupies the
	// bytes it wrote.
	PeakBytes int64 `json:"peak_bytes" gorm:"not null"`
	// FreeBytes is the free allowance applied at settlement, copied from the
	// owner's group policy so the row explains its own arithmetic.
	FreeBytes     int64 `json:"free_bytes" gorm:"not null"`
	BillableBytes int64 `json:"billable_bytes" gorm:"not null"`
	// EgressBytes and EgressRequests are the served attachment downloads of
	// the day, accumulated transactionally by the content route.
	EgressBytes    int64 `json:"egress_bytes" gorm:"not null"`
	EgressRequests int64 `json:"egress_requests" gorm:"not null"`
	// Quota is the part of the day's charge that left the wallet, DebtQuota
	// the uncovered part recorded as wallet debt, and EgressQuota the egress
	// share of the charge when egress is metered.
	Quota       int64  `json:"quota" gorm:"not null"`
	DebtQuota   int64  `json:"debt_quota" gorm:"not null"`
	EgressQuota int64  `json:"egress_quota" gorm:"not null"`
	Status      string `json:"status" gorm:"type:varchar(16);not null;index"`
	// GraceUntil is the payment deadline of an unpaid day, so the user and
	// the administrator can see how long the read-only grace has lasted.
	GraceUntil int64 `json:"grace_until" gorm:"bigint;not null"`
	SettledAt  int64 `json:"settled_at" gorm:"bigint;not null"`
	CreatedAt  int64 `json:"created_at" gorm:"bigint;not null"`
	UpdatedAt  int64 `json:"updated_at" gorm:"bigint;not null"`
}

func (PlaygroundStorageLedger) TableName() string {
	return "playground_storage_ledger"
}

// playgroundStorageLedgerDate returns the ledger day of one timestamp.
func playgroundStorageLedgerDate(timestamp int64) string {
	return time.Unix(timestamp, 0).Format(playgroundStorageLedgerDateLayout)
}

// lockPlaygroundStorageLedgerTx locks (or creates) the account's row for one
// day. The insert is idempotent, so concurrent sampling, egress accounting and
// settlement of the same account always converge on one row.
func lockPlaygroundStorageLedgerTx(tx *gorm.DB, userID int, date string) (*PlaygroundStorageLedger, error) {
	var row PlaygroundStorageLedger
	err := lockForUpdate(tx).Where("user_id = ? AND date = ?", userID, date).First(&row).Error
	if err == nil {
		return &row, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	now := common.GetTimestamp()
	fresh := PlaygroundStorageLedger{
		UserId:    userID,
		Date:      date,
		Status:    PlaygroundStorageLedgerStatusPending,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&fresh).Error; err != nil {
		return nil, err
	}
	if err := lockForUpdate(tx).Where("user_id = ? AND date = ?", userID, date).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// PlaygroundStorageBillableFootprint reports the stored bytes the metered
// storage bill weighs for one account: every stored attachment byte (database
// backed legacy rows included), artifact version bytes, canvas document bytes,
// canvas snapshot bytes and the retained async-task results. ObjectBytes is
// deliberately not added: it is a subset of AttachmentBytes and would double
// count object-store attachments.
func PlaygroundStorageBillableFootprint(userID int) (int64, error) {
	if userID <= 0 {
		return 0, nil
	}
	counters, err := readPlaygroundUserUsage(userID)
	if err != nil {
		return 0, err
	}
	taskBytes, err := PlaygroundTaskResultStorageBytes(userID)
	if err != nil {
		return 0, err
	}
	total := int64(0)
	for _, part := range []int64{counters.AttachmentBytes, counters.ArtifactBytes, counters.CanvasBytes, counters.CanvasSnapshotBytes, taskBytes} {
		next, err := addWalletQuotaChecked(total, part, "playground storage footprint")
		if err != nil {
			return 0, err
		}
		total = next
	}
	return total, nil
}

// playgroundStorageSamplingCandidates lists the accounts whose stored bytes
// the sampler must weigh: every Playground workspace owner plus every account
// with a Playground-origin async task (their retained task results count even
// when the workspace tables are empty).
func playgroundStorageSamplingCandidates(db *gorm.DB) ([]int, error) {
	owners, err := playgroundUsageOwnerIDs(db)
	if err != nil {
		return nil, err
	}
	seen := make(map[int]struct{}, len(owners))
	for _, id := range owners {
		if id > 0 {
			seen[id] = struct{}{}
		}
	}
	var taskOwners []int
	if err := db.Model(&Task{}).Where(playgroundTaskOriginCondition()).Distinct("user_id").Pluck("user_id", &taskOwners).Error; err != nil {
		return nil, err
	}
	for _, id := range taskOwners {
		if id > 0 {
			seen[id] = struct{}{}
		}
	}
	merged := make([]int, 0, len(seen))
	for id := range seen {
		merged = append(merged, id)
	}
	slices.Sort(merged)
	return merged, nil
}

// SamplePlaygroundStoragePeak folds the account's current footprint into
// today's ledger row as a running peak. It writes nothing while the optional
// storage billing tier is disabled, and a footprint that never exceeds the
// previous peak leaves the row untouched.
func SamplePlaygroundStoragePeak(userID int, timestamp int64) error {
	if userID <= 0 {
		return nil
	}
	footprint, err := PlaygroundStorageBillableFootprint(userID)
	if err != nil {
		return err
	}
	date := playgroundStorageLedgerDate(timestamp)
	return DB.Transaction(func(tx *gorm.DB) error {
		row, err := lockPlaygroundStorageLedgerTx(tx, userID, date)
		if err != nil {
			return err
		}
		if footprint <= row.PeakBytes {
			return nil
		}
		return tx.Model(&PlaygroundStorageLedger{}).Where("id = ?", row.Id).Updates(map[string]any{
			"peak_bytes": footprint,
			"updated_at": common.GetTimestamp(),
		}).Error
	})
}

// SamplePlaygroundStoragePeaks samples every account that stores Playground
// bytes. It is the scheduled half of the metered tier; the number of sampled
// accounts feeds the task result.
func SamplePlaygroundStoragePeaks(timestamp int64) (int, error) {
	billing := playground_setting.GetPlaygroundStorageBillingSetting()
	if !billing.IsEnabled() {
		return 0, nil
	}
	candidates, err := playgroundStorageSamplingCandidates(DB)
	if err != nil {
		return 0, err
	}
	sampled := 0
	for _, userID := range candidates {
		if err := SamplePlaygroundStoragePeak(userID, timestamp); err != nil {
			return sampled, err
		}
		sampled++
	}
	return sampled, nil
}

// ReservePlaygroundEgress accounts one served attachment download against the
// account's day. It accumulates the bytes so a metered egress can be charged at
// settlement, and it refuses the transfer with ErrPlaygroundEgressLimitExceeded
// when the daily byte or request ceiling would be crossed. The stored object is
// never touched by a refusal.
func ReservePlaygroundEgress(userID int, byteSize int64, requestCount int64) error {
	if userID <= 0 || (byteSize <= 0 && requestCount <= 0) {
		return nil
	}
	billing := playground_setting.GetPlaygroundStorageBillingSetting()
	if !billing.IsEnabled() {
		return nil
	}
	group, err := GetUserGroup(userID, false)
	if err != nil {
		return err
	}
	bytesLimit, requestsLimit := billing.EgressDailyLimits(group)
	date := playgroundStorageLedgerDate(common.GetTimestamp())
	return DB.Transaction(func(tx *gorm.DB) error {
		row, err := lockPlaygroundStorageLedgerTx(tx, userID, date)
		if err != nil {
			return err
		}
		nextBytes := row.EgressBytes + max(byteSize, 0)
		if nextBytes < row.EgressBytes {
			common.SysError(common.LogText("playground egress byte counter overflow: user=%d date=%s", userID, date))
			return ErrPlaygroundEgressLimitExceeded
		}
		nextRequests := row.EgressRequests + max(requestCount, 0)
		if nextRequests < row.EgressRequests {
			common.SysError(common.LogText("playground egress request counter overflow: user=%d date=%s", userID, date))
			return ErrPlaygroundEgressLimitExceeded
		}
		if bytesLimit > 0 && nextBytes > bytesLimit {
			return ErrPlaygroundEgressLimitExceeded
		}
		if requestsLimit > 0 && nextRequests > requestsLimit {
			return ErrPlaygroundEgressLimitExceeded
		}
		return tx.Model(&PlaygroundStorageLedger{}).Where("id = ?", row.Id).Updates(map[string]any{
			"egress_bytes":    nextBytes,
			"egress_requests": nextRequests,
			"updated_at":      common.GetTimestamp(),
		}).Error
	})
}

// playgroundStorageChargeQuota converts one day's peak and egress into a quota
// charge. The GB-day price is the monthly price over a 30-day month; the free
// allowance is subtracted first, and a metered egress adds its GB volume. All
// arithmetic runs in exact decimals and the final conversion saturates at the
// single-charge quota boundary with an audit marker, so a misconfiguration can
// never produce a negative or wrapped charge.
func playgroundStorageChargeQuota(peakBytes int64, freeBytes int64, egressBytes int64, group string, billing *playground_setting.PlaygroundStorageBillingSetting) (charge int, egressQuota int, clamp *common.QuotaClamp) {
	billableBytes := max(peakBytes-freeBytes, 0)
	if billableBytes <= 0 && !billing.EgressMetered() {
		return 0, 0, nil
	}
	gb := decimal.NewFromInt(playground_setting.PlaygroundStorageBytesPerGB)
	storageUSD := decimal.NewFromInt(billableBytes).Div(gb).
		Mul(decimal.NewFromFloat(billing.EffectivePriceUSDPerGBMonth())).
		Div(decimal.NewFromInt(playgroundStorageSettlementDaysPerMonth))
	egressUSD := decimal.Zero
	if billing.EgressMetered() && egressBytes > 0 {
		egressUSD = decimal.NewFromInt(egressBytes).Div(gb).Mul(decimal.NewFromFloat(billing.EffectiveEgressPriceUSDPerGB()))
	}
	totalUSD := storageUSD.Add(egressUSD)
	if totalUSD.IsNegative() {
		// Defense in depth: a negative total can only come from an invalid
		// configuration that slipped past its own guard, and it must never
		// become a credit.
		common.SysError(common.LogText("playground storage charge for group %q is negative, charging 0: %s", group, totalUSD.String()))
		return 0, 0, nil
	}
	quotaValue := totalUSD.Mul(decimal.NewFromFloat(common.QuotaPerUnit))
	if billing.ApplyGroupRatio {
		quotaValue = quotaValue.Mul(decimal.NewFromFloat(ratio_setting.GetGroupRatio(group)))
	}
	if quotaValue.IsNegative() {
		common.SysError(common.LogText("playground storage charge for group %q is negative after the group ratio, charging 0: %s", group, quotaValue.String()))
		return 0, 0, nil
	}
	charge, clamp = common.QuotaFromDecimalChecked(quotaValue)
	if egressUSD.IsPositive() {
		egressQuota = common.QuotaFromDecimal(egressUSD.Mul(decimal.NewFromFloat(common.QuotaPerUnit)).Mul(groupRatioDecimal(billing, group)))
	}
	return charge, min(egressQuota, charge), clamp
}

func groupRatioDecimal(billing *playground_setting.PlaygroundStorageBillingSetting, group string) decimal.Decimal {
	if billing == nil || !billing.ApplyGroupRatio {
		return decimal.NewFromInt(1)
	}
	return decimal.NewFromFloat(ratio_setting.GetGroupRatio(group))
}

// PlaygroundStorageSettlementReport summarizes one settlement pass.
type PlaygroundStorageSettlementReport struct {
	CheckedAt    int64 `json:"checked_at"`
	SettledCount int64 `json:"settled_count"`
	GraceCount   int64 `json:"grace_count"`
	FailedCount  int64 `json:"failed_count"`
	ChargedQuota int64 `json:"charged_quota"`
	GraceQuota   int64 `json:"grace_quota"`
}

// playgroundStorageSettlement is one settled day's outcome.
type playgroundStorageSettlement struct {
	ChargedQuota  int64
	DebtQuota     int64
	BillableBytes int64
	EgressQuota   int64
	Group         string
	Clamp         *common.QuotaClamp
	Charged       bool
	Graced        bool
	Replay        bool
}

// settlePlaygroundStorageLedgerRow settles one pending day inside its own
// transaction. The wallet-ledger reference (storage_daily, user:date) is
// claimed before the wallet moves, so a replay of the same day can never charge
// twice, and the row lock keeps two settlers of the same day serialized.
func settlePlaygroundStorageLedgerRow(row *PlaygroundStorageLedger, timestamp int64, group string, overdraftLimit int64) (*playgroundStorageSettlement, error) {
	billing := playground_setting.GetPlaygroundStorageBillingSetting()
	freeBytes := billing.FreeBytesForGroup(group)
	charge, egressQuota, clamp := playgroundStorageChargeQuota(row.PeakBytes, freeBytes, row.EgressBytes, group, billing)
	result := &playgroundStorageSettlement{
		BillableBytes: max(row.PeakBytes-freeBytes, 0),
		EgressQuota:   egressQuota,
		Group:         group,
		Clamp:         clamp,
		Charged:       charge > 0,
	}
	err := DB.Transaction(func(tx *gorm.DB) error {
		var locked PlaygroundStorageLedger
		if err := lockForUpdate(tx).Where("id = ?", row.Id).First(&locked).Error; err != nil {
			return err
		}
		if locked.Status != PlaygroundStorageLedgerStatusPending {
			result.Replay = true
			return nil
		}
		var applied, debtIncrease int64
		if charge > 0 {
			balance, err := lockUserQuotaTx(tx, locked.UserId)
			if err != nil {
				return err
			}
			debt, err := lockWalletDebtTx(tx, locked.UserId)
			if err != nil {
				return err
			}
			applied, debtIncrease = walletChargeSplit(balance, int64(charge), overdraftLimit)
			claimed, err := AppendWalletLedgerTx(tx, &WalletLedgerEntry{
				UserId:       locked.UserId,
				Kind:         WalletLedgerKindStorageDaily,
				Amount:       -applied,
				BalanceAfter: balance - applied,
				RefType:      WalletLedgerRefStorageDaily,
				RefId:        fmt.Sprintf("%d:%s", locked.UserId, locked.Date),
				Meta:         fmt.Sprintf("peak_bytes=%d billable_bytes=%d egress_bytes=%d", locked.PeakBytes, result.BillableBytes, locked.EgressBytes),
				CreatedAt:    timestamp,
			})
			if err != nil {
				return err
			}
			if !claimed {
				// Another settlement already claimed this day; the wallet did
				// not move and no second charge may be applied.
				result.Replay = true
				return nil
			}
			if _, _, err := applyLockedWalletChargeTx(tx, locked.UserId, balance, debt, int64(charge), overdraftLimit, "storage_daily:"+locked.Date); err != nil {
				return err
			}
		}
		status := PlaygroundStorageLedgerStatusSettled
		graceUntil := int64(0)
		if debtIncrease > 0 {
			status = PlaygroundStorageLedgerStatusGrace
			graceUntil = timestamp + int64(billing.EffectiveGraceDays())*24*60*60
		}
		now := common.GetTimestamp()
		if err := tx.Model(&PlaygroundStorageLedger{}).Where("id = ?", locked.Id).Updates(map[string]any{
			"free_bytes":     freeBytes,
			"billable_bytes": result.BillableBytes,
			"egress_quota":   result.EgressQuota,
			"quota":          applied,
			"debt_quota":     debtIncrease,
			"status":         status,
			"grace_until":    graceUntil,
			"settled_at":     now,
			"updated_at":     now,
		}).Error; err != nil {
			return err
		}
		result.ChargedQuota = applied
		result.DebtQuota = debtIncrease
		result.Graced = debtIncrease > 0
		return nil
	})
	if err != nil {
		return nil, err
	}
	if result.ChargedQuota > 0 {
		syncWalletQuotaCache(row.UserId, -result.ChargedQuota, "playground storage settlement")
	}
	return result, nil
}

// SettlePlaygroundStorageLedgers settles every pending day before today. Each
// day settles exactly once: the row state and the wallet-ledger reference both
// refuse a replay. A day whose charge exceeds the wallet becomes wallet debt
// through the shared overdraft path, marks the row grace and leaves the
// account read-only until the wallet covers it; no stored data is ever
// removed. One account's failure is reported without stopping the others.
func SettlePlaygroundStorageLedgers(timestamp int64, batchLimit int) (*PlaygroundStorageSettlementReport, error) {
	report := &PlaygroundStorageSettlementReport{CheckedAt: common.GetTimestamp()}
	billing := playground_setting.GetPlaygroundStorageBillingSetting()
	if !billing.IsEnabled() {
		return report, nil
	}
	if batchLimit <= 0 {
		batchLimit = 200
	}
	today := playgroundStorageLedgerDate(timestamp)
	var rows []PlaygroundStorageLedger
	if err := DB.Where("status = ? AND date < ?", PlaygroundStorageLedgerStatusPending, today).
		Order("id ASC").Limit(batchLimit).Find(&rows).Error; err != nil {
		return report, err
	}
	for index := range rows {
		row := &rows[index]
		group, err := GetUserGroup(row.UserId, false)
		if err != nil {
			report.FailedCount++
			common.SysError(common.LogText("failed to resolve the group of user %d for storage settlement: %s", row.UserId, err.Error()))
			continue
		}
		settlement, err := settlePlaygroundStorageLedgerRow(row, timestamp, group, OverdraftLimitQuotaForGroup(group))
		if err != nil {
			report.FailedCount++
			common.SysError(common.LogText("failed to settle the playground storage day %s of user %d: %s", row.Date, row.UserId, err.Error()))
			continue
		}
		if settlement.Replay {
			continue
		}
		if settlement.Graced {
			report.GraceCount++
			report.GraceQuota += settlement.DebtQuota
		} else {
			report.SettledCount++
		}
		report.ChargedQuota += settlement.ChargedQuota
		if settlement.Charged {
			recordPlaygroundStorageSettlementLog(row, settlement)
		}
	}
	return report, nil
}

// recordPlaygroundStorageSettlementLog writes the ordinary consume log of one
// settled day. The charge is already committed; a log failure is audited and
// never changes the wallet. A quota saturation marker (if any) is nested under
// admin_info so the anomaly stays auditable for administrators only.
func recordPlaygroundStorageSettlementLog(row *PlaygroundStorageLedger, settlement *playgroundStorageSettlement) {
	other := NewLogOther()
	other.SetPublic("storage_date", row.Date)
	if settlement.Clamp != nil {
		other.SetAdmin("quota_saturation", settlement.Clamp.AuditMap())
		common.SysError(common.LogText("playground storage settlement quota saturation for user %d on %s: %s", row.UserId, row.Date, settlement.Clamp.Error()))
	}
	RecordTaskBillingLog(RecordTaskBillingLogParams{
		UserId:    row.UserId,
		LogType:   LogTypeConsume,
		Content:   []*common.Message{common.NewMessage("Playground storage billing for {{date}}: {{quota}} quota charged, {{bytes}} bytes billed", map[string]any{"date": row.Date, "quota": settlement.ChargedQuota, "bytes": settlement.BillableBytes + row.EgressBytes})},
		ModelName: PlaygroundStorageBillingModelName,
		Quota:     int(settlement.ChargedQuota),
		Group:     settlement.Group,
		Other:     other,
	})
}

// ListPlaygroundStorageLedger lists ledger days, newest first, optionally
// scoped to one account and a date range. An empty userID lists every account
// (administrator view); the read is bounded by the caller's page size.
func ListPlaygroundStorageLedger(userID int, startDate string, endDate string, offset int, limit int) ([]*PlaygroundStorageLedger, int64, error) {
	query := DB.Model(&PlaygroundStorageLedger{})
	if userID > 0 {
		query = query.Where("user_id = ?", userID)
	}
	if startDate != "" {
		query = query.Where("date >= ?", startDate)
	}
	if endDate != "" {
		query = query.Where("date <= ?", endDate)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*PlaygroundStorageLedger
	if err := query.Order("date DESC, id DESC").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}

// StreamPlaygroundStorageLedger walks the selected ledger days newest first for
// CSV export without loading the whole selection into memory.
func StreamPlaygroundStorageLedger(userID int, startDate string, endDate string, exportLimit int, fn func(*PlaygroundStorageLedger) error) error {
	query := DB.Model(&PlaygroundStorageLedger{})
	if userID > 0 {
		query = query.Where("user_id = ?", userID)
	}
	if startDate != "" {
		query = query.Where("date >= ?", startDate)
	}
	if endDate != "" {
		query = query.Where("date <= ?", endDate)
	}
	rows, err := query.Order("date DESC, id DESC").Limit(exportLimit).Rows()
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var row PlaygroundStorageLedger
		if err := DB.ScanRows(rows, &row); err != nil {
			return err
		}
		if err := fn(&row); err != nil {
			return err
		}
	}
	return rows.Err()
}

// PlaygroundStorageBillingStatus is the caller's read-only view of the
// metered tier: the effective prices and limits, today's accruing day and the
// read-only grace state of an unpaid settlement.
type PlaygroundStorageBillingStatus struct {
	Enabled                  bool                     `json:"enabled"`
	Group                    string                   `json:"group"`
	PriceUSDPerGBMonth       float64                  `json:"price_usd_per_gb_month"`
	FreeBytes                int64                    `json:"free_bytes"`
	ApplyGroupRatio          bool                     `json:"apply_group_ratio"`
	GraceDays                int                      `json:"grace_days"`
	EgressMode               string                   `json:"egress_mode"`
	EgressPriceUSDPerGB      float64                  `json:"egress_price_usd_per_gb"`
	EgressDailyBytesLimit    int64                    `json:"egress_daily_bytes_limit"`
	EgressDailyRequestsLimit int64                    `json:"egress_daily_requests_limit"`
	Today                    *PlaygroundStorageLedger `json:"today,omitempty"`
	// DebtQuota is the account's outstanding wallet debt (any kind), and
	// ReadOnly mirrors the shared wallet lock the workspace write paths
	// enforce. GraceUntil is the latest recorded payment deadline of an
	// unpaid storage day.
	DebtQuota  int64 `json:"debt_quota"`
	GraceUntil int64 `json:"grace_until"`
	ReadOnly   bool  `json:"read_only"`
}

// GetPlaygroundStorageBillingStatus builds the read-only billing view of one
// account. It resolves the group policy, reads (never creates) today's row and
// asks the shared wallet-debt resolver, which may collect owed money from a
// recharged wallet exactly like the write gate does.
func GetPlaygroundStorageBillingStatus(userID int) (*PlaygroundStorageBillingStatus, error) {
	_, group, err := playgroundPolicyForGroup(DB, userID)
	if err != nil {
		return nil, err
	}
	billing := playground_setting.GetPlaygroundStorageBillingSetting()
	bytesLimit, requestsLimit := billing.EgressDailyLimits(group)
	status := &PlaygroundStorageBillingStatus{
		Enabled:                  billing.IsEnabled(),
		Group:                    group,
		PriceUSDPerGBMonth:       billing.EffectivePriceUSDPerGBMonth(),
		FreeBytes:                billing.FreeBytesForGroup(group),
		ApplyGroupRatio:          billing.ApplyGroupRatio,
		GraceDays:                billing.EffectiveGraceDays(),
		EgressMode:               billing.Egress.Mode,
		EgressPriceUSDPerGB:      billing.EffectiveEgressPriceUSDPerGB(),
		EgressDailyBytesLimit:    bytesLimit,
		EgressDailyRequestsLimit: requestsLimit,
	}
	var today PlaygroundStorageLedger
	err = DB.Where("user_id = ? AND date = ?", userID, playgroundStorageLedgerDate(common.GetTimestamp())).First(&today).Error
	if err == nil {
		status.Today = &today
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	var latestGrace struct {
		GraceUntil int64
	}
	if err := DB.Model(&PlaygroundStorageLedger{}).
		Select("COALESCE(MAX(grace_until), 0) AS grace_until").
		Where("user_id = ? AND status = ?", userID, PlaygroundStorageLedgerStatusGrace).
		Scan(&latestGrace).Error; err != nil {
		return nil, err
	}
	status.GraceUntil = latestGrace.GraceUntil
	debt, readOnly, err := ResolveWalletDebtStatus(userID)
	if err != nil {
		return nil, err
	}
	status.DebtQuota = debt
	status.ReadOnly = readOnly
	return status, nil
}

// PlaygroundStorageReconciliation is one account's storage billing
// reconciliation: the quota the ledger rows billed against the wallet-account
// movement recorded in the unified ledger. Both must be equal; reconciliation
// never modifies either side.
type PlaygroundStorageReconciliation struct {
	UserId       int   `json:"user_id"`
	StorageQuota int64 `json:"storage_quota"`
	WalletQuota  int64 `json:"wallet_quota"`
	DayCount     int64 `json:"day_count"`
	Deviation    int64 `json:"deviation"`
	Reconciled   bool  `json:"reconciled"`
	CheckedAt    int64 `json:"checked_at"`
}

// PlaygroundStorageReconciliationReport summarizes one reconciliation pass.
// Deviations is capped; DeviationCount is the full count.
type PlaygroundStorageReconciliationReport struct {
	CheckedAt      int64                             `json:"checked_at"`
	UserCount      int64                             `json:"user_count"`
	DeviationCount int64                             `json:"deviation_count"`
	Deviations     []PlaygroundStorageReconciliation `json:"deviations"`
}

// ReconcilePlaygroundStorageBilling compares every settled storage day with
// the matching storage_daily rows of the unified wallet ledger. A zero userID
// checks every account; a positive one checks that account only. Pending
// updates are flushed first so the comparison sees the committed state.
func ReconcilePlaygroundStorageBilling(deviationLimit int, userID int) (*PlaygroundStorageReconciliationReport, error) {
	FlushBatchUpdates()

	type storageSumRow struct {
		UserId int
		Total  int64
		Days   int64
	}
	storageQuery := DB.Model(&PlaygroundStorageLedger{}).
		Select("user_id, COALESCE(SUM(quota), 0) AS total, COUNT(*) AS days").
		Where("status IN ?", []string{PlaygroundStorageLedgerStatusSettled, PlaygroundStorageLedgerStatusGrace})
	if userID > 0 {
		storageQuery = storageQuery.Where("user_id = ?", userID)
	}
	var storageSums []storageSumRow
	if err := storageQuery.Group("user_id").Find(&storageSums).Error; err != nil {
		return nil, err
	}

	type walletSumRow struct {
		UserId int
		Total  int64
	}
	walletQuery := DB.Model(&WalletLedgerEntry{}).
		Select("user_id, COALESCE(SUM(-amount), 0) AS total").
		Where("ref_type = ?", WalletLedgerRefStorageDaily)
	if userID > 0 {
		walletQuery = walletQuery.Where("user_id = ?", userID)
	}
	var walletSums []walletSumRow
	if err := walletQuery.Group("user_id").Find(&walletSums).Error; err != nil {
		return nil, err
	}
	walletByUser := make(map[int]int64, len(walletSums))
	for _, sum := range walletSums {
		walletByUser[sum.UserId] = sum.Total
	}

	report := &PlaygroundStorageReconciliationReport{
		CheckedAt:  common.GetTimestamp(),
		Deviations: make([]PlaygroundStorageReconciliation, 0),
	}
	checked := make(map[int]struct{}, len(storageSums))
	for _, sum := range storageSums {
		checked[sum.UserId] = struct{}{}
		report.UserCount++
		entry := PlaygroundStorageReconciliation{
			UserId:       sum.UserId,
			StorageQuota: sum.Total,
			WalletQuota:  walletByUser[sum.UserId],
			DayCount:     sum.Days,
			CheckedAt:    report.CheckedAt,
		}
		entry.Deviation = entry.StorageQuota - entry.WalletQuota
		entry.Reconciled = entry.Deviation == 0
		if !entry.Reconciled {
			report.DeviationCount++
			if deviationLimit > 0 && len(report.Deviations) >= deviationLimit {
				continue
			}
			report.Deviations = append(report.Deviations, entry)
		}
	}
	// A wallet movement without a settled day is a deviation too, so a lost or
	// half-written ledger row cannot stay invisible.
	for _, sum := range walletSums {
		if _, ok := checked[sum.UserId]; ok {
			continue
		}
		report.UserCount++
		entry := PlaygroundStorageReconciliation{
			UserId:      sum.UserId,
			WalletQuota: sum.Total,
			Deviation:   -sum.Total,
			CheckedAt:   report.CheckedAt,
		}
		report.DeviationCount++
		if deviationLimit > 0 && len(report.Deviations) >= deviationLimit {
			continue
		}
		report.Deviations = append(report.Deviations, entry)
	}
	return report, nil
}
