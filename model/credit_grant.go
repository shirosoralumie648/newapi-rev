package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"gorm.io/gorm"
)

// Credit grants are the source and validity buckets of wallet credits.
//
// Users.Quota stays the single spendable balance: a grant records how much of
// that balance was credited by a sign-in, an invitation, a redemption code, a
// promotion or an administrator, and until when that claim is valid. Charging
// follows subscription -> grants (earliest expiry first) -> paid balance:
// claimCreditGrantsTx reduces the matching grant rows while the balance itself
// is reduced once, so the composition of a reservation is recorded on its
// wallet hold and can be restored exactly when the charge is refunded. A
// top-up never creates a grant, so the paid balance (quota minus every
// outstanding claim) never expires.
//
// Invariant: Σ credit_grants.remaining ≤ max(users.quota, 0). A grant can
// therefore never claim more money than the wallet holds; the expiry sweep
// enforces it defensively when credit was spent through a path that could not
// attribute it (see VoidExpiredCreditGrants).

var (
	// ErrCreditGrantSourceInvalid rejects a grant source outside the supported
	// set so a typo cannot create an unlabelled bucket.
	ErrCreditGrantSourceInvalid = errors.New("invalid credit grant source")
	// ErrCreditGrantAmountInvalid rejects non-positive crediting amounts.
	ErrCreditGrantAmountInvalid = errors.New("credit grant amount must be positive")
)

// CreditGrant is one credit bucket: the amount credited by one event, how much
// of it is still unspent and when the remainder stops being spendable (0 means
// it never expires).
type CreditGrant struct {
	Id     int    `json:"id" gorm:"primaryKey;autoIncrement"`
	UserId int    `json:"user_id" gorm:"not null;index:idx_credit_grant_user_expiry,priority:1"`
	Source string `json:"source" gorm:"type:varchar(32);not null"`
	Amount int64  `json:"amount" gorm:"type:bigint;not null"`
	// Remaining is the unspent part of this claim. It is reduced by charges in
	// the documented spending order and restored when a charge is refunded.
	Remaining int64 `json:"remaining" gorm:"type:bigint;not null"`
	// ExpiresAt is the unix timestamp after which the remaining claim is voided
	// (and the wallet balance reduced by it). 0 means the credit never expires.
	ExpiresAt int64  `json:"expires_at" gorm:"bigint;not null;index:idx_credit_grant_expires,priority:1;index:idx_credit_grant_user_expiry,priority:2"`
	Note      string `json:"note" gorm:"type:varchar(255);not null"`
	CreatedAt int64  `json:"created_at" gorm:"bigint;not null"`
	UpdatedAt int64  `json:"updated_at" gorm:"bigint;not null"`
}

func (CreditGrant) TableName() string {
	return "credit_grants"
}

// CreditGrantNoteMaxLength is the longest grant note stored with one grant.
const CreditGrantNoteMaxLength = 255

// IsCreditGrantExpired reports whether a claim with this expiry is no longer
// spendable at now. 0 never expires.
func IsCreditGrantExpired(expiresAt int64, now int64) bool {
	return expiresAt > 0 && expiresAt <= now
}

// CreditGrantExpiryFor resolves the configured validity of one source into an
// absolute expiry timestamp; 0 means the credit never expires.
func CreditGrantExpiryFor(source string, now int64) int64 {
	return operation_setting.GetCreditGrantSetting().ExpiryTimestampFor(source, now)
}

// creditGrantAllocation records how much of one claim was attributed to one
// grant.
type creditGrantAllocation struct {
	GrantId int
	Amount  int64
}

// creditGrantAvailability splits an account's outstanding claims into the part
// that is still spendable and the part whose validity already elapsed.
func creditGrantAvailability(grants []CreditGrant, now int64) (spendable int64, expired int64) {
	for i := range grants {
		if IsCreditGrantExpired(grants[i].ExpiresAt, now) {
			expired += grants[i].Remaining
			continue
		}
		spendable += grants[i].Remaining
	}
	return spendable, expired
}

// lockCreditGrantsTx loads and locks every grant of one account that still has
// money, in spending order: earliest expiry first, never-expiring credits last.
func lockCreditGrantsTx(tx *gorm.DB, userId int) ([]CreditGrant, error) {
	if userId <= 0 {
		return nil, nil
	}
	var grants []CreditGrant
	err := lockForUpdate(tx).
		Where("user_id = ? AND remaining > 0", userId).
		Order("CASE WHEN expires_at = 0 THEN 1 ELSE 0 END, expires_at ASC, id ASC").
		Find(&grants).Error
	return grants, err
}

