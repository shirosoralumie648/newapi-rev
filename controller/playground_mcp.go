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

package controller

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/gin-gonic/gin"
)

const (
	playgroundMCPDisabledErrorCode       = "PLAYGROUND_MCP_DISABLED"
	playgroundMCPNotFoundErrorCode       = "PLAYGROUND_MCP_SERVER_NOT_FOUND"
	playgroundMCPServerDisabledErrorCode = "PLAYGROUND_MCP_SERVER_DISABLED"
	playgroundMCPInvalidRequestErrorCode = "PLAYGROUND_MCP_INVALID_REQUEST"
	playgroundMCPUnavailableErrorCode    = "PLAYGROUND_MCP_UNAVAILABLE"
	playgroundMCPTimeoutErrorCode        = "PLAYGROUND_MCP_TIMEOUT"
	playgroundMCPCallRequestMaxBytes     = 96 << 10
	playgroundMCPAdminRequestMaxBytes    = 128 << 10
)

type playgroundMCPCallRequest struct {
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
}

// ListPlaygroundMCPServers returns the tool catalog of every enabled global
// MCP connection. Endpoints and credentials stay on the gateway. A connection
// whose catalog cannot be read is returned with an empty tool list and
// available=false; the other connections stay usable.
func ListPlaygroundMCPServers(c *gin.Context) {
	if c.GetInt("id") <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	if !playground_setting.IsPlaygroundMCPEnabled() {
		writePlaygroundGenerationError(c, http.StatusForbidden, playgroundMCPDisabledErrorCode, "MCP tools are disabled.")
		return
	}
	servers, err := service.ListPlaygroundMCPServers(c.Request.Context())
	if err != nil {
		if errors.Is(err, service.ErrPlaygroundMCPDisabled) {
			writePlaygroundGenerationError(c, http.StatusForbidden, playgroundMCPDisabledErrorCode, "MCP tools are disabled.")
			return
		}
		common.SysError(common.LogText("playground MCP tool list failed"))
		writePlaygroundGenerationError(c, http.StatusInternalServerError, playgroundMCPUnavailableErrorCode, "MCP tools are temporarily unavailable.")
		return
	}
	common.ApiSuccess(c, gin.H{
		"enabled": true,
		"servers": servers,
	})
}

// CallPlaygroundMCPTool proxies one tools/call to an enabled global MCP
// connection. The browser can name only a configured connection and a tool;
// the method is fixed by the gateway, and endpoints and credentials never
// leave the server.
func CallPlaygroundMCPTool(c *gin.Context) {
	serverID := strings.TrimSpace(c.Param("serverId"))
	if serverID == "" {
		writePlaygroundGenerationError(c, http.StatusBadRequest, playgroundMCPInvalidRequestErrorCode, "Invalid MCP request.")
		return
	}
	var request playgroundMCPCallRequest
	if !decodePlaygroundRequest(c, &request, playgroundMCPCallRequestMaxBytes) {
		return
	}
	request.Tool = strings.TrimSpace(request.Tool)
	if request.Tool == "" {
		writePlaygroundGenerationError(c, http.StatusBadRequest, playgroundMCPInvalidRequestErrorCode, "Invalid MCP request.")
		return
	}
	if len(request.Arguments) == 0 {
		request.Arguments = json.RawMessage(`{}`)
	}
	result, err := service.CallPlaygroundMCPTool(c.Request.Context(), serverID, request.Tool, request.Arguments)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrPlaygroundMCPDisabled):
			writePlaygroundGenerationError(c, http.StatusForbidden, playgroundMCPDisabledErrorCode, "MCP tools are disabled.")
		case errors.Is(err, service.ErrPlaygroundMCPServerNotFound):
			writePlaygroundGenerationError(c, http.StatusNotFound, playgroundMCPNotFoundErrorCode, "The MCP server is not available.")
		case errors.Is(err, service.ErrPlaygroundMCPServerDisabled):
			writePlaygroundGenerationError(c, http.StatusForbidden, playgroundMCPServerDisabledErrorCode, "The MCP server is disabled.")
		case errors.Is(err, service.ErrPlaygroundMCPInvalidRequest):
			writePlaygroundGenerationError(c, http.StatusBadRequest, playgroundMCPInvalidRequestErrorCode, "Invalid MCP request.")
		case errors.Is(err, service.ErrPlaygroundMCPTimeout):
			common.SysError(common.LogText("playground MCP call timed out for server %s", serverID))
			writePlaygroundGenerationError(c, http.StatusGatewayTimeout, playgroundMCPTimeoutErrorCode, "The MCP server did not answer in time.")
		case errors.Is(err, service.ErrPlaygroundMCPResponseTooLarge):
			common.SysError(common.LogText("playground MCP call response exceeded the size limit for server %s", serverID))
			writePlaygroundGenerationError(c, http.StatusBadGateway, playgroundMCPUnavailableErrorCode, "The MCP server returned an unusable response.")
		default:
			common.SysError(common.LogText("playground MCP call failed for server %s", serverID))
			writePlaygroundGenerationError(c, http.StatusBadGateway, playgroundMCPUnavailableErrorCode, "The MCP server is temporarily unavailable.")
		}
		return
	}
	common.ApiSuccess(c, result)
}

// UpdatePlaygroundMCP saves the administrator-managed MCP connection list and
// its credentials atomically. A blank token keeps the stored one; an explicit
// clear_token removes it. The option response redacts every token afterwards.
func UpdatePlaygroundMCP(c *gin.Context) {
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, playgroundMCPAdminRequestMaxBytes))
	if err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	var request struct {
		MCP string `json:"mcp"`
	}
	if err := common.Unmarshal(body, &request); err != nil || strings.TrimSpace(request.MCP) == "" {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	merged, err := playground_setting.MergePlaygroundMCPJSON(request.MCP, playground_setting.GetPlaygroundMCPSetting())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if err := playground_setting.ValidatePlaygroundMCPJSON(merged); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.UpdateOptionsBulk(map[string]string{
		playground_setting.PlaygroundMCPOptionKey: merged,
	}); err != nil {
		common.ApiError(c, err)
		return
	}
	service.ResetPlaygroundMCPToolCache()
	recordManageAudit(c, "option.update", map[string]any{
		"key": playground_setting.PlaygroundMCPOptionKey,
	})
	common.ApiSuccessT(c, "MCP settings saved", nil)
}
