package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Wallet hold lifecycle states. A hold stays active until the request it was
// created for is settled (the reserved quota is legitimately spent), refunded
// (the request failed) or expired (the process that created it disappeared).
const (
	WalletHoldStatusActive   = "active"
	WalletHoldStatusSettled  = "settled"
	WalletHoldStatusRefunded = "refunded"
	WalletHoldStatusExpired  = "expired"
)

var (
	// ErrWalletHoldClosed refuses an operation that would re-open or extend a
	// hold which already reached a terminal state.
	ErrWalletHoldClosed = errors.New("wallet hold is already closed")
	// ErrWalletHoldNotFound marks a missing parent hold when a budget child is
	// mounted.
	ErrWalletHoldNotFound = errors.New("wallet hold not found")
	// ErrWalletHoldInsufficientQuota rejects a budget reservation the wallet
	// cannot cover.
	ErrWalletHoldInsufficientQuota = errors.New("insufficient wallet quota for the hold")
	// ErrWalletBudgetExceeded rejects a workflow step allocation that would
	// exceed the run budget its parent hold reserved (BL-03).
	ErrWalletBudgetExceeded = errors.New("wallet budget exceeded")
)

const (
	// walletHoldDefaultTTLSeconds bounds how long one reservation may stay
	// unsettled before the recovery sweep returns it to the wallet. It is
	// deliberately longer than any single relay request, so the sweep can only
	// observe reservations whose process is gone.
	walletHoldDefaultTTLSeconds = 3600
	walletHoldMinTTLSeconds     = 60
)

// WalletHoldTTLSeconds is the reservation lifetime in seconds, configurable
// through WALLET_HOLD_TTL_SECONDS.
func WalletHoldTTLSeconds() int {
	ttl := common.GetEnvOrDefault("WALLET_HOLD_TTL_SECONDS", walletHoldDefaultTTLSeconds)
	if ttl < walletHoldMinTTLSeconds {
		ttl = walletHoldMinTTLSeconds
	}
	return ttl
}

// WalletHold is the durable record of one wallet pre-consume. Amount is the
// quota this hold reserved, already deducted from the wallet: the available
// balance stays exactly quota, there is no separate freeze. A root hold
// (ParentId nil) owns that money; a child hold mounted on a workflow run budget
// (ParentId set, BL-03) only records an allocation inside the budget its parent
// already reserved.
//
// Settlement and refund close the hold in the same transaction that moves the
// money and are keyed by RequestId, so replaying either transition never moves
// quota twice. Requests whose process disappeared before a transition are
// refunded by RefundExpiredWalletHolds.
type WalletHold struct {
	Id        int    `json:"id" gorm:"primaryKey;autoIncrement"`
	RequestId string `json:"request_id" gorm:"type:varchar(64);not null;uniqueIndex"`
	UserId    int    `json:"user_id" gorm:"not null;index"`
	Amount    int64  `json:"amount" gorm:"type:bigint;not null"`
	Status    string `json:"status" gorm:"type:varchar(32);not null;index"`
	// ParentId points at the budget hold a child hold was mounted on; nil for
	// holds that deducted quota themselves.
	ParentId  *int  `json:"parent_id" gorm:"index"`
	ExpiresAt int64 `json:"expires_at" gorm:"bigint;not null;index"`
	CreatedAt int64 `json:"created_at" gorm:"bigint;not null"`
	UpdatedAt int64 `json:"updated_at" gorm:"bigint;not null"`
}

func (WalletHold) TableName() string {
	return "wallet_holds"
}

// WalletHoldGrant records how much of one wallet hold was attributed to one
// credit grant. The rows are the composition of the reservation: a refund or a
// partial release returns the money to the same buckets it came from, and the
// rows are deleted together with their hold.
type WalletHoldGrant struct {
	Id        int   `json:"id" gorm:"primaryKey;autoIncrement"`
	HoldId    int   `json:"hold_id" gorm:"not null;uniqueIndex:idx_wallet_hold_grant,priority:1"`
	GrantId   int   `json:"grant_id" gorm:"not null;uniqueIndex:idx_wallet_hold_grant,priority:2"`
	Amount    int64 `json:"amount" gorm:"type:bigint;not null"`
	CreatedAt int64 `json:"created_at" gorm:"bigint;not null"`
}

func (WalletHoldGrant) TableName() string {
	return "wallet_hold_grants"
}

// recordWalletHoldGrantClaimsTx appends the grant composition of one
// reservation. Extending an active hold adds to the existing per-grant claims.
func recordWalletHoldGrantClaimsTx(tx *gorm.DB, holdId int, allocations []creditGrantAllocation) error {
	for _, allocation := range allocations {
		if allocation.Amount <= 0 {
			continue
		}
		row := &WalletHoldGrant{
			HoldId:    holdId,
			GrantId:   allocation.GrantId,
			Amount:    allocation.Amount,
			CreatedAt: common.GetTimestamp(),
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "hold_id"}, {Name: "grant_id"}},
			DoUpdates: clause.Assignments(map[string]any{
				"amount": gorm.Expr("wallet_hold_grants.amount + ?", allocation.Amount),
			}),
		}).Create(row).Error; err != nil {
			return err
		}
	}
	return nil
}

