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
package controller

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

// A memory request carries the remembered text and its short category. The
// envelope adds room for the JSON around the content, whose own budget stays
// with the owner's policy.
const playgroundMemoryRequestMaxBytes = 4 << 10

// playgroundMemoryCategoryMaxLength bounds the display label, not the memory
// text. The categories are short machine-stable labels the client maps to
// localized names, so an overlong value is rejected instead of truncated.
const playgroundMemoryCategoryMaxLength = 50

type playgroundMemoryRequest struct {
	Content  *string `json:"content"`
	Category *string `json:"category"`
	// SourceSessionID distinguishes an absent field (keep the current source)
	// from an explicit null (clear it), which a *string cannot express.
	SourceSessionID json.RawMessage `json:"source_session_id"`
	Enabled         *bool           `json:"enabled"`
}

type playgroundMemoryResponse struct {
	ID              string  `json:"id"`
	Content         string  `json:"content"`
	Category        string  `json:"category"`
	SourceSessionID *string `json:"source_session_id"`
	Enabled         bool    `json:"enabled"`
	CreatedAt       int64   `json:"created_at"`
	UpdatedAt       int64   `json:"updated_at"`
}

// validatePlaygroundMemoryContent bounds the remembered text. The text is
// model context, not user interface copy, so only its presence, size and the
// NUL byte PostgreSQL rejects are checked; the outer whitespace is trimmed so a
// pasted note does not carry an invisible block into every request.
func validatePlaygroundMemoryContent(content *string, maxBytes int64) (string, error) {
	if content == nil || strings.TrimSpace(*content) == "" {
		return "", common.NewMessage("Playground memory content must not be empty.")
	}
	value := strings.TrimSpace(*content)
	if int64(len(value)) > maxBytes {
		return "", model.ErrPlaygroundMemoryContentLimit
	}
	if strings.ContainsRune(value, 0) {
		return "", common.NewMessage("Invalid Playground memory.")
	}
	return value, nil
}

// validatePlaygroundMemoryCategory normalizes the short category label. An
// empty category is allowed and stored as an empty string; the client then
// renders its general label.
func validatePlaygroundMemoryCategory(category *string) (string, error) {
	if category == nil {
		return "", nil
	}
	value := strings.TrimSpace(*category)
	if utf8.RuneCountInString(value) > playgroundMemoryCategoryMaxLength {
		return "", common.NewMessage("Playground memory category must contain at most 50 characters.")
	}
	if strings.ContainsRune(value, 0) {
		return "", common.NewMessage("Invalid Playground memory.")
	}
	return value, nil
}

// decodePlaygroundMemorySource returns the source conversation of a request.
// The present flag tells the update path whether the field appeared at all;
// value is nil both for an absent field and for an explicit null.
func decodePlaygroundMemorySource(raw json.RawMessage) (value *string, present bool, err error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil, true, nil
	}
	var sessionID string
	if err := common.Unmarshal(raw, &sessionID); err != nil {
		return nil, true, common.NewMessage("Invalid Playground memory.")
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || len(sessionID) > 128 || strings.ContainsRune(sessionID, 0) {
		return nil, true, common.NewMessage("Invalid Playground memory.")
	}
	return &sessionID, true, nil
}

func playgroundDecodeMemory(memory *model.PlaygroundMemory) playgroundMemoryResponse {
	return playgroundMemoryResponse{
		ID: memory.ID, Content: string(memory.Content), Category: memory.Category,
		SourceSessionID: memory.SourceSessionID, Enabled: memory.Enabled,
		CreatedAt: memory.CreatedAt, UpdatedAt: memory.UpdatedAt,
	}
}

func GetPlaygroundMemory(c *gin.Context) {
	memory, err := model.GetPlaygroundMemory(c.GetInt("id"), c.Param("memoryId"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeMemory(memory))
}

func ListPlaygroundMemories(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	memories, total, err := model.ListPlaygroundMemories(c.GetInt("id"), policy.MemoryUserMaxCount)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	items := make([]playgroundMemoryResponse, 0, len(memories))
	for index := range memories {
		items = append(items, playgroundDecodeMemory(&memories[index]))
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": total, "limit": policy.MemoryUserMaxCount})
}

func CreatePlaygroundMemory(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundMemoryRequest
	if !decodePlaygroundRequest(c, &request, policy.MemoryContentMaxBytes+playgroundMemoryRequestMaxBytes) {
		return
	}
	content, err := validatePlaygroundMemoryContent(request.Content, policy.MemoryContentMaxBytes)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	category, err := validatePlaygroundMemoryCategory(request.Category)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	source, _, err := decodePlaygroundMemorySource(request.SourceSessionID)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	enabled := true
	if request.Enabled != nil {
		enabled = *request.Enabled
	}
	memory := &model.PlaygroundMemory{Content: model.LongText(content), Category: category, SourceSessionID: source, Enabled: enabled}
	if err := model.CreatePlaygroundMemory(c.GetInt("id"), memory); err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeMemory(memory))
}

func UpdatePlaygroundMemory(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundMemoryRequest
	if !decodePlaygroundRequest(c, &request, policy.MemoryContentMaxBytes+playgroundMemoryRequestMaxBytes) {
		return
	}
	source, sourcePresent, err := decodePlaygroundMemorySource(request.SourceSessionID)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	if request.Content == nil && request.Category == nil && !sourcePresent && request.Enabled == nil {
		writePlaygroundError(c, common.NewMessage("Invalid Playground memory."))
		return
	}
	updates := map[string]any{}
	if request.Content != nil {
		content, err := validatePlaygroundMemoryContent(request.Content, policy.MemoryContentMaxBytes)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		updates["content"] = content
	}
	if request.Category != nil {
		category, err := validatePlaygroundMemoryCategory(request.Category)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		updates["category"] = category
	}
	if sourcePresent {
		updates["source_session_id"] = source
	}
	if request.Enabled != nil {
		updates["enabled"] = *request.Enabled
	}
	memory, err := model.UpdatePlaygroundMemory(c.GetInt("id"), c.Param("memoryId"), updates)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeMemory(memory))
}

func DeletePlaygroundMemory(c *gin.Context) {
	if err := model.DeletePlaygroundMemory(c.GetInt("id"), c.Param("memoryId")); err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("memoryId")})
}
