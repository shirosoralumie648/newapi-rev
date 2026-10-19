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
	ErrPlaygroundMemoryNotFound = errors.New("Playground memory not found.")
	// ErrPlaygroundMemoryLimit is the stable capacity error the resource quota
	// policy produces when the account's memory budget is full. The per-memory
	// content bound is validated by the controller against the same policy
	// before the row reaches this layer.
	ErrPlaygroundMemoryLimit = errors.New("Playground memory limit exceeded.")
	// ErrPlaygroundMemoryContentLimit is the stable capacity error for one
	// memory whose text exceeds the account's per-memory byte budget.
	ErrPlaygroundMemoryContentLimit = errors.New("Playground memory content limit exceeded.")
	// ErrPlaygroundMemorySourceNotFound is returned when a memory points at a
	// conversation the owner does not have. Ownership is checked inside the
	// write transaction so one account can never attach another account's
	// conversation as the source of a memory.
	ErrPlaygroundMemorySourceNotFound = errors.New("Playground memory source conversation not found.")
)

// playgroundMemoryListMaxCount bounds one listing independently of the policy,
// so an extremely high per-account limit cannot turn the list endpoint into an
// unbounded response. The stored memories stay intact; the response reports the
// total so a truncated page is still visible.
const playgroundMemoryListMaxCount = 200

// PlaygroundMemory is one durable note an account keeps across conversations.
// Memories are derived from the owner's own data: a memory either carries a
// source conversation that belongs to the same account or no source at all.
// The stored text is model context, never executable content; injecting it only
// adds a system message to the ordinary /pg request the Relay bills.
type PlaygroundMemory struct {
	ID     string `json:"id" gorm:"size:32;primaryKey"`
	UserID int    `json:"user_id" gorm:"not null;index"`
	// Content is the remembered fact or preference. The controller enforces the
	// per-memory byte budget before this row is written.
	Content  LongText `json:"-" gorm:"not null"`
	Category string   `json:"category" gorm:"size:50;not null"`
	// SourceSessionID is nullable: a memory can be written by hand or survive
	// the purge of the conversation it was extracted from. When it is present
	// the source conversation must belong to the same account.
	SourceSessionID *string `json:"source_session_id" gorm:"size:128;index"`
	Enabled         bool    `json:"enabled" gorm:"not null"`
	CreatedAt       int64   `json:"created_at" gorm:"not null;index"`
	UpdatedAt       int64   `json:"updated_at" gorm:"not null;index"`
}

// CreatePlaygroundMemory stores a new memory for the account. The account
// counter row is locked first so concurrent creates cannot both slip past the
// per-account memory budget without touching the users row.
func CreatePlaygroundMemory(userID int, memory *PlaygroundMemory) error {
	if userID <= 0 || memory == nil {
		return errors.New("invalid playground memory")
	}
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return err
	}
	now := common.GetTimestamp()
	memory.ID = "pgm_" + key
	memory.UserID = userID
	memory.CreatedAt = now
	memory.UpdatedAt = now
	return DB.Transaction(func(tx *gorm.DB) error {
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if usage.Memories >= int64(policy.MemoryUserMaxCount) {
			return ErrPlaygroundMemoryLimit
		}
		if err := validatePlaygroundMemorySource(tx, userID, memory.SourceSessionID); err != nil {
			return err
		}
		if err := tx.Create(memory).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{Memories: 1})
		return savePlaygroundUserUsage(tx, usage)
	})
}

// validatePlaygroundMemorySource rejects a source conversation that is not an
// active conversation of the same account. An empty or nil source is valid.
func validatePlaygroundMemorySource(tx *gorm.DB, userID int, sourceSessionID *string) error {
	if sourceSessionID == nil {
		return nil
	}
	if *sourceSessionID == "" {
		return ErrPlaygroundMemorySourceNotFound
	}
	var count int64
	if err := tx.Model(&PlaygroundSession{}).
		Where("id = ? AND user_id = ? AND deleted_at = 0", *sourceSessionID, userID).
		Count(&count).Error; err != nil {
		return err
	}
	if count == 0 {
		return ErrPlaygroundMemorySourceNotFound
	}
	return nil
}

func GetPlaygroundMemory(userID int, id string) (*PlaygroundMemory, error) {
	var memory PlaygroundMemory
	err := DB.Where("id = ? AND user_id = ?", id, userID).First(&memory).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundMemoryNotFound
	}
	if err != nil {
		return nil, err
	}
	return &memory, nil
}

// ListPlaygroundMemories returns the owner's memories, newest first, together
// with the stored total. The effective read cap is the smaller of the account
// policy and the listing bound.
func ListPlaygroundMemories(userID int, maxCount int) ([]PlaygroundMemory, int64, error) {
	if userID <= 0 {
		return nil, 0, ErrPlaygroundMemoryNotFound
	}
	if maxCount <= 0 || maxCount > playgroundMemoryListMaxCount {
		maxCount = playgroundMemoryListMaxCount
	}
	memories := make([]PlaygroundMemory, 0)
	var count int64
	query := DB.Model(&PlaygroundMemory{}).Where("user_id = ?", userID)
	if err := query.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	err := query.Order("updated_at DESC, id DESC").Limit(maxCount).Find(&memories).Error
	return memories, count, err
}

// UpdatePlaygroundMemory applies the validated field updates of one owned
// memory and returns the stored row. A source conversation can be set or
// cleared through the same updates map and is owner-checked inside the
// transaction.
func UpdatePlaygroundMemory(userID int, id string, updates map[string]any) (*PlaygroundMemory, error) {
	if userID <= 0 || id == "" || len(updates) == 0 {
		return nil, ErrPlaygroundMemoryNotFound
	}
	var memory PlaygroundMemory
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&memory).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundMemoryNotFound
			}
			return err
		}
		if raw, ok := updates["source_session_id"]; ok {
			var source *string
			switch value := raw.(type) {
			case nil:
				source = nil
			case string:
				source = &value
			case *string:
				source = value
			default:
				return ErrPlaygroundMemorySourceNotFound
			}
			if err := validatePlaygroundMemorySource(tx, userID, source); err != nil {
				return err
			}
		}
		updates["updated_at"] = common.GetTimestamp()
		if err := tx.Model(&PlaygroundMemory{}).Where("id = ? AND user_id = ?", id, userID).Updates(updates).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).First(&memory).Error
	})
	if err != nil {
		return nil, err
	}
	return &memory, nil
}

func DeletePlaygroundMemory(userID int, id string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var memory PlaygroundMemory
		err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&memory).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundMemoryNotFound
		}
		if err != nil {
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if err := tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundMemory{}).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{Memories: -1})
		return savePlaygroundUserUsage(tx, usage)
	})
}