// claimCreditGrantsTx attributes up to amount of one wallet charge to the
// account's grants, earliest expiry first. grants must be the locked result of
// lockCreditGrantsTx. It returns the per-grant allocation and the claimed total.
func claimCreditGrantsTx(tx *gorm.DB, userId int, amount int64, grants []CreditGrant, now int64) ([]creditGrantAllocation, int64, error) {
	if amount <= 0 {
		return nil, 0, nil
	}
	allocations := make([]creditGrantAllocation, 0, len(grants))
	remaining := amount
	for i := range grants {
		if remaining <= 0 {
			break
		}
		if grants[i].UserId != userId || IsCreditGrantExpired(grants[i].ExpiresAt, now) || grants[i].Remaining <= 0 {
			continue
		}
		take, err := spendCreditGrantTx(tx, grants[i].Id, min(grants[i].Remaining, remaining))
		if err != nil {
			return nil, 0, err
		}
		if take <= 0 {
			continue
		}
		allocations = append(allocations, creditGrantAllocation{GrantId: grants[i].Id, Amount: take})
		remaining -= take
	}
	return allocations, amount - remaining, nil
}

// spendCreditGrantTx reduces one grant by up to amount and returns how much was
// actually spent. The row is read under the caller's transaction lock and the
// conditional write keeps the claim above zero even when a concurrent charge
// touched the same grant.
func spendCreditGrantTx(tx *gorm.DB, grantId int, amount int64) (int64, error) {
	if amount <= 0 {
		return 0, nil
	}
	var grant CreditGrant
	if err := lockForUpdate(tx).Select("id", "remaining").Where("id = ?", grantId).First(&grant).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil
		}
		return 0, err
	}
	take := min(grant.Remaining, amount)
	if take <= 0 {
		return 0, nil
	}
	result := tx.Model(&CreditGrant{}).
		Where("id = ? AND remaining >= ?", grantId, take).
		Update("remaining", gorm.Expr("remaining - ?", take))
	if result.Error != nil {
		return 0, result.Error
	}
	if result.RowsAffected != 1 {
		return 0, errors.New("credit grant changed while it was being spent")
	}
	return take, nil
}

// restoreCreditGrantTx returns money to one grant without ever exceeding the
// amount it was originally credited with. It returns how much was restored.
func restoreCreditGrantTx(tx *gorm.DB, grantId int, amount int64) (int64, error) {
	if amount <= 0 {
		return 0, nil
	}
	var grant CreditGrant
	if err := lockForUpdate(tx).Select("id", "amount", "remaining").Where("id = ?", grantId).First(&grant).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil
		}
		return 0, err
	}
	give := min(amount, max(grant.Amount-grant.Remaining, 0))
	if give <= 0 {
		return 0, nil
	}
	result := tx.Model(&CreditGrant{}).
		Where("id = ? AND amount - remaining >= ?", grantId, give).
		Update("remaining", gorm.Expr("remaining + ?", give))
	if result.Error != nil {
		return 0, result.Error
	}
	if result.RowsAffected != 1 {
		return 0, errors.New("credit grant changed while it was being restored")
	}
	return give, nil
}

// reduceCreditGrantClaimsTx applies a wallet decrease that carries no hold (an
// administrator adjustment or a legacy charge) to the account's claims in
// spending order, so the claim total stays within the balance. It returns the
// released claim amount; released claims are simply given up because the money
// itself leaves the wallet in the same operation.
func reduceCreditGrantClaimsTx(tx *gorm.DB, userId int, amount int64, now int64) (int64, error) {
	if amount <= 0 {
		return 0, nil
	}
	grants, err := lockCreditGrantsTx(tx, userId)
	if err != nil {
		return 0, err
	}
	_, claimed, err := claimCreditGrantsTx(tx, userId, amount, grants, now)
	if err != nil {
		return 0, err
	}
	return claimed, nil
}

// createCreditGrantTx records one grant row. The caller has already credited
// the wallet (and written its ledger row) inside the same transaction, so the
// claim always refers to money that exists.
func createCreditGrantTx(tx *gorm.DB, userId int, source string, amount int64, expiresAt int64, note string) (*CreditGrant, error) {
	if tx == nil {
		return nil, errors.New("database handle is required")
	}
	if userId <= 0 {
		return nil, errors.New("invalid credit grant user")
	}
	if amount <= 0 {
		return nil, ErrCreditGrantAmountInvalid
	}
	if !operation_setting.IsCreditGrantSource(source) {
		return nil, fmt.Errorf("%w: %s", ErrCreditGrantSourceInvalid, source)
	}
	if err := common.ValidateWalletQuota(int(amount)); err != nil {
		return nil, err
	}
	note = strings.TrimSpace(note)
	if len(note) > CreditGrantNoteMaxLength {
		return nil, errors.New("credit grant note is too long")
	}
	grant := &CreditGrant{
		UserId:    userId,
		Source:    source,
		Amount:    amount,
		Remaining: amount,
		ExpiresAt: expiresAt,
		Note:      note,
	}
	if err := tx.Create(grant).Error; err != nil {
		return nil, err
	}
	return grant, nil
}

