package controller

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

// walletLedgerExportMaxRows bounds one CSV export so a huge history cannot
// exhaust server memory or a client connection.
const walletLedgerExportMaxRows = 100000

// GetSelfWalletLedger lists the caller's own wallet ledger entries.
func GetSelfWalletLedger(c *gin.Context) {
	walletLedgerResponse(c, c.GetInt("id"))
}

// GetUserWalletLedger lists one user's wallet ledger entries (admin).
func GetUserWalletLedger(c *gin.Context) {
	user, ok := requireManagedUser(c)
	if !ok {
		return
	}
	walletLedgerResponse(c, user.Id)
}

// GetUserWalletReconcile compares one user's wallet with its ledger sum.
func GetUserWalletReconcile(c *gin.Context) {
	user, ok := requireManagedUser(c)
	if !ok {
		return
	}
	result, err := model.ReconcileWalletLedgerForUser(user.Id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    result,
	})
}

// GetWalletDebtors lists the accounts whose wallet has unsettled debt together
// with the owed amount, so administrators can see and follow up on the
// read-only lock without querying the database by hand.
func GetWalletDebtors(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	debtors, total, err := model.ListWalletDebtors(pageInfo)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(debtors)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    pageInfo,
	})
}

// ExportSelfWalletLedger streams the caller's own ledger as CSV.
func ExportSelfWalletLedger(c *gin.Context) {
	exportWalletLedgerCSV(c, c.GetInt("id"))
}

// ExportUserWalletLedger streams one user's ledger as CSV (admin).
func ExportUserWalletLedger(c *gin.Context) {
	user, ok := requireManagedUser(c)
	if !ok {
		return
	}
	exportWalletLedgerCSV(c, user.Id)
}

func exportWalletLedgerCSV(c *gin.Context, userId int) {
	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="wallet-ledger-%d.csv"`, userId))
	c.Header("Cache-Control", "no-store")
	c.Status(http.StatusOK)
	// UTF-8 BOM keeps spreadsheet tools from misreading non-ASCII meta text.
	_, _ = c.Writer.Write([]byte("\xEF\xBB\xBF"))

	writer := csv.NewWriter(c.Writer)
	_ = writer.Write([]string{"id", "created_at", "kind", "amount", "balance_after", "ref_type", "ref_id", "meta"})
	err := model.StreamUserWalletLedger(userId, walletLedgerExportMaxRows, func(entry *model.WalletLedgerEntry) error {
		return writer.Write([]string{
			strconv.Itoa(entry.Id),
			strconv.FormatInt(entry.CreatedAt, 10),
			entry.Kind,
			strconv.FormatInt(entry.Amount, 10),
			strconv.FormatInt(entry.BalanceAfter, 10),
			entry.RefType,
			entry.RefId,
			entry.Meta,
		})
	})
	if err != nil {
		// The status line is already sent; log the failure for the operator.
		common.SysError(common.LogText("failed to export wallet ledger for user %d: %s", userId, err.Error()))
		return
	}
	writer.Flush()
}

func walletLedgerResponse(c *gin.Context, userId int) {
	pageInfo := common.GetPageQuery(c)
	entries, total, err := model.GetWalletLedgerEntries(userId, c.Query("kind"), pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(entries)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    pageInfo,
	})
}

// requireManagedUser resolves the :id path parameter and enforces the admin
// role hierarchy for the target account.
func requireManagedUser(c *gin.Context) (*model.User, bool) {
	userId, err := strconv.Atoi(c.Param("id"))
	if err != nil || userId <= 0 {
		common.ApiError(c, fmt.Errorf("invalid user id"))
		return nil, false
	}
	user, err := model.GetUserById(userId, false)
	if err != nil {
		common.ApiError(c, err)
		return nil, false
	}
	if !canManageTargetRole(c.GetInt("role"), user.Role) {
		common.ApiErrorT(c, "No permission to access users of same or higher level")
		return nil, false
	}
	return user, true
}
