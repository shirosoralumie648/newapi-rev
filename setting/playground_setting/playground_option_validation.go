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

package playground_setting

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
)

// Option keys of the web-search feature. The credential is a separate option
// so the option API can hide it by its sensitive suffix.
const (
	PlaygroundWebSearchOptionKey       = "playground_setting.web_search"
	PlaygroundWebSearchAPIKeyOptionKey = "playground_setting.web_search_api_key"
)

const (
	playgroundWebSearchMaxConfigBytes    = 64 << 10
	playgroundWebSearchMaxProviderBytes  = 32
	playgroundWebSearchMaxBaseURLBytes   = 2048
	playgroundWebSearchMaxAPIKeyBytes    = 4096
	playgroundWebSearchMaxGroupOverrides = 1000
	playgroundWebSearchMaxGroupNameRunes = 128
)

// ValidatePlaygroundOption validates the Playground options that own a JSON
// shape or a sensitive credential before they replace a working configuration.
// Other Playground options keep their existing validation and normalization.
func ValidatePlaygroundOption(key, value string) error {
	switch key {
	case PlaygroundWebSearchOptionKey:
		return ValidatePlaygroundWebSearchJSON(value)
	case PlaygroundWebSearchAPIKeyOptionKey:
		return validatePlaygroundWebSearchAPIKey(value)
	case PlaygroundMCPOptionKey:
		return ValidatePlaygroundMCPJSON(value)
	case PlaygroundModelCatalogOptionKey:
		return ValidatePlaygroundModelCatalogJSON(value)
	default:
		return nil
	}
}

const (
	playgroundModelCatalogMaxConfigBytes      = 512 << 10
	playgroundModelCatalogMaxGroups           = 64
	playgroundModelCatalogMaxModels           = 2000
	playgroundModelCatalogMaxGroupOverrides   = 1000
	playgroundModelCatalogMaxGroupIDBytes     = 64
	playgroundModelCatalogMaxGroupNameRunes   = 128
	playgroundModelCatalogMaxModelBytes       = 256
	playgroundModelCatalogMaxDisplayNameRunes = 128
	playgroundModelCatalogMaxDescriptionRunes = 2000
	playgroundModelCatalogMaxIconBytes        = 1024
	playgroundModelCatalogMaxCapabilities     = 4
	playgroundModelCatalogMaxLimitValue       = 10_000_000
)

var (
	playgroundModelCatalogGroupIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	playgroundModelCatalogCapabilities   = map[string]struct{}{
		"vision":            {},
		"tools":             {},
		"reasoning":         {},
		"structured_output": {},
	}
	playgroundModelCatalogReasoningEfforts = map[string]struct{}{
		"none": {}, "minimal": {}, "low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {},
	}
)

// ValidatePlaygroundModelCatalogJSON rejects a malformed or unbounded curated
// catalog before it replaces a working one. Validation is structural: the
// catalog may name only models the group can use, which the read path merges
// against the available model list, so an entry for a temporarily disabled
// model is allowed and simply does not render.
func ValidatePlaygroundModelCatalogJSON(value string) error {
	if len(value) > playgroundModelCatalogMaxConfigBytes {
		return fmt.Errorf("%s must not exceed %d bytes", PlaygroundModelCatalogOptionKey, playgroundModelCatalogMaxConfigBytes)
	}
	var setting PlaygroundModelCatalogSetting
	if err := common.UnmarshalJsonStr(value, &setting); err != nil {
		return fmt.Errorf("%s must be a JSON object of catalog settings: %w", PlaygroundModelCatalogOptionKey, err)
	}
	if err := validatePlaygroundModelCatalog(setting.PlaygroundModelCatalog, PlaygroundModelCatalogOptionKey); err != nil {
		return err
	}
	if len(setting.GroupOverrides) > playgroundModelCatalogMaxGroupOverrides {
		return fmt.Errorf("%s.group_overrides must not contain more than %d groups", PlaygroundModelCatalogOptionKey, playgroundModelCatalogMaxGroupOverrides)
	}
	for group, override := range setting.GroupOverrides {
		group = strings.TrimSpace(group)
		if group == "" || utf8.RuneCountInString(group) > playgroundModelCatalogMaxGroupNameRunes {
			return fmt.Errorf("%s.group_overrides contains an invalid group name", PlaygroundModelCatalogOptionKey)
		}
		field := PlaygroundModelCatalogOptionKey + ".group_overrides." + group
		if err := validatePlaygroundModelCatalog(override, field); err != nil {
			return err
		}
	}
	return nil
}

