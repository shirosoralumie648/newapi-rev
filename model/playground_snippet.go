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
	// ErrPlaygroundSnippetVersionNotFound is the stable error for a rollback or
	// export that names a version the snippet does not store.
	ErrPlaygroundSnippetVersionNotFound = errors.New("Prompt snippet version not found.")
	// ErrPlaygroundSnippetVersionLimit is the stable capacity error produced
	// when appending a version would exceed the per-template version budget or
	// the account's total version budget.
	ErrPlaygroundSnippetVersionLimit = errors.New("Prompt snippet version limit exceeded.")
)

// playgroundSnippetListMaxCount bounds one listing independently of the
// policy, so an extremely high per-account limit cannot turn the list endpoint
// into an unbounded response. The stored snippets stay intact; the response
// reports the total so a truncated page is still visible.
const playgroundSnippetListMaxCount = 200

// playgroundSnippetVersionIDPrefix identifies one immutable snippet version.
const playgroundSnippetVersionIDPrefix = "pgsv_"

// PlaygroundSnippet is one reusable prompt template owned by an account: a
// short display name and the text the composer inserts. Snippets carry no
// credentials or provider addresses; inserting one only fills the composer,
// and sending the message still runs through the ordinary Relay pipeline.
//
// Every content save appends one immutable PlaygroundSnippetVersion; Content
// mirrors the content of the version ProductionVersion points at, so the
// CH-07 insert path keeps inserting exactly the published text.
type PlaygroundSnippet struct {
	ID      string   `json:"id" gorm:"size:32;primaryKey"`
	UserID  int      `json:"user_id" gorm:"not null;index"`
	Name    string   `json:"name" gorm:"size:100;not null"`
	Content LongText `json:"-" gorm:"not null"`
	// CurrentVersion is the number of stored versions (they are contiguous
	// 1..N) and ProductionVersion is the movable publish pointer. The columns
	// were appended to a table that already holds rows, so they carry the same
	// DEFAULT 0 as the other later columns on upgraded installations.
	CurrentVersion    int   `json:"current_version" gorm:"not null;default:0"`
	ProductionVersion int   `json:"production_version" gorm:"not null;default:0"`
	CreatedAt         int64 `json:"created_at" gorm:"not null;index"`
	UpdatedAt         int64 `json:"updated_at" gorm:"not null;index"`
}

// PlaygroundSnippetVersion is one immutable revision of a prompt template.
// Rows are never rewritten: saving changed text appends the next version and
// moves the production pointer, and a rollback only moves the pointer back.
// (snippet_id, version) is unique so two concurrent saves can never store the
// same revision twice.
type PlaygroundSnippetVersion struct {
	ID        string   `json:"id" gorm:"size:32;primaryKey"`
	SnippetID string   `json:"snippet_id" gorm:"size:32;not null;uniqueIndex:uk_playground_snippet_version"`
	UserID    int      `json:"user_id" gorm:"not null;index"`
	Version   int      `json:"version" gorm:"not null;uniqueIndex:uk_playground_snippet_version"`
	Content   LongText `json:"-" gorm:"not null"`
	ByteSize  int64    `json:"byte_size" gorm:"not null"`
	CreatedAt int64    `json:"created_at" gorm:"not null"`
}

// newPlaygroundSnippetVersionID produces the random identifier of one version
// row; it is shared by the write paths and the one-time migration.
func newPlaygroundSnippetVersionID() (string, error) {
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return "", err
	}
	return playgroundSnippetVersionIDPrefix + key, nil
}

