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
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/billingexpr"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	relaytypes "github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/group_setting"

	"github.com/gin-gonic/gin"
)

// BL-03 workspace workflow run budget endpoints. The canvas asks for a per-node
// pre-charge estimate before a run, may open one budget cap for the run, and
// settles that budget when the run stops. A step bills inside the budget
// through BillingSourceWorkflowBudget; without a cap the estimate is advisory
// and every step bills exactly as before.

const (
	// PlaygroundWorkflowBudgetUnavailableCode reports a malformed estimate or
	// budget request that the workspace maps to a translated message.
	PlaygroundWorkflowBudgetUnavailableCode = "PLAYGROUND_WORKFLOW_BUDGET_UNAVAILABLE"
	// PlaygroundWorkflowBudgetInsufficientCode reports a run cap the wallet
	// cannot cover.
	PlaygroundWorkflowBudgetInsufficientCode = "PLAYGROUND_WORKFLOW_BUDGET_INSUFFICIENT"
	// PlaygroundWorkflowRunNotFoundCode hides another account's run budget.
	PlaygroundWorkflowRunNotFoundCode = "PLAYGROUND_WORKFLOW_RUN_NOT_FOUND"
	// PlaygroundWorkflowRunSettleFailedCode reports a budget settlement that
	// could not reach the wallet.
	PlaygroundWorkflowRunSettleFailedCode = "PLAYGROUND_WORKFLOW_RUN_SETTLE_FAILED"
)

// playgroundWorkflowRunPrefix marks the server-generated run budget ids.
const playgroundWorkflowRunPrefix = "pgw_"

// playgroundWorkflowRunIdLength is the random part of a generated run id.
const playgroundWorkflowRunIdLength = 32

// maxPlaygroundWorkflowEstimateSteps bounds one estimate request.
const maxPlaygroundWorkflowEstimateSteps = 64

// maxPlaygroundWorkflowStepTokens bounds the client-supplied prompt-token
// estimate so a forged payload cannot ask for an absurd quota.
const maxPlaygroundWorkflowStepTokens = 2_000_000

// maxPlaygroundWorkflowStepImages bounds the client-supplied image count. The
// real request is priced through the same bound (dto.MaxImageN), so a forged
// estimate can never show a price the relay would not also compute.
const maxPlaygroundWorkflowStepImages = dto.MaxImageN

// newPlaygroundWorkflowRunId returns a run id this server hands out and accepts
// back through the X-Playground-Workflow-Run header.
func newPlaygroundWorkflowRunId() string {
	return playgroundWorkflowRunPrefix + common.GetRandomString(playgroundWorkflowRunIdLength)
}

type playgroundWorkflowEstimateStep struct {
	NodeId string `json:"node_id"`
	// Kind selects the billing path of the node: "chat" for text models,
	// "image" for synchronous image generation, "video" for async generation
	// tasks. Anything else is reported as unavailable.
	Kind    string `json:"kind"`
	Model   string `json:"model"`
	Tokens  int    `json:"tokens"`
	Count   int    `json:"count"`
	Size    string `json:"size"`
	Quality string `json:"quality"`
	// Group is the node's own group override; empty means the run group. An
	// account may run different steps in different groups, so each step is
	// priced with the group its real request would use.
	Group string `json:"group"`
}

type playgroundWorkflowEstimateRequest struct {
	Group string                           `json:"group"`
	Steps []playgroundWorkflowEstimateStep `json:"steps"`
}

type playgroundWorkflowEstimateStepResult struct {
	NodeId string `json:"node_id"`
	Quota  int    `json:"quota"`
	// Available is false when the node has no configured price or its
	// parameters cannot be priced; the workspace still runs it and the actual
	// charge is settled as usual.
	Available bool `json:"available"`
	// Approximate marks a step whose pre-charge estimate cannot include the
	// usage-profile ratios an async task adaptor applies at submission (video
	// duration and size).
	Approximate bool `json:"approximate"`
}

type playgroundWorkflowEstimateResult struct {
	Steps      []playgroundWorkflowEstimateStepResult `json:"steps"`
	TotalQuota int                                    `json:"total_quota"`
	// Available is false when any step could not be priced.
	Available bool `json:"available"`
}

