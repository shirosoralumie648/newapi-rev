package service

import (
	"bytes"
	"context"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/playground_setting"

	"github.com/gin-gonic/gin"
)

const (
	// playgroundLogCaptureCleanupEvery and playgroundLogCaptureCleanupBatch
	// bound the scheduled collection of summaries whose window elapsed.
	playgroundLogCaptureCleanupEvery = 6 * time.Hour
	playgroundLogCaptureCleanupBatch = 200
	// playgroundLogCaptureTextReadLimit bounds how much raw text the scrubber
	// ever inspects, so a pathological message cannot make the capture walk a
	// multi-megabyte string with regular expressions.
	playgroundLogCaptureTextReadLimit = 4 << 20
)

// playgroundLogCaptureSecretPatterns redact credential-looking strings that a
// user may have pasted into a conversation. The capture never stores what it
// matches; the surrounding text stays readable.
var playgroundLogCaptureSecretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}`),
	regexp.MustCompile(`\bxox[baprs]-[A-Za-z0-9-]{10,}`),
}

// playgroundLogCaptureRequest is the credential-free subset of a Playground
// chat request the capture may retain. Every other field the body carried,
// including provider-specific keys, is dropped before storage.
type playgroundLogCaptureRequest struct {
	Model               string                        `json:"model"`
	Group               string                        `json:"group"`
	Stream              *bool                         `json:"stream"`
	Messages            []playgroundLogCaptureMessage `json:"messages"`
	Temperature         *float64                      `json:"temperature"`
	TopP                *float64                      `json:"top_p"`
	MaxTokens           *int                          `json:"max_tokens"`
	MaxCompletionTokens *int                          `json:"max_completion_tokens"`
	FrequencyPenalty    *float64                      `json:"frequency_penalty"`
	PresencePenalty     *float64                      `json:"presence_penalty"`
	Seed                *int                          `json:"seed"`
	ReasoningEffort     string                        `json:"reasoning_effort"`
}

type playgroundLogCaptureMessage struct {
	Role       string                         `json:"role"`
	Content    any                            `json:"content"`
	Name       string                         `json:"name"`
	ToolCallId string                         `json:"tool_call_id"`
	ToolCalls  []playgroundLogCaptureToolCall `json:"tool_calls"`
}

type playgroundLogCaptureToolCall struct {
	Id       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name string `json:"name"`
	} `json:"function"`
}

// The stored documents below are the on-disk schema of a summary. They only
// ever contain scrubbed, truncated values.
type playgroundLogCaptureStoredSummary struct {
	Model        string                              `json:"model,omitempty"`
	Group        string                              `json:"group,omitempty"`
	Stream       *bool                               `json:"stream,omitempty"`
	Sampling     *playgroundLogCaptureStoredSampling `json:"sampling,omitempty"`
	MessageCount int                                 `json:"message_count"`
	Messages     []playgroundLogCaptureStoredMessage `json:"messages,omitempty"`
	Truncated    bool                                `json:"truncated,omitempty"`
}

type playgroundLogCaptureStoredSampling struct {
	Temperature      *float64 `json:"temperature,omitempty"`
	TopP             *float64 `json:"top_p,omitempty"`
	MaxTokens        *int     `json:"max_tokens,omitempty"`
	FrequencyPenalty *float64 `json:"frequency_penalty,omitempty"`
	PresencePenalty  *float64 `json:"presence_penalty,omitempty"`
	Seed             *int     `json:"seed,omitempty"`
	ReasoningEffort  string   `json:"reasoning_effort,omitempty"`
}

type playgroundLogCaptureStoredMessage struct {
	Role          string   `json:"role"`
	Content       string   `json:"content,omitempty"`
	Name          string   `json:"name,omitempty"`
	ToolCallId    string   `json:"tool_call_id,omitempty"`
	ToolCallNames []string `json:"tool_calls,omitempty"`
	// Attachments counts the binary parts (images, audio) whose payload was
	// replaced by the count; the bytes themselves are never stored.
	Attachments int  `json:"attachments,omitempty"`
	Truncated   bool `json:"truncated,omitempty"`
}

type playgroundLogCaptureStoredResponse struct {
	Status       int                        `json:"status"`
	Content      string                     `json:"content,omitempty"`
	FinishReason string                     `json:"finish_reason,omitempty"`
	Model        string                     `json:"model,omitempty"`
	Usage        *playgroundLogCaptureUsage `json:"usage,omitempty"`
	Truncated    bool                       `json:"truncated,omitempty"`
}

type playgroundLogCaptureUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type playgroundLogCaptureCompletionFrame struct {
	Model   string `json:"model"`
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		Message struct {
			Content any `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *playgroundLogCaptureUsage `json:"usage"`
}

