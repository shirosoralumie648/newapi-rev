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
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"gorm.io/gorm"
)

// Playground workflow run history (PG2-07). One row records one execution of a
// canvas workflow: the immutable inputs (canvas, workflow revision, run
// budget) plus the bounded per-node snapshot the browser reports as steps
// settle. The node fingerprints recorded here are the reuse keys of the node
// cache, so a later run can adopt an unchanged upstream output instead of
// calling a model again. Nothing in this table charges quota: every step is an
// ordinary /pg relay request with its own pre-charge, settlement and group.
const (
	// PlaygroundWorkflowRunStatusRunning marks a run whose steps are still
	// being executed by the browser.
	PlaygroundWorkflowRunStatusRunning = "running"
	// PlaygroundWorkflowRunStatusCompleted means every step reached a final
	// state, per-node failures included.
	PlaygroundWorkflowRunStatusCompleted = "completed"
	// PlaygroundWorkflowRunStatusFailed means the run stopped on a failed
	// step before the remaining steps could execute.
	PlaygroundWorkflowRunStatusFailed = "failed"
	// PlaygroundWorkflowRunStatusCanceled means the user stopped the run.
	PlaygroundWorkflowRunStatusCanceled = "canceled"

	// PlaygroundWorkflowNodeStatusSucceeded marks a step whose output is a
	// reusable cache entry, whether it was executed or adopted.
	PlaygroundWorkflowNodeStatusSucceeded = "succeeded"
	PlaygroundWorkflowNodeStatusFailed    = "failed"
	PlaygroundWorkflowNodeStatusCanceled  = "canceled"
	// PlaygroundWorkflowNodeStatusSkipped marks a step the run never reached.
	PlaygroundWorkflowNodeStatusSkipped = "skipped"
)

const (
	// playgroundWorkflowRunMaxNodes bounds one stored run. A canvas may hold
	// fewer nodes than this; the cap only keeps one snapshot small enough to
	// list, replicate and cache-scan.
	playgroundWorkflowRunMaxNodes = 256
	// Per-field caps keep one node record bounded. The output cap matches the
	// bounded text the runner keeps on the step node.
	playgroundWorkflowNodeIDMaxBytes      = 128
	playgroundWorkflowModelMaxBytes       = 256
	playgroundWorkflowGroupMaxBytes       = 64
	playgroundWorkflowFingerprintMaxBytes = 128
	playgroundWorkflowOutputMaxBytes      = 64 << 10
	playgroundWorkflowErrorMaxBytes       = 2 << 10
	playgroundWorkflowTaskIDMaxBytes      = 128
	playgroundWorkflowArtifactKeyMaxBytes = 256
	playgroundWorkflowArtifactKeyMax      = 16
	playgroundWorkflowTokenMax            = int64(1) << 40
	playgroundWorkflowNodeDurationMaxMs   = int64(7 * 24 * 60 * 60 * 1000)
	// playgroundWorkflowTimestampMaxMs is the year 2100; a recorded node
	// timestamp outside [0, max] is a forged or corrupted payload.
	playgroundWorkflowTimestampMaxMs = int64(4102444800000)
	playgroundWorkflowListMaxCount   = 50
	// playgroundWorkflowCacheMaxFingerprints bounds one cache lookup request
	// and playgroundWorkflowCacheMaxEntries bounds the answer.
	playgroundWorkflowCacheMaxFingerprints = 128
	playgroundWorkflowCacheMaxEntries      = 256
	// playgroundWorkflowCacheScanRuns bounds how many of the newest finished
	// runs one cache lookup parses, so the lookup stays cheap on a long board
	// history while the newest entry of a fingerprint still wins.
	playgroundWorkflowCacheScanRuns = 32
)

var (
	ErrPlaygroundWorkflowRunNotFound     = errors.New("Workflow run not found.")
	ErrPlaygroundWorkflowRunConflict     = errors.New("The workflow run changed. Reload it and try again.")
	ErrPlaygroundWorkflowRunInvalid      = errors.New("Invalid workflow run.")
	ErrPlaygroundWorkflowRunLimit        = errors.New("Workflow run limit exceeded.")
	ErrPlaygroundWorkflowRunStorageLimit = errors.New("Workflow run storage limit exceeded.")
	ErrPlaygroundWorkflowRunUnavailable  = errors.New("Workflow runs are unavailable.")
)

