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

package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type playgroundMCPTestRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func usePlaygroundMCPTestClient(t *testing.T) {
	t.Helper()
	previousClient := playgroundMCPHTTPClient
	previousValidator := playgroundMCPTargetValidator
	playgroundMCPHTTPClient = &http.Client{}
	playgroundMCPTargetValidator = func(context.Context, *url.URL) error { return nil }
	t.Cleanup(func() {
		playgroundMCPHTTPClient = previousClient
		playgroundMCPTargetValidator = previousValidator
		ResetPlaygroundMCPToolCache()
	})
	ResetPlaygroundMCPToolCache()
}

func usePlaygroundMCPTestServers(t *testing.T, servers ...playground_setting.PlaygroundMCPServerSetting) {
	t.Helper()
	previous := playground_setting.GetPlaygroundSetting().MCP
	playground_setting.GetPlaygroundSetting().MCP = &playground_setting.PlaygroundMCPSetting{
		Enabled: true,
		Servers: servers,
	}
	t.Cleanup(func() {
		playground_setting.GetPlaygroundSetting().MCP = previous
		ResetPlaygroundMCPToolCache()
	})
	ResetPlaygroundMCPToolCache()
}

func playgroundMCPTestServer(serverID string) playground_setting.PlaygroundMCPServerSetting {
	return playground_setting.PlaygroundMCPServerSetting{
		ID:      serverID,
		Name:    "Docs",
		Enabled: true,
		Header:  "Authorization",
	}
}

func readPlaygroundMCPTestRequest(t *testing.T, request *http.Request) playgroundMCPTestRequest {
	t.Helper()
	var payload playgroundMCPTestRequest
	if err := common.DecodeJson(request.Body, &payload); err != nil {
		assert.NoError(t, err)
	}
	return payload
}

