/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
package model

import (
	"fmt"

	"github.com/QuantumNous/new-api/common"
)

// PlaygroundOriginLogOtherKey is the public `other` field that marks a usage
// log as submitted from the Playground workspace. It is written next to the
// ordinary log metadata, so no schema change is needed and API calls stay
// unmarked.
const PlaygroundOriginLogOtherKey = "playground_origin"

// Playground usage origins, read back from the log marker. A log without the
// marker (including every direct API call and every row written before the
// marker existed) is an API-origin row.
const (
	PlaygroundUsageOriginPlayground = "playground"
	PlaygroundUsageOriginAPI        = "api"
)

// playgroundUsageAnalyticsMaxBuckets bounds one analytics answer so a very
// active account over a long range still gets a bounded response. Buckets are
// day x model x origin groups, so the cap is far above a realistic workspace.
const playgroundUsageAnalyticsMaxBuckets = 2000

// PlaygroundUsageAnalyticsBucket is one day x model x origin group of the
// caller's settled usage logs. Every figure is a sum copied from the stored
// rows; the two averages are derived from the same sums (0 when no row carried
// a usable measurement). It is display-only and never recalculates billing.
type PlaygroundUsageAnalyticsBucket struct {
	// DayStart is the UTC midnight (unix seconds) the log rows fall in.
	DayStart         int64  `json:"day_start"`
	ModelName        string `json:"model_name"`
	Origin           string `json:"origin"`
	Quota            int64  `json:"quota"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	CacheTokens      int64  `json:"cache_tokens"`
	Requests         int64  `json:"requests"`
	Errors           int64  `json:"errors"`
	AvgTimeSeconds   int64  `json:"avg_time_seconds"`
	AvgFirstTokenMs  int64  `json:"avg_first_token_ms"`
}

// PlaygroundUsageAnalytics is the read-only usage/performance answer for one
// account. Enabled mirrors the runtime consume-log setting, so a client can
// explain an empty view instead of waiting for rows the gateway would never
// write. Errors still appear while consume logging is off because they are
// recorded independently.
type PlaygroundUsageAnalytics struct {
	Enabled        bool                             `json:"enabled"`
	StartTimestamp int64                            `json:"start_timestamp"`
	EndTimestamp   int64                            `json:"end_timestamp"`
	Buckets        []PlaygroundUsageAnalyticsBucket `json:"buckets"`
}

// playgroundUsageAnalyticsRow is the flat scan target of the grouped query.
type playgroundUsageAnalyticsRow struct {
	DayStart          int64
	ModelName         string
	Origin            string
	Quota             int64
	PromptTokens      int64
	CompletionTokens  int64
	CacheTokens       int64
	Requests          int64
	Errors            int64
	TotalTimeSeconds  int64
	TimedRequests     int64
	FirstTokenTotalMs int64
	FirstTokenSamples int64
}

// playgroundUsageDayBucketExpr renders the UTC day the row belongs to with the
// integer division form supported by the log database.
func playgroundUsageDayBucketExpr() string {
	switch {
	case common.UsingLogDatabase(common.DatabaseTypeClickHouse):
		return "intDiv(created_at, 86400) * 86400"
	case common.UsingLogDatabase(common.DatabaseTypePostgreSQL):
		return "(created_at / 86400) * 86400"
	case common.UsingLogDatabase(common.DatabaseTypeMySQL):
		return "FLOOR(created_at / 86400) * 86400"
	default:
		return "(created_at / 86400) * 86400"
	}
}

// playgroundUsageCacheTokensExpr renders the cached prompt token count of one
// log row. Only consume rows can carry one. Empty and malformed `other`
// documents count as absent instead of failing the query: SQLite and MySQL
// check JSON validity first, PostgreSQL and ClickHouse match the numeric
// pattern in the stored text without casting the whole document. Every branch
// yields an integer so the aggregate column type is the same everywhere.
func playgroundUsageCacheTokensExpr() string {
	switch {
	case common.UsingLogDatabase(common.DatabaseTypeClickHouse):
		return "toInt64OrZero(extract(other, '\"cache_tokens\"[[:space:]]*:[[:space:]]*([0-9]+)'))"
	case common.UsingLogDatabase(common.DatabaseTypePostgreSQL):
		return "COALESCE(substring(other from '\"cache_tokens\"[[:space:]]*:[[:space:]]*([0-9]+)')::bigint, 0)"
	case common.UsingLogDatabase(common.DatabaseTypeMySQL):
		return "CASE WHEN JSON_VALID(other) THEN COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(other, '$.cache_tokens')) AS SIGNED), 0) ELSE 0 END"
	default:
		return "CASE WHEN json_valid(other) THEN CAST(COALESCE(json_extract(other, '$.cache_tokens'), 0) AS INTEGER) ELSE 0 END"
	}
}

// playgroundUsageFirstTokenExpr renders the observed first-token wait of one
// log row: the request timing breakdown when the entry point recorded one, or
// the legacy `frt` field otherwise. A legacy fraction is truncated so the sum
// stays an integer, and a missing or malformed document yields 0.
func playgroundUsageFirstTokenExpr() string {
	firstTokenPattern := `"first_token_ms"[[:space:]]*:[[:space:]]*([0-9]+)`
	legacyPattern := `"frt"[[:space:]]*:[[:space:]]*([0-9]+)`
	switch {
	case common.UsingLogDatabase(common.DatabaseTypeClickHouse):
		return "COALESCE(NULLIF(toInt64OrZero(extract(other, '" + firstTokenPattern + "')), 0), toInt64OrZero(extract(other, '" + legacyPattern + "')), 0)"
	case common.UsingLogDatabase(common.DatabaseTypePostgreSQL):
		return "COALESCE(NULLIF(substring(other from '" + firstTokenPattern + "')::bigint, 0), substring(other from '" + legacyPattern + "')::bigint, 0)"
	case common.UsingLogDatabase(common.DatabaseTypeMySQL):
		return "CASE WHEN JSON_VALID(other) THEN COALESCE(NULLIF(CAST(JSON_UNQUOTE(JSON_EXTRACT(other, '$.request_timing.first_token_ms')) AS SIGNED), 0), CAST(JSON_UNQUOTE(JSON_EXTRACT(other, '$.frt')) AS SIGNED), 0) ELSE 0 END"
	default:
		return "CASE WHEN json_valid(other) THEN CAST(COALESCE(NULLIF(json_extract(other, '$.request_timing.first_token_ms'), 0), json_extract(other, '$.frt'), 0) AS INTEGER) ELSE 0 END"
	}
}

// playgroundUsageOriginExpr renders the origin marker of one log row: the
// public boolean the Playground context wrote. A row without the marker, or
// with a malformed document, is an API-origin row.
func playgroundUsageOriginExpr() string {
	markerPattern := `"` + PlaygroundOriginLogOtherKey + `"[[:space:]]*:[[:space:]]*true`
	switch {
	case common.UsingLogDatabase(common.DatabaseTypeClickHouse):
		return "if(match(other, '" + markerPattern + "'), '" + PlaygroundUsageOriginPlayground + "', '" + PlaygroundUsageOriginAPI + "')"
	case common.UsingLogDatabase(common.DatabaseTypePostgreSQL):
		return "CASE WHEN other ~ '" + markerPattern + "' THEN '" + PlaygroundUsageOriginPlayground + "' ELSE '" + PlaygroundUsageOriginAPI + "' END"
	case common.UsingLogDatabase(common.DatabaseTypeMySQL):
		// The validity check wraps its own CASE so JSON_EXTRACT only ever runs
		// on a well-formed document.
		return "CASE WHEN JSON_VALID(other) THEN CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(other, '$." + PlaygroundOriginLogOtherKey + "')) = 'true' THEN '" + PlaygroundUsageOriginPlayground + "' ELSE '" + PlaygroundUsageOriginAPI + "' END ELSE '" + PlaygroundUsageOriginAPI + "' END"
	default:
		return "CASE WHEN json_valid(other) THEN CASE WHEN json_extract(other, '$." + PlaygroundOriginLogOtherKey + "') = 1 THEN '" + PlaygroundUsageOriginPlayground + "' ELSE '" + PlaygroundUsageOriginAPI + "' END ELSE '" + PlaygroundUsageOriginAPI + "' END"
	}
}

// playgroundUsageAnalyticsSelect renders the grouped projection of one
// analytics query. Every database gets the same column names; only the JSON,
// day-bucket and boolean spellings differ.
func playgroundUsageAnalyticsSelect() string {
	cacheTokens := playgroundUsageCacheTokensExpr()
	firstToken := playgroundUsageFirstTokenExpr()
	consume := fmt.Sprintf("type = %d", LogTypeConsume)
	return fmt.Sprintf(`%s AS day_start, model_name, %s AS origin,
		COALESCE(SUM(CASE WHEN %s THEN quota ELSE 0 END), 0) AS quota,
		COALESCE(SUM(CASE WHEN %s THEN prompt_tokens ELSE 0 END), 0) AS prompt_tokens,
		COALESCE(SUM(CASE WHEN %s THEN completion_tokens ELSE 0 END), 0) AS completion_tokens,
		COALESCE(SUM(CASE WHEN %s THEN %s ELSE 0 END), 0) AS cache_tokens,
		COALESCE(SUM(CASE WHEN %s THEN 1 ELSE 0 END), 0) AS requests,
		COALESCE(SUM(CASE WHEN type = %d THEN 1 ELSE 0 END), 0) AS errors,
		COALESCE(SUM(CASE WHEN %s AND use_time > 0 THEN use_time ELSE 0 END), 0) AS total_time_seconds,
		COALESCE(SUM(CASE WHEN %s AND use_time > 0 THEN 1 ELSE 0 END), 0) AS timed_requests,
		COALESCE(SUM(CASE WHEN %s AND %s > 0 THEN %s ELSE 0 END), 0) AS first_token_total_ms,
		COALESCE(SUM(CASE WHEN %s AND %s > 0 THEN 1 ELSE 0 END), 0) AS first_token_samples`,
		playgroundUsageDayBucketExpr(),
		playgroundUsageOriginExpr(),
		consume,
		consume,
		consume,
		consume, cacheTokens,
		consume,
		LogTypeError,
		consume,
		consume,
		consume, firstToken, firstToken,
		consume, firstToken,
	)
}

// PlaygroundUsageAnalyticsForUser reads the caller's own settled usage over
// [startTimestamp, endTimestamp] and folds it into day x model x origin
// buckets. It is strictly read-only and owner-scoped: the query filters on the
// caller's user id, only the consume and error event types are read, and no
// quota is reserved, settled or recalculated. The log database may be a
// separate MySQL/PostgreSQL connection or ClickHouse; the JSON marker, cache
// figures and first-token waits are read with the dialect of the configured
// log database.
func PlaygroundUsageAnalyticsForUser(userID int, startTimestamp int64, endTimestamp int64) (PlaygroundUsageAnalytics, error) {
	result := PlaygroundUsageAnalytics{
		Enabled:        common.LogConsumeEnabled,
		StartTimestamp: startTimestamp,
		EndTimestamp:   endTimestamp,
		Buckets:        make([]PlaygroundUsageAnalyticsBucket, 0),
	}
	if userID <= 0 || startTimestamp <= 0 || endTimestamp <= 0 || endTimestamp < startTimestamp {
		return result, nil
	}
	rows := make([]playgroundUsageAnalyticsRow, 0, 32)
	err := LOG_DB.Model(&Log{}).
		Select(playgroundUsageAnalyticsSelect()).
		Where("user_id = ?", userID).
		Where("created_at >= ? AND created_at <= ?", startTimestamp, endTimestamp).
		Where("type IN ?", []int{LogTypeConsume, LogTypeError}).
		Group("day_start, model_name, origin").
		Order("day_start ASC, model_name ASC, origin ASC").
		Limit(playgroundUsageAnalyticsMaxBuckets).
		Scan(&rows).Error
	if err != nil {
		return result, err
	}
	result.Buckets = make([]PlaygroundUsageAnalyticsBucket, 0, len(rows))
	for index := range rows {
		row := &rows[index]
		origin := row.Origin
		if origin != PlaygroundUsageOriginPlayground {
			origin = PlaygroundUsageOriginAPI
		}
		bucket := PlaygroundUsageAnalyticsBucket{
			DayStart:         row.DayStart,
			ModelName:        row.ModelName,
			Origin:           origin,
			Quota:            row.Quota,
			PromptTokens:     row.PromptTokens,
			CompletionTokens: row.CompletionTokens,
			CacheTokens:      row.CacheTokens,
			Requests:         row.Requests,
			Errors:           row.Errors,
		}
		if row.TimedRequests > 0 {
			bucket.AvgTimeSeconds = row.TotalTimeSeconds / row.TimedRequests
		}
		if row.FirstTokenSamples > 0 {
			bucket.AvgFirstTokenMs = row.FirstTokenTotalMs / row.FirstTokenSamples
		}
		result.Buckets = append(result.Buckets, bucket)
	}
	return result, nil
}
