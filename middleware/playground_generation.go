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
package middleware

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/group_setting"

	"github.com/gin-gonic/gin"
)

const (
	playgroundGenerationSizeMin = 64
	playgroundGenerationSizeMax = 8192
	playgroundGenerationSeedMax = 1<<31 - 1
	// playgroundGenerationPromptMaxRunes bounds the display-only prompt that is
	// copied into task metadata. It is deliberately generous for a real prompt
	// while keeping one task row from retaining an unbounded request body.
	playgroundGenerationPromptMaxRunes = 2000

	playgroundGenerationSizeMessage = "The size must use WIDTHxHEIGHT with each side between 64 and 8192 pixels."
	playgroundGenerationSeedMessage = "The seed must be an integer between 1 and 2147483647."
)

var playgroundGenerationSizePattern = regexp.MustCompile(`^([0-9]+)[xX]([0-9]+)$`)

// playgroundGenerationSizeValid accepts provider size labels ("auto", "1K",
// "16:9") unchanged and bounds only explicit WIDTHxHEIGHT values, which are the
// custom sizes the canvas sends.
func playgroundGenerationSizeValid(size string) bool {
	size = strings.TrimSpace(size)
	if size == "" || !strings.ContainsAny(size, "xX×") {
		return true
	}
	match := playgroundGenerationSizePattern.FindStringSubmatch(size)
	if match == nil {
		return false
	}
	width, err := strconv.Atoi(match[1])
	if err != nil || width < playgroundGenerationSizeMin || width > playgroundGenerationSizeMax {
		return false
	}
	height, err := strconv.Atoi(match[2])
	if err != nil || height < playgroundGenerationSizeMin || height > playgroundGenerationSizeMax {
		return false
	}
	return true
}

func playgroundGenerationSeedValid(raw json.RawMessage) bool {
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return false
	}
	seed, err := strconv.ParseInt(text, 10, 64)
	return err == nil && seed >= 1 && seed <= playgroundGenerationSeedMax
}

// validatePlaygroundGenerationParameters rejects malformed seed and custom
// size values with a stable 400 before channel selection and billing start.
// The body is read through the reusable storage, so the relay still receives
// the original bytes.
func validatePlaygroundGenerationParameters(c *gin.Context, canonicalPath string) bool {
	if canonicalPath != "/v1/images/generations" && canonicalPath != "/v1/videos" {
		return true
	}
	if !strings.HasPrefix(c.Request.Header.Get("Content-Type"), "application/json") {
		return true
	}
	var request map[string]json.RawMessage
	if err := common.UnmarshalBodyReusable(c, &request); err != nil {
		abortWithOpenAiMessage(c, http.StatusBadRequest, i18n.T(c, i18n.MsgDistributorInvalidRequest, map[string]any{"Error": err.Error()}), types.ErrorCodeInvalidRequest)
		return false
	}
	if raw, exists := request["size"]; exists && string(raw) != "null" {
		var size string
		if err := common.Unmarshal(raw, &size); err != nil || !playgroundGenerationSizeValid(size) {
			abortWithOpenAiMessage(c, http.StatusBadRequest, playgroundGenerationSizeMessage, types.ErrorCodeInvalidRequest)
			return false
		}
	}
	if raw, exists := request["seed"]; exists && string(raw) != "null" {
		if !playgroundGenerationSeedValid(raw) {
			abortWithOpenAiMessage(c, http.StatusBadRequest, playgroundGenerationSeedMessage, types.ErrorCodeInvalidRequest)
			return false
		}
	}
	common.SetContextKey(c, constant.ContextKeyPlaygroundGenerationParams, playgroundGenerationSnapshot(canonicalPath, request))
	return true
}

// playgroundGenerationSnapshot copies the display fields of a validated image
// or video request. Only request metadata is read here: the body has already
// been parsed once for validation, and nothing is added to what the relay
// forwards upstream. Credentials or provider-specific extensions are never
// part of this shape.
func playgroundGenerationSnapshot(canonicalPath string, request map[string]json.RawMessage) *model.TaskGenerationParams {
	kind := "image"
	if canonicalPath == "/v1/videos" {
		kind = "video"
	}
	prompt := []rune(playgroundGenerationString(request, "prompt"))
	if len(prompt) > playgroundGenerationPromptMaxRunes {
		prompt = prompt[:playgroundGenerationPromptMaxRunes]
	}
	params := &model.TaskGenerationParams{
		Kind:    kind,
		Prompt:  string(prompt),
		Model:   playgroundGenerationString(request, "model"),
		Size:    playgroundGenerationString(request, "size"),
		Quality: playgroundGenerationString(request, "quality"),
	}
	if raw, exists := request["seed"]; exists && string(raw) != "null" {
		var seed int64
		if err := common.Unmarshal(raw, &seed); err == nil && seed >= 1 && seed <= playgroundGenerationSeedMax {
			params.Seed = &seed
		}
	}
	if count, ok := playgroundGenerationNumber(request, "n"); ok && count >= 1 {
		params.Count = min(int(count), dto.MaxImageN)
	}
	if duration, ok := playgroundGenerationNumber(request, "duration"); ok && duration > 0 {
		params.Duration = int(duration)
	} else if duration, ok := playgroundGenerationNumber(request, "seconds"); ok && duration > 0 {
		params.Duration = int(duration)
	}
	return params
}

