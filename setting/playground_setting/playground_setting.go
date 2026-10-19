package playground_setting

import (
	"math"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/group_setting"
)

// PlaygroundStorageBytesPerGB is the byte unit the optional storage billing
// weighs: one GiB at the account's peak daily footprint is one GB-day.
const PlaygroundStorageBytesPerGB = int64(1) << 30

// Egress modes of the storage billing. Unmetered keeps the daily byte and
// request ceilings but never charges for downloads; metered adds the egress
// volume to the day's settlement charge.
const (
	PlaygroundStorageEgressModeUnmetered = "unmetered"
	PlaygroundStorageEgressModeMetered   = "metered"
)

// PlaygroundStorageEgressSetting bounds and (optionally) bills attachment
// egress. The daily limits are enforced for every download regardless of the
// mode: zero means unlimited, and a negative value is treated as unlimited so
// a misconfigured ceiling can never reject every request.
type PlaygroundStorageEgressSetting struct {
	Mode               string  `json:"mode"`
	PriceUSDPerGB      float64 `json:"price_usd_per_gb"`
	DailyBytesLimit    int64   `json:"daily_bytes_limit"`
	DailyRequestsLimit int64   `json:"daily_requests_limit"`
}

// PlaygroundStorageBillingSetting is the optional metered storage tier
// (plan section 9.3): every day the account's peak stored bytes are weighed as
// GB-days at PriceUSDPerGBMonth/30, the free allowance is subtracted, and the
// result is charged to the same wallet the relay consumes from. While the
// charge stays uncovered the account is read-only through the shared wallet
// debt lock; stored data is never deleted.
type PlaygroundStorageBillingSetting struct {
	Enabled            bool    `json:"enabled"`
	PriceUSDPerGBMonth float64 `json:"price_usd_per_gb_month"`
	FreeGB             float64 `json:"free_gb"`
	// GroupFreeGB replaces the free allowance of one user group. The key is a
	// stable group identifier (an editable display name still matches); a
	// present entry applies even when it is zero, so a paid group can be
	// billed from the first byte.
	GroupFreeGB     map[string]float64 `json:"group_free_gb"`
	ApplyGroupRatio bool               `json:"apply_group_ratio"`
	// GraceDays is the settlement grace window recorded on an unpaid day: the
	// account stays read-only until the wallet covers the charge, and the
	// deadline tells the user and the administrator how long that read-only
	// grace already lasts. Data is never deleted.
	GraceDays int                            `json:"grace_days"`
	Egress    PlaygroundStorageEgressSetting `json:"egress"`
}

// IsEnabled reports whether the optional storage billing tier is switched on.
// Everything else in this file may be configured freely while it is off; the
// flag is the single switch that makes the configured prices and limits take
// effect.
func (setting *PlaygroundStorageBillingSetting) IsEnabled() bool {
	return setting != nil && setting.Enabled
}

// PlaygroundStorageEgressModeMetered reports whether egress volume is charged.
func (setting *PlaygroundStorageBillingSetting) EgressMetered() bool {
	return setting != nil && setting.Egress.Mode == PlaygroundStorageEgressModeMetered
}

// EffectivePriceUSDPerGBMonth is the monthly GB price with invalid values
// clamped to zero and audited, so a negative configuration can never turn a
// charge into a credit.
func (setting *PlaygroundStorageBillingSetting) EffectivePriceUSDPerGBMonth() float64 {
	if setting == nil {
		return 0
	}
	return sanitizedStorageBillingPrice(setting.PriceUSDPerGBMonth, "storage billing monthly price")
}

// EffectiveEgressPriceUSDPerGB is the egress GB price with the same guard.
func (setting *PlaygroundStorageBillingSetting) EffectiveEgressPriceUSDPerGB() float64 {
	if setting == nil {
		return 0
	}
	return sanitizedStorageBillingPrice(setting.Egress.PriceUSDPerGB, "storage billing egress price")
}

// EffectiveGraceDays keeps the grace window in a sane range: a negative value
// becomes zero (unpaid days are locked immediately) and an absurd value is
// capped at ten years.
func (setting *PlaygroundStorageBillingSetting) EffectiveGraceDays() int {
	if setting == nil {
		return 0
	}
	days := setting.GraceDays
	if days < 0 {
		common.SysError(common.LogText("playground storage billing grace days is negative, using 0: %d", days))
		return 0
	}
	if days > 3650 {
		common.SysError(common.LogText("playground storage billing grace days exceeds 3650, using 3650: %d", days))
		return 3650
	}
	return days
}

func sanitizedStorageBillingPrice(value float64, label string) float64 {
	if math.IsNaN(value) || value < 0 {
		common.SysError(common.LogText("playground %s is invalid, using 0: %v", label, value))
		return 0
	}
	return value
}

