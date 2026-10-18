package model

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
)

func createReserveTestUser(t *testing.T, quota int) User {
	t.Helper()
	user := User{
		Username:    "reserve-user-" + common.GetRandomString(6),
		Password:    "unused-password-hash",
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
		Quota:       quota,
		AffCode:     "reserve-aff-" + common.GetRandomString(8),
	}
	require.NoError(t, DB.Create(&user).Error)
	return user
}

func createReserveTestToken(t *testing.T, remainQuota int) Token {
	t.Helper()
	token := Token{
		UserId:      1,
		Key:         "reserve-token-" + common.GetRandomString(8),
		Name:        "reserve-test",
		Status:      common.TokenStatusEnabled,
		ExpiredTime: -1,
		RemainQuota: remainQuota,
	}
	require.NoError(t, token.Insert())
	return token
}

func getUserQuotaFromDB(t *testing.T, id int) int {
	t.Helper()
	var user User
	require.NoError(t, DB.Select("quota").First(&user, id).Error)
	return user.Quota
}

func getTokenFromDB(t *testing.T, id int) Token {
	t.Helper()
	var token Token
	require.NoError(t, DB.First(&token, id).Error)
	return token
}

func resetBatchUpdateTestState(t *testing.T) {
	t.Helper()
	oldBatchEnabled := common.BatchUpdateEnabled
	common.BatchUpdateEnabled = false
	for i := range BatchUpdateTypeCount {
		batchUpdateLocks[i].Lock()
		batchUpdateStores[i] = make(map[int]int)
		batchUpdateLocks[i].Unlock()
	}
	t.Cleanup(func() {
		common.BatchUpdateEnabled = oldBatchEnabled
		for i := range BatchUpdateTypeCount {
			batchUpdateLocks[i].Lock()
			batchUpdateStores[i] = make(map[int]int)
			batchUpdateLocks[i].Unlock()
		}
	})
}

func TestTryReserveQuotaWithoutRedis(t *testing.T) {
	truncateTables(t)
	resetBatchUpdateTestState(t)

	user := createReserveTestUser(t, 100)
	reserved, err := TryReserveUserQuota(user.Id, 60, "")
	require.NoError(t, err)
	assert.True(t, reserved)
	assert.Equal(t, 40, getUserQuotaFromDB(t, user.Id))

	reserved, err = TryReserveUserQuota(user.Id, 41, "")
	require.NoError(t, err)
	assert.False(t, reserved)
	assert.Equal(t, 40, getUserQuotaFromDB(t, user.Id))

	token := createReserveTestToken(t, 80)
	reserved, err = TryReserveTokenQuota(token.Id, token.Key, 25, false, "")
	require.NoError(t, err)
	assert.True(t, reserved)
	reloaded := getTokenFromDB(t, token.Id)
	assert.Equal(t, 55, reloaded.RemainQuota)
	assert.Equal(t, 25, reloaded.UsedQuota)

	reserved, err = TryReserveTokenQuota(token.Id, token.Key, 56, false, "")
	require.NoError(t, err)
	assert.False(t, reserved)
	assert.Equal(t, 55, getTokenFromDB(t, token.Id).RemainQuota)
}

func TestRedisBatchReserveNeverFallsBackToStaleDatabaseBalance(t *testing.T) {
	truncateTables(t)
	resetBatchUpdateTestState(t)
	useUserCacheMiniRedis(t)
	common.BatchUpdateEnabled = true

	user := createReserveTestUser(t, 10)
	reserved, err := TryReserveUserQuota(user.Id, 8, "")
	require.NoError(t, err)
	assert.True(t, reserved)
	assert.Equal(t, 10, getUserQuotaFromDB(t, user.Id), "batch delta is not flushed yet")

	reserved, err = TryReserveUserQuota(user.Id, 3, "")
	require.NoError(t, err)
	assert.False(t, reserved, "stale DB balance must not authorize a second spend")
	cachedUser, err := GetUserCache(user.Id)
	require.NoError(t, err)
	assert.Equal(t, 2, cachedUser.Quota)

	token := createReserveTestToken(t, 9)
	reserved, err = TryReserveTokenQuota(token.Id, token.Key, 7, false, "")
	require.NoError(t, err)
	assert.True(t, reserved)
	reserved, err = TryReserveTokenQuota(token.Id, token.Key, 3, false, "")
	require.NoError(t, err)
	assert.False(t, reserved)
	assert.Equal(t, 9, getTokenFromDB(t, token.Id).RemainQuota)

	batchUpdate()
	assert.Equal(t, 2, getUserQuotaFromDB(t, user.Id))
	reloadedToken := getTokenFromDB(t, token.Id)
	assert.Equal(t, 2, reloadedToken.RemainQuota)
	assert.Equal(t, 7, reloadedToken.UsedQuota)
}

