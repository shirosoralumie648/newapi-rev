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

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"gorm.io/gorm"
)

// playgroundMessageClientIndex is the unique index that makes one
// (session_id, client_key) pair identify exactly one stored message row.
const playgroundMessageClientIndex = "uk_playground_message_session_client"

type playgroundMessageDuplicate struct {
	SessionID string
	ClientKey string
}

// migratePlaygroundMessageUniqueness keeps the newest row of every duplicated
// (session_id, client_key) pair before AutoMigrate adds the unique index, so a
// database written by a release that replaced whole snapshots never fails the
// index creation. The check is skipped once the index exists, which keeps later
// startups cheap.
func migratePlaygroundMessageUniqueness(db *gorm.DB) error {
	if db == nil {
		return fmt.Errorf("migrate playground message uniqueness: database is nil")
	}
	if !db.Migrator().HasTable(&PlaygroundMessage{}) {
		return nil
	}
	if db.Migrator().HasIndex(&PlaygroundMessage{}, playgroundMessageClientIndex) {
		return nil
	}

	duplicates := make([]playgroundMessageDuplicate, 0)
	if err := db.Model(&PlaygroundMessage{}).
		Select("session_id, client_key").
		Group("session_id, client_key").
		Having("COUNT(*) > 1").
		Find(&duplicates).Error; err != nil {
		return fmt.Errorf("inspect duplicate playground messages: %w", err)
	}
	for _, duplicate := range duplicates {
		rows := make([]PlaygroundMessage, 0)
		if err := db.Where("session_id = ? AND client_key = ?", duplicate.SessionID, duplicate.ClientKey).
			Order("position DESC, id DESC").Find(&rows).Error; err != nil {
			return fmt.Errorf("load duplicate playground messages: %w", err)
		}
		if len(rows) < 2 {
			continue
		}
		ids := make([]int64, 0, len(rows)-1)
		for _, row := range rows[1:] {
			ids = append(ids, row.ID)
		}
		if err := db.Where("id IN ?", ids).Delete(&PlaygroundMessage{}).Error; err != nil {
			return fmt.Errorf("remove duplicate playground messages: %w", err)
		}
		common.SysLog(common.LogText("removed %d duplicate Playground message rows for session %s", len(ids), duplicate.SessionID))
	}
	return nil
}

// migratePlaygroundAttachmentStorage relaxes the data column of
// playground_attachments before AutoMigrate runs. The release that moved
// attachment bytes into the object store writes NULL there for every new
// upload, but GORM only alters a column when the database is stricter than the
// model: a shipped NOT NULL column would reject those NULLs, so the constraint
// is dropped explicitly here (MySQL MODIFY, PostgreSQL DROP NOT NULL, SQLite
// table rebuild; AutoMigrate recreates the indexes the SQLite rebuild drops).
// The migration is a no-op on a fresh database and once the column is
// nullable.
func migratePlaygroundAttachmentStorage(db *gorm.DB) error {
	if db == nil {
		return fmt.Errorf("migrate playground attachment storage: database is nil")
	}
	if !db.Migrator().HasTable(&PlaygroundAttachment{}) {
		return nil
	}
	columnTypes, err := db.Migrator().ColumnTypes(&PlaygroundAttachment{})
	if err != nil {
		return fmt.Errorf("inspect playground attachment columns: %w", err)
	}
	for _, columnType := range columnTypes {
		if columnType.Name() != "data" {
			continue
		}
		nullable, ok := columnType.Nullable()
		if !ok || nullable {
			return nil
		}
		if err := db.Migrator().AlterColumn(&PlaygroundAttachment{}, "Data"); err != nil {
			return fmt.Errorf("make playground attachment data column nullable: %w", err)
		}
		return nil
	}
	return nil
}

// playgroundTrashTables are the tables that gained a trash tombstone. The
// resolved table name comes from the statement parser so the migration honors
// the configured naming strategy (including a table prefix).
var playgroundTrashTables = []any{&PlaygroundSession{}, &PlaygroundCanvasProject{}}