// CreatePlaygroundSnippet stores a new snippet and its first immutable version
// for the account. The account counter row is locked first so concurrent
// creates cannot both slip past the per-account snippet or version budget
// without touching the users row.
func CreatePlaygroundSnippet(userID int, snippet *PlaygroundSnippet) error {
	if userID <= 0 || snippet == nil {
		return errors.New("invalid playground snippet")
	}
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return err
	}
	versionID, err := newPlaygroundSnippetVersionID()
	if err != nil {
		return err
	}
	now := common.GetTimestamp()
	snippet.ID = "pgs_" + key
	snippet.UserID = userID
	snippet.CurrentVersion = 1
	snippet.ProductionVersion = 1
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
		if usage.SnippetVersions+1 > int64(policy.SnippetVersionUserMaxCount) {
			return ErrPlaygroundSnippetVersionLimit
		}
		if err := tx.Create(snippet).Error; err != nil {
			return err
		}
		version := &PlaygroundSnippetVersion{
			ID: versionID, SnippetID: snippet.ID, UserID: userID, Version: 1,
			Content: snippet.Content, ByteSize: int64(len(snippet.Content)), CreatedAt: now,
		}
		if err := tx.Create(version).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{Snippets: 1, SnippetVersions: 1})
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

// GetPlaygroundSnippetVersions returns the owner's stored revisions of one
// snippet, oldest first. Ownership is checked against the snippet row before a
// single version is read, so a version is never reachable by id alone.
func GetPlaygroundSnippetVersions(userID int, id string) ([]PlaygroundSnippetVersion, error) {
	snippet, err := GetPlaygroundSnippet(userID, id)
	if err != nil {
		return nil, err
	}
	versions := make([]PlaygroundSnippetVersion, 0)
	err = DB.Where("snippet_id = ? AND user_id = ?", snippet.ID, userID).Order("version ASC").Find(&versions).Error
	if err != nil {
		return nil, err
	}
	return versions, nil
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

// PlaygroundSnippetUpdate is one validated update of an owned snippet. A nil
// field keeps the stored value.
type PlaygroundSnippetUpdate struct {
	Name    *string
	Content *string
}

// UpdatePlaygroundSnippet applies the validated field updates of one owned
// snippet and returns the stored row. Text that matches the published version
// changes nothing but the update timestamp; text that matches an older
// revision re-publishes that revision, and new text appends the next immutable
// version and moves the production pointer to it.
func UpdatePlaygroundSnippet(userID int, id string, update PlaygroundSnippetUpdate) (*PlaygroundSnippet, error) {
	if userID <= 0 || id == "" || (update.Name == nil && update.Content == nil) {
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
		updates := map[string]any{"updated_at": common.GetTimestamp()}
		if update.Name != nil {
			updates["name"] = *update.Name
		}
		if update.Content != nil && *update.Content != string(snippet.Content) {
			var existing PlaygroundSnippetVersion
			err := tx.Where("snippet_id = ? AND user_id = ? AND content = ?", snippet.ID, userID, *update.Content).
				Order("version DESC").First(&existing).Error
			switch {
			case err == nil:
				// The submitted text is an existing revision: publishing it is a
				// pointer move, never a new row.
				updates["content"] = *update.Content
				updates["production_version"] = existing.Version
			case errors.Is(err, gorm.ErrRecordNotFound):
				if err := appendPlaygroundSnippetVersion(tx, &snippet, *update.Content, updates); err != nil {
					return err
				}
			default:
				return err
			}
		}
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

// appendPlaygroundSnippetVersion stores the next immutable revision of one
// snippet whose row is already locked by the surrounding transaction. The
// per-template and per-account version budgets are checked against the locked
// snippet and counter rows before the row is written.
func appendPlaygroundSnippetVersion(tx *gorm.DB, snippet *PlaygroundSnippet, content string, updates map[string]any) error {
	policy, err := playgroundPolicyForUser(tx, snippet.UserID)
	if err != nil {
		return err
	}
	usage, err := lockPlaygroundUserUsage(tx, snippet.UserID)
	if err != nil {
		return err
	}
	next := snippet.CurrentVersion + 1
	if next > policy.SnippetVersionMaxCount || usage.SnippetVersions+1 > int64(policy.SnippetVersionUserMaxCount) {
		return ErrPlaygroundSnippetVersionLimit
	}
	versionID, err := newPlaygroundSnippetVersionID()
	if err != nil {
		return err
	}
	version := &PlaygroundSnippetVersion{
		ID: versionID, SnippetID: snippet.ID, UserID: snippet.UserID, Version: next,
		Content: LongText(content), ByteSize: int64(len(content)), CreatedAt: common.GetTimestamp(),
	}
	if err := tx.Create(version).Error; err != nil {
		return err
	}
	usage.apply(playgroundUserUsageDelta{SnippetVersions: 1})
	if err := savePlaygroundUserUsage(tx, usage); err != nil {
		return err
	}
	updates["content"] = content
	updates["current_version"] = next
	updates["production_version"] = next
	return nil
}

// RollbackPlaygroundSnippet moves the production pointer of one owned snippet
// back to a stored revision. The revision history is never rewritten: only
// Content and ProductionVersion change, so the rollback itself can be rolled
// back by pointing at a later version again.
func RollbackPlaygroundSnippet(userID int, id string, version int) (*PlaygroundSnippet, error) {
	if userID <= 0 || id == "" || version <= 0 {
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
		var target PlaygroundSnippetVersion
		err := tx.Where("snippet_id = ? AND user_id = ? AND version = ?", snippet.ID, userID, version).First(&target).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundSnippetVersionNotFound
		}
		if err != nil {
			return err
		}
		if err := tx.Model(&PlaygroundSnippet{}).Where("id = ? AND user_id = ?", id, userID).
			Updates(map[string]any{
				"production_version": version,
				"content":            string(target.Content),
				"updated_at":         common.GetTimestamp(),
			}).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).First(&snippet).Error
	})
	if err != nil {
		return nil, err
	}
	return &snippet, nil
}