func TestBatchUpdateAccumulatesTwoMaximumRequestCharges(t *testing.T) {
	truncateTables(t)
	resetBatchUpdateTestState(t)
	common.BatchUpdateEnabled = true

	user := createReserveTestUser(t, common.MaxQuota*2+100)
	require.NoError(t, DecreaseUserQuota(user.Id, common.MaxQuota, false))
	require.NoError(t, DecreaseUserQuota(user.Id, common.MaxQuota, false))

	batchUpdate()
	assert.Equal(t, 100, getUserQuotaFromDB(t, user.Id))
}

func TestBatchUpdateAccumulatorSaturatesOverflow(t *testing.T) {
	resetBatchUpdateTestState(t)

	addNewRecord(BatchUpdateTypeUserQuota, 1, math.MaxInt)
	addNewRecord(BatchUpdateTypeUserQuota, 1, 1)
	batchUpdateLocks[BatchUpdateTypeUserQuota].Lock()
	assert.Equal(t, math.MaxInt, batchUpdateStores[BatchUpdateTypeUserQuota][1])
	batchUpdateLocks[BatchUpdateTypeUserQuota].Unlock()

	batchUpdateLocks[BatchUpdateTypeUserQuota].Lock()
	batchUpdateStores[BatchUpdateTypeUserQuota] = make(map[int]int)
	batchUpdateLocks[BatchUpdateTypeUserQuota].Unlock()
	addNewRecord(BatchUpdateTypeUserQuota, 1, math.MinInt)
	addNewRecord(BatchUpdateTypeUserQuota, 1, -1)
	batchUpdateLocks[BatchUpdateTypeUserQuota].Lock()
	assert.Equal(t, math.MinInt, batchUpdateStores[BatchUpdateTypeUserQuota][1])
	batchUpdateLocks[BatchUpdateTypeUserQuota].Unlock()
}

func TestReserveFallsBackToDatabaseWhenRedisIsUnavailable(t *testing.T) {
	truncateTables(t)
	resetBatchUpdateTestState(t)
	server := useUserCacheMiniRedis(t)

	user := createReserveTestUser(t, 20)
	require.NoError(t, populateUserCache(user))
	server.Close()

	// Redis 故障时降级为数据库条件更新：服务保持可用且不会超扣。
	reserved, err := TryReserveUserQuota(user.Id, 5, "")
	require.NoError(t, err)
	assert.True(t, reserved)
	assert.Equal(t, 15, getUserQuotaFromDB(t, user.Id))

	reserved, err = TryReserveUserQuota(user.Id, 16, "")
	require.NoError(t, err)
	assert.False(t, reserved)
	assert.Equal(t, 15, getUserQuotaFromDB(t, user.Id))
}

func TestSynchronousReserveCompensatesCacheWhenPersistenceFails(t *testing.T) {
	truncateTables(t)
	resetBatchUpdateTestState(t)
	useUserCacheMiniRedis(t)

	user := createReserveTestUser(t, 10)
	require.NoError(t, populateUserCache(user))
	require.NoError(t, DB.Delete(&user).Error)

	reserved, err := TryReserveUserQuota(user.Id, 6, "")
	assert.False(t, reserved)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
	cached, cacheErr := cacheGetUserBase(user.Id)
	require.NoError(t, cacheErr)
	assert.Equal(t, 10, cached.Quota)

	token := createReserveTestToken(t, 12)
	_, err = GetTokenByKey(token.Key, true)
	require.NoError(t, err)
	require.NoError(t, DB.Delete(&token).Error)
	reserved, err = TryReserveTokenQuota(token.Id, token.Key, 7, false, "")
	assert.False(t, reserved)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
	cachedToken, cacheErr := cacheGetTokenByKey(token.Key)
	require.NoError(t, cacheErr)
	assert.Equal(t, 12, cachedToken.RemainQuota)
	assert.Zero(t, cachedToken.UsedQuota)
}

