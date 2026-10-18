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
	"fmt"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// setupLegacyReferralTest extends the referral commission fixture with the
// option table (the one-time import marker) and the log table (the
// user-visible import line), and pins the invitation grant validity to "never
// expires" so the assertions are independent of the environment.
func setupLegacyReferralTest(t *testing.T, db *gorm.DB) {
	t.Helper()
	setupReferralCommissionTest(t, db)
	require.NoError(t, db.AutoMigrate(&Option{}, &Log{}))
	t.Cleanup(func() {
		require.NoError(t, db.Migrator().DropTable(&Option{}, &Log{}))
	})
	grantSetting := operation_setting.GetCreditGrantSetting()
	grantSetting.DefaultExpiryDays = 0
	if grantSetting.SourceExpiryDays != nil {
		delete(grantSetting.SourceExpiryDays, operation_setting.CreditGrantSourceInvite)
	}
}

// setLegacyAffiliateQuota seeds the legacy counters of one fixture account the
// way the pre-ledger code left them.
func setLegacyAffiliateQuota(t *testing.T, db *gorm.DB, userId int, quota int, history int) {
	t.Helper()
	require.NoError(t, db.Model(&User{}).Where("id = ?", userId).
		UpdateColumns(map[string]any{"aff_quota": quota, "aff_history": history}).Error)
}

func legacyLedgerSum(t *testing.T, db *gorm.DB, userId int) int64 {
	t.Helper()
	var sum int64
	require.NoError(t, db.Model(&WalletLedgerEntry{}).
		Select("COALESCE(SUM(CASE WHEN kind = ? THEN 0 ELSE amount END), 0)", WalletLedgerKindDebt).
		Where("user_id = ?", userId).
		Scan(&sum).Error)
	return sum
}

