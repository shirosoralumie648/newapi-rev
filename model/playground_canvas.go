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
	ErrPlaygroundCanvasNotFound  = errors.New("Playground canvas project not found.")
	ErrPlaygroundCanvasInvalid   = errors.New("Invalid Playground canvas project.")
	ErrPlaygroundCanvasLimit     = errors.New("Playground canvas storage limit exceeded.")
	ErrPlaygroundCanvasReference = errors.New("Playground canvas references a resource that is not available to this account.")
)

// PlaygroundCanvasReference identifies one external resource a canvas node
// points at by ID. Empty fields are ignored; a message key always requires its
// session so a cross-user message cannot be reached through an orphan key.
type PlaygroundCanvasReference struct {
	SessionID    string
	MessageKey   string
	AttachmentID string
	ArtifactID   string
}

// resolvePlaygroundCanvasReference classifies one reference for an account.
//
// A resource that no longer exists is not an ownership violation: the node
// keeps its stored snapshot and is rendered as "source deleted". A resource
// that exists under a different account is foreign, and the caller rejects the
// document without ever reading the other account's content. Availability is
// true only while every resource the reference names still resolves.
//
// An attachment is intentionally resolved by its own row: a canvas pin keeps
// the bytes alive independently of the conversation, so the session row may
// already be gone while the attachment is still served to its owner.
func resolvePlaygroundCanvasReference(userID int, reference PlaygroundCanvasReference) (available bool, foreign bool, err error) {
	if reference.MessageKey != "" && reference.SessionID == "" {
		return false, true, nil
	}
	sessionOwned := false
	if reference.SessionID != "" {
		var session PlaygroundSession
		if err := DB.Select("id, user_id").Where("id = ?", reference.SessionID).First(&session).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return false, false, err
			}
		} else if session.UserID != userID {
			return false, true, nil
		} else {
			sessionOwned = true
		}
	}
	// Session-scoped references require their session to resolve; an
	// attachment-only reference is resolved by its own row below, because a
	// canvas pin can outlive the conversation.
	sessionRequired := reference.MessageKey != "" || reference.ArtifactID != "" || reference.AttachmentID == ""
	available = !(reference.SessionID != "" && sessionRequired && !sessionOwned)
	if reference.MessageKey != "" {
		var message PlaygroundMessage
		err := DB.Select("id").Where("user_id = ? AND session_id = ? AND client_key = ?", userID, reference.SessionID, reference.MessageKey).First(&message).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			available = false
		} else if err != nil {
			return false, false, err
		}
	}
	if reference.AttachmentID != "" {
		var attachment PlaygroundAttachment
		err := DB.Select("id, user_id, session_id").Where("id = ?", reference.AttachmentID).First(&attachment).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			available = false
		case err != nil:
			return false, false, err
		case attachment.UserID != userID:
			return false, true, nil
		case reference.SessionID != "" && attachment.SessionID != reference.SessionID:
			available = false
		}
	}
	if reference.ArtifactID != "" {
		var artifact PlaygroundArtifact
		err := DB.Select("id, user_id, session_id, deleted_at").Where("id = ?", reference.ArtifactID).First(&artifact).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			available = false
		case err != nil:
			return false, false, err
		case artifact.UserID != userID:
			return false, true, nil
		case artifact.DeletedAt != 0:
			available = false
		case reference.SessionID != "" && artifact.SessionID != reference.SessionID:
			available = false
		}
	}
	return available, false, nil
}

// ValidatePlaygroundCanvasReferences rejects a document that references a
// session, message, attachment or artifact owned by another account. A
// reference whose resource was deleted is accepted so the canvas stays
// editable; the read path reports it as "source deleted". It never reads
// attachment or artifact bodies; the canvas stores references only, and the
// bytes stay behind the controlled content endpoints.
func ValidatePlaygroundCanvasReferences(userID int, references []PlaygroundCanvasReference) error {
	if userID <= 0 {
		return ErrPlaygroundCanvasInvalid
	}
	for _, reference := range references {
		_, foreign, err := resolvePlaygroundCanvasReference(userID, reference)
		if err != nil {
			return err
		}
		if foreign {
			return ErrPlaygroundCanvasReference
		}
	}
	return nil
}

// PlaygroundCanvasReferenceAvailability reports, for each reference, whether it
// still resolves for the account. The canvas read path uses it to mark nodes
// whose source was deleted without rewriting the stored document.
func PlaygroundCanvasReferenceAvailability(userID int, references []PlaygroundCanvasReference) ([]bool, error) {
	available := make([]bool, len(references))
	if userID <= 0 {
		return available, ErrPlaygroundCanvasInvalid
	}
	for index, reference := range references {
		found, foreign, err := resolvePlaygroundCanvasReference(userID, reference)
		if err != nil {
			return nil, err
		}
		available[index] = found && !foreign
	}
	return available, nil
}

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

// CreatePlaygroundCanvasProject stores a new canvas. attachmentIDs are the
// attachments its nodes reference; they are pinned in the same transaction so
// deleting the uploading message cannot orphan a canvas image.
func CreatePlaygroundCanvasProject(userID int, project *PlaygroundCanvasProject, attachmentIDs []string) (*PlaygroundCanvasProject, bool, error) {
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
		if err := syncPlaygroundCanvasAssets(tx, userID, project.ID, attachmentIDs); err != nil {
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
	// AttachmentIDs are the attachments the replacement document references.
	// They replace the canvas pins only when a document is written.
	AttachmentIDs []string
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
		if input.Document != nil {
			if err := syncPlaygroundCanvasAssets(tx, userID, id, input.AttachmentIDs); err != nil {
				return err
			}
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
		// Deleting the canvas releases every attachment pin it held, so the
		// orphan cleanup can collect images this board was the last user of.
		if err := tx.Where("canvas_id = ? AND user_id = ?", id, userID).Delete(&PlaygroundCanvasAsset{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundCanvasProject{}).Error
	})
}

// PlaygroundCanvasAsset pins one attachment while at least one canvas node
// references it. Attachments have no ownership column for canvases, so this row
// is what keeps a referenced image alive after the uploading message is
// removed; deleting the canvas, or saving a document that no longer references
// the attachment, returns the bytes to the orphan cleanup countdown.
type PlaygroundCanvasAsset struct {
	CanvasID     string `gorm:"size:32;primaryKey"`
	AttachmentID string `gorm:"size:32;primaryKey"`
	UserID       int    `gorm:"not null;index"`
	CreatedAt    int64  `gorm:"not null"`
}

// syncPlaygroundCanvasAssets replaces the attachment pins of one canvas. It runs
// inside the canvas write transaction so a concurrent save cannot leave a pin
// for a document that was never stored.
func syncPlaygroundCanvasAssets(tx *gorm.DB, userID int, canvasID string, attachmentIDs []string) error {
	if err := tx.Where("canvas_id = ? AND user_id = ?", canvasID, userID).Delete(&PlaygroundCanvasAsset{}).Error; err != nil {
		return err
	}
	seen := make(map[string]bool, len(attachmentIDs))
	rows := make([]PlaygroundCanvasAsset, 0, len(attachmentIDs))
	now := common.GetTimestamp()
	for _, attachmentID := range attachmentIDs {
		if attachmentID == "" || seen[attachmentID] {
			continue
		}
		seen[attachmentID] = true
		rows = append(rows, PlaygroundCanvasAsset{CanvasID: canvasID, AttachmentID: attachmentID, UserID: userID, CreatedAt: now})
	}
	if len(rows) == 0 {
		return nil
	}
	return tx.Create(&rows).Error
}
