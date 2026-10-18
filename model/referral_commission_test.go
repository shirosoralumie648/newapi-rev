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
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// setupReferralCommissionTest prepares the isolated database and restores the
// commission configuration after the scenario. The baseline configuration is
// applied by restoreReferralCommissionTestSetting and can be adjusted through
// operation_setting.GetReferralSetting inside a scenario.
func setupReferralCommissionTest(t *testing.T, db *gorm.DB) {
	t.Helper()
	require.NoError(t, db.AutoMigrate(&TopUp{}, &Redemption{}, &ReferralBinding{}, &ReferralCommission{}))
	t.Cleanup(func() {
		require.NoError(t, db.Migrator().DropTable(&TopUp{}, &Redemption{}, &ReferralBinding{}, &ReferralCommission{}))
	})
	confirmPaymentComplianceForTest(t)
	previousQuotaPerUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 500000
	previous := *operation_setting.GetReferralSetting()
	restoreReferralCommissionTestSetting()
	t.Cleanup(func() {
		common.QuotaPerUnit = previousQuotaPerUnit
		*operation_setting.GetReferralSetting() = previous
	})
}

// restoreReferralCommissionTestSetting returns the commission configuration to
// the scenario baseline: engine on, 10 percent default rate, the default
// trigger window, no group overrides and redemption codes excluded.
func restoreReferralCommissionTestSetting() {
	*operation_setting.GetReferralSetting() = operation_setting.ReferralSetting{
		Enabled:               true,
		CommissionRatePercent: 10,
		WindowMonths:          operation_setting.ReferralWindowMonthsDefault,
	}
}

// createReferralCommissionTestUser creates one wallet fixture with a seeded
// opening balance so the ledger identity (sum of entries = balance) is
// checkable for every account the scenario touches.
func createReferralCommissionTestUser(t *testing.T, db *gorm.DB, username string, group string) *User {
	t.Helper()
	user := &User{
		Username: username,
		Password: "password",
		AffCode:  username,
		Quota:    1000,
		Group:    group,
		Status:   common.UserStatusEnabled,
	}
	createWalletLedgerWallet(t, db, user)
	return user
}

// bindReferralCommissionTestInviter records the invitation relation of a
// fixture account through the production binding API.
func bindReferralCommissionTestInviter(t *testing.T, invitee *User, inviterId int) {
	t.Helper()
	require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
		_, err := CreateReferralBindingWithTx(tx, invitee, inviterId, ReferralSourceCode)
		return err
	}))
}

// completeReferralCommissionTestTopUp completes one pending epay order through
// the real settlement path, so the commission hook runs exactly where
// production runs it.
func completeReferralCommissionTestTopUp(t *testing.T, tradeNo string, userId int, amount int64) {
	t.Helper()
	order := &TopUp{
		UserId:          userId,
		Amount:          amount,
		Money:           float64(amount),
		TradeNo:         tradeNo,
		PaymentMethod:   PaymentProviderEpay,
		PaymentProvider: PaymentProviderEpay,
		CreateTime:      common.GetTimestamp(),
		Status:          common.TopUpStatusPending,
	}
	require.NoError(t, DB.Create(order).Error)
	alreadyDone, err := RechargeEpay(tradeNo, "", "127.0.0.1")
	require.NoError(t, err)
	require.False(t, alreadyDone)
}

// createReferralCommissionTestRedemption creates one unused quota code.
func createReferralCommissionTestRedemption(t *testing.T, key string, quota int) *Redemption {
	t.Helper()
	code := &Redemption{
		Key:         key,
		Name:        "referral commission code",
		Status:      common.RedemptionCodeStatusEnabled,
		Quota:       quota,
		Type:        RedemptionTypeQuota,
		CreatedTime: common.GetTimestamp(),
	}
	require.NoError(t, DB.Create(code).Error)
	return code
}

func countReferralCommissionsFor(t *testing.T, inviteeId int) int64 {
	t.Helper()
	var count int64
	require.NoError(t, DB.Model(&ReferralCommission{}).Where("invitee_id = ?", inviteeId).Count(&count).Error)
	return count
}

func loadReferralCommissionsByRef(t *testing.T, refType string, refId string) []ReferralCommission {
	t.Helper()
	var commissions []ReferralCommission
	require.NoError(t, DB.Where("ref_type = ? AND ref_id = ?", refType, refId).Order("id").Find(&commissions).Error)
	return commissions
}

