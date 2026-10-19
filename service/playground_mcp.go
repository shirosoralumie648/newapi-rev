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
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"golang.org/x/net/http/httpguts"
)

// Limits and timeouts of the gateway-side MCP client. Every connection is
// administrator-configured, but a slow or malicious server must never hold a
// Playground request open or feed an unbounded body into the model loop.
const (
	PlaygroundMCPToolNamePrefix  = "mcp__"
	PlaygroundMCPMaxToolNameSize = 64

	playgroundMCPProtocolVersion       = "2025-03-26"
	playgroundMCPMaxRequestBytes       = 128 << 10
	playgroundMCPMaxCallArgumentsBytes = 64 << 10
	playgroundMCPMaxResponseBytes      = 2 << 20
	playgroundMCPMaxToolDescription    = 1024
	playgroundMCPMaxToolSchemaBytes    = 64 << 10
	playgroundMCPMaxContentTextBytes   = 64 << 10
	playgroundMCPMaxContentBytes       = 256 << 10
	playgroundMCPMaxContentItems       = 64
	playgroundMCPMaxStructuredBytes    = 64 << 10
	playgroundMCPMaxToolPages          = 5
	playgroundMCPMaxToolsPerServer     = 64
	playgroundMCPMaxToolCursorBytes    = 512
	playgroundMCPMaxSessionIDBytes     = 256
	playgroundMCPListTimeout           = 20 * time.Second
	playgroundMCPCallTimeout           = 30 * time.Second
	playgroundMCPToolCacheTTL          = 60 * time.Second
	playgroundMCPSessionCacheTTL       = 5 * time.Minute
)

var (
	// ErrPlaygroundMCPDisabled means the administrator switch or every
	// connection is off. It is a client error, not an upstream failure.
	ErrPlaygroundMCPDisabled = errors.New("playground MCP is disabled")
	// ErrPlaygroundMCPServerNotFound means the requested global connection is
	// not configured.
	ErrPlaygroundMCPServerNotFound = errors.New("playground MCP server not found")
	// ErrPlaygroundMCPServerDisabled means the connection exists but its
	// administrator switch is off.
	ErrPlaygroundMCPServerDisabled = errors.New("playground MCP server is disabled")
	// ErrPlaygroundMCPInvalidRequest means the tool name, arguments or server
	// id cannot form a valid JSON-RPC call.
	ErrPlaygroundMCPInvalidRequest = errors.New("playground MCP request is invalid")
	// ErrPlaygroundMCPUnavailable covers transport and protocol failures.
	ErrPlaygroundMCPUnavailable = errors.New("playground MCP server is unavailable")
	// ErrPlaygroundMCPResponseTooLarge means the server exceeded the response
	// ceiling before a complete JSON-RPC answer was read.
	ErrPlaygroundMCPResponseTooLarge = errors.New("playground MCP response is too large")
	// ErrPlaygroundMCPTimeout means the shared operation deadline expired.
	ErrPlaygroundMCPTimeout = errors.New("playground MCP request timed out")
)

var playgroundMCPToolNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// PlaygroundMCPRPCError is a JSON-RPC error returned by the upstream server.
// Its text is kept for diagnostics and tests; it is never shown to the browser.
type PlaygroundMCPRPCError struct {
	Code    int
	Message string
}

func (err *PlaygroundMCPRPCError) Error() string {
	return fmt.Sprintf("playground MCP JSON-RPC error %d: %s", err.Code, err.Message)
}

// playgroundMCPHTTPStatusError preserves an upstream HTTP status so a stale
// session can be distinguished from a genuine transport failure.
type playgroundMCPHTTPStatusError struct {
	StatusCode int
}

func (err *playgroundMCPHTTPStatusError) Error() string {
	return fmt.Sprintf("playground MCP server returned HTTP %d", err.StatusCode)
}

// PlaygroundMCPTool is one tool exposed by a global connection. FunctionName
// is the provider-safe `mcp__<server>__<tool>` name the model calls.
type PlaygroundMCPTool struct {
	Name         string          `json:"name"`
	FunctionName string          `json:"function_name"`
	Description  string          `json:"description,omitempty"`
	InputSchema  json.RawMessage `json:"input_schema"`
}

// PlaygroundMCPServerTools is the tool catalog of one connection. Available
// stays false when the upstream list failed, so the console can explain the
// empty list without exposing the upstream error.
type PlaygroundMCPServerTools struct {
	ID        string              `json:"id"`
	Name      string              `json:"name"`
	Available bool                `json:"available"`
	Tools     []PlaygroundMCPTool `json:"tools"`
}

