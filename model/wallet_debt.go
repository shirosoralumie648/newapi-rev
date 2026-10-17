package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	sqlitedriver "github.com/glebarez/go-sqlite"
	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
)

// Wallet debt accounting.
//
// The wallet of one account may go as far below zero as its overdraft credit
// line allows (per user group, default zero). A settlement charge is applied to
// the wallet down to that floor; whatever the wallet cannot cover becomes debt,
// recorded here and in the wallet ledger (kind=debt) in the same transaction.
// The account is locked read-only while debt is outstanding and recovers
// automatically once a recharge covers it: the next debt check collects the
// money from the wallet, which is also what keeps the quota cache in step.
//
// Two accounts stay consistent at all times:
//   - the sum of every non-debt ledger row equals User.Quota;
//   - the sum of every debt ledger row equals WalletDebt.Amount.

// WalletDebt is the outstanding uncovered part of one account's wallet charges.
type WalletDebt struct {
	Id        int   `json:"id" gorm:"primaryKey;autoIncrement"`
	UserId    int   `json:"user_id" gorm:"not null;uniqueIndex"`
	Amount    int64 `json:"amount" gorm:"type:bigint;not null"`
	CreatedAt int64 `json:"created_at" gorm:"bigint;not null"`
	UpdatedAt int64 `json:"updated_at" gorm:"bigint;not null"`
}

func (WalletDebt) TableName() string {
	return "wallet_debts"
}

func (d *WalletDebt) BeforeCreate(tx *gorm.DB) error {
	now := common.GetTimestamp()
	d.CreatedAt = now
	d.UpdatedAt = now
	return nil
}

func (d *WalletDebt) BeforeUpdate(tx *gorm.DB) error {
	d.UpdatedAt = common.GetTimestamp()
	return nil
}

// WalletDebtor is one read-only account with money owed to the platform.
type WalletDebtor struct {
	UserId    int    `json:"user_id"`
	Username  string `json:"username"`
	Group     string `json:"group"`
	Quota     int64  `json:"quota"`
	Debt      int64  `json:"debt"`
	UpdatedAt int64  `json:"updated_at"`
}

// lockWalletDebtTx loads and locks one account's debt row, or nil when the
// account never owed anything. Together with the wallet hold it fixes the
// transaction lock order used by every wallet mutation: hold -> user -> debt.
// The user row comes before the debt row so two charges that create the same
// account's first debt row serialize on the wallet instead of taking a gap lock
// that deadlocks with it.
func lockWalletDebtTx(tx *gorm.DB, userId int) (*WalletDebt, error) {
	var debt WalletDebt
	err := lockForUpdate(tx).Where("user_id = ?", userId).First(&debt).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &debt, nil
}

// appendWalletDebtLedgerTx records one debt account movement (positive when
// debt grows, negative when it is repaid). Reference ids are unique per event;
// replay safety comes from the enclosing transaction, which moves the debt and
// the wallet together.
func appendWalletDebtLedgerTx(tx *gorm.DB, userId int, amount int64, outstanding int64, meta string) error {
	if amount == 0 {
		return nil
	}
	refId := fmt.Sprintf("%d-%d-%s", userId, common.GetTimestamp(), common.GetRandomString(8))
	refType := WalletLedgerRefWalletDebt
	if amount < 0 {
		refType = WalletLedgerRefWalletDebtRepay
	}
	applied, err := AppendWalletLedgerTx(tx, &WalletLedgerEntry{
		UserId:       userId,
		Kind:         WalletLedgerKindDebt,
		Amount:       amount,
		BalanceAfter: outstanding,
		RefType:      refType,
		RefId:        refId,
		Meta:         fmt.Sprintf("outstanding_debt=%d %s", outstanding, meta),
		CreatedAt:    common.GetTimestamp(),
	})
	if err != nil {
		return err
	}
	if !applied {
		return errors.New("wallet debt ledger reference conflict")
	}
	return nil
}

// OverdraftLimitQuotaForGroup resolves the effective overdraft credit line of
// one user group in quota units.
func OverdraftLimitQuotaForGroup(group string) int64 {
	return operation_setting.GetQuotaSetting().OverdraftLimitQuota(group)
}

// OverdraftLimitForUser resolves the overdraft credit line of one account from
// its user group. Lookups run before a wallet transaction starts so SQLite's
// single-connection tests never read a second handle inside it.
func OverdraftLimitForUser(userId int) (int64, error) {
	if userId <= 0 {
		return 0, nil
	}
	group, err := GetUserGroup(userId, false)
	if err != nil {
		return 0, err
	}
	return OverdraftLimitQuotaForGroup(group), nil
}

