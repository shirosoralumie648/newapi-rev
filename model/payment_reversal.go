package model

import (
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"

	"gorm.io/gorm"
)

// Payment reversal: refunds and chargebacks.
//
// A refund or dispute notification means the payment provider took the money
// back. The quota the order credited is reversed through the wallet ledger in
// the same transaction that moves the order to refunded/disputed: the wallet
// is debited down to zero (never into the overdraft line) and any remainder
// the account already spent becomes wallet debt under the WL-06 rules, so the
// platform never loses more than the account could cover. The order status
// transition success -> refunded/disputed and the unique ledger reference
// (topup_reversal, tradeNo) are the idempotency anchors; replaying the same
// notification is a no-op, and a refund followed by a dispute keeps the first
// classification.

// paymentReversalStatus maps the event kind to the order status it records.
func paymentReversalStatus(disputed bool) string {
	if disputed {
		return common.TopUpStatusDisputed
	}
	return common.TopUpStatusRefunded
}

// lockTopUpTx loads and locks one top-up order by its trade number.
func lockTopUpTx(tx *gorm.DB, tradeNo string) (*TopUp, error) {
	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}
	topUp := &TopUp{}
	if err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(topUp).Error; err != nil {
		return nil, ErrTopUpNotFound
	}
	return topUp, nil
}

// lockSubscriptionOrderTx loads and locks one subscription order by its trade
// number.
func lockSubscriptionOrderTx(tx *gorm.DB, tradeNo string) (*SubscriptionOrder, error) {
	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}
	order := &SubscriptionOrder{}
	if err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(order).Error; err != nil {
		return nil, ErrSubscriptionOrderNotFound
	}
	return order, nil
}

// topUpCreditedQuotaTx returns the quota one top-up order actually credited,
// read from its ledger row. Orders that never reached the wallet (expired,
// failed, or the zero-amount mirror row of a subscription order) return zero.
func topUpCreditedQuotaTx(tx *gorm.DB, tradeNo string) (int64, error) {
	var credited int64
	err := tx.Model(&WalletLedgerEntry{}).
		Where("kind = ? AND ref_type = ? AND ref_id = ?", WalletLedgerKindTopUp, WalletLedgerRefTopUp, tradeNo).
		Select("COALESCE(SUM(amount), 0)").
		Scan(&credited).Error
	return credited, err
}

// reverseWalletQuotaTx debits up to credited quota from the wallet without
// entering the overdraft line; the part the wallet cannot cover becomes wallet
// debt. The wallet movement is recorded as one chargeback ledger row under
// (topup_reversal, tradeNo), and the charge is attributed to credit grants
// first, exactly like a settlement charge, so the grant invariant
// Σ remaining ≤ max(quota, 0) still holds after the reversal.
func reverseWalletQuotaTx(tx *gorm.DB, userId int, credited int64, tradeNo string) (int64, int64, error) {
	applied, debtIncrease, err := chargeWalletQuotaTx(tx, userId, credited, 0, "")
	if err != nil {
		return 0, 0, err
	}
	if applied <= 0 {
		return applied, debtIncrease, nil
	}
	balanceAfter, err := lockUserQuotaTx(tx, userId)
	if err != nil {
		return 0, 0, err
	}
	rowApplied, err := AppendWalletLedgerTx(tx, &WalletLedgerEntry{
		UserId:       userId,
		Kind:         WalletLedgerKindChargeback,
		Amount:       -applied,
		BalanceAfter: balanceAfter,
		RefType:      WalletLedgerRefTopUpReversal,
		RefId:        tradeNo,
		Meta:         fmt.Sprintf("reversed_credit=%d debt=%d", credited, debtIncrease),
		CreatedAt:    common.GetTimestamp(),
	})
	if err != nil {
		return 0, 0, err
	}
	if !rowApplied {
		return 0, 0, errors.New("wallet ledger reference conflict")
	}
	grants, err := lockCreditGrantsTx(tx, userId)
	if err != nil {
		return 0, 0, err
	}
	if _, _, err := claimCreditGrantsTx(tx, userId, applied, grants, common.GetTimestamp()); err != nil {
		return 0, 0, err
	}
	return applied, debtIncrease, nil
}

