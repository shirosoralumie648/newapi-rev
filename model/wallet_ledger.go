package model

import (
	"errors"
	"fmt"
	"sync"

	"github.com/QuantumNous/new-api/common"

	sqlitedriver "github.com/glebarez/go-sqlite"
	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Wallet ledger kinds. Fund events live in the main database as one
// append-only row per movement, while API consumption is aggregated into one
// consume_hourly row per user and hour. The unique (ref_type, ref_id) index
// makes every fund event replay-safe.
const (
	WalletLedgerKindOpeningBalance      = "opening_balance"
	WalletLedgerKindTopUp               = "topup"
	WalletLedgerKindRedeem              = "redeem"
	WalletLedgerKindAdminAdjust         = "admin_adjust"
	WalletLedgerKindRefund              = "refund"
	WalletLedgerKindSubscriptionPayment = "subscription_payment"
	WalletLedgerKindCheckin             = "checkin"
	WalletLedgerKindAffiliateTransfer   = "affiliate_transfer"
	WalletLedgerKindSystemGrant         = "system_grant"
	WalletLedgerKindConsumeHourly       = "consume_hourly"
	// Reserved: chargeback reversals (WL payment webhooks) and the daily
	// storage settlement (BL-02) record through these kinds.
	WalletLedgerKindChargeback   = "chargeback"
	WalletLedgerKindStorageDaily = "storage_daily"
)

// Reference namespaces used by the unique idempotency index.
const (
	WalletLedgerRefOpening          = "opening"
	WalletLedgerRefTopUp            = "topup"
	WalletLedgerRefRedeem           = "redeem"
	WalletLedgerRefAdminAdjust      = "admin_adjust"
	WalletLedgerRefCheckin          = "checkin"
	WalletLedgerRefAffiliate        = "affiliate_transfer"
	WalletLedgerRefSubscription     = "subscription_order"
	WalletLedgerRefRequestRefund    = "request_refund"
	WalletLedgerRefTaskRefund       = "task_refund"
	WalletLedgerRefMidjourneyRefund = "midjourney_refund"
	WalletLedgerRefInviteeBonus     = "invitee_bonus"
	WalletLedgerRefConsumeHourly    = "consume_hourly"
)

// walletLedgerConsumeHourSeconds is the aggregation window for API consumption.
const walletLedgerConsumeHourSeconds = int64(3600)

// WalletLedgerEntry is one append-only wallet movement. Amount is positive for
// credits and negative for debits; BalanceAfter is the wallet quota after the
// row was applied and is informational for aggregated consumption rows.
type WalletLedgerEntry struct {
	Id           int    `json:"id" gorm:"primaryKey;autoIncrement"`
	UserId       int    `json:"user_id" gorm:"not null;index"`
	Kind         string `json:"kind" gorm:"type:varchar(32);not null;index"`
	Amount       int64  `json:"amount" gorm:"not null"`
	BalanceAfter int64  `json:"balance_after" gorm:"not null"`
	RefType      string `json:"ref_type" gorm:"type:varchar(32);not null;uniqueIndex:idx_wallet_ledger_ref,priority:1"`
	RefId        string `json:"ref_id" gorm:"type:varchar(96);not null;uniqueIndex:idx_wallet_ledger_ref,priority:2"`
	CreatedAt    int64  `json:"created_at" gorm:"bigint;not null;index"`
	Meta         string `json:"meta" gorm:"type:text"`
}

func (WalletLedgerEntry) TableName() string {
	return "wallet_ledger"
}

// isWalletLedgerDuplicateError reports whether err is the database rejecting a
// duplicate (ref_type, ref_id) claim. GORM error translation is disabled in
// this project, so the driver error is probed directly.
func isWalletLedgerDuplicateError(err error) bool {
	if err == nil {
		return false
	}
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		return mysqlErr.Number == 1062
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	var sqliteErr *sqlitedriver.Error
	if errors.As(err, &sqliteErr) {
		// Mask to the primary result code (SQLITE_CONSTRAINT == 19) so
		// extended codes such as SQLITE_CONSTRAINT_UNIQUE match too.
		return sqliteErr.Code()&0xff == 19
	}
	return false
}

// AppendWalletLedgerTx inserts one ledger row inside tx. A row that already
// claims (ref_type, ref_id) is reported as a replay (applied=false) without
// writing anything, which is what makes fund events idempotent.
func AppendWalletLedgerTx(tx *gorm.DB, entry *WalletLedgerEntry) (applied bool, err error) {
	if tx == nil || entry == nil {
		return false, errors.New("wallet ledger entry is required")
	}
	if entry.UserId <= 0 || entry.Kind == "" || entry.RefType == "" || entry.RefId == "" {
		return false, errors.New("invalid wallet ledger entry")
	}
	if entry.CreatedAt == 0 {
		entry.CreatedAt = common.GetTimestamp()
	}

	var existing WalletLedgerEntry
	if findErr := tx.Select("id").Where("ref_type = ? AND ref_id = ?", entry.RefType, entry.RefId).First(&existing).Error; findErr == nil {
		return false, nil
	} else if !errors.Is(findErr, gorm.ErrRecordNotFound) {
		return false, findErr
	}

	if err := tx.Create(entry).Error; err != nil {
		if isWalletLedgerDuplicateError(err) {
			// A concurrent transaction claimed the same reference first; the
			// caller treats this as a replay and performs no balance change.
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// ApplyWalletLedgerDelta applies delta to the user's wallet and appends the
// matching ledger row in the same transaction, keeping the wallet and the
// ledger consistent even on rollback. The ledger row is inserted first, so a
// duplicate (ref_type, ref_id) is a replay: applied=false and no balance
// change. delta==0 is a no-op.
func ApplyWalletLedgerDelta(tx *gorm.DB, userId int, kind string, delta int64, refType string, refId string, meta string) (applied bool, err error) {
	if tx == nil {
		return false, errors.New("database handle is required")
	}
	if delta == 0 {
		return false, nil
	}

	var user User
	if err := lockForUpdate(tx).Select("id", "quota").Where("id = ?", userId).First(&user).Error; err != nil {
		return false, err
	}

	balanceAfter := int64(user.Quota) + delta
	maxWallet := int64(common.MaxWalletQuota)
	if balanceAfter > maxWallet || balanceAfter < -maxWallet {
		return false, ErrWalletQuotaLimitExceeded
	}

	entry := &WalletLedgerEntry{
		UserId:       userId,
		Kind:         kind,
		Amount:       delta,
		BalanceAfter: balanceAfter,
		RefType:      refType,
		RefId:        refId,
		Meta:         meta,
		CreatedAt:    common.GetTimestamp(),
	}
	applied, err = AppendWalletLedgerTx(tx, entry)
	if err != nil || !applied {
		return false, err
	}
	if err := tx.Model(&User{}).Where("id = ?", userId).Update("quota", balanceAfter).Error; err != nil {
		return false, err
	}
	return true, nil
}

// ApplyWalletLedgerDeltaDB wraps ApplyWalletLedgerDelta in its own transaction
// for standalone callers. Callers are responsible for syncing the user cache
// after the commitment is known to have succeeded.
func ApplyWalletLedgerDeltaDB(userId int, kind string, delta int64, refType string, refId string, meta string) (applied bool, err error) {
	err = DB.Transaction(func(tx *gorm.DB) error {
		var applyErr error
		applied, applyErr = ApplyWalletLedgerDelta(tx, userId, kind, delta, refType, refId, meta)
		return applyErr
	})
	return applied, err
}

// GrantWalletQuota credits a system grant (for example the invitee bonus) to
// the wallet and records the matching ledger row.
func GrantWalletQuota(userId int, amount int, refType string, refId string) error {
	if amount <= 0 {
		return nil
	}
	if err := common.ValidateWalletQuota(amount); err != nil {
		return err
	}
	applied, err := ApplyWalletLedgerDeltaDB(userId, WalletLedgerKindSystemGrant, int64(amount), refType, refId, "")
	if err != nil {
		return err
	}
	if applied {
		syncCreditUserQuotaCache(userId, amount, refType)
	}
	return nil
}

// RefundWalletQuota returns quota to the wallet for a refundable reference.
// Replays of the same reference are no-ops.
func RefundWalletQuota(userId int, amount int, refType string, refId string) error {
	if amount <= 0 {
		return nil
	}
	applied, err := ApplyWalletLedgerDeltaDB(userId, WalletLedgerKindRefund, int64(amount), refType, refId, "")
	if err != nil {
		return err
	}
	if applied {
		syncCreditUserQuotaCache(userId, amount, refType)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Consumption aggregation (one consume_hourly row per user and hour)
// ---------------------------------------------------------------------------

type walletConsumeBucketKey struct {
	userId int
	hour   int64
}

var (
	walletConsumeMu      sync.Mutex
	walletConsumeBuckets = make(map[walletConsumeBucketKey]int64)
)

// RecordWalletConsumeDelta accounts a wallet quota movement caused by API
// consumption (pre-consume, settlement deltas, refunds of pre-consume). With
// batch updates enabled the delta is accumulated in memory and flushed by
// batchUpdate; otherwise it is upserted directly. The hourly row is an upsert
// on (consume_hourly, user:hour), so concurrent instances still converge on
// one row per bucket.
func RecordWalletConsumeDelta(userId int, delta int64) {
	if userId <= 0 || delta == 0 {
		return
	}
	hour := walletConsumeHourBucket(common.GetTimestamp())
	if !common.BatchUpdateEnabled {
		if err := upsertWalletConsumeLedger(userId, hour, delta); err != nil {
			common.SysError(common.LogText("failed to write wallet consume ledger for user %d: %s", userId, err.Error()))
		}
		return
	}

	key := walletConsumeBucketKey{userId: userId, hour: hour}
	walletConsumeMu.Lock()
	defer walletConsumeMu.Unlock()
	sum := walletConsumeBuckets[key] + delta
	if (delta > 0 && sum < walletConsumeBuckets[key]) || (delta < 0 && sum > walletConsumeBuckets[key]) {
		common.SysError(common.LogText("wallet consume accumulation overflow: user=%d hour=%d", userId, hour))
		return
	}
	walletConsumeBuckets[key] = sum
}

// walletConsumeLedgerPending reports whether consumption deltas are waiting to
// be flushed, so the batch updater does not return early on their behalf.
func walletConsumeLedgerPending() bool {
	walletConsumeMu.Lock()
	defer walletConsumeMu.Unlock()
	return len(walletConsumeBuckets) > 0
}

// flushWalletConsumeLedgers writes all pending hourly buckets. Buckets whose
// upsert fails are restored so a transient database error does not silently
// drop consumption rows.
func flushWalletConsumeLedgers() {
	walletConsumeMu.Lock()
	if len(walletConsumeBuckets) == 0 {
		walletConsumeMu.Unlock()
		return
	}
	buckets := walletConsumeBuckets
	walletConsumeBuckets = make(map[walletConsumeBucketKey]int64)
	walletConsumeMu.Unlock()

	for key, delta := range buckets {
		if err := upsertWalletConsumeLedger(key.userId, key.hour, delta); err != nil {
			common.SysError(common.LogText("failed to flush wallet consume ledger for user %d: %s", key.userId, err.Error()))
			walletConsumeMu.Lock()
			walletConsumeBuckets[key] += delta
			walletConsumeMu.Unlock()
		}
	}
}

// walletConsumeHourBucket returns the aggregation window (hour start) of a
// timestamp for the per-user consumption row.
func walletConsumeHourBucket(timestamp int64) int64 {
	return timestamp / walletLedgerConsumeHourSeconds * walletLedgerConsumeHourSeconds
}

func upsertWalletConsumeLedger(userId int, hour int64, delta int64) error {
	return upsertWalletConsumeLedgerTx(DB, userId, hour, delta)
}

// upsertWalletConsumeLedgerTx accumulates delta into the user's hourly
// consumption row through tx, so a wallet movement committed inside an outer
// transaction records its ledger row in that same transaction. balance_after
// is read through tx and therefore reflects any balance change the caller
// already applied.
func upsertWalletConsumeLedgerTx(tx *gorm.DB, userId int, hour int64, delta int64) error {
	if delta == 0 {
		return nil
	}
	var quota int64
	if err := tx.Model(&User{}).Where("id = ?", userId).Pluck("quota", &quota).Error; err != nil {
		return err
	}
	entry := &WalletLedgerEntry{
		UserId:       userId,
		Kind:         WalletLedgerKindConsumeHourly,
		Amount:       delta,
		BalanceAfter: quota,
		RefType:      WalletLedgerRefConsumeHourly,
		RefId:        fmt.Sprintf("%d:%d", userId, hour),
		CreatedAt:    common.GetTimestamp(),
	}
	return tx.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "ref_type"}, {Name: "ref_id"}},
		DoUpdates: clause.Assignments(map[string]any{
			// Qualify the accumulated column: PostgreSQL reports an unqualified
			// `amount` as ambiguous with the EXCLUDED row of the same statement.
			"amount":        gorm.Expr("wallet_ledger.amount + ?", delta),
			"balance_after": quota,
		}),
	}).Create(entry).Error
}

// ---------------------------------------------------------------------------
// Opening balance baseline
// ---------------------------------------------------------------------------

// EnsureWalletLedgerOpeningBalances seeds one opening_balance row for every
// user that has no ledger rows yet. It is idempotent and gives reconciliation
// a baseline for wallets that existed before the ledger was introduced.
func EnsureWalletLedgerOpeningBalances() (int, error) {
	var ledgerUserIds []int
	if err := DB.Model(&WalletLedgerEntry{}).Distinct().Pluck("user_id", &ledgerUserIds).Error; err != nil {
		return 0, err
	}
	seeded := make(map[int]struct{}, len(ledgerUserIds))
	for _, id := range ledgerUserIds {
		seeded[id] = struct{}{}
	}

	seededCount := 0
	var batch []*WalletLedgerEntry
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := DB.CreateInBatches(batch, 200).Error; err != nil {
			// A concurrent/previous partial seed may have claimed some rows;
			// insert individually so the rest still receive a baseline.
			for _, entry := range batch {
				if insertErr := DB.Create(entry).Error; insertErr != nil && !isWalletLedgerDuplicateError(insertErr) {
					return insertErr
				}
			}
		}
		seededCount += len(batch)
		batch = batch[:0]
		return nil
	}

	var users []User
	if err := DB.Model(&User{}).Select("id", "quota").FindInBatches(&users, 500, func(tx *gorm.DB, _ int) error {
		for _, user := range users {
			if _, ok := seeded[user.Id]; ok {
				continue
			}
			quota := int64(user.Quota)
			batch = append(batch, &WalletLedgerEntry{
				UserId:       user.Id,
				Kind:         WalletLedgerKindOpeningBalance,
				Amount:       quota,
				BalanceAfter: quota,
				RefType:      WalletLedgerRefOpening,
				RefId:        fmt.Sprintf("%d", user.Id),
				CreatedAt:    common.GetTimestamp(),
			})
			seeded[user.Id] = struct{}{}
			if len(batch) >= 200 {
				if err := flush(); err != nil {
					return err
				}
			}
		}
		return nil
	}).Error; err != nil {
		return seededCount, err
	}
	if err := flush(); err != nil {
		return seededCount, err
	}
	return seededCount, nil
}

// insertSignupOpeningBalance records the sign-up bonus as the new wallet's
// opening balance in the same transaction that creates the user.
func insertSignupOpeningBalance(tx *gorm.DB, user *User) error {
	if user == nil || user.Id <= 0 || user.Quota <= 0 {
		return nil
	}
	if err := common.ValidateWalletQuota(user.Quota); err != nil {
		return err
	}
	quota := int64(user.Quota)
	_, err := AppendWalletLedgerTx(tx, &WalletLedgerEntry{
		UserId:       user.Id,
		Kind:         WalletLedgerKindOpeningBalance,
		Amount:       quota,
		BalanceAfter: quota,
		RefType:      WalletLedgerRefOpening,
		RefId:        fmt.Sprintf("%d", user.Id),
		CreatedAt:    common.GetTimestamp(),
	})
	return err
}

// ---------------------------------------------------------------------------
// Queries and reconciliation
// ---------------------------------------------------------------------------

// GetWalletLedgerEntries lists one user's ledger entries, newest first.
func GetWalletLedgerEntries(userId int, kind string, offset int, limit int) ([]*WalletLedgerEntry, int64, error) {
	query := DB.Model(&WalletLedgerEntry{}).Where("user_id = ?", userId)
	if kind != "" {
		query = query.Where("kind = ?", kind)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var entries []*WalletLedgerEntry
	if err := query.Order("id DESC").Limit(limit).Offset(offset).Find(&entries).Error; err != nil {
		return nil, 0, err
	}
	return entries, total, nil
}

// StreamUserWalletLedger walks one user's ledger entries newest first for CSV
// export without loading the whole history into memory.
func StreamUserWalletLedger(userId int, exportLimit int, fn func(*WalletLedgerEntry) error) error {
	rows, err := DB.Model(&WalletLedgerEntry{}).Where("user_id = ?", userId).Order("id DESC").Limit(exportLimit).Rows()
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var entry WalletLedgerEntry
		if err := DB.ScanRows(rows, &entry); err != nil {
			return err
		}
		if err := fn(&entry); err != nil {
			return err
		}
	}
	return rows.Err()
}

// WalletLedgerSumForUser returns the ledger total and row count for one user.
func WalletLedgerSumForUser(userId int) (int64, int64, error) {
	var row struct {
		Total      int64
		EntryCount int64
	}
	if err := DB.Model(&WalletLedgerEntry{}).
		Select("COALESCE(SUM(amount), 0) AS total, COUNT(*) AS entry_count").
		Where("user_id = ?", userId).
		Scan(&row).Error; err != nil {
		return 0, 0, err
	}
	return row.Total, row.EntryCount, nil
}

// WalletReconciliation is the per-user result of comparing Σledger with the
// wallet balance. Reconciliation never modifies the balance.
type WalletReconciliation struct {
	UserId     int    `json:"user_id"`
	Username   string `json:"username,omitempty"`
	LedgerSum  int64  `json:"ledger_sum"`
	EntryCount int64  `json:"entry_count"`
	Quota      int64  `json:"quota"`
	CacheQuota *int64 `json:"cache_quota,omitempty"`
	Deviation  int64  `json:"deviation"`
	Reconciled bool   `json:"reconciled"`
	CheckedAt  int64  `json:"checked_at"`
}

// WalletReconciliationReport summarizes one reconciliation run. Deviations is
// capped so the report stays bounded; DeviationCount is the full count.
type WalletReconciliationReport struct {
	CheckedAt      int64                  `json:"checked_at"`
	UserCount      int64                  `json:"user_count"`
	DeviationCount int64                  `json:"deviation_count"`
	Deviations     []WalletReconciliation `json:"deviations"`
}

// ReconcileWalletLedgerForUser compares one wallet with its ledger. Pending
// batch updates are flushed first so the comparison sees the committed state.
func ReconcileWalletLedgerForUser(userId int) (*WalletReconciliation, error) {
	FlushBatchUpdates()

	var user User
	if err := DB.Select("id", "username", "quota").Where("id = ?", userId).First(&user).Error; err != nil {
		return nil, err
	}
	ledgerSum, entryCount, err := WalletLedgerSumForUser(userId)
	if err != nil {
		return nil, err
	}
	quota := int64(user.Quota)
	result := &WalletReconciliation{
		UserId:     user.Id,
		Username:   user.Username,
		LedgerSum:  ledgerSum,
		EntryCount: entryCount,
		Quota:      quota,
		Deviation:  ledgerSum - quota,
		CheckedAt:  common.GetTimestamp(),
	}
	result.Reconciled = result.Deviation == 0
	if !result.Reconciled && common.RedisEnabled {
		if cacheQuota, cacheErr := getUserQuotaCache(userId); cacheErr == nil {
			value := int64(cacheQuota)
			result.CacheQuota = &value
		}
	}
	return result, nil
}

// ReconcileWalletLedgers compares every user's wallet with the sum of their
// ledger rows. It flushes pending batch updates first and never modifies any
// balance; deviationLimit caps how many deviating users the report lists.
func ReconcileWalletLedgers(deviationLimit int) (*WalletReconciliationReport, error) {
	FlushBatchUpdates()

	type ledgerSumRow struct {
		UserId     int
		Total      int64
		EntryCount int64
	}
	var sums []ledgerSumRow
	if err := DB.Model(&WalletLedgerEntry{}).
		Select("user_id, SUM(amount) AS total, COUNT(*) AS entry_count").
		Group("user_id").
		Find(&sums).Error; err != nil {
		return nil, err
	}
	sumByUser := make(map[int]ledgerSumRow, len(sums))
	for _, row := range sums {
		sumByUser[row.UserId] = row
	}

	report := &WalletReconciliationReport{CheckedAt: common.GetTimestamp()}
	var users []User
	if err := DB.Model(&User{}).Select("id", "username", "quota").FindInBatches(&users, 500, func(tx *gorm.DB, _ int) error {
		for _, user := range users {
			row := sumByUser[user.Id]
			quota := int64(user.Quota)
			report.UserCount++
			deviation := row.Total - quota
			if deviation == 0 {
				continue
			}
			report.DeviationCount++
			if deviationLimit > 0 && len(report.Deviations) >= deviationLimit {
				continue
			}
			entry := WalletReconciliation{
				UserId:     user.Id,
				Username:   user.Username,
				LedgerSum:  row.Total,
				EntryCount: row.EntryCount,
				Quota:      quota,
				Deviation:  deviation,
				CheckedAt:  report.CheckedAt,
			}
			if common.RedisEnabled {
				if cacheQuota, cacheErr := getUserQuotaCache(user.Id); cacheErr == nil {
					value := int64(cacheQuota)
					entry.CacheQuota = &value
				}
			}
			report.Deviations = append(report.Deviations, entry)
		}
		return nil
	}).Error; err != nil {
		return nil, err
	}
	return report, nil
}
