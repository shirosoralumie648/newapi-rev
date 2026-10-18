package model

import (
	"fmt"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// seedSubscriptionLimitFixture creates one user, one plan, and one active
// subscription for the plan-limit and quota-window tests.
func seedSubscriptionLimitFixture(t *testing.T, db *gorm.DB, userId int, planId int, subId int, plan SubscriptionPlan, amountUsed int64) {
	t.Helper()
	now := GetDBTimestamp()
	plan.Id = planId
	plan.Title = fmt.Sprintf("sub-limit-%d", planId)
	if plan.DurationUnit == "" {
		plan.DurationUnit = SubscriptionDurationMonth
	}
	if plan.DurationValue == 0 {
		plan.DurationValue = 1
	}
	require.NoError(t, db.Create(&User{Id: userId, Username: fmt.Sprintf("sub-limit-%d", userId), AffCode: fmt.Sprintf("sub-limit-%d", userId), Status: common.UserStatusEnabled}).Error)
	require.NoError(t, db.Create(&plan).Error)
	require.NoError(t, db.Create(&UserSubscription{
		Id: subId, UserId: userId, PlanId: planId, AmountTotal: plan.TotalAmount, AmountUsed: amountUsed,
		AllowWalletOverflow: true, Status: "active", StartTime: now - 60, EndTime: now + 3600,
	}).Error)
}

// assertSubscriptionWindowUsage reads one window usage row. The window column
// name is reserved on MySQL and PostgreSQL, so it is compared through a quoted
// identifier instead of raw SQL.
func assertSubscriptionWindowUsage(t *testing.T, db *gorm.DB, subId int, window string, want int64) {
	t.Helper()
	var row SubscriptionWindowUsage
	require.NoError(t, db.Where("subscription_id = ?", subId).
		Where(clause.Eq{Column: clause.Column{Name: "window"}, Value: window}).
		First(&row).Error)
	assert.EqualValues(t, want, row.Used)
}

// A plan's allowed-group and allowed-model lists gate which requests may
// consume it: a request in another group or for another model falls through to
// the next active subscription, and when none matches, the pre-consume reports
// the subscription as ineligible instead of spending quota (upstream #3388).
func TestSubscriptionLimitsGroupAndModelRestrictions(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		seedSubscriptionLimitFixture(t, db, 91, 9100, 9101, SubscriptionPlan{
			QuotaResetPeriod: SubscriptionResetNever, TotalAmount: 1000,
			AllowedGroups: "vip", AllowedModels: "gpt-*",
		}, 0)
		seedSubscriptionLimitFixture(t, db, 91, 9102, 9103, SubscriptionPlan{
			QuotaResetPeriod: SubscriptionResetNever, TotalAmount: 1000,
			AllowedModels: "fallback-model",
		}, 0)

		// A request in the allowed group for a model with the allowed prefix
		// consumes the restricted plan.
		result, err := PreConsumeUserSubscription("limits-grant-1", 91, "vip", "gpt-4o-mini", 0, 100)
		require.NoError(t, err)
		assert.Equal(t, 9101, result.UserSubscriptionId)
		assert.EqualValues(t, 100, subscriptionUsed(t, db, 9101))

		// A request outside the allowed group never touches the restricted plan
		// and falls through to the subscription that allows every group.
		result, err = PreConsumeUserSubscription("limits-grant-2", 91, "default", "fallback-model", 0, 50)
		require.NoError(t, err)
		assert.Equal(t, 9103, result.UserSubscriptionId)
		assert.EqualValues(t, 100, subscriptionUsed(t, db, 9101), "the ineligible subscription must not be charged")

		// A wildcard entry matches every model with the prefix.
		result, err = PreConsumeUserSubscription("limits-grant-3", 91, "vip", "gpt-image-1", 0, 20)
		require.NoError(t, err)
		assert.Equal(t, 9101, result.UserSubscriptionId)

		// A model outside every plan's list is ineligible: nothing is charged.
		_, err = PreConsumeUserSubscription("limits-grant-4", 91, "default", "claude-3-5", 0, 10)
		require.ErrorIs(t, err, ErrSubscriptionIneligible)
		assert.EqualValues(t, 50, subscriptionUsed(t, db, 9103))
	})
}