func writePlaygroundMCPTestJSON(t *testing.T, w http.ResponseWriter, payload any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	encoded, err := common.Marshal(payload)
	if !assert.NoError(t, err) {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	_, _ = w.Write(encoded)
}

// TestPlaygroundMCPProxy covers the streamable HTTP handshake, paginated tool
// listing, the JSON and SSE response forms, session reuse, and the bounded
// normalization of a tool result. The upstream is a local server whose
// protected client and target check are replaced for the duration of the test.
func TestPlaygroundMCPProxy(t *testing.T) {
	usePlaygroundMCPTestClient(t)
	var initializeCalls, toolListCalls, toolCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		payload := readPlaygroundMCPTestRequest(t, request)
		assert.Equal(t, "Bearer test-token", request.Header.Get("Authorization"))
		switch payload.Method {
		case "initialize":
			initializeCalls.Add(1)
			assert.Empty(t, request.Header.Get("Mcp-Session-Id"))
			w.Header().Set("Mcp-Session-Id", "session-1")
			writePlaygroundMCPTestJSON(t, w, map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(payload.ID),
				"result":  map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{}},
			})
		case "notifications/initialized":
			assert.Equal(t, "session-1", request.Header.Get("Mcp-Session-Id"))
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			toolListCalls.Add(1)
			assert.Equal(t, "session-1", request.Header.Get("Mcp-Session-Id"))
			assert.Equal(t, "2025-03-26", request.Header.Get("MCP-Protocol-Version"))
			var params struct {
				Cursor string `json:"cursor"`
			}
			assert.NoError(t, common.Unmarshal(payload.Params, &params))
			if params.Cursor == "" {
				writePlaygroundMCPTestJSON(t, w, map[string]any{
					"jsonrpc": "2.0",
					"id":      json.RawMessage(payload.ID),
					"result": map[string]any{
						"tools": []any{
							map[string]any{
								"name":        "search",
								"description": strings.Repeat("d", 2000),
								"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"q": map[string]any{"type": "string"}}},
							},
							map[string]any{"name": "bad tool name", "inputSchema": map[string]any{"type": "object"}},
							map[string]any{"name": "search", "description": "duplicate"},
						},
						"nextCursor": "page-2",
					},
				})
				return
			}
			assert.Equal(t, "page-2", params.Cursor)
			writePlaygroundMCPTestJSON(t, w, map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(payload.ID),
				"result": map[string]any{
					"tools": []any{
						map[string]any{"name": "echo", "description": "Echo input"},
						map[string]any{"name": strings.Repeat("x", 60), "description": "unrepresentable"},
					},
				},
			})
		case "tools/call":
			toolCalls.Add(1)
			assert.Equal(t, "session-1", request.Header.Get("Mcp-Session-Id"))
			assert.Equal(t, "2025-03-26", request.Header.Get("MCP-Protocol-Version"))
			var params struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			assert.NoError(t, common.Unmarshal(payload.Params, &params))
			assert.Equal(t, "echo", params.Name)
			assert.Contains(t, string(params.Arguments), "9007199254740993")
			w.Header().Set("Content-Type", "text/event-stream")
			notification, err := common.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"method":  "notifications/progress",
				"params":  map[string]any{"progress": 1},
			})
			assert.NoError(t, err)
			response, err := common.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(payload.ID),
				"result": map[string]any{
					"isError": false,
					"content": []any{
						map[string]any{"type": "text", "text": "hello"},
						map[string]any{"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"},
					},
					"structuredContent": map[string]any{"answer": 42},
				},
			})
			assert.NoError(t, err)
			_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\nevent: message\ndata: %s\n\n", notification, response)
		default:
			t.Errorf("unexpected MCP method %q", payload.Method)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(upstream.Close)

	server := playgroundMCPTestServer("docs")
	server.URL = upstream.URL + "/mcp"
	server.AuthToken = "Bearer test-token"
	usePlaygroundMCPTestServers(t, server)

	servers, err := ListPlaygroundMCPServers(context.Background())
	require.NoError(t, err)
	require.Len(t, servers, 1)
	assert.True(t, servers[0].Available)
	require.Len(t, servers[0].Tools, 2)
	assert.Equal(t, "search", servers[0].Tools[0].Name)
	assert.Equal(t, "mcp__docs__search", servers[0].Tools[0].FunctionName)
	assert.LessOrEqual(t, len(servers[0].Tools[0].Description), playgroundMCPMaxToolDescription)
	assert.JSONEq(t, `{"type":"object","properties":{"q":{"type":"string"}}}`, string(servers[0].Tools[0].InputSchema))
	assert.Equal(t, "echo", servers[0].Tools[1].Name)

	// The second catalog read comes from the short-lived cache: neither the
	// upstream list nor the initialize handshake is repeated.
	again, err := ListPlaygroundMCPServers(context.Background())
	require.NoError(t, err)
	require.Len(t, again, 1)
	assert.EqualValues(t, 1, initializeCalls.Load())
	assert.EqualValues(t, 2, toolListCalls.Load())

	result, err := CallPlaygroundMCPTool(context.Background(), "docs", "echo", json.RawMessage(`{"query":"go","limit":9007199254740993}`))
	require.NoError(t, err)
	assert.False(t, result.IsError)
	require.Len(t, result.Content, 2)
	assert.Equal(t, "text", result.Content[0].Type)
	assert.Equal(t, "hello", result.Content[0].Text)
	assert.Equal(t, "image", result.Content[1].Type)
	assert.Equal(t, "image/png", result.Content[1].MimeType)
	assert.Empty(t, result.Content[1].Text)
	assert.JSONEq(t, `{"answer":42}`, string(result.StructuredContent))
	assert.EqualValues(t, 1, toolCalls.Load())
	assert.EqualValues(t, 1, initializeCalls.Load())
}