// PlaygroundLogCaptureSession tees one Playground chat response into a bounded
// buffer and, when the request ends, persists the desensitized request and
// response summaries. It exists only while PLAYGROUND_LOG_CAPTURE is on.
type PlaygroundLogCaptureSession struct {
	userId           int
	requestId        string
	model            string
	group            string
	isStream         bool
	maxBytes         int
	requestSummary   string
	requestTruncated bool
	writer           *playgroundLogCaptureWriter
	previous         gin.ResponseWriter
}

// BeginPlaygroundLogCapture parses the request body of a Playground chat call
// into a replay summary. It returns nil when the optional retention switch is
// off, the body is unreadable, or the request carries no request id to key the
// summary by; a disabled switch never retains anything.
func BeginPlaygroundLogCapture(c *gin.Context) *PlaygroundLogCaptureSession {
	if !playground_setting.PlaygroundLogCaptureEnabled() {
		return nil
	}
	userId := c.GetInt("id")
	requestId := c.GetString(common.RequestIdKey)
	if userId <= 0 || requestId == "" {
		return nil
	}
	var payload playgroundLogCaptureRequest
	if err := common.UnmarshalBodyReusable(c, &payload); err != nil {
		return nil
	}
	maxBytes := playground_setting.PlaygroundLogCaptureMaxBytes()
	summary, truncated := buildPlaygroundLogCaptureRequestSummary(&payload, maxBytes)
	if summary == "" {
		return nil
	}
	return &PlaygroundLogCaptureSession{
		userId:           userId,
		requestId:        requestId,
		model:            payload.Model,
		group:            payload.Group,
		isStream:         payload.Stream != nil && *payload.Stream,
		maxBytes:         maxBytes,
		requestSummary:   summary,
		requestTruncated: truncated,
	}
}

// TeeResponse replaces the response writer so the bytes the relay already
// sends stay untouched while a bounded prefix is buffered for the summary.
func (s *PlaygroundLogCaptureSession) TeeResponse(c *gin.Context) {
	if s == nil {
		return
	}
	s.previous = c.Writer
	s.writer = &playgroundLogCaptureWriter{ResponseWriter: c.Writer, limit: s.maxBytes}
	c.Writer = s.writer
}

// Finish restores the response writer and stores the summaries. It runs in a
// defer after the relay returned, so it observes the final status and headers.
func (s *PlaygroundLogCaptureSession) Finish(c *gin.Context) {
	if s == nil {
		return
	}
	if s.previous != nil {
		c.Writer = s.previous
	}
	status := c.Writer.Status()
	contentType := c.Writer.Header().Get("Content-Type")
	var body []byte
	overflow := false
	if s.writer != nil {
		body = s.writer.buffer.Bytes()
		overflow = s.writer.overflow
	}
	responseSummary, responseTruncated := buildPlaygroundLogCaptureResponseSummary(body, contentType, status, s.maxBytes)
	if responseSummary == "" {
		responseSummary = "{}"
	}
	now := common.GetTimestamp()
	record := &model.PlaygroundLogCapture{
		UserId:          s.userId,
		RequestId:       s.requestId,
		ModelName:       s.model,
		Group:           s.group,
		IsStream:        s.isStream,
		StatusCode:      status,
		RequestSummary:  s.requestSummary,
		ResponseSummary: responseSummary,
		SummaryBytes:    len(s.requestSummary) + len(responseSummary),
		Truncated:       s.requestTruncated || responseTruncated || overflow,
		CreatedAt:       now,
		ExpiresAt:       now + playground_setting.PlaygroundLogCaptureTTLSeconds(),
	}
	if err := model.SavePlaygroundLogCapture(record); err != nil {
		logger.LogError(c, common.LogText("failed to store playground log capture: %s", err.Error()))
	}
}

