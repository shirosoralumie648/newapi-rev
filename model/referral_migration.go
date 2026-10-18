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

	"gorm.io/gorm"
)

// referralCommissionSettlementColumns are the columns the settlement step
// (RF-04) added to the commission event table, with a portable definition:
// PostgreSQL and MySQL refuse to add a NOT NULL column to a non-empty table
// without a default. The payout form has no default, so it stays nullable and
// NULL means "not settled yet" — the shape AutoMigrate itself would create and
// the only one it can append without rewriting the column on every startup.
var referralCommissionSettlementColumns = []struct {
	name       string
	definition string
}{
	{"locked_at", "bigint NOT NULL DEFAULT 0"},
	{"settled_at", "bigint NOT NULL DEFAULT 0"},
	{"grant_id", "bigint NOT NULL DEFAULT 0"},
	{"settlement_method", "varchar(16)"},
}

// migrateReferralCommissionSettlementColumns adds the settlement columns to an
// installation whose commission table predates them, so their existing events
// keep their values and start as pending with no lock or settlement. The
// migration is a no-op on a fresh database and once the columns exist; the
// resolved table name comes from the statement parser so it honors the
// configured naming strategy (including a table prefix).
func migrateReferralCommissionSettlementColumns(db *gorm.DB) error {
	if db == nil {
		return fmt.Errorf("migrate referral commission settlement columns: database is nil")
	}
	target := &ReferralCommission{}
	if !db.Migrator().HasTable(target) {
		return nil
	}
	statement := &gorm.Statement{DB: db}
	if err := statement.Parse(target); err != nil {
		return fmt.Errorf("resolve referral commission table: %w", err)
	}
	if statement.Table == "" {
		return fmt.Errorf("resolve referral commission table: empty table name")
	}
	for _, column := range referralCommissionSettlementColumns {
		if db.Migrator().HasColumn(target, column.name) {
			continue
		}
		if err := db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", statement.Table, column.name, column.definition)).Error; err != nil {
			return fmt.Errorf("add %s.%s: %w", statement.Table, column.name, err)
		}
	}
	return nil
}
