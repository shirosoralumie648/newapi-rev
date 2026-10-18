package admission

import (
	"context"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// useMemoryAdmission forces the in-process counter store for the duration of
// one test.
func useMemoryAdmission(t *testing.T) {
	t.Helper()
	previousEnabled := common.RedisEnabled
	previousClient := common.RDB
	common.RedisEnabled = false
	common.RDB = nil
	t.Cleanup(func() {
		common.RedisEnabled = previousEnabled
		common.RDB = previousClient
	})
}

// useAdmissionMiniRedis points the package's shared Redis handles at a
// miniredis instance for the duration of one test.
func useAdmissionMiniRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()
	previousEnabled := common.RedisEnabled
	previousClient := common.RDB
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	require.NoError(t, client.Ping(context.Background()).Err())

	common.RedisEnabled = true
	common.RDB = client
	t.Cleanup(func() {
		_ = client.Close()
		common.RedisEnabled = previousEnabled
		common.RDB = previousClient
	})

	return server, client
}

func TestAcquireWithoutLimitsIsUntracked(t *testing.T) {
	useMemoryAdmission(t)

	lease, reason := Acquire(SubjectKey("channel", 9901), Limits{}, 500)
	assert.Nil(t, lease)
	assert.Empty(t, reason)
}

func TestMemoryAdmissionEnforcesEachLimit(t *testing.T) {
	useMemoryAdmission(t)

	t.Run("concurrency", func(t *testing.T) {
		key := SubjectKey("channel", 9902)
		limits := Limits{MaxConcurrency: 1}

		first, reason := Acquire(key, limits, 0)
		require.NotNil(t, first)
		assert.Empty(t, reason)

		second, reason := Acquire(key, limits, 0)
		assert.Nil(t, second)
		assert.Equal(t, RejectConcurrency, reason)

		first.Release()
		third, reason := Acquire(key, limits, 0)
		require.NotNil(t, third)
		assert.Empty(t, reason)
		third.Release()
	})

	t.Run("rpm", func(t *testing.T) {
		key := SubjectKey("channel", 9903)
		limits := Limits{RPMLimit: 2}

		first, reason := Acquire(key, limits, 0)
		require.NotNil(t, first)
		second, reason := Acquire(key, limits, 0)
		require.NotNil(t, second)

		third, reason := Acquire(key, limits, 0)
		assert.Nil(t, third)
		assert.Equal(t, RejectRPM, reason)

		// Releasing an attempt must not return its request count.
		first.Release()
		second.Release()
		fourth, reason := Acquire(key, limits, 0)
		assert.Nil(t, fourth)
		assert.Equal(t, RejectRPM, reason)
	})

	t.Run("tpm", func(t *testing.T) {
		key := SubjectKey("channel", 9904)
		limits := Limits{TPMLimit: 100}

		first, reason := Acquire(key, limits, 60)
		require.NotNil(t, first)
		assert.Empty(t, reason)

		// The estimate alone pushes the window over the limit.
		second, reason := Acquire(key, limits, 50)
		assert.Nil(t, second)
		assert.Equal(t, RejectTPM, reason)

		// Settlement corrects the reservation downwards.
		first.Settle(20)
		first.Release()
		third, reason := Acquire(key, limits, 70)
		require.NotNil(t, third)
		assert.Empty(t, reason)

		fourth, reason := Acquire(key, limits, 20)
		assert.Nil(t, fourth)
		assert.Equal(t, RejectTPM, reason)
	})

	t.Run("rollback returns the reservation", func(t *testing.T) {
		key := SubjectKey("channel", 9905)
		limits := Limits{TPMLimit: 100}

		first, reason := Acquire(key, limits, 90)
		require.NotNil(t, first)
		first.Rollback()

		second, reason := Acquire(key, limits, 90)
		require.NotNil(t, second)
		assert.Empty(t, reason)
		second.Rollback()
	})

	t.Run("settlement never returns capacity", func(t *testing.T) {
		key := SubjectKey("channel", 9906)
		limits := Limits{TPMLimit: 100}

		first, reason := Acquire(key, limits, 40)
		require.NotNil(t, first)
		// The actual usage exceeded the estimate: it stays counted.
		first.Settle(100)
		first.Release()

		second, reason := Acquire(key, limits, 1)
		assert.Nil(t, second)
		assert.Equal(t, RejectTPM, reason)
	})
}