func TestTokenCacheInitPreservesLiveQuotaAndFenceBlocksStaleSnapshot(t *testing.T) {
	truncateTables(t)
	resetBatchUpdateTestState(t)
	server := useUserCacheMiniRedis(t)

	token := createReserveTestToken(t, 100)
	loaded, err := GetTokenByKey(token.Key, true)
	require.NoError(t, err)
	stale := *loaded

	result, err := cacheApplyTokenQuotaDelta(token.Id, token.Key, -70)
	require.NoError(t, err)
	require.Equal(t, cacheQuotaOK, result)

	// 已存在的哈希只刷新 TTL：数据库快照不得覆盖已被原子预扣的余额。
	code, err := cacheInitToken(stale)
	require.NoError(t, err)
	assert.Equal(t, 2, code)
	cached, err := cacheGetTokenByKey(token.Key)
	require.NoError(t, err)
	assert.Equal(t, 30, cached.RemainQuota)

	// 变更期间：fence 删除缓存并拦截并发读者手中的过期快照。
	require.NoError(t, invalidateTokenCacheForMutation(token.Key))
	code, err = cacheInitToken(stale)
	require.NoError(t, err)
	assert.Zero(t, code, "the pre-mutation snapshot must not be published while fenced")
	_, err = cacheGetTokenByKey(token.Key)
	assert.Error(t, err)

	// fence 过期后可重新从数据库水合。
	server.FastForward(time.Duration(tokenCacheFenceSeconds+1) * time.Second)
	fresh, err := GetTokenByKey(token.Key, false)
	require.NoError(t, err)
	assert.Equal(t, 100, fresh.RemainQuota)
	cached, err = cacheGetTokenByKey(token.Key)
	require.NoError(t, err)
	assert.Equal(t, 100, cached.RemainQuota)
}

// TestTokenCacheSchemaAndPeriodBudgetGovernCachedReads 保护两项缓存契约：
// 旧 schema 的哈希既不能被读取也不能被续期，只等待自然过期后重建；
// 周期预算令牌始终回源数据库，Redis 预扣不会触碰它的余额。
func TestTokenCacheSchemaAndPeriodBudgetGovernCachedReads(t *testing.T) {
	truncateTables(t)
	resetBatchUpdateTestState(t)
	server := useUserCacheMiniRedis(t)

	token := createReserveTestToken(t, 100)
	loaded, err := GetTokenByKey(token.Key, true)
	require.NoError(t, err)
	server.HSet(getTokenCacheKey(token.Key), "CacheSchema", "1")

	_, err = cacheGetTokenByKey(token.Key)
	require.Error(t, err, "a stale hash must not be served")
	code, err := cacheInitToken(*loaded)
	require.NoError(t, err)
	assert.Equal(t, 3, code, "a stale hash must not get its TTL refreshed")

	// 自然过期（这里显式删除）后由下一次读取按当前 schema 重建。
	require.NoError(t, common.RDB.Del(context.Background(), getTokenCacheKey(token.Key)).Err())
	reloaded, err := GetTokenByKey(token.Key, false)
	require.NoError(t, err)
	assert.Equal(t, 100, reloaded.RemainQuota)
	cached, err := cacheGetTokenByKey(token.Key)
	require.NoError(t, err, "the rebuilt hash must serve reads again")
	assert.Equal(t, 100, cached.RemainQuota)

	periodToken := createReserveTestPeriodToken(t, 100, false, 50, TokenPeriodDaily)
	_, err = GetTokenByKey(periodToken.Key, true)
	require.NoError(t, err)
	_, err = cacheGetTokenByKey(periodToken.Key)
	require.Error(t, err, "a periodic token must not be served from the cache")

	reserved, err := TryReserveTokenQuota(periodToken.Id, periodToken.Key, 30, false, TokenPeriodDaily)
	require.NoError(t, err)
	require.True(t, reserved)
	assert.Equal(t, 70, getTokenFromDB(t, periodToken.Id).RemainQuota)
	cachedRemain, err := common.RDB.HGet(context.Background(), getTokenCacheKey(periodToken.Key), "RemainQuota").Result()
	require.NoError(t, err)
	assert.Equal(t, "100", cachedRemain, "the cache must not be the reserve path for periodic tokens")
}