// lockWalletHoldGrantClaimsTx loads the recorded claims of one hold in the
// order they were claimed, which is the spending order of the reservation.
func lockWalletHoldGrantClaimsTx(tx *gorm.DB, holdId int) ([]WalletHoldGrant, error) {
	var rows []WalletHoldGrant
	err := lockForUpdate(tx).Where("hold_id = ? AND amount > 0", holdId).Order("id asc").Find(&rows).Error
	return rows, err
}

// releaseWalletHoldClaimsTx returns release quota of a hold's reservation to
// the wallet in reverse charging order and keeps the recorded composition in
// step: the part of the charge that was not attributed to a grant comes back
// first, then the claims are restored from the most recently claimed grant back
// to the earliest. The caller is responsible for the balance movement itself
// (which always returns the whole released amount) and must hold the user row
// lock, so the lock order stays hold -> user -> grants.
func releaseWalletHoldClaimsTx(tx *gorm.DB, hold *WalletHold, release int64) error {
	if hold == nil || release <= 0 {
		return nil
	}
	claims, err := lockWalletHoldGrantClaimsTx(tx, hold.Id)
	if err != nil {
		return err
	}
	claimTotal := int64(0)
	for i := range claims {
		claimTotal += claims[i].Amount
	}
	// The unattributed part of the reservation is the paid balance; it was
	// charged after the grants, so it is returned first.
	remaining := release - min(release, max(hold.Amount-claimTotal, 0))
	if remaining <= 0 {
		return nil
	}
	for i := len(claims) - 1; i >= 0 && remaining > 0; i-- {
		take := min(claims[i].Amount, remaining)
		if take <= 0 {
			continue
		}
		restored, err := restoreCreditGrantTx(tx, claims[i].GrantId, take)
		if err != nil {
			return err
		}
		if restored <= 0 {
			continue
		}
		if err := tx.Model(&WalletHoldGrant{}).Where("id = ?", claims[i].Id).Update("amount", claims[i].Amount-restored).Error; err != nil {
			return err
		}
		remaining -= restored
	}
	return nil
}

func (h *WalletHold) BeforeCreate(tx *gorm.DB) error {
	now := common.GetTimestamp()
	h.CreatedAt = now
	h.UpdatedAt = now
	return nil
}

func (h *WalletHold) BeforeUpdate(tx *gorm.DB) error {
	h.UpdatedAt = common.GetTimestamp()
	return nil
}

// addWalletQuotaChecked applies a signed delta to a wallet quota value within
// the shared wallet bound, in both directions. Saturation is audited through
// common.SysError like every other quota clamp.
func addWalletQuotaChecked(current int64, delta int64, operation string) (int64, error) {
	if delta == 0 {
		return current, nil
	}
	next := current + delta
	if (delta > 0 && next < current) || (delta < 0 && next > current) {
		common.SysError(common.LogText("wallet quota overflow (%s): current=%d delta=%d", operation, current, delta))
		return 0, ErrWalletQuotaLimitExceeded
	}
	if next > int64(common.MaxWalletQuota) || next < -int64(common.MaxWalletQuota) {
		common.SysError(common.LogText("wallet quota limit (%s): current=%d delta=%d exceeds %d", operation, current, delta, int64(common.MaxWalletQuota)))
		return 0, ErrWalletQuotaLimitExceeded
	}
	return next, nil
}

// syncWalletQuotaCache applies an already committed wallet delta to the user
// cache. A cache miss is a no-op: the next read hydrates the committed balance.
func syncWalletQuotaCache(userId int, delta int64, operation string) {
	if delta == 0 {
		return
	}
	if err := cacheIncrUserQuota(userId, delta); err != nil {
		common.SysLog(common.LogText("failed to sync %s to user quota cache: %s", operation, err.Error()))
	}
}

// lockWalletHoldTx locks and loads the hold of requestId inside tx. It returns
// (nil, nil) when the request has no hold, for example a request admitted
// before wallet holds existed.
func lockWalletHoldTx(tx *gorm.DB, requestId string) (*WalletHold, error) {
	var hold WalletHold
	err := lockForUpdate(tx).Where("request_id = ?", requestId).First(&hold).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &hold, nil
}

// lockUserQuotaTx locks one user row and returns its committed quota.
func lockUserQuotaTx(tx *gorm.DB, userId int) (int64, error) {
	var user User
	if err := lockForUpdate(tx).Select("id", "quota").Where("id = ?", userId).First(&user).Error; err != nil {
		return 0, err
	}
	return int64(user.Quota), nil
}

func writeLockedWalletQuotaTx(tx *gorm.DB, userId int, balance int64) error {
	return tx.Model(&User{}).Where("id = ?", userId).Update("quota", balance).Error
}

