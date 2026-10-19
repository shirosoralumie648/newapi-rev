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
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/playground_setting"
)

// Bounds of one browser-triggered search. The query is a chat turn, not a
// document, and the normalized result list is injected into the next model
// request, so every field has an explicit ceiling.
const (
	PlaygroundSearchMaxQueryRunes      = 512
	PlaygroundSearchMaxResults         = 6
	PlaygroundSearchMaxProviderBytes   = 2 << 20
	PlaygroundSearchMaxResultListBytes = 24 << 10
	playgroundSearchMaxTitleBytes      = 300
	playgroundSearchMaxSnippetBytes    = 1200
	playgroundSearchMaxURLBytes        = 4096
	playgroundSearchTimeout            = 12 * time.Second
)

var (
	// ErrPlaygroundSearchDisabled rejects a search while the administrator
	// keeps the feature switched off.
	ErrPlaygroundSearchDisabled = errors.New("playground web search is disabled")
	// ErrPlaygroundSearchInvalidQuery rejects an empty or oversized query.
	ErrPlaygroundSearchInvalidQuery = errors.New("invalid playground web search query")
	// ErrPlaygroundSearchNotConfigured marks a usable provider that still
	// lacks its endpoint or credential.
	ErrPlaygroundSearchNotConfigured = errors.New("playground web search is not configured")
	// ErrPlaygroundSearchProvider wraps any failed upstream search request.
	ErrPlaygroundSearchProvider = errors.New("playground web search provider failed")
)

// PlaygroundSearchResult is the normalized shape injected into the next
// request and echoed to the browser. It deliberately carries no provider
// score, raw HTML or upstream payload.
type PlaygroundSearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

// PlaygroundSearchResponse is one successful, billable provider call.
type PlaygroundSearchResponse struct {
	Query    string                   `json:"query"`
	Provider string                   `json:"provider"`
	Results  []PlaygroundSearchResult `json:"results"`
}

// playgroundSearchCandidate is the adapter boundary: each provider maps its
// payload into this shape and the shared normalizer applies every limit.
type playgroundSearchCandidate struct {
	Title   string
	URL     string
	Snippet string
}

var playgroundSearchHTMLTag = regexp.MustCompile(`</?[a-zA-Z][^>]*>`)

var playgroundSearchHTTPClient = &http.Client{
	Timeout: playgroundSearchTimeout,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// RunPlaygroundWebSearch performs one provider call and returns a bounded,
// normalized result list. The function is pure provider IO: wallet holds,
// settlement and consume logs belong to the caller so a failed call can be
// refunded without recording a charge.
func RunPlaygroundWebSearch(ctx context.Context, query string) (PlaygroundSearchResponse, error) {
	setting := playground_setting.GetPlaygroundWebSearchSetting()
	if !setting.IsEnabled() {
		return PlaygroundSearchResponse{}, ErrPlaygroundSearchDisabled
	}
	query = strings.TrimSpace(query)
	if query == "" || utf8.RuneCountInString(query) > PlaygroundSearchMaxQueryRunes {
		return PlaygroundSearchResponse{}, ErrPlaygroundSearchInvalidQuery
	}

	provider := strings.TrimSpace(setting.Provider)
	endpoint, err := playgroundSearchEndpoint(provider, setting.BaseURL)
	if err != nil {
		return PlaygroundSearchResponse{}, err
	}
	apiKey := playground_setting.GetPlaygroundWebSearchAPIKey()
	if provider != playground_setting.PlaygroundWebSearchProviderSearXNG && apiKey == "" {
		return PlaygroundSearchResponse{}, fmt.Errorf("%w: %s API key is empty", ErrPlaygroundSearchNotConfigured, provider)
	}

	var candidates []playgroundSearchCandidate
	switch provider {
	case playground_setting.PlaygroundWebSearchProviderTavily:
		candidates, err = playgroundSearchTavily(ctx, endpoint, apiKey, query)
	case playground_setting.PlaygroundWebSearchProviderSearXNG:
		candidates, err = playgroundSearchSearXNG(ctx, endpoint, apiKey, query)
	case playground_setting.PlaygroundWebSearchProviderBrave:
		candidates, err = playgroundSearchBrave(ctx, endpoint, apiKey, query)
	default:
		return PlaygroundSearchResponse{}, fmt.Errorf("%w: unknown provider %q", ErrPlaygroundSearchNotConfigured, provider)
	}
	if err != nil {
		return PlaygroundSearchResponse{}, err
	}

	return PlaygroundSearchResponse{
		Query:    query,
		Provider: provider,
		Results:  normalizePlaygroundSearchResults(candidates),
	}, nil
}

// playgroundSearchEndpoint resolves and validates the administrator-provided
// base URL, then appends the provider's fixed search path.
func playgroundSearchEndpoint(provider, configuredBaseURL string) (string, error) {
	baseURL := strings.TrimSpace(configuredBaseURL)
	if baseURL == "" {
		switch provider {
		case playground_setting.PlaygroundWebSearchProviderTavily:
			baseURL = "https://api.tavily.com"
		case playground_setting.PlaygroundWebSearchProviderBrave:
			baseURL = "https://api.search.brave.com"
		default:
			return "", fmt.Errorf("%w: SearXNG base URL is empty", ErrPlaygroundSearchNotConfigured)
		}
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || parsed.User != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("%w: invalid base URL", ErrPlaygroundSearchNotConfigured)
	}

	switch provider {
	case playground_setting.PlaygroundWebSearchProviderTavily:
		parsed.Path = path.Join(parsed.Path, "search")
	case playground_setting.PlaygroundWebSearchProviderSearXNG:
		parsed.Path = path.Join(parsed.Path, "search")
	case playground_setting.PlaygroundWebSearchProviderBrave:
		parsed.Path = path.Join(parsed.Path, "res/v1/web/search")
	default:
		return "", fmt.Errorf("%w: unknown provider %q", ErrPlaygroundSearchNotConfigured, provider)
	}
	return parsed.String(), nil
}

func playgroundSearchTavily(ctx context.Context, endpoint, apiKey, query string) ([]playgroundSearchCandidate, error) {
	body, err := common.Marshal(map[string]any{
		"query":               query,
		"max_results":         PlaygroundSearchMaxResults,
		"search_depth":        "basic",
		"include_answer":      false,
		"include_raw_content": false,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPlaygroundSearchProvider, err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPlaygroundSearchProvider, err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+apiKey)

	var response struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := doPlaygroundSearchRequest(request, &response); err != nil {
		return nil, err
	}
	candidates := make([]playgroundSearchCandidate, 0, len(response.Results))
	for _, result := range response.Results {
		candidates = append(candidates, playgroundSearchCandidate{
			Title:   result.Title,
			URL:     result.URL,
			Snippet: result.Content,
		})
	}
	return candidates, nil
}

func playgroundSearchSearXNG(ctx context.Context, endpoint, apiKey, query string) ([]playgroundSearchCandidate, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPlaygroundSearchProvider, err)
	}
	values := parsed.Query()
	values.Set("q", query)
	values.Set("format", "json")
	values.Set("categories", "general")
	parsed.RawQuery = values.Encode()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPlaygroundSearchProvider, err)
	}
	request.Header.Set("Accept", "application/json")
	if apiKey != "" {
		// SearXNG itself has no credential, but deployments commonly front it
		// with an API-key gate; send both common header conventions.
		request.Header.Set("X-API-Key", apiKey)
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}

	var response struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := doPlaygroundSearchRequest(request, &response); err != nil {
		return nil, err
	}
	candidates := make([]playgroundSearchCandidate, 0, len(response.Results))
	for _, result := range response.Results {
		candidates = append(candidates, playgroundSearchCandidate{
			Title:   result.Title,
			URL:     result.URL,
			Snippet: result.Content,
		})
	}
	return candidates, nil
}

