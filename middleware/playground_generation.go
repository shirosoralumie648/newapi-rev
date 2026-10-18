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
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/group_setting"

	"github.com/gin-gonic/gin"
)

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
