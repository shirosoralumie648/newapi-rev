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

import "github.com/QuantumNous/new-api/setting/group_setting"

// PlaygroundModelCatalogOptionKey is the persisted option of the curated
// Playground model catalog. The generic option API also accepts it, so the
// value always passes through ValidatePlaygroundOption before it replaces a
// working configuration.
const PlaygroundModelCatalogOptionKey = "playground_setting.model_catalog"

// PlaygroundModelCatalogGroup is one editorial section of the selector. The id
// is the stable reference an entry uses; the label and description are display
// text in the deployment's own language and are not translated by the console.
type PlaygroundModelCatalogGroup struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// PlaygroundModelCatalogDefaults are the sampling values a new conversation
// starts with when the entry's model is selected. Pointer fields keep an
// explicit zero apart from an absent value (temperature 0 is a valid default).
// They are only applied while a new conversation is created; an existing
// conversation keeps the values it stored.
type PlaygroundModelCatalogDefaults struct {
	Temperature      *float64 `json:"temperature,omitempty"`
	TopP             *float64 `json:"top_p,omitempty"`
	MaxTokens        *int     `json:"max_tokens,omitempty"`
	FrequencyPenalty *float64 `json:"frequency_penalty,omitempty"`
	PresencePenalty  *float64 `json:"presence_penalty,omitempty"`
	Seed             *int64   `json:"seed,omitempty"`
	ReasoningEffort  *string  `json:"reasoning_effort,omitempty"`
}

// PlaygroundModelCatalogLimits are display-only limits of one curated entry.
// The context length overrides the tag-derived value for the selector; the
// output ceiling documents what the deployment recommends for the model.
// Enforcement stays with the relay and the provider.
type PlaygroundModelCatalogLimits struct {
	ContextLength   *int `json:"context_length,omitempty"`
	MaxOutputTokens *int `json:"max_output_tokens,omitempty"`
}

// PlaygroundModelCatalogEntry is the curated metadata of one model. The model
// name is the machine key and must match an available model exactly; the
// remaining fields only decorate or constrain the selector. `Hidden` removes
// the entry's model from the Playground selector without affecting the raw
// model list the API exposes elsewhere.
type PlaygroundModelCatalogEntry struct {
	Model        string                          `json:"model"`
	DisplayName  string                          `json:"display_name,omitempty"`
	Description  string                          `json:"description,omitempty"`
	Icon         string                          `json:"icon,omitempty"`
	Group        string                          `json:"group,omitempty"`
	Capabilities []string                        `json:"capabilities,omitempty"`
	Hidden       bool                            `json:"hidden,omitempty"`
	Defaults     *PlaygroundModelCatalogDefaults `json:"defaults,omitempty"`
	Limits       *PlaygroundModelCatalogLimits   `json:"limits,omitempty"`
}

// PlaygroundModelCatalog is the catalog itself. A group override replaces the
// whole global catalog for one user group: merging entries by id across two
// editorial lists would make a removal impossible to express.
type PlaygroundModelCatalog struct {
	Groups []PlaygroundModelCatalogGroup `json:"groups"`
	Models []PlaygroundModelCatalogEntry `json:"models"`
}

// PlaygroundModelCatalogSetting is the persisted global catalog plus its user
// group overrides. The key of an override is a stable group identifier; a
// stored display name still matches through ResolveGroupID.
type PlaygroundModelCatalogSetting struct {
	PlaygroundModelCatalog
	GroupOverrides map[string]PlaygroundModelCatalog `json:"group_overrides"`
}

// Visible returns a copy without hidden entries, so an administrator can keep
// an entry's metadata while withdrawing the model from the selector. Groups
// stay listed even when all of their models are hidden; the browser renders an
// empty section as no section.
func (catalog PlaygroundModelCatalog) Visible() PlaygroundModelCatalog {
	groups := append([]PlaygroundModelCatalogGroup(nil), catalog.Groups...)
	models := make([]PlaygroundModelCatalogEntry, 0, len(catalog.Models))
	for _, entry := range catalog.Models {
		if entry.Hidden {
			continue
		}
		models = append(models, entry)
	}
	return PlaygroundModelCatalog{Groups: groups, Models: models}
}

// GetPlaygroundModelCatalogSetting returns the persisted catalog. Callers must
// not mutate it outside tests.
func GetPlaygroundModelCatalogSetting() *PlaygroundModelCatalogSetting {
	if playgroundSetting.ModelCatalog == nil {
		playgroundSetting.ModelCatalog = builtinPlaygroundModelCatalogSetting()
	}
	return playgroundSetting.ModelCatalog
}

// GetPlaygroundModelCatalog resolves the effective, user-visible catalog of one
// user group. An override replaces the global list even when it is empty, and
// hidden entries are removed before the catalog reaches the browser.
func GetPlaygroundModelCatalog(group string) PlaygroundModelCatalog {
	setting := GetPlaygroundModelCatalogSetting()
	if override, ok := playgroundModelCatalogOverride(setting, group); ok {
		return override.Visible()
	}
	return setting.PlaygroundModelCatalog.Visible()
}

// playgroundModelCatalogOverride matches the stable group identifier first and
// then every stored key that still resolves to it, so a group rename cannot
// silently drop an override.
func playgroundModelCatalogOverride(setting *PlaygroundModelCatalogSetting, group string) (PlaygroundModelCatalog, bool) {
	identifier := group_setting.ResolveGroupID(group)
	if override, ok := setting.GroupOverrides[identifier]; ok {
		return override, true
	}
	for rawGroup, override := range setting.GroupOverrides {
		if rawGroup == identifier {
			continue // already checked above
		}
		if group_setting.ResolveGroupID(rawGroup) == identifier {
			return override, true
		}
	}
	return PlaygroundModelCatalog{}, false
}

// builtinPlaygroundModelCatalogSetting starts with an empty catalog, which
// keeps every available model selectable in its existing flat list.
func builtinPlaygroundModelCatalogSetting() *PlaygroundModelCatalogSetting {
	return &PlaygroundModelCatalogSetting{
		PlaygroundModelCatalog: PlaygroundModelCatalog{
			Groups: []PlaygroundModelCatalogGroup{},
			Models: []PlaygroundModelCatalogEntry{},
		},
		GroupOverrides: map[string]PlaygroundModelCatalog{},
	}
}
