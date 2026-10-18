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
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

const (
	// playgroundStorageLedgerExportMaxRows bounds one CSV export so a huge
	// history cannot exhaust server memory or a client connection.
	playgroundStorageLedgerExportMaxRows = 100000
	// playgroundStorageReconcileDeviationLimit caps how many deviating
	// accounts one reconciliation report lists.
	playgroundStorageReconcileDeviationLimit = 50
)

// GetPlaygroundStorageBilling returns the caller's read-only view of the
// optional metered storage tier: the effective prices, limits and grace state,
// today's accruing day and whether the shared wallet lock currently keeps the
// account read-only. It never changes a balance; a recharged wallet may collect
// recorded debt the same way the workspace write gate does.
func GetPlaygroundStorageBilling(c *gin.Context) {
	userId := c.GetInt("id")
	if userId <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	status, err := model.GetPlaygroundStorageBillingStatus(userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, status)
}

// GetPlaygroundStorageLedger lists storage billing days across accounts
// (admin view), newest first, optionally narrowed to one account with the
// user_id query parameter and to a date range with start/end (inclusive,
// YYYY-MM-DD).
func GetPlaygroundStorageLedger(c *gin.Context) {
	userId, ok := parsePlaygroundStorageUserFilter(c)
	if !ok {
		return
	}
	start, ok := parsePlaygroundStorageDateQuery(c, "start")
	if !ok {
		return
	}
	end, ok := parsePlaygroundStorageDateQuery(c, "end")
	if !ok {
		return
	}
	pageInfo := common.GetPageQuery(c)
	days, total, err := model.ListPlaygroundStorageLedger(userId, start, end, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(days)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    pageInfo,
	})
}

// ExportPlaygroundStorageLedger streams the selected storage billing days as
// CSV with the same filters as the list view (admin).
func ExportPlaygroundStorageLedger(c *gin.Context) {
	userId, ok := parsePlaygroundStorageUserFilter(c)
	if !ok {
		return
	}
	start, ok := parsePlaygroundStorageDateQuery(c, "start")
	if !ok {
		return
	}
	end, ok := parsePlaygroundStorageDateQuery(c, "end")
	if !ok {
		return
	}
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="playground-storage-ledger.csv"`)
	c.Header("Cache-Control", "no-store")
	c.Status(http.StatusOK)
	// UTF-8 BOM keeps spreadsheet tools from misreading non-ASCII meta text.
	_, _ = c.Writer.Write([]byte("\xEF\xBB\xBF"))

	writer := csv.NewWriter(c.Writer)
	_ = writer.Write([]string{"id", "user_id", "date", "peak_bytes", "free_bytes", "billable_bytes", "egress_bytes", "egress_requests", "quota", "debt_quota", "egress_quota", "status", "grace_until", "settled_at", "created_at", "updated_at"})
	err := model.StreamPlaygroundStorageLedger(userId, start, end, playgroundStorageLedgerExportMaxRows, func(day *model.PlaygroundStorageLedger) error {
		return writer.Write([]string{
			strconv.Itoa(day.Id),
			strconv.Itoa(day.UserId),
			day.Date,
			strconv.FormatInt(day.PeakBytes, 10),
			strconv.FormatInt(day.FreeBytes, 10),
			strconv.FormatInt(day.BillableBytes, 10),
			strconv.FormatInt(day.EgressBytes, 10),
			strconv.FormatInt(day.EgressRequests, 10),
			strconv.FormatInt(day.Quota, 10),
			strconv.FormatInt(day.DebtQuota, 10),
			strconv.FormatInt(day.EgressQuota, 10),
			day.Status,
			strconv.FormatInt(day.GraceUntil, 10),
			strconv.FormatInt(day.SettledAt, 10),
			strconv.FormatInt(day.CreatedAt, 10),
			strconv.FormatInt(day.UpdatedAt, 10),
		})
	})
	if err != nil {
		// The status line is already sent; log the failure for the operator.
		common.SysError(common.LogText("failed to export the playground storage ledger: %s", err.Error()))
		return
	}
	writer.Flush()
}

// GetPlaygroundStorageReconcile compares the settled storage billing days
// with the unified wallet ledger (admin). Reconciliation only reports; it
// never moves money or changes a row.
func GetPlaygroundStorageReconcile(c *gin.Context) {
	userId, ok := parsePlaygroundStorageUserFilter(c)
	if !ok {
		return
	}
	report, err := model.ReconcilePlaygroundStorageBilling(playgroundStorageReconcileDeviationLimit, userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    report,
	})
}

// parsePlaygroundStorageUserFilter reads the optional user_id filter shared by
// the admin storage views; an empty or zero value selects every account.
func parsePlaygroundStorageUserFilter(c *gin.Context) (int, bool) {
	raw := strings.TrimSpace(c.Query("user_id"))
	if raw == "" || raw == "0" {
		return 0, true
	}
	userId, err := strconv.Atoi(raw)
	if err != nil || userId < 0 {
		common.ApiError(c, fmt.Errorf("invalid user_id"))
		return 0, false
	}
	return userId, true
}

// parsePlaygroundStorageDateQuery reads one optional inclusive date filter of
// the admin storage views and rejects malformed values instead of silently
// comparing the wrong days.
func parsePlaygroundStorageDateQuery(c *gin.Context, name string) (string, bool) {
	raw := strings.TrimSpace(c.Query(name))
	if raw == "" {
		return "", true
	}
	if _, err := time.Parse("2006-01-02", raw); err != nil {
		common.ApiError(c, fmt.Errorf("invalid %s, expected YYYY-MM-DD", name))
		return "", false
	}
	return raw, true
}