// isolatedAccountingTestDB opens an isolated database for accounting tests
// (shutdown flush matrix, token quota adjustment matrix) and swaps it into
// model.DB for the duration of the test.
func isolatedAccountingTestDB(t *testing.T, dialect string) *gorm.DB {
	t.Helper()
	var driver gorm.Dialector
	switch dialect {
	case "mysql":
		dsn := os.Getenv("TEST_MYSQL_DSN")
		if dsn == "" {
			t.Skip("TEST_MYSQL_DSN is not configured")
		}
		driver = mysql.Open(dsn)
	case "postgres":
		dsn := os.Getenv("TEST_POSTGRES_DSN")
		if dsn == "" {
			t.Skip("TEST_POSTGRES_DSN is not configured")
		}
		driver = postgres.Open(dsn)
	default:
		driver = sqlite.Open(filepath.Join(t.TempDir(), "accounting.db"))
	}
	prefix := fmt.Sprintf("accounting_%d_", os.Getpid())
	db, err := gorm.Open(driver, &gorm.Config{
		NamingStrategy: schema.NamingStrategy{TablePrefix: prefix},
		Logger:         gormlogger.Default.LogMode(gormlogger.Silent),
	})
	require.NoError(t, err)
	if dialect == "sqlite" {
		sqlDB, err := db.DB()
		require.NoError(t, err)
		sqlDB.SetMaxOpenConns(1)
	}
	previous := DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	common.SetDatabaseTypes(common.DatabaseType(dialect), previousLog)
	DB = db
	// The reserved-word quoting and boolean literals of the raw SQL helpers
	// follow the active dialect, so they must be rebuilt for this database.
	initCol()
	t.Cleanup(func() {
		require.NoError(t, db.Migrator().DropTable(&User{}, &Token{}, &Channel{}, &CreditGrant{}, &ReferralBinding{},
			&ReferralRegistrationSignal{}, &ReferralIdentity{}, &ReferralFlag{}))
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
		DB = previous
		common.SetDatabaseTypes(previousMain, previousLog)
		initCol()
	})
	require.NoError(t, db.AutoMigrate(&User{}, &Token{}, &Channel{}, &CreditGrant{}, &ReferralBinding{},
		&ReferralRegistrationSignal{}, &ReferralIdentity{}, &ReferralFlag{}))
	var version string
	versionQuery := "SELECT version()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("database version (%s): %s", dialect, version)
	return db
}

func TestBatchUpdateShutdownFlushMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			isolatedAccountingTestDB(t, dialect)
			resetBatchUpdateTestState(t)
			common.BatchUpdateEnabled = true

			user := createReserveTestUser(t, 1000)
			token := createReserveTestToken(t, 1000)
			channel := Channel{Name: "flush-channel-" + common.GetRandomString(6), Key: "sk-flush", Status: common.ChannelStatusEnabled}
			require.NoError(t, DB.Create(&channel).Error)

			require.NoError(t, DecreaseUserQuota(user.Id, 300, false))
			UpdateUserUsedQuotaAndRequestCount(user.Id, 300)
			require.NoError(t, DecreaseTokenQuota(token.Id, token.Key, 200))
			UpdateChannelUsedQuota(channel.Id, 300)

			// Deltas stay queued until a flush runs.
			assert.Equal(t, 1000, getUserQuotaFromDB(t, user.Id))
			assert.Equal(t, 1000, getTokenFromDB(t, token.Id).RemainQuota)
			var reloadedChannel Channel
			require.NoError(t, DB.First(&reloadedChannel, channel.Id).Error)
			assert.Zero(t, reloadedChannel.UsedQuota)

			flushCtx, cancelFlush := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancelFlush()
			require.NoError(t, FlushBatchUpdate(flushCtx))

			var reloadedUser User
			require.NoError(t, DB.First(&reloadedUser, user.Id).Error)
			assert.Equal(t, 700, reloadedUser.Quota)
			assert.Equal(t, 300, reloadedUser.UsedQuota)
			assert.Equal(t, 1, reloadedUser.RequestCount)
			reloadedToken := getTokenFromDB(t, token.Id)
			assert.Equal(t, 800, reloadedToken.RemainQuota)
			assert.Equal(t, 200, reloadedToken.UsedQuota)
			require.NoError(t, DB.First(&reloadedChannel, channel.Id).Error)
			assert.Equal(t, int64(300), reloadedChannel.UsedQuota)

			// An empty flush must not replay the previous deltas.
			require.NoError(t, FlushBatchUpdate(context.Background()))
			assert.Equal(t, 700, getUserQuotaFromDB(t, user.Id))

			// Deltas queued after the first flush are drained as well.
			require.NoError(t, DecreaseUserQuota(user.Id, 50, false))
			UpdateUserUsedQuota(user.Id, 25)
			require.NoError(t, FlushBatchUpdate(context.Background()))
			require.NoError(t, DB.First(&reloadedUser, user.Id).Error)
			assert.Equal(t, 650, reloadedUser.Quota)
			assert.Equal(t, 325, reloadedUser.UsedQuota)
		})
	}
}

