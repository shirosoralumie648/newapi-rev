package model

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

// legacyQuotaUser and legacyQuotaToken describe the 32-bit quota columns of a
// database created by an older release. Keying those columns on int32 is what
// makes GORM ask the database for a real 32-bit column.
type legacyQuotaUser struct {
	Quota           int32 `gorm:"column:quota;type:int;default:0"`
	UsedQuota       int32 `gorm:"column:used_quota;type:int;default:0"`
	RequestCount    int32 `gorm:"column:request_count;type:int;default:0"`
	AffQuota        int32 `gorm:"column:aff_quota;type:int;default:0"`
	AffHistoryQuota int32 `gorm:"column:aff_history;type:int;default:0"`
}

type legacyQuotaToken struct {
	RemainQuota int32 `gorm:"column:remain_quota;type:int;default:0"`
	UsedQuota   int32 `gorm:"column:used_quota;type:int;default:0"`
}

// legacyQuotaSingle downgrades the single quota column of the remaining models.
// Each legacy definition lists only columns that already exist, because
// AutoMigrate would add a missing column instead of ignoring it.
type legacyQuotaSingle struct {
	Quota int32 `gorm:"column:quota;type:int"`
}

func quotaBigintModels() []any {
	models := make([]any, 0, len(quotaColumnGroups))
	for _, group := range quotaColumnGroups {
		models = append(models, group.model)
	}
	return models
}

// openQuotaMigrationTestDB opens a connection whose tables and indexes are
// isolated behind a unique prefix, so the migration test can share a real test
// database with the rest of the suite. The dialectors are the ones production
// uses, so schema reconciliation behaves the way it does at startup.
func openQuotaMigrationTestDB(t *testing.T, recorder *migrationSQLRecorder, dialector gorm.Dialector, dbType common.DatabaseType) *gorm.DB {
	t.Helper()
	prefix := fmt.Sprintf("wl01q_%d_", time.Now().UnixNano())
	db, err := gorm.Open(dialector, &gorm.Config{
		Logger:         recorder,
		NamingStrategy: schema.NamingStrategy{TablePrefix: prefix, IdentifierMaxLength: 64},
	})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() {
		_ = db.Migrator().DropTable(quotaBigintModels()...)
		_ = sqlDB.Close()
	})
	// The engine version is part of the database verification record.
	versionQuery := "SELECT version()"
	if dbType == common.DatabaseTypeSQLite {
		versionQuery = "SELECT sqlite_version()"
	}
	var version string
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("quota schema migration on %s: %s", dbType, version)
	return db
}

func quotaMigrationTableName(t *testing.T, db *gorm.DB, model any) string {
	t.Helper()
	statement := &gorm.Statement{DB: db}
	require.NoError(t, statement.Parse(model))
	return statement.Table
}

// quotaColumnType returns the type the driver reports for one of a model's
// quota columns, and fails the test when the column does not exist.
func quotaColumnType(t *testing.T, db *gorm.DB, model any, column string) string {
	t.Helper()
	columnTypes, err := db.Migrator().ColumnTypes(model)
	require.NoError(t, err)
	for _, actual := range columnTypes {
		if strings.EqualFold(actual.Name(), column) {
			return actual.DatabaseTypeName()
		}
	}
	require.Failf(t, "column not found", "%T.%s does not exist", model, column)
	return ""
}

// assertQuotaColumnsAre64Bit verifies that every quota column exists and that
// the dialects the widening migration targets report a 64-bit integer for it.
// SQLite stores integers in up to 64 bits regardless of the declared type.
func assertQuotaColumnsAre64Bit(t *testing.T, db *gorm.DB, dbType common.DatabaseType) {
	t.Helper()
	for _, group := range quotaColumnGroups {
		for _, column := range group.columns {
			dataType := quotaColumnType(t, db, group.model, column)
			if dbType == common.DatabaseTypeSQLite {
				continue
			}
			assert.Truef(t, is64BitIntegerType(dbType, dataType), "%T.%s uses %s, want a 64-bit integer", group.model, column, dataType)
		}
	}
}

// runQuotaSchemaStartup mirrors the order migrateDB applies to the quota
// schema: widen legacy columns, AutoMigrate, then validate what the models
// declare.
func runQuotaSchemaStartup(t *testing.T, db *gorm.DB, dbType common.DatabaseType) {
	t.Helper()
	require.NoError(t, migrateQuotaColumns(db, dbType))
	require.NoError(t, db.AutoMigrate(quotaBigintModels()...))
	require.NoError(t, ensureQuotaColumns(db, dbType))
}

