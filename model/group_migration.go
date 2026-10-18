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
	"slices"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/group_setting"
	"gorm.io/gorm"
)

// migrateStableGroupReferences rewrites stored group references that still use
// an editable display name into the group's stable identifier. Groups are keyed
// by immutable identifiers, so after the rewrite a later display-name change
// can never invalidate a token, a user, a subscription or an Auto snapshot.
//
// The rewrite is driven by the configured display names and only touches values
// that match one exactly, which makes it idempotent: repeating it changes
// nothing, and a database where no display name is configured (the default) is
// left untouched. It must run after AutoMigrate because it writes the token,
// user, subscription plan and subscription tables.
func migrateStableGroupReferences(db *gorm.DB) error {
	if db == nil {
		return nil
	}
	displayNames := group_setting.GetGroupDisplayNamesCopy()
	if len(displayNames) == 0 {
		return nil
	}
	aliases := make([]string, 0, len(displayNames))
	for displayName := range displayNames {
		aliases = append(aliases, displayName)
	}
	slices.Sort(aliases)
	for _, displayName := range aliases {
		identifier := displayNames[displayName]
		// Only rewrite an alias that resolves to a real group and that does not
		// shadow an identifier. Validation rejects such display names, and the
		// guard also skips a hand-edited option row.
		if identifier == displayName || !group_setting.IsKnownGroupID(identifier) || group_setting.IsKnownGroupID(displayName) {
			continue
		}
		if err := migrateGroupReferenceColumn(db, &Token{}, displayName, identifier); err != nil {
			return err
		}
		if err := migrateGroupReferenceColumn(db, &User{}, displayName, identifier); err != nil {
			return err
		}
		for _, column := range []string{"upgrade_group", "downgrade_group"} {
			if err := db.Model(&SubscriptionPlan{}).Where(column+" = ?", displayName).Update(column, identifier).Error; err != nil {
				return err
			}
			if err := db.Model(&UserSubscription{}).Where(column+" = ?", displayName).Update(column, identifier).Error; err != nil {
				return err
			}
		}
		if err := db.Model(&UserSubscription{}).Where("prev_user_group = ?", displayName).Update("prev_user_group", identifier).Error; err != nil {
			return err
		}
		if err := migrateTokenAutoGroupReferences(db, displayName, identifier); err != nil {
			return err
		}
	}
	return nil
}

// migrateGroupReferenceColumn updates one reserved-word group column.
func migrateGroupReferenceColumn(db *gorm.DB, value any, from, to string) error {
	return db.Model(value).Where(commonGroupCol+" = ?", from).Update("group", to).Error
}

// migrateTokenAutoGroupReferences rewrites an Auto snapshot that still lists a
// display name. The LIKE prefilter only narrows the rows to parse; every
// candidate is decoded and matched exactly, so wildcards in the name cannot
// rewrite an unrelated snapshot.
func migrateTokenAutoGroupReferences(db *gorm.DB, displayName, identifier string) error {
	var tokens []Token
	if err := db.Where("auto_groups LIKE ?", "%\""+displayName+"\"%").Find(&tokens).Error; err != nil {
		return err
	}
	for index := range tokens {
		if tokens[index].AutoGroups == "" {
			continue
		}
		groups, err := tokens[index].GetAutoGroups()
		if err != nil {
			common.SysError(common.LogText("skip migrating token %d Auto groups: %s", tokens[index].Id, err.Error()))
			continue
		}
		changed := false
		for groupIndex, group := range groups {
			if group == displayName {
				groups[groupIndex] = identifier
				changed = true
			}
		}
		if !changed {
			continue
		}
		payload, err := common.Marshal(groups)
		if err != nil {
			return err
		}
		// Compare the snapshot in the condition so a concurrent edit wins and is
		// never overwritten with a stale list.
		if err := db.Model(&Token{}).
			Where("id = ? AND auto_groups = ?", tokens[index].Id, tokens[index].AutoGroups).
			Update("auto_groups", string(payload)).Error; err != nil {
			return err
		}
	}
	return nil
}
