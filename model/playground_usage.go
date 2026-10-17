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
}

// PlaygroundUsageForUser reports the caller's Playground storage against the
// effective quota policy for the caller's group. It is read-only and never
// mutates state.
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
	}

	if err := DB.Model(&PlaygroundSession{}).Where("user_id = ?", userID).Count(&usage.Sessions.Used).Error; err != nil {
		return nil, err
	}

	var attachments struct {
		Used      int64
		UsedBytes int64
	}
	if err := DB.Model(&PlaygroundAttachment{}).Where("user_id = ?", userID).
		Select("COUNT(*) AS used, COALESCE(SUM(byte_size), 0) AS used_bytes").Scan(&attachments).Error; err != nil {
		return nil, err
	}
	usage.Attachments.Used = attachments.Used
	usage.Attachments.UsedBytes = attachments.UsedBytes

	// Only live artifacts count: a tombstoned artifact has had its versions
	// removed, so it no longer occupies the account budget.
	var artifacts struct {
		Used int64
	}
	if err := DB.Model(&PlaygroundArtifact{}).Where("user_id = ? AND deleted_at = 0", userID).
		Select("COUNT(*) AS used").Scan(&artifacts).Error; err != nil {
		return nil, err
	}
	usage.Artifacts.Used = artifacts.Used

	artifactIDs := DB.Model(&PlaygroundArtifact{}).Select("id").Where("user_id = ?", userID)
	var artifactBytes struct {
		UsedBytes int64
	}
	if err := DB.Model(&PlaygroundArtifactVersion{}).Where("artifact_id IN (?)", artifactIDs).
		Select("COALESCE(SUM(byte_size), 0) AS used_bytes").Scan(&artifactBytes).Error; err != nil {
		return nil, err
	}
	usage.Artifacts.UsedBytes = artifactBytes.UsedBytes

	var canvas struct {
		Used      int64
		UsedBytes int64
	}
	if err := DB.Model(&PlaygroundCanvasProject{}).Where("user_id = ?", userID).
		Select("COUNT(*) AS used, COALESCE(SUM(document_bytes), 0) AS used_bytes").Scan(&canvas).Error; err != nil {
		return nil, err
	}
	usage.Canvas.Used = canvas.Used
	usage.Canvas.UsedBytes = canvas.UsedBytes

	return usage, nil
}
