// Package admission implements the capacity admission of one upstream
// dispatch: an in-flight concurrency slot, a per-minute request count (RPM) and
// a per-minute token reservation (TPM). Redis backs the counters when it is
// configured; an in-process fixed-window store keeps the same semantics
// otherwise. Zero limits mean unlimited, so a deployment that never configures
// a limit performs no admission at all. Counter backend failures fail open
// instead of blocking traffic, matching the rate-limit policy of the gateway.
package admission

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
)

// Window is the fixed rate window shared by the RPM and TPM counters.
const Window = time.Minute

const (
	// leaseTTL bounds how long an admitted dispatch may hold its concurrency
	// slot, so a crashed process cannot leak a slot forever.
	leaseTTL = 30 * time.Minute
	// windowKeyTTL is how long a fixed-window counter stays in Redis after its
	// last write. Two windows cover clock skew between instances.
	windowKeyTTL = 2 * Window
	windowMillis = int64(Window / time.Millisecond)
)

// Limits are one admission subject's limits. Zero values mean unlimited.
type Limits struct {
	MaxConcurrency int
	RPMLimit       int
	TPMLimit       int
}

// RejectReason names the limit that rejected an admission.
type RejectReason string

const (
	RejectConcurrency RejectReason = "concurrency"
	RejectRPM         RejectReason = "rpm"
	RejectTPM         RejectReason = "tpm"
)

// SubjectKey returns the counter key prefix of one admission subject, for
// example "admission:channel:12" or "admission:token:34".
func SubjectKey(scope string, id int) string {
	return "admission:" + scope + ":" + strconv.Itoa(id)
}

// Lease is one admitted dispatch. When the dispatch finishes exactly one of
// Settle plus Release/Rollback must run; every transition is idempotent so a
// retried request may retire an attempt twice.
type Lease struct {
	mu       sync.Mutex
	key      string
	id       string
	client   *redis.Client
	memory   *memorySubject
	window   int64
	reserved int
	// tracksTokens reports whether the lease reserved TPM capacity. A lease
	// without a reservation never touches the token counter.
	tracksTokens bool
	settled      bool
	completed    bool
}

var leaseCounter atomic.Uint64

// leasePrefix makes lease ids unique across processes sharing one Redis.
var leasePrefix = common.GetRandomString(8)

func nextLeaseID() string {
	return leasePrefix + "-" + strconv.FormatUint(leaseCounter.Add(1), 36)
}

// Acquire reserves capacity on the given subject. A nil lease with an empty
// reason means the dispatch may proceed untracked: no limit is configured or
// the counter backend failed (fail-open).
func Acquire(key string, limits Limits, estimatedTokens int) (*Lease, RejectReason) {
	if limits.MaxConcurrency <= 0 && limits.RPMLimit <= 0 && limits.TPMLimit <= 0 {
		return nil, ""
	}
	if estimatedTokens < 0 {
		estimatedTokens = 0
	}
	now := time.Now()
	lease := &Lease{
		key:          key,
		id:           nextLeaseID(),
		window:       now.UnixMilli() / windowMillis,
		reserved:     estimatedTokens,
		tracksTokens: limits.TPMLimit > 0 && estimatedTokens > 0,
	}
	if common.RedisEnabled && common.RDB != nil {
		reason, err := acquireRedis(common.RDB, lease, limits)
		if err != nil {
			common.SysError(common.LogText("admission backend error, allowing request: %s", err.Error()))
			return nil, ""
		}
		if reason != "" {
			return nil, reason
		}
		lease.client = common.RDB
		return lease, ""
	}
	if reason := acquireMemory(lease, limits, now); reason != "" {
		return nil, reason
	}
	return lease, ""
}