// overdraftLimitForCharge resolves the credit line of a charge and falls back
// to zero, audited, when the group lookup fails: an unavailable group can only
// narrow the credit line, never widen it.
func overdraftLimitForCharge(userId int) int64 {
	limit, err := OverdraftLimitForUser(userId)
	if err != nil {
		common.SysError(common.LogText("failed to resolve the wallet overdraft limit of user %d, using 0: %s", userId, err.Error()))
		return 0
	}
	return limit
}

// WalletDebtForUser returns the outstanding debt of one account, zero when the
// account never owed anything. A database whose schema predates the debt table
// has no debt; every other error is reported.
func WalletDebtForUser(userId int) (int64, error) {
	if userId <= 0 {
		return 0, nil
	}
	var debt WalletDebt
	err := DB.Select("amount").Where("user_id = ?", userId).First(&debt).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, nil
	}
	if isWalletDebtTableMissing(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return debt.Amount, nil
}

// isWalletDebtTableMissing reports whether the database rejected a query
// because the wallet debt table does not exist, which means the schema predates
// wallet debt and therefore holds none. Driver error translation is disabled in
// this project, so the driver error is probed directly.
func isWalletDebtTableMissing(err error) bool {
	if err == nil {
		return false
	}
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1146
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "42P01"
	}
	var sqliteErr *sqlitedriver.Error
	if errors.As(err, &sqliteErr) {
		return sqliteErr.Code()&0xff == 1 && strings.Contains(sqliteErr.Error(), "no such table")
	}
	return false
}

// ResolveWalletDebtStatus returns the outstanding debt of one account and
// whether it is locked read-only because of it.
//
// A recharge cannot pay the debt inside its own transaction (the credit path
// only knows the gross amount), so the first debt check afterwards collects the
// owed money from the wallet. The collection is idempotent and a no-op without
// debt or without money above the credit line, which is what makes a recharged
// account recover automatically.
func ResolveWalletDebtStatus(userId int) (int64, bool, error) {
	debt, err := WalletDebtForUser(userId)
	if err != nil {
		return 0, false, err
	}
	if debt <= 0 {
		return 0, false, nil
	}
	collected, err := SettleWalletDebt(userId)
	if err != nil {
		return debt, true, err
	}
	return debt - collected, debt-collected > 0, nil
}

// SettleWalletDebt collects the outstanding debt from the wallet: money above
// the account's credit line pays the debt first, so it cannot be spent again.
// The wallet movement, the debt movement and both ledger rows commit together,
// and the collected amount is applied to the quota cache so the cache never
// authorizes money that just repaid debt.
func SettleWalletDebt(userId int) (int64, error) {
	if userId <= 0 {
		return 0, nil
	}
	limit, err := OverdraftLimitForUser(userId)
	if err != nil {
		return 0, err
	}
	collected := int64(0)
	err = DB.Transaction(func(tx *gorm.DB) error {
		balance, err := lockUserQuotaTx(tx, userId)
		if err != nil {
			return err
		}
		debt, err := lockWalletDebtTx(tx, userId)
		if err != nil {
			return err
		}
		if debt == nil || debt.Amount <= 0 {
			return nil
		}
		collected = min(debt.Amount, max(balance+limit, 0))
		if collected <= 0 {
			return nil
		}
		if _, err := addWalletQuotaChecked(balance, -collected, "wallet debt collection"); err != nil {
			return err
		}
		nextDebt, err := addWalletQuotaChecked(debt.Amount, -collected, "wallet debt collection")
		if err != nil {
			return err
		}
		// The money leaving the wallet is a wallet-account movement; the debt
		// shrinking is the matching debt-account movement.
		applied, err := ApplyWalletLedgerDelta(tx, userId, WalletLedgerKindDebtRepayment, -collected, WalletLedgerRefWalletDebtRepay,
			fmt.Sprintf("%d-%d-%s", userId, common.GetTimestamp(), common.GetRandomString(8)), "debt collection")
		if err != nil {
			return err
		}
		if !applied {
			return errors.New("wallet debt collection reference conflict")
		}
		debt.Amount = nextDebt
		if err := tx.Save(debt).Error; err != nil {
			return err
		}
		return appendWalletDebtLedgerTx(tx, userId, -collected, nextDebt, "debt collection")
	})
	if err != nil {
		return 0, err
	}
	if collected > 0 {
		syncWalletQuotaCache(userId, -collected, "wallet debt collection")
	}
	return collected, nil
}

// walletChargeSplit returns how much of one charge the wallet absorbs and how
// much of it becomes debt, given the wallet balance and its credit line.
func walletChargeSplit(balance int64, charge int64, limit int64) (applied int64, debt int64) {
	if charge <= 0 {
		return 0, 0
	}
	available := max(balance+limit, 0)
	applied = min(charge, available)
	return applied, charge - applied
}