func validatePlaygroundModelCatalog(catalog PlaygroundModelCatalog, field string) error {
	if len(catalog.Groups) > playgroundModelCatalogMaxGroups {
		return fmt.Errorf("%s.groups must not contain more than %d groups", field, playgroundModelCatalogMaxGroups)
	}
	groupIDs := make(map[string]bool, len(catalog.Groups))
	for index, group := range catalog.Groups {
		id := strings.TrimSpace(group.ID)
		if len(id) > playgroundModelCatalogMaxGroupIDBytes || !playgroundModelCatalogGroupIDPattern.MatchString(id) {
			return fmt.Errorf("%s.groups[%d].id must match %s", field, index, playgroundModelCatalogGroupIDPattern.String())
		}
		if groupIDs[id] {
			return fmt.Errorf("%s.groups[%d].id duplicates %q", field, index, id)
		}
		groupIDs[id] = true
		if strings.TrimSpace(group.Label) == "" {
			return fmt.Errorf("%s.groups[%d].label is required", field, index)
		}
		if utf8.RuneCountInString(group.Label) > playgroundModelCatalogMaxGroupNameRunes {
			return fmt.Errorf("%s.groups[%d].label is too long", field, index)
		}
		if utf8.RuneCountInString(group.Description) > playgroundModelCatalogMaxDescriptionRunes {
			return fmt.Errorf("%s.groups[%d].description is too long", field, index)
		}
	}

	if len(catalog.Models) > playgroundModelCatalogMaxModels {
		return fmt.Errorf("%s.models must not contain more than %d models", field, playgroundModelCatalogMaxModels)
	}
	modelNames := make(map[string]bool, len(catalog.Models))
	for index, entry := range catalog.Models {
		entryField := fmt.Sprintf("%s.models[%d]", field, index)
		modelName := strings.TrimSpace(entry.Model)
		if modelName == "" || len(modelName) > playgroundModelCatalogMaxModelBytes {
			return fmt.Errorf("%s.model is required and must not exceed %d bytes", entryField, playgroundModelCatalogMaxModelBytes)
		}
		if modelNames[modelName] {
			return fmt.Errorf("%s.model duplicates %q", entryField, modelName)
		}
		modelNames[modelName] = true
		if utf8.RuneCountInString(entry.DisplayName) > playgroundModelCatalogMaxDisplayNameRunes {
			return fmt.Errorf("%s.display_name is too long", entryField)
		}
		if utf8.RuneCountInString(entry.Description) > playgroundModelCatalogMaxDescriptionRunes {
			return fmt.Errorf("%s.description is too long", entryField)
		}
		if len(entry.Icon) > playgroundModelCatalogMaxIconBytes || strings.ContainsAny(entry.Icon, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f") {
			return fmt.Errorf("%s.icon is invalid", entryField)
		}
		groupID := strings.TrimSpace(entry.Group)
		if groupID != "" && !groupIDs[groupID] {
			return fmt.Errorf("%s.group references unknown group %q", entryField, groupID)
		}
		if len(entry.Capabilities) > playgroundModelCatalogMaxCapabilities {
			return fmt.Errorf("%s.capabilities must not contain more than %d items", entryField, playgroundModelCatalogMaxCapabilities)
		}
		seenCapabilities := make(map[string]bool, len(entry.Capabilities))
		for capabilityIndex, capability := range entry.Capabilities {
			if _, ok := playgroundModelCatalogCapabilities[capability]; !ok {
				return fmt.Errorf("%s.capabilities[%d] is unknown", entryField, capabilityIndex)
			}
			if seenCapabilities[capability] {
				return fmt.Errorf("%s.capabilities[%d] duplicates %q", entryField, capabilityIndex, capability)
			}
			seenCapabilities[capability] = true
		}
		if entry.Defaults != nil {
			if err := validatePlaygroundModelCatalogDefaults(*entry.Defaults, entryField+".defaults"); err != nil {
				return err
			}
		}
		if entry.Limits != nil {
			if err := validatePlaygroundModelCatalogLimit(entry.Limits.ContextLength, entryField+".limits.context_length"); err != nil {
				return err
			}
			if err := validatePlaygroundModelCatalogLimit(entry.Limits.MaxOutputTokens, entryField+".limits.max_output_tokens"); err != nil {
				return err
			}
		}
	}
	return nil
}