// Settle corrects the token reservation to the actual usage of the dispatch.
// It is a no-op for a lease that never reserved tokens.
func (l *Lease) Settle(actualTokens int) {
	if l == nil || !l.tracksTokens {
		return
	}
	if actualTokens < 0 {
		actualTokens = 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.settled || l.completed {
		return
	}
	l.settled = true
	if delta := actualTokens - l.reserved; delta != 0 {
		l.adjustTokensLocked(delta)
	}
}

// Release frees the concurrency slot after a settled dispatch.
func (l *Lease) Release() {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.completed {
		return
	}
	l.completed = true
	l.releaseConcurrencyLocked()
}

// Rollback retires an attempt that never settled: the concurrency slot is
// freed and an unsettled token estimate is returned to the counter.
func (l *Lease) Rollback() {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.completed {
		return
	}
	if l.tracksTokens && !l.settled {
		l.settled = true
		l.adjustTokensLocked(-l.reserved)
	}
	l.completed = true
	l.releaseConcurrencyLocked()
}

func (l *Lease) releaseConcurrencyLocked() {
	if l.client != nil {
		if err := l.client.ZRem(context.Background(), l.concurrencyKey(), l.id).Err(); err != nil {
			common.SysError(common.LogText("failed to release admission concurrency slot: %s", err.Error()))
		}
		return
	}
	if l.memory == nil {
		return
	}
	memoryStore.Lock()
	defer memoryStore.Unlock()
	delete(l.memory.concurrency, l.id)
}

func (l *Lease) adjustTokensLocked(delta int) {
	if l.client != nil {
		ctx := context.Background()
		if err := l.client.IncrBy(ctx, l.tpmKey(), int64(delta)).Err(); err != nil {
			common.SysError(common.LogText("failed to settle admission token reservation: %s", err.Error()))
			return
		}
		if err := l.client.Expire(ctx, l.tpmKey(), windowKeyTTL).Err(); err != nil {
			common.SysError(common.LogText("failed to expire admission token counter: %s", err.Error()))
		}
		return
	}
	if l.memory == nil {
		return
	}
	memoryStore.Lock()
	defer memoryStore.Unlock()
	if l.memory.tpmWindow != l.window {
		return
	}
	l.memory.tpmCount += delta
	if l.memory.tpmCount < 0 {
		l.memory.tpmCount = 0
	}
}

func (l *Lease) concurrencyKey() string {
	return l.key + ":concurrency"
}

func (l *Lease) rpmKey(window int64) string {
	return l.key + ":rpm:" + strconv.FormatInt(window, 10)
}

func (l *Lease) tpmKey() string {
	return l.key + ":tpm:" + strconv.FormatInt(l.window, 10)
}

// acquireScript checks all three limits and reserves the dispatch atomically,
// so a race between check and reserve cannot over-admit.
// KEYS: concurrency zset, rpm counter, tpm counter.
// ARGV: now_ms, lease_id, lease_deadline_ms, max_concurrency, rpm_limit,
// tpm_limit, estimated_tokens, counter_ttl_ms.
var acquireScript = redis.NewScript(`
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local maxConcurrency = tonumber(ARGV[4])
if maxConcurrency > 0 and redis.call('ZCARD', KEYS[1]) >= maxConcurrency then
  return {0, 'concurrency'}
end
local rpmLimit = tonumber(ARGV[5])
if rpmLimit > 0 then
  local rpm = redis.call('INCR', KEYS[2])
  if rpm == 1 then
    redis.call('PEXPIRE', KEYS[2], ARGV[8])
  end
  if rpm > rpmLimit then
    redis.call('DECR', KEYS[2])
    return {0, 'rpm'}
  end
end
local tpmLimit = tonumber(ARGV[6])
local tokens = tonumber(ARGV[7])
if tpmLimit > 0 and tokens > 0 then
  local tpm = redis.call('INCRBY', KEYS[3], tokens)
  if tpm == tokens then
    redis.call('PEXPIRE', KEYS[3], ARGV[8])
  end
  if tpm > tpmLimit then
    redis.call('DECRBY', KEYS[3], tokens)
    return {0, 'tpm'}
  end
end
if maxConcurrency > 0 then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[8])
end
return {1, ''}
`)

func acquireRedis(client *redis.Client, lease *Lease, limits Limits) (RejectReason, error) {
	result, err := acquireScript.Run(
		context.Background(),
		client,
		[]string{lease.concurrencyKey(), lease.rpmKey(lease.window), lease.tpmKey()},
		time.Now().UnixMilli(),
		lease.id,
		time.Now().Add(leaseTTL).UnixMilli(),
		limits.MaxConcurrency,
		limits.RPMLimit,
		limits.TPMLimit,
		lease.reserved,
		int64(windowKeyTTL/time.Millisecond),
	).Result()
	if err != nil {
		return "", err
	}
	values, ok := result.([]interface{})
	if !ok || len(values) < 2 {
		return "", fmt.Errorf("unexpected admission script result: %v", result)
	}
	if admitted, _ := values[0].(int64); admitted == 1 {
		return "", nil
	}
	return RejectReason(fmt.Sprint(values[1])), nil
}

// memorySubject holds the in-process counters of one subject. Subjects are
// keyed by channel or token, so the map size is bounded by the configured
// subjects and entries are never evicted.
type memorySubject struct {
	concurrency map[string]int64
	rpmWindow   int64
	rpmCount    int
	tpmWindow   int64
	tpmCount    int
}

var memoryStore = struct {
	sync.Mutex
	subjects map[string]*memorySubject
}{subjects: make(map[string]*memorySubject)}

func memorySubjectFor(key string) *memorySubject {
	subject := memoryStore.subjects[key]
	if subject == nil {
		subject = &memorySubject{concurrency: make(map[string]int64)}
		memoryStore.subjects[key] = subject
	}
	return subject
}

func acquireMemory(lease *Lease, limits Limits, now time.Time) RejectReason {
	nowMillis := now.UnixMilli()
	memoryStore.Lock()
	defer memoryStore.Unlock()
	subject := memorySubjectFor(lease.key)
	for id, deadline := range subject.concurrency {
		if deadline <= nowMillis {
			delete(subject.concurrency, id)
		}
	}
	if limits.MaxConcurrency > 0 && len(subject.concurrency) >= limits.MaxConcurrency {
		return RejectConcurrency
	}
	rpmCount := subject.rpmCount
	if subject.rpmWindow != lease.window {
		rpmCount = 0
	}
	if limits.RPMLimit > 0 && rpmCount >= limits.RPMLimit {
		return RejectRPM
	}
	tpmCount := subject.tpmCount
	if subject.tpmWindow != lease.window {
		tpmCount = 0
	}
	if limits.TPMLimit > 0 && lease.reserved > 0 && tpmCount+lease.reserved > limits.TPMLimit {
		return RejectTPM
	}
	if limits.MaxConcurrency > 0 {
		subject.concurrency[lease.id] = nowMillis + int64(leaseTTL/time.Millisecond)
	}
	if limits.RPMLimit > 0 {
		subject.rpmWindow = lease.window
		subject.rpmCount = rpmCount + 1
	}
	if limits.TPMLimit > 0 && lease.reserved > 0 {
		subject.tpmWindow = lease.window
		subject.tpmCount = tpmCount + lease.reserved
	}
	lease.memory = subject
	return ""
}

// Context keys of the attempt leases a request holds. The keys live here so
// both the relay packages and the consume-log settlement share them without
// importing each other.
const (
	ChannelLeaseContextKey = "admission_channel_lease"
	TokenLeaseContextKey   = "admission_token_lease"
)

// StoreLease replaces the attempt lease held under key; the replaced lease is
// rolled back so a retried attempt never keeps the previous attempt's slot or
// token reservation.
func StoreLease(c *gin.Context, key string, lease *Lease) {
	if c == nil {
		return
	}
	RetireLease(c, key)
	c.Set(key, lease)
}

// RetireLease rolls back the lease stored under key and clears the slot.
func RetireLease(c *gin.Context, key string) {
	if c == nil {
		return
	}
	if value, exists := c.Get(key); exists {
		if lease, ok := value.(*Lease); ok && lease != nil {
			lease.Rollback()
		}
		c.Set(key, (*Lease)(nil))
	}
}

// ReleaseLeases retires both attempt leases of the request. It is idempotent
// and safe to call when no admission was tracked.
func ReleaseLeases(c *gin.Context) {
	RetireLease(c, ChannelLeaseContextKey)
	RetireLease(c, TokenLeaseContextKey)
}

// SettleLease corrects the token reservation of the lease stored under key to
// the actual token usage of the settled request.
func SettleLease(c *gin.Context, key string, actualTokens int) {
	if c == nil {
		return
	}
	value, exists := c.Get(key)
	if !exists {
		return
	}
	if lease, ok := value.(*Lease); ok && lease != nil {
		lease.Settle(actualTokens)
	}
}
