package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCountClaudeTokensReturnsInputTokensWhenRelayCountingDisabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	originalCountToken := constant.CountToken
	constant.CountToken = false
	t.Cleanup(func() {
		constant.CountToken = originalCountToken
	})

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(
		http.MethodPost,
		"/v1/messages/count_tokens?beta=true",
		strings.NewReader(`{
			"model":"gemini-3.6-flash",
			"messages":[{"role":"user","content":"count this prompt"}],
			"tools":[{"name":"lookup","description":"Look up a value","input_schema":{"type":"object","properties":{"query":{"type":"string"}}}}]
		}`),
	)
	ctx.Request.Header.Set("Content-Type", "application/json")
	common.SetContextKey(ctx, constant.ContextKeyOriginalModel, "gemini-3.6-flash")

	CountClaudeTokens(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		InputTokens int `json:"input_tokens"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.Positive(t, response.InputTokens)
}

func TestCountClaudeTokensRejectsInvalidRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name    string
		body    string
		message string
	}{
		{
			name:    "messages are required",
			body:    `{"model":"gemini-3.6-flash"}`,
			message: "messages",
		},
		{
			name:    "model is required",
			body:    `{"messages":[{"role":"user","content":"count this"}]}`,
			message: "model",
		},
		{
			name: "malformed json is a client error",
			body: `{"model":`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(
				http.MethodPost,
				"/v1/messages/count_tokens",
				strings.NewReader(test.body),
			)
			ctx.Request.Header.Set("Content-Type", "application/json")

			CountClaudeTokens(ctx)

			require.Equal(t, http.StatusBadRequest, recorder.Code)
			var response struct {
				Type  string `json:"type"`
				Error struct {
					Type    string `json:"type"`
					Message string `json:"message"`
				} `json:"error"`
			}
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			assert.Equal(t, "error", response.Type)
			assert.Equal(t, "invalid_request_error", response.Error.Type)
			if test.message != "" {
				assert.Contains(t, response.Error.Message, test.message)
			}
		})
	}
}

// TestCountClaudeTokensCountsMessagesSystemAndToolsLocally locks in the local
// estimator contract: the endpoint reads the request alone (no channel and no
// upstream are prepared here) and every part of the Claude payload contributes
// to input_tokens.
func TestCountClaudeTokensCountsMessagesSystemAndToolsLocally(t *testing.T) {
	gin.SetMode(gin.TestMode)

	count := func(body string) int {
		recorder := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(recorder)
		ctx.Request = httptest.NewRequest(
			http.MethodPost,
			"/v1/messages/count_tokens",
			strings.NewReader(body),
		)
		ctx.Request.Header.Set("Content-Type", "application/json")
		common.SetContextKey(ctx, constant.ContextKeyOriginalModel, "claude-sonnet-4-5-20250929")

		CountClaudeTokens(ctx)

		require.Equal(t, http.StatusOK, recorder.Code)
		var response struct {
			InputTokens int `json:"input_tokens"`
		}
		require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
		assert.NotContains(t, recorder.Body.String(), "error")
		return response.InputTokens
	}

	plain := count(`{"model":"claude-sonnet-4-5-20250929","messages":[{"role":"user","content":"count this prompt"}]}`)
	require.Positive(t, plain)

	withSystem := count(`{
		"model":"claude-sonnet-4-5-20250929",
		"system":[{"type":"text","text":"You are a careful assistant that answers briefly and precisely."}],
		"messages":[{"role":"user","content":"count this prompt"}]
	}`)
	assert.Greater(t, withSystem, plain, "system text is part of the estimate")

	withTools := count(`{
		"model":"claude-sonnet-4-5-20250929",
		"messages":[{"role":"user","content":"count this prompt"}],
		"tools":[{"name":"lookup","description":"Look up a value in the catalogue","input_schema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}]
	}`)
	assert.Greater(t, withTools, plain, "tool schemas are counted, not dropped")

	withImage := count(`{
		"model":"claude-sonnet-4-5-20250929",
		"messages":[{"role":"user","content":[
			{"type":"text","text":"what is this"},
			{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}}
		]}]
	}`)
	assert.Greater(t, withImage, plain, "images contribute a local estimate")
}
