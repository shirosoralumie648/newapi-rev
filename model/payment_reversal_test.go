package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/shopspring/decimal"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// preparePaymentReversalWallet creates one wallet with a seeded opening balance
// and pins the quota-per-unit rate so money proceeds in exact decimal amounts.
func preparePaymentReversalWallet(t *testing.T, db *gorm.DB, userId int, quota int) {
	t.Helper()
	oldQuotaPerUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 500000
	t.Cleanup(func() { common.QuotaPerUnit = oldQuotaPerUnit })
	createWalletLedgerWallet(t, db, &User{
		Id:       userId,
		Username: "payment-reversal",
		AffCode:  "payment-reversal",
		Quota:    quota,
		Status:   common.UserStatusEnabled,
	})
}

// createReversalTestTopUp inserts a pending top-up order and credits it through
// the Stripe completion path, exactly like the checkout webhook does, so the
// order carries the provider payment reference a refund webhook matches on.
func createReversalTestTopUp(t *testing.T, tradeNo string, userId int, quota int64) *TopUp {
	t.Helper()
	money := decimal.NewFromFloat(float64(quota) / common.QuotaPerUnit)
	topUp := &TopUp{
		UserId:          userId,
		Money:           money,
		Currency:        "USD",
		TradeNo:         tradeNo,
		PaymentMethod:   PaymentMethodStripe,
		PaymentProvider: PaymentProviderStripe,
		CreateTime:      common.GetTimestamp(),
		Status:          common.TopUpStatusPending,
	}
	require.NoError(t, topUp.Insert())
	err := Recharge(tradeNo, TopUpPaymentInfo{
		CustomerID:        "cus_reversal",
		ProviderPaymentID: "pi_" + tradeNo,
		Currency:          "USD",
	}, "127.0.0.1")
	require.NoError(t, err)
	order := GetTopUpByTradeNo(tradeNo)
	require.NotNil(t, order)
	require.Equal(t, common.TopUpStatusSuccess, order.Status)
	return order
}

// readWalletDebt returns the account's debt row, or a zero row when it has none.
func readWalletDebt(t *testing.T, db *gorm.DB, userId int) WalletDebt {
	t.Helper()
	var debt WalletDebt
	require.NoError(t, db.Where("user_id = ?", userId).Limit(1).Find(&debt).Error)
	return debt
}

