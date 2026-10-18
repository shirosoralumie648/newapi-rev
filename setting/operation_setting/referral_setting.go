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
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"

	"github.com/shopspring/decimal"
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

// Referral commission rate sources, in resolution order: a single-account
// override wins over the account's agent tier, the tier wins over the group
// override and the group override wins over the global default. The source is
// recorded on every commission event for the audit trail.
const (
	ReferralRateSourceUser    = "user"
	ReferralRateSourceTier    = "tier"
	ReferralRateSourceGroup   = "group"
	ReferralRateSourceDefault = "default"
)

// Bounds of the optional agent program (RF-08): an administrator marks
// accounts as 推荐官/代理 and attaches one configured tier. The program is
// strictly single level — a tier only scales the account's own commission and
// never introduces uplines, downlines or team compensation.
const (
	ReferralAgentTierMaxCount     = 50
	ReferralAgentTierIdMaxLength  = 40
	ReferralAgentTierNameMaxRunes = 40
)

// ReferralAgentTier is one optional agent tier: a stable identifier
// administrators attach to marked accounts, a display name and the commission
// rate the tier grants.
type ReferralAgentTier struct {
	Id          string  `json:"id"`
	Name        string  `json:"name"`
	RatePercent float64 `json:"rate_percent"`
}

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

// ReferralInviteLimitMax bounds the configurable per-signal invitation limits
// (RF-06), so an accidental extra digit cannot silently disable the bound.
const ReferralInviteLimitMax = 100

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
	// per-account override is recorded per account (RF-08).
	GroupRateOverrides map[string]float64 `json:"group_rate_overrides"`
	// AgentTiers lists the optional administrator-defined tiers of the agent
	// program (RF-08); the list is empty by default, so the program stays off
	// until it is configured. A marked account inherits its tier's rate unless
	// the account carries its own override.
	AgentTiers []ReferralAgentTier `json:"agent_tiers"`
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

	// Anti-abuse limits (RF-06). Every bound is disabled by default (0): an
	// installation keeps working without configured limits.
	//
	// InviteLimitPerIP, InviteLimitPerDevice and InviteLimitPerEmailDomain
	// bound how many invitees of one inviter may earn a commission from
	// registrations sharing the invitee's registration IP, device or email
	// domain. A missing registration signal never triggers its bound.
	InviteLimitPerIP          int `json:"invite_limit_per_ip"`
	InviteLimitPerDevice      int `json:"invite_limit_per_device"`
	InviteLimitPerEmailDomain int `json:"invite_limit_per_email_domain"`
	// DailyCommissionCapUSD, MonthlyCommissionCapUSD and
	// InviteeCommissionCapUSD bound the payable commission of one inviter per
	// calendar day, per calendar month and one invitee over the whole
	// relation. An event above a cap is recorded as blocked for the audit
	// trail and never pays out.
	DailyCommissionCapUSD   float64 `json:"daily_commission_cap_usd"`
	MonthlyCommissionCapUSD float64 `json:"monthly_commission_cap_usd"`
	InviteeCommissionCapUSD float64 `json:"invitee_commission_cap_usd"`
	// ReviewThresholdUSD moves a single commission above this amount into
	// manual review; an administrator must approve it before it can settle.
	ReviewThresholdUSD float64 `json:"review_threshold_usd"`
	// RequireRealName blocks the commissions of an inviter whose real-name
	// identity has not been recorded by an administrator yet.
	RequireRealName bool `json:"require_real_name"`
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

// ResolveCommissionRatePercent resolves the effective commission rate of one
// inviter from the recorded account context. The resolution order is
// single-account override → agent tier → group override → global default; an
// unknown or deleted tier falls through to the group configuration, so
// removing a tier never orphans a marked agent. The second return value names
// the winning source and is recorded on the commission event.
func (s *ReferralSetting) ResolveCommissionRatePercent(group string, tierId string, accountOverride *float64) (float64, string) {
	if s == nil {
		return 0, ReferralRateSourceDefault
	}
	if accountOverride != nil {
		return clampReferralCommissionRate(*accountOverride), ReferralRateSourceUser
	}
	if tier, ok := s.AgentTier(tierId); ok {
		return clampReferralCommissionRate(tier.RatePercent), ReferralRateSourceTier
	}
	if override, ok := s.GroupRateOverrides[group]; ok && group != "" {
		return clampReferralCommissionRate(override), ReferralRateSourceGroup
	}
	return clampReferralCommissionRate(s.CommissionRatePercent), ReferralRateSourceDefault
}

