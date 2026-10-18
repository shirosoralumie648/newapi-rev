package model

import (
	"context"
	"errors"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

type cacheQuotaResult int

const (
	cacheQuotaInsufficient cacheQuotaResult = iota
	cacheQuotaOK
	cacheQuotaMiss
)

const userQuotaReserveScript = `
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[2])
  or tonumber(redis.call('HGET', KEYS[1], 'CacheSchema') or '0') ~= tonumber(ARGV[3])
  or redis.call('HEXISTS', KEYS[1], 'Quota') == 0 then
  return -1
end
local quota = tonumber(redis.call('HGET', KEYS[1], 'Quota'))
local limit = tonumber(ARGV[4] or '0') or 0
if quota == nil or quota + limit < tonumber(ARGV[1]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'Quota', -tonumber(ARGV[1]))
return 1`

const userQuotaDeltaScript = `
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[2])
  or tonumber(redis.call('HGET', KEYS[1], 'CacheSchema') or '0') ~= tonumber(ARGV[3])
  or redis.call('HEXISTS', KEYS[1], 'Quota') == 0 then
  return -1
end
redis.call('HINCRBY', KEYS[1], 'Quota', ARGV[1])
return 1`

const tokenQuotaReserveScript = `
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[2])
  or tonumber(redis.call('HGET', KEYS[1], 'CacheSchema') or '0') ~= tonumber(ARGV[4])
  or redis.call('HEXISTS', KEYS[1], 'RemainQuota') == 0
  or redis.call('HEXISTS', KEYS[1], 'UsedQuota') == 0 then
  return -1
end
local remain = tonumber(redis.call('HGET', KEYS[1], 'RemainQuota'))
if remain == nil or remain < tonumber(ARGV[1]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'RemainQuota', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'UsedQuota', tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'AccessedTime', ARGV[3])
return 1`

const tokenQuotaDeltaScript = `
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[2])
  or redis.call('HEXISTS', KEYS[1], 'RemainQuota') == 0
  or redis.call('HEXISTS', KEYS[1], 'UsedQuota') == 0 then
  return -1
end
redis.call('HINCRBY', KEYS[1], 'RemainQuota', tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'UsedQuota', -tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'AccessedTime', ARGV[3])
return 1`

func quotaResultFromLua(result int, err error) (cacheQuotaResult, error) {
	if err != nil {
		return cacheQuotaMiss, err
	}
	switch result {
	case 1:
		return cacheQuotaOK, nil
	case 0:
		return cacheQuotaInsufficient, nil
	default:
		return cacheQuotaMiss, nil
	}
}

func cacheTryReserveUserQuota(userID int, amount int64, overdraftLimit int64) (cacheQuotaResult, error) {
	result, err := common.RDB.Eval(context.Background(), userQuotaReserveScript,
		[]string{getUserCacheKey(userID)}, amount, userID, userCacheSchemaVersion, overdraftLimit).Int()
	return quotaResultFromLua(result, err)
}

func cacheApplyUserQuotaDelta(userID int, delta int64) (cacheQuotaResult, error) {
	result, err := common.RDB.Eval(context.Background(), userQuotaDeltaScript,
		[]string{getUserCacheKey(userID)}, delta, userID, userCacheSchemaVersion).Int()
	return quotaResultFromLua(result, err)
}

func cacheTryReserveTokenQuota(id int, key string, amount int64) (cacheQuotaResult, error) {
	result, err := common.RDB.Eval(context.Background(), tokenQuotaReserveScript,
		[]string{getTokenCacheKey(key)}, amount, id, common.GetTimestamp(), tokenCacheSchemaVersion).Int()
	return quotaResultFromLua(result, err)
}

func cacheApplyTokenQuotaDelta(id int, key string, delta int64) (cacheQuotaResult, error) {
	result, err := common.RDB.Eval(context.Background(), tokenQuotaDeltaScript,
		[]string{getTokenCacheKey(key)}, delta, id, common.GetTimestamp()).Int()
	return quotaResultFromLua(result, err)
}

// persistUserQuotaDelta 把已在缓存侧预扣成功的增量落库；批量模式下入队，
// 直写模式下要求行存在（用户已删除时报错，交由调用方补偿缓存）。
func persistUserQuotaDelta(id int, delta int) error {
	if common.BatchUpdateEnabled {
		addNewRecord(BatchUpdateTypeUserQuota, id, delta)
		return nil
	}
	result := DB.Model(&User{}).Where("id = ?", id).Update("quota", gorm.Expr("quota + ?", delta))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func persistTokenQuotaDelta(id int, delta int) error {
	if common.BatchUpdateEnabled {
		addNewRecord(BatchUpdateTypeTokenQuota, id, delta)
		return nil
	}
	result := DB.Model(&Token{}).Where("id = ?", id).Updates(
		map[string]any{
			"remain_quota":  gorm.Expr("remain_quota + ?", delta),
			"used_quota":    gorm.Expr("used_quota - ?", delta),
			"period_used":   gorm.Expr("CASE WHEN period_used - ? < 0 THEN 0 ELSE period_used - ? END", delta, delta),
			"accessed_time": common.GetTimestamp(),
		},
	)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func reserveUserQuotaDB(id int, quota int, overdraftLimit int64) (bool, error) {
	reserved := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&User{}).
			Where("id = ? AND quota + ? >= ?", id, overdraftLimit, quota).
			Update("quota", gorm.Expr("quota - ?", quota))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return nil
		}
		reserved = true
		// The charge is attributed to the account's credit grants in spending
		// order inside the same transaction that moved the balance.
		grants, err := lockCreditGrantsTx(tx, id)
		if err != nil {
			return err
		}
		_, _, err = claimCreditGrantsTx(tx, id, int64(quota), grants, common.GetTimestamp())
		return err
	})
	if err != nil {
		return false, err
	}
	return reserved, nil
}

