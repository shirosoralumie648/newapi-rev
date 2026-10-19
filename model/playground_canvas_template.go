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
	ErrPlaygroundCanvasTemplateNotFound = errors.New("Canvas template not found.")
	ErrPlaygroundCanvasTemplateLimit    = errors.New("Canvas template limit exceeded.")
	ErrPlaygroundCanvasTemplateInvalid  = errors.New("Invalid canvas template.")
)

const (
	// PlaygroundCanvasTemplateVisibilityPrivate is the default scope: only the
	// owner can list, read, edit and apply the template.
	PlaygroundCanvasTemplateVisibilityPrivate = "private"
	// PlaygroundCanvasTemplateVisibilityGlobal marks an official or
	// administrator-published template offered to every account. Global rows
	// have no owner (user_id 0) and never consume an account's private budget.
	PlaygroundCanvasTemplateVisibilityGlobal = "global"
)

// playgroundCanvasTemplateListMaxCount bounds one listing independently of the
// configured per-account limit, so an extremely high policy value cannot turn
// the list endpoint into an unbounded response. The response reports the stored
// total so a truncated page is still visible.
const playgroundCanvasTemplateListMaxCount = 200

// PlaygroundCanvasTemplate is a reusable, structure-level canvas definition: a
// display name and description, the nodes and edges with their model and
// generation parameters, and (optionally) the bytes of the attachments the
// nodes reference. Templates never carry credentials, provider addresses or
// volatile workflow run state; applying one only lays out nodes and re-uploads
// the inline assets into the target canvas.
//
// A global template is platform content instead of an account resource: it has
// user_id 0, is excluded from every per-account listing and counter, and is
// maintained by an administrator. Official templates additionally carry a
// non-empty SystemKey so the startup seed can create each one exactly once.
type PlaygroundCanvasTemplate struct {
	ID          string   `json:"id" gorm:"size:32;primaryKey"`
	UserID      int      `json:"user_id" gorm:"not null;index"`
	Name        string   `json:"name" gorm:"size:100;not null"`
	Description LongText `json:"-" gorm:"not null"`
	// Category groups the administrator's catalogue; the official seeds use it
	// to label their workflow family. It is display-only.
	Category string `json:"category" gorm:"size:32"`
	// Visibility is the private/global scope. The column stays nullable so an
	// existing installation can add it on every supported database; a NULL or
	// unknown value reads back as private, which is the pre-template behavior.
	Visibility string `json:"-" gorm:"size:16;index"`
	// SystemKey identifies one official seed. The startup seed skips a key it
	// has already written, including a soft-deleted row, so deleting an
	// official template is permanent instead of resurrecting it on restart.
	SystemKey string `json:"-" gorm:"size:64;index"`
	// InlineAssets records whether the template carries attachment bytes. A
	// structure-only template drops every resource reference so it stays
	// portable; an inline template snapshots the bytes once and re-uploads them
	// on apply.
	InlineAssets  bool     `json:"inline_assets" gorm:"not null;default:false"`
	Document      LongText `json:"-" gorm:"not null"`
	DocumentBytes int64    `json:"document_bytes" gorm:"not null"`
	NodeCount     int      `json:"node_count" gorm:"not null"`
	EdgeCount     int      `json:"edge_count" gorm:"not null"`
	AssetCount    int      `json:"asset_count" gorm:"not null;default:0"`
	AssetBytes    int64    `json:"asset_bytes" gorm:"not null;default:0"`
	// DeletedAt is the delete tombstone. Private deletes release the account
	// counters immediately; the row stays so its SystemKey (when present) is
	// never seeded again.
	DeletedAt int64 `json:"-" gorm:"not null;default:0;index"`
	CreatedAt int64 `json:"created_at" gorm:"not null;index"`
	UpdatedAt int64 `json:"updated_at" gorm:"not null;index"`
}

// PlaygroundCanvasTemplateAsset is one attachment byte snapshot of a template.
// The bytes are base64 in LongText so the same row works on SQLite, MySQL and
// PostgreSQL without an object-store dependency; the metadata mirrors the
// attachment contract (filename, media type, size and SHA-256) so an export can
// be verified before it is imported again.
type PlaygroundCanvasTemplateAsset struct {
	ID          string   `json:"id" gorm:"size:32;primaryKey"`
	TemplateID  string   `json:"template_id" gorm:"size:32;not null;index"`
	Filename    string   `json:"filename" gorm:"size:255;not null"`
	MediaType   string   `json:"media_type" gorm:"size:128;not null"`
	ByteSize    int64    `json:"byte_size" gorm:"not null"`
	ContentHash string   `json:"content_hash" gorm:"size:64;not null"`
	Data        LongText `json:"-" gorm:"not null"`
	CreatedAt   int64    `json:"created_at" gorm:"not null"`
}

