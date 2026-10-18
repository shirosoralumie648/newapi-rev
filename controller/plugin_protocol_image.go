package controller

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/relay"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// serveTaskPluginImageProtocol answers an OpenAI Images API request that a
// task plugin claimed. By default the API is synchronous: the durable
// submission runs first on a context that survives a client disconnect, an
// asynchronous upstream task is then polled inside the request until it is
// terminal or the protocol timeout elapses, and the plugin's render hook
// finally shapes the OpenAI image response from the terminal task. A request
// that asks for the asynchronous mode instead answers with the durable task id
// and leaves the wait and the rendering to the polling endpoint.
func serveTaskPluginImageProtocol(c *gin.Context, pinned pluginruntime.PinnedEndpoint, deps pluginProtocolBridgeDeps) {
	deps = deps.withDefaults()
	requestValue, exists := c.Get(pluginruntime.ContextKeyProtocolRequest)
	protocolRequest, ok := requestValue.(pluginruntime.ProtocolRequestContext)
	if !exists || !ok || protocolRequest.Protocol != pinned.Protocol || pinned.Plugin == nil {
		respondPluginProtocolError(c, http.StatusInternalServerError, "task_protocol_error", "Task protocol request failed")
		return
	}
	async := asyncImageTaskRequested(c, pinned, protocolRequest)
	if async {
		// The submission itself is unchanged: it is already durable and
		// settles its billing before the response. Only the in-request wait
		// and the rendered response move to the polling endpoint.
		c.Set(string(constant.ContextKeyImageTaskAsync), true)
		protocolRequest = stripAsyncImageTaskFlag(c, protocolRequest)
	}
	clientRequest := c.Request
	var relayInfo *relaycommon.RelayInfo
	var relayInfoErr error
	var outcome *taskSubmissionOutcome
	var taskErr *dto.TaskError
	// DashScope bills the images as soon as it accepts the upstream call. A
	// client that gives up while the submission is in flight must not cancel
	// that call, the task row, its settlement, or its consume log, so the
	// submission runs on its own bounded context exactly like the Responses
	// bridge. Only the in-request wait and the response write observe the
	// client connection.
	func() {
		submissionContext, cancelSubmission := context.WithTimeout(
			context.WithoutCancel(clientRequest.Context()),
			deps.submissionTimeout,
		)
		c.Request = clientRequest.Clone(submissionContext)
		defer func() {
			c.Request = clientRequest
			cancelSubmission()
		}()

		relayInfo, relayInfoErr = relaycommon.GenRelayInfo(c, types.RelayFormatTask, nil, nil)
		if relayInfoErr != nil {
			return
		}
		relayInfo.IsStream = false
		relayInfo.OriginModelName = c.GetString("resolved_task_model")
		if action := c.GetString("task_action"); action != "" {
			relayInfo.Action = action
		}
		if taskErr = relay.ResolveOriginTask(c, relayInfo); taskErr != nil {
			return
		}
		if taskErr = relay.ApplyOriginTaskAffinity(c, relayInfo); taskErr != nil {
			return
		}
		outcome, taskErr = deps.submit(c, relayInfo)
	}()
	if clientRequest.Context().Err() != nil {
		// The client is gone. A durable task keeps its settlement and consume
		// log; an asynchronous one is finished by the background poller.
		return
	}
	if relayInfoErr != nil {
		logger.LogError(c, common.LogText("build task protocol relay info failed: %s", relayInfoErr.Error()))
		respondPluginProtocolError(c, http.StatusInternalServerError, "task_protocol_error", "Task protocol request failed")
		return
	}
	if taskErr != nil {
		respondTaskPluginImageError(c, taskErr)
		return
	}
	if outcome == nil || outcome.Task == nil || outcome.Task.Platform != constant.TaskPlatform(pinned.Plugin.Meta.Key) {
		logger.LogError(c, common.LogText("task protocol submission returned an invalid durable outcome"))
		respondPluginProtocolError(c, http.StatusInternalServerError, "task_protocol_error", "Task protocol request failed")
		return
	}
	task := outcome.Task
	if async {
		presentAsyncImageTaskSubmission(c, task)
		return
	}
	if task.Status != model.TaskStatusSuccess && task.Status != model.TaskStatusFailure {
		if taskErr = waitTaskPluginImageTask(c, task, deps); taskErr != nil {
			if c.Request.Context().Err() == nil {
				respondTaskPluginImageError(c, taskErr)
			}
			return
		}
	}
	if task.Status == model.TaskStatusFailure {
		reason := strings.TrimSpace(task.FailReason)
		if reason == "" {
			reason = "image generation failed"
		}
		// The fail reason comes from the upstream, so mask the channel address in it.
		taskErr = service.TaskErrorWrapper(errors.New(reason), "image_generation_failed", http.StatusBadRequest, common.UpstreamAddresses(c)...)
		taskErr.LocalError = true
		respondTaskPluginImageError(c, taskErr)
		return
	}
	response, err := renderTaskPluginImageResponse(c, pinned, task, protocolRequest.JSValue(), deps)
	if err != nil {
		logger.LogError(c, common.LogText("render task protocol image response failed: %s", err.Error()))
		respondPluginProtocolError(c, http.StatusInternalServerError, "task_protocol_error", "Task protocol request failed")
		return
	}
	c.JSON(http.StatusOK, response)
}

