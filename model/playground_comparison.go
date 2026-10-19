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
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"gorm.io/gorm"
)

const (
	// PlaygroundComparisonRunStatusRunning marks a matrix whose cells are
	// still being sent. The browser owns execution; the server records the
	// state it is told and never starts a relay request itself.
	PlaygroundComparisonRunStatusRunning = "running"
	// PlaygroundComparisonRunStatusCompleted means every cell reached a final
	// state, including per-cell failures.
	PlaygroundComparisonRunStatusCompleted = "completed"
	// PlaygroundComparisonRunStatusFailed means the orchestration stopped
	// before every cell could run, for example after the run budget cap.
	PlaygroundComparisonRunStatusFailed = "failed"
	// PlaygroundComparisonRunStatusCanceled means the user stopped the run.
	PlaygroundComparisonRunStatusCanceled = "canceled"

	PlaygroundComparisonCellPending   = "pending"
	PlaygroundComparisonCellRunning   = "running"
	PlaygroundComparisonCellSucceeded = "succeeded"
	PlaygroundComparisonCellFailed    = "failed"
	PlaygroundComparisonCellCanceled  = "canceled"

	PlaygroundComparisonStrategySerial     = "serial"
	PlaygroundComparisonStrategyConcurrent = "concurrent"
)

const (
	// playgroundComparisonMaxModels and playgroundComparisonMaxPrompts are the
	// product bounds the quota policy may tighten but never exceed. The two
	// bounds also keep one estimate within BL-03's 64-step request ceiling
	// (6 models x 10 prompts = 60 cells).
	playgroundComparisonMaxModels  = 6
	playgroundComparisonMaxPrompts = 10
	// Per-field caps keep one stored matrix small enough to list and export.
	// The account and per-run byte budgets in the quota policy bound the total.
	playgroundComparisonModelMaxBytes   = 256
	playgroundComparisonTitleMaxRunes   = 200
	playgroundComparisonGroupMaxBytes   = 64
	playgroundComparisonCellOutputBytes = 16 << 10
	playgroundComparisonCellErrorBytes  = 2 << 10
	playgroundComparisonErrorCodeBytes  = 64
	playgroundComparisonRequestIdBytes  = 64
	playgroundComparisonTokenMax        = int64(1) << 40
	playgroundComparisonLatencyMaxMs    = int64(24 * 60 * 60 * 1000)
	playgroundComparisonListMaxCount    = 50
)

var (
	ErrPlaygroundComparisonNotFound     = errors.New("Comparison run not found.")
	ErrPlaygroundComparisonConflict     = errors.New("The comparison run changed. Reload it and try again.")
	ErrPlaygroundComparisonInvalid      = errors.New("Invalid comparison run.")
	ErrPlaygroundComparisonLimit        = errors.New("Comparison run limit exceeded.")
	ErrPlaygroundComparisonStorageLimit = errors.New("Comparison run storage limit exceeded.")
	ErrPlaygroundComparisonUnavailable  = errors.New("Comparison runs are unavailable.")
)

