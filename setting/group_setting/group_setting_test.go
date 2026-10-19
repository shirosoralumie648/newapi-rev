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
package group_setting_test

import (
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/group_setting"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// configureGroupIdentity installs a small group registry whose identifiers are
// stable and restores every touched setting afterwards.
func configureGroupIdentity(t *testing.T) {
	t.Helper()
	originalRatios := ratio_setting.GroupRatio2JSONString()
	originalUsable := setting.UserUsableGroups2JSONString()
	originalNames := group_setting.GroupDisplayNames2JSONString()
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"vip":1,"svip":1}`))
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default group","vip":"VIP group"}`))
	require.NoError(t, group_setting.UpdateGroupDisplayNamesByJSONString(`{"vip":"VIP 会员"}`))
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(originalRatios))
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(originalUsable))
		require.NoError(t, group_setting.UpdateGroupDisplayNamesByJSONString(originalNames))
	})
}

func TestGroupDisplayNameFallsBackToIdentifier(t *testing.T) {
	configureGroupIdentity(t)

	assert.Equal(t, "VIP 会员", group_setting.GetGroupDisplayName("vip"))
	assert.Equal(t, "default", group_setting.GetGroupDisplayName("default"))
	assert.Equal(t, "", group_setting.GetGroupDisplayName(""))
	assert.Equal(t, map[string]string{"vip": "VIP 会员"}, group_setting.GetGroupDisplayNamesCopy())

	identifier, ok := group_setting.LookupGroupIDByDisplayName(" VIP 会员 ")
	require.True(t, ok)
	assert.Equal(t, "vip", identifier)
	_, ok = group_setting.LookupGroupIDByDisplayName("default")
	assert.False(t, ok)
}

func TestResolveGroupIDPrefersIdentifiersAndAcceptsDisplayNames(t *testing.T) {
	configureGroupIdentity(t)

	assert.Equal(t, "vip", group_setting.ResolveGroupID("vip"))
	assert.Equal(t, "vip", group_setting.ResolveGroupID(" VIP 会员 "))
	assert.Equal(t, "default", group_setting.ResolveGroupID("default"))
	assert.Equal(t, "unknown", group_setting.ResolveGroupID("unknown"))
	assert.Equal(t, "", group_setting.ResolveGroupID(""))
	// A reference that resolves to nothing keeps its exact stored value, so
	// existing validation still rejects it instead of silently changing it.
	assert.Equal(t, " v i p ", group_setting.ResolveGroupID(" v i p "))
}

