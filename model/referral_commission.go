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
package model

import (
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

// Referral commission sources: the paid events of an invitee that commission
// the inviter.
const (
	ReferralCommissionSourceTopUp  = "topup"
	ReferralCommissionSourceRedeem = "redeem"
)

// Referral commission statuses. Every event starts pending: the commission is
// recorded but not yet locked or issued. Review events wait for an
// administrator's decision (a large amount or a watched account); blocked
// events were refused by an anti-abuse rule and rejected events were declined
// in review. Blocked and rejected events never pay out and never count against
// a payable cap. The settlement step (RF-04) transitions payable events into
// locked (confirmed, not yet paid out) and settled (paid out); the reversal
// step (RF-05) moves any event whose order payment was refunded or charged
// back to refunded, which is terminal. The statistics panel buckets by every
// known state.
const (
	ReferralCommissionStatusPending  = "pending"
	ReferralCommissionStatusReview   = "review"
	ReferralCommissionStatusBlocked  = "blocked"
	ReferralCommissionStatusRejected = "rejected"
	ReferralCommissionStatusLocked   = "locked"
	ReferralCommissionStatusSettled  = "settled"
	// ReferralCommissionStatusRefunded is a terminal state: the paid order of
	// the event was refunded or charged back, so the commission is void and
	// stops consuming a payable allowance.
	ReferralCommissionStatusRefunded = "refunded"
)

// Referral commission settlement methods record how a settled commission
// reached the inviter: as a credit grant in the wallet (the default path) or
// as cash payable outside the wallet, which requires the explicit
// administrator switch and the confirmed payment compliance terms.
const (
	ReferralCommissionSettlementCredit = "credit"
	ReferralCommissionSettlementCash   = "cash"
)

// referralCommissionUnpayableStatuses are the statuses that neither pay out
// nor consume a payable commission allowance.
var referralCommissionUnpayableStatuses = []string{
	ReferralCommissionStatusBlocked,
	ReferralCommissionStatusRejected,
	ReferralCommissionStatusRefunded,
}

// ReferralCommission is one single-level commission event of one paid order:
// how much the invitee actually paid, which rate applied and how much the
// inviter earns. The row is an event only — the settlement task (RF-04) locks
// and issues it — so writing one never moves any balance. The unique
// (ref_type, ref_id) index keys the event by the top-up order or the
// redemption code, so a replayed payment webhook or a retried redemption
// cannot commission twice.
type ReferralCommission struct {
	Id        int    `json:"id" gorm:"primaryKey;autoIncrement"`
	InviterId int    `json:"inviter_id" gorm:"not null;index"`
	InviteeId int    `json:"invitee_id" gorm:"not null;index"`
	Source    string `json:"source" gorm:"type:varchar(16);not null"`
	RefType   string `json:"ref_type" gorm:"type:varchar(32);not null;uniqueIndex:idx_referral_commission_ref,priority:1"`
	RefId     string `json:"ref_id" gorm:"type:varchar(96);not null;uniqueIndex:idx_referral_commission_ref,priority:2"`
	// BaseQuota is the paid amount in quota: the quota the order actually
	// credited, which excludes grants, discounts and bonus credit.
	BaseQuota int64 `json:"base_quota" gorm:"type:bigint;not null"`
	// RatePercent is the effective rate for the audit trail; the amount is
	// always derived from BaseQuota and CommissionQuota.
	RatePercent string `json:"rate_percent" gorm:"type:varchar(16);not null"`
	// RateSource names where RatePercent came from: the single-account
	// override, the agent tier, the group override or the global default
	// (RF-08). Historic rows without a recorded source stay empty.
	RateSource      string `json:"rate_source" gorm:"type:varchar(16);not null;default:''"`
	CommissionQuota int64  `json:"commission_quota" gorm:"type:bigint;not null"`
	Status          string `json:"status" gorm:"type:varchar(16);not null;index"`
	// LockedAt and SettledAt timestamp the two settlement transitions.
	// SettlementMethod records the payout form of a settled commission and is
	// empty (NULL) while the commission waits; GrantId is the credit_grants
	// row the credit form created (0 while pending, locked, and for cash
	// payouts). SettlementMethod stays nullable because a column without a
	// default is the only shape both engines can append to a table that
	// already holds rows.
	LockedAt         int64  `json:"locked_at" gorm:"bigint;not null;default:0"`
	SettledAt        int64  `json:"settled_at" gorm:"bigint;not null;default:0"`
	SettlementMethod string `json:"settlement_method" gorm:"type:varchar(16)"`
	GrantId          int    `json:"grant_id" gorm:"not null;default:0"`
	// ReversedAt timestamps the refund/chargeback reversal (RF-05); 0 while
	// the event was never reversed.
	ReversedAt int64 `json:"reversed_at" gorm:"bigint;not null;default:0"`
	// Reason carries the anti-abuse decision behind a blocked or review event;
	// it stays empty for events that were payable directly.
	Reason    string `json:"reason" gorm:"type:varchar(32);not null;default:''"`
	CreatedAt int64  `json:"created_at" gorm:"bigint;not null;index"`
	UpdatedAt int64  `json:"updated_at" gorm:"bigint;not null"`
}

func (ReferralCommission) TableName() string {
	return "referral_commissions"
}

// RecordReferralCommissionTx records the commission of one settled paid order
// for the invitee's inviter, inside the same transaction that credited the
// wallet. It writes one event row and never moves any balance. Replays of the
// same reference (a repeated payment webhook, a retried redemption) return
// (nil, nil): the unique index already claims the order. A non-replay database
// failure is returned so the caller's transaction fails as a whole — a paid
// order must not commit without its commission event.
func RecordReferralCommissionTx(tx *gorm.DB, inviteeId int, source string, baseQuota int64, refType string, refId string) (*ReferralCommission, error) {
	if tx == nil {
		return nil, errors.New("database handle is required")
	}
	if source != ReferralCommissionSourceTopUp && source != ReferralCommissionSourceRedeem {
		return nil, fmt.Errorf("unknown referral commission source %q", source)
	}
	if inviteeId <= 0 || baseQuota <= 0 || refType == "" || refId == "" {
		return nil, nil
	}

	setting := operation_setting.GetReferralSetting()
	if !setting.Enabled || !operation_setting.IsPaymentComplianceConfirmed() {
		return nil, nil
	}
	// Redemption codes commission the inviter only when the administrator
	// turned the switch on (the upstream #5829 dispute).
	if source == ReferralCommissionSourceRedeem && !setting.IncludeRedemptionCodes {
		return nil, nil
	}

	var binding ReferralBinding
	err := tx.Where("invitee_id = ?", inviteeId).First(&binding).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var inviter User
	err = tx.First(&inviter, binding.InviterId).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if inviter.Status != common.UserStatusEnabled {
		return nil, nil
	}

	agent, err := referralAgentWithTx(tx, inviter.Id)
	if err != nil {
		return nil, err
	}
	ratePercent, rateSource := ReferralCommissionRateFor(agent, inviter.Group)
	if ratePercent <= 0 {
		return nil, nil
	}

	now := common.GetTimestamp()
	var invitee User
	if err := tx.Select("id", "created_at").First(&invitee, inviteeId).Error; err != nil {
		return nil, err
	}
	// Trigger window: 0 = only the first paid order, -1 = forever, otherwise
	// the paid order must fall inside the first WindowMonths calendar months
	// after registration.
	switch {
	case setting.WindowMonths == operation_setting.ReferralWindowMonthsFirstTopUp:
		var recorded int64
		if err := tx.Model(&ReferralCommission{}).
			Where("invitee_id = ?", inviteeId).
			Where("status NOT IN ?", referralCommissionUnpayableStatuses).
			Count(&recorded).Error; err != nil {
			return nil, err
		}
		if recorded > 0 {
			return nil, nil
		}
	case setting.WindowMonths > 0:
		if now > referralCommissionWindowEnd(invitee.CreatedAt, setting.WindowMonths) {
			return nil, nil
		}
	}

	commissionQuota, err := referralCommissionQuota(baseQuota, ratePercent)
	if err != nil || commissionQuota <= 0 {
		// The shared wallet conversion already audited the clamp; the paid
		// order itself must still succeed, so the event is skipped.
		return nil, nil
	}

	// Anti-abuse gate (RF-06): the initial status is pending when the event may
	// settle, review when an administrator must approve it first, or blocked
	// with the reason when a rule refuses it. A refused event is still stored
	// with the would-be amount as audit evidence.
	initialStatus, reason, err := referralCommissionGate(tx, &inviter, inviteeId, int64(commissionQuota), now)
	if err != nil {
		return nil, err
	}

	commission := &ReferralCommission{
		InviterId:       binding.InviterId,
		InviteeId:       inviteeId,
		Source:          source,
		RefType:         refType,
		RefId:           refId,
		BaseQuota:       baseQuota,
		RatePercent:     strconv.FormatFloat(ratePercent, 'f', -1, 64),
		RateSource:      rateSource,
		CommissionQuota: int64(commissionQuota),
		Status:          initialStatus,
		Reason:          reason,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	// A replay is answered before the insert so the common duplicate path
	// never aborts the enclosing transaction (PostgreSQL).
	var existing ReferralCommission
	err = tx.Select("id").Where("ref_type = ? AND ref_id = ?", refType, refId).First(&existing).Error
	if err == nil {
		return nil, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if err := tx.Create(commission).Error; err != nil {
		if isDuplicateKeyError(err) {
			// A concurrent transaction claimed the same reference first; the
			// order is already commissioned.
			return nil, nil
		}
		return nil, fmt.Errorf("record referral commission: %w", err)
	}
	return commission, nil
}

// referralCommissionWindowEnd returns the last second of the trigger window,
// counting whole calendar months from registration like subscription
// durations do.
func referralCommissionWindowEnd(registeredAt int64, months int) int64 {
	return time.Unix(registeredAt, 0).AddDate(0, months, 0).Unix()
}

// referralCommissionQuota converts the paid base and the resolved percentage
// into wallet quota with the shared wallet bound and rounding policy.
func referralCommissionQuota(baseQuota int64, ratePercent float64) (int, error) {
	return common.WalletQuotaFromDecimalStrict(
		decimal.NewFromInt(baseQuota).
			Mul(decimal.NewFromFloat(ratePercent)).
			Div(decimal.NewFromInt(100)),
	)
}

// ---------------------------------------------------------------------------
// Settlement (RF-04): pending -> locked -> settled
// ---------------------------------------------------------------------------

// referralCommissionSettlementBatch caps how many commissions one settlement
// statement touches, so a large backlog cannot hold a transaction for long.
const referralCommissionSettlementBatch = 200

// ReferralCommissionSettlementResult summarizes one settlement pass.
type ReferralCommissionSettlementResult struct {
	LockedCount   int   `json:"locked_count"`
	ScannedCount  int   `json:"scanned_count"`
	SettledCount  int   `json:"settled_count"`
	FailedCount   int   `json:"failed_count"`
	SettledQuota  int64 `json:"settled_quota"`
	CreditedQuota int64 `json:"credited_quota"`
	CashQuota     int64 `json:"cash_quota"`
}

// referralCommissionLockWindowSeconds resolves the configured refund window in
// seconds; the setting clamps the value into its supported range.
func referralCommissionLockWindowSeconds() int64 {
	return int64(operation_setting.GetReferralSetting().EffectiveLockWindowDays()) * 86400
}

// referralCommissionCashSettlementEnabled reports whether locked commissions
// settle as cash payable instead of wallet credit. Cash requires both the
// explicit administrator switch and the confirmed payment compliance terms;
// when the confirmation is withdrawn, the default path (credit grants) resumes
// so the sweep never stalls on a legal gate.
func referralCommissionCashSettlementEnabled() bool {
	return operation_setting.GetReferralSetting().CashSettlementEnabled &&
		operation_setting.IsPaymentComplianceConfirmed()
}

// LockDueReferralCommissions moves up to limit pending commissions whose
// refund window elapsed into the locked state and returns how many it moved.
// Locking is the cutoff of the refund window: an event still pending can be
// voided by a refund (RF-05), a locked one is about to be issued. The state
// change is conditional on the current status, so a concurrent pass or refund
// cannot double-lock.
func LockDueReferralCommissions(now int64, limit int) (int, error) {
	if limit <= 0 {
		limit = referralCommissionSettlementBatch
	}
	var candidates []ReferralCommission
	if err := DB.Select("id").
		Where("status = ? AND created_at <= ?", ReferralCommissionStatusPending, now-referralCommissionLockWindowSeconds()).
		Order("id ASC").
		Limit(limit).
		Find(&candidates).Error; err != nil {
		return 0, err
	}
	if len(candidates) == 0 {
		return 0, nil
	}
	ids := make([]int, 0, len(candidates))
	for i := range candidates {
		ids = append(ids, candidates[i].Id)
	}
	updated := DB.Model(&ReferralCommission{}).
		Where("id IN ? AND status = ?", ids, ReferralCommissionStatusPending).
		Updates(map[string]any{
			"status":     ReferralCommissionStatusLocked,
			"locked_at":  now,
			"updated_at": now,
		})
	if updated.Error != nil {
		return 0, updated.Error
	}
	return int(updated.RowsAffected), nil
}

// SettleLockedReferralCommissions issues up to limit locked commissions and
// marks them settled. One commission is one transaction, so a partially failed
// pass simply retries the failed ones on the next run. A commission is settled
// even when the inviter was disabled after the order: the money was earned when
// the event was recorded, and undoing it is the job of the refund and abuse
// paths, not of the settlement sweep.
func SettleLockedReferralCommissions(now int64, limit int) (*ReferralCommissionSettlementResult, error) {
	if limit <= 0 {
		limit = referralCommissionSettlementBatch
	}
	var candidates []ReferralCommission
	if err := DB.Where("status = ?", ReferralCommissionStatusLocked).
		Order("id ASC").
		Limit(limit).
		Find(&candidates).Error; err != nil {
		return nil, err
	}
	result := &ReferralCommissionSettlementResult{ScannedCount: len(candidates)}
	cash := referralCommissionCashSettlementEnabled()
	for i := range candidates {
		source := &candidates[i]
		method := ReferralCommissionSettlementCredit
		if cash {
			method = ReferralCommissionSettlementCash
		}
		grantId, quota, settled, err := settleReferralCommissionTx(source.Id, method, now)
		if err != nil {
			result.FailedCount++
			common.SysError(common.LogText("failed to settle referral commission %d (inviter %d): %s", source.Id, source.InviterId, err.Error()))
			continue
		}
		if !settled {
			continue
		}
		result.SettledCount++
		result.SettledQuota += quota
		if method == ReferralCommissionSettlementCash {
			result.CashQuota += quota
			continue
		}
		result.CreditedQuota += quota
		if grantId <= 0 {
			common.SysError(common.LogText("referral commission %d settled without a credit grant", source.Id))
			continue
		}
		syncCreditUserQuotaCache(source.InviterId, int(quota), "referral commission")
	}
	return result, nil
}

// settleReferralCommissionTx issues one locked commission inside its own
// transaction. The credit grant, its wallet ledger row and the settled state
// commit together: a crash between any two of them leaves the commission
// locked and the next pass settles it again, while the ledger reference
// (referral_commission, commission id) keeps the retry from issuing a second
// grant. A commission that is no longer locked is skipped. Cash settlement
// moves no wallet balance and records the payout form instead, so the
// administrator can process the payout manually.
func settleReferralCommissionTx(commissionId int, method string, now int64) (grantId int, quota int64, settled bool, err error) {
	if commissionId <= 0 {
		return 0, 0, false, nil
	}
	err = DB.Transaction(func(tx *gorm.DB) error {
		// The commission row is locked before the wallet rows, so two
		// settlement passes (or a refund path) serialize on the state
		// transition instead of both issuing.
		var commission ReferralCommission
		if err := lockForUpdate(tx).Where("id = ?", commissionId).First(&commission).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if commission.Status != ReferralCommissionStatusLocked || commission.CommissionQuota <= 0 {
			return nil
		}
		if method != ReferralCommissionSettlementCash {
			grant, applied, err := IssueCreditGrantTx(tx, commission.InviterId,
				operation_setting.CreditGrantSourceReferral, int(commission.CommissionQuota),
				CreditGrantExpiryFor(operation_setting.CreditGrantSourceReferral, now),
				WalletLedgerKindSystemGrant, WalletLedgerRefReferralCommission, strconv.Itoa(commission.Id),
				fmt.Sprintf("referral commission #%d", commission.Id))
			if err != nil {
				return err
			}
			if !applied {
				return errors.New("referral commission ledger reference conflict")
			}
			grantId = grant.Id
		}
		updated := tx.Model(&ReferralCommission{}).
			Where("id = ? AND status = ?", commission.Id, ReferralCommissionStatusLocked).
			Updates(map[string]any{
				"status":            ReferralCommissionStatusSettled,
				"settled_at":        now,
				"settlement_method": method,
				"grant_id":          grantId,
				"updated_at":        now,
			})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return errors.New("referral commission state changed during settlement")
		}
		quota = commission.CommissionQuota
		settled = true
		return nil
	})
	return grantId, quota, settled, err
}

// ProcessReferralCommissionSettlement runs one settlement pass: it locks every
// pending commission whose refund window elapsed and then issues the locked
// ones. The two phases are separate statements, so a failure between them
// leaves the commission locked — visible to the refund path and settled by the
// next pass — instead of silently pending.
func ProcessReferralCommissionSettlement(now int64, limit int) (*ReferralCommissionSettlementResult, error) {
	locked, err := LockDueReferralCommissions(now, limit)
	if err != nil {
		return nil, err
	}
	result, err := SettleLockedReferralCommissions(now, limit)
	if err != nil {
		return nil, err
	}
	result.LockedCount = locked
	return result, nil
}

// ---------------------------------------------------------------------------
// Reversal (RF-05): refund/chargeback -> refunded
// ---------------------------------------------------------------------------

// ReferralCommissionReversal reports one revoked commission event so the
// caller can finish the post-commit work once the enclosing transaction
// committed: the inviter's quota cache and billing history. Quota is the
// amount the inviter is shown — the recorded commission of a revoked event,
// or the part taken back from the wallet of a reclaimed one — and Debt is the
// remainder a reclaimed settled commission could not cover from the wallet
// (WL-06). Reclaimed marks the wallet chargeback of an already issued credit
// commission; a cash payout never entered the wallet, so it is only revoked.
type ReferralCommissionReversal struct {
	CommissionId int
	InviterId    int
	Quota        int64
	Debt         int64
	Reclaimed    bool
}

// reverseReferralCommissionForOrderTx revokes the commission event of one
// refunded or charged-back order inside the same transaction that reverses the
// order, so the order status and its commission can never diverge. An event
// that was never issued (pending, review, locked) moves to the terminal
// refunded state without any wallet movement; a settled credit commission is
// taken back from the inviter's wallet down to zero, the remainder becoming
// wallet debt under the WL-06 rules, and the chargeback is recorded under
// (referral_commission_reversal, commission id). Cash-settled events never
// entered the wallet, so their reversal only voids the recorded event. Events
// that never pay out (blocked, rejected, already refunded) are a no-op, and an
// order without a recorded commission returns (nil, nil). The state change is
// conditional on the current status — the same idempotency anchor settlement
// uses — so a replayed refund reverses nothing twice.
func reverseReferralCommissionForOrderTx(tx *gorm.DB, refType string, refId string, now int64) (*ReferralCommissionReversal, error) {
	if tx == nil || refType == "" || refId == "" {
		return nil, nil
	}
	var commission ReferralCommission
	err := lockForUpdate(tx).Where("ref_type = ? AND ref_id = ?", refType, refId).First(&commission).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var reversal *ReferralCommissionReversal
	switch commission.Status {
	case ReferralCommissionStatusPending, ReferralCommissionStatusReview, ReferralCommissionStatusLocked:
		// The commission was never issued, so revoking it moves no balance;
		// the terminal state also frees the payable allowance it held.
		reversal = &ReferralCommissionReversal{
			CommissionId: commission.Id,
			InviterId:    commission.InviterId,
			Quota:        commission.CommissionQuota,
		}
	case ReferralCommissionStatusSettled:
		if commission.SettlementMethod != ReferralCommissionSettlementCredit {
			// A cash payout never entered the wallet: the reversal voids the
			// recorded event, and recovering an actually paid-out commission
			// stays a manual compliance process.
			reversal = &ReferralCommissionReversal{
				CommissionId: commission.Id,
				InviterId:    commission.InviterId,
				Quota:        commission.CommissionQuota,
			}
			break
		}
		applied, debtIncrease, err := chargeWalletQuotaTx(tx, commission.InviterId, commission.CommissionQuota, 0, "")
		if err != nil {
			return nil, err
		}
		if applied > 0 {
			balanceAfter, err := lockUserQuotaTx(tx, commission.InviterId)
			if err != nil {
				return nil, err
			}
			rowApplied, err := AppendWalletLedgerTx(tx, &WalletLedgerEntry{
				UserId:       commission.InviterId,
				Kind:         WalletLedgerKindChargeback,
				Amount:       -applied,
				BalanceAfter: balanceAfter,
				RefType:      WalletLedgerRefReferralCommissionReversal,
				RefId:        strconv.Itoa(commission.Id),
				Meta:         fmt.Sprintf("reclaimed_commission=%d debt=%d", commission.CommissionQuota, debtIncrease),
				CreatedAt:    now,
			})
			if err != nil {
				return nil, err
			}
			if !rowApplied {
				return nil, errors.New("wallet ledger reference conflict")
			}
			grants, err := lockCreditGrantsTx(tx, commission.InviterId)
			if err != nil {
				return nil, err
			}
			if _, _, err := claimCreditGrantsTx(tx, commission.InviterId, applied, grants, now); err != nil {
				return nil, err
			}
		}
		reversal = &ReferralCommissionReversal{
			CommissionId: commission.Id,
			InviterId:    commission.InviterId,
			Quota:        applied,
			Debt:         debtIncrease,
			Reclaimed:    true,
		}
	default:
		// Blocked, rejected and already refunded events never pay out; a
		// refund of the order reverses nothing.
		return nil, nil
	}

	updated := tx.Model(&ReferralCommission{}).
		Where("id = ? AND status = ?", commission.Id, commission.Status).
		Updates(map[string]any{
			"status":      ReferralCommissionStatusRefunded,
			"reversed_at": now,
			"updated_at":  now,
		})
	if updated.Error != nil {
		return nil, updated.Error
	}
	if updated.RowsAffected != 1 {
		return nil, errors.New("referral commission state changed during reversal")
	}
	return reversal, nil
}

// finishReferralCommissionReversal completes one reversal after its
// transaction committed: the inviter's quota cache absorbs the amount taken
// back from the wallet, and the inviter's billing history records what
// happened — a revoked event that was never issued, or a reclaimed settled
// commission with the debt it left behind. The operator audit line is written
// for every reversal, so an unexpected chargeback stays traceable.
func finishReferralCommissionReversal(reversal *ReferralCommissionReversal) {
	if reversal == nil || reversal.InviterId <= 0 {
		return
	}
	if reversal.Reclaimed && reversal.Quota > 0 {
		syncWalletQuotaCache(reversal.InviterId, -reversal.Quota, "referral commission reversal")
	}
	common.SysLog(common.LogText("referral commission %d (inviter %d) reversed by a payment reversal: quota=%d debt=%d reclaimed=%t",
		reversal.CommissionId, reversal.InviterId, reversal.Quota, reversal.Debt, reversal.Reclaimed))
	if reversal.Reclaimed {
		RecordLog(reversal.InviterId, LogTypeTopup, common.NewMessage(
			"Referral commission reclaimed because the order payment was reversed: {{quota}}, debt added: {{debt}}",
			map[string]any{
				"quota": logger.FormatQuota(int(reversal.Quota)),
				"debt":  logger.FormatQuota(int(reversal.Debt)),
			}))
		return
	}
	RecordLog(reversal.InviterId, LogTypeTopup, common.NewMessage(
		"Referral commission revoked because the order payment was reversed: {{quota}}",
		map[string]any{"quota": logger.FormatQuota(int(reversal.Quota))}))
}

// ErrReferralReviewNotPending reports a review that a concurrent or earlier
// decision already resolved.
var ErrReferralReviewNotPending = errors.New("referral commission review is no longer pending")

// ListReferralCommissionReviews lists the commission events waiting for a
// manual decision, oldest first.
func ListReferralCommissionReviews(pageInfo *common.PageInfo) ([]ReferralCommission, int64, error) {
	var total int64
	if err := DB.Model(&ReferralCommission{}).Where("status = ?", ReferralCommissionStatusReview).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	reviews := make([]ReferralCommission, 0)
	if total == 0 {
		return reviews, 0, nil
	}
	pageSize, offset := 20, 0
	if pageInfo != nil {
		pageSize = pageInfo.GetPageSize()
		offset = pageInfo.GetStartIdx()
	}
	if err := DB.Where("status = ?", ReferralCommissionStatusReview).Order("id").Limit(pageSize).Offset(offset).Find(&reviews).Error; err != nil {
		return nil, total, err
	}
	return reviews, total, nil
}

// DecideReferralCommissionReview approves (review -> pending) or rejects
// (review -> rejected) one reviewed commission. The conditional update claims
// the decision, so two concurrent decisions resolve exactly once; a commission
// that is no longer under review returns ErrReferralReviewNotPending.
func DecideReferralCommissionReview(id int, approve bool) (*ReferralCommission, error) {
	if id <= 0 {
		return nil, errors.New("referral commission id is invalid")
	}
	targetStatus := ReferralCommissionStatusRejected
	if approve {
		targetStatus = ReferralCommissionStatusPending
	}
	var commission ReferralCommission
	err := DB.Transaction(func(tx *gorm.DB) error {
		update := tx.Model(&ReferralCommission{}).
			Where("id = ? AND status = ?", id, ReferralCommissionStatusReview).
			Updates(map[string]any{"status": targetStatus, "updated_at": common.GetTimestamp()})
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected == 0 {
			return ErrReferralReviewNotPending
		}
		return tx.First(&commission, id).Error
	})
	if err != nil {
		return nil, err
	}
	return &commission, nil
}
