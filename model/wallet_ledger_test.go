package model

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
)

// accountingTestDB opens a dedicated database for one dialect: in-memory
// SQLite by default, or the external test database from TEST_MYSQL_DSN /
// TEST_POSTGRES_DSN so the wallet ledger and subscription settlement contracts
// are verified on every supported engine. Table names are prefixed so
// concurrent runs cannot clash.
func accountingTestDB(t *testing.T, dialect string) *gorm.DB {
	t.Helper()
	var driver gorm.Dialector
	switch dialect {
	case "mysql":
		dsn := os.Getenv("TEST_MYSQL_DSN")
		if dsn == "" {
			t.Skip("TEST_MYSQL_DSN not configured")
		}
		driver = mysql.Open(dsn)
	case "postgres":
		dsn := os.Getenv("TEST_POSTGRES_DSN")
		if dsn == "" {
			t.Skip("TEST_POSTGRES_DSN not configured")
		}
		driver = postgres.Open(dsn)
	default:
		driver = sqlite.Open(":memory:")
	}
	prefix := fmt.Sprintf("wltest_%d_", os.Getpid())
	db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: prefix}, Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	if dialect == "sqlite" {
		sqlDB, err := db.DB()
		require.NoError(t, err)
		sqlDB.SetMaxOpenConns(1)
	}

	previous := DB
	previousLog := LOG_DB
	previousMain, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
	previousRedis := common.RedisEnabled
	previousBatch := common.BatchUpdateEnabled
	common.SetDatabaseTypes(common.DatabaseType(dialect), previousLogType)
	common.RedisEnabled = false
	common.BatchUpdateEnabled = false
	DB = db
	LOG_DB = db
	t.Cleanup(func() {
		require.NoError(t, db.Migrator().DropTable(&WalletLedgerEntry{}, &WalletHold{}, &WalletHoldGrant{}, &WalletDebt{}, &CreditGrant{}, &SubscriptionPreConsumeRecord{}, &UserSubscription{}, &SubscriptionPlan{}, &User{}))
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
		DB = previous
		LOG_DB = previousLog
		common.SetDatabaseTypes(previousMain, previousLogType)
		common.RedisEnabled = previousRedis
		common.BatchUpdateEnabled = previousBatch
	})

	// A fresh migration and a repeated migration both succeed, so the new
	// tables are created idempotently on every engine.
	require.NoError(t, db.AutoMigrate(&User{}, &WalletLedgerEntry{}, &WalletHold{}, &WalletHoldGrant{}, &WalletDebt{}, &CreditGrant{}, &SubscriptionPlan{}, &UserSubscription{}, &SubscriptionPreConsumeRecord{}))
	require.NoError(t, db.AutoMigrate(&User{}, &WalletLedgerEntry{}, &WalletHold{}, &WalletHoldGrant{}, &WalletDebt{}, &CreditGrant{}, &SubscriptionPlan{}, &UserSubscription{}, &SubscriptionPreConsumeRecord{}))
	var version string
	versionQuery := "SELECT version()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("accounting database: %s %s", dialect, version)
	return db
}

func forEachAccountingDialect(t *testing.T, run func(t *testing.T, db *gorm.DB)) {
	t.Helper()
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			run(t, accountingTestDB(t, dialect))
		})
	}
}

// createWalletLedgerWallet creates one fixture wallet and seeds its opening
// balance. A wallet's starting quota is funded outside the ledger, so
// reconciliation can only explain it through the opening_balance row that
// production writes on user creation and seeds at startup.
func createWalletLedgerWallet(t *testing.T, db *gorm.DB, user *User) {
	t.Helper()
	require.NoError(t, db.Create(user).Error)
	_, err := EnsureWalletLedgerOpeningBalances()
	require.NoError(t, err)
}

// The ledger row and the balance update must commit or roll back together, and
// replaying the same reference must never move the balance twice.
func TestWalletLedgerApplyDeltaIsAtomicAndReplaySafe(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 41, Username: "ledger-atomic", AffCode: "ledger-atomic", Quota: 1000, Status: common.UserStatusEnabled}).Error)

		require.NoError(t, db.Transaction(func(tx *gorm.DB) error {
			applied, err := ApplyWalletLedgerDelta(tx, 41, WalletLedgerKindTopUp, 500, WalletLedgerRefTopUp, "tx-commit", "")
			require.NoError(t, err)
			require.True(t, applied)
			return nil
		}))

		var stored User
		require.NoError(t, db.Select("quota").First(&stored, 41).Error)
		assert.Equal(t, 1500, stored.Quota)
		var entry WalletLedgerEntry
		require.NoError(t, db.Where("ref_type = ? AND ref_id = ?", WalletLedgerRefTopUp, "tx-commit").First(&entry).Error)
		assert.Equal(t, WalletLedgerKindTopUp, entry.Kind)
		assert.EqualValues(t, 500, entry.Amount)
		assert.EqualValues(t, 1500, entry.BalanceAfter)

		// A failure after the ledger claim rolls back both writes.
		sentinel := errors.New("rollback after ledger claim")
		err := db.Transaction(func(tx *gorm.DB) error {
			applied, applyErr := ApplyWalletLedgerDelta(tx, 41, WalletLedgerKindTopUp, 250, WalletLedgerRefTopUp, "tx-rollback", "")
			require.NoError(t, applyErr)
			require.True(t, applied)
			return sentinel
		})
		require.ErrorIs(t, err, sentinel)
		require.NoError(t, db.Select("quota").First(&stored, 41).Error)
		assert.Equal(t, 1500, stored.Quota)
		var rolledBack int64
		require.NoError(t, db.Model(&WalletLedgerEntry{}).Where("ref_type = ? AND ref_id = ?", WalletLedgerRefTopUp, "tx-rollback").Count(&rolledBack).Error)
		assert.Zero(t, rolledBack)

		// Replaying the committed reference is a no-op.
		applied, err := ApplyWalletLedgerDeltaDB(41, WalletLedgerKindTopUp, 500, WalletLedgerRefTopUp, "tx-commit", "")
		require.NoError(t, err)
		assert.False(t, applied)
		require.NoError(t, db.Select("quota").First(&stored, 41).Error)
		assert.Equal(t, 1500, stored.Quota)
	})
}

// Consumption must converge on exactly one consume_hourly row per user and
// hour in both the batch-update and the direct-write mode.
func TestWalletLedgerAggregatesConsumptionPerUserHour(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 42, Username: "ledger-consume", AffCode: "ledger-consume", Quota: 1000, Status: common.UserStatusEnabled}).Error)

		RecordWalletConsumeDelta(42, -100)
		RecordWalletConsumeDelta(42, 40)

		hour := common.GetTimestamp() / walletLedgerConsumeHourSeconds * walletLedgerConsumeHourSeconds
		var rows []WalletLedgerEntry
		require.NoError(t, db.Where("user_id = ? AND kind = ?", 42, WalletLedgerKindConsumeHourly).Find(&rows).Error)
		require.Len(t, rows, 1)
		assert.Equal(t, WalletLedgerRefConsumeHourly, rows[0].RefType)
		assert.Equal(t, fmt.Sprintf("%d:%d", 42, hour), rows[0].RefId)
		assert.EqualValues(t, -60, rows[0].Amount)
		assert.EqualValues(t, 1000, rows[0].BalanceAfter)

		// Batch mode accumulates in memory and flushes into the same row.
		common.BatchUpdateEnabled = true
		RecordWalletConsumeDelta(42, -30)
		FlushBatchUpdates()
		rows = nil
		require.NoError(t, db.Where("user_id = ? AND kind = ?", 42, WalletLedgerKindConsumeHourly).Find(&rows).Error)
		require.Len(t, rows, 1)
		assert.EqualValues(t, -90, rows[0].Amount)
	})
}

