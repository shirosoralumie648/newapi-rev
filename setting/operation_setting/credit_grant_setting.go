package operation_setting

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/QuantumNous/new-api/setting/config"
)

// Credit grant sources. Grant-typed credits (sign-in bonus, invitation reward,
// redemption code, promotion, administrator gift) are recorded as credit_grants
// rows with their own validity, while a top-up only credits the paid balance
// that never expires.
const (
	CreditGrantSourceGift    = "gift"
	CreditGrantSourceCheckin = "checkin"
	CreditGrantSourceInvite  = "invite"
	CreditGrantSourceRedeem  = "redeem"
	CreditGrantSourcePromo   = "promo"
	CreditGrantSourceAdmin   = "admin"
)

// CreditGrantMaxExpiryDays bounds one configured validity in days (ten years),
// so a misconfigured option cannot create an expiry outside the supported
// timestamp range.
const CreditGrantMaxExpiryDays = 3650

// creditGrantSourceList is the canonical source order used by validation and
// by administrator-facing listings.
var creditGrantSourceList = []string{
	CreditGrantSourceGift,
	CreditGrantSourceCheckin,
	CreditGrantSourceInvite,
	CreditGrantSourceRedeem,
	CreditGrantSourcePromo,
	CreditGrantSourceAdmin,
}

// CreditGrantSources returns the supported grant sources in display order.
func CreditGrantSources() []string {
	sources := make([]string, len(creditGrantSourceList))
	copy(sources, creditGrantSourceList)
	return sources
}

// IsCreditGrantSource reports whether source is a supported grant source.
func IsCreditGrantSource(source string) bool {
	for _, known := range creditGrantSourceList {
		if source == known {
			return true
		}
	}
	return false
}

// CreditGrantSetting configures how long grant-typed credits stay valid. 0
// means the credit never expires.
type CreditGrantSetting struct {
	// DefaultExpiryDays applies to every source without an override.
	DefaultExpiryDays int `json:"default_expiry_days"`
	// SourceExpiryDays overrides DefaultExpiryDays per source. A source present
	// here uses its own value, including 0 (never expires).
	SourceExpiryDays map[string]int `json:"source_expiry_days"`
}

// 默认配置：赠送额度默认不设有效期，管理员按来源显式开启。
var creditGrantSetting = CreditGrantSetting{
	DefaultExpiryDays: 0,
}

func init() {
	config.GlobalConfig.Register("credit_grant_setting", &creditGrantSetting)
}

func GetCreditGrantSetting() *CreditGrantSetting {
	return &creditGrantSetting
}

// ExpiryDaysFor returns the effective validity of one source in days; 0 means
// the credit never expires. Unknown sources inherit the default.
func (s *CreditGrantSetting) ExpiryDaysFor(source string) int {
	if s == nil {
		return 0
	}
	if days, ok := s.SourceExpiryDays[source]; ok {
		return clampCreditGrantExpiryDays(days)
	}
	return clampCreditGrantExpiryDays(s.DefaultExpiryDays)
}

// ExpiryTimestampFor converts the validity of one source into an absolute
// expiry timestamp; 0 means the credit never expires.
func (s *CreditGrantSetting) ExpiryTimestampFor(source string, now int64) int64 {
	days := s.ExpiryDaysFor(source)
	if days <= 0 {
		return 0
	}
	return now + int64(days)*86400
}

func clampCreditGrantExpiryDays(days int) int {
	if days < 0 {
		return 0
	}
	if days > CreditGrantMaxExpiryDays {
		return CreditGrantMaxExpiryDays
	}
	return days
}

// ValidateCreditGrantOption validates grant validity settings before they are
// persisted. Invalid updates are rejected and the previous configuration keeps
// working.
func ValidateCreditGrantOption(key, value string) error {
	switch key {
	case "credit_grant_setting.default_expiry_days":
		if err := validateCreditGrantExpiryDays(value); err != nil {
			return fmt.Errorf("credit_grant_setting.default_expiry_days %s", err.Error())
		}
	case "credit_grant_setting.source_expiry_days":
		return validateCreditGrantSourceExpiryDays(value)
	}
	return nil
}

// validateCreditGrantExpiryDays accepts one integer number of days within the
// supported validity range.
func validateCreditGrantExpiryDays(value string) error {
	days, err := strconv.Atoi(value)
	if err != nil || days < 0 || days > CreditGrantMaxExpiryDays {
		return fmt.Errorf("must be an integer between 0 and %d", CreditGrantMaxExpiryDays)
	}
	return nil
}

// validateCreditGrantSourceExpiryDays accepts a JSON object of grant source to
// validity in days, rejecting unknown sources and out-of-range values.
func validateCreditGrantSourceExpiryDays(value string) error {
	if value == "" {
		return nil
	}
	overrides := map[string]int{}
	if err := json.Unmarshal([]byte(value), &overrides); err != nil {
		return fmt.Errorf("credit_grant_setting.source_expiry_days must be a JSON object of source to days")
	}
	for source, days := range overrides {
		if !IsCreditGrantSource(source) {
			return fmt.Errorf("credit_grant_setting.source_expiry_days contains unsupported source %s", source)
		}
		if days < 0 || days > CreditGrantMaxExpiryDays {
			return fmt.Errorf("credit grant expiry of source %s must be between 0 and %d days", source, CreditGrantMaxExpiryDays)
		}
	}
	return nil
}