// waitTaskPluginImageTask polls an asynchronous image task inside the client
// request through the ordinary task polling path, so completion settles
// billing exactly as the background poller would, until the task is terminal
// or the protocol timeout elapses. A client disconnect stops waiting; the
// background poller then finishes the durable task.
func waitTaskPluginImageTask(c *gin.Context, task *model.Task, deps pluginProtocolBridgeDeps) *dto.TaskError {
	ctx, cancel := context.WithTimeout(c.Request.Context(), deps.submissionTimeout)
	defer cancel()
	for {
		timer := time.NewTimer(deps.imagePollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			if errors.Is(ctx.Err(), context.DeadlineExceeded) && c.Request.Context().Err() == nil {
				return service.TaskErrorWrapperLocal(fmt.Errorf("image generation is still running; task %s settles when it completes", task.TaskID), "task_timeout", http.StatusGatewayTimeout)
			}
			return service.TaskErrorWrapperLocal(ctx.Err(), "request_cancelled", http.StatusRequestTimeout)
		case <-timer.C:
		}
		if err := deps.pollTask(ctx, task); err != nil {
			logger.LogWarn(c, common.LogText("task protocol image poll failed for task %s: %s", task.TaskID, common.MaskSensitiveInfo(err.Error(), common.UpstreamAddresses(c)...)))
			continue
		}
		if task.Status == model.TaskStatusSuccess || task.Status == model.TaskStatusFailure {
			return nil
		}
	}
}

// pollTaskPluginImageTask runs one poll round for a single task through the
// same code path as the scheduled task poller, including status CAS and
// completion settlement.
func pollTaskPluginImageTask(ctx context.Context, task *model.Task) error {
	upstreamID := task.GetUpstreamTaskID()
	if upstreamID == "" {
		return errors.New("task has no upstream id")
	}
	return service.UpdateVideoTasks(ctx, task.Platform, map[int][]string{task.ChannelId: {upstreamID}}, map[string]*model.Task{upstreamID: task})
}

// taskPluginImageResponseFormat reads response_format out of the protocol
// request value the render hook received, so the synchronous response and the
// polling endpoint inline Base64 under the same rule.
func taskPluginImageResponseFormat(requestValue any) string {
	request, ok := requestValue.(map[string]any)
	if !ok {
		return ""
	}
	body, ok := request["body"].(map[string]any)
	if !ok {
		return ""
	}
	switch body["kind"] {
	case string(pluginruntime.BodyJSON):
		value, _ := body["value"].(map[string]any)
		format, _ := value["response_format"].(string)
		return strings.TrimSpace(format)
	case string(pluginruntime.BodyMultipart), string(pluginruntime.BodyForm):
		fields, _ := body["fields"].(map[string][]string)
		if values := fields["response_format"]; len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
	}
	return ""
}