// writeQuotaValuesBeyondInt32 stores quota values that a 32-bit column cannot
// hold, including the largest wallet the billing rules allow.
func writeQuotaValuesBeyondInt32(t *testing.T, db *gorm.DB) {
	t.Helper()
	require.NoError(t, db.Create(&User{
		Id:              7,
		Username:        "quota-bigint",
		Password:        "placeholder",
		AffCode:         "quota-bigint",
		Quota:           common.MaxWalletQuota,
		UsedQuota:       3_000_000_000,
		RequestCount:    3_000_000_001,
		AffQuota:        4_000_000_000,
		AffHistoryQuota: 5_000_000_000,
	}).Error)
	require.NoError(t, db.Create(&Token{
		Id:          7,
		UserId:      7,
		Key:         "quota-bigint-key",
		Name:        "quota-bigint",
		RemainQuota: 3_000_000_000,
		UsedQuota:   5_000_000_001,
	}).Error)
}

func assertQuotaValuesBeyondInt32(t *testing.T, db *gorm.DB) {
	t.Helper()
	var user User
	require.NoError(t, db.Select("quota", "used_quota", "request_count", "aff_quota", "aff_history").First(&user, 7).Error)
	assert.Equal(t, common.MaxWalletQuota, user.Quota)
	assert.Equal(t, 3_000_000_000, user.UsedQuota)
	assert.Equal(t, 3_000_000_001, user.RequestCount)
	assert.Equal(t, 4_000_000_000, user.AffQuota)
	assert.Equal(t, 5_000_000_000, user.AffHistoryQuota)

	var token Token
	require.NoError(t, db.Select("remain_quota", "used_quota").First(&token, 7).Error)
	assert.Equal(t, 3_000_000_000, token.RemainQuota)
	assert.Equal(t, 5_000_000_001, token.UsedQuota)
}

// testQuotaBigintMigration follows one set of tables through both startup
// paths: a fresh install and a database created by an older release whose
// 32-bit quota columns must be widened without losing data.
func testQuotaBigintMigration(t *testing.T, db *gorm.DB, recorder *migrationSQLRecorder, dbType common.DatabaseType) {
	t.Helper()

	// Fresh install: no table exists yet, widening has nothing to do, and
	// AutoMigrate creates 64-bit quota columns that the check accepts.
	runQuotaSchemaStartup(t, db, dbType)
	assertQuotaColumnsAre64Bit(t, db, dbType)

	recorder.reset()
	runQuotaSchemaStartup(t, db, dbType)
	assert.Empty(t, recorder.schemaMutations(), "a second startup on a fresh install must not change the schema")

	if dbType != common.DatabaseTypeSQLite {
		// Legacy database: the quota columns are 32-bit, validation rejects
		// that schema, and startup widens the columns in place.
		require.NoError(t, db.Create(&User{
			Id:              1,
			Username:        "legacy-quota",
			Password:        "placeholder",
			AffCode:         "legacy-quota",
			Quota:           1_500_000_000,
			UsedQuota:       7,
			RequestCount:    8,
			AffQuota:        9,
			AffHistoryQuota: 10,
		}).Error)
		require.NoError(t, db.Create(&Token{
			Id:          1,
			UserId:      1,
			Key:         "legacy-quota-key",
			Name:        "legacy-quota",
			RemainQuota: 1_500_000_000,
			UsedQuota:   11,
		}).Error)
		legacyFixtures := []struct {
			model  any
			legacy any
		}{
			{model: &User{}, legacy: &legacyQuotaUser{}},
			{model: &Token{}, legacy: &legacyQuotaToken{}},
			{model: &Redemption{}, legacy: &legacyQuotaSingle{}},
			{model: &QuotaData{}, legacy: &legacyQuotaSingle{}},
			{model: &Task{}, legacy: &legacyQuotaSingle{}},
			{model: &Midjourney{}, legacy: &legacyQuotaSingle{}},
			{model: &Log{}, legacy: &legacyQuotaSingle{}},
		}
		for _, fixture := range legacyFixtures {
			table := quotaMigrationTableName(t, db, fixture.model)
			require.NoError(t, db.Table(table).AutoMigrate(fixture.legacy))
		}
		for _, group := range quotaColumnGroups {
			for _, column := range group.columns {
				dataType := quotaColumnType(t, db, group.model, column)
				require.Falsef(t, is64BitIntegerType(dbType, dataType), "legacy fixture left %T.%s at %s", group.model, column, dataType)
			}
		}
		assert.Error(t, ensureQuotaColumns(db, dbType))

		runQuotaSchemaStartup(t, db, dbType)
		assertQuotaColumnsAre64Bit(t, db, dbType)

		// Rows written before the upgrade keep their values.
		var legacyUser User
		require.NoError(t, db.Select("quota", "used_quota").First(&legacyUser, 1).Error)
		assert.Equal(t, 1_500_000_000, legacyUser.Quota)
		assert.Equal(t, 7, legacyUser.UsedQuota)
		var legacyToken Token
		require.NoError(t, db.Select("remain_quota", "used_quota").First(&legacyToken, 1).Error)
		assert.Equal(t, 1_500_000_000, legacyToken.RemainQuota)
		assert.Equal(t, 11, legacyToken.UsedQuota)
	}

	// Quota values beyond a 32-bit integer fit and are read back unchanged.
	writeQuotaValuesBeyondInt32(t, db)
	assertQuotaValuesBeyondInt32(t, db)

	// No later startup may alter the schema again.
	recorder.reset()
	runQuotaSchemaStartup(t, db, dbType)
	assert.Empty(t, recorder.schemaMutations(), "an upgraded database must not be altered again")
	assertQuotaColumnsAre64Bit(t, db, dbType)
	assertQuotaValuesBeyondInt32(t, db)
}

