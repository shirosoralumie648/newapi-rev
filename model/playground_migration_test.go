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
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/group_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
)

// playgroundMigrationDB opens the same prefixed schema the external Playground
// tests use, without swapping the package-level DB: the uniqueness migration is
// exercised directly on it.
func playgroundMigrationDB(t *testing.T, dialect string) *gorm.DB {
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
	prefix := fmt.Sprintf("pgmig_%d_", os.Getpid())
	db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: prefix}, Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	if dialect == "sqlite" {
		// A pooled second connection would open its own in-memory database.
		sqlDB, err := db.DB()
		require.NoError(t, err)
		sqlDB.SetMaxOpenConns(1)
	}
	t.Cleanup(func() {
		require.NoError(t, db.Migrator().DropTable(&PlaygroundMessage{}, &PlaygroundAttachment{}, &PlaygroundUserUsage{}, &PlaygroundPreset{}, &PlaygroundSession{}, &PlaygroundSessionShare{}, &PlaygroundCanvasProject{}))
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
	})
	return db
}

// A database written before the unique index existed can hold duplicate
// (session_id, client_key) rows. The migration keeps the newest row of every
// pair so the following AutoMigrate can create the index instead of failing
// startup, and repeating the migration changes nothing.
func TestPlaygroundMessageUniquenessMigration(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundMigrationDB(t, dialect)
			require.NoError(t, db.AutoMigrate(&PlaygroundMessage{}))
			require.True(t, db.Migrator().HasIndex(&PlaygroundMessage{}, playgroundMessageClientIndex))
			// Recreate the legacy schema: no unique index, duplicate keys.
			require.NoError(t, db.Migrator().DropIndex(&PlaygroundMessage{}, playgroundMessageClientIndex))
			require.False(t, db.Migrator().HasIndex(&PlaygroundMessage{}, playgroundMessageClientIndex))
			rows := []PlaygroundMessage{
				{SessionID: "pgs_legacy", UserID: 7, ClientKey: "m1", Position: 1, Payload: `{"key":"m1","from":"user","versions":[{"id":"v","content":"old"}]}`, CreatedAt: 1, UpdatedAt: 1},
				{SessionID: "pgs_legacy", UserID: 7, ClientKey: "m1", Position: 2, Payload: `{"key":"m1","from":"user","versions":[{"id":"v","content":"new"}]}`, CreatedAt: 2, UpdatedAt: 2},
				{SessionID: "pgs_legacy", UserID: 7, ClientKey: "m2", Position: 3, Payload: `{"key":"m2","from":"user","versions":[{"id":"v","content":"kept"}]}`, CreatedAt: 3, UpdatedAt: 3},
			}
			for index := range rows {
				require.NoError(t, db.Create(&rows[index]).Error)
			}
			for range 2 {
				require.NoError(t, migratePlaygroundMessageUniqueness(db))
			}

			stored := make([]PlaygroundMessage, 0)
			require.NoError(t, db.Where("session_id = ?", "pgs_legacy").Order("position").Find(&stored).Error)
			require.Len(t, stored, 2)
			assert.Contains(t, string(stored[0].Payload), "new")
			assert.Contains(t, string(stored[1].Payload), "kept")

			// The next startup migration creates the index and rejects a
			// duplicate again.
			require.NoError(t, db.AutoMigrate(&PlaygroundMessage{}))
			require.True(t, db.Migrator().HasIndex(&PlaygroundMessage{}, playgroundMessageClientIndex))
			assert.Error(t, db.Create(&PlaygroundMessage{
				SessionID: "pgs_legacy", UserID: 7, ClientKey: "m2", Position: 4,
				Payload: `{"key":"m2","from":"user","versions":[{"id":"v","content":"duplicate"}]}`, CreatedAt: 4, UpdatedAt: 4,
			}).Error)
		})
	}
}

