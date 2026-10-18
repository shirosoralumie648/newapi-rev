package model

import (
	"errors"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"gorm.io/gorm"
)

// Redemption code types: a code either credits wallet quota (the legacy
// default) or grants a subscription plan.
const (
	RedemptionTypeQuota        = "quota"
	RedemptionTypeSubscription = "subscription"
)

// RedemptionDurationMaxYears bounds a subscription duration override so a code
// can never grant an effectively permanent subscription.
const RedemptionDurationMaxYears = 10

var (
	// ErrRedemptionDurationInvalid reports an unknown duration unit, a
	// non-positive value, or stray values without a unit.
	ErrRedemptionDurationInvalid = errors.New("redemption duration override is invalid")
	// ErrRedemptionDurationTooLong reports an override beyond ten years.
	ErrRedemptionDurationTooLong = errors.New("redemption duration override is too long")
	// ErrRedemptionPlanUnavailable reports a code whose subscription plan is
	// missing.
	ErrRedemptionPlanUnavailable = errors.New("redemption subscription plan is unavailable")
)

type Redemption struct {
	Id     int    `json:"id"`
	UserId int    `json:"user_id"`
	Key    string `json:"key" gorm:"type:char(32);uniqueIndex"`
	Status int    `json:"status" gorm:"default:1"`
	Name   string `json:"name" gorm:"index"`
	// Quota carries the wallet credit of a quota code. Subscription codes
	// store 0, so the column has no database default: GORM would rewrite a
	// zero value with it on insert and subscription codes would carry credit.
	Quota int `json:"quota" gorm:"type:bigint"`
	// Type is "quota" (credit Quota) or "subscription" (grant PlanId). Rows
	// created before this column existed read back as empty and are treated
	// as quota codes.
	Type string `json:"type" gorm:"type:varchar(16);default:'quota'"`
	// PlanId is the subscription plan granted by a "subscription" code.
	PlanId int `json:"plan_id" gorm:"index"`
	// Optional duration override for a "subscription" code. An empty unit
	// uses the plan's own duration; otherwise the code grants DurationValue
	// of DurationUnit (or DurationSeconds when the unit is "custom").
	DurationUnit    string         `json:"duration_unit" gorm:"type:varchar(16);default:''"`
	DurationValue   int            `json:"duration_value" gorm:"default:0"`
	DurationSeconds int64          `json:"duration_seconds" gorm:"type:bigint;default:0"`
	CreatedTime     int64          `json:"created_time" gorm:"bigint"`
	RedeemedTime    int64          `json:"redeemed_time" gorm:"bigint"`
	Count           int            `json:"count" gorm:"-:all"` // only for api request
	UsedUserId      int            `json:"used_user_id"`
	DeletedAt       gorm.DeletedAt `gorm:"index"`
	ExpiredTime     int64          `json:"expired_time" gorm:"bigint"` // 过期时间，0 表示不过期
}

// NormalizeRedemptionType maps an empty (legacy) value to the quota type and
// reports whether the value names a supported type.
func NormalizeRedemptionType(redemptionType string) (string, bool) {
	switch strings.TrimSpace(redemptionType) {
	case "", RedemptionTypeQuota:
		return RedemptionTypeQuota, true
	case RedemptionTypeSubscription:
		return RedemptionTypeSubscription, true
	default:
		return "", false
	}
}

// NormalizedType returns the stored type, treating a legacy empty value as a
// quota code.
func (redemption *Redemption) NormalizedType() string {
	if redemption == nil {
		return RedemptionTypeQuota
	}
	if strings.TrimSpace(redemption.Type) == RedemptionTypeSubscription {
		return RedemptionTypeSubscription
	}
	return RedemptionTypeQuota
}