// PlaygroundWorkflowEstimate prices the nodes of one prospective workflow run
// with the same helpers the relay uses to pre-charge a real request: token and
// image steps mirror ModelPriceHelper, task steps mirror the per-call base of
// ModelPriceHelperPerCall. A node that cannot be priced is reported as
// unavailable instead of failing the whole estimate, because a run may mix
// priced and unpriced models.
func PlaygroundWorkflowEstimate(c *gin.Context) {
	var request playgroundWorkflowEstimateRequest
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		writePlaygroundGenerationError(c, http.StatusBadRequest, PlaygroundWorkflowBudgetUnavailableCode, "Invalid estimate request.")
		return
	}
	if len(request.Steps) > maxPlaygroundWorkflowEstimateSteps {
		writePlaygroundGenerationError(c, http.StatusBadRequest, PlaygroundWorkflowBudgetUnavailableCode, "Too many workflow steps to estimate.")
		return
	}
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	userId := c.GetInt("id")
	userGroup, err := model.GetUserGroup(userId, false)
	if err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundWorkflowBudgetUnavailableCode, "Unable to price the workflow steps.")
		return
	}
	// The requested group was already validated against the account's usable
	// groups by the workspace; re-validate here so a forged request can never
	// price with a group the caller may not use.
	group, ok := playgroundWorkflowEstimateGroup(userGroup, request.Group)
	if !ok {
		writePlaygroundGenerationError(c, http.StatusForbidden, PlaygroundWorkflowBudgetUnavailableCode, "The requested group is not available to this account.")
		return
	}
	if err := setupPlaygroundToken(c, group); err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundWorkflowBudgetUnavailableCode, "Unable to price the workflow steps.")
		return
	}
	relayInfo, err := relaycommon.GenRelayInfo(c, relaytypes.RelayFormatOpenAI, nil, nil)
	if err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundWorkflowBudgetUnavailableCode, "Unable to price the workflow steps.")
		return
	}

	result := playgroundWorkflowEstimateResult{
		Steps:     make([]playgroundWorkflowEstimateStepResult, 0, len(request.Steps)),
		Available: true,
	}
	for _, step := range request.Steps {
		stepResult := playgroundWorkflowEstimateStepResult{NodeId: step.NodeId}
		stepResult.Quota, stepResult.Available, stepResult.Approximate = estimatePlaygroundWorkflowStep(c, relayInfo, userGroup, step)
		if stepResult.Available {
			result.TotalQuota += stepResult.Quota
		} else {
			result.Available = false
		}
		result.Steps = append(result.Steps, stepResult)
	}
	common.ApiSuccess(c, result)
}

// playgroundWorkflowEstimateGroup resolves one requested group to the group a
// real request would run in. An empty request means the account's own group; a
// group the account may not use is refused instead of being priced.
func playgroundWorkflowEstimateGroup(userGroup, requested string) (string, bool) {
	group := group_setting.ResolveGroupID(strings.TrimSpace(requested))
	if group == "" || group == userGroup {
		return userGroup, true
	}
	if !service.GroupInUserUsableGroups(userGroup, group) {
		return "", false
	}
	return group, true
}