func playgroundSearchBrave(ctx context.Context, endpoint, apiKey, query string) ([]playgroundSearchCandidate, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPlaygroundSearchProvider, err)
	}
	values := parsed.Query()
	values.Set("q", query)
	values.Set("count", fmt.Sprintf("%d", PlaygroundSearchMaxResults))
	values.Set("text_decorations", "false")
	parsed.RawQuery = values.Encode()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPlaygroundSearchProvider, err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Subscription-Token", apiKey)

	var response struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := doPlaygroundSearchRequest(request, &response); err != nil {
		return nil, err
	}
	candidates := make([]playgroundSearchCandidate, 0, len(response.Web.Results))
	for _, result := range response.Web.Results {
		candidates = append(candidates, playgroundSearchCandidate{
			Title:   result.Title,
			URL:     result.URL,
			Snippet: result.Description,
		})
	}
	return candidates, nil
}

func doPlaygroundSearchRequest(request *http.Request, target any) error {
	response, err := playgroundSearchHTTPClient.Do(request)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrPlaygroundSearchProvider, err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("%w: unexpected status %d", ErrPlaygroundSearchProvider, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, PlaygroundSearchMaxProviderBytes+1))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrPlaygroundSearchProvider, err)
	}
	if len(body) > PlaygroundSearchMaxProviderBytes {
		return fmt.Errorf("%w: response body exceeds %d bytes", ErrPlaygroundSearchProvider, PlaygroundSearchMaxProviderBytes)
	}
	if err := common.Unmarshal(body, target); err != nil {
		return fmt.Errorf("%w: %v", ErrPlaygroundSearchProvider, err)
	}
	return nil
}

func normalizePlaygroundSearchResults(candidates []playgroundSearchCandidate) []PlaygroundSearchResult {
	results := make([]PlaygroundSearchResult, 0, min(len(candidates), PlaygroundSearchMaxResults))
	seenURLs := make(map[string]bool, len(candidates))
	totalBytes := 0
	for _, candidate := range candidates {
		if len(results) >= PlaygroundSearchMaxResults {
			break
		}
		title := normalizePlaygroundSearchText(candidate.Title, playgroundSearchMaxTitleBytes)
		snippet := normalizePlaygroundSearchText(candidate.Snippet, playgroundSearchMaxSnippetBytes)
		resultURL := strings.TrimSpace(candidate.URL)
		if resultURL == "" || len(resultURL) > playgroundSearchMaxURLBytes || !validPlaygroundSearchURL(resultURL) || seenURLs[resultURL] {
			continue
		}
		size := len(title) + len(resultURL) + len(snippet)
		if totalBytes+size > PlaygroundSearchMaxResultListBytes {
			break
		}
		seenURLs[resultURL] = true
		totalBytes += size
		results = append(results, PlaygroundSearchResult{
			Title:   title,
			URL:     resultURL,
			Snippet: snippet,
		})
	}
	return results
}

func normalizePlaygroundSearchText(value string, maxBytes int) string {
	value = playgroundSearchHTMLTag.ReplaceAllString(value, " ")
	value = html.UnescapeString(value)
	// Search snippets are single lines in the injected prompt; collapsing
	// whitespace also removes the control characters a provider may return.
	value = strings.Join(strings.Fields(value), " ")
	if len(value) <= maxBytes {
		return value
	}
	for maxBytes > 0 && !utf8.RuneStart(value[maxBytes]) {
		maxBytes--
	}
	return strings.TrimSpace(value[:maxBytes])
}

func validPlaygroundSearchURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return false
	}
	return parsed.Scheme == "http" || parsed.Scheme == "https"
}