// upsertWalletHoldTx records a reservation of amount for requestId. An existing
// active hold is extended, because one request can raise its reservation when
// the selected channel or the outbound image quantity changes the estimate; a
// closed hold refuses the reservation so quota is never held twice.
func upsertWalletHoldTx(tx *gorm.DB, existing *WalletHold, userId int, requestId string, amount int64, now int64) (*WalletHold, error) {
	expiresAt := now + int64(WalletHoldTTLSeconds())
	if existing == nil {
		hold := &WalletHold{
			RequestId: requestId,
			UserId:    userId,
			Amount:    amount,
			Status:    WalletHoldStatusActive,
			ExpiresAt: expiresAt,
		}
		if err := tx.Create(hold).Error; err != nil {
			return nil, err
		}
		return hold, nil
	}
	if existing.UserId != userId {
		return nil, fmt.Errorf("wallet hold %s belongs to user %d", requestId, existing.UserId)
	}
	if existing.Status != WalletHoldStatusActive {
		return nil, ErrWalletHoldClosed
	}
	next, err := addWalletQuotaChecked(existing.Amount, amount, "wallet hold reserve")
	if err != nil {
		return nil, err
	}
	existing.Amount = next
	existing.ExpiresAt = max(existing.ExpiresAt, expiresAt)
	if err := tx.Save(existing).Error; err != nil {
		return nil, err
	}
	return existing, nil
}

// closeWalletHoldChildrenTx closes every active child of a budget hold with the
// same terminal status as its parent, so no allocation outlives its budget.
func closeWalletHoldChildrenTx(tx *gorm.DB, parentId int, status string, now int64) error {
	return tx.Model(&WalletHold{}).
		Where("parent_id = ? AND status = ?", parentId, WalletHoldStatusActive).
		Updates(map[string]any{"status": status, "updated_at": now}).Error
}

// reserveWalletQuotaWithHoldTx deducts quota and records the matching hold in
// one transaction. The lock order is fixed (hold first, then the user row, then
// the credit grants and the debt row) so concurrent reserves, settlements,
// refunds and debt collections of one user cannot deadlock.
//
// requireBalance=true is the pre-consume reservation: it only deducts when the
// whole amount fits above the account's credit line (-limit). requireBalance=false
// mirrors the settlement top-up: the wallet is debited down to the credit line
// and the remainder becomes tracked debt. The returned value is the amount that
// actually left the wallet.
//
// The deduction is attributed to the account's credit grants in spending order
// (earliest expiry first) and that composition is recorded on the hold, so a
// refund returns the money to the same buckets.
func reserveWalletQuotaWithHoldTx(userId int, quota int64, requestId string, requireBalance bool) (int64, error) {
	if quota <= 0 {
		return 0, nil
	}
	limit := overdraftLimitForCharge(userId)
	applied := int64(0)
	err := DB.Transaction(func(tx *gorm.DB) error {
		hold, err := lockWalletHoldTx(tx, requestId)
		if err != nil {
			return err
		}
		if hold != nil && hold.Status != WalletHoldStatusActive {
			return ErrWalletHoldClosed
		}
		if hold != nil && hold.UserId != userId {
			return fmt.Errorf("wallet hold %s belongs to user %d", requestId, hold.UserId)
		}
		now := common.GetTimestamp()
		grants := []CreditGrant(nil)
		if requireBalance {
			balance, err := lockUserQuotaTx(tx, userId)
			if err != nil {
				return err
			}
			grants, err = lockCreditGrantsTx(tx, userId)
			if err != nil {
				return err
			}
			// Credit a grant whose validity already elapsed still sits in the
			// balance until the sweep voids it; it is not spendable.
			_, expired := creditGrantAvailability(grants, now)
			if balance-expired+limit < quota {
				return nil
			}
			next, err := addWalletQuotaChecked(balance, -quota, "wallet hold reserve")
			if err != nil {
				return err
			}
			if err := writeLockedWalletQuotaTx(tx, userId, next); err != nil {
				return err
			}
			applied = quota
		} else {
			applied, _, err = chargeWalletQuotaTx(tx, userId, quota, limit, requestId)
			if err != nil {
				return err
			}
			if applied > 0 {
				grants, err = lockCreditGrantsTx(tx, userId)
				if err != nil {
					return err
				}
			}
		}
		if applied <= 0 {
			return nil
		}
		allocations, _, err := claimCreditGrantsTx(tx, userId, applied, grants, now)
		if err != nil {
			return err
		}
		// The hold records exactly the money the wallet actually gave up, so a
		// refund can never return more than was deducted.
		nextHold, err := upsertWalletHoldTx(tx, hold, userId, requestId, applied, now)
		if err != nil {
			return err
		}
		return recordWalletHoldGrantClaimsTx(tx, nextHold.Id, allocations)
	})
	if err != nil {
		return 0, err
	}
	return applied, nil
}

