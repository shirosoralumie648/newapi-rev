package playground_setting

import (
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/group_setting"
)

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
	MessageMaxCount        int   `json:"message_max_count"`
	MessageMaxVersions     int   `json:"message_max_versions"`
	MessageMaxBytes        int64 `json:"message_max_bytes"`
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
}

var playgroundSetting = newPlaygroundSetting()

func init() {
	config.GlobalConfig.Register("playground_setting", &playgroundSetting)
}

func newPlaygroundSetting() PlaygroundSetting {
	defaults := builtinPlaygroundQuotaPolicy()
	return PlaygroundSetting{Defaults: &defaults, GroupOverrides: map[string]PlaygroundQuotaPolicy{}}
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
