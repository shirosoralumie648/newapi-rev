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
package controller

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/playground_setting"

	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
)

const (
	// PlaygroundTaskQueueFullErrorCode is the stable code returned when the
	// account already holds the configured number of active queue entries.
	PlaygroundTaskQueueFullErrorCode = "PLAYGROUND_TASK_QUEUE_FULL"
	// PlaygroundTaskQueuePayloadTooLargeErrorCode is returned when a request
	// is valid for the relay but too large to retain while it waits.
	PlaygroundTaskQueuePayloadTooLargeErrorCode = "PLAYGROUND_TASK_QUEUE_PAYLOAD_TOO_LARGE"
	// PlaygroundTaskQueueUnavailableErrorCode reports a queue persistence or
	// read failure; the caller fails closed instead of silently submitting.
	PlaygroundTaskQueueUnavailableErrorCode = "PLAYGROUND_TASK_QUEUE_UNAVAILABLE"
	// PlaygroundTaskQueueNoTaskErrorCode reports that a replay returned success
	// without a durable task id. The entry is failed rather than pretending a
	// submission exists.
	PlaygroundTaskQueueNoTaskErrorCode = "PLAYGROUND_TASK_QUEUE_NO_TASK"
	// PlaygroundTaskQueueInterruptedErrorCode reports a worker stopped between
	// claiming an entry and recording its result.
	PlaygroundTaskQueueInterruptedErrorCode = "PLAYGROUND_TASK_QUEUE_INTERRUPTED"

	// playgroundTaskQueueMaxRequestBytes bounds one stored JSON request. The
	// supported image/video bodies are far below this in normal use; the cap
	// keeps a single queued row from parking an unbounded amount of bytes.
	playgroundTaskQueueMaxRequestBytes int64 = 16 << 20
	// playgroundTaskQueuePromptPreviewRunes bounds the display-only prompt
	// copied into the queue view. The full body stays in RequestBody.
	playgroundTaskQueuePromptPreviewRunes = 500
	// playgroundTaskQueueDrainLimit bounds one scheduled worker run. The next
	// run continues from the queue head, so a large backlog never holds the
	// system task handler for an unbounded time.
	playgroundTaskQueueDrainLimit = 20
	// playgroundTaskQueueStaleSubmittingSeconds recovers a claim abandoned by a
	// stopped process. The relay submission itself is bounded well below this.
	playgroundTaskQueueStaleSubmittingSeconds int64 = 120
	// playgroundTaskQueueWaitCapSeconds bounds the advisory wait estimate. The
	// queue view labels it as an estimate and never uses it for scheduling.
	playgroundTaskQueueWaitCapSeconds int64 = 7 * 24 * 60 * 60
)

// PlaygroundTaskQueueEntryView is the browser-facing projection of one queue
// entry. It deliberately omits the stored request body and owner id.
type PlaygroundTaskQueueEntryView struct {
	ID                   string `json:"id"`
	Kind                 string `json:"kind"`
	Status               string `json:"status"`
	Priority             int    `json:"priority"`
	Position             int64  `json:"position"`
	EstimatedWaitSeconds int64  `json:"estimated_wait_seconds"`
	Model                string `json:"model"`
	PromptPreview        string `json:"prompt_preview"`
	CreatedAt            int64  `json:"created_at"`
	TaskID               string `json:"task_id,omitempty"`
	ErrorCode            string `json:"error_code,omitempty"`
	ErrorMessage         string `json:"error_message,omitempty"`
}

// playgroundTaskQueueEntryView resolves the current position and advisory wait
// of one entry. Submitting and recently submitted entries have no position.
func playgroundTaskQueueEntryView(entry *model.PlaygroundTaskQueueEntry, policy playground_setting.PlaygroundQuotaPolicy) (PlaygroundTaskQueueEntryView, error) {
	view := PlaygroundTaskQueueEntryView{
		ID:            entry.QueueID,
		Kind:          entry.Kind,
		Status:        entry.Status,
		Priority:      entry.Priority,
		Model:         entry.Model,
		PromptPreview: entry.PromptPreview,
		CreatedAt:     entry.CreatedAt,
		TaskID:        entry.TaskID,
		ErrorCode:     entry.ErrorCode,
		ErrorMessage:  entry.ErrorMessage,
	}
	position, err := model.PlaygroundTaskQueuePosition(entry)
	if err != nil {
		return view, err
	}
	view.Position = position
	if position > 0 {
		average, err := model.AveragePlaygroundTaskDurationSeconds(entry.UserID)
		if err != nil {
			return view, err
		}
		view.EstimatedWaitSeconds = estimatePlaygroundTaskQueueWait(position, average, policy.TaskMaxConcurrency)
	}
	return view, nil
}