// SettleWalletHold closes the request's hold as settled and applies the
// settlement difference to the wallet in one transaction. It returns the quota
// that actually left the wallet (positive when the request cost more than
// reserved, negative when part of the reservation is returned, zero for a
// replay). A top-up beyond the account's credit line is not deducted from the
// wallet: it is recorded as debt, so the returned value can be smaller than the
// difference that was charged.
//
// A settlement top-up is attributed to the account's credit grants (earliest
// expiry first) and a settlement refund is returned in reverse charging order,
// so the buckets of a partially used reservation stay exactly reversible.
//
// A hold that was already refunded or expired (the process stopped before
// settling and the sweep returned the reservation) is not re-opened: the full
// actual charge is applied instead of only the difference, because the
// pre-consume is no longer held.
func SettleWalletHold(userId int, requestId string, delta int64) (int64, error) {
	if strings.TrimSpace(requestId) == "" {
		return 0, errors.New("requestId is empty")
	}
	limit := overdraftLimitForCharge(userId)
	walletDelta := int64(0)
	err := DB.Transaction(func(tx *gorm.DB) error {
		var err error
		walletDelta, err = settleWalletHoldTx(tx, userId, requestId, delta, limit)
		return err
	})
	if err != nil {
		return 0, err
	}
	if walletDelta != 0 {
		syncWalletQuotaCache(userId, -walletDelta, "wallet hold settlement")
	}
	return walletDelta, nil
}

// settleWalletHoldTx settles one request's hold inside tx and returns the quota
// that actually left the wallet (negative when part of the reservation is
// returned). It keeps the transaction semantics of SettleWalletHold so a
// workflow run settlement (BL-03) can reuse the exact same movement rules. The
// caller must apply the returned delta to the quota cache.
func settleWalletHoldTx(tx *gorm.DB, userId int, requestId string, delta int64, limit int64) (int64, error) {
	hold, err := lockWalletHoldTx(tx, requestId)
	if err != nil {
		return 0, err
	}
	now := common.GetTimestamp()
	charged := int64(0)
	if hold == nil {
		// A request admitted before wallet holds existed settles the raw
		// difference.
		charged = delta
	} else {
		if hold.UserId != userId {
			return 0, fmt.Errorf("wallet hold %s belongs to user %d", requestId, hold.UserId)
		}
		switch hold.Status {
		case WalletHoldStatusActive:
			charged = delta
		case WalletHoldStatusSettled:
			// The settlement already moved the wallet.
			return 0, nil
		default:
			// The reservation was returned; the whole actual charge is
			// still outstanding.
			charged, err = addWalletQuotaChecked(delta, hold.Amount, "wallet hold settle after refund")
			if err != nil {
				return 0, err
			}
		}
	}
	if hold != nil && hold.Status == WalletHoldStatusActive {
		hold.Status = WalletHoldStatusSettled
		if err := tx.Save(hold).Error; err != nil {
			return 0, err
		}
		if err := closeWalletHoldChildrenTx(tx, hold.Id, WalletHoldStatusSettled, now); err != nil {
			return 0, err
		}
	}
	if charged == 0 {
		return 0, nil
	}
	if charged > 0 {
		applied, _, err := chargeWalletQuotaTx(tx, userId, charged, limit, requestId)
		if err != nil {
			return 0, err
		}
		if applied > 0 {
			grants, err := lockCreditGrantsTx(tx, userId)
			if err != nil {
				return 0, err
			}
			if _, _, err := claimCreditGrantsTx(tx, userId, applied, grants, now); err != nil {
				return 0, err
			}
		}
		return applied, nil
	}
	balance, err := lockUserQuotaTx(tx, userId)
	if err != nil {
		return 0, err
	}
	next, err := addWalletQuotaChecked(balance, -charged, "wallet hold settle")
	if err != nil {
		return 0, err
	}
	if err := writeLockedWalletQuotaTx(tx, userId, next); err != nil {
		return 0, err
	}
	return charged, releaseWalletHoldClaimsTx(tx, hold, -charged)
}