// The commission engine records one single-level event per paid order of an
// invitee whose inviter is still eligible and inside the trigger window, never
// moves a balance, and never commissions one reference twice.
func TestReferralCommissionEngine(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		setupReferralCommissionTest(t, db)

		t.Run("records one commission per paid order without moving balances", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			inviter := createReferralCommissionTestUser(t, db, "c-a-inviter", "default")
			invitee := createReferralCommissionTestUser(t, db, "c-a-invitee", "default")
			bindReferralCommissionTestInviter(t, invitee, inviter.Id)

			completeReferralCommissionTestTopUp(t, "c-a-order", invitee.Id, 10)

			commissions := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "c-a-order")
			require.Len(t, commissions, 1)
			commission := commissions[0]
			assert.Equal(t, inviter.Id, commission.InviterId)
			assert.Equal(t, invitee.Id, commission.InviteeId)
			assert.Equal(t, ReferralCommissionSourceTopUp, commission.Source)
			assert.EqualValues(t, 10*500000, commission.BaseQuota)
			assert.Equal(t, "10", commission.RatePercent)
			assert.EqualValues(t, 500000, commission.CommissionQuota)
			assert.Equal(t, ReferralCommissionStatusPending, commission.Status)

			// The event records money owed and moves none: the inviter earns
			// no quota and its ledger identity still holds.
			var reloaded User
			require.NoError(t, DB.Select("id", "quota").First(&reloaded, inviter.Id).Error)
			assert.Equal(t, inviter.Quota, reloaded.Quota)
			reconciliation, err := ReconcileWalletLedgerForUser(inviter.Id)
			require.NoError(t, err)
			assert.True(t, reconciliation.Reconciled)

			// A replayed payment webhook settles once and commissions once.
			alreadyDone, err := RechargeEpay("c-a-order", "", "127.0.0.1")
			require.NoError(t, err)
			assert.True(t, alreadyDone)
			assert.Len(t, loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "c-a-order"), 1)
		})

		t.Run("bounds commissions by the trigger window", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			inviter := createReferralCommissionTestUser(t, db, "c-b-inviter", "default")
			invitee := createReferralCommissionTestUser(t, db, "c-b-invitee", "default")
			bindReferralCommissionTestInviter(t, invitee, inviter.Id)

			// The default window ends twelve months after registration.
			registeredLongAgo := time.Unix(common.GetTimestamp(), 0).AddDate(0, -13, 0).Unix()
			require.NoError(t, DB.Model(&User{}).Where("id = ?", invitee.Id).Update("created_at", registeredLongAgo).Error)
			completeReferralCommissionTestTopUp(t, "c-b-old", invitee.Id, 10)
			assert.Zero(t, countReferralCommissionsFor(t, invitee.Id))

			// -1 keeps the engine rewarding every order forever.
			operation_setting.GetReferralSetting().WindowMonths = operation_setting.ReferralWindowMonthsUnlimited
			completeReferralCommissionTestTopUp(t, "c-b-forever", invitee.Id, 10)
			assert.EqualValues(t, 1, countReferralCommissionsFor(t, invitee.Id))

			// 0 keeps only the first paid order of each invitee.
			operation_setting.GetReferralSetting().WindowMonths = operation_setting.ReferralWindowMonthsFirstTopUp
			freshInvitee := createReferralCommissionTestUser(t, db, "c-b-fresh", "default")
			bindReferralCommissionTestInviter(t, freshInvitee, inviter.Id)
			completeReferralCommissionTestTopUp(t, "c-b-first-1", freshInvitee.Id, 10)
			assert.EqualValues(t, 1, countReferralCommissionsFor(t, freshInvitee.Id))
			completeReferralCommissionTestTopUp(t, "c-b-first-2", freshInvitee.Id, 10)
			assert.EqualValues(t, 1, countReferralCommissionsFor(t, freshInvitee.Id), "window 0 must keep only the first paid order")
		})

		t.Run("resolves the rate from the group override and honors the master switches", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			setting := operation_setting.GetReferralSetting()
			setting.GroupRateOverrides = map[string]float64{"vip": 25, "capped": 150, "broken": -1}

			inviter := createReferralCommissionTestUser(t, db, "c-c-inviter", "vip")
			invitee := createReferralCommissionTestUser(t, db, "c-c-invitee", "default")
			bindReferralCommissionTestInviter(t, invitee, inviter.Id)

			completeReferralCommissionTestTopUp(t, "c-c-order", invitee.Id, 10)
			commissions := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "c-c-order")
			require.Len(t, commissions, 1)
			assert.Equal(t, "25", commissions[0].RatePercent)
			assert.EqualValues(t, 1250000, commissions[0].CommissionQuota)

			assert.Equal(t, 25.0, setting.CommissionRatePercentFor("vip"))
			assert.Equal(t, 10.0, setting.CommissionRatePercentFor("default"))
			assert.Equal(t, 100.0, setting.CommissionRatePercentFor("capped"), "a rate above the cap must clamp")
			assert.Zero(t, setting.CommissionRatePercentFor("broken"), "a negative rate must resolve to zero")

			// The master switch stops new events.
			setting.Enabled = false
			secondInvitee := createReferralCommissionTestUser(t, db, "c-c-second", "default")
			bindReferralCommissionTestInviter(t, secondInvitee, inviter.Id)
			completeReferralCommissionTestTopUp(t, "c-c-disabled", secondInvitee.Id, 10)
			assert.Zero(t, countReferralCommissionsFor(t, secondInvitee.Id))

			// An unconfirmed compliance state stops them too.
			setting.Enabled = true
			payment := operation_setting.GetPaymentSetting()
			previousConfirmed := payment.ComplianceConfirmed
			payment.ComplianceConfirmed = false
			completeReferralCommissionTestTopUp(t, "c-c-unconfirmed", secondInvitee.Id, 10)
			assert.Zero(t, countReferralCommissionsFor(t, secondInvitee.Id))
			payment.ComplianceConfirmed = previousConfirmed
		})

		t.Run("redemption codes commission only when the switch is on", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			inviter := createReferralCommissionTestUser(t, db, "c-d-inviter", "default")
			invitee := createReferralCommissionTestUser(t, db, "c-d-invitee", "default")
			bindReferralCommissionTestInviter(t, invitee, inviter.Id)

			offCode := createReferralCommissionTestRedemption(t, fmt.Sprintf("%032d", 1), 200000)
			_, err := Redeem(offCode.Key, invitee.Id)
			require.NoError(t, err)
			assert.Zero(t, countReferralCommissionsFor(t, invitee.Id))

			operation_setting.GetReferralSetting().IncludeRedemptionCodes = true
			onCode := createReferralCommissionTestRedemption(t, fmt.Sprintf("%032d", 2), 200000)
			_, err = Redeem(onCode.Key, invitee.Id)
			require.NoError(t, err)
			commissions := loadReferralCommissionsByRef(t, WalletLedgerRefRedeem, fmt.Sprintf("%d", onCode.Id))
			require.Len(t, commissions, 1)
			assert.Equal(t, ReferralCommissionSourceRedeem, commissions[0].Source)
			assert.EqualValues(t, 200000, commissions[0].BaseQuota)
			assert.EqualValues(t, 20000, commissions[0].CommissionQuota)

			// A reused code cannot commission twice.
			_, err = Redeem(onCode.Key, invitee.Id)
			require.Error(t, err)
			assert.Len(t, loadReferralCommissionsByRef(t, WalletLedgerRefRedeem, fmt.Sprintf("%d", onCode.Id)), 1)
		})

		t.Run("a duplicate reference is a replay", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			inviter := createReferralCommissionTestUser(t, db, "c-e-inviter", "default")
			invitee := createReferralCommissionTestUser(t, db, "c-e-invitee", "default")
			bindReferralCommissionTestInviter(t, invitee, inviter.Id)

			var recorded *ReferralCommission
			require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
				var err error
				recorded, err = RecordReferralCommissionTx(tx, invitee.Id, ReferralCommissionSourceTopUp, 100000, WalletLedgerRefTopUp, "c-e-order")
				return err
			}))
			require.NotNil(t, recorded)

			// The same order entering the engine again (a replay that bypassed
			// the ledger) is claimed by the recorded reference and must not
			// change the amount.
			var replayed *ReferralCommission
			require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
				var err error
				replayed, err = RecordReferralCommissionTx(tx, invitee.Id, ReferralCommissionSourceTopUp, 990000, WalletLedgerRefTopUp, "c-e-order")
				return err
			}))
			assert.Nil(t, replayed)

			// The unique index, not only the replay check, claims the
			// reference on every engine.
			duplicate := &ReferralCommission{
				InviterId:       inviter.Id,
				InviteeId:       invitee.Id,
				Source:          ReferralCommissionSourceTopUp,
				RefType:         WalletLedgerRefTopUp,
				RefId:           "c-e-order",
				BaseQuota:       1,
				RatePercent:     "10",
				CommissionQuota: 1,
				Status:          ReferralCommissionStatusPending,
				CreatedAt:       common.GetTimestamp(),
				UpdatedAt:       common.GetTimestamp(),
			}
			assert.Error(t, DB.Create(duplicate).Error)

			commissions := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "c-e-order")
			require.Len(t, commissions, 1)
			assert.EqualValues(t, 100000, commissions[0].BaseQuota, "the first event must win")
		})

		t.Run("unbound invitees and ineligible inviters earn nothing", func(t *testing.T) {
			restoreReferralCommissionTestSetting()

			unbound := createReferralCommissionTestUser(t, db, "c-f-unbound", "default")
			completeReferralCommissionTestTopUp(t, "c-f-unbound", unbound.Id, 10)
			assert.Zero(t, countReferralCommissionsFor(t, unbound.Id))

			disabledInviter := createReferralCommissionTestUser(t, db, "c-f-dis-inviter", "default")
			disabledInvitee := createReferralCommissionTestUser(t, db, "c-f-dis-invitee", "default")
			bindReferralCommissionTestInviter(t, disabledInvitee, disabledInviter.Id)
			require.NoError(t, DB.Model(&User{}).Where("id = ?", disabledInviter.Id).Update("status", common.UserStatusDisabled).Error)
			completeReferralCommissionTestTopUp(t, "c-f-disabled", disabledInvitee.Id, 10)
			assert.Zero(t, countReferralCommissionsFor(t, disabledInvitee.Id))

			deletedInviter := createReferralCommissionTestUser(t, db, "c-f-del-inviter", "default")
			deletedInvitee := createReferralCommissionTestUser(t, db, "c-f-del-invitee", "default")
			bindReferralCommissionTestInviter(t, deletedInvitee, deletedInviter.Id)
			require.NoError(t, DB.Delete(&User{Id: deletedInviter.Id}).Error)
			completeReferralCommissionTestTopUp(t, "c-f-deleted", deletedInvitee.Id, 10)
			assert.Zero(t, countReferralCommissionsFor(t, deletedInvitee.Id))
		})
	})
}

