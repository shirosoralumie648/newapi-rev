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

const (
	// playgroundSnippetFileFormat and playgroundSnippetFileVersion identify the
	// prompt template import/export document, so an unrelated JSON file is
	// rejected before its fields reach the ordinary snippet validation.
	playgroundSnippetFileFormat  = "new-api-playground-prompt-template"
	playgroundSnippetFileVersion = 1
	// playgroundSnippetImportMaxVersions bounds one imported document
	// independently of the policy, so a hand-written file cannot make the
	// server hold an unbounded number of version rows in one request.
	playgroundSnippetImportMaxVersions = 200
)

type playgroundSnippetRequest struct {
	Name    *string `json:"name"`
	Content *string `json:"content"`
}

type playgroundSnippetRollbackRequest struct {
	Version *int `json:"version"`
}

type playgroundSnippetVersionResponse struct {
	Version   int    `json:"version"`
	Content   string `json:"content"`
	ByteSize  int64  `json:"byte_size"`
	CreatedAt int64  `json:"created_at"`
}

type playgroundSnippetResponse struct {
	ID                string                             `json:"id"`
	Name              string                             `json:"name"`
	Content           string                             `json:"content"`
	CurrentVersion    int                                `json:"current_version"`
	ProductionVersion int                                `json:"production_version"`
	VersionCount      int                                `json:"version_count"`
	Versions          []playgroundSnippetVersionResponse `json:"versions,omitempty"`
	CreatedAt         int64                              `json:"created_at"`
	UpdatedAt         int64                              `json:"updated_at"`
}

// playgroundSnippetExportDocument is the portable template record. It carries
// every immutable version plus the production pointer so a round trip restores
// the exact history; ids and ownership are deliberately omitted, while each
// version keeps its created_at so a re-export of imported data is stable.
type playgroundSnippetExportDocument struct {
	Format        string                    `json:"format"`
	SchemaVersion int                       `json:"schema_version"`
	ExportedAt    int64                     `json:"exported_at"`
	Template      playgroundSnippetPortable `json:"template"`
}

type playgroundSnippetPortable struct {
	Name              string                             `json:"name"`
	Versions          []playgroundSnippetPortableVersion `json:"versions"`
	ProductionVersion int                                `json:"production_version"`
}

type playgroundSnippetPortableVersion struct {
	Version   int    `json:"version"`
	Content   string `json:"content"`
	CreatedAt int64  `json:"created_at"`
}

type playgroundSnippetImportDocument struct {
	Format        string                     `json:"format"`
	SchemaVersion int                        `json:"schema_version"`
	Template      *playgroundSnippetPortable `json:"template"`
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
		CurrentVersion: snippet.CurrentVersion, ProductionVersion: snippet.ProductionVersion,
		VersionCount: snippet.CurrentVersion,
		CreatedAt:    snippet.CreatedAt, UpdatedAt: snippet.UpdatedAt,
	}
}

func playgroundDecodeSnippetDetail(snippet *model.PlaygroundSnippet, versions []model.PlaygroundSnippetVersion) playgroundSnippetResponse {
	response := playgroundDecodeSnippet(snippet)
	response.Versions = make([]playgroundSnippetVersionResponse, 0, len(versions))
	for index := range versions {
		response.Versions = append(response.Versions, playgroundSnippetVersionResponse{
			Version: versions[index].Version, Content: string(versions[index].Content),
			ByteSize: versions[index].ByteSize, CreatedAt: versions[index].CreatedAt,
		})
	}
	return response
}

func GetPlaygroundSnippet(c *gin.Context) {
	userID := c.GetInt("id")
	snippet, err := model.GetPlaygroundSnippet(userID, c.Param("snippetId"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	versions, err := model.GetPlaygroundSnippetVersions(userID, snippet.ID)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeSnippetDetail(snippet, versions))
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
	update := model.PlaygroundSnippetUpdate{}
	if request.Name != nil {
		name, err := validatePlaygroundSnippetName(request.Name)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		update.Name = &name
	}
	if request.Content != nil {
		content, err := validatePlaygroundSnippetContent(request.Content, policy.SnippetContentMaxBytes)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		update.Content = &content
	}
	snippet, err := model.UpdatePlaygroundSnippet(c.GetInt("id"), c.Param("snippetId"), update)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeSnippet(snippet))
}

