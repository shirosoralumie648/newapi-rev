package model

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/cachex"
	"github.com/QuantumNous/new-api/setting/group_setting"
	"github.com/bytedance/gopkg/util/gopool"
	"github.com/samber/hot"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Subscription duration units
const (
	SubscriptionDurationYear   = "year"
	SubscriptionDurationMonth  = "month"
	SubscriptionDurationDay    = "day"
	SubscriptionDurationHour   = "hour"
	SubscriptionDurationCustom = "custom"
)

// Subscription quota reset period
const (
	SubscriptionResetNever   = "never"
	SubscriptionResetDaily   = "daily"
	SubscriptionResetWeekly  = "weekly"
	SubscriptionResetMonthly = "monthly"
	SubscriptionResetCustom  = "custom"
)

// Subscription quota window kinds. A plan may cap usage per calendar hour,
// day, week, and month in addition to its total quota; an exhausted window
// stops the subscription from funding further requests until the window rolls.
const (
	SubscriptionWindowHour  = "hour"
	SubscriptionWindowDay   = "day"
	SubscriptionWindowWeek  = "week"
	SubscriptionWindowMonth = "month"
)

// SubscriptionSourceRedemption marks a subscription granted by redeeming a
// redemption code.
const SubscriptionSourceRedemption = "redemption"

var (
	ErrSubscriptionOrderNotFound      = errors.New("subscription order not found")
	ErrSubscriptionOrderStatusInvalid = errors.New("subscription order status invalid")
	// ErrNoActiveSubscription reports that the user has no active subscription
	// at all; the caller may fall back to the wallet according to the user's
	// billing preference.
	ErrNoActiveSubscription = errors.New("no active subscription")
	// ErrSubscriptionIneligible reports that the user's active subscriptions do
	// not cover the request's group or model, so none of them may fund it.
	ErrSubscriptionIneligible = errors.New("no active subscription covers the request group or model")
	// ErrSubscriptionQuotaInsufficient reports that every eligible active
	// subscription is out of quota: the total or one of the plan's quota
	// windows cannot cover the pre-consume amount.
	ErrSubscriptionQuotaInsufficient = errors.New("subscription quota insufficient")
)

const (
	subscriptionPlanCacheNamespace     = "new-api:subscription_plan:v1"
	subscriptionPlanInfoCacheNamespace = "new-api:subscription_plan_info:v1"
)

var (
	subscriptionPlanCacheOnce     sync.Once
	subscriptionPlanInfoCacheOnce sync.Once

	subscriptionPlanCache     *cachex.HybridCache[SubscriptionPlan]
	subscriptionPlanInfoCache *cachex.HybridCache[SubscriptionPlanInfo]
)

func subscriptionPlanCacheTTL() time.Duration {
	ttlSeconds := common.GetEnvOrDefault("SUBSCRIPTION_PLAN_CACHE_TTL", 300)
	if ttlSeconds <= 0 {
		ttlSeconds = 300
	}
	return time.Duration(ttlSeconds) * time.Second
}

func subscriptionPlanInfoCacheTTL() time.Duration {
	ttlSeconds := common.GetEnvOrDefault("SUBSCRIPTION_PLAN_INFO_CACHE_TTL", 120)
	if ttlSeconds <= 0 {
		ttlSeconds = 120
	}
	return time.Duration(ttlSeconds) * time.Second
}

func subscriptionPlanCacheCapacity() int {
	capacity := common.GetEnvOrDefault("SUBSCRIPTION_PLAN_CACHE_CAP", 5000)
	if capacity <= 0 {
		capacity = 5000
	}
	return capacity
}

func subscriptionPlanInfoCacheCapacity() int {
	capacity := common.GetEnvOrDefault("SUBSCRIPTION_PLAN_INFO_CACHE_CAP", 10000)
	if capacity <= 0 {
		capacity = 10000
	}
	return capacity
}

func getSubscriptionPlanCache() *cachex.HybridCache[SubscriptionPlan] {
	subscriptionPlanCacheOnce.Do(func() {
		ttl := subscriptionPlanCacheTTL()
		subscriptionPlanCache = cachex.NewHybridCache[SubscriptionPlan](cachex.HybridCacheConfig[SubscriptionPlan]{
			Namespace: cachex.Namespace(subscriptionPlanCacheNamespace),
			Redis:     common.RDB,
			RedisEnabled: func() bool {
				return common.RedisEnabled && common.RDB != nil
			},
			RedisCodec: cachex.JSONCodec[SubscriptionPlan]{},
			Memory: func() *hot.HotCache[string, SubscriptionPlan] {
				return hot.NewHotCache[string, SubscriptionPlan](hot.LRU, subscriptionPlanCacheCapacity()).
					WithTTL(ttl).
					WithJanitor().
					Build()
			},
		})
	})
	return subscriptionPlanCache
}

func getSubscriptionPlanInfoCache() *cachex.HybridCache[SubscriptionPlanInfo] {
	subscriptionPlanInfoCacheOnce.Do(func() {
		ttl := subscriptionPlanInfoCacheTTL()
		subscriptionPlanInfoCache = cachex.NewHybridCache[SubscriptionPlanInfo](cachex.HybridCacheConfig[SubscriptionPlanInfo]{
			Namespace: cachex.Namespace(subscriptionPlanInfoCacheNamespace),
			Redis:     common.RDB,
			RedisEnabled: func() bool {
				return common.RedisEnabled && common.RDB != nil
			},
			RedisCodec: cachex.JSONCodec[SubscriptionPlanInfo]{},
			Memory: func() *hot.HotCache[string, SubscriptionPlanInfo] {
				return hot.NewHotCache[string, SubscriptionPlanInfo](hot.LRU, subscriptionPlanInfoCacheCapacity()).
					WithTTL(ttl).
					WithJanitor().
					Build()
			},
		})
	})
	return subscriptionPlanInfoCache
}

func subscriptionPlanCacheKey(id int) string {
	if id <= 0 {
		return ""
	}
	return strconv.Itoa(id)
}

func InvalidateSubscriptionPlanCache(planId int) {
	if planId <= 0 {
		return
	}
	cache := getSubscriptionPlanCache()
	_, _ = cache.DeleteMany([]string{subscriptionPlanCacheKey(planId)})
	infoCache := getSubscriptionPlanInfoCache()
	_ = infoCache.Purge()
}

// Subscription plan
type SubscriptionPlan struct {
	Id int `json:"id"`

	Title    string `json:"title" gorm:"type:varchar(128);not null"`
	Subtitle string `json:"subtitle" gorm:"type:varchar(255);default:''"`

	// Display money amount (follow existing code style: float64 for money)
	PriceAmount float64 `json:"price_amount" gorm:"type:decimal(10,6);not null;default:0"`
	Currency    string  `json:"currency" gorm:"type:varchar(8);not null;default:'USD'"`

	DurationUnit  string `json:"duration_unit" gorm:"type:varchar(16);not null;default:'month'"`
	DurationValue int    `json:"duration_value" gorm:"type:int;not null;default:1"`
	CustomSeconds int64  `json:"custom_seconds" gorm:"type:bigint;not null;default:0"`

	Enabled   bool `json:"enabled" gorm:"default:true"`
	SortOrder int  `json:"sort_order" gorm:"type:int;default:0"`

	AllowBalancePay *bool `json:"allow_balance_pay"`

	// Allow falling back to wallet balance after subscription quota is exhausted (empty = true)
	AllowWalletOverflow *bool `json:"allow_wallet_overflow"`

	StripePriceId         string `json:"stripe_price_id" gorm:"type:varchar(128);default:''"`
	CreemProductId        string `json:"creem_product_id" gorm:"type:varchar(128);default:''"`
	WaffoPancakeProductId string `json:"waffo_pancake_product_id" gorm:"type:varchar(128);default:''"`

	// Max purchases per user (0 = unlimited)
	MaxPurchasePerUser int `json:"max_purchase_per_user" gorm:"type:int;default:0"`

	// Upgrade user group after purchase (empty = no change)
	UpgradeGroup string `json:"upgrade_group" gorm:"type:varchar(64);default:''"`

	// Downgrade user group on expiry (empty = revert to the group held before purchase)
	DowngradeGroup string `json:"downgrade_group" gorm:"type:varchar(64);default:''"`

	// Groups allowed to consume this plan's quota (comma-separated stable group
	// identifiers; empty = every group)
	AllowedGroups string `json:"allowed_groups" gorm:"type:text"`

	// Models allowed to consume this plan's quota (comma-separated model names;
	// one trailing * matches a prefix; empty = every model)
	AllowedModels string `json:"allowed_models" gorm:"type:text"`

	// Total quota (amount in quota units, 0 = unlimited)
	TotalAmount int64 `json:"total_amount" gorm:"type:bigint;not null;default:0"`

	// Quota reset period for plan
	QuotaResetPeriod        string `json:"quota_reset_period" gorm:"type:varchar(16);default:'never'"`
	QuotaResetCustomSeconds int64  `json:"quota_reset_custom_seconds" gorm:"type:bigint;default:0"`

	// Additional calendar-window quotas in quota units (0 = unlimited). The
	// hour window starts on the hour, the day window at midnight, the week
	// window on Monday, and the month window on the first day, all in the
	// server's local time (the same boundaries as quota reset periods).
	QuotaWindowHour  int64 `json:"quota_window_hour" gorm:"type:bigint;not null;default:0"`
	QuotaWindowDay   int64 `json:"quota_window_day" gorm:"type:bigint;not null;default:0"`
	QuotaWindowWeek  int64 `json:"quota_window_week" gorm:"type:bigint;not null;default:0"`
	QuotaWindowMonth int64 `json:"quota_window_month" gorm:"type:bigint;not null;default:0"`

	CreatedAt int64 `json:"created_at" gorm:"bigint"`
	UpdatedAt int64 `json:"updated_at" gorm:"bigint"`
}

func (p *SubscriptionPlan) BeforeCreate(tx *gorm.DB) error {
	now := common.GetTimestamp()
	p.CreatedAt = now
	p.UpdatedAt = now
	return nil
}

