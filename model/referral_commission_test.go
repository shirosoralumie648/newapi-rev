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
	require.NoError(t, db.AutoMigrate(&TopUp{}, &Redemption{}, &ReferralBinding{}, &ReferralCommission{},
		&ReferralRegistrationSignal{}, &ReferralIdentity{}, &ReferralFlag{}))
	t.Cleanup(func() {
		require.NoError(t, db.Migrator().DropTable(&TopUp{}, &Redemption{}, &ReferralBinding{}, &ReferralCommission{},
			&ReferralRegistrationSignal{}, &ReferralIdentity{}, &ReferralFlag{}))
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

// recordReferralCommissionTestSignal seeds the registration environment of a
// fixture account through the production hashing and domain helpers.
func recordReferralCommissionTestSignal(t *testing.T, userId int, ip string, deviceId string, emailDomain string) {
	t.Helper()
	require.NoError(t, DB.Create(&ReferralRegistrationSignal{
		UserId:      userId,
		Ip:          ip,
		DeviceHash:  hashReferralDeviceId(deviceId),
		EmailDomain: emailDomain,
		UserAgent:   "referral-test-agent/1.0",
		CreatedAt:   common.GetTimestamp(),
	}).Error)
}

// setReferralCommissionTestIdentity records a verified real-name identity on a
// fixture account through the production API.
func setReferralCommissionTestIdentity(t *testing.T, userId int, identity string) {
	t.Helper()
	_, err := SetReferralIdentity(userId, identity)
	require.NoError(t, err)
}

// setReferralCommissionTestFlag sets an anti-abuse mark on a fixture account
// through the production API.
func setReferralCommissionTestFlag(t *testing.T, userId int, level string) {
	t.Helper()
	_, err := SetReferralFlag(userId, level, "referral test "+level, 1)
	require.NoError(t, err)
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

// RF-06: the commission engine refuses payouts of farmed invitations and
// oversized rewards. Every refused event is still recorded with its reason and
// the would-be amount, so the decision stays auditable.
func TestReferralCommissionAntiAbuse(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		setupReferralCommissionTest(t, db)

		t.Run("blocks commissions of a shared real-name identity", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			inviter := createReferralCommissionTestUser(t, db, "aa-a-inviter", "default")
			invitee := createReferralCommissionTestUser(t, db, "aa-a-invitee", "default")
			bindReferralCommissionTestInviter(t, invitee, inviter.Id)
			setReferralCommissionTestIdentity(t, inviter.Id, "ID-A-0001")
			setReferralCommissionTestIdentity(t, invitee.Id, "ID-A-0001")

			completeReferralCommissionTestTopUp(t, "aa-a-order", invitee.Id, 10)

			commissions := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-a-order")
			require.Len(t, commissions, 1)
			assert.Equal(t, ReferralCommissionStatusBlocked, commissions[0].Status)
			assert.Equal(t, ReferralCommissionReasonSelfInvite, commissions[0].Reason)
			assert.EqualValues(t, 500000, commissions[0].CommissionQuota, "the would-be amount stays for the audit trail")
		})

		t.Run("pays one canonical account per real-name identity", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			inviter := createReferralCommissionTestUser(t, db, "aa-b-inviter", "default")
			first := createReferralCommissionTestUser(t, db, "aa-b-first", "default")
			second := createReferralCommissionTestUser(t, db, "aa-b-second", "default")
			bindReferralCommissionTestInviter(t, first, inviter.Id)
			bindReferralCommissionTestInviter(t, second, inviter.Id)
			setReferralCommissionTestIdentity(t, first.Id, "ID-B-0002")
			setReferralCommissionTestIdentity(t, second.Id, "ID-B-0002")

			completeReferralCommissionTestTopUp(t, "aa-b-first-order", first.Id, 10)
			completeReferralCommissionTestTopUp(t, "aa-b-second-order", second.Id, 10)

			firstCommission := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-b-first-order")
			require.Len(t, firstCommission, 1)
			assert.Equal(t, ReferralCommissionStatusPending, firstCommission[0].Status, "the smallest user id is the canonical account")
			blocked := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-b-second-order")
			require.Len(t, blocked, 1)
			assert.Equal(t, ReferralCommissionStatusBlocked, blocked[0].Status)
			assert.Equal(t, ReferralCommissionReasonDuplicateIdentity, blocked[0].Reason)

			// A duplicate identity cannot earn as an inviter either.
			duplicateInviter := createReferralCommissionTestUser(t, db, "aa-b-dup-inviter", "default")
			duplicateInvitee := createReferralCommissionTestUser(t, db, "aa-b-dup-invitee", "default")
			bindReferralCommissionTestInviter(t, duplicateInvitee, duplicateInviter.Id)
			setReferralCommissionTestIdentity(t, duplicateInviter.Id, "ID-B-0002")
			completeReferralCommissionTestTopUp(t, "aa-b-dup-order", duplicateInvitee.Id, 10)
			paid := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-b-dup-order")
			require.Len(t, paid, 1)
			assert.Equal(t, ReferralCommissionStatusBlocked, paid[0].Status)
			assert.Equal(t, ReferralCommissionReasonDuplicateIdentity, paid[0].Reason)
		})

		t.Run("requires a recorded identity when configured", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			operation_setting.GetReferralSetting().RequireRealName = true
			inviter := createReferralCommissionTestUser(t, db, "aa-c-inviter", "default")
			invitee := createReferralCommissionTestUser(t, db, "aa-c-invitee", "default")
			bindReferralCommissionTestInviter(t, invitee, inviter.Id)

			completeReferralCommissionTestTopUp(t, "aa-c-before", invitee.Id, 10)
			blocked := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-c-before")
			require.Len(t, blocked, 1)
			assert.Equal(t, ReferralCommissionStatusBlocked, blocked[0].Status)
			assert.Equal(t, ReferralCommissionReasonRealNameRequired, blocked[0].Reason)

			setReferralCommissionTestIdentity(t, inviter.Id, "ID-C-0003")
			completeReferralCommissionTestTopUp(t, "aa-c-after", invitee.Id, 10)
			paid := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-c-after")
			require.Len(t, paid, 1)
			assert.Equal(t, ReferralCommissionStatusPending, paid[0].Status)
		})

		t.Run("freezes payouts in both directions until cleared", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			inviter := createReferralCommissionTestUser(t, db, "aa-d-inviter", "default")
			invitee := createReferralCommissionTestUser(t, db, "aa-d-invitee", "default")
			bindReferralCommissionTestInviter(t, invitee, inviter.Id)

			setReferralCommissionTestFlag(t, inviter.Id, ReferralFlagLevelFrozen)
			completeReferralCommissionTestTopUp(t, "aa-d-frozen-inviter", invitee.Id, 10)
			blocked := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-d-frozen-inviter")
			require.Len(t, blocked, 1)
			assert.Equal(t, ReferralCommissionReasonFrozenInviter, blocked[0].Reason)

			setReferralCommissionTestFlag(t, inviter.Id, ReferralFlagLevelClear)
			setReferralCommissionTestFlag(t, invitee.Id, ReferralFlagLevelFrozen)
			completeReferralCommissionTestTopUp(t, "aa-d-frozen-invitee", invitee.Id, 10)
			blocked = loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-d-frozen-invitee")
			require.Len(t, blocked, 1)
			assert.Equal(t, ReferralCommissionReasonFrozenInvitee, blocked[0].Reason)

			setReferralCommissionTestFlag(t, invitee.Id, ReferralFlagLevelClear)
			completeReferralCommissionTestTopUp(t, "aa-d-cleared", invitee.Id, 10)
			paid := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-d-cleared")
			require.Len(t, paid, 1)
			assert.Equal(t, ReferralCommissionStatusPending, paid[0].Status)
		})

		t.Run("bounds effective invitations by registration signal", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			setting := operation_setting.GetReferralSetting()
			setting.InviteLimitPerIP = 1

			ipInviter := createReferralCommissionTestUser(t, db, "aa-e-ip-inviter", "default")
			ipFirst := createReferralCommissionTestUser(t, db, "aa-e-ip-first", "default")
			ipSecond := createReferralCommissionTestUser(t, db, "aa-e-ip-second", "default")
			ipThird := createReferralCommissionTestUser(t, db, "aa-e-ip-third", "default")
			bindReferralCommissionTestInviter(t, ipFirst, ipInviter.Id)
			bindReferralCommissionTestInviter(t, ipSecond, ipInviter.Id)
			bindReferralCommissionTestInviter(t, ipThird, ipInviter.Id)
			recordReferralCommissionTestSignal(t, ipFirst.Id, "203.0.113.10", "aa-e-device-1", "one.example.com")
			recordReferralCommissionTestSignal(t, ipSecond.Id, "203.0.113.10", "aa-e-device-2", "two.example.com")
			recordReferralCommissionTestSignal(t, ipThird.Id, "203.0.113.11", "aa-e-device-3", "three.example.com")

			completeReferralCommissionTestTopUp(t, "aa-e-ip-first", ipFirst.Id, 10)
			completeReferralCommissionTestTopUp(t, "aa-e-ip-second", ipSecond.Id, 10)
			completeReferralCommissionTestTopUp(t, "aa-e-ip-third", ipThird.Id, 10)
			assert.Equal(t, ReferralCommissionStatusPending, loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-e-ip-first")[0].Status)
			blocked := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-e-ip-second")
			require.Len(t, blocked, 1)
			assert.Equal(t, ReferralCommissionStatusBlocked, blocked[0].Status)
			assert.Equal(t, ReferralCommissionReasonInviteLimitIP, blocked[0].Reason)
			assert.Equal(t, ReferralCommissionStatusPending, loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-e-ip-third")[0].Status, "a different signal value is not limited")

			setting.InviteLimitPerIP = 0
			setting.InviteLimitPerDevice = 1
			deviceInviter := createReferralCommissionTestUser(t, db, "aa-e-dev-inviter", "default")
			deviceFirst := createReferralCommissionTestUser(t, db, "aa-e-dev-first", "default")
			deviceSecond := createReferralCommissionTestUser(t, db, "aa-e-dev-second", "default")
			bindReferralCommissionTestInviter(t, deviceFirst, deviceInviter.Id)
			bindReferralCommissionTestInviter(t, deviceSecond, deviceInviter.Id)
			recordReferralCommissionTestSignal(t, deviceFirst.Id, "203.0.113.20", "aa-e-shared-device", "dev-one.example.com")
			recordReferralCommissionTestSignal(t, deviceSecond.Id, "203.0.113.21", "aa-e-shared-device", "dev-two.example.com")

			completeReferralCommissionTestTopUp(t, "aa-e-dev-first", deviceFirst.Id, 10)
			completeReferralCommissionTestTopUp(t, "aa-e-dev-second", deviceSecond.Id, 10)
			assert.Equal(t, ReferralCommissionStatusPending, loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-e-dev-first")[0].Status)
			blocked = loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-e-dev-second")
			require.Len(t, blocked, 1)
			assert.Equal(t, ReferralCommissionReasonInviteLimitDevice, blocked[0].Reason)

			setting.InviteLimitPerDevice = 0
			setting.InviteLimitPerEmailDomain = 1
			domainInviter := createReferralCommissionTestUser(t, db, "aa-e-dom-inviter", "default")
			domainFirst := createReferralCommissionTestUser(t, db, "aa-e-dom-first", "default")
			domainSecond := createReferralCommissionTestUser(t, db, "aa-e-dom-second", "default")
			bindReferralCommissionTestInviter(t, domainFirst, domainInviter.Id)
			bindReferralCommissionTestInviter(t, domainSecond, domainInviter.Id)
			recordReferralCommissionTestSignal(t, domainFirst.Id, "203.0.113.30", "aa-e-device-30", "shared.example.com")
			recordReferralCommissionTestSignal(t, domainSecond.Id, "203.0.113.31", "aa-e-device-31", "shared.example.com")

			completeReferralCommissionTestTopUp(t, "aa-e-dom-first", domainFirst.Id, 10)
			completeReferralCommissionTestTopUp(t, "aa-e-dom-second", domainSecond.Id, 10)
			assert.Equal(t, ReferralCommissionStatusPending, loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-e-dom-first")[0].Status)
			blocked = loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-e-dom-second")
			require.Len(t, blocked, 1)
			assert.Equal(t, ReferralCommissionReasonInviteLimitEmailDomain, blocked[0].Reason)

			// With every bound disabled (the default) the same environment
			// pays both invitees.
			restoreReferralCommissionTestSetting()
			openInviter := createReferralCommissionTestUser(t, db, "aa-e-open-inviter", "default")
			openFirst := createReferralCommissionTestUser(t, db, "aa-e-open-first", "default")
			openSecond := createReferralCommissionTestUser(t, db, "aa-e-open-second", "default")
			bindReferralCommissionTestInviter(t, openFirst, openInviter.Id)
			bindReferralCommissionTestInviter(t, openSecond, openInviter.Id)
			recordReferralCommissionTestSignal(t, openFirst.Id, "203.0.113.40", "aa-e-open-device", "open.example.com")
			recordReferralCommissionTestSignal(t, openSecond.Id, "203.0.113.40", "aa-e-open-device", "open.example.com")
			completeReferralCommissionTestTopUp(t, "aa-e-open-first", openFirst.Id, 10)
			completeReferralCommissionTestTopUp(t, "aa-e-open-second", openSecond.Id, 10)
			assert.Equal(t, ReferralCommissionStatusPending, loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-e-open-first")[0].Status)
			assert.Equal(t, ReferralCommissionStatusPending, loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-e-open-second")[0].Status)
		})

		t.Run("caps daily monthly and per-invitee payable commissions", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			// 1 USD = 500000 quota; a 6-unit order pays a 300000 commission.
			operation_setting.GetReferralSetting().DailyCommissionCapUSD = 1
			inviter := createReferralCommissionTestUser(t, db, "aa-f-inviter", "default")
			invitee := createReferralCommissionTestUser(t, db, "aa-f-invitee", "default")
			bindReferralCommissionTestInviter(t, invitee, inviter.Id)

			completeReferralCommissionTestTopUp(t, "aa-f-first", invitee.Id, 6)
			completeReferralCommissionTestTopUp(t, "aa-f-second", invitee.Id, 6)
			blocked := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-f-second")
			require.Len(t, blocked, 1)
			assert.Equal(t, ReferralCommissionStatusBlocked, blocked[0].Status)
			assert.Equal(t, ReferralCommissionReasonDailyCap, blocked[0].Reason)

			// The blocked event consumes no allowance: the remaining 200000
			// quota still pays exactly at the cap.
			completeReferralCommissionTestTopUp(t, "aa-f-third", invitee.Id, 4)
			third := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-f-third")
			require.Len(t, third, 1)
			assert.Equal(t, ReferralCommissionStatusPending, third[0].Status)

			restoreReferralCommissionTestSetting()
			operation_setting.GetReferralSetting().MonthlyCommissionCapUSD = 1
			monthlyInviter := createReferralCommissionTestUser(t, db, "aa-g-inviter", "default")
			monthlyInvitee := createReferralCommissionTestUser(t, db, "aa-g-invitee", "default")
			bindReferralCommissionTestInviter(t, monthlyInvitee, monthlyInviter.Id)
			completeReferralCommissionTestTopUp(t, "aa-g-first", monthlyInvitee.Id, 10)
			completeReferralCommissionTestTopUp(t, "aa-g-second", monthlyInvitee.Id, 10)
			blocked = loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-g-second")
			require.Len(t, blocked, 1)
			assert.Equal(t, ReferralCommissionReasonMonthlyCap, blocked[0].Reason)

			restoreReferralCommissionTestSetting()
			operation_setting.GetReferralSetting().InviteeCommissionCapUSD = 0.5
			capInviter := createReferralCommissionTestUser(t, db, "aa-h-inviter", "default")
			capInvitee := createReferralCommissionTestUser(t, db, "aa-h-invitee", "default")
			bindReferralCommissionTestInviter(t, capInvitee, capInviter.Id)
			completeReferralCommissionTestTopUp(t, "aa-h-first", capInvitee.Id, 10)
			blocked = loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-h-first")
			require.Len(t, blocked, 1)
			assert.Equal(t, ReferralCommissionStatusBlocked, blocked[0].Status)
			assert.Equal(t, ReferralCommissionReasonInviteeCap, blocked[0].Reason)
		})

		t.Run("routes large or watched commissions through manual review", func(t *testing.T) {
			restoreReferralCommissionTestSetting()
			setting := operation_setting.GetReferralSetting()
			setting.ReviewThresholdUSD = 0.5
			inviter := createReferralCommissionTestUser(t, db, "aa-i-inviter", "default")
			invitee := createReferralCommissionTestUser(t, db, "aa-i-invitee", "default")
			bindReferralCommissionTestInviter(t, invitee, inviter.Id)

			completeReferralCommissionTestTopUp(t, "aa-i-large", invitee.Id, 10)
			large := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-i-large")
			require.Len(t, large, 1)
			assert.Equal(t, ReferralCommissionStatusReview, large[0].Status)
			assert.Equal(t, ReferralCommissionReasonReviewThreshold, large[0].Reason)

			reviews, total, err := ListReferralCommissionReviews(nil)
			require.NoError(t, err)
			assert.EqualValues(t, 1, total)
			require.Len(t, reviews, 1)
			assert.Equal(t, large[0].Id, reviews[0].Id)

			decided, err := DecideReferralCommissionReview(large[0].Id, true)
			require.NoError(t, err)
			assert.Equal(t, ReferralCommissionStatusPending, decided.Status)
			_, err = DecideReferralCommissionReview(large[0].Id, false)
			assert.ErrorIs(t, err, ErrReferralReviewNotPending, "a decided review cannot be decided again")

			// A watched account forces review even below the threshold, and a
			// rejected review never becomes payable.
			setting.ReviewThresholdUSD = 0
			setReferralCommissionTestFlag(t, invitee.Id, ReferralFlagLevelWatch)
			completeReferralCommissionTestTopUp(t, "aa-i-watch", invitee.Id, 10)
			watched := loadReferralCommissionsByRef(t, WalletLedgerRefTopUp, "aa-i-watch")
			require.Len(t, watched, 1)
			assert.Equal(t, ReferralCommissionStatusReview, watched[0].Status)
			assert.Equal(t, ReferralCommissionReasonWatchFlag, watched[0].Reason)
			rejected, err := DecideReferralCommissionReview(watched[0].Id, false)
			require.NoError(t, err)
			assert.Equal(t, ReferralCommissionStatusRejected, rejected.Status)
		})
	})
}

// RF-06: the registration environment is recorded in the same transaction as
// the account and only as a hash where it is sensitive.
func TestReferralRegistrationSignals(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		setupReferralCommissionTest(t, db)

		t.Run("records the registration environment with the account", func(t *testing.T) {
			inviter := createReferralCommissionTestUser(t, db, "sig-a-inviter", "default")
			invitee := &User{
				Username: "sig-a-invitee",
				Password: "password",
				Email:    "Sign-Up@Example.com",
				Status:   common.UserStatusEnabled,
			}
			require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
				return invitee.InsertWithTx(tx, ReferralAttribution{
					InviterId: inviter.Id,
					Source:    ReferralSourceCode,
					Ip:        "203.0.113.50",
					UserAgent: "referral-test-agent/1.0",
					DeviceId:  "raw-device-identifier",
				})
			}))

			var signal ReferralRegistrationSignal
			require.NoError(t, DB.Where("user_id = ?", invitee.Id).First(&signal).Error)
			assert.Equal(t, "203.0.113.50", signal.Ip)
			assert.Equal(t, "referral-test-agent/1.0", signal.UserAgent)
			assert.Equal(t, "example.com", signal.EmailDomain)
			assert.Equal(t, hashReferralDeviceId("raw-device-identifier"), signal.DeviceHash)
			assert.NotContains(t, signal.DeviceHash, "raw-device-identifier")

			binding, err := GetReferralBindingForInvitee(invitee.Id)
			require.NoError(t, err)
			require.NotNil(t, binding)
			assert.Equal(t, inviter.Id, binding.InviterId)
		})

		t.Run("records no signal when the environment is not observable", func(t *testing.T) {
			user := &User{Username: "sig-b-plain", Password: "password", Status: common.UserStatusEnabled}
			require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
				return user.InsertWithTx(tx, ReferralAttribution{})
			}))
			var count int64
			require.NoError(t, DB.Model(&ReferralRegistrationSignal{}).Where("user_id = ?", user.Id).Count(&count).Error)
			assert.Zero(t, count)
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

	inviteLimitCases := []struct {
		value   string
		wantErr bool
	}{
		{"0", false},
		{"5", false},
		{"100", false},
		{"101", true},
		{"-1", true},
		{"two", true},
	}
	for _, tc := range inviteLimitCases {
		for _, key := range []string{
			"referral_setting.invite_limit_per_ip",
			"referral_setting.invite_limit_per_device",
			"referral_setting.invite_limit_per_email_domain",
		} {
			err := operation_setting.ValidateReferralOption(key, tc.value)
			if tc.wantErr {
				assert.Error(t, err, "%s limit %q must be rejected", key, tc.value)
			} else {
				assert.NoError(t, err, "%s limit %q must be accepted", key, tc.value)
			}
		}
	}

	capMax := operation_setting.ReferralCommissionCapMaxUSD()
	capCases := []struct {
		value   string
		wantErr bool
	}{
		{"0", false},
		{"12.5", false},
		{fmt.Sprintf("%v", capMax), false},
		{fmt.Sprintf("%v", capMax*2), true},
		{"-1", true},
		{"NaN", true},
		{"Inf", true},
		{"abc", true},
	}
	for _, tc := range capCases {
		for _, key := range []string{
			"referral_setting.daily_commission_cap_usd",
			"referral_setting.monthly_commission_cap_usd",
			"referral_setting.invitee_commission_cap_usd",
			"referral_setting.review_threshold_usd",
		} {
			err := operation_setting.ValidateReferralOption(key, tc.value)
			if tc.wantErr {
				assert.Error(t, err, "%s cap %q must be rejected", key, tc.value)
			} else {
				assert.NoError(t, err, "%s cap %q must be accepted", key, tc.value)
			}
		}
	}

	require.NoError(t, operation_setting.ValidateReferralOption("referral_setting.require_real_name", "true"))
	require.Error(t, operation_setting.ValidateReferralOption("referral_setting.require_real_name", "yes"))

	payment := operation_setting.GetPaymentSetting()
	previousConfirmed := payment.ComplianceConfirmed
	payment.ComplianceConfirmed = false
	assert.Error(t, operation_setting.ValidateReferralOption("referral_setting.enabled", "true"), "enabling the engine requires the compliance terms")
	assert.Error(t, operation_setting.ValidateReferralOption("referral_setting.cash_settlement_enabled", "true"), "enabling cash settlement requires the compliance terms")
	payment.ComplianceConfirmed = previousConfirmed
	assert.NoError(t, operation_setting.ValidateReferralOption("referral_setting.cash_settlement_enabled", "true"))
}

