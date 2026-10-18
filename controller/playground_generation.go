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
	"errors"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"

	"github.com/gin-gonic/gin"
)

// PlaygroundTaskLimitErrorCode is the stable error code the workspace uses to
// translate an exceeded account-level async generation task budget. The limit
// comes from the independent Playground resource policy, never from
// User.Quota or token billing.
const PlaygroundTaskLimitErrorCode = "PLAYGROUND_TASK_LIMIT_EXCEEDED"

// PlaygroundTaskStorageLimitErrorCode is the stable error code for an exceeded
// account-level async task result storage budget.
const PlaygroundTaskStorageLimitErrorCode = "PLAYGROUND_TASK_STORAGE_LIMIT_EXCEEDED"

// PlaygroundWalletDebtErrorCode is the stable error code returned for new
// billable workspace work (generation, uploads) from an account whose wallet
// holds unsettled debt. Reading and exporting stay available.
const PlaygroundWalletDebtErrorCode = "PLAYGROUND_WALLET_DEBT_READ_ONLY"

// PlaygroundWalletDebtUnavailableErrorCode reports that the debt state could not
// be checked; the request fails closed.
const PlaygroundWalletDebtUnavailableErrorCode = "PLAYGROUND_WALLET_DEBT_UNAVAILABLE"

// PlaygroundWalletDebtMessage is the English source message of the read-only
// workspace lock; the frontend translates it by code.
const PlaygroundWalletDebtMessage = "Your wallet has unsettled debt. Top up to restore access; reading and exporting data stays available."

// enforcePlaygroundWalletWritable rejects new billable workspace work while the
// account has unsettled wallet debt. The workspace lock is a server-side
// control: the debt state is re-read here and never trusted from the client.
func enforcePlaygroundWalletWritable(c *gin.Context) bool {
	_, readOnly, err := model.ResolveWalletDebtStatus(c.GetInt("id"))
	if err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundWalletDebtUnavailableErrorCode, "Unable to check the account wallet debt.")
		return false
	}
	if !readOnly {
		return true
	}
	writePlaygroundGenerationError(c, http.StatusForbidden, PlaygroundWalletDebtErrorCode, PlaygroundWalletDebtMessage)
	return false
}

// playgroundGenerationHandler establishes the Playground account context and
// runs the canonical relay or task handler. The request path was already
// rewritten to its /v1 form by middleware.PlaygroundRelayBridge, so plugin
// endpoint pinning, model grouping, permissions and billing behave exactly
// like a direct API call.
func playgroundGenerationHandler(c *gin.Context, handler gin.HandlerFunc) {
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	group := common.GetContextKeyString(c, constant.ContextKeyUsingGroup)
	if err := setupPlaygroundToken(c, group); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": types.NewError(err, types.ErrorCodeQueryDataError, types.ErrOptionWithSkipRetry()).ToOpenAIError(),
		})
		return
	}
	c.Set(string(constant.ContextKeyPlaygroundOrigin), true)
	handler(c)
}

// playgroundTaskCreatesTask reports whether the request will create an async
// generation task. The /v1/videos route always does; /v1/images/* does when a
// task plugin claimed the shared endpoint before channel selection.
func playgroundTaskCreatesTask(c *gin.Context) bool {
	if c.Request.URL.Path == "/v1/videos" || c.Request.URL.Path == "/v1/video/generations" {
		return true
	}
	_, pinned := c.Get(pluginruntime.ContextKeyPinnedEndpoint)
	return pinned
}