// estimatePlaygroundWorkflowStep prices one node. The base relay info is copied
// so a failed or tiered step can never leak an earlier step's pricing identity
// into the next one.
func estimatePlaygroundWorkflowStep(c *gin.Context, relayInfo *relaycommon.RelayInfo, userGroup string, step playgroundWorkflowEstimateStep) (int, bool, bool) {
	modelName := strings.TrimSpace(step.Model)
	if modelName == "" {
		return 0, false, false
	}
	stepGroup, ok := playgroundWorkflowEstimateGroup(userGroup, step.Group)
	if !ok {
		return 0, false, false
	}
	tokens := step.Tokens
	if tokens < 0 {
		tokens = 0
	}
	if tokens > maxPlaygroundWorkflowStepTokens {
		tokens = maxPlaygroundWorkflowStepTokens
	}
	stepInfo := *relayInfo
	stepInfo.OriginModelName = modelName
	stepInfo.BillingModelName = ""
	stepInfo.UsingGroup = stepGroup
	stepInfo.Request = nil
	stepInfo.BillingImageCount = nil
	stepInfo.TieredBillingSnapshot = nil
	// The estimate POST body is not a chat request, so tiered pricing must run
	// against this empty input instead of reading the body.
	stepInfo.BillingRequestInput = &billingexpr.RequestInput{}

	switch step.Kind {
	case "image":
		count := step.Count
		if count < 1 {
			count = 1
		}
		if count > maxPlaygroundWorkflowStepImages {
			count = maxPlaygroundWorkflowStepImages
		}
		imageCount := uint(count)
		stepInfo.Request = &dto.ImageRequest{
			Model:   modelName,
			N:       &imageCount,
			Size:    strings.TrimSpace(step.Size),
			Quality: strings.TrimSpace(step.Quality),
		}
		stepInfo.BillingImageCount = &count
		priceData, err := helper.ModelPriceHelper(c, &stepInfo, tokens, &relaytypes.TokenCountMeta{})
		if err != nil {
			return 0, false, false
		}
		return priceData.QuotaToPreConsume, true, false
	case "video":
		priceData, err := helper.ModelPriceHelperPerCall(c, &stepInfo)
		if err != nil {
			return 0, false, true
		}
		// The task adaptor applies its usage-profile ratios (duration, size) at
		// submission, so the estimate can only show the per-call base.
		return priceData.Quota, true, true
	case "chat":
		priceData, err := helper.ModelPriceHelper(c, &stepInfo, tokens, &relaytypes.TokenCountMeta{})
		if err != nil {
			return 0, false, false
		}
		return priceData.QuotaToPreConsume, true, false
	default:
		return 0, false, false
	}
}

// PlaygroundWorkflowRunCreate opens one run budget for a workflow. The cap is
// reserved from the wallet as a parent hold, and every step of the run then
// allocates inside it (BL-03). Settling the run returns what the steps did not
// spend and charges what they spent beyond the cap.
func PlaygroundWorkflowRunCreate(c *gin.Context) {
	var request struct {
		Cap int `json:"cap"`
	}
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		writePlaygroundGenerationError(c, http.StatusBadRequest, PlaygroundWorkflowBudgetUnavailableCode, "Invalid budget request.")
		return
	}
	if err := common.ValidateWalletQuota(request.Cap); err != nil || request.Cap <= 0 {
		writePlaygroundGenerationError(c, http.StatusBadRequest, PlaygroundWorkflowBudgetUnavailableCode, "The run budget must be a positive quota amount.")
		return
	}
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	userId := c.GetInt("id")
	runId := newPlaygroundWorkflowRunId()
	hold, err := model.CreateWalletBudgetHold(userId, runId, request.Cap)
	if errors.Is(err, model.ErrWalletHoldInsufficientQuota) {
		writePlaygroundGenerationError(c, http.StatusForbidden, PlaygroundWorkflowBudgetInsufficientCode, "Insufficient wallet quota to cover this run budget.")
		return
	}
	if err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundWorkflowBudgetUnavailableCode, "Unable to open the run budget.")
		return
	}
	common.ApiSuccess(c, gin.H{
		"run_id":     hold.RequestId,
		"cap":        hold.Amount,
		"remaining":  hold.Amount,
		"spent":      0,
		"status":     hold.Status,
		"expires_at": hold.ExpiresAt,
	})
}

// PlaygroundWorkflowRunSettle settles one run budget and returns the summary.
// It is idempotent: the workspace calls it when the run stops (success,
// failure or cancellation) and a replay only reports the recorded outcome.
func PlaygroundWorkflowRunSettle(c *gin.Context) {
	runId := strings.TrimSpace(c.Param("runId"))
	userId := c.GetInt("id")
	hold, err := model.GetWalletHoldByRequestId(runId)
	if err != nil || hold == nil || hold.UserId != userId || hold.ParentId != nil {
		writePlaygroundGenerationError(c, http.StatusNotFound, PlaygroundWorkflowRunNotFoundCode, "Workflow run not found.")
		return
	}
	summary, err := model.SettleWalletBudgetRun(userId, runId)
	if err != nil {
		writePlaygroundGenerationError(c, http.StatusInternalServerError, PlaygroundWorkflowRunSettleFailedCode, "Unable to settle the run budget.")
		return
	}
	common.ApiSuccess(c, gin.H{
		"run_id":    summary.RunId,
		"cap":       summary.Cap,
		"spent":     summary.Spent,
		"remaining": summary.Remaining,
		"status":    summary.Status,
	})
}
