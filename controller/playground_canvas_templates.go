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
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/gin-gonic/gin"
)

const (
	// playgroundCanvasTemplateRequestMaxBytes bounds the metadata envelope of
	// one create, update or copy request. The document itself is never sent by
	// the client: a private template is built from the owner's saved canvas.
	playgroundCanvasTemplateRequestMaxBytes = 64 << 10
	// playgroundCanvasTemplateNameMaxRunes bounds the display name.
	playgroundCanvasTemplateNameMaxRunes = 100
	// playgroundCanvasTemplateDescriptionMaxRunes bounds the description.
	playgroundCanvasTemplateDescriptionMaxRunes = 2000
	// playgroundCanvasTemplateCategoryMaxRunes bounds the display-only
	// category slug.
	playgroundCanvasTemplateCategoryMaxRunes = 32
)

const (
	// playgroundCanvasTemplateArchiveFormat identifies the template zip both
	// export and import use. A template archive carries the document plus the
	// optional inline attachment bytes, never live resource references.
	playgroundCanvasTemplateArchiveFormat  = "new-api-canvas-template"
	playgroundCanvasTemplateArchiveVersion = 1
	// playgroundCanvasTemplateArchiveManifestEntry is the archive member with
	// the template metadata and the document.
	playgroundCanvasTemplateArchiveManifestEntry = "template.json"
	// playgroundCanvasTemplateArchiveResourceDir holds the inline bytes.
	playgroundCanvasTemplateArchiveResourceDir = "resources/"
	// playgroundCanvasTemplateArchiveClientKey marks the validation key of an
	// imported resource. Template assets are not attachments, so the key only
	// satisfies the shared signature/size validator.
	playgroundCanvasTemplateArchiveClientKey = "canvas-template-import"
)

type playgroundCanvasTemplateRequest struct {
	CanvasID     string  `json:"canvas_id"`
	Name         *string `json:"name"`
	Description  *string `json:"description"`
	Category     *string `json:"category"`
	InlineAssets *bool   `json:"inline_assets"`
}

type playgroundCanvasTemplateResponse struct {
	model.PlaygroundCanvasTemplateSummary
	Document json.RawMessage                       `json:"document"`
	Assets   []model.PlaygroundCanvasTemplateAsset `json:"assets"`
}

type playgroundCanvasTemplateWriteResponse struct {
	Template          model.PlaygroundCanvasTemplateSummary `json:"template"`
	AssetsInlined     int                                   `json:"assets_inlined"`
	ResourcesMissing  int                                   `json:"resources_missing"`
	ReferencesDropped int                                   `json:"references_dropped"`
}

type playgroundCanvasTemplateArchiveResource struct {
	Entry        string `json:"entry"`
	AttachmentID string `json:"attachment_id"`
	Filename     string `json:"filename"`
	MediaType    string `json:"media_type"`
	ByteSize     int64  `json:"byte_size"`
	ContentHash  string `json:"content_hash"`
}

type playgroundCanvasTemplateArchiveManifest struct {
	Format       string                                    `json:"format"`
	Version      int                                       `json:"version"`
	ExportedAt   int64                                     `json:"exported_at"`
	Name         string                                    `json:"name"`
	Description  string                                    `json:"description"`
	Category     string                                    `json:"category"`
	InlineAssets bool                                      `json:"inline_assets"`
	Document     json.RawMessage                           `json:"document"`
	Resources    []playgroundCanvasTemplateArchiveResource `json:"resources"`
}

var errPlaygroundCanvasTemplateArchiveInvalid = errors.New("Invalid canvas template archive.")

func playgroundCanvasTemplateSummary(template *model.PlaygroundCanvasTemplate) model.PlaygroundCanvasTemplateSummary {
	return model.PlaygroundCanvasTemplateSummary{
		ID: template.ID, Name: template.Name, Description: string(template.Description),
		Category: template.Category, Visibility: model.PlaygroundCanvasTemplateVisibility(template.Visibility),
		InlineAssets: template.InlineAssets, NodeCount: template.NodeCount, EdgeCount: template.EdgeCount,
		DocumentBytes: template.DocumentBytes, AssetCount: template.AssetCount, AssetBytes: template.AssetBytes,
		CreatedAt: template.CreatedAt, UpdatedAt: template.UpdatedAt,
	}
}

