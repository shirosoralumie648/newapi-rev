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