// Web search providers the Playground can query on behalf of one turn. The
// set is closed in the adapter, but the configuration is a plain provider
// identifier so adding another adapter does not change the stored shape.
const (
	PlaygroundWebSearchProviderTavily  = "tavily"
	PlaygroundWebSearchProviderSearXNG = "searxng"
	PlaygroundWebSearchProviderBrave   = "brave"
)

// PlaygroundWebSearchSetting is the administrator configuration of the
// optional web-search turn. The provider call itself never runs in the
// browser: the gateway owns the endpoint and the credential, and the browser
// only submits the query.
type PlaygroundWebSearchSetting struct {
	Enabled  bool   `json:"enabled"`
	Provider string `json:"provider"`
	// BaseURL overrides the provider endpoint. It is required for SearXNG and
	// optional for the hosted providers, where an empty value selects the
	// official endpoint. The adapter appends the provider's fixed search path.
	BaseURL string `json:"base_url"`
	// PriceUSDPerCall is the global wallet price of one successful search.
	PriceUSDPerCall float64 `json:"price_usd_per_call"`
	// GroupPriceUSDPerCall replaces the global price of one group. The key is
	// a stable group identifier (an editable display name still matches); a
	// present entry applies even when it is zero, so a group can search free.
	GroupPriceUSDPerCall map[string]float64 `json:"group_price_usd_per_call"`
}

// IsEnabled reports whether the administrator enabled the web-search turn.
func (setting *PlaygroundWebSearchSetting) IsEnabled() bool {
	return setting != nil && setting.Enabled
}

// EffectivePriceUSDPerCall clamps an invalid global price to zero and audits
// it, so a negative configuration can never turn a search into a credit.
func (setting *PlaygroundWebSearchSetting) EffectivePriceUSDPerCall() float64 {
	if setting == nil {
		return 0
	}
	price := setting.PriceUSDPerCall
	if math.IsNaN(price) || price < 0 {
		common.SysError(common.LogText("playground web search price is invalid, using 0: %v", price))
		return 0
	}
	return price
}

// PriceUSDPerCallForGroup resolves the configured price of one group. The
// global price applies unless the group has an explicit override, which
// applies even when it is zero.
func (setting *PlaygroundWebSearchSetting) PriceUSDPerCallForGroup(group string) float64 {
	if setting == nil {
		return 0
	}
	price := setting.EffectivePriceUSDPerCall()
	if len(setting.GroupPriceUSDPerCall) == 0 {
		return price
	}
	identifier := group_setting.ResolveGroupID(group)
	if override, ok := setting.GroupPriceUSDPerCall[identifier]; ok {
		return sanitizedWebSearchPrice(override, "group price")
	}
	for rawGroup, override := range setting.GroupPriceUSDPerCall {
		if group_setting.ResolveGroupID(rawGroup) == identifier {
			return sanitizedWebSearchPrice(override, "group price")
		}
	}
	return price
}

func sanitizedWebSearchPrice(value float64, label string) float64 {
	if math.IsNaN(value) || value < 0 {
		common.SysError(common.LogText("playground web search %s is invalid, using 0: %v", label, value))
		return 0
	}
	return value
}