// The first launch writes one opening_balance baseline per user and repeating
// the seed neither duplicates rows nor touches balances.
func TestWalletLedgerOpeningBalanceSeedsOncePerUser(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 51, Username: "ledger-opening-a", AffCode: "ledger-opening-a", Quota: 700, Status: common.UserStatusEnabled}).Error)
		require.NoError(t, db.Create(&User{Id: 52, Username: "ledger-opening-b", AffCode: "ledger-opening-b", Quota: 0, Status: common.UserStatusEnabled}).Error)

		seeded, err := EnsureWalletLedgerOpeningBalances()
		require.NoError(t, err)
		assert.Equal(t, 2, seeded)

		var entry WalletLedgerEntry
		require.NoError(t, db.Where("ref_type = ? AND ref_id = ?", WalletLedgerRefOpening, "51").First(&entry).Error)
		assert.Equal(t, WalletLedgerKindOpeningBalance, entry.Kind)
		assert.EqualValues(t, 700, entry.Amount)
		assert.EqualValues(t, 700, entry.BalanceAfter)

		seeded, err = EnsureWalletLedgerOpeningBalances()
		require.NoError(t, err)
		assert.Zero(t, seeded, "a second seed must not insert duplicate baselines")
		var count int64
		require.NoError(t, db.Model(&WalletLedgerEntry{}).Where("user_id = ?", 51).Count(&count).Error)
		assert.EqualValues(t, 1, count)

		require.NoError(t, db.Create(&User{Id: 53, Username: "ledger-opening-c", AffCode: "ledger-opening-c", Quota: 25, Status: common.UserStatusEnabled}).Error)
		seeded, err = EnsureWalletLedgerOpeningBalances()
		require.NoError(t, err)
		assert.Equal(t, 1, seeded)
	})
}

// A wallet that no longer matches its ledger sum is reported as a deviation,
// and reconciliation never repairs the balance by itself.
func TestWalletReconcileReportsDeviationWithoutChangingBalance(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 61, Username: "ledger-ok", AffCode: "ledger-ok", Quota: 0, Status: common.UserStatusEnabled}).Error)
		applied, err := ApplyWalletLedgerDeltaDB(61, WalletLedgerKindTopUp, 1000, WalletLedgerRefTopUp, "reconcile-ok", "")
		require.NoError(t, err)
		require.True(t, applied)

		require.NoError(t, db.Create(&User{Id: 62, Username: "ledger-bad", AffCode: "ledger-bad", Quota: 400, Status: common.UserStatusEnabled}).Error)
		applied, err = ApplyWalletLedgerDeltaDB(62, WalletLedgerKindTopUp, 500, WalletLedgerRefTopUp, "reconcile-bad", "")
		require.NoError(t, err)
		require.True(t, applied)
		// Simulate an out-of-band balance change no ledger row explains.
		require.NoError(t, db.Model(&User{}).Where("id = ?", 62).Update("quota", 650).Error)

		ok, err := ReconcileWalletLedgerForUser(61)
		require.NoError(t, err)
		assert.True(t, ok.Reconciled)
		assert.Zero(t, ok.Deviation)

		bad, err := ReconcileWalletLedgerForUser(62)
		require.NoError(t, err)
		assert.False(t, bad.Reconciled)
		assert.EqualValues(t, 500, bad.LedgerSum)
		assert.EqualValues(t, 650, bad.Quota)
		assert.EqualValues(t, -150, bad.Deviation)

		report, err := ReconcileWalletLedgers(10)
		require.NoError(t, err)
		assert.EqualValues(t, 2, report.UserCount)
		assert.EqualValues(t, 1, report.DeviationCount)
		require.Len(t, report.Deviations, 1)
		assert.Equal(t, 62, report.Deviations[0].UserId)
		assert.EqualValues(t, -150, report.Deviations[0].Deviation)

		var stored User
		require.NoError(t, db.Select("quota").First(&stored, 62).Error)
		assert.Equal(t, 650, stored.Quota, "reconciliation must not modify balances")
	})
}

// A wallet pre-consume persists an active hold next to the deduction, an extra
// reservation extends that hold instead of opening a second one, and settlement
// closes it while charging exactly the difference.
func TestWalletHoldReserveExtendsAndSettles(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 71, Username: "hold-settle", AffCode: "hold-settle", Quota: 1000, Status: common.UserStatusEnabled}).Error)
		startedAt := common.GetTimestamp()

		reserved, err := TryReserveUserQuota(71, 300, "hold-settle-a")
		require.NoError(t, err)
		require.True(t, reserved)
		var user User
		require.NoError(t, db.Select("quota").First(&user, 71).Error)
		assert.Equal(t, 700, user.Quota)

		hold, err := GetWalletHoldByRequestId("hold-settle-a")
		require.NoError(t, err)
		assert.Equal(t, WalletHoldStatusActive, hold.Status)
		assert.EqualValues(t, 300, hold.Amount)
		assert.Equal(t, 71, hold.UserId)
		assert.Nil(t, hold.ParentId)
		assert.Greater(t, hold.ExpiresAt, startedAt)

		// Insufficient balance neither deducts nor leaves a hold behind.
		reserved, err = TryReserveUserQuota(71, 701, "hold-settle-b")
		require.NoError(t, err)
		assert.False(t, reserved)
		require.NoError(t, db.Select("quota").First(&user, 71).Error)
		assert.Equal(t, 700, user.Quota)
		_, err = GetWalletHoldByRequestId("hold-settle-b")
		assert.ErrorIs(t, err, gorm.ErrRecordNotFound)

		// A mid-flight reserve (channel switch, image override) extends the same
		// hold and can admit wallet debt.
		applied, err := ReserveUserQuotaWithDebt(71, 150, "hold-settle-a")
		require.NoError(t, err)
		require.EqualValues(t, 150, applied)
		hold, err = GetWalletHoldByRequestId("hold-settle-a")
		require.NoError(t, err)
		assert.EqualValues(t, 450, hold.Amount)
		var holdCount int64
		require.NoError(t, db.Model(&WalletHold{}).Where("user_id = ?", 71).Count(&holdCount).Error)
		assert.EqualValues(t, 1, holdCount, "one request keeps exactly one hold")
		require.NoError(t, db.Select("quota").First(&user, 71).Error)
		assert.Equal(t, 550, user.Quota)

		// Settling below the reservation returns the difference and closes the hold.
		charged, err := SettleWalletHold(71, "hold-settle-a", -50)
		require.NoError(t, err)
		assert.EqualValues(t, -50, charged)
		require.NoError(t, db.Select("quota").First(&user, 71).Error)
		assert.Equal(t, 600, user.Quota)
		hold, err = GetWalletHoldByRequestId("hold-settle-a")
		require.NoError(t, err)
		assert.Equal(t, WalletHoldStatusSettled, hold.Status)

		// Replaying the settlement never charges again.
		charged, err = SettleWalletHold(71, "hold-settle-a", -50)
		require.NoError(t, err)
		assert.Zero(t, charged)
		require.NoError(t, db.Select("quota").First(&user, 71).Error)
		assert.Equal(t, 600, user.Quota)

		// A reservation for a request whose hold is closed is refused.
		_, err = TryReserveUserQuota(71, 10, "hold-settle-a")
		assert.ErrorIs(t, err, ErrWalletHoldClosed)
		require.NoError(t, db.Select("quota").First(&user, 71).Error)
		assert.Equal(t, 600, user.Quota)

		// Settling above the reservation charges the difference.
		reserved, err = TryReserveUserQuota(71, 50, "hold-settle-c")
		require.NoError(t, err)
		require.True(t, reserved)
		charged, err = SettleWalletHold(71, "hold-settle-c", 30)
		require.NoError(t, err)
		assert.EqualValues(t, 30, charged)
		require.NoError(t, db.Select("quota").First(&user, 71).Error)
		assert.Equal(t, 520, user.Quota)
	})
}