// RefundWalletHold closes an active hold as refunded and returns the whole held
// amount to the wallet in one transaction. Every replay (already refunded,
// expired or settled) is a no-op, so the wallet never receives the same
// reservation twice. fallbackAmount is used only for requests that have no hold
// row (a request admitted before wallet holds existed).
func RefundWalletHold(userId int, requestId string, fallbackAmount int) (bool, error) {
	if strings.TrimSpace(requestId) == "" {
		return false, errors.New("requestId is empty")
	}
	refunded := int64(0)
	err := DB.Transaction(func(tx *gorm.DB) error {
		hold, err := lockWalletHoldTx(tx, requestId)
		if err != nil {
			return err
		}
		if hold == nil {
			if fallbackAmount <= 0 {
				return nil
			}
			applied, err := ApplyWalletLedgerDelta(tx, userId, WalletLedgerKindRefund, int64(fallbackAmount), WalletLedgerRefRequestRefund, requestId, "")
			if err != nil {
				return err
			}
			if applied {
				refunded = int64(fallbackAmount)
			}
			return nil
		}
		if hold.UserId != userId {
			return fmt.Errorf("wallet hold %s belongs to user %d", requestId, hold.UserId)
		}
		if hold.Status != WalletHoldStatusActive {
			return nil
		}
		if hold.Amount > 0 {
			applied, err := ApplyWalletLedgerDelta(tx, hold.UserId, WalletLedgerKindRefund, hold.Amount, WalletLedgerRefRequestRefund, requestId, "")
			if err != nil {
				return err
			}
			if applied {
				refunded = hold.Amount
			}
		}
		if err := releaseWalletHoldClaimsTx(tx, hold, hold.Amount); err != nil {
			return err
		}
		hold.Status = WalletHoldStatusRefunded
		if err := tx.Save(hold).Error; err != nil {
			return err
		}
		return closeWalletHoldChildrenTx(tx, hold.Id, WalletHoldStatusRefunded, common.GetTimestamp())
	})
	if err != nil {
		return false, err
	}
	if refunded > 0 {
		syncWalletQuotaCache(userId, refunded, "wallet hold refund")
	}
	return refunded > 0, nil
}

// ReverseWalletHoldReserve returns an extra reservation to the wallet and
// shrinks the matching hold in one transaction. It is used when a mid-flight
// reserve has to be rolled back (for example the token quota failed after the
// funding was reserved), so the recovery sweep can never refund that amount a
// second time.
func ReverseWalletHoldReserve(userId int, requestId string, delta int) error {
	if delta <= 0 {
		return nil
	}
	if requestId == "" {
		if err := IncreaseUserQuota(userId, delta, false); err != nil {
			return err
		}
		RecordWalletConsumeDelta(userId, int64(delta))
		return nil
	}
	released := int64(0)
	err := DB.Transaction(func(tx *gorm.DB) error {
		hold, err := lockWalletHoldTx(tx, requestId)
		if err != nil {
			return err
		}
		if hold == nil || hold.Status != WalletHoldStatusActive {
			return ErrWalletHoldClosed
		}
		asserted := min(int64(delta), hold.Amount)
		if asserted <= 0 {
			return nil
		}
		balance, err := lockUserQuotaTx(tx, userId)
		if err != nil {
			return err
		}
		next, err := addWalletQuotaChecked(balance, asserted, "wallet hold reserve rollback")
		if err != nil {
			return err
		}
		if err := writeLockedWalletQuotaTx(tx, userId, next); err != nil {
			return err
		}
		// The returned part follows the reverse charging order, so the grant
		// composition of the remaining reservation stays correct.
		if err := releaseWalletHoldClaimsTx(tx, hold, asserted); err != nil {
			return err
		}
		hold.Amount -= asserted
		if err := tx.Save(hold).Error; err != nil {
			return err
		}
		released = asserted
		return nil
	})
	if err != nil {
		return err
	}
	if released > 0 {
		syncWalletQuotaCache(userId, released, "wallet hold reserve rollback")
		RecordWalletConsumeDelta(userId, released)
	}
	return nil
}

// CreateWalletBudgetHold reserves a workflow run budget (BL-03): the budget is
// deducted from the wallet and a root hold is opened, so per-step child holds
// can mount on it without deducting the same quota twice.
func CreateWalletBudgetHold(userId int, requestId string, amount int) (*WalletHold, error) {
	if strings.TrimSpace(requestId) == "" {
		return nil, errors.New("requestId is empty")
	}
	if amount <= 0 {
		return nil, errors.New("budget amount must be > 0")
	}
	if err := common.ValidateWalletQuota(amount); err != nil {
		return nil, err
	}
	reserved, err := TryReserveUserQuota(userId, amount, requestId)
	if err != nil {
		return nil, err
	}
	if !reserved {
		return nil, ErrWalletHoldInsufficientQuota
	}
	// The cap is already spent money, so the consumption ledger records it at
	// creation; the run settlement later records the correction between the cap
	// and the steps' actual cost. Σ non-debt ledger rows therefore always equals
	// the wallet balance.
	RecordWalletConsumeDelta(userId, -int64(amount))
	return GetWalletHoldByRequestId(requestId)
}