// ImportPlaygroundSnippet stores one imported template atomically: the snippet
// row and all of its versions are written inside a single transaction after
// the same per-account snippet and version budgets the create path applies.
// The caller has already validated the name and every version content.
func ImportPlaygroundSnippet(userID int, name string, contents []string, productionVersion int) (*PlaygroundSnippet, error) {
	if userID <= 0 || len(contents) == 0 {
		return nil, errors.New("invalid playground snippet")
	}
	if productionVersion <= 0 || productionVersion > len(contents) {
		productionVersion = len(contents)
	}
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return nil, err
	}
	now := common.GetTimestamp()
	snippet := &PlaygroundSnippet{
		ID: "pgs_" + key, UserID: userID, Name: name, Content: LongText(contents[productionVersion-1]),
		CurrentVersion: len(contents), ProductionVersion: productionVersion, CreatedAt: now, UpdatedAt: now,
	}
	err = DB.Transaction(func(tx *gorm.DB) error {
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
		if len(contents) > policy.SnippetVersionMaxCount || usage.SnippetVersions+int64(len(contents)) > int64(policy.SnippetVersionUserMaxCount) {
			return ErrPlaygroundSnippetVersionLimit
		}
		if err := tx.Create(snippet).Error; err != nil {
			return err
		}
		rows := make([]PlaygroundSnippetVersion, 0, len(contents))
		for index, content := range contents {
			versionID, err := newPlaygroundSnippetVersionID()
			if err != nil {
				return err
			}
			rows = append(rows, PlaygroundSnippetVersion{
				ID: versionID, SnippetID: snippet.ID, UserID: userID, Version: index + 1,
				Content: LongText(content), ByteSize: int64(len(content)), CreatedAt: now,
			})
		}
		if err := tx.Create(&rows).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{Snippets: 1, SnippetVersions: int64(len(contents))})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		return nil, err
	}
	return snippet, nil
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
		var versionCount int64
		if err := tx.Model(&PlaygroundSnippetVersion{}).Where("snippet_id = ? AND user_id = ?", id, userID).Count(&versionCount).Error; err != nil {
			return err
		}
		if err := tx.Where("snippet_id = ? AND user_id = ?", id, userID).Delete(&PlaygroundSnippetVersion{}).Error; err != nil {
			return err
		}
		if err := tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundSnippet{}).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{Snippets: -1, SnippetVersions: -versionCount})
		return savePlaygroundUserUsage(tx, usage)
	})
}
