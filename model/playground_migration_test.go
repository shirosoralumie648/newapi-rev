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
	"os"
	"testing"

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
		require.NoError(t, db.Migrator().DropTable(&PlaygroundMessage{}))
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
