package model

import (
	"encoding/json"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

const (
	logOtherAdminInfoKey    = "admin_info"
	logOtherRootInfoKey     = "root_info"
	logOtherAuditInfoKey    = "audit_info"
	logOtherContentPartsKey = "content_parts"
)

// legacySensitiveLogOtherKeys are historical top-level fields that must never
// be written via SetPublic and must be stripped from user-visible projections.
var legacySensitiveLogOtherKeys = []string{
	"channel_id",
	"channel_name",
	"channel_type",
	"reject_reason",
}

type logOtherVisibility int

const (
	logOtherVisibilityUser logOtherVisibility = iota
	logOtherVisibilityAdmin
	logOtherVisibilityRoot
)

// LogOther separates usage-log metadata by the audience allowed to see it.
// Its maps stay private so callers cannot accidentally place privileged fields
// in the user-visible top level.
type LogOther struct {
	public    map[string]any
	adminInfo map[string]any
	rootInfo  map[string]any
	auditInfo map[string]any
}

func NewLogOther() *LogOther {
	return &LogOther{}
}

func isReservedLogOtherKey(key string) bool {
	switch key {
	case logOtherAdminInfoKey, logOtherRootInfoKey, logOtherAuditInfoKey:
		return true
	default:
		return slices.Contains(legacySensitiveLogOtherKeys, key)
	}
}

// SetPublic records metadata that log owners may receive from self/token log APIs.
// It rejects role-scoped and legacy-sensitive keys so new writers cannot recreate
// the historical channel/reject-reason leak.
func (o *LogOther) SetPublic(key string, value any) bool {
	if o == nil || key == "" || isReservedLogOtherKey(key) {
		return false
	}
	if o.public == nil {
		o.public = make(map[string]any)
	}
	o.public[key] = value
	return true
}

func (o *LogOther) MergePublic(values map[string]any) {
	for key, value := range values {
		o.SetPublic(key, value)
	}
}

// setContent stores structured content under content_parts, which the web
// console renders in the viewer's language, and returns the English text kept
// in the content column for exports and API callers.
func (o *LogOther) setContent(parts []*common.Message) string {
	if len(parts) == 0 {
		return ""
	}
	o.SetPublic(logOtherContentPartsKey, parts)
	texts := make([]string, 0, len(parts))
	for _, part := range parts {
		texts = append(texts, part.Error())
	}
	return strings.Join(texts, ", ")
}

func (o *LogOther) SetAdmin(key string, value any) bool {
	if o == nil || key == "" {
		return false
	}
	if o.adminInfo == nil {
		o.adminInfo = make(map[string]any)
	}
	o.adminInfo[key] = value
	return true
}

func (o *LogOther) MergeAdmin(values map[string]any) {
	for key, value := range values {
		o.SetAdmin(key, value)
	}
}

func (o *LogOther) SetRoot(key string, value any) bool {
	if o == nil || key == "" {
		return false
	}
	if o.rootInfo == nil {
		o.rootInfo = make(map[string]any)
	}
	o.rootInfo[key] = value
	return true
}

func (o *LogOther) MergeRoot(values map[string]any) {
	for key, value := range values {
		o.SetRoot(key, value)
	}
}

func (o *LogOther) SetAudit(key string, value any) bool {
	if o == nil || key == "" {
		return false
	}
	if o.auditInfo == nil {
		o.auditInfo = make(map[string]any)
	}
	o.auditInfo[key] = value
	return true
}

func (o *LogOther) MergeAudit(values map[string]any) {
	for key, value := range values {
		o.SetAudit(key, value)
	}
}

func copyLogOtherMap(values map[string]any) map[string]any {
	if len(values) == 0 {
		return nil
	}
	copyValues := make(map[string]any, len(values))
	maps.Copy(copyValues, values)
	return copyValues
}

func (o *LogOther) toMap() map[string]any {
	result := make(map[string]any)
	if o == nil {
		return result
	}

	maps.Copy(result, o.public)
	if adminInfo := copyLogOtherMap(o.adminInfo); len(adminInfo) > 0 {
		result[logOtherAdminInfoKey] = adminInfo
	}
	if auditInfo := copyLogOtherMap(o.auditInfo); len(auditInfo) > 0 {
		result[logOtherAuditInfoKey] = auditInfo
	}
	if rootInfo := copyLogOtherMap(o.rootInfo); len(rootInfo) > 0 {
		result[logOtherRootInfoKey] = rootInfo
	}
	return result
}

func (o *LogOther) jsonString() string {
	if o == nil {
		return ""
	}
	data, err := common.Marshal(o.toMap())
	if err != nil {
		common.SysError(common.LogText("failed to marshal log other: %s", err.Error()))
		return ""
	}
	return string(data)
}

// JSONString returns the complete stored representation, including all
// privileged scopes. API projections must use the role-specific formatter.
func (o *LogOther) JSONString() string {
	return o.jsonString()
}

// Snapshot returns a detached top-level view for tests and read-only
// inspection. Mutating it cannot add or replace fields in LogOther.
func (o *LogOther) Snapshot() map[string]any {
	if o == nil {
		return nil
	}
	return o.toMap()
}

func (o *LogOther) MarshalJSON() ([]byte, error) {
	return common.Marshal(o.toMap())
}

func normalizeLegacyRejectReason(values map[string]json.RawMessage) bool {
	rejectReason, ok := values["reject_reason"]
	if !ok {
		return false
	}

	adminInfo := make(map[string]json.RawMessage)
	if rawAdminInfo, exists := values[logOtherAdminInfoKey]; exists {
		_ = common.Unmarshal(rawAdminInfo, &adminInfo)
	}
	if adminInfo == nil {
		adminInfo = make(map[string]json.RawMessage)
	}
	if _, exists := adminInfo["reject_reason"]; !exists {
		adminInfo["reject_reason"] = rejectReason
	}
	encodedAdminInfo, err := common.Marshal(adminInfo)
	if err != nil {
		return false
	}
	values[logOtherAdminInfoKey] = encodedAdminInfo
	delete(values, "reject_reason")
	return true
}

// ConsumeLogDisplayFields is the read-only projection of one consume row's
// stored `other` document that the request's owner may see next to its
// settled cost: the applied price ratios, the cached prompt tokens and the
// public request timing. The channel chain lives in the admin-only
// admin_info.use_channel scope, so UseChannels is populated separately and
// callers must only project it for administrators.
type ConsumeLogDisplayFields struct {
	CacheTokens *int
	CacheRatio  *float64
	ModelRatio  *float64
	GroupRatio  *float64
	Timing      *common.RequestTimingPayload
	UseChannels []int
}

// ParseConsumeLogDisplayFields reads the owner-visible figures out of a
// stored consume row. Unknown or malformed documents yield an empty
// projection instead of an error: the settled quota remains displayable even
// when the metadata cannot be read.
func ParseConsumeLogDisplayFields(other string) ConsumeLogDisplayFields {
	var fields ConsumeLogDisplayFields
	if other == "" {
		return fields
	}
	// The phase breakdown lives in the same document but is parsed by its own
	// reader, so a row with a malformed price field still keeps its timing.
	fields.Timing = common.ParseRequestTimingPayload(other)
	var stored struct {
		CacheTokens *int     `json:"cache_tokens"`
		CacheRatio  *float64 `json:"cache_ratio"`
		ModelRatio  *float64 `json:"model_ratio"`
		GroupRatio  *float64 `json:"group_ratio"`
		AdminInfo   struct {
			UseChannel []json.RawMessage `json:"use_channel"`
		} `json:"admin_info"`
	}
	if err := common.UnmarshalJsonStr(other, &stored); err != nil {
		return fields
	}
	fields.CacheTokens = stored.CacheTokens
	fields.CacheRatio = stored.CacheRatio
	fields.ModelRatio = stored.ModelRatio
	fields.GroupRatio = stored.GroupRatio
	fields.UseChannels = make([]int, 0, len(stored.AdminInfo.UseChannel))
	for _, raw := range stored.AdminInfo.UseChannel {
		if id, ok := parseStoredChannelID(raw); ok {
			fields.UseChannels = append(fields.UseChannels, id)
		}
	}
	return fields
}

// parseStoredChannelID accepts both shapes the chain has used: the strings
// written by service.Distribute and the plain numbers stored by older rows.
func parseStoredChannelID(raw json.RawMessage) (int, bool) {
	var text string
	if err := common.Unmarshal(raw, &text); err == nil {
		id, err := strconv.Atoi(strings.TrimSpace(text))
		if err == nil && id > 0 {
			return id, true
		}
		return 0, false
	}
	var number float64
	if err := common.Unmarshal(raw, &number); err != nil {
		return 0, false
	}
	if number <= 0 || number != math.Trunc(number) || number > 1<<31-1 {
		return 0, false
	}
	return int(number), true
}

// formatLogOtherJSON applies the role projection while keeping untouched JSON
// values as RawMessage. This preserves integers larger than JavaScript's safe
// range instead of round-tripping them through float64.
func formatLogOtherJSON(value string, visibility logOtherVisibility) string {
	if value == "" {
		return ""
	}

	var values map[string]json.RawMessage
	if err := common.UnmarshalJsonStr(value, &values); err != nil {
		if visibility == logOtherVisibilityRoot {
			return value
		}
		return "{}"
	}

	changed := false
	if visibility == logOtherVisibilityUser {
		for _, key := range []string{logOtherAdminInfoKey, logOtherRootInfoKey, logOtherAuditInfoKey} {
			if _, exists := values[key]; exists {
				delete(values, key)
				changed = true
			}
		}
		for _, key := range legacySensitiveLogOtherKeys {
			if _, exists := values[key]; exists {
				delete(values, key)
				changed = true
			}
		}
	} else {
		changed = normalizeLegacyRejectReason(values)
		if visibility == logOtherVisibilityAdmin {
			if _, exists := values[logOtherRootInfoKey]; exists {
				delete(values, logOtherRootInfoKey)
				changed = true
			}
		}
	}

	if !changed {
		return value
	}
	formatted, err := common.Marshal(values)
	if err != nil {
		if visibility == logOtherVisibilityRoot {
			return value
		}
		return "{}"
	}
	return string(formatted)
}
