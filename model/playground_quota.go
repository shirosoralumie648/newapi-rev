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
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"gorm.io/gorm"
)

// PlaygroundQuotaPolicyForUser resolves the effective Playground resource
// budget for one account from its user group. Request handlers use it for
// pre-checks and cheap request limits; every capacity write is re-checked
// inside its transaction so the stored data always obeys the policy.
func PlaygroundQuotaPolicyForUser(userID int) (playground_setting.PlaygroundQuotaPolicy, error) {
	return playgroundPolicyForUser(DB, userID)
}

// playgroundPolicyForUser reads the owner's group and resolves the policy on the
// given connection, so a transactional caller sees the group it locked.
func playgroundPolicyForUser(tx *gorm.DB, userID int) (playground_setting.PlaygroundQuotaPolicy, error) {
	policy, _, err := playgroundPolicyForGroup(tx, userID)
	return policy, err
}

// playgroundPolicyForGroup resolves the effective resource budget for one
// account together with the user group it was resolved from. The unified usage
// view reports that group so the caller can see which group's entitlement
// applies and where a subscription upgrade would take them; every write path
// keeps using the policy alone.
func playgroundPolicyForGroup(tx *gorm.DB, userID int) (playground_setting.PlaygroundQuotaPolicy, string, error) {
	if userID <= 0 {
		return playground_setting.GetPlaygroundQuotaPolicy(""), "", nil
	}
	var user User
	if err := tx.Select("id", "group").Where("id = ?", userID).First(&user).Error; err != nil {
		return playground_setting.PlaygroundQuotaPolicy{}, "", err
	}
	return playground_setting.GetPlaygroundQuotaPolicy(user.Group), user.Group, nil
}