// respondTaskPluginImageError writes an OpenAI error envelope for the Images
// API. DashScope failure bodies arrive as JSON {code, message}; their message
// is surfaced so a client sees the vendor reason instead of raw JSON.
func respondTaskPluginImageError(c *gin.Context, taskErr *dto.TaskError) {
	service.RecordRequestPolicyTermination(c, taskSubmissionAPIError(taskErr))
	status := http.StatusInternalServerError
	if taskErr.StatusCode >= 400 && taskErr.StatusCode <= 599 {
		status = taskErr.StatusCode
	}
	code := taskErr.Code
	message := taskErr.Message
	var upstream struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if common.UnmarshalJsonStr(message, &upstream) == nil && strings.TrimSpace(upstream.Message) != "" {
		message = upstream.Message
		if strings.TrimSpace(upstream.Code) != "" {
			code = upstream.Code
		}
	}
	errorType := "new_api_error"
	if status < http.StatusInternalServerError {
		errorType = "invalid_request_error"
	}
	c.JSON(status, gin.H{"error": gin.H{
		"message": common.MessageWithRequestId(message, c.GetString(common.RequestIdKey)),
		"type":    errorType,
		"code":    code,
	}})
}

// asyncImageTaskRequested reports whether this Images request runs as a
// durable task instead of waiting for its images inside the request. The
// public endpoint asks for it with the body flag; the Playground image route
// always runs asynchronously, so a browser proxy never holds a long
// generation. Only the generate operation supports it, which is also the only
// JSON body the synchronous protocol documents.
func asyncImageTaskRequested(c *gin.Context, pinned pluginruntime.PinnedEndpoint, request pluginruntime.ProtocolRequestContext) bool {
	if pinned.Operation.Name != "generate" {
		return false
	}
	if common.GetContextKeyBool(c, constant.ContextKeyPlaygroundOrigin) {
		return true
	}
	body, ok := request.Body.(map[string]any)
	if !ok || body["kind"] != string(pluginruntime.BodyJSON) {
		return false
	}
	value, ok := body["value"].(map[string]any)
	if !ok {
		return false
	}
	flag, isBool := value["async"].(bool)
	return isBool && flag
}

// stripAsyncImageTaskFlag removes the host-level `async` flag from the
// protocol request value the host exposes to hooks: the parsed body the hooks
// share and the raw body text that backs the order-preserving decode. A later
// replay of the request (the render hook of the polling endpoint) therefore
// never sees a host flag, and the value stored with the task keeps the client
// fields alone. The submitting decode hook has already mapped the request onto
// its upstream body, which copies documented provider fields only.
func stripAsyncImageTaskFlag(c *gin.Context, request pluginruntime.ProtocolRequestContext) pluginruntime.ProtocolRequestContext {
	body, ok := request.Body.(map[string]any)
	if !ok {
		return request
	}
	value, ok := body["value"].(map[string]any)
	if !ok {
		return request
	}
	if _, present := value["async"]; !present {
		return request
	}
	delete(value, "async")
	if len(request.BodyText) > 0 {
		var raw map[string]any
		if err := common.Unmarshal(request.BodyText, &raw); err == nil {
			delete(raw, "async")
			if encoded, err := common.Marshal(raw); err == nil {
				request.BodyText = encoded
			}
		}
	}
	c.Set(pluginruntime.ContextKeyProtocolRequest, request)
	return request
}

// presentAsyncImageTaskSubmission answers an asynchronous image submission
// with the durable task id. The submission already settled its billing and
// stored its upstream task, so the client only polls from here on.
func presentAsyncImageTaskSubmission(c *gin.Context, task *model.Task) {
	c.JSON(http.StatusAccepted, gin.H{
		"success": true,
		"data": gin.H{
			"task_id":    task.TaskID,
			"status":     imageTaskPublicStatus(task.Status),
			"created_at": imageTaskCreatedAtUnix(task),
			"model":      task.Properties.OriginModelName,
		},
	})
}