// estimatePlaygroundTaskQueueWait divides the global queue position by the
// account's concurrency slots and multiplies by its recent task duration. It is
// intentionally an estimate: other accounts' submissions are included in the
// position, while a free slot may start this entry earlier.
func estimatePlaygroundTaskQueueWait(position, averageSeconds int64, concurrency int) int64 {
	if position <= 0 || averageSeconds <= 0 {
		return 0
	}
	slots := int64(max(concurrency, 1))
	batches := (position + slots - 1) / slots
	wait := batches * averageSeconds
	if wait < 0 || wait > playgroundTaskQueueWaitCapSeconds {
		return playgroundTaskQueueWaitCapSeconds
	}
	return wait
}

// ListPlaygroundTaskQueue returns the owner's waiting entries and the recent
// dequeue transitions the browser needs to refresh its durable task list. It is
// owner-scoped; no queue id of another account is resolvable through it.
func ListPlaygroundTaskQueue(c *gin.Context) {
	userID := c.GetInt("id")
	policy, err := model.PlaygroundQuotaPolicyForUser(userID)
	if err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundTaskQueueUnavailableErrorCode, "Unable to read the generation queue.")
		return
	}
	entries, err := model.ListPlaygroundTaskQueueEntries(userID)
	if err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundTaskQueueUnavailableErrorCode, "Unable to read the generation queue.")
		return
	}
	items := make([]PlaygroundTaskQueueEntryView, 0, len(entries))
	for index := range entries {
		view, err := playgroundTaskQueueEntryView(&entries[index], policy)
		if err != nil {
			writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundTaskQueueUnavailableErrorCode, "Unable to read the generation queue.")
			return
		}
		items = append(items, view)
	}
	common.ApiSuccess(c, gin.H{
		"enabled":         playground_setting.IsTaskQueueEnabled(),
		"items":           items,
		"max_queued":      policy.TaskQueueMaxCount,
		"max_concurrency": policy.TaskMaxConcurrency,
	})
}

// PlaygroundTaskQueueCancel cancels one queued entry. A submitting or submitted
// entry is rejected: once the relay starts, cancellation belongs to the durable
// task endpoint and its refund path.
func PlaygroundTaskQueueCancel(c *gin.Context) {
	userID := c.GetInt("id")
	entry, err := model.CancelPlaygroundTaskQueueEntry(userID, strings.TrimSpace(c.Param("queueId")))
	if err != nil {
		switch {
		case errors.Is(err, model.ErrPlaygroundTaskQueueNotFound):
			common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Queued generation not found."), gin.H{"code": "PLAYGROUND_TASK_QUEUE_NOT_FOUND"})
		case errors.Is(err, model.ErrPlaygroundTaskQueueNotCancelable):
			common.ApiErrorStatus(c, http.StatusConflict, common.NewMessage("The queued generation already started."), gin.H{"code": "PLAYGROUND_TASK_QUEUE_NOT_CANCELABLE"})
		default:
			common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Unable to cancel the queued generation."), gin.H{"code": PlaygroundTaskQueueUnavailableErrorCode})
		}
		return
	}
	policy, err := model.PlaygroundQuotaPolicyForUser(userID)
	if err != nil {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Unable to read the generation queue."), gin.H{"code": PlaygroundTaskQueueUnavailableErrorCode})
		return
	}
	view, err := playgroundTaskQueueEntryView(entry, policy)
	if err != nil {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Unable to read the generation queue."), gin.H{"code": PlaygroundTaskQueueUnavailableErrorCode})
		return
	}
	common.ApiSuccess(c, gin.H{"queue": view})
}

