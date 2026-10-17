package operation_setting

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"

	"github.com/shopspring/decimal"
)

// OverdraftLimitMaxUSD is the largest configurable overdraft credit line. It is
// the wallet quota bound converted back to USD, so a configured limit can never
// saturate the wallet conversion.
func OverdraftLimitMaxUSD() float64 {
	return float64(common.MaxWalletQuota) / common.QuotaPerUnit
}

type QuotaSetting struct {
	EnableFreeModelPreConsume bool    `json:"enable_free_model_pre_consume"` // 是否对免费模型启用预消耗
	TrustQuotaUSD             float64 `json:"trust_quota_usd"`               // 钱包免预扣门槛，0 表示禁用
	PreConsumeMultiplier      float64 `json:"pre_consume_multiplier"`        // 预计输入费用的预扣倍率，仅影响预留
	// OverdraftLimitUSD is the default wallet overdraft credit line in USD: how
	// far the balance may go below zero before the excess becomes debt. 0 means
	// the wallet may not go below zero.
	OverdraftLimitUSD float64 `json:"overdraft_limit_usd"`
	// OverdraftGroupOverrides replaces OverdraftLimitUSD for one user group; a
	// missing group inherits the default. A present override of 0 denies that
	// group any overdraft.
	OverdraftGroupOverrides map[string]float64 `json:"overdraft_group_overrides"`
}

// 默认配置
var quotaSetting = QuotaSetting{
	EnableFreeModelPreConsume: true,
	TrustQuotaUSD:             10,
	PreConsumeMultiplier:      1,
	OverdraftLimitUSD:         0,
}

func init() {
	// 注册到全局配置管理器
	config.GlobalConfig.Register("quota_setting", &quotaSetting)
}

func GetQuotaSetting() *QuotaSetting {
	return &quotaSetting
}

// OverdraftLimitQuota resolves the effective overdraft credit line of one user
// group in quota units: the group override when configured, otherwise the
// global default. Missing, non-finite or negative values resolve to zero, so a
// misconfigured option can never hand out unbounded credit.
func (s *QuotaSetting) OverdraftLimitQuota(group string) int64 {
	usd := s.OverdraftLimitUSD
	if override, ok := s.OverdraftGroupOverrides[group]; ok && group != "" {
		usd = override
	}
	return overdraftLimitQuotaFromUSD(usd)
}

// overdraftLimitQuotaFromUSD converts a USD credit line to quota with the
// shared wallet bound and audits a saturated configuration once per conversion.
func overdraftLimitQuotaFromUSD(usd float64) int64 {
	if usd <= 0 || math.IsNaN(usd) || math.IsInf(usd, 0) {
		return 0
	}
	if maxUSD := OverdraftLimitMaxUSD(); maxUSD > 0 && usd > maxUSD {
		common.SysError(common.LogText("wallet overdraft limit %v USD exceeds the wallet bound, using %v USD", usd, maxUSD))
		usd = maxUSD
	}
	quota, err := common.WalletQuotaFromDecimalStrict(
		decimal.NewFromFloat(usd).Mul(decimal.NewFromFloat(common.QuotaPerUnit)),
	)
	if err != nil {
		common.SysError(common.LogText("invalid wallet overdraft limit %v USD: %s", usd, err.Error()))
		return 0
	}
	return int64(quota)
}

// ValidateQuotaOption validates reservation settings before they are persisted.
func ValidateQuotaOption(key, value string) error {
	if key == "quota_setting.overdraft_group_overrides" {
		return validateOverdraftGroupOverrides(value)
	}
	if key != "quota_setting.trust_quota_usd" &&
		key != "quota_setting.pre_consume_multiplier" &&
		key != "quota_setting.overdraft_limit_usd" {
		return nil
	}
	number, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return fmt.Errorf("%s must be a finite non-negative number", key)
	}
	if key == "quota_setting.pre_consume_multiplier" && number == 0 {
		return fmt.Errorf("%s must be greater than zero", key)
	}
	if key == "quota_setting.overdraft_limit_usd" && number > OverdraftLimitMaxUSD() {
		return fmt.Errorf("%s must not exceed %v", key, OverdraftLimitMaxUSD())
	}
	return nil
}

// validateOverdraftGroupOverrides accepts a JSON object of user group to USD
// credit line and rejects unknown shapes, negative or oversized values.
func validateOverdraftGroupOverrides(value string) error {
	if value == "" {
		return nil
	}
	overrides := map[string]float64{}
	if err := json.Unmarshal([]byte(value), &overrides); err != nil {
		return fmt.Errorf("quota_setting.overdraft_group_overrides must be a JSON object of group to USD amounts")
	}
	for group, usd := range overrides {
		if group == "" {
			return fmt.Errorf("quota_setting.overdraft_group_overrides must not contain an empty group")
		}
		if math.IsNaN(usd) || math.IsInf(usd, 0) || usd < 0 {
			return fmt.Errorf("overdraft limit of group %s must be a finite non-negative number", group)
		}
		if usd > OverdraftLimitMaxUSD() {
			return fmt.Errorf("overdraft limit of group %s must not exceed %v", group, OverdraftLimitMaxUSD())
		}
	}
	return nil
}

// InputPreConsumeMultiplier rejects invalid runtime settings as well as invalid saves.
func InputPreConsumeMultiplier() (float64, error) {
	multiplier := quotaSetting.PreConsumeMultiplier
	if multiplier <= 0 || math.IsNaN(multiplier) || math.IsInf(multiplier, 0) {
		return 0, fmt.Errorf("pre-consume multiplier must be a finite number greater than zero")
	}
	return multiplier, nil
}