// renderTaskPluginImageResponse asks the submitting plugin's render hook for
// the OpenAI image response of a terminal task. requestValue is the protocol
// request value that submitted the task: the synchronous path passes the live
// request, the polling endpoint replays the value stored with the task, so
// both surfaces answer in the same shape.
func renderTaskPluginImageResponse(c *gin.Context, pinned pluginruntime.PinnedEndpoint, task *model.Task, requestValue any, deps pluginProtocolBridgeDeps) (map[string]any, error) {
	view, err := service.BuildTaskPluginView(task)
	if err != nil {
		return nil, fmt.Errorf("build task protocol view failed: %w", err)
	}
	viewValue, err := taskPluginProtocolJSONValue(view)
	if err != nil {
		return nil, fmt.Errorf("encode task protocol view failed: %w", err)
	}
	payload, err := pinned.Plugin.Engine.CallPathWithAdmissionTimeout(c.Request.Context(), deps.admissionTimeout, "protocols", []string{pinned.Protocol, "render"}, requestValue, viewValue)
	if err != nil {
		return nil, fmt.Errorf("task protocol image render hook failed: %w", err)
	}
	response, ok := payload.(map[string]any)
	data, hasData := response["data"].([]any)
	if !ok || !hasData {
		return nil, errors.New("task protocol image render hook must return an object with a data array")
	}
	if _, present := response["created"]; !present {
		response["created"] = imageTaskCreatedAtUnix(task)
	}
	// response_format is host-owned: the plugin renders upstream URLs and the
	// host inlines each image when the client asked for Base64.
	if taskPluginImageResponseFormat(requestValue) == "b64_json" {
		for _, entry := range data {
			item, isObject := entry.(map[string]any)
			if !isObject {
				continue
			}
			url, _ := item["url"].(string)
			if existing, _ := item["b64_json"].(string); strings.TrimSpace(url) == "" || existing != "" {
				continue
			}
			_, encoded, downloadErr := deps.downloadImage(url)
			if downloadErr != nil {
				logger.LogWarn(c, common.LogText("task protocol image download failed; returning the upstream URL instead of b64_json: %s", common.MaskSensitiveInfo(downloadErr.Error(), common.UpstreamAddresses(c)...)))
				continue
			}
			item["b64_json"] = encoded
		}
	}
	return response, nil
}

// RelayImageGenerationTask answers `GET /v1/images/generations/:task_id`, the
// polling endpoint of the asynchronous image mode.
func RelayImageGenerationTask(c *gin.Context) {
	relayImageGenerationTask(c, defaultPluginProtocolBridgeDeps())
}

// relayImageGenerationTask is owner-scoped and serves only tasks of the
// Images endpoint. Billing is never touched here: the submission reserved and
// settled the task, and the task pipeline refunds a failed or timed-out task
// on its own.
func relayImageGenerationTask(c *gin.Context, deps pluginProtocolBridgeDeps) {
	deps = deps.withDefaults()
	taskID := strings.TrimSpace(c.Param("task_id"))
	if taskID == "" {
		respondImageTaskNotFound(c)
		return
	}
	task, exists, err := deps.getByTaskId(common.GetContextKeyInt(c, constant.ContextKeyUserId), taskID)
	if err != nil {
		logger.LogError(c, common.LogText("image task lookup failed: %s", err.Error()))
		respondPluginProtocolError(c, http.StatusInternalServerError, "task_protocol_error", "Task protocol request failed")
		return
	}
	if !exists || task == nil || !task.ResultRetrievable() || !imageTaskSubmittedByImagesEndpoint(task) {
		respondImageTaskNotFound(c)
		return
	}
	if task.Status != model.TaskStatusSuccess && task.Status != model.TaskStatusFailure {
		// The scheduled poller finishes every durable task anyway; asking once
		// while a client is watching keeps the answer current without
		// hammering the provider from the endpoint.
		if pollErr := pollImageTaskOnDemand(c, task, deps); pollErr != nil {
			logger.LogWarn(c, common.LogText("image task poll failed for task %s: %s", task.TaskID, common.MaskSensitiveInfo(pollErr.Error(), common.UpstreamAddresses(c)...)))
		}
	}
	data := gin.H{
		"task_id":    task.TaskID,
		"status":     imageTaskPublicStatus(task.Status),
		"progress":   task.Progress,
		"created_at": imageTaskCreatedAtUnix(task),
		"model":      task.Properties.OriginModelName,
	}
	if task.Status == model.TaskStatusSuccess || task.Status == model.TaskStatusFailure {
		data["finished_at"] = task.FinishTime
	}
	switch task.Status {
	case model.TaskStatusSuccess:
		images, renderErr := renderImageTaskImages(c, task, deps)
		if renderErr != nil {
			logger.LogError(c, common.LogText("render image task %s failed: %s", task.TaskID, renderErr.Error()))
			respondPluginProtocolError(c, http.StatusServiceUnavailable, "image_task_plugin_unavailable", "Image result plugin is unavailable")
			return
		}
		data["images"] = images
	case model.TaskStatusFailure:
		reason := strings.TrimSpace(task.FailReason)
		if reason == "" {
			reason = "image generation failed"
		}
		data["error"] = gin.H{"code": "image_generation_failed", "message": reason}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

// imageTaskOnDemandPollTimeout bounds the provider round trip of one polling
// request. A provider that needs longer is finished by the scheduled poller.
const imageTaskOnDemandPollTimeout = 30 * time.Second

// pollImageTaskOnDemand refreshes one unfinished task at most once per poll
// interval, so an actively polling client learns about completion without
// waiting for the next scheduled poller round.
func pollImageTaskOnDemand(c *gin.Context, task *model.Task, deps pluginProtocolBridgeDeps) error {
	if common.GetTimestamp()-task.UpdatedAt < int64(deps.imagePollInterval.Seconds()) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), imageTaskOnDemandPollTimeout)
	defer cancel()
	return deps.pollTask(ctx, task)
}

