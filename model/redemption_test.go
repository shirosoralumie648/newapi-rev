package model

import (
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestSearchRedemptionsFiltersAndPaginates(t *testing.T) {
	require.NoError(t, DB.AutoMigrate(&Redemption{}))
	require.NoError(t, DB.Session(&gorm.Session{AllowGlobalUpdate: true}).Unscoped().Delete(&Redemption{}).Error)
	t.Cleanup(func() {
		require.NoError(t, DB.Session(&gorm.Session{AllowGlobalUpdate: true}).Unscoped().Delete(&Redemption{}).Error)
	})

	now := common.GetTimestamp()
	redemptions := []Redemption{
		{Id: 1, Name: "alpha-active", Key: "00000000000000000000000000000001", Status: common.RedemptionCodeStatusEnabled, ExpiredTime: 0},
		{Id: 2, Name: "alpha-future", Key: "00000000000000000000000000000002", Status: common.RedemptionCodeStatusEnabled, ExpiredTime: now + 3600, Type: RedemptionTypeSubscription, PlanId: 7},
		{Id: 3, Name: "alpha-expired", Key: "00000000000000000000000000000003", Status: common.RedemptionCodeStatusEnabled, ExpiredTime: now - 10, Type: RedemptionTypeQuota},
		{Id: 4, Name: "beta-disabled", Key: "00000000000000000000000000000004", Status: common.RedemptionCodeStatusDisabled, ExpiredTime: 0, Type: RedemptionTypeQuota},
		{Id: 5, Name: "beta-used", Key: "00000000000000000000000000000005", Status: common.RedemptionCodeStatusUsed, ExpiredTime: 0, Type: RedemptionTypeQuota},
	}
	require.NoError(t, DB.Create(&redemptions).Error)

	tests := []struct {
		name           string
		keyword        string
		status         string
		redemptionType string
		startIdx       int
		num            int
		wantTotal      int64
		wantIds        []int
	}{
		{
			name:      "no filters returns all rows",
			num:       10,
			wantTotal: 5,
			wantIds:   []int{5, 4, 3, 2, 1},
		},
		{
			name:      "keyword filters by name prefix",
			keyword:   "alpha",
			num:       10,
			wantTotal: 3,
			wantIds:   []int{3, 2, 1},
		},
		{
			name:      "enabled status excludes expired rows",
			status:    "1",
			num:       10,
			wantTotal: 2,
			wantIds:   []int{2, 1},
		},
		{
			name:      "expired status returns enabled expired rows",
			status:    "expired",
			num:       10,
			wantTotal: 1,
			wantIds:   []int{3},
		},
		{
			name:      "disabled status",
			status:    "2",
			num:       10,
			wantTotal: 1,
			wantIds:   []int{4},
		},
		{
			name:      "used status",
			status:    "3",
			num:       10,
			wantTotal: 1,
			wantIds:   []int{5},
		},
		{
			name:      "pagination keeps unpaged total",
			startIdx:  1,
			num:       2,
			wantTotal: 5,
			wantIds:   []int{4, 3},
		},
		{
			name:           "quota type includes legacy rows without a stored type",
			redemptionType: "quota",
			num:            10,
			wantTotal:      4,
			wantIds:        []int{5, 4, 3, 1},
		},
		{
			name:           "subscription type",
			redemptionType: "subscription",
			num:            10,
			wantTotal:      1,
			wantIds:        []int{2},
		},
		{
			name:           "unknown type is ignored",
			redemptionType: "nonsense",
			num:            10,
			wantTotal:      5,
			wantIds:        []int{5, 4, 3, 2, 1},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rows, total, err := SearchRedemptions(tt.keyword, tt.status, tt.redemptionType, tt.startIdx, tt.num)
			require.NoError(t, err)
			assert.Equal(t, tt.wantTotal, total)
			gotIds := make([]int, 0, len(rows))
			for _, row := range rows {
				gotIds = append(gotIds, row.Id)
			}
			assert.Equal(t, tt.wantIds, gotIds)
		})
	}
}