func playgroundCanvasTemplateResult(template *model.PlaygroundCanvasTemplate, assets []model.PlaygroundCanvasTemplateAsset) (*playgroundCanvasTemplateResponse, error) {
	response := &playgroundCanvasTemplateResponse{
		PlaygroundCanvasTemplateSummary: playgroundCanvasTemplateSummary(template),
		Document:                        json.RawMessage(template.Document),
		Assets:                          assets,
	}
	if len(response.Document) == 0 {
		response.Document = json.RawMessage(`{"nodes":[],"edges":[]}`)
	}
	return response, nil
}

// playgroundCanvasTemplateText trims and validates one display field. A blank
// optional field is stored as an empty string; the required name is checked by
// the caller.
func playgroundCanvasTemplateText(value string, maxRunes int, required bool) (string, bool) {
	value = strings.TrimSpace(value)
	if strings.ContainsRune(value, 0) || !utf8.ValidString(value) {
		return "", false
	}
	if required && value == "" {
		return "", false
	}
	if utf8.RuneCountInString(value) > maxRunes {
		return "", false
	}
	return value, true
}

// playgroundCanvasTemplateCategory keeps the category a display-only slug. The
// official seeds use the same alphabet, so the client can translate the known
// values and still show an administrator's custom one.
func playgroundCanvasTemplateCategory(value string) (string, bool) {
	value, ok := playgroundCanvasTemplateText(value, playgroundCanvasTemplateCategoryMaxRunes, false)
	if !ok {
		return "", false
	}
	for _, symbol := range value {
		if symbol == '-' || symbol == '_' || symbol >= '0' && symbol <= '9' ||
			symbol >= 'a' && symbol <= 'z' {
			continue
		}
		return "", false
	}
	return value, true
}