// The invitation statistics list every invitee of an inviter — those without
// any commission event included, so a zero amount never hides an invited
// account (#4197) — with the aggregates of their commission events, and honor
// the administrator filters, summary, pagination and window without ever
// moving a balance.
func TestReferralInvitationStats(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		setupReferralCommissionTest(t, db)
		restoreReferralCommissionTestSetting()

		inviter := createReferralCommissionTestUser(t, db, "s-a-inviter", "default")
		otherInviter := createReferralCommissionTestUser(t, db, "s-b-inviter", "default")
		paidInvitee := createReferralCommissionTestUser(t, db, "s-a-paid", "default")
		quietInvitee := createReferralCommissionTestUser(t, db, "s-a-quiet", "default")
		foreignInvitee := createReferralCommissionTestUser(t, db, "s-b-foreign", "default")
		require.NoError(t, DB.Model(&User{}).Where("id = ?", paidInvitee.Id).Update("email", "s-a-paid@example.com").Error)

		bindReferralCommissionTestInviter(t, paidInvitee, inviter.Id)
		// The quiet invitee arrived through another channel; the channel
		// filter below must separate the two.
		require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
			_, err := CreateReferralBindingWithTx(tx, quietInvitee, inviter.Id, ReferralSourceOAuth)
			return err
		}))
		bindReferralCommissionTestInviter(t, foreignInvitee, otherInviter.Id)

		// Explicit binding times make the newest-first order deterministic.
		require.NoError(t, DB.Model(&ReferralBinding{}).Where("invitee_id = ?", paidInvitee.Id).Update("bound_at", 1700000100).Error)
		require.NoError(t, DB.Model(&ReferralBinding{}).Where("invitee_id = ?", quietInvitee.Id).Update("bound_at", 1700000200).Error)

		// Three paid orders record three pending events; two of them move to
		// their later states the way the settlement step (RF-04) will.
		completeReferralCommissionTestTopUp(t, "s-a-order-1", paidInvitee.Id, 10)
		completeReferralCommissionTestTopUp(t, "s-a-order-2", paidInvitee.Id, 4)
		completeReferralCommissionTestTopUp(t, "s-a-order-3", paidInvitee.Id, 2)
		require.NoError(t, DB.Model(&ReferralCommission{}).Where("ref_id = ?", "s-a-order-2").Update("status", ReferralCommissionStatusLocked).Error)
		require.NoError(t, DB.Model(&ReferralCommission{}).Where("ref_id = ?", "s-a-order-3").Update("status", ReferralCommissionStatusSettled).Error)

		t.Run("lists every invitee with commission aggregates and the window end", func(t *testing.T) {
			query := ReferralInvitationQuery{InviterId: inviter.Id}
			total, err := CountReferralInvitations(query)
			require.NoError(t, err)
			assert.EqualValues(t, 2, total)

			invitations, err := ListReferralInvitations(query, 0, 10)
			require.NoError(t, err)
			require.Len(t, invitations, 2)
			assert.Equal(t, quietInvitee.Id, invitations[0].InviteeId)
			assert.Zero(t, invitations[0].CommissionCount, "an invitee without events must stay listed")
			assert.Zero(t, invitations[0].TotalPaidQuota)
			assert.Equal(t, paidInvitee.Id, invitations[1].InviteeId)

			paid := invitations[1]
			assert.Equal(t, inviter.Id, paid.InviterId)
			assert.Equal(t, "s-a-inviter", paid.InviterUsername)
			assert.EqualValues(t, 500000, paid.PendingQuota)
			assert.EqualValues(t, 200000, paid.LockedQuota)
			assert.EqualValues(t, 100000, paid.SettledQuota)
			assert.EqualValues(t, 8000000, paid.TotalPaidQuota)
			assert.EqualValues(t, 3, paid.CommissionCount)
			assert.Equal(t,
				referralCommissionWindowEnd(paidInvitee.CreatedAt, operation_setting.ReferralWindowMonthsDefault),
				paid.CommissionEndsAt)

			// The panel exposes the masked identifier only.
			assert.Equal(t, "s***@example.com", MaskReferralIdentifier(paid.Username, paid.Email))
		})

		t.Run("filters by keyword, source and commission status", func(t *testing.T) {
			// The keyword matches the username or the email, ignoring case.
			total, err := CountReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id, Keyword: "S-A-QUIET"})
			require.NoError(t, err)
			assert.EqualValues(t, 1, total)
			total, err = CountReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id, Keyword: "EXAMPLE.COM"})
			require.NoError(t, err)
			assert.EqualValues(t, 1, total)

			total, err = CountReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id, Source: ReferralSourceOAuth})
			require.NoError(t, err)
			assert.EqualValues(t, 1, total)
			total, err = CountReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id, Source: ReferralSourceLink})
			require.NoError(t, err)
			assert.Zero(t, total)

			filtered, err := ListReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id, Status: ReferralCommissionStatusSettled}, 0, 10)
			require.NoError(t, err)
			require.Len(t, filtered, 1)
			assert.Equal(t, paidInvitee.Id, filtered[0].InviteeId)

			// A keyword wildcard is a literal, not a pattern.
			total, err = CountReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id, Keyword: "%"})
			require.NoError(t, err)
			assert.Zero(t, total)
		})

		t.Run("paginates and isolates inviters", func(t *testing.T) {
			page, err := ListReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id}, 1, 1)
			require.NoError(t, err)
			require.Len(t, page, 1)
			assert.Equal(t, paidInvitee.Id, page[0].InviteeId)

			foreign, err := ListReferralInvitations(ReferralInvitationQuery{InviterId: otherInviter.Id}, 0, 10)
			require.NoError(t, err)
			require.Len(t, foreign, 1)
			assert.Equal(t, foreignInvitee.Id, foreign[0].InviteeId)
			assert.Zero(t, foreign[0].CommissionCount)
		})

		t.Run("summarizes the filtered invitations", func(t *testing.T) {
			summary, err := SummarizeReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id})
			require.NoError(t, err)
			assert.EqualValues(t, 2, summary.TotalInvitees)
			assert.EqualValues(t, 1, summary.InviteesWithCommission)
			assert.EqualValues(t, 8000000, summary.TotalPaidQuota)
			assert.EqualValues(t, 800000, summary.TotalCommissionQuota)
			assert.EqualValues(t, 500000, summary.PendingQuota)
			assert.EqualValues(t, 200000, summary.LockedQuota)
			assert.EqualValues(t, 100000, summary.SettledQuota)

			onlyQuiet, err := SummarizeReferralInvitations(ReferralInvitationQuery{InviterId: inviter.Id, Source: ReferralSourceOAuth})
			require.NoError(t, err)
			assert.EqualValues(t, 1, onlyQuiet.TotalInvitees)
			assert.Zero(t, onlyQuiet.InviteesWithCommission)
			assert.Zero(t, onlyQuiet.TotalCommissionQuota)
		})

		t.Run("derives the window end from the current configuration", func(t *testing.T) {
			setting := operation_setting.GetReferralSetting()
			query := ReferralInvitationQuery{InviterId: inviter.Id}

			setting.WindowMonths = operation_setting.ReferralWindowMonthsFirstTopUp
			firstTopUpOnly, err := ListReferralInvitations(query, 0, 1)
			require.NoError(t, err)
			require.Len(t, firstTopUpOnly, 1)
			assert.Zero(t, firstTopUpOnly[0].CommissionEndsAt)

			setting.WindowMonths = 6
			sixMonths, err := ListReferralInvitations(query, 0, 1)
			require.NoError(t, err)
			require.Len(t, sixMonths, 1)
			assert.Equal(t, referralCommissionWindowEnd(quietInvitee.CreatedAt, 6), sixMonths[0].CommissionEndsAt)
		})
	})
}

