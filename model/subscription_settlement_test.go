package model

import (
	"fmt"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// subscriptionUsed reads one subscription's amount_used.
func subscriptionUsed(t *testing.T, db *gorm.DB, subId int) int64 {
	t.Helper()
	var sub UserSubscription
	require.NoError(t, db.Select("amount_used").First(&sub, subId).Error)
	return sub.AmountUsed
}

// preConsumeRecordStatus reads one pre-consume record's status.
func preConsumeRecordStatus(t *testing.T, db *gorm.DB, requestId string) string {
	t.Helper()
	var record SubscriptionPreConsumeRecord
	require.NoError(t, db.Where("request_id = ?", requestId).First(&record).Error)
	return record.Status
}

// The refund must move the subscription amount and the record status in one
// transaction: a failure while writing the subscription rolls the status claim
// back too, and retrying afterwards refunds exactly once (upstream #5556).
func TestSubscriptionPreConsumeRefundIsAtomicAndIdempotent(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		const userId, subId, planId = 71, 7101, 7100
		now := GetDBTimestamp()
		require.NoError(t, db.Create(&User{Id: userId, Username: "wl03-refund", AffCode: "wl03-refund", Status: common.UserStatusEnabled}).Error)
		require.NoError(t, db.Create(&SubscriptionPlan{
			Id: planId, Title: "WL-03 refund", DurationUnit: SubscriptionDurationMonth,
			DurationValue: 1, TotalAmount: 1000, QuotaResetPeriod: SubscriptionResetNever,
		}).Error)
		require.NoError(t, db.Create(&UserSubscription{
			Id: subId, UserId: userId, PlanId: planId, AmountTotal: 1000, AmountUsed: 0,
			AllowWalletOverflow: true, Status: "active", StartTime: now - 60, EndTime: now + 3600,
		}).Error)

		result, err := PreConsumeUserSubscription("wl03-refund-request", userId, "wl03-model", 0, 300)
		require.NoError(t, err)
		assert.Equal(t, subId, result.UserSubscriptionId)
		assert.EqualValues(t, 300, result.PreConsumed)
		assert.EqualValues(t, 300, subscriptionUsed(t, db, subId))

		// Fail the subscription write to prove the status change is not
		// committed on its own.
		const callback = "wl03_fail_subscription_update"
		require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callback, func(tx *gorm.DB) {
			if strings.HasSuffix(tx.Statement.Table, "user_subscriptions") {
				tx.AddError(fmt.Errorf("wl03 injected subscription update failure"))
			}
		}))
		err = RefundSubscriptionPreConsume("wl03-refund-request")
		require.NoError(t, db.Callback().Update().Remove(callback))
		require.ErrorContains(t, err, "wl03 injected subscription update failure")
		assert.EqualValues(t, 300, subscriptionUsed(t, db, subId), "the subscription amount must roll back with the status")
		assert.Equal(t, "consumed", preConsumeRecordStatus(t, db, "wl03-refund-request"))

		// A successful refund followed by replays refunds exactly once.
		require.NoError(t, RefundSubscriptionPreConsume("wl03-refund-request"))
		require.NoError(t, RefundSubscriptionPreConsume("wl03-refund-request"))
		assert.Zero(t, subscriptionUsed(t, db, subId))
		assert.Equal(t, "refunded", preConsumeRecordStatus(t, db, "wl03-refund-request"))
	})
}