// PlaygroundQuotaPolicy is the effective per-account resource budget for the
// Playground workspace: conversations, messages, attachments, artifacts and
// canvas documents. It is deliberately independent of User.Quota and
// UsedQuota. Those resources are storage, not billable token usage, so they are
// enforced here and never touch the token billing settlement path.
//
// A zero or negative value in an override inherits the value below it, so a
// misconfigured option can never silently disable a server-side limit.
type PlaygroundQuotaPolicy struct {
	SessionMaxCount      int   `json:"session_max_count"`
	PresetUserMaxCount   int   `json:"preset_user_max_count"`
	SystemPromptMaxBytes int64 `json:"system_prompt_max_bytes"`
	// SnippetUserMaxCount and SnippetContentMaxBytes bound the account's prompt
	// snippet library: how many snippets it may store and how many bytes one
	// snippet's text may occupy. Snippets are reusable composer text, not
	// stored attachments, so they have no account-level byte budget.
	SnippetUserMaxCount    int   `json:"snippet_user_max_count"`
	SnippetContentMaxBytes int64 `json:"snippet_content_max_bytes"`
	// MemoryUserMaxCount and MemoryContentMaxBytes bound the account's durable
	// cross-session notes: how many memories it may store and how many bytes one
	// memory's text may occupy. Memories are derived from the owner's own
	// conversations and only add context to a normal /pg request, so they have
	// no account-level byte budget.
	MemoryUserMaxCount    int   `json:"memory_user_max_count"`
	MemoryContentMaxBytes int64 `json:"memory_content_max_bytes"`
	MessageMaxCount       int   `json:"message_max_count"`
	MessageMaxVersions    int   `json:"message_max_versions"`
	MessageMaxBytes       int64 `json:"message_max_bytes"`
	// ParallelCompareMaxModels bounds one parallel-comparison message group:
	// how many models a single send may fan out to. Each comparison request is
	// an ordinary /pg call whose own rate limit, channel and billing apply, so
	// this only caps the group the account may persist and launch.
	ParallelCompareMaxModels  int   `json:"parallel_compare_max_models"`
	ToolCallMaxCount          int   `json:"tool_call_max_count"`
	ToolCallArgumentsMaxBytes int64 `json:"tool_call_arguments_max_bytes"`
	ToolCallResultMaxBytes    int64 `json:"tool_call_result_max_bytes"`
	AttachmentMaxCount        int   `json:"attachment_max_count"`
	AttachmentMaxFileBytes    int64 `json:"attachment_max_file_bytes"`
	AttachmentUserMaxBytes    int64 `json:"attachment_user_max_bytes"`
	AttachmentUserMaxCount    int   `json:"attachment_user_max_count"`
	// The extended attachment kinds have their own per-file ceilings: a video is
	// legitimately much larger than a chat image, while the account byte budgets
	// above still bound the total an account may store. The classic limit
	// applies to images; every kind is signature-checked server-side.
	AttachmentVideoMaxFileBytes    int64 `json:"attachment_video_max_file_bytes"`
	AttachmentAudioMaxFileBytes    int64 `json:"attachment_audio_max_file_bytes"`
	AttachmentDocumentMaxFileBytes int64 `json:"attachment_document_max_file_bytes"`
	// DocumentTextMaxBytes and DocumentTextMaxPages bound the text one document
	// attachment may contribute as chat context. PDF extraction stops at either
	// limit, and a document above a limit is reported as too large instead of
	// being silently truncated; the cached outcome keeps the decision stable.
	DocumentTextMaxBytes      int64 `json:"document_text_max_bytes"`
	DocumentTextMaxPages      int   `json:"document_text_max_pages"`
	ArtifactSessionMaxCount   int   `json:"artifact_session_max_count"`
	ArtifactSessionMaxRecords int   `json:"artifact_session_max_records"`
	ArtifactMaxVersions       int   `json:"artifact_max_versions"`
	ArtifactContentMaxBytes   int64 `json:"artifact_content_max_bytes"`
	ArtifactMaxBytes          int64 `json:"artifact_max_bytes"`
	ArtifactSessionMaxBytes   int64 `json:"artifact_session_max_bytes"`
	ArtifactUserMaxCount      int   `json:"artifact_user_max_count"`
	ArtifactUserMaxBytes      int64 `json:"artifact_user_max_bytes"`
	CanvasUserMaxProjects     int   `json:"canvas_user_max_projects"`
	CanvasDocumentMaxBytes    int64 `json:"canvas_document_max_bytes"`
	CanvasMaxNodes            int   `json:"canvas_max_nodes"`
	CanvasMaxEdges            int   `json:"canvas_max_edges"`
	CanvasNodeDataMaxBytes    int64 `json:"canvas_node_data_max_bytes"`
	CanvasUserMaxBytes        int64 `json:"canvas_user_max_bytes"`
	// Canvas snapshot history is written while the board is saved: a snapshot
	// is captured after every CanvasSnapshotEverySaves document saves, after
	// CanvasSnapshotIntervalMinutes since the previous one, and once for the
	// first save of a board. Snapshots are gzip objects in the object store and
	// count against the account's snapshot count and byte budgets, so history
	// can never grow without a server-enforced cap.
	CanvasSnapshotEverySaves        int   `json:"canvas_snapshot_every_saves"`
	CanvasSnapshotIntervalMinutes   int   `json:"canvas_snapshot_interval_minutes"`
	CanvasSnapshotPerCanvasMaxCount int   `json:"canvas_snapshot_per_canvas_max_count"`
	CanvasSnapshotUserMaxCount      int   `json:"canvas_snapshot_user_max_count"`
	CanvasSnapshotUserMaxBytes      int64 `json:"canvas_snapshot_user_max_bytes"`
	// Knowledge base budgets (LB-07). Bases, their documents and their
	// embedding chunks have independent count limits; the byte budget weighs
	// the source files, the extracted text and the stored chunk text plus
	// vectors. ChunkTextMaxBytes bounds one chunk, ChunkMaxCount bounds one
	// document and EmbeddingMaxDims bounds one vector, so a single document or
	// vector can never make the index unbounded.
	KnowledgeBaseUserMaxCount         int   `json:"knowledge_base_user_max_count"`
	KnowledgeBaseDocumentUserMaxCount int   `json:"knowledge_base_document_user_max_count"`
	KnowledgeBaseDocumentMaxCount     int   `json:"knowledge_base_document_max_count"`
	KnowledgeBaseChunkUserMaxCount    int   `json:"knowledge_base_chunk_user_max_count"`
	KnowledgeBaseChunkMaxCount        int   `json:"knowledge_base_chunk_max_count"`
	KnowledgeBaseChunkTextMaxBytes    int64 `json:"knowledge_base_chunk_text_max_bytes"`
	KnowledgeBaseEmbeddingMaxDims     int   `json:"knowledge_base_embedding_max_dims"`
	KnowledgeBaseUserMaxBytes         int64 `json:"knowledge_base_user_max_bytes"`
	// ObjectUserMaxBytes caps the bytes the account keeps in the object store
	// (conversation and canvas attachments today, generated results once they
	// are persisted there). It is the account-level storage entitlement a
	// subscription plan grants by upgrading the buyer into a group whose
	// override is larger.
	ObjectUserMaxBytes     int64 `json:"object_user_max_bytes"`
	TaskMaxConcurrency     int   `json:"task_max_concurrency"`
	TaskUserResultMaxBytes int64 `json:"task_user_result_max_bytes"`
	// TrashRetentionDays is how long a soft-deleted conversation or canvas
	// stays recoverable in the trash before the cleanup task purges it. A
	// resource in the trash keeps occupying the account budgets until that
	// purge, so restoring it can never exceed a limit the account already
	// enforced; only the purge releases the stored rows and bytes.
	TrashRetentionDays int `json:"trash_retention_days"`
}