// ValidateRedemptionDuration validates an optional subscription duration
// override. An empty unit means the code uses the plan's own duration and
// carries no value; otherwise the unit must be one of the plan duration units
// with a positive value bounded to ten years.
func ValidateRedemptionDuration(unit string, value int, seconds int64) error {
	maxValue := 0
	switch strings.TrimSpace(unit) {
	case "":
		if value != 0 || seconds != 0 {
			return ErrRedemptionDurationInvalid
		}
		return nil
	case SubscriptionDurationYear:
		maxValue = RedemptionDurationMaxYears
	case SubscriptionDurationMonth:
		maxValue = RedemptionDurationMaxYears * 12
	case SubscriptionDurationDay:
		maxValue = RedemptionDurationMaxYears * 365
	case SubscriptionDurationHour:
		maxValue = RedemptionDurationMaxYears * 365 * 24
	case SubscriptionDurationCustom:
		if seconds < 1 {
			return ErrRedemptionDurationInvalid
		}
		if seconds > int64(RedemptionDurationMaxYears)*365*24*60*60 {
			return ErrRedemptionDurationTooLong
		}
		return nil
	default:
		return ErrRedemptionDurationInvalid
	}
	if value < 1 {
		return ErrRedemptionDurationInvalid
	}
	if value > maxValue {
		return ErrRedemptionDurationTooLong
	}
	return nil
}

// subscriptionPlanWithRedemptionDuration returns a copy of the plan whose
// duration is replaced by the code's optional override.
func subscriptionPlanWithRedemptionDuration(plan *SubscriptionPlan, redemption *Redemption) (*SubscriptionPlan, error) {
	if plan == nil || redemption == nil {
		return nil, ErrRedemptionDurationInvalid
	}
	effective := *plan
	unit := strings.TrimSpace(redemption.DurationUnit)
	if unit == "" {
		return &effective, nil
	}
	if err := ValidateRedemptionDuration(unit, redemption.DurationValue, redemption.DurationSeconds); err != nil {
		return nil, err
	}
	effective.DurationUnit = unit
	if unit == SubscriptionDurationCustom {
		effective.DurationValue = 0
		effective.CustomSeconds = redemption.DurationSeconds
	} else {
		effective.DurationValue = redemption.DurationValue
	}
	return &effective, nil
}

func GetAllRedemptions(startIdx int, num int) (redemptions []*Redemption, total int64, err error) {
	// 开始事务
	tx := DB.Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	// 获取总数
	err = tx.Model(&Redemption{}).Count(&total).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	// 获取分页数据
	err = tx.Order("id desc").Limit(num).Offset(startIdx).Find(&redemptions).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	// 提交事务
	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}

	return redemptions, total, nil
}

func SearchRedemptions(keyword string, status string, redemptionType string, startIdx int, num int) (redemptions []*Redemption, total int64, err error) {
	tx := DB.Begin()
	if tx.Error != nil {
		return nil, 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	query := tx.Model(&Redemption{})

	if keyword != "" {
		if id, err := strconv.Atoi(keyword); err == nil {
			query = query.Where("id = ? OR name LIKE ?", id, keyword+"%")
		} else {
			query = query.Where("name LIKE ?", keyword+"%")
		}
	}

	if status != "" {
		now := common.GetTimestamp()
		switch status {
		case "expired":
			query = query.Where(
				"status = ? AND expired_time != 0 AND expired_time < ?",
				common.RedemptionCodeStatusEnabled,
				now,
			)
		case strconv.Itoa(common.RedemptionCodeStatusEnabled):
			query = query.Where(
				"status = ? AND (expired_time = 0 OR expired_time >= ?)",
				common.RedemptionCodeStatusEnabled,
				now,
			)
		case strconv.Itoa(common.RedemptionCodeStatusDisabled):
			query = query.Where("status = ?", common.RedemptionCodeStatusDisabled)
		case strconv.Itoa(common.RedemptionCodeStatusUsed):
			query = query.Where("status = ?", common.RedemptionCodeStatusUsed)
		}
	}

	if normalized, ok := NormalizeRedemptionType(redemptionType); ok && strings.TrimSpace(redemptionType) != "" {
		if normalized == RedemptionTypeQuota {
			// Legacy rows predate the type column and carry no value.
			query = query.Where("type = ? OR type = '' OR type IS NULL", RedemptionTypeQuota)
		} else {
			query = query.Where("type = ?", normalized)
		}
	}

	// Get total count
	err = query.Count(&total).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	// Get paginated data
	err = query.Order("id desc").Limit(num).Offset(startIdx).Find(&redemptions).Error
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}

	if err = tx.Commit().Error; err != nil {
		return nil, 0, err
	}

	return redemptions, total, nil
}

func GetRedemptionById(id int) (*Redemption, error) {
	if id == 0 {
		return nil, common.NewMessage("ID is empty")
	}
	redemption := Redemption{Id: id}
	var err error = nil
	err = DB.First(&redemption, "id = ?", id).Error
	return &redemption, err
}