// The one-time import backfills the relations that only exist in users.inviter_id
// and moves every positive legacy affiliate balance into the wallet with an
// invite grant, a ledger row and the zeroed counter committing together. A
// second run is a no-op, and a rerun without the marker still cannot import one
// account twice because the per-account ledger reference is already claimed.
func TestLegacyReferralImportMatrix(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		setupLegacyReferralTest(t, db)

		inviter := createReferralCommissionTestUser(t, db, "legacy-inviter", "default")
		setLegacyAffiliateQuota(t, db, inviter.Id, 700, 1200)

		legacyInvitee := createReferralCommissionTestUser(t, db, "legacy-invitee", "default")
		require.NoError(t, db.Model(&User{}).Where("id = ?", legacyInvitee.Id).
			UpdateColumn("inviter_id", inviter.Id).Error)

		selfInvitee := createReferralCommissionTestUser(t, db, "legacy-self", "default")
		require.NoError(t, db.Model(&User{}).Where("id = ?", selfInvitee.Id).
			UpdateColumn("inviter_id", selfInvitee.Id).Error)

		danglingInvitee := createReferralCommissionTestUser(t, db, "legacy-dangling", "default")
		require.NoError(t, db.Model(&User{}).Where("id = ?", danglingInvitee.Id).
			UpdateColumn("inviter_id", 999999).Error)

		boundInvitee := createReferralCommissionTestUser(t, db, "legacy-bound", "default")
		bindReferralCommissionTestInviter(t, boundInvitee, inviter.Id)

		result, err := MigrateLegacyReferralData()
		require.NoError(t, err)
		assert.False(t, result.Skipped)
		assert.True(t, result.Completed)
		assert.EqualValues(t, 1, result.RelationCount)
		assert.EqualValues(t, 1, result.BalanceUsers)
		assert.EqualValues(t, 1, result.MigratedUsers)
		assert.EqualValues(t, 700, result.MigratedQuota)
		assert.Zero(t, result.FailedUsers)
		assert.Zero(t, result.SkippedUsers)

		var storedInviter User
		require.NoError(t, db.Select("quota", "aff_quota", "aff_history").First(&storedInviter, inviter.Id).Error)
		assert.EqualValues(t, 1700, storedInviter.Quota)
		assert.Zero(t, storedInviter.AffQuota)
		assert.EqualValues(t, 1200, storedInviter.AffHistoryQuota)

		var entry WalletLedgerEntry
		require.NoError(t, db.Where("ref_type = ? AND ref_id = ?", WalletLedgerRefAffiliateMigration, fmt.Sprint(inviter.Id)).First(&entry).Error)
		assert.Equal(t, WalletLedgerKindAffiliateTransfer, entry.Kind)
		assert.EqualValues(t, 700, entry.Amount)
		assert.EqualValues(t, 1700, entry.BalanceAfter)
		assert.Contains(t, entry.Meta, "legacy_aff_quota=700")
		assert.Contains(t, entry.Meta, "legacy_aff_history=1200")
		grantId := legacyReferralGrantId(entry.Meta)
		require.NotZero(t, grantId)

		var grant CreditGrant
		require.NoError(t, db.First(&grant, grantId).Error)
		assert.Equal(t, inviter.Id, grant.UserId)
		assert.Equal(t, operation_setting.CreditGrantSourceInvite, grant.Source)
		assert.EqualValues(t, 700, grant.Amount)
		assert.EqualValues(t, 700, grant.Remaining)
		assert.Zero(t, grant.ExpiresAt)
		assert.Equal(t, affiliateLegacyGrantNote, grant.Note)
		assert.EqualValues(t, 1700, legacyLedgerSum(t, db, inviter.Id))

		// The user sees one system line explaining the balance change.
		var logCount int64
		require.NoError(t, db.Model(&Log{}).Where("user_id = ? AND type = ?", inviter.Id, LogTypeSystem).Count(&logCount).Error)
		assert.EqualValues(t, 1, logCount)

		// Relations: the mirror column produced one legacy binding; the self
		// invite and the dangling inviter produce none; an existing binding
		// keeps its recorded source.
		var legacyBinding ReferralBinding
		require.NoError(t, db.Where("invitee_id = ?", legacyInvitee.Id).First(&legacyBinding).Error)
		assert.Equal(t, inviter.Id, legacyBinding.InviterId)
		assert.Equal(t, ReferralSourceLegacy, legacyBinding.Source)
		var selfBindings int64
		require.NoError(t, db.Model(&ReferralBinding{}).Where("invitee_id = ?", selfInvitee.Id).Count(&selfBindings).Error)
		assert.Zero(t, selfBindings)
		var danglingBindings int64
		require.NoError(t, db.Model(&ReferralBinding{}).Where("invitee_id = ?", danglingInvitee.Id).Count(&danglingBindings).Error)
		assert.Zero(t, danglingBindings)
		var boundBinding ReferralBinding
		require.NoError(t, db.Where("invitee_id = ?", boundInvitee.Id).First(&boundBinding).Error)
		assert.Equal(t, ReferralSourceCode, boundBinding.Source)

		// The imported channel is a recorded source: the administrator
		// statistics filter accepts it and finds exactly the backfilled
		// relation.
		legacyTotal, err := CountReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id, Source: ReferralSourceLegacy})
		require.NoError(t, err)
		assert.EqualValues(t, 1, legacyTotal)
		codeTotal, err := CountReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id, Source: ReferralSourceCode})
		require.NoError(t, err)
		assert.EqualValues(t, 1, codeTotal)

		// The marker records the completed import and makes it a one-time event.
		var option Option
		require.NoError(t, db.Where(&Option{Key: referralLegacyMigrationOptionKey}).First(&option).Error)
		var marker LegacyReferralMigrationMarker
		require.NoError(t, common.UnmarshalJsonStr(option.Value, &marker))
		assert.EqualValues(t, 1, marker.RelationCount)
		assert.EqualValues(t, 1, marker.MigratedUsers)
		assert.EqualValues(t, 700, marker.MigratedQuota)
		assert.NotZero(t, marker.CompletedAt)

		second, err := MigrateLegacyReferralData()
		require.NoError(t, err)
		assert.True(t, second.Skipped)
		assert.EqualValues(t, 700, second.MigratedQuota)
		require.NoError(t, db.Select("quota", "aff_quota").First(&storedInviter, inviter.Id).Error)
		assert.EqualValues(t, 1700, storedInviter.Quota)
		assert.Zero(t, storedInviter.AffQuota)

		// Without the marker a rerun still cannot import the account twice:
		// the per-account ledger reference is already claimed.
		require.NoError(t, db.Where(&Option{Key: referralLegacyMigrationOptionKey}).Delete(&Option{}).Error)
		require.NoError(t, db.Model(&User{}).Where("id = ?", inviter.Id).UpdateColumn("aff_quota", 50).Error)
		third, err := MigrateLegacyReferralData()
		require.NoError(t, err)
		assert.True(t, third.Completed)
		assert.Zero(t, third.MigratedUsers)
		assert.EqualValues(t, 1, third.SkippedUsers)
		require.NoError(t, db.Select("quota", "aff_quota").First(&storedInviter, inviter.Id).Error)
		assert.EqualValues(t, 1700, storedInviter.Quota)
		assert.EqualValues(t, 50, storedInviter.AffQuota)
		var migrationRows int64
		require.NoError(t, db.Model(&WalletLedgerEntry{}).
			Where("ref_type = ? AND user_id = ?", WalletLedgerRefAffiliateMigration, inviter.Id).
			Count(&migrationRows).Error)
		assert.EqualValues(t, 1, migrationRows)
	})
}