// PlaygroundTaskQueuePrioritize moves one queued entry above the current global
// queue head. Only the owner can move it, and only while it is still queued.
func PlaygroundTaskQueuePrioritize(c *gin.Context) {
	userID := c.GetInt("id")
	entry, err := model.PrioritizePlaygroundTaskQueueEntry(userID, strings.TrimSpace(c.Param("queueId")))
	if err != nil {
		switch {
		case errors.Is(err, model.ErrPlaygroundTaskQueueNotFound):
			common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Queued generation not found."), gin.H{"code": "PLAYGROUND_TASK_QUEUE_NOT_FOUND"})
		case errors.Is(err, model.ErrPlaygroundTaskQueueNotCancelable):
			common.ApiErrorStatus(c, http.StatusConflict, common.NewMessage("The queued generation already started."), gin.H{"code": "PLAYGROUND_TASK_QUEUE_NOT_CANCELABLE"})
		default:
			common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Unable to move the queued generation."), gin.H{"code": PlaygroundTaskQueueUnavailableErrorCode})
		}
		return
	}
	policy, err := model.PlaygroundQuotaPolicyForUser(userID)
	if err != nil {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Unable to read the generation queue."), gin.H{"code": PlaygroundTaskQueueUnavailableErrorCode})
		return
	}
	view, err := playgroundTaskQueueEntryView(entry, policy)
	if err != nil {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Unable to read the generation queue."), gin.H{"code": PlaygroundTaskQueueUnavailableErrorCode})
		return
	}
	common.ApiSuccess(c, gin.H{"queue": view})
}

// playgroundTaskQueueKindForPath returns the supported queue kind of a
// canonical generation path. Multipart image edits and every other request
// shape return an empty string and keep the existing immediate rejection.
func playgroundTaskQueueKindForPath(path string) string {
	switch path {
	case "/v1/videos", "/v1/video/generations":
		return model.PlaygroundTaskQueueKindVideo
	case "/v1/images/generations":
		return model.PlaygroundTaskQueueKindImage
	default:
		return ""
	}
}

// tryEnqueuePlaygroundTaskQueue stores one validated concurrency-rejected
// generation and answers 202. It returns false only when the request shape is
// not queueable; every other outcome is an explicit response. Queueing itself
// never reserves or charges quota.
func tryEnqueuePlaygroundTaskQueue(c *gin.Context, userID int, policy playground_setting.PlaygroundQuotaPolicy) bool {
	// A workflow step bills against a live run budget that cannot be preserved
	// while the entry waits, so it keeps the immediate concurrency rejection.
	if common.GetContextKeyString(c, constant.ContextKeyPlaygroundWorkflowRun) != "" {
		return false
	}
	kind := playgroundTaskQueueKindForPath(c.Request.URL.Path)
	if kind == "" {
		return false
	}
	contentType := strings.ToLower(strings.TrimSpace(c.Request.Header.Get("Content-Type")))
	if !strings.HasPrefix(contentType, "application/json") {
		return false
	}
	storage, err := common.GetBodyStorage(c)
	if err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundTaskQueueUnavailableErrorCode, "Unable to store the queued generation.")
		return true
	}
	if storage.Size() <= 0 || storage.Size() > playgroundTaskQueueMaxRequestBytes {
		writePlaygroundGenerationError(c, http.StatusRequestEntityTooLarge, PlaygroundTaskQueuePayloadTooLargeErrorCode, "The generation request is too large to queue.")
		return true
	}
	body, err := storage.Bytes()
	if err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundTaskQueueUnavailableErrorCode, "Unable to store the queued generation.")
		return true
	}
	var payload struct {
		Model  string `json:"model"`
		Prompt string `json:"prompt"`
	}
	_ = common.Unmarshal(body, &payload)
	entry := &model.PlaygroundTaskQueueEntry{
		UserID:        userID,
		Kind:          kind,
		RequestPath:   c.Request.URL.Path,
		Group:         common.GetContextKeyString(c, constant.ContextKeyUsingGroup),
		ContentType:   c.Request.Header.Get("Content-Type"),
		RequestBody:   model.LongText(body),
		RequestBytes:  storage.Size(),
		Model:         payload.Model,
		PromptPreview: truncatePlaygroundTaskQueuePrompt(payload.Prompt),
	}
	if _, err := model.EnqueuePlaygroundTaskQueueEntry(entry, policy.TaskQueueMaxCount); err != nil {
		if errors.Is(err, model.ErrPlaygroundTaskQueueFull) {
			writePlaygroundGenerationError(c, http.StatusTooManyRequests, PlaygroundTaskQueueFullErrorCode, "The generation queue is full. Wait for a queued or running task to finish.")
			return true
		}
		common.SysError(common.LogText("failed to enqueue a playground generation: %s", err.Error()))
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundTaskQueueUnavailableErrorCode, "Unable to queue the generation.")
		return true
	}
	view, err := playgroundTaskQueueEntryView(entry, policy)
	if err != nil {
		// The entry is already accepted. Do not turn a display lookup failure
		// into an error the browser would retry as a duplicate submission.
		view = PlaygroundTaskQueueEntryView{
			ID:            entry.QueueID,
			Kind:          entry.Kind,
			Status:        entry.Status,
			Model:         entry.Model,
			PromptPreview: entry.PromptPreview,
			CreatedAt:     entry.CreatedAt,
		}
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusAccepted, gin.H{
		"success": true,
		"message": "",
		"data":    gin.H{"queue": view},
	})
	return true
}