// grantLedgerMeta is the ledger meta of one grant-typed credit.
func grantLedgerMeta(source string, expiresAt int64) string {
	return fmt.Sprintf("source=%s expires_at=%d", source, expiresAt)
}

// IssueCreditGrantTx credits amount to the wallet and records the matching
// claim in one transaction. The ledger reference makes a replay a no-op, so a
// retried sign-in, redemption or administrator action can never grant the same
// credit twice.
func IssueCreditGrantTx(tx *gorm.DB, userId int, source string, amount int, expiresAt int64, ledgerKind string, refType string, refId string, note string) (bool, error) {
	if amount <= 0 {
		return false, ErrCreditGrantAmountInvalid
	}
	if !operation_setting.IsCreditGrantSource(source) {
		return false, fmt.Errorf("%w: %s", ErrCreditGrantSourceInvalid, source)
	}
	applied, err := ApplyWalletLedgerDelta(tx, userId, ledgerKind, int64(amount), refType, refId, grantLedgerMeta(source, expiresAt))
	if err != nil || !applied {
		return false, err
	}
	if _, err := createCreditGrantTx(tx, userId, source, int64(amount), expiresAt, note); err != nil {
		return false, err
	}
	return true, nil
}

// IssueCreditGrant wraps IssueCreditGrantTx in its own transaction and keeps
// the quota cache in step. It is the entry point for credits that are not part
// of a larger unit of work.
func IssueCreditGrant(userId int, source string, amount int, expiresAt int64, ledgerKind string, refType string, refId string, note string) (bool, error) {
	applied := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		var applyErr error
		applied, applyErr = IssueCreditGrantTx(tx, userId, source, amount, expiresAt, ledgerKind, refType, refId, note)
		return applyErr
	})
	if err != nil {
		return false, err
	}
	if applied {
		syncCreditUserQuotaCache(userId, amount, "credit grant")
	}
	return applied, nil
}