// A balance the wallet cap refuses stays in the legacy counter: the account is
// counted as failed, the marker stays absent so a later attempt retries it, and
// the remaining accounts are still imported exactly once.
func TestLegacyReferralImportContainsFailuresMatrix(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		setupLegacyReferralTest(t, db)

		healthy := createReferralCommissionTestUser(t, db, "legacy-healthy", "default")
		setLegacyAffiliateQuota(t, db, healthy.Id, 400, 400)
		oversized := createReferralCommissionTestUser(t, db, "legacy-oversized", "default")
		setLegacyAffiliateQuota(t, db, oversized.Id, common.MaxWalletQuota+1, 0)

		result, err := MigrateLegacyReferralData()
		require.NoError(t, err)
		assert.False(t, result.Completed)
		assert.EqualValues(t, 1, result.MigratedUsers)
		assert.EqualValues(t, 400, result.MigratedQuota)
		assert.EqualValues(t, 1, result.FailedUsers)

		var storedOversized User
		require.NoError(t, db.Select("quota", "aff_quota").First(&storedOversized, oversized.Id).Error)
		assert.EqualValues(t, 1000, storedOversized.Quota)
		assert.EqualValues(t, common.MaxWalletQuota+1, storedOversized.AffQuota)
		var oversizedRows int64
		require.NoError(t, db.Model(&WalletLedgerEntry{}).
			Where("ref_type = ? AND user_id = ?", WalletLedgerRefAffiliateMigration, oversized.Id).
			Count(&oversizedRows).Error)
		assert.Zero(t, oversizedRows)
		var oversizedGrants int64
		require.NoError(t, db.Model(&CreditGrant{}).Where("user_id = ?", oversized.Id).Count(&oversizedGrants).Error)
		assert.Zero(t, oversizedGrants)
		var markerCount int64
		require.NoError(t, db.Model(&Option{}).Where(&Option{Key: referralLegacyMigrationOptionKey}).Count(&markerCount).Error)
		assert.Zero(t, markerCount)

		retry, err := MigrateLegacyReferralData()
		require.NoError(t, err)
		assert.False(t, retry.Completed)
		assert.Zero(t, retry.MigratedUsers)
		assert.Zero(t, retry.SkippedUsers)
		assert.EqualValues(t, 1, retry.FailedUsers)
	})
}

