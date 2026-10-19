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
	"maps"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

// A preset request carries display fields, the session settings it applies and
// a system prompt. The envelope adds room for the JSON around the prompt, whose
// own budget stays with the owner's policy inside the shared validation.
const playgroundPresetRequestMaxBytes = 64 << 10

const (
	// playgroundPresetOpeningMessageMaxBytes bounds the display-only greeting.
	// It is a request-shape limit, not a billing or model-input budget: the
	// greeting is stored on the conversation but never sent to a model.
	playgroundPresetOpeningMessageMaxBytes = 8 << 10
	// playgroundPresetSuggestedQuestionMaxCount and
	// playgroundPresetSuggestedQuestionMaxLength bound the starter questions a
	// preset may offer.
	playgroundPresetSuggestedQuestionMaxCount  = 6
	playgroundPresetSuggestedQuestionMaxLength = 200
	// playgroundPresetFileFormat and playgroundPresetFileVersion identify the
	// JSON import/export document, so an unrelated JSON file is rejected before
	// its fields reach the ordinary preset validation.
	playgroundPresetFileFormat  = "new-api-playground-preset"
	playgroundPresetFileVersion = 1
)

type playgroundPresetRequest struct {
	Name               *string         `json:"name"`
	Avatar             *string         `json:"avatar"`
	Config             map[string]any  `json:"config"`
	ParameterEnabled   map[string]bool `json:"parameter_enabled"`
	SystemPrompt       *string         `json:"system_prompt"`
	OpeningMessage     *string         `json:"opening_message"`
	SuggestedQuestions *[]string       `json:"suggested_questions"`
}

type playgroundPresetResponse struct {
	ID                 string          `json:"id"`
	Name               string          `json:"name"`
	Avatar             string          `json:"avatar"`
	Config             map[string]any  `json:"config"`
	ParameterEnabled   map[string]bool `json:"parameter_enabled"`
	SystemPrompt       string          `json:"system_prompt"`
	Visibility         string          `json:"visibility"`
	OpeningMessage     string          `json:"opening_message"`
	SuggestedQuestions []string        `json:"suggested_questions"`
	CreatedAt          int64           `json:"created_at"`
	UpdatedAt          int64           `json:"updated_at"`
}

// playgroundPresetExportDocument is the portable preset record. It deliberately
// omits ids, ownership and timestamps: an import always creates a new preset
// for the target scope after the ordinary validation runs again.
type playgroundPresetExportDocument struct {
	Format     string                   `json:"format"`
	Version    int                      `json:"version"`
	ExportedAt int64                    `json:"exported_at"`
	Preset     playgroundPresetPortable `json:"preset"`
}

type playgroundPresetPortable struct {
	Name               string          `json:"name"`
	Avatar             string          `json:"avatar"`
	Config             map[string]any  `json:"config"`
	ParameterEnabled   map[string]bool `json:"parameter_enabled"`
	SystemPrompt       string          `json:"system_prompt"`
	OpeningMessage     string          `json:"opening_message"`
	SuggestedQuestions []string        `json:"suggested_questions"`
}

type playgroundPresetImportDocument struct {
	Format  string                   `json:"format"`
	Version int                      `json:"version"`
	Preset  *playgroundPresetRequest `json:"preset"`
}

// validatePlaygroundPresetName normalizes the display name. A preset is only
// discoverable by its name, so an empty or overlong value is rejected instead
// of truncated.
func validatePlaygroundPresetName(name *string) (string, error) {
	if name == nil {
		return "", common.NewMessage("Assistant preset name must contain 1 to 100 characters.")
	}
	value := strings.TrimSpace(*name)
	if value == "" || utf8.RuneCountInString(value) > 100 || strings.ContainsRune(value, 0) {
		return "", common.NewMessage("Assistant preset name must contain 1 to 100 characters.")
	}
	return value, nil
}

// validatePlaygroundPresetAvatar accepts an emoji/short label or an http(s)
// image URL. Arbitrary schemes (for example `data:` or `javascript:`) are never
// treated as an image source, and no avatar is fetched by the server.
func validatePlaygroundPresetAvatar(avatar *string) (string, error) {
	// A fresh message per call keeps the shared error text out of package state.
	invalid := common.NewMessage("Assistant preset avatar must be an emoji or an http(s) image URL.")
	if avatar == nil {
		return "", nil
	}
	value := strings.TrimSpace(*avatar)
	if value == "" {
		return "", nil
	}
	if len(value) > 2048 || strings.ContainsRune(value, 0) {
		return "", invalid
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return "", invalid
		}
	}
	if strings.Contains(value, "://") {
		parsed, err := url.Parse(value)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return "", invalid
		}
		return value, nil
	}
	if utf8.RuneCountInString(value) > 64 {
		return "", invalid
	}
	return value, nil
}