func truncatePlaygroundTaskQueuePrompt(prompt string) string {
	prompt = strings.TrimSpace(prompt)
	runes := []rune(prompt)
	if len(runes) <= playgroundTaskQueuePromptPreviewRunes {
		return prompt
	}
	return string(runes[:playgroundTaskQueuePromptPreviewRunes])
}

// playgroundTaskQueueHandler drains accepted workspace submissions when their
// owner has a free concurrency slot. It runs on the scheduled system-task
// runner, which holds a per-type lock, so one process dequeues at a time; each
// claim is still a database CAS.
type playgroundTaskQueueHandler struct{}

func (playgroundTaskQueueHandler) Type() string { return model.SystemTaskTypePlaygroundTaskQueue }

func (playgroundTaskQueueHandler) Enabled() bool {
	hasQueued, err := model.HasQueuedPlaygroundTaskQueueEntries()
	if err != nil {
		common.SysError(common.LogText("failed to inspect the playground task queue: %s", err.Error()))
		return false
	}
	return hasQueued
}

func (playgroundTaskQueueHandler) Interval() time.Duration {
	return playgroundTaskQueueInterval
}

func (playgroundTaskQueueHandler) NewPayload() any { return nil }

func (playgroundTaskQueueHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	summary, err := runPlaygroundTaskQueueOnce(ctx)
	if err != nil {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, summary, err)
		return
	}
	finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusSucceeded, summary, nil)
}

const playgroundTaskQueueInterval = 15 * time.Second

type playgroundTaskQueueSubmissionResult struct {
	taskID       string
	statusCode   int
	errorCode    string
	errorMessage string
	// capacity asks the worker to release the entry and stop this run because
	// another submission took the last slot between selection and replay.
	capacity bool
	// transient asks the worker to release the entry for a later attempt.
	transient bool
	// fatal reaches the attempt limit immediately; retrying cannot succeed.
	fatal bool
}

// runPlaygroundTaskQueueOnce drains up to one bounded batch. Entries whose
// owner is still at the concurrency limit stay queued; the worker walks past
// them so one busy account cannot block another account.
func runPlaygroundTaskQueueOnce(ctx context.Context) (map[string]any, error) {
	summary := map[string]any{
		"recovered": int64(0),
		"claimed":   0,
		"submitted": 0,
		"released":  0,
		"failed":    0,
	}
	recovered, err := model.RecoverStalePlaygroundTaskQueueEntries(common.GetTimestamp() - playgroundTaskQueueStaleSubmittingSeconds)
	if err != nil {
		return summary, err
	}
	summary["recovered"] = recovered

	skip := make(map[string]bool)
	for claimedCount := 0; claimedCount < playgroundTaskQueueDrainLimit; {
		if err := ctx.Err(); err != nil {
			return summary, err
		}
		candidates, err := model.ListQueuedPlaygroundTaskQueueCandidates(100)
		if err != nil {
			return summary, err
		}
		claimed := false
		for index := range candidates {
			entry := &candidates[index]
			if skip[entry.QueueID] {
				continue
			}
			hasCapacity, err := playgroundTaskQueueOwnerHasCapacity(entry.UserID)
			if err != nil {
				return summary, err
			}
			if !hasCapacity {
				continue
			}
			won, err := model.ClaimPlaygroundTaskQueueEntry(entry.QueueID)
			if err != nil {
				return summary, err
			}
			if !won {
				continue
			}
			claimed = true
			claimedCount++
			summary["claimed"] = claimedCount
			entry.Attempts++
			result := executePlaygroundTaskQueueEntry(ctx, entry)
			handlePlaygroundTaskQueueSubmissionResult(entry, result, summary)
			if result.capacity {
				return summary, nil
			}
			if result.transient {
				skip[entry.QueueID] = true
			}
			break
		}
		if !claimed {
			break
		}
	}
	return summary, nil
}