// The manual transfer is one ledger transaction keyed by the client request id:
// the first call moves the quota, and every replay of the same request reports
// success without a second movement, even after the balance was spent. Every
// amount stays above the production minimum of one common.QuotaPerUnit.
func TestAffiliateTransferIdempotencyMatrix(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		setupLegacyReferralTest(t, db)

		fixture := createReferralCommissionTestUser(t, db, "transfer-user", "default")
		setLegacyAffiliateQuota(t, db, fixture.Id, 2_000_000, 2_000_000)
		var user User
		require.NoError(t, db.First(&user, fixture.Id).Error)

		require.NoError(t, user.TransferAffQuotaToQuota(600_000, "req-1"))
		assert.EqualValues(t, 1_400_000, user.AffQuota)
		assert.EqualValues(t, 601_000, user.Quota)

		var stored User
		require.NoError(t, db.Select("quota", "aff_quota").First(&stored, fixture.Id).Error)
		assert.EqualValues(t, 601_000, stored.Quota)
		assert.EqualValues(t, 1_400_000, stored.AffQuota)

		var entry WalletLedgerEntry
		require.NoError(t, db.Where("ref_type = ? AND ref_id = ?", WalletLedgerRefAffiliate, fmt.Sprintf("%d:req-1", fixture.Id)).First(&entry).Error)
		assert.Equal(t, WalletLedgerKindAffiliateTransfer, entry.Kind)
		assert.EqualValues(t, 600_000, entry.Amount)
		assert.EqualValues(t, 601_000, entry.BalanceAfter)
		assert.Equal(t, grantLedgerMeta(operation_setting.CreditGrantSourceInvite, 0), entry.Meta)

		var grant CreditGrant
		require.NoError(t, db.Where("user_id = ?", fixture.Id).First(&grant).Error)
		assert.Equal(t, operation_setting.CreditGrantSourceInvite, grant.Source)
		assert.EqualValues(t, 600_000, grant.Amount)
		assert.EqualValues(t, 600_000, grant.Remaining)
		assert.Zero(t, grant.ExpiresAt)

		// Replaying the same request reports success without a second movement
		// and without a second grant.
		require.NoError(t, user.TransferAffQuotaToQuota(600_000, "req-1"))
		require.NoError(t, db.Select("quota", "aff_quota").First(&stored, fixture.Id).Error)
		assert.EqualValues(t, 601_000, stored.Quota)
		assert.EqualValues(t, 1_400_000, stored.AffQuota)
		var transferRows int64
		require.NoError(t, db.Model(&WalletLedgerEntry{}).
			Where("ref_type = ? AND user_id = ?", WalletLedgerRefAffiliate, fixture.Id).
			Count(&transferRows).Error)
		assert.EqualValues(t, 1, transferRows)
		var grantRows int64
		require.NoError(t, db.Model(&CreditGrant{}).Where("user_id = ?", fixture.Id).Count(&grantRows).Error)
		assert.EqualValues(t, 1, grantRows)

		// A replay still succeeds after the balance was spent, because the
		// reference check runs before the balance check.
		require.NoError(t, user.TransferAffQuotaToQuota(1_400_000, "req-2"))
		require.NoError(t, db.Select("quota", "aff_quota").First(&stored, fixture.Id).Error)
		assert.EqualValues(t, 2_001_000, stored.Quota)
		assert.Zero(t, stored.AffQuota)
		require.NoError(t, user.TransferAffQuotaToQuota(600_000, "req-1"))
		require.NoError(t, db.Select("quota", "aff_quota").First(&stored, fixture.Id).Error)
		assert.EqualValues(t, 2_001_000, stored.Quota)
		assert.Zero(t, stored.AffQuota)

		// Insufficient invitation quota is refused without a ledger claim.
		err := user.TransferAffQuotaToQuota(600_000, "req-3")
		var message *common.Message
		require.ErrorAs(t, err, &message)
		assert.Equal(t, "Invitation quota is insufficient!", message.Key)
		var refusedRows int64
		require.NoError(t, db.Model(&WalletLedgerEntry{}).
			Where("ref_type = ? AND ref_id = ?", WalletLedgerRefAffiliate, fmt.Sprintf("%d:req-3", fixture.Id)).
			Count(&refusedRows).Error)
		assert.Zero(t, refusedRows)

		// A malformed request id and a request below the minimum are refused
		// before any database work.
		err = user.TransferAffQuotaToQuota(600_000, "bad id!")
		require.ErrorAs(t, err, &message)
		assert.Equal(t, "Invalid parameters", message.Key)
		err = user.TransferAffQuotaToQuota(10, "req-min")
		require.ErrorAs(t, err, &message)
		assert.Equal(t, "Minimum transfer quota is {{min}}!", message.Key)

		// Clients without a request id keep the historical behavior: a unique
		// random reference still moves the quota exactly once per call.
		require.NoError(t, db.Model(&User{}).Where("id = ?", fixture.Id).UpdateColumn("aff_quota", 700_000).Error)
		require.NoError(t, user.TransferAffQuotaToQuota(700_000, ""))
		require.NoError(t, db.Select("quota", "aff_quota").First(&stored, fixture.Id).Error)
		assert.EqualValues(t, 2_701_000, stored.Quota)
		assert.Zero(t, stored.AffQuota)
		require.NoError(t, db.Model(&WalletLedgerEntry{}).
			Where("ref_type = ? AND user_id = ?", WalletLedgerRefAffiliate, fixture.Id).
			Count(&transferRows).Error)
		assert.EqualValues(t, 3, transferRows)
		assert.EqualValues(t, 2_701_000, legacyLedgerSum(t, db, fixture.Id))
	})
}

