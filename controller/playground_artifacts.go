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
	"io"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

const playgroundArtifactRequestMaxBytes = 2 << 20

func writePlaygroundArtifactError(c *gin.Context, err error) {
	status, code, message := http.StatusInternalServerError, "PLAYGROUND_STORAGE_ERROR", "Unable to load or save Playground artifacts."
	switch {
	case errors.Is(err, model.ErrPlaygroundSessionNotFound):
		status, code, message = http.StatusNotFound, "PLAYGROUND_NOT_FOUND", "Playground artifact or conversation not found."
	case errors.Is(err, model.ErrPlaygroundConflict):
		status, code, message = http.StatusConflict, "PLAYGROUND_CONFLICT", err.Error()
	case errors.Is(err, model.ErrPlaygroundArtifactRequestConflict):
		status, code, message = http.StatusConflict, "PLAYGROUND_ARTIFACT_REQUEST_CONFLICT", err.Error()
	case errors.Is(err, model.ErrPlaygroundArtifactSourceConflict):
		status, code, message = http.StatusConflict, "PLAYGROUND_ARTIFACT_SOURCE_CONFLICT", err.Error()
	case errors.Is(err, model.ErrPlaygroundArtifactLimit):
		status, code, message = http.StatusUnprocessableEntity, "PLAYGROUND_ARTIFACT_LIMIT_EXCEEDED", err.Error()
	case errors.Is(err, model.ErrPlaygroundArtifactInvalid):
		status, code, message = http.StatusBadRequest, "PLAYGROUND_INVALID_REQUEST", err.Error()
	}
	// Database errors may contain snapshot text or schema details. Never echo them.
	common.ApiErrorStatus(c, status, common.NewMessage(message), gin.H{"code": code})
}

func decodePlaygroundArtifactRequest(c *gin.Context, target any) bool {
	if c.GetInt("id") <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, playgroundArtifactRequestMaxBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			common.ApiErrorStatus(c, http.StatusRequestEntityTooLarge, common.NewMessage("Playground request is too large."), gin.H{"code": "PLAYGROUND_REQUEST_TOO_LARGE"})
		} else {
			writePlaygroundArtifactError(c, model.ErrPlaygroundArtifactInvalid)
		}
		return false
	}
	if !utf8.Valid(body) || common.Unmarshal(body, target) != nil {
		writePlaygroundArtifactError(c, model.ErrPlaygroundArtifactInvalid)
		return false
	}
	return true
}

func playgroundArtifactPage(c *gin.Context) *common.PageInfo {
	// Inspect the raw aliases too: GetPageQuery clamps to 100 and silently
	// defaults malformed input, but artifact limits must reject, not truncate.
	for _, key := range []string{"p", "page_size", "ps", "size"} {
		if values, ok := c.GetQueryArray(key); ok {
			if len(values) != 1 {
				writePlaygroundArtifactError(c, model.ErrPlaygroundArtifactInvalid)
				return nil
			}
			value, err := strconv.Atoi(values[0])
			limit := 50
			if key == "p" {
				limit = 1000000
			}
			if err != nil || value < 1 || value > limit {
				writePlaygroundArtifactError(c, model.ErrPlaygroundArtifactInvalid)
				return nil
			}
		}
	}
	page := common.GetPageQuery(c)
	if page.PageSize < 1 || page.PageSize > 50 {
		writePlaygroundArtifactError(c, model.ErrPlaygroundArtifactInvalid)
		return nil
	}
	return page
}

func ListPlaygroundArtifacts(c *gin.Context) {
	page := playgroundArtifactPage(c)
	if page == nil {
		return
	}
	items, total, err := model.ListPlaygroundArtifacts(c.GetInt("id"), c.Param("id"), page.GetStartIdx(), page.PageSize)
	if err != nil {
		writePlaygroundArtifactError(c, err)
		return
	}
	page.SetItems(items)
	page.SetTotal(int(total))
	common.ApiSuccess(c, page)
}

func CreatePlaygroundArtifact(c *gin.Context) {
	var input model.CreatePlaygroundArtifactInput
	if !decodePlaygroundArtifactRequest(c, &input) {
		return
	}
	result, err := model.CreatePlaygroundArtifact(c.GetInt("id"), c.Param("id"), input)
	if err != nil {
		writePlaygroundArtifactError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func GetPlaygroundArtifact(c *gin.Context) {
	result, err := model.GetPlaygroundArtifact(c.GetInt("id"), c.Param("id"), c.Param("artifactId"), c.Param("versionId"))
	if err != nil {
		writePlaygroundArtifactError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func ListPlaygroundArtifactVersions(c *gin.Context) {
	page := playgroundArtifactPage(c)
	if page == nil {
		return
	}
	items, total, err := model.ListPlaygroundArtifactVersions(c.GetInt("id"), c.Param("id"), c.Param("artifactId"), page.GetStartIdx(), page.PageSize)
	if err != nil {
		writePlaygroundArtifactError(c, err)
		return
	}
	page.SetItems(items)
	page.SetTotal(int(total))
	common.ApiSuccess(c, page)
}

func SavePlaygroundArtifactVersion(c *gin.Context) {
	var input model.SavePlaygroundArtifactInput
	if !decodePlaygroundArtifactRequest(c, &input) {
		return
	}
	result, err := model.SavePlaygroundArtifactVersion(c.GetInt("id"), c.Param("id"), c.Param("artifactId"), input)
	if err != nil {
		writePlaygroundArtifactError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func RestorePlaygroundArtifactVersion(c *gin.Context) {
	var input model.RestorePlaygroundArtifactInput
	if !decodePlaygroundArtifactRequest(c, &input) {
		return
	}
	result, err := model.RestorePlaygroundArtifactVersion(c.GetInt("id"), c.Param("id"), c.Param("artifactId"), input)
	if err != nil {
		writePlaygroundArtifactError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func DeletePlaygroundArtifact(c *gin.Context) {
	values := c.QueryArray("expected_revision")
	if len(values) != 1 {
		writePlaygroundArtifactError(c, model.ErrPlaygroundArtifactInvalid)
		return
	}
	revision, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || revision < 1 {
		writePlaygroundArtifactError(c, model.ErrPlaygroundArtifactInvalid)
		return
	}
	if err := model.DeletePlaygroundArtifact(c.GetInt("id"), c.Param("id"), c.Param("artifactId"), revision); err != nil {
		writePlaygroundArtifactError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("artifactId")})
}