func TestValidateGroupDisplayNamesRejectsUnsafeMaps(t *testing.T) {
	configureGroupIdentity(t)

	for _, test := range []struct {
		name    string
		payload string
	}{
		{name: "not an object", payload: `[]`},
		{name: "blank identifier", payload: `{"  ":"Name"}`},
		{name: "blank display name", payload: `{"vip":"  "}`},
		{name: "duplicate display names", payload: `{"vip":"Premium","svip":"Premium"}`},
		{name: "shadows an identifier", payload: `{"vip":"default"}`},
		{name: "control character", payload: `{"vip":"a\u0000b"}`},
		{name: "too long", payload: `{"vip":"` + strings.Repeat("x", group_setting.MaxGroupDisplayNameLength+1) + `"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			assert.Error(t, group_setting.ValidateGroupDisplayNamesJSON(test.payload))
		})
	}

	require.NoError(t, group_setting.ValidateGroupDisplayNamesJSON(`{"vip":"Premium"}`))
	// A display name for a group that is not configured yet is allowed; the
	// entry only takes effect once the group exists.
	require.NoError(t, group_setting.ValidateGroupDisplayNamesJSON(`{"future":"Coming soon"}`))
	// Repeating the identifier as the display name is equivalent to no entry.
	require.NoError(t, group_setting.ValidateGroupDisplayNamesJSON(`{"vip":"vip"}`))
}

func TestUpdateGroupDisplayNamesKeepsPreviousStateOnInvalidInput(t *testing.T) {
	configureGroupIdentity(t)

	require.Error(t, group_setting.UpdateGroupDisplayNamesByJSONString(`{"vip":""}`))
	assert.Equal(t, "VIP 会员", group_setting.GetGroupDisplayName("vip"))

	// Repeating the identifier clears the stored display name.
	require.NoError(t, group_setting.UpdateGroupDisplayNamesByJSONString(`{"vip":"vip"}`))
	assert.Equal(t, "vip", group_setting.GetGroupDisplayName("vip"))
}

func TestPlaygroundModelCatalogResolvesOverridesAndValidates(t *testing.T) {
	configureGroupIdentity(t)
	catalog := playground_setting.GetPlaygroundModelCatalogSetting()
	original := *catalog
	t.Cleanup(func() { *catalog = original })

	catalog.Groups = []playground_setting.PlaygroundModelCatalogGroup{
		{ID: "recommended", Label: "Recommended"},
	}
	catalog.Models = []playground_setting.PlaygroundModelCatalogEntry{
		{Model: "gpt-4o", DisplayName: "GPT-4o", Group: "recommended"},
		{Model: "retired-model", DisplayName: "Retired", Hidden: true},
	}
	catalog.GroupOverrides = map[string]playground_setting.PlaygroundModelCatalog{
		"vip": {
			Groups: []playground_setting.PlaygroundModelCatalogGroup{{ID: "vip-only", Label: "VIP"}},
			Models: []playground_setting.PlaygroundModelCatalogEntry{{Model: "vip-model", Group: "vip-only"}},
		},
		"empty-group": {},
	}

	global := playground_setting.GetPlaygroundModelCatalog("default")
	require.Len(t, global.Models, 1)
	assert.Equal(t, "gpt-4o", global.Models[0].Model)
	assert.Equal(t, "Recommended", global.Groups[0].Label)

	vip := playground_setting.GetPlaygroundModelCatalog("VIP 会员")
	require.Len(t, vip.Models, 1)
	assert.Equal(t, "vip-model", vip.Models[0].Model)
	assert.Equal(t, "vip-only", vip.Groups[0].ID)

	empty := playground_setting.GetPlaygroundModelCatalog("empty-group")
	assert.Empty(t, empty.Groups)
	assert.Empty(t, empty.Models)

	valid := `{
		"groups": [{"id":"recommended","label":"Recommended"}],
		"models": [{
			"model":"gpt-4o","display_name":"GPT-4o","group":"recommended",
			"capabilities":["vision","tools"],
			"defaults":{"temperature":0,"top_p":1,"max_tokens":4096,"seed":0,"reasoning_effort":"high"},
			"limits":{"context_length":128000,"max_output_tokens":16384}
		}],
		"group_overrides": {"vip":{"groups":[],"models":[]}}
	}`
	require.NoError(t, playground_setting.ValidatePlaygroundModelCatalogJSON(valid))

	for name, payload := range map[string]string{
		"duplicate model":    `{"groups":[],"models":[{"model":"m"},{"model":"m"}]}`,
		"unknown group":      `{"groups":[],"models":[{"model":"m","group":"missing"}]}`,
		"unknown capability": `{"groups":[],"models":[{"model":"m","capabilities":["audio"]}]}`,
		"invalid default":    `{"groups":[],"models":[{"model":"m","defaults":{"temperature":3}}]}`,
		"invalid limit":      `{"groups":[],"models":[{"model":"m","limits":{"context_length":0}}]}`,
		"invalid group id":   `{"groups":[{"id":"space id","label":"Bad"}],"models":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			assert.Error(t, playground_setting.ValidatePlaygroundModelCatalogJSON(payload))
		})
	}
}

func TestPlaygroundQuotaPolicyResolvesGroupDisplayNames(t *testing.T) {
	configureGroupIdentity(t)
	settings := playground_setting.GetPlaygroundSetting()
	originalOverrides := settings.GroupOverrides
	t.Cleanup(func() { settings.GroupOverrides = originalOverrides })

	settings.GroupOverrides = map[string]playground_setting.PlaygroundQuotaPolicy{
		"vip": {SessionMaxCount: 7},
	}
	assert.Equal(t, 7, playground_setting.GetPlaygroundQuotaPolicy("VIP 会员").SessionMaxCount)
	assert.Equal(t, 7, playground_setting.GetPlaygroundQuotaPolicy("vip").SessionMaxCount)

	// An older configuration keyed by the display name still applies and never
	// silently drops the budget.
	settings.GroupOverrides = map[string]playground_setting.PlaygroundQuotaPolicy{
		"VIP 会员": {SessionMaxCount: 3},
	}
	assert.Equal(t, 3, playground_setting.GetPlaygroundQuotaPolicy("vip").SessionMaxCount)
	assert.Equal(t, playground_setting.GetPlaygroundQuotaPolicy("").SessionMaxCount, playground_setting.GetPlaygroundQuotaPolicy("default").SessionMaxCount)
}
