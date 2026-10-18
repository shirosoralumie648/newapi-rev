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

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
)

// referralInvitationExportMaxRows bounds one CSV export so a huge invitation
// history cannot exhaust server memory or a client connection.
const referralInvitationExportMaxRows = 100000

// referralInvitationExportPageSize bounds one page of the export walk.
const referralInvitationExportPageSize = 1000

// referralInvitationStatsFields is the shared commission aggregate of one
// listed invitation; quota amounts and the trigger window are read-only.
type referralInvitationStatsFields struct {
	Source           string `json:"source"`
	BoundAt          int64  `json:"bound_at"`
	CommissionEndsAt int64  `json:"commission_ends_at"`
	PendingQuota     int64  `json:"pending_quota"`
	LockedQuota      int64  `json:"locked_quota"`
	SettledQuota     int64  `json:"settled_quota"`
	TotalPaidQuota   int64  `json:"total_paid_quota"`
	CommissionCount  int64  `json:"commission_count"`
}

// referralInvitationSelfItem is one invitee as the inviter sees it: the
// identifier is masked, so the raw username and email never leave the server.
type referralInvitationSelfItem struct {
	InviteeId  int    `json:"invitee_id"`
	Identifier string `json:"identifier"`
	referralInvitationStatsFields
}

// referralInvitationAdminItem is one platform-wide invitation as the
// administrator sees it, with the inviter and the raw account identifiers.
type referralInvitationAdminItem struct {
	InviteeId       int    `json:"invitee_id"`
	Username        string `json:"username"`
	Email           string `json:"email"`
	DisplayName     string `json:"display_name"`
	InviterId       int    `json:"inviter_id"`
	InviterUsername string `json:"inviter_username"`
	referralInvitationStatsFields
}

// referralInvitationSelfResponse is the caller's paginated invitation list
// with the window configuration the rows are derived from: 0 limits the
// commission to the invitee's first paid order, -1 never expires and a
// positive value is a number of months from registration.
type referralInvitationSelfResponse struct {
	*common.PageInfo
	WindowMonths      int  `json:"window_months"`
	CommissionEnabled bool `json:"commission_enabled"`
}

// referralInvitationAdminResponse adds the summary of the active filters.
type referralInvitationAdminResponse struct {
	*common.PageInfo
	Summary           model.ReferralStatsSummary `json:"summary"`
	WindowMonths      int                        `json:"window_months"`
	CommissionEnabled bool                       `json:"commission_enabled"`
}

