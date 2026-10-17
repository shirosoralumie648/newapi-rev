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
	"unicode/utf8"
)

const (
	playgroundAssetKindAttachment = "attachment"
	playgroundAssetKindArtifact   = "artifact"
	playgroundAssetSearchMaxRunes = 100
)

// Errors returned by the asset library read path. They all mean the request
// itself is malformed, never that a resource is missing: the library lists one
// owner's own rows, so a missing page is simply empty.
var ErrPlaygroundAssetInvalid = errors.New("Invalid Playground asset query.")

// PlaygroundAssetItem is one entry of the asset library. It carries metadata
// only: attachment bytes and artifact bodies are never embedded, and the
// generation results (tasks) are listed through the owner-scoped task
// endpoints instead.
type PlaygroundAssetItem struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	Title     string `json:"title"`
	// MediaType is set for attachments; Language for artifacts.
	MediaType string `json:"media_type,omitempty"`
	Language  string `json:"language,omitempty"`
	ByteSize  int64  `json:"byte_size,omitempty"`
	// Revision is the artifact revision. It is the expected revision for
	// deleting the artifact from the library.
	Revision int64 `json:"revision,omitempty"`
	// InUse reports that the server refuses to delete the asset: an
	// attachment referenced by a message or pinned by a canvas.
	InUse     bool  `json:"in_use"`
	CreatedAt int64 `json:"created_at"`
	UpdatedAt int64 `json:"updated_at"`
}

func isPlaygroundAssetKind(kind string) bool {
	return kind == playgroundAssetKindAttachment || kind == playgroundAssetKindArtifact
}

// ListPlaygroundAssets returns one page of the owner's attachments or
// artifacts, most recent first. Attribution is enforced by the user_id scope
// on every query, so a caller can never enumerate another account's rows.
func ListPlaygroundAssets(userID int, kind, search string, offset, limit int) ([]PlaygroundAssetItem, int64, error) {
	if userID <= 0 || !isPlaygroundAssetKind(kind) || offset < 0 || limit < 1 || limit > 50 {
		return nil, 0, ErrPlaygroundAssetInvalid
	}
	search = strings.TrimSpace(search)
	if utf8.RuneCountInString(search) > playgroundAssetSearchMaxRunes || !utf8.ValidString(search) || strings.ContainsRune(search, 0) {
		return nil, 0, ErrPlaygroundAssetInvalid
	}
	// The term is matched as a literal substring: LIKE metacharacters are
	// escaped so "100%" searches for that text instead of matching everything.
	pattern := ""
	if search != "" {
		pattern = "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(strings.ToLower(search)) + "%"
	}
	items := make([]PlaygroundAssetItem, 0)
	var total int64
	if kind == playgroundAssetKindAttachment {
		query := DB.Model(&PlaygroundAttachment{}).Where("user_id = ?", userID)
		if pattern != "" {
			query = query.Where("LOWER(filename) LIKE ? ESCAPE '!'", pattern)
		}
		if err := query.Count(&total).Error; err != nil {
			return nil, 0, err
		}
		var rows []PlaygroundAttachment
		if err := query.Select("id, session_id, filename, media_type, byte_size, referenced_at, created_at, updated_at").
			Order("created_at DESC, id DESC").Offset(offset).Limit(limit).Find(&rows).Error; err != nil {
			return nil, 0, err
		}
		pinned := map[string]bool{}
		if len(rows) > 0 {
			ids := make([]string, 0, len(rows))
			for i := range rows {
				ids = append(ids, rows[i].ID)
			}
			var pinnedIDs []string
			if err := DB.Model(&PlaygroundCanvasAsset{}).Where("user_id = ? AND attachment_id IN ?", userID, ids).
				Pluck("attachment_id", &pinnedIDs).Error; err != nil {
				return nil, 0, err
			}
			for _, id := range pinnedIDs {
				pinned[id] = true
			}
		}
		for i := range rows {
			row := &rows[i]
			items = append(items, PlaygroundAssetItem{
				Kind: playgroundAssetKindAttachment, ID: row.ID, SessionID: row.SessionID, Title: row.Filename,
				MediaType: row.MediaType, ByteSize: row.ByteSize,
				InUse:     row.ReferencedAt > 0 || pinned[row.ID],
				CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
			})
		}
		return items, total, nil
	}
	// Tombstoned artifacts keep only deduplication fields, so only live rows
	// are listable.
	query := DB.Model(&PlaygroundArtifact{}).Where("user_id = ? AND deleted_at = 0", userID)
	if pattern != "" {
		query = query.Where("LOWER(title) LIKE ? ESCAPE '!'", pattern)
	}
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []PlaygroundArtifact
	if err := query.Select("id, session_id, title, language, revision, created_at, updated_at").
		Order("updated_at DESC, id DESC").Offset(offset).Limit(limit).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	for i := range rows {
		row := &rows[i]
		items = append(items, PlaygroundAssetItem{
			Kind: playgroundAssetKindArtifact, ID: row.ID, SessionID: row.SessionID, Title: row.Title,
			Language: row.Language, Revision: row.Revision,
			CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		})
	}
	return items, total, nil
}
