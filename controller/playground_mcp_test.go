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
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func playgroundMCPAdminRequest(t *testing.T, router *gin.Engine, mcp string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := common.Marshal(map[string]string{"mcp": mcp})
	require.NoError(t, err)
	request := httptest.NewRequest(http.MethodPut, "/api/option/playground/mcp", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func storedPlaygroundMCPOption(t *testing.T, db *gorm.DB) string {
	t.Helper()
	var option model.Option
	require.NoError(t, db.Where("key = ?", playground_setting.PlaygroundMCPOptionKey).First(&option).Error)
	return option.Value
}

// The administrator save owns two contracts the service helpers cannot prove:
// an edited list is merged into the persisted option, and the ordinary option
// read never returns a stored credential.
func TestPlaygroundMCPAdminSettingsPersistAndRedactTokens(t *testing.T) {
	db, _ := setupPlaygroundSearchTest(t)
	previousMap := common.OptionMap
	common.OptionMap = make(map[string]string)
	previousMCP := playground_setting.GetPlaygroundSetting().MCP
	playground_setting.GetPlaygroundSetting().MCP = nil
	t.Cleanup(func() {
		common.OptionMap = previousMap
		playground_setting.GetPlaygroundSetting().MCP = previousMCP
	})

	router := gin.New()
	router.PUT("/api/option/playground/mcp", func(c *gin.Context) {
		c.Set("id", 1)
		c.Set("role", common.RoleAdminUser)
		c.Next()
	}, UpdatePlaygroundMCP)
	router.GET("/api/option/", GetOptions)

	response := playgroundMCPAdminRequest(t, router, `{
		"enabled": true,
		"servers": [{"id":"docs","name":"Docs","url":"https://mcp.example.com/mcp","enabled":true,"header":"Authorization","auth_token":"stored-secret"}]
	}`)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Contains(t, storedPlaygroundMCPOption(t, db), "stored-secret")
	assert.True(t, playground_setting.IsPlaygroundMCPEnabled())

	// A blank token keeps the stored credential while the list is edited.
	response = playgroundMCPAdminRequest(t, router, `{
		"enabled": true,
		"servers": [{"id":"docs","name":"Docs v2","url":"https://mcp.example.com/mcp","enabled":true,"header":"Authorization"}]
	}`)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	stored := storedPlaygroundMCPOption(t, db)
	assert.Contains(t, stored, "stored-secret")
	assert.Contains(t, stored, "Docs v2")

	// The option read replaces the credential with has_token.
	response = httptest.NewRecorder()
	getRequest := httptest.NewRequest(http.MethodGet, "/api/option/", nil)
	router.ServeHTTP(response, getRequest)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.NotContains(t, response.Body.String(), "stored-secret")
	var options struct {
		Success bool `json:"success"`
		Data    []struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &options))
	require.True(t, options.Success)
	var redacted string
	for _, option := range options.Data {
		if option.Key == playground_setting.PlaygroundMCPOptionKey {
			redacted = option.Value
		}
	}
	require.NotEmpty(t, redacted)
	assert.Contains(t, redacted, `"has_token":true`)

	// An explicit clear removes the credential, and a rejected draft leaves the
	// working configuration untouched.
	response = playgroundMCPAdminRequest(t, router, `{
		"enabled": true,
		"servers": [{"id":"docs","name":"Docs v2","url":"https://mcp.example.com/mcp","enabled":true,"header":"Authorization","clear_token":true}]
	}`)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.NotContains(t, storedPlaygroundMCPOption(t, db), "stored-secret")

	rejected := playgroundMCPAdminRequest(t, router, `{
		"enabled": true,
		"servers": [{"id":"docs","name":"Docs","url":"ftp://mcp.example.com/mcp","enabled":true,"header":"Authorization"}]
	}`)
	require.Equal(t, http.StatusOK, rejected.Code, rejected.Body.String())
	assert.Contains(t, rejected.Body.String(), `"success":false`)
	assert.NotContains(t, storedPlaygroundMCPOption(t, db), "ftp://")
}

// The browser-facing routes turn a disabled feature and unknown or disabled
// connections into stable codes without contacting an upstream server.
func TestPlaygroundMCPUserRoutesReportUnavailableServers(t *testing.T) {
	previousMCP := playground_setting.GetPlaygroundSetting().MCP
	playground_setting.GetPlaygroundSetting().MCP = &playground_setting.PlaygroundMCPSetting{Enabled: false}
	t.Cleanup(func() { playground_setting.GetPlaygroundSetting().MCP = previousMCP })

	router := gin.New()
	withUser := func(c *gin.Context) {
		c.Set("id", 1)
		c.Next()
	}
	router.GET("/api/playground/mcp/servers", withUser, ListPlaygroundMCPServers)
	router.POST("/api/playground/mcp/:serverId/call", withUser, CallPlaygroundMCPTool)

	request := func(method, path, body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(response, req)
		return response
	}

	response := request(http.MethodGet, "/api/playground/mcp/servers", "")
	require.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), playgroundMCPDisabledErrorCode)

	playground_setting.GetPlaygroundSetting().MCP = &playground_setting.PlaygroundMCPSetting{
		Enabled: true,
		Servers: []playground_setting.PlaygroundMCPServerSetting{
			{ID: "docs", Name: "Docs", URL: "https://mcp.example.com/mcp", Enabled: true},
			{ID: "off", Name: "Off", URL: "https://off.example.com/mcp", Enabled: false},
		},
	}

	response = request(http.MethodPost, "/api/playground/mcp/missing/call", `{"tool":"echo"}`)
	require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), playgroundMCPNotFoundErrorCode)

	response = request(http.MethodPost, "/api/playground/mcp/off/call", `{"tool":"echo"}`)
	require.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), playgroundMCPServerDisabledErrorCode)

	response = request(http.MethodPost, "/api/playground/mcp/docs/call", `{"tool":" "}`)
	require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), playgroundMCPInvalidRequestErrorCode)
}