// PlaygroundMCPContent is one normalized content item of a tools/call result.
// Binary payloads are never proxied: only their type and MIME type survive,
// keeping the model-facing result bounded and text-only.
type PlaygroundMCPContent struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	URI      string `json:"uri,omitempty"`
	Name     string `json:"name,omitempty"`
}

// PlaygroundMCPCallResult is the normalized answer of one tools/call. It
// carries the upstream error flag so the model loop can report a failed tool
// invocation without treating the gateway call itself as failed.
type PlaygroundMCPCallResult struct {
	IsError           bool                   `json:"is_error"`
	Content           []PlaygroundMCPContent `json:"content"`
	StructuredContent json.RawMessage        `json:"structured_content,omitempty"`
}

type playgroundMCPServer struct {
	id     string
	name   string
	url    string
	header string
	token  string
}

type playgroundMCPSession struct {
	id              string
	protocolVersion string
	endpoint        string
	credential      string
	createdAt       time.Time
}

type playgroundMCPToolCacheEntry struct {
	tools      []PlaygroundMCPTool
	available  bool
	endpoint   string
	credential string
	fetchedAt  time.Time
}

var (
	playgroundMCPHTTPClient      = newPlaygroundMCPHTTPClient()
	playgroundMCPTargetValidator = validatePlaygroundMCPTarget

	playgroundMCPToolsCache = struct {
		sync.Mutex
		entries map[string]playgroundMCPToolCacheEntry
	}{entries: map[string]playgroundMCPToolCacheEntry{}}

	playgroundMCPSessions = struct {
		sync.Mutex
		entries map[string]playgroundMCPSession
	}{entries: map[string]playgroundMCPSession{}}

	playgroundMCPRequestSequence atomic.Uint64
)

// newPlaygroundMCPHTTPClient builds a client that ignores the global fetch
// setting: MCP endpoints are administrator input, but the protected dialer
// still rejects private, loopback and link-local targets even on deployments
// that allow those addresses for operator-configured fetches. Proxies are
// disabled so the dial-time check cannot be bypassed by an environment proxy.
func newPlaygroundMCPHTTPClient() *http.Client {
	protection := &common.SSRFProtection{
		AllowPrivateIp:         false,
		DomainFilterMode:       false,
		IpFilterMode:           false,
		ApplyIPFilterForDomain: true,
	}
	client := newProtectedFetchHTTPClientWithProxy(nil, nil, func() (*common.SSRFProtection, bool, error) {
		return protection, true, nil
	}, func(*http.Request) (*url.URL, error) {
		return nil, nil
	})
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return fmt.Errorf("%w: redirects are not followed", ErrPlaygroundMCPUnavailable)
	}
	return client
}

// validatePlaygroundMCPTarget repeats the dial-time protection before the
// first connection: literal private and loopback addresses fail immediately,
// and a host name is rejected when any of its addresses is private. DNS
// rebinding between this lookup and the dial is still caught by the dialer.
func validatePlaygroundMCPTarget(ctx context.Context, parsed *url.URL) error {
	if parsed == nil || parsed.Hostname() == "" {
		return fmt.Errorf("%w: the endpoint URL is invalid", ErrPlaygroundMCPUnavailable)
	}
	protection := &common.SSRFProtection{
		AllowPrivateIp:         false,
		DomainFilterMode:       false,
		IpFilterMode:           false,
		ApplyIPFilterForDomain: true,
	}
	host := parsed.Hostname()
	if ip := net.ParseIP(host); ip != nil {
		if err := protection.ValidateResolvedIP(host, ip); err != nil {
			return fmt.Errorf("%w: %v", ErrPlaygroundMCPUnavailable, err)
		}
		return nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		// A resolution failure may be transient; the dial retries it.
		return nil
	}
	for _, addr := range addrs {
		if addr.IP == nil {
			continue
		}
		if err := protection.ValidateResolvedIP(host, addr.IP); err != nil {
			return fmt.Errorf("%w: %v", ErrPlaygroundMCPUnavailable, err)
		}
	}
	return nil
}