// RedeemResult describes what a successful redemption granted.
type RedeemResult struct {
	Type           string `json:"type"`
	Quota          int    `json:"quota"`
	PlanId         int    `json:"plan_id"`
	PlanTitle      string `json:"plan_title"`
	SubscriptionId int    `json:"subscription_id"`
	EndTime        int64  `json:"end_time"`
}

func Redeem(key string, userId int) (*RedeemResult, error) {
	if key == "" {
		return nil, errors.New("redemption code not provided")
	}
	if userId == 0 {
		return nil, errors.New("invalid user id")
	}
	redemption := &Redemption{}

	keyCol := "`key`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		keyCol = `"key"`
	}
	common.RandomSleep()
	var result *RedeemResult
	groupUpgraded := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		err := lockForUpdate(tx).Where(keyCol+" = ?", key).First(redemption).Error
		if err != nil {
			return errors.New("invalid redemption code")
		}
		if redemption.Status != common.RedemptionCodeStatusEnabled {
			return errors.New("redemption code already used")
		}
		if redemption.ExpiredTime != 0 && redemption.ExpiredTime < common.GetTimestamp() {
			return errors.New("redemption code expired")
		}
		// Compare-and-swap on status: only the transaction that flips
		// enabled -> used may credit quota, so a concurrent redeem of the
		// same code loses here even without a row lock (e.g. on SQLite).
		claim := tx.Model(&Redemption{}).
			Where("id = ? AND status = ?", redemption.Id, common.RedemptionCodeStatusEnabled).
			Updates(map[string]any{
				"redeemed_time": common.GetTimestamp(),
				"status":        common.RedemptionCodeStatusUsed,
				"used_user_id":  userId,
			})
		if claim.Error != nil {
			return claim.Error
		}
		if claim.RowsAffected == 0 {
			return errors.New("redemption code already used")
		}
		switch redemption.NormalizedType() {
		case RedemptionTypeSubscription:
			// Lock the user row first so the per-plan purchase limit check
			// serializes per user, exactly like paid and admin subscriptions.
			var userRow User
			if err := lockForUpdate(tx).Select("id").Where("id = ?", userId).First(&userRow).Error; err != nil {
				return err
			}
			plan, err := getSubscriptionPlanByIdTx(tx, redemption.PlanId)
			if err != nil {
				return ErrRedemptionPlanUnavailable
			}
			effectivePlan, err := subscriptionPlanWithRedemptionDuration(plan, redemption)
			if err != nil {
				return err
			}
			subscription, err := CreateUserSubscriptionFromPlanTx(tx, userId, effectivePlan, SubscriptionSourceRedemption)
			if err != nil {
				return err
			}
			groupUpgraded = subscription.PrevUserGroup != ""
			result = &RedeemResult{
				Type:           RedemptionTypeSubscription,
				PlanId:         plan.Id,
				PlanTitle:      plan.Title,
				SubscriptionId: subscription.Id,
				EndTime:        subscription.EndTime,
			}
		default:
			if redemption.Quota <= 0 {
				return errors.New("invalid redemption code")
			}
			// 兑换码额度进入 redeem 桶，按配置的兑换码额度有效期生效。
			source := operation_setting.CreditGrantSourceRedeem
			expiresAt := operation_setting.GetCreditGrantSetting().ExpiryTimestampFor(source, common.GetTimestamp())
			if _, _, err := IssueCreditGrantTx(tx, userId, source, redemption.Quota, expiresAt, WalletLedgerKindRedeem, WalletLedgerRefRedeem, strconv.Itoa(redemption.Id), ""); err != nil {
				return err
			}
			// A redemption code commissions the inviter only when the
			// administrator turned the switch on (the upstream #5829
			// dispute); the event is keyed by the code and written in the
			// same transaction as the credit.
			if _, err := RecordReferralCommissionTx(tx, userId, ReferralCommissionSourceRedeem, int64(redemption.Quota), WalletLedgerRefRedeem, strconv.Itoa(redemption.Id)); err != nil {
				return err
			}
			result = &RedeemResult{Type: RedemptionTypeQuota, Quota: redemption.Quota}
		}
		return nil
	})
	if err != nil {
		common.SysError(common.LogText("redemption failed: %s", err.Error()))
		return nil, ErrRedeemFailed
	}
	if result.Type == RedemptionTypeSubscription {
		// A subscription grant does not move the wallet balance, so it writes
		// no wallet ledger row (the ledger identity is sum(entries) = balance);
		// the subscription row and the top-up log below are its audit trail.
		if groupUpgraded {
			refreshSubscriptionUserGroupCache(userId, common.LogText("redemption subscription"))
		}
		RecordLog(userId, LogTypeTopup, common.NewMessage("Subscription redeemed with a redemption code, plan: {{plan}}, code ID {{id}}", map[string]any{"plan": result.PlanTitle, "id": redemption.Id}))
		return result, nil
	}
	syncCreditUserQuotaCache(userId, redemption.Quota, common.LogText("redemption"))
	RecordLog(userId, LogTypeTopup, common.NewMessage("Topped up {{quota}} with a redemption code, code ID {{id}}", map[string]any{"quota": logger.FormatQuota(redemption.Quota), "id": redemption.Id}))
	return result, nil
}