// migratePlaygroundTrashColumns adds the trash tombstone to installations that
// predate it. PostgreSQL refuses to add a NOT NULL column to a non-empty table
// without a default, so the column is created with DEFAULT 0 before
// AutoMigrate sees it; AutoMigrate then only verifies the model contract. The
// migration is a no-op on a fresh database and once the column exists.
func migratePlaygroundTrashColumns(db *gorm.DB) error {
	if db == nil {
		return fmt.Errorf("migrate playground trash columns: database is nil")
	}
	for _, target := range playgroundTrashTables {
		if !db.Migrator().HasTable(target) {
			continue
		}
		if db.Migrator().HasColumn(target, "DeletedAt") {
			continue
		}
		statement := &gorm.Statement{DB: db}
		if err := statement.Parse(target); err != nil {
			return fmt.Errorf("resolve playground trash table: %w", err)
		}
		if statement.Table == "" {
			return fmt.Errorf("resolve playground trash table: empty table name")
		}
		if err := db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN deleted_at bigint NOT NULL DEFAULT 0", statement.Table)).Error; err != nil {
			return fmt.Errorf("add %s.deleted_at: %w", statement.Table, err)
		}
	}
	return nil
}

// playgroundUserUsageCounterColumns are the Playground usage counters that
// later releases added to the account counter row. PostgreSQL refuses to add a
// NOT NULL column to a non-empty table without a default, so they are created
// with DEFAULT 0 before AutoMigrate sees them.
var playgroundUserUsageCounterColumns = []string{"snippets", "canvas_snapshot_count", "canvas_snapshot_bytes", "attachment_pending_count", "attachment_pending_bytes"}

// migratePlaygroundUserUsageCounters adds the counters that later releases
// introduced (prompt snippets, canvas snapshots and in-flight upload
// reservations) to an installation that predates them. The migration is a
// no-op on a fresh database and once the columns exist.
func migratePlaygroundUserUsageCounters(db *gorm.DB) error {
	if db == nil {
		return fmt.Errorf("migrate playground user usage counters: database is nil")
	}
	target := &PlaygroundUserUsage{}
	if !db.Migrator().HasTable(target) {
		return nil
	}
	statement := &gorm.Statement{DB: db}
	if err := statement.Parse(target); err != nil {
		return fmt.Errorf("resolve playground user usage table: %w", err)
	}
	if statement.Table == "" {
		return fmt.Errorf("resolve playground user usage table: empty table name")
	}
	for _, column := range playgroundUserUsageCounterColumns {
		if db.Migrator().HasColumn(target, column) {
			continue
		}
		if err := db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s bigint NOT NULL DEFAULT 0", statement.Table, column)).Error; err != nil {
			return fmt.Errorf("add %s.%s: %w", statement.Table, column, err)
		}
	}
	return nil
}

// ensurePlaygroundAttachmentStorageBackend marks rows written before the
// object store existed (and rows that an older node of a rolling upgrade kept
// writing) as database-backed after AutoMigrate added the column. AutoMigrate
// leaves upgraded rows NULL, so both NULL and the empty string count as
// unmarked. The update skips UpdatedAt so it never resets the orphan countdown
// of an unreferenced attachment.
func ensurePlaygroundAttachmentStorageBackend(db *gorm.DB) error {
	if db == nil {
		return fmt.Errorf("ensure playground attachment storage backend: database is nil")
	}
	unmarked := "storage_backend IS NULL OR storage_backend = ?"
	var legacy int64
	if err := db.Model(&PlaygroundAttachment{}).Where(unmarked, "").Count(&legacy).Error; err != nil {
		return fmt.Errorf("count legacy playground attachments: %w", err)
	}
	if legacy == 0 {
		return nil
	}
	if err := db.Model(&PlaygroundAttachment{}).Where(unmarked, "").
		UpdateColumn("storage_backend", system_setting.ObjectStoreBackendDB).Error; err != nil {
		return fmt.Errorf("mark legacy playground attachments as database-backed: %w", err)
	}
	return nil
}