// The user-facing panel masks every invitee identifier: the local part of the
// email and all but the first characters of a username stay hidden.
func TestMaskReferralIdentifier(t *testing.T) {
	cases := []struct {
		name     string
		username string
		email    string
		want     string
	}{
		{"masks the local part of an email and keeps the domain", "alice", "alice@example.com", "a***@example.com"},
		{"keeps only the first rune of a multi-character local part", "alice", "jo.doe@example.com", "j***@example.com"},
		{"falls back to the username without an email", "alice", "", "al***"},
		{"keeps a one-character username recognizable", "a", "", "a***"},
		{"returns nothing when both identifiers are empty", "", "", ""},
		{"counts runes, not bytes", "用户名", "", "用户***"},
		{"treats an email without a local part as missing", "alice", "@example.com", "al***"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, MaskReferralIdentifier(tc.username, tc.email))
		})
	}
}

// The statistics query validates the administrator filters: only recorded
// sources and known commission states are accepted, the empty string meaning
// "any".
func TestReferralInvitationQueryValidation(t *testing.T) {
	for _, source := range []string{"", ReferralSourceLink, ReferralSourceCode, ReferralSourceOAuth, ReferralSourceAdmin} {
		assert.True(t, IsReferralSource(source), "source %q must be accepted", source)
	}
	assert.False(t, IsReferralSource("unknown"))

	for _, status := range []string{"", ReferralCommissionStatusPending, ReferralCommissionStatusLocked, ReferralCommissionStatusSettled} {
		assert.True(t, IsReferralCommissionStatus(status), "status %q must be accepted", status)
	}
	assert.False(t, IsReferralCommissionStatus("reversed"))
}