// PlaygroundCanvasTemplateSummary is the list/detail metadata of a template.
// The document is only returned by the detail endpoint, so a workspace with
// large inline assets does not transfer every byte just to render the library.
type PlaygroundCanvasTemplateSummary struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	Category      string `json:"category"`
	Visibility    string `json:"visibility"`
	InlineAssets  bool   `json:"inline_assets"`
	NodeCount     int    `json:"node_count"`
	EdgeCount     int    `json:"edge_count"`
	DocumentBytes int64  `json:"document_bytes"`
	AssetCount    int    `json:"asset_count"`
	AssetBytes    int64  `json:"asset_bytes"`
	CreatedAt     int64  `json:"created_at"`
	UpdatedAt     int64  `json:"updated_at"`
}

// PlaygroundCanvasTemplateResult is one template with its document and asset
// metadata, but without the base64 asset bytes.
type PlaygroundCanvasTemplateResult struct {
	PlaygroundCanvasTemplateSummary
	Document string                          `json:"document"`
	Assets   []PlaygroundCanvasTemplateAsset `json:"assets"`
}

// PlaygroundCanvasTemplateVisibility normalizes a stored visibility value.
// Rows created before the visibility column existed have no value and remain
// private.
func PlaygroundCanvasTemplateVisibility(value string) string {
	if value == PlaygroundCanvasTemplateVisibilityGlobal {
		return PlaygroundCanvasTemplateVisibilityGlobal
	}
	return PlaygroundCanvasTemplateVisibilityPrivate
}

// CreatePlaygroundCanvasTemplate stores a new private template for the account.
// The account counter row is locked first so concurrent creates cannot both
// slip past the per-account template budget, and the document plus inline asset
// bytes are charged to the template byte budget before the rows are written.
func CreatePlaygroundCanvasTemplate(userID int, template *PlaygroundCanvasTemplate, assets []PlaygroundCanvasTemplateAsset, policy playground_setting.PlaygroundQuotaPolicy) error {
	if userID <= 0 || template == nil {
		return ErrPlaygroundCanvasTemplateInvalid
	}
	size := playgroundCanvasTemplateSize(template, assets)
	if size > policy.CanvasTemplateMaxBytes {
		return ErrPlaygroundCanvasTemplateLimit
	}
	template.Visibility = PlaygroundCanvasTemplateVisibilityPrivate
	template.SystemKey = ""
	template.DeletedAt = 0
	return DB.Transaction(func(tx *gorm.DB) error {
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if usage.CanvasTemplateCount >= int64(policy.CanvasTemplateUserMaxCount) {
			return ErrPlaygroundCanvasTemplateLimit
		}
		if usage.CanvasTemplateBytes+size > policy.CanvasTemplateUserMaxBytes {
			return ErrPlaygroundCanvasTemplateLimit
		}
		if err := createPlaygroundCanvasTemplateRow(tx, userID, template, assets); err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{CanvasTemplateCount: 1, CanvasTemplateBytes: size})
		return savePlaygroundUserUsage(tx, usage)
	})
}

// CreateGlobalPlaygroundCanvasTemplate stores one market template. Global
// templates are platform content: they have no owner and do not touch any
// account counter. The market size is bounded so the listing never silently
// truncates.
func CreateGlobalPlaygroundCanvasTemplate(template *PlaygroundCanvasTemplate, assets []PlaygroundCanvasTemplateAsset, policy playground_setting.PlaygroundQuotaPolicy) error {
	if template == nil {
		return ErrPlaygroundCanvasTemplateInvalid
	}
	if playgroundCanvasTemplateSize(template, assets) > policy.CanvasTemplateMaxBytes {
		return ErrPlaygroundCanvasTemplateLimit
	}
	template.Visibility = PlaygroundCanvasTemplateVisibilityGlobal
	template.DeletedAt = 0
	return DB.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&PlaygroundCanvasTemplate{}).
			Where("visibility = ? AND deleted_at = 0", PlaygroundCanvasTemplateVisibilityGlobal).
			Count(&count).Error; err != nil {
			return err
		}
		if count >= playgroundCanvasTemplateListMaxCount {
			return ErrPlaygroundCanvasTemplateLimit
		}
		return createPlaygroundCanvasTemplateRow(tx, 0, template, assets)
	})
}