// playgroundLogCaptureWriter buffers a bounded prefix of every response write
// and lets the rest of the writer's contract pass through unchanged, so
// streaming keeps flushing exactly as before.
type playgroundLogCaptureWriter struct {
	gin.ResponseWriter
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func (w *playgroundLogCaptureWriter) Write(data []byte) (int, error) {
	w.capture(data)
	return w.ResponseWriter.Write(data)
}

func (w *playgroundLogCaptureWriter) WriteString(value string) (int, error) {
	w.capture([]byte(value))
	return w.ResponseWriter.WriteString(value)
}

func (w *playgroundLogCaptureWriter) capture(data []byte) {
	if w.overflow || w.limit <= 0 {
		return
	}
	remaining := w.limit - w.buffer.Len()
	if remaining <= 0 {
		w.overflow = true
		return
	}
	if len(data) > remaining {
		w.buffer.Write(data[:remaining])
		w.overflow = true
		return
	}
	w.buffer.Write(data)
}

// scrubPlaygroundLogText removes credential-looking substrings, so a key a
// user pasted into a prompt is not retained even while the capture is on.
func scrubPlaygroundLogText(text string) string {
	for _, pattern := range playgroundLogCaptureSecretPatterns {
		text = pattern.ReplaceAllString(text, "[redacted]")
	}
	return strings.ReplaceAll(text, "\x00", "")
}

// truncatePlaygroundLogText cuts text to at most limit bytes without splitting
// a UTF-8 rune.
func truncatePlaygroundLogText(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

func playgroundLogCaptureText(value string) (string, bool) {
	truncated := false
	if len(value) > playgroundLogCaptureTextReadLimit {
		value = truncatePlaygroundLogText(value, playgroundLogCaptureTextReadLimit)
		truncated = true
	}
	return scrubPlaygroundLogText(value), truncated
}

// playgroundLogCaptureContentText flattens one message content value. Text
// parts are joined; binary parts count as attachments and are dropped, so no
// data URL, file id, or attachment address is ever stored.
func playgroundLogCaptureContentText(content any) (string, int, bool) {
	switch typed := content.(type) {
	case nil:
		return "", 0, false
	case string:
		text, truncated := playgroundLogCaptureText(typed)
		return text, 0, truncated
	case []any:
		var parts []string
		attachments := 0
		truncated := false
		for _, rawPart := range typed {
			part, ok := rawPart.(map[string]any)
			if !ok {
				attachments++
				continue
			}
			partType, _ := part["type"].(string)
			if partType == "text" {
				if text, ok := part["text"].(string); ok {
					partText, partTruncated := playgroundLogCaptureText(text)
					truncated = truncated || partTruncated
					parts = append(parts, partText)
				}
				continue
			}
			attachments++
		}
		return strings.Join(parts, "\n"), attachments, truncated
	default:
		return "", 1, false
	}
}

func buildPlaygroundLogCaptureRequestSummary(payload *playgroundLogCaptureRequest, maxBytes int) (string, bool) {
	if payload == nil {
		return "", false
	}
	stored := playgroundLogCaptureStoredSummary{
		Model:        payload.Model,
		Group:        payload.Group,
		Stream:       payload.Stream,
		Sampling:     playgroundLogCaptureSampling(payload),
		MessageCount: len(payload.Messages),
	}
	truncated := false
	for _, message := range payload.Messages {
		content, attachments, messageTruncated := playgroundLogCaptureContentText(message.Content)
		if len(content) > maxBytes {
			content = truncatePlaygroundLogText(content, maxBytes)
			messageTruncated = true
		}
		storedMessage := playgroundLogCaptureStoredMessage{
			Role:        message.Role,
			Content:     content,
			Name:        message.Name,
			ToolCallId:  message.ToolCallId,
			Attachments: attachments,
			Truncated:   messageTruncated,
		}
		for _, toolCall := range message.ToolCalls {
			// Only the called function name is retained: tool arguments can
			// carry credentials and are never stored.
			if toolCall.Function.Name != "" {
				storedMessage.ToolCallNames = append(storedMessage.ToolCallNames, toolCall.Function.Name)
			}
		}
		truncated = truncated || storedMessage.Truncated
		stored.Messages = append(stored.Messages, storedMessage)
	}
	return fitPlaygroundLogCaptureSummary(&stored, maxBytes, truncated)
}

func playgroundLogCaptureSampling(payload *playgroundLogCaptureRequest) *playgroundLogCaptureStoredSampling {
	maxTokens := payload.MaxTokens
	if maxTokens == nil {
		maxTokens = payload.MaxCompletionTokens
	}
	sampling := &playgroundLogCaptureStoredSampling{
		Temperature:      payload.Temperature,
		TopP:             payload.TopP,
		MaxTokens:        maxTokens,
		FrequencyPenalty: payload.FrequencyPenalty,
		PresencePenalty:  payload.PresencePenalty,
		Seed:             payload.Seed,
		ReasoningEffort:  payload.ReasoningEffort,
	}
	if *sampling == (playgroundLogCaptureStoredSampling{}) {
		return nil
	}
	return sampling
}

// fitPlaygroundLogCaptureSummary shrinks a summary until its serialized form
// fits the byte budget: oldest messages are dropped first, then the remaining
// text is halved. Every step is deterministic and leaves valid JSON behind.
func fitPlaygroundLogCaptureSummary(stored *playgroundLogCaptureStoredSummary, maxBytes int, truncated bool) (string, bool) {
	for {
		raw, err := common.Marshal(stored)
		if err == nil && len(raw) <= maxBytes {
			return string(raw), truncated
		}
		if len(stored.Messages) > 1 {
			stored.Messages = stored.Messages[1:]
			stored.Truncated = true
			truncated = true
			continue
		}
		if len(stored.Messages) == 1 {
			message := &stored.Messages[0]
			switch {
			case message.Content != "":
				message.Content = truncatePlaygroundLogText(message.Content, len(message.Content)/2)
			case len(message.ToolCallNames) > 0:
				message.ToolCallNames = message.ToolCallNames[:len(message.ToolCallNames)/2]
			case message.Attachments != 0:
				message.Attachments = 0
			default:
				stored.Messages = nil
			}
			message.Truncated = true
			truncated = true
			continue
		}
		// Only the metadata remains; it always fits the minimum budget.
		raw, err = common.Marshal(stored)
		if err != nil {
			return "", true
		}
		stored.Truncated = true
		if len(raw) <= maxBytes {
			return string(raw), true
		}
		return "", true
	}
}

func buildPlaygroundLogCaptureResponseSummary(body []byte, contentType string, status int, maxBytes int) (string, bool) {
	stored := playgroundLogCaptureStoredResponse{Status: status}
	if status < 200 || status >= 300 {
		raw, err := common.Marshal(&stored)
		if err != nil {
			return "", false
		}
		return string(raw), false
	}
	truncated := false
	var content strings.Builder
	frames := [][]byte{body}
	if strings.Contains(contentType, "text/event-stream") {
		frames = nil
		for line := range strings.SplitSeq(string(body), "\n") {
			payload, ok := strings.CutPrefix(strings.TrimSuffix(line, "\r"), "data:")
			if !ok {
				continue
			}
			payload = strings.TrimSpace(payload)
			if payload == "" || payload == "[DONE]" {
				continue
			}
			frames = append(frames, []byte(payload))
		}
	}
	for _, frame := range frames {
		var parsed playgroundLogCaptureCompletionFrame
		if err := common.Unmarshal(frame, &parsed); err != nil {
			// A prefix cut in the middle of a stream frame is dropped; every
			// complete frame before it was already accumulated.
			truncated = true
			continue
		}
		if parsed.Model != "" {
			stored.Model = parsed.Model
		}
		if parsed.Usage != nil {
			stored.Usage = parsed.Usage
		}
		for _, choice := range parsed.Choices {
			if choice.Delta.Content != "" {
				content.WriteString(choice.Delta.Content)
			}
			if text, _, choiceTruncated := playgroundLogCaptureContentText(choice.Message.Content); text != "" || choiceTruncated {
				content.WriteString(text)
			}
			if choice.FinishReason != "" {
				stored.FinishReason = choice.FinishReason
			}
		}
	}
	text, textTruncated := playgroundLogCaptureText(content.String())
	truncated = truncated || textTruncated
	if len(text) > maxBytes {
		text = truncatePlaygroundLogText(text, maxBytes)
		truncated = true
	}
	stored.Content = text
	for {
		raw, err := common.Marshal(&stored)
		if err != nil {
			return "", truncated
		}
		if len(raw) <= maxBytes {
			return string(raw), truncated
		}
		if stored.Usage != nil {
			stored.Usage = nil
			truncated = true
			continue
		}
		if stored.Content != "" {
			stored.Content = truncatePlaygroundLogText(stored.Content, len(stored.Content)/2)
			truncated = true
			continue
		}
		stored.Truncated = true
		raw, err = common.Marshal(&stored)
		if err != nil {
			return "", true
		}
		if len(raw) <= maxBytes {
			return string(raw), true
		}
		return "", true
	}
}

// playgroundLogCaptureCleanupHandler collects retained summaries whose
// retention window elapsed. It keeps running while the capture switch is off,
// so rows stored before the switch was turned off still leave on schedule.
type playgroundLogCaptureCleanupHandler struct{}

func (playgroundLogCaptureCleanupHandler) Type() string {
	return model.SystemTaskTypePlaygroundLogCaptureCleanup
}

func (playgroundLogCaptureCleanupHandler) Enabled() bool { return true }

func (playgroundLogCaptureCleanupHandler) Interval() time.Duration {
	return playgroundLogCaptureCleanupEvery
}

func (playgroundLogCaptureCleanupHandler) NewPayload() any { return nil }

func (playgroundLogCaptureCleanupHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	deleted, err := model.DeleteExpiredPlaygroundLogCaptures(common.GetTimestamp(), playgroundLogCaptureCleanupBatch)
	if err != nil {
		failSystemTask(task, runnerID, err)
		return
	}
	if err := model.FinishSystemTask(task.TaskID, runnerID, model.SystemTaskStatusSucceeded, map[string]any{"deleted_count": deleted}, ""); err != nil {
		logSystemTaskLockError(ctx, task, err)
	}
}

func init() {
	RegisterSystemTaskHandler(playgroundLogCaptureCleanupHandler{})
}
