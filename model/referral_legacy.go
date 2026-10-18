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
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	// referralLegacyMigrationOptionKey is the internal option that records the
	// completed one-time legacy import. The key is kept out of the public
	// option map and refuses updates through the option API.
	referralLegacyMigrationOptionKey = "ReferralLegacyMigration"
	// referralLegacyMigrationBatch bounds one keyset page of the import.
	referralLegacyMigrationBatch = 200
	// referralLegacyReconciliationBatch bounds one keyset page of the audit.
	referralLegacyReconciliationBatch = 200
	// affiliateLegacyGrantNote is stored on the credit grant created by the
	// balance import, so an administrator can tell a migrated balance from a
	// newly earned invitation.
	affiliateLegacyGrantNote = "legacy affiliate balance migration"
)

// Affiliate legacy reconciliation reasons. Each names one integrity rule the
// audit enforces; they are stable codes, not translated text.
const (
	// LegacyReferralReasonNegativeBalance reports a negative legacy counter,
	// which every legitimate path keeps at zero or above.
	LegacyReferralReasonNegativeBalance = "legacy_balance_negative"
	// LegacyReferralReasonGrantMissing reports an import ledger row without
	// the invite credit grant that was created with it.
	LegacyReferralReasonGrantMissing = "migration_grant_missing"
	// LegacyReferralReasonGrantMismatch reports an import grant that no longer
	// matches its ledger row (another user, source or amount).
	LegacyReferralReasonGrantMismatch = "migration_grant_mismatch"
	// LegacyReferralReasonLedgerDeviation reports an imported wallet whose
	// ledger sum no longer equals the balance.
	LegacyReferralReasonLedgerDeviation = "wallet_ledger_deviation"
)

// errReferralLegacyMigrationReadOnly refuses option writes to the internal
// import marker.
var errReferralLegacyMigrationReadOnly = errors.New("ReferralLegacyMigration is an internal option and cannot be updated")

// LegacyReferralMigrationMarker is the stored summary of the completed
// one-time import: when it finished and what it moved. Its presence is what
// makes the import run exactly once.
type LegacyReferralMigrationMarker struct {
	CompletedAt   int64 `json:"completed_at"`
	RelationCount int64 `json:"relation_count"`
	MigratedUsers int64 `json:"migrated_users"`
	MigratedQuota int64 `json:"migrated_quota"`
}

// LegacyReferralMigrationResult summarizes one attempt of the legacy import.
// A skipped run means the stored marker shows a completed import; per-account
// ledger references keep a retried account from ever being imported twice.
type LegacyReferralMigrationResult struct {
	CheckedAt     int64 `json:"checked_at"`
	Skipped       bool  `json:"skipped"`
	Completed     bool  `json:"completed"`
	RelationCount int64 `json:"relation_count"`
	BalanceUsers  int64 `json:"balance_users"`
	MigratedUsers int64 `json:"migrated_users"`
	MigratedQuota int64 `json:"migrated_quota"`
	SkippedUsers  int64 `json:"skipped_users"`
	FailedUsers   int64 `json:"failed_users"`
}

// loadLegacyReferralMigrationMarker returns the stored import marker and
// whether the import already completed. A marker row whose payload cannot be
// read still counts as completed: the import must never run twice.
func loadLegacyReferralMigrationMarker() (*LegacyReferralMigrationMarker, bool, error) {
	var option Option
	err := DB.Where(&Option{Key: referralLegacyMigrationOptionKey}).First(&option).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	marker := &LegacyReferralMigrationMarker{}
	if err := common.UnmarshalJsonStr(option.Value, marker); err != nil {
		common.SysError(common.LogText("the legacy referral import marker is unreadable: %s", err.Error()))
		return &LegacyReferralMigrationMarker{}, true, nil
	}
	return marker, true, nil
}

// storeLegacyReferralMigrationMarker writes the one-time import marker. The
// first node to finish wins; a concurrent node only reads it.
func storeLegacyReferralMigrationMarker(marker *LegacyReferralMigrationMarker) error {
	encoded, err := common.Marshal(marker)
	if err != nil {
		return err
	}
	return DB.Clauses(clause.OnConflict{DoNothing: true}).
		Create(&Option{Key: referralLegacyMigrationOptionKey, Value: string(encoded)}).Error
}

