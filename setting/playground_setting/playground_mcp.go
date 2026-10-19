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
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"golang.org/x/net/http/httpguts"
)

// MCP (LB-10) is an administrator-managed list of global streamable HTTP MCP
// servers. The browser receives only ids, names and tool metadata; endpoints
// and credentials stay on the gateway. The feature ships off and every server
// is off until an administrator enables it.
const (
	PlaygroundMCPOptionKey = "playground_setting.mcp"

	PlaygroundMCPMaxServers = 20

	playgroundMCPMaxConfigBytes       = 64 << 10
	playgroundMCPMaxServerIDLength    = 24
	playgroundMCPMaxServerNameRunes   = 100
	playgroundMCPMaxURLBytes          = 2048
	playgroundMCPMaxHeaderNameBytes   = 64
	playgroundMCPMaxTokenBytes        = 4096
	playgroundMCPDefaultAuthHeaderKey = "Authorization"
)

var playgroundMCPServerIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$`)

// PlaygroundMCPServerSetting is one global MCP connection. AuthToken is
// accepted only on write; GetOptions redacts it and exposes HasToken instead,
// so the stored credential never reaches the console.
type PlaygroundMCPServerSetting struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	Enabled   bool   `json:"enabled"`
	Header    string `json:"header"`
	AuthToken string `json:"auth_token,omitempty"`
	// HasToken and ClearToken are console-only fields of a redacted or edited
	// configuration. A blank token keeps the stored one; ClearToken removes it.
	HasToken   bool `json:"has_token,omitempty"`
	ClearToken bool `json:"clear_token,omitempty"`
}

// PlaygroundMCPSetting is the global MCP configuration.
type PlaygroundMCPSetting struct {
	Enabled bool                         `json:"enabled"`
	Servers []PlaygroundMCPServerSetting `json:"servers"`
}

func builtinPlaygroundMCPSetting() *PlaygroundMCPSetting {
	return &PlaygroundMCPSetting{
		Enabled: false,
		Servers: []PlaygroundMCPServerSetting{},
	}
}

// GetPlaygroundMCPSetting returns the persisted MCP configuration. Callers
// must not mutate it outside tests.
func GetPlaygroundMCPSetting() *PlaygroundMCPSetting {
	if playgroundSetting.MCP == nil {
		playgroundSetting.MCP = builtinPlaygroundMCPSetting()
	}
	return playgroundSetting.MCP
}

// IsPlaygroundMCPEnabled reports whether the global switch is on and at least
// one connection is enabled. An incomplete configuration stays off.
func IsPlaygroundMCPEnabled() bool {
	setting := GetPlaygroundMCPSetting()
	if !setting.Enabled {
		return false
	}
	for _, server := range setting.Servers {
		if server.Enabled && strings.TrimSpace(server.URL) != "" {
			return true
		}
	}
	return false
}

// PlaygroundMCPEnabledServers returns a copy of the enabled connections for
// the gateway-side client. Disabled connections are never exposed.
func PlaygroundMCPEnabledServers() []PlaygroundMCPServerSetting {
	if !IsPlaygroundMCPEnabled() {
		return nil
	}
	setting := GetPlaygroundMCPSetting()
	servers := make([]PlaygroundMCPServerSetting, 0, len(setting.Servers))
	for _, server := range setting.Servers {
		if !server.Enabled || strings.TrimSpace(server.URL) == "" {
			continue
		}
		servers = append(servers, server)
	}
	return servers
}

// PlaygroundMCPDefaultAuthHeader is the header the console starts a new
// connection with. A blank value means the connection carries no credential.
func PlaygroundMCPDefaultAuthHeader() string {
	return playgroundMCPDefaultAuthHeaderKey
}

// RedactPlaygroundMCPJSON replaces every stored token with HasToken so the
// administrator console can show whether one is configured without receiving
// the secret. Unparseable content is never echoed back.
func RedactPlaygroundMCPJSON(value string) string {
	var setting PlaygroundMCPSetting
	if err := common.UnmarshalJsonStr(value, &setting); err != nil {
		return `{"enabled":false,"servers":[]}`
	}
	if setting.Servers == nil {
		setting.Servers = []PlaygroundMCPServerSetting{}
	}
	for i := range setting.Servers {
		setting.Servers[i].HasToken = setting.Servers[i].AuthToken != ""
		setting.Servers[i].AuthToken = ""
		setting.Servers[i].ClearToken = false
	}
	// The console shape keeps HasToken, so the encoder for the stored shape is
	// deliberately not used here.
	redacted, err := common.Marshal(setting)
	if err != nil {
		return `{"enabled":false,"servers":[]}`
	}
	return string(redacted)
}

// MergePlaygroundMCPJSON merges an edited configuration with the stored one:
// a blank token keeps the credential already stored for that server id, and
// ClearToken removes it. HasToken is console state and never persisted.
func MergePlaygroundMCPJSON(value string, existing *PlaygroundMCPSetting) (string, error) {
	if len(value) > playgroundMCPMaxConfigBytes {
		return "", fmt.Errorf("%s must not exceed %d bytes", PlaygroundMCPOptionKey, playgroundMCPMaxConfigBytes)
	}
	var incoming PlaygroundMCPSetting
	if err := common.UnmarshalJsonStr(value, &incoming); err != nil {
		return "", fmt.Errorf("%s must be a JSON object of MCP settings: %w", PlaygroundMCPOptionKey, err)
	}
	previousTokens := make(map[string]string)
	if existing != nil {
		for _, server := range existing.Servers {
			previousTokens[strings.TrimSpace(server.ID)] = server.AuthToken
		}
	}
	for i := range incoming.Servers {
		server := &incoming.Servers[i]
		server.ID = strings.TrimSpace(server.ID)
		switch {
		case server.ClearToken:
			server.AuthToken = ""
		case server.AuthToken == "":
			server.AuthToken = previousTokens[server.ID]
		}
		server.HasToken = false
		server.ClearToken = false
	}
	return EncodePlaygroundMCPSetting(incoming)
}

// EncodePlaygroundMCPSetting serializes a configuration in its stored shape.
// Console-only fields are dropped and an empty server list stays a JSON array.
func EncodePlaygroundMCPSetting(setting PlaygroundMCPSetting) (string, error) {
	setting.Servers = append([]PlaygroundMCPServerSetting(nil), setting.Servers...)
	for i := range setting.Servers {
		setting.Servers[i].HasToken = false
		setting.Servers[i].ClearToken = false
	}
	if setting.Servers == nil {
		setting.Servers = []PlaygroundMCPServerSetting{}
	}
	encoded, err := common.Marshal(setting)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// ValidatePlaygroundMCPJSON checks a complete stored configuration. A disabled
// feature may keep a partial list, but every present connection must be
// usable once its own switch is turned on.
func ValidatePlaygroundMCPJSON(value string) error {
	if len(value) > playgroundMCPMaxConfigBytes {
		return fmt.Errorf("%s must not exceed %d bytes", PlaygroundMCPOptionKey, playgroundMCPMaxConfigBytes)
	}
	var setting PlaygroundMCPSetting
	if err := common.UnmarshalJsonStr(value, &setting); err != nil {
		return fmt.Errorf("%s must be a JSON object of MCP settings: %w", PlaygroundMCPOptionKey, err)
	}
	if len(setting.Servers) > PlaygroundMCPMaxServers {
		return fmt.Errorf("%s.servers must not contain more than %d connections", PlaygroundMCPOptionKey, PlaygroundMCPMaxServers)
	}
	seen := make(map[string]struct{}, len(setting.Servers))
	for i := range setting.Servers {
		server := &setting.Servers[i]
		server.ID = strings.TrimSpace(server.ID)
		if !playgroundMCPServerIDPattern.MatchString(server.ID) {
			return fmt.Errorf("%s.servers[%d].id must match %s", PlaygroundMCPOptionKey, i, playgroundMCPServerIDPattern.String())
		}
		if _, duplicate := seen[server.ID]; duplicate {
			return fmt.Errorf("%s.servers contains duplicate id %q", PlaygroundMCPOptionKey, server.ID)
		}
		seen[server.ID] = struct{}{}

		server.Name = strings.TrimSpace(server.Name)
		if server.Name == "" || utf8.RuneCountInString(server.Name) > playgroundMCPMaxServerNameRunes {
			return fmt.Errorf("%s.servers[%d].name must be a non-empty name of at most %d characters", PlaygroundMCPOptionKey, i, playgroundMCPMaxServerNameRunes)
		}
		server.URL = strings.TrimSpace(server.URL)
		if err := validatePlaygroundMCPURL(server.URL); err != nil {
			return fmt.Errorf("%s.servers[%d].url %w", PlaygroundMCPOptionKey, i, err)
		}
		server.Header = strings.TrimSpace(server.Header)
		if server.Header != "" {
			if len(server.Header) > playgroundMCPMaxHeaderNameBytes || !httpguts.ValidHeaderFieldName(server.Header) {
				return fmt.Errorf("%s.servers[%d].header is not a valid HTTP header name", PlaygroundMCPOptionKey, i)
			}
			switch strings.ToLower(server.Header) {
			case "host", "content-length", "connection", "transfer-encoding", "upgrade",
				"proxy-authorization", "accept", "content-type", "mcp-session-id", "mcp-protocol-version":
				return fmt.Errorf("%s.servers[%d].header %s is reserved by the MCP client", PlaygroundMCPOptionKey, i, server.Header)
			}
		}
		if server.AuthToken != "" {
			if len(server.AuthToken) > playgroundMCPMaxTokenBytes || strings.ContainsAny(server.AuthToken, "\x00\r\n") {
				return fmt.Errorf("%s.servers[%d].auth_token is invalid", PlaygroundMCPOptionKey, i)
			}
			if server.Header == "" {
				return fmt.Errorf("%s.servers[%d].header is required when a token is configured", PlaygroundMCPOptionKey, i)
			}
		}
	}
	return nil
}

// validatePlaygroundMCPURL keeps stored endpoints to plain absolute HTTP(S)
// URLs. Credentials, query parameters and fragments belong in the header
// configuration, so a URL can never smuggle a secret into logs or responses.
func validatePlaygroundMCPURL(raw string) error {
	if raw == "" {
		return fmt.Errorf("is required")
	}
	if len(raw) > playgroundMCPMaxURLBytes || strings.ContainsAny(raw, " \t\r\n") {
		return fmt.Errorf("is invalid")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("must be an http(s) URL without credentials, query parameters or fragments")
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return fmt.Errorf("has an invalid port")
		}
	}
	return nil
}