// createPlaygroundCanvasTemplateRow writes one template and its asset rows
// without touching an account counter. Global templates use it directly;
// private templates reach it inside the locked create transaction.
func createPlaygroundCanvasTemplateRow(tx *gorm.DB, userID int, template *PlaygroundCanvasTemplate, assets []PlaygroundCanvasTemplateAsset) error {
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return err
	}
	now := common.GetTimestamp()
	if template.ID == "" {
		template.ID = "pgct_" + key
	}
	template.UserID = userID
	template.CreatedAt = now
	template.UpdatedAt = now
	template.AssetCount = len(assets)
	template.AssetBytes = 0
	for index := range assets {
		if assets[index].ID == "" {
			assetKey, err := common.GenerateRandomCharsKey(24)
			if err != nil {
				return err
			}
			assets[index].ID = "pgta_" + assetKey
		}
		assets[index].TemplateID = template.ID
		assets[index].CreatedAt = now
		template.AssetBytes += assets[index].ByteSize
	}
	if err := tx.Create(template).Error; err != nil {
		return err
	}
	if len(assets) == 0 {
		return nil
	}
	return tx.Create(&assets).Error
}

// playgroundCanvasTemplateSize is the account-visible size of one template:
// the stored document plus the raw (decoded) inline asset bytes.
func playgroundCanvasTemplateSize(template *PlaygroundCanvasTemplate, assets []PlaygroundCanvasTemplateAsset) int64 {
	size := template.DocumentBytes
	for index := range assets {
		size += assets[index].ByteSize
	}
	return size
}

func GetPlaygroundCanvasTemplate(userID int, id string) (*PlaygroundCanvasTemplate, error) {
	if userID <= 0 || id == "" {
		return nil, ErrPlaygroundCanvasTemplateNotFound
	}
	var template PlaygroundCanvasTemplate
	err := DB.Where("id = ? AND user_id = ? AND deleted_at = 0 AND (visibility IS NULL OR visibility <> ?)", id, userID, PlaygroundCanvasTemplateVisibilityGlobal).First(&template).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundCanvasTemplateNotFound
	}
	if err != nil {
		return nil, err
	}
	return &template, nil
}

// GetGlobalPlaygroundCanvasTemplate loads one market template regardless of who
// created it. Only live rows explicitly marked global are visible here.
func GetGlobalPlaygroundCanvasTemplate(id string) (*PlaygroundCanvasTemplate, error) {
	if id == "" {
		return nil, ErrPlaygroundCanvasTemplateNotFound
	}
	var template PlaygroundCanvasTemplate
	err := DB.Where("id = ? AND visibility = ? AND deleted_at = 0", id, PlaygroundCanvasTemplateVisibilityGlobal).First(&template).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundCanvasTemplateNotFound
	}
	if err != nil {
		return nil, err
	}
	return &template, nil
}

// ListPlaygroundCanvasTemplates returns the owner's private templates, newest
// first, together with the stored total. Global templates have no owner and
// never appear in an account list.
func ListPlaygroundCanvasTemplates(userID int, maxCount int) ([]PlaygroundCanvasTemplate, int64, error) {
	if userID <= 0 {
		return nil, 0, ErrPlaygroundCanvasTemplateNotFound
	}
	return listPlaygroundCanvasTemplates(DB.Where("user_id = ? AND deleted_at = 0 AND (visibility IS NULL OR visibility <> ?)", userID, PlaygroundCanvasTemplateVisibilityGlobal), maxCount)
}

// ListGlobalPlaygroundCanvasTemplates returns the market templates, newest
// first.
func ListGlobalPlaygroundCanvasTemplates(maxCount int) ([]PlaygroundCanvasTemplate, int64, error) {
	return listPlaygroundCanvasTemplates(DB.Where("visibility = ? AND deleted_at = 0", PlaygroundCanvasTemplateVisibilityGlobal), maxCount)
}

func listPlaygroundCanvasTemplates(query *gorm.DB, maxCount int) ([]PlaygroundCanvasTemplate, int64, error) {
	if maxCount <= 0 || maxCount > playgroundCanvasTemplateListMaxCount {
		maxCount = playgroundCanvasTemplateListMaxCount
	}
	templates := make([]PlaygroundCanvasTemplate, 0)
	var count int64
	if err := query.Model(&PlaygroundCanvasTemplate{}).Count(&count).Error; err != nil {
		return nil, 0, err
	}
	err := query.Order("updated_at DESC, id DESC").Limit(maxCount).Find(&templates).Error
	return templates, count, err
}

// ListPlaygroundCanvasTemplateAssets returns the asset metadata and bytes of
// one template, ordered by id so a copy or export is deterministic.
func ListPlaygroundCanvasTemplateAssets(templateID string) ([]PlaygroundCanvasTemplateAsset, error) {
	if templateID == "" {
		return nil, ErrPlaygroundCanvasTemplateNotFound
	}
	assets := make([]PlaygroundCanvasTemplateAsset, 0)
	err := DB.Where("template_id = ?", templateID).Order("id ASC").Find(&assets).Error
	return assets, err
}