func playgroundCanvasTemplateAssetFromAttachment(c *gin.Context, userID int, attachmentID string, policy playground_setting.PlaygroundQuotaPolicy) (*model.PlaygroundCanvasTemplateAsset, bool) {
	if attachmentID == "" {
		return nil, false
	}
	attachment, err := model.GetPlaygroundAttachmentForUser(userID, attachmentID)
	if err != nil {
		return nil, false
	}
	if attachment.ByteSize <= 0 || attachment.ByteSize > policy.AttachmentMediaMaxFileBytes(attachment.MediaType) {
		return nil, false
	}
	reader, err := model.OpenPlaygroundAttachmentContent(c.Request.Context(), attachment)
	if err != nil {
		return nil, false
	}
	data, err := io.ReadAll(io.LimitReader(reader, attachment.ByteSize+1))
	_ = reader.Close()
	if err != nil || int64(len(data)) != attachment.ByteSize {
		return nil, false
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != attachment.ContentHash {
		return nil, false
	}
	return &model.PlaygroundCanvasTemplateAsset{
		SourceAttachmentID: attachment.ID,
		Filename:           attachment.Filename,
		MediaType:          attachment.MediaType,
		ByteSize:           attachment.ByteSize,
		ContentHash:        attachment.ContentHash,
		Data:               model.LongText(base64.StdEncoding.EncodeToString(data)),
	}, true
}

// playgroundCanvasTemplateAttachmentID reads the attachment claim of one node.
// A malformed ref contributes no attachment and is dropped by the sanitizer.
func playgroundCanvasTemplateAttachmentID(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var decoded map[string]json.RawMessage
	if common.Unmarshal(raw, &decoded) != nil {
		return ""
	}
	rawRef, present := decoded["ref"]
	if !present {
		return ""
	}
	var reference map[string]json.RawMessage
	if common.Unmarshal(rawRef, &reference) != nil {
		return ""
	}
	return playgroundCanvasArchiveReferenceField(reference, "attachmentId")
}

// playgroundCanvasTemplateVolatileWorkflowKeys is the run state a template
// never carries: a saved chain keeps its configuration (model, generation,
// size, image count, duration, group) but not what the last run produced.
var playgroundCanvasTemplateVolatileWorkflowKeys = []string{
	"status", "inputText", "inputImageCount", "output", "resultImageCount",
	"taskId", "sourceNodeId", "error", "attempts", "updatedAt",
}

// playgroundCanvasTemplateSanitizeNodeData removes volatile run state and
// rewrites the resource reference. keptAttachment is the source attachment id
// the template keeps; an empty value drops the ref entirely, which is what a
// structure-only template does to every node. It reports whether a ref was
// present (dropped) and whether the payload changed.
func playgroundCanvasTemplateSanitizeNodeData(raw json.RawMessage, keptAttachment string) (json.RawMessage, bool, bool, error) {
	if len(raw) == 0 {
		return raw, false, false, nil
	}
	var decoded map[string]json.RawMessage
	if common.Unmarshal(raw, &decoded) != nil {
		return raw, false, false, nil
	}
	changed := false
	if _, present := decoded["sourceDeleted"]; present {
		delete(decoded, "sourceDeleted")
		changed = true
	}
	if rawWorkflow, present := decoded["workflow"]; present {
		var workflow map[string]json.RawMessage
		if common.Unmarshal(rawWorkflow, &workflow) == nil {
			removed := false
			for _, key := range playgroundCanvasTemplateVolatileWorkflowKeys {
				if _, present := workflow[key]; present {
					delete(workflow, key)
					removed = true
				}
			}
			if removed {
				encoded, err := common.Marshal(workflow)
				if err != nil {
					return raw, false, false, err
				}
				decoded["workflow"] = encoded
				changed = true
			}
		}
	}
	dropped := false
	if _, present := decoded["ref"]; present {
		changed = true
		if keptAttachment == "" {
			delete(decoded, "ref")
			dropped = true
		} else {
			encoded, err := common.Marshal(map[string]string{"attachmentId": keptAttachment})
			if err != nil {
				return raw, false, false, err
			}
			decoded["ref"] = encoded
		}
	}
	if !changed {
		return raw, false, false, nil
	}
	encoded, err := common.Marshal(decoded)
	if err != nil {
		return raw, false, false, err
	}
	return encoded, dropped, true, nil
}

// playgroundCanvasTemplateInlineAssets snapshots the attachment bytes the
// document claims. A missing or unreadable attachment drops its ref instead of
// failing the save: the template stays usable without that resource. Bytes are
// deduplicated by attachment id and charged against the template budget.
func playgroundCanvasTemplateInlineAssets(c *gin.Context, userID int, document *playgroundCanvasDocument, policy playground_setting.PlaygroundQuotaPolicy) ([]model.PlaygroundCanvasTemplateAsset, map[string]bool, error) {
	assets := make([]model.PlaygroundCanvasTemplateAsset, 0)
	kept := make(map[string]bool)
	total := int64(0)
	for _, claim := range playgroundCanvasNodeReferences(document) {
		id := claim.Reference.AttachmentID
		if id == "" || kept[id] {
			continue
		}
		asset, ok := playgroundCanvasTemplateAssetFromAttachment(c, userID, id, policy)
		if !ok {
			continue
		}
		total += asset.ByteSize
		if total > policy.CanvasTemplateMaxBytes {
			return nil, nil, model.ErrPlaygroundCanvasTemplateLimit
		}
		assets = append(assets, *asset)
		kept[id] = true
	}
	return assets, kept, nil
}

// playgroundCanvasTemplateFromCanvas turns one saved canvas into a template
// document. It strips every reference a structure template cannot carry, keeps
// only attachment claims whose bytes were snapshotted for an inline template,
// and removes volatile workflow run state in both modes.
func playgroundCanvasTemplateFromCanvas(c *gin.Context, userID int, document *playgroundCanvasDocument, inline bool, policy playground_setting.PlaygroundQuotaPolicy) ([]model.PlaygroundCanvasTemplateAsset, int, error) {
	assets := make([]model.PlaygroundCanvasTemplateAsset, 0)
	kept := make(map[string]bool)
	if inline {
		var err error
		assets, kept, err = playgroundCanvasTemplateInlineAssets(c, userID, document, policy)
		if err != nil {
			return nil, 0, err
		}
	}
	dropped := 0
	for index := range document.Nodes {
		attachmentID := ""
		if inline {
			sourceID := playgroundCanvasTemplateAttachmentID(document.Nodes[index].Data)
			if kept[sourceID] {
				attachmentID = sourceID
			}
		}
		encoded, refDropped, _, err := playgroundCanvasTemplateSanitizeNodeData(document.Nodes[index].Data, attachmentID)
		if err != nil {
			return nil, 0, err
		}
		if refDropped {
			dropped++
		}
		document.Nodes[index].Data = encoded
	}
	return assets, dropped, nil
}

func writePlaygroundCanvasTemplateError(c *gin.Context, err error) {
	writePlaygroundError(c, err)
}

func CreatePlaygroundCanvasTemplate(c *gin.Context) {
	userID := c.GetInt("id")
	if userID <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundCanvasTemplateRequest
	if !decodePlaygroundRequest(c, &request, playgroundCanvasTemplateRequestMaxBytes) {
		return
	}
	if request.Name == nil {
		writePlaygroundCanvasTemplateError(c, model.ErrPlaygroundCanvasTemplateInvalid)
		return
	}
	name, ok := playgroundCanvasTemplateText(*request.Name, playgroundCanvasTemplateNameMaxRunes, true)
	if !ok {
		writePlaygroundCanvasTemplateError(c, model.ErrPlaygroundCanvasTemplateInvalid)
		return
	}
	description := ""
	if request.Description != nil {
		description, ok = playgroundCanvasTemplateText(*request.Description, playgroundCanvasTemplateDescriptionMaxRunes, false)
		if !ok {
			writePlaygroundCanvasTemplateError(c, model.ErrPlaygroundCanvasTemplateInvalid)
			return
		}
	}
	category := ""
	if request.Category != nil {
		category, ok = playgroundCanvasTemplateCategory(*request.Category)
		if !ok {
			writePlaygroundCanvasTemplateError(c, model.ErrPlaygroundCanvasTemplateInvalid)
			return
		}
	}
	if request.CanvasID == "" {
		writePlaygroundCanvasTemplateError(c, model.ErrPlaygroundCanvasTemplateInvalid)
		return
	}
	project, err := model.GetPlaygroundCanvasProject(userID, request.CanvasID)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	var document playgroundCanvasDocument
	if common.UnmarshalJsonStr(string(project.Document), &document) != nil {
		writePlaygroundCanvasError(c, model.ErrPlaygroundCanvasInvalid)
		return
	}
	inline := request.InlineAssets != nil && *request.InlineAssets
	assets, dropped, err := playgroundCanvasTemplateFromCanvas(c, userID, &document, inline, policy)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	normalized, nodeCount, edgeCount, err := normalizePlaygroundCanvasDocument(&document, policy)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	template := &model.PlaygroundCanvasTemplate{
		Name: name, Description: model.LongText(description), Category: category,
		InlineAssets: inline, Document: model.LongText(normalized),
		DocumentBytes: int64(len(normalized)), NodeCount: nodeCount, EdgeCount: edgeCount,
	}
	if playgroundCanvasTemplateSizeWithAssets(template, assets) > policy.CanvasTemplateMaxBytes {
		writePlaygroundCanvasTemplateError(c, model.ErrPlaygroundCanvasTemplateLimit)
		return
	}
	if err := model.CreatePlaygroundCanvasTemplate(userID, template, assets, policy); err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundCanvasTemplateWriteResponse{
		Template:          playgroundCanvasTemplateSummary(template),
		AssetsInlined:     len(assets),
		ReferencesDropped: dropped,
	})
}