func setupRedeemFixture(t *testing.T, quota int) (userId int, key string) {
	t.Helper()
	require.NoError(t, DB.AutoMigrate(&Redemption{}))
	require.NoError(t, DB.Session(&gorm.Session{AllowGlobalUpdate: true}).Unscoped().Delete(&Redemption{}).Error)
	t.Cleanup(func() {
		require.NoError(t, DB.Session(&gorm.Session{AllowGlobalUpdate: true}).Unscoped().Delete(&Redemption{}).Error)
		DB.Exec("DELETE FROM users")
		DB.Exec("DELETE FROM logs")
	})

	user := &User{Username: "redeem-user", Password: "password", Status: common.UserStatusEnabled, Quota: 0}
	require.NoError(t, DB.Create(user).Error)

	key = "10000000000000000000000000000001"
	redemption := &Redemption{
		Name:        "redeem-test",
		Key:         key,
		Status:      common.RedemptionCodeStatusEnabled,
		Quota:       quota,
		CreatedTime: common.GetTimestamp(),
	}
	require.NoError(t, DB.Create(redemption).Error)
	return user.Id, key
}

func TestRedeemCreditsQuotaExactlyOnce(t *testing.T) {
	userId, key := setupRedeemFixture(t, 500)

	result, err := Redeem(key, userId)
	require.NoError(t, err)
	assert.Equal(t, RedemptionTypeQuota, result.Type)
	assert.Equal(t, 500, result.Quota)
	assert.Equal(t, 0, result.PlanId)

	var user User
	require.NoError(t, DB.First(&user, "id = ?", userId).Error)
	assert.Equal(t, 500, user.Quota)

	var redemption Redemption
	require.NoError(t, DB.First(&redemption, "name = ?", "redeem-test").Error)
	assert.Equal(t, common.RedemptionCodeStatusUsed, redemption.Status)
	assert.Equal(t, userId, redemption.UsedUserId)

	// Redeeming the same code again must fail and must not credit quota.
	_, err = Redeem(key, userId)
	require.Error(t, err)
	require.NoError(t, DB.First(&user, "id = ?", userId).Error)
	assert.Equal(t, 500, user.Quota)
}

func TestRedeemRejectsWalletOverflow(t *testing.T) {
	userId, key := setupRedeemFixture(t, 11)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", userId).Update("quota", common.MaxWalletQuota-10).Error)

	_, err := Redeem(key, userId)
	require.ErrorIs(t, err, ErrRedeemFailed)

	var user User
	require.NoError(t, DB.First(&user, "id = ?", userId).Error)
	assert.Equal(t, common.MaxWalletQuota-10, user.Quota)

	var redemption Redemption
	require.NoError(t, DB.First(&redemption, "key = ?", key).Error)
	assert.Equal(t, common.RedemptionCodeStatusEnabled, redemption.Status)
}

func TestRedemptionQuotaRejectsWalletOverflow(t *testing.T) {
	setupRedeemFixture(t, 500)

	redemption := &Redemption{
		Name:        "overflow-redemption",
		Key:         "10000000000000000000000000000002",
		Status:      common.RedemptionCodeStatusEnabled,
		Quota:       common.MaxWalletQuota + 1,
		CreatedTime: common.GetTimestamp(),
	}
	require.Error(t, redemption.Insert())
}

// Exactly one of several concurrent redeems of the same code may win, and
// quota must be credited exactly once.
func TestRedeemConcurrentSingleSuccess(t *testing.T) {
	userId, key := setupRedeemFixture(t, 300)

	const goroutines = 5
	successes := make([]bool, goroutines)
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := range goroutines {
		go func(idx int) {
			defer wg.Done()
			if _, err := Redeem(key, userId); err == nil {
				successes[idx] = true
			}
		}(i)
	}
	wg.Wait()

	successCount := 0
	for _, ok := range successes {
		if ok {
			successCount++
		}
	}
	assert.Equal(t, 1, successCount, "exactly one concurrent redeem should succeed")

	var user User
	require.NoError(t, DB.First(&user, "id = ?", userId).Error)
	assert.Equal(t, 300, user.Quota, "quota must be credited exactly once")
}