func TestFlushBatchUpdateTimeoutLogsAndRetainsDeltas(t *testing.T) {
	truncateTables(t)
	resetBatchUpdateTestState(t)
	common.BatchUpdateEnabled = true

	user := createReserveTestUser(t, 1000)
	require.NoError(t, DecreaseUserQuota(user.Id, 100, false))
	UpdateUserUsedQuota(user.Id, 100)

	// Fail every user-row update so the flush attempt retains its deltas.
	injected := errors.New("injected batch flush failure")
	const callback = "test:wl02_batch_flush_failure"
	require.NoError(t, DB.Callback().Update().Before("gorm:update").Register(callback, func(tx *gorm.DB) {
		if tx.Statement.Table == "users" {
			tx.AddError(injected)
		}
	}))
	t.Cleanup(func() { _ = DB.Callback().Update().Remove(callback) })

	var logs bytes.Buffer
	previousWriter := gin.DefaultErrorWriter
	gin.DefaultErrorWriter = &logs
	t.Cleanup(func() { gin.DefaultErrorWriter = previousWriter })

	timeoutCtx, cancelTimeout := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancelTimeout()
	flushErr := FlushBatchUpdate(timeoutCtx)
	require.ErrorIs(t, flushErr, context.DeadlineExceeded)
	require.ErrorIs(t, flushErr, injected)
	assert.Contains(t, logs.String(), "batch update flush failed; pending entries are kept for retry")
	assert.Contains(t, logs.String(), "batch update flush incomplete")

	// The retained deltas are persisted by the next flush.
	require.NoError(t, DB.Callback().Update().Remove(callback))
	require.NoError(t, FlushBatchUpdate(context.Background()))
	var reloadedUser User
	require.NoError(t, DB.First(&reloadedUser, user.Id).Error)
	assert.Equal(t, 900, reloadedUser.Quota)
	assert.Equal(t, 100, reloadedUser.UsedQuota)
}

func TestTokenQuotaUpdatePreservesConcurrentDeductions(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			isolatedAccountingTestDB(t, dialect)
			resetBatchUpdateTestState(t)

			for _, tc := range []struct {
				name            string
				target          int
				wantRemain      int
				wantQuotaChange bool
			}{
				{name: "unchanged target keeps the deduction", target: 100, wantRemain: 70},
				{name: "raised target applies only the difference", target: 200, wantRemain: 170, wantQuotaChange: true},
				{name: "lowered target applies only the difference", target: 40, wantRemain: 10, wantQuotaChange: true},
			} {
				t.Run(tc.name, func(t *testing.T) {
					token := createReserveTestToken(t, 100)
					snapshot := token.RemainQuota

					// A relay deduction commits after the operator's snapshot.
					reserved, err := TryReserveTokenQuota(token.Id, token.Key, 30, false, "")
					require.NoError(t, err)
					require.True(t, reserved)
					require.Equal(t, 70, getTokenFromDB(t, token.Id).RemainQuota)

					token.RemainQuota = tc.target
					token.Name = "renamed-" + dialect
					change, err := token.UpdateWithQuotaTarget(snapshot)
					require.NoError(t, err)

					saved := getTokenFromDB(t, token.Id)
					assert.Equal(t, "renamed-"+dialect, saved.Name)
					assert.Equal(t, 30, saved.UsedQuota, "the concurrent deduction must stay recorded as usage")
					assert.Equal(t, tc.wantRemain, saved.RemainQuota)
					if !tc.wantQuotaChange {
						assert.Nil(t, change)
						return
					}
					require.NotNil(t, change)
					assert.Equal(t, 70, change.Before)
					assert.Equal(t, tc.wantRemain, change.After)
				})
			}
		})
	}
}