// PlaygroundComparisonCell is one model x prompt result of a comparison run.
// Output is a bounded summary: the table and every export need the visible
// answer, not an unbounded generation transcript.
type PlaygroundComparisonCell struct {
	PromptIndex      int    `json:"prompt_index"`
	ModelIndex       int    `json:"model_index"`
	Status           string `json:"status"`
	Output           string `json:"output"`
	Error            string `json:"error"`
	ErrorCode        string `json:"error_code"`
	RequestId        string `json:"request_id"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	TotalTokens      int    `json:"total_tokens"`
	LatencyMs        int64  `json:"latency_ms"`
}

// PlaygroundComparisonRun is one persisted model-selection matrix. It stores
// the inputs and the bounded result snapshot so a run survives reloads; every
// cell is an ordinary /pg relay request with its own pre-charge, settlement,
// group and rate limit. The table never charges quota itself.
type PlaygroundComparisonRun struct {
	ID          string   `json:"id" gorm:"size:48;primaryKey"`
	UserID      int      `json:"user_id" gorm:"not null;index:idx_playground_comparison_owner,priority:1"`
	Title       string   `json:"title" gorm:"size:200;not null"`
	Group       string   `json:"group" gorm:"size:64;not null"`
	Models      LongText `json:"-" gorm:"not null"`
	Prompts     LongText `json:"-" gorm:"not null"`
	Results     LongText `json:"-" gorm:"not null"`
	Status      string   `json:"status" gorm:"size:24;not null"`
	Strategy    string   `json:"strategy" gorm:"size:16;not null"`
	Concurrency int      `json:"concurrency" gorm:"not null"`
	// EstimateQuota is the server-priced pre-run estimate and BudgetCap is the
	// optional BL-03 run cap the cells billed inside. Both are display records;
	// the wallet holds enforce the cap when the requests actually run.
	EstimateQuota int `json:"estimate_quota" gorm:"not null;default:0"`
	BudgetCap     int `json:"budget_cap" gorm:"not null;default:0"`
	// BaselineModel marks the optional reference column of the matrix.
	BaselineModel string `json:"baseline_model" gorm:"size:256;not null;default:''"`
	ModelCount    int    `json:"model_count" gorm:"not null;default:0"`
	PromptCount   int    `json:"prompt_count" gorm:"not null;default:0"`
	// ByteSize is the stored JSON payload size counted against the account
	// budget. Revision is a compare-and-swap guard so two tabs cannot silently
	// overwrite each other's results.
	ByteSize  int64 `json:"byte_size" gorm:"not null;default:0"`
	Revision  int64 `json:"revision" gorm:"not null;default:1"`
	CreatedAt int64 `json:"created_at" gorm:"not null;index:idx_playground_comparison_owner,priority:2"`
	UpdatedAt int64 `json:"updated_at" gorm:"not null"`
}

func (PlaygroundComparisonRun) TableName() string {
	return "playground_comparison_runs"
}

// PlaygroundComparisonRunCreate is the immutable input of one matrix. The
// client sends it once, before the first cell; later updates only carry the
// result snapshot, its status and the optional baseline.
type PlaygroundComparisonRunCreate struct {
	Title         string   `json:"title"`
	Group         string   `json:"group"`
	Models        []string `json:"models"`
	Prompts       []string `json:"prompts"`
	Strategy      string   `json:"strategy"`
	Concurrency   int      `json:"concurrency"`
	EstimateQuota int      `json:"estimate_quota"`
	BudgetCap     int      `json:"budget_cap"`
}

// PlaygroundComparisonRunUpdate replaces the mutable part of a run: the cell
// snapshot, the run status and the optional baseline model. Revision is the
// revision the client read; a mismatch is returned as a conflict.
type PlaygroundComparisonRunUpdate struct {
	Revision      int64                      `json:"revision"`
	Status        string                     `json:"status"`
	Results       []PlaygroundComparisonCell `json:"results"`
	BaselineModel string                     `json:"baseline_model"`
}

// PlaygroundComparisonRunView is the wire shape of one run. The stored columns
// carry JSON text; the view exposes decoded arrays and the matrix.
type PlaygroundComparisonRunView struct {
	ID            string                     `json:"id"`
	Title         string                     `json:"title"`
	Group         string                     `json:"group"`
	Models        []string                   `json:"models"`
	Prompts       []string                   `json:"prompts"`
	Results       []PlaygroundComparisonCell `json:"results"`
	Status        string                     `json:"status"`
	Strategy      string                     `json:"strategy"`
	Concurrency   int                        `json:"concurrency"`
	EstimateQuota int                        `json:"estimate_quota"`
	BudgetCap     int                        `json:"budget_cap"`
	BaselineModel string                     `json:"baseline_model"`
	ModelCount    int                        `json:"model_count"`
	PromptCount   int                        `json:"prompt_count"`
	ByteSize      int64                      `json:"byte_size"`
	Revision      int64                      `json:"revision"`
	CreatedAt     int64                      `json:"created_at"`
	UpdatedAt     int64                      `json:"updated_at"`
}

// PlaygroundComparisonRunSummary is the bounded list projection of a run. It
// deliberately omits the models, prompts and results so listing history never
// transfers every stored matrix.
type PlaygroundComparisonRunSummary struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Group         string `json:"group"`
	Status        string `json:"status"`
	Strategy      string `json:"strategy"`
	Concurrency   int    `json:"concurrency"`
	EstimateQuota int    `json:"estimate_quota"`
	BudgetCap     int    `json:"budget_cap"`
	BaselineModel string `json:"baseline_model"`
	ModelCount    int    `json:"model_count"`
	PromptCount   int    `json:"prompt_count"`
	ByteSize      int64  `json:"byte_size"`
	Revision      int64  `json:"revision"`
	CreatedAt     int64  `json:"created_at"`
	UpdatedAt     int64  `json:"updated_at"`
}

// CreatePlaygroundComparisonRun validates and stores one run, initializing a
// pending cell for every model x prompt pair. The account counter row is locked
// before the capacity checks, so concurrent creates cannot overrun the count or
// byte budget.
func CreatePlaygroundComparisonRun(userID int, input PlaygroundComparisonRunCreate) (*PlaygroundComparisonRunView, error) {
	if userID <= 0 {
		return nil, ErrPlaygroundComparisonInvalid
	}
	normalized, err := normalizeComparisonRunCreate(input)
	if err != nil {
		return nil, err
	}
	var view *PlaygroundComparisonRunView
	err = DB.Transaction(func(tx *gorm.DB) error {
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		limits := comparisonRunLimits(policy)
		if len(normalized.Models) > limits.maxModels || len(normalized.Prompts) > limits.maxPrompts {
			return ErrPlaygroundComparisonLimit
		}
		if normalized.Strategy == PlaygroundComparisonStrategyConcurrent {
			normalized.Concurrency = min(normalized.Concurrency, limits.maxConcurrency)
		}
		for _, prompt := range normalized.Prompts {
			if int64(len(prompt)) > limits.promptBytes {
				return ErrPlaygroundComparisonInvalid
			}
		}
		modelsJSON, err := common.Marshal(normalized.Models)
		if err != nil {
			return err
		}
		promptsJSON, err := common.Marshal(normalized.Prompts)
		if err != nil {
			return err
		}
		results := make([]PlaygroundComparisonCell, 0, len(normalized.Models)*len(normalized.Prompts))
		for promptIndex := range normalized.Prompts {
			for modelIndex := range normalized.Models {
				results = append(results, PlaygroundComparisonCell{
					PromptIndex: promptIndex,
					ModelIndex:  modelIndex,
					Status:      PlaygroundComparisonCellPending,
				})
			}
		}
		resultsJSON, err := common.Marshal(results)
		if err != nil {
			return err
		}
		byteSize := comparisonRunByteSize(normalized.Title, normalized.Group, modelsJSON, promptsJSON, resultsJSON)
		if byteSize > limits.runBytes {
			return ErrPlaygroundComparisonStorageLimit
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		if usage.ComparisonRunCount >= int64(limits.userCount) {
			return ErrPlaygroundComparisonLimit
		}
		if usage.ComparisonRunBytes+byteSize > limits.userBytes {
			return ErrPlaygroundComparisonStorageLimit
		}
		key, err := common.GenerateRandomCharsKey(24)
		if err != nil {
			return err
		}
		now := common.GetTimestamp()
		run := PlaygroundComparisonRun{
			ID:            "pgc_" + key,
			UserID:        userID,
			Title:         normalized.Title,
			Group:         normalized.Group,
			Models:        LongText(modelsJSON),
			Prompts:       LongText(promptsJSON),
			Results:       LongText(resultsJSON),
			Status:        PlaygroundComparisonRunStatusRunning,
			Strategy:      normalized.Strategy,
			Concurrency:   normalized.Concurrency,
			EstimateQuota: normalized.EstimateQuota,
			BudgetCap:     normalized.BudgetCap,
			ModelCount:    len(normalized.Models),
			PromptCount:   len(normalized.Prompts),
			ByteSize:      byteSize,
			Revision:      1,
			CreatedAt:     now,
			UpdatedAt:     now,
		}
		if err := tx.Create(&run).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{ComparisonRunCount: 1, ComparisonRunBytes: byteSize})
		if err := savePlaygroundUserUsage(tx, usage); err != nil {
			return err
		}
		view = comparisonRunViewFromRow(&run, normalized.Models, normalized.Prompts, results)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if view == nil {
		return nil, ErrPlaygroundComparisonUnavailable
	}
	return view, nil
}

// GetPlaygroundComparisonRun reads one owner-scoped run and decodes its matrix.
func GetPlaygroundComparisonRun(userID int, id string) (*PlaygroundComparisonRunView, error) {
	if userID <= 0 || strings.TrimSpace(id) == "" {
		return nil, ErrPlaygroundComparisonNotFound
	}
	var run PlaygroundComparisonRun
	err := DB.Where("id = ? AND user_id = ?", id, userID).First(&run).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundComparisonNotFound
	}
	if err != nil {
		return nil, err
	}
	view := comparisonRunViewFromRow(&run, nil, nil, nil)
	if view == nil {
		return nil, ErrPlaygroundComparisonUnavailable
	}
	return view, nil
}

// ListPlaygroundComparisonRuns returns the newest owner-scoped run summaries.
func ListPlaygroundComparisonRuns(userID int) ([]PlaygroundComparisonRunSummary, error) {
	rows := make([]PlaygroundComparisonRun, 0, playgroundComparisonListMaxCount)
	if userID <= 0 {
		return []PlaygroundComparisonRunSummary{}, nil
	}
	err := DB.Select("id", "user_id", "title", "group", "status", "strategy", "concurrency", "estimate_quota", "budget_cap", "baseline_model", "model_count", "prompt_count", "byte_size", "revision", "created_at", "updated_at").
		Where("user_id = ?", userID).
		Order("updated_at DESC, id DESC").
		Limit(playgroundComparisonListMaxCount).
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	items := make([]PlaygroundComparisonRunSummary, 0, len(rows))
	for _, row := range rows {
		items = append(items, PlaygroundComparisonRunSummary{
			ID:            row.ID,
			Title:         row.Title,
			Group:         row.Group,
			Status:        row.Status,
			Strategy:      row.Strategy,
			Concurrency:   row.Concurrency,
			EstimateQuota: row.EstimateQuota,
			BudgetCap:     row.BudgetCap,
			BaselineModel: row.BaselineModel,
			ModelCount:    row.ModelCount,
			PromptCount:   row.PromptCount,
			ByteSize:      row.ByteSize,
			Revision:      row.Revision,
			CreatedAt:     row.CreatedAt,
			UpdatedAt:     row.UpdatedAt,
		})
	}
	return items, nil
}

// UpdatePlaygroundComparisonRun replaces the mutable snapshot of one run under
// a revision compare-and-swap. The stored byte delta is mirrored into the
// account counters in the same transaction, and a rejected write leaves both
// the run and the counters untouched.
func UpdatePlaygroundComparisonRun(userID int, id string, input PlaygroundComparisonRunUpdate) (*PlaygroundComparisonRunView, error) {
	if userID <= 0 || strings.TrimSpace(id) == "" {
		return nil, ErrPlaygroundComparisonNotFound
	}
	status, ok := normalizeComparisonRunStatus(input.Status)
	if !ok {
		return nil, ErrPlaygroundComparisonInvalid
	}
	baseline := strings.TrimSpace(input.BaselineModel)
	var view *PlaygroundComparisonRunView
	err := DB.Transaction(func(tx *gorm.DB) error {
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		limits := comparisonRunLimits(policy)
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		var run PlaygroundComparisonRun
		err = lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&run).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundComparisonNotFound
		}
		if err != nil {
			return err
		}
		if input.Revision != run.Revision {
			return ErrPlaygroundComparisonConflict
		}
		var models []string
		if err := common.UnmarshalJsonStr(string(run.Models), &models); err != nil {
			return fmt.Errorf("decode comparison models: %w", err)
		}
		var prompts []string
		if err := common.UnmarshalJsonStr(string(run.Prompts), &prompts); err != nil {
			return fmt.Errorf("decode comparison prompts: %w", err)
		}
		if err := validateComparisonResults(input.Results, len(models), len(prompts)); err != nil {
			return err
		}
		if baseline != "" && !slices.Contains(models, baseline) {
			return ErrPlaygroundComparisonInvalid
		}
		resultsJSON, err := common.Marshal(input.Results)
		if err != nil {
			return err
		}
		byteSize := comparisonRunByteSize(run.Title, run.Group, []byte(run.Models), []byte(run.Prompts), resultsJSON)
		if byteSize > limits.runBytes {
			return ErrPlaygroundComparisonStorageLimit
		}
		delta := byteSize - run.ByteSize
		if delta > 0 && usage.ComparisonRunBytes+delta > limits.userBytes {
			return ErrPlaygroundComparisonStorageLimit
		}
		now := common.GetTimestamp()
		updated := tx.Model(&PlaygroundComparisonRun{}).
			Where("id = ? AND user_id = ? AND revision = ?", id, userID, run.Revision).
			Updates(map[string]any{
				"results":        string(resultsJSON),
				"status":         status,
				"baseline_model": baseline,
				"byte_size":      byteSize,
				"revision":       run.Revision + 1,
				"updated_at":     now,
			})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return ErrPlaygroundComparisonConflict
		}
		usage.apply(playgroundUserUsageDelta{ComparisonRunBytes: delta})
		if err := savePlaygroundUserUsage(tx, usage); err != nil {
			return err
		}
		run.Results = LongText(resultsJSON)
		run.Status = status
		run.BaselineModel = baseline
		run.ByteSize = byteSize
		run.Revision++
		run.UpdatedAt = now
		view = comparisonRunViewFromRow(&run, models, prompts, input.Results)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if view == nil {
		return nil, ErrPlaygroundComparisonUnavailable
	}
	return view, nil
}

// DeletePlaygroundComparisonRun removes one owner-scoped run and releases its
// counters in the same transaction. Deleting an absent or foreign run reports
// NotFound and does not change another account's counters.
func DeletePlaygroundComparisonRun(userID int, id string) error {
	if userID <= 0 || strings.TrimSpace(id) == "" {
		return ErrPlaygroundComparisonNotFound
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		var run PlaygroundComparisonRun
		err = lockForUpdate(tx).Where("id = ? AND user_id = ?", id, userID).First(&run).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlaygroundComparisonNotFound
		}
		if err != nil {
			return err
		}
		result := tx.Where("id = ? AND user_id = ?", id, userID).Delete(&PlaygroundComparisonRun{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrPlaygroundComparisonNotFound
		}
		usage.apply(playgroundUserUsageDelta{ComparisonRunCount: -1, ComparisonRunBytes: -run.ByteSize})
		return savePlaygroundUserUsage(tx, usage)
	})
}

type playgroundComparisonLimits struct {
	maxModels      int
	maxConcurrency int
	maxPrompts     int
	promptBytes    int64
	runBytes       int64
	userCount      int
	userBytes      int64
}

// comparisonRunLimits combines the product bounds with the account policy. The
// policy may shrink every limit and may relax a lower administrator default up
// to the product ceiling, never beyond it.
func comparisonRunLimits(policy playground_setting.PlaygroundQuotaPolicy) playgroundComparisonLimits {
	limits := playgroundComparisonLimits{
		maxModels:      playgroundComparisonMaxModels,
		maxConcurrency: 3,
		maxPrompts:     playgroundComparisonMaxPrompts,
		promptBytes:    16 << 10,
		runBytes:       1 << 20,
		userCount:      50,
		userBytes:      32 << 20,
	}
	if policy.ComparisonRunMaxModels > 0 {
		limits.maxModels = min(policy.ComparisonRunMaxModels, playgroundComparisonMaxModels)
	}
	limits.maxModels = max(2, limits.maxModels)
	if policy.ComparisonRunMaxConcurrency > 0 {
		limits.maxConcurrency = min(policy.ComparisonRunMaxConcurrency, playgroundComparisonMaxModels)
	}
	limits.maxConcurrency = max(1, limits.maxConcurrency)
	if policy.ComparisonRunPromptMaxCount > 0 {
		limits.maxPrompts = min(policy.ComparisonRunPromptMaxCount, playgroundComparisonMaxPrompts)
	}
	limits.maxPrompts = max(1, limits.maxPrompts)
	if policy.ComparisonRunPromptMaxBytes > 0 {
		limits.promptBytes = policy.ComparisonRunPromptMaxBytes
	}
	if policy.ComparisonRunMaxBytes > 0 {
		limits.runBytes = policy.ComparisonRunMaxBytes
	}
	if policy.ComparisonRunUserMaxCount > 0 {
		limits.userCount = policy.ComparisonRunUserMaxCount
	}
	if policy.ComparisonRunUserMaxBytes > 0 {
		limits.userBytes = policy.ComparisonRunUserMaxBytes
	}
	return limits
}

func normalizeComparisonRunCreate(input PlaygroundComparisonRunCreate) (PlaygroundComparisonRunCreate, error) {
	title := strings.TrimSpace(input.Title)
	if utf8.RuneCountInString(title) > playgroundComparisonTitleMaxRunes {
		return input, ErrPlaygroundComparisonInvalid
	}
	group := strings.TrimSpace(input.Group)
	if len(group) > playgroundComparisonGroupMaxBytes {
		return input, ErrPlaygroundComparisonInvalid
	}
	if group == "" {
		group = "default"
	}
	models := make([]string, 0, len(input.Models))
	seenModels := make(map[string]struct{}, len(input.Models))
	for _, raw := range input.Models {
		modelName := strings.TrimSpace(raw)
		if modelName == "" || len(modelName) > playgroundComparisonModelMaxBytes {
			return input, ErrPlaygroundComparisonInvalid
		}
		if _, exists := seenModels[modelName]; exists {
			return input, ErrPlaygroundComparisonInvalid
		}
		seenModels[modelName] = struct{}{}
		models = append(models, modelName)
	}
	if len(models) < 2 || len(models) > playgroundComparisonMaxModels {
		return input, ErrPlaygroundComparisonInvalid
	}
	prompts := make([]string, 0, len(input.Prompts))
	for _, raw := range input.Prompts {
		prompt := strings.TrimSpace(raw)
		if prompt == "" || !utf8.ValidString(prompt) || len(prompt) > 64<<10 {
			return input, ErrPlaygroundComparisonInvalid
		}
		prompts = append(prompts, prompt)
	}
	if len(prompts) == 0 || len(prompts) > playgroundComparisonMaxPrompts {
		return input, ErrPlaygroundComparisonInvalid
	}
	// A generated default title keeps the history list readable without asking
	// the user to name every throwaway matrix.
	if title == "" {
		title = comparisonRunDefaultTitle(len(models), len(prompts))
	}
	strategy := strings.ToLower(strings.TrimSpace(input.Strategy))
	if strategy == "" {
		strategy = PlaygroundComparisonStrategySerial
	}
	if strategy != PlaygroundComparisonStrategySerial && strategy != PlaygroundComparisonStrategyConcurrent {
		return input, ErrPlaygroundComparisonInvalid
	}
	concurrency := input.Concurrency
	if strategy == PlaygroundComparisonStrategySerial {
		concurrency = 1
	} else {
		if concurrency <= 0 {
			concurrency = 2
		}
		concurrency = min(concurrency, playgroundComparisonMaxModels)
	}
	if input.EstimateQuota < 0 || input.EstimateQuota > common.MaxQuota || input.BudgetCap < 0 || input.BudgetCap > common.MaxQuota {
		return input, ErrPlaygroundComparisonInvalid
	}
	return PlaygroundComparisonRunCreate{
		Title:         title,
		Group:         group,
		Models:        models,
		Prompts:       prompts,
		Strategy:      strategy,
		Concurrency:   concurrency,
		EstimateQuota: input.EstimateQuota,
		BudgetCap:     input.BudgetCap,
	}, nil
}

func comparisonRunDefaultTitle(modelCount, promptCount int) string {
	return fmt.Sprintf("%d models x %d prompts", modelCount, promptCount)
}

func normalizeComparisonRunStatus(status string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case PlaygroundComparisonRunStatusRunning:
		return PlaygroundComparisonRunStatusRunning, true
	case PlaygroundComparisonRunStatusCompleted:
		return PlaygroundComparisonRunStatusCompleted, true
	case PlaygroundComparisonRunStatusFailed:
		return PlaygroundComparisonRunStatusFailed, true
	case PlaygroundComparisonRunStatusCanceled:
		return PlaygroundComparisonRunStatusCanceled, true
	default:
		return "", false
	}
}

func comparisonCellStatusValid(status string) bool {
	switch status {
	case PlaygroundComparisonCellPending,
		PlaygroundComparisonCellRunning,
		PlaygroundComparisonCellSucceeded,
		PlaygroundComparisonCellFailed,
		PlaygroundComparisonCellCanceled:
		return true
	default:
		return false
	}
}

func validateComparisonResults(results []PlaygroundComparisonCell, modelCount, promptCount int) error {
	if modelCount < 1 || promptCount < 1 || len(results) != modelCount*promptCount {
		return ErrPlaygroundComparisonInvalid
	}
	seen := make([]bool, len(results))
	for index := range results {
		cell := &results[index]
		if cell.PromptIndex < 0 || cell.PromptIndex >= promptCount || cell.ModelIndex < 0 || cell.ModelIndex >= modelCount {
			return ErrPlaygroundComparisonInvalid
		}
		slot := cell.PromptIndex*modelCount + cell.ModelIndex
		if seen[slot] {
			return ErrPlaygroundComparisonInvalid
		}
		seen[slot] = true
		if !comparisonCellStatusValid(cell.Status) {
			return ErrPlaygroundComparisonInvalid
		}
		if len(cell.Output) > playgroundComparisonCellOutputBytes || len(cell.Error) > playgroundComparisonCellErrorBytes {
			return ErrPlaygroundComparisonInvalid
		}
		if len(cell.ErrorCode) > playgroundComparisonErrorCodeBytes {
			return ErrPlaygroundComparisonInvalid
		}
		cell.RequestId = strings.TrimSpace(cell.RequestId)
		if len(cell.RequestId) > playgroundComparisonRequestIdBytes || strings.Contains(cell.RequestId, ",") {
			return ErrPlaygroundComparisonInvalid
		}
		if cell.PromptTokens < 0 || cell.CompletionTokens < 0 || cell.TotalTokens < 0 ||
			int64(cell.PromptTokens) > playgroundComparisonTokenMax ||
			int64(cell.CompletionTokens) > playgroundComparisonTokenMax ||
			int64(cell.TotalTokens) > playgroundComparisonTokenMax ||
			cell.LatencyMs < 0 || cell.LatencyMs > playgroundComparisonLatencyMaxMs {
			return ErrPlaygroundComparisonInvalid
		}
	}
	return nil
}

func comparisonRunByteSize(title, group string, modelsJSON, promptsJSON, resultsJSON []byte) int64 {
	return int64(len(title) + len(group) + len(modelsJSON) + len(promptsJSON) + len(resultsJSON))
}

func comparisonRunViewFromRow(run *PlaygroundComparisonRun, models []string, prompts []string, results []PlaygroundComparisonCell) *PlaygroundComparisonRunView {
	if models == nil {
		if err := common.UnmarshalJsonStr(string(run.Models), &models); err != nil {
			return nil
		}
	}
	if prompts == nil {
		if err := common.UnmarshalJsonStr(string(run.Prompts), &prompts); err != nil {
			return nil
		}
	}
	if results == nil {
		if err := common.UnmarshalJsonStr(string(run.Results), &results); err != nil {
			return nil
		}
	}
	return &PlaygroundComparisonRunView{
		ID:            run.ID,
		Title:         run.Title,
		Group:         run.Group,
		Models:        models,
		Prompts:       prompts,
		Results:       results,
		Status:        run.Status,
		Strategy:      run.Strategy,
		Concurrency:   run.Concurrency,
		EstimateQuota: run.EstimateQuota,
		BudgetCap:     run.BudgetCap,
		BaselineModel: run.BaselineModel,
		ModelCount:    run.ModelCount,
		PromptCount:   run.PromptCount,
		ByteSize:      run.ByteSize,
		Revision:      run.Revision,
		CreatedAt:     run.CreatedAt,
		UpdatedAt:     run.UpdatedAt,
	}
}
