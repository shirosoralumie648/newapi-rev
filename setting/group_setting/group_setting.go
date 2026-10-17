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
// Package group_setting separates a group's stable identifier from its editable
// display name. An identifier is a key of the group ratio and usable-group
// configuration and never changes once the group exists; tokens, subscription
// plans and Playground resource-policy overrides always store identifiers.
// Display names are cosmetic, so renaming one cannot invalidate a stored
// reference.
package group_setting

import (
	"errors"
	"fmt"
	"maps"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
)

// MaxGroupDisplayNameLength bounds one editable display name, in characters.
const MaxGroupDisplayNameLength = 64

var (
	groupDisplayNames      = map[string]string{}
	groupDisplayNamesMutex sync.RWMutex
)

// GetGroupDisplayNamesCopy returns a copy of the identifier → display-name map.
// Groups without an entry display their identifier.
func GetGroupDisplayNamesCopy() map[string]string {
	groupDisplayNamesMutex.RLock()
	defer groupDisplayNamesMutex.RUnlock()

	names := make(map[string]string, len(groupDisplayNames))
	maps.Copy(names, groupDisplayNames)
	return names
}

// GroupDisplayNames2JSONString serializes the configured display names.
func GroupDisplayNames2JSONString() string {
	payload, err := common.Marshal(GetGroupDisplayNamesCopy())
	if err != nil {
		common.SysError(common.LogText("error marshalling group display names: %s", err.Error()))
		return "{}"
	}
	return string(payload)
}

// ValidateGroupDisplayNamesJSON rejects malformed maps before the option is
// persisted, so an invalid draft can never replace a working configuration.
// Blank identifiers or names, control characters, over-long text, duplicate
// display names and names that shadow another group's identifier are invalid.
func ValidateGroupDisplayNamesJSON(jsonStr string) error {
	parsed := make(map[string]string)
	if err := common.Unmarshal([]byte(jsonStr), &parsed); err != nil {
		return fmt.Errorf("group display names must be a JSON object of identifier → display name: %w", err)
	}
	seen := make(map[string]string, len(parsed))
	for rawIdentifier, rawName := range parsed {
		identifier := strings.TrimSpace(rawIdentifier)
		if identifier == "" {
			return errors.New("group display names cannot contain a blank identifier")
		}
		if err := validateGroupDisplayText("group identifier", identifier); err != nil {
			return err
		}
		name := strings.TrimSpace(rawName)
		if name == "" {
			return fmt.Errorf("group display name for %q cannot be blank; remove the entry to fall back to the identifier", identifier)
		}
		if err := validateGroupDisplayText("group display name", name); err != nil {
			return err
		}
		if existing, ok := seen[name]; ok {
			return fmt.Errorf("group display names must be unique: %q is used by both %q and %q", name, existing, identifier)
		}
		seen[name] = identifier
		if name == identifier {
			// Equivalent to no display name; the identifier is displayed.
			continue
		}
		if IsKnownGroupID(name) {
			return fmt.Errorf("group display name %q duplicates an existing group identifier", name)
		}
	}
	return nil
}

// UpdateGroupDisplayNamesByJSONString validates and replaces the display-name
// map. Entries whose name equals their identifier are dropped so the stored map
// only contains real renames.
func UpdateGroupDisplayNamesByJSONString(jsonStr string) error {
	if err := ValidateGroupDisplayNamesJSON(jsonStr); err != nil {
		return err
	}
	parsed := make(map[string]string)
	if err := common.Unmarshal([]byte(jsonStr), &parsed); err != nil {
		return err
	}
	normalized := make(map[string]string, len(parsed))
	for rawIdentifier, rawName := range parsed {
		identifier := strings.TrimSpace(rawIdentifier)
		name := strings.TrimSpace(rawName)
		if name == identifier {
			continue
		}
		normalized[identifier] = name
	}

	groupDisplayNamesMutex.Lock()
	groupDisplayNames = normalized
	groupDisplayNamesMutex.Unlock()
	return nil
}

// GetGroupDisplayName returns the editable display name of a group, falling
// back to the identifier when none is configured.
func GetGroupDisplayName(groupID string) string {
	identifier := strings.TrimSpace(groupID)
	if identifier == "" {
		return ""
	}
	groupDisplayNamesMutex.RLock()
	name := strings.TrimSpace(groupDisplayNames[identifier])
	groupDisplayNamesMutex.RUnlock()

	if name == "" {
		return identifier
	}
	return name
}

// LookupGroupIDByDisplayName resolves a display name back to its stable
// identifier. Display names are unique, so the result is unambiguous.
func LookupGroupIDByDisplayName(name string) (string, bool) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", false
	}
	groupDisplayNamesMutex.RLock()
	defer groupDisplayNamesMutex.RUnlock()

	for identifier, displayName := range groupDisplayNames {
		if strings.TrimSpace(displayName) == trimmed {
			return identifier, true
		}
	}
	return "", false
}

// IsKnownGroupID reports whether the value names a configured group. The keys
// of the group ratio and usable-group maps are the stable identifiers.
func IsKnownGroupID(groupID string) bool {
	identifier := strings.TrimSpace(groupID)
	if identifier == "" {
		return false
	}
	return ratio_setting.ContainsGroupRatio(identifier) || setting.ContainsUserUsableGroup(identifier)
}

// ResolveGroupID maps a stored or submitted group reference to its stable
// identifier. An exact identifier always wins; otherwise a configured display
// name is translated, so references written before a rename keep working.
// Unknown values are returned unchanged for the existing validation to reject.
func ResolveGroupID(group string) string {
	trimmed := strings.TrimSpace(group)
	if trimmed == "" {
		return group
	}
	if IsKnownGroupID(trimmed) {
		return trimmed
	}
	if identifier, ok := LookupGroupIDByDisplayName(trimmed); ok {
		return identifier
	}
	return group
}

func validateGroupDisplayText(label, value string) error {
	if utf8.RuneCountInString(value) > MaxGroupDisplayNameLength {
		return fmt.Errorf("%s must be at most %d characters", label, MaxGroupDisplayNameLength)
	}
	if strings.ContainsFunc(value, unicode.IsControl) {
		return fmt.Errorf("%s cannot contain control characters", label)
	}
	return nil
}