// A settlement delta beyond the subscription's remaining quota is split in one
// transaction: the subscription absorbs up to its total and, when the plan
// allows wallet overflow, the excess is charged to the wallet and recorded in
// the wallet ledger (upstream #6911). Until the WL-06 overdraft policy lands
// the wallet is only charged down to zero, and the rest is reported uncovered.
func TestSubscriptionSettlementOverflowChargesWallet(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		for index, tc := range []struct {
			name                                   string
			amountTotal, amountUsed, delta         int64
			allowOverflow                          bool
			wallet                                 int
			wantApplied, wantWallet, wantUncovered int64
			wantBalance                            int
		}{
			{name: "wallet covers the overflow", amountTotal: 1000, amountUsed: 900, delta: 250, allowOverflow: true, wallet: 5000, wantApplied: 100, wantWallet: 150, wantBalance: 4850},
			{name: "wallet covers only part of the overflow", amountTotal: 1000, amountUsed: 900, delta: 250, allowOverflow: true, wallet: 100, wantApplied: 100, wantWallet: 100, wantUncovered: 50, wantBalance: 0},
			{name: "negative wallet balance is charged nothing", amountTotal: 1000, amountUsed: 900, delta: 250, allowOverflow: true, wallet: -20, wantApplied: 100, wantUncovered: 150, wantBalance: -20},
			{name: "wallet overflow disabled keeps the plan limit", amountTotal: 1000, amountUsed: 900, delta: 250, wallet: 5000, wantApplied: 100, wantUncovered: 150, wantBalance: 5000},
			{name: "delta within the plan total stays on the subscription", amountTotal: 1000, amountUsed: 500, delta: 250, allowOverflow: true, wallet: 5000, wantApplied: 250, wantBalance: 5000},
			{name: "unlimited plan absorbs the whole delta", amountUsed: 500, delta: 250, allowOverflow: true, wallet: 5000, wantApplied: 250, wantBalance: 5000},
			{name: "negative delta refunds the subscription", amountTotal: 1000, amountUsed: 900, delta: -250, allowOverflow: true, wallet: 5000, wantApplied: -250, wantBalance: 5000},
			{name: "negative delta never goes below zero", amountTotal: 1000, amountUsed: 100, delta: -250, wallet: 5000, wantApplied: -100, wantBalance: 5000},
		} {
			t.Run(tc.name, func(t *testing.T) {
				userId := 800 + index
				subId := 8100 + index
				now := GetDBTimestamp()
				require.NoError(t, db.Create(&User{Id: userId, Username: fmt.Sprintf("wl03-settle-%d", index), AffCode: fmt.Sprintf("wl03-settle-%d", index), Quota: tc.wallet, Status: common.UserStatusEnabled}).Error)
				require.NoError(t, db.Create(&UserSubscription{
					Id: subId, UserId: userId, AmountTotal: tc.amountTotal, AmountUsed: tc.amountUsed,
					AllowWalletOverflow: tc.allowOverflow, Status: "active", StartTime: now - 60, EndTime: now + 3600,
				}).Error)

				hour := walletConsumeHourBucket(common.GetTimestamp())
				result, err := SettleUserSubscriptionDelta(subId, tc.delta)
				require.NoError(t, err)
				require.NotNil(t, result)
				assert.Equal(t, tc.wantApplied, result.SubscriptionDelta)
				assert.Equal(t, tc.wantWallet, result.WalletDelta)
				assert.Equal(t, tc.wantUncovered, result.WalletUncovered)
				assert.Equal(t, tc.allowOverflow, result.AllowWalletOverflow)
				assert.Equal(t, tc.amountUsed+tc.wantApplied, subscriptionUsed(t, db, subId))

				var user User
				require.NoError(t, db.Select("quota").First(&user, userId).Error)
				assert.Equal(t, tc.wantBalance, user.Quota)

				var ledger []WalletLedgerEntry
				require.NoError(t, db.Where("user_id = ? AND kind = ?", userId, WalletLedgerKindConsumeHourly).Find(&ledger).Error)
				if tc.wantWallet > 0 {
					require.Len(t, ledger, 1)
					assert.EqualValues(t, -tc.wantWallet, ledger[0].Amount)
					assert.Equal(t, fmt.Sprintf("%d:%d", userId, hour), ledger[0].RefId)
					assert.EqualValues(t, tc.wantBalance, ledger[0].BalanceAfter)
				} else {
					assert.Empty(t, ledger, "no wallet movement may leave a consumption row behind")
				}
			})
		}
	})
}
