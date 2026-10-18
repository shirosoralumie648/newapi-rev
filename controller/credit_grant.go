package controller

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
)

// GetSelfCreditGrantWallet returns the caller's own wallet composition: the
// paid balance that never expires, the credit grant buckets with their
// validity, and the remainder of grants whose validity already elapsed.
func GetSelfCreditGrantWallet(c *gin.Context) {
	creditGrantWalletResponse(c, c.GetInt("id"))
}

// GetUserCreditGrantWallet returns one user's wallet composition (admin).
func GetUserCreditGrantWallet(c *gin.Context) {
	user, ok := requireManagedUser(c)
	if !ok {
		return
	}
	creditGrantWalletResponse(c, user.Id)
}

func creditGrantWalletResponse(c *gin.Context, userId int) {
	view, err := model.CreditGrantWalletForUser(userId, common.GetTimestamp())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    view,
	})
}

// GetCreditGrantStats reports the wallet totals administrators audit: money
// that entered through top-ups, grant-typed credit broken down by source,
// consumption, refunds and the credit that expired unused.
func GetCreditGrantStats(c *gin.Context) {
	stats, err := model.CreditGrantStatistics()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    stats,
	})
}

// creditGrantIssueRequest is the administrator credit issuance body.
// expires_in_days is optional: omitted keeps the configured validity of the
// source, 0 issues credit that never expires.
type creditGrantIssueRequest struct {
	UserId        int    `json:"user_id"`
	Source        string `json:"source"`
	Quota         int    `json:"quota"`
	ExpiresInDays *int   `json:"expires_in_days"`
	Note          string `json:"note"`
}

// IssueCreditGrant credits one user with a grant-typed amount. The credit is
// recorded through the wallet ledger and the matching credit grant bucket in
// one transaction, so a retried request can never credit the same amount twice
// and the bucket carries its source and validity.
func IssueCreditGrant(c *gin.Context) {
	var req creditGrantIssueRequest
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	req.Source = strings.TrimSpace(req.Source)
	req.Note = strings.TrimSpace(req.Note)
	if req.UserId <= 0 || !operation_setting.IsCreditGrantSource(req.Source) || req.Quota <= 0 || len(req.Note) > model.CreditGrantNoteMaxLength {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	if err := common.ValidateWalletQuota(req.Quota); err != nil {
		common.ApiError(c, err)
		return
	}
	now := common.GetTimestamp()
	expiresAt := int64(0)
	if req.ExpiresInDays == nil {
		expiresAt = model.CreditGrantExpiryFor(req.Source, now)
	} else if *req.ExpiresInDays < 0 || *req.ExpiresInDays > operation_setting.CreditGrantMaxExpiryDays {
		common.ApiErrorT(c, "Invalid parameters")
		return
	} else if *req.ExpiresInDays > 0 {
		expiresAt = now + int64(*req.ExpiresInDays)*86400
	}

	user, err := model.GetUserById(req.UserId, false)
	if err != nil {
		common.ApiErrorT(c, "User does not exist")
		return
	}
	if !canManageTargetRole(c.GetInt("role"), user.Role) {
		common.ApiErrorT(c, "No permission to update users of same or higher permission level")
		return
	}

	action := "user.credit_grant"
	params := model.AuditFields{
		"target_user_id":  user.Id,
		"target_username": user.Username,
		"source":          req.Source,
		"quota":           req.Quota,
		"expires_at":      expiresAt,
	}
	success := false
	defer func() {
		content := auditContentEN(action, params)
		if !success {
			content = "Failed credit grant issuance"
		}
		model.RecordOperationAuditLog(c.GetInt("id"), c.GetInt("role"), content, c.ClientIP(), action, params,
			auditOperatorInfo(c), &model.AuditRequestInfo{
				Method: c.Request.Method, Route: c.FullPath(), Status: c.Writer.Status(), Success: success,
			}, c)
		markAuditLogged(c)
	}()

	applied, err := model.IssueCreditGrant(user.Id, req.Source, req.Quota, expiresAt, model.WalletLedgerKindSystemGrant, model.WalletLedgerRefAdminGrant, creditGrantIssueRefId(user.Id, now), req.Note)
	if err != nil {
		params["failure_reason"] = "database_error"
		common.ApiError(c, err)
		return
	}
	params["applied"] = applied
	success = true
	operation := model.AuditOperation{Action: action, Params: params}
	model.RecordLogWithAdminInfo(user.Id, model.LogTypeTopup, auditContentEN(action, params), auditOperatorInfo(c), &operation, c)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
	})
}

// creditGrantIssueRefId builds a unique ledger reference for one administrator
// issuance, so two identical grants are two separate credits.
func creditGrantIssueRefId(userId int, now int64) string {
	return fmt.Sprintf("%d-%d-%s", userId, now, common.GetRandomString(8))
}