func reserveTokenQuotaDB(id int, quota int) (bool, error) {
	result := DB.Model(&Token{}).
		Where("id = ? AND remain_quota >= ?", id, quota).
		Updates(map[string]any{
			"remain_quota":  gorm.Expr("remain_quota - ?", quota),
			"used_quota":    gorm.Expr("used_quota + ?", quota),
			"accessed_time": common.GetTimestamp(),
		})
	return result.RowsAffected == 1, result.Error
}

// reserveTokenQuotaWithPeriodDB 在一条条件 UPDATE 内同时校验余额与周期预算。
// 预算窗口按请求认证时使用的周期计算：窗口已过期时，本窗口累计用量从本次
// 扣费重新开始，检查与写入由同一条语句完成，不存在检查通过后被并发超扣的
// 间隙。unlimited 令牌跳过余额条件但仍维护余额与周期用量记账。
func reserveTokenQuotaWithPeriodDB(id int, quota int, unlimited bool, periodReset string, now int64) (bool, error) {
	windowStart := TokenPeriodWindowStart(periodReset, now)
	query := DB.Model(&Token{}).Where("id = ?", id)
	if !unlimited {
		query = query.Where("remain_quota >= ?", quota)
	}
	result := query.
		Where("period_quota <= 0 OR (CASE WHEN period_window_start <> ? THEN 0 ELSE period_used END) + ? <= period_quota", windowStart, quota).
		Updates(map[string]any{
			"remain_quota":        gorm.Expr("remain_quota - ?", quota),
			"used_quota":          gorm.Expr("used_quota + ?", quota),
			"period_used":         gorm.Expr("CASE WHEN period_window_start <> ? THEN ? ELSE period_used + ? END", windowStart, quota, quota),
			"period_window_start": windowStart,
			"accessed_time":       now,
		})
	return result.RowsAffected == 1, result.Error
}

// TryReserveUserQuota atomically checks and deducts a user's wallet quota. The
// check admits spending down to the account's overdraft credit line, so a group
// configured for postpaid usage can consume with no prepaid balance. With a
// non-empty requestId the deduction and an active wallet hold commit in one
// transaction, which is what makes a reservation left behind by a crash
// refundable. An empty requestId keeps the legacy cache/batch path.
func TryReserveUserQuota(id int, quota int, requestId string) (bool, error) {
	if quota < 0 {
		return false, errors.New("quota cannot be negative")
	}
	if quota == 0 {
		return true, nil
	}
	limit := overdraftLimitForCharge(id)
	if requestId == "" {
		// Legacy path without a durable hold, kept for callers that carry no
		// stable request reference.
		if !common.RedisEnabled {
			return reserveUserQuotaDB(id, quota, limit)
		}

		result, err := cacheTryReserveUserQuota(id, int64(quota), limit)
		if err == nil && result == cacheQuotaMiss {
			if _, hydrateErr := GetUserCache(id); hydrateErr == nil {
				result, err = cacheTryReserveUserQuota(id, int64(quota), limit)
			}
		}
		if err != nil || result == cacheQuotaMiss {
			if err != nil {
				common.SysLog(common.LogText("user quota cache reserve unavailable, falling back to database: %s", err.Error()))
			}
			return reserveUserQuotaDB(id, quota, limit)
		}
		if result == cacheQuotaInsufficient {
			return false, nil
		}
		if err = persistUserQuotaDelta(id, -quota); err != nil {
			compensated, compensateErr := cacheApplyUserQuotaDelta(id, int64(quota))
			if compensateErr != nil || compensated != cacheQuotaOK {
				common.SysError(common.LogText("failed to compensate reserved user quota: result=%d error=%v", compensated, compensateErr))
			}
			return false, err
		}
		// Attribute the charge to the account's credit grants, so a bucket that
		// reached its expiry can never claim money the wallet no longer holds.
		ClaimCreditGrantsForCharge(id, quota)
		return true, nil
	}
	if !common.RedisEnabled {
		applied, err := reserveWalletQuotaWithHoldTx(id, int64(quota), requestId, true)
		return applied > 0, err
	}

	result, err := cacheTryReserveUserQuota(id, int64(quota), limit)
	if err == nil && result == cacheQuotaMiss {
		if _, hydrateErr := GetUserCache(id); hydrateErr == nil {
			result, err = cacheTryReserveUserQuota(id, int64(quota), limit)
		}
	}
	if err != nil || result == cacheQuotaMiss {
		if err != nil {
			common.SysLog(common.LogText("user quota cache reserve unavailable, falling back to database: %s", err.Error()))
		}
		applied, err := reserveWalletQuotaWithHoldTx(id, int64(quota), requestId, true)
		return applied > 0, err
	}
	if result == cacheQuotaInsufficient {
		// The cache authorizes a charge against the paid balance only, so it
		// cannot admit a charge that the account's credit grants cover. Re-check
		// against the database, where the buckets live.
		applied, err := reserveWalletQuotaWithHoldTx(id, int64(quota), requestId, true)
		return applied > 0, err
	}
	// The cache already authorized the reservation, so the database write only
	// has to persist it together with the hold.
	applied, err := reserveWalletQuotaWithHoldTx(id, int64(quota), requestId, false)
	if err != nil {
		compensated, compensateErr := cacheApplyUserQuotaDelta(id, int64(quota))
		if compensateErr != nil || compensated != cacheQuotaOK {
			common.SysError(common.LogText("failed to compensate reserved user quota: result=%d error=%v", compensated, compensateErr))
		}
		return false, err
	}
	if applied < int64(quota) {
		// A stale cache authorized more than the committed balance could cover:
		// return the part the wallet never gave up to the cache so the two stay
		// in step.
		syncWalletQuotaCache(id, int64(quota)-applied, "wallet hold reserve beyond the credit line")
	}
	return true, nil
}

