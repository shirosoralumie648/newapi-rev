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

// ReferralCommissionStatusPending is the state of every event this step
// writes: the commission is recorded but not yet locked or issued (RF-04).
const ReferralCommissionStatusPending = "pending"

// ReferralCommission is one single-level commission event of one paid order:
// how much the invitee actually paid, which rate applied and how much the
// inviter earns. The row is an event only — the reference settlement step
// (RF-04) locks and issues it — so writing one never moves any balance. The
// unique (ref_type, ref_id) index keys the event by the top-up order or the
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
	RatePercent     string `json:"rate_percent" gorm:"type:varchar(16);not null"`
	CommissionQuota int64  `json:"commission_quota" gorm:"type:bigint;not null"`
	Status          string `json:"status" gorm:"type:varchar(16);not null;index"`
	CreatedAt       int64  `json:"created_at" gorm:"bigint;not null;index"`
	UpdatedAt       int64  `json:"updated_at" gorm:"bigint;not null"`
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

	ratePercent := setting.CommissionRatePercentFor(inviter.Group)
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
		if err := tx.Model(&ReferralCommission{}).Where("invitee_id = ?", inviteeId).Count(&recorded).Error; err != nil {
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

	commission := &ReferralCommission{
		InviterId:       binding.InviterId,
		InviteeId:       inviteeId,
		Source:          source,
		RefType:         refType,
		RefId:           refId,
		BaseQuota:       baseQuota,
		RatePercent:     strconv.FormatFloat(ratePercent, 'f', -1, 64),
		CommissionQuota: int64(commissionQuota),
		Status:          ReferralCommissionStatusPending,
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