// setupRedeemSubscriptionFixture prepares one user and one enabled plan on the
// package test database and cleans up everything a subscription redemption
// touches.
func setupRedeemSubscriptionFixture(t *testing.T, plan *SubscriptionPlan) (userId int, user *User) {
	t.Helper()
	require.NoError(t, DB.AutoMigrate(&Redemption{}))
	clear := func() {
		require.NoError(t, DB.Session(&gorm.Session{AllowGlobalUpdate: true}).Unscoped().Delete(&Redemption{}).Error)
		DB.Exec("DELETE FROM user_subscriptions")
		DB.Exec("DELETE FROM subscription_plans")
		DB.Exec("DELETE FROM users")
		DB.Exec("DELETE FROM logs")
		DB.Exec("DELETE FROM wallet_ledger")
	}
	clear()
	t.Cleanup(clear)
	plan.NormalizeDefaults()
	require.NoError(t, DB.Create(plan).Error)
	InvalidateSubscriptionPlanCache(plan.Id)
	t.Cleanup(func() { InvalidateSubscriptionPlanCache(plan.Id) })

	user = &User{Username: "redeem-subscription-user", Password: "password", Status: common.UserStatusEnabled, Quota: 1000, Group: "default"}
	require.NoError(t, DB.Create(user).Error)
	return user.Id, user
}

// Redeeming a subscription code creates the same subscription a paid or admin
// grant would: the plan's UpgradeGroup is applied, the code's optional duration
// override replaces the plan duration, the per-plan purchase limit is enforced,
// and the wallet balance and ledger stay untouched.
func TestRedeemSubscriptionPlanCode(t *testing.T) {
	plan := &SubscriptionPlan{
		Title:              "redeem plan",
		DurationUnit:       SubscriptionDurationMonth,
		DurationValue:      1,
		TotalAmount:        5000,
		Enabled:            true,
		UpgradeGroup:       "pro",
		MaxPurchasePerUser: 1,
	}
	userId, _ := setupRedeemSubscriptionFixture(t, plan)
	now := common.GetTimestamp()

	code := &Redemption{
		Name:          "subscription-code",
		Key:           "30000000000000000000000000000001",
		Status:        common.RedemptionCodeStatusEnabled,
		Type:          RedemptionTypeSubscription,
		PlanId:        plan.Id,
		DurationUnit:  SubscriptionDurationDay,
		DurationValue: 3,
		CreatedTime:   now,
	}
	require.NoError(t, code.Insert())

	result, err := Redeem(code.Key, userId)
	require.NoError(t, err)
	assert.Equal(t, RedemptionTypeSubscription, result.Type)
	assert.Equal(t, plan.Id, result.PlanId)
	assert.Equal(t, "redeem plan", result.PlanTitle)
	assert.NotZero(t, result.SubscriptionId)
	// The override replaces the plan's one month with three days.
	assert.InDelta(t, now+3*24*3600, result.EndTime, 60)

	var sub UserSubscription
	require.NoError(t, DB.First(&sub, "id = ?", result.SubscriptionId).Error)
	assert.Equal(t, userId, sub.UserId)
	assert.Equal(t, plan.Id, sub.PlanId)
	assert.Equal(t, SubscriptionSourceRedemption, sub.Source)
	assert.EqualValues(t, 5000, sub.AmountTotal)
	assert.EqualValues(t, 0, sub.AmountUsed)
	assert.Equal(t, "pro", sub.UpgradeGroup)
	assert.Equal(t, "default", sub.PrevUserGroup)

	var user User
	require.NoError(t, DB.First(&user, "id = ?", userId).Error)
	assert.Equal(t, "pro", user.Group, "the plan's UpgradeGroup is applied")
	assert.Equal(t, 1000, user.Quota, "a subscription grant never moves the wallet balance")

	// A subscription grant is not a wallet fund event, so it writes no ledger row.
	var ledgerCount int64
	require.NoError(t, DB.Model(&WalletLedgerEntry{}).Where("user_id = ?", userId).Count(&ledgerCount).Error)
	assert.EqualValues(t, 0, ledgerCount)

	var stored Redemption
	require.NoError(t, DB.First(&stored, "id = ?", code.Id).Error)
	assert.Equal(t, common.RedemptionCodeStatusUsed, stored.Status)
	assert.Equal(t, userId, stored.UsedUserId)
	assert.Equal(t, RedemptionTypeSubscription, stored.Type)
	assert.Equal(t, SubscriptionDurationDay, stored.DurationUnit)
	assert.Equal(t, 3, stored.DurationValue)

	// The same code cannot be redeemed twice.
	_, err = Redeem(code.Key, userId)
	require.ErrorIs(t, err, ErrRedeemFailed)
	var subscriptionCount int64
	require.NoError(t, DB.Model(&UserSubscription{}).Where("user_id = ? AND plan_id = ?", userId, plan.Id).Count(&subscriptionCount).Error)
	assert.EqualValues(t, 1, subscriptionCount)

	// A second code for the same plan violates MaxPurchasePerUser and stays
	// enabled so the administrator can reuse or delete it.
	second := &Redemption{
		Name:        "subscription-code-limit",
		Key:         "30000000000000000000000000000002",
		Status:      common.RedemptionCodeStatusEnabled,
		Type:        RedemptionTypeSubscription,
		PlanId:      plan.Id,
		CreatedTime: now,
	}
	require.NoError(t, second.Insert())
	_, err = Redeem(second.Key, userId)
	require.ErrorIs(t, err, ErrRedeemFailed)
	var reloaded Redemption
	require.NoError(t, DB.First(&reloaded, "id = ?", second.Id).Error)
	assert.Equal(t, common.RedemptionCodeStatusEnabled, reloaded.Status)
	require.NoError(t, DB.Model(&UserSubscription{}).Where("user_id = ? AND plan_id = ?", userId, plan.Id).Count(&subscriptionCount).Error)
	assert.EqualValues(t, 1, subscriptionCount)
}