func TestStoreLeaseRetiresPreviousAttempt(t *testing.T) {
	useMemoryAdmission(t)
	c, _ := gin.CreateTestContext(nil)

	limits := Limits{MaxConcurrency: 1}
	firstKey := SubjectKey("token", 9907)
	secondKey := SubjectKey("token", 9908)

	first, reason := Acquire(firstKey, limits, 0)
	require.NotNil(t, first)
	assert.Empty(t, reason)
	StoreLease(c, TokenLeaseContextKey, first)

	second, reason := Acquire(secondKey, limits, 0)
	require.NotNil(t, second)
	assert.Empty(t, reason)
	StoreLease(c, TokenLeaseContextKey, second)

	// The replaced attempt must no longer hold its slot.
	reusable, reason := Acquire(firstKey, limits, 0)
	require.NotNil(t, reusable)
	assert.Empty(t, reason)
	reusable.Release()

	ReleaseLeases(c)
	retry, reason := Acquire(secondKey, limits, 0)
	require.NotNil(t, retry)
	assert.Empty(t, reason)
	retry.Release()
	ReleaseLeases(c) // idempotent
}

func TestSettleLeaseCorrectsStoredReservation(t *testing.T) {
	useMemoryAdmission(t)
	c, _ := gin.CreateTestContext(nil)

	key := SubjectKey("token", 9909)
	limits := Limits{TPMLimit: 100}

	lease, reason := Acquire(key, limits, 80)
	require.NotNil(t, lease)
	assert.Empty(t, reason)
	StoreLease(c, TokenLeaseContextKey, lease)

	SettleLease(c, TokenLeaseContextKey, 30)
	next, reason := Acquire(key, limits, 70) // 30 + 70 = 100
	require.NotNil(t, next)
	assert.Empty(t, reason)
	next.Rollback()

	// A second settlement is a no-op, so the corrected count stays.
	SettleLease(c, TokenLeaseContextKey, 10)
	still, reason := Acquire(key, limits, 90) // 30 + 90 > 100
	assert.Nil(t, still)
	assert.Equal(t, RejectTPM, reason)
}

func TestRedisAdmissionEnforcesLimits(t *testing.T) {
	_, client := useAdmissionMiniRedis(t)

	t.Run("concurrency", func(t *testing.T) {
		key := SubjectKey("channel", 9911)
		limits := Limits{MaxConcurrency: 1}

		first, reason := Acquire(key, limits, 0)
		require.NotNil(t, first)
		assert.Empty(t, reason)

		second, reason := Acquire(key, limits, 0)
		assert.Nil(t, second)
		assert.Equal(t, RejectConcurrency, reason)

		first.Release()
		third, reason := Acquire(key, limits, 0)
		require.NotNil(t, third)
		assert.Empty(t, reason)
		third.Release()
	})

	t.Run("rpm", func(t *testing.T) {
		key := SubjectKey("channel", 9912)
		limits := Limits{RPMLimit: 1}

		first, reason := Acquire(key, limits, 0)
		require.NotNil(t, first)
		assert.Empty(t, reason)
		first.Release()

		second, reason := Acquire(key, limits, 0)
		assert.Nil(t, second)
		assert.Equal(t, RejectRPM, reason)
	})

	t.Run("tpm settle correction", func(t *testing.T) {
		key := SubjectKey("channel", 9913)
		limits := Limits{TPMLimit: 100}

		first, reason := Acquire(key, limits, 80)
		require.NotNil(t, first)
		first.Settle(30)
		first.Release()

		stored, err := client.Get(context.Background(), first.tpmKey()).Int()
		require.NoError(t, err)
		assert.Equal(t, 30, stored)

		next, reason := Acquire(key, limits, 70) // 30 + 70 = 100
		require.NotNil(t, next)
		assert.Empty(t, reason)
		next.Rollback()

		stored, err = client.Get(context.Background(), first.tpmKey()).Int()
		require.NoError(t, err)
		assert.Equal(t, 30, stored)
	})
}

func TestRedisAdmissionFailsOpenWhenBackendIsDown(t *testing.T) {
	server, _ := useAdmissionMiniRedis(t)
	server.Close()

	lease, reason := Acquire(SubjectKey("channel", 9914), Limits{MaxConcurrency: 1}, 10)
	assert.Nil(t, lease)
	assert.Empty(t, reason)
}