// Refunds are idempotent through the hold status and the wallet ledger, and a
// settlement that arrives after a refund still pays the full actual charge
// because the pre-consume is no longer held.
func TestWalletHoldRefundIsIdempotent(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		createWalletLedgerWallet(t, db, &User{Id: 81, Username: "hold-refund", AffCode: "hold-refund", Quota: 1000, Status: common.UserStatusEnabled})
		var user User

		reserved, err := TryReserveUserQuota(81, 200, "hold-refund-a")
		require.NoError(t, err)
		require.True(t, reserved)
		RecordWalletConsumeDelta(81, -200)

		applied, err := RefundWalletHold(81, "hold-refund-a", 0)
		require.NoError(t, err)
		assert.True(t, applied)
		require.NoError(t, db.Select("quota").First(&user, 81).Error)
		assert.Equal(t, 1000, user.Quota)
		hold, err := GetWalletHoldByRequestId("hold-refund-a")
		require.NoError(t, err)
		assert.Equal(t, WalletHoldStatusRefunded, hold.Status)

		// Replaying the refund is a no-op: no second credit, no second ledger row.
		applied, err = RefundWalletHold(81, "hold-refund-a", 0)
		require.NoError(t, err)
		assert.False(t, applied)
		require.NoError(t, db.Select("quota").First(&user, 81).Error)
		assert.Equal(t, 1000, user.Quota)
		var refundRows int64
		require.NoError(t, db.Model(&WalletLedgerEntry{}).
			Where("ref_type = ? AND ref_id = ?", WalletLedgerRefRequestRefund, "hold-refund-a").
			Count(&refundRows).Error)
		assert.EqualValues(t, 1, refundRows)

		// The reservation and its refund cancel out in the ledger.
		reconciliation, err := ReconcileWalletLedgerForUser(81)
		require.NoError(t, err)
		assert.True(t, reconciliation.Reconciled, "deviation=%d", reconciliation.Deviation)

		// A request whose process died after the refund was already returned is
		// charged the full actual amount when it settles late.
		reserved, err = TryReserveUserQuota(81, 300, "hold-refund-b")
		require.NoError(t, err)
		require.True(t, reserved)
		RecordWalletConsumeDelta(81, -300)
		applied, err = RefundWalletHold(81, "hold-refund-b", 0)
		require.NoError(t, err)
		require.True(t, applied)
		charged, err := SettleWalletHold(81, "hold-refund-b", 0)
		require.NoError(t, err)
		assert.EqualValues(t, 300, charged, "a refunded reservation must still pay the full actual charge")
		RecordWalletConsumeDelta(81, -charged)
		require.NoError(t, db.Select("quota").First(&user, 81).Error)
		assert.Equal(t, 700, user.Quota)

		reconciliation, err = ReconcileWalletLedgerForUser(81)
		require.NoError(t, err)
		assert.True(t, reconciliation.Reconciled, "deviation=%d", reconciliation.Deviation)
	})
}

// A process that stops between the pre-consume and the settlement leaves an
// active hold behind; the recovery sweep returns that quota exactly once, and
// settled or fresh reservations are never touched.
func TestWalletHoldExpiryRecoveryRefundsCrashedReservations(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		createWalletLedgerWallet(t, db, &User{Id: 91, Username: "hold-expiry", AffCode: "hold-expiry", Quota: 1000, Status: common.UserStatusEnabled})
		var user User

		reserved, err := TryReserveUserQuota(91, 250, "hold-expiry-a")
		require.NoError(t, err)
		require.True(t, reserved)
		RecordWalletConsumeDelta(91, -250)
		hold, err := GetWalletHoldByRequestId("hold-expiry-a")
		require.NoError(t, err)

		// A reservation inside its lifetime is left alone.
		result, err := RefundExpiredWalletHolds(hold.ExpiresAt-1, 200)
		require.NoError(t, err)
		assert.Zero(t, result.ExpiredCount)
		require.NoError(t, db.Select("quota").First(&user, 91).Error)
		assert.Equal(t, 750, user.Quota)

		// Once the lifetime elapsed the sweep returns the reservation.
		result, err = RefundExpiredWalletHolds(hold.ExpiresAt, 200)
		require.NoError(t, err)
		assert.Equal(t, 1, result.ScannedCount)
		assert.Equal(t, 1, result.ExpiredCount)
		assert.Zero(t, result.FailedCount)
		assert.EqualValues(t, 250, result.RefundedQuota)
		require.NoError(t, db.Select("quota").First(&user, 91).Error)
		assert.Equal(t, 1000, user.Quota)
		expiredHold, err := GetWalletHoldByRequestId("hold-expiry-a")
		require.NoError(t, err)
		assert.Equal(t, WalletHoldStatusExpired, expiredHold.Status)

		// Replaying the sweep and a late normal refund never refund twice.
		result, err = RefundExpiredWalletHolds(hold.ExpiresAt+3600, 200)
		require.NoError(t, err)
		assert.Zero(t, result.ExpiredCount)
		applied, err := RefundWalletHold(91, "hold-expiry-a", 250)
		require.NoError(t, err)
		assert.False(t, applied)
		require.NoError(t, db.Select("quota").First(&user, 91).Error)
		assert.Equal(t, 1000, user.Quota)

		// A settled reservation is never refunded by the sweep.
		reserved, err = TryReserveUserQuota(91, 100, "hold-expiry-b")
		require.NoError(t, err)
		require.True(t, reserved)
		RecordWalletConsumeDelta(91, -100)
		charged, err := SettleWalletHold(91, "hold-expiry-b", 0)
		require.NoError(t, err)
		assert.Zero(t, charged)
		settled, err := GetWalletHoldByRequestId("hold-expiry-b")
		require.NoError(t, err)
		result, err = RefundExpiredWalletHolds(settled.ExpiresAt+3600, 200)
		require.NoError(t, err)
		assert.Zero(t, result.ExpiredCount)
		require.NoError(t, db.Select("quota").First(&user, 91).Error)
		assert.Equal(t, 900, user.Quota)

		reconciliation, err := ReconcileWalletLedgerForUser(91)
		require.NoError(t, err)
		assert.True(t, reconciliation.Reconciled, "deviation=%d", reconciliation.Deviation)

		// A normal refund racing the sweep returns the reservation exactly once.
		createWalletLedgerWallet(t, db, &User{Id: 92, Username: "hold-race", AffCode: "hold-race", Quota: 1000, Status: common.UserStatusEnabled})
		reserved, err = TryReserveUserQuota(92, 400, "hold-race-a")
		require.NoError(t, err)
		require.True(t, reserved)
		raceHold, err := GetWalletHoldByRequestId("hold-race-a")
		require.NoError(t, err)
		var race sync.WaitGroup
		race.Add(2)
		go func() {
			defer race.Done()
			_, _ = RefundWalletHold(92, "hold-race-a", 0)
		}()
		go func() {
			defer race.Done()
			_, _ = RefundExpiredWalletHolds(raceHold.ExpiresAt, 200)
		}()
		race.Wait()
		var raced User
		require.NoError(t, db.Select("quota").First(&raced, 92).Error)
		assert.Equal(t, 1000, raced.Quota, "exactly one path may return the reservation")
		var raceRefundRows int64
		require.NoError(t, db.Model(&WalletLedgerEntry{}).
			Where("ref_type = ? AND ref_id = ?", WalletLedgerRefRequestRefund, "hold-race-a").
			Count(&raceRefundRows).Error)
		assert.EqualValues(t, 1, raceRefundRows)

		// Closed holds are pruned after the retention window; active holds are kept.
		cleaned, err := CleanupClosedWalletHolds(common.GetTimestamp()+1, 200)
		require.NoError(t, err)
		assert.Equal(t, 3, cleaned, "every closed hold is pruned")
		var remain int64
		require.NoError(t, db.Model(&WalletHold{}).Count(&remain).Error)
		assert.Zero(t, remain)
	})
}