func playgroundCanvasTemplateSizeWithAssets(template *model.PlaygroundCanvasTemplate, assets []model.PlaygroundCanvasTemplateAsset) int64 {
	total := template.DocumentBytes
	for index := range assets {
		total += assets[index].ByteSize
	}
	return total
}

func ListPlaygroundCanvasTemplates(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	templates, total, err := model.ListPlaygroundCanvasTemplates(c.GetInt("id"), policy.CanvasTemplateUserMaxCount)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	items := make([]model.PlaygroundCanvasTemplateSummary, 0, len(templates))
	for index := range templates {
		items = append(items, playgroundCanvasTemplateSummary(&templates[index]))
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": total, "limit": policy.CanvasTemplateUserMaxCount})
}

func ListPlaygroundCanvasTemplateMarket(c *gin.Context) {
	templates, total, err := model.ListGlobalPlaygroundCanvasTemplates(0)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	items := make([]model.PlaygroundCanvasTemplateSummary, 0, len(templates))
	for index := range templates {
		items = append(items, playgroundCanvasTemplateSummary(&templates[index]))
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": total})
}

func ListGlobalPlaygroundCanvasTemplates(c *gin.Context) {
	ListPlaygroundCanvasTemplateMarket(c)
}

func GetPlaygroundCanvasTemplate(c *gin.Context) {
	template, err := model.GetPlaygroundCanvasTemplateForReader(c.GetInt("id"), c.Param("templateId"))
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	assets, err := model.ListPlaygroundCanvasTemplateAssets(template.ID)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	response, err := playgroundCanvasTemplateResult(template, assets)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

func GetGlobalPlaygroundCanvasTemplate(c *gin.Context) {
	template, err := model.GetGlobalPlaygroundCanvasTemplate(c.Param("templateId"))
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	assets, err := model.ListPlaygroundCanvasTemplateAssets(template.ID)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	response, err := playgroundCanvasTemplateResult(template, assets)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

// playgroundCanvasTemplateUpdates validates the display fields one update
// request carries. Unset fields keep their stored value; sending only unknown
// or empty fields is rejected instead of writing an empty patch.
func playgroundCanvasTemplateUpdates(request playgroundCanvasTemplateRequest) (map[string]any, error) {
	updates := make(map[string]any)
	if request.Name != nil {
		name, ok := playgroundCanvasTemplateText(*request.Name, playgroundCanvasTemplateNameMaxRunes, true)
		if !ok {
			return nil, model.ErrPlaygroundCanvasTemplateInvalid
		}
		updates["name"] = name
	}
	if request.Description != nil {
		description, ok := playgroundCanvasTemplateText(*request.Description, playgroundCanvasTemplateDescriptionMaxRunes, false)
		if !ok {
			return nil, model.ErrPlaygroundCanvasTemplateInvalid
		}
		updates["description"] = model.LongText(description)
	}
	if request.Category != nil {
		category, ok := playgroundCanvasTemplateCategory(*request.Category)
		if !ok {
			return nil, model.ErrPlaygroundCanvasTemplateInvalid
		}
		updates["category"] = category
	}
	if len(updates) == 0 {
		return nil, model.ErrPlaygroundCanvasTemplateInvalid
	}
	return updates, nil
}

func UpdatePlaygroundCanvasTemplate(c *gin.Context) {
	var request playgroundCanvasTemplateRequest
	if !decodePlaygroundRequest(c, &request, playgroundCanvasTemplateRequestMaxBytes) {
		return
	}
	updates, err := playgroundCanvasTemplateUpdates(request)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	template, err := model.UpdatePlaygroundCanvasTemplate(c.GetInt("id"), c.Param("templateId"), updates)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundCanvasTemplateSummary(template))
}

func UpdateGlobalPlaygroundCanvasTemplate(c *gin.Context) {
	var request playgroundCanvasTemplateRequest
	if !decodePlaygroundRequest(c, &request, playgroundCanvasTemplateRequestMaxBytes) {
		return
	}
	updates, err := playgroundCanvasTemplateUpdates(request)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	template, err := model.UpdateGlobalPlaygroundCanvasTemplate(c.Param("templateId"), updates)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundCanvasTemplateSummary(template))
}

func DeletePlaygroundCanvasTemplate(c *gin.Context) {
	if err := model.DeletePlaygroundCanvasTemplate(c.GetInt("id"), c.Param("templateId")); err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("templateId")})
}