// paymentReversalOutcome is what one applied payment reversal did: the quota
// that left the wallet, the debt it added, the referral commission event it
// revoked (nil when the order recorded none) and whether this call performed
// the transition.
type paymentReversalOutcome struct {
	walletQuota  int64
	debtIncrease int64
	commission   *ReferralCommissionReversal
	reversed     bool
}

// applyPaymentReversal reverses the wallet credit of one locked top-up order
// and moves it to refunded/disputed, revoking the referral commission the order
// recorded in the same transaction. It returns what the reversal did; replays
// of an already reversed order change nothing and report false.
func applyPaymentReversal(tx *gorm.DB, topUp *TopUp, targetStatus string) (paymentReversalOutcome, error) {
	outcome := paymentReversalOutcome{}
	switch topUp.Status {
	case common.TopUpStatusRefunded, common.TopUpStatusDisputed:
		return outcome, nil
	case common.TopUpStatusSuccess:
	default:
		return outcome, ErrTopUpStatusInvalid
	}
	credited, err := topUpCreditedQuotaTx(tx, topUp.TradeNo)
	if err != nil {
		return outcome, err
	}
	if credited > 0 {
		applied, debtIncrease, err := reverseWalletQuotaTx(tx, topUp.UserId, credited, topUp.TradeNo)
		if err != nil {
			return outcome, err
		}
		outcome.walletQuota = applied
		outcome.debtIncrease = debtIncrease
	}
	// The commission event of the order is revoked in the same transaction:
	// the order must not commit as refunded while its commission keeps
	// waiting to be issued.
	commission, err := reverseReferralCommissionForOrderTx(tx, WalletLedgerRefTopUp, topUp.TradeNo, common.GetTimestamp())
	if err != nil {
		return outcome, err
	}
	outcome.commission = commission
	topUp.Status = targetStatus
	topUp.RefundTime = common.GetTimestamp()
	if err := tx.Save(topUp).Error; err != nil {
		return outcome, err
	}
	outcome.reversed = true
	return outcome, nil
}

// ReverseTopUpPayment reverses one wallet top-up identified by its local trade
// number, classifying it as a refund or a chargeback dispute.
func ReverseTopUpPayment(tradeNo string, disputed bool) error {
	if tradeNo == "" {
		return errors.New("payment order number not provided")
	}
	targetStatus := paymentReversalStatus(disputed)
	var userId int
	var outcome paymentReversalOutcome
	err := DB.Transaction(func(tx *gorm.DB) error {
		topUp, err := lockTopUpTx(tx, tradeNo)
		if err != nil {
			return err
		}
		userId = topUp.UserId
		outcome, err = applyPaymentReversal(tx, topUp, targetStatus)
		return err
	})
	if err != nil {
		return err
	}
	if outcome.walletQuota > 0 {
		syncWalletQuotaCache(userId, -outcome.walletQuota, "top-up payment reversal")
	}
	finishReferralCommissionReversal(outcome.commission)
	if outcome.reversed {
		recordPaymentReversalLog(userId, outcome.walletQuota, outcome.debtIncrease, disputed)
	}
	return nil
}