// A workflow run budget (BL-03) is one root hold per run; per-step child holds
// mount on it without deducting quota again and are closed with their parent.
func TestWalletHoldBudgetParentMountsChildren(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 101, Username: "hold-budget", AffCode: "hold-budget", Quota: 1000, Status: common.UserStatusEnabled}).Error)
		var user User

		parent, err := CreateWalletBudgetHold(101, "workflow-run-1", 400)
		require.NoError(t, err)
		assert.EqualValues(t, 400, parent.Amount)
		assert.Nil(t, parent.ParentId)
		require.NoError(t, db.Select("quota").First(&user, 101).Error)
		assert.Equal(t, 600, user.Quota)

		child, err := MountWalletBudgetChild("workflow-run-1", "workflow-run-1-node-1", 101, 120)
		require.NoError(t, err)
		require.NotNil(t, child.ParentId)
		assert.Equal(t, parent.Id, *child.ParentId)
		require.NoError(t, db.Select("quota").First(&user, 101).Error)
		assert.Equal(t, 600, user.Quota, "a budget child allocates inside the parent reservation")

		// The same step reporting again extends its allocation.
		child, err = MountWalletBudgetChild("workflow-run-1", "workflow-run-1-node-1", 101, 30)
		require.NoError(t, err)
		assert.EqualValues(t, 150, child.Amount)

		// A budget hold belongs to its owner and needs a root parent.
		_, err = MountWalletBudgetChild("workflow-run-1", "workflow-run-1-node-2", 102, 10)
		assert.Error(t, err)
		_, err = MountWalletBudgetChild("workflow-run-missing", "workflow-run-1-node-3", 101, 10)
		assert.ErrorIs(t, err, ErrWalletHoldNotFound)
		_, err = MountWalletBudgetChild("workflow-run-1-node-1", "workflow-run-1-node-4", 101, 10)
		assert.Error(t, err)

		// The sweep owns the money on the parent and closes the children with it.
		expired, err := RefundExpiredWalletHolds(parent.ExpiresAt, 200)
		require.NoError(t, err)
		assert.Equal(t, 1, expired.ExpiredCount)
		assert.EqualValues(t, 400, expired.RefundedQuota)
		require.NoError(t, db.Select("quota").First(&user, 101).Error)
		assert.Equal(t, 1000, user.Quota)
		closedChild, err := GetWalletHoldByRequestId("workflow-run-1-node-1")
		require.NoError(t, err)
		assert.Equal(t, WalletHoldStatusExpired, closedChild.Status)
		closedParent, err := GetWalletHoldByRequestId("workflow-run-1")
		require.NoError(t, err)
		assert.Equal(t, WalletHoldStatusExpired, closedParent.Status)

		// A closed parent accepts no further mounts, and a budget the wallet
		// cannot cover is refused without deducting.
		_, err = MountWalletBudgetChild("workflow-run-1", "workflow-run-1-node-5", 101, 10)
		assert.ErrorIs(t, err, ErrWalletHoldClosed)
		_, err = CreateWalletBudgetHold(101, "workflow-run-2", 2000)
		assert.ErrorIs(t, err, ErrWalletHoldInsufficientQuota)
		require.NoError(t, db.Select("quota").First(&user, 101).Error)
		assert.Equal(t, 1000, user.Quota)

		// Settling the parent closes active children as settled as well.
		parent, err = CreateWalletBudgetHold(101, "workflow-run-3", 200)
		require.NoError(t, err)
		_, err = MountWalletBudgetChild("workflow-run-3", "workflow-run-3-node-1", 101, 60)
		require.NoError(t, err)
		charged, err := SettleWalletHold(101, "workflow-run-3", -50)
		require.NoError(t, err)
		assert.EqualValues(t, -50, charged)
		settledChild, err := GetWalletHoldByRequestId("workflow-run-3-node-1")
		require.NoError(t, err)
		assert.Equal(t, WalletHoldStatusSettled, settledChild.Status)
	})
}

// The Redis Lua reservation path persists its hold before returning, so a
// cache-authorized reservation is recoverable after a crash exactly like the
// conditional update path even with batch updates enabled.
func TestWalletHoldRedisReserveWritesHold(t *testing.T) {
	truncateTables(t)
	resetBatchUpdateTestState(t)
	useUserCacheMiniRedis(t)
	common.BatchUpdateEnabled = true

	user := createReserveTestUser(t, 10)
	reserved, err := TryReserveUserQuota(user.Id, 8, "hold-redis-a")
	require.NoError(t, err)
	require.True(t, reserved)

	assert.Equal(t, 2, getUserQuotaFromDB(t, user.Id), "a hold-bearing reservation is never deferred to the batch queue")
	hold, err := GetWalletHoldByRequestId("hold-redis-a")
	require.NoError(t, err)
	assert.Equal(t, WalletHoldStatusActive, hold.Status)
	assert.EqualValues(t, 8, hold.Amount)
	cached, err := GetUserCache(user.Id)
	require.NoError(t, err)
	assert.Equal(t, 2, cached.Quota)

	// The cache stays authoritative for the next reservation and the same hold
	// grows with it.
	applied, err := ReserveUserQuotaWithDebt(user.Id, 1, "hold-redis-a")
	require.NoError(t, err)
	require.EqualValues(t, 1, applied)
	assert.Equal(t, 1, getUserQuotaFromDB(t, user.Id))
	hold, err = GetWalletHoldByRequestId("hold-redis-a")
	require.NoError(t, err)
	assert.EqualValues(t, 9, hold.Amount)
	cached, err = GetUserCache(user.Id)
	require.NoError(t, err)
	assert.Equal(t, 1, cached.Quota)

	charged, err := SettleWalletHold(user.Id, "hold-redis-a", -1)
	require.NoError(t, err)
	assert.EqualValues(t, -1, charged)
	assert.Equal(t, 2, getUserQuotaFromDB(t, user.Id))
	cached, err = GetUserCache(user.Id)
	require.NoError(t, err)
	assert.Equal(t, 2, cached.Quota)
}

// useWalletOverdraftLimit installs one overdraft credit line (USD, plus per
// group overrides) for the duration of a test and restores the shared setting
// afterwards.
func useWalletOverdraftLimit(t *testing.T, usd float64, groupOverrides map[string]float64) {
	t.Helper()
	setting := operation_setting.GetQuotaSetting()
	previousUSD, previousOverrides := setting.OverdraftLimitUSD, setting.OverdraftGroupOverrides
	previousUnit := common.QuotaPerUnit
	setting.OverdraftLimitUSD = usd
	setting.OverdraftGroupOverrides = groupOverrides
	common.QuotaPerUnit = 500_000
	t.Cleanup(func() {
		setting.OverdraftLimitUSD = previousUSD
		setting.OverdraftGroupOverrides = previousOverrides
		common.QuotaPerUnit = previousUnit
	})
}

