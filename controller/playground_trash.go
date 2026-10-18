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
	"github.com/gin-gonic/gin"
)

// ListPlaygroundTrash returns the caller's trashed conversations and canvases
// together with the retention window that applies to the account, so the
// client can show when each entry disappears. It is read-only and
// owner-scoped; the purge itself runs in the background cleanup task.
func ListPlaygroundTrash(c *gin.Context) {
	userID := c.GetInt("id")
	if userID <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	listing, err := model.ListPlaygroundTrash(userID)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, listing)
}

// RestorePlaygroundSession returns one trashed conversation to the active
// list. Only a row that is actually in the trash can be restored: an active or
// foreign conversation is a plain not-found. No capacity is re-checked because
// the conversation never left the account counters while it was trashed.
func RestorePlaygroundSession(c *gin.Context) {
	session, err := model.RestorePlaygroundSession(c.GetInt("id"), c.Param("id"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	response, err := playgroundDecodeSession(session)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

// RestorePlaygroundCanvasProject returns one trashed canvas to the active
// list under the same trash-only, owner-scoped rule as conversation restore.
// The canvas kept its document, pins and counter share while it waited, so no
// capacity is re-checked.
func RestorePlaygroundCanvasProject(c *gin.Context) {
	project, err := model.RestorePlaygroundCanvasProject(c.GetInt("id"), c.Param("canvasId"))
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeCanvasProject(project, false))
}