// enforcePlaygroundTaskBudget applies the Q-01 account task concurrency and
// result storage budgets to one async generation submission. The checks are
// intentionally advisory: task rows are the durable record and their state is
// re-read from the database on every poll, so a small race between two
// concurrent submits never bypasses quota in a compounding way, and the
// settled billing of an already accepted task is never touched here.
func enforcePlaygroundTaskBudget(c *gin.Context) bool {
	if !playgroundTaskCreatesTask(c) {
		return true
	}
	userID := c.GetInt("id")
	policy, err := model.PlaygroundQuotaPolicyForUser(userID)
	if err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, "PLAYGROUND_TASK_LIMIT_UNAVAILABLE", "Unable to check the account task budget.")
		return false
	}
	if policy.TaskMaxConcurrency > 0 {
		active, err := model.CountActivePlaygroundTasks(userID)
		if err != nil {
			writePlaygroundGenerationError(c, http.StatusInternalServerError, "PLAYGROUND_TASK_LIMIT_UNAVAILABLE", "Unable to check the account task budget.")
			return false
		}
		if active >= int64(policy.TaskMaxConcurrency) {
			writePlaygroundGenerationError(c, http.StatusTooManyRequests, PlaygroundTaskLimitErrorCode, "Playground task concurrency limit reached. Wait for a running task to finish.")
			return false
		}
	}
	if policy.TaskUserResultMaxBytes > 0 {
		stored, err := model.PlaygroundTaskResultStorageBytes(userID)
		if err != nil {
			writePlaygroundGenerationError(c, http.StatusInternalServerError, "PLAYGROUND_TASK_LIMIT_UNAVAILABLE", "Unable to check the account task budget.")
			return false
		}
		if stored >= policy.TaskUserResultMaxBytes {
			writePlaygroundGenerationError(c, http.StatusTooManyRequests, PlaygroundTaskStorageLimitErrorCode, "Playground task result storage limit reached. Wait for old task results to expire.")
			return false
		}
	}
	return true
}

func writePlaygroundGenerationError(c *gin.Context, status int, code, message string) {
	c.Header("Cache-Control", "private, no-store")
	c.JSON(status, gin.H{
		"error": gin.H{
			"message": message,
			"type":    "new_api_error",
			"code":    code,
		},
	})
}

// PlaygroundImageGeneration serves image generation from the workspace through
// the canonical /v1/images/generations pipeline: a plugin-claimed image model
// enters the generation-pinned protocol bridge, everything else falls back to
// the ordinary image relay.
func PlaygroundImageGeneration(c *gin.Context) {
	if !enforcePlaygroundTaskBudget(c) {
		return
	}
	playgroundGenerationHandler(c, func(c *gin.Context) {
		RelayTaskPluginEndpoint(c, func(c *gin.Context) { Relay(c, types.RelayFormatOpenAIImage) })
	})
}

// PlaygroundImageEdit serves image edits from the workspace through the
// canonical /v1/images/edits pipeline.
func PlaygroundImageEdit(c *gin.Context) {
	if !enforcePlaygroundTaskBudget(c) {
		return
	}
	playgroundGenerationHandler(c, func(c *gin.Context) {
		RelayTaskPluginEndpoint(c, func(c *gin.Context) { Relay(c, types.RelayFormatOpenAIImage) })
	})
}

// PlaygroundVideoTask submits a video or other async generation task from the
// workspace through the canonical /v1/videos pipeline.
func PlaygroundVideoTask(c *gin.Context) {
	if !enforcePlaygroundTaskBudget(c) {
		return
	}
	playgroundGenerationHandler(c, func(c *gin.Context) {
		RelayTaskPluginEndpoint(c, RelayTask)
	})
}

// PlaygroundAudioSpeech serves audio generation from the workspace through the
// canonical /v1/audio/speech pipeline. Speech is synchronous, so it does not
// consume the async task concurrency budget.
func PlaygroundAudioSpeech(c *gin.Context) {
	playgroundGenerationHandler(c, func(c *gin.Context) { Relay(c, types.RelayFormatOpenAIAudio) })
}