// A settlement charge may use the account's overdraft credit line, and whatever
// exceeds it becomes tracked debt instead of a negative balance that keeps
// growing. Debt rows live in the ledger next to the wallet rows, so both
// accounts reconcile.
func TestWalletDebtSettleRespectsOverdraftLimit(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		useWalletOverdraftLimit(t, 0.02, nil)
		createWalletLedgerWallet(t, db, &User{Id: 201, Username: "debt-settle", AffCode: "debt-settle", Quota: 5_000, Group: "default", Status: common.UserStatusEnabled})

		// A pre-consume of the whole balance, then a settlement 3_000 above the
		// reservation: the credit line (10_000) still covers it. Each wallet
		// movement is recorded in the consumption ledger exactly as the service
		// funding source records it.
		reserved, err := TryReserveUserQuota(201, 5_000, "debt-settle-a")
		require.NoError(t, err)
		require.True(t, reserved)
		RecordWalletConsumeDelta(201, -5_000)
		charged, err := SettleWalletHold(201, "debt-settle-a", 3_000)
		require.NoError(t, err)
		assert.EqualValues(t, 3_000, charged)
		RecordWalletConsumeDelta(201, -charged)
		balance, err := GetUserQuota(201, true)
		require.NoError(t, err)
		assert.Equal(t, -3_000, balance)
		debt, err := WalletDebtForUser(201)
		require.NoError(t, err)
		assert.Zero(t, debt, "a charge inside the credit line is no debt")
		_, readOnly, err := ResolveWalletDebtStatus(201)
		require.NoError(t, err)
		assert.False(t, readOnly)

		// The next charge exceeds the remaining credit line: the wallet is
		// debited exactly down to it and the uncovered 1_000 becomes debt.
		charged, err = SettleWalletHold(201, "debt-settle-b", 8_000)
		require.NoError(t, err)
		assert.EqualValues(t, 7_000, charged)
		RecordWalletConsumeDelta(201, -charged)
		balance, err = GetUserQuota(201, true)
		require.NoError(t, err)
		assert.Equal(t, -10_000, balance, "the wallet never goes below its credit line")
		debt, err = WalletDebtForUser(201)
		require.NoError(t, err)
		assert.EqualValues(t, 1_000, debt)

		var entry WalletLedgerEntry
		require.NoError(t, db.Where("user_id = ? AND kind = ?", 201, WalletLedgerKindDebt).First(&entry).Error)
		assert.EqualValues(t, 1_000, entry.Amount)
		assert.Contains(t, entry.Meta, "outstanding_debt=1000")
		reconcile, err := ReconcileWalletLedgerForUser(201)
		require.NoError(t, err)
		assert.True(t, reconcile.Reconciled, "wallet sum %d vs balance %d, debt rows %d vs stored %d", reconcile.LedgerSum, reconcile.Quota, reconcile.Debt, reconcile.DebtBalance)
		assert.EqualValues(t, 1_000, reconcile.Debt)

		// A group override replaces the default credit line for that group only.
		useWalletOverdraftLimit(t, 0, map[string]float64{"default": 0.04})
		assert.EqualValues(t, 20_000, OverdraftLimitQuotaForGroup("default"))
		assert.Zero(t, OverdraftLimitQuotaForGroup("basic"))
	})
}

// Concurrent charges of one account are serialized on the wallet row, so no
// matter how many requests settle at the same time the wallet balance never
// goes below its credit line; the rest is recorded as debt.
func TestWalletDebtConcurrentChargesStayWithinOverdraftLimit(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		useWalletOverdraftLimit(t, 0.02, nil) // 10_000 quota
		createWalletLedgerWallet(t, db, &User{Id: 211, Username: "debt-concurrent", AffCode: "debt-concurrent", Quota: 0, Group: "default", Status: common.UserStatusEnabled})

		const charges = 5
		const chargeQuota = 4_000
		var (
			mu      sync.Mutex
			applied int64
			wg      sync.WaitGroup
		)
		for i := range charges {
			wg.Go(func() {
				charged, err := SettleWalletHold(211, fmt.Sprintf("debt-concurrent-%d", i), chargeQuota)
				if err != nil {
					t.Errorf("concurrent settlement %d failed: %v", i, err)
					return
				}
				mu.Lock()
				applied += charged
				mu.Unlock()
			})
		}
		wg.Wait()
		// The service funding source records exactly the wallet movement of
		// every settlement in the consumption ledger.
		RecordWalletConsumeDelta(211, -applied)

		balance, err := GetUserQuota(211, true)
		require.NoError(t, err)
		assert.Equal(t, -10_000, balance, "concurrent settlements must not exceed the overdraft limit")
		debt, err := WalletDebtForUser(211)
		require.NoError(t, err)
		assert.EqualValues(t, charges*chargeQuota-10_000, debt)
		reconcile, err := ReconcileWalletLedgerForUser(211)
		require.NoError(t, err)
		assert.True(t, reconcile.Reconciled, "wallet sum %d vs balance %d, debt rows %d vs stored %d", reconcile.LedgerSum, reconcile.Quota, reconcile.Debt, reconcile.DebtBalance)
	})
}

// Debt locks the account read-only, a recharge collects it automatically
// without an administrator, and a partial recharge still leaves the account
// locked until the debt is covered.
func TestWalletDebtReadOnlyRecoversAfterRecharge(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		useWalletOverdraftLimit(t, 0, nil)
		require.NoError(t, db.Create(&User{Id: 221, Username: "debt-readonly", AffCode: "debt-readonly", Quota: 1_000, Group: "default", Status: common.UserStatusEnabled}).Error)

		charged, err := SettleWalletHold(221, "debt-readonly-a", 4_000)
		require.NoError(t, err)
		assert.EqualValues(t, 1_000, charged)
		debt, readOnly, err := ResolveWalletDebtStatus(221)
		require.NoError(t, err)
		assert.True(t, readOnly)
		assert.EqualValues(t, 3_000, debt)

		// A partial recharge is collected at the next check and keeps the lock.
		_, err = ApplyWalletLedgerDeltaDB(221, WalletLedgerKindTopUp, 1_000, WalletLedgerRefTopUp, "debt-topup-partial", "")
		require.NoError(t, err)
		debt, readOnly, err = ResolveWalletDebtStatus(221)
		require.NoError(t, err)
		assert.True(t, readOnly, "a partially covered debt keeps the account read-only")
		assert.EqualValues(t, 2_000, debt)
		balance, err := GetUserQuota(221, true)
		require.NoError(t, err)
		assert.Zero(t, balance, "the recharge paid the debt instead of becoming spendable")

		// The covering recharge releases the lock and leaves the remainder.
		_, err = ApplyWalletLedgerDeltaDB(221, WalletLedgerKindTopUp, 5_000, WalletLedgerRefTopUp, "debt-topup-full", "")
		require.NoError(t, err)
		debt, readOnly, err = ResolveWalletDebtStatus(221)
		require.NoError(t, err)
		assert.False(t, readOnly)
		assert.Zero(t, debt)
		balance, err = GetUserQuota(221, true)
		require.NoError(t, err)
		assert.Equal(t, 3_000, balance)

		// Both accounts still reconcile after the collection.
		reconcile, err := ReconcileWalletLedgerForUser(221)
		require.NoError(t, err)
		assert.True(t, reconcile.Reconciled, "wallet sum %d vs balance %d, debt rows %d vs stored %d", reconcile.LedgerSum, reconcile.Quota, reconcile.Debt, reconcile.DebtBalance)
		assert.Zero(t, reconcile.Debt)
		var repayments int64
		require.NoError(t, db.Model(&WalletLedgerEntry{}).Where("user_id = ? AND kind = ?", 221, WalletLedgerKindDebtRepayment).Count(&repayments).Error)
		assert.EqualValues(t, 2, repayments, "each collection writes one wallet-side repayment row")
	})
}