func validatePlaygroundMCPEndpoint(raw string) (*url.URL, error) {
	if raw == "" || len(raw) > 2048 || strings.ContainsAny(raw, "\x00\r\n") {
		return nil, fmt.Errorf("%w: the endpoint URL is invalid", ErrPlaygroundMCPUnavailable)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil || parsed.Host == "" || parsed.User != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%w: the endpoint URL must be absolute http(s)", ErrPlaygroundMCPUnavailable)
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return nil, fmt.Errorf("%w: the endpoint port is invalid", ErrPlaygroundMCPUnavailable)
		}
	}
	return parsed, nil
}

func playgroundMCPConfiguredServers() []playgroundMCPServer {
	configured := playground_setting.PlaygroundMCPEnabledServers()
	servers := make([]playgroundMCPServer, 0, len(configured))
	for _, server := range configured {
		servers = append(servers, playgroundMCPServer{
			id:     strings.TrimSpace(server.ID),
			name:   strings.TrimSpace(server.Name),
			url:    strings.TrimSpace(server.URL),
			header: strings.TrimSpace(server.Header),
			token:  server.AuthToken,
		})
	}
	return servers
}

func findPlaygroundMCPServer(id string) (playgroundMCPServer, error) {
	if !playground_setting.IsPlaygroundMCPEnabled() {
		return playgroundMCPServer{}, ErrPlaygroundMCPDisabled
	}
	global := playground_setting.GetPlaygroundMCPSetting()
	for _, server := range global.Servers {
		if strings.TrimSpace(server.ID) != id {
			continue
		}
		if !server.Enabled {
			return playgroundMCPServer{}, ErrPlaygroundMCPServerDisabled
		}
		return playgroundMCPServer{
			id:     strings.TrimSpace(server.ID),
			name:   strings.TrimSpace(server.Name),
			url:    strings.TrimSpace(server.URL),
			header: strings.TrimSpace(server.Header),
			token:  server.AuthToken,
		}, nil
	}
	return playgroundMCPServer{}, ErrPlaygroundMCPServerNotFound
}

func playgroundMCPCredentialFingerprint(server playgroundMCPServer) string {
	digest := sha256.Sum256([]byte(server.header + "\x00" + server.token))
	return hex.EncodeToString(digest[:8])
}

func nextPlaygroundMCPRequestID() string {
	return fmt.Sprintf("new-api-%d", playgroundMCPRequestSequence.Add(1))
}

// ResetPlaygroundMCPToolCache drops every cached catalog and session. The
// administrator save path calls it so a changed endpoint, credential or tool
// set is visible on the next request instead of after the short TTL.
func ResetPlaygroundMCPToolCache() {
	playgroundMCPToolsCache.Lock()
	playgroundMCPToolsCache.entries = map[string]playgroundMCPToolCacheEntry{}
	playgroundMCPToolsCache.Unlock()
	playgroundMCPSessions.Lock()
	playgroundMCPSessions.entries = map[string]playgroundMCPSession{}
	playgroundMCPSessions.Unlock()
}

func playgroundMCPCachedTools(server playgroundMCPServer, now time.Time) ([]PlaygroundMCPTool, bool) {
	playgroundMCPToolsCache.Lock()
	defer playgroundMCPToolsCache.Unlock()
	entry, ok := playgroundMCPToolsCache.entries[server.id]
	if !ok || now.Sub(entry.fetchedAt) >= playgroundMCPToolCacheTTL ||
		entry.endpoint != server.url || entry.credential != playgroundMCPCredentialFingerprint(server) {
		return nil, false
	}
	return append([]PlaygroundMCPTool(nil), entry.tools...), entry.available
}

func storePlaygroundMCPTools(server playgroundMCPServer, tools []PlaygroundMCPTool, available bool, now time.Time) {
	playgroundMCPToolsCache.Lock()
	defer playgroundMCPToolsCache.Unlock()
	playgroundMCPToolsCache.entries[server.id] = playgroundMCPToolCacheEntry{
		tools:      append([]PlaygroundMCPTool(nil), tools...),
		available:  available,
		endpoint:   server.url,
		credential: playgroundMCPCredentialFingerprint(server),
		fetchedAt:  now,
	}
}