func playgroundTaskQueueOwnerHasCapacity(userID int) (bool, error) {
	policy, err := model.PlaygroundQuotaPolicyForUser(userID)
	if err != nil {
		return false, err
	}
	if policy.TaskMaxConcurrency <= 0 {
		return true, nil
	}
	active, err := model.CountActivePlaygroundTasks(userID)
	if err != nil {
		return false, err
	}
	return active < int64(policy.TaskMaxConcurrency), nil
}

func handlePlaygroundTaskQueueSubmissionResult(entry *model.PlaygroundTaskQueueEntry, result playgroundTaskQueueSubmissionResult, summary map[string]any) {
	if result.taskID != "" {
		if err := model.CompletePlaygroundTaskQueueEntry(entry.UserID, entry.QueueID, result.taskID); err != nil {
			common.SysError(common.LogText("playground task queue entry %s submitted task %s but consistency check failed: %v", entry.QueueID, result.taskID, err))
			if failErr := model.FailPlaygroundTaskQueueEntry(entry.QueueID, PlaygroundTaskQueueNoTaskErrorCode, "The queued generation finished without a matching task."); failErr != nil {
				common.SysError(common.LogText("playground task queue entry %s failed to record consistency failure: %v", entry.QueueID, failErr))
			}
			summary["failed"] = summary["failed"].(int) + 1
			return
		}
		summary["submitted"] = summary["submitted"].(int) + 1
		return
	}

	if result.fatal {
		if err := model.FailPlaygroundTaskQueueEntry(entry.QueueID, result.errorCode, result.errorMessage); err != nil {
			common.SysError(common.LogText("playground task queue entry %s failed to record failure: %v", entry.QueueID, err))
		}
		summary["failed"] = summary["failed"].(int) + 1
		return
	}

	status, err := model.ReleasePlaygroundTaskQueueEntry(entry.QueueID, entry.Attempts, model.PlaygroundTaskQueueMaxAttempts, result.errorCode, result.errorMessage)
	if err != nil {
		common.SysError(common.LogText("playground task queue entry %s failed to release: %v", entry.QueueID, err))
		return
	}
	if status == model.PlaygroundTaskQueueStatusFailed {
		summary["failed"] = summary["failed"].(int) + 1
		return
	}
	summary["released"] = summary["released"].(int) + 1
}

