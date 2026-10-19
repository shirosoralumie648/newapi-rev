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

// PlaygroundUsageMetric is one dimension of the unified Playground resource
// usage view: how much the owner stores and the account-level cap that applies.
// Limit and LimitBytes come from the same resource quota policy the write paths
// enforce, so the view never advertises a budget larger than the server allows.
type PlaygroundUsageMetric struct {
	Used       int64 `json:"used"`
	Limit      int64 `json:"limit"`
	UsedBytes  int64 `json:"used_bytes"`
	LimitBytes int64 `json:"limit_bytes"`
}

// PlaygroundResourceUsage groups the storage the owner holds across the
// Playground workspace. Every figure is filtered by user ID, the same owner
// scope the read and write paths use, so one account can never observe another
// account's totals. Group is the user group the limits were resolved from.
type PlaygroundResourceUsage struct {
	Group           string                `json:"group"`
	Sessions        PlaygroundUsageMetric `json:"sessions"`
	Memories        PlaygroundUsageMetric `json:"memories"`
	Attachments     PlaygroundUsageMetric `json:"attachments"`
	Artifacts       PlaygroundUsageMetric `json:"artifacts"`
	Canvas          PlaygroundUsageMetric `json:"canvas"`
	CanvasSnapshots PlaygroundUsageMetric `json:"canvas_snapshots"`
	// CanvasTemplates is the private template library: document bytes plus the
	// raw inline asset bytes. Global market templates are platform content and
	// never appear in an account's counters.
	CanvasTemplates PlaygroundUsageMetric `json:"canvas_templates"`
	// Knowledge bases, their documents and their embedding chunks are separate
	// metrics because the three limits are independent. The chunk metric also
	// carries the knowledge byte budget (source files, extracted text and
	// chunk text plus vectors).
	KnowledgeBases         PlaygroundUsageMetric `json:"knowledge_bases"`
	KnowledgeBaseDocuments PlaygroundUsageMetric `json:"kb_documents"`
	KnowledgeBaseChunks    PlaygroundUsageMetric `json:"kb_chunks"`
	// ComparisonRuns is the persisted compare-run matrix count and snapshot
	// bytes of the account.
	ComparisonRuns PlaygroundUsageMetric `json:"comparison_runs"`
	Storage        PlaygroundUsageMetric `json:"storage"`
	Tasks          PlaygroundUsageMetric `json:"tasks"`
}

// PlaygroundUsageForUser reports the caller's Playground storage against the
// effective quota policy for the caller's group. Every figure comes from the
// account's counter row (playground_user_usage), the same counters the write
// paths enforce, so the view cannot advertise room the server would refuse and
// the read never aggregates the stored rows. An account that never wrote since
// the counters were introduced is measured on the fly. It is read-only and
// never mutates state.
func PlaygroundUsageForUser(userID int) (*PlaygroundResourceUsage, error) {
	policy, group, err := playgroundPolicyForGroup(DB, userID)
	if err != nil {
		return nil, err
	}
	usage := &PlaygroundResourceUsage{
		Group: group,
		Sessions: PlaygroundUsageMetric{
			Limit: int64(policy.SessionMaxCount),
		},
		Memories: PlaygroundUsageMetric{
			Limit: int64(policy.MemoryUserMaxCount),
		},
		Attachments: PlaygroundUsageMetric{
			Limit:      int64(policy.AttachmentUserMaxCount),
			LimitBytes: policy.AttachmentUserMaxBytes,
		},
		Artifacts: PlaygroundUsageMetric{
			Limit:      int64(policy.ArtifactUserMaxCount),
			LimitBytes: policy.ArtifactUserMaxBytes,
		},
		Canvas: PlaygroundUsageMetric{
			Limit:      int64(policy.CanvasUserMaxProjects),
			LimitBytes: policy.CanvasUserMaxBytes,
		},
		CanvasSnapshots: PlaygroundUsageMetric{
			Limit:      int64(policy.CanvasSnapshotUserMaxCount),
			LimitBytes: policy.CanvasSnapshotUserMaxBytes,
		},
		CanvasTemplates: PlaygroundUsageMetric{
			Limit:      int64(policy.CanvasTemplateUserMaxCount),
			LimitBytes: policy.CanvasTemplateUserMaxBytes,
		},
		KnowledgeBases: PlaygroundUsageMetric{
			Limit: int64(policy.KnowledgeBaseUserMaxCount),
		},
		KnowledgeBaseDocuments: PlaygroundUsageMetric{
			Limit: int64(policy.KnowledgeBaseDocumentUserMaxCount),
		},
		KnowledgeBaseChunks: PlaygroundUsageMetric{
			Limit:      int64(policy.KnowledgeBaseChunkUserMaxCount),
			LimitBytes: policy.KnowledgeBaseUserMaxBytes,
		},
		ComparisonRuns: PlaygroundUsageMetric{
			Limit:      int64(policy.ComparisonRunUserMaxCount),
			LimitBytes: policy.ComparisonRunUserMaxBytes,
		},
		Storage: PlaygroundUsageMetric{
			LimitBytes: policy.ObjectUserMaxBytes,
		},
		Tasks: PlaygroundUsageMetric{
			Limit:      int64(policy.TaskMaxConcurrency),
			LimitBytes: policy.TaskUserResultMaxBytes,
		},
	}

	counters, err := readPlaygroundUserUsage(userID)
	if err != nil {
		return nil, err
	}
	usage.Sessions.Used = counters.Sessions
	usage.Memories.Used = counters.Memories
	usage.Attachments.Used = counters.AttachmentCount
	usage.Attachments.UsedBytes = counters.AttachmentBytes
	usage.Artifacts.Used = counters.ArtifactCount
	usage.Artifacts.UsedBytes = counters.ArtifactBytes
	usage.Canvas.Used = counters.CanvasCount
	usage.Canvas.UsedBytes = counters.CanvasBytes
	usage.CanvasSnapshots.Used = counters.CanvasSnapshotCount
	usage.CanvasSnapshots.UsedBytes = counters.CanvasSnapshotBytes
	usage.CanvasTemplates.Used = counters.CanvasTemplateCount
	usage.CanvasTemplates.UsedBytes = counters.CanvasTemplateBytes
	usage.KnowledgeBases.Used = counters.KnowledgeBaseCount
	usage.KnowledgeBaseDocuments.Used = counters.KnowledgeBaseDocumentCount
	usage.KnowledgeBaseChunks.Used = counters.KnowledgeBaseChunkCount
	usage.KnowledgeBaseChunks.UsedBytes = counters.KnowledgeBaseBytes
	usage.ComparisonRuns.Used = counters.ComparisonRunCount
	usage.ComparisonRuns.UsedBytes = counters.ComparisonRunBytes
	// Storage counts the bytes that live in the object store, the same figure
	// the upload path checks against ObjectUserMaxBytes.
	usage.Storage.UsedBytes = counters.ObjectBytes

	// Async generation tasks live outside the Playground tables: their rows are
	// created, polled and finished by the relay and task pipeline, so the two
	// task metrics are still measured directly inside the owner scope.
	activeTasks, err := CountActivePlaygroundTasks(userID)
	if err != nil {
		return nil, err
	}
	usage.Tasks.Used = activeTasks
	taskBytes, err := PlaygroundTaskResultStorageBytes(userID)
	if err != nil {
		return nil, err
	}
	usage.Tasks.UsedBytes = taskBytes

	return usage, nil
}
