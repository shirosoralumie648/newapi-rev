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

// playgroundGenerationHandler establishes the Playground account context and
// runs the canonical relay or task handler. The request path was already
// rewritten to its /v1 form by middleware.PlaygroundRelayBridge, so plugin
// endpoint pinning, model grouping, permissions and billing behave exactly
// like a direct API call.
func playgroundGenerationHandler(c *gin.Context, handler gin.HandlerFunc) {
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