// MountWalletBudgetChild records a child hold under an active budget hold. The
// child deducts nothing: its amount is the allocation the parent already
// reserved, and it is closed together with the parent.
func MountWalletBudgetChild(parentRequestId string, requestId string, userId int, amount int) (*WalletHold, error) {
	if strings.TrimSpace(parentRequestId) == "" || strings.TrimSpace(requestId) == "" {
		return nil, errors.New("parent and child request ids are required")
	}
	if amount < 0 {
		return nil, errors.New("budget allocation cannot be negative")
	}
	if err := common.ValidateWalletQuota(amount); err != nil {
		return nil, err
	}
	var child *WalletHold
	err := DB.Transaction(func(tx *gorm.DB) error {
		parent, err := lockWalletHoldTx(tx, parentRequestId)
		if err != nil {
			return err
		}
		if parent == nil {
			return ErrWalletHoldNotFound
		}
		if parent.ParentId != nil {
			return fmt.Errorf("wallet hold %s is not a root budget hold", parentRequestId)
		}
		if parent.UserId != userId {
			return fmt.Errorf("wallet hold %s belongs to user %d", parentRequestId, parent.UserId)
		}
		if parent.Status != WalletHoldStatusActive {
			return ErrWalletHoldClosed
		}
		existing, err := lockWalletHoldTx(tx, requestId)
		if err != nil {
			return err
		}
		if existing != nil {
			if existing.UserId != userId {
				return fmt.Errorf("wallet hold %s belongs to user %d", requestId, existing.UserId)
			}
			if existing.ParentId == nil || *existing.ParentId != parent.Id {
				return fmt.Errorf("wallet hold %s is not mounted on %s", requestId, parentRequestId)
			}
			if existing.Status != WalletHoldStatusActive {
				return ErrWalletHoldClosed
			}
			next, err := addWalletQuotaChecked(existing.Amount, int64(amount), "wallet budget allocation")
			if err != nil {
				return err
			}
			existing.Amount = next
			if err := tx.Save(existing).Error; err != nil {
				return err
			}
			child = existing
			return nil
		}
		parentId := parent.Id
		child = &WalletHold{
			RequestId: requestId,
			UserId:    userId,
			Amount:    int64(amount),
			Status:    WalletHoldStatusActive,
			ParentId:  &parentId,
			ExpiresAt: max(parent.ExpiresAt, common.GetTimestamp()+int64(WalletHoldTTLSeconds())),
		}
		return tx.Create(child).Error
	})
	if err != nil {
		return nil, err
	}
	return child, nil
}

// GetWalletHoldByRequestId loads one hold, used by budget callers and by
// diagnostics.
func GetWalletHoldByRequestId(requestId string) (*WalletHold, error) {
	if strings.TrimSpace(requestId) == "" {
		return nil, errors.New("requestId is empty")
	}
	var hold WalletHold
	if err := DB.Where("request_id = ?", requestId).First(&hold).Error; err != nil {
		return nil, err
	}
	return &hold, nil
}

// ReserveWalletBudgetChild allocates one workflow step inside a run budget
// (BL-03). The amount is absolute: a retried step replaces its previous
// allocation instead of stacking on it. The sum of the run's active allocations
// may not exceed the budget cap its parent hold reserved, so a step that would
// cross the cap is refused before it starts and the caller aborts the remaining
// nodes.
func ReserveWalletBudgetChild(parentRequestId string, requestId string, userId int, amount int) (*WalletHold, error) {
	return writeWalletBudgetChild(parentRequestId, requestId, userId, amount, true)
}

// SettleWalletBudgetChild records the actual cost of one finished workflow step
// in its run budget (BL-03). Unlike a reservation, an absolute amount is
// accepted even when it crosses the remaining cap: the step already ran, and the
// run settlement bills what it actually cost. Zero releases the step's whole
// allocation back to the budget.
func SettleWalletBudgetChild(parentRequestId string, requestId string, userId int, actual int) (*WalletHold, error) {
	return writeWalletBudgetChild(parentRequestId, requestId, userId, actual, false)
}