// executePlaygroundTaskQueueEntry replays the canonical generation pipeline in
// the owner's context. The entry stores the already validated canonical JSON
// body, so the same Pin/Prepare/Distribute/handler chain runs as a browser
// submission. No client connection, browser admission limit, or queue
// submission is involved: if the slot was taken meanwhile, the replay flag makes
// the budget check return the ordinary 429 and the worker releases this entry.
func executePlaygroundTaskQueueEntry(ctx context.Context, entry *model.PlaygroundTaskQueueEntry) playgroundTaskQueueSubmissionResult {
	userCache, err := model.GetUserCache(entry.UserID)
	if err != nil {
		return playgroundTaskQueueSubmissionResult{statusCode: http.StatusServiceUnavailable, errorCode: PlaygroundTaskQueueUnavailableErrorCode, errorMessage: "Unable to load the queued generation owner.", transient: true}
	}
	group := entry.Group
	if group == "" {
		group = userCache.Group
	}
	if entry.Group != "" && !service.GroupInUserUsableGroups(userCache.Group, entry.Group) {
		return playgroundTaskQueueSubmissionResult{statusCode: http.StatusForbidden, errorCode: "PLAYGROUND_TASK_QUEUE_GROUP_UNAVAILABLE", errorMessage: "The generation group is no longer available to this account.", fatal: true}
	}

	// Re-enter through the canonical workspace path so PlaygroundRelayBridge
	// validates the stored body, restores the generation snapshot and rewrites
	// the path to /v1 before pinning and distribution, exactly like a browser
	// submission. The owner group travels in the bridge header so the originally
	// selected group survives even when it came from the request body.
	replayPath := entry.RequestPath
	if strings.HasPrefix(entry.RequestPath, "/v1/") {
		replayPath = "/pg/" + strings.TrimPrefix(entry.RequestPath, "/v1/")
	}
	recorder := httptest.NewRecorder()
	engine := newPlaygroundTaskQueueReplayEngine(entry, group, replayPath)
	request := httptest.NewRequest(http.MethodPost, replayPath, bytes.NewReader([]byte(entry.RequestBody)))
	request = request.WithContext(ctx)
	request.Header.Set("Content-Type", entry.ContentType)
	request.Header.Set("Accept", "application/json")
	engine.ServeHTTP(recorder, request)

	body := recorder.Body.Bytes()
	status := recorder.Code
	if status >= 200 && status < 300 {
		taskID := playgroundTaskQueueResponseTaskID(body)
		if taskID == "" {
			return playgroundTaskQueueSubmissionResult{statusCode: status, errorCode: PlaygroundTaskQueueNoTaskErrorCode, errorMessage: "The queued generation finished without a task id.", fatal: true}
		}
		return playgroundTaskQueueSubmissionResult{taskID: taskID, statusCode: status}
	}

	code := strings.TrimSpace(gjson.GetBytes(body, "error.code").String())
	message := strings.TrimSpace(gjson.GetBytes(body, "error.message").String())
	if message == "" {
		message = http.StatusText(status)
	}
	result := playgroundTaskQueueSubmissionResult{statusCode: status, errorCode: code, errorMessage: message}
	switch {
	case code == PlaygroundTaskLimitErrorCode:
		result.capacity = true
		result.transient = true
	case code == PlaygroundTaskStorageLimitErrorCode:
		result.fatal = true
	case status == http.StatusTooManyRequests || status == http.StatusRequestTimeout || status >= http.StatusInternalServerError:
		result.transient = true
	default:
		result.fatal = true
	}
	return result
}

func newPlaygroundTaskQueueReplayEngine(entry *model.PlaygroundTaskQueueEntry, group, replayPath string) *gin.Engine {
	engine := gin.New()
	engine.Use(gin.Recovery())
	engine.Use(func(c *gin.Context) {
		userCache, err := model.GetUserCache(entry.UserID)
		if err != nil {
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		c.Set("id", entry.UserID)
		userCache.WriteContext(c)
		if group != "" {
			c.Request.Header.Set("X-Playground-Group", group)
		}
		common.SetContextKey(c, constant.ContextKeyUsingGroup, group)
		common.SetContextKey(c, constant.ContextKeyPlaygroundOrigin, true)
		common.SetContextKey(c, constant.ContextKeyPlaygroundTaskQueueReplay, true)
		c.Next()
	})
	engine.POST(replayPath,
		middleware.PlaygroundRelayBridge(entry.RequestPath),
		middleware.PinTaskPluginEndpoint(),
		middleware.PrepareTaskPluginEndpoint(),
		middleware.Distribute(),
		func(c *gin.Context) {
			switch entry.Kind {
			case model.PlaygroundTaskQueueKindVideo:
				PlaygroundVideoTask(c)
			default:
				PlaygroundImageGeneration(c)
			}
		},
	)
	return engine
}

func playgroundTaskQueueResponseTaskID(body []byte) string {
	for _, path := range []string{"data.task_id", "task_id", "id"} {
		if taskID := strings.TrimSpace(gjson.GetBytes(body, path).String()); taskID != "" {
			return taskID
		}
	}
	return ""
}