// ReverseSubscriptionOrderPayment reverses one subscription order. Subscription
// quota is not wallet money, so no wallet movement is reversed; the order is
// moved to refunded/disputed, the mirrored top-up history row is reversed too,
// and the subscription the order created is cancelled with the user group
// downgraded under the same rules as an administrator invalidation.
func ReverseSubscriptionOrderPayment(tradeNo string, disputed bool) error {
	if tradeNo == "" {
		return errors.New("payment order number not provided")
	}
	targetStatus := paymentReversalStatus(disputed)
	var userId int
	var cacheGroup string
	var reversed bool
	var commission *ReferralCommissionReversal
	err := DB.Transaction(func(tx *gorm.DB) error {
		order, err := lockSubscriptionOrderTx(tx, tradeNo)
		if err != nil {
			return err
		}
		switch order.Status {
		case common.TopUpStatusRefunded, common.TopUpStatusDisputed:
			return nil
		case common.TopUpStatusSuccess:
		default:
			return ErrSubscriptionOrderStatusInvalid
		}
		reversed = true
		userId = order.UserId

		// The mirror top-up row carries no wallet credit, so reversing it only
		// keeps the billing history consistent; a commission on the trade
		// number is revoked all the same.
		if mirror, err := lockTopUpTx(tx, tradeNo); err == nil {
			if mirror.Status == common.TopUpStatusSuccess {
				outcome, err := applyPaymentReversal(tx, mirror, targetStatus)
				if err != nil {
					return err
				}
				commission = outcome.commission
			}
		} else if !errors.Is(err, ErrTopUpNotFound) {
			return err
		}

		now := common.GetTimestamp()
		var sub UserSubscription
		err = lockForUpdate(tx).Where("trade_no = ?", tradeNo).First(&sub).Error
		if err == nil && sub.Status == "active" {
			if err := tx.Model(&sub).Updates(map[string]any{
				"status":     "cancelled",
				"end_time":   now,
				"updated_at": now,
			}).Error; err != nil {
				return err
			}
			targetGroup, err := downgradeUserGroupForSubscriptionTx(tx, &sub, now)
			if err != nil {
				return err
			}
			cacheGroup = targetGroup
		} else if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}

		order.Status = targetStatus
		order.RefundTime = now
		return tx.Save(order).Error
	})
	if err != nil {
		return err
	}
	if cacheGroup != "" && userId > 0 {
		refreshSubscriptionUserGroupCache(userId, common.LogText("subscription order reversal"))
	}
	if reversed {
		RecordLog(userId, LogTypeTopup, common.NewMessage("Subscription order payment was reversed, plan subscription cancelled"))
	}
	finishReferralCommissionReversal(commission)
	return nil
}

// ReversePaymentByProviderPaymentId classifies a provider refund or dispute by
// the provider payment reference stored on the order. Subscription orders are
// matched before wallet top-ups, because a subscription order also writes a
// mirror top-up row under the same trade number. It reports whether a local
// order was found and reversed.
func ReversePaymentByProviderPaymentId(provider string, providerPaymentId string, disputed bool) (bool, error) {
	if provider == "" || providerPaymentId == "" {
		return false, errors.New("provider payment id is required")
	}
	var order SubscriptionOrder
	err := DB.Select("trade_no").
		Where("payment_provider = ? AND provider_payment_id = ?", provider, providerPaymentId).
		First(&order).Error
	if err == nil {
		return true, ReverseSubscriptionOrderPayment(order.TradeNo, disputed)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return false, err
	}
	var topUp TopUp
	err = DB.Select("trade_no").
		Where("payment_provider = ? AND provider_payment_id = ?", provider, providerPaymentId).
		First(&topUp).Error
	if err == nil {
		return true, ReverseTopUpPayment(topUp.TradeNo, disputed)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return false, err
	}
	return false, nil
}

// ReversePaymentByTradeNo classifies a provider refund or dispute that carries
// the local trade number. Subscription orders are matched before wallet
// top-ups, because a subscription order also writes a mirror top-up row under
// the same trade number. It reports whether a local order was found and
// reversed.
func ReversePaymentByTradeNo(tradeNo string, disputed bool) (bool, error) {
	if tradeNo == "" {
		return false, errors.New("payment order number not provided")
	}
	var order SubscriptionOrder
	err := DB.Select("trade_no").Where("trade_no = ?", tradeNo).First(&order).Error
	if err == nil {
		return true, ReverseSubscriptionOrderPayment(tradeNo, disputed)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return false, err
	}
	var topUp TopUp
	err = DB.Select("trade_no").Where("trade_no = ?", tradeNo).First(&topUp).Error
	if err == nil {
		return true, ReverseTopUpPayment(tradeNo, disputed)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return false, err
	}
	return false, nil
}

