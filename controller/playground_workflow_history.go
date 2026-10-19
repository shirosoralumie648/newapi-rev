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

// PG2-07 canvas workflow run history endpoints. A run history row is the
// owner's record of one browser-executed workflow; creating it never charges
// quota, because every step remains an ordinary /pg or task request with its
// own pre-charge and settlement. The node cache lookup is read-only and
// returns only the newest succeeded output of an owned canvas, so it can never
// read another account's runs.

// playgroundWorkflowHistoryRequestMaxBytes leaves room for a full bounded run
// snapshot (the model caps the snapshot itself) without accepting an unbounded
// body.
const playgroundWorkflowHistoryRequestMaxBytes = 2 << 20

type playgroundWorkflowNodeCacheRequest struct {
	CanvasID     string   `json:"canvas_id"`
	Fingerprints []string `json:"fingerprints"`
}

// CreatePlaygroundWorkflowRunHistory stores the immutable input of a run
// before its first step. The canvas and optional conversation are resolved
// under the caller's ownership by the model.
func CreatePlaygroundWorkflowRunHistory(c *gin.Context) {
	var request model.PlaygroundWorkflowRunCreate
	if !decodePlaygroundRequest(c, &request, playgroundWorkflowHistoryRequestMaxBytes) {
		return
	}
	view, err := model.CreatePlaygroundWorkflowRun(c.GetInt("id"), request)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}

// ListPlaygroundWorkflowRunHistory returns the newest run summaries, optionally
// restricted to one canvas. The node snapshot is omitted from every summary.
func ListPlaygroundWorkflowRunHistory(c *gin.Context) {
	userID := c.GetInt("id")
	if userID <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	items, err := model.ListPlaygroundWorkflowRuns(userID, strings.TrimSpace(c.Query("canvas_id")))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": items})
}

// GetPlaygroundWorkflowRunHistory returns one owner-scoped run with its node
// waterfall.
func GetPlaygroundWorkflowRunHistory(c *gin.Context) {
	view, err := model.GetPlaygroundWorkflowRun(c.GetInt("id"), strings.TrimSpace(c.Param("runId")))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}

// UpdatePlaygroundWorkflowRunHistory replaces the node snapshot under the
// revision compare-and-swap the client received from create, list, get or the
// previous update.
func UpdatePlaygroundWorkflowRunHistory(c *gin.Context) {
	var request model.PlaygroundWorkflowRunUpdate
	if !decodePlaygroundRequest(c, &request, playgroundWorkflowHistoryRequestMaxBytes) {
		return
	}
	view, err := model.UpdatePlaygroundWorkflowRun(c.GetInt("id"), strings.TrimSpace(c.Param("runId")), request)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}

// DeletePlaygroundWorkflowRunHistory deletes one owner-scoped run and releases
// its snapshot bytes from the account budget.
func DeletePlaygroundWorkflowRunHistory(c *gin.Context) {
	if err := model.DeletePlaygroundWorkflowRun(c.GetInt("id"), strings.TrimSpace(c.Param("runId"))); err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"deleted": true})
}

// LookupPlaygroundWorkflowNodeCache resolves reusable outputs for a batch of
// client-computed node fingerprints. An unknown or foreign canvas is reported
// exactly like an unknown run.
func LookupPlaygroundWorkflowNodeCache(c *gin.Context) {
	var request playgroundWorkflowNodeCacheRequest
	if !decodePlaygroundRequest(c, &request, playgroundWorkflowHistoryRequestMaxBytes) {
		return
	}
	entries, err := model.LookupPlaygroundWorkflowNodeCache(c.GetInt("id"), request.CanvasID, request.Fingerprints)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"items": entries})
}
