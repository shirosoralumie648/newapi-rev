package playground_setting

import "github.com/QuantumNous/new-api/setting/config"

// PlaygroundQuotaPolicy is the effective per-account resource budget for the
// Playground workspace: conversations, messages, attachments, artifacts and
// canvas documents. It is deliberately independent of User.Quota and
// UsedQuota. Those resources are storage, not billable token usage, so they are
// enforced here and never touch the token billing settlement path.
//
// A zero or negative value in an override inherits the value below it, so a
// misconfigured option can never silently disable a server-side limit.
type PlaygroundQuotaPolicy struct {
	SessionMaxCount           int   `json:"session_max_count"`
	MessageMaxCount           int   `json:"message_max_count"`
	MessageMaxVersions        int   `json:"message_max_versions"`
	MessageMaxBytes           int64 `json:"message_max_bytes"`
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
	TaskMaxConcurrency        int   `json:"task_max_concurrency"`
	TaskUserResultMaxBytes    int64 `json:"task_user_result_max_bytes"`
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
		MessageMaxCount:           100,
		MessageMaxVersions:        100,
		MessageMaxBytes:           1 << 20,
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
		TaskMaxConcurrency:     3,
		// The account-level result storage budget for Playground-origin async
		// tasks. Scheduled expiry frees finished task rows after the retention
		// window, so a healthy workspace stays far below this ceiling.
		TaskUserResultMaxBytes: 64 << 20,
	}
}

func GetPlaygroundSetting() *PlaygroundSetting {
	return &playgroundSetting
}

// GetPlaygroundQuotaPolicy resolves the effective budget for a user group:
// built-in defaults, then the global configuration, then the group override.
func GetPlaygroundQuotaPolicy(group string) PlaygroundQuotaPolicy {
	policy := builtinPlaygroundQuotaPolicy()
	applyPlaygroundQuotaOverrides(&policy, playgroundSetting.Defaults)
	if override, ok := playgroundSetting.GroupOverrides[group]; ok {
		applyPlaygroundQuotaOverrides(&policy, &override)
	}
	return policy
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
	if override.MessageMaxCount > 0 {
		policy.MessageMaxCount = override.MessageMaxCount
	}
	if override.MessageMaxVersions > 0 {
		policy.MessageMaxVersions = override.MessageMaxVersions
	}
	if override.MessageMaxBytes > 0 {
		policy.MessageMaxBytes = override.MessageMaxBytes
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
	if override.TaskMaxConcurrency > 0 {
		policy.TaskMaxConcurrency = override.TaskMaxConcurrency
	}
	if override.TaskUserResultMaxBytes > 0 {
		policy.TaskUserResultMaxBytes = override.TaskUserResultMaxBytes
	}
}