// Exactly one of several concurrent redemptions of the same subscription code
// may grant a subscription.
func TestRedeemSubscriptionPlanCodeConcurrentSingleSuccess(t *testing.T) {
	plan := &SubscriptionPlan{
		Title:         "concurrent plan",
		DurationUnit:  SubscriptionDurationDay,
		DurationValue: 1,
		TotalAmount:   1000,
		Enabled:       true,
	}
	userId, _ := setupRedeemSubscriptionFixture(t, plan)

	code := &Redemption{
		Name:        "concurrent-subscription-code",
		Key:         "30000000000000000000000000000003",
		Status:      common.RedemptionCodeStatusEnabled,
		Type:        RedemptionTypeSubscription,
		PlanId:      plan.Id,
		CreatedTime: common.GetTimestamp(),
	}
	require.NoError(t, code.Insert())

	const goroutines = 5
	successes := make([]bool, goroutines)
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := range goroutines {
		go func(idx int) {
			defer wg.Done()
			if _, err := Redeem(code.Key, userId); err == nil {
				successes[idx] = true
			}
		}(i)
	}
	wg.Wait()

	successCount := 0
	for _, ok := range successes {
		if ok {
			successCount++
		}
	}
	assert.Equal(t, 1, successCount, "exactly one concurrent redeem should succeed")

	var subscriptionCount int64
	require.NoError(t, DB.Model(&UserSubscription{}).Where("user_id = ? AND plan_id = ?", userId, plan.Id).Count(&subscriptionCount).Error)
	assert.EqualValues(t, 1, subscriptionCount, "the subscription must be granted exactly once")
}