// AgentTier returns the configured agent tier by identifier; the empty
// identifier and an unknown tier both report false.
func (s *ReferralSetting) AgentTier(tierId string) (ReferralAgentTier, bool) {
	if s == nil || tierId == "" {
		return ReferralAgentTier{}, false
	}
	for _, tier := range s.AgentTiers {
		if tier.Id == tierId {
			return tier, true
		}
	}
	return ReferralAgentTier{}, false
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

// ReferralCommissionCapMaxUSD is the largest configurable commission cap in
// USD: the wallet quota bound converted back, so a configured cap can never
// saturate the wallet conversion.
func ReferralCommissionCapMaxUSD() float64 {
	return float64(common.MaxWalletQuota) / common.QuotaPerUnit
}

// referralCommissionCapQuota converts a USD cap to quota with the shared wallet
// bound and audits a saturated configuration like the overdraft limit does.
func referralCommissionCapQuota(usd float64) int64 {
	if usd <= 0 || math.IsNaN(usd) || math.IsInf(usd, 0) {
		return 0
	}
	if maxUSD := ReferralCommissionCapMaxUSD(); maxUSD > 0 && usd > maxUSD {
		common.SysError(common.LogText("referral commission cap %v USD exceeds the wallet bound, using %v USD", usd, maxUSD))
		usd = maxUSD
	}
	quota, err := common.WalletQuotaFromDecimalStrict(
		decimal.NewFromFloat(usd).Mul(decimal.NewFromFloat(common.QuotaPerUnit)),
	)
	if err != nil {
		common.SysError(common.LogText("invalid referral commission cap %v USD: %s", usd, err.Error()))
		return 0
	}
	return int64(quota)
}

// DailyCommissionCapQuota resolves the per-day payable commission cap in quota;
// 0 means the cap is disabled.
func (s *ReferralSetting) DailyCommissionCapQuota() int64 {
	if s == nil {
		return 0
	}
	return referralCommissionCapQuota(s.DailyCommissionCapUSD)
}

// MonthlyCommissionCapQuota resolves the per-calendar-month payable commission
// cap in quota; 0 means the cap is disabled.
func (s *ReferralSetting) MonthlyCommissionCapQuota() int64 {
	if s == nil {
		return 0
	}
	return referralCommissionCapQuota(s.MonthlyCommissionCapUSD)
}

// InviteeCommissionCapQuota resolves the lifetime payable commission cap of one
// invitee relation in quota; 0 means the cap is disabled.
func (s *ReferralSetting) InviteeCommissionCapQuota() int64 {
	if s == nil {
		return 0
	}
	return referralCommissionCapQuota(s.InviteeCommissionCapUSD)
}

// ReviewThresholdQuota resolves the single-commission manual review threshold
// in quota; 0 means every commission is recorded as payable directly.
func (s *ReferralSetting) ReviewThresholdQuota() int64 {
	if s == nil {
		return 0
	}
	return referralCommissionCapQuota(s.ReviewThresholdUSD)
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
	case "referral_setting.agent_tiers":
		return validateReferralAgentTiers(value)
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
	case "referral_setting.invite_limit_per_ip",
		"referral_setting.invite_limit_per_device",
		"referral_setting.invite_limit_per_email_domain":
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 0 || limit > ReferralInviteLimitMax {
			return fmt.Errorf("%s must be an integer between 0 and %d", key, ReferralInviteLimitMax)
		}
	case "referral_setting.daily_commission_cap_usd",
		"referral_setting.monthly_commission_cap_usd",
		"referral_setting.invitee_commission_cap_usd",
		"referral_setting.review_threshold_usd":
		return validateReferralCommissionCap(key, value)
	case "referral_setting.require_real_name":
		if _, err := strconv.ParseBool(value); err != nil {
			return fmt.Errorf("referral_setting.require_real_name must be a boolean")
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

// validateReferralCommissionCap accepts a finite USD amount within the wallet
// bound; 0 disables the bound.
func validateReferralCommissionCap(key string, value string) error {
	amount, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(amount) || math.IsInf(amount, 0) || amount < 0 || amount > ReferralCommissionCapMaxUSD() {
		return fmt.Errorf("%s must be a finite amount in USD between 0 and %v", key, ReferralCommissionCapMaxUSD())
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

// validateReferralAgentTiers accepts a JSON array of agent tiers, rejecting
// duplicate or oversized identifiers, empty or oversized names and
// out-of-range rates so a broken tier list can never be persisted.
func validateReferralAgentTiers(value string) error {
	if value == "" {
		return nil
	}
	tiers := []ReferralAgentTier{}
	if err := common.UnmarshalJsonStr(value, &tiers); err != nil {
		return fmt.Errorf("referral_setting.agent_tiers must be a JSON array of agent tiers")
	}
	if len(tiers) > ReferralAgentTierMaxCount {
		return fmt.Errorf("referral_setting.agent_tiers must not contain more than %d tiers", ReferralAgentTierMaxCount)
	}
	seen := make(map[string]struct{}, len(tiers))
	for _, tier := range tiers {
		id := strings.TrimSpace(tier.Id)
		name := strings.TrimSpace(tier.Name)
		if id == "" || len(id) > ReferralAgentTierIdMaxLength {
			return fmt.Errorf("referral agent tier id must be 1-%d characters", ReferralAgentTierIdMaxLength)
		}
		if name == "" || len([]rune(name)) > ReferralAgentTierNameMaxRunes {
			return fmt.Errorf("referral agent tier name of %s must be 1-%d characters", id, ReferralAgentTierNameMaxRunes)
		}
		if math.IsNaN(tier.RatePercent) || math.IsInf(tier.RatePercent, 0) || tier.RatePercent < 0 || tier.RatePercent > ReferralCommissionRateMaxPercent {
			return fmt.Errorf("referral commission rate of agent tier %s must be a number between 0 and %d", id, ReferralCommissionRateMaxPercent)
		}
		if _, ok := seen[id]; ok {
			return fmt.Errorf("referral agent tier id %s is duplicated", id)
		}
		seen[id] = struct{}{}
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
