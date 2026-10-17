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
	"errors"
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

func writePlaygroundAssetError(c *gin.Context, err error) {
	status, code, message := http.StatusInternalServerError, "PLAYGROUND_STORAGE_ERROR", "Unable to load the Playground asset library."
	if errors.Is(err, model.ErrPlaygroundAssetInvalid) {
		status, code, message = http.StatusBadRequest, "PLAYGROUND_INVALID_REQUEST", err.Error()
	}
	common.ApiErrorStatus(c, status, common.NewMessage(message), gin.H{"code": code})
}

// ListPlaygroundAssets returns one page of the caller's asset library, filtered
// by kind ("attachment" or "artifact") and an optional filename/title search.
// The model enforces the owner scope; the handler never accepts a user ID.
func ListPlaygroundAssets(c *gin.Context) {
	page, ok := playgroundStrictPage(c)
	if !ok {
		writePlaygroundAssetError(c, model.ErrPlaygroundAssetInvalid)
		return
	}
	items, total, err := model.ListPlaygroundAssets(c.GetInt("id"), c.Query("kind"), c.Query("search"), page.GetStartIdx(), page.PageSize)
	if err != nil {
		writePlaygroundAssetError(c, err)
		return
	}
	page.SetItems(items)
	page.SetTotal(int(total))
	common.ApiSuccess(c, page)
}