// The window counts whole calendar months from registration, like subscription
// durations.
func TestReferralCommissionWindowEnd(t *testing.T) {
	registered := time.Date(2026, time.June, 15, 8, 0, 0, 0, time.Local)
	assert.Equal(
		t,
		time.Date(2027, time.June, 15, 8, 0, 0, 0, time.Local).Unix(),
		referralCommissionWindowEnd(registered.Unix(), 12),
	)
}

// Commission settings are validated before they are persisted: rates stay
// within the supported range, the window accepts only its documented values,
// and enabling the engine or cash settlement requires the confirmed payment
// compliance terms.
func TestReferralCommissionOptionValidation(t *testing.T) {
	confirmPaymentComplianceForTest(t)

	require.NoError(t, operation_setting.ValidateReferralOption("referral_setting.enabled", "false"))
	require.NoError(t, operation_setting.ValidateReferralOption("referral_setting.enabled", "true"))

	rateCases := []struct {
		value   string
		wantErr bool
	}{
		{"0", false},
		{"12.5", false},
		{"100", false},
		{"100.01", true},
		{"-1", true},
		{"abc", true},
	}
	for _, tc := range rateCases {
		err := operation_setting.ValidateReferralOption("referral_setting.commission_rate_percent", tc.value)
		if tc.wantErr {
			assert.Error(t, err, "rate %q must be rejected", tc.value)
		} else {
			assert.NoError(t, err, "rate %q must be accepted", tc.value)
		}
	}

	windowCases := []struct {
		value   string
		wantErr bool
	}{
		{"0", false},
		{"1", false},
		{"12", false},
		{"120", false},
		{"-1", false},
		{"-2", true},
		{"121", true},
		{"year", true},
	}
	for _, tc := range windowCases {
		err := operation_setting.ValidateReferralOption("referral_setting.window_months", tc.value)
		if tc.wantErr {
			assert.Error(t, err, "window %q must be rejected", tc.value)
		} else {
			assert.NoError(t, err, "window %q must be accepted", tc.value)
		}
	}

	overrideCases := []struct {
		value   string
		wantErr bool
	}{
		{"", false},
		{"{}", false},
		{`{"vip": 25}`, false},
		{`{"": 5}`, true},
		{`{"vip": 101}`, true},
		{`{"vip": -1}`, true},
		{`[25]`, true},
		{`not json`, true},
	}
	for _, tc := range overrideCases {
		err := operation_setting.ValidateReferralOption("referral_setting.group_rate_overrides", tc.value)
		if tc.wantErr {
			assert.Error(t, err, "overrides %q must be rejected", tc.value)
		} else {
			assert.NoError(t, err, "overrides %q must be accepted", tc.value)
		}
	}

	require.NoError(t, operation_setting.ValidateReferralOption("referral_setting.include_redemption_codes", "true"))
	require.Error(t, operation_setting.ValidateReferralOption("referral_setting.include_redemption_codes", "yes"))

	payment := operation_setting.GetPaymentSetting()
	previousConfirmed := payment.ComplianceConfirmed
	payment.ComplianceConfirmed = false
	assert.Error(t, operation_setting.ValidateReferralOption("referral_setting.enabled", "true"), "enabling the engine requires the compliance terms")
	assert.Error(t, operation_setting.ValidateReferralOption("referral_setting.cash_settlement_enabled", "true"), "enabling cash settlement requires the compliance terms")
	payment.ComplianceConfirmed = previousConfirmed
	assert.NoError(t, operation_setting.ValidateReferralOption("referral_setting.cash_settlement_enabled", "true"))
}