// writeWalletBudgetChild writes the child hold of one step inside its run
// budget. It locks the parent first (row order: parent, child) and renews the
// parent's reservation lifetime while the run is active, so a long run is never
// swept from under a running step.
func writeWalletBudgetChild(parentRequestId string, requestId string, userId int, amount int, enforceCap bool) (*WalletHold, error) {
	if strings.TrimSpace(parentRequestId) == "" || strings.TrimSpace(requestId) == "" {
		return nil, errors.New("parent and child request ids are required")
	}
	if amount < 0 {
		return nil, errors.New("budget allocation cannot be negative")
	}
	if err := common.ValidateWalletQuota(amount); err != nil {
		return nil, err
	}
	var child *WalletHold
	err := DB.Transaction(func(tx *gorm.DB) error {
		parent, err := lockWalletHoldTx(tx, parentRequestId)
		if err != nil {
			return err
		}
		if parent == nil {
			return ErrWalletHoldNotFound
		}
		if parent.ParentId != nil {
			return fmt.Errorf("wallet hold %s is not a root budget hold", parentRequestId)
		}
		if parent.UserId != userId {
			return fmt.Errorf("wallet hold %s belongs to user %d", parentRequestId, parent.UserId)
		}
		if parent.Status != WalletHoldStatusActive {
			return ErrWalletHoldClosed
		}
		existing, err := lockWalletHoldTx(tx, requestId)
		if err != nil {
			return err
		}
		excludeId := 0
		if existing != nil {
			if existing.UserId != userId {
				return fmt.Errorf("wallet hold %s belongs to user %d", requestId, existing.UserId)
			}
			if existing.ParentId == nil || *existing.ParentId != parent.Id {
				return fmt.Errorf("wallet hold %s is not mounted on %s", requestId, parentRequestId)
			}
			if existing.Status != WalletHoldStatusActive {
				return ErrWalletHoldClosed
			}
			excludeId = existing.Id
		}
		now := common.GetTimestamp()
		if enforceCap {
			allocated, err := walletBudgetAllocatedTx(tx, parent.Id, excludeId, WalletHoldStatusActive)
			if err != nil {
				return err
			}
			if allocated+int64(amount) > parent.Amount {
				return ErrWalletBudgetExceeded
			}
		}
		renewed := max(parent.ExpiresAt, now+int64(WalletHoldTTLSeconds()))
		if renewed != parent.ExpiresAt {
			parent.ExpiresAt = renewed
			if err := tx.Save(parent).Error; err != nil {
				return err
			}
		}
		if existing == nil {
			if amount == 0 {
				return nil
			}
			parentId := parent.Id
			child = &WalletHold{
				RequestId: requestId,
				UserId:    userId,
				Amount:    int64(amount),
				Status:    WalletHoldStatusActive,
				ParentId:  &parentId,
				ExpiresAt: renewed,
			}
			return tx.Create(child).Error
		}
		if existing.Amount == int64(amount) {
			child = existing
			return nil
		}
		existing.Amount = int64(amount)
		existing.ExpiresAt = max(existing.ExpiresAt, renewed)
		if err := tx.Save(existing).Error; err != nil {
			return err
		}
		child = existing
		return nil
	})
	if err != nil {
		return nil, err
	}
	return child, nil
}

// walletBudgetAllocatedTx sums the allocations of one run budget in one state,
// with the child being replaced optionally excluded.
func walletBudgetAllocatedTx(tx *gorm.DB, parentId int, excludeId int, status string) (int64, error) {
	var row struct {
		Total int64
	}
	query := tx.Model(&WalletHold{}).
		Select("COALESCE(SUM(amount), 0) AS total").
		Where("parent_id = ? AND status = ?", parentId, status)
	if excludeId > 0 {
		query = query.Where("id <> ?", excludeId)
	}
	if err := query.Scan(&row).Error; err != nil {
		return 0, err
	}
	return row.Total, nil
}

// WalletBudgetSummary describes one workflow run budget (BL-03): the cap the
// run reserved, the sum of its step allocations, and what is left of the cap
// after settlement. Remaining is negative when a finished step cost more than
// the cap; that excess is billed by the run settlement.
type WalletBudgetSummary struct {
	RunId     string `json:"run_id"`
	Cap       int64  `json:"cap"`
	Spent     int64  `json:"spent"`
	Remaining int64  `json:"remaining"`
	Status    string `json:"status"`
}

