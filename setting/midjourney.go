package setting

import "strings"

// Midjourney image access modes accepted by MjImageAccessMode.
const (
	// MjImageAccessAuth requires a dashboard session or an API token and checks
	// that the caller owns the task.
	MjImageAccessAuth = "auth"
	// MjImageAccessSigned also accepts an unexpired HMAC link, so image URLs
	// already handed to clients keep working without credentials.
	MjImageAccessSigned = "signed"
	// MjImageAccessLegacy keeps the historical open access.
	MjImageAccessLegacy = "legacy"
)

// MjImageAccessMode controls how GET /mj/image/:id authorises a request.
// Unknown values fall back to MjImageAccessAuth, so a bad option value never
// opens the route.
var MjImageAccessMode = MjImageAccessAuth

// NormalizeMjImageAccessMode maps a stored option value to a supported mode.
func NormalizeMjImageAccessMode(mode string) string {
	switch strings.TrimSpace(mode) {
	case MjImageAccessSigned:
		return MjImageAccessSigned
	case MjImageAccessLegacy:
		return MjImageAccessLegacy
	default:
		return MjImageAccessAuth
	}
}

var MjNotifyEnabled = false
var MjAccountFilterEnabled = false
var MjModeClearEnabled = false
var MjForwardUrlEnabled = true
var MjActionCheckSuccessEnabled = true