func playgroundGenerationString(request map[string]json.RawMessage, field string) string {
	raw, exists := request[field]
	if !exists || string(raw) == "null" {
		return ""
	}
	var value string
	if err := common.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func playgroundGenerationNumber(request map[string]json.RawMessage, field string) (float64, bool) {
	raw, exists := request[field]
	if !exists || string(raw) == "null" {
		return 0, false
	}
	var value float64
	if err := common.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

// PlaygroundRelayBridge bridges one workspace media route to its canonical /v1
// path before plugin endpoint pinning and channel selection run. Pinning,
// request-path filters and relay-mode detection all match on the canonical
// path, so rewriting it here keeps a Playground request identical to a direct
// API call while the route itself stays behind UserAuth and the Playground
// group override.
//
// The optional `group` member of a JSON request body selects the group the
// caller may already use, exactly like the chat workspace: the override is
// validated against the account's usable groups and never widens access. A
// multipart request (audio dictation) has no JSON member, so it names the
// override in the X-Playground-Group header instead; either way the override
// is consumed here and can never leak into the upstream request.
func PlaygroundRelayBridge(canonicalPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !strings.HasPrefix(c.Request.URL.Path, "/pg/") {
			c.Next()
			return
		}
		if !consumePlaygroundWorkflowRun(c) {
			return
		}
		if !validatePlaygroundGenerationParameters(c, canonicalPath) {
			return
		}
		requestedGroup := strings.TrimSpace(c.Request.Header.Get("X-Playground-Group"))
		c.Request.Header.Del("X-Playground-Group")
		if requestedGroup == "" && strings.HasPrefix(c.Request.Header.Get("Content-Type"), "application/json") {
			request := &dto.PlayGroundRequest{}
			if err := common.UnmarshalBodyReusable(c, request); err == nil && request.Group != "" {
				requestedGroup = request.Group
			}
		}
		if requestedGroup != "" {
			usingGroup := common.GetContextKeyString(c, constant.ContextKeyUsingGroup)
			// A submitted display name is resolved to the stable identifier
			// before it reaches channel selection and billing.
			group := group_setting.ResolveGroupID(requestedGroup)
			if !service.GroupInUserUsableGroups(usingGroup, group) && group != usingGroup {
				abortWithOpenAiMessage(c, http.StatusForbidden, i18n.T(c, i18n.MsgDistributorGroupAccessDenied))
				return
			}
			common.SetContextKey(c, constant.ContextKeyUsingGroup, group)
		}
		c.Request.URL.Path = canonicalPath
		c.Next()
	}
}

// PlaygroundWorkflowRunHeader names the run budget a workspace canvas step
// bills against (BL-03). The header is workspace-only: it is validated, stored
// in the request context and removed before anything else sees the request.
const PlaygroundWorkflowRunHeader = "X-Playground-Workflow-Run"

// playgroundWorkflowRunPrefix marks the server-generated run ids the workspace
// receives from POST /api/playground/workflows/runs.
const playgroundWorkflowRunPrefix = "pgw_"

// playgroundWorkflowRunMaxLength bounds the accepted run id, matching the
// wallet hold request id column.
const playgroundWorkflowRunMaxLength = 64

// validPlaygroundWorkflowRunId accepts only the ids this server generates, so a
// forged header can never name a hold that belongs to something else.
func validPlaygroundWorkflowRunId(runId string) bool {
	if len(runId) <= len(playgroundWorkflowRunPrefix) || len(runId) > playgroundWorkflowRunMaxLength {
		return false
	}
	if !strings.HasPrefix(runId, playgroundWorkflowRunPrefix) {
		return false
	}
	for _, character := range runId[len(playgroundWorkflowRunPrefix):] {
		switch {
		case character >= 'a' && character <= 'z':
		case character >= 'A' && character <= 'Z':
		case character >= '0' && character <= '9':
		case character == '_' || character == '-':
		default:
			return false
		}
	}
	return true
}

// consumePlaygroundWorkflowRun reads, validates and removes the run budget
// header. It aborts the request with a stable error code when a workspace step
// carries a malformed run id, so a client bug can never silently bill the step
// outside its budget. It reports whether the request may continue.
func consumePlaygroundWorkflowRun(c *gin.Context) bool {
	runId := strings.TrimSpace(c.Request.Header.Get(PlaygroundWorkflowRunHeader))
	c.Request.Header.Del(PlaygroundWorkflowRunHeader)
	if runId == "" {
		return true
	}
	if !validPlaygroundWorkflowRunId(runId) {
		abortWithOpenAiMessage(c, http.StatusBadRequest, i18n.T(c, i18n.MsgDistributorInvalidRequest, map[string]any{"Error": "invalid workflow run id"}), types.ErrorCodeWorkflowBudgetExceeded)
		return false
	}
	common.SetContextKey(c, constant.ContextKeyPlaygroundWorkflowRun, runId)
	return true
}

// PlaygroundWorkflowRun consumes the run budget header on the workspace chat
// route, which is not served through PlaygroundRelayBridge.
func PlaygroundWorkflowRun() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !consumePlaygroundWorkflowRun(c) {
			return
		}
		c.Next()
	}
}
