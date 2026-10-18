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
	ErrPlaygroundSnippetNotFound = errors.New("Prompt snippet not found.")
	// ErrPlaygroundSnippetLimit is the stable capacity error the resource
	// quota policy produces when the account's snippet budget is full. The
	// per-snippet content bound is validated by the controller against the same
	// policy before the row reaches this layer.
	ErrPlaygroundSnippetLimit = errors.New("Prompt snippet limit exceeded.")
	// ErrPlaygroundSnippetContentLimit is the stable capacity error for one
	// snippet whose text exceeds the account's per-snippet byte budget.
	ErrPlaygroundSnippetContentLimit = errors.New("Prompt snippet content limit exceeded.")
)

// playgroundSnippetListMaxCount bounds one listing independently of the
// policy, so an extremely high per-account limit cannot turn the list endpoint
// into an unbounded response. The stored snippets stay intact; the response
// reports the total so a truncated page is still visible.
const playgroundSnippetListMaxCount = 200

// PlaygroundSnippet is one reusable prompt fragment owned by an account: a
// short display name and the text the composer inserts. Snippets carry no
// credentials or provider addresses; inserting one only fills the composer,
// and sending the message still runs through the ordinary Relay pipeline.
type PlaygroundSnippet struct {
	ID        string   `json:"id" gorm:"size:32;primaryKey"`
	UserID    int      `json:"user_id" gorm:"not null;index"`
	Name      string   `json:"name" gorm:"size:100;not null"`
	Content   LongText `json:"-" gorm:"not null"`
	CreatedAt int64    `json:"created_at" gorm:"not null;index"`
	UpdatedAt int64    `json:"updated_at" gorm:"not null;index"`
}

// CreatePlaygroundSnippet stores a new snippet for the account. The account
// counter row is locked first so concurrent creates cannot both slip past the
// per-account snippet budget without touching the users row.
func CreatePlaygroundSnippet(userID int, snippet *PlaygroundSnippet) error {
	if userID <= 0 || snippet == nil {
		return errors.New("invalid playground snippet")
	}
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return err
	}
	now := common.GetTimestamp()
	snippet.ID = "pgs_" + key
	snippet.UserID = userID
	snippet.CreatedAt = now
	snippet.UpdatedAt = now
	return DB.Transaction(func(tx *gorm.DB) error {
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if usage.Snippets >= int64(policy.SnippetUserMaxCount) {
			return ErrPlaygroundSnippetLimit
		}
		if err := tx.Create(snippet).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{Snippets: 1})
		return savePlaygroundUserUsage(tx, usage)
	})
}

func GetPlaygroundSnippet(userID int, id string) (*PlaygroundSnippet, error) {
	var snippet PlaygroundSnippet
	err := DB.Where("id = ? AND user_id = ?", id, userID).First(&snippet).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundSnippetNotFound
	}
	if err != nil {
		return nil, err
	}
	return &snippet, nil
}

// ListPlaygroundSnippets returns the owner's snippets, newest first, together
// with the stored total. The effective read cap is the smaller of the account
// policy and the listing bound.
func ListPlaygroundSnippets(userID int, maxCount int) ([]PlaygroundSnippet, int64, error) {
	if userID <= 0 {
		return nil, 0, ErrPlaygroundSnippetNotFound
	}
	if maxCount <= 0 || maxCount > playgroundSnippetListMaxCount {
		maxCount = playgroundSnippetListMaxCount
	}
	snippets := make([]PlaygroundSnippet, 0)
	var count int64
	query := DB.Model(&PlaygroundSnippet{}).Where("user_id = ?", userID)
	if err := query.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	err := query.Order("updated_at DESC, id DESC").Limit(maxCount).Find(&snippets).Error
	return snippets, count, err
}

// UpdatePlaygroundSnippet applies the validated field updates of one owned
// snippet and returns the stored row.
func UpdatePlaygroundSnippet(userID int, id string, updates map[string]any) (*PlaygroundSnippet, error) {
	if userID <= 0 || id == "" || len(updates) == 0 {
		return nil, ErrPlaygroundSnippetNotFound
	}
	var snippet PlaygroundSnippet
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&snippet).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundSnippetNotFound
			}
			return err
		}
		updates["updated_at"] = common.GetTimestamp()
		if err := tx.Model(&PlaygroundSnippet{}).Where("id = ? AND user_id = ?", id, userID).Updates(updates).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).First(&snippet).Error
	})
	if err != nil {
		return nil, err
	}
	return &snippet, nil
}

func DeletePlaygroundSnippet(userID int, id string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var snippet PlaygroundSnippet
		err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&snippet).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundSnippetNotFound
		}
		if err != nil {
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if err := tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundSnippet{}).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{Snippets: -1})
		return savePlaygroundUserUsage(tx, usage)
	})
}