func createReserveTestPeriodToken(t *testing.T, remainQuota int, unlimited bool, periodQuota int, resetPeriod string) Token {
	t.Helper()
	token := Token{
		UserId:            1,
		Key:               "reserve-period-token-" + common.GetRandomString(8),
		Name:              "reserve-period-test",
		Status:            common.TokenStatusEnabled,
		ExpiredTime:       -1,
		RemainQuota:       remainQuota,
		UnlimitedQuota:    unlimited,
		PeriodQuota:       periodQuota,
		PeriodResetPeriod: resetPeriod,
	}
	require.NoError(t, token.Insert())
	return token
}

// TestTokenPeriodQuotaBudgetMatrix 保护周期预算的核心契约：预算与余额同时
// 生效、窗口过期后惰性重置、结算退还/补扣同步维护本窗口用量、配置更新
// 确定性地保留或清零窗口。矩阵覆盖 SQLite 与 CI 中的 MySQL/PostgreSQL。
func TestTokenPeriodQuotaBudgetMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			isolatedAccountingTestDB(t, dialect)
			resetBatchUpdateTestState(t)

			windowStart := TokenPeriodWindowStart(TokenPeriodDaily, common.GetTimestamp())

			t.Run("the period budget limits reserves on top of the balance", func(t *testing.T) {
				token := createReserveTestPeriodToken(t, 1000, false, 100, TokenPeriodDaily)

				reserved, err := TryReserveTokenQuota(token.Id, token.Key, 60, token.UnlimitedQuota, token.PeriodResetPeriod)
				require.NoError(t, err)
				require.True(t, reserved)
				saved := getTokenFromDB(t, token.Id)
				assert.Equal(t, 940, saved.RemainQuota)
				assert.Equal(t, 60, saved.UsedQuota)
				assert.Equal(t, 60, saved.PeriodUsed)
				assert.Equal(t, windowStart, saved.PeriodWindowStart)

				// The balance alone would admit this reserve; the budget must not.
				reserved, err = TryReserveTokenQuota(token.Id, token.Key, 50, token.UnlimitedQuota, token.PeriodResetPeriod)
				require.NoError(t, err)
				assert.False(t, reserved)
				saved = getTokenFromDB(t, token.Id)
				assert.Equal(t, 940, saved.RemainQuota)
				assert.Equal(t, 60, saved.PeriodUsed)
			})

			t.Run("an expired window resets lazily on the next reserve", func(t *testing.T) {
				token := createReserveTestPeriodToken(t, 1000, false, 100, TokenPeriodDaily)
				require.NoError(t, DB.Model(&Token{}).Where("id = ?", token.Id).Updates(map[string]any{
					"period_used":         100,
					"period_window_start": windowStart - 7*86400,
				}).Error)

				reserved, err := TryReserveTokenQuota(token.Id, token.Key, 40, token.UnlimitedQuota, token.PeriodResetPeriod)
				require.NoError(t, err)
				require.True(t, reserved)
				saved := getTokenFromDB(t, token.Id)
				assert.Equal(t, 40, saved.PeriodUsed)
				assert.Equal(t, windowStart, saved.PeriodWindowStart)
			})

			t.Run("unlimited tokens still enforce the period budget", func(t *testing.T) {
				token := createReserveTestPeriodToken(t, 0, true, 50, TokenPeriodDaily)

				reserved, err := TryReserveTokenQuota(token.Id, token.Key, 30, token.UnlimitedQuota, token.PeriodResetPeriod)
				require.NoError(t, err)
				require.True(t, reserved)
				reserved, err = TryReserveTokenQuota(token.Id, token.Key, 30, token.UnlimitedQuota, token.PeriodResetPeriod)
				require.NoError(t, err)
				assert.False(t, reserved)
				saved := getTokenFromDB(t, token.Id)
				assert.Equal(t, -30, saved.RemainQuota)
				assert.Equal(t, 30, saved.PeriodUsed)
			})

			t.Run("refunds and top-ups settle against the current period", func(t *testing.T) {
				token := createReserveTestPeriodToken(t, 1000, false, 100, TokenPeriodDaily)
				_, err := TryReserveTokenQuota(token.Id, token.Key, 60, false, TokenPeriodDaily)
				require.NoError(t, err)

				require.NoError(t, IncreaseTokenQuota(token.Id, token.Key, 20))
				assert.Equal(t, 40, getTokenFromDB(t, token.Id).PeriodUsed)

				require.NoError(t, DecreaseTokenQuota(token.Id, token.Key, 5))
				assert.Equal(t, 45, getTokenFromDB(t, token.Id).PeriodUsed)

				// A refund never pushes the recorded usage below zero.
				require.NoError(t, IncreaseTokenQuota(token.Id, token.Key, 100))
				assert.Zero(t, getTokenFromDB(t, token.Id).PeriodUsed)
			})

			t.Run("token validation reports the exhausted period budget", func(t *testing.T) {
				token := createReserveTestPeriodToken(t, 1000, false, 30, TokenPeriodDaily)
				_, err := TryReserveTokenQuota(token.Id, token.Key, 30, false, TokenPeriodDaily)
				require.NoError(t, err)

				_, err = ValidateUserToken(token.Key)
				require.ErrorIs(t, err, ErrTokenPeriodQuotaExhausted)

				// Reads of the next window start fresh without a write, and the
				// following reserve recharges the window.
				require.NoError(t, DB.Model(&Token{}).Where("id = ?", token.Id).Update("period_window_start", windowStart-7*86400).Error)
				validated, err := ValidateUserToken(token.Key)
				require.NoError(t, err)
				require.NotNil(t, validated)

				reserved, err := TryReserveTokenQuota(token.Id, token.Key, 10, false, TokenPeriodDaily)
				require.NoError(t, err)
				assert.True(t, reserved)
				assert.Equal(t, 10, getTokenFromDB(t, token.Id).PeriodUsed)
			})

			t.Run("configuration updates reset or keep the window deterministically", func(t *testing.T) {
				token := createReserveTestPeriodToken(t, 1000, false, 100, TokenPeriodDaily)
				_, err := TryReserveTokenQuota(token.Id, token.Key, 60, false, TokenPeriodDaily)
				require.NoError(t, err)

				// Same cycle: the window and the usage accumulated during it survive
				// a quota change.
				token.PeriodQuota = 200
				_, err = token.UpdateWithQuotaTarget(getTokenFromDB(t, token.Id).RemainQuota)
				require.NoError(t, err)
				saved := getTokenFromDB(t, token.Id)
				assert.Equal(t, 200, saved.PeriodQuota)
				assert.Equal(t, 60, saved.PeriodUsed)
				assert.Equal(t, windowStart, saved.PeriodWindowStart)

				// A changed cycle restarts usage inside the new cycle's window.
				token.PeriodResetPeriod = TokenPeriodMonthly
				token.PeriodQuota = 100
				_, err = token.UpdateWithQuotaTarget(getTokenFromDB(t, token.Id).RemainQuota)
				require.NoError(t, err)
				saved = getTokenFromDB(t, token.Id)
				assert.Zero(t, saved.PeriodUsed)
				assert.Equal(t, TokenPeriodWindowStart(TokenPeriodMonthly, common.GetTimestamp()), saved.PeriodWindowStart)

				// Disabling the budget clears the window state.
				token.PeriodQuota = 0
				token.PeriodResetPeriod = ""
				_, err = token.UpdateWithQuotaTarget(getTokenFromDB(t, token.Id).RemainQuota)
				require.NoError(t, err)
				saved = getTokenFromDB(t, token.Id)
				assert.Zero(t, saved.PeriodQuota)
				assert.Empty(t, saved.PeriodResetPeriod)
				assert.Zero(t, saved.PeriodUsed)
				assert.Zero(t, saved.PeriodWindowStart)
			})
		})
	}
}
