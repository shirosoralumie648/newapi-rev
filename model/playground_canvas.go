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
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

const (
	// PlaygroundCanvasDocumentMaxBytes bounds one serialized canvas document.
	PlaygroundCanvasDocumentMaxBytes = 1 << 20
	// PlaygroundCanvasMaxNodes and PlaygroundCanvasMaxEdges bound one document.
	PlaygroundCanvasMaxNodes = 200
	PlaygroundCanvasMaxEdges = 400
)

// The project count and byte budgets are variables so tests can exercise the
// boundaries without storing full-size documents; administrator quota
// configuration can replace them later.
var (
	// PlaygroundCanvasMaxProjects bounds the projects one account can keep.
	PlaygroundCanvasMaxProjects = 20
	// PlaygroundCanvasUserMaxBytes bounds the total stored canvas documents per account.
	PlaygroundCanvasUserMaxBytes int64 = 16 << 20
)

var (
	ErrPlaygroundCanvasNotFound = errors.New("Playground canvas project not found.")
	ErrPlaygroundCanvasInvalid  = errors.New("Invalid Playground canvas project.")
	ErrPlaygroundCanvasLimit    = errors.New("Playground canvas storage limit exceeded.")
)

// PlaygroundCanvasProject stores one canvas document (nodes, edges, viewport)
// as a versioned JSON snapshot. The document references conversations,
// artifacts and attachments by ID; those references never own the rows.
type PlaygroundCanvasProject struct {
	ID       string   `gorm:"size:32;primaryKey"`
	UserID   int      `gorm:"not null;index;uniqueIndex:uk_playground_canvas_client,priority:1"`
	ClientID *string  `gorm:"size:128;uniqueIndex:uk_playground_canvas_client,priority:2"`
	Title    string   `gorm:"size:200;not null"`
	Document LongText `gorm:"not null"`
	// DocumentBytes and the node/edge counters let list views and quota sums
	// avoid parsing every stored document.
	DocumentBytes int64 `gorm:"not null"`
	NodeCount     int   `gorm:"not null"`
	EdgeCount     int   `gorm:"not null"`
	Revision      int64 `gorm:"not null"`
	CreatedAt     int64 `gorm:"not null;index"`
	UpdatedAt     int64 `gorm:"not null;index"`
}

type PlaygroundCanvasSummary struct {
	ID            string  `json:"id"`
	ClientID      *string `json:"client_id,omitempty"`
	Title         string  `json:"title"`
	NodeCount     int     `json:"node_count"`
	EdgeCount     int     `json:"edge_count"`
	DocumentBytes int64   `json:"document_bytes"`
	Revision      int64   `json:"revision"`
	CreatedAt     int64   `json:"created_at"`
	UpdatedAt     int64   `json:"updated_at"`
}

type PlaygroundCanvasResult struct {
	PlaygroundCanvasSummary
	Document string `json:"document"`
}

func playgroundCanvasSummary(project *PlaygroundCanvasProject) PlaygroundCanvasSummary {
	return PlaygroundCanvasSummary{
		ID: project.ID, ClientID: project.ClientID, Title: project.Title,
		NodeCount: project.NodeCount, EdgeCount: project.EdgeCount,
		DocumentBytes: project.DocumentBytes, Revision: project.Revision,
		CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt,
	}
}

func playgroundCanvasResult(project *PlaygroundCanvasProject) *PlaygroundCanvasResult {
	return &PlaygroundCanvasResult{
		PlaygroundCanvasSummary: playgroundCanvasSummary(project),
		Document:                string(project.Document),
	}
}

// FindPlaygroundCanvasProjectByClientID resolves the idempotent create key.
func FindPlaygroundCanvasProjectByClientID(userID int, clientID string) (*PlaygroundCanvasProject, error) {
	if strings.TrimSpace(clientID) == "" {
		return nil, ErrPlaygroundCanvasNotFound
	}
	var project PlaygroundCanvasProject
	if err := DB.Where("user_id = ? AND client_id = ?", userID, clientID).First(&project).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlaygroundCanvasNotFound
		}
		return nil, err
	}
	return &project, nil
}

