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
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

// A snippet request carries a display name and the composer text it inserts.
// The envelope adds room for the JSON around the content, whose own budget
// stays with the owner's policy.
const playgroundSnippetRequestMaxBytes = 4 << 10

type playgroundSnippetRequest struct {
	Name    *string `json:"name"`
	Content *string `json:"content"`
}

type playgroundSnippetResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Content   string `json:"content"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// validatePlaygroundSnippetName normalizes the display name. A snippet is only
// discoverable by its name, so an empty or overlong value is rejected instead
// of truncated.
func validatePlaygroundSnippetName(name *string) (string, error) {
	if name == nil {
		return "", common.NewMessage("Prompt snippet name must contain 1 to 100 characters.")
	}
	value := strings.TrimSpace(*name)
	if value == "" || utf8.RuneCountInString(value) > 100 {
		return "", common.NewMessage("Prompt snippet name must contain 1 to 100 characters.")
	}
	if strings.ContainsRune(value, 0) {
		return "", common.NewMessage("Invalid prompt snippet.")
	}
	return value, nil
}

// validatePlaygroundSnippetContent bounds the inserted text. The text is
// model input, not user interface copy, so only its presence, size and the
// NUL byte PostgreSQL rejects are checked; the content is stored exactly as
// written.
func validatePlaygroundSnippetContent(content *string, maxBytes int64) (string, error) {
	if content == nil || strings.TrimSpace(*content) == "" {
		return "", common.NewMessage("Prompt snippet text must not be empty.")
	}
	value := *content
	if int64(len(value)) > maxBytes {
		return "", model.ErrPlaygroundSnippetContentLimit
	}
	if strings.ContainsRune(value, 0) {
		return "", common.NewMessage("Invalid prompt snippet.")
	}
	return value, nil
}

func playgroundDecodeSnippet(snippet *model.PlaygroundSnippet) playgroundSnippetResponse {
	return playgroundSnippetResponse{
		ID: snippet.ID, Name: snippet.Name, Content: string(snippet.Content),
		CreatedAt: snippet.CreatedAt, UpdatedAt: snippet.UpdatedAt,
	}
}

func GetPlaygroundSnippet(c *gin.Context) {
	snippet, err := model.GetPlaygroundSnippet(c.GetInt("id"), c.Param("snippetId"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeSnippet(snippet))
}

func ListPlaygroundSnippets(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	snippets, total, err := model.ListPlaygroundSnippets(c.GetInt("id"), policy.SnippetUserMaxCount)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	items := make([]playgroundSnippetResponse, 0, len(snippets))
	for index := range snippets {
		items = append(items, playgroundDecodeSnippet(&snippets[index]))
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": total, "limit": policy.SnippetUserMaxCount})
}

func CreatePlaygroundSnippet(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundSnippetRequest
	if !decodePlaygroundRequest(c, &request, policy.SnippetContentMaxBytes+playgroundSnippetRequestMaxBytes) {
		return
	}
	name, err := validatePlaygroundSnippetName(request.Name)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	content, err := validatePlaygroundSnippetContent(request.Content, policy.SnippetContentMaxBytes)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	snippet := &model.PlaygroundSnippet{Name: name, Content: model.LongText(content)}
	if err := model.CreatePlaygroundSnippet(c.GetInt("id"), snippet); err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeSnippet(snippet))
}

func UpdatePlaygroundSnippet(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundSnippetRequest
	if !decodePlaygroundRequest(c, &request, policy.SnippetContentMaxBytes+playgroundSnippetRequestMaxBytes) {
		return
	}
	if request.Name == nil && request.Content == nil {
		writePlaygroundError(c, common.NewMessage("Invalid prompt snippet."))
		return
	}
	updates := map[string]any{}
	if request.Name != nil {
		name, err := validatePlaygroundSnippetName(request.Name)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		updates["name"] = name
	}
	if request.Content != nil {
		content, err := validatePlaygroundSnippetContent(request.Content, policy.SnippetContentMaxBytes)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		updates["content"] = content
	}
	snippet, err := model.UpdatePlaygroundSnippet(c.GetInt("id"), c.Param("snippetId"), updates)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeSnippet(snippet))
}

func DeletePlaygroundSnippet(c *gin.Context) {
	if err := model.DeletePlaygroundSnippet(c.GetInt("id"), c.Param("snippetId")); err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("snippetId")})
}