// Subscription redemption codes must behave identically on SQLite, MySQL and
// PostgreSQL: the new columns migrate idempotently, the override round-trips,
// missing plans fail without consuming the code, and legacy quota rows with an
// empty type still credit quota.
func TestRedeemSubscriptionPlanCodeMatrix(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.AutoMigrate(&Redemption{}))
		require.NoError(t, db.AutoMigrate(&Redemption{}))
		t.Cleanup(func() { require.NoError(t, db.Migrator().DropTable(&Redemption{})) })

		now := common.GetTimestamp()
		plan := &SubscriptionPlan{
			Title:         "matrix plan",
			DurationUnit:  SubscriptionDurationMonth,
			DurationValue: 1,
			TotalAmount:   2000,
			Enabled:       true,
			UpgradeGroup:  "pro",
		}
		require.NoError(t, db.Create(plan).Error)
		t.Cleanup(func() { InvalidateSubscriptionPlanCache(plan.Id) })

		user := &User{Username: "redeem-matrix-user", AffCode: "redeem-matrix-user", Password: "password", Status: common.UserStatusEnabled, Quota: 100, Group: "default"}
		require.NoError(t, db.Create(user).Error)

		code := &Redemption{
			Name:            "matrix-code",
			Key:             "40000000000000000000000000000001",
			Status:          common.RedemptionCodeStatusEnabled,
			Type:            RedemptionTypeSubscription,
			PlanId:          plan.Id,
			DurationUnit:    SubscriptionDurationCustom,
			DurationSeconds: 7200,
			CreatedTime:     now,
		}
		require.NoError(t, code.Insert())

		result, err := Redeem(code.Key, user.Id)
		require.NoError(t, err)
		require.Equal(t, RedemptionTypeSubscription, result.Type)
		require.InDelta(t, now+7200, result.EndTime, 60)

		var storedCode Redemption
		require.NoError(t, db.First(&storedCode, "id = ?", code.Id).Error)
		require.Equal(t, RedemptionTypeSubscription, storedCode.Type)
		require.Equal(t, plan.Id, storedCode.PlanId)
		require.Equal(t, SubscriptionDurationCustom, storedCode.DurationUnit)
		require.EqualValues(t, 7200, storedCode.DurationSeconds)

		var storedUser User
		require.NoError(t, db.First(&storedUser, user.Id).Error)
		require.Equal(t, "pro", storedUser.Group)
		require.Equal(t, 100, storedUser.Quota)

		// A code whose plan no longer exists fails closed and stays enabled.
		orphan := &Redemption{
			Name:        "orphan-code",
			Key:         "40000000000000000000000000000002",
			Status:      common.RedemptionCodeStatusEnabled,
			Type:        RedemptionTypeSubscription,
			PlanId:      plan.Id + 999,
			CreatedTime: now,
		}
		require.NoError(t, db.Create(orphan).Error)
		_, err = Redeem(orphan.Key, user.Id)
		require.ErrorIs(t, err, ErrRedeemFailed)
		var reloadedOrphan Redemption
		require.NoError(t, db.First(&reloadedOrphan, "id = ?", orphan.Id).Error)
		require.Equal(t, common.RedemptionCodeStatusEnabled, reloadedOrphan.Status)

		// Legacy quota rows predate the type column and still credit quota.
		legacy := &Redemption{
			Name:        "legacy-code",
			Key:         "40000000000000000000000000000003",
			Status:      common.RedemptionCodeStatusEnabled,
			Quota:       250,
			CreatedTime: now,
		}
		require.NoError(t, db.Create(legacy).Error)
		result, err = Redeem(legacy.Key, user.Id)
		require.NoError(t, err)
		require.Equal(t, RedemptionTypeQuota, result.Type)
		require.Equal(t, 250, result.Quota)
		require.NoError(t, db.First(&storedUser, user.Id).Error)
		require.Equal(t, 350, storedUser.Quota)
	})
}

func TestValidateRedemptionDuration(t *testing.T) {
	tests := []struct {
		name    string
		unit    string
		value   int
		seconds int64
		wantErr error
	}{
		{name: "empty override uses the plan duration", unit: "", value: 0, seconds: 0},
		{name: "empty override rejects stray values", unit: "", value: 1, seconds: 0, wantErr: ErrRedemptionDurationInvalid},
		{name: "years", unit: SubscriptionDurationYear, value: 2},
		{name: "months", unit: SubscriptionDurationMonth, value: 12},
		{name: "days", unit: SubscriptionDurationDay, value: 30},
		{name: "hours", unit: SubscriptionDurationHour, value: 24},
		{name: "custom seconds", unit: SubscriptionDurationCustom, seconds: 3600},
		{name: "unknown unit", unit: "fortnight", value: 1, wantErr: ErrRedemptionDurationInvalid},
		{name: "zero value", unit: SubscriptionDurationMonth, value: 0, wantErr: ErrRedemptionDurationInvalid},
		{name: "negative value", unit: SubscriptionDurationDay, value: -1, wantErr: ErrRedemptionDurationInvalid},
		{name: "custom without seconds", unit: SubscriptionDurationCustom, seconds: 0, wantErr: ErrRedemptionDurationInvalid},
		{name: "year bound", unit: SubscriptionDurationYear, value: RedemptionDurationMaxYears + 1, wantErr: ErrRedemptionDurationTooLong},
		{name: "month bound", unit: SubscriptionDurationMonth, value: RedemptionDurationMaxYears*12 + 1, wantErr: ErrRedemptionDurationTooLong},
		{name: "hour bound", unit: SubscriptionDurationHour, value: RedemptionDurationMaxYears*365*24 + 1, wantErr: ErrRedemptionDurationTooLong},
		{name: "custom bound", unit: SubscriptionDurationCustom, seconds: int64(RedemptionDurationMaxYears)*365*24*60*60 + 1, wantErr: ErrRedemptionDurationTooLong},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRedemptionDuration(tt.unit, tt.value, tt.seconds)
			if tt.wantErr == nil {
				require.NoError(t, err)
				return
			}
			require.ErrorIs(t, err, tt.wantErr)
		})
	}
}