func CreatePlaygroundCanvasProject(userID int, project *PlaygroundCanvasProject) (*PlaygroundCanvasProject, bool, error) {
	if userID <= 0 || project == nil {
		return nil, false, ErrPlaygroundCanvasInvalid
	}
	if project.ClientID != nil {
		existing, err := FindPlaygroundCanvasProjectByClientID(userID, *project.ClientID)
		if err == nil {
			return existing, false, nil
		}
		if !errors.Is(err, ErrPlaygroundCanvasNotFound) {
			return nil, false, err
		}
	}
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return nil, false, err
	}
	now := common.GetTimestamp()
	project.ID = "pgc_" + key
	project.UserID = userID
	project.Revision = 0
	project.CreatedAt = now
	project.UpdatedAt = now
	if project.Title == "" {
		project.Title = "New canvas"
	}
	created := false
	err = DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).Select("id").Where("id = ?", userID).First(&user).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&PlaygroundCanvasProject{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
			return err
		}
		if count >= int64(PlaygroundCanvasMaxProjects) {
			return ErrPlaygroundCanvasLimit
		}
		var stored int64
		if err := tx.Model(&PlaygroundCanvasProject{}).Where("user_id = ?", userID).
			Select("COALESCE(SUM(document_bytes), 0)").Scan(&stored).Error; err != nil {
			return err
		}
		if stored+int64(len(project.Document)) > PlaygroundCanvasUserMaxBytes {
			return ErrPlaygroundCanvasLimit
		}
		if err := tx.Create(project).Error; err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		// A concurrent create with the same client ID may have won the unique index.
		if project.ClientID != nil {
			if existing, findErr := FindPlaygroundCanvasProjectByClientID(userID, *project.ClientID); findErr == nil {
				return existing, false, nil
			}
		}
		return nil, false, err
	}
	return project, created, nil
}

func GetPlaygroundCanvasProject(userID int, id string) (*PlaygroundCanvasProject, error) {
	var project PlaygroundCanvasProject
	err := DB.Where("id = ? AND user_id = ?", id, userID).First(&project).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundCanvasNotFound
	}
	if err != nil {
		return nil, err
	}
	return &project, nil
}

func ListPlaygroundCanvasProjects(userID int, offset, limit int) ([]PlaygroundCanvasProject, int64, error) {
	if offset < 0 || limit < 1 {
		return nil, 0, ErrPlaygroundCanvasInvalid
	}
	projects := make([]PlaygroundCanvasProject, 0)
	var count int64
	query := DB.Model(&PlaygroundCanvasProject{}).Where("user_id = ?", userID)
	if err := query.Count(&count).Error; err != nil {
		return nil, 0, err
	}
	err := query.Select("id, user_id, client_id, title, document_bytes, node_count, edge_count, revision, created_at, updated_at").
		Order("updated_at DESC, id DESC").Offset(offset).Limit(limit).Find(&projects).Error
	return projects, count, err
}

type UpdatePlaygroundCanvasInput struct {
	Title    *string
	Document *string
	// Counters describe the replacement document and are always required with it.
	NodeCount int
	EdgeCount int
}

func UpdatePlaygroundCanvasProject(userID int, id string, revision int64, input UpdatePlaygroundCanvasInput) (*PlaygroundCanvasProject, error) {
	if revision < 0 || (input.Document == nil && input.Title == nil) {
		return nil, ErrPlaygroundCanvasInvalid
	}
	var project PlaygroundCanvasProject
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&project).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundCanvasNotFound
			}
			return err
		}
		if project.Revision != revision {
			return ErrPlaygroundConflict
		}
		updates := map[string]any{"updated_at": common.GetTimestamp(), "revision": revision + 1}
		if input.Title != nil {
			updates["title"] = *input.Title
		}
		if input.Document != nil {
			size := int64(len(*input.Document))
			if size != project.DocumentBytes {
				var stored int64
				if err := tx.Model(&PlaygroundCanvasProject{}).Where("user_id = ? AND id <> ?", userID, id).
					Select("COALESCE(SUM(document_bytes), 0)").Scan(&stored).Error; err != nil {
					return err
				}
				if stored+size > PlaygroundCanvasUserMaxBytes {
					return ErrPlaygroundCanvasLimit
				}
			}
			updates["document"] = *input.Document
			updates["document_bytes"] = size
			updates["node_count"] = input.NodeCount
			updates["edge_count"] = input.EdgeCount
		}
		result := tx.Model(&PlaygroundCanvasProject{}).
			Where("id = ? AND user_id = ? AND revision = ?", id, userID, revision).Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrPlaygroundConflict
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).First(&project).Error
	})
	if err != nil {
		return nil, err
	}
	return &project, nil
}

func DeletePlaygroundCanvasProject(userID int, id string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var project PlaygroundCanvasProject
		err := lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&project).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundCanvasNotFound
		}
		if err != nil {
			return err
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundCanvasProject{}).Error
	})
}
