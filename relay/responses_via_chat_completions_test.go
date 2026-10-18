package relay

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	relaytypes "github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/model_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newResponsesDowngradeTestContext(t *testing.T, upstreamURL string, request *dto.OpenAIResponsesRequest) (*gin.Context, *relaycommon.RelayInfo, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	c.Request.Header.Set("Content-Type", "application/json")
	common.SetContextKey(c, constant.ContextKeyOriginalModel, request.Model)
	common.SetContextKey(c, constant.ContextKeyChannelType, constant.ChannelTypeOpenAI)
	common.SetContextKey(c, constant.ContextKeyChannelBaseUrl, upstreamURL)
	common.SetContextKey(c, constant.ContextKeyChannelKey, "test-key")
	info := relaycommon.GenRelayInfoResponses(c, request)
	info.InitChannelMeta(c)
	return c, info, recorder
}

func TestResponsesViaChatCompletionsConvertsRequestAndResponse(t *testing.T) {
	type capturedRequest struct {
		path string
		body []byte
	}
	captured := make(chan capturedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		captured <- capturedRequest{path: r.URL.Path, body: body}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl_1","object":"chat.completion","model":"gpt-4o","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`))
	}))
	defer server.Close()

	request := &dto.OpenAIResponsesRequest{Model: "gpt-4o", Input: []byte(`"hello"`)}
	c, info, recorder := newResponsesDowngradeTestContext(t, server.URL, request)

	usage, apiErr := responsesViaChatCompletions(c, info, request)

	require.Nil(t, apiErr)
	require.NotNil(t, usage)
	assert.Equal(t, 5, usage.TotalTokens)
	assert.Equal(t, []relaytypes.RelayFormat{relaytypes.RelayFormatOpenAIResponses, relaytypes.RelayFormatOpenAI}, info.RequestConversionChain)

	upstream := <-captured
	assert.Equal(t, "/v1/chat/completions", upstream.path)
	var upstreamRequest dto.GeneralOpenAIRequest
	require.NoError(t, common.Unmarshal(upstream.body, &upstreamRequest))
	require.Len(t, upstreamRequest.Messages, 1)
	assert.Equal(t, "hello", upstreamRequest.Messages[0].StringContent())

	var response dto.OpenAIResponsesResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.Equal(t, "ok", service.ExtractOutputTextFromResponses(&response))
}

func TestResponsesViaChatCompletionsRejectsUnsupportedStatefulFields(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	request := &dto.OpenAIResponsesRequest{
		Model:              "gpt-4o",
		Input:              []byte(`"hello"`),
		PreviousResponseID: "resp_prev",
	}
	c, info, _ := newResponsesDowngradeTestContext(t, server.URL, request)

	usage, apiErr := responsesViaChatCompletions(c, info, request)

	require.Nil(t, usage)
	require.NotNil(t, apiErr)
	assert.Equal(t, http.StatusBadRequest, apiErr.StatusCode)
	assert.Contains(t, apiErr.Error(), "previous_response_id")
	assert.Equal(t, int32(0), calls.Load())
}

func TestShouldResponsesUseChatCompletionsPolicyMatchesChannelAndModel(t *testing.T) {
	tests := []struct {
		name        string
		policy      model_setting.ResponsesToChatCompletionsPolicy
		channelID   int
		channelType int
		model       string
		want        bool
	}{
		{
			name:        "disabled policy never matches",
			policy:      model_setting.ResponsesToChatCompletionsPolicy{Enabled: false, AllChannels: true},
			channelID:   1,
			channelType: constant.ChannelTypeOpenAI,
			model:       "gpt-4o",
			want:        false,
		},
		{
			name:        "all channels with matching model pattern",
			policy:      model_setting.ResponsesToChatCompletionsPolicy{Enabled: true, AllChannels: true, ModelPatterns: []string{"^gpt-4o"}},
			channelID:   1,
			channelType: constant.ChannelTypeOpenAI,
			model:       "gpt-4o-mini",
			want:        true,
		},
		{
			name:        "all channels with non matching model pattern",
			policy:      model_setting.ResponsesToChatCompletionsPolicy{Enabled: true, AllChannels: true, ModelPatterns: []string{"^gpt-4o"}},
			channelID:   1,
			channelType: constant.ChannelTypeOpenAI,
			model:       "claude-3-5-sonnet",
			want:        false,
		},
		{
			name:        "no model pattern never matches",
			policy:      model_setting.ResponsesToChatCompletionsPolicy{Enabled: true, AllChannels: true},
			channelID:   1,
			channelType: constant.ChannelTypeOpenAI,
			model:       "gpt-4o",
			want:        false,
		},
		{
			name:        "selected channel id matches",
			policy:      model_setting.ResponsesToChatCompletionsPolicy{Enabled: true, ChannelIDs: []int{7}, ModelPatterns: []string{"^gpt-4o"}},
			channelID:   7,
			channelType: constant.ChannelTypeOpenAI,
			model:       "gpt-4o",
			want:        true,
		},
		{
			name:        "unselected channel id does not match",
			policy:      model_setting.ResponsesToChatCompletionsPolicy{Enabled: true, ChannelIDs: []int{7}, ModelPatterns: []string{"^gpt-4o"}},
			channelID:   8,
			channelType: constant.ChannelTypeOpenAI,
			model:       "gpt-4o",
			want:        false,
		},
		{
			name:        "selected channel type matches",
			policy:      model_setting.ResponsesToChatCompletionsPolicy{Enabled: true, ChannelTypes: []int{constant.ChannelTypeOpenAI}, ModelPatterns: []string{"^gpt-4o"}},
			channelID:   1,
			channelType: constant.ChannelTypeOpenAI,
			model:       "gpt-4o",
			want:        true,
		},
		{
			name:        "channel outside the selectors does not match",
			policy:      model_setting.ResponsesToChatCompletionsPolicy{Enabled: true, ChannelIDs: []int{7}, ChannelTypes: []int{constant.ChannelTypeAzure}, ModelPatterns: []string{"^gpt-4o"}},
			channelID:   1,
			channelType: constant.ChannelTypeOpenAI,
			model:       "gpt-4o",
			want:        false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, service.ShouldResponsesUseChatCompletionsPolicy(tt.policy, tt.channelID, tt.channelType, tt.model))
		})
	}
}