// PlaygroundTaskCancel cancels one unfinished workspace generation task with a
// status CAS and refunds the quota reserved at submission. Only tasks created
// from the Playground workspace are visible here; a direct API task id returns
// 404 even when it belongs to the caller.
func PlaygroundTaskCancel(c *gin.Context) {
	task, err := model.CancelPlaygroundTask(c.GetInt("id"), c.Param("taskId"))
	if err != nil {
		status, code, message := http.StatusInternalServerError, "PLAYGROUND_TASK_CANCEL_FAILED", "Unable to cancel the task."
		switch {
		case errors.Is(err, model.ErrPlaygroundTaskNotFound):
			status, code, message = http.StatusNotFound, "PLAYGROUND_TASK_NOT_FOUND", "Task not found."
		case errors.Is(err, model.ErrPlaygroundTaskNotCancelable):
			status, code, message = http.StatusConflict, "PLAYGROUND_TASK_NOT_CANCELABLE", "Only a running task can be canceled."
		}
		common.ApiErrorStatus(c, status, common.NewMessage(message), gin.H{"code": code})
		return
	}
	if task.Quota != 0 {
		service.RefundTaskQuota(c.Request.Context(), task, model.PlaygroundTaskCanceledReason)
	}
	common.ApiSuccess(c, gin.H{"task_id": task.TaskID, "status": task.Status})
}

// PlaygroundTaskArtifactPin keeps or releases the stored bytes of one
// generated result. Pinning is what exempts the artifact from the result
// retention window; it is owner-scoped to workspace tasks, and the result
// budget still applies while bytes are stored. Releasing a pin only removes
// the asset-library pin, so a canvas that still references the result keeps it.
func PlaygroundTaskArtifactPin(c *gin.Context) {
	userID := c.GetInt("id")
	taskID := strings.TrimSpace(c.Param("taskId"))
	artifactKey := strings.TrimSpace(c.Param("artifactKey"))
	var request struct {
		Pinned *bool `json:"pinned"`
	}
	if err := common.DecodeJson(c.Request.Body, &request); err != nil || request.Pinned == nil {
		common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage("Invalid request."), gin.H{"code": "PLAYGROUND_INVALID_REQUEST"})
		return
	}

	task, exists, err := model.GetByTaskId(userID, taskID)
	if err != nil {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Unable to query the task."), gin.H{"code": "PLAYGROUND_STORAGE_ERROR"})
		return
	}
	if !exists || task == nil || !task.PrivateData.PlaygroundOrigin {
		common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Task not found."), gin.H{"code": "PLAYGROUND_TASK_NOT_FOUND"})
		return
	}
	if task.Status != model.TaskStatusSuccess {
		common.ApiErrorStatus(c, http.StatusConflict, common.NewMessage("Only a finished task keeps its results."), gin.H{"code": "PLAYGROUND_TASK_NOT_READY"})
		return
	}
	if !playgroundTaskArtifactKeyExists(task, artifactKey) {
		common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Task or artifact not found."), gin.H{"code": "PLAYGROUND_TASK_ARTIFACT_NOT_FOUND"})
		return
	}
	if err := model.SetPlaygroundTaskArtifactPin(userID, taskID, artifactKey, *request.Pinned); err != nil {
		common.ApiErrorStatus(c, http.StatusInternalServerError, common.NewMessage("Unable to update the result retention."), gin.H{"code": "PLAYGROUND_STORAGE_ERROR"})
		return
	}
	common.ApiSuccess(c, gin.H{"task_id": taskID, "artifact_key": artifactKey, "pinned": *request.Pinned})
}

// playgroundTaskArtifactKeyExists reports whether the artifact key belongs to
// the task's results. An already projected artifact is accepted (stored,
// pending, or expired); otherwise the key must be part of the current
// projection (the plugin listing or the legacy video result), so a caller
// cannot pin an arbitrary key.
func playgroundTaskArtifactKeyExists(task *model.Task, artifactKey string) bool {
	if task == nil || !taskArtifactKeyPattern.MatchString(artifactKey) {
		return false
	}
	record, err := model.GetPlaygroundTaskArtifact(task.UserId, task.TaskID, artifactKey)
	if err != nil {
		return false
	}
	if record != nil {
		return true
	}
	if !taskHasPluginExecution(task) {
		return artifactKey == "video" && legacyVideoAvailable(task)
	}
	artifacts, err := projectTaskArtifacts(task)
	if err != nil {
		return false
	}
	for _, artifact := range artifacts {
		if artifact.Key == artifactKey {
			return true
		}
	}
	return false
}
