package model

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
)

func (token Token) cacheMAC() (string, error) {
	key := getTokenCacheKey(token.Key)
	token.Key = ""
	token.RemainQuota = 0
	token.UsedQuota = 0
	token.AccessedTime = 0
	if token.AllowIps != nil && *token.AllowIps == "" {
		token.AllowIps = nil
	}
	return authCacheMAC(key, struct {
		Token          Token
		AutoGroups     string
		CacheExpiresAt int64
	}{token, token.AutoGroups, token.CacheExpiresAt})
}

func getTokenCacheKey(key string) string {
	return fmt.Sprintf("token:%s", common.GenerateHMAC(key))
}

func getTokenCacheFenceKey(key string) string {
	return fmt.Sprintf("token:fence:%s", common.GenerateHMAC(key))
}

func tokenCacheTTLSeconds() int {
	ttl := common.RedisKeyCacheSeconds()
	if ttl <= 0 {
		return 60
	}
	return ttl
}

// tokenCacheFenceSeconds must outlive a token mutation's database write plus
// any in-flight reader's DB-read-to-cache-init gap. The fence is not deleted
// after commit; it expires naturally so a reader holding a pre-mutation
// snapshot cannot publish it right after the mutation cleared the cache.
// While the fence exists readers simply serve the database without caching.
const tokenCacheFenceSeconds = 10

// tokenCacheSchemaVersion marks the field layout of the token hash. Bump it
// whenever a field is added, changed, or reinterpreted: hashes below the
// current version are never served nor refreshed, so they expire naturally and
// the next read rebuilds them from the database. This is what makes a cached
// token hash trustworthy for enforcement decisions such as whether a periodic
// budget applies or an admission limit applies.
const tokenCacheSchemaVersion = 3

// invalidateTokenCacheForMutation is called before a token metadata mutation
// writes to the database: it raises the fence and drops the cached hash so no
// reader can act on (or re-publish) the pre-mutation state.
func invalidateTokenCacheForMutation(key string) error {
	if !common.RedisEnabled || key == "" {
		return nil
	}
	ctx := context.Background()
	err := common.RDB.Set(ctx, getTokenCacheFenceKey(key), 1, time.Duration(tokenCacheFenceSeconds)*time.Second).Err()
	if err != nil {
		return err
	}
	return common.RDB.Del(ctx, getTokenCacheKey(key)).Err()
}