// ReserveUserQuotaWithDebt deducts quota without a balance check: the wallet is
// debited down to its overdraft credit line and the remainder is recorded as
// debt (the same semantics as a settlement top-up). It returns the amount that
// left the wallet so consumption accounting never records more than the balance
// movement. With a non-empty requestId the deduction and the hold extension
// commit together; otherwise it falls back to the legacy batch queue.
func ReserveUserQuotaWithDebt(id int, quota int, requestId string) (int64, error) {
	if quota < 0 {
		return 0, errors.New("quota cannot be negative")
	}
	if quota == 0 {
		return 0, nil
	}
	if requestId == "" {
		// 兼容路径同样受透支上限约束：扣到信用额度为止，超出部分记为欠款。
		applied, err := SettleWalletCharge(id, quota)
		return int64(applied), err
	}
	applied, err := reserveWalletQuotaWithHoldTx(id, int64(quota), requestId, false)
	if err != nil {
		return 0, err
	}
	// DecreaseUserQuota keeps the cache in step for this path; mirror it so the
	// cache cannot authorize the already spent quota again.
	syncWalletQuotaCache(id, -applied, "wallet reserve with debt")
	return applied, nil
}

// TryReserveTokenQuota atomically checks and deducts a token quota. Unlimited
// tokens skip the balance check but still update remain/used accounting. A
// non-empty periodReset enforces the token's periodic budget in the same
// conditional statement: the window state lives in the token row, which the
// Redis balance cache never carries, so this path always reads the database.
func TryReserveTokenQuota(id int, key string, quota int, unlimited bool, periodReset string) (bool, error) {
	if quota < 0 {
		return false, errors.New("quota cannot be negative")
	}
	if quota == 0 {
		return true, nil
	}
	if periodReset != "" {
		return reserveTokenQuotaWithPeriodDB(id, quota, unlimited, periodReset, common.GetTimestamp())
	}
	if unlimited {
		return true, DecreaseTokenQuota(id, key, quota)
	}
	if !common.RedisEnabled {
		return reserveTokenQuotaDB(id, quota)
	}

	result, err := cacheTryReserveTokenQuota(id, key, int64(quota))
	if err == nil && result == cacheQuotaMiss {
		if _, hydrateErr := GetTokenByKey(key, true); hydrateErr == nil {
			result, err = cacheTryReserveTokenQuota(id, key, int64(quota))
		}
	}
	if err != nil || result == cacheQuotaMiss {
		if err != nil {
			common.SysLog(common.LogText("token quota cache reserve unavailable, falling back to database: %s", err.Error()))
		}
		return reserveTokenQuotaDB(id, quota)
	}
	if result == cacheQuotaInsufficient {
		return false, nil
	}
	if err = persistTokenQuotaDelta(id, -quota); err != nil {
		compensated, compensateErr := cacheApplyTokenQuotaDelta(id, key, int64(quota))
		if compensateErr != nil || compensated != cacheQuotaOK {
			common.SysError(common.LogText("failed to compensate reserved token quota: result=%d error=%v", compensated, compensateErr))
		}
		return false, err
	}
	return true, nil
}
