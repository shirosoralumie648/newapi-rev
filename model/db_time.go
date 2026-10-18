package model

import (
	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// GetDBTimestamp returns a UNIX timestamp from database time.
// Falls back to application time on error.
func GetDBTimestamp() int64 {
	return dbTimestamp(DB)
}

// GetDBTimestampTx returns a UNIX timestamp from database time read through an
// open transaction. Callers already inside a transaction MUST use it instead of
// GetDBTimestamp: the transaction owns its connection, so asking the pool for a
// second one can deadlock when it is limited to a single connection.
func GetDBTimestampTx(tx *gorm.DB) int64 {
	if tx == nil {
		return GetDBTimestamp()
	}
	return dbTimestamp(tx)
}

func dbTimestamp(db *gorm.DB) int64 {
	var ts int64
	var err error
	switch {
	case common.UsingMainDatabase(common.DatabaseTypePostgreSQL):
		err = db.Raw("SELECT EXTRACT(EPOCH FROM NOW())::bigint").Scan(&ts).Error
	case common.UsingMainDatabase(common.DatabaseTypeSQLite):
		err = db.Raw("SELECT strftime('%s','now')").Scan(&ts).Error
	default:
		err = db.Raw("SELECT UNIX_TIMESTAMP()").Scan(&ts).Error
	}
	if err != nil || ts <= 0 {
		return common.GetTimestamp()
	}
	return ts
}
