package playground_setting

import "github.com/QuantumNous/new-api/common"

// The optional replay capture (PG2-08) retains a desensitized summary of a
// Playground chat request and response so an owner can reopen the settled call
// as a new draft. It is off by default and only the deploying administrator can
// switch it on: the switch is a process-level environment variable, never a
// per-user preference.
const (
	// PlaygroundLogCaptureEnv enables the retention of request/response
	// summaries. Any value accepted by strconv.ParseBool turns it on.
	PlaygroundLogCaptureEnv = "PLAYGROUND_LOG_CAPTURE"
	// PlaygroundLogCaptureMaxBytesEnv bounds one stored summary (request or
	// response). Values outside the supported range are clamped.
	PlaygroundLogCaptureMaxBytesEnv = "PLAYGROUND_LOG_CAPTURE_MAX_BYTES"
	// PlaygroundLogCaptureTTLDaysEnv is the retention window of a stored
	// summary. Values outside the supported range are clamped.
	PlaygroundLogCaptureTTLDaysEnv = "PLAYGROUND_LOG_CAPTURE_TTL_DAYS"

	DefaultPlaygroundLogCaptureMaxBytes = 64 << 10
	MinPlaygroundLogCaptureMaxBytes     = 4 << 10
	MaxPlaygroundLogCaptureMaxBytes     = 256 << 10
	DefaultPlaygroundLogCaptureTTLDays  = 7
	MaxPlaygroundLogCaptureTTLDays      = 30
)

// PlaygroundLogCaptureEnabled reports whether the administrator turned the
// optional request/response retention on. Everything else in this file may be
// configured freely while it is off; a disabled switch never stores content.
func PlaygroundLogCaptureEnabled() bool {
	return common.GetEnvOrDefaultBool(PlaygroundLogCaptureEnv, false)
}

// PlaygroundLogCaptureMaxBytes returns the byte budget of one stored summary,
// clamped to a range that keeps a summary useful without turning the capture
// into a second copy of the request payload.
func PlaygroundLogCaptureMaxBytes() int {
	value := common.GetEnvOrDefault(PlaygroundLogCaptureMaxBytesEnv, DefaultPlaygroundLogCaptureMaxBytes)
	return min(max(value, MinPlaygroundLogCaptureMaxBytes), MaxPlaygroundLogCaptureMaxBytes)
}

// PlaygroundLogCaptureTTLSeconds returns the retention window of a stored
// summary. The scheduled cleanup collects rows whose window elapsed.
func PlaygroundLogCaptureTTLSeconds() int64 {
	days := common.GetEnvOrDefault(PlaygroundLogCaptureTTLDaysEnv, DefaultPlaygroundLogCaptureTTLDays)
	days = min(max(days, 1), MaxPlaygroundLogCaptureTTLDays)
	return int64(days) * 24 * 60 * 60
}