// renderImageTaskImages replays the submitting plugin's render hook with the
// protocol request stored at submission, so a polled result carries the same
// OpenAI image objects the synchronous response would have carried.
func renderImageTaskImages(c *gin.Context, task *model.Task, deps pluginProtocolBridgeDeps) ([]any, error) {
	plugin, generation, ok := deps.resolvePlugin(task.Platform)
	if !ok || plugin == nil {
		return nil, errors.New("task plugin is unavailable")
	}
	claimsProtocol := false
	for _, claim := range plugin.Meta.Protocols {
		if claim.Name == pluginruntime.ProtocolOpenAIImage {
			claimsProtocol = true
			break
		}
	}
	if !claimsProtocol {
		return nil, errors.New("task plugin does not claim the OpenAI Images protocol")
	}
	var requestValue any
	if len(task.PrivateData.AsyncImageRequest) > 0 {
		if err := common.Unmarshal(task.PrivateData.AsyncImageRequest, &requestValue); err != nil {
			return nil, fmt.Errorf("decode async image protocol request failed: %w", err)
		}
	}
	pinned := pluginruntime.PinnedEndpoint{
		Generation: generation,
		Plugin:     plugin,
		Protocol:   pluginruntime.ProtocolOpenAIImage,
		Model:      task.Properties.OriginModelName,
	}
	response, err := renderTaskPluginImageResponse(c, pinned, task, requestValue, deps)
	if err != nil {
		return nil, err
	}
	images, _ := response["data"].([]any)
	return images, nil
}

// imageTaskSubmittedByImagesEndpoint reports whether the task was created by
// the Images endpoint, so this endpoint never serves another protocol's task.
// Rows without an execution snapshot stay out of the polling surface.
func imageTaskSubmittedByImagesEndpoint(task *model.Task) bool {
	if task == nil || task.PrivateData.Execution == nil {
		return false
	}
	return strings.TrimSpace(task.PrivateData.Execution.RequestPath) == "/v1/images/generations"
}

// imageTaskPublicStatus maps a durable task status to the stable lowercase
// status of the asynchronous Images API.
func imageTaskPublicStatus(status model.TaskStatus) string {
	switch status {
	case model.TaskStatusNotStart, model.TaskStatusSubmitted:
		return "submitted"
	case model.TaskStatusQueued:
		return "queued"
	case model.TaskStatusSuccess:
		return "succeeded"
	case model.TaskStatusFailure:
		return "failed"
	default:
		return "in_progress"
	}
}

func imageTaskCreatedAtUnix(task *model.Task) int64 {
	if task.CreatedAt != 0 {
		return task.CreatedAt
	}
	return task.SubmitTime
}

func respondImageTaskNotFound(c *gin.Context) {
	respondPluginProtocolError(c, http.StatusNotFound, "image_task_not_found", "Image generation task not found")
}
