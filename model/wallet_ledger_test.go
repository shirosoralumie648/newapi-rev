package model

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
)

// walletLedgerTestDB opens a dedicated database for one dialect: in-memory
// SQLite by default, or the external test database from TEST_MYSQL_DSN /
// TEST_POSTGRES_DSN so the wallet ledger contract is verified on every
// supported engine. Table names are prefixed so concurrent runs cannot clash.
func walletLedgerTestDB(t *testing.T, dialect string) *gorm.DB {
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
		require.NoError(t, db.Migrator().DropTable(&WalletLedgerEntry{}, &WalletHold{}, &User{}))
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
	require.NoError(t, db.AutoMigrate(&User{}, &WalletLedgerEntry{}, &WalletHold{}))
	require.NoError(t, db.AutoMigrate(&User{}, &WalletLedgerEntry{}, &WalletHold{}))
	var version string
	versionQuery := "SELECT version()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("wallet ledger database: %s %s", dialect, version)
	return db
}

func forEachWalletLedgerDialect(t *testing.T, run func(t *testing.T, db *gorm.DB)) {
	t.Helper()
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			run(t, walletLedgerTestDB(t, dialect))
		})
	}
}

// The ledger row and the balance update must commit or roll back together, and
// replaying the same reference must never move the balance twice.
func TestWalletLedgerApplyDeltaIsAtomicAndReplaySafe(t *testing.T) {
	forEachWalletLedgerDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 41, Username: "ledger-atomic", Quota: 1000, Status: common.UserStatusEnabled}).Error)

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
	forEachWalletLedgerDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 42, Username: "ledger-consume", Quota: 1000, Status: common.UserStatusEnabled}).Error)

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
	forEachWalletLedgerDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 51, Username: "ledger-opening-a", Quota: 700, Status: common.UserStatusEnabled}).Error)
		require.NoError(t, db.Create(&User{Id: 52, Username: "ledger-opening-b", Quota: 0, Status: common.UserStatusEnabled}).Error)

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

		require.NoError(t, db.Create(&User{Id: 53, Username: "ledger-opening-c", Quota: 25, Status: common.UserStatusEnabled}).Error)
		seeded, err = EnsureWalletLedgerOpeningBalances()
		require.NoError(t, err)
		assert.Equal(t, 1, seeded)
	})
}

// A wallet that no longer matches its ledger sum is reported as a deviation,
// and reconciliation never repairs the balance by itself.
func TestWalletReconcileReportsDeviationWithoutChangingBalance(t *testing.T) {
	forEachWalletLedgerDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 61, Username: "ledger-ok", Quota: 0, Status: common.UserStatusEnabled}).Error)
		applied, err := ApplyWalletLedgerDeltaDB(61, WalletLedgerKindTopUp, 1000, WalletLedgerRefTopUp, "reconcile-ok", "")
		require.NoError(t, err)
		require.True(t, applied)

		require.NoError(t, db.Create(&User{Id: 62, Username: "ledger-bad", Quota: 400, Status: common.UserStatusEnabled}).Error)
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
	forEachWalletLedgerDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 71, Username: "hold-settle", Quota: 1000, Status: common.UserStatusEnabled}).Error)
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
		require.NoError(t, ReserveUserQuotaWithDebt(71, 150, "hold-settle-a"))
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
	forEachWalletLedgerDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 81, Username: "hold-refund", Quota: 1000, Status: common.UserStatusEnabled}).Error)
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
	forEachWalletLedgerDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 91, Username: "hold-expiry", Quota: 1000, Status: common.UserStatusEnabled}).Error)
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
		require.NoError(t, db.Create(&User{Id: 92, Username: "hold-race", Quota: 1000, Status: common.UserStatusEnabled}).Error)
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
	})
}

// A workflow run budget (BL-03) is one root hold per run; per-step child holds
// mount on it without deducting quota again and are closed with their parent.
func TestWalletHoldBudgetParentMountsChildren(t *testing.T) {
	forEachWalletLedgerDialect(t, func(t *testing.T, db *gorm.DB) {
		require.NoError(t, db.Create(&User{Id: 101, Username: "hold-budget", Quota: 1000, Status: common.UserStatusEnabled}).Error)
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
	require.NoError(t, ReserveUserQuotaWithDebt(user.Id, 1, "hold-redis-a"))
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
