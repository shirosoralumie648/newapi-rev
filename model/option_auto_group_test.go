package model

import (
	"fmt"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidateOptionValueRejectsInvalidMaxTokenAutoGroups(t *testing.T) {
	for _, value := range []string{"", "0", "-1", "1.5", "invalid"} {
		t.Run(value, func(t *testing.T) {
			assert.Error(t, validateOptionValue("MaxTokenAutoGroups", value))
		})
	}
	require.NoError(t, validateOptionValue("MaxTokenAutoGroups", "999999"))
}

func TestValidateOptionValueWebSearchConfiguration(t *testing.T) {
	valid := `{"enabled":true,"provider":"tavily","base_url":"","price_usd_per_call":0.01,"group_price_usd_per_call":{"vip":0}}`
	require.NoError(t, validateOptionValue(playground_setting.PlaygroundWebSearchOptionKey, valid))
	require.NoError(t, validateOptionValue(playground_setting.PlaygroundWebSearchOptionKey,
		`{"enabled":true,"provider":"SearXNG","base_url":"https://search.example.com/searxng","price_usd_per_call":0}`))

	invalid := map[string]string{
		"malformed JSON":       `{"provider":`,
		"empty provider":       `{"enabled":true,"provider":""}`,
		"unknown provider":     `{"enabled":true,"provider":"bing"}`,
		"searxng without URL":  `{"enabled":true,"provider":"searxng","base_url":""}`,
		"non-http base URL":    `{"enabled":true,"provider":"tavily","base_url":"ftp://example.com"}`,
		"base URL with query":  `{"enabled":true,"provider":"tavily","base_url":"https://example.com?x=1"}`,
		"base URL with user":   `{"enabled":true,"provider":"tavily","base_url":"https://user:pass@example.com"}`,
		"negative price":       `{"enabled":true,"provider":"tavily","price_usd_per_call":-0.01}`,
		"negative group price": `{"enabled":true,"provider":"tavily","group_price_usd_per_call":{"vip":-1}}`,
		"blank group name":     `{"enabled":true,"provider":"tavily","group_price_usd_per_call":{" ":1}}`,
		"oversized provider":   `{"enabled":true,"provider":"` + strings.Repeat("p", 33) + `"}`,
		"oversized base URL":   `{"enabled":true,"provider":"searxng","base_url":"https://example.com/` + strings.Repeat("a", 2048) + `"}`,
		"oversized group name": `{"enabled":true,"provider":"tavily","group_price_usd_per_call":{"` + strings.Repeat("g", 129) + `":1}}`,
	}
	groups := make([]string, 0, 1001)
	for index := range 1001 {
		groups = append(groups, fmt.Sprintf(`"group-%d":1`, index))
	}
	invalid["oversized group count"] = `{"enabled":true,"provider":"tavily","group_price_usd_per_call":{` + strings.Join(groups, ",") + `}}`
	for name, value := range invalid {
		t.Run(name, func(t *testing.T) {
			assert.Error(t, validateOptionValue(playground_setting.PlaygroundWebSearchOptionKey, value))
		})
	}

	require.NoError(t, validateOptionValue(playground_setting.PlaygroundWebSearchAPIKeyOptionKey, ""))
	require.NoError(t, validateOptionValue(playground_setting.PlaygroundWebSearchAPIKeyOptionKey, "tvly-secret"))
	assert.Error(t, validateOptionValue(playground_setting.PlaygroundWebSearchAPIKeyOptionKey, "key\ninjected"))
	assert.Error(t, validateOptionValue(playground_setting.PlaygroundWebSearchAPIKeyOptionKey, strings.Repeat("k", 4097)))
}
