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
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

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

// referralInvitationStatsFields is the shared payable commission aggregate of
// one listed invitation: quota amounts, the binding channel and the trigger
// window are read-only. The user-facing list exposes exactly these states,
// the reversed terminal state included, because a revoked commission is part
// of the inviter's own commission history.
type referralInvitationStatsFields struct {
	Source           string `json:"source"`
	BoundAt          int64  `json:"bound_at"`
	CommissionEndsAt int64  `json:"commission_ends_at"`
	PendingQuota     int64  `json:"pending_quota"`
	LockedQuota      int64  `json:"locked_quota"`
	SettledQuota     int64  `json:"settled_quota"`
	RefundedQuota    int64  `json:"refunded_quota"`
	TotalPaidQuota   int64  `json:"total_paid_quota"`
	CommissionCount  int64  `json:"commission_count"`
}

// referralInvitationAdminStatsFields adds the recorded states that wait for a
// decision or never pay out. Only administrators see them; exposing them to
// the inviter would leak the anti-abuse decisions of the platform.
type referralInvitationAdminStatsFields struct {
	referralInvitationStatsFields
	ReviewQuota   int64 `json:"review_quota"`
	BlockedQuota  int64 `json:"blocked_quota"`
	RejectedQuota int64 `json:"rejected_quota"`
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
	referralInvitationAdminStatsFields
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
				RefundedQuota:    invitations[i].RefundedQuota,
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
			referralInvitationAdminStatsFields: referralInvitationAdminStatsFields{
				referralInvitationStatsFields: referralInvitationStatsFields{
					Source:           invitations[i].Source,
					BoundAt:          invitations[i].BoundAt,
					CommissionEndsAt: invitations[i].CommissionEndsAt,
					PendingQuota:     invitations[i].PendingQuota,
					LockedQuota:      invitations[i].LockedQuota,
					SettledQuota:     invitations[i].SettledQuota,
					RefundedQuota:    invitations[i].RefundedQuota,
					TotalPaidQuota:   invitations[i].TotalPaidQuota,
					CommissionCount:  invitations[i].CommissionCount,
				},
				ReviewQuota:   invitations[i].ReviewQuota,
				BlockedQuota:  invitations[i].BlockedQuota,
				RejectedQuota: invitations[i].RejectedQuota,
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
// moves a balance. As an administrator view it carries the raw identifiers and
// every recorded commission state, refused events included.
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
		"pending_quota", "locked_quota", "settled_quota",
		"review_quota", "blocked_quota", "rejected_quota", "refunded_quota",
		"total_paid_quota", "commission_count",
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
				strconv.FormatInt(invitation.ReviewQuota, 10),
				strconv.FormatInt(invitation.BlockedQuota, 10),
				strconv.FormatInt(invitation.RejectedQuota, 10),
				strconv.FormatInt(invitation.RefundedQuota, 10),
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

// GetUserReferralProfile returns the anti-abuse view of one managed account:
// the registration signal, the identity correlation prefix, the flag and the
// commission summary.
func GetUserReferralProfile(c *gin.Context) {
	user, ok := requireManagedUser(c)
	if !ok {
		return
	}
	profile, err := model.GetReferralProfile(user.Id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    profile,
	})
}

type referralFlagRequest struct {
	Level string `json:"level"`
	Note  string `json:"note"`
}

// SetUserReferralFlag sets or clears the anti-abuse mark (watch or frozen) of a
// managed account.
func SetUserReferralFlag(c *gin.Context) {
	user, ok := requireManagedUser(c)
	if !ok {
		return
	}
	var request referralFlagRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	request.Level = strings.TrimSpace(request.Level)
	flag, err := model.SetReferralFlag(user.Id, request.Level, request.Note, c.GetInt("id"))
	if err != nil {
		if errors.Is(err, model.ErrReferralFlagLevelInvalid) {
			common.ApiErrorT(c, "Invalid parameters")
			return
		}
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, user.Id, "user.referral_flag", map[string]any{
		"username": user.Username,
		"id":       user.Id,
		"level":    request.Level,
		"note":     strings.TrimSpace(request.Note),
	})
	common.ApiSuccessT(c, "Referral flag updated", gin.H{"flag": flag})
}

type referralIdentityRequest struct {
	Identity string `json:"identity"`
}

// SetUserReferralIdentity records the administrator-verified real-name identity
// of a managed account. Only a hash is stored; the response exposes an
// 8-character correlation prefix.
func SetUserReferralIdentity(c *gin.Context) {
	user, ok := requireManagedUser(c)
	if !ok {
		return
	}
	var request referralIdentityRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	record, err := model.SetReferralIdentity(user.Id, request.Identity)
	if err != nil {
		if errors.Is(err, model.ErrReferralIdentityInvalid) {
			common.ApiErrorT(c, "Invalid parameters")
			return
		}
		common.ApiError(c, err)
		return
	}
	identityRef := record.IdentityHash
	if len(identityRef) > 8 {
		identityRef = identityRef[:8]
	}
	recordManageAuditFor(c, user.Id, "user.referral_identity", map[string]any{
		"username":     user.Username,
		"id":           user.Id,
		"identity_ref": identityRef,
	})
	common.ApiSuccessT(c, "Referral identity updated", gin.H{"identity_ref": identityRef})
}

// ClearUserReferralIdentity removes the recorded real-name identity of a
// managed account.
func ClearUserReferralIdentity(c *gin.Context) {
	user, ok := requireManagedUser(c)
	if !ok {
		return
	}
	if err := model.ClearReferralIdentity(user.Id); err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, user.Id, "user.referral_identity_clear", map[string]any{
		"username": user.Username,
		"id":       user.Id,
	})
	common.ApiSuccessT(c, "Referral identity cleared", nil)
}