// A database written before attachments moved to the object store has a NOT
// NULL data column. The pre-AutoMigrate migration must relax it so object
// backed rows can store NULL, AutoMigrate must add the storage columns without
// touching the stored payload, and repeating the migration must change
// nothing.
func TestPlaygroundAttachmentStorageSchemaMigration(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundMigrationDB(t, dialect)
			// A fresh database has no attachment table; the migration is a
			// no-op and AutoMigrate creates the schema.
			require.NoError(t, migratePlaygroundAttachmentStorage(db))

			quote := "`"
			if dialect == "postgres" {
				quote = `"`
			}
			table := db.NamingStrategy.TableName("PlaygroundAttachment")
			q := func(name string) string { return quote + name + quote }
			legacyColumns := []string{"id", "user_id", "session_id", "media_type", "filename", "byte_size", "content_hash", "client_key_hash", "data", "referenced_at", "created_at", "updated_at"}
			legacyTypes := []string{"varchar(32) PRIMARY KEY", "integer NOT NULL", "varchar(128) NOT NULL", "varchar(100) NOT NULL", "varchar(255) NOT NULL", "bigint NOT NULL", "varchar(64) NOT NULL", "varchar(64) NOT NULL", "text NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL"}
			definitions := make([]string, len(legacyColumns))
			quoted := make([]string, len(legacyColumns))
			for index, name := range legacyColumns {
				definitions[index] = q(name) + " " + legacyTypes[index]
				quoted[index] = q(name)
			}
			require.NoError(t, db.Exec("CREATE TABLE "+q(table)+" ("+strings.Join(definitions, ", ")+")").Error)

			payload := base64.StdEncoding.EncodeToString([]byte("legacy payload"))
			require.NoError(t, db.Exec("INSERT INTO "+q(table)+" ("+strings.Join(quoted, ", ")+") VALUES ("+strings.Repeat("?,", len(legacyColumns)-1)+"?)",
				"pgf_legacy-schema", 7, "pgs_legacy", "image/png", "legacy.png", 14,
				strings.Repeat("a", 64), strings.Repeat("b", 64), payload, 0, 111, 111).Error)

			require.NoError(t, migratePlaygroundAttachmentStorage(db))
			require.NoError(t, db.AutoMigrate(&PlaygroundAttachment{}))
			require.NoError(t, ensurePlaygroundAttachmentStorageBackend(db))

			columnTypes, err := db.Migrator().ColumnTypes(&PlaygroundAttachment{})
			require.NoError(t, err)
			dataNullable := false
			for _, columnType := range columnTypes {
				if columnType.Name() != "data" {
					continue
				}
				nullable, ok := columnType.Nullable()
				require.True(t, ok, "the driver must report data nullability")
				dataNullable = nullable
			}
			assert.True(t, dataNullable, "data must accept NULL after the migration")

			var stored PlaygroundAttachment
			require.NoError(t, db.Where("id = ?", "pgf_legacy-schema").First(&stored).Error)
			require.NotNil(t, stored.Data)
			assert.Equal(t, payload, string(*stored.Data))
			assert.Equal(t, system_setting.ObjectStoreBackendDB, stored.StorageBackend)
			assert.True(t, db.Migrator().HasIndex(&PlaygroundAttachment{}, "uk_playground_attachment_client"))
			// The document text cache columns arrive with the same migration on
			// a database that already holds attachment rows.
			for _, column := range []string{"text_status", "text_content", "text_bytes", "text_page_count", "text_extracted_at"} {
				assert.True(t, db.Migrator().HasColumn(&PlaygroundAttachment{}, column), column)
			}

			// Object-backed rows store NULL and no payload, and repeating the
			// migration plus AutoMigrate keeps both states intact.
			require.NoError(t, db.Create(&PlaygroundAttachment{
				ID: "pgf_new-schema", UserID: 7, SessionID: "pgs_legacy", MediaType: "image/png",
				Filename: "new.png", ByteSize: 4, ContentHash: strings.Repeat("c", 64), ClientKeyHash: strings.Repeat("d", 64),
				StorageBackend: system_setting.ObjectStoreBackendLocal, ObjectKey: "pg/7/attachment/2026/10/pgf_new-schema",
				CreatedAt: 222, UpdatedAt: 222,
			}).Error)
			require.NoError(t, migratePlaygroundAttachmentStorage(db))
			require.NoError(t, ensurePlaygroundAttachmentStorageBackend(db))
			require.NoError(t, db.AutoMigrate(&PlaygroundAttachment{}))
			require.NoError(t, db.Where("id = ?", "pgf_legacy-schema").First(&stored).Error)
			require.NotNil(t, stored.Data)
			assert.Equal(t, payload, string(*stored.Data))
			assert.Equal(t, system_setting.ObjectStoreBackendDB, stored.StorageBackend)
		})
	}
}

