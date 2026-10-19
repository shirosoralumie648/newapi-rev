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

const (
	// PlaygroundPresetVisibilityPrivate is the default scope: only the owner can
	// list, read and edit the preset.
	PlaygroundPresetVisibilityPrivate = "private"
	// PlaygroundPresetVisibilityGlobal marks a preset maintained by an
	// administrator and offered to every account through the preset market.
	// Global rows have no owner (user_id 0), so they never consume an account's
	// private preset budget.
	PlaygroundPresetVisibilityGlobal = "global"
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
//
// A global preset is platform content instead of an account resource: it is
// created and edited through the administrator endpoints, has user_id 0 and is
// excluded from every per-account listing and counter.
type PlaygroundPreset struct {
	ID               string   `json:"id" gorm:"size:32;primaryKey"`
	UserID           int      `json:"user_id" gorm:"not null;index"`
	Name             string   `json:"name" gorm:"size:100;not null"`
	Avatar           string   `json:"avatar" gorm:"size:2048;not null"`
	Config           string   `json:"-" gorm:"type:text;not null"`
	ParameterEnabled string   `json:"-" gorm:"type:text;not null"`
	SystemPrompt     LongText `json:"-" gorm:"not null"`
	// Visibility is the private/global scope. The column stays nullable so an
	// existing installation can add it on every supported database; a NULL or
	// unknown value reads back as private, which is the pre-market behavior.
	Visibility string `json:"-" gorm:"size:16;index"`
	// OpeningMessage is the display-only greeting a conversation created from
	// the preset starts with. It is never sent to the model as a message.
	OpeningMessage LongText `json:"-"`
	// SuggestedQuestions stores the starter questions as a JSON array of
	// strings. The column stays nullable for the same migration reason.
	SuggestedQuestions string `json:"-" gorm:"type:text"`
	CreatedAt          int64  `json:"created_at" gorm:"not null;index"`
	UpdatedAt          int64  `json:"updated_at" gorm:"not null;index"`
}

// PlaygroundPresetVisibility normalizes a stored visibility value. Rows created
// before the market existed have no value and remain private.
func PlaygroundPresetVisibility(value string) string {
	if value == PlaygroundPresetVisibilityGlobal {
		return PlaygroundPresetVisibilityGlobal
	}
	return PlaygroundPresetVisibilityPrivate
}

// CreatePlaygroundPreset stores a new private preset for the account. The
// account counter row is locked first so concurrent creates cannot both slip
// past the per-account preset budget without touching the users row.
func CreatePlaygroundPreset(userID int, preset *PlaygroundPreset) error {
	if userID <= 0 || preset == nil {
		return errors.New("invalid playground preset")
	}
	preset.Visibility = PlaygroundPresetVisibilityPrivate
	return DB.Transaction(func(tx *gorm.DB) error {
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if usage.Presets >= int64(policy.PresetUserMaxCount) {
			return ErrPlaygroundPresetLimit
		}
		if err := createPlaygroundPresetRow(tx, userID, preset); err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{Presets: 1})
		return savePlaygroundUserUsage(tx, usage)
	})
}

// createPlaygroundPresetRow writes one preset row without touching an account
// counter. Global presets use it directly; private presets reach it inside the
// locked CreatePlaygroundPreset transaction.
func createPlaygroundPresetRow(tx *gorm.DB, userID int, preset *PlaygroundPreset) error {
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return err
	}
	now := common.GetTimestamp()
	preset.ID = "pgp_" + key
	preset.UserID = userID
	preset.CreatedAt = now
	preset.UpdatedAt = now
	return tx.Create(preset).Error
}

func GetPlaygroundPreset(userID int, id string) (*PlaygroundPreset, error) {
	if userID <= 0 || id == "" {
		return nil, ErrPlaygroundPresetNotFound
	}
	var preset PlaygroundPreset
	err := DB.Where("id = ? AND user_id = ? AND (visibility IS NULL OR visibility <> ?)", id, userID, PlaygroundPresetVisibilityGlobal).First(&preset).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundPresetNotFound
	}
	if err != nil {
		return nil, err
	}
	return &preset, nil
}

// GetGlobalPlaygroundPreset loads one market preset regardless of who created
// it. Only rows explicitly marked global are visible here.
func GetGlobalPlaygroundPreset(id string) (*PlaygroundPreset, error) {
	if id == "" {
		return nil, ErrPlaygroundPresetNotFound
	}
	var preset PlaygroundPreset
	err := DB.Where("id = ? AND visibility = ?", id, PlaygroundPresetVisibilityGlobal).First(&preset).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundPresetNotFound
	}
	if err != nil {
		return nil, err
	}
	return &preset, nil
}

// ListPlaygroundPresets returns the owner's private presets, newest first,
// together with the stored total. Global presets have no owner and never
// appear in an account list.
func ListPlaygroundPresets(userID int, maxCount int) ([]PlaygroundPreset, int64, error) {
	if userID <= 0 {
		return nil, 0, ErrPlaygroundPresetNotFound
	}
	return listPlaygroundPresets(DB.Where("user_id = ? AND (visibility IS NULL OR visibility <> ?)", userID, PlaygroundPresetVisibilityGlobal), maxCount)
}

// ListGlobalPlaygroundPresets returns the market presets, newest first.
func ListGlobalPlaygroundPresets(maxCount int) ([]PlaygroundPreset, int64, error) {
	return listPlaygroundPresets(DB.Where("visibility = ?", PlaygroundPresetVisibilityGlobal), maxCount)
}