// TestPlaygroundMCPStaleSessionRetriesOnce proves a terminated session is
// re-initialized, while any other failure is not retried.
func TestPlaygroundMCPStaleSessionRetriesOnce(t *testing.T) {
	usePlaygroundMCPTestClient(t)
	var initializeCalls, toolCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		payload := readPlaygroundMCPTestRequest(t, request)
		switch payload.Method {
		case "initialize":
			initializeCalls.Add(1)
			w.Header().Set("Mcp-Session-Id", fmt.Sprintf("session-%d", initializeCalls.Load()))
			writePlaygroundMCPTestJSON(t, w, map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(payload.ID),
				"result":  map[string]any{"protocolVersion": "2025-03-26"},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/call":
			if toolCalls.Add(1) == 1 {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			writePlaygroundMCPTestJSON(t, w, map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(payload.ID),
				"result":  map[string]any{"content": []any{map[string]any{"type": "text", "text": "ok"}}},
			})
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(upstream.Close)

	server := playgroundMCPTestServer("docs")
	server.URL = upstream.URL
	usePlaygroundMCPTestServers(t, server)

	result, err := CallPlaygroundMCPTool(context.Background(), "docs", "echo", json.RawMessage(`{}`))
	require.NoError(t, err)
	require.Len(t, result.Content, 1)
	assert.Equal(t, "ok", result.Content[0].Text)
	assert.EqualValues(t, 2, toolCalls.Load())
	assert.EqualValues(t, 2, initializeCalls.Load())
}

func TestPlaygroundMCPValidationAndLimits(t *testing.T) {
	usePlaygroundMCPTestClient(t)
	server := playgroundMCPTestServer("docs")
	server.URL = "https://mcp.example.com/mcp"
	usePlaygroundMCPTestServers(t, server)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := CallPlaygroundMCPTool(ctx, "docs", "echo", json.RawMessage(`{}`))
	require.ErrorIs(t, err, ErrPlaygroundMCPTimeout)

	_, err = CallPlaygroundMCPTool(context.Background(), "docs", "echo", json.RawMessage(`[]`))
	require.ErrorIs(t, err, ErrPlaygroundMCPInvalidRequest)

	huge := json.RawMessage(`{"value":"` + strings.Repeat("x", playgroundMCPMaxCallArgumentsBytes) + `"}`)
	_, err = CallPlaygroundMCPTool(context.Background(), "docs", "echo", huge)
	require.ErrorIs(t, err, ErrPlaygroundMCPInvalidRequest)

	_, err = CallPlaygroundMCPTool(context.Background(), "missing", "echo", json.RawMessage(`{}`))
	require.ErrorIs(t, err, ErrPlaygroundMCPServerNotFound)

	disabled := playgroundMCPTestServer("off")
	disabled.Enabled = false
	usePlaygroundMCPTestServers(t, server, disabled)
	_, err = CallPlaygroundMCPTool(context.Background(), "off", "echo", json.RawMessage(`{}`))
	require.ErrorIs(t, err, ErrPlaygroundMCPServerDisabled)

	playground_setting.GetPlaygroundSetting().MCP.Enabled = false
	_, err = CallPlaygroundMCPTool(context.Background(), "docs", "echo", json.RawMessage(`{}`))
	require.ErrorIs(t, err, ErrPlaygroundMCPDisabled)
	_, err = ListPlaygroundMCPServers(context.Background())
	require.ErrorIs(t, err, ErrPlaygroundMCPDisabled)
}

func TestPlaygroundMCPOversizedResponseIsReported(t *testing.T) {
	usePlaygroundMCPTestClient(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(strings.Repeat("x", playgroundMCPMaxResponseBytes+1)))
	}))
	t.Cleanup(upstream.Close)
	server := playgroundMCPTestServer("docs")
	server.URL = upstream.URL
	usePlaygroundMCPTestServers(t, server)

	servers, err := ListPlaygroundMCPServers(context.Background())
	require.NoError(t, err)
	require.Len(t, servers, 1)
	assert.False(t, servers[0].Available)
	assert.Empty(t, servers[0].Tools)

	_, err = CallPlaygroundMCPTool(context.Background(), "docs", "echo", json.RawMessage(`{}`))
	require.ErrorIs(t, err, ErrPlaygroundMCPResponseTooLarge)
}