// The overdraft credit line is usable for new requests: a pre-consume may debit
// the wallet down to it, and it blocks exactly at the line.
func TestWalletDebtPreConsumeUsesOverdraftLimit(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		useWalletOverdraftLimit(t, 0.02, nil) // 10_000 quota
		require.NoError(t, db.Create(&User{Id: 231, Username: "debt-preconsume", AffCode: "debt-preconsume", Quota: 0, Group: "default", Status: common.UserStatusEnabled}).Error)

		reserved, err := TryReserveUserQuota(231, 6_000, "debt-preconsume-a")
		require.NoError(t, err)
		require.True(t, reserved, "the credit line admits a postpaid reservation")
		balance, err := GetUserQuota(231, true)
		require.NoError(t, err)
		assert.Equal(t, -6_000, balance)

		reserved, err = TryReserveUserQuota(231, 5_000, "debt-preconsume-b")
		require.NoError(t, err)
		assert.False(t, reserved, "a reservation beyond the credit line is rejected")
		balance, err = GetUserQuota(231, true)
		require.NoError(t, err)
		assert.Equal(t, -6_000, balance)

		// Without a credit line the same reservation is refused.
		useWalletOverdraftLimit(t, 0, nil)
		require.NoError(t, db.Create(&User{Id: 232, Username: "debt-preconsume-b", AffCode: "debt-preconsume-b", Quota: 0, Group: "default", Status: common.UserStatusEnabled}).Error)
		reserved, err = TryReserveUserQuota(232, 1, "debt-preconsume-c")
		require.NoError(t, err)
		assert.False(t, reserved)
	})
}

// Administrators can list every account with outstanding debt together with the
// owed amount; settled accounts stay out of the list.
func TestWalletDebtorsListOutstandingAccounts(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		useWalletOverdraftLimit(t, 0, nil)
		require.NoError(t, db.Create(&User{Id: 241, Username: "debtor-a", AffCode: "debtor-a", Quota: 1_000, Group: "vip", Status: common.UserStatusEnabled}).Error)
		require.NoError(t, db.Create(&User{Id: 242, Username: "debtor-b", AffCode: "debtor-b", Quota: 0, Group: "default", Status: common.UserStatusEnabled}).Error)
		require.NoError(t, db.Create(&User{Id: 243, Username: "settled", AffCode: "settled", Quota: 9_000, Group: "default", Status: common.UserStatusEnabled}).Error)

		_, err := SettleWalletHold(241, "debtor-a-charge", 6_000)
		require.NoError(t, err)
		_, err = SettleWalletHold(242, "debtor-b-charge", 500)
		require.NoError(t, err)

		page := &common.PageInfo{Page: 1, PageSize: 10}
		debtors, total, err := ListWalletDebtors(page)
		require.NoError(t, err)
		assert.EqualValues(t, 2, total)
		require.Len(t, debtors, 2)
		byId := map[int]WalletDebtor{}
		for _, debtor := range debtors {
			byId[debtor.UserId] = debtor
		}
		assert.EqualValues(t, 5_000, byId[241].Debt)
		assert.Equal(t, "debtor-a", byId[241].Username)
		assert.Equal(t, "vip", byId[241].Group)
		assert.Equal(t, int64(0), byId[241].Quota)
		assert.EqualValues(t, 500, byId[242].Debt)
		_, settles := byId[243]
		assert.False(t, settles, "an account without debt is not listed")
	})
}

// A legacy settlement without a request id follows the same credit line: the
// uncovered part becomes debt instead of a negative balance.
func TestWalletDebtLegacySettlementClampsAtCreditLine(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		useWalletOverdraftLimit(t, 0, nil)
		require.NoError(t, db.Create(&User{Id: 251, Username: "debt-legacy", AffCode: "debt-legacy", Quota: 700, Group: "default", Status: common.UserStatusEnabled}).Error)

		applied, err := SettleWalletCharge(251, 1_200)
		require.NoError(t, err)
		assert.Equal(t, 700, applied)
		balance, err := GetUserQuota(251, true)
		require.NoError(t, err)
		assert.Zero(t, balance)
		debt, err := WalletDebtForUser(251)
		require.NoError(t, err)
		assert.EqualValues(t, 500, debt)
	})
}

// ---------------------------------------------------------------------------
// Credit grants (source and validity buckets)
// ---------------------------------------------------------------------------

// grantRemaining reads one grant's unspent remainder.
func grantRemaining(t *testing.T, grantId int) int64 {
	t.Helper()
	var grant CreditGrant
	require.NoError(t, DB.Select("id", "remaining").Where("id = ?", grantId).First(&grant).Error)
	return grant.Remaining
}

// creditGrantWalletForTest seeds one wallet with a paid top-up and grant
// credits, so every later assertion only has to describe reservations.
func creditGrantWalletForTest(t *testing.T, userId int, paid int, grants []struct {
	source    string
	amount    int
	expiresAt int64
}) []int {
	t.Helper()
	_, err := ApplyWalletLedgerDeltaDB(userId, WalletLedgerKindTopUp, int64(paid), WalletLedgerRefTopUp, fmt.Sprintf("%d-topup", userId), "")
	require.NoError(t, err)
	grantIds := make([]int, 0, len(grants))
	for index, grant := range grants {
		refId := fmt.Sprintf("%d-grant-%d", userId, index)
		_, err := IssueCreditGrant(userId, grant.source, grant.amount, grant.expiresAt, WalletLedgerKindSystemGrant, WalletLedgerRefAdminGrant, refId, "")
		require.NoError(t, err)
		var stored CreditGrant
		require.NoError(t, DB.Where("user_id = ? AND source = ? AND amount = ?", userId, grant.source, grant.amount).First(&stored).Error)
		grantIds = append(grantIds, stored.Id)
	}
	return grantIds
}