// PlaygroundSetting is the persisted configuration. Defaults is the global
// budget; GroupOverrides replaces individual fields for one user group. Every
// default equals the hard limit Playground enforced before quotas became
// configurable, so enabling the policy never loosens an existing limit.
type PlaygroundSetting struct {
	Defaults       *PlaygroundQuotaPolicy           `json:"defaults"`
	GroupOverrides map[string]PlaygroundQuotaPolicy `json:"group_overrides"`
	// SandboxPreviewEnabled turns on the sandboxed preview of HTML and SVG
	// artifacts. It stays off by default: artifact content is model output the
	// account did not author, so an administrator must opt in before the
	// Playground mounts it inside the sandboxed iframe.
	SandboxPreviewEnabled bool `json:"sandbox_preview_enabled"`
	// StorageBilling is the optional metered storage tier. It is off by
	// default: enabling it is the explicit administrator decision to charge
	// the same wallet for the bytes an account keeps.
	StorageBilling *PlaygroundStorageBillingSetting `json:"storage_billing"`
	// WebSearch is the optional search-with-this-turn feature. It stays off
	// until an administrator configures a provider.
	WebSearch *PlaygroundWebSearchSetting `json:"web_search"`
	// WebSearchAPIKey is stored as its own top-level option so the sensitive
	// option filter hides it; the nested WebSearch JSON never contains it.
	// An empty value means SearXNG runs unauthenticated or the hosted provider
	// is not configured yet.
	WebSearchAPIKey string `json:"web_search_api_key"`
}

var playgroundSetting = newPlaygroundSetting()

func init() {
	config.GlobalConfig.Register("playground_setting", &playgroundSetting)
}

func newPlaygroundSetting() PlaygroundSetting {
	defaults := builtinPlaygroundQuotaPolicy()
	return PlaygroundSetting{
		Defaults:       &defaults,
		GroupOverrides: map[string]PlaygroundQuotaPolicy{},
		StorageBilling: builtinPlaygroundStorageBillingSetting(),
		WebSearch:      builtinPlaygroundWebSearchSetting(),
	}
}

// builtinPlaygroundWebSearchSetting starts disabled with the hosted provider
// most deployments already have a key for. The official base URL stays empty
// so the adapter can choose it; SearXNG requires an explicit self-hosted URL.
func builtinPlaygroundWebSearchSetting() *PlaygroundWebSearchSetting {
	return &PlaygroundWebSearchSetting{
		Enabled:              false,
		Provider:             PlaygroundWebSearchProviderTavily,
		GroupPriceUSDPerCall: map[string]float64{},
	}
}

// builtinPlaygroundStorageBillingSetting returns the disabled starting
// configuration. The reference prices follow the plan's storage research
// (Cloudflare R2, 0.015 USD per GB-month); they only take effect after an
// administrator enables the tier, and the egress price starts at zero so
// enabling metered egress without a price bills nothing.
func builtinPlaygroundStorageBillingSetting() *PlaygroundStorageBillingSetting {
	return &PlaygroundStorageBillingSetting{
		Enabled:            false,
		PriceUSDPerGBMonth: 0.015,
		FreeGB:             1,
		GroupFreeGB:        map[string]float64{},
		ApplyGroupRatio:    false,
		GraceDays:          7,
		Egress: PlaygroundStorageEgressSetting{
			Mode:          PlaygroundStorageEgressModeUnmetered,
			PriceUSDPerGB: 0,
		},
	}
}

// GetPlaygroundStorageBillingSetting returns the persisted storage billing
// configuration. Callers must not mutate it outside tests.
func GetPlaygroundStorageBillingSetting() *PlaygroundStorageBillingSetting {
	return playgroundSetting.StorageBilling
}