// MigrateLegacyReferralData runs the one-time import of the data that predates
// the referral models: the invitation relations that only exist in
// users.inviter_id get their referral_bindings row, and every legacy aff_quota
// balance moves into the wallet as a never-expiring invite credit grant
// recorded in the wallet ledger. The import runs once per installation — the
// stored marker is the guard — and every account owns exactly one ledger
// reference, so a crashed or retried run can never credit an account twice.
// An account whose balance is already zero is never touched, and a failing
// account does not block the rest: it keeps its balance and a later attempt
// (a restart, while the marker is absent) retries it.
func MigrateLegacyReferralData() (*LegacyReferralMigrationResult, error) {
	marker, completed, err := loadLegacyReferralMigrationMarker()
	if err != nil {
		return nil, err
	}
	result := &LegacyReferralMigrationResult{CheckedAt: common.GetTimestamp(), Skipped: completed}
	if completed {
		result.RelationCount = marker.RelationCount
		result.MigratedUsers = marker.MigratedUsers
		result.MigratedQuota = marker.MigratedQuota
		return result, nil
	}

	if result.RelationCount, err = backfillLegacyReferralBindings(); err != nil {
		return result, err
	}
	if err := sweepLegacyAffiliateBalances(result); err != nil {
		return result, err
	}
	if result.FailedUsers > 0 {
		common.SysError(common.LogText("the legacy referral import left %d accounts with a legacy affiliate balance; the next start retries them", result.FailedUsers))
		return result, nil
	}
	if err := storeLegacyReferralMigrationMarker(&LegacyReferralMigrationMarker{
		CompletedAt:   common.GetTimestamp(),
		RelationCount: result.RelationCount,
		MigratedUsers: result.MigratedUsers,
		MigratedQuota: result.MigratedQuota,
	}); err != nil {
		return result, err
	}
	result.Completed = true
	return result, nil
}

// backfillLegacyReferralBindings gives accounts whose users.inviter_id
// predates the binding table their missing binding row, so rewards and
// statistics keep reading one source of truth. The pass is append-once: an
// account that already has a binding keeps it, and a historical relation is
// recorded even when the inviter is disabled now, because rewards re-check the
// inviter before they are issued. Self-invites and relations whose inviter row
// no longer exists are skipped; the mirror column itself is left untouched.
func backfillLegacyReferralBindings() (int64, error) {
	inserted := int64(0)
	lastId := 0
	for {
		var invitees []User
		if err := DB.Model(&User{}).
			Select("id", "inviter_id").
			Where("inviter_id > 0 AND inviter_id <> id AND id > ?", lastId).
			Order("id ASC").
			Limit(referralLegacyMigrationBatch).
			Find(&invitees).Error; err != nil {
			return inserted, err
		}
		if len(invitees) == 0 {
			return inserted, nil
		}
		for i := range invitees {
			invitee := invitees[i]
			lastId = invitee.Id

			// A scoped existence check: a deleted inviter does not receive a
			// relation, exactly like a binding created at sign-up.
			var inviterCount int64
			if err := DB.Model(&User{}).Where("id = ?", invitee.InviterId).Count(&inviterCount).Error; err != nil {
				return inserted, err
			}
			if inviterCount == 0 {
				continue
			}

			var existing ReferralBinding
			err := DB.Select("id").Where("invitee_id = ?", invitee.Id).First(&existing).Error
			if err == nil {
				continue
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return inserted, err
			}

			binding := &ReferralBinding{
				InviteeId: invitee.Id,
				InviterId: invitee.InviterId,
				Source:    ReferralSourceLegacy,
				BoundAt:   common.GetTimestamp(),
			}
			if err := DB.Create(binding).Error; err != nil {
				if isReferralBindingDuplicateError(err) {
					continue // a concurrent start recorded the relation first
				}
				return inserted, err
			}
			inserted++
		}
	}
}