func (p *SubscriptionPlan) BeforeUpdate(tx *gorm.DB) error {
	p.UpdatedAt = common.GetTimestamp()
	return nil
}

func (p *SubscriptionPlan) NormalizeDefaults() {
	if p.AllowBalancePay == nil {
		p.AllowBalancePay = common.GetPointer(true)
	}
	if p.AllowWalletOverflow == nil {
		p.AllowWalletOverflow = common.GetPointer(true)
	}
}

// Subscription order (payment -> webhook -> create UserSubscription)
type SubscriptionOrder struct {
	Id     int     `json:"id"`
	UserId int     `json:"user_id" gorm:"index"`
	PlanId int     `json:"plan_id" gorm:"index"`
	Money  float64 `json:"money"`

	TradeNo         string `json:"trade_no" gorm:"unique;type:varchar(255);index"`
	PaymentMethod   string `json:"payment_method" gorm:"type:varchar(50)"`
	PaymentProvider string `json:"payment_provider" gorm:"type:varchar(50);default:''"`
	Status          string `json:"status"`
	CreateTime      int64  `json:"create_time"`
	CompleteTime    int64  `json:"complete_time"`

	ProviderPayload string `json:"provider_payload" gorm:"type:text"`
}

func (o *SubscriptionOrder) Insert() error {
	if o.CreateTime == 0 {
		o.CreateTime = common.GetTimestamp()
	}
	return DB.Create(o).Error
}

func (o *SubscriptionOrder) Update() error {
	return DB.Save(o).Error
}

func GetSubscriptionOrderByTradeNo(tradeNo string) *SubscriptionOrder {
	if tradeNo == "" {
		return nil
	}
	var order SubscriptionOrder
	if err := DB.Where("trade_no = ?", tradeNo).First(&order).Error; err != nil {
		return nil
	}
	return &order
}

// User subscription instance
type UserSubscription struct {
	Id     int `json:"id"`
	UserId int `json:"user_id" gorm:"index;index:idx_user_sub_active,priority:1"`
	PlanId int `json:"plan_id" gorm:"index"`

	AmountTotal int64 `json:"amount_total" gorm:"type:bigint;not null;default:0"`
	AmountUsed  int64 `json:"amount_used" gorm:"type:bigint;not null;default:0"`

	StartTime int64  `json:"start_time" gorm:"bigint"`
	EndTime   int64  `json:"end_time" gorm:"bigint;index;index:idx_user_sub_active,priority:3"`
	Status    string `json:"status" gorm:"type:varchar(32);index;index:idx_user_sub_active,priority:2"` // active/expired/cancelled

	Source string `json:"source" gorm:"type:varchar(32);default:'order'"` // order/admin

	LastResetTime int64 `json:"last_reset_time" gorm:"type:bigint;default:0"`
	NextResetTime int64 `json:"next_reset_time" gorm:"type:bigint;default:0;index"`

	UpgradeGroup  string `json:"upgrade_group" gorm:"type:varchar(64);default:''"`
	PrevUserGroup string `json:"prev_user_group" gorm:"type:varchar(64);default:''"`

	// Downgrade target group on expiry (snapshot from plan; empty = revert to PrevUserGroup)
	DowngradeGroup string `json:"downgrade_group" gorm:"type:varchar(64);default:''"`

	// Whether wallet fallback is allowed after this subscription's quota is exhausted (snapshot from plan)
	AllowWalletOverflow bool `json:"allow_wallet_overflow"`

	CreatedAt int64 `json:"created_at" gorm:"bigint"`
	UpdatedAt int64 `json:"updated_at" gorm:"bigint"`
}

func (s *UserSubscription) BeforeCreate(tx *gorm.DB) error {
	now := common.GetTimestamp()
	s.CreatedAt = now
	s.UpdatedAt = now
	return nil
}

func (s *UserSubscription) BeforeUpdate(tx *gorm.DB) error {
	s.UpdatedAt = common.GetTimestamp()
	return nil
}

type SubscriptionSummary struct {
	Subscription *UserSubscription `json:"subscription"`
}

type SubscriptionResetResult struct {
	PlanId           int    `json:"plan_id"`
	MatchedCount     int    `json:"matched_count"`
	ResetCount       int    `json:"reset_count"`
	UserCount        int    `json:"user_count"`
	AdvanceResetTime bool   `json:"advance_reset_time"`
	PlanTitle        string `json:"-"`
	AffectedUserIds  []int  `json:"-"`
}

func calcPlanEndTime(start time.Time, plan *SubscriptionPlan) (int64, error) {
	if plan == nil {
		return 0, errors.New("plan is nil")
	}
	if plan.DurationValue <= 0 && plan.DurationUnit != SubscriptionDurationCustom {
		return 0, errors.New("duration_value must be > 0")
	}
	switch plan.DurationUnit {
	case SubscriptionDurationYear:
		return start.AddDate(plan.DurationValue, 0, 0).Unix(), nil
	case SubscriptionDurationMonth:
		return start.AddDate(0, plan.DurationValue, 0).Unix(), nil
	case SubscriptionDurationDay:
		return start.Add(time.Duration(plan.DurationValue) * 24 * time.Hour).Unix(), nil
	case SubscriptionDurationHour:
		return start.Add(time.Duration(plan.DurationValue) * time.Hour).Unix(), nil
	case SubscriptionDurationCustom:
		if plan.CustomSeconds <= 0 {
			return 0, errors.New("custom_seconds must be > 0")
		}
		return start.Add(time.Duration(plan.CustomSeconds) * time.Second).Unix(), nil
	default:
		return 0, fmt.Errorf("invalid duration_unit: %s", plan.DurationUnit)
	}
}

func NormalizeResetPeriod(period string) string {
	switch strings.TrimSpace(period) {
	case SubscriptionResetDaily, SubscriptionResetWeekly, SubscriptionResetMonthly, SubscriptionResetCustom:
		return strings.TrimSpace(period)
	default:
		return SubscriptionResetNever
	}
}

func calcNextResetTime(base time.Time, plan *SubscriptionPlan, endUnix int64) int64 {
	if plan == nil {
		return 0
	}
	period := NormalizeResetPeriod(plan.QuotaResetPeriod)
	if period == SubscriptionResetNever {
		return 0
	}
	var next time.Time
	switch period {
	case SubscriptionResetDaily:
		next = time.Date(base.Year(), base.Month(), base.Day(), 0, 0, 0, 0, base.Location()).
			AddDate(0, 0, 1)
	case SubscriptionResetWeekly:
		// Align to next Monday 00:00
		weekday := int(base.Weekday()) // Sunday=0
		// Convert to Monday=1..Sunday=7
		if weekday == 0 {
			weekday = 7
		}
		daysUntil := 8 - weekday
		next = time.Date(base.Year(), base.Month(), base.Day(), 0, 0, 0, 0, base.Location()).
			AddDate(0, 0, daysUntil)
	case SubscriptionResetMonthly:
		// Align to first day of next month 00:00
		next = time.Date(base.Year(), base.Month(), 1, 0, 0, 0, 0, base.Location()).
			AddDate(0, 1, 0)
	case SubscriptionResetCustom:
		if plan.QuotaResetCustomSeconds <= 0 {
			return 0
		}
		next = base.Add(time.Duration(plan.QuotaResetCustomSeconds) * time.Second)
	default:
		return 0
	}
	if endUnix > 0 && next.Unix() > endUnix {
		return 0
	}
	return next.Unix()
}

func GetSubscriptionPlanById(id int) (*SubscriptionPlan, error) {
	return getSubscriptionPlanByIdTx(nil, id)
}

func getSubscriptionPlanByIdTx(tx *gorm.DB, id int) (*SubscriptionPlan, error) {
	if id <= 0 {
		return nil, errors.New("invalid plan id")
	}
	key := subscriptionPlanCacheKey(id)
	if key != "" {
		if cached, found, err := getSubscriptionPlanCache().Get(key); err == nil && found {
			cached.NormalizeDefaults()
			return &cached, nil
		}
	}
	var plan SubscriptionPlan
	query := DB
	if tx != nil {
		query = tx
	}
	if err := query.Where("id = ?", id).First(&plan).Error; err != nil {
		return nil, err
	}
	plan.NormalizeDefaults()
	_ = getSubscriptionPlanCache().SetWithTTL(key, plan, subscriptionPlanCacheTTL())
	return &plan, nil
}