// FreeBytesForGroup resolves the free storage allowance of one user group in
// bytes. The global FreeGB applies unless the group has an explicit override,
// which applies even when it is zero; an editable display name still matches
// its stable identifier. Invalid values are clamped to zero and audited, so a
// misconfigured allowance can only reduce the billable amount.
func (setting *PlaygroundStorageBillingSetting) FreeBytesForGroup(group string) int64 {
	if setting == nil {
		return 0
	}
	gb := setting.FreeGB
	if len(setting.GroupFreeGB) > 0 {
		identifier := group_setting.ResolveGroupID(group)
		if override, ok := setting.GroupFreeGB[identifier]; ok {
			gb = override
		} else {
			for rawGroup, override := range setting.GroupFreeGB {
				if rawGroup != identifier && group_setting.ResolveGroupID(rawGroup) == identifier {
					gb = override
					break
				}
			}
		}
	}
	if math.IsNaN(gb) || gb < 0 {
		common.SysError(common.LogText("playground storage billing free GB for group %q is invalid, using 0: %v", group, gb))
		return 0
	}
	if gb > 1<<40 {
		common.SysError(common.LogText("playground storage billing free GB for group %q exceeds 1 PiB, using 1 PiB: %v", group, gb))
		gb = 1 << 40
	}
	return int64(gb * float64(PlaygroundStorageBytesPerGB))
}

// EgressDailyLimits resolves the daily download ceilings of one group: the
// uploaded bytes and the request count. Zero means unlimited, and a negative
// configuration is treated as unlimited after an audit line.
func (setting *PlaygroundStorageBillingSetting) EgressDailyLimits(group string) (bytesLimit int64, requestsLimit int64) {
	if setting == nil {
		return 0, 0
	}
	bytesLimit, requestsLimit = setting.Egress.DailyBytesLimit, setting.Egress.DailyRequestsLimit
	if bytesLimit < 0 {
		common.SysError(common.LogText("playground storage billing egress byte limit for group %q is negative, treating it as unlimited: %d", group, bytesLimit))
		bytesLimit = 0
	}
	if requestsLimit < 0 {
		common.SysError(common.LogText("playground storage billing egress request limit for group %q is negative, treating it as unlimited: %d", group, requestsLimit))
		requestsLimit = 0
	}
	return bytesLimit, requestsLimit
}

// builtinPlaygroundQuotaPolicy returns the values Playground enforced before
// the policy existed.
func builtinPlaygroundQuotaPolicy() PlaygroundQuotaPolicy {
	return PlaygroundQuotaPolicy{
		SessionMaxCount:           100,
		PresetUserMaxCount:        50,
		SystemPromptMaxBytes:      16 << 10,
		SnippetUserMaxCount:       100,
		SnippetContentMaxBytes:    8 << 10,
		MemoryUserMaxCount:        100,
		MemoryContentMaxBytes:     4 << 10,
		MessageMaxCount:           100,
		MessageMaxVersions:        100,
		MessageMaxBytes:           1 << 20,
		ParallelCompareMaxModels:  4,
		ToolCallMaxCount:          16,
		ToolCallArgumentsMaxBytes: 64 << 10,
		ToolCallResultMaxBytes:    256 << 10,
		AttachmentMaxCount:        8,
		AttachmentMaxFileBytes:    8 << 20,
		AttachmentUserMaxBytes:    64 << 20,
		AttachmentUserMaxCount:    500,
		// The extended kinds start at the ceilings the upload endpoint already
		// enforced for generated media: video is capped at 64 MiB, audio and
		// documents at 16 MiB, and the account byte budgets above still bound
		// the total.
		AttachmentVideoMaxFileBytes:    64 << 20,
		AttachmentAudioMaxFileBytes:    16 << 20,
		AttachmentDocumentMaxFileBytes: 16 << 20,
		// A document contributes its extracted text as context. One document may
		// contribute at most 256 KiB of text and a PDF at most 200 pages: both
		// stay far below a context window while a single oversized document can
		// never occupy the whole conversation.
		DocumentTextMaxBytes:      256 << 10,
		DocumentTextMaxPages:      200,
		ArtifactSessionMaxCount:   32,
		ArtifactSessionMaxRecords: 256,
		ArtifactMaxVersions:       100,
		ArtifactContentMaxBytes:   256 << 10,
		ArtifactMaxBytes:          8 << 20,
		ArtifactSessionMaxBytes:   32 << 20,
		// The account-level artifact budget starts at the ceiling the per-session
		// limits already imply (100 conversations x 32 active artifacts and
		// 100 conversations x 32 MiB). It therefore never rejects a write that
		// the previous per-session enforcement accepted, while giving the unified
		// usage view and administrators a real, enforced account cap.
		ArtifactUserMaxCount:   3200,
		ArtifactUserMaxBytes:   32 << 20 * 100,
		CanvasUserMaxProjects:  20,
		CanvasDocumentMaxBytes: 1 << 20,
		CanvasMaxNodes:         200,
		CanvasMaxEdges:         400,
		CanvasNodeDataMaxBytes: 64 << 10,
		CanvasUserMaxBytes:     16 << 20,
		// History starts on the first document save and then keeps one snapshot
		// per ten saves or per half hour, retaining ten per board. The account
		// ceilings bound the whole workspace at 200 snapshots / 64 MiB, and the
		// per-board retention keeps the newest states, which is what a restore
		// needs; older states are dropped by the documented retention rule.
		CanvasSnapshotEverySaves:        10,
		CanvasSnapshotIntervalMinutes:   30,
		CanvasSnapshotPerCanvasMaxCount: 10,
		CanvasSnapshotUserMaxCount:      200,
		CanvasSnapshotUserMaxBytes:      64 << 20,
		// Knowledge bases reuse the 16 MiB document ceiling and the 256 KiB
		// text extraction budget above. A base holds up to 50 documents, one
		// document up to 500 chunks of at most 4 KiB text, and an account up
		// to 20 bases / 200 documents / 10000 chunks / 128 MiB of source,
		// extracted text and vectors. Embedding models with up to 4096
		// dimensions fit (text-embedding-3-large uses 3072).
		KnowledgeBaseUserMaxCount:         20,
		KnowledgeBaseDocumentUserMaxCount: 200,
		KnowledgeBaseDocumentMaxCount:     50,
		KnowledgeBaseChunkUserMaxCount:    10000,
		KnowledgeBaseChunkMaxCount:        500,
		KnowledgeBaseChunkTextMaxBytes:    4 << 10,
		KnowledgeBaseEmbeddingMaxDims:     4096,
		KnowledgeBaseUserMaxBytes:         128 << 20,
		// The account-level object-store budget starts at the ceiling the
		// existing attachment and generated-result budgets already imply
		// (64 MiB each), so enabling it never rejects a write the previous
		// limits accepted while still capping the durable object footprint.
		ObjectUserMaxBytes: 128 << 20,
		TaskMaxConcurrency: 3,
		// The account-level result storage budget for Playground-origin async
		// tasks. Scheduled expiry frees finished task rows after the retention
		// window, so a healthy workspace stays far below this ceiling.
		TaskUserResultMaxBytes: 64 << 20,
		// A deleted conversation or canvas stays in the trash for 30 days
		// before the cleanup task removes its rows and bytes.
		TrashRetentionDays: 30,
	}
}