// ListReferralCommissionReviews lists the commission events waiting for a
// manual decision.
func ListReferralCommissionReviews(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	reviews, total, err := model.ListReferralCommissionReviews(pageInfo)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(reviews)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    pageInfo,
	})
}

type referralReviewDecisionRequest struct {
	Decision string `json:"decision"`
}

// ReviewReferralCommission approves or rejects one reviewed commission event.
func ReviewReferralCommission(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	var request referralReviewDecisionRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	decision := strings.TrimSpace(request.Decision)
	if decision != "approve" && decision != "reject" {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	commission, err := model.DecideReferralCommissionReview(id, decision == "approve")
	if err != nil {
		if errors.Is(err, model.ErrReferralReviewNotPending) {
			common.ApiErrorT(c, "The referral review is no longer pending")
			return
		}
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, commission.InviterId, "user.referral_review", map[string]any{
		"id":               commission.Id,
		"decision":         decision,
		"invitee_id":       commission.InviteeId,
		"commission_quota": commission.CommissionQuota,
	})
	common.ApiSuccessT(c, "Referral review updated", gin.H{"commission": commission})
}

// referralAgentSelfResponse is the caller's own agent profile: whether the
// account is marked as a referral agent (推荐官/代理), the configured tier and
// the effective commission rate with its source, plus the invitation summary
// of the caller.
type referralAgentSelfResponse struct {
	Marked      bool                       `json:"marked"`
	TierId      string                     `json:"tier_id"`
	TierName    string                     `json:"tier_name"`
	RatePercent float64                    `json:"rate_percent"`
	RateSource  string                     `json:"rate_source"`
	Enabled     bool                       `json:"enabled"`
	Summary     model.ReferralStatsSummary `json:"summary"`
}

// GetSelfReferralAgent returns the caller's own referral agent profile:
// single-level, read-only and only ever the caller's own mark.
func GetSelfReferralAgent(c *gin.Context) {
	userId := c.GetInt("id")
	if userId <= 0 {
		common.ApiErrorMsg(c, "unauthorized")
		return
	}
	user, err := model.GetUserById(userId, false)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	agent, err := model.GetReferralAgent(userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	summary, err := model.SummarizeReferralInvitations(model.ReferralInvitationQuery{InviterId: userId})
	if err != nil {
		common.ApiError(c, err)
		return
	}
	response := referralAgentSelfResponse{
		Marked:  agent != nil,
		Enabled: referralCommissionEnabled(),
		Summary: *summary,
	}
	if agent != nil {
		response.TierId = agent.TierId
		if tier, ok := operation_setting.GetReferralSetting().AgentTier(agent.TierId); ok {
			response.TierName = tier.Name
		}
	}
	response.RatePercent, response.RateSource = model.ReferralCommissionRateFor(agent, user.Group)
	common.ApiSuccess(c, response)
}

// referralAgentAdminResponse is the paginated agent list with the configured
// tier catalogue the marks refer to.
type referralAgentAdminResponse struct {
	*common.PageInfo
	Tiers []operation_setting.ReferralAgentTier `json:"tiers"`
}

// GetReferralAgents lists the marked referral agent accounts with the account
// context and the effective rate of every mark (administrator view).
func GetReferralAgents(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	items, total, err := model.ListReferralAgents(pageInfo)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	tiers := operation_setting.GetReferralSetting().AgentTiers
	if tiers == nil {
		tiers = []operation_setting.ReferralAgentTier{}
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(items)
	common.ApiSuccess(c, referralAgentAdminResponse{
		PageInfo: pageInfo,
		Tiers:    tiers,
	})
}

type referralAgentUpdateRequest struct {
	TierId      *string  `json:"tier_id"`
	RatePercent *float64 `json:"rate_percent"`
	Note        string   `json:"note"`
}

// SetUserReferralAgent marks a managed account as a referral agent with an
// optional configured tier and/or single-account commission rate override.
func SetUserReferralAgent(c *gin.Context) {
	user, ok := requireManagedUser(c)
	if !ok {
		return
	}
	var request referralAgentUpdateRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	tierId := ""
	if request.TierId != nil {
		tierId = strings.TrimSpace(*request.TierId)
	}
	agent, err := model.SetReferralAgent(user.Id, tierId, request.RatePercent, request.Note, c.GetInt("id"))
	if err != nil {
		if errors.Is(err, model.ErrReferralAgentTierUnknown) {
			common.ApiErrorT(c, "Unknown referral agent tier")
			return
		}
		if errors.Is(err, model.ErrReferralAgentRateInvalid) {
			common.ApiErrorT(c, "Referral agent rate must be between 0 and 100")
			return
		}
		common.ApiError(c, err)
		return
	}
	params := map[string]any{
		"username": user.Username,
		"id":       user.Id,
		"tier_id":  tierId,
	}
	if request.RatePercent != nil {
		params["rate_percent"] = *request.RatePercent
	}
	recordManageAuditFor(c, user.Id, "user.referral_agent", params)
	common.ApiSuccessT(c, "Referral agent updated", gin.H{"agent": agent})
}

// ClearUserReferralAgent removes the agent mark of a managed account; the
// account then falls back to its group configuration.
func ClearUserReferralAgent(c *gin.Context) {
	user, ok := requireManagedUser(c)
	if !ok {
		return
	}
	if err := model.ClearReferralAgent(user.Id); err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAuditFor(c, user.Id, "user.referral_agent_clear", map[string]any{
		"username": user.Username,
		"id":       user.Id,
	})
	common.ApiSuccessT(c, "Referral agent cleared", nil)
}