// PlaygroundWorkflowRunNode is one step of a stored run. Fingerprint is the
// reuse key the node cache indexes; CacheHit marks a step that adopted an
// earlier output instead of calling the relay, so cached steps carry no tokens
// and no quota. Output carries the bounded text of a `model` step, and
// TaskId/ArtifactKeys reference the durable result of a `task` step. The bytes
// of a generated artifact stay behind the owner-scoped task artifact endpoint;
// a synchronous image preview is only counted, never stored.
type PlaygroundWorkflowRunNode struct {
	NodeID string `json:"node_id"`
	Kind   string `json:"kind"`
	Model  string `json:"model"`
	Group  string `json:"group"`
	// Status is the final step state; a run snapshot only stores settled
	// steps, so a pending step is reported as skipped instead.
	Status      string `json:"status"`
	Fingerprint string `json:"fingerprint"`
	CacheHit    bool   `json:"cache_hit"`
	Output      string `json:"output"`
	TaskID      string `json:"task_id"`
	// ArtifactKeys are the durable artifact keys the task exposed, so a later
	// run can rebuild the result nodes without re-reading the task row.
	ArtifactKeys     []string `json:"artifact_keys"`
	ResultCount      int      `json:"result_count"`
	PromptTokens     int      `json:"prompt_tokens"`
	CompletionTokens int      `json:"completion_tokens"`
	TotalTokens      int      `json:"total_tokens"`
	Quota            int      `json:"quota"`
	DurationMs       int64    `json:"duration_ms"`
	Error            string   `json:"error"`
	StartedAt        int64    `json:"started_at"`
	FinishedAt       int64    `json:"finished_at"`
}

// PlaygroundWorkflowRun is one stored execution of a canvas workflow.
type PlaygroundWorkflowRun struct {
	ID string `json:"id" gorm:"size:48;primaryKey"`
	// UserID scopes every read and write; a foreign run is reported as absent.
	UserID int `json:"user_id" gorm:"not null;index:idx_playground_workflow_run_owner,priority:1"`
	// CanvasID is the owned canvas project the run executes. Purging the
	// canvas removes its runs.
	CanvasID string `json:"canvas_id" gorm:"size:32;not null;index:idx_playground_workflow_run_owner,priority:2"`
	// SessionID optionally ties a run to a conversation (a canvas opened
	// against one). Purging the conversation removes the tied runs.
	SessionID string `json:"session_id" gorm:"size:32;index:idx_playground_workflow_run_session"`
	// WorkflowRevision is the canvas revision the run started from; it is
	// display metadata, because the fingerprint already folds in the workflow
	// structure version the browser computed.
	WorkflowRevision int64  `json:"workflow_revision" gorm:"not null;default:0"`
	Status           string `json:"status" gorm:"size:24;not null"`
	// Aggregates are derived from Nodes on every write, so list views never
	// parse the snapshot.
	NodeCount        int   `json:"node_count" gorm:"not null;default:0"`
	CacheHits        int   `json:"cache_hits" gorm:"not null;default:0"`
	TotalQuota       int   `json:"total_quota" gorm:"not null;default:0"`
	PromptTokens     int64 `json:"prompt_tokens" gorm:"not null;default:0"`
	CompletionTokens int64 `json:"completion_tokens" gorm:"not null;default:0"`
	TotalTokens      int64 `json:"total_tokens" gorm:"not null;default:0"`
	DurationMs       int64 `json:"duration_ms" gorm:"not null;default:0"`
	// EstimateQuota and BudgetCap are display records of the BL-03 price
	// estimate and the optional run budget the steps billed inside.
	EstimateQuota int `json:"estimate_quota" gorm:"not null;default:0"`
	BudgetCap     int `json:"budget_cap" gorm:"not null;default:0"`
	// Nodes is the bounded JSON snapshot of the node records.
	Nodes LongText `json:"-" gorm:"not null"`
	// ByteSize is the stored snapshot size counted against the account
	// budget. Revision is a compare-and-swap guard so a stale write cannot
	// overwrite a newer snapshot.
	ByteSize  int64 `json:"byte_size" gorm:"not null;default:0"`
	Revision  int64 `json:"revision" gorm:"not null;default:1"`
	CreatedAt int64 `json:"created_at" gorm:"not null"`
	UpdatedAt int64 `json:"updated_at" gorm:"not null;index:idx_playground_workflow_run_owner,priority:3"`
}

func (PlaygroundWorkflowRun) TableName() string {
	return "playground_workflow_runs"
}

// PlaygroundWorkflowRunCreate is the immutable input of one run. The client
// sends it once, before the first step; later updates only carry the snapshot.
type PlaygroundWorkflowRunCreate struct {
	CanvasID         string `json:"canvas_id"`
	SessionID        string `json:"session_id"`
	WorkflowRevision int64  `json:"workflow_revision"`
	EstimateQuota    int    `json:"estimate_quota"`
	BudgetCap        int    `json:"budget_cap"`
}

// PlaygroundWorkflowRunUpdate replaces the node snapshot and the run status
// under a revision compare-and-swap.
type PlaygroundWorkflowRunUpdate struct {
	Revision int64                       `json:"revision"`
	Status   string                      `json:"status"`
	Nodes    []PlaygroundWorkflowRunNode `json:"nodes"`
}

