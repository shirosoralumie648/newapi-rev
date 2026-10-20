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

// playgroundArenaVoteMaxBytes leaves room for the optional one-sentence note
// and the JSON envelope. The model enforces the rune limit again.
const playgroundArenaVoteMaxBytes = 8 << 10

type playgroundArenaVoteRequest struct {
	Choice string `json:"choice"`
	Note   string `json:"note"`
}

// ListPlaygroundArenaVotes returns only the caller's votes for one owned
// conversation. It is a read-only companion to the stored anonymous groups, so
// the client can restore its selected choices after a reload.
func ListPlaygroundArenaVotes(c *gin.Context) {
	votes, err := model.ListPlaygroundArenaVotes(c.GetInt("id"), c.Param("id"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"votes": votes})
}

// UpsertPlaygroundArenaVote records or changes one raw preference for an
// anonymous A/B group. The unique owner/session/message key makes a replay and
// a vote change update the same row, so a group is counted once per account.
func UpsertPlaygroundArenaVote(c *gin.Context) {
	messageKey := strings.TrimSpace(c.Param("messageKey"))
	if messageKey == "" {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	var request playgroundArenaVoteRequest
	if !decodePlaygroundRequest(c, &request, playgroundArenaVoteMaxBytes) {
		return
	}
	vote, err := model.UpsertPlaygroundArenaVote(c.GetInt("id"), c.Param("id"), messageKey, request.Choice, request.Note)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, vote)
}

// GetPlaygroundArenaVoteSummary returns a read-only choice breakdown. Personal
// scope is available to the owner; instance scope exposes every account's raw
// preference totals and is therefore restricted to administrators.
func GetPlaygroundArenaVoteSummary(c *gin.Context) {
	scope := strings.TrimSpace(c.DefaultQuery("scope", model.PlaygroundArenaScopePersonal))
	switch scope {
	case model.PlaygroundArenaScopePersonal:
		summary, err := model.PlaygroundArenaVoteSummaryForUser(c.GetInt("id"))
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		common.ApiSuccess(c, summary)
	case model.PlaygroundArenaScopeInstance:
		if c.GetInt("role") < common.RoleAdminUser {
			common.ApiErrorStatus(c, http.StatusForbidden, common.NewMessage("Administrator access is required."), gin.H{"code": "PLAYGROUND_ARENA_SUMMARY_FORBIDDEN"})
			return
		}
		summary, err := model.PlaygroundArenaVoteSummaryForInstance()
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		common.ApiSuccess(c, summary)
	default:
		writePlaygroundError(c, common.NewMessage("Invalid Playground arena summary scope."))
	}
}