// The reconciliation reports the import, the balances still waiting for a
// manual transfer, relations that still only exist in the mirror column, and a
// capped list of integrity anomalies — without changing any balance.
func TestLegacyReferralReconciliationMatrix(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		setupLegacyReferralTest(t, db)

		clean := createReferralCommissionTestUser(t, db, "reco-clean", "default")
		negative := createReferralCommissionTestUser(t, db, "reco-negative", "default")
		missingGrant := createReferralCommissionTestUser(t, db, "reco-missing-grant", "default")
		mismatchedGrant := createReferralCommissionTestUser(t, db, "reco-mismatch", "default")
		deviation := createReferralCommissionTestUser(t, db, "reco-deviation", "default")
		setLegacyAffiliateQuota(t, db, clean.Id, 700, 700)
		setLegacyAffiliateQuota(t, db, negative.Id, -5, 0)
		setLegacyAffiliateQuota(t, db, missingGrant.Id, 500, 500)
		setLegacyAffiliateQuota(t, db, mismatchedGrant.Id, 300, 300)
		setLegacyAffiliateQuota(t, db, deviation.Id, 200, 200)

		result, err := MigrateLegacyReferralData()
		require.NoError(t, err)
		require.True(t, result.Completed)

		// Break three migrated accounts one way each: a deleted grant, a grant
		// whose amount no longer matches its ledger row, and a wallet whose
		// balance no longer matches its ledger sum.
		require.NoError(t, db.Where("user_id = ?", missingGrant.Id).Delete(&CreditGrant{}).Error)
		require.NoError(t, db.Model(&CreditGrant{}).Where("user_id = ?", mismatchedGrant.Id).UpdateColumn("amount", 999).Error)
		require.NoError(t, db.Model(&User{}).Where("id = ?", deviation.Id).UpdateColumn("quota", gorm.Expr("quota + ?", 7)).Error)

		// A runtime accrual that arrived after the import stays pending until
		// its owner transfers it; a relation that still only exists in the
		// mirror column is counted too.
		pending := createReferralCommissionTestUser(t, db, "reco-pending", "default")
		setLegacyAffiliateQuota(t, db, pending.Id, 120, 120)
		unbound := createReferralCommissionTestUser(t, db, "reco-unbound", "default")
		require.NoError(t, db.Model(&User{}).Where("id = ?", unbound.Id).UpdateColumn("inviter_id", clean.Id).Error)

		type balanceSnapshot struct {
			Quota    int
			AffQuota int
		}
		snapshot := map[int]balanceSnapshot{}
		var scanUsers []User
		require.NoError(t, db.Select("id", "quota", "aff_quota").Find(&scanUsers).Error)
		for _, scanUser := range scanUsers {
			snapshot[scanUser.Id] = balanceSnapshot{Quota: scanUser.Quota, AffQuota: scanUser.AffQuota}
		}

		report, err := ReconcileLegacyReferralData(50)
		require.NoError(t, err)
		assert.True(t, report.MigrationDone)
		assert.EqualValues(t, 4, report.MigratedUsers)
		assert.EqualValues(t, 1700, report.MigratedQuota)
		assert.EqualValues(t, 1, report.PendingUsers)
		assert.EqualValues(t, 120, report.PendingQuota)
		assert.EqualValues(t, 1, report.UnboundInvitees)
		assert.EqualValues(t, 4, report.AnomalyCount)

		reasons := map[int]string{}
		for _, anomaly := range report.Anomalies {
			reasons[anomaly.UserId] = anomaly.Reason
			if anomaly.UserId == deviation.Id {
				assert.EqualValues(t, -7, anomaly.Deviation)
			}
		}
		assert.Equal(t, LegacyReferralReasonNegativeBalance, reasons[negative.Id])
		assert.Equal(t, LegacyReferralReasonGrantMissing, reasons[missingGrant.Id])
		assert.Equal(t, LegacyReferralReasonGrantMismatch, reasons[mismatchedGrant.Id])
		assert.Equal(t, LegacyReferralReasonLedgerDeviation, reasons[deviation.Id])
		assert.NotContains(t, reasons, clean.Id)
		assert.NotContains(t, reasons, pending.Id)

		// The audit never modifies a balance.
		var after []User
		require.NoError(t, db.Select("id", "quota", "aff_quota").Find(&after).Error)
		require.Len(t, after, len(snapshot))
		for _, afterUser := range after {
			assert.Equal(t, snapshot[afterUser.Id], balanceSnapshot{Quota: afterUser.Quota, AffQuota: afterUser.AffQuota}, "user %d", afterUser.Id)
		}

		// The listed anomalies are capped; the reported count stays complete.
		capped, err := ReconcileLegacyReferralData(2)
		require.NoError(t, err)
		assert.EqualValues(t, 4, capped.AnomalyCount)
		assert.Len(t, capped.Anomalies, 2)
	})
}