// RollbackPlaygroundSnippet moves the production pointer to a stored revision.
// It never rewrites history: the version rows stay byte-identical, only the
// published content changes.
func RollbackPlaygroundSnippet(c *gin.Context) {
	var request playgroundSnippetRollbackRequest
	if !decodePlaygroundRequest(c, &request, playgroundSnippetRequestMaxBytes) {
		return
	}
	if request.Version == nil || *request.Version <= 0 {
		writePlaygroundError(c, common.NewMessage("Invalid prompt snippet."))
		return
	}
	userID := c.GetInt("id")
	snippet, err := model.RollbackPlaygroundSnippet(userID, c.Param("snippetId"), *request.Version)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	versions, err := model.GetPlaygroundSnippetVersions(userID, snippet.ID)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeSnippetDetail(snippet, versions))
}

func ExportPlaygroundSnippet(c *gin.Context) {
	userID := c.GetInt("id")
	snippet, err := model.GetPlaygroundSnippet(userID, c.Param("snippetId"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	versions, err := model.GetPlaygroundSnippetVersions(userID, snippet.ID)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	portable := playgroundSnippetPortable{
		Name:              snippet.Name,
		ProductionVersion: snippet.ProductionVersion,
		Versions:          make([]playgroundSnippetPortableVersion, 0, len(versions)),
	}
	for index := range versions {
		portable.Versions = append(portable.Versions, playgroundSnippetPortableVersion{
			Version: versions[index].Version, Content: string(versions[index].Content),
			CreatedAt: versions[index].CreatedAt,
		})
	}
	document := playgroundSnippetExportDocument{
		Format: playgroundSnippetFileFormat, SchemaVersion: playgroundSnippetFileVersion,
		ExportedAt: common.GetTimestamp(), Template: portable,
	}
	encoded, err := common.Marshal(document)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundExportEnvelope{
		Format:      playgroundExportFormatJSON,
		Filename:    playgroundExportFilename(snippet.Name, "json"),
		ContentType: "application/json; charset=utf-8",
		Content:     string(encoded),
	})
}

// ImportPlaygroundSnippet stores one exported template for the caller. The
// document is validated against the effective policy first and then written
// atomically, so a partially imported history can never be stored.
func ImportPlaygroundSnippet(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	maxVersions := min(policy.SnippetVersionMaxCount, playgroundSnippetImportMaxVersions)
	if maxVersions < 1 {
		maxVersions = 1
	}
	var document playgroundSnippetImportDocument
	if !decodePlaygroundRequest(c, &document, policy.SnippetContentMaxBytes*int64(maxVersions)+playgroundSnippetRequestMaxBytes) {
		return
	}
	if document.Format != playgroundSnippetFileFormat || document.SchemaVersion != playgroundSnippetFileVersion || document.Template == nil {
		writePlaygroundError(c, common.NewMessage("Invalid prompt snippet file."))
		return
	}
	name, err := validatePlaygroundSnippetName(&document.Template.Name)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	if len(document.Template.Versions) == 0 || len(document.Template.Versions) > maxVersions {
		writePlaygroundError(c, common.NewMessage("Invalid prompt snippet file."))
		return
	}
	// Versions must be contiguous 1..N in ascending order: the stored history
	// is append-only, so a file with gaps cannot be represented.
	contents := make([]string, 0, len(document.Template.Versions))
	versionCreatedAt := make([]int64, 0, len(document.Template.Versions))
	for index := range document.Template.Versions {
		if document.Template.Versions[index].Version != index+1 {
			writePlaygroundError(c, common.NewMessage("Invalid prompt snippet file."))
			return
		}
		content := document.Template.Versions[index].Content
		validated, err := validatePlaygroundSnippetContent(&content, policy.SnippetContentMaxBytes)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		contents = append(contents, validated)
		versionCreatedAt = append(versionCreatedAt, document.Template.Versions[index].CreatedAt)
	}
	production := document.Template.ProductionVersion
	if production < 0 || production > len(contents) {
		writePlaygroundError(c, common.NewMessage("Invalid prompt snippet file."))
		return
	}
	snippet, versions, err := model.ImportPlaygroundSnippet(c.GetInt("id"), name, contents, versionCreatedAt, production)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeSnippetDetail(snippet, versions))
}

func DeletePlaygroundSnippet(c *gin.Context) {
	if err := model.DeletePlaygroundSnippet(c.GetInt("id"), c.Param("snippetId")); err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("snippetId")})
}
