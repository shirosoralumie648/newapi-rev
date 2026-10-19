package controller

import (
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"

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
func playgroundRelay(c *gin.Context, relayFormat string) {
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

	relayInfo, err := relaycommon.GenRelayInfo(c, relayFormat, nil, nil)
	if err != nil {
		newAPIError = types.NewError(err, types.ErrorCodeInvalidRequest, types.ErrOptionWithSkipRetry())
		return
	}

	if err := setupPlaygroundToken(c, relayInfo.UsingGroup); err != nil {
		newAPIError = types.NewError(err, types.ErrorCodeQueryDataError, types.ErrOptionWithSkipRetry())
		return
	}

	Relay(c, relayFormat)
}

func Playground(c *gin.Context) {
	playgroundRelay(c, types.RelayFormatOpenAI)
}

// PlaygroundEmbeddings serves the workspace knowledge indexer through the
// canonical /v1/embeddings pipeline. The route stays behind UserAuth, so the
// request is billed, grouped and channel-selected exactly like a direct call.
func PlaygroundEmbeddings(c *gin.Context) {
	playgroundRelay(c, types.RelayFormatEmbedding)
}