// A database written before the preset market existed has no visibility or
// intro columns. AutoMigrate must add them without touching the stored preset,
// NULL must read back as the pre-market defaults, and the same holds for the
// nullable intro columns added to an existing conversation. Repeating the
// migration changes nothing on any supported dialect.
func TestPlaygroundPresetSchemaMigration(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundMigrationDB(t, dialect)
			quote := "`"
			if dialect == "postgres" {
				quote = `"`
			}
			q := func(name string) string { return quote + name + quote }

			presetTable := db.NamingStrategy.TableName("PlaygroundPreset")
			presetColumns := []string{"id", "user_id", "name", "avatar", "config", "parameter_enabled", "system_prompt", "created_at", "updated_at"}
			presetTypes := []string{"varchar(32) PRIMARY KEY", "bigint NOT NULL", "varchar(100) NOT NULL", "varchar(2048) NOT NULL", "text NOT NULL", "text NOT NULL", "text NOT NULL", "bigint NOT NULL", "bigint NOT NULL"}
			definitions := make([]string, len(presetColumns))
			quoted := make([]string, len(presetColumns))
			for index, name := range presetColumns {
				definitions[index] = q(name) + " " + presetTypes[index]
				quoted[index] = q(name)
			}
			// MySQL 5.7 creates databases with the latin1 default charset, which
			// cannot store the emoji avatar written below. Declare the fixture
			// table as utf8mb4 so the migration behavior is what is tested.
			tableOptions := ""
			if dialect == "mysql" {
				tableOptions = " DEFAULT CHARSET=utf8mb4"
			}
			require.NoError(t, db.Exec("CREATE TABLE "+q(presetTable)+" ("+strings.Join(definitions, ", ")+")"+tableOptions).Error)
			require.NoError(t, db.Exec("INSERT INTO "+q(presetTable)+" ("+strings.Join(quoted, ", ")+") VALUES ("+strings.Repeat("?,", len(presetColumns)-1)+"?)",
				"pgp_legacy", 7, "Legacy preset", "🧩", `{"model":"legacy"}`, `{}`, "Legacy prompt", 111, 111).Error)

			for range 2 {
				require.NoError(t, db.AutoMigrate(&PlaygroundPreset{}))
			}
			for _, column := range []string{"visibility", "opening_message", "suggested_questions"} {
				assert.True(t, db.Migrator().HasColumn(&PlaygroundPreset{}, column), column)
			}
			var preset PlaygroundPreset
			require.NoError(t, db.Where("id = ?", "pgp_legacy").First(&preset).Error)
			assert.Equal(t, "Legacy preset", preset.Name)
			assert.Equal(t, "Legacy prompt", string(preset.SystemPrompt))
			assert.Empty(t, preset.Visibility)
			assert.Empty(t, preset.OpeningMessage)
			assert.Empty(t, preset.SuggestedQuestions)
			assert.Equal(t, PlaygroundPresetVisibilityPrivate, PlaygroundPresetVisibility(preset.Visibility))

			sessionTable := db.NamingStrategy.TableName("PlaygroundSession")
			sessionColumns := []string{"id", "user_id", "client_id", "title", "config", "parameter_enabled", "system_prompt", "context_config", "context_summary", "deleted_at", "revision", "message_revision", "created_at", "updated_at"}
			sessionTypes := []string{"varchar(128) PRIMARY KEY", "bigint NOT NULL", "varchar(128) NULL", "varchar(200) NOT NULL", "text NOT NULL", "text NOT NULL", "text NULL", "text NULL", "text NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL"}
			definitions = make([]string, len(sessionColumns))
			quoted = make([]string, len(sessionColumns))
			for index, name := range sessionColumns {
				definitions[index] = q(name) + " " + sessionTypes[index]
				quoted[index] = q(name)
			}
			require.NoError(t, db.Exec("CREATE TABLE "+q(sessionTable)+" ("+strings.Join(definitions, ", ")+")").Error)
			require.NoError(t, db.Exec("INSERT INTO "+q(sessionTable)+" ("+strings.Join(quoted, ", ")+") VALUES ("+strings.Repeat("?,", len(sessionColumns)-1)+"?)",
				"pgs_legacy", 7, nil, "Legacy conversation", `{"model":"legacy"}`, `{}`, nil, nil, nil, 0, 0, 0, 111, 111).Error)

			for range 2 {
				require.NoError(t, db.AutoMigrate(&PlaygroundSession{}))
			}
			for _, column := range []string{"opening_message", "suggested_questions", "knowledge_base_ids", "pinned_at", "archived_at", "tags"} {
				assert.True(t, db.Migrator().HasColumn(&PlaygroundSession{}, column), column)
			}
			var session PlaygroundSession
			require.NoError(t, db.Where("id = ?", "pgs_legacy").First(&session).Error)
			assert.Equal(t, "Legacy conversation", session.Title)
			assert.Empty(t, session.OpeningMessage)
			assert.Empty(t, session.SuggestedQuestions)
			assert.Empty(t, session.KnowledgeBaseIDs)
			assert.Zero(t, session.PinnedAt)
			assert.Zero(t, session.ArchivedAt)
			assert.Empty(t, session.Tags)
		})
	}
}