func DeleteGlobalPlaygroundCanvasTemplate(c *gin.Context) {
	if err := model.DeleteGlobalPlaygroundCanvasTemplate(c.Param("templateId")); err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("templateId")})
}

func CopyPlaygroundCanvasTemplateFromMarket(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	template, err := model.CopyGlobalPlaygroundCanvasTemplate(c.GetInt("id"), c.Param("templateId"), policy)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundCanvasTemplateSummary(template))
}

// GetPlaygroundCanvasTemplateAssetContent serves the bytes of one inline asset.
// The caller may be the owner of a private template or any signed-in account
// for a global template; the asset must belong to the same template.
func GetPlaygroundCanvasTemplateAssetContent(c *gin.Context) {
	template, err := model.GetPlaygroundCanvasTemplateForReader(c.GetInt("id"), c.Param("templateId"))
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	assets, err := model.ListPlaygroundCanvasTemplateAssets(template.ID)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	var asset *model.PlaygroundCanvasTemplateAsset
	for index := range assets {
		if assets[index].ID == c.Param("assetId") {
			asset = &assets[index]
			break
		}
	}
	if asset == nil {
		writePlaygroundCanvasTemplateError(c, model.ErrPlaygroundCanvasTemplateNotFound)
		return
	}
	data, err := base64.StdEncoding.DecodeString(string(asset.Data))
	if err != nil || int64(len(data)) != asset.ByteSize {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Stored canvas template asset is invalid."), gin.H{"code": "PLAYGROUND_STORAGE_ERROR"})
		return
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != asset.ContentHash {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Stored canvas template asset is invalid."), gin.H{"code": "PLAYGROUND_STORAGE_ERROR"})
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": asset.Filename}))
	c.Data(http.StatusOK, asset.MediaType, data)
}

// playgroundCanvasTemplateArchiveEntryName derives one resource member from an
// asset id. The id is generated, but the name is rebuilt from a safe alphabet
// so a hand-crafted row can never add a path separator.
func playgroundCanvasTemplateArchiveEntryName(asset *model.PlaygroundCanvasTemplateAsset) string {
	var builder strings.Builder
	builder.WriteString(playgroundCanvasTemplateArchiveResourceDir)
	for _, symbol := range asset.ID {
		switch {
		case symbol == '_' || symbol == '-',
			symbol >= '0' && symbol <= '9',
			symbol >= 'a' && symbol <= 'z',
			symbol >= 'A' && symbol <= 'Z':
			builder.WriteRune(symbol)
		default:
			builder.WriteByte('-')
		}
	}
	if builder.Len() == len(playgroundCanvasTemplateArchiveResourceDir) {
		builder.WriteString("resource")
	}
	builder.WriteString(model.PlaygroundAttachmentExtension(asset.MediaType))
	return builder.String()
}

func playgroundCanvasTemplateArchiveResourceID(asset *model.PlaygroundCanvasTemplateAsset) string {
	if asset.SourceAttachmentID != "" {
		return asset.SourceAttachmentID
	}
	return asset.ID
}

func ExportPlaygroundCanvasTemplate(c *gin.Context) {
	template, err := model.GetPlaygroundCanvasTemplateForReader(c.GetInt("id"), c.Param("templateId"))
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	assets, err := model.ListPlaygroundCanvasTemplateAssets(template.ID)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	var document playgroundCanvasDocument
	if common.UnmarshalJsonStr(string(template.Document), &document) != nil {
		writePlaygroundCanvasTemplateError(c, model.ErrPlaygroundCanvasTemplateInvalid)
		return
	}
	manifest := playgroundCanvasTemplateArchiveManifest{
		Format: playgroundCanvasTemplateArchiveFormat, Version: playgroundCanvasTemplateArchiveVersion,
		ExportedAt: common.GetTimestamp(), Name: template.Name, Description: string(template.Description),
		Category: template.Category, InlineAssets: template.InlineAssets,
		Document: json.RawMessage(template.Document), Resources: make([]playgroundCanvasTemplateArchiveResource, 0),
	}
	members := make(map[string][]byte, len(assets))
	if template.InlineAssets {
		for index := range assets {
			asset := &assets[index]
			data, err := base64.StdEncoding.DecodeString(string(asset.Data))
			if err != nil || int64(len(data)) != asset.ByteSize {
				continue
			}
			sum := sha256.Sum256(data)
			if hex.EncodeToString(sum[:]) != asset.ContentHash {
				continue
			}
			entry := playgroundCanvasTemplateArchiveEntryName(asset)
			manifest.Resources = append(manifest.Resources, playgroundCanvasTemplateArchiveResource{
				Entry: entry, AttachmentID: playgroundCanvasTemplateArchiveResourceID(asset),
				Filename: asset.Filename, MediaType: asset.MediaType, ByteSize: asset.ByteSize, ContentHash: asset.ContentHash,
			})
			members[entry] = data
		}
	}
	encodedManifest, err := common.Marshal(manifest)
	if err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
		"filename": playgroundExportFilename(template.Name, "zip"),
	}))
	c.Header("Cache-Control", "private, no-store")
	writer := zip.NewWriter(c.Writer)
	if err := playgroundCanvasArchiveWriteEntry(writer, playgroundCanvasTemplateArchiveManifestEntry, manifest.ExportedAt, int64(len(encodedManifest)), bytes.NewReader(encodedManifest)); err != nil {
		_ = writer.Close()
		return
	}
	for _, resource := range manifest.Resources {
		if err := playgroundCanvasArchiveWriteEntry(writer, resource.Entry, manifest.ExportedAt, resource.ByteSize, bytes.NewReader(members[resource.Entry])); err != nil {
			_ = writer.Close()
			return
		}
	}
	_ = writer.Close()
}