func CountUserSubscriptionsByPlan(userId int, planId int) (int64, error) {
	if userId <= 0 || planId <= 0 {
		return 0, errors.New("invalid userId or planId")
	}
	var count int64
	if err := DB.Model(&UserSubscription{}).
		Where("user_id = ? AND plan_id = ?", userId, planId).
		Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

func getUserGroupByIdTx(tx *gorm.DB, userId int) (string, error) {
	if userId <= 0 {
		return "", errors.New("invalid userId")
	}
	if tx == nil {
		tx = DB
	}
	var group string
	if err := lockForUpdate(tx).Model(&User{}).Where("id = ?", userId).Select("group").Find(&group).Error; err != nil {
		return "", err
	}
	return group, nil
}

func downgradeUserGroupForSubscriptionTx(tx *gorm.DB, sub *UserSubscription, now int64) (string, error) {
	if tx == nil || sub == nil {
		return "", errors.New("invalid downgrade args")
	}
	// Stored references may predate a display-name change; resolve them to the
	// stable identifier before comparing or applying.
	downgradeGroup := group_setting.ResolveGroupID(sub.DowngradeGroup)
	upgradeGroup := group_setting.ResolveGroupID(sub.UpgradeGroup)
	// Nothing to do if neither an explicit downgrade target nor an upgrade snapshot exists.
	if downgradeGroup == "" && upgradeGroup == "" {
		return "", nil
	}
	currentGroup, err := getUserGroupByIdTx(tx, sub.UserId)
	if err != nil {
		return "", err
	}
	// If another active upgraded subscription exists, keep the current group.
	var activeSub UserSubscription
	activeQuery := tx.Where("user_id = ? AND status = ? AND end_time > ? AND id <> ? AND upgrade_group <> ''",
		sub.UserId, "active", now, sub.Id).
		Order("end_time desc, id desc").
		Limit(1).
		Find(&activeSub)
	if activeQuery.Error == nil && activeQuery.RowsAffected > 0 {
		return "", nil
	}
	// Determine the downgrade target: an explicit downgrade group takes precedence,
	// otherwise revert to the group held before purchase (legacy behavior).
	target := downgradeGroup
	if target == "" {
		// Legacy behavior: only revert when the subscription actually elevated the user.
		if currentGroup != upgradeGroup {
			return "", nil
		}
		target = group_setting.ResolveGroupID(sub.PrevUserGroup)
	}
	if target == "" || target == currentGroup {
		return "", nil
	}
	if err := tx.Model(&User{}).Where("id = ?", sub.UserId).
		Update("group", target).Error; err != nil {
		return "", err
	}
	return target, nil
}

func CreateUserSubscriptionFromPlanTx(tx *gorm.DB, userId int, plan *SubscriptionPlan, source string) (*UserSubscription, error) {
	if tx == nil {
		return nil, errors.New("tx is nil")
	}
	if plan == nil || plan.Id == 0 {
		return nil, errors.New("invalid plan")
	}
	if userId <= 0 {
		return nil, errors.New("invalid user id")
	}
	if plan.MaxPurchasePerUser > 0 {
		var count int64
		if err := tx.Model(&UserSubscription{}).
			Where("user_id = ? AND plan_id = ?", userId, plan.Id).
			Count(&count).Error; err != nil {
			return nil, err
		}
		if count >= int64(plan.MaxPurchasePerUser) {
			return nil, common.NewMessage("Purchase limit for this plan has been reached")
		}
	}
	nowUnix := GetDBTimestampTx(tx)
	now := time.Unix(nowUnix, 0)
	endUnix, err := calcPlanEndTime(now, plan)
	if err != nil {
		return nil, err
	}
	resetBase := now
	nextReset := calcNextResetTime(resetBase, plan, endUnix)
	lastReset := int64(0)
	if nextReset > 0 {
		lastReset = now.Unix()
	}
	upgradeGroup := group_setting.ResolveGroupID(plan.UpgradeGroup)
	prevGroup := ""
	if upgradeGroup != "" {
		currentGroup, err := getUserGroupByIdTx(tx, userId)
		if err != nil {
			return nil, err
		}
		if currentGroup != upgradeGroup {
			prevGroup = currentGroup
			if err := tx.Model(&User{}).Where("id = ?", userId).
				Update("group", upgradeGroup).Error; err != nil {
				return nil, err
			}
		}
	}
	allowWalletOverflow := true
	if plan.AllowWalletOverflow != nil {
		allowWalletOverflow = *plan.AllowWalletOverflow
	}
	sub := &UserSubscription{
		UserId:              userId,
		PlanId:              plan.Id,
		AmountTotal:         plan.TotalAmount,
		AmountUsed:          0,
		StartTime:           now.Unix(),
		EndTime:             endUnix,
		Status:              "active",
		Source:              source,
		LastResetTime:       lastReset,
		NextResetTime:       nextReset,
		UpgradeGroup:        upgradeGroup,
		PrevUserGroup:       prevGroup,
		DowngradeGroup:      group_setting.ResolveGroupID(plan.DowngradeGroup),
		AllowWalletOverflow: allowWalletOverflow,
		CreatedAt:           common.GetTimestamp(),
		UpdatedAt:           common.GetTimestamp(),
	}
	if err := tx.Create(sub).Error; err != nil {
		return nil, err
	}
	return sub, nil
}

func refreshSubscriptionUserGroupCache(userId int, operation string) {
	if err := RefreshUserGroupCache(userId); err != nil {
		common.SysError(common.LogText("failed to refresh user group cache after %s for user %d: %v", operation, userId, err))
	}
}

// Complete a subscription order (idempotent). Creates a UserSubscription snapshot from the plan.
// expectedPaymentProvider guards against cross-gateway callback attacks (empty skips the check).
// actualPaymentMethod updates the order's PaymentMethod to reflect the real payment type used (empty skips update).
func CompleteSubscriptionOrder(tradeNo string, providerPayload string, expectedPaymentProvider string, actualPaymentMethod string) error {
	if tradeNo == "" {
		return errors.New("tradeNo is empty")
	}
	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}
	var logUserId int
	var logPlanTitle string
	var logMoney float64
	var logPaymentMethod string
	var upgradeGroup string
	err := DB.Transaction(func(tx *gorm.DB) error {
		var order SubscriptionOrder
		if err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(&order).Error; err != nil {
			return ErrSubscriptionOrderNotFound
		}
		if expectedPaymentProvider != "" && order.PaymentProvider != expectedPaymentProvider {
			return ErrPaymentMethodMismatch
		}
		if order.Status == common.TopUpStatusSuccess {
			return nil
		}
		if order.Status != common.TopUpStatusPending {
			return ErrSubscriptionOrderStatusInvalid
		}
		plan, err := GetSubscriptionPlanById(order.PlanId)
		if err != nil {
			return err
		}
		if !plan.Enabled {
			// still allow completion for already purchased orders
		}
		// 锁定用户行：并发完成同一用户的不同订单（包括多实例部署下）时，
		// 使 CreateUserSubscriptionFromPlanTx 的 MaxPurchasePerUser 检查按用户串行。
		var userRow User
		if err := lockForUpdate(tx).Select("id").Where("id = ?", order.UserId).First(&userRow).Error; err != nil {
			return err
		}
		subscription, err := CreateUserSubscriptionFromPlanTx(tx, order.UserId, plan, "order")
		if err != nil {
			return err
		}
		if subscription.PrevUserGroup != "" {
			upgradeGroup = group_setting.ResolveGroupID(subscription.UpgradeGroup)
		}
		if err := upsertSubscriptionTopUpTx(tx, &order); err != nil {
			return err
		}
		order.Status = common.TopUpStatusSuccess
		order.CompleteTime = common.GetTimestamp()
		if providerPayload != "" {
			order.ProviderPayload = providerPayload
		}
		if actualPaymentMethod != "" && order.PaymentMethod != actualPaymentMethod {
			order.PaymentMethod = actualPaymentMethod
		}
		if err := tx.Save(&order).Error; err != nil {
			return err
		}
		logUserId = order.UserId
		logPlanTitle = plan.Title
		logMoney = order.Money
		logPaymentMethod = order.PaymentMethod
		return nil
	})
	if err != nil {
		return err
	}
	if upgradeGroup != "" && logUserId > 0 {
		refreshSubscriptionUserGroupCache(logUserId, common.LogText("subscription payment completion"))
	}
	if logUserId > 0 {
		RecordLog(logUserId, LogTypeTopup, common.NewMessage("Subscription purchased, plan: {{plan}}, payment amount: {{amount}}, payment method: {{method}}", map[string]any{
			"plan":   logPlanTitle,
			"amount": fmt.Sprintf("%.2f", logMoney),
			"method": logPaymentMethod,
		}))
	}
	return nil
}

func upsertSubscriptionTopUpTx(tx *gorm.DB, order *SubscriptionOrder) error {
	if tx == nil || order == nil {
		return errors.New("invalid subscription order")
	}
	now := common.GetTimestamp()
	var topup TopUp
	if err := tx.Where("trade_no = ?", order.TradeNo).First(&topup).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			topup = TopUp{
				UserId:        order.UserId,
				Amount:        0,
				Money:         order.Money,
				TradeNo:       order.TradeNo,
				PaymentMethod: order.PaymentMethod,
				CreateTime:    order.CreateTime,
				CompleteTime:  now,
				Status:        common.TopUpStatusSuccess,
			}
			return tx.Create(&topup).Error
		}
		return err
	}
	topup.Money = order.Money
	if topup.PaymentMethod == "" {
		topup.PaymentMethod = order.PaymentMethod
	} else if topup.PaymentMethod != order.PaymentMethod {
		return ErrPaymentMethodMismatch
	}
	if topup.CreateTime == 0 {
		topup.CreateTime = order.CreateTime
	}
	topup.CompleteTime = now
	topup.Status = common.TopUpStatusSuccess
	return tx.Save(&topup).Error
}

func ExpireSubscriptionOrder(tradeNo string, expectedPaymentProvider string) error {
	if tradeNo == "" {
		return errors.New("tradeNo is empty")
	}
	refCol := "`trade_no`"
	if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
		refCol = `"trade_no"`
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var order SubscriptionOrder
		if err := lockForUpdate(tx).Where(refCol+" = ?", tradeNo).First(&order).Error; err != nil {
			return ErrSubscriptionOrderNotFound
		}
		if expectedPaymentProvider != "" && order.PaymentProvider != expectedPaymentProvider {
			return ErrPaymentMethodMismatch
		}
		if order.Status != common.TopUpStatusPending {
			return nil
		}
		order.Status = common.TopUpStatusExpired
		order.CompleteTime = common.GetTimestamp()
		return tx.Save(&order).Error
	})
}