// A share table written before canvas links existed must gain the nullable
// canvas_id column on upgrade, keep its session links working, and stay
// idempotent. Existing rows default to the empty canvas id, so they keep
// resolving as conversation links and can never be mistaken for a canvas link.
func TestPlaygroundShareCanvasColumnMigration(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundMigrationDB(t, dialect)
			quote := "`"
			if dialect == "postgres" {
				quote = `"`
			}
			q := func(name string) string { return quote + name + quote }
			table := db.NamingStrategy.TableName("PlaygroundSessionShare")
			legacyColumns := []string{"id", "session_id", "user_id", "token_hash", "expires_at", "revoked_at", "created_at"}
			// The pre-canvas model already declared an auto-incrementing int64
			// primary key, so reproduce the table AutoMigrate created then: a
			// plain PRIMARY KEY column cannot accept rows without an explicit id.
			legacyIDType := "integer PRIMARY KEY AUTOINCREMENT"
			switch dialect {
			case "mysql":
				legacyIDType = "bigint AUTO_INCREMENT PRIMARY KEY"
			case "postgres":
				legacyIDType = "bigserial PRIMARY KEY"
			}
			legacyTypes := []string{legacyIDType, "varchar(128) NOT NULL", "bigint NOT NULL", "varchar(64) NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL"}
			definitions := make([]string, len(legacyColumns))
			quoted := make([]string, len(legacyColumns))
			for index, name := range legacyColumns {
				definitions[index] = q(name) + " " + legacyTypes[index]
				quoted[index] = q(name)
			}
			require.NoError(t, db.Exec("CREATE TABLE "+q(table)+" ("+strings.Join(definitions, ", ")+")").Error)
			// The id column is left out of the insert so every dialect's own
			// generator advances: writing an explicit id into a PostgreSQL
			// bigserial leaves the sequence behind and the next generated row
			// collides with the fixture.
			insertColumns := quoted[1:]
			require.NoError(t, db.Exec("INSERT INTO "+q(table)+" ("+strings.Join(insertColumns, ", ")+") VALUES ("+strings.Repeat("?,", len(insertColumns)-1)+"?)",
				"pgs_legacy", 7, "legacy-token-hash", 0, 0, 111).Error)

			for range 2 {
				require.NoError(t, db.AutoMigrate(&PlaygroundSessionShare{}))
			}
			require.True(t, db.Migrator().HasColumn(&PlaygroundSessionShare{}, "canvas_id"))
			var stored PlaygroundSessionShare
			require.NoError(t, db.Where("token_hash = ?", "legacy-token-hash").First(&stored).Error)
			assert.Equal(t, "pgs_legacy", stored.SessionID)
			assert.Empty(t, stored.CanvasID)

			// A canvas link created after the upgrade fills the new column and
			// still coexists with the migrated session link.
			require.NoError(t, db.Create(&PlaygroundSessionShare{CanvasID: "pgc_upgraded", UserID: 7, TokenHash: "canvas-token-hash", CreatedAt: 222}).Error)
			var canvasShare PlaygroundSessionShare
			require.NoError(t, db.Where("token_hash = ?", "canvas-token-hash").First(&canvasShare).Error)
			assert.Equal(t, "pgc_upgraded", canvasShare.CanvasID)
			assert.Empty(t, canvasShare.SessionID)
		})
	}
}

