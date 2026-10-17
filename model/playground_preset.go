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
	"errors"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"gorm.io/gorm"
)

var (
	ErrPlaygroundPresetNotFound = errors.New("Assistant preset not found.")
	// ErrPlaygroundPresetLimit and ErrPlaygroundSystemPromptLimit are the stable
	// capacity errors the resource quota policy produces for assistant presets
	// and for the conversation-level system prompt.
	ErrPlaygroundPresetLimit       = errors.New("Assistant preset limit exceeded.")
	ErrPlaygroundSystemPromptLimit = errors.New("Playground system prompt limit exceeded.")
)

// playgroundPresetListMaxCount bounds one listing independently of the policy,
// so an extremely high per-account limit cannot turn the list endpoint into an
// unbounded response. The stored presets stay intact; the response reports the
// total so a truncated page is still visible.
const playgroundPresetListMaxCount = 200

// PlaygroundPreset is a reusable assistant definition owned by one account: a
// display name and avatar, the model and sampling parameters it configures, and
// the system prompt it applies. Presets never carry credentials or provider
// addresses; applying one only copies its fields into a conversation, and every
// model request still runs through the ordinary Relay pipeline.
type PlaygroundPreset struct {
	ID               string   `json:"id" gorm:"size:32;primaryKey"`
	UserID           int      `json:"user_id" gorm:"not null;index"`
	Name             string   `json:"name" gorm:"size:100;not null"`
	Avatar           string   `json:"avatar" gorm:"size:2048;not null"`
	Config           string   `json:"-" gorm:"type:text;not null"`
	ParameterEnabled string   `json:"-" gorm:"type:text;not null"`
	SystemPrompt     LongText `json:"-" gorm:"not null"`
	CreatedAt        int64    `json:"created_at" gorm:"not null;index"`
	UpdatedAt        int64    `json:"updated_at" gorm:"not null;index"`
}

// CreatePlaygroundPreset stores a new preset for the account. The owner row is
// locked first so concurrent creates cannot both slip past the per-account
// preset budget.
func CreatePlaygroundPreset(userID int, preset *PlaygroundPreset) error {
	if userID <= 0 || preset == nil {
		return errors.New("invalid playground preset")
	}
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return err
	}
	now := common.GetTimestamp()
	preset.ID = "pgp_" + key
	preset.UserID = userID
	preset.CreatedAt = now
	preset.UpdatedAt = now
	return DB.Transaction(func(tx *gorm.DB) error {
		var owner User
		if err := lockForUpdate(tx).Where("id = ?", userID).First(&owner).Error; err != nil {
			return err
		}
		policy := playground_setting.GetPlaygroundQuotaPolicy(owner.Group)
		var count int64
		if err := tx.Model(&PlaygroundPreset{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
			return err
		}
		if count >= int64(policy.PresetUserMaxCount) {
			return ErrPlaygroundPresetLimit
		}
		return tx.Create(preset).Error
	})
}

func GetPlaygroundPreset(userID int, id string) (*PlaygroundPreset, error) {
	var preset PlaygroundPreset
	err := DB.Where("id = ? AND user_id = ?", id, userID).First(&preset).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundPresetNotFound
	}
	if err != nil {
		return nil, err
	}
	return &preset, nil
}

// ListPlaygroundPresets returns the owner's presets, newest first, together
// with the stored total. The effective read cap is the smaller of the account
// policy and the listing bound.
func ListPlaygroundPresets(userID int, maxCount int) ([]PlaygroundPreset, int64, error) {
	if userID <= 0 {
		return nil, 0, ErrPlaygroundPresetNotFound
	}
	if maxCount <= 0 || maxCount > playgroundPresetListMaxCount {
		maxCount = playgroundPresetListMaxCount
	}
	presets := make([]PlaygroundPreset, 0)
	var count int64
	query := DB.Model(&PlaygroundPreset{}).Where("user_id = ?", userID)
	if err := query.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	err := query.Order("updated_at DESC, id DESC").Limit(maxCount).Find(&presets).Error
	return presets, count, err
}

// UpdatePlaygroundPreset applies the validated field updates of one owned
// preset and returns the stored row.
func UpdatePlaygroundPreset(userID int, id string, updates map[string]any) (*PlaygroundPreset, error) {
	if userID <= 0 || id == "" || len(updates) == 0 {
		return nil, ErrPlaygroundPresetNotFound
	}
	var preset PlaygroundPreset
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&preset).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundPresetNotFound
			}
			return err
		}
		updates["updated_at"] = common.GetTimestamp()
		if err := tx.Model(&PlaygroundPreset{}).Where("id = ? AND user_id = ?", id, userID).Updates(updates).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).First(&preset).Error
	})
	if err != nil {
		return nil, err
	}
	return &preset, nil
}

func DeletePlaygroundPreset(userID int, id string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var preset PlaygroundPreset
		err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&preset).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundPresetNotFound
		}
		if err != nil {
			return err
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundPreset{}).Error
	})
}