func validatePlaygroundModelCatalogDefaults(defaults PlaygroundModelCatalogDefaults, field string) error {
	if err := validatePlaygroundModelCatalogFloat(defaults.Temperature, 0, 2, field+".temperature"); err != nil {
		return err
	}
	if err := validatePlaygroundModelCatalogFloat(defaults.TopP, 0, 1, field+".top_p"); err != nil {
		return err
	}
	if defaults.MaxTokens != nil && (*defaults.MaxTokens < 1 || *defaults.MaxTokens > playgroundModelCatalogMaxLimitValue) {
		return fmt.Errorf("%s.max_tokens must be between 1 and %d", field, playgroundModelCatalogMaxLimitValue)
	}
	if err := validatePlaygroundModelCatalogFloat(defaults.FrequencyPenalty, -2, 2, field+".frequency_penalty"); err != nil {
		return err
	}
	if err := validatePlaygroundModelCatalogFloat(defaults.PresencePenalty, -2, 2, field+".presence_penalty"); err != nil {
		return err
	}
	if defaults.Seed != nil && (*defaults.Seed < 0 || *defaults.Seed > math.MaxInt32) {
		return fmt.Errorf("%s.seed must be between 0 and %d", field, math.MaxInt32)
	}
	if defaults.ReasoningEffort != nil {
		effort := strings.ToLower(strings.TrimSpace(*defaults.ReasoningEffort))
		if effort != "" {
			if _, ok := playgroundModelCatalogReasoningEfforts[effort]; !ok {
				return fmt.Errorf("%s.reasoning_effort is unknown", field)
			}
		}
	}
	return nil
}

func validatePlaygroundModelCatalogFloat(value *float64, minValue, maxValue float64, field string) error {
	if value == nil {
		return nil
	}
	if math.IsNaN(*value) || math.IsInf(*value, 0) || *value < minValue || *value > maxValue {
		return fmt.Errorf("%s must be between %g and %g", field, minValue, maxValue)
	}
	return nil
}

func validatePlaygroundModelCatalogLimit(value *int, field string) error {
	if value != nil && (*value < 1 || *value > playgroundModelCatalogMaxLimitValue) {
		return fmt.Errorf("%s must be between 1 and %d", field, playgroundModelCatalogMaxLimitValue)
	}
	return nil
}