// A counter row written before the snapshot columns existed must gain them
// with DEFAULT 0 on upgrade, keep its existing values, and the migration must
// be repeatable. A fresh database has no counter table, so it is a no-op.
func TestPlaygroundUserUsageCountersMigration(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundMigrationDB(t, dialect)
			require.NoError(t, migratePlaygroundUserUsageCounters(db))

			quote := "`"
			if dialect == "postgres" {
				quote = `"`
			}
			// The model pins its table name, so the naming strategy cannot
			// prefix this table; resolve it the way the migration does.
			statement := &gorm.Statement{DB: db}
			require.NoError(t, statement.Parse(&PlaygroundUserUsage{}))
			table := statement.Table
			q := func(name string) string { return quote + name + quote }
			legacyColumns := []string{"user_id", "sessions", "presets", "attachment_count", "attachment_bytes", "object_bytes", "artifact_count", "artifact_bytes", "canvas_count", "canvas_bytes", "created_at", "updated_at"}
			legacyTypes := []string{"bigint PRIMARY KEY", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL"}
			definitions := make([]string, len(legacyColumns))
			quoted := make([]string, len(legacyColumns))
			for index, name := range legacyColumns {
				definitions[index] = q(name) + " " + legacyTypes[index]
				quoted[index] = q(name)
			}
			require.NoError(t, db.Exec("CREATE TABLE "+q(table)+" ("+strings.Join(definitions, ", ")+")").Error)
			require.NoError(t, db.Exec("INSERT INTO "+q(table)+" ("+strings.Join(quoted, ", ")+") VALUES ("+strings.Repeat("?,", len(legacyColumns)-1)+"?)",
				7, 1, 1, 0, 0, 0, 0, 0, 3, 4096, 111, 111).Error)

			require.NoError(t, migratePlaygroundUserUsageCounters(db))
			require.NoError(t, db.AutoMigrate(&PlaygroundUserUsage{}))
			// Repeating the migration and AutoMigrate changes nothing.
			require.NoError(t, migratePlaygroundUserUsageCounters(db))
			require.NoError(t, db.AutoMigrate(&PlaygroundUserUsage{}))
			require.True(t, db.Migrator().HasColumn(&PlaygroundUserUsage{}, "canvas_snapshot_count"))
			require.True(t, db.Migrator().HasColumn(&PlaygroundUserUsage{}, "canvas_snapshot_bytes"))
			require.True(t, db.Migrator().HasColumn(&PlaygroundUserUsage{}, "memories"))

			var stored PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&stored).Error)
			assert.EqualValues(t, 3, stored.CanvasCount)
			assert.EqualValues(t, 4096, stored.CanvasBytes)
			assert.Zero(t, stored.CanvasSnapshotCount)
			assert.Zero(t, stored.CanvasSnapshotBytes)
			assert.Zero(t, stored.Memories)

			// Counter rows written afterwards carry snapshot usage. The read
			// uses a fresh destination: the primary key of an already loaded
			// struct becomes an extra query condition.
			require.NoError(t, db.Create(&PlaygroundUserUsage{UserID: 8, CanvasSnapshotCount: 2, CanvasSnapshotBytes: 128, CreatedAt: 1, UpdatedAt: 1}).Error)
			var created PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 8).First(&created).Error)
			assert.EqualValues(t, 2, created.CanvasSnapshotCount)
			assert.EqualValues(t, 128, created.CanvasSnapshotBytes)
		})
	}
}