func GetPlaygroundSetting() *PlaygroundSetting {
	return &playgroundSetting
}

// GetPlaygroundWebSearchSetting returns the persisted web-search
// configuration. Callers must not mutate it outside tests.
func GetPlaygroundWebSearchSetting() *PlaygroundWebSearchSetting {
	if playgroundSetting.WebSearch == nil {
		playgroundSetting.WebSearch = builtinPlaygroundWebSearchSetting()
	}
	return playgroundSetting.WebSearch
}

// IsWebSearchEnabled reports whether the search-with-this-turn control should
// be offered to users. An unanswered or incomplete configuration stays off.
func IsWebSearchEnabled() bool {
	return GetPlaygroundWebSearchSetting().IsEnabled()
}

// GetPlaygroundWebSearchAPIKey returns the server-side provider credential.
// It is never serialized into a web-console response.
func GetPlaygroundWebSearchAPIKey() string {
	return strings.TrimSpace(playgroundSetting.WebSearchAPIKey)
}

// IsSandboxPreviewEnabled reports whether administrators enabled the sandboxed
// HTML/SVG artifact preview. A zero value (the shipped default) means the
// browser must not render artifact content at all.
func IsSandboxPreviewEnabled() bool {
	return playgroundSetting.SandboxPreviewEnabled
}

// GetPlaygroundQuotaPolicy resolves the effective budget for a user group:
// built-in defaults, then the global configuration, then the group override.
// A group reference may still use an editable display name, so it is resolved
// to the stable identifier first.
func GetPlaygroundQuotaPolicy(group string) PlaygroundQuotaPolicy {
	policy := builtinPlaygroundQuotaPolicy()
	applyPlaygroundQuotaOverrides(&policy, playgroundSetting.Defaults)
	if override, ok := playgroundGroupOverride(group); ok {
		applyPlaygroundQuotaOverrides(&policy, override)
	}
	return policy
}

// playgroundGroupOverride returns the configured override for a group. The
// policy is keyed by stable identifiers; a stored key that uses an editable
// display name (an older configuration) still matches, so a rename never drops
// a budget silently.
func playgroundGroupOverride(group string) (*PlaygroundQuotaPolicy, bool) {
	identifier := group_setting.ResolveGroupID(group)
	if override, ok := playgroundSetting.GroupOverrides[identifier]; ok {
		return &override, true
	}
	for rawGroup, override := range playgroundSetting.GroupOverrides {
		if rawGroup == identifier {
			continue // already checked above
		}
		if group_setting.ResolveGroupID(rawGroup) == identifier {
			return &override, true
		}
	}
	return nil, false
}

