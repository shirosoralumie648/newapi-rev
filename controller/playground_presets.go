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

type playgroundPresetRequest struct {
	Name             *string         `json:"name"`
	Avatar           *string         `json:"avatar"`
	Config           map[string]any  `json:"config"`
	ParameterEnabled map[string]bool `json:"parameter_enabled"`
	SystemPrompt     *string         `json:"system_prompt"`
}

type playgroundPresetResponse struct {
	ID               string          `json:"id"`
	Name             string          `json:"name"`
	Avatar           string          `json:"avatar"`
	Config           map[string]any  `json:"config"`
	ParameterEnabled map[string]bool `json:"parameter_enabled"`
	SystemPrompt     string          `json:"system_prompt"`
	CreatedAt        int64           `json:"created_at"`
	UpdatedAt        int64           `json:"updated_at"`
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

func playgroundDecodePreset(preset *model.PlaygroundPreset) (playgroundPresetResponse, error) {
	response := playgroundPresetResponse{
		ID: preset.ID, Name: preset.Name, Avatar: preset.Avatar,
		SystemPrompt: string(preset.SystemPrompt),
		CreatedAt:    preset.CreatedAt, UpdatedAt: preset.UpdatedAt,
		Config: map[string]any{}, ParameterEnabled: map[string]bool{},
	}
	if err := common.Unmarshal([]byte(preset.Config), &response.Config); err != nil {
		return response, err
	}
	if err := common.Unmarshal([]byte(preset.ParameterEnabled), &response.ParameterEnabled); err != nil {
		return response, err
	}
	return response, nil
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
	items := make([]playgroundPresetResponse, 0, len(presets))
	for index := range presets {
		response, err := playgroundDecodePreset(&presets[index])
		if err != nil {
			common.ApiError(c, err)
			return
		}
		items = append(items, response)
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": total, "limit": policy.PresetUserMaxCount})
}

func CreatePlaygroundPreset(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundPresetRequest
	if !decodePlaygroundRequest(c, &request, policy.SystemPromptMaxBytes+playgroundPresetRequestMaxBytes) {
		return
	}
	name, err := validatePlaygroundPresetName(request.Name)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	avatar, err := validatePlaygroundPresetAvatar(request.Avatar)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	updates, err := playgroundPresetSessionSettings(request, policy.SystemPromptMaxBytes)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	preset := &model.PlaygroundPreset{Name: name, Avatar: avatar, Config: "{}", ParameterEnabled: "{}"}
	if config, ok := updates["config"]; ok {
		preset.Config = config.(string)
	}
	if flags, ok := updates["parameter_enabled"]; ok {
		preset.ParameterEnabled = flags.(string)
	}
	if prompt, ok := updates["system_prompt"]; ok {
		preset.SystemPrompt = model.LongText(prompt.(string))
	}
	if err := model.CreatePlaygroundPreset(c.GetInt("id"), preset); err != nil {
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
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundPresetRequest
	if !decodePlaygroundRequest(c, &request, policy.SystemPromptMaxBytes+playgroundPresetRequestMaxBytes) {
		return
	}
	if request.Name == nil && request.Avatar == nil && request.Config == nil && request.ParameterEnabled == nil && request.SystemPrompt == nil {
		writePlaygroundError(c, common.NewMessage("Invalid assistant preset."))
		return
	}
	updates := map[string]any{}
	if request.Name != nil {
		name, err := validatePlaygroundPresetName(request.Name)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		updates["name"] = name
	}
	if request.Avatar != nil {
		avatar, err := validatePlaygroundPresetAvatar(request.Avatar)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		updates["avatar"] = avatar
	}
	settings, err := playgroundPresetSessionSettings(request, policy.SystemPromptMaxBytes)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	maps.Copy(updates, settings)
	preset, err := model.UpdatePlaygroundPreset(c.GetInt("id"), c.Param("presetId"), updates)
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
