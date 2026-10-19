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
	"fmt"
	"hash/fnv"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/gin-gonic/gin"
)

const (
	// playgroundCostLookupMaxRequestIds bounds one cost lookup so a single
	// request stays a bounded indexed query. A conversation holds far fewer
	// generated versions than this.
	playgroundCostLookupMaxRequestIds = 100
	// playgroundCostRequestIdMaxLength matches the logs.request_id column.
	playgroundCostRequestIdMaxLength = 64
)

// playgroundMessageCost is one message's settled cost, read from the caller's
// ordinary consume log. It is display-only: the figures are copied from the
// settled row and never recalculated.
type playgroundMessageCost struct {
	RequestId        string `json:"request_id"`
	Quota            int    `json:"quota"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	TotalTokens      int    `json:"total_tokens"`
	ModelName        string `json:"model_name,omitempty"`
	CreatedAt        int64  `json:"created_at"`
	// Timing is the public phase breakdown the request timing middleware wrote
	// to the same log row. It stays absent for rows stored before the field
	// existed and for entry points that do not record one.
	Timing *common.RequestTimingPayload `json:"timing,omitempty"`
	// CacheTokens is the cached prompt token count the row was billed for. It
	// is absent for requests without a cache report.
	CacheTokens *int `json:"cache_tokens,omitempty"`
	// CacheRatio and ModelRatio are the price ratios the settlement actually
	// applied. The client can estimate the cache saving from them, and shows
	// only the token count when either one is missing.
	CacheRatio *float64 `json:"cache_ratio,omitempty"`
	ModelRatio *float64 `json:"model_ratio,omitempty"`
	// GroupRatio is the group multiplier applied to this request.
	GroupRatio *float64 `json:"group_ratio,omitempty"`
	// ChannelKey is the channel label this viewer may see. Regular users get a
	// stable masked number (for example "#4821") with no name and no routing
	// chain; administrators get the full attempt chain from
	// admin_info.use_channel, exactly like the log detail view.
	ChannelKey string `json:"channel_key,omitempty"`
	// ChannelId and ChannelName are the complete channel identity and are only
	// populated for administrators.
	ChannelId   *int   `json:"channel_id,omitempty"`
	ChannelName string `json:"channel_name,omitempty"`
}

// playgroundMaskedChannelKey renders the stable label a regular viewer sees
// instead of the channel id. It is derived from the viewer and the channel, so
// the same route looks the same across messages, but the real channel
// identifier never leaves the server.
func playgroundMaskedChannelKey(userID, channelID int) string {
	if channelID <= 0 {
		return ""
	}
	digest := fnv.New32a()
	_, _ = fmt.Fprintf(digest, "playground-channel:%d:%d", userID, channelID)
	return fmt.Sprintf("#%d", 1000+digest.Sum32()%9000)
}

// playgroundAdminChannelKey shows administrators the whole attempt chain, so a
// retry or fallback reads the same way as the admin log view.
func playgroundAdminChannelKey(channelID int, useChannels []int) string {
	if len(useChannels) == 0 {
		if channelID <= 0 {
			return ""
		}
		return fmt.Sprintf("#%d", channelID)
	}
	keys := make([]string, 0, len(useChannels))
	for _, id := range useChannels {
		keys = append(keys, fmt.Sprintf("#%d", id))
	}
	return strings.Join(keys, " → ")
}

// GetPlaygroundUsage returns the caller's unified Playground resource usage.
// It is read-only and scoped to the authenticated user, so it exposes only the
// caller's own storage figures.
func GetPlaygroundUsage(c *gin.Context) {
	userID := c.GetInt("id")
	if userID <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	usage, err := model.PlaygroundUsageForUser(userID)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, usage)
}

// GetPlaygroundSettings returns the Playground feature switches the browser
// needs before it renders anything. The sandbox preview flag is the only
// artifact-content gate: while it is off the client must not mount the
// sandboxed iframe, and artifact bodies stay inert text.
func GetPlaygroundSettings(c *gin.Context) {
	userID := c.GetInt("id")
	if userID <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	common.ApiSuccess(c, gin.H{
		"sandbox_preview_enabled": playground_setting.IsSandboxPreviewEnabled(),
		"web_search_enabled":      playground_setting.IsWebSearchEnabled(),
	})
}

// GetPlaygroundMessageCosts resolves the caller's own relay requests to their
// ordinary consume-log rows, so a conversation can display the tokens and the
// amount that were actually billed for each message, together with read-only
// request diagnostics: the phase timing, the cached prompt tokens and applied
// prices, the group multiplier and the channel the viewer may see. It is
// strictly read-only and owner-scoped: another account's request id has no
// row, the figures come from the settled log, and no quota is reserved,
// settled or refunded here. Regular users only receive a masked channel
// label; the complete channel identity is limited to administrators, matching
// the admin-only admin_info.use_channel scope of the stored log row.
func GetPlaygroundMessageCosts(c *gin.Context) {
	userID := c.GetInt("id")
	if userID <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	raw := c.Query("request_ids")
	if raw == "" {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	parts := strings.Split(raw, ",")
	if len(parts) > playgroundCostLookupMaxRequestIds {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	ids := make([]string, 0, len(parts))
	seen := make(map[string]bool, len(parts))
	for _, part := range parts {
		id := strings.TrimSpace(part)
		if id == "" || len(id) > playgroundCostRequestIdMaxLength || seen[id] {
			writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
			return
		}
		seen[id] = true
		ids = append(ids, id)
	}
	logs, err := model.GetUserConsumeLogsByRequestIds(userID, ids)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	items := make([]playgroundMessageCost, 0, len(logs))
	admin := c.GetInt("role") >= common.RoleAdminUser
	for index := range logs {
		entry := &logs[index]
		fields := model.ParseConsumeLogDisplayFields(entry.Other)
		item := playgroundMessageCost{
			RequestId:        entry.RequestId,
			Quota:            entry.Quota,
			PromptTokens:     entry.PromptTokens,
			CompletionTokens: entry.CompletionTokens,
			TotalTokens:      entry.PromptTokens + entry.CompletionTokens,
			ModelName:        entry.ModelName,
			CreatedAt:        entry.CreatedAt,
			Timing:           fields.Timing,
			CacheTokens:      fields.CacheTokens,
			CacheRatio:       fields.CacheRatio,
			ModelRatio:       fields.ModelRatio,
			GroupRatio:       fields.GroupRatio,
		}
		if admin {
			item.ChannelKey = playgroundAdminChannelKey(entry.ChannelId, fields.UseChannels)
			if entry.ChannelId > 0 {
				channelID := entry.ChannelId
				item.ChannelId = &channelID
				if channel, err := model.CacheGetChannel(channelID); err == nil && channel != nil {
					item.ChannelName = channel.Name
				}
			}
		} else {
			item.ChannelKey = playgroundMaskedChannelKey(userID, entry.ChannelId)
		}
		items = append(items, item)
	}
	// The enabled flag mirrors the runtime consume-log setting: when logging is
	// switched off no row will ever appear, so the client stops waiting for one.
	common.ApiSuccess(c, gin.H{
		"enabled": common.LogConsumeEnabled,
		"items":   items,
	})
}