// PlaygroundWorkflowRunView is the wire shape of one run with its snapshot.
type PlaygroundWorkflowRunView struct {
	ID               string                      `json:"id"`
	CanvasID         string                      `json:"canvas_id"`
	SessionID        string                      `json:"session_id"`
	WorkflowRevision int64                       `json:"workflow_revision"`
	Status           string                      `json:"status"`
	NodeCount        int                         `json:"node_count"`
	CacheHits        int                         `json:"cache_hits"`
	TotalQuota       int                         `json:"total_quota"`
	PromptTokens     int64                       `json:"prompt_tokens"`
	CompletionTokens int64                       `json:"completion_tokens"`
	TotalTokens      int64                       `json:"total_tokens"`
	DurationMs       int64                       `json:"duration_ms"`
	EstimateQuota    int                         `json:"estimate_quota"`
	BudgetCap        int                         `json:"budget_cap"`
	Nodes            []PlaygroundWorkflowRunNode `json:"nodes"`
	ByteSize         int64                       `json:"byte_size"`
	Revision         int64                       `json:"revision"`
	CreatedAt        int64                       `json:"created_at"`
	UpdatedAt        int64                       `json:"updated_at"`
}

// PlaygroundWorkflowRunSummary is the bounded list projection of a run. It
// deliberately omits the node snapshot so listing history never parses every
// stored run.
type PlaygroundWorkflowRunSummary struct {
	ID               string `json:"id"`
	CanvasID         string `json:"canvas_id"`
	SessionID        string `json:"session_id"`
	WorkflowRevision int64  `json:"workflow_revision"`
	Status           string `json:"status"`
	NodeCount        int    `json:"node_count"`
	CacheHits        int    `json:"cache_hits"`
	TotalQuota       int    `json:"total_quota"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	TotalTokens      int64  `json:"total_tokens"`
	DurationMs       int64  `json:"duration_ms"`
	EstimateQuota    int    `json:"estimate_quota"`
	BudgetCap        int    `json:"budget_cap"`
	ByteSize         int64  `json:"byte_size"`
	Revision         int64  `json:"revision"`
	CreatedAt        int64  `json:"created_at"`
	UpdatedAt        int64  `json:"updated_at"`
}

// PlaygroundWorkflowCacheEntry is one reusable node output: the newest
// succeeded record of a fingerprint in an owned canvas. A cached `model` step
// reuses Output; a cached `task` step adopts TaskId and rebuilds its result
// nodes from ArtifactKeys (the runner re-reads the durable task row and falls
// back to a fresh submission when the artifacts expired).
type PlaygroundWorkflowCacheEntry struct {
	Fingerprint  string   `json:"fingerprint"`
	NodeID       string   `json:"node_id"`
	Kind         string   `json:"kind"`
	Model        string   `json:"model"`
	Output       string   `json:"output"`
	TaskID       string   `json:"task_id"`
	ArtifactKeys []string `json:"artifact_keys"`
	ResultCount  int      `json:"result_count"`
	Quota        int      `json:"quota"`
	RunID        string   `json:"run_id"`
	UpdatedAt    int64    `json:"updated_at"`
}

type playgroundWorkflowRunLimits struct {
	nodes     int
	runBytes  int64
	userCount int
	userBytes int64
}

// workflowRunLimits combines the product bounds with the account policy. The
// policy may shrink every limit, never raise it above the product ceiling.
func workflowRunLimits(policy playground_setting.PlaygroundQuotaPolicy) playgroundWorkflowRunLimits {
	limits := playgroundWorkflowRunLimits{
		nodes:     playgroundWorkflowRunMaxNodes,
		runBytes:  1 << 20,
		userCount: 100,
		userBytes: 64 << 20,
	}
	if policy.WorkflowRunNodeMaxCount > 0 {
		limits.nodes = min(policy.WorkflowRunNodeMaxCount, playgroundWorkflowRunMaxNodes)
	}
	limits.nodes = max(1, limits.nodes)
	if policy.WorkflowRunMaxBytes > 0 {
		limits.runBytes = policy.WorkflowRunMaxBytes
	}
	if policy.WorkflowRunUserMaxCount > 0 {
		limits.userCount = policy.WorkflowRunUserMaxCount
	}
	if policy.WorkflowRunUserMaxBytes > 0 {
		limits.userBytes = policy.WorkflowRunUserMaxBytes
	}
	return limits
}

func normalizeWorkflowRunCreate(input PlaygroundWorkflowRunCreate) (PlaygroundWorkflowRunCreate, error) {
	canvasID := strings.TrimSpace(input.CanvasID)
	if canvasID == "" || len(canvasID) > 32 {
		return input, ErrPlaygroundWorkflowRunInvalid
	}
	sessionID := strings.TrimSpace(input.SessionID)
	if len(sessionID) > 32 {
		return input, ErrPlaygroundWorkflowRunInvalid
	}
	if input.WorkflowRevision < 0 {
		return input, ErrPlaygroundWorkflowRunInvalid
	}
	if input.EstimateQuota < 0 || input.EstimateQuota > common.MaxQuota || input.BudgetCap < 0 || input.BudgetCap > common.MaxQuota {
		return input, ErrPlaygroundWorkflowRunInvalid
	}
	return PlaygroundWorkflowRunCreate{
		CanvasID:         canvasID,
		SessionID:        sessionID,
		WorkflowRevision: input.WorkflowRevision,
		EstimateQuota:    input.EstimateQuota,
		BudgetCap:        input.BudgetCap,
	}, nil
}

func normalizeWorkflowRunStatus(status string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case PlaygroundWorkflowRunStatusRunning:
		return PlaygroundWorkflowRunStatusRunning, true
	case PlaygroundWorkflowRunStatusCompleted:
		return PlaygroundWorkflowRunStatusCompleted, true
	case PlaygroundWorkflowRunStatusFailed:
		return PlaygroundWorkflowRunStatusFailed, true
	case PlaygroundWorkflowRunStatusCanceled:
		return PlaygroundWorkflowRunStatusCanceled, true
	default:
		return "", false
	}
}

func workflowNodeStatusValid(status string) bool {
	switch status {
	case PlaygroundWorkflowNodeStatusSucceeded,
		PlaygroundWorkflowNodeStatusFailed,
		PlaygroundWorkflowNodeStatusCanceled,
		PlaygroundWorkflowNodeStatusSkipped:
		return true
	default:
		return false
	}
}

// normalizeWorkflowNodes validates the reported snapshot and recomputes the
// run aggregates from it, so the stored totals can never disagree with the
// records they summarize.
func normalizeWorkflowNodes(nodes []PlaygroundWorkflowRunNode, maxNodes int) ([]PlaygroundWorkflowRunNode, error) {
	if len(nodes) > maxNodes {
		return nil, ErrPlaygroundWorkflowRunLimit
	}
	normalized := make([]PlaygroundWorkflowRunNode, 0, len(nodes))
	seen := make(map[string]struct{}, len(nodes))
	for index := range nodes {
		node := nodes[index]
		node.NodeID = strings.TrimSpace(node.NodeID)
		node.Kind = strings.TrimSpace(node.Kind)
		node.Model = strings.TrimSpace(node.Model)
		node.Group = strings.TrimSpace(node.Group)
		node.Status = strings.TrimSpace(node.Status)
		node.Fingerprint = strings.TrimSpace(node.Fingerprint)
		node.TaskID = strings.TrimSpace(node.TaskID)
		node.Error = strings.TrimSpace(node.Error)
		if node.NodeID == "" || len(node.NodeID) > playgroundWorkflowNodeIDMaxBytes {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if _, exists := seen[node.NodeID]; exists {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		seen[node.NodeID] = struct{}{}
		if node.Kind != "model" && node.Kind != "task" {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if !workflowNodeStatusValid(node.Status) {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if len(node.Model) > playgroundWorkflowModelMaxBytes || len(node.Group) > playgroundWorkflowGroupMaxBytes {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if len(node.Fingerprint) > playgroundWorkflowFingerprintMaxBytes {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if len(node.Output) > playgroundWorkflowOutputMaxBytes || len(node.Error) > playgroundWorkflowErrorMaxBytes {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if !utf8.ValidString(node.Output) || !utf8.ValidString(node.Error) {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if node.TaskID != "" && len(node.TaskID) > playgroundWorkflowTaskIDMaxBytes {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if len(node.ArtifactKeys) > playgroundWorkflowArtifactKeyMax {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		keys := make([]string, 0, len(node.ArtifactKeys))
		for _, raw := range node.ArtifactKeys {
			key := strings.TrimSpace(raw)
			if key == "" || len(key) > playgroundWorkflowArtifactKeyMaxBytes {
				return nil, ErrPlaygroundWorkflowRunInvalid
			}
			keys = append(keys, key)
		}
		node.ArtifactKeys = keys
		if node.ResultCount < 0 || node.ResultCount > playgroundWorkflowRunMaxNodes {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if node.PromptTokens < 0 || node.CompletionTokens < 0 || node.TotalTokens < 0 ||
			int64(node.PromptTokens) > playgroundWorkflowTokenMax ||
			int64(node.CompletionTokens) > playgroundWorkflowTokenMax ||
			int64(node.TotalTokens) > playgroundWorkflowTokenMax {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if node.Quota < 0 || node.Quota > common.MaxQuota {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if node.DurationMs < 0 || node.DurationMs > playgroundWorkflowNodeDurationMaxMs {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if node.StartedAt < 0 || node.StartedAt > playgroundWorkflowTimestampMaxMs ||
			node.FinishedAt < 0 || node.FinishedAt > playgroundWorkflowTimestampMaxMs {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if node.StartedAt > 0 && node.FinishedAt > 0 && node.FinishedAt < node.StartedAt {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		normalized = append(normalized, node)
	}
	return normalized, nil
}

// workflowRunAggregates derives the list-view totals from the snapshot.
type workflowRunAggregates struct {
	nodeCount        int
	cacheHits        int
	totalQuota       int
	promptTokens     int64
	completionTokens int64
	totalTokens      int64
	startedAt        int64
	finishedAt       int64
}

func workflowRunAggregate(nodes []PlaygroundWorkflowRunNode) workflowRunAggregates {
	var aggregates workflowRunAggregates
	aggregates.nodeCount = len(nodes)
	for index := range nodes {
		node := &nodes[index]
		if node.CacheHit {
			aggregates.cacheHits++
		}
		aggregates.totalQuota += node.Quota
		aggregates.promptTokens += int64(node.PromptTokens)
		aggregates.completionTokens += int64(node.CompletionTokens)
		aggregates.totalTokens += int64(node.TotalTokens)
		if node.StartedAt > 0 && (aggregates.startedAt == 0 || node.StartedAt < aggregates.startedAt) {
			aggregates.startedAt = node.StartedAt
		}
		if node.FinishedAt > aggregates.finishedAt {
			aggregates.finishedAt = node.FinishedAt
		}
	}
	return aggregates
}

// workflowRunDurationMs is the wall time the stored records span; zero when
// the run holds no timed record.
func workflowRunDurationMs(aggregates workflowRunAggregates) int64 {
	if aggregates.startedAt <= 0 || aggregates.finishedAt <= aggregates.startedAt {
		return 0
	}
	duration := aggregates.finishedAt - aggregates.startedAt
	if duration > playgroundWorkflowNodeDurationMaxMs {
		return playgroundWorkflowNodeDurationMaxMs
	}
	return duration
}

// playgroundWorkflowCanvasOwned reports whether the account owns an active
// canvas project. A missing or foreign canvas is reported as absent so the
// error never distinguishes another account's project from an unknown id.
func playgroundWorkflowCanvasOwned(tx *gorm.DB, userID int, canvasID string) (bool, error) {
	if userID <= 0 || canvasID == "" {
		return false, nil
	}
	var project PlaygroundCanvasProject
	err := tx.Select("id").Where("id = ? AND user_id = ? AND deleted_at = 0", canvasID, userID).First(&project).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// playgroundWorkflowSessionOwned reports whether the account owns an active
// conversation; an empty session id is accepted because the link is optional.
func playgroundWorkflowSessionOwned(tx *gorm.DB, userID int, sessionID string) (bool, error) {
	if sessionID == "" {
		return true, nil
	}
	var session PlaygroundSession
	err := tx.Select("id").Where("id = ? AND user_id = ? AND deleted_at = 0", sessionID, userID).First(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// CreatePlaygroundWorkflowRun stores the immutable input of one run. Capacity
// is checked against the locked account counter row, so concurrent creates
// cannot overrun the count or byte budget, and the canvas/session links are
// resolved under the owner's scope before any row is written.
func CreatePlaygroundWorkflowRun(userID int, input PlaygroundWorkflowRunCreate) (*PlaygroundWorkflowRunView, error) {
	if userID <= 0 {
		return nil, ErrPlaygroundWorkflowRunInvalid
	}
	normalized, err := normalizeWorkflowRunCreate(input)
	if err != nil {
		return nil, err
	}
	var view *PlaygroundWorkflowRunView
	err = DB.Transaction(func(tx *gorm.DB) error {
		owned, err := playgroundWorkflowCanvasOwned(tx, userID, normalized.CanvasID)
		if err != nil {
			return err
		}
		if !owned {
			return ErrPlaygroundWorkflowRunNotFound
		}
		sessionOwned, err := playgroundWorkflowSessionOwned(tx, userID, normalized.SessionID)
		if err != nil {
			return err
		}
		if !sessionOwned {
			return ErrPlaygroundWorkflowRunNotFound
		}
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		limits := workflowRunLimits(policy)
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if usage.WorkflowRunCount >= int64(limits.userCount) {
			return ErrPlaygroundWorkflowRunLimit
		}
		key, err := common.GenerateRandomCharsKey(24)
		if err != nil {
			return err
		}
		nodesJSON, err := common.Marshal([]PlaygroundWorkflowRunNode{})
		if err != nil {
			return err
		}
		byteSize := int64(len(nodesJSON))
		if usage.WorkflowRunBytes+byteSize > limits.userBytes {
			return ErrPlaygroundWorkflowRunStorageLimit
		}
		now := common.GetTimestamp()
		run := PlaygroundWorkflowRun{
			ID:               "pgwr_" + key,
			UserID:           userID,
			CanvasID:         normalized.CanvasID,
			SessionID:        normalized.SessionID,
			WorkflowRevision: normalized.WorkflowRevision,
			Status:           PlaygroundWorkflowRunStatusRunning,
			EstimateQuota:    normalized.EstimateQuota,
			BudgetCap:        normalized.BudgetCap,
			Nodes:            LongText(nodesJSON),
			ByteSize:         byteSize,
			Revision:         1,
			CreatedAt:        now,
			UpdatedAt:        now,
		}
		if err := tx.Create(&run).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{WorkflowRunCount: 1, WorkflowRunBytes: byteSize})
		if err := savePlaygroundUserUsage(tx, usage); err != nil {
			return err
		}
		view = &PlaygroundWorkflowRunView{
			ID:               run.ID,
			CanvasID:         run.CanvasID,
			SessionID:        run.SessionID,
			WorkflowRevision: run.WorkflowRevision,
			Status:           run.Status,
			EstimateQuota:    run.EstimateQuota,
			BudgetCap:        run.BudgetCap,
			Nodes:            []PlaygroundWorkflowRunNode{},
			ByteSize:         byteSize,
			Revision:         run.Revision,
			CreatedAt:        now,
			UpdatedAt:        now,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if view == nil {
		return nil, ErrPlaygroundWorkflowRunUnavailable
	}
	return view, nil
}

// GetPlaygroundWorkflowRun reads one owner-scoped run and decodes its snapshot.
func GetPlaygroundWorkflowRun(userID int, id string) (*PlaygroundWorkflowRunView, error) {
	if userID <= 0 || strings.TrimSpace(id) == "" {
		return nil, ErrPlaygroundWorkflowRunNotFound
	}
	var run PlaygroundWorkflowRun
	err := DB.Where("id = ? AND user_id = ?", id, userID).First(&run).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundWorkflowRunNotFound
	}
	if err != nil {
		return nil, err
	}
	return workflowRunViewFromRow(&run, nil)
}

// ListPlaygroundWorkflowRuns returns the newest owner-scoped run summaries,
// optionally restricted to one canvas.
func ListPlaygroundWorkflowRuns(userID int, canvasID string) ([]PlaygroundWorkflowRunSummary, error) {
	if userID <= 0 {
		return []PlaygroundWorkflowRunSummary{}, nil
	}
	query := DB.Model(&PlaygroundWorkflowRun{}).Where("user_id = ?", userID)
	if trimmed := strings.TrimSpace(canvasID); trimmed != "" {
		query = query.Where("canvas_id = ?", trimmed)
	}
	rows := make([]PlaygroundWorkflowRun, 0, playgroundWorkflowListMaxCount)
	err := query.
		Select("id", "canvas_id", "session_id", "workflow_revision", "status", "node_count", "cache_hits", "total_quota", "prompt_tokens", "completion_tokens", "total_tokens", "duration_ms", "estimate_quota", "budget_cap", "byte_size", "revision", "created_at", "updated_at").
		Order("updated_at DESC, id DESC").
		Limit(playgroundWorkflowListMaxCount).
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	items := make([]PlaygroundWorkflowRunSummary, 0, len(rows))
	for index := range rows {
		row := &rows[index]
		items = append(items, PlaygroundWorkflowRunSummary{
			ID:               row.ID,
			CanvasID:         row.CanvasID,
			SessionID:        row.SessionID,
			WorkflowRevision: row.WorkflowRevision,
			Status:           row.Status,
			NodeCount:        row.NodeCount,
			CacheHits:        row.CacheHits,
			TotalQuota:       row.TotalQuota,
			PromptTokens:     row.PromptTokens,
			CompletionTokens: row.CompletionTokens,
			TotalTokens:      row.TotalTokens,
			DurationMs:       row.DurationMs,
			EstimateQuota:    row.EstimateQuota,
			BudgetCap:        row.BudgetCap,
			ByteSize:         row.ByteSize,
			Revision:         row.Revision,
			CreatedAt:        row.CreatedAt,
			UpdatedAt:        row.UpdatedAt,
		})
	}
	return items, nil
}

// UpdatePlaygroundWorkflowRun replaces the snapshot of one run under a
// revision compare-and-swap. The stored byte delta is mirrored into the account
// counters in the same transaction, and a rejected write leaves both the run
// and the counters untouched.
func UpdatePlaygroundWorkflowRun(userID int, id string, input PlaygroundWorkflowRunUpdate) (*PlaygroundWorkflowRunView, error) {
	if userID <= 0 || strings.TrimSpace(id) == "" {
		return nil, ErrPlaygroundWorkflowRunNotFound
	}
	status, ok := normalizeWorkflowRunStatus(input.Status)
	if !ok {
		return nil, ErrPlaygroundWorkflowRunInvalid
	}
	var view *PlaygroundWorkflowRunView
	err := DB.Transaction(func(tx *gorm.DB) error {
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		limits := workflowRunLimits(policy)
		nodes, err := normalizeWorkflowNodes(input.Nodes, limits.nodes)
		if err != nil {
			return err
		}
		nodesJSON, err := common.Marshal(nodes)
		if err != nil {
			return err
		}
		byteSize := int64(len(nodesJSON))
		if byteSize > limits.runBytes {
			return ErrPlaygroundWorkflowRunStorageLimit
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		var run PlaygroundWorkflowRun
		err = lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&run).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundWorkflowRunNotFound
		}
		if err != nil {
			return err
		}
		if input.Revision != run.Revision {
			return ErrPlaygroundWorkflowRunConflict
		}
		delta := byteSize - run.ByteSize
		if delta > 0 && usage.WorkflowRunBytes+delta > limits.userBytes {
			return ErrPlaygroundWorkflowRunStorageLimit
		}
		aggregates := workflowRunAggregate(nodes)
		durationMs := workflowRunDurationMs(aggregates)
		now := common.GetTimestamp()
		updated := tx.Model(&PlaygroundWorkflowRun{}).
			Where("id = ? AND user_id = ? AND revision = ?", id, userID, run.Revision).
			Updates(map[string]any{
				"status":            status,
				"nodes":             string(nodesJSON),
				"node_count":        aggregates.nodeCount,
				"cache_hits":        aggregates.cacheHits,
				"total_quota":       aggregates.totalQuota,
				"prompt_tokens":     aggregates.promptTokens,
				"completion_tokens": aggregates.completionTokens,
				"total_tokens":      aggregates.totalTokens,
				"duration_ms":       durationMs,
				"byte_size":         byteSize,
				"revision":          run.Revision + 1,
				"updated_at":        now,
			})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return ErrPlaygroundWorkflowRunConflict
		}
		usage.apply(playgroundUserUsageDelta{WorkflowRunBytes: delta})
		if err := savePlaygroundUserUsage(tx, usage); err != nil {
			return err
		}
		run.Status = status
		run.Nodes = LongText(nodesJSON)
		run.NodeCount = aggregates.nodeCount
		run.CacheHits = aggregates.cacheHits
		run.TotalQuota = aggregates.totalQuota
		run.PromptTokens = aggregates.promptTokens
		run.CompletionTokens = aggregates.completionTokens
		run.TotalTokens = aggregates.totalTokens
		run.DurationMs = durationMs
		run.ByteSize = byteSize
		run.Revision++
		run.UpdatedAt = now
		view, err = workflowRunViewFromRow(&run, nodes)
		return err
	})
	if err != nil {
		return nil, err
	}
	if view == nil {
		return nil, ErrPlaygroundWorkflowRunUnavailable
	}
	return view, nil
}

// DeletePlaygroundWorkflowRun removes one owner-scoped run and releases its
// counters in the same transaction.
func DeletePlaygroundWorkflowRun(userID int, id string) error {
	if userID <= 0 || strings.TrimSpace(id) == "" {
		return ErrPlaygroundWorkflowRunNotFound
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		var run PlaygroundWorkflowRun
		err = lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&run).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundWorkflowRunNotFound
		}
		if err != nil {
			return err
		}
		result := tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundWorkflowRun{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrPlaygroundWorkflowRunNotFound
		}
		usage.apply(playgroundUserUsageDelta{WorkflowRunCount: -1, WorkflowRunBytes: -run.ByteSize})
		return savePlaygroundUserUsage(tx, usage)
	})
}

// LookupPlaygroundWorkflowNodeCache resolves reusable node outputs for one
// owned canvas. It scans the newest finished runs and returns, for every
// requested fingerprint, the record of the newest run that succeeded it, so a
// step whose inputs did not change can adopt its output without a relay call.
func LookupPlaygroundWorkflowNodeCache(userID int, canvasID string, fingerprints []string) ([]PlaygroundWorkflowCacheEntry, error) {
	if userID <= 0 {
		return nil, ErrPlaygroundWorkflowRunInvalid
	}
	canvasID = strings.TrimSpace(canvasID)
	if canvasID == "" || len(canvasID) > 32 {
		return nil, ErrPlaygroundWorkflowRunInvalid
	}
	if len(fingerprints) == 0 || len(fingerprints) > playgroundWorkflowCacheMaxFingerprints {
		return nil, ErrPlaygroundWorkflowRunInvalid
	}
	requested := make(map[string]struct{}, len(fingerprints))
	order := make([]string, 0, len(fingerprints))
	for _, raw := range fingerprints {
		fingerprint := strings.TrimSpace(raw)
		if fingerprint == "" || len(fingerprint) > playgroundWorkflowFingerprintMaxBytes {
			return nil, ErrPlaygroundWorkflowRunInvalid
		}
		if _, exists := requested[fingerprint]; exists {
			continue
		}
		requested[fingerprint] = struct{}{}
		order = append(order, fingerprint)
	}
	// The lookup is a pure read: it resolves the newest finished runs of the
	// owned canvas and keeps the newest succeeded record per fingerprint, so
	// the browser adopts the same output a "restore this run" action would.
	var runs []PlaygroundWorkflowRun
	if err := DB.Transaction(func(tx *gorm.DB) error {
		owned, err := playgroundWorkflowCanvasOwned(tx, userID, canvasID)
		if err != nil {
			return err
		}
		if !owned {
			return ErrPlaygroundWorkflowRunNotFound
		}
		rows := make([]PlaygroundWorkflowRun, 0, playgroundWorkflowCacheScanRuns)
		if err := tx.Select("id", "nodes", "updated_at").
			Where("user_id = ? AND canvas_id = ? AND status IN ?", userID, canvasID, []string{
				PlaygroundWorkflowRunStatusCompleted,
				PlaygroundWorkflowRunStatusFailed,
				PlaygroundWorkflowRunStatusCanceled,
			}).
			Order("updated_at DESC, id DESC").
			Limit(playgroundWorkflowCacheScanRuns).
			Find(&rows).Error; err != nil {
			return err
		}
		runs = rows
		return nil
	}); err != nil {
		return nil, err
	}
	entries := make([]PlaygroundWorkflowCacheEntry, 0, len(order))
	found := make(map[string]struct{}, len(order))
	for index := range runs {
		run := &runs[index]
		nodes := make([]PlaygroundWorkflowRunNode, 0)
		if err := common.UnmarshalJsonStr(string(run.Nodes), &nodes); err != nil {
			// A run whose snapshot cannot be decoded is skipped instead of
			// failing the whole lookup: the cache is best-effort by design.
			continue
		}
		for nodeIndex := range nodes {
			node := &nodes[nodeIndex]
			if node.Status != PlaygroundWorkflowNodeStatusSucceeded || node.Fingerprint == "" {
				continue
			}
			if _, wanted := requested[node.Fingerprint]; !wanted {
				continue
			}
			if _, exists := found[node.Fingerprint]; exists {
				continue
			}
			found[node.Fingerprint] = struct{}{}
			entries = append(entries, PlaygroundWorkflowCacheEntry{
				Fingerprint:  node.Fingerprint,
				NodeID:       node.NodeID,
				Kind:         node.Kind,
				Model:        node.Model,
				Output:       node.Output,
				TaskID:       node.TaskID,
				ArtifactKeys: node.ArtifactKeys,
				ResultCount:  node.ResultCount,
				Quota:        node.Quota,
				RunID:        run.ID,
				UpdatedAt:    run.UpdatedAt,
			})
			if len(entries) >= playgroundWorkflowCacheMaxEntries || len(found) == len(order) {
				return entries, nil
			}
		}
	}
	return entries, nil
}

// workflowRunViewFromRow decodes one stored run into its wire shape. The
// caller may pass an already-decoded snapshot to skip the JSON decode.
func workflowRunViewFromRow(run *PlaygroundWorkflowRun, nodes []PlaygroundWorkflowRunNode) (*PlaygroundWorkflowRunView, error) {
	if nodes == nil {
		nodes = make([]PlaygroundWorkflowRunNode, 0)
		if err := common.UnmarshalJsonStr(string(run.Nodes), &nodes); err != nil {
			return nil, err
		}
	}
	return &PlaygroundWorkflowRunView{
		ID:               run.ID,
		CanvasID:         run.CanvasID,
		SessionID:        run.SessionID,
		WorkflowRevision: run.WorkflowRevision,
		Status:           run.Status,
		NodeCount:        run.NodeCount,
		CacheHits:        run.CacheHits,
		TotalQuota:       run.TotalQuota,
		PromptTokens:     run.PromptTokens,
		CompletionTokens: run.CompletionTokens,
		TotalTokens:      run.TotalTokens,
		DurationMs:       run.DurationMs,
		EstimateQuota:    run.EstimateQuota,
		BudgetCap:        run.BudgetCap,
		Nodes:            nodes,
		ByteSize:         run.ByteSize,
		Revision:         run.Revision,
		CreatedAt:        run.CreatedAt,
		UpdatedAt:        run.UpdatedAt,
	}, nil
}