// Credit is spent subscription -> grants (earliest expiry first) -> paid
// balance, and a refund returns the money to exactly the buckets it came from:
// a full refund restores every claim, a settlement refund gives up the
// unattributed part first and then the claims in reverse spending order.
func TestCreditGrantSpendOrderAndRefundReturnsToTheBucket(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		useWalletOverdraftLimit(t, 0, nil)
		require.NoError(t, db.Create(&User{Id: 301, Username: "grant-order", AffCode: "grant-order", Quota: 0, Group: "default", Status: common.UserStatusEnabled}).Error)
		now := common.GetTimestamp()
		grantIds := creditGrantWalletForTest(t, 301, 500, []struct {
			source    string
			amount    int
			expiresAt int64
		}{
			{operation_setting.CreditGrantSourceCheckin, 100, now + 3_600},
			{operation_setting.CreditGrantSourceInvite, 100, now + 7_200},
			{operation_setting.CreditGrantSourceGift, 100, 0},
		})
		checkin, invite, gift := grantIds[0], grantIds[1], grantIds[2]

		var user User
		require.NoError(t, db.Select("quota").First(&user, 301).Error)
		assert.Equal(t, 800, user.Quota, "grant credits and the paid balance share the wallet balance")

		// A reservation of 400 spends every grant, earliest expiry first, and
		// only the remaining 100 from the paid balance.
		reserved, err := TryReserveUserQuota(301, 400, "grant-order-a")
		require.NoError(t, err)
		require.True(t, reserved)
		RecordWalletConsumeDelta(301, -400)
		require.NoError(t, db.Select("quota").First(&user, 301).Error)
		assert.Equal(t, 400, user.Quota)
		assert.Zero(t, grantRemaining(t, checkin))
		assert.Zero(t, grantRemaining(t, invite))
		assert.Zero(t, grantRemaining(t, gift))
		hold, err := GetWalletHoldByRequestId("grant-order-a")
		require.NoError(t, err)
		claims, err := lockWalletHoldGrantClaimsTx(db, hold.Id)
		require.NoError(t, err)
		assert.EqualValues(t, 300, holdGrantClaimTotal(claims), "the hold records the grant composition of the reservation")

		// The refund restores each claim to its own bucket.
		applied, err := RefundWalletHold(301, "grant-order-a", 400)
		require.NoError(t, err)
		require.True(t, applied)
		require.NoError(t, db.Select("quota").First(&user, 301).Error)
		assert.Equal(t, 800, user.Quota)
		assert.EqualValues(t, 100, grantRemaining(t, checkin))
		assert.EqualValues(t, 100, grantRemaining(t, invite))
		assert.EqualValues(t, 100, grantRemaining(t, gift))

		// A settlement below the reservation returns the unattributed part
		// first: the 100 paid quota comes back while the grants stay spent.
		reserved, err = TryReserveUserQuota(301, 400, "grant-order-b")
		require.NoError(t, err)
		require.True(t, reserved)
		RecordWalletConsumeDelta(301, -400)
		charged, err := SettleWalletHold(301, "grant-order-b", -100)
		require.NoError(t, err)
		assert.EqualValues(t, -100, charged)
		RecordWalletConsumeDelta(301, 100)
		require.NoError(t, db.Select("quota").First(&user, 301).Error)
		assert.Equal(t, 500, user.Quota)
		assert.Zero(t, grantRemaining(t, checkin))
		assert.Zero(t, grantRemaining(t, invite))
		assert.Zero(t, grantRemaining(t, gift))

		// A settlement above the reservation spends the newly available grant
		// first, and the refusal of an unaffordable reservation leaves the
		// buckets untouched.
		promoIds := creditGrantWalletForTest(t, 301, 0, []struct {
			source    string
			amount    int
			expiresAt int64
		}{
			{operation_setting.CreditGrantSourcePromo, 150, 0},
		})
		promo := promoIds[0]
		reserved, err = TryReserveUserQuota(301, 100, "grant-order-c")
		require.NoError(t, err)
		require.True(t, reserved)
		RecordWalletConsumeDelta(301, -100)
		assert.Zero(t, grantRemaining(t, promo))
		reserved, err = TryReserveUserQuota(301, 900, "grant-order-d")
		require.NoError(t, err)
		assert.False(t, reserved, "the paid balance cannot cover a reservation the grants no longer cover")
		assert.Zero(t, grantRemaining(t, promo))
		charged, err = SettleWalletHold(301, "grant-order-c", 50)
		require.NoError(t, err)
		assert.EqualValues(t, 50, charged)
		RecordWalletConsumeDelta(301, -50)
		require.NoError(t, db.Select("quota").First(&user, 301).Error)
		assert.Equal(t, 500, user.Quota)
		assert.Zero(t, grantRemaining(t, promo))

		view, err := CreditGrantWalletForUser(301, common.GetTimestamp())
		require.NoError(t, err)
		assert.EqualValues(t, 500, view.TotalQuota)
		assert.EqualValues(t, 500, view.PaidQuota)
		assert.Zero(t, view.GrantQuota)
		assert.Zero(t, view.ExpiredQuota)
		assert.Empty(t, view.Grants)

		reconciliation, err := ReconcileWalletLedgerForUser(301)
		require.NoError(t, err)
		assert.True(t, reconciliation.Reconciled, "deviation=%d", reconciliation.Deviation)
	})
}

// holdGrantClaimTotal sums the grant-attributed part of one hold's claims.
func holdGrantClaimTotal(claims []WalletHoldGrant) int64 {
	total := int64(0)
	for i := range claims {
		total += claims[i].Amount
	}
	return total
}

// The expiry sweep voids the unspent remainder of a grant, reduces the balance
// with a wallet ledger row, never takes the balance below zero, never voids the
// same remainder twice, and leaves the expired credit unspendable until it runs.
func TestCreditGrantExpiryVoidsAndStaysOutOfDebt(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		useWalletOverdraftLimit(t, 0, nil)
		require.NoError(t, db.Create(&User{Id: 311, Username: "grant-expiry", AffCode: "grant-expiry", Quota: 0, Group: "default", Status: common.UserStatusEnabled}).Error)
		now := common.GetTimestamp()
		grantIds := creditGrantWalletForTest(t, 311, 200, []struct {
			source    string
			amount    int
			expiresAt int64
		}{
			{operation_setting.CreditGrantSourceCheckin, 300, now - 60},
		})
		expiredGrant := grantIds[0]

		var user User
		require.NoError(t, db.Select("quota").First(&user, 311).Error)
		assert.Equal(t, 500, user.Quota)

		// The expired remainder is not spendable even before the sweep writes
		// it off.
		reserved, err := TryReserveUserQuota(311, 300, "grant-expiry-a")
		require.NoError(t, err)
		assert.False(t, reserved)
		reserved, err = TryReserveUserQuota(311, 200, "grant-expiry-b")
		require.NoError(t, err)
		require.True(t, reserved)
		RecordWalletConsumeDelta(311, -200)
		require.NoError(t, db.Select("quota").First(&user, 311).Error)
		assert.Equal(t, 300, user.Quota)

		result, err := VoidExpiredCreditGrants(now, 200)
		require.NoError(t, err)
		assert.Equal(t, 1, result.ScannedCount)
		assert.Equal(t, 1, result.VoidedCount)
		assert.EqualValues(t, 300, result.VoidedQuota)
		assert.EqualValues(t, 300, result.DeductedQuota)
		assert.Zero(t, result.ClampedCount)
		assert.Zero(t, result.FailedCount)
		require.NoError(t, db.Select("quota").First(&user, 311).Error)
		assert.Zero(t, user.Quota)
		assert.Zero(t, grantRemaining(t, expiredGrant))

		var expiryEntry WalletLedgerEntry
		require.NoError(t, db.Where("user_id = ? AND kind = ?", 311, WalletLedgerKindGrantExpire).First(&expiryEntry).Error)
		assert.EqualValues(t, -300, expiryEntry.Amount)
		assert.Equal(t, WalletLedgerRefGrantExpire, expiryEntry.RefType)

		// A second sweep finds nothing: the claim is gone and the balance moved
		// exactly once.
		result, err = VoidExpiredCreditGrants(now+3_600, 200)
		require.NoError(t, err)
		assert.Zero(t, result.ScannedCount)
		require.NoError(t, db.Select("quota").First(&user, 311).Error)
		assert.Zero(t, user.Quota)
		reconciliation, err := ReconcileWalletLedgerForUser(311)
		require.NoError(t, err)
		assert.True(t, reconciliation.Reconciled, "deviation=%d", reconciliation.Deviation)

		// A claim that outlived the money it refers to is given up without
		// taking the balance below zero.
		require.NoError(t, db.Create(&User{Id: 312, Username: "grant-expiry-clamp", AffCode: "grant-expiry-clamp", Quota: 100, Group: "default", Status: common.UserStatusEnabled}).Error)
		clampedIds := creditGrantWalletForTest(t, 312, 0, []struct {
			source    string
			amount    int
			expiresAt int64
		}{
			{operation_setting.CreditGrantSourcePromo, 300, now - 60},
		})
		// A legacy charge spent 300 of the balance without attributing it to
		// the claim, so the grant claims more than the wallet still holds.
		require.NoError(t, db.Model(&User{}).Where("id = ?", 312).Update("quota", 100).Error)
		RecordWalletConsumeDelta(312, -300)
		result, err = VoidExpiredCreditGrants(now, 200)
		require.NoError(t, err)
		assert.Equal(t, 1, result.VoidedCount)
		assert.EqualValues(t, 300, result.VoidedQuota)
		assert.EqualValues(t, 100, result.DeductedQuota)
		assert.Equal(t, 1, result.ClampedCount)
		require.NoError(t, db.Select("quota").First(&user, 312).Error)
		assert.Zero(t, user.Quota)
		assert.Zero(t, grantRemaining(t, clampedIds[0]))
	})
}