// A plan's hour/day/week/month windows cap usage in addition to the total: a
// window that cannot hold the whole pre-consume rejects it, and a refund
// restores exactly the windows that were charged (upstream #4978, #6009).
func TestSubscriptionLimitsWindowQuotaBlocksAndRefundRestores(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		seedSubscriptionLimitFixture(t, db, 92, 9200, 9201, SubscriptionPlan{
			QuotaResetPeriod: SubscriptionResetNever, TotalAmount: 1000, QuotaWindowDay: 100,
		}, 0)

		_, err := PreConsumeUserSubscription("limits-window-1", 92, "", "model", 0, 60)
		require.NoError(t, err)
		assertSubscriptionWindowUsage(t, db, 9201, SubscriptionWindowDay, 60)

		// The remaining window quota cannot hold the whole amount, matching the
		// total-quota rule: the pre-consume is refused, not partially charged.
		_, err = PreConsumeUserSubscription("limits-window-2", 92, "", "model", 0, 50)
		require.ErrorIs(t, err, ErrSubscriptionQuotaInsufficient)
		assertSubscriptionWindowUsage(t, db, 9201, SubscriptionWindowDay, 60)
		assert.EqualValues(t, 60, subscriptionUsed(t, db, 9201))

		// The refund returns the window capacity immediately.
		require.NoError(t, RefundSubscriptionPreConsume("limits-window-1"))
		assertSubscriptionWindowUsage(t, db, 9201, SubscriptionWindowDay, 0)
		_, err = PreConsumeUserSubscription("limits-window-3", 92, "", "model", 0, 50)
		require.NoError(t, err)
		assertSubscriptionWindowUsage(t, db, 9201, SubscriptionWindowDay, 50)
		assert.EqualValues(t, 50, subscriptionUsed(t, db, 9201))
	})
}

// A window row whose boundary already passed restarts on the next charge, so a
// new hour/day/week/month begins with its full quota.
func TestSubscriptionLimitsWindowRollsOverAtBoundary(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		seedSubscriptionLimitFixture(t, db, 93, 9300, 9301, SubscriptionPlan{
			QuotaResetPeriod: SubscriptionResetNever, TotalAmount: 1000, QuotaWindowHour: 100,
		}, 0)
		start, ok := subscriptionWindowStart(SubscriptionWindowHour, GetDBTimestamp())
		require.True(t, ok)
		require.NoError(t, db.Create(&SubscriptionWindowUsage{
			SubscriptionId: 9301, Window: SubscriptionWindowHour, Used: 100, WindowStart: start - 3600,
		}).Error)

		_, err := PreConsumeUserSubscription("limits-roll-1", 93, "", "model", 0, 100)
		require.NoError(t, err)
		assertSubscriptionWindowUsage(t, db, 9301, SubscriptionWindowHour, 100)
		var row SubscriptionWindowUsage
		require.NoError(t, db.Where("subscription_id = ?", 9301).
			Where(clause.Eq{Column: clause.Column{Name: "window"}, Value: SubscriptionWindowHour}).
			First(&row).Error)
		assert.GreaterOrEqual(t, row.WindowStart, start, "the stale window must move to the current boundary")
	})
}

// Settlement deltas count toward the plan windows, so window caps judge the
// real spend: a request whose settlement exceeds the window fills it and the
// next reservation is refused even though the total still has room.
func TestSubscriptionLimitsSettlementChargesWindows(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		seedSubscriptionLimitFixture(t, db, 94, 9400, 9401, SubscriptionPlan{
			QuotaResetPeriod: SubscriptionResetNever, TotalAmount: 1000, QuotaWindowDay: 100,
		}, 0)

		_, err := PreConsumeUserSubscription("limits-settle-1", 94, "", "model", 0, 10)
		require.NoError(t, err)
		result, err := SettleUserSubscriptionDelta(9401, 95)
		require.NoError(t, err)
		assert.EqualValues(t, 95, result.SubscriptionDelta)
		assertSubscriptionWindowUsage(t, db, 9401, SubscriptionWindowDay, 105)
		assert.EqualValues(t, 105, subscriptionUsed(t, db, 9401))

		// The window is over its cap; the next reservation is refused.
		_, err = PreConsumeUserSubscription("limits-settle-2", 94, "", "model", 0, 1)
		require.ErrorIs(t, err, ErrSubscriptionQuotaInsufficient)

		// A settlement refund returns window capacity.
		refund, err := SettleUserSubscriptionDelta(9401, -30)
		require.NoError(t, err)
		assert.EqualValues(t, -30, refund.SubscriptionDelta)
		assertSubscriptionWindowUsage(t, db, 9401, SubscriptionWindowDay, 75)
		_, err = PreConsumeUserSubscription("limits-settle-3", 94, "", "model", 0, 25)
		require.NoError(t, err)
	})
}

// Resetting a subscription's total quota also restarts its calendar windows,
// so the new period starts without stale window usage.
func TestSubscriptionLimitsResetClearsWindows(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		seedSubscriptionLimitFixture(t, db, 95, 9500, 9501, SubscriptionPlan{
			QuotaResetPeriod: SubscriptionResetNever, TotalAmount: 1000, QuotaWindowDay: 100,
		}, 0)
		_, err := PreConsumeUserSubscription("limits-reset-1", 95, "", "model", 0, 40)
		require.NoError(t, err)
		assertSubscriptionWindowUsage(t, db, 9501, SubscriptionWindowDay, 40)

		_, err = AdminResetUserSubscriptionsByPlan(95, 9500, false)
		require.NoError(t, err)
		var count int64
		require.NoError(t, db.Model(&SubscriptionWindowUsage{}).Where("subscription_id = ?", 9501).Count(&count).Error)
		assert.Zero(t, count)
		assert.Zero(t, subscriptionUsed(t, db, 9501))
	})
}