func ImportPlaygroundCanvasTemplate(c *gin.Context) {
	importPlaygroundCanvasTemplate(c, false)
}

func ImportGlobalPlaygroundCanvasTemplate(c *gin.Context) {
	importPlaygroundCanvasTemplate(c, true)
}

// playgroundCanvasTemplateArchiveRead reads one template zip. The manifest is
// bounded and validated structurally; resources are validated individually by
// the importer, so a damaged member drops its reference instead of failing the
// whole template.
func playgroundCanvasTemplateArchiveRead(c *gin.Context, policy playground_setting.PlaygroundQuotaPolicy) ([]byte, *zip.Reader, *playgroundCanvasTemplateArchiveManifest, error) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, playgroundCanvasArchiveMaxUploadBytes)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		return nil, nil, nil, err
	}
	defer file.Close()
	if header.Size <= 0 {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	archive, err := zip.NewReader(file, header.Size)
	if err != nil || len(archive.File) > playgroundCanvasArchiveMaxEntries {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	var member *zip.File
	for _, entry := range archive.File {
		if entry.Name == playgroundCanvasTemplateArchiveManifestEntry {
			member = entry
			break
		}
	}
	if member == nil || member.FileInfo().IsDir() {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	reader, err := member.Open()
	if err != nil {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	defer reader.Close()
	encoded, err := io.ReadAll(io.LimitReader(reader, playgroundCanvasArchiveManifestMaxBytes+1))
	if err != nil || len(encoded) > playgroundCanvasArchiveManifestMaxBytes {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	var manifest playgroundCanvasTemplateArchiveManifest
	if common.Unmarshal(encoded, &manifest) != nil {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	if manifest.Format != playgroundCanvasTemplateArchiveFormat || manifest.Version != playgroundCanvasTemplateArchiveVersion {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	name, ok := playgroundCanvasTemplateText(manifest.Name, playgroundCanvasTemplateNameMaxRunes, true)
	if !ok {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	manifest.Name = name
	description, ok := playgroundCanvasTemplateText(manifest.Description, playgroundCanvasTemplateDescriptionMaxRunes, false)
	if !ok {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	manifest.Description = description
	category, ok := playgroundCanvasTemplateCategory(manifest.Category)
	if !ok {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	manifest.Category = category
	if len(manifest.Document) == 0 || len(manifest.Resources) > policy.CanvasMaxNodes {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	var document playgroundCanvasDocument
	if common.Unmarshal(manifest.Document, &document) != nil {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	if !manifest.InlineAssets && len(manifest.Resources) > 0 {
		return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
	}
	members := make(map[string]bool, len(manifest.Resources))
	attachments := make(map[string]bool, len(manifest.Resources))
	for index := range manifest.Resources {
		resource := &manifest.Resources[index]
		if !playgroundCanvasArchiveMemberValid(resource.Entry) || members[resource.Entry] ||
			resource.AttachmentID == "" || len(resource.AttachmentID) > 128 || attachments[resource.AttachmentID] ||
			resource.ByteSize <= 0 || resource.Filename == "" || utf8.RuneCountInString(resource.Filename) > 255 ||
			!model.IsPlaygroundAttachmentMediaType(resource.MediaType) {
			return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
		}
		if len(resource.ContentHash) != 64 {
			return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
		}
		if _, err := hex.DecodeString(resource.ContentHash); err != nil {
			return nil, nil, nil, errPlaygroundCanvasTemplateArchiveInvalid
		}
		members[resource.Entry] = true
		attachments[resource.AttachmentID] = true
	}
	return encoded, archive, &manifest, nil
}

func playgroundCanvasTemplateImportResource(archive *zip.Reader, resource *playgroundCanvasTemplateArchiveResource, policy playground_setting.PlaygroundQuotaPolicy) (*model.PlaygroundCanvasTemplateAsset, bool) {
	budget := policy.AttachmentMediaMaxFileBytes(resource.MediaType)
	if resource.ByteSize <= 0 || resource.ByteSize > budget || resource.ByteSize > policy.CanvasTemplateMaxBytes {
		return nil, false
	}
	var member *zip.File
	for _, entry := range archive.File {
		if entry.Name == resource.Entry {
			member = entry
			break
		}
	}
	if member == nil || member.FileInfo().IsDir() {
		return nil, false
	}
	reader, err := member.Open()
	if err != nil {
		return nil, false
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, resource.ByteSize+1))
	if err != nil || int64(len(data)) != resource.ByteSize {
		return nil, false
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != resource.ContentHash {
		return nil, false
	}
	input := model.PlaygroundAttachmentInput{
		ClientKey: playgroundCanvasTemplateArchiveClientKey,
		MediaType: resource.MediaType, Filename: resource.Filename, Data: data,
	}
	if model.ValidatePlaygroundAttachmentInput(&input, budget) != nil {
		return nil, false
	}
	return &model.PlaygroundCanvasTemplateAsset{
		SourceAttachmentID: resource.AttachmentID, Filename: resource.Filename,
		MediaType: resource.MediaType, ByteSize: resource.ByteSize,
		ContentHash: hex.EncodeToString(sum[:]),
		Data:        model.LongText(base64.StdEncoding.EncodeToString(data)),
	}, true
}

func importPlaygroundCanvasTemplate(c *gin.Context, global bool) {
	userID := c.GetInt("id")
	if userID <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	_, archive, manifest, err := playgroundCanvasTemplateArchiveRead(c, policy)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			common.ApiErrorStatus(c, http.StatusRequestEntityTooLarge, common.NewMessage("Playground request is too large."), gin.H{"code": "PLAYGROUND_REQUEST_TOO_LARGE"})
			return
		}
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage(errPlaygroundCanvasTemplateArchiveInvalid.Error()), gin.H{"code": "PLAYGROUND_INVALID_REQUEST"})
		return
	}
	var document playgroundCanvasDocument
	if common.Unmarshal(manifest.Document, &document) != nil {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage(errPlaygroundCanvasTemplateArchiveInvalid.Error()), gin.H{"code": "PLAYGROUND_INVALID_REQUEST"})
		return
	}
	assets := make([]model.PlaygroundCanvasTemplateAsset, 0, len(manifest.Resources))
	available := make(map[string]bool, len(manifest.Resources))
	missing := 0
	total := int64(0)
	for index := range manifest.Resources {
		resource := &manifest.Resources[index]
		asset, ok := playgroundCanvasTemplateImportResource(archive, resource, policy)
		if !ok {
			missing++
			continue
		}
		total += asset.ByteSize
		if total > policy.CanvasTemplateMaxBytes {
			writePlaygroundCanvasTemplateError(c, model.ErrPlaygroundCanvasTemplateLimit)
			return
		}
		assets = append(assets, *asset)
		available[asset.SourceAttachmentID] = true
	}
	dropped := 0
	for index := range document.Nodes {
		attachmentID := ""
		if manifest.InlineAssets {
			sourceID := playgroundCanvasTemplateAttachmentID(document.Nodes[index].Data)
			if available[sourceID] {
				attachmentID = sourceID
			}
		}
		encoded, refDropped, _, err := playgroundCanvasTemplateSanitizeNodeData(document.Nodes[index].Data, attachmentID)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		if refDropped {
			dropped++
		}
		document.Nodes[index].Data = encoded
	}
	normalized, nodeCount, edgeCount, err := normalizePlaygroundCanvasDocument(&document, policy)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	template := &model.PlaygroundCanvasTemplate{
		Name: manifest.Name, Description: model.LongText(manifest.Description), Category: manifest.Category,
		InlineAssets: manifest.InlineAssets, Document: model.LongText(normalized),
		DocumentBytes: int64(len(normalized)), NodeCount: nodeCount, EdgeCount: edgeCount,
	}
	if playgroundCanvasTemplateSizeWithAssets(template, assets) > policy.CanvasTemplateMaxBytes {
		writePlaygroundCanvasTemplateError(c, model.ErrPlaygroundCanvasTemplateLimit)
		return
	}
	if global {
		if err := model.CreateGlobalPlaygroundCanvasTemplate(template, assets, policy); err != nil {
			writePlaygroundCanvasTemplateError(c, err)
			return
		}
	} else if err := model.CreatePlaygroundCanvasTemplate(userID, template, assets, policy); err != nil {
		writePlaygroundCanvasTemplateError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundCanvasTemplateWriteResponse{
		Template:          playgroundCanvasTemplateSummary(template),
		AssetsInlined:     len(assets),
		ResourcesMissing:  missing,
		ReferencesDropped: dropped,
	})
}
