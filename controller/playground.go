package controller

import (
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

// setupPlaygroundToken writes the authenticated account context and a synthetic
// in-memory token so a Playground request runs through the ordinary Relay,
// channel selection and billing pipeline without the browser ever holding an
// API key. The token is never persisted and never leaves the request context.
func setupPlaygroundToken(c *gin.Context, group string) error {
	userId := c.GetInt("id")
	if userId <= 0 {
		return errors.New("Authentication required.")
	}
	userCache, err := model.GetUserCache(userId)
	if err != nil {
		return err
	}
	userCache.WriteContext(c)

	// Write user context to ensure acceptUnsetRatio is available
	tempToken := &model.Token{
		UserId: userId,
		Name:   fmt.Sprintf("playground-%s", group),
		Group:  group,
	}
	return middleware.SetupContextForToken(c, tempToken)
}

// playgroundRelay runs one authenticated workspace request through the
// canonical relay pipeline with the requested format. The browser never holds
// an API key: the synthetic in-memory token makes group resolution, channel
// selection, limits and billing identical to a direct API call.
func playgroundRelay(c *gin.Context, relayFormat types.RelayFormat) {
	var newAPIError *types.NewAPIError

	defer func() {
		if newAPIError != nil {
			c.JSON(newAPIError.StatusCode, gin.H{
				"error": newAPIError.ToOpenAIError(common.UpstreamAddresses(c)...),
			})
		}
	}()

	useAccessToken := c.GetBool("use_access_token")
	if useAccessToken {
		newAPIError = types.NewError(errors.New(i18n.T(c, i18n.MsgRelayAccessTokenUnsupported)), types.ErrorCodeAccessDenied, types.ErrOptionWithSkipRetry())
		return
	}

	// Channel selection already resolved the group on this route, so the
	// synthetic token carries exactly the group the caller selected. Building a
	// relay info here would require the format-specific request, which the
	// relay parses itself.
	group := common.GetContextKeyString(c, constant.ContextKeyUsingGroup)
	if err := setupPlaygroundToken(c, group); err != nil {
		newAPIError = types.NewError(err, types.ErrorCodeQueryDataError, types.ErrOptionWithSkipRetry())
		return
	}

	// Mark the request as Playground-origin before the relay runs. The marker
	// only scopes log metadata (the settled consume/error rows carry
	// `other.playground_origin`) used by the read-only usage analytics; billing,
	// group resolution and channel selection are untouched.
	c.Set(string(constant.ContextKeyPlaygroundOrigin), true)

	Relay(c, relayFormat)
}

func Playground(c *gin.Context) {
	// The optional replay capture tees the response and stores a desensitized
	// summary after the relay returned. With PLAYGROUND_LOG_CAPTURE off (the
	// default) nothing is buffered or stored.
	capture := service.BeginPlaygroundLogCapture(c)
	if capture != nil {
		capture.TeeResponse(c)
		defer capture.Finish(c)
	}
	playgroundRelay(c, types.RelayFormatOpenAI)
}

// PlaygroundResponses serves the Responses protocol through the canonical
// /v1/responses pipeline. The bridge rewrites the path and the relay parses and
// bills the request exactly like a direct API call.
func PlaygroundResponses(c *gin.Context) {
	playgroundRelay(c, types.RelayFormatOpenAIResponses)
}

// PlaygroundMessages serves the Anthropic Messages protocol through the
// canonical /v1/messages pipeline with the same group, channel selection and
// billing rules as a direct API call.
func PlaygroundMessages(c *gin.Context) {
	playgroundRelay(c, types.RelayFormatClaude)
}

// PlaygroundEmbeddings serves the workspace knowledge indexer through the
// canonical /v1/embeddings pipeline. The route stays behind UserAuth, so the
// request is billed, grouped and channel-selected exactly like a direct call.
func PlaygroundEmbeddings(c *gin.Context) {
	playgroundRelay(c, types.RelayFormatEmbedding)
}

// PlaygroundRerank serves the non-chat model workbench through the canonical
// /v1/rerank pipeline.
func PlaygroundRerank(c *gin.Context) {
	playgroundRelay(c, types.RelayFormatRerank)
}

// PlaygroundModerations serves the non-chat model workbench through the
// canonical /v1/moderations pipeline. Moderation uses the OpenAI relay format,
// matching the direct route.
func PlaygroundModerations(c *gin.Context) {
	playgroundRelay(c, types.RelayFormatOpenAI)
}