// ListPlaygroundMCPServers returns the catalog of every enabled connection.
// A failing connection never fails the whole list: it is reported as
// unavailable with an empty tool set so the console can keep the others
// usable. The per-server call runs under its own bounded deadline.
func ListPlaygroundMCPServers(ctx context.Context) ([]PlaygroundMCPServerTools, error) {
	if !playground_setting.IsPlaygroundMCPEnabled() {
		return nil, ErrPlaygroundMCPDisabled
	}
	servers := playgroundMCPConfiguredServers()
	results := make([]PlaygroundMCPServerTools, len(servers))
	var wait sync.WaitGroup
	for index, server := range servers {
		wait.Go(func() {
			results[index] = PlaygroundMCPServerTools{
				ID:    server.id,
				Name:  server.name,
				Tools: []PlaygroundMCPTool{},
			}
			listCtx, cancel := context.WithTimeout(ctx, playgroundMCPListTimeout)
			defer cancel()
			tools, err := playgroundMCPToolsForServer(listCtx, server)
			if err != nil {
				common.SysError(common.LogText("playground MCP tool list unavailable for server %s: %s", server.id, playgroundMCPErrorSummary(err)))
				return
			}
			results[index].Available = true
			results[index].Tools = tools
		})
	}
	wait.Wait()
	return results, nil
}

func playgroundMCPToolsForServer(ctx context.Context, server playgroundMCPServer) ([]PlaygroundMCPTool, error) {
	if cached, ok := playgroundMCPCachedTools(server, time.Now()); ok {
		return cached, nil
	}
	tools, err := fetchPlaygroundMCPTools(ctx, server)
	if err != nil {
		return nil, err
	}
	storePlaygroundMCPTools(server, tools, true, time.Now())
	return tools, nil
}

