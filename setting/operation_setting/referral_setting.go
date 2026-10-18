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
package operation_setting

import (
	"fmt"
	"math"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"
)

// Referral commission trigger windows. The window is counted from the
// invitee's registration time: 0 rewards only the first paid order, a positive
// value rewards every order inside that many months, and -1 rewards every
// order forever.
const (
	ReferralWindowMonthsDefault    = 12
	ReferralWindowMonthsFirstTopUp = 0
	ReferralWindowMonthsUnlimited  = -1
	// ReferralWindowMonthsMax bounds a configured window (ten years), so a
	// misconfigured option cannot describe an unbounded future range.
	ReferralWindowMonthsMax = 120
)

// ReferralCommissionRateMaxPercent is the largest configurable commission
// rate. 100 percent means the inviter earns the full paid amount.
const ReferralCommissionRateMaxPercent = 100

// Referral commission lock windows. A recorded commission stays pending for
// this many days after the paid order (the refund window, RF-05), then it is
// locked and issued. The supported range keeps the window long enough for a
// payment to be refunded and short enough that inviters are paid within a
// month.
const (
	ReferralLockWindowDaysMin     = 14
	ReferralLockWindowDaysMax     = 30
	ReferralLockWindowDaysDefault = 21
)

// ReferralSetting configures the single-level referral commission engine: the
// inviter earns a percentage of every paid order of an invitee inside the
// configured window. Commissions are recorded as events (RF-03) and issued by
// the settlement task (RF-04): an event stays pending for the lock window,
// then it is locked and settled as a credit grant. Cash settlement stays
// disabled by default and is gated on the payment compliance confirmation; it
// records the settled quota as payable instead of crediting the wallet.
type ReferralSetting struct {
	// Enabled is the master switch of the engine. It requires the confirmed
	// payment compliance terms, like the other invitation rewards.
	Enabled bool `json:"enabled"`
	// CommissionRatePercent is the default commission rate in percent of the
	// paid amount (0 means no commission).
	CommissionRatePercent float64 `json:"commission_rate_percent"`
	// GroupRateOverrides replaces CommissionRatePercent for one inviter group
	// (the stable group identifier); a missing group inherits the default. The
	// per-account override is a later step (RF-08).
	GroupRateOverrides map[string]float64 `json:"group_rate_overrides"`
	// WindowMonths bounds which paid orders commission: 0 rewards only the
	// first order, a positive value the first WindowMonths months after
	// registration, and -1 every order forever.
	WindowMonths int `json:"window_months"`
	// IncludeRedemptionCodes decides whether redeeming a quota code counts as
	// a paid order (the upstream #5829 dispute); subscription codes never
	// count because they move no wallet balance.
	IncludeRedemptionCodes bool `json:"include_redemption_codes"`
	// LockWindowDays is the refund window of a recorded commission in days:
	// the commission stays pending until it elapses, so a refund inside the
	// window can still cancel it before any credit is issued. The supported
	// range is 14 to 30 days.
	LockWindowDays int `json:"lock_window_days"`
	// CashSettlementEnabled is the payout-form switch of the settlement step
	// (RF-04); it is off by default and requires the confirmed payment
	// compliance terms, because paying cash can trigger tax and payment
	// license duties of the operator. Only an explicit choice settles cash;
	// the default path issues credit grants.
	CashSettlementEnabled bool `json:"cash_settlement_enabled"`
}

// 默认配置：引擎默认关闭，窗口默认注册后 12 个月，退款窗口默认 21 天。
var referralSetting = ReferralSetting{
	WindowMonths:   ReferralWindowMonthsDefault,
	LockWindowDays: ReferralLockWindowDaysDefault,
}

func init() {
	config.GlobalConfig.Register("referral_setting", &referralSetting)
}

func GetReferralSetting() *ReferralSetting {
	return &referralSetting
}

// CommissionRatePercentFor resolves the effective commission rate of one
// inviter group in percent of the paid amount. The group override wins over
// the default; a missing, non-finite or out-of-range value resolves to zero
// (or the cap) so a misconfigured option can never pay more than configured.
func (s *ReferralSetting) CommissionRatePercentFor(group string) float64 {
	if s == nil {
		return 0
	}
	rate := s.CommissionRatePercent
	if override, ok := s.GroupRateOverrides[group]; ok && group != "" {
		rate = override
	}
	return clampReferralCommissionRate(rate)
}