// A provider refund or dispute reverses the credited quota down to zero and
// records what the account already spent as wallet debt (WL-06), the order
// status is the idempotency anchor, and the first classification wins.
func TestPaymentReversalDebitsToZeroAndDebtsTheRemainder(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		const userId = 61
		preparePaymentReversalWallet(t, db, userId, 0)
		createReversalTestTopUp(t, "rev-debt-order", userId, 5000000)

		order := GetTopUpByTradeNo("rev-debt-order")
		require.NotNil(t, order)
		assert.True(t, order.Money.Equal(decimal.NewFromInt(10)), "the exact decimal amount round-trips: got %s", order.Money)
		assert.Equal(t, "10.00", formatTopUpMoney(order.Money))
		assert.Equal(t, "pi_rev-debt-order", order.ProviderPaymentId)
		assert.Equal(t, "USD", order.Currency)

		// The account spends most of the credit before the payment is reversed.
		applied, err := ApplyWalletLedgerDelta(DB, userId, WalletLedgerKindConsumeHourly, -4500000, WalletLedgerRefConsumeHourly, "rev-consume", "")
		require.NoError(t, err)
		require.True(t, applied)

		handled, err := ReversePaymentByProviderPaymentId(PaymentProviderStripe, "pi_rev-debt-order", false)
		require.NoError(t, err)
		require.True(t, handled)

		order = GetTopUpByTradeNo("rev-debt-order")
		require.NotNil(t, order)
		assert.Equal(t, common.TopUpStatusRefunded, order.Status)
		assert.NotZero(t, order.RefundTime)

		var user User
		require.NoError(t, db.Select("quota").Where("id = ?", userId).First(&user).Error)
		assert.Zero(t, int64(user.Quota), "the wallet is drawn down to zero, never below")
		assert.Equal(t, int64(4500000), readWalletDebt(t, db, userId).Amount, "the spent part becomes wallet debt")

		// A webhook replay must not reverse the same payment twice.
		handled, err = ReversePaymentByProviderPaymentId(PaymentProviderStripe, "pi_rev-debt-order", false)
		require.NoError(t, err)
		require.True(t, handled)
		user = User{}
		require.NoError(t, db.Select("quota").Where("id = ?", userId).First(&user).Error)
		assert.Zero(t, int64(user.Quota))
		assert.Equal(t, int64(4500000), readWalletDebt(t, db, userId).Amount)

		var reversalRows int64
		require.NoError(t, db.Model(&WalletLedgerEntry{}).
			Where("user_id = ? AND kind = ? AND ref_type = ? AND ref_id = ?",
				userId, WalletLedgerKindChargeback, WalletLedgerRefTopUpReversal, "rev-debt-order").
			Count(&reversalRows).Error)
		assert.Equal(t, int64(1), reversalRows, "one reversal row per order proves the replay was a no-op")

		// The first classification wins: a later dispute keeps the refund.
		require.NoError(t, ReverseTopUpPayment("rev-debt-order", true))
		order = GetTopUpByTradeNo("rev-debt-order")
		require.NotNil(t, order)
		assert.Equal(t, common.TopUpStatusRefunded, order.Status)

		// The debt row and the non-debt ledger sum still reconcile.
		total, _, err := WalletLedgerSumForUser(userId)
		require.NoError(t, err)
		assert.Zero(t, total, "non-debt ledger rows sum to the wallet balance")
	})

	t.Run("dispute classification", func(t *testing.T) {
		db := accountingTestDB(t, "sqlite")
		const userId = 62
		preparePaymentReversalWallet(t, db, userId, 0)
		createReversalTestTopUp(t, "rev-dispute-order", userId, 1000000)

		handled, err := ReversePaymentByProviderPaymentId(PaymentProviderStripe, "pi_rev-dispute-order", true)
		require.NoError(t, err)
		require.True(t, handled)
		order := GetTopUpByTradeNo("rev-dispute-order")
		require.NotNil(t, order)
		assert.Equal(t, common.TopUpStatusDisputed, order.Status)

		var user User
		require.NoError(t, db.Select("quota").Where("id = ?", userId).First(&user).Error)
		assert.Zero(t, int64(user.Quota))
		assert.Zero(t, readWalletDebt(t, db, userId).Amount)
	})
}

// An administrator refund only claws back credit the account still holds; when
// part of the credit was spent the request is rejected instead of booking debt,
// and a successful refund is idempotent.
func TestRefundUnusedTopUpBalanceRejectsSpentCredit(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		const userId = 63
		preparePaymentReversalWallet(t, db, userId, 0)
		createReversalTestTopUp(t, "rev-admin-spent", userId, 5000000)

		// The account already spent part of this credit.
		applied, err := ApplyWalletLedgerDelta(DB, userId, WalletLedgerKindConsumeHourly, -100000, WalletLedgerRefConsumeHourly, "rev-consume-admin", "")
		require.NoError(t, err)
		require.True(t, applied)

		err = RefundUnusedTopUpBalance("rev-admin-spent", "127.0.0.1")
		require.ErrorIs(t, err, ErrTopUpBalanceInsufficient)
		order := GetTopUpByTradeNo("rev-admin-spent")
		require.NotNil(t, order)
		assert.Equal(t, common.TopUpStatusSuccess, order.Status, "a rejected refund leaves the order untouched")
		assert.Zero(t, readWalletDebt(t, db, userId).Amount, "an administrator refund never books debt")

		// An untouched order refunds exactly once and withdraws its quota.
		createReversalTestTopUp(t, "rev-admin-unspent", userId, 1000000)
		require.NoError(t, RefundUnusedTopUpBalance("rev-admin-unspent", "127.0.0.1"))
		order = GetTopUpByTradeNo("rev-admin-unspent")
		require.NotNil(t, order)
		assert.Equal(t, common.TopUpStatusRefunded, order.Status)
		assert.NotZero(t, order.RefundTime)

		var user User
		require.NoError(t, db.Select("quota").Where("id = ?", userId).First(&user).Error)
		assert.Equal(t, int64(4900000), int64(user.Quota))

		require.NoError(t, RefundUnusedTopUpBalance("rev-admin-unspent", "127.0.0.1"))
		user = User{}
		require.NoError(t, db.Select("quota").Where("id = ?", userId).First(&user).Error)
		assert.Equal(t, int64(4900000), int64(user.Quota), "a retry withdraws nothing more")
	})

	t.Run("order without a wallet credit", func(t *testing.T) {
		db := accountingTestDB(t, "sqlite")
		const userId = 64
		preparePaymentReversalWallet(t, db, userId, 300000)
		// A success order whose credit predates the ledger has nothing to refund.
		require.NoError(t, db.Create(&TopUp{
			UserId:          userId,
			Money:           decimal.NewFromInt(100),
			Currency:        "USD",
			TradeNo:         "rev-admin-no-credit",
			PaymentMethod:   PaymentMethodStripe,
			PaymentProvider: PaymentProviderStripe,
			CreateTime:      common.GetTimestamp(),
			Status:          common.TopUpStatusSuccess,
		}).Error)

		err := RefundUnusedTopUpBalance("rev-admin-no-credit", "127.0.0.1")
		require.ErrorIs(t, err, ErrTopUpRefundNotAllowed)
		assert.Equal(t, common.TopUpStatusSuccess, GetTopUpByTradeNo("rev-admin-no-credit").Status)
	})
}

