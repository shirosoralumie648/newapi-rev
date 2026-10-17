package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
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
// one transaction. The lock order is fixed (hold first, then the debt row, then
// the user row) so concurrent reserves, settlements, refunds and debt
// collections of one user cannot deadlock.
//
// requireBalance=true is the pre-consume reservation: it only deducts when the
// whole amount fits above the account's credit line (-limit). requireBalance=false
// mirrors the settlement top-up: the wallet is debited down to the credit line
// and the remainder becomes tracked debt. The returned value is the amount that
// actually left the wallet.
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
		if requireBalance {
			balance, err := lockUserQuotaTx(tx, userId)
			if err != nil {
				return err
			}
			if balance+limit < quota {
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
		}
		if applied <= 0 {
			return nil
		}
		// The hold records exactly the money the wallet actually gave up, so a
		// refund can never return more than was deducted.
		_, err = upsertWalletHoldTx(tx, hold, userId, requestId, applied, common.GetTimestamp())
		return err
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
		hold, err := lockWalletHoldTx(tx, requestId)
		if err != nil {
			return err
		}
		charged := int64(0)
		if hold == nil {
			// A request admitted before wallet holds existed settles the raw
			// difference.
			charged = delta
		} else {
			if hold.UserId != userId {
				return fmt.Errorf("wallet hold %s belongs to user %d", requestId, hold.UserId)
			}
			switch hold.Status {
			case WalletHoldStatusActive:
				charged = delta
			case WalletHoldStatusSettled:
				// The settlement already moved the wallet.
				return nil
			default:
				// The reservation was returned; the whole actual charge is
				// still outstanding.
				charged, err = addWalletQuotaChecked(delta, hold.Amount, "wallet hold settle after refund")
				if err != nil {
					return err
				}
			}
		}
		if hold != nil && hold.Status == WalletHoldStatusActive {
			hold.Status = WalletHoldStatusSettled
			if err := tx.Save(hold).Error; err != nil {
				return err
			}
			if err := closeWalletHoldChildrenTx(tx, hold.Id, WalletHoldStatusSettled, common.GetTimestamp()); err != nil {
				return err
			}
		}
		if charged == 0 {
			return nil
		}
		if charged > 0 {
			applied, _, err := chargeWalletQuotaTx(tx, userId, charged, limit, requestId)
			if err != nil {
				return err
			}
			walletDelta = applied
			return nil
		}
		balance, err := lockUserQuotaTx(tx, userId)
		if err != nil {
			return err
		}
		next, err := addWalletQuotaChecked(balance, -charged, "wallet hold settle")
		if err != nil {
			return err
		}
		if err := writeLockedWalletQuotaTx(tx, userId, next); err != nil {
			return err
		}
		walletDelta = charged
		return nil
	})
	if err != nil {
		return 0, err
	}
	if walletDelta != 0 {
		syncWalletQuotaCache(userId, -walletDelta, "wallet hold settlement")
	}
	return walletDelta, nil
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