// applyPlaygroundQuotaOverrides copies every positive field over the policy so
// an absent or zero override field keeps the value it inherited.
func applyPlaygroundQuotaOverrides(policy *PlaygroundQuotaPolicy, override *PlaygroundQuotaPolicy) {
	if override == nil {
		return
	}
	if override.SessionMaxCount > 0 {
		policy.SessionMaxCount = override.SessionMaxCount
	}
	if override.PresetUserMaxCount > 0 {
		policy.PresetUserMaxCount = override.PresetUserMaxCount
	}
	if override.SystemPromptMaxBytes > 0 {
		policy.SystemPromptMaxBytes = override.SystemPromptMaxBytes
	}
	if override.SnippetUserMaxCount > 0 {
		policy.SnippetUserMaxCount = override.SnippetUserMaxCount
	}
	if override.SnippetContentMaxBytes > 0 {
		policy.SnippetContentMaxBytes = override.SnippetContentMaxBytes
	}
	if override.MemoryUserMaxCount > 0 {
		policy.MemoryUserMaxCount = override.MemoryUserMaxCount
	}
	if override.MemoryContentMaxBytes > 0 {
		policy.MemoryContentMaxBytes = override.MemoryContentMaxBytes
	}
	if override.MessageMaxCount > 0 {
		policy.MessageMaxCount = override.MessageMaxCount
	}
	if override.MessageMaxVersions > 0 {
		policy.MessageMaxVersions = override.MessageMaxVersions
	}
	if override.MessageMaxBytes > 0 {
		policy.MessageMaxBytes = override.MessageMaxBytes
	}
	if override.ParallelCompareMaxModels > 0 {
		policy.ParallelCompareMaxModels = override.ParallelCompareMaxModels
	}
	if override.ToolCallMaxCount > 0 {
		policy.ToolCallMaxCount = override.ToolCallMaxCount
	}
	if override.ToolCallArgumentsMaxBytes > 0 {
		policy.ToolCallArgumentsMaxBytes = override.ToolCallArgumentsMaxBytes
	}
	if override.ToolCallResultMaxBytes > 0 {
		policy.ToolCallResultMaxBytes = override.ToolCallResultMaxBytes
	}
	if override.AttachmentMaxCount > 0 {
		policy.AttachmentMaxCount = override.AttachmentMaxCount
	}
	if override.AttachmentMaxFileBytes > 0 {
		policy.AttachmentMaxFileBytes = override.AttachmentMaxFileBytes
	}
	if override.AttachmentUserMaxBytes > 0 {
		policy.AttachmentUserMaxBytes = override.AttachmentUserMaxBytes
	}
	if override.AttachmentUserMaxCount > 0 {
		policy.AttachmentUserMaxCount = override.AttachmentUserMaxCount
	}
	if override.AttachmentVideoMaxFileBytes > 0 {
		policy.AttachmentVideoMaxFileBytes = override.AttachmentVideoMaxFileBytes
	}
	if override.AttachmentAudioMaxFileBytes > 0 {
		policy.AttachmentAudioMaxFileBytes = override.AttachmentAudioMaxFileBytes
	}
	if override.AttachmentDocumentMaxFileBytes > 0 {
		policy.AttachmentDocumentMaxFileBytes = override.AttachmentDocumentMaxFileBytes
	}
	if override.DocumentTextMaxBytes > 0 {
		policy.DocumentTextMaxBytes = override.DocumentTextMaxBytes
	}
	if override.DocumentTextMaxPages > 0 {
		policy.DocumentTextMaxPages = override.DocumentTextMaxPages
	}
	if override.ArtifactSessionMaxCount > 0 {
		policy.ArtifactSessionMaxCount = override.ArtifactSessionMaxCount
	}
	if override.ArtifactSessionMaxRecords > 0 {
		policy.ArtifactSessionMaxRecords = override.ArtifactSessionMaxRecords
	}
	if override.ArtifactMaxVersions > 0 {
		policy.ArtifactMaxVersions = override.ArtifactMaxVersions
	}
	if override.ArtifactContentMaxBytes > 0 {
		policy.ArtifactContentMaxBytes = override.ArtifactContentMaxBytes
	}
	if override.ArtifactMaxBytes > 0 {
		policy.ArtifactMaxBytes = override.ArtifactMaxBytes
	}
	if override.ArtifactSessionMaxBytes > 0 {
		policy.ArtifactSessionMaxBytes = override.ArtifactSessionMaxBytes
	}
	if override.ArtifactUserMaxCount > 0 {
		policy.ArtifactUserMaxCount = override.ArtifactUserMaxCount
	}
	if override.ArtifactUserMaxBytes > 0 {
		policy.ArtifactUserMaxBytes = override.ArtifactUserMaxBytes
	}
	if override.CanvasUserMaxProjects > 0 {
		policy.CanvasUserMaxProjects = override.CanvasUserMaxProjects
	}
	if override.CanvasDocumentMaxBytes > 0 {
		policy.CanvasDocumentMaxBytes = override.CanvasDocumentMaxBytes
	}
	if override.CanvasMaxNodes > 0 {
		policy.CanvasMaxNodes = override.CanvasMaxNodes
	}
	if override.CanvasMaxEdges > 0 {
		policy.CanvasMaxEdges = override.CanvasMaxEdges
	}
	if override.CanvasNodeDataMaxBytes > 0 {
		policy.CanvasNodeDataMaxBytes = override.CanvasNodeDataMaxBytes
	}
	if override.CanvasUserMaxBytes > 0 {
		policy.CanvasUserMaxBytes = override.CanvasUserMaxBytes
	}
	if override.CanvasSnapshotEverySaves > 0 {
		policy.CanvasSnapshotEverySaves = override.CanvasSnapshotEverySaves
	}
	if override.CanvasSnapshotIntervalMinutes > 0 {
		policy.CanvasSnapshotIntervalMinutes = override.CanvasSnapshotIntervalMinutes
	}
	if override.CanvasSnapshotPerCanvasMaxCount > 0 {
		policy.CanvasSnapshotPerCanvasMaxCount = override.CanvasSnapshotPerCanvasMaxCount
	}
	if override.CanvasSnapshotUserMaxCount > 0 {
		policy.CanvasSnapshotUserMaxCount = override.CanvasSnapshotUserMaxCount
	}
	if override.CanvasSnapshotUserMaxBytes > 0 {
		policy.CanvasSnapshotUserMaxBytes = override.CanvasSnapshotUserMaxBytes
	}
	if override.KnowledgeBaseUserMaxCount > 0 {
		policy.KnowledgeBaseUserMaxCount = override.KnowledgeBaseUserMaxCount
	}
	if override.KnowledgeBaseDocumentUserMaxCount > 0 {
		policy.KnowledgeBaseDocumentUserMaxCount = override.KnowledgeBaseDocumentUserMaxCount
	}
	if override.KnowledgeBaseDocumentMaxCount > 0 {
		policy.KnowledgeBaseDocumentMaxCount = override.KnowledgeBaseDocumentMaxCount
	}
	if override.KnowledgeBaseChunkUserMaxCount > 0 {
		policy.KnowledgeBaseChunkUserMaxCount = override.KnowledgeBaseChunkUserMaxCount
	}
	if override.KnowledgeBaseChunkMaxCount > 0 {
		policy.KnowledgeBaseChunkMaxCount = override.KnowledgeBaseChunkMaxCount
	}
	if override.KnowledgeBaseChunkTextMaxBytes > 0 {
		policy.KnowledgeBaseChunkTextMaxBytes = override.KnowledgeBaseChunkTextMaxBytes
	}
	if override.KnowledgeBaseEmbeddingMaxDims > 0 {
		policy.KnowledgeBaseEmbeddingMaxDims = override.KnowledgeBaseEmbeddingMaxDims
	}
	if override.KnowledgeBaseUserMaxBytes > 0 {
		policy.KnowledgeBaseUserMaxBytes = override.KnowledgeBaseUserMaxBytes
	}
	if override.ObjectUserMaxBytes > 0 {
		policy.ObjectUserMaxBytes = override.ObjectUserMaxBytes
	}
	if override.TaskMaxConcurrency > 0 {
		policy.TaskMaxConcurrency = override.TaskMaxConcurrency
	}
	if override.TaskUserResultMaxBytes > 0 {
		policy.TaskUserResultMaxBytes = override.TaskUserResultMaxBytes
	}
	if override.TrashRetentionDays > 0 {
		policy.TrashRetentionDays = override.TrashRetentionDays
	}
}

// TrashRetentionSeconds is the resolved trash window in seconds, floored at one
// day so a misconfigured policy can never purge a conversation right after it
// was deleted.
func (policy PlaygroundQuotaPolicy) TrashRetentionSeconds() int64 {
	return int64(max(policy.TrashRetentionDays, 1)) * 24 * 60 * 60
}

// AttachmentMediaMaxFileBytes resolves the per-file ceiling of one declared
// media type. It is the single place the per-kind rule lives, so the request
// pre-check and the transactional validation can never disagree. A type outside
// the upload whitelist falls through to the classic image budget; the caller
// rejects the unknown type before any size is considered.
func (policy PlaygroundQuotaPolicy) AttachmentMediaMaxFileBytes(mediaType string) int64 {
	switch {
	case strings.HasPrefix(mediaType, "video/"):
		return policy.AttachmentVideoMaxFileBytes
	case strings.HasPrefix(mediaType, "audio/"):
		return policy.AttachmentAudioMaxFileBytes
	case mediaType == "application/pdf", strings.HasPrefix(mediaType, "text/"):
		return policy.AttachmentDocumentMaxFileBytes
	default:
		return policy.AttachmentMaxFileBytes
	}
}