// ValidatePlaygroundWebSearchJSON rejects an incomplete or malformed provider
// configuration. A disabled feature may keep prices, but the provider itself
// must stay one the adapter implements and SearXNG must always name its
// self-hosted endpoint, so enabling the toggle later cannot fail at runtime.
func ValidatePlaygroundWebSearchJSON(value string) error {
	if len(value) > playgroundWebSearchMaxConfigBytes {
		return fmt.Errorf("%s must not exceed %d bytes", PlaygroundWebSearchOptionKey, playgroundWebSearchMaxConfigBytes)
	}
	var setting PlaygroundWebSearchSetting
	if err := common.UnmarshalJsonStr(value, &setting); err != nil {
		return fmt.Errorf("%s must be a JSON object of web-search settings: %w", PlaygroundWebSearchOptionKey, err)
	}
	if len(setting.Provider) > playgroundWebSearchMaxProviderBytes {
		return fmt.Errorf("%s.provider is too long", PlaygroundWebSearchOptionKey)
	}
	setting.Provider = strings.ToLower(strings.TrimSpace(setting.Provider))
	switch setting.Provider {
	case PlaygroundWebSearchProviderTavily, PlaygroundWebSearchProviderSearXNG, PlaygroundWebSearchProviderBrave:
	case "":
		return fmt.Errorf("%s.provider is required", PlaygroundWebSearchOptionKey)
	default:
		return fmt.Errorf("%s.provider must be one of %s, %s or %s", PlaygroundWebSearchOptionKey,
			PlaygroundWebSearchProviderTavily, PlaygroundWebSearchProviderSearXNG, PlaygroundWebSearchProviderBrave)
	}
	setting.BaseURL = strings.TrimSpace(setting.BaseURL)
	if err := validatePlaygroundWebSearchBaseURL(setting.Provider, setting.BaseURL); err != nil {
		return err
	}
	if err := validatePlaygroundWebSearchPrice(setting.PriceUSDPerCall, "price_usd_per_call"); err != nil {
		return err
	}
	if len(setting.GroupPriceUSDPerCall) > playgroundWebSearchMaxGroupOverrides {
		return fmt.Errorf("%s.group_price_usd_per_call must not contain more than %d groups",
			PlaygroundWebSearchOptionKey, playgroundWebSearchMaxGroupOverrides)
	}
	for group, price := range setting.GroupPriceUSDPerCall {
		group = strings.TrimSpace(group)
		if group == "" || utf8.RuneCountInString(group) > playgroundWebSearchMaxGroupNameRunes {
			return fmt.Errorf("%s.group_price_usd_per_call contains an invalid group name", PlaygroundWebSearchOptionKey)
		}
		if err := validatePlaygroundWebSearchPrice(price, "group_price_usd_per_call."+group); err != nil {
			return err
		}
	}
	return nil
}

func validatePlaygroundWebSearchBaseURL(provider, baseURL string) error {
	if baseURL == "" {
		if provider == PlaygroundWebSearchProviderSearXNG {
			return fmt.Errorf("%s.base_url is required for SearXNG", PlaygroundWebSearchOptionKey)
		}
		return nil
	}
	if len(baseURL) > playgroundWebSearchMaxBaseURLBytes ||
		strings.ContainsAny(baseURL, " \t\r\n") {
		return fmt.Errorf("%s.base_url is invalid", PlaygroundWebSearchOptionKey)
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || parsed.User != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("%s.base_url must be an http(s) URL without credentials, query parameters or fragments", PlaygroundWebSearchOptionKey)
	}
	return nil
}

func validatePlaygroundWebSearchPrice(price float64, field string) error {
	if math.IsNaN(price) || math.IsInf(price, 0) || price < 0 {
		return fmt.Errorf("%s.%s must be a finite non-negative number", PlaygroundWebSearchOptionKey, field)
	}
	return nil
}

func validatePlaygroundWebSearchAPIKey(value string) error {
	if len(value) > playgroundWebSearchMaxAPIKeyBytes {
		return fmt.Errorf("%s must not exceed %d bytes", PlaygroundWebSearchAPIKeyOptionKey, playgroundWebSearchMaxAPIKeyBytes)
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return fmt.Errorf("%s is invalid", PlaygroundWebSearchAPIKeyOptionKey)
	}
	return nil
}
