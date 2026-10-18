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
// validated against the account's usable groups and never widens access.
func PlaygroundRelayBridge(canonicalPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !strings.HasPrefix(c.Request.URL.Path, "/pg/") {
			c.Next()
			return
		}
		if strings.HasPrefix(c.Request.Header.Get("Content-Type"), "application/json") {
			request := &dto.PlayGroundRequest{}
			if err := common.UnmarshalBodyReusable(c, request); err == nil && request.Group != "" {
				usingGroup := common.GetContextKeyString(c, constant.ContextKeyUsingGroup)
				// A submitted display name is resolved to the stable identifier
				// before it reaches channel selection and billing.
				group := group_setting.ResolveGroupID(request.Group)
				if !service.GroupInUserUsableGroups(usingGroup, group) && group != usingGroup {
					abortWithOpenAiMessage(c, http.StatusForbidden, i18n.T(c, i18n.MsgDistributorGroupAccessDenied))
					return
				}
				common.SetContextKey(c, constant.ContextKeyUsingGroup, group)
			}
		}
		c.Request.URL.Path = canonicalPath
		c.Next()
	}
}