// An issuance replays as a no-op, and the wallet view reports the paid balance,
// the spendable buckets with their validity and the expired remainder that the
// sweep has still to void.
func TestCreditGrantIssuanceIsIdempotentAndVisible(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		useWalletOverdraftLimit(t, 0, nil)
		require.NoError(t, db.Create(&User{Id: 321, Username: "grant-issue", AffCode: "grant-issue", Quota: 0, Group: "default", Status: common.UserStatusEnabled}).Error)
		now := common.GetTimestamp()

		applied, err := IssueCreditGrant(321, operation_setting.CreditGrantSourceRedeem, 400, now+86_400, WalletLedgerKindRedeem, WalletLedgerRefRedeem, "redeem-321", "note")
		require.NoError(t, err)
		require.True(t, applied)
		applied, err = IssueCreditGrant(321, operation_setting.CreditGrantSourceRedeem, 400, now+86_400, WalletLedgerKindRedeem, WalletLedgerRefRedeem, "redeem-321", "note")
		require.NoError(t, err)
		assert.False(t, applied, "a replayed ledger reference never grants the credit twice")
		var user User
		require.NoError(t, db.Select("quota").First(&user, 321).Error)
		assert.Equal(t, 400, user.Quota)
		var grants []CreditGrant
		require.NoError(t, db.Where("user_id = ?", 321).Find(&grants).Error)
		require.Len(t, grants, 1)
		assert.EqualValues(t, 400, grants[0].Amount)
		assert.EqualValues(t, 400, grants[0].Remaining)

		_, err = IssueCreditGrant(321, operation_setting.CreditGrantSourcePromo, 100, now-60, WalletLedgerKindSystemGrant, WalletLedgerRefAdminGrant, "promo-321", "")
		require.NoError(t, err)
		view, err := CreditGrantWalletForUser(321, common.GetTimestamp())
		require.NoError(t, err)
		assert.EqualValues(t, 500, view.TotalQuota)
		assert.EqualValues(t, 400, view.GrantQuota)
		assert.EqualValues(t, 100, view.ExpiredQuota)
		assert.Zero(t, view.PaidQuota)
		require.Len(t, view.Grants, 1)
		assert.Equal(t, operation_setting.CreditGrantSourceRedeem, view.Grants[0].Source)
		assert.EqualValues(t, 400, view.Grants[0].Remaining)
		assert.EqualValues(t, now+86_400, view.Grants[0].ExpiresAt)

		applied, err = IssueCreditGrant(321, "unsupported", 10, 0, WalletLedgerKindSystemGrant, WalletLedgerRefAdminGrant, "bad-source", "")
		require.ErrorIs(t, err, ErrCreditGrantSourceInvalid)
		assert.False(t, applied)
	})
}

// The administrator overview reports money that entered through top-ups,
// granted credit broken down by source, consumption, refunds and the credit
// that expired unused.
func TestCreditGrantStatisticsBySource(t *testing.T) {
	forEachAccountingDialect(t, func(t *testing.T, db *gorm.DB) {
		useWalletOverdraftLimit(t, 0, nil)
		require.NoError(t, db.Create(&User{Id: 331, Username: "grant-stats", AffCode: "grant-stats", Quota: 0, Group: "default", Status: common.UserStatusEnabled}).Error)
		require.NoError(t, db.Create(&User{Id: 332, Username: "grant-stats-b", AffCode: "grant-stats-b", Quota: 0, Group: "default", Status: common.UserStatusEnabled}).Error)
		now := common.GetTimestamp()

		_, err := ApplyWalletLedgerDeltaDB(331, WalletLedgerKindTopUp, 1_000, WalletLedgerRefTopUp, "stats-topup", "")
		require.NoError(t, err)
		_, err = IssueCreditGrant(331, operation_setting.CreditGrantSourceCheckin, 200, 0, WalletLedgerKindCheckin, WalletLedgerRefCheckin, "stats-checkin", "")
		require.NoError(t, err)
		_, err = IssueCreditGrant(332, operation_setting.CreditGrantSourceCheckin, 100, 0, WalletLedgerKindCheckin, WalletLedgerRefCheckin, "stats-checkin-b", "")
		require.NoError(t, err)
		_, err = IssueCreditGrant(331, operation_setting.CreditGrantSourceInvite, 300, now-60, WalletLedgerKindAffiliateTransfer, WalletLedgerRefAffiliate, "stats-invite", "")
		require.NoError(t, err)

		// Consume 500 from the wallet and refund 100 of it.
		reserved, err := TryReserveUserQuota(331, 500, "stats-consume")
		require.NoError(t, err)
		require.True(t, reserved)
		RecordWalletConsumeDelta(331, -500)
		require.NoError(t, RefundWalletQuota(331, 100, WalletLedgerRefRequestRefund, "stats-refund"))

		// The invitation credit expires unused.
		result, err := VoidExpiredCreditGrants(now, 200)
		require.NoError(t, err)
		assert.Equal(t, 1, result.VoidedCount)
		assert.EqualValues(t, 300, result.VoidedQuota)

		stats, err := CreditGrantStatistics()
		require.NoError(t, err)
		assert.EqualValues(t, 1_000, stats.TotalTopUp)
		assert.EqualValues(t, 600, stats.TotalGranted)
		assert.EqualValues(t, 100, stats.TotalRemaining)
		assert.EqualValues(t, 500, stats.TotalSpent)
		assert.EqualValues(t, 300, stats.TotalExpired)
		assert.EqualValues(t, 500, stats.TotalConsumed)
		assert.EqualValues(t, 100, stats.TotalRefunded)

		bySource := map[string]CreditGrantSourceStats{}
		for _, entry := range stats.Sources {
			bySource[entry.Source] = entry
		}
		assert.EqualValues(t, 300, bySource[operation_setting.CreditGrantSourceCheckin].Granted)
		assert.EqualValues(t, 100, bySource[operation_setting.CreditGrantSourceCheckin].Remaining)
		assert.EqualValues(t, 200, bySource[operation_setting.CreditGrantSourceCheckin].Spent)
		assert.EqualValues(t, 2, bySource[operation_setting.CreditGrantSourceCheckin].Accounts)
		assert.EqualValues(t, 300, bySource[operation_setting.CreditGrantSourceInvite].Granted)
		assert.Zero(t, bySource[operation_setting.CreditGrantSourceInvite].Remaining)
		assert.EqualValues(t, 300, bySource[operation_setting.CreditGrantSourceInvite].Spent)
		assert.Len(t, stats.Sources, 2)

		reconciliation, err := ReconcileWalletLedgerForUser(331)
		require.NoError(t, err)
		assert.True(t, reconciliation.Reconciled, "deviation=%d", reconciliation.Deviation)
	})
}