// cacheInitToken publishes database metadata when the hash is cold or fails
// verification. A hash from an older schema is left untouched (no TTL refresh)
// so it expires naturally instead of being served with incomplete fields.
// Existing quota counters survive repairs because pre-consume can update Redis
// before the database catches up; counters that are no longer integers are
// replaced from the snapshot.
// 返回值：0=被 fence 拦截，1=完成初始化，2=哈希已存在（校验通过仅刷新 TTL，或已修复），3=schema 过期。
func cacheInitToken(token Token) (int, error) {
	if !common.RedisEnabled {
		return 0, nil
	}
	allowIps := ""
	if token.AllowIps != nil {
		allowIps = *token.AllowIps
	}
	cacheKey := getTokenCacheKey(token.Key)
	var existing Token
	readErr := common.RedisHGetObj(cacheKey, &existing)
	if readErr != nil {
		// Decoding stops at the first unreadable field, before CacheMAC.
		existing.CacheMAC, _ = common.RDB.HGet(context.Background(), cacheKey, "CacheMAC").Result()
	}
	existing.Key = token.Key
	existingMAC, macErr := existing.cacheMAC()
	repair := readErr != nil || macErr != nil || !validAuthCacheMAC(existingMAC, existing.CacheMAC, existing.CacheExpiresAt)
	token.CacheExpiresAt = time.Now().Add(time.Duration(tokenCacheTTLSeconds()) * time.Second).UnixMilli()
	mac, err := token.cacheMAC()
	if err != nil {
		return 0, err
	}
	const script = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
local exists = redis.call('EXISTS', KEYS[1])
if exists == 1 then
  if tonumber(redis.call('HGET', KEYS[1], 'CacheSchema') or '0') ~= tonumber(ARGV[19]) then
    return 3
  end
  if ARGV[28] ~= 'true' or (redis.call('HGET', KEYS[1], 'CacheMAC') or '') ~= ARGV[29] then
    redis.call('EXPIRE', KEYS[1], ARGV[18])
    return 2
  end
end
redis.call('HDEL', KEYS[1], 'DeletedAt')
redis.call('HSET', KEYS[1],
  'Id', ARGV[1], 'UserId', ARGV[2], 'Status', ARGV[3], 'Name', ARGV[4],
  'CreatedTime', ARGV[5], 'ExpiredTime', ARGV[7],
  'UnlimitedQuota', ARGV[8], 'ModelLimitsEnabled', ARGV[9], 'ModelLimits', ARGV[10],
  'AllowIps', ARGV[11], 'Group', ARGV[12], 'CrossGroupRetry', ARGV[13],
  'AutoGroups', ARGV[14], 'AllowUserQuotaQuery', ARGV[17],
  'CacheSchema', ARGV[19], 'PeriodQuota', ARGV[20],
  'PeriodResetPeriod', ARGV[21], 'PeriodUsed', ARGV[22], 'PeriodWindowStart', ARGV[23],
  'RPMLimit', ARGV[24], 'TPMLimit', ARGV[25],
  'CacheExpiresAt', ARGV[26], 'CacheMAC', ARGV[27])
for _, counter in ipairs({{'AccessedTime', ARGV[6]}, {'RemainQuota', ARGV[15]}, {'UsedQuota', ARGV[16]}}) do
  if not string.match(redis.call('HGET', KEYS[1], counter[1]) or '', '^-?%d+$') then
    redis.call('HSET', KEYS[1], counter[1], counter[2])
  end
end
redis.call('EXPIRE', KEYS[1], ARGV[18])
if exists == 1 then
  return 2
end
return 1`

	return common.RDB.Eval(context.Background(), script, []string{
		cacheKey, getTokenCacheFenceKey(token.Key),
	},
		token.Id, token.UserId, token.Status, token.Name,
		token.CreatedTime, token.AccessedTime, token.ExpiredTime,
		strconv.FormatBool(token.UnlimitedQuota), strconv.FormatBool(token.ModelLimitsEnabled),
		token.ModelLimits, allowIps, token.Group, strconv.FormatBool(token.CrossGroupRetry),
		token.AutoGroups, token.RemainQuota, token.UsedQuota,
		strconv.FormatBool(token.AllowUserQuotaQuery),
		tokenCacheTTLSeconds(), tokenCacheSchemaVersion, token.PeriodQuota,
		token.PeriodResetPeriod, token.PeriodUsed, token.PeriodWindowStart,
		token.RPMLimit, token.TPMLimit,
		token.CacheExpiresAt, mac, strconv.FormatBool(repair), existing.CacheMAC,
	).Int()
}

// cacheGetTokenByKey 从缓存读取 token；不完整的哈希（如仅有配额字段）或旧
// schema 的哈希会被拒绝。带周期预算的令牌始终回源数据库：预算窗口由数据库
// 权威维护，缓存的 PeriodUsed 可能落后于已提交窗口，不能用于放行判断。
func cacheGetTokenByKey(key string) (*Token, error) {
	if !common.RedisEnabled {
		return nil, fmt.Errorf("redis is not enabled")
	}
	var token Token
	if err := common.RedisHGetObj(getTokenCacheKey(key), &token); err != nil {
		return nil, err
	}
	if token.Id <= 0 || token.CacheSchema != tokenCacheSchemaVersion {
		return nil, fmt.Errorf("token cache is incomplete or stale")
	}
	if token.HasPeriodQuota() {
		return nil, fmt.Errorf("token with a periodic budget is served from the database")
	}
	token.Key = key
	mac, err := token.cacheMAC()
	if err != nil || !validAuthCacheMAC(mac, token.CacheMAC, token.CacheExpiresAt) {
		return nil, fmt.Errorf("token cache integrity check failed")
	}
	return &token, nil
}