func TestRedemptionPayloadValidation(t *testing.T) {
	plan := &SubscriptionPlan{
		Title:         "validation plan",
		DurationUnit:  SubscriptionDurationMonth,
		DurationValue: 1,
		Enabled:       true,
	}
	userId, _ := setupRedeemSubscriptionFixture(t, plan)

	subscriptionCode := &Redemption{
		Name:          "valid subscription code",
		Key:           "30000000000000000000000000000004",
		Status:        common.RedemptionCodeStatusEnabled,
		Type:          RedemptionTypeSubscription,
		PlanId:        plan.Id,
		DurationUnit:  SubscriptionDurationMonth,
		DurationValue: 3,
	}
	require.NoError(t, subscriptionCode.Insert())
	assert.Equal(t, 0, subscriptionCode.Quota, "subscription codes never carry a quota")

	// A subscription code without a plan, an unknown type, and an out-of-range
	// override are all rejected before anything is stored.
	for name, code := range map[string]*Redemption{
		"missing plan": {
			Name: "missing plan", Key: "30000000000000000000000000000005",
			Type: RedemptionTypeSubscription,
		},
		"unknown plan": {
			Name: "unknown plan", Key: "30000000000000000000000000000006",
			Type: RedemptionTypeSubscription, PlanId: plan.Id + 500,
		},
		"unknown type": {
			Name: "unknown type", Key: "30000000000000000000000000000007",
			Type: "coupon", Quota: 100,
		},
		"too long override": {
			Name: "too long", Key: "30000000000000000000000000000008",
			Type: RedemptionTypeSubscription, PlanId: plan.Id,
			DurationUnit: SubscriptionDurationYear, DurationValue: RedemptionDurationMaxYears + 1,
		},
		"stray override": {
			Name: "stray", Key: "30000000000000000000000000000009",
			Type: RedemptionTypeSubscription, PlanId: plan.Id, DurationValue: 2,
		},
	} {
		t.Run(name, func(t *testing.T) {
			require.Error(t, code.Insert())
			var count int64
			require.NoError(t, DB.Model(&Redemption{}).Where("key = ?", code.Key).Count(&count).Error)
			assert.EqualValues(t, 0, count)
		})
	}

	// Switching an existing code back to the quota type clears the
	// subscription-only fields.
	subscriptionCode.Type = RedemptionTypeQuota
	subscriptionCode.Quota = 700
	subscriptionCode.PlanId = plan.Id
	subscriptionCode.DurationUnit = SubscriptionDurationDay
	subscriptionCode.DurationValue = 1
	require.NoError(t, subscriptionCode.Update())
	var stored Redemption
	require.NoError(t, DB.First(&stored, "id = ?", subscriptionCode.Id).Error)
	assert.Equal(t, RedemptionTypeQuota, stored.Type)
	assert.Equal(t, 700, stored.Quota)
	assert.Equal(t, 0, stored.PlanId)
	assert.Empty(t, stored.DurationUnit)
	assert.Equal(t, 0, stored.DurationValue)
	assert.EqualValues(t, 0, stored.DurationSeconds)

	// The code is now redeemable as a quota code.
	result, err := Redeem(subscriptionCode.Key, userId)
	require.NoError(t, err)
	assert.Equal(t, RedemptionTypeQuota, result.Type)
	assert.Equal(t, 700, result.Quota)
}