// Admin bind (no payment). Creates a UserSubscription from a plan.
func AdminBindSubscription(userId int, planId int, sourceNote string) (*common.Message, error) {
	if userId <= 0 || planId <= 0 {
		return nil, errors.New("invalid userId or planId")
	}
	plan, err := GetSubscriptionPlanById(planId)
	if err != nil {
		return nil, err
	}
	groupChanged := false
	err = DB.Transaction(func(tx *gorm.DB) error {
		// 与 CompleteSubscriptionOrder 一致：先锁用户行，再做购买次数检查。
		var userRow User
		if err := lockForUpdate(tx).Select("id").Where("id = ?", userId).First(&userRow).Error; err != nil {
			return err
		}
		subscription, err := CreateUserSubscriptionFromPlanTx(tx, userId, plan, "admin")
		if err == nil {
			groupChanged = subscription.PrevUserGroup != ""
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	if groupChanged {
		refreshSubscriptionUserGroupCache(userId, common.LogText("admin subscription creation"))
		return common.NewMessage("User group will be upgraded to {{group}}", map[string]any{"group": plan.UpgradeGroup}), nil
	}
	return nil, nil
}

func calcSubscriptionBalanceQuota(priceAmount float64) (int, error) {
	if priceAmount <= 0 {
		return 0, nil
	}
	if common.QuotaPerUnit <= 0 {
		return 0, common.NewMessage("Quota unit is misconfigured")
	}
	quota := decimal.NewFromFloat(priceAmount).
		Mul(decimal.NewFromFloat(common.QuotaPerUnit)).
		Ceil()
	return common.WalletQuotaFromDecimalStrict(quota)
}

// PurchaseSubscriptionWithBalance creates a subscription by deducting the user's wallet quota.
func PurchaseSubscriptionWithBalance(userId int, planId int) error {
	if userId <= 0 || planId <= 0 {
		return errors.New("invalid userId or planId")
	}

	var logPlanTitle string
	var logMoney float64
	var chargedQuota int
	var upgradeGroup string
	err := DB.Transaction(func(tx *gorm.DB) error {
		plan, err := getSubscriptionPlanByIdTx(tx, planId)
		if err != nil {
			return err
		}
		if !plan.Enabled {
			return common.NewMessage("Subscription plan is not enabled")
		}
		if plan.PriceAmount < 0 {
			return common.NewMessage("Price cannot be negative")
		}
		if plan.AllowBalancePay != nil && !*plan.AllowBalancePay {
			return common.NewMessage("This plan does not allow balance redemption")
		}

		requiredQuota, err := calcSubscriptionBalanceQuota(plan.PriceAmount)
		if err != nil {
			return err
		}

		var user User
		if err := lockForUpdate(tx).Where("id = ?", userId).First(&user).Error; err != nil {
			return err
		}
		if requiredQuota > 0 && user.Quota < requiredQuota {
			return common.NewMessage("Insufficient balance")
		}
		if requiredQuota > 0 {
			if err := tx.Model(&User{}).Where("id = ?", userId).
				Update("quota", gorm.Expr("quota - ?", requiredQuota)).Error; err != nil {
				return err
			}
		}

		subscription, err := CreateUserSubscriptionFromPlanTx(tx, userId, plan, PaymentMethodBalance)
		if err != nil {
			return err
		}

		now := common.GetTimestamp()
		tradeNo := fmt.Sprintf("SUBBALUSR%dNO%s%d", userId, common.GetRandomString(6), time.Now().UnixNano())
		order := &SubscriptionOrder{
			UserId:          userId,
			PlanId:          plan.Id,
			Money:           plan.PriceAmount,
			TradeNo:         tradeNo,
			PaymentMethod:   PaymentMethodBalance,
			PaymentProvider: PaymentProviderBalance,
			Status:          common.TopUpStatusSuccess,
			CreateTime:      now,
			CompleteTime:    now,
			ProviderPayload: fmt.Sprintf("charged_quota=%d", requiredQuota),
		}
		if err := tx.Create(order).Error; err != nil {
			return err
		}

		// Balance-funded subscription payment is a wallet fund event: the
		// ledger row and the balance deduction commit together.
		if requiredQuota > 0 {
			applied, err := AppendWalletLedgerTx(tx, &WalletLedgerEntry{
				UserId:       userId,
				Kind:         WalletLedgerKindSubscriptionPayment,
				Amount:       -int64(requiredQuota),
				BalanceAfter: int64(user.Quota - requiredQuota),
				RefType:      WalletLedgerRefSubscription,
				RefId:        tradeNo,
				CreatedAt:    common.GetTimestamp(),
			})
			if err != nil {
				return err
			}
			if !applied {
				return errors.New("wallet ledger reference conflict")
			}
		}

		logPlanTitle = plan.Title
		logMoney = plan.PriceAmount
		chargedQuota = requiredQuota
		if subscription.PrevUserGroup != "" {
			upgradeGroup = group_setting.ResolveGroupID(subscription.UpgradeGroup)
		}
		return nil
	})
	if err != nil {
		return err
	}

	if chargedQuota > 0 {
		if err := cacheDecrUserQuota(userId, int64(chargedQuota)); err != nil {
			common.SysLog(common.LogText("failed to decrease user quota cache after subscription balance purchase: %s", err.Error()))
		}
	}
	if upgradeGroup != "" {
		refreshSubscriptionUserGroupCache(userId, common.LogText("subscription balance purchase"))
	}
	RecordLog(userId, LogTypeTopup, common.NewMessage("Subscription purchased with balance, plan: {{plan}}, payment amount: {{amount}}, quota deducted: {{quota}}", map[string]any{
		"plan":   logPlanTitle,
		"amount": fmt.Sprintf("%.2f", logMoney),
		"quota":  chargedQuota,
	}))
	return nil
}

// GetAllActiveUserSubscriptions returns all active subscriptions for a user.
func GetAllActiveUserSubscriptions(userId int) ([]SubscriptionSummary, error) {
	if userId <= 0 {
		return nil, errors.New("invalid userId")
	}
	now := common.GetTimestamp()
	var subs []UserSubscription
	err := DB.Where("user_id = ? AND status = ? AND end_time > ?", userId, "active", now).
		Order("end_time desc, id desc").
		Find(&subs).Error
	if err != nil {
		return nil, err
	}
	return buildSubscriptionSummaries(subs), nil
}

// HasActiveUserSubscription returns whether the user has any active subscription.
// This is a lightweight existence check to avoid heavy pre-consume transactions.
func HasActiveUserSubscription(userId int) (bool, error) {
	if userId <= 0 {
		return false, errors.New("invalid userId")
	}
	now := common.GetTimestamp()
	var count int64
	if err := DB.Model(&UserSubscription{}).
		Where("user_id = ? AND status = ? AND end_time > ?", userId, "active", now).
		Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

// UserActiveSubscriptionsAllowWalletOverflow returns whether wallet balance may be used
// after the user's subscription quota is exhausted. A single active subscription that
// disallows wallet overflow (allow_wallet_overflow = false) blocks the fallback.
func UserActiveSubscriptionsAllowWalletOverflow(userId int) (bool, error) {
	if userId <= 0 {
		return false, errors.New("invalid userId")
	}
	now := common.GetTimestamp()
	var strictCount int64
	if err := DB.Model(&UserSubscription{}).
		Where("user_id = ? AND status = ? AND end_time > ? AND allow_wallet_overflow = ?",
			userId, "active", now, false).
		Count(&strictCount).Error; err != nil {
		return false, err
	}
	return strictCount == 0, nil
}

// GetAllUserSubscriptions returns all subscriptions (active and expired) for a user.
func GetAllUserSubscriptions(userId int) ([]SubscriptionSummary, error) {
	if userId <= 0 {
		return nil, errors.New("invalid userId")
	}
	var subs []UserSubscription
	err := DB.Where("user_id = ?", userId).
		Order("end_time desc, id desc").
		Find(&subs).Error
	if err != nil {
		return nil, err
	}
	return buildSubscriptionSummaries(subs), nil
}

func buildSubscriptionSummaries(subs []UserSubscription) []SubscriptionSummary {
	if len(subs) == 0 {
		return []SubscriptionSummary{}
	}
	result := make([]SubscriptionSummary, 0, len(subs))
	for _, sub := range subs {
		subCopy := sub
		result = append(result, SubscriptionSummary{
			Subscription: &subCopy,
		})
	}
	return result
}

// AdminInvalidateUserSubscription marks a user subscription as cancelled and ends it immediately.
func AdminInvalidateUserSubscription(userSubscriptionId int) (*common.Message, error) {
	if userSubscriptionId <= 0 {
		return nil, errors.New("invalid userSubscriptionId")
	}
	now := common.GetTimestamp()
	cacheGroup := ""
	downgradeGroup := ""
	var userId int
	err := DB.Transaction(func(tx *gorm.DB) error {
		var sub UserSubscription
		if err := lockForUpdate(tx).
			Where("id = ?", userSubscriptionId).First(&sub).Error; err != nil {
			return err
		}
		userId = sub.UserId
		if err := tx.Model(&sub).Updates(map[string]any{
			"status":     "cancelled",
			"end_time":   now,
			"updated_at": now,
		}).Error; err != nil {
			return err
		}
		target, err := downgradeUserGroupForSubscriptionTx(tx, &sub, now)
		if err != nil {
			return err
		}
		if target != "" {
			cacheGroup = target
			downgradeGroup = target
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if cacheGroup != "" && userId > 0 {
		refreshSubscriptionUserGroupCache(userId, common.LogText("admin subscription update"))
	}
	if downgradeGroup != "" {
		return common.NewMessage("User group will be reverted to {{group}}", map[string]any{"group": downgradeGroup}), nil
	}
	return nil, nil
}

// AdminDeleteUserSubscription hard-deletes a user subscription.
func AdminDeleteUserSubscription(userSubscriptionId int) (*common.Message, error) {
	if userSubscriptionId <= 0 {
		return nil, errors.New("invalid userSubscriptionId")
	}
	now := common.GetTimestamp()
	cacheGroup := ""
	downgradeGroup := ""
	var userId int
	err := DB.Transaction(func(tx *gorm.DB) error {
		var sub UserSubscription
		if err := lockForUpdate(tx).
			Where("id = ?", userSubscriptionId).First(&sub).Error; err != nil {
			return err
		}
		userId = sub.UserId
		target, err := downgradeUserGroupForSubscriptionTx(tx, &sub, now)
		if err != nil {
			return err
		}
		if target != "" {
			cacheGroup = target
			downgradeGroup = target
		}
		if err := tx.Where("id = ?", userSubscriptionId).Delete(&UserSubscription{}).Error; err != nil {
			return err
		}
		return clearSubscriptionWindowUsageTx(tx, userSubscriptionId)
	})
	if err != nil {
		return nil, err
	}
	if cacheGroup != "" && userId > 0 {
		refreshSubscriptionUserGroupCache(userId, common.LogText("admin subscription deletion"))
	}
	if downgradeGroup != "" {
		return common.NewMessage("User group will be reverted to {{group}}", map[string]any{"group": downgradeGroup}), nil
	}
	return nil, nil
}

func resetUserSubscriptionTx(tx *gorm.DB, sub *UserSubscription, plan *SubscriptionPlan, now int64, advanceResetTime bool) error {
	if tx == nil || sub == nil || plan == nil {
		return errors.New("invalid reset args")
	}
	sub.AmountUsed = 0
	if err := clearSubscriptionWindowUsageTx(tx, sub.Id); err != nil {
		return err
	}
	if advanceResetTime {
		nextReset := calcNextResetTime(time.Unix(now, 0), plan, sub.EndTime)
		sub.NextResetTime = nextReset
		if nextReset > 0 {
			sub.LastResetTime = now
		} else {
			sub.LastResetTime = 0
		}
	}
	return tx.Save(sub).Error
}

func buildSubscriptionResetResult(plan *SubscriptionPlan, subs []UserSubscription, advanceResetTime bool) *SubscriptionResetResult {
	userIds := make([]int, 0, len(subs))
	seenUsers := make(map[int]struct{}, len(subs))
	for _, sub := range subs {
		if _, ok := seenUsers[sub.UserId]; ok {
			continue
		}
		seenUsers[sub.UserId] = struct{}{}
		userIds = append(userIds, sub.UserId)
	}
	return &SubscriptionResetResult{
		PlanId:           plan.Id,
		MatchedCount:     len(subs),
		ResetCount:       len(subs),
		UserCount:        len(userIds),
		AdvanceResetTime: advanceResetTime,
		PlanTitle:        plan.Title,
		AffectedUserIds:  userIds,
	}
}

func adminResetUserSubscriptionsByPlanTx(tx *gorm.DB, userId int, plan *SubscriptionPlan, now int64, advanceResetTime bool) (*SubscriptionResetResult, error) {
	if tx == nil || plan == nil {
		return nil, errors.New("invalid reset args")
	}
	var subs []UserSubscription
	if err := lockForUpdate(tx).
		Where("user_id = ? AND plan_id = ? AND status = ? AND end_time > ?", userId, plan.Id, "active", now).
		Order("end_time asc, id asc").
		Find(&subs).Error; err != nil {
		return nil, err
	}
	if len(subs) == 0 {
		return nil, common.NewMessage("This user has no active subscription to this plan")
	}
	for i := range subs {
		if err := resetUserSubscriptionTx(tx, &subs[i], plan, now, advanceResetTime); err != nil {
			return nil, err
		}
	}
	return buildSubscriptionResetResult(plan, subs, advanceResetTime), nil
}

func adminResetPlanSubscriptionsTx(tx *gorm.DB, plan *SubscriptionPlan, now int64, advanceResetTime bool) (*SubscriptionResetResult, error) {
	if tx == nil || plan == nil {
		return nil, errors.New("invalid reset args")
	}
	var subs []UserSubscription
	if err := lockForUpdate(tx).
		Where("plan_id = ? AND status = ? AND end_time > ?", plan.Id, "active", now).
		Order("user_id asc, end_time asc, id asc").
		Find(&subs).Error; err != nil {
		return nil, err
	}
	for i := range subs {
		if err := resetUserSubscriptionTx(tx, &subs[i], plan, now, advanceResetTime); err != nil {
			return nil, err
		}
	}
	return buildSubscriptionResetResult(plan, subs, advanceResetTime), nil
}

func AdminResetUserSubscriptionsByPlan(userId int, planId int, advanceResetTime bool) (*SubscriptionResetResult, error) {
	if userId <= 0 || planId <= 0 {
		return nil, errors.New("invalid userId or planId")
	}
	var result *SubscriptionResetResult
	now := GetDBTimestamp()
	err := DB.Transaction(func(tx *gorm.DB) error {
		plan, err := getSubscriptionPlanByIdTx(tx, planId)
		if err != nil {
			return err
		}
		result, err = adminResetUserSubscriptionsByPlanTx(tx, userId, plan, now, advanceResetTime)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func AdminResetPlanSubscriptions(planId int, advanceResetTime bool) (*SubscriptionResetResult, error) {
	if planId <= 0 {
		return nil, errors.New("invalid planId")
	}
	var result *SubscriptionResetResult
	now := GetDBTimestamp()
	err := DB.Transaction(func(tx *gorm.DB) error {
		plan, err := getSubscriptionPlanByIdTx(tx, planId)
		if err != nil {
			return err
		}
		result, err = adminResetPlanSubscriptionsTx(tx, plan, now, advanceResetTime)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

type SubscriptionPreConsumeResult struct {
	UserSubscriptionId int
	PreConsumed        int64
	AmountTotal        int64
	AmountUsedBefore   int64
	AmountUsedAfter    int64
}

// ExpireDueSubscriptions marks expired subscriptions and handles group downgrade.
func ExpireDueSubscriptions(limit int) (int, error) {
	if limit <= 0 {
		limit = 200
	}
	now := GetDBTimestamp()
	var subs []UserSubscription
	if err := DB.Where("status = ? AND end_time > 0 AND end_time <= ?", "active", now).
		Order("end_time asc, id asc").
		Limit(limit).
		Find(&subs).Error; err != nil {
		return 0, err
	}
	if len(subs) == 0 {
		return 0, nil
	}
	expiredCount := 0
	userIds := make(map[int]struct{}, len(subs))
	for _, sub := range subs {
		if sub.UserId > 0 {
			userIds[sub.UserId] = struct{}{}
		}
	}
	for userId := range userIds {
		cacheGroup := ""
		err := DB.Transaction(func(tx *gorm.DB) error {
			res := tx.Model(&UserSubscription{}).
				Where("user_id = ? AND status = ? AND end_time > 0 AND end_time <= ?", userId, "active", now).
				Updates(map[string]any{
					"status":     "expired",
					"updated_at": common.GetTimestamp(),
				})
			if res.Error != nil {
				return res.Error
			}
			expiredCount += int(res.RowsAffected)

			// If there's an active upgraded subscription, keep current group.
			var activeSub UserSubscription
			activeQuery := tx.Where("user_id = ? AND status = ? AND end_time > ? AND upgrade_group <> ''",
				userId, "active", now).
				Order("end_time desc, id desc").
				Limit(1).
				Find(&activeSub)
			if activeQuery.Error == nil && activeQuery.RowsAffected > 0 {
				return nil
			}

			// Find the most recently expired subscription that defines a group transition
			// (an explicit downgrade target or an upgrade snapshot to revert).
			var lastExpired UserSubscription
			expiredQuery := tx.Where("user_id = ? AND status = ? AND (downgrade_group <> '' OR upgrade_group <> '')",
				userId, "expired").
				Order("end_time desc, id desc").
				Limit(1).
				Find(&lastExpired)
			if expiredQuery.Error != nil || expiredQuery.RowsAffected == 0 {
				return nil
			}
			currentGroup, err := getUserGroupByIdTx(tx, userId)
			if err != nil {
				return err
			}
			// An explicit downgrade group takes precedence; otherwise revert to the
			// group held before purchase (legacy behavior, only when the subscription
			// actually elevated the user).
			target := group_setting.ResolveGroupID(lastExpired.DowngradeGroup)
			if target == "" {
				upgradeGroup := group_setting.ResolveGroupID(lastExpired.UpgradeGroup)
				prevGroup := group_setting.ResolveGroupID(lastExpired.PrevUserGroup)
				if upgradeGroup == "" || prevGroup == "" {
					return nil
				}
				if currentGroup != upgradeGroup {
					return nil
				}
				target = prevGroup
			}
			if target == "" || target == currentGroup {
				return nil
			}
			if err := tx.Model(&User{}).Where("id = ?", userId).
				Update("group", target).Error; err != nil {
				return err
			}
			cacheGroup = target
			return nil
		})
		if err != nil {
			return expiredCount, err
		}
		if cacheGroup != "" {
			refreshSubscriptionUserGroupCache(userId, common.LogText("subscription expiration"))
		}
	}
	return expiredCount, nil
}

// SubscriptionPreConsumeRecord stores idempotent pre-consume operations per request.
type SubscriptionPreConsumeRecord struct {
	Id                 int    `json:"id"`
	RequestId          string `json:"request_id" gorm:"type:varchar(64);uniqueIndex"`
	UserId             int    `json:"user_id" gorm:"index"`
	UserSubscriptionId int    `json:"user_subscription_id" gorm:"index"`
	PreConsumed        int64  `json:"pre_consumed" gorm:"type:bigint;not null;default:0"`
	Status             string `json:"status" gorm:"type:varchar(32);index"` // consumed/refunded
	// WindowCharges records which calendar windows a pre-consume charged, as a
	// JSON array of {window,start,amount}. A refund restores exactly those
	// windows instead of whatever windows are open at refund time.
	WindowCharges string `json:"window_charges" gorm:"type:text"`
	CreatedAt     int64  `json:"created_at" gorm:"bigint"`
	UpdatedAt     int64  `json:"updated_at" gorm:"bigint;index"`
}

func (r *SubscriptionPreConsumeRecord) BeforeCreate(tx *gorm.DB) error {
	now := common.GetTimestamp()
	r.CreatedAt = now
	r.UpdatedAt = now
	return nil
}

func (r *SubscriptionPreConsumeRecord) BeforeUpdate(tx *gorm.DB) error {
	r.UpdatedAt = common.GetTimestamp()
	return nil
}

// SubscriptionWindowUsage tracks one subscription's accumulated usage inside
// one calendar window (hour/day/week/month). window_start identifies the
// boundary the row belongs to; a row whose boundary already passed is rolled
// (used reset) the next time the window is charged.
type SubscriptionWindowUsage struct {
	Id             int    `json:"id"`
	SubscriptionId int    `json:"subscription_id" gorm:"uniqueIndex:idx_subscription_window,priority:1"`
	Window         string `json:"window" gorm:"type:varchar(16);uniqueIndex:idx_subscription_window,priority:2"`
	Used           int64  `json:"used" gorm:"type:bigint;not null;default:0"`
	WindowStart    int64  `json:"window_start" gorm:"type:bigint;not null;default:0"`
	CreatedAt      int64  `json:"created_at" gorm:"bigint"`
	UpdatedAt      int64  `json:"updated_at" gorm:"bigint"`
}

func (u *SubscriptionWindowUsage) BeforeCreate(tx *gorm.DB) error {
	now := common.GetTimestamp()
	u.CreatedAt = now
	u.UpdatedAt = now
	return nil
}

func (u *SubscriptionWindowUsage) BeforeUpdate(tx *gorm.DB) error {
	u.UpdatedAt = common.GetTimestamp()
	return nil
}

func maybeResetUserSubscriptionWithPlanTx(tx *gorm.DB, sub *UserSubscription, plan *SubscriptionPlan, now int64) error {
	if tx == nil || sub == nil || plan == nil {
		return errors.New("invalid reset args")
	}
	if sub.NextResetTime > 0 && sub.NextResetTime > now {
		return nil
	}
	if NormalizeResetPeriod(plan.QuotaResetPeriod) == SubscriptionResetNever {
		return nil
	}
	baseUnix := sub.LastResetTime
	if baseUnix <= 0 {
		baseUnix = sub.StartTime
	}
	base := time.Unix(baseUnix, 0)
	next := calcNextResetTime(base, plan, sub.EndTime)
	advanced := false
	for next > 0 && next <= now {
		advanced = true
		base = time.Unix(next, 0)
		next = calcNextResetTime(base, plan, sub.EndTime)
	}
	if !advanced {
		if sub.NextResetTime == 0 && next > 0 {
			sub.NextResetTime = next
			sub.LastResetTime = base.Unix()
			return tx.Save(sub).Error
		}
		return nil
	}
	sub.AmountUsed = 0
	sub.LastResetTime = base.Unix()
	sub.NextResetTime = next
	if err := tx.Save(sub).Error; err != nil {
		return err
	}
	// A new quota period also restarts every calendar window.
	return clearSubscriptionWindowUsageTx(tx, sub.Id)
}

// subscriptionWindowLimit is one configured calendar window and its cap.
type subscriptionWindowLimit struct {
	Window string
	Limit  int64
}

// SubscriptionWindowCharge is one window's contribution to a pre-consume. It
// is persisted on the pre-consume record so a refund can restore the exact
// windows that were charged.
type SubscriptionWindowCharge struct {
	Window string `json:"window"`
	Start  int64  `json:"start"`
	Amount int64  `json:"amount"`
}

// subscriptionPlanWindowLimits returns the plan's configured window caps in a
// stable hour→month order. A zero cap means the window is unlimited.
func subscriptionPlanWindowLimits(plan *SubscriptionPlan) []subscriptionWindowLimit {
	if plan == nil {
		return nil
	}
	limits := make([]subscriptionWindowLimit, 0, 4)
	if plan.QuotaWindowHour > 0 {
		limits = append(limits, subscriptionWindowLimit{Window: SubscriptionWindowHour, Limit: plan.QuotaWindowHour})
	}
	if plan.QuotaWindowDay > 0 {
		limits = append(limits, subscriptionWindowLimit{Window: SubscriptionWindowDay, Limit: plan.QuotaWindowDay})
	}
	if plan.QuotaWindowWeek > 0 {
		limits = append(limits, subscriptionWindowLimit{Window: SubscriptionWindowWeek, Limit: plan.QuotaWindowWeek})
	}
	if plan.QuotaWindowMonth > 0 {
		limits = append(limits, subscriptionWindowLimit{Window: SubscriptionWindowMonth, Limit: plan.QuotaWindowMonth})
	}
	return limits
}

// subscriptionWindowStart returns the start of the calendar window that
// contains now, in server-local time, matching the boundaries used by
// calcNextResetTime.
func subscriptionWindowStart(window string, now int64) (int64, bool) {
	at := time.Unix(now, 0)
	switch window {
	case SubscriptionWindowHour:
		return time.Date(at.Year(), at.Month(), at.Day(), at.Hour(), 0, 0, 0, at.Location()).Unix(), true
	case SubscriptionWindowDay:
		return time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, at.Location()).Unix(), true
	case SubscriptionWindowWeek:
		weekday := int(at.Weekday()) // Sunday = 0
		if weekday == 0 {
			weekday = 7
		}
		dayStart := time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, at.Location())
		return dayStart.AddDate(0, 0, -(weekday - 1)).Unix(), true
	case SubscriptionWindowMonth:
		return time.Date(at.Year(), at.Month(), 1, 0, 0, 0, 0, at.Location()).Unix(), true
	default:
		return 0, false
	}
}

// splitSubscriptionPlanList splits a comma-separated plan restriction list,
// dropping blank entries.
func splitSubscriptionPlanList(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	items := make([]string, 0, 4)
	for part := range strings.SplitSeq(raw, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			items = append(items, part)
		}
	}
	return items
}

// subscriptionPlanAllowsRequest reports whether a plan may fund a request made
// in group for modelName. Empty restriction lists allow everything; a model
// entry with a trailing * matches every name with that prefix. A request whose
// group or model matches no entry is never charged to the subscription.
func subscriptionPlanAllowsRequest(plan *SubscriptionPlan, group string, modelName string) bool {
	if plan == nil {
		return false
	}
	if allowed := splitSubscriptionPlanList(plan.AllowedGroups); len(allowed) > 0 {
		resolved := group_setting.ResolveGroupID(strings.TrimSpace(group))
		matched := false
		for _, candidate := range allowed {
			if group_setting.ResolveGroupID(candidate) == resolved {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	if allowed := splitSubscriptionPlanList(plan.AllowedModels); len(allowed) > 0 {
		modelName = strings.TrimSpace(modelName)
		matched := false
		for _, pattern := range allowed {
			prefix, wildcard := strings.CutSuffix(pattern, "*")
			if wildcard {
				if prefix == "" || strings.HasPrefix(modelName, prefix) {
					matched = true
					break
				}
				continue
			}
			if pattern == modelName {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

// getSubscriptionWindowUsageTx loads the usage row of one window, creating it
// on first use. The caller must already hold the subscription row lock, which
// serializes window updates for the same subscription.
func getSubscriptionWindowUsageTx(tx *gorm.DB, subscriptionId int, window string) (*SubscriptionWindowUsage, error) {
	if tx == nil || subscriptionId <= 0 {
		return nil, errors.New("invalid window usage args")
	}
	var row SubscriptionWindowUsage
	// "window" is a reserved word on MySQL and PostgreSQL, so the condition is
	// built from a quoted identifier instead of raw SQL.
	err := tx.Where("subscription_id = ?", subscriptionId).
		Where(clause.Eq{Column: clause.Column{Name: "window"}, Value: window}).
		First(&row).Error
	if err == nil {
		return &row, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	row = SubscriptionWindowUsage{SubscriptionId: subscriptionId, Window: window}
	if err := tx.Create(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// checkSubscriptionWindowsTx rolls every configured window of the plan to the
// current boundary and reports whether amount fits in all of them. When it
// fits, it returns the charges to persist after the caller commits the record
// and the subscription amount. A window that cannot hold the whole amount
// rejects the pre-consume, matching the total-quota rule (no partial charge).
func checkSubscriptionWindowsTx(tx *gorm.DB, subscriptionId int, plan *SubscriptionPlan, now int64, amount int64) ([]SubscriptionWindowCharge, bool, error) {
	limits := subscriptionPlanWindowLimits(plan)
	if len(limits) == 0 {
		return nil, true, nil
	}
	charges := make([]SubscriptionWindowCharge, 0, len(limits))
	for _, window := range limits {
		start, ok := subscriptionWindowStart(window.Window, now)
		if !ok {
			return nil, false, fmt.Errorf("unsupported subscription quota window: %s", window.Window)
		}
		row, err := getSubscriptionWindowUsageTx(tx, subscriptionId, window.Window)
		if err != nil {
			return nil, false, err
		}
		if row.WindowStart != start {
			row.WindowStart = start
			row.Used = 0
			if err := tx.Save(row).Error; err != nil {
				return nil, false, err
			}
		}
		remaining := window.Limit - row.Used
		if remaining < 0 {
			remaining = 0
		}
		if amount > remaining {
			return nil, false, nil
		}
		charges = append(charges, SubscriptionWindowCharge{Window: window.Window, Start: start, Amount: amount})
	}
	return charges, true, nil
}

// applySubscriptionWindowChargesTx persists a pre-consume's window charges.
// A charge whose window already rolled is skipped so a restarted window is
// never credited with usage from the previous period.
func applySubscriptionWindowChargesTx(tx *gorm.DB, subscriptionId int, charges []SubscriptionWindowCharge) error {
	for _, charge := range charges {
		if charge.Amount <= 0 {
			continue
		}
		row, err := getSubscriptionWindowUsageTx(tx, subscriptionId, charge.Window)
		if err != nil {
			return err
		}
		if row.WindowStart != charge.Start {
			continue
		}
		row.Used += charge.Amount
		if err := tx.Save(row).Error; err != nil {
			return err
		}
	}
	return nil
}

// restoreSubscriptionWindowChargesTx reverses the window charges recorded on a
// refunded pre-consume record. A window that already rolled keeps its
// restarted usage untouched, and a used amount never drops below zero.
func restoreSubscriptionWindowChargesTx(tx *gorm.DB, record *SubscriptionPreConsumeRecord) error {
	if record == nil || strings.TrimSpace(record.WindowCharges) == "" {
		return nil
	}
	var charges []SubscriptionWindowCharge
	if err := common.UnmarshalJsonStr(record.WindowCharges, &charges); err != nil {
		// A corrupt charge snapshot must not block the refund itself: the total
		// is still refunded, and the window expires with its period anyway.
		common.SysError(common.LogText("failed to decode subscription window charges for request %s: %s", record.RequestId, err.Error()))
		return nil
	}
	for _, charge := range charges {
		if charge.Amount <= 0 {
			continue
		}
		row, err := getSubscriptionWindowUsageTx(tx, record.UserSubscriptionId, charge.Window)
		if err != nil {
			return err
		}
		if row.WindowStart != charge.Start {
			continue
		}
		row.Used -= charge.Amount
		if row.Used < 0 {
			row.Used = 0
		}
		if err := tx.Save(row).Error; err != nil {
			return err
		}
	}
	return nil
}

// applySubscriptionWindowDeltaTx applies delta to every configured window of
// the plan, rolling stale windows first. A positive delta is a committed
// charge (an admitted reserve or a settlement), so it is added without a
// capacity check: the window may end up over its cap and simply refuses new
// pre-consumes until it rolls. A negative delta only reduces and never goes
// below zero. Rows for unlimited windows are never created.
func applySubscriptionWindowDeltaTx(tx *gorm.DB, subscriptionId int, plan *SubscriptionPlan, now int64, delta int64) error {
	if delta == 0 {
		return nil
	}
	for _, window := range subscriptionPlanWindowLimits(plan) {
		start, ok := subscriptionWindowStart(window.Window, now)
		if !ok {
			continue
		}
		row, err := getSubscriptionWindowUsageTx(tx, subscriptionId, window.Window)
		if err != nil {
			return err
		}
		if row.WindowStart != start {
			row.WindowStart = start
			row.Used = 0
		}
		row.Used += delta
		if row.Used < 0 {
			row.Used = 0
		}
		if err := tx.Save(row).Error; err != nil {
			return err
		}
	}
	return nil
}

// clearSubscriptionWindowUsageTx drops a subscription's window usage when its
// total usage resets or the subscription is deleted.
func clearSubscriptionWindowUsageTx(tx *gorm.DB, subscriptionId int) error {
	if tx == nil || subscriptionId <= 0 {
		return nil
	}
	return tx.Where("subscription_id = ?", subscriptionId).Delete(&SubscriptionWindowUsage{}).Error
}

// PreConsumeUserSubscription pre-consumes from any active subscription that
// covers the request. A subscription only funds requests whose group and model
// match its plan's restrictions (both unset = unrestricted), and the amount
// must fit the plan total and every configured quota window; otherwise the
// next eligible subscription is tried.
func PreConsumeUserSubscription(requestId string, userId int, group string, modelName string, quotaType int, amount int64) (*SubscriptionPreConsumeResult, error) {
	if userId <= 0 {
		return nil, errors.New("invalid userId")
	}
	if strings.TrimSpace(requestId) == "" {
		return nil, errors.New("requestId is empty")
	}
	if amount <= 0 {
		return nil, errors.New("amount must be > 0")
	}
	now := GetDBTimestamp()

	returnValue := &SubscriptionPreConsumeResult{}

	err := DB.Transaction(func(tx *gorm.DB) error {
		var existing SubscriptionPreConsumeRecord
		query := tx.Where("request_id = ?", requestId).Limit(1).Find(&existing)
		if query.Error != nil {
			return query.Error
		}
		if query.RowsAffected > 0 {
			if existing.Status == "refunded" {
				return errors.New("subscription pre-consume already refunded")
			}
			var sub UserSubscription
			if err := tx.Where("id = ?", existing.UserSubscriptionId).First(&sub).Error; err != nil {
				return err
			}
			returnValue.UserSubscriptionId = sub.Id
			returnValue.PreConsumed = existing.PreConsumed
			returnValue.AmountTotal = sub.AmountTotal
			returnValue.AmountUsedBefore = sub.AmountUsed
			returnValue.AmountUsedAfter = sub.AmountUsed
			return nil
		}

		var subs []UserSubscription
		if err := lockForUpdate(tx).
			Where("user_id = ? AND status = ? AND end_time > ?", userId, "active", now).
			Order("end_time asc, id asc").
			Find(&subs).Error; err != nil {
			return err
		}
		if len(subs) == 0 {
			return ErrNoActiveSubscription
		}
		eligible := false
		insufficient := false
		for _, candidate := range subs {
			sub := candidate
			plan, err := getSubscriptionPlanByIdTx(tx, sub.PlanId)
			if err != nil {
				return err
			}
			if !subscriptionPlanAllowsRequest(plan, group, modelName) {
				continue
			}
			eligible = true
			if err := maybeResetUserSubscriptionWithPlanTx(tx, &sub, plan, now); err != nil {
				return err
			}
			usedBefore := sub.AmountUsed
			if sub.AmountTotal > 0 {
				remaining := sub.AmountTotal - usedBefore
				if remaining < 0 {
					remaining = 0
				}
				if amount > remaining {
					insufficient = true
					continue
				}
			}
			windowCharges, fits, err := checkSubscriptionWindowsTx(tx, sub.Id, plan, now, amount)
			if err != nil {
				return err
			}
			if !fits {
				insufficient = true
				continue
			}
			record := &SubscriptionPreConsumeRecord{
				RequestId:          requestId,
				UserId:             userId,
				UserSubscriptionId: sub.Id,
				PreConsumed:        amount,
				Status:             "consumed",
			}
			if len(windowCharges) > 0 {
				payload, err := common.Marshal(windowCharges)
				if err != nil {
					return err
				}
				record.WindowCharges = string(payload)
			}
			if err := tx.Create(record).Error; err != nil {
				var dup SubscriptionPreConsumeRecord
				if err2 := tx.Where("request_id = ?", requestId).First(&dup).Error; err2 == nil {
					if dup.Status == "refunded" {
						return errors.New("subscription pre-consume already refunded")
					}
					returnValue.UserSubscriptionId = sub.Id
					returnValue.PreConsumed = dup.PreConsumed
					returnValue.AmountTotal = sub.AmountTotal
					returnValue.AmountUsedBefore = sub.AmountUsed
					returnValue.AmountUsedAfter = sub.AmountUsed
					return nil
				}
				return err
			}
			sub.AmountUsed = usedBefore + amount
			if err := tx.Save(&sub).Error; err != nil {
				return err
			}
			if err := applySubscriptionWindowChargesTx(tx, sub.Id, windowCharges); err != nil {
				return err
			}
			returnValue.UserSubscriptionId = sub.Id
			returnValue.PreConsumed = amount
			returnValue.AmountTotal = sub.AmountTotal
			returnValue.AmountUsedBefore = usedBefore
			returnValue.AmountUsedAfter = sub.AmountUsed
			return nil
		}
		if !eligible {
			return fmt.Errorf("%w: group=%q model=%q", ErrSubscriptionIneligible, group, modelName)
		}
		if insufficient {
			return fmt.Errorf("%w, need=%d", ErrSubscriptionQuotaInsufficient, amount)
		}
		return ErrNoActiveSubscription
	})
	if err != nil {
		return nil, err
	}
	return returnValue, nil
}

// RefundSubscriptionPreConsume refunds pre-consumed subscription quota by
// requestId. The refund record status and the subscription amount change in one
// transaction, and the status update claims the record atomically, so a
// concurrent refund or a retry after a failed transaction refunds exactly once.
func RefundSubscriptionPreConsume(requestId string) error {
	if strings.TrimSpace(requestId) == "" {
		return errors.New("requestId is empty")
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var record SubscriptionPreConsumeRecord
		query := tx.Where("request_id = ?", requestId).Limit(1).Find(&record)
		if query.Error != nil {
			return query.Error
		}
		if query.RowsAffected == 0 {
			return fmt.Errorf("subscription pre-consume record not found for request %s", requestId)
		}
		if record.Status == "refunded" {
			return nil
		}
		// Lock the subscription before touching the record so the lock order
		// matches PreConsumeUserSubscription (subscription, then record).
		var sub UserSubscription
		if err := lockForUpdate(tx).Where("id = ?", record.UserSubscriptionId).First(&sub).Error; err != nil {
			return err
		}
		claim := tx.Model(&SubscriptionPreConsumeRecord{}).
			Where("id = ? AND status <> ?", record.Id, "refunded").
			Updates(map[string]any{"status": "refunded", "updated_at": common.GetTimestamp()})
		if claim.Error != nil {
			return claim.Error
		}
		if claim.RowsAffected == 0 {
			// A concurrent refund won the claim; its transaction already applied
			// the amount refund, so this replay must not refund again.
			return nil
		}
		if record.PreConsumed <= 0 {
			return nil
		}
		// Restore the exact windows the pre-consume charged before reducing the
		// total, all in the same transaction as the status claim.
		if err := restoreSubscriptionWindowChargesTx(tx, &record); err != nil {
			return err
		}
		_, err := applyUserSubscriptionUsedDeltaTx(tx, &sub, -record.PreConsumed)
		return err
	})
}

// ResetDueSubscriptions resets subscriptions whose next_reset_time has passed.
func ResetDueSubscriptions(limit int) (int, error) {
	if limit <= 0 {
		limit = 200
	}
	now := GetDBTimestamp()
	var subs []UserSubscription
	if err := DB.Where("next_reset_time > 0 AND next_reset_time <= ? AND status = ?", now, "active").
		Order("next_reset_time asc").
		Limit(limit).
		Find(&subs).Error; err != nil {
		return 0, err
	}
	if len(subs) == 0 {
		return 0, nil
	}
	resetCount := 0
	for _, sub := range subs {
		subCopy := sub
		plan, err := getSubscriptionPlanByIdTx(nil, sub.PlanId)
		if err != nil || plan == nil {
			continue
		}
		err = DB.Transaction(func(tx *gorm.DB) error {
			var locked UserSubscription
			if err := lockForUpdate(tx).
				Where("id = ? AND next_reset_time > 0 AND next_reset_time <= ?", subCopy.Id, now).
				First(&locked).Error; err != nil {
				return nil
			}
			if err := maybeResetUserSubscriptionWithPlanTx(tx, &locked, plan, now); err != nil {
				return err
			}
			resetCount++
			return nil
		})
		if err != nil {
			return resetCount, err
		}
	}
	return resetCount, nil
}

// CleanupSubscriptionPreConsumeRecords removes old idempotency records to keep table small.
func CleanupSubscriptionPreConsumeRecords(olderThanSeconds int64) (int64, error) {
	if olderThanSeconds <= 0 {
		olderThanSeconds = 7 * 24 * 3600
	}
	cutoff := GetDBTimestamp() - olderThanSeconds
	res := DB.Where("updated_at < ?", cutoff).Delete(&SubscriptionPreConsumeRecord{})
	return res.RowsAffected, res.Error
}

type SubscriptionPlanInfo struct {
	PlanId    int
	PlanTitle string
}

func GetSubscriptionPlanInfoByUserSubscriptionId(userSubscriptionId int) (*SubscriptionPlanInfo, error) {
	if userSubscriptionId <= 0 {
		return nil, errors.New("invalid userSubscriptionId")
	}
	cacheKey := fmt.Sprintf("sub:%d", userSubscriptionId)
	if cached, found, err := getSubscriptionPlanInfoCache().Get(cacheKey); err == nil && found {
		return &cached, nil
	}
	var sub UserSubscription
	if err := DB.Where("id = ?", userSubscriptionId).First(&sub).Error; err != nil {
		return nil, err
	}
	plan, err := getSubscriptionPlanByIdTx(nil, sub.PlanId)
	if err != nil {
		return nil, err
	}
	info := &SubscriptionPlanInfo{
		PlanId:    sub.PlanId,
		PlanTitle: plan.Title,
	}
	_ = getSubscriptionPlanInfoCache().SetWithTTL(cacheKey, *info, subscriptionPlanInfoCacheTTL())
	return info, nil
}

// Update subscription used amount by delta (positive consume more, negative refund).
// A positive delta must fit both the plan total and every configured quota
// window, matching the pre-consume admission rule for in-flight reserves; a
// negative delta rolls the reserve back and never goes below zero.
func PostConsumeUserSubscriptionDelta(userSubscriptionId int, delta int64) error {
	if userSubscriptionId <= 0 {
		return errors.New("invalid userSubscriptionId")
	}
	if delta == 0 {
		return nil
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		var sub UserSubscription
		if err := lockForUpdate(tx).
			Where("id = ?", userSubscriptionId).
			First(&sub).Error; err != nil {
			return err
		}
		var plan *SubscriptionPlan
		if sub.PlanId > 0 {
			loaded, err := getSubscriptionPlanByIdTx(tx, sub.PlanId)
			if err != nil {
				common.SysError(common.LogText("failed to load subscription plan %d for window accounting: %s", sub.PlanId, err.Error()))
			} else {
				plan = loaded
			}
		}
		now := GetDBTimestampTx(tx)
		if delta > 0 {
			if sub.AmountTotal > 0 {
				remaining := sub.AmountTotal - sub.AmountUsed
				if remaining < 0 {
					remaining = 0
				}
				if delta > remaining {
					return fmt.Errorf("subscription used exceeds total, used=%d total=%d", sub.AmountUsed+remaining, sub.AmountTotal)
				}
			}
			windowCharges, fits, err := checkSubscriptionWindowsTx(tx, sub.Id, plan, now, delta)
			if err != nil {
				return err
			}
			if !fits {
				return fmt.Errorf("%w, need=%d", ErrSubscriptionQuotaInsufficient, delta)
			}
			sub.AmountUsed += delta
			if err := tx.Save(&sub).Error; err != nil {
				return err
			}
			return applySubscriptionWindowChargesTx(tx, sub.Id, windowCharges)
		}
		newUsed := sub.AmountUsed + delta
		if newUsed < 0 {
			newUsed = 0
		}
		sub.AmountUsed = newUsed
		if err := tx.Save(&sub).Error; err != nil {
			return err
		}
		return applySubscriptionWindowDeltaTx(tx, sub.Id, plan, now, delta)
	})
}

// applyUserSubscriptionUsedDeltaTx applies a used-amount delta to a locked
// subscription and saves it. The used amount never exceeds the plan total
// (positive deltas are capped, so a settlement can never overshoot the plan)
// and never drops below zero (negative deltas are capped). It returns the delta
// actually applied, which is smaller than the requested delta when a cap hit.
func applyUserSubscriptionUsedDeltaTx(tx *gorm.DB, sub *UserSubscription, delta int64) (int64, error) {
	if sub == nil {
		return 0, errors.New("subscription is nil")
	}
	if delta == 0 {
		return 0, nil
	}
	if delta > 0 && sub.AmountTotal > 0 {
		remaining := sub.AmountTotal - sub.AmountUsed
		if remaining < 0 {
			remaining = 0
		}
		if delta > remaining {
			delta = remaining
		}
	}
	newUsed := sub.AmountUsed + delta
	if newUsed < 0 {
		newUsed = 0
	}
	applied := newUsed - sub.AmountUsed
	sub.AmountUsed = newUsed
	if err := tx.Save(sub).Error; err != nil {
		return 0, err
	}
	return applied, nil
}

// SubscriptionSettlementResult reports how one settlement delta was covered.
type SubscriptionSettlementResult struct {
	// SubscriptionDelta is the part of the delta applied to the subscription's amount_used.
	SubscriptionDelta int64
	// WalletDelta is the overflow charged to the wallet (positive = deducted).
	WalletDelta int64
	// WalletUncovered is the overflow that was charged nowhere: the wallet is
	// only charged down to zero until the WL-06 overdraft policy lands, and a
	// subscription may disallow wallet overflow entirely.
	WalletUncovered int64
	// AllowWalletOverflow is the subscription snapshot of the plan setting.
	AllowWalletOverflow bool
}

// SettleUserSubscriptionDelta applies a settlement delta to one subscription in
// a single transaction. A positive delta that exceeds the subscription's
// remaining quota is split: the subscription absorbs up to its total and, when
// the subscription allows wallet overflow, the excess is charged to the owner's
// wallet in the same transaction together with the matching wallet_ledger
// consumption row (capped at the available balance, never below zero). A
// subscription that disallows wallet overflow keeps its limit and reports the
// excess as uncovered; so does any part the wallet balance cannot cover.
// Negative deltas refund the subscription only, capped at zero. The part the
// subscription absorbs also counts toward its plan's hour/day/week/month quota
// windows, so window caps judge real spend, not only the pre-consume estimate.
func SettleUserSubscriptionDelta(userSubscriptionId int, delta int64) (*SubscriptionSettlementResult, error) {
	if userSubscriptionId <= 0 {
		return nil, errors.New("invalid userSubscriptionId")
	}
	result := &SubscriptionSettlementResult{}
	if delta == 0 {
		return result, nil
	}
	settleUserId := 0
	settleAllowOverflow := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		var sub UserSubscription
		if err := lockForUpdate(tx).Where("id = ?", userSubscriptionId).First(&sub).Error; err != nil {
			return err
		}
		applied, err := applyUserSubscriptionUsedDeltaTx(tx, &sub, delta)
		if err != nil {
			return err
		}
		// The applied part also counts toward the plan's calendar windows. A
		// settlement is a committed charge, so it is recorded even when the
		// window is already at its cap: the window then refuses further
		// pre-consumes until it rolls, while the total keeps its cap above.
		if applied != 0 && sub.PlanId > 0 {
			plan, planErr := getSubscriptionPlanByIdTx(tx, sub.PlanId)
			if planErr != nil {
				common.SysError(common.LogText("failed to load subscription plan %d for window settlement: %s", sub.PlanId, planErr.Error()))
			} else if err := applySubscriptionWindowDeltaTx(tx, sub.Id, plan, GetDBTimestampTx(tx), applied); err != nil {
				return err
			}
		}
		result.SubscriptionDelta = applied
		result.AllowWalletOverflow = sub.AllowWalletOverflow
		settleUserId = sub.UserId
		settleAllowOverflow = sub.AllowWalletOverflow

		overflow := delta - applied
		if overflow <= 0 {
			return nil
		}
		result.WalletUncovered = overflow
		if !sub.AllowWalletOverflow {
			return nil
		}
		charged, uncovered, err := chargeWalletOverflowTx(tx, sub.UserId, overflow)
		if err != nil {
			return err
		}
		result.WalletDelta = charged
		result.WalletUncovered = uncovered
		return nil
	})
	if err != nil {
		return nil, err
	}
	if result.WalletDelta > 0 {
		// Mirror DecreaseUserQuota: keep the cached balance (used by the atomic
		// reservation path) consistent with the committed deduction.
		chargedDelta := result.WalletDelta
		chargedUser := settleUserId
		gopool.Go(func() {
			if err := cacheDecrUserQuota(chargedUser, chargedDelta); err != nil {
				common.SysLog(common.LogText("failed to sync subscription overflow charge to user quota cache: %s", err.Error()))
			}
		})
	}
	if result.WalletUncovered > 0 {
		common.SysError(common.LogText("subscription settlement overflow is not fully covered (user=%d subscription=%d requested=%d subscription_applied=%d wallet_charged=%d uncovered=%d allow_wallet_overflow=%t)",
			settleUserId, userSubscriptionId, delta, result.SubscriptionDelta, result.WalletDelta, result.WalletUncovered, settleAllowOverflow))
	}
	return result, nil
}

// chargeWalletOverflowTx charges a subscription overflow to the wallet inside
// tx: the balance is deducted down to zero (no overdraft before the WL-06
// policy lands) and the deduction is recorded as an hourly consumption row in
// the same transaction. The returned uncovered part stays uncharged for the
// caller to record.
func chargeWalletOverflowTx(tx *gorm.DB, userId int, overflow int64) (charged int64, uncovered int64, err error) {
	if overflow <= 0 {
		return 0, 0, nil
	}
	var user User
	if err := lockForUpdate(tx).Select("id", "quota").Where("id = ?", userId).First(&user).Error; err != nil {
		return 0, 0, err
	}
	available := int64(user.Quota)
	if available < 0 {
		available = 0
	}
	charged = min(overflow, available)
	uncovered = overflow - charged
	if charged == 0 {
		return 0, uncovered, nil
	}
	if err := tx.Model(&User{}).Where("id = ?", userId).Update("quota", int64(user.Quota)-charged).Error; err != nil {
		return 0, 0, err
	}
	// The part of the overflow the wallet covers is attributed to the account's
	// credit grants in spending order.
	grants, err := lockCreditGrantsTx(tx, userId)
	if err != nil {
		return 0, 0, err
	}
	if _, _, err := claimCreditGrantsTx(tx, userId, charged, grants, common.GetTimestamp()); err != nil {
		return 0, 0, err
	}
	if err := upsertWalletConsumeLedgerTx(tx, userId, walletConsumeHourBucket(common.GetTimestamp()), -charged); err != nil {
		return 0, 0, err
	}
	return charged, uncovered, nil
}