// TestQuotaBigintColumnTags guards the declared schema: on SQLite no widening
// runs, so the model tags are what keep the columns 64-bit there.
func TestQuotaBigintColumnTags(t *testing.T) {
	t.Setenv("SKIP_64BIT_QUOTA_SCHEMA_CHECK", "false")
	for _, group := range quotaColumnGroups {
		statement := &gorm.Statement{DB: DB}
		require.NoError(t, statement.Parse(group.model))
		for _, column := range group.columns {
			field := statement.Schema.LookUpField(column)
			require.NotNilf(t, field, "%T has no field for column %s", group.model, column)
			assert.Equalf(t, "bigint", strings.ToLower(field.TagSettings["TYPE"]), "%T.%s must declare type:bigint", group.model, column)
		}
	}
}

func TestQuotaBigintMigrationSQLite(t *testing.T) {
	t.Setenv("SKIP_64BIT_QUOTA_SCHEMA_CHECK", "false")
	// SQLite stores integers in up to 64 bits, so there is no 32-bit schema to
	// upgrade; the fresh install path still has to accept the largest wallet.
	recorder := &migrationSQLRecorder{}
	testQuotaBigintMigration(t, openQuotaMigrationTestDB(t, recorder, sqlite.Open(":memory:"), common.DatabaseTypeSQLite), recorder, common.DatabaseTypeSQLite)
}

func TestQuotaBigintMigrationConfiguredDatabases(t *testing.T) {
	t.Setenv("SKIP_64BIT_QUOTA_SCHEMA_CHECK", "false")
	// The test database must be dedicated to the test suite: PostgreSQL index
	// names are unique per schema, and the models carry fixed index names.
	tests := []struct {
		name      string
		env       string
		dbType    common.DatabaseType
		dialector func(string) gorm.Dialector
	}{
		{name: "mysql", env: "TEST_MYSQL_DSN", dbType: common.DatabaseTypeMySQL, dialector: func(dsn string) gorm.Dialector {
			return mysqlMigrationDialector{mysql.Dialector{Config: &mysql.Config{DSN: dsn}}}
		}},
		{name: "postgres", env: "TEST_POSTGRES_DSN", dbType: common.DatabaseTypePostgreSQL, dialector: func(dsn string) gorm.Dialector {
			return postgresMigrationDialector{postgres.Dialector{Config: &postgres.Config{DSN: dsn, PreferSimpleProtocol: true}}}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dsn := strings.TrimSpace(os.Getenv(test.env))
			if dsn == "" {
				t.Skip(test.env + " is not configured")
			}
			recorder := &migrationSQLRecorder{}
			testQuotaBigintMigration(t, openQuotaMigrationTestDB(t, recorder, test.dialector(dsn), test.dbType), recorder, test.dbType)
		})
	}
}