// ClaimCreditGrantsForCharge attributes a wallet charge that carries no hold to
// the account's grants, in its own transaction. The claim is bookkeeping only:
// the balance movement itself was applied by the caller, so a failure here is
// logged instead of failing the charge.
func ClaimCreditGrantsForCharge(userId int, amount int) {
	if userId <= 0 || amount <= 0 {
		return
	}
	if err := DB.Transaction(func(tx *gorm.DB) error {
		_, err := reduceCreditGrantClaimsTx(tx, userId, int64(amount), common.GetTimestamp())
		return err
	}); err != nil {
		common.SysError(common.LogText("failed to attribute a wallet charge of user %d to credit grants: %s", userId, err.Error()))
	}
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// CreditGrantBucket is one spendable credit bucket of a wallet.
type CreditGrantBucket struct {
	GrantId   int    `json:"grant_id"`
	Source    string `json:"source"`
	Remaining int64  `json:"remaining"`
	ExpiresAt int64  `json:"expires_at"`
	CreatedAt int64  `json:"created_at"`
}

// CreditGrantWalletView is the wallet composition of one account: the paid
// balance that never expires, the grant buckets still spendable, and the
// expired remainder that the sweep has not voided yet.
type CreditGrantWalletView struct {
	UserId       int                 `json:"user_id"`
	TotalQuota   int64               `json:"total_quota"`
	PaidQuota    int64               `json:"paid_quota"`
	GrantQuota   int64               `json:"grant_quota"`
	ExpiredQuota int64               `json:"expired_quota"`
	Grants       []CreditGrantBucket `json:"grants"`
}

// creditGrantListLimit bounds how many buckets one wallet view lists.
const creditGrantListLimit = 200

// CreditGrantWalletForUser reads one account's wallet composition. The paid
// balance is the part of quota no grant claims, so paid + grants + expired
// always equals the balance the account can see.
func CreditGrantWalletForUser(userId int, now int64) (*CreditGrantWalletView, error) {
	if userId <= 0 {
		return nil, errors.New("invalid user id")
	}
	quota, err := GetUserQuota(userId, true)
	if err != nil {
		return nil, err
	}
	var grants []CreditGrant
	if err := DB.Where("user_id = ? AND remaining > 0", userId).
		Order("CASE WHEN expires_at = 0 THEN 1 ELSE 0 END, expires_at ASC, id ASC").
		Find(&grants).Error; err != nil {
		return nil, err
	}
	view := &CreditGrantWalletView{
		UserId:     userId,
		TotalQuota: int64(quota),
		Grants:     make([]CreditGrantBucket, 0, len(grants)),
	}
	for i := range grants {
		if IsCreditGrantExpired(grants[i].ExpiresAt, now) {
			view.ExpiredQuota += grants[i].Remaining
			continue
		}
		view.GrantQuota += grants[i].Remaining
		if len(view.Grants) >= creditGrantListLimit {
			continue
		}
		view.Grants = append(view.Grants, CreditGrantBucket{
			GrantId:   grants[i].Id,
			Source:    grants[i].Source,
			Remaining: grants[i].Remaining,
			ExpiresAt: grants[i].ExpiresAt,
			CreatedAt: grants[i].CreatedAt,
		})
	}
	view.PaidQuota = max(view.TotalQuota-view.GrantQuota-view.ExpiredQuota, 0)
	return view, nil
}

// ---------------------------------------------------------------------------
// Expiry sweep
// ---------------------------------------------------------------------------

// CreditGrantExpiryResult summarizes one expiry sweep.
type CreditGrantExpiryResult struct {
	ScannedCount  int   `json:"scanned_count"`
	VoidedCount   int   `json:"voided_count"`
	FailedCount   int   `json:"failed_count"`
	VoidedQuota   int64 `json:"voided_quota"`
	DeductedQuota int64 `json:"deducted_quota"`
	ClampedCount  int   `json:"clamped_count"`
}

// voidExpiredCreditGrantTx voids the unspent remainder of one expired grant and
// reduces the wallet balance by it in the same transaction, recording the
// movement in the wallet ledger. The deduction never takes the balance below
// zero: when a grant claims more than the wallet still holds (credit spent
// through a legacy path that could not attribute it), only the available part
// is deducted and the anomaly is reported by the caller.
func voidExpiredCreditGrantTx(grantId int, now int64) (voided int64, deducted int64, clamped bool, err error) {
	err = DB.Transaction(func(tx *gorm.DB) error {
		// The shared lock order is hold -> user -> grants, so the account row is
		// locked before the grant itself: the owner is read without a lock
		// first, then both rows are locked in that order.
		var probe CreditGrant
		if err := tx.Select("id", "user_id").Where("id = ?", grantId).First(&probe).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		balance, err := lockUserQuotaTx(tx, probe.UserId)
		if err != nil {
			return err
		}
		var grant CreditGrant
		if err := lockForUpdate(tx).Where("id = ?", grantId).First(&grant).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if grant.Remaining <= 0 || !IsCreditGrantExpired(grant.ExpiresAt, now) {
			return nil
		}
		deducted = min(grant.Remaining, max(balance, 0))
		if deducted > 0 {
			refId := fmt.Sprintf("%d-%d-%s", grant.Id, now, common.GetRandomString(8))
			applied, err := ApplyWalletLedgerDelta(tx, grant.UserId, WalletLedgerKindGrantExpire, -deducted, WalletLedgerRefGrantExpire, refId, grantLedgerMeta(grant.Source, grant.ExpiresAt))
			if err != nil {
				return err
			}
			if !applied {
				return errors.New("credit grant expiry ledger reference conflict")
			}
		}
		if err := tx.Model(&CreditGrant{}).Where("id = ?", grant.Id).Update("remaining", 0).Error; err != nil {
			return err
		}
		voided = grant.Remaining
		clamped = deducted < voided
		return nil
	})
	return voided, deducted, clamped, err
}

// VoidExpiredCreditGrants voids the unspent remainder of every grant whose
// validity elapsed. One grant is one transaction, so a partially failed sweep
// simply retries the remaining grants on the next pass.
func VoidExpiredCreditGrants(now int64, limit int) (*CreditGrantExpiryResult, error) {
	if limit <= 0 {
		limit = 200
	}
	var candidates []CreditGrant
	if err := DB.Where("remaining > 0 AND expires_at > 0 AND expires_at <= ?", now).
		Order("expires_at ASC, id ASC").
		Limit(limit).
		Find(&candidates).Error; err != nil {
		return nil, err
	}
	result := &CreditGrantExpiryResult{ScannedCount: len(candidates)}
	for i := range candidates {
		voided, deducted, clamped, err := voidExpiredCreditGrantTx(candidates[i].Id, now)
		if err != nil {
			result.FailedCount++
			common.SysError(common.LogText("failed to void expired credit grant %d (user %d): %s", candidates[i].Id, candidates[i].UserId, err.Error()))
			continue
		}
		if voided <= 0 {
			continue
		}
		result.VoidedCount++
		result.VoidedQuota += voided
		result.DeductedQuota += deducted
		if deducted > 0 {
			syncWalletQuotaCache(candidates[i].UserId, -deducted, "credit grant expiry")
		}
		if clamped {
			result.ClampedCount++
			common.SysError(common.LogText("credit grant %d (user %d) claimed %d more than the wallet held, voided %d", candidates[i].Id, candidates[i].UserId, voided-deducted, deducted))
		}
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// Administrator statistics
// ---------------------------------------------------------------------------

// CreditGrantSourceStats aggregates one grant source.
type CreditGrantSourceStats struct {
	Source    string `json:"source"`
	Granted   int64  `json:"granted"`
	Remaining int64  `json:"remaining"`
	Spent     int64  `json:"spent"`
	Grants    int64  `json:"grants"`
	Accounts  int64  `json:"accounts"`
}

// CreditGrantStats reports the wallet totals administrators track by source:
// money that entered through top-ups, grant-typed credits and their sources,
// consumption and refunds, and the credit that expired unused.
type CreditGrantStats struct {
	TotalTopUp     int64                    `json:"total_topup"`
	TotalGranted   int64                    `json:"total_granted"`
	TotalRemaining int64                    `json:"total_remaining"`
	TotalSpent     int64                    `json:"total_spent"`
	TotalConsumed  int64                    `json:"total_consumed"`
	TotalRefunded  int64                    `json:"total_refunded"`
	TotalExpired   int64                    `json:"total_expired"`
	Sources        []CreditGrantSourceStats `json:"sources"`
}

// WalletLedgerKindTotal sums one ledger kind, optionally limited to one sign.
func walletLedgerTotal(kind string, positive bool) (int64, error) {
	query := DB.Model(&WalletLedgerEntry{}).Where("kind = ?", kind)
	if positive {
		query = query.Where("amount > 0")
	} else {
		query = query.Where("amount < 0")
	}
	var total int64
	if err := query.Select("COALESCE(SUM(ABS(amount)), 0)").Scan(&total).Error; err != nil {
		return 0, err
	}
	return total, nil
}

// CreditGrantStatistics aggregates the wallet totals and the per-source grant
// breakdown administrators use to audit granted credit.
func CreditGrantStatistics() (*CreditGrantStats, error) {
	stats := &CreditGrantStats{Sources: make([]CreditGrantSourceStats, 0)}
	type sourceRow struct {
		Source    string
		Granted   int64
		Remaining int64
		Grants    int64
		Accounts  int64
	}
	var rows []sourceRow
	if err := DB.Model(&CreditGrant{}).
		Select("source, COALESCE(SUM(amount), 0) AS granted, COALESCE(SUM(remaining), 0) AS remaining, COUNT(*) AS grants, COUNT(DISTINCT user_id) AS accounts").
		Group("source").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	bySource := make(map[string]CreditGrantSourceStats, len(rows))
	for _, row := range rows {
		bySource[row.Source] = CreditGrantSourceStats{
			Source:    row.Source,
			Granted:   row.Granted,
			Remaining: row.Remaining,
			Spent:     max(row.Granted-row.Remaining, 0),
			Grants:    row.Grants,
			Accounts:  row.Accounts,
		}
		stats.TotalGranted += row.Granted
		stats.TotalRemaining += row.Remaining
	}
	stats.TotalSpent = max(stats.TotalGranted-stats.TotalRemaining, 0)
	for _, source := range operation_setting.CreditGrantSources() {
		if entry, ok := bySource[source]; ok {
			stats.Sources = append(stats.Sources, entry)
		}
	}
	// Sources outside the supported set (for example rows written by an older
	// build) are still reported, after the known ones.
	for _, row := range rows {
		if !operation_setting.IsCreditGrantSource(row.Source) {
			stats.Sources = append(stats.Sources, bySource[row.Source])
		}
	}

	var err error
	if stats.TotalTopUp, err = walletLedgerTotal(WalletLedgerKindTopUp, true); err != nil {
		return nil, err
	}
	if stats.TotalConsumed, err = walletLedgerTotal(WalletLedgerKindConsumeHourly, false); err != nil {
		return nil, err
	}
	if stats.TotalRefunded, err = walletLedgerTotal(WalletLedgerKindRefund, true); err != nil {
		return nil, err
	}
	if stats.TotalExpired, err = walletLedgerTotal(WalletLedgerKindGrantExpire, false); err != nil {
		return nil, err
	}
	return stats, nil
}