// RefundUnusedTopUpBalance is the administrator-initiated refund of a paid
// top-up. Unlike a provider refund it must not create debt: it claws back the
// credited quota only when the whole amount is still covered by the wallet
// balance, and rejects the request with ErrTopUpBalanceInsufficient otherwise.
// The provider-side money movement stays manual; this records the order as
// refunded and takes the quota back.
func RefundUnusedTopUpBalance(tradeNo string, callerIp string) error {
	if tradeNo == "" {
		return errors.New("payment order number not provided")
	}
	var userId int
	var paymentMethod string
	var credited int64
	var commission *ReferralCommissionReversal
	err := DB.Transaction(func(tx *gorm.DB) error {
		topUp, err := lockTopUpTx(tx, tradeNo)
		if err != nil {
			return err
		}
		if topUp.Status == common.TopUpStatusRefunded || topUp.Status == common.TopUpStatusDisputed {
			return nil // already refunded, an administrator retry is a no-op
		}
		if topUp.Status != common.TopUpStatusSuccess {
			return ErrTopUpStatusInvalid
		}
		credited, err = topUpCreditedQuotaTx(tx, tradeNo)
		if err != nil {
			return err
		}
		if credited <= 0 {
			return ErrTopUpRefundNotAllowed
		}
		balance, err := lockUserQuotaTx(tx, topUp.UserId)
		if err != nil {
			return err
		}
		if max(balance, 0) < credited {
			return ErrTopUpBalanceInsufficient
		}
		balanceAfter, err := addWalletQuotaChecked(balance, -credited, "admin top-up refund")
		if err != nil {
			return err
		}
		rowApplied, err := AppendWalletLedgerTx(tx, &WalletLedgerEntry{
			UserId:       topUp.UserId,
			Kind:         WalletLedgerKindChargeback,
			Amount:       -credited,
			BalanceAfter: balanceAfter,
			RefType:      WalletLedgerRefTopUpReversal,
			RefId:        tradeNo,
			Meta:         "administrator refund of unused top-up balance",
			CreatedAt:    common.GetTimestamp(),
		})
		if err != nil {
			return err
		}
		if !rowApplied {
			return errors.New("wallet ledger reference conflict")
		}
		if err := writeLockedWalletQuotaTx(tx, topUp.UserId, balanceAfter); err != nil {
			return err
		}
		grants, err := lockCreditGrantsTx(tx, topUp.UserId)
		if err != nil {
			return err
		}
		if _, _, err := claimCreditGrantsTx(tx, topUp.UserId, credited, grants, common.GetTimestamp()); err != nil {
			return err
		}
		// The commission of the refunded order is revoked in the same
		// transaction; the inviter's clawback may book wallet debt even
		// though the invitee side of this refund may not.
		commission, err = reverseReferralCommissionForOrderTx(tx, WalletLedgerRefTopUp, tradeNo, common.GetTimestamp())
		if err != nil {
			return err
		}
		topUp.Status = common.TopUpStatusRefunded
		topUp.RefundTime = common.GetTimestamp()
		if err := tx.Save(topUp).Error; err != nil {
			return err
		}
		userId = topUp.UserId
		paymentMethod = topUp.PaymentMethod
		return nil
	})
	if err != nil {
		return err
	}
	if credited > 0 {
		syncWalletQuotaCache(userId, -credited, "admin top-up refund")
		RecordTopupLog(userId, common.NewMessage("Administrator refunded the order, quota withdrawn: {{quota}}", map[string]any{"quota": logger.FormatQuota(int(credited))}), callerIp, paymentMethod, "admin")
	}
	finishReferralCommissionReversal(commission)
	return nil
}

// recordPaymentReversalLog writes the billing-history entry of one reversed
// payment. A reversal that found nothing to withdraw (an order whose credit
// predates the ledger) is still recorded, so the status change is visible.
func recordPaymentReversalLog(userId int, applied int64, debtIncrease int64, disputed bool) {
	if userId <= 0 {
		return
	}
	if disputed {
		RecordLog(userId, LogTypeTopup, common.NewMessage("Top-up payment disputed, quota withdrawn: {{quota}}, debt added: {{debt}}", map[string]any{
			"quota": logger.FormatQuota(int(applied)),
			"debt":  logger.FormatQuota(int(debtIncrease)),
		}))
		return
	}
	RecordLog(userId, LogTypeTopup, common.NewMessage("Top-up payment refunded, quota withdrawn: {{quota}}, debt added: {{debt}}", map[string]any{
		"quota": logger.FormatQuota(int(applied)),
		"debt":  logger.FormatQuota(int(debtIncrease)),
	}))
}
