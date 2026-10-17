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
// account's totals.
type PlaygroundResourceUsage struct {
	Sessions    PlaygroundUsageMetric `json:"sessions"`
	Attachments PlaygroundUsageMetric `json:"attachments"`
	Artifacts   PlaygroundUsageMetric `json:"artifacts"`
	Canvas      PlaygroundUsageMetric `json:"canvas"`
	Tasks       PlaygroundUsageMetric `json:"tasks"`
}

// PlaygroundUsageForUser reports the caller's Playground storage against the
// effective quota policy for the caller's group. Every figure comes from the
// account's counter row (playground_user_usage), the same counters the write
// paths enforce, so the view cannot advertise room the server would refuse and
// the read never aggregates the stored rows. An account that never wrote since
// the counters were introduced is measured on the fly. It is read-only and
// never mutates state.
func PlaygroundUsageForUser(userID int) (*PlaygroundResourceUsage, error) {
	policy, err := PlaygroundQuotaPolicyForUser(userID)
	if err != nil {
		return nil, err
	}
	usage := &PlaygroundResourceUsage{
		Sessions: PlaygroundUsageMetric{
			Limit: int64(policy.SessionMaxCount),
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
		Tasks: PlaygroundUsageMetric{
			Limit:      int64(policy.TaskMaxConcurrency),
			LimitBytes: policy.TaskUserResultMaxBytes,
		},
	}

	counters, err := playgroundUserUsageCounters(userID)
	if err != nil {
		return nil, err
	}
	usage.Sessions.Used = counters.Sessions
	usage.Attachments.Used = counters.AttachmentCount
	usage.Attachments.UsedBytes = counters.AttachmentBytes
	usage.Artifacts.Used = counters.ArtifactCount
	usage.Artifacts.UsedBytes = counters.ArtifactBytes
	usage.Canvas.Used = counters.CanvasCount
	usage.Canvas.UsedBytes = counters.CanvasBytes

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
