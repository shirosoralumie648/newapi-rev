package model

import (
	"context"
	"errors"
	"maps"
	"math"
	"slices"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"

	"github.com/bytedance/gopkg/util/gopool"
	"gorm.io/gorm"
)

const (
	BatchUpdateTypeUserQuota = iota
	BatchUpdateTypeTokenQuota
	BatchUpdateTypeUsedQuota
	BatchUpdateTypeChannelUsedQuota
	BatchUpdateTypeRequestCount
	BatchUpdateTypeCount // if you add a new type, you need to add a new map and a new lock
)

var batchUpdateStores []map[int]int
var batchUpdateLocks []sync.Mutex
var batchFlushLock sync.Mutex

func init() {
	for range BatchUpdateTypeCount {
		batchUpdateStores = append(batchUpdateStores, make(map[int]int))
		batchUpdateLocks = append(batchUpdateLocks, sync.Mutex{})
	}
}

// InitBatchUpdater starts the periodic batch writer and returns a channel that
// is closed once the writer has exited. Shutdown cancels ctx, waits for the
// returned channel, and then calls FlushBatchUpdate so no tick is in flight
// while the queue is drained.
func InitBatchUpdater(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	gopool.Go(func() {
		defer close(done)
		interval := time.Duration(common.BatchUpdateInterval) * time.Second
		if interval <= 0 {
			interval = time.Second
		}
		timer := time.NewTimer(interval)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				batchUpdate()
				timer.Reset(interval)
			}
		}
	})
	return done
}

func addNewRecord(type_ int, id int, value int) {
	batchUpdateLocks[type_].Lock()
	defer batchUpdateLocks[type_].Unlock()
	old, ok := batchUpdateStores[type_][id]
	if !ok {
		batchUpdateStores[type_][id] = value
		return
	}

	sum := old + value
	if (value > 0 && sum < old) || (value < 0 && sum > old) {
		common.SysError(common.LogText("batch update overflow: type=%d id=%d old=%d value=%d", type_, id, old, value))
		if value > 0 {
			sum = math.MaxInt
		} else {
			sum = math.MinInt
		}
	}
	batchUpdateStores[type_][id] = sum
}

// batchUpdate drains pending accounting deltas outside of shutdown. A failed
// pass keeps its deltas queued for the next pass instead of dropping them.
func batchUpdate() {
	// check if there's any data to update
	hasData := walletConsumeLedgerPending()
	for i := range BatchUpdateTypeCount {
		batchUpdateLocks[i].Lock()
		if len(batchUpdateStores[i]) > 0 {
			hasData = true
			batchUpdateLocks[i].Unlock()
			break
		}
		batchUpdateLocks[i].Unlock()
	}
	if !hasData {
		return
	}
	if err := flushBatchUpdateSnapshot(context.Background()); err != nil {
		common.SysError(common.LogText("batch update failed; pending entries are kept for the next pass: %s", err.Error()))
	}
}

// flushBatchUpdateSnapshot persists one snapshot of the queued deltas in a
// single transaction. The snapshot is merged back when the transaction fails
// so a later pass can retry it instead of losing accounting writes.
func flushBatchUpdateSnapshot(ctx context.Context) error {
	batchFlushLock.Lock()
	defer batchFlushLock.Unlock()

	stores := make([]map[int]int, BatchUpdateTypeCount)
	total := 0
	for i := range BatchUpdateTypeCount {
		batchUpdateLocks[i].Lock()
		stores[i] = batchUpdateStores[i]
		batchUpdateStores[i] = make(map[int]int)
		batchUpdateLocks[i].Unlock()
		total += len(stores[i])
	}
	if total == 0 {
		// Wallet consumption buckets can be the only pending data; flush them
		// here so callers still observe a committed snapshot.
		flushWalletConsumeLedgers()
		return nil
	}

	common.SysLog(common.LogText("batch update started"))
	err := DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Keys are sorted so concurrent writers (for example several master
		// nodes) acquire row locks in the same order and avoid deadlocks.
		tokenStore := stores[BatchUpdateTypeTokenQuota]
		for _, id := range slices.Sorted(maps.Keys(tokenStore)) {
			if err := increaseTokenQuota(tx, id, tokenStore[id]); err != nil {
				return err
			}
		}
		channelStore := stores[BatchUpdateTypeChannelUsedQuota]
		for _, id := range slices.Sorted(maps.Keys(channelStore)) {
			if err := updateChannelUsedQuota(tx, id, channelStore[id]); err != nil {
				return err
			}
		}
		userQuotaStore := stores[BatchUpdateTypeUserQuota]
		usedQuotaStore := stores[BatchUpdateTypeUsedQuota]
		requestCountStore := stores[BatchUpdateTypeRequestCount]
		userIDs := make(map[int]struct{}, len(userQuotaStore)+len(usedQuotaStore)+len(requestCountStore))
		for id := range userQuotaStore {
			userIDs[id] = struct{}{}
		}
		for id := range usedQuotaStore {
			userIDs[id] = struct{}{}
		}
		for id := range requestCountStore {
			userIDs[id] = struct{}{}
		}
		for _, id := range slices.Sorted(maps.Keys(userIDs)) {
			if err := updateUserQuotaUsedQuotaAndRequestCount(tx, id, userQuotaStore[id], usedQuotaStore[id], requestCountStore[id]); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		// Requeue the snapshot; addNewRecord saturates on overflow like the
		// original enqueue path.
		for i, store := range stores {
			for id, value := range store {
				addNewRecord(i, id, value)
			}
		}
		return err
	}
	// Consumption buckets are flushed after the wallet balances so each
	// consume_hourly row records the balance the flushed consumption implies.
	flushWalletConsumeLedgers()
	common.SysLog(common.LogText("batch update finished"))
	return nil
}

// FlushBatchUpdate drains every queued accounting delta to the database. It is
// meant to run during shutdown after HTTP handlers, refund goroutines, and the
// periodic writer stopped, so the queue has no active producers. A failed
// attempt keeps its deltas queued and is retried until ctx expires; on timeout
// the remaining entries are reported in the error and logged instead of being
// silently dropped.
func FlushBatchUpdate(ctx context.Context) error {
	var lastErr error
	for {
		if pendingBatchUpdateCount() == 0 {
			return nil
		}
		if err := ctx.Err(); err != nil {
			flushErr := errors.Join(lastErr, err)
			common.SysError(common.LogText("batch update flush incomplete: %d pending entries were not persisted: %s", pendingBatchUpdateCount(), flushErr.Error()))
			return flushErr
		}
		err := flushBatchUpdateSnapshot(ctx)
		if err == nil {
			continue
		}
		lastErr = err
		common.SysError(common.LogText("batch update flush failed; pending entries are kept for retry: %s", err.Error()))
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
}

// pendingBatchUpdateCount returns the number of queued delta entries.
func pendingBatchUpdateCount() int {
	pending := 0
	for i := range BatchUpdateTypeCount {
		batchUpdateLocks[i].Lock()
		pending += len(batchUpdateStores[i])
		batchUpdateLocks[i].Unlock()
	}
	return pending
}

// FlushBatchUpdates applies every queued batch update immediately. Callers that
// need a committed snapshot (wallet reconciliation, shutdown) use it instead of
// waiting for the periodic batch updater.
func FlushBatchUpdates() {
	batchUpdate()
}

func RecordExist(err error) (bool, error) {
	if err == nil {
		return true, nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	return false, err
}

func shouldUpdateRedis(fromDB bool, err error) bool {
	return common.RedisEnabled && fromDB && err == nil
}