// TestPlaygroundMCPRejectsPrivateTargets exercises the production target
// validator, which is the pre-flight half of the SSRF protection.
func TestPlaygroundMCPRejectsPrivateTargets(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1:8080/mcp",
		"http://[::1]:8080/mcp",
		"http://10.0.0.1/mcp",
		"http://169.254.169.254/latest/meta-data",
		"http://192.168.1.1/mcp",
	} {
		parsed, err := url.Parse(raw)
		require.NoError(t, err)
		require.ErrorIs(t, validatePlaygroundMCPTarget(context.Background(), parsed), ErrPlaygroundMCPUnavailable, raw)
	}
	for _, raw := range []string{
		"ftp://mcp.example.com/mcp",
		"https://user:pass@mcp.example.com/mcp",
		"https://mcp.example.com/mcp?token=secret",
		"https://mcp.example.com/mcp#fragment",
		"not a url",
	} {
		_, err := validatePlaygroundMCPEndpoint(raw)
		require.ErrorIs(t, err, ErrPlaygroundMCPUnavailable, raw)
	}
}

func TestPlaygroundMCPConfigRedactsAndKeepsSecrets(t *testing.T) {
	previous := playground_setting.GetPlaygroundSetting().MCP
	t.Cleanup(func() { playground_setting.GetPlaygroundSetting().MCP = previous })

	existing := &playground_setting.PlaygroundMCPSetting{
		Enabled: true,
		Servers: []playground_setting.PlaygroundMCPServerSetting{{
			ID: "docs", Name: "Docs", URL: "https://mcp.example.com/mcp",
			Enabled: true, Header: "Authorization", AuthToken: "Bearer stored",
		}},
	}
	merged, err := playground_setting.MergePlaygroundMCPJSON(`{
		"enabled": true,
		"servers": [
			{"id":"docs","name":"Docs","url":"https://mcp.example.com/mcp","enabled":true,"header":"Authorization","has_token":true},
			{"id":"other","name":"Other","url":"https://other.example.com/mcp","enabled":true,"header":"X-Api-Key","auth_token":"new-secret"}
		]
	}`, existing)
	require.NoError(t, err)
	require.NoError(t, playground_setting.ValidatePlaygroundMCPJSON(merged))
	var stored playground_setting.PlaygroundMCPSetting
	require.NoError(t, common.UnmarshalJsonStr(merged, &stored))
	require.Len(t, stored.Servers, 2)
	assert.Equal(t, "Bearer stored", stored.Servers[0].AuthToken)
	assert.Equal(t, "new-secret", stored.Servers[1].AuthToken)

	redacted := playground_setting.RedactPlaygroundMCPJSON(merged)
	assert.NotContains(t, redacted, "stored")
	assert.NotContains(t, redacted, "new-secret")
	assert.Contains(t, redacted, `"has_token":true`)

	cleared, err := playground_setting.MergePlaygroundMCPJSON(`{
		"enabled": true,
		"servers": [{"id":"docs","name":"Docs","url":"https://mcp.example.com/mcp","enabled":true,"header":"Authorization","clear_token":true}]
	}`, existing)
	require.NoError(t, err)
	var clearedSetting playground_setting.PlaygroundMCPSetting
	require.NoError(t, common.UnmarshalJsonStr(cleared, &clearedSetting))
	require.Len(t, clearedSetting.Servers, 1)
	assert.Empty(t, clearedSetting.Servers[0].AuthToken)

	for _, invalid := range []string{
		`{"enabled":true,"servers":[{"id":"bad id","name":"Docs","url":"https://mcp.example.com/mcp"}]}`,
		`{"enabled":true,"servers":[{"id":"docs","name":"","url":"https://mcp.example.com/mcp"}]}`,
		`{"enabled":true,"servers":[{"id":"docs","name":"Docs","url":"ftp://mcp.example.com/mcp"}]}`,
		`{"enabled":true,"servers":[{"id":"docs","name":"Docs","url":"https://mcp.example.com/mcp","header":"Content-Type","auth_token":"x"}]}`,
		`{"enabled":true,"servers":[{"id":"docs","name":"Docs","url":"https://mcp.example.com/mcp","auth_token":"x"}]}`,
	} {
		require.Error(t, playground_setting.ValidatePlaygroundMCPJSON(invalid), invalid)
	}
}