// sweepLegacyAffiliateBalances imports every account whose legacy affiliate
// balance is positive. The keyset cursor advances past an account even when its
// import failed, so one account (for example an oversized balance) can neither
// loop nor block the rest.
func sweepLegacyAffiliateBalances(result *LegacyReferralMigrationResult) error {
	lastId := 0
	for {
		var candidates []User
		if err := DB.Model(&User{}).
			Select("id").
			Where("aff_quota > 0 AND id > ?", lastId).
			Order("id ASC").
			Limit(referralLegacyMigrationBatch).
			Find(&candidates).Error; err != nil {
			return err
		}
		if len(candidates) == 0 {
			return nil
		}
		for i := range candidates {
			userId := candidates[i].Id
			lastId = userId
			result.BalanceUsers++
			migrated, err := migrateLegacyAffiliateBalanceTx(userId)
			switch {
			case err != nil:
				result.FailedUsers++
				common.SysError(common.LogText("failed to import the legacy affiliate balance of user %d: %s", userId, err.Error()))
			case migrated > 0:
				result.MigratedUsers++
				result.MigratedQuota += migrated
				syncCreditUserQuotaCache(userId, int(migrated), "legacy affiliate import")
				RecordLog(userId, LogTypeSystem, common.NewMessage("Legacy invitation reward transferred to balance {{quota}}", map[string]any{"quota": logger.FormatQuota(int(migrated))}))
			default:
				result.SkippedUsers++
			}
		}
	}
}

// migrateLegacyAffiliateBalanceTx imports one account's legacy aff_quota into
// the wallet as an invite credit grant that never expires — the balance was
// earned under a policy without validity, so the import must not retroactively
// expire it — and clears the legacy counter. The wallet ledger row, the credit
// grant and the cleared column commit in one transaction, so an interrupted
// run leaves either the full import or nothing. The imported grant records the
// amount in the ledger meta together with the historical aff_history value,
// which stays as the lifetime statistic it always was. The function returns
// the imported amount, or zero when there was nothing left to import.
func migrateLegacyAffiliateBalanceTx(userId int) (int64, error) {
	migrated := int64(0)
	err := DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).
			Select("id", "quota", "aff_quota", "aff_history").
			Where("id = ?", userId).
			First(&user).Error; err != nil {
			return err
		}
		amount := int64(user.AffQuota)
		if amount <= 0 {
			// A concurrent manual transfer or an earlier attempt already
			// emptied the counter.
			return nil
		}

		refId := strconv.Itoa(user.Id)
		var existing WalletLedgerEntry
		findErr := tx.Select("id").
			Where("ref_type = ? AND ref_id = ?", WalletLedgerRefAffiliateMigration, refId).
			First(&existing).Error
		if findErr == nil {
			// This account was imported by an earlier attempt that did not
			// reach the marker yet.
			return nil
		}
		if !errors.Is(findErr, gorm.ErrRecordNotFound) {
			return findErr
		}

		meta := fmt.Sprintf("%s legacy_aff_quota=%d legacy_aff_history=%d",
			grantLedgerMeta(operation_setting.CreditGrantSourceInvite, 0), amount, user.AffHistoryQuota)
		applied, err := ApplyWalletLedgerDelta(tx, user.Id, WalletLedgerKindAffiliateTransfer, amount,
			WalletLedgerRefAffiliateMigration, refId, meta)
		if err != nil {
			return err
		}
		if !applied {
			// A concurrent start claimed the reference first.
			return nil
		}
		grant, err := createCreditGrantTx(tx, user.Id, operation_setting.CreditGrantSourceInvite, amount, 0, affiliateLegacyGrantNote)
		if err != nil {
			return err
		}
		// Attach the grant to the ledger row so the reconciliation can tie the
		// imported money to the claim created with it. Both rows commit
		// together in this transaction, so the row keeps referring to it.
		if err := tx.Model(&WalletLedgerEntry{}).
			Where("ref_type = ? AND ref_id = ?", WalletLedgerRefAffiliateMigration, refId).
			UpdateColumn("meta", fmt.Sprintf("%s grant=%d", meta, grant.Id)).Error; err != nil {
			return err
		}
		if err := tx.Model(&User{}).Where("id = ?", user.Id).UpdateColumn("aff_quota", 0).Error; err != nil {
			return err
		}
		migrated = amount
		return nil
	})
	return migrated, err
}