// SettleWalletBudgetRun closes a workflow run budget and settles it against the
// wallet in one transaction: the run costs the sum of its step allocations, so
// the unused part of the cap is returned and a run whose steps cost more than
// the cap is charged the difference (down to the account's credit line, like
// every other wallet charge). Replaying a settled run reports the same summary
// and moves no quota again. A budget that was already refunded or expired (its
// whole cap went back to the wallet) bills nothing, because the run's outcome is
// unknown to the recovery sweep.
func SettleWalletBudgetRun(userId int, runId string) (*WalletBudgetSummary, error) {
	if strings.TrimSpace(runId) == "" {
		return nil, errors.New("runId is empty")
	}
	limit := overdraftLimitForCharge(userId)
	summary := &WalletBudgetSummary{RunId: runId}
	walletDelta := int64(0)
	err := DB.Transaction(func(tx *gorm.DB) error {
		parent, err := lockWalletHoldTx(tx, runId)
		if err != nil {
			return err
		}
		if parent == nil {
			return ErrWalletHoldNotFound
		}
		if parent.ParentId != nil {
			return fmt.Errorf("wallet hold %s is not a root budget hold", runId)
		}
		if parent.UserId != userId {
			return fmt.Errorf("wallet hold %s belongs to user %d", runId, parent.UserId)
		}
		spent, err := walletBudgetSpentTx(tx, parent)
		if err != nil {
			return err
		}
		summary.Cap = parent.Amount
		summary.Spent = spent
		summary.Status = parent.Status
		summary.Remaining = parent.Amount - spent
		charged, err := settleWalletHoldTx(tx, userId, runId, spent-parent.Amount, limit)
		if err != nil {
			return err
		}
		walletDelta = charged
		if parent.Status == WalletHoldStatusActive {
			summary.Status = WalletHoldStatusSettled
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if walletDelta != 0 {
		syncWalletQuotaCache(userId, -walletDelta, "wallet budget settlement")
		// The consumption ledger follows the money: the cap was recorded at
		// creation, so only the settlement correction between the cap and the
		// steps' actual cost is recorded here.
		RecordWalletConsumeDelta(userId, -walletDelta)
	}
	return summary, nil
}

// walletBudgetSpentTx sums the billed allocations of one run budget. An open
// budget bills its active allocations; a settled budget bills the allocations
// its settlement closed, so replaying the settlement reports the same summary.
// A budget that was refunded or expired returns zero: its whole reservation went
// back to the wallet, so it bills nothing.
func walletBudgetSpentTx(tx *gorm.DB, parent *WalletHold) (int64, error) {
	billed := WalletHoldStatusActive
	if parent.Status == WalletHoldStatusSettled {
		billed = WalletHoldStatusSettled
	} else if parent.Status != WalletHoldStatusActive {
		return 0, nil
	}
	return walletBudgetAllocatedTx(tx, parent.Id, 0, billed)
}

// WalletHoldExpiryResult summarizes one recovery sweep.
type WalletHoldExpiryResult struct {
	ScannedCount  int   `json:"scanned_count"`
	ExpiredCount  int   `json:"expired_count"`
	FailedCount   int   `json:"failed_count"`
	RefundedQuota int64 `json:"refunded_quota"`
}

// refundExpiredWalletHoldTx closes one expired root hold and returns its
// reservation in the same transaction. The status guard inside the lock makes
// a concurrent settlement, refund or sweep a no-op.
func refundExpiredWalletHoldTx(holdId int, now int64) (int64, bool, error) {
	refunded := int64(0)
	closed := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		var hold WalletHold
		if err := lockForUpdate(tx).Where("id = ?", holdId).First(&hold).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if hold.Status != WalletHoldStatusActive || hold.ExpiresAt > now {
			return nil
		}
		if hold.Amount > 0 {
			applied, err := ApplyWalletLedgerDelta(tx, hold.UserId, WalletLedgerKindRefund, hold.Amount, WalletLedgerRefRequestRefund, hold.RequestId, "")
			if err != nil {
				return err
			}
			if applied {
				refunded = hold.Amount
			}
		}
		if err := releaseWalletHoldClaimsTx(tx, &hold, hold.Amount); err != nil {
			return err
		}
		hold.Status = WalletHoldStatusExpired
		if err := tx.Save(&hold).Error; err != nil {
			return err
		}
		if err := closeWalletHoldChildrenTx(tx, hold.Id, WalletHoldStatusExpired, now); err != nil {
			return err
		}
		closed = true
		return nil
	})
	return refunded, closed, err
}

// CleanupClosedWalletHolds removes terminal holds whose last update predates the
// retention cutoff, batched by id list so the same statement works on SQLite,
// MySQL and PostgreSQL. Active holds are never removed: they still own quota.
func CleanupClosedWalletHolds(cutoff int64, limit int) (int, error) {
	if limit <= 0 {
		limit = 500
	}
	var ids []int
	if err := DB.Model(&WalletHold{}).
		Where("status <> ? AND updated_at < ?", WalletHoldStatusActive, cutoff).
		Order("id asc").
		Limit(limit).
		Pluck("id", &ids).Error; err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}
	// The recorded grant composition of a hold is pruned with it.
	if err := DB.Where("hold_id IN ?", ids).Delete(&WalletHoldGrant{}).Error; err != nil {
		return 0, err
	}
	res := DB.Where("id IN ?", ids).Delete(&WalletHold{})
	return int(res.RowsAffected), res.Error
}

// RefundExpiredWalletHolds refunds every root hold whose reservation lifetime
// elapsed without a settlement or refund. This is the crash-recovery path: a
// process that stopped between the pre-consume and the settlement leaves an
// active hold behind, and the sweep returns the quota with an idempotent ledger
// refund. A hold that cannot be refunded (for example the wallet bound would be
// exceeded) stays active and is retried by the next sweep; the failure is
// logged and counted instead of being dropped.
func RefundExpiredWalletHolds(now int64, limit int) (*WalletHoldExpiryResult, error) {
	if limit <= 0 {
		limit = 200
	}
	result := &WalletHoldExpiryResult{}
	var candidates []WalletHold
	if err := DB.Where("status = ? AND parent_id IS NULL AND expires_at <= ?", WalletHoldStatusActive, now).
		Order("id asc").
		Limit(limit).
		Find(&candidates).Error; err != nil {
		return nil, err
	}
	result.ScannedCount = len(candidates)
	for i := range candidates {
		refunded, closed, err := refundExpiredWalletHoldTx(candidates[i].Id, now)
		if err != nil {
			result.FailedCount++
			common.SysError(common.LogText("failed to refund expired wallet hold %s (user %d): %s", candidates[i].RequestId, candidates[i].UserId, err.Error()))
			continue
		}
		if !closed {
			continue
		}
		result.ExpiredCount++
		if refunded > 0 {
			result.RefundedQuota += refunded
			syncWalletQuotaCache(candidates[i].UserId, refunded, "expired wallet hold refund")
		}
	}
	return result, nil
}