func fetchPlaygroundMCPTools(ctx context.Context, server playgroundMCPServer) ([]PlaygroundMCPTool, error) {
	tools := make([]PlaygroundMCPTool, 0)
	seen := map[string]struct{}{}
	cursor := ""
	for page := 0; page < playgroundMCPMaxToolPages; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		response, err := playgroundMCPToolsList(ctx, server, params)
		if err != nil {
			return nil, err
		}
		var result struct {
			Tools []struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				InputSchema json.RawMessage `json:"inputSchema"`
			} `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := common.Unmarshal(response.Result, &result); err != nil {
			return nil, fmt.Errorf("%w: tools/list returned an invalid result", ErrPlaygroundMCPUnavailable)
		}
		for _, tool := range result.Tools {
			normalized, ok := normalizePlaygroundMCPTool(server.id, tool.Name, tool.Description, tool.InputSchema)
			if !ok {
				continue
			}
			if _, duplicate := seen[normalized.Name]; duplicate {
				continue
			}
			seen[normalized.Name] = struct{}{}
			tools = append(tools, normalized)
			if len(tools) >= playgroundMCPMaxToolsPerServer {
				return tools, nil
			}
		}
		cursor = strings.TrimSpace(result.NextCursor)
		if cursor == "" || len(cursor) > playgroundMCPMaxToolCursorBytes {
			break
		}
	}
	return tools, nil
}

func normalizePlaygroundMCPTool(serverID, name, description string, schema json.RawMessage) (PlaygroundMCPTool, bool) {
	name = strings.TrimSpace(name)
	if !playgroundMCPToolNamePattern.MatchString(name) {
		return PlaygroundMCPTool{}, false
	}
	functionName := PlaygroundMCPToolNamePrefix + serverID + "__" + name
	if len(functionName) > PlaygroundMCPMaxToolNameSize {
		return PlaygroundMCPTool{}, false
	}
	normalizedSchema := json.RawMessage(`{"type":"object","properties":{}}`)
	trimmed := bytes.TrimSpace(schema)
	if len(trimmed) > 0 && len(trimmed) <= playgroundMCPMaxToolSchemaBytes {
		var probe map[string]json.RawMessage
		if err := common.Unmarshal(trimmed, &probe); err == nil && probe != nil {
			normalizedSchema = append(json.RawMessage(nil), trimmed...)
		}
	}
	return PlaygroundMCPTool{
		Name:         name,
		FunctionName: functionName,
		Description:  truncatePlaygroundMCPUTF8(strings.TrimSpace(description), playgroundMCPMaxToolDescription),
		InputSchema:  normalizedSchema,
	}, true
}

// CallPlaygroundMCPTool proxies one tools/call to an enabled global server.
// The gateway always sends a fixed method and a validated object argument, so
// a caller can never turn the proxy into an arbitrary JSON-RPC client.
func CallPlaygroundMCPTool(ctx context.Context, serverID, toolName string, arguments json.RawMessage) (PlaygroundMCPCallResult, error) {
	if !playground_setting.IsPlaygroundMCPEnabled() {
		return PlaygroundMCPCallResult{}, ErrPlaygroundMCPDisabled
	}
	server, err := findPlaygroundMCPServer(serverID)
	if err != nil {
		return PlaygroundMCPCallResult{}, err
	}
	toolName = strings.TrimSpace(toolName)
	if toolName == "" || len(toolName) > 128 || strings.ContainsAny(toolName, "\x00\r\n") {
		return PlaygroundMCPCallResult{}, fmt.Errorf("%w: the tool name is invalid", ErrPlaygroundMCPInvalidRequest)
	}
	if len(arguments) == 0 {
		arguments = json.RawMessage(`{}`)
	}
	if len(arguments) > playgroundMCPMaxCallArgumentsBytes {
		return PlaygroundMCPCallResult{}, fmt.Errorf("%w: the tool arguments are too large", ErrPlaygroundMCPInvalidRequest)
	}
	var object map[string]json.RawMessage
	if err := common.Unmarshal(arguments, &object); err != nil || object == nil {
		return PlaygroundMCPCallResult{}, fmt.Errorf("%w: the tool arguments must be a JSON object", ErrPlaygroundMCPInvalidRequest)
	}

	callCtx, cancel := context.WithTimeout(ctx, playgroundMCPCallTimeout)
	defer cancel()
	request := &playgroundMCPRPCRequest{
		JSONRPC: "2.0",
		ID:      nextPlaygroundMCPRequestID(),
		Method:  "tools/call",
		Params: map[string]any{
			"name":      toolName,
			"arguments": arguments,
		},
	}
	response, err := playgroundMCPWithSession(callCtx, server, func(session *playgroundMCPSession) (*playgroundMCPRPCResponse, error) {
		return playgroundMCPSessionRequest(callCtx, server, session, request)
	})
	if err != nil {
		return PlaygroundMCPCallResult{}, err
	}
	var result struct {
		Content           []json.RawMessage `json:"content"`
		IsError           bool              `json:"isError"`
		StructuredContent json.RawMessage   `json:"structuredContent"`
	}
	if err := common.Unmarshal(response.Result, &result); err != nil {
		return PlaygroundMCPCallResult{}, fmt.Errorf("%w: tools/call returned an invalid result", ErrPlaygroundMCPUnavailable)
	}
	callResult := PlaygroundMCPCallResult{
		IsError: result.IsError,
		Content: []PlaygroundMCPContent{},
	}
	for _, raw := range result.Content {
		if len(callResult.Content) >= playgroundMCPMaxContentItems {
			break
		}
		item, ok := normalizePlaygroundMCPContent(raw)
		if !ok {
			continue
		}
		callResult.Content = append(callResult.Content, item)
	}
	encoded, err := common.Marshal(callResult.Content)
	if err != nil {
		return PlaygroundMCPCallResult{}, fmt.Errorf("%w: unable to encode the tool result", ErrPlaygroundMCPUnavailable)
	}
	for len(callResult.Content) > 0 && len(encoded) > playgroundMCPMaxContentBytes {
		callResult.Content = callResult.Content[:len(callResult.Content)-1]
		encoded, err = common.Marshal(callResult.Content)
		if err != nil {
			return PlaygroundMCPCallResult{}, fmt.Errorf("%w: unable to encode the tool result", ErrPlaygroundMCPUnavailable)
		}
	}
	if structured := bytes.TrimSpace(result.StructuredContent); len(structured) > 0 &&
		len(structured) <= playgroundMCPMaxStructuredBytes && string(structured) != "null" {
		callResult.StructuredContent = append(json.RawMessage(nil), structured...)
	}
	return callResult, nil
}

func normalizePlaygroundMCPContent(raw json.RawMessage) (PlaygroundMCPContent, bool) {
	var payload struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		MimeType string `json:"mimeType"`
		URI      string `json:"uri"`
		Name     string `json:"name"`
		Resource *struct {
			URI      string `json:"uri"`
			MimeType string `json:"mimeType"`
			Text     string `json:"text"`
		} `json:"resource"`
	}
	if err := common.Unmarshal(raw, &payload); err != nil || payload.Type == "" {
		return PlaygroundMCPContent{}, false
	}
	item := PlaygroundMCPContent{Type: truncatePlaygroundMCPUTF8(payload.Type, 32)}
	switch payload.Type {
	case "text":
		item.Text = truncatePlaygroundMCPUTF8(payload.Text, playgroundMCPMaxContentTextBytes)
	case "image", "audio":
		item.MimeType = truncatePlaygroundMCPUTF8(payload.MimeType, 128)
	case "resource":
		if payload.Resource != nil {
			item.URI = truncatePlaygroundMCPUTF8(payload.Resource.URI, 2048)
			item.MimeType = truncatePlaygroundMCPUTF8(payload.Resource.MimeType, 128)
			item.Text = truncatePlaygroundMCPUTF8(payload.Resource.Text, playgroundMCPMaxContentTextBytes)
		} else {
			item.URI = truncatePlaygroundMCPUTF8(payload.URI, 2048)
			item.MimeType = truncatePlaygroundMCPUTF8(payload.MimeType, 128)
			item.Text = truncatePlaygroundMCPUTF8(payload.Text, playgroundMCPMaxContentTextBytes)
		}
	case "resource_link":
		item.URI = truncatePlaygroundMCPUTF8(payload.URI, 2048)
		item.Name = truncatePlaygroundMCPUTF8(payload.Name, 256)
	}
	return item, true
}

func truncatePlaygroundMCPUTF8(value string, maxBytes int) string {
	if maxBytes <= 0 || len(value) <= maxBytes {
		return value
	}
	cut := maxBytes
	for cut > 0 && !utf8.ValidString(value[:cut]) {
		cut--
	}
	return value[:cut]
}

func playgroundMCPToolsList(ctx context.Context, server playgroundMCPServer, params map[string]any) (*playgroundMCPRPCResponse, error) {
	request := &playgroundMCPRPCRequest{
		JSONRPC: "2.0",
		ID:      nextPlaygroundMCPRequestID(),
		Method:  "tools/list",
		Params:  params,
	}
	return playgroundMCPWithSession(ctx, server, func(session *playgroundMCPSession) (*playgroundMCPRPCResponse, error) {
		return playgroundMCPSessionRequest(ctx, server, session, request)
	})
}

// playgroundMCPWithSession performs one request with a cached or freshly
// initialized session, and retries exactly once when the upstream reports the
// session as terminated. A tool call is retried only on HTTP 404, so a genuine
// transport failure can never duplicate a side-effecting call.
func playgroundMCPWithSession(ctx context.Context, server playgroundMCPServer, request func(*playgroundMCPSession) (*playgroundMCPRPCResponse, error)) (*playgroundMCPRPCResponse, error) {
	session, err := playgroundMCPGetSession(ctx, server)
	if err != nil {
		return nil, err
	}
	response, err := request(session)
	if err == nil {
		return response, nil
	}
	var status *playgroundMCPHTTPStatusError
	if !errors.As(err, &status) || status.StatusCode != http.StatusNotFound || session.id == "" {
		return nil, err
	}
	playgroundMCPForgetSession(server.id)
	nextSession, initErr := playgroundMCPGetSession(ctx, server)
	if initErr != nil {
		return nil, initErr
	}
	return request(nextSession)
}

func playgroundMCPGetSession(ctx context.Context, server playgroundMCPServer) (*playgroundMCPSession, error) {
	endpoint, err := validatePlaygroundMCPEndpoint(server.url)
	if err != nil {
		return nil, err
	}
	credential := playgroundMCPCredentialFingerprint(server)
	now := time.Now()
	playgroundMCPSessions.Lock()
	cached, ok := playgroundMCPSessions.entries[server.id]
	playgroundMCPSessions.Unlock()
	if ok && now.Sub(cached.createdAt) < playgroundMCPSessionCacheTTL &&
		cached.endpoint == server.url && cached.credential == credential {
		return &cached, nil
	}

	session, err := playgroundMCPInitialize(ctx, server, endpoint, credential)
	if err != nil {
		return nil, err
	}
	playgroundMCPSessions.Lock()
	playgroundMCPSessions.entries[server.id] = *session
	playgroundMCPSessions.Unlock()
	return session, nil
}

func playgroundMCPForgetSession(serverID string) {
	playgroundMCPSessions.Lock()
	delete(playgroundMCPSessions.entries, serverID)
	playgroundMCPSessions.Unlock()
}

func playgroundMCPSessionRequest(ctx context.Context, server playgroundMCPServer, session *playgroundMCPSession, request *playgroundMCPRPCRequest) (*playgroundMCPRPCResponse, error) {
	endpoint, err := validatePlaygroundMCPEndpoint(server.url)
	if err != nil {
		return nil, err
	}
	response, _, err := playgroundMCPRoundTrip(ctx, server, endpoint, session.id, session.protocolVersion, request)
	return response, err
}

func playgroundMCPInitialize(ctx context.Context, server playgroundMCPServer, endpoint *url.URL, credential string) (*playgroundMCPSession, error) {
	session := &playgroundMCPSession{
		endpoint:   server.url,
		credential: credential,
		createdAt:  time.Now(),
	}
	request := &playgroundMCPRPCRequest{
		JSONRPC: "2.0",
		ID:      nextPlaygroundMCPRequestID(),
		Method:  "initialize",
		Params: map[string]any{
			"protocolVersion": playgroundMCPProtocolVersion,
			"capabilities":    map[string]any{},
			"clientInfo": map[string]any{
				"name":    "new-api-playground",
				"version": "1.0.0",
			},
		},
	}
	response, headers, err := playgroundMCPRoundTrip(ctx, server, endpoint, "", "", request)
	if err != nil {
		var rpc *PlaygroundMCPRPCError
		if errors.As(err, &rpc) {
			// A stateless server may implement tools/list without initialize.
			// Keep an anonymous session so the catalog request can still try.
			return session, nil
		}
		return nil, err
	}
	if response != nil {
		var result struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if err := common.Unmarshal(response.Result, &result); err == nil {
			if version := strings.TrimSpace(result.ProtocolVersion); version != "" && len(version) <= 32 {
				session.protocolVersion = version
			}
		}
	}
	if headers != nil {
		session.id = strings.TrimSpace(headers.Get("Mcp-Session-Id"))
		if len(session.id) > playgroundMCPMaxSessionIDBytes || !httpguts.ValidHeaderFieldValue(session.id) {
			session.id = ""
		}
	}
	if session.id != "" {
		// The initialized notification is best effort: a server that already
		// answered initialize can still serve the catalog if it rejects it.
		_ = playgroundMCPSendNotification(ctx, server, session, "notifications/initialized", nil)
	}
	return session, nil
}

func playgroundMCPSendNotification(ctx context.Context, server playgroundMCPServer, session *playgroundMCPSession, method string, params any) error {
	endpoint, err := validatePlaygroundMCPEndpoint(server.url)
	if err != nil {
		return err
	}
	request := &playgroundMCPRPCRequest{JSONRPC: "2.0", Method: method}
	if params != nil {
		request.Params = params
	}
	_, _, err = playgroundMCPRoundTrip(ctx, server, endpoint, session.id, session.protocolVersion, request)
	return err
}

type playgroundMCPRPCRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      string `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type playgroundMCPRPCResponse struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func playgroundMCPRoundTrip(ctx context.Context, server playgroundMCPServer, endpoint *url.URL, sessionID, protocolVersion string, payload *playgroundMCPRPCRequest) (*playgroundMCPRPCResponse, http.Header, error) {
	body, err := common.Marshal(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: unable to encode the request", ErrPlaygroundMCPInvalidRequest)
	}
	if len(body) > playgroundMCPMaxRequestBytes {
		return nil, nil, fmt.Errorf("%w: the request is too large", ErrPlaygroundMCPInvalidRequest)
	}
	return playgroundMCPDoPost(ctx, server, endpoint, sessionID, protocolVersion, body, payload.ID)
}

func playgroundMCPDoPost(ctx context.Context, server playgroundMCPServer, endpoint *url.URL, sessionID, protocolVersion string, body []byte, requestID string) (*playgroundMCPRPCResponse, http.Header, error) {
	if err := playgroundMCPTargetValidator(ctx, endpoint); err != nil {
		return nil, nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, nil, fmt.Errorf("%w: unable to build the request", ErrPlaygroundMCPUnavailable)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("User-Agent", "new-api-playground-mcp/1.0")
	if sessionID != "" {
		request.Header.Set("Mcp-Session-Id", sessionID)
	}
	if protocolVersion != "" {
		request.Header.Set("MCP-Protocol-Version", protocolVersion)
	}
	if server.header != "" && server.token != "" {
		request.Header.Set(server.header, server.token)
	}

	response, err := playgroundMCPHTTPClient.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return nil, nil, ErrPlaygroundMCPTimeout
		}
		return nil, nil, fmt.Errorf("%w: %v", ErrPlaygroundMCPUnavailable, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, playgroundMCPMaxResponseBytes+1))
	if err != nil {
		return nil, nil, fmt.Errorf("%w: unable to read the response", ErrPlaygroundMCPUnavailable)
	}
	if len(raw) > playgroundMCPMaxResponseBytes {
		return nil, nil, ErrPlaygroundMCPResponseTooLarge
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, response.Header, &playgroundMCPHTTPStatusError{StatusCode: response.StatusCode}
	}
	if requestID == "" {
		return nil, response.Header, nil
	}

	contentType := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Type")))
	var rpcResponse *playgroundMCPRPCResponse
	if strings.HasPrefix(contentType, "text/event-stream") {
		rpcResponse, err = parsePlaygroundMCPSSE(raw, requestID)
	} else {
		if len(bytes.TrimSpace(raw)) == 0 {
			return nil, response.Header, fmt.Errorf("%w: the server returned an empty response", ErrPlaygroundMCPUnavailable)
		}
		rpcResponse = &playgroundMCPRPCResponse{}
		if err := common.Unmarshal(raw, rpcResponse); err != nil {
			return nil, response.Header, fmt.Errorf("%w: the server returned invalid JSON", ErrPlaygroundMCPUnavailable)
		}
		if !playgroundMCPResponseMatchesID(rpcResponse, requestID) {
			return nil, response.Header, fmt.Errorf("%w: the server returned a mismatched response id", ErrPlaygroundMCPUnavailable)
		}
	}
	if err != nil {
		return nil, response.Header, err
	}
	if rpcResponse.Error != nil {
		message := strings.TrimSpace(rpcResponse.Error.Message)
		if len(message) > 300 {
			message = truncatePlaygroundMCPUTF8(message, 300)
		}
		return nil, response.Header, &PlaygroundMCPRPCError{Code: rpcResponse.Error.Code, Message: message}
	}
	if len(bytes.TrimSpace(rpcResponse.Result)) == 0 {
		return nil, response.Header, fmt.Errorf("%w: the server returned no result", ErrPlaygroundMCPUnavailable)
	}
	return rpcResponse, response.Header, nil
}