// Stored group references that still used an editable display name are
// rewritten to the stable identifier, so a rename made before this release
// cannot leave a token, a user or a subscription bound to a dead name. The
// migration leaves unknown aliases untouched and repeating it changes nothing.
func TestStableGroupReferenceMigration(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundMigrationDB(t, dialect)
			previousType := common.MainDatabaseType()
			common.SetMainDatabaseType(common.DatabaseType(dialect))
			initCol()
			originalNames := group_setting.GroupDisplayNames2JSONString()
			originalRatios := ratio_setting.GroupRatio2JSONString()
			require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"vip":1}`))
			require.NoError(t, group_setting.UpdateGroupDisplayNamesByJSONString(`{"vip":"VIP 会员","unknown-group":"Ghost"}`))
			t.Cleanup(func() {
				common.SetMainDatabaseType(previousType)
				initCol()
				require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalRatios))
				require.NoError(t, group_setting.UpdateGroupDisplayNamesByJSONString(originalNames))
				require.NoError(t, db.Migrator().DropTable(&Token{}, &User{}, &SubscriptionPlan{}, &UserSubscription{}))
			})
			require.NoError(t, db.AutoMigrate(&User{}, &Token{}, &SubscriptionPlan{}, &UserSubscription{}))
			require.NoError(t, db.Create(&User{Id: 1, Username: "group-migrate", AffCode: "group-migrate", Group: "VIP 会员", Status: common.UserStatusEnabled}).Error)
			require.NoError(t, db.Create(&Token{UserId: 1, Key: "migrate-key-1", Name: "migrate", Group: "VIP 会员", AutoGroups: `["VIP 会员","default"]`, CreatedTime: 1, AccessedTime: 1}).Error)
			require.NoError(t, db.Create(&Token{UserId: 1, Key: "migrate-key-2", Name: "ghost", Group: "Ghost", CreatedTime: 1, AccessedTime: 1}).Error)
			require.NoError(t, db.Create(&SubscriptionPlan{Title: "Plan", UpgradeGroup: "VIP 会员", DowngradeGroup: "default"}).Error)
			require.NoError(t, db.Create(&UserSubscription{UserId: 1, PlanId: 1, Status: "expired", UpgradeGroup: "VIP 会员", DowngradeGroup: "VIP 会员", PrevUserGroup: "VIP 会员"}).Error)

			require.NoError(t, migrateStableGroupReferences(db))
			require.NoError(t, migrateStableGroupReferences(db))

			var user User
			require.NoError(t, db.First(&user, 1).Error)
			assert.Equal(t, "vip", user.Group)

			var tokens []Token
			require.NoError(t, db.Order("id").Find(&tokens).Error)
			require.Len(t, tokens, 2)
			assert.Equal(t, "vip", tokens[0].Group)
			assert.JSONEq(t, `["vip","default"]`, tokens[0].AutoGroups)
			// The alias points at a group that does not exist, so the reference
			// is preserved instead of being rewritten to a dead identifier.
			assert.Equal(t, "Ghost", tokens[1].Group)

			var plan SubscriptionPlan
			require.NoError(t, db.First(&plan, 1).Error)
			assert.Equal(t, "vip", plan.UpgradeGroup)
			assert.Equal(t, "default", plan.DowngradeGroup)

			var subscription UserSubscription
			require.NoError(t, db.First(&subscription, 1).Error)
			assert.Equal(t, "vip", subscription.UpgradeGroup)
			assert.Equal(t, "vip", subscription.DowngradeGroup)
			assert.Equal(t, "vip", subscription.PrevUserGroup)
		})
	}
}

// A canvas table written before the workbench modes existed has no mode column.
// AutoMigrate must add it without touching the stored document, a legacy row
// must read back as the infinite canvas default (the app-level normalization,
// independent of any dialect column default), a workbench mode must be
// storable after the upgrade, and repeating the migration changes nothing.
func TestPlaygroundCanvasModeColumnMigration(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundMigrationDB(t, dialect)
			quote := "`"
			if dialect == "postgres" {
				quote = `"`
			}
			q := func(name string) string { return quote + name + quote }

			table := db.NamingStrategy.TableName("PlaygroundCanvasProject")
			legacyColumns := []string{"id", "user_id", "client_id", "title", "document", "document_bytes", "node_count", "edge_count", "revision", "storage_backend", "object_key", "content_encoding", "deleted_at", "created_at", "updated_at"}
			legacyTypes := []string{"varchar(32) PRIMARY KEY", "bigint NOT NULL", "varchar(128) NULL", "varchar(200) NOT NULL", "text NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "varchar(32) NOT NULL", "varchar(512) NOT NULL", "varchar(16) NOT NULL", "bigint NOT NULL", "bigint NOT NULL", "bigint NOT NULL"}
			definitions := make([]string, len(legacyColumns))
			quoted := make([]string, len(legacyColumns))
			for index, name := range legacyColumns {
				definitions[index] = q(name) + " " + legacyTypes[index]
				quoted[index] = q(name)
			}
			require.NoError(t, db.Exec("CREATE TABLE "+q(table)+" ("+strings.Join(definitions, ", ")+")").Error)
			require.NoError(t, db.Exec("INSERT INTO "+q(table)+" ("+strings.Join(quoted, ", ")+") VALUES ("+strings.Repeat("?,", len(legacyColumns)-1)+"?)",
				"pgc_legacy", 7, nil, "Legacy board", `{"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[]}`, 51, 0, 0, 3, "", "", "", 0, 111, 111).Error)

			for range 2 {
				require.NoError(t, db.AutoMigrate(&PlaygroundCanvasProject{}))
			}
			assert.True(t, db.Migrator().HasColumn(&PlaygroundCanvasProject{}, "mode"))

			var legacy PlaygroundCanvasProject
			require.NoError(t, db.Where("id = ?", "pgc_legacy").First(&legacy).Error)
			assert.Equal(t, "Legacy board", legacy.Title)
			assert.EqualValues(t, 3, legacy.Revision)
			require.NoError(t, hydratePlaygroundCanvasProject(&legacy))
			assert.Equal(t, PlaygroundCanvasModeInfinite, legacy.Mode)
			assert.Equal(t, PlaygroundCanvasModeInfinite, NormalizePlaygroundCanvasMode("unknown"))

			require.NoError(t, db.Create(&PlaygroundCanvasProject{
				ID: "pgc_image", UserID: 7, Title: "Image workspace",
				Mode: PlaygroundCanvasModeImage, Document: `{"nodes":[],"edges":[]}`,
				DocumentBytes: 23, CreatedAt: 222, UpdatedAt: 222,
			}).Error)
			var stored PlaygroundCanvasProject
			require.NoError(t, db.Where("id = ?", "pgc_image").First(&stored).Error)
			assert.Equal(t, PlaygroundCanvasModeImage, NormalizePlaygroundCanvasMode(stored.Mode))
		})
	}
}