// validatePayload normalizes and validates the fields shared by create and
// update. It mutates the redemption in place so stored rows never carry a
// mismatched type and payload.
func (redemption *Redemption) validatePayload() error {
	redemptionType, ok := NormalizeRedemptionType(redemption.Type)
	if !ok {
		return errors.New("invalid redemption code type")
	}
	redemption.Type = redemptionType
	if redemptionType == RedemptionTypeSubscription {
		if redemption.PlanId <= 0 {
			return errors.New("redemption code requires a subscription plan")
		}
		if _, err := GetSubscriptionPlanById(redemption.PlanId); err != nil {
			return ErrRedemptionPlanUnavailable
		}
		redemption.Quota = 0
		redemption.DurationUnit = strings.TrimSpace(redemption.DurationUnit)
		return ValidateRedemptionDuration(redemption.DurationUnit, redemption.DurationValue, redemption.DurationSeconds)
	}
	if redemption.Quota <= 0 {
		return errors.New("redemption quota must be positive")
	}
	if err := common.ValidateWalletQuota(redemption.Quota); err != nil {
		return err
	}
	redemption.PlanId = 0
	redemption.DurationUnit = ""
	redemption.DurationValue = 0
	redemption.DurationSeconds = 0
	return nil
}

func (redemption *Redemption) Insert() error {
	if err := redemption.validatePayload(); err != nil {
		return err
	}
	return DB.Create(redemption).Error
}

func (redemption *Redemption) SelectUpdate() error {
	// This can update zero values
	return DB.Model(redemption).Select("redeemed_time", "status").Updates(redemption).Error
}

// Update Make sure your token's fields is completed, because this will update non-zero values
func (redemption *Redemption) Update() error {
	if err := redemption.validatePayload(); err != nil {
		return err
	}
	return DB.Model(redemption).Select("name", "status", "quota", "type", "plan_id", "duration_unit", "duration_value", "duration_seconds", "redeemed_time", "expired_time").Updates(redemption).Error
}

func (redemption *Redemption) Delete() error {
	var err error
	err = DB.Delete(redemption).Error
	return err
}

func DeleteRedemptionById(id int) (err error) {
	if id == 0 {
		return common.NewMessage("ID is empty")
	}
	redemption := Redemption{Id: id}
	err = DB.Where(redemption).First(&redemption).Error
	if err != nil {
		return err
	}
	return redemption.Delete()
}

func DeleteInvalidRedemptions() (int64, error) {
	now := common.GetTimestamp()
	result := DB.Where("status IN ? OR (status = ? AND expired_time != 0 AND expired_time < ?)", []int{common.RedemptionCodeStatusUsed, common.RedemptionCodeStatusDisabled}, common.RedemptionCodeStatusEnabled, now).Delete(&Redemption{})
	return result.RowsAffected, result.Error
}

// BatchDeleteRedemptions soft-deletes the selected codes in one statement.
func BatchDeleteRedemptions(ids []int) (int64, error) {
	if len(ids) == 0 || len(ids) > 1000 {
		return 0, errors.New("select between 1 and 1000 redemption codes")
	}
	for _, id := range ids {
		if id <= 0 {
			return 0, errors.New("redemption IDs must be positive")
		}
	}
	result := DB.Where("id IN ?", ids).Delete(&Redemption{})
	return result.RowsAffected, result.Error
}