// parsePlaygroundMCPSSE reads a bounded stream and returns the JSON-RPC reply
// whose id matches the request. Server notifications and requests are ignored:
// the Playground client supports tools only, not sampling or elicitation.
func parsePlaygroundMCPSSE(body []byte, requestID string) (*playgroundMCPRPCResponse, error) {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 0, 64<<10), playgroundMCPMaxResponseBytes)
	var data strings.Builder
	flush := func() (*playgroundMCPRPCResponse, bool) {
		if data.Len() == 0 {
			return nil, false
		}
		payload := data.String()
		data.Reset()
		var response playgroundMCPRPCResponse
		if err := common.UnmarshalJsonStr(payload, &response); err != nil {
			return nil, false
		}
		if !playgroundMCPResponseMatchesID(&response, requestID) {
			return nil, false
		}
		return &response, true
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if response, matched := flush(); matched {
				return response, nil
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			value := strings.TrimPrefix(line, "data:")
			value = strings.TrimPrefix(value, " ")
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(value)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("%w: unable to parse the event stream", ErrPlaygroundMCPUnavailable)
	}
	if response, matched := flush(); matched {
		return response, nil
	}
	return nil, fmt.Errorf("%w: no response matching the request id", ErrPlaygroundMCPUnavailable)
}

func playgroundMCPResponseMatchesID(response *playgroundMCPRPCResponse, requestID string) bool {
	if response == nil || len(bytes.TrimSpace(response.ID)) == 0 {
		return false
	}
	var value any
	if err := common.Unmarshal(response.ID, &value); err != nil {
		return false
	}
	id, ok := value.(string)
	return ok && id == requestID
}

func playgroundMCPErrorSummary(err error) string {
	var rpc *PlaygroundMCPRPCError
	if errors.As(err, &rpc) {
		return fmt.Sprintf("JSON-RPC error %d", rpc.Code)
	}
	var status *playgroundMCPHTTPStatusError
	if errors.As(err, &status) {
		return fmt.Sprintf("HTTP %d", status.StatusCode)
	}
	switch {
	case errors.Is(err, ErrPlaygroundMCPTimeout):
		return "timeout"
	case errors.Is(err, ErrPlaygroundMCPResponseTooLarge):
		return "response too large"
	case errors.Is(err, ErrPlaygroundMCPInvalidRequest):
		return "invalid request"
	default:
		return "request failed"
	}
}