// LegacyReferralReconciliation is the per-account result of auditing the
// legacy import; reconciliation never modifies a balance.
type LegacyReferralReconciliation struct {
	UserId        int    `json:"user_id"`
	Username      string `json:"username,omitempty"`
	LegacyQuota   int64  `json:"legacy_quota"`
	HistoryQuota  int64  `json:"history_quota"`
	MigratedQuota int64  `json:"migrated_quota"`
	WalletQuota   int64  `json:"wallet_quota"`
	LedgerSum     int64  `json:"ledger_sum"`
	Deviation     int64  `json:"deviation"`
	Reason        string `json:"reason"`
	CheckedAt     int64  `json:"checked_at"`
}

// LegacyReferralReconciliationReport summarizes one audit run. Anomalies is
// capped so the report stays bounded; AnomalyCount is the full count.
type LegacyReferralReconciliationReport struct {
	CheckedAt       int64                          `json:"checked_at"`
	MigrationDone   bool                           `json:"migration_done"`
	MigratedUsers   int64                          `json:"migrated_users"`
	MigratedQuota   int64                          `json:"migrated_quota"`
	PendingUsers    int64                          `json:"pending_users"`
	PendingQuota    int64                          `json:"pending_quota"`
	UnboundInvitees int64                          `json:"unbound_invitees"`
	AnomalyCount    int64                          `json:"anomaly_count"`
	Anomalies       []LegacyReferralReconciliation `json:"anomalies"`
}

// ReconcileLegacyReferralData audits the legacy import without changing any
// balance. It reports how many accounts were imported and how much legacy
// quota is still waiting to be transferred, and lists a capped set of
// anomalies: a negative legacy counter, an import ledger row whose credit
// grant is missing or no longer matches it, and an imported wallet whose
// ledger sum no longer equals the balance.
func ReconcileLegacyReferralData(anomalyLimit int) (*LegacyReferralReconciliationReport, error) {
	FlushBatchUpdates()

	report := &LegacyReferralReconciliationReport{CheckedAt: common.GetTimestamp()}
	_, completed, err := loadLegacyReferralMigrationMarker()
	if err != nil {
		return nil, err
	}
	report.MigrationDone = completed

	lastId := 0
	for {
		var users []User
		if err := DB.Model(&User{}).
			Select("id", "username", "quota", "aff_quota", "aff_history").
			Where("aff_quota <> 0 OR id IN (?)",
				DB.Model(&WalletLedgerEntry{}).Select("user_id").Where("ref_type = ?", WalletLedgerRefAffiliateMigration)).
			Where("id > ?", lastId).
			Order("id ASC").
			Limit(referralLegacyReconciliationBatch).
			Find(&users).Error; err != nil {
			return nil, err
		}
		if len(users) == 0 {
			break
		}
		ids := make([]int, 0, len(users))
		for i := range users {
			ids = append(ids, users[i].Id)
		}
		batch, err := loadLegacyReferralAuditBatch(ids)
		if err != nil {
			return nil, err
		}
		for _, user := range users {
			if user.AffQuota > 0 {
				report.PendingUsers++
				report.PendingQuota += int64(user.AffQuota)
			}
			migration := batch.migrations[user.Id]
			if migration != nil {
				report.MigratedUsers++
				report.MigratedQuota += migration.Amount
			}
			entry := LegacyReferralReconciliation{
				UserId:       user.Id,
				Username:     user.Username,
				LegacyQuota:  int64(user.AffQuota),
				HistoryQuota: int64(user.AffHistoryQuota),
				WalletQuota:  int64(user.Quota),
				LedgerSum:    batch.ledgerSums[user.Id],
				CheckedAt:    report.CheckedAt,
			}
			if migration != nil {
				entry.MigratedQuota = migration.Amount
			}
			switch {
			case user.AffQuota < 0:
				entry.Reason = LegacyReferralReasonNegativeBalance
			case migration != nil:
				if reason := legacyReferralGrantIssue(migration, batch.grants); reason != "" {
					entry.Reason = reason
				} else if entry.LedgerSum != entry.WalletQuota {
					entry.Deviation = entry.LedgerSum - entry.WalletQuota
					entry.Reason = LegacyReferralReasonLedgerDeviation
				}
			}
			if entry.Reason == "" {
				continue
			}
			report.AnomalyCount++
			if anomalyLimit <= 0 || len(report.Anomalies) < anomalyLimit {
				report.Anomalies = append(report.Anomalies, entry)
			}
		}
		lastId = users[len(users)-1].Id
	}

	// Relations that still only exist in the mirror column mean the backfill
	// has not covered them: count the same shape the backfill imports.
	var unbound int64
	if err := DB.Model(&User{}).
		Where("inviter_id > 0 AND inviter_id <> id").
		Where("inviter_id IN (?)", DB.Model(&User{}).Select("id")).
		Where("id NOT IN (?)", DB.Model(&ReferralBinding{}).Select("invitee_id")).
		Count(&unbound).Error; err != nil {
		return nil, err
	}
	report.UnboundInvitees = unbound
	return report, nil
}