// A subscription order refund cancels the created subscription and its mirrored
// top-up row, and it never moves wallet money because subscription quota is not
// wallet balance.
func TestSubscriptionOrderReversalCancelsSubscriptionWithoutWalletMovement(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		const userId = 65
		preparePaymentReversalWallet(t, db, userId, 1000000)
		plan := insertSubscriptionPlanForPaymentGuardTest(t, 611)
		order := &SubscriptionOrder{
			UserId:          userId,
			PlanId:          plan.Id,
			Money:           decimal.NewFromFloat(9.99),
			Currency:        "USD",
			TradeNo:         "rev-sub-order",
			PaymentMethod:   PaymentMethodStripe,
			PaymentProvider: PaymentProviderStripe,
			Status:          common.TopUpStatusPending,
			CreateTime:      common.GetTimestamp(),
		}
		require.NoError(t, order.Insert())
		require.NoError(t, CompleteSubscriptionOrder("rev-sub-order", TopUpPaymentInfo{
			ProviderPaymentID: "pi_rev-sub-order",
			Currency:          "USD",
		}, `{"provider":"stripe"}`, PaymentProviderStripe, ""))

		var sub UserSubscription
		require.NoError(t, db.Where("trade_no = ?", "rev-sub-order").First(&sub).Error)
		require.Equal(t, "active", sub.Status)
		mirror := GetTopUpByTradeNo("rev-sub-order")
		require.NotNil(t, mirror)
		require.Equal(t, common.TopUpStatusSuccess, mirror.Status)
		require.Equal(t, "pi_rev-sub-order", mirror.ProviderPaymentId)

		handled, err := ReversePaymentByProviderPaymentId(PaymentProviderStripe, "pi_rev-sub-order", false)
		require.NoError(t, err)
		require.True(t, handled)

		order = GetSubscriptionOrderByTradeNo("rev-sub-order")
		require.NotNil(t, order)
		assert.Equal(t, common.TopUpStatusRefunded, order.Status)
		mirror = GetTopUpByTradeNo("rev-sub-order")
		require.NotNil(t, mirror)
		assert.Equal(t, common.TopUpStatusRefunded, mirror.Status)
		sub = UserSubscription{}
		require.NoError(t, db.Where("trade_no = ?", "rev-sub-order").First(&sub).Error)
		assert.Equal(t, "cancelled", sub.Status)

		var user User
		require.NoError(t, db.Select("quota").Where("id = ?", userId).First(&user).Error)
		assert.Equal(t, 1000000, user.Quota, "subscription reversal leaves wallet money untouched")
		total, _, err := WalletLedgerSumForUser(userId)
		require.NoError(t, err)
		assert.Equal(t, int64(1000000), total)

		// Replays are no-ops.
		handled, err = ReversePaymentByProviderPaymentId(PaymentProviderStripe, "pi_rev-sub-order", false)
		require.NoError(t, err)
		require.True(t, handled)
		order = GetSubscriptionOrderByTradeNo("rev-sub-order")
		assert.Equal(t, common.TopUpStatusRefunded, order.Status)
	})
}
