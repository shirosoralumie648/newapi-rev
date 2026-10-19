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
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

const (
	// playgroundComparisonCreateMaxBytes bounds the immutable matrix input.
	// The per-prompt and per-run byte budgets are enforced again by the model.
	playgroundComparisonCreateMaxBytes = 512 << 10
	// playgroundComparisonUpdateOverhead leaves room for the status, revision,
	// baseline and JSON envelope around the stored result snapshot.
	playgroundComparisonUpdateOverhead = 64 << 10
)

// ListPlaygroundComparisonRuns returns the caller's newest persisted compare
// runs. The projection omits every matrix snapshot, so history stays cheap.
func ListPlaygroundComparisonRuns(c *gin.Context) {
	userID := c.GetInt("id")
	if userID <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	items, err := model.ListPlaygroundComparisonRuns(userID)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": items})
}

// CreatePlaygroundComparisonRun stores the inputs of one matrix and returns
// its pending cells. Nothing is sent to a model here; the browser runs each
// cell as an ordinary /pg request and updates the snapshot through the PATCH
// endpoint.
func CreatePlaygroundComparisonRun(c *gin.Context) {
	var request model.PlaygroundComparisonRunCreate
	if !decodePlaygroundRequest(c, &request, playgroundComparisonCreateMaxBytes) {
		return
	}
	view, err := model.CreatePlaygroundComparisonRun(c.GetInt("id"), request)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}

// GetPlaygroundComparisonRun returns one owner-scoped matrix.
func GetPlaygroundComparisonRun(c *gin.Context) {
	view, err := model.GetPlaygroundComparisonRun(c.GetInt("id"), strings.TrimSpace(c.Param("runId")))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}

// UpdatePlaygroundComparisonRun replaces the result snapshot under a revision
// compare-and-swap and reports the new revision.
func UpdatePlaygroundComparisonRun(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	maxBytes := policy.ComparisonRunMaxBytes + playgroundComparisonUpdateOverhead
	if maxBytes < playgroundComparisonUpdateOverhead {
		maxBytes = playgroundComparisonUpdateOverhead
	}
	var request model.PlaygroundComparisonRunUpdate
	if !decodePlaygroundRequest(c, &request, maxBytes) {
		return
	}
	view, err := model.UpdatePlaygroundComparisonRun(c.GetInt("id"), strings.TrimSpace(c.Param("runId")), request)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}

// DeletePlaygroundComparisonRun removes the caller's run and releases its
// account counters.
func DeletePlaygroundComparisonRun(c *gin.Context) {
	err := model.DeletePlaygroundComparisonRun(c.GetInt("id"), strings.TrimSpace(c.Param("runId")))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"deleted": true})
}