func validatePlaygroundPresetOpeningMessage(message *string) (string, error) {
	if message == nil {
		return "", nil
	}
	if len(*message) > playgroundPresetOpeningMessageMaxBytes {
		return "", common.NewMessage("The opening message is too long.")
	}
	if strings.ContainsRune(*message, 0) {
		return "", common.NewMessage("Invalid assistant preset.")
	}
	return *message, nil
}

// encodePlaygroundSuggestedQuestions normalizes the starter questions into the
// JSON array stored on a preset or conversation. Blank entries are rejected
// instead of silently dropped, and repeated questions are stored once.
func encodePlaygroundSuggestedQuestions(questions []string) (string, error) {
	if len(questions) > playgroundPresetSuggestedQuestionMaxCount {
		return "", common.NewMessage("Too many suggested questions.")
	}
	values := make([]string, 0, len(questions))
	seen := make(map[string]bool, len(questions))
	for _, raw := range questions {
		value := strings.TrimSpace(raw)
		if value == "" || utf8.RuneCountInString(value) > playgroundPresetSuggestedQuestionMaxLength || strings.ContainsRune(value, 0) {
			return "", common.NewMessage("Each suggested question must contain 1 to 200 characters.")
		}
		if seen[value] {
			continue
		}
		seen[value] = true
		values = append(values, value)
	}
	encoded, err := common.Marshal(values)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// validatePlaygroundPresetSuggestedQuestions normalizes the starter questions
// carried by a preset request; an absent field keeps the stored value.
func validatePlaygroundPresetSuggestedQuestions(questions *[]string) (string, error) {
	if questions == nil {
		return "", nil
	}
	return encodePlaygroundSuggestedQuestions(*questions)
}

// playgroundPresetSessionSettings validates the session-shaped settings of a
// preset with the same rules a conversation uses, so applying a preset can
// never store a configuration a session update would reject.
func playgroundPresetSessionSettings(request playgroundPresetRequest, systemPromptMaxBytes int64) (map[string]any, error) {
	return encodePlaygroundSettings(playgroundSessionRequest{
		Config:           request.Config,
		ParameterEnabled: request.ParameterEnabled,
		SystemPrompt:     request.SystemPrompt,
	}, systemPromptMaxBytes)
}

// playgroundPresetUpdates validates every field the request carries and returns
// the stored column values. requireName is used by create/import, where the
// display name is mandatory; requireAny is used by PATCH, where an empty body
// would otherwise look like a successful no-op.
func playgroundPresetUpdates(request playgroundPresetRequest, systemPromptMaxBytes int64, requireName, requireAny bool) (map[string]any, error) {
	updates := map[string]any{}
	if request.Name == nil && requireName {
		return nil, common.NewMessage("Assistant preset name must contain 1 to 100 characters.")
	}
	if request.Name != nil {
		name, err := validatePlaygroundPresetName(request.Name)
		if err != nil {
			return nil, err
		}
		updates["name"] = name
	}
	if request.Avatar != nil {
		avatar, err := validatePlaygroundPresetAvatar(request.Avatar)
		if err != nil {
			return nil, err
		}
		updates["avatar"] = avatar
	}
	settings, err := playgroundPresetSessionSettings(request, systemPromptMaxBytes)
	if err != nil {
		return nil, err
	}
	maps.Copy(updates, settings)
	if request.OpeningMessage != nil {
		message, err := validatePlaygroundPresetOpeningMessage(request.OpeningMessage)
		if err != nil {
			return nil, err
		}
		updates["opening_message"] = message
	}
	if request.SuggestedQuestions != nil {
		questions, err := validatePlaygroundPresetSuggestedQuestions(request.SuggestedQuestions)
		if err != nil {
			return nil, err
		}
		updates["suggested_questions"] = questions
	}
	if requireAny && len(updates) == 0 {
		return nil, common.NewMessage("Invalid assistant preset.")
	}
	return updates, nil
}

// playgroundPresetFromUpdates builds a new row from validated request values.
// Name is mandatory and therefore already present when this is called.
func playgroundPresetFromUpdates(updates map[string]any) *model.PlaygroundPreset {
	preset := &model.PlaygroundPreset{Config: "{}", ParameterEnabled: "{}", SuggestedQuestions: "[]"}
	if value, ok := updates["name"].(string); ok {
		preset.Name = value
	}
	if value, ok := updates["avatar"].(string); ok {
		preset.Avatar = value
	}
	if value, ok := updates["config"].(string); ok {
		preset.Config = value
	}
	if value, ok := updates["parameter_enabled"].(string); ok {
		preset.ParameterEnabled = value
	}
	if value, ok := updates["system_prompt"].(string); ok {
		preset.SystemPrompt = model.LongText(value)
	}
	if value, ok := updates["opening_message"].(string); ok {
		preset.OpeningMessage = model.LongText(value)
	}
	if value, ok := updates["suggested_questions"].(string); ok {
		preset.SuggestedQuestions = value
	}
	return preset
}

func playgroundDecodePreset(preset *model.PlaygroundPreset) (playgroundPresetResponse, error) {
	response := playgroundPresetResponse{
		ID: preset.ID, Name: preset.Name, Avatar: preset.Avatar,
		SystemPrompt:       string(preset.SystemPrompt),
		Visibility:         model.PlaygroundPresetVisibility(preset.Visibility),
		OpeningMessage:     string(preset.OpeningMessage),
		SuggestedQuestions: []string{},
		CreatedAt:          preset.CreatedAt, UpdatedAt: preset.UpdatedAt,
		Config: map[string]any{}, ParameterEnabled: map[string]bool{},
	}
	if err := common.Unmarshal([]byte(preset.Config), &response.Config); err != nil {
		return response, err
	}
	if err := common.Unmarshal([]byte(preset.ParameterEnabled), &response.ParameterEnabled); err != nil {
		return response, err
	}
	if stored := strings.TrimSpace(preset.SuggestedQuestions); stored != "" && stored != "null" {
		if err := common.UnmarshalJsonStr(stored, &response.SuggestedQuestions); err != nil {
			return response, err
		}
		if response.SuggestedQuestions == nil {
			response.SuggestedQuestions = []string{}
		}
	}
	return response, nil
}

func playgroundPresetResponses(presets []model.PlaygroundPreset) ([]playgroundPresetResponse, error) {
	items := make([]playgroundPresetResponse, 0, len(presets))
	for index := range presets {
		response, err := playgroundDecodePreset(&presets[index])
		if err != nil {
			return nil, err
		}
		items = append(items, response)
	}
	return items, nil
}

func GetPlaygroundPreset(c *gin.Context) {
	preset, err := model.GetPlaygroundPreset(c.GetInt("id"), c.Param("presetId"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	response, err := playgroundDecodePreset(preset)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

func ListPlaygroundPresets(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	presets, total, err := model.ListPlaygroundPresets(c.GetInt("id"), policy.PresetUserMaxCount)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	items, err := playgroundPresetResponses(presets)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": total, "limit": policy.PresetUserMaxCount})
}

// ListPlaygroundPresetMarket lists the global presets every account may copy.
// The market is not an account resource, so it carries no per-account limit.
func ListPlaygroundPresetMarket(c *gin.Context) {
	presets, total, err := model.ListGlobalPlaygroundPresets(0)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	items, err := playgroundPresetResponses(presets)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": total})
}

// ListGlobalPlaygroundPresets is the administrator view of the same rows.
func ListGlobalPlaygroundPresets(c *gin.Context) {
	ListPlaygroundPresetMarket(c)
}

func GetGlobalPlaygroundPreset(c *gin.Context) {
	preset, err := model.GetGlobalPlaygroundPreset(c.Param("presetId"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	response, err := playgroundDecodePreset(preset)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

func CreatePlaygroundPreset(c *gin.Context) {
	createPlaygroundPreset(c, false)
}

func CreateGlobalPlaygroundPreset(c *gin.Context) {
	createPlaygroundPreset(c, true)
}

func createPlaygroundPreset(c *gin.Context, global bool) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundPresetRequest
	if !decodePlaygroundRequest(c, &request, policy.SystemPromptMaxBytes+playgroundPresetRequestMaxBytes) {
		return
	}
	updates, err := playgroundPresetUpdates(request, policy.SystemPromptMaxBytes, true, false)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	preset := playgroundPresetFromUpdates(updates)
	if global {
		err = model.CreateGlobalPlaygroundPreset(preset)
	} else {
		err = model.CreatePlaygroundPreset(c.GetInt("id"), preset)
	}
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	response, err := playgroundDecodePreset(preset)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

func UpdatePlaygroundPreset(c *gin.Context) {
	updatePlaygroundPreset(c, false)
}

func UpdateGlobalPlaygroundPreset(c *gin.Context) {
	updatePlaygroundPreset(c, true)
}

func updatePlaygroundPreset(c *gin.Context, global bool) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundPresetRequest
	if !decodePlaygroundRequest(c, &request, policy.SystemPromptMaxBytes+playgroundPresetRequestMaxBytes) {
		return
	}
	updates, err := playgroundPresetUpdates(request, policy.SystemPromptMaxBytes, false, true)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	var preset *model.PlaygroundPreset
	if global {
		preset, err = model.UpdateGlobalPlaygroundPreset(c.Param("presetId"), updates)
	} else {
		preset, err = model.UpdatePlaygroundPreset(c.GetInt("id"), c.Param("presetId"), updates)
	}
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	response, err := playgroundDecodePreset(preset)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

func DeletePlaygroundPreset(c *gin.Context) {
	if err := model.DeletePlaygroundPreset(c.GetInt("id"), c.Param("presetId")); err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("presetId")})
}

func DeleteGlobalPlaygroundPreset(c *gin.Context) {
	if err := model.DeleteGlobalPlaygroundPreset(c.Param("presetId")); err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("presetId")})
}

// CopyPlaygroundPresetFromMarket stores a private copy for the caller. The
// global row is only read; the copy goes through the ordinary quota-checked
// create path.
func CopyPlaygroundPresetFromMarket(c *gin.Context) {
	preset, err := model.CopyGlobalPlaygroundPreset(c.GetInt("id"), c.Param("presetId"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	response, err := playgroundDecodePreset(preset)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

func ExportPlaygroundPreset(c *gin.Context) {
	preset, err := model.GetPlaygroundPreset(c.GetInt("id"), c.Param("presetId"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	exportPlaygroundPreset(c, preset)
}

func ExportGlobalPlaygroundPreset(c *gin.Context) {
	preset, err := model.GetGlobalPlaygroundPreset(c.Param("presetId"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	exportPlaygroundPreset(c, preset)
}

func exportPlaygroundPreset(c *gin.Context, preset *model.PlaygroundPreset) {
	response, err := playgroundDecodePreset(preset)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	document := playgroundPresetExportDocument{
		Format: playgroundPresetFileFormat, Version: playgroundPresetFileVersion,
		ExportedAt: common.GetTimestamp(),
		Preset: playgroundPresetPortable{
			Name: response.Name, Avatar: response.Avatar,
			Config: response.Config, ParameterEnabled: response.ParameterEnabled,
			SystemPrompt: response.SystemPrompt, OpeningMessage: response.OpeningMessage,
			SuggestedQuestions: response.SuggestedQuestions,
		},
	}
	encoded, err := common.Marshal(document)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundExportEnvelope{
		Format:      playgroundExportFormatJSON,
		Filename:    playgroundExportFilename(response.Name, "json"),
		ContentType: "application/json; charset=utf-8",
		Content:     string(encoded),
	})
}

func ImportPlaygroundPreset(c *gin.Context) {
	importPlaygroundPreset(c, false)
}

func ImportGlobalPlaygroundPreset(c *gin.Context) {
	importPlaygroundPreset(c, true)
}

func importPlaygroundPreset(c *gin.Context, global bool) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var document playgroundPresetImportDocument
	if !decodePlaygroundRequest(c, &document, policy.SystemPromptMaxBytes+playgroundPresetRequestMaxBytes) {
		return
	}
	if document.Format != playgroundPresetFileFormat || document.Version != playgroundPresetFileVersion || document.Preset == nil {
		writePlaygroundError(c, common.NewMessage("Invalid preset file."))
		return
	}
	updates, err := playgroundPresetUpdates(*document.Preset, policy.SystemPromptMaxBytes, true, false)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	preset := playgroundPresetFromUpdates(updates)
	if global {
		err = model.CreateGlobalPlaygroundPreset(preset)
	} else {
		err = model.CreatePlaygroundPreset(c.GetInt("id"), preset)
	}
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	response, err := playgroundDecodePreset(preset)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}