// legacyReferralAuditBatch is the per-page state of the audit: the wallet
// ledger sum of each candidate and the import rows with the grants they refer
// to.
type legacyReferralAuditBatch struct {
	ledgerSums map[int]int64
	migrations map[int]*WalletLedgerEntry
	grants     map[int]*CreditGrant
}

// loadLegacyReferralAuditBatch loads the audit state of one candidate page with
// three grouped queries instead of one query per account.
func loadLegacyReferralAuditBatch(ids []int) (*legacyReferralAuditBatch, error) {
	batch := &legacyReferralAuditBatch{
		ledgerSums: make(map[int]int64, len(ids)),
		migrations: make(map[int]*WalletLedgerEntry),
		grants:     make(map[int]*CreditGrant),
	}
	type ledgerSumRow struct {
		UserId int
		Total  int64
	}
	var sums []ledgerSumRow
	if err := DB.Model(&WalletLedgerEntry{}).
		Select("user_id, SUM(CASE WHEN kind = ? THEN 0 ELSE amount END) AS total", WalletLedgerKindDebt).
		Where("user_id IN ?", ids).
		Group("user_id").
		Find(&sums).Error; err != nil {
		return nil, err
	}
	for _, row := range sums {
		batch.ledgerSums[row.UserId] = row.Total
	}

	var migrations []*WalletLedgerEntry
	if err := DB.Model(&WalletLedgerEntry{}).
		Where("ref_type = ? AND user_id IN ?", WalletLedgerRefAffiliateMigration, ids).
		Order("id ASC").
		Find(&migrations).Error; err != nil {
		return nil, err
	}
	grantIds := make([]int, 0, len(migrations))
	for _, entry := range migrations {
		if existing := batch.migrations[entry.UserId]; existing != nil {
			// One import per account; keep the first row so the audit stays
			// deterministic even if a row was added by hand.
			continue
		}
		batch.migrations[entry.UserId] = entry
		if grantId := legacyReferralGrantId(entry.Meta); grantId > 0 {
			grantIds = append(grantIds, grantId)
		}
	}
	if len(grantIds) > 0 {
		var grants []CreditGrant
		if err := DB.Model(&CreditGrant{}).Where("id IN ?", grantIds).Find(&grants).Error; err != nil {
			return nil, err
		}
		for i := range grants {
			batch.grants[grants[i].Id] = &grants[i]
		}
	}
	return batch, nil
}

// legacyReferralGrantId reads the grant reference the import recorded on a
// ledger row; 0 means the row carries none.
func legacyReferralGrantId(meta string) int {
	for _, field := range strings.Fields(meta) {
		value, ok := strings.CutPrefix(field, "grant=")
		if !ok {
			continue
		}
		grantId, err := strconv.Atoi(value)
		if err != nil || grantId <= 0 {
			return 0
		}
		return grantId
	}
	return 0
}

// legacyReferralGrantIssue reports why the grant recorded on an import ledger
// row no longer matches it, or "" when it does.
func legacyReferralGrantIssue(entry *WalletLedgerEntry, grants map[int]*CreditGrant) string {
	grantId := legacyReferralGrantId(entry.Meta)
	if grantId == 0 {
		return LegacyReferralReasonGrantMissing
	}
	grant := grants[grantId]
	if grant == nil {
		return LegacyReferralReasonGrantMissing
	}
	if grant.UserId != entry.UserId ||
		grant.Source != operation_setting.CreditGrantSourceInvite ||
		grant.Amount != entry.Amount {
		return LegacyReferralReasonGrantMismatch
	}
	return ""
}