// chargeWalletQuotaTx applies one wallet charge down to the account's credit
// line and records everything beyond it as debt. Applied and debt parts are
// returned so the caller can account only the wallet movement as consumption.
// It locks the user row before the debt row (hold -> user -> debt), the fixed
// order every wallet mutation follows.
func chargeWalletQuotaTx(tx *gorm.DB, userId int, charge int64, limit int64, requestId string) (int64, int64, error) {
	if charge <= 0 {
		return 0, 0, nil
	}
	balance, err := lockUserQuotaTx(tx, userId)
	if err != nil {
		return 0, 0, err
	}
	debt, err := lockWalletDebtTx(tx, userId)
	if err != nil {
		return 0, 0, err
	}
	outstanding := int64(0)
	if debt != nil {
		outstanding = debt.Amount
	}
	applied, debtIncrease := walletChargeSplit(balance, charge, limit)
	if applied > 0 {
		next, err := addWalletQuotaChecked(balance, -applied, "wallet charge")
		if err != nil {
			return 0, 0, err
		}
		if err := writeLockedWalletQuotaTx(tx, userId, next); err != nil {
			return 0, 0, err
		}
	}
	if debtIncrease <= 0 {
		return applied, 0, nil
	}
	nextDebt, err := addWalletQuotaChecked(outstanding, debtIncrease, "wallet debt")
	if err != nil {
		return 0, 0, err
	}
	if debt == nil {
		debt = &WalletDebt{UserId: userId, Amount: nextDebt}
		if err := tx.Create(debt).Error; err != nil {
			return 0, 0, err
		}
	} else {
		debt.Amount = nextDebt
		if err := tx.Save(debt).Error; err != nil {
			return 0, 0, err
		}
	}
	meta := "wallet charge beyond the overdraft limit"
	if requestId != "" {
		meta = fmt.Sprintf("request_id=%s", requestId)
	}
	if err := appendWalletDebtLedgerTx(tx, userId, debtIncrease, nextDebt, meta); err != nil {
		return 0, 0, err
	}
	return applied, debtIncrease, nil
}

// SettleWalletCharge applies a final wallet charge that has no durable hold
// (legacy requests without a request id): the wallet is debited down to the
// credit line and the remainder becomes debt. It returns the amount that
// actually left the wallet.
func SettleWalletCharge(userId int, amount int) (int, error) {
	if amount <= 0 {
		return 0, nil
	}
	limit := overdraftLimitForCharge(userId)
	applied := int64(0)
	err := DB.Transaction(func(tx *gorm.DB) error {
		var applyErr error
		applied, _, applyErr = chargeWalletQuotaTx(tx, userId, int64(amount), limit, "")
		return applyErr
	})
	if err != nil {
		return 0, err
	}
	if applied > 0 {
		syncWalletQuotaCache(userId, -applied, "wallet charge settlement")
	}
	return int(applied), nil
}

// ListWalletDebtors lists every account with outstanding debt, newest first,
// with the balance and group administrators need to judge the exposure.
func ListWalletDebtors(pageInfo *common.PageInfo) ([]WalletDebtor, int64, error) {
	var total int64
	if err := DB.Model(&WalletDebt{}).Where("amount > 0").Count(&total).Error; err != nil {
		return nil, 0, err
	}
	debtors := make([]WalletDebtor, 0)
	if total == 0 {
		return debtors, 0, nil
	}
	pageSize, offset := 20, 0
	if pageInfo != nil {
		pageSize = pageInfo.GetPageSize()
		offset = pageInfo.GetStartIdx()
	}
	var debts []WalletDebt
	if err := DB.Where("amount > 0").Order("updated_at DESC, id DESC").Limit(pageSize).Offset(offset).Find(&debts).Error; err != nil {
		return nil, total, err
	}
	userIds := make([]int, 0, len(debts))
	for _, debt := range debts {
		userIds = append(userIds, debt.UserId)
	}
	var users []User
	// Select the group by model field name so the dialect quotes it correctly.
	if err := DB.Select("id", "username", "group", "quota").Where("id IN ?", userIds).Find(&users).Error; err != nil {
		return nil, total, err
	}
	byId := make(map[int]User, len(users))
	for _, user := range users {
		byId[user.Id] = user
	}
	for _, debt := range debts {
		user := byId[debt.UserId]
		debtors = append(debtors, WalletDebtor{
			UserId:    debt.UserId,
			Username:  user.Username,
			Group:     user.Group,
			Quota:     int64(user.Quota),
			Debt:      debt.Amount,
			UpdatedAt: debt.UpdatedAt,
		})
	}
	return debtors, total, nil
}
