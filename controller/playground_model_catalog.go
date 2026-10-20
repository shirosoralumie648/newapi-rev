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
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/gin-gonic/gin"
)

// GetPlaygroundModelCatalog returns the effective curated catalog of the
// caller's user group. It is read-only and contains no model credentials or
// routing detail; hidden entries are already removed. Models missing from the
// catalog stay available in the Playground under the uncategorized section, so
// a deployment without an administrator catalog behaves exactly as before.
func GetPlaygroundModelCatalog(c *gin.Context) {
	userId := c.GetInt("id")
	if userId <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	group, err := model.GetUserGroup(userId, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, playground_setting.GetPlaygroundModelCatalog(group))
}

// UpdatePlaygroundModelCatalog replaces the administrator-curated catalog and
// its user-group overrides in one write. The handler is registered behind
// AdminAuth; the option validation rejects a malformed or unbounded payload
// before it replaces the working configuration.
func UpdatePlaygroundModelCatalog(c *gin.Context) {
	var request struct {
		Catalog playground_setting.PlaygroundModelCatalogSetting `json:"catalog"`
	}
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	encoded, err := common.Marshal(request.Catalog)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	value := string(encoded)
	if err := playground_setting.ValidatePlaygroundModelCatalogJSON(value); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := model.UpdateOption(playground_setting.PlaygroundModelCatalogOptionKey, value); err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAudit(c, "option.update", map[string]any{
		"key": playground_setting.PlaygroundModelCatalogOptionKey,
	})
	common.ApiSuccessT(c, "Model catalog saved", nil)
}
