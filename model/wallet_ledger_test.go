package model

import (
	"errors"
	"fmt"
	"os"
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
		require.NoError(t, db.Migrator().DropTable(&WalletLedgerEntry{}, &User{}))
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
	// table is created idempotently on every engine.
	require.NoError(t, db.AutoMigrate(&User{}, &WalletLedgerEntry{}))
	require.NoError(t, db.AutoMigrate(&User{}, &WalletLedgerEntry{}))
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