// EffectiveLockWindowDays returns the configured commission lock window in
// days, clamped into the supported range. A missing or misconfigured value
// resolves to the closest bound, so a bad option can neither issue a
// commission before the refund window nor lock it forever.
func (s *ReferralSetting) EffectiveLockWindowDays() int {
	if s == nil {
		return ReferralLockWindowDaysDefault
	}
	return min(max(s.LockWindowDays, ReferralLockWindowDaysMin), ReferralLockWindowDaysMax)
}

// clampReferralCommissionRate rejects a non-finite or negative rate and caps
// one above the configured maximum, so the caller always receives a usable
// percentage.
func clampReferralCommissionRate(rate float64) float64 {
	if math.IsNaN(rate) || math.IsInf(rate, 0) || rate < 0 {
		return 0
	}
	return min(rate, float64(ReferralCommissionRateMaxPercent))
}

// ValidateReferralOption validates commission settings before they are
// persisted. Invalid updates are rejected and the previous configuration
// keeps working.
func ValidateReferralOption(key, value string) error {
	switch key {
	case "referral_setting.enabled":
		enabled, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("referral_setting.enabled must be a boolean")
		}
		if enabled && !IsPaymentComplianceConfirmed() {
			return fmt.Errorf("referral_setting.enabled requires the confirmed payment compliance terms")
		}
	case "referral_setting.commission_rate_percent":
		return validateReferralCommissionRate(key, value)
	case "referral_setting.group_rate_overrides":
		return validateReferralGroupRateOverrides(value)
	case "referral_setting.window_months":
		return validateReferralWindowMonths(value)
	case "referral_setting.include_redemption_codes":
		if _, err := strconv.ParseBool(value); err != nil {
			return fmt.Errorf("referral_setting.include_redemption_codes must be a boolean")
		}
	case "referral_setting.lock_window_days":
		return validateReferralLockWindowDays(value)
	case "referral_setting.cash_settlement_enabled":
		enabled, err := strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("referral_setting.cash_settlement_enabled must be a boolean")
		}
		if enabled && !IsPaymentComplianceConfirmed() {
			return fmt.Errorf("referral_setting.cash_settlement_enabled requires the confirmed payment compliance terms; the administrator must assess the personal income tax and payment licensing duties of cash commissions")
		}
	}
	return nil
}

// validateReferralCommissionRate accepts one finite percentage within the
// supported range.
func validateReferralCommissionRate(key string, value string) error {
	rate, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(rate) || math.IsInf(rate, 0) || rate < 0 || rate > ReferralCommissionRateMaxPercent {
		return fmt.Errorf("%s must be a number between 0 and %d", key, ReferralCommissionRateMaxPercent)
	}
	return nil
}

// validateReferralGroupRateOverrides accepts a JSON object of inviter group to
// commission percentage, rejecting empty groups and out-of-range values.
func validateReferralGroupRateOverrides(value string) error {
	if value == "" {
		return nil
	}
	overrides := map[string]float64{}
	if err := common.UnmarshalJsonStr(value, &overrides); err != nil {
		return fmt.Errorf("referral_setting.group_rate_overrides must be a JSON object of group to percent")
	}
	for group, rate := range overrides {
		if group == "" {
			return fmt.Errorf("referral_setting.group_rate_overrides must not contain an empty group")
		}
		if math.IsNaN(rate) || math.IsInf(rate, 0) || rate < 0 || rate > ReferralCommissionRateMaxPercent {
			return fmt.Errorf("referral commission rate of group %s must be a number between 0 and %d", group, ReferralCommissionRateMaxPercent)
		}
	}
	return nil
}

// validateReferralWindowMonths accepts -1 (no limit) or an integer number of
// months from 0 (first order only) to the supported maximum.
func validateReferralWindowMonths(value string) error {
	months, err := strconv.Atoi(value)
	if err != nil || months < ReferralWindowMonthsUnlimited || months > ReferralWindowMonthsMax {
		return fmt.Errorf("referral_setting.window_months must be -1 or an integer between 0 and %d", ReferralWindowMonthsMax)
	}
	return nil
}

// validateReferralLockWindowDays accepts an integer number of days inside the
// supported lock window range.
func validateReferralLockWindowDays(value string) error {
	days, err := strconv.Atoi(value)
	if err != nil || days < ReferralLockWindowDaysMin || days > ReferralLockWindowDaysMax {
		return fmt.Errorf("referral_setting.lock_window_days must be an integer between %d and %d", ReferralLockWindowDaysMin, ReferralLockWindowDaysMax)
	}
	return nil
}
