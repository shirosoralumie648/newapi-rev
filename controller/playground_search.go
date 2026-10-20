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
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

const (
	playgroundWebSearchModelName = "playground/web-search"

	playgroundWebSearchDisabledErrorCode           = "PLAYGROUND_SEARCH_DISABLED"
	playgroundWebSearchUnavailableErrorCode        = "PLAYGROUND_SEARCH_UNAVAILABLE"
	playgroundWebSearchInsufficientErrorCode       = "PLAYGROUND_SEARCH_INSUFFICIENT_QUOTA"
	playgroundWebSearchProviderErrorCode           = "PLAYGROUND_SEARCH_FAILED"
	playgroundWebSearchInvalidQueryErrorCode       = "PLAYGROUND_SEARCH_INVALID_QUERY"
	playgroundWebSearchReservationErrorCode        = "PLAYGROUND_SEARCH_RESERVATION_FAILED"
	playgroundWebSearchRequestMaxBytes       int64 = 8 << 10
)

type playgroundWebSearchRequest struct {
	Query string `json:"query"`
}

// PlaygroundWebSearch performs one web search for the composer's
// search-with-this-turn toggle. The browser never sees the provider endpoint
// or credential. A successful provider call is billed exactly once from the
// caller's wallet; a failed call refunds the hold and writes no consume log.
func PlaygroundWebSearch(c *gin.Context) {
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	setting := playground_setting.GetPlaygroundWebSearchSetting()
	if !setting.IsEnabled() {
		writePlaygroundGenerationError(c, http.StatusForbidden, playgroundWebSearchDisabledErrorCode, "Web search is disabled.")
		return
	}

	var request playgroundWebSearchRequest
	if !decodePlaygroundRequest(c, &request, playgroundWebSearchRequestMaxBytes) {
		return
	}
	request.Query = trimPlaygroundSearchQuery(request.Query)
	if request.Query == "" {
		writePlaygroundGenerationError(c, http.StatusBadRequest, playgroundWebSearchInvalidQueryErrorCode, "Enter a web search query.")
		return
	}

	userID := c.GetInt("id")
	group := c.GetString("group")
	if group == "" {
		var err error
		group, err = model.GetUserGroup(userID, false)
		if err != nil {
			writePlaygroundGenerationError(c, http.StatusInternalServerError, playgroundWebSearchUnavailableErrorCode, "Unable to resolve the account group.")
			return
		}
	}
	quota, clamp := playgroundWebSearchQuota(setting.PriceUSDPerCallForGroup(group))
	requestID := c.GetString(common.RequestIdKey)
	if requestID == "" {
		requestID = common.NewRequestId()
		c.Set(common.RequestIdKey, requestID)
		c.Header(common.RequestIdKey, requestID)
	}

	startedAt := time.Now()
	if quota > 0 {
		reserved, err := model.TryReserveUserQuota(userID, quota, requestID)
		if err != nil {
			writePlaygroundGenerationError(c, http.StatusInternalServerError, playgroundWebSearchReservationErrorCode, "Unable to reserve wallet quota for the search.")
			return
		}
		if !reserved {
			writePlaygroundGenerationError(c, http.StatusPaymentRequired, playgroundWebSearchInsufficientErrorCode, "Insufficient wallet quota for this search.")
			return
		}
	}

	result, err := service.RunPlaygroundWebSearch(c.Request.Context(), request.Query)
	if err != nil {
		if quota > 0 {
			_, _ = model.RefundWalletHold(userID, requestID, 0)
		}
		switch {
		case errors.Is(err, service.ErrPlaygroundSearchInvalidQuery):
			writePlaygroundGenerationError(c, http.StatusBadRequest, playgroundWebSearchInvalidQueryErrorCode, "Enter a web search query.")
		case errors.Is(err, service.ErrPlaygroundSearchDisabled):
			writePlaygroundGenerationError(c, http.StatusForbidden, playgroundWebSearchDisabledErrorCode, "Web search is disabled.")
		case errors.Is(err, service.ErrPlaygroundSearchNotConfigured):
			common.SysError(common.LogText("playground web search is not configured: %s", err.Error()))
			writePlaygroundGenerationError(c, http.StatusServiceUnavailable, playgroundWebSearchUnavailableErrorCode, "Web search configuration is incomplete.")
		default:
			common.SysError(common.LogText("playground web search provider call failed: %s", err.Error()))
			writePlaygroundGenerationError(c, http.StatusBadGateway, playgroundWebSearchProviderErrorCode, "Web search is temporarily unavailable.")
		}
		return
	}

	if quota > 0 {
		if _, err := model.SettleWalletHold(userID, requestID, 0); err != nil {
			_, _ = model.RefundWalletHold(userID, requestID, 0)
			common.SysError(common.LogText("failed to settle playground web search hold for user %d: %s", userID, err.Error()))
			writePlaygroundGenerationError(c, http.StatusInternalServerError, playgroundWebSearchReservationErrorCode, "Unable to settle wallet quota for the search.")
			return
		}
		model.RecordWalletConsumeDelta(userID, -int64(quota))
	}

	// The search is started from the Playground workspace, so its consume row
	// belongs to the Playground origin even though this route lives under
	// /api/playground. The usage analytics uses the same marker as the relay
	// routes to split workspace spend from direct API spend.
	c.Set(string(constant.ContextKeyPlaygroundOrigin), true)
	other := model.NewLogOther()
	other.SetPublic("web_search_provider", result.Provider)
	other.SetPublic("web_search_results", len(result.Results))
	if clamp != nil {
		other.SetAdmin("quota_saturation", clamp.AuditMap())
	}
	model.RecordConsumeLog(c, userID, model.RecordConsumeLogParams{
		ModelName:      playgroundWebSearchModelName,
		Quota:          quota,
		Content:        []*common.Message{common.NewMessage("Web search")},
		UseTimeSeconds: int(time.Since(startedAt).Seconds()),
		Group:          group,
		Other:          other,
	})

	common.ApiSuccess(c, gin.H{
		"query":    result.Query,
		"provider": result.Provider,
		"results":  result.Results,
	})
}

// playgroundWebSearchQuota converts the configured USD unit price into the
// wallet quota unit with the same exact-decimal path as other wallet charges.
func playgroundWebSearchQuota(priceUSD float64) (int, *common.QuotaClamp) {
	if priceUSD <= 0 || math.IsNaN(priceUSD) {
		return 0, nil
	}
	return common.QuotaFromDecimalChecked(
		decimal.NewFromFloat(priceUSD).Mul(decimal.NewFromFloat(common.QuotaPerUnit)),
	)
}

// trimPlaygroundSearchQuery applies the same length bound the provider adapter
// enforces, so an oversized query is rejected before any wallet hold.
func trimPlaygroundSearchQuery(query string) string {
	query = strings.TrimSpace(query)
	if len(query) > service.PlaygroundSearchMaxQueryRunes*4 {
		return ""
	}
	if utf8.RuneCountInString(query) > service.PlaygroundSearchMaxQueryRunes {
		return ""
	}
	return query
}