func listPlaygroundPresets(query *gorm.DB, maxCount int) ([]PlaygroundPreset, int64, error) {
	if maxCount <= 0 || maxCount > playgroundPresetListMaxCount {
		maxCount = playgroundPresetListMaxCount
	}
	presets := make([]PlaygroundPreset, 0)
	var count int64
	if err := query.Model(&PlaygroundPreset{}).Count(&count).Error; err != nil {
		return nil, 0, err
	}
	err := query.Order("updated_at DESC, id DESC").Limit(maxCount).Find(&presets).Error
	return presets, count, err
}

// UpdatePlaygroundPreset applies the validated field updates of one owned
// private preset and returns the stored row.
func UpdatePlaygroundPreset(userID int, id string, updates map[string]any) (*PlaygroundPreset, error) {
	if userID <= 0 || id == "" || len(updates) == 0 {
		return nil, ErrPlaygroundPresetNotFound
	}
	var preset PlaygroundPreset
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND (visibility IS NULL OR visibility <> ?)", id, userID, PlaygroundPresetVisibilityGlobal).First(&preset).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundPresetNotFound
			}
			return err
		}
		updates["updated_at"] = common.GetTimestamp()
		owned := tx.Model(&PlaygroundPreset{}).Where("id = ? AND user_id = ? AND (visibility IS NULL OR visibility <> ?)", id, userID, PlaygroundPresetVisibilityGlobal)
		if err := owned.Updates(updates).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND user_id = ? AND (visibility IS NULL OR visibility <> ?)", id, userID, PlaygroundPresetVisibilityGlobal).First(&preset).Error
	})
	if err != nil {
		return nil, err
	}
	return &preset, nil
}

func DeletePlaygroundPreset(userID int, id string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var preset PlaygroundPreset
		owned := tx.Where("id = ? AND user_id = ? AND (visibility IS NULL OR visibility <> ?)", id, userID, PlaygroundPresetVisibilityGlobal)
		err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND (visibility IS NULL OR visibility <> ?)", id, userID, PlaygroundPresetVisibilityGlobal).First(&preset).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundPresetNotFound
		}
		if err != nil {
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if err := owned.Delete(&PlaygroundPreset{}).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{Presets: -1})
		return savePlaygroundUserUsage(tx, usage)
	})
}

// CreateGlobalPlaygroundPreset stores one market preset. Global presets are
// platform content, so they have no owner and do not touch any account counter.
// The market size is bounded so the listing never silently truncates.
func CreateGlobalPlaygroundPreset(preset *PlaygroundPreset) error {
	if preset == nil {
		return errors.New("invalid playground preset")
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&PlaygroundPreset{}).Where("visibility = ?", PlaygroundPresetVisibilityGlobal).Count(&count).Error; err != nil {
			return err
		}
		if count >= playgroundPresetListMaxCount {
			return ErrPlaygroundPresetLimit
		}
		preset.Visibility = PlaygroundPresetVisibilityGlobal
		return createPlaygroundPresetRow(tx, 0, preset)
	})
}

// UpdateGlobalPlaygroundPreset applies field updates to one market preset. The
// visibility column is never part of the update, so a global preset cannot be
// demoted into an ownerless private row.
func UpdateGlobalPlaygroundPreset(id string, updates map[string]any) (*PlaygroundPreset, error) {
	if id == "" || len(updates) == 0 {
		return nil, ErrPlaygroundPresetNotFound
	}
	var preset PlaygroundPreset
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND visibility = ?", id, PlaygroundPresetVisibilityGlobal).First(&preset).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundPresetNotFound
			}
			return err
		}
		updates["updated_at"] = common.GetTimestamp()
		global := tx.Model(&PlaygroundPreset{}).Where("id = ? AND visibility = ?", id, PlaygroundPresetVisibilityGlobal)
		if err := global.Updates(updates).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND visibility = ?", id, PlaygroundPresetVisibilityGlobal).First(&preset).Error
	})
	if err != nil {
		return nil, err
	}
	return &preset, nil
}

func DeleteGlobalPlaygroundPreset(id string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var preset PlaygroundPreset
		err := lockForUpdate(tx).Where("id = ? AND visibility = ?", id, PlaygroundPresetVisibilityGlobal).First(&preset).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundPresetNotFound
		}
		if err != nil {
			return err
		}
		return tx.Where("id = ? AND visibility = ?", id, PlaygroundPresetVisibilityGlobal).Delete(&PlaygroundPreset{}).Error
	})
}

// CopyGlobalPlaygroundPreset copies one market preset into the caller's private
// presets. The copy goes through CreatePlaygroundPreset, so the account preset
// budget and its counter stay authoritative.
func CopyGlobalPlaygroundPreset(userID int, id string) (*PlaygroundPreset, error) {
	source, err := GetGlobalPlaygroundPreset(id)
	if err != nil {
		return nil, err
	}
	cloned := &PlaygroundPreset{
		Name:               source.Name,
		Avatar:             source.Avatar,
		Config:             source.Config,
		ParameterEnabled:   source.ParameterEnabled,
		SystemPrompt:       source.SystemPrompt,
		OpeningMessage:     source.OpeningMessage,
		SuggestedQuestions: source.SuggestedQuestions,
	}
	if err := CreatePlaygroundPreset(userID, cloned); err != nil {
		return nil, err
	}
	return cloned, nil
}