// UpdatePlaygroundCanvasTemplate applies the validated display-field updates of
// one owned private template and returns the stored row.
func UpdatePlaygroundCanvasTemplate(userID int, id string, updates map[string]any) (*PlaygroundCanvasTemplate, error) {
	if userID <= 0 || id == "" || len(updates) == 0 {
		return nil, ErrPlaygroundCanvasTemplateNotFound
	}
	var template PlaygroundCanvasTemplate
	err := DB.Transaction(func(tx *gorm.DB) error {
		owned := tx.Where("id = ? AND user_id = ? AND deleted_at = 0 AND (visibility IS NULL OR visibility <> ?)", id, userID, PlaygroundCanvasTemplateVisibilityGlobal)
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND deleted_at = 0 AND (visibility IS NULL OR visibility <> ?)", id, userID, PlaygroundCanvasTemplateVisibilityGlobal).First(&template).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundCanvasTemplateNotFound
			}
			return err
		}
		updates["updated_at"] = common.GetTimestamp()
		if err := owned.Updates(updates).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).First(&template).Error
	})
	if err != nil {
		return nil, err
	}
	return &template, nil
}

// UpdateGlobalPlaygroundCanvasTemplate applies field updates to one market
// template. The visibility column is never part of the update, so a global
// template cannot be demoted into an ownerless private row.
func UpdateGlobalPlaygroundCanvasTemplate(id string, updates map[string]any) (*PlaygroundCanvasTemplate, error) {
	if id == "" || len(updates) == 0 {
		return nil, ErrPlaygroundCanvasTemplateNotFound
	}
	var template PlaygroundCanvasTemplate
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND visibility = ? AND deleted_at = 0", id, PlaygroundCanvasTemplateVisibilityGlobal).First(&template).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundCanvasTemplateNotFound
			}
			return err
		}
		updates["updated_at"] = common.GetTimestamp()
		if err := tx.Model(&PlaygroundCanvasTemplate{}).Where("id = ? AND visibility = ?", id, PlaygroundCanvasTemplateVisibilityGlobal).Updates(updates).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND visibility = ?", id, PlaygroundCanvasTemplateVisibilityGlobal).First(&template).Error
	})
	if err != nil {
		return nil, err
	}
	return &template, nil
}

// DeletePlaygroundCanvasTemplate soft-deletes one owned private template,
// removes its asset rows and returns the charged bytes to the account budget.
func DeletePlaygroundCanvasTemplate(userID int, id string) error {
	if userID <= 0 || id == "" {
		return ErrPlaygroundCanvasTemplateNotFound
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var template PlaygroundCanvasTemplate
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND deleted_at = 0 AND (visibility IS NULL OR visibility <> ?)", id, userID, PlaygroundCanvasTemplateVisibilityGlobal).First(&template).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundCanvasTemplateNotFound
			}
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if err := tx.Where("template_id = ?", template.ID).Delete(&PlaygroundCanvasTemplateAsset{}).Error; err != nil {
			return err
		}
		if err := tx.Model(&PlaygroundCanvasTemplate{}).Where("id = ? AND user_id = ?", template.ID, userID).
			Update("deleted_at", common.GetTimestamp()).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{
			CanvasTemplateCount: -1,
			CanvasTemplateBytes: -(template.DocumentBytes + template.AssetBytes),
		})
		return savePlaygroundUserUsage(tx, usage)
	})
}

// DeleteGlobalPlaygroundCanvasTemplate soft-deletes one market template. Its
// SystemKey stays recorded, so an official template the administrator removed
// is not seeded again at the next startup.
func DeleteGlobalPlaygroundCanvasTemplate(id string) error {
	if id == "" {
		return ErrPlaygroundCanvasTemplateNotFound
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var template PlaygroundCanvasTemplate
		if err := lockForUpdate(tx).Where("id = ? AND visibility = ? AND deleted_at = 0", id, PlaygroundCanvasTemplateVisibilityGlobal).First(&template).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundCanvasTemplateNotFound
			}
			return err
		}
		if err := tx.Where("template_id = ?", template.ID).Delete(&PlaygroundCanvasTemplateAsset{}).Error; err != nil {
			return err
		}
		return tx.Model(&PlaygroundCanvasTemplate{}).Where("id = ? AND visibility = ?", template.ID, PlaygroundCanvasTemplateVisibilityGlobal).
			Update("deleted_at", common.GetTimestamp()).Error
	})
}
