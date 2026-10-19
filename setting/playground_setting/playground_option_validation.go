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
	default:
		return nil
	}
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