// GetSelfReferralInvitations lists the caller's own invitees with their
// commission aggregates. It is read-only and only ever returns the caller's
// invitations, with masked invitee identifiers (#4197).
func GetSelfReferralInvitations(c *gin.Context) {
	inviterId := c.GetInt("id")
	if inviterId <= 0 {
		common.ApiErrorMsg(c, "unauthorized")
		return
	}
	query := model.ReferralInvitationQuery{InviterId: inviterId}
	pageInfo := common.GetPageQuery(c)
	invitations, err := model.ListReferralInvitations(query, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	total, err := model.CountReferralInvitations(query)
	if err != nil {
		common.ApiError(c, err)
		return
	}

	items := make([]referralInvitationSelfItem, 0, len(invitations))
	for i := range invitations {
		items = append(items, referralInvitationSelfItem{
			InviteeId:  invitations[i].InviteeId,
			Identifier: model.MaskReferralIdentifier(invitations[i].Username, invitations[i].Email),
			referralInvitationStatsFields: referralInvitationStatsFields{
				Source:           invitations[i].Source,
				BoundAt:          invitations[i].BoundAt,
				CommissionEndsAt: invitations[i].CommissionEndsAt,
				PendingQuota:     invitations[i].PendingQuota,
				LockedQuota:      invitations[i].LockedQuota,
				SettledQuota:     invitations[i].SettledQuota,
				TotalPaidQuota:   invitations[i].TotalPaidQuota,
				CommissionCount:  invitations[i].CommissionCount,
			},
		})
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(items)
	common.ApiSuccess(c, referralInvitationSelfResponse{
		PageInfo:          pageInfo,
		WindowMonths:      referralCommissionWindowMonths(),
		CommissionEnabled: referralCommissionEnabled(),
	})
}

// GetReferralInvitations lists every invitation platform-wide with the
// summary of the active filters (administrator view). The keyword matches the
// invitee's username, display name or email.
func GetReferralInvitations(c *gin.Context) {
	query, err := referralInvitationQueryFromRequest(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo := common.GetPageQuery(c)
	invitations, err := model.ListReferralInvitations(query, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	total, err := model.CountReferralInvitations(query)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	summary, err := model.SummarizeReferralInvitations(query)
	if err != nil {
		common.ApiError(c, err)
		return
	}

	items := make([]referralInvitationAdminItem, 0, len(invitations))
	for i := range invitations {
		items = append(items, referralInvitationAdminItem{
			InviteeId:       invitations[i].InviteeId,
			Username:        invitations[i].Username,
			Email:           invitations[i].Email,
			DisplayName:     invitations[i].DisplayName,
			InviterId:       invitations[i].InviterId,
			InviterUsername: invitations[i].InviterUsername,
			referralInvitationStatsFields: referralInvitationStatsFields{
				Source:           invitations[i].Source,
				BoundAt:          invitations[i].BoundAt,
				CommissionEndsAt: invitations[i].CommissionEndsAt,
				PendingQuota:     invitations[i].PendingQuota,
				LockedQuota:      invitations[i].LockedQuota,
				SettledQuota:     invitations[i].SettledQuota,
				TotalPaidQuota:   invitations[i].TotalPaidQuota,
				CommissionCount:  invitations[i].CommissionCount,
			},
		})
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(items)
	common.ApiSuccess(c, referralInvitationAdminResponse{
		PageInfo:          pageInfo,
		Summary:           *summary,
		WindowMonths:      referralCommissionWindowMonths(),
		CommissionEnabled: referralCommissionEnabled(),
	})
}

// ExportReferralInvitations streams the filtered invitation list as CSV. The
// export is bounded and read-only: it walks the list page by page and never
// moves a balance.
func ExportReferralInvitations(c *gin.Context) {
	query, err := referralInvitationQueryFromRequest(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}

	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="referral-invitations.csv"`)
	c.Header("Cache-Control", "no-store")
	c.Status(http.StatusOK)
	// UTF-8 BOM keeps spreadsheet tools from misreading non-ASCII meta text.
	_, _ = c.Writer.Write([]byte("\xEF\xBB\xBF"))

	writer := csv.NewWriter(c.Writer)
	_ = writer.Write([]string{
		"invitee_id", "username", "email", "display_name", "inviter_id", "inviter_username",
		"source", "bound_at", "commission_ends_at",
		"pending_quota", "locked_quota", "settled_quota", "total_paid_quota", "commission_count",
	})
	for written := 0; written < referralInvitationExportMaxRows; {
		limit := min(referralInvitationExportPageSize, referralInvitationExportMaxRows-written)
		invitations, err := model.ListReferralInvitations(query, written, limit)
		if err != nil {
			// The status line is already sent; log the failure for the operator.
			common.SysError(common.LogText("failed to export referral invitations: %s", err.Error()))
			return
		}
		if len(invitations) == 0 {
			break
		}
		for i := range invitations {
			invitation := &invitations[i]
			err = writer.Write([]string{
				strconv.Itoa(invitation.InviteeId),
				invitation.Username,
				invitation.Email,
				invitation.DisplayName,
				strconv.Itoa(invitation.InviterId),
				invitation.InviterUsername,
				invitation.Source,
				strconv.FormatInt(invitation.BoundAt, 10),
				strconv.FormatInt(invitation.CommissionEndsAt, 10),
				strconv.FormatInt(invitation.PendingQuota, 10),
				strconv.FormatInt(invitation.LockedQuota, 10),
				strconv.FormatInt(invitation.SettledQuota, 10),
				strconv.FormatInt(invitation.TotalPaidQuota, 10),
				strconv.FormatInt(invitation.CommissionCount, 10),
			})
			if err != nil {
				common.SysError(common.LogText("failed to export referral invitations: %s", err.Error()))
				return
			}
		}
		written += len(invitations)
	}
	writer.Flush()
}

// referralInvitationQueryFromRequest reads the administrator filters and
// rejects unknown values so a typo cannot silently return everything.
func referralInvitationQueryFromRequest(c *gin.Context) (model.ReferralInvitationQuery, error) {
	query := model.ReferralInvitationQuery{
		Keyword: c.Query("keyword"),
		Source:  c.Query("source"),
		Status:  c.Query("status"),
	}
	if !model.IsReferralSource(query.Source) {
		return query, fmt.Errorf("unknown referral source %q", query.Source)
	}
	if !model.IsReferralCommissionStatus(query.Status) {
		return query, fmt.Errorf("unknown referral commission status %q", query.Status)
	}
	return query, nil
}

// referralCommissionWindowMonths returns the configured trigger window:
// 0 = first paid order only, -1 = no expiry, otherwise months from sign-up.
func referralCommissionWindowMonths() int {
	return operation_setting.GetReferralSetting().WindowMonths
}

// referralCommissionEnabled reports whether the commission engine records new
// events; a disabled engine leaves every aggregate at its recorded value.
func referralCommissionEnabled() bool {
	return operation_setting.GetReferralSetting().Enabled
}
