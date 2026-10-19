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
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/gin-gonic/gin"
)

const (
	// playgroundMessageRequestIdMaxLength matches the logs.request_id column,
	// so a stored id can always be looked up in the consume log.
	playgroundMessageRequestIdMaxLength = 64
	// playgroundMessageTokenMax is a sanity ceiling for the display-only token
	// counts a client may attach to one version, not a billing limit.
	playgroundMessageTokenMax = 1 << 40
	// playgroundMessageModelMaxLength mirrors the model name bound of the
	// conversation config; every compared version names the model that produced
	// it.
	playgroundMessageModelMaxLength = 512
	// playgroundMessageFinishReasonMaxLength bounds the provider finish reason
	// a version may record. It labels the stored message only; the value is
	// opaque text and never consulted for billing.
	playgroundMessageFinishReasonMaxLength = 64
	// playgroundMessageErrorCodeMaxLength bounds the stable error code a failed
	// version of a parallel comparison may carry.
	playgroundMessageErrorCodeMaxLength = 500
	// playgroundMessageSearch* bound the web-search snapshot a user message
	// keeps for replay. The shape mirrors the normalized search response; the
	// stored snapshot is context data, never a billing record.
	playgroundMessageSearchMaxQueryRunes      = 512
	playgroundMessageSearchMaxResults         = 6
	playgroundMessageSearchMaxTitleBytes      = 300
	playgroundMessageSearchMaxSnippetBytes    = 1200
	playgroundMessageSearchMaxURLBytes        = 4096
	playgroundMessageSearchMaxProviderBytes   = 32
	playgroundMessageSearchMaxResultListBytes = 24 << 10
	// playgroundMessageKnowledge* bound the retrieval snapshot of one user
	// turn. The merged server response already caps hits and text, but the
	// stored payload is still validated because clients can write it.
	playgroundMessageKnowledgeMaxQueryRunes      = 8_000
	playgroundMessageKnowledgeMaxResults         = 12
	playgroundMessageKnowledgeMaxIDBytes         = 200
	playgroundMessageKnowledgeMaxBaseNameBytes   = 200
	playgroundMessageKnowledgeMaxFilenameBytes   = 255
	playgroundMessageKnowledgeMaxChunkTextBytes  = 32 << 10
	playgroundMessageKnowledgeMaxResultListBytes = 64 << 10
	playgroundSessionKnowledgeBaseMax            = 3
	playgroundSessionKnowledgeBaseIDMaxBytes     = 128
	// playgroundParallelMinVersions is the smallest group that actually
	// compares models: a single reply already has the ordinary message path.
	playgroundParallelMinVersions = 2
	// playgroundContextHistoryLimitMax and playgroundContextTokenBudgetMax bound
	// the caller-supplied context management settings. They are request-shape
	// limits, not resource quotas: staying inside them never changes what the
	// model receives beyond the caller's own configuration.
	playgroundContextHistoryLimitMax = 1000
	playgroundContextTokenBudgetMax  = 2_000_000
	// playgroundContextSummaryModelMaxLength mirrors the model name bound of
	// the conversation config.
	playgroundContextSummaryModelMaxLength = 512
	// playgroundContextSummaryMessageCountMax bounds the display-only count of
	// messages one compression node reports it replaces.
	playgroundContextSummaryMessageCountMax = 1_000_000
	// playgroundContextSummaryMaxBytes bounds the stored summary text. A longer
	// summary is rejected instead of truncated so the stored node always
	// matches what the model produced.
	playgroundContextSummaryMaxBytes = 32 << 10
	// Developer options bounds: request-shape limits the client mirrors, not
	// resource quotas. They only bound what a stored conversation may inject
	// into its next request.
	playgroundDeveloperOptionsMaxBytes         = 256 << 10
	playgroundDeveloperToolMaxCount            = 32
	playgroundDeveloperSchemaMaxBytes          = 64 << 10
	playgroundDeveloperNameMaxLength           = 64
	playgroundDeveloperDescriptionMaxBytes     = 1024
	playgroundDeveloperJSONSchemaNameMaxLength = 64
	// Conversation tags are a compact client-side organizing aid: a bounded
	// number of short labels stored as one JSON array.
	playgroundSessionTagMaxCount  = 10
	playgroundSessionTagMaxLength = 24
)

// playgroundReasoningEffortValues lists the effort strings the relay accepts
// for `reasoning_effort` (relaykit/relayconvert/reasoning.ParseEffort), plus
// the empty value stored while the parameter stays unset. The conversion
// rejects any other value, so a stored configuration only ever carries one a
// request can send.
var playgroundReasoningEffortValues = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

// playgroundDeveloperToolChoiceValues and playgroundDeveloperResponseFormatTypes
// list the accepted developer-settings enums. They mirror the OpenAI wire shape
// the client injects unchanged into a relay request.
var playgroundDeveloperToolChoiceValues = []string{"auto", "none", "required"}
var playgroundDeveloperResponseFormatTypes = []string{"text", "json_object", "json_schema"}

type playgroundSessionRequest struct {
	Title            *string         `json:"title"`
	ClientID         string          `json:"client_id"`
	Config           map[string]any  `json:"config"`
	ParameterEnabled map[string]bool `json:"parameter_enabled"`
	SystemPrompt     *string         `json:"system_prompt"`
	OpeningMessage   *string         `json:"opening_message"`
	// SuggestedQuestions is a pointer so an update can distinguish "keep the
	// stored questions" from an explicit empty list that clears them.
	SuggestedQuestions *[]string `json:"suggested_questions"`
	// KnowledgeBaseIDs binds up to three owner-scoped bases to the
	// conversation. A second pointer level is unnecessary because an empty
	// list explicitly clears the binding.
	KnowledgeBaseIDs *[]string       `json:"knowledge_base_ids"`
	Context          json.RawMessage `json:"context"`
	ContextSummary   json.RawMessage `json:"context_summary"`
	// DeveloperOptions is the complete request-side developer settings object
	// (enabled flag, function tools, response format). An explicit null clears
	// the stored value; an absent field keeps it.
	DeveloperOptions json.RawMessage `json:"developer_options"`
	// Pinned and Archived are explicit state switches: absent keeps the stored
	// value, while a boolean sets it. Tags is the complete replacement list.
	Pinned   *bool                    `json:"pinned"`
	Archived *bool                    `json:"archived"`
	Tags     *[]string                `json:"tags"`
	Revision *int64                   `json:"revision"`
	Messages []playgroundMessageInput `json:"messages"`
}

type playgroundSessionResponse struct {
	Created            bool            `json:"created,omitempty"`
	ID                 string          `json:"id"`
	ClientID           *string         `json:"client_id,omitempty"`
	Title              string          `json:"title"`
	Config             map[string]any  `json:"config"`
	ParameterEnabled   map[string]bool `json:"parameter_enabled"`
	SystemPrompt       string          `json:"system_prompt"`
	OpeningMessage     string          `json:"opening_message"`
	SuggestedQuestions []string        `json:"suggested_questions"`
	KnowledgeBaseIDs   []string        `json:"knowledge_base_ids"`
	// Context is the conversation's context management settings; an absent or
	// legacy NULL column reads back as an empty object and the client picks
	// its defaults. ContextSummary is the persisted compression node or null.
	Context        map[string]any  `json:"context"`
	ContextSummary json.RawMessage `json:"context_summary"`
	// DeveloperOptions is the conversation's stored request-side developer
	// settings — enabled switch, function tool definitions and response
	// format — or an empty object when the conversation never stored any.
	// The client turns the empty object into its disabled defaults.
	DeveloperOptions map[string]any `json:"developer_options"`
	PinnedAt         int64          `json:"pinned_at"`
	ArchivedAt       int64          `json:"archived_at"`
	Pinned           bool           `json:"pinned"`
	Archived         bool           `json:"archived"`
	Tags             []string       `json:"tags"`
	Revision         int64          `json:"revision"`
	MessageRevision  int64          `json:"message_revision"`
	CreatedAt        int64          `json:"created_at"`
	UpdatedAt        int64          `json:"updated_at"`
}

type playgroundMessageInput struct {
	ClientKey string          `json:"client_key"`
	Payload   json.RawMessage `json:"payload"`
}

type playgroundMessagesRequest struct {
	Revision *int64                    `json:"revision"`
	Messages *[]playgroundMessageInput `json:"messages"`
}

// playgroundMessageDeltaRequest is one incremental message write. Upserts carry
// the messages the client added or changed, deletes the client keys it removed;
// at least one of them must be present.
type playgroundMessageDeltaRequest struct {
	Revision *int64                    `json:"revision"`
	Upserts  *[]playgroundMessageInput `json:"upserts"`
	Deletes  *[]string                 `json:"deletes"`
}

type playgroundMessagePayload struct {
	Key  string `json:"key"`
	From string `json:"from"`
	// Parallel marks an assistant message group that compares models: every
	// version holds one reply and names the model that produced it. The group
	// is stored as one message so the conversation can keep every compared
	// reply and continue from the one the user selects.
	Parallel *bool `json:"parallel,omitempty"`
	Versions []struct {
		ID      string `json:"id"`
		Content string `json:"content"`
		// Model is the model that produced this version. It is required on
		// every version of a parallel group and optional elsewhere.
		Model *string `json:"model,omitempty"`
		// Status and ErrorCode describe one version of a parallel group while
		// it waits for its request or after that request failed; an absent
		// status means the version settled normally.
		Status      string                        `json:"status,omitempty"`
		ErrorCode   *string                       `json:"errorCode,omitempty"`
		Attachments []playgroundMessageAttachment `json:"attachments,omitempty"`
		// Speech references the cached read-aloud audio of this version. The
		// bytes are an owned conversation attachment; only the reference is
		// stored on the message, exactly like an attachment reference.
		Speech    *playgroundMessageAttachment `json:"speech,omitempty"`
		ToolCalls []playgroundMessageToolCall  `json:"toolCalls,omitempty"`
		// RequestId and Usage are the display-only record of the generation
		// that produced this version: the relay request id plus the token
		// usage it reported. Neither feeds billing; the settled consume log
		// remains the only source of the billed amount.
		RequestId *string                 `json:"requestId,omitempty"`
		Usage     *playgroundMessageUsage `json:"usage,omitempty"`
		// FinishReason records why a generation ended (for example `length`
		// or `interrupted`). It only labels the stored version so a truncated
		// reply can offer "continue generation"; it never feeds billing.
		FinishReason *string `json:"finishReason,omitempty"`
	} `json:"versions"`
	ActiveVersionIndex *int     `json:"activeVersionIndex,omitempty"`
	CreatedAt          *float64 `json:"createdAt,omitempty"`
	StartedAt          *float64 `json:"startedAt,omitempty"`
	CompletedAt        *float64 `json:"completedAt,omitempty"`
	DurationMs         *float64 `json:"durationMs,omitempty"`
	Sources            []struct {
		Href  string `json:"href"`
		Title string `json:"title"`
	} `json:"sources,omitempty"`
	// Search is the web-search snapshot of one user turn: the query the user
	// searched with and the normalized results that were injected into the
	// request. Persisting it lets a replay rebuild the exact same prompt and
	// lets the assistant reply show its citations after a reload. The provider
	// name labels the snapshot; no credential or raw payload is stored.
	Search *playgroundMessageSearch `json:"search,omitempty"`
	// Knowledge is the retrieval snapshot of one user turn: the merged hits
	// injected into the request. The assistant reply derives its [n] citation
	// list from the preceding user message, so citations survive a reload
	// without duplicating chunk text on every version.
	Knowledge *playgroundMessageKnowledge `json:"knowledge,omitempty"`
	Reasoning *struct {
		Content     string   `json:"content"`
		Duration    float64  `json:"duration"`
		StartedAt   *float64 `json:"startedAt,omitempty"`
		CompletedAt *float64 `json:"completedAt,omitempty"`
		DurationMs  *float64 `json:"durationMs,omitempty"`
	} `json:"reasoning,omitempty"`
	IsReasoningStreaming *bool   `json:"isReasoningStreaming,omitempty"`
	IsReasoningComplete  *bool   `json:"isReasoningComplete,omitempty"`
	IsContentComplete    *bool   `json:"isContentComplete,omitempty"`
	Status               string  `json:"status,omitempty"`
	ErrorCode            *string `json:"errorCode,omitempty"`
}

// playgroundMessageSearch is the stored web-search snapshot of one user turn.
type playgroundMessageSearch struct {
	Query    string                          `json:"query"`
	Provider string                          `json:"provider,omitempty"`
	Results  []playgroundMessageSearchResult `json:"results"`
}

// playgroundMessageSearchResult is one normalized hit the turn injected.
type playgroundMessageSearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

// playgroundMessageKnowledge is the stored retrieval snapshot of one user
// turn. Results are ordered: the assistant cites the first hit as [1].
type playgroundMessageKnowledge struct {
	Query   string                             `json:"query"`
	Results []playgroundMessageKnowledgeResult `json:"results"`
}

// playgroundMessageKnowledgeResult is one merged knowledge chunk.
type playgroundMessageKnowledgeResult struct {
	KnowledgeBaseID   string  `json:"knowledge_base_id"`
	KnowledgeBaseName string  `json:"knowledge_base_name"`
	DocumentID        string  `json:"document_id"`
	Filename          string  `json:"filename"`
	ChunkID           string  `json:"chunk_id"`
	ChunkIndex        int     `json:"chunk_index"`
	Score             float64 `json:"score"`
	Text              string  `json:"text"`
	Truncated         *bool   `json:"truncated,omitempty"`
}

// playgroundMessageToolCall is one requested tool call plus the result the user
// provided manually. The gateway never executes a tool: the recorded request
// and the user's answer are only relayed to the model as `tool_calls` and
// `tool` messages. Optional fields use pointers so an absent value keeps its
// exact JSON shape on the round trip.
type playgroundMessageToolCall struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Arguments    string   `json:"arguments"`
	Status       string   `json:"status"`
	Result       *string  `json:"result,omitempty"`
	ErrorMessage *string  `json:"errorMessage,omitempty"`
	CreatedAt    *float64 `json:"createdAt,omitempty"`
	CompletedAt  *float64 `json:"completedAt,omitempty"`
}

// playgroundMessageUsage is the token usage a client recorded when a version
// finished generating. It only labels the stored message; the billed amount
// always comes from the settled consume log the request id points at.
type playgroundMessageUsage struct {
	PromptTokens     *float64 `json:"promptTokens,omitempty"`
	CompletionTokens *float64 `json:"completionTokens,omitempty"`
	TotalTokens      *float64 `json:"totalTokens,omitempty"`
}

// playgroundContextSummary is the persisted compression node: the summary that
// replaces the messages up to (and including) `through_message_key` in every
// request. The content is produced by an ordinary billed relay call the client
// makes through /pg; the server only validates and stores it. The usage record
// labels the summarization call exactly like a message version does.
type playgroundContextSummary struct {
	ID                string                  `json:"id"`
	Content           string                  `json:"content"`
	ThroughMessageKey string                  `json:"through_message_key"`
	MessageCount      *int                    `json:"message_count,omitempty"`
	Model             string                  `json:"model"`
	CreatedAt         *float64                `json:"created_at,omitempty"`
	RequestID         *string                 `json:"request_id,omitempty"`
	Usage             *playgroundMessageUsage `json:"usage,omitempty"`
}

type playgroundMessageResponse struct {
	ClientKey string          `json:"client_key"`
	Payload   json.RawMessage `json:"payload"`
}

// playgroundMessageAttachment is the stored reference to an attachment. Only
// the ID is read from clients; the remaining fields are always rewritten from
// the owned attachment row during validation.
type playgroundMessageAttachment struct {
	ID        string `json:"id"`
	MediaType string `json:"media_type,omitempty"`
	Filename  string `json:"filename,omitempty"`
	ByteSize  int64  `json:"byte_size,omitempty"`
}

// playgroundStrictPage parses the p/page_size aliases without clamping: a
// malformed or out-of-range value is rejected instead of silently truncated.
func playgroundStrictPage(c *gin.Context) (*common.PageInfo, bool) {
	for _, key := range []string{"p", "page_size", "ps", "size"} {
		if values, ok := c.GetQueryArray(key); ok {
			if len(values) != 1 {
				return nil, false
			}
			value, err := strconv.Atoi(values[0])
			limit := 50
			if key == "p" {
				limit = 1000000
			}
			if err != nil || value < 1 || value > limit {
				return nil, false
			}
		}
	}
	page := common.GetPageQuery(c)
	if page.PageSize < 1 || page.PageSize > 50 {
		return nil, false
	}
	return page, true
}

// writePlaygroundError maps the stable Playground errors onto their HTTP
// status, public code and user-facing message.
func writePlaygroundError(c *gin.Context, err error) {
	status, code := http.StatusBadRequest, "PLAYGROUND_INVALID_REQUEST"
	var message *common.Message
	if !errors.As(err, &message) {
		status = http.StatusInternalServerError
		code = "PLAYGROUND_STORAGE_ERROR"
	}
	if errors.Is(err, model.ErrPlaygroundSessionNotFound) {
		status = http.StatusNotFound
		code = "PLAYGROUND_NOT_FOUND"
		err = common.NewMessage("Playground conversation not found.")
	}
	if errors.Is(err, model.ErrPlaygroundPresetNotFound) {
		status = http.StatusNotFound
		code = "PLAYGROUND_NOT_FOUND"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundCanvasTemplateNotFound) {
		status = http.StatusNotFound
		code = "PLAYGROUND_NOT_FOUND"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundCanvasTemplateInvalid) {
		status = http.StatusBadRequest
		code = "PLAYGROUND_INVALID_REQUEST"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundSnippetNotFound) {
		status = http.StatusNotFound
		code = "PLAYGROUND_NOT_FOUND"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundSnippetVersionNotFound) {
		status = http.StatusNotFound
		code = "PLAYGROUND_NOT_FOUND"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundMemoryNotFound) {
		status = http.StatusNotFound
		code = "PLAYGROUND_NOT_FOUND"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundMemorySourceNotFound) {
		status = http.StatusBadRequest
		code = "PLAYGROUND_INVALID_REQUEST"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundConflict) {
		status = http.StatusConflict
		code = "PLAYGROUND_CONFLICT"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundComparisonNotFound) {
		status = http.StatusNotFound
		code = "PLAYGROUND_COMPARISON_NOT_FOUND"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundComparisonConflict) {
		status = http.StatusConflict
		code = "PLAYGROUND_COMPARISON_CONFLICT"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundComparisonInvalid) {
		status = http.StatusBadRequest
		code = "PLAYGROUND_COMPARISON_INVALID"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundComparisonLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_COMPARISON_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundComparisonStorageLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_COMPARISON_STORAGE_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundComparisonUnavailable) {
		status = http.StatusInternalServerError
		code = "PLAYGROUND_COMPARISON_UNAVAILABLE"
		err = common.NewMessage(err.Error())
	}
	// Workflow history has its own stable codes so the canvas can tell a full
	// history from a malformed snapshot or a stale revision.
	if errors.Is(err, model.ErrPlaygroundWorkflowRunNotFound) {
		status = http.StatusNotFound
		code = "PLAYGROUND_WORKFLOW_RUN_NOT_FOUND"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundWorkflowRunConflict) {
		status = http.StatusConflict
		code = "PLAYGROUND_CONFLICT"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundWorkflowRunInvalid) {
		status = http.StatusBadRequest
		code = "PLAYGROUND_WORKFLOW_RUN_INVALID"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundWorkflowRunLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_WORKFLOW_RUN_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundWorkflowRunStorageLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_WORKFLOW_RUN_STORAGE_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundWorkflowRunUnavailable) {
		status = http.StatusInternalServerError
		code = "PLAYGROUND_WORKFLOW_RUN_UNAVAILABLE"
		err = common.NewMessage(err.Error())
	}
	// The resource quota policy returns stable capacity errors so the client can
	// tell a full workspace from a malformed request.
	if errors.Is(err, model.ErrPlaygroundSessionLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_SESSION_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundMessageLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_MESSAGE_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundParallelLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_PARALLEL_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundPresetLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_PRESET_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundCanvasTemplateLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_CANVAS_TEMPLATE_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundSnippetLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_SNIPPET_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundSnippetContentLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_SNIPPET_CONTENT_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundSnippetVersionLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_SNIPPET_VERSION_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundMemoryLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_MEMORY_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundMemoryContentLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_MEMORY_CONTENT_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundSystemPromptLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_SYSTEM_PROMPT_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundContextSummaryLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_CONTEXT_SUMMARY_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundDeveloperOptionsLimit) {
		status = http.StatusUnprocessableEntity
		code = "PLAYGROUND_DEVELOPER_OPTIONS_LIMIT_EXCEEDED"
		err = common.NewMessage(err.Error())
	}
	if errors.Is(err, model.ErrPlaygroundSessionArchived) {
		status = http.StatusBadRequest
		code = "PLAYGROUND_SESSION_ARCHIVED"
		err = common.NewMessage(err.Error())
	}
	common.ApiErrorStatus(c, status, err, gin.H{"code": code})
}

// playgroundRequestPolicy resolves the owner's effective resource budget for
// request pre-checks. The model re-checks the same policy inside each write
// transaction.
func playgroundRequestPolicy(c *gin.Context) (playground_setting.PlaygroundQuotaPolicy, bool) {
	policy, err := model.PlaygroundQuotaPolicyForUser(c.GetInt("id"))
	if err != nil {
		common.ApiError(c, err)
		return policy, false
	}
	return policy, true
}

func decodePlaygroundRequest(c *gin.Context, target any, maxBytes int64) bool {
	if c.GetInt("id") <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes))
	if err != nil {
		common.ApiErrorStatus(c, http.StatusRequestEntityTooLarge, common.NewMessage("Playground request is too large."))
		return false
	}
	reader := bytes.NewReader(body)
	if err = common.DecodeJson(reader, target); err != nil {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return false
	}
	// Unmarshal also ensures no trailing JSON values remain after DecodeJson.
	if err = common.Unmarshal(body, target); err != nil {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return false
	}
	return true
}

func playgroundDecodeSession(session *model.PlaygroundSession) (playgroundSessionResponse, error) {
	response := playgroundSessionResponse{ID: session.ID, ClientID: session.ClientID, Created: session.CreatedNow, Title: session.Title, Revision: session.Revision, MessageRevision: session.MessageRevision,
		SystemPrompt: session.SystemPrompt, OpeningMessage: string(session.OpeningMessage), SuggestedQuestions: []string{}, KnowledgeBaseIDs: []string{},
		Context: map[string]any{}, ContextSummary: json.RawMessage("null"),
		DeveloperOptions: map[string]any{},
		PinnedAt:         session.PinnedAt, ArchivedAt: session.ArchivedAt,
		Pinned: session.PinnedAt > 0, Archived: session.ArchivedAt > 0, Tags: []string{},
		CreatedAt: session.CreatedAt, UpdatedAt: session.UpdatedAt, Config: map[string]any{}, ParameterEnabled: map[string]bool{}}
	if err := common.Unmarshal([]byte(session.Config), &response.Config); err != nil {
		return response, err
	}
	if err := common.Unmarshal([]byte(session.ParameterEnabled), &response.ParameterEnabled); err != nil {
		return response, err
	}
	if stored := strings.TrimSpace(session.SuggestedQuestions); stored != "" && stored != "null" {
		if err := common.UnmarshalJsonStr(stored, &response.SuggestedQuestions); err != nil {
			return response, err
		}
		if response.SuggestedQuestions == nil {
			response.SuggestedQuestions = []string{}
		}
	}
	if stored := strings.TrimSpace(session.KnowledgeBaseIDs); stored != "" && stored != "null" {
		if err := common.UnmarshalJsonStr(stored, &response.KnowledgeBaseIDs); err != nil {
			return response, err
		}
		if response.KnowledgeBaseIDs == nil {
			response.KnowledgeBaseIDs = []string{}
		}
	}
	// Tags were validated on write. A NULL or legacy value reads back as no
	// tags instead of failing the conversation, mirroring the optional local
	// field that predates this column.
	if stored := strings.TrimSpace(session.Tags); stored != "" && stored != "null" {
		if err := common.UnmarshalJsonStr(stored, &response.Tags); err == nil && response.Tags == nil {
			response.Tags = []string{}
		}
	}
	if stored := strings.TrimSpace(session.ContextConfig); stored != "" && stored != "null" {
		if err := common.UnmarshalJsonStr(stored, &response.Context); err != nil {
			return response, err
		}
	}
	if stored := strings.TrimSpace(session.ContextSummary); stored != "" && stored != "null" {
		response.ContextSummary = json.RawMessage(stored)
	}
	// Developer options were validated on write. A NULL or legacy value reads
	// back as an empty object instead of failing the conversation; the client
	// applies its disabled defaults.
	if stored := strings.TrimSpace(session.DeveloperOptions); stored != "" && stored != "null" {
		if err := common.UnmarshalJsonStr(stored, &response.DeveloperOptions); err != nil {
			return response, err
		}
	}
	return response, nil
}

// encodePlaygroundContextSettings validates the conversation's context
// management object (history limit, token budget, auto summary flag and
// summary model). Unknown keys, wrong types and out-of-range numbers are
// rejected instead of silently dropped, and the value is stored as compact
// canonical JSON. An absent or null value leaves the stored settings alone.
func encodePlaygroundContextSettings(raw json.RawMessage) (string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return "", nil
	}
	var values map[string]json.RawMessage
	if err := common.Unmarshal(trimmed, &values); err != nil {
		return "", common.NewMessage("Invalid Playground configuration.")
	}
	for key, value := range values {
		switch key {
		case "history_limit":
			var limit int
			if err := common.Unmarshal(value, &limit); err != nil || limit < 0 || limit > playgroundContextHistoryLimitMax {
				return "", common.NewMessage("Invalid Playground configuration.")
			}
		case "token_budget":
			var budget int64
			if err := common.Unmarshal(value, &budget); err != nil || budget < 0 || budget > playgroundContextTokenBudgetMax {
				return "", common.NewMessage("Invalid Playground configuration.")
			}
		case "auto_summarize":
			var enabled bool
			if err := common.Unmarshal(value, &enabled); err != nil {
				return "", common.NewMessage("Invalid Playground configuration.")
			}
		case "summary_model":
			var name string
			if err := common.Unmarshal(value, &name); err != nil || len(name) > playgroundContextSummaryModelMaxLength || strings.ContainsRune(name, 0) {
				return "", common.NewMessage("Invalid Playground configuration.")
			}
		default:
			return "", common.NewMessage("Invalid Playground configuration.")
		}
	}
	encoded, err := common.Marshal(values)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// encodePlaygroundContextSummary validates the compression node one request
// may store. A literal null clears the stored summary; an object replaces it.
// The summary text is bounded by playgroundContextSummaryMaxBytes and a longer
// one is rejected with the stable capacity error, so a truncated summary is
// never persisted as if the model had produced it.
func encodePlaygroundContextSummary(raw json.RawMessage) (encoded string, clear bool, err error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "", false, nil
	}
	if string(trimmed) == "null" {
		return "", true, nil
	}
	var summary playgroundContextSummary
	if err := common.Unmarshal(trimmed, &summary); err != nil {
		return "", false, common.NewMessage("Invalid Playground configuration.")
	}
	for _, text := range []string{summary.ID, summary.Content, summary.ThroughMessageKey, summary.Model} {
		if strings.ContainsRune(text, 0) {
			return "", false, common.NewMessage("Invalid Playground configuration.")
		}
	}
	if len(summary.Content) > playgroundContextSummaryMaxBytes {
		return "", false, model.ErrPlaygroundContextSummaryLimit
	}
	if summary.ID == "" || len(summary.ID) > 200 || summary.Content == "" ||
		summary.ThroughMessageKey == "" || len(summary.ThroughMessageKey) > 200 ||
		len(summary.Model) > playgroundContextSummaryModelMaxLength {
		return "", false, common.NewMessage("Invalid Playground configuration.")
	}
	if summary.MessageCount != nil && (*summary.MessageCount < 0 || *summary.MessageCount > playgroundContextSummaryMessageCountMax) {
		return "", false, common.NewMessage("Invalid Playground configuration.")
	}
	if summary.CreatedAt != nil && (*summary.CreatedAt < 0 || math.IsInf(*summary.CreatedAt, 0) || math.IsNaN(*summary.CreatedAt)) {
		return "", false, common.NewMessage("Invalid Playground configuration.")
	}
	if err := validatePlaygroundMessageUsage(summary.RequestID, summary.Usage); err != nil {
		return "", false, err
	}
	payload, err := common.Marshal(summary)
	if err != nil {
		return "", false, err
	}
	return string(payload), false, nil
}

// playgroundDeveloperOptions is the stored request-side developer settings of
// one conversation, kept in the OpenAI wire shape so the client injects the
// stored value into a request unchanged. Only `type: "function"` tools are
// accepted: the gateway never executes anything, so a hosted tool type
// (code_interpreter, web_search, ...) would describe work nothing performs.
type playgroundDeveloperOptions struct {
	Enabled    bool             `json:"enabled"`
	Tools      []map[string]any `json:"tools,omitempty"`
	ToolChoice string           `json:"tool_choice,omitempty"`
	// ResponseFormat and the schema bodies are raw JSON so a stored JSON
	// Schema is injected verbatim: the gateway validates its shape and size
	// but never rewrites keywords the provider defines.
	ResponseFormat map[string]any `json:"response_format,omitempty"`
}

// playgroundDeveloperDecodeObject parses one JSON object and rejects every key
// outside the allowed set, so a stored developer setting never carries a field
// the server did not validate.
func playgroundDeveloperDecodeObject(raw json.RawMessage, allowed ...string) (map[string]json.RawMessage, error) {
	var values map[string]json.RawMessage
	if err := common.Unmarshal(raw, &values); err != nil || values == nil {
		return nil, common.NewMessage("Invalid Playground configuration.")
	}
	for key := range values {
		if !slices.Contains(allowed, key) {
			return nil, common.NewMessage("Invalid Playground configuration.")
		}
	}
	return values, nil
}

// playgroundDeveloperText reads one bounded string field. NUL bytes are
// rejected because PostgreSQL refuses them inside text columns.
func playgroundDeveloperText(raw json.RawMessage, maxBytes int) (string, error) {
	var text string
	if err := common.Unmarshal(raw, &text); err != nil || len(text) > maxBytes || strings.ContainsRune(text, 0) {
		return "", common.NewMessage("Invalid Playground configuration.")
	}
	return text, nil
}

// playgroundDeveloperSchema keeps one JSON Schema verbatim: it must be a JSON
// object and stay inside the per-schema budget, and a longer one is rejected
// with the stable capacity error instead of being truncated.
func playgroundDeveloperSchema(raw json.RawMessage) (json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := common.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, common.NewMessage("Invalid Playground configuration.")
	}
	if len(raw) > playgroundDeveloperSchemaMaxBytes {
		return nil, model.ErrPlaygroundDeveloperOptionsLimit
	}
	return raw, nil
}

// playgroundDeveloperEncodeTool validates one stored function tool and returns
// its canonical shape. Names must be unique so a client can tell the requested
// calls apart.
func playgroundDeveloperEncodeTool(raw json.RawMessage, names map[string]bool) (map[string]any, error) {
	invalid := common.NewMessage("Invalid Playground configuration.")
	tool, err := playgroundDeveloperDecodeObject(raw, "type", "function")
	if err != nil {
		return nil, err
	}
	var toolType string
	if err := common.Unmarshal(tool["type"], &toolType); err != nil || toolType != "function" {
		return nil, invalid
	}
	rawFunction, ok := tool["function"]
	if !ok {
		return nil, invalid
	}
	function, err := playgroundDeveloperDecodeObject(rawFunction, "name", "description", "parameters", "strict")
	if err != nil {
		return nil, err
	}
	name, err := playgroundDeveloperText(function["name"], playgroundDeveloperNameMaxLength)
	if err != nil || name == "" || names[name] {
		return nil, invalid
	}
	names[name] = true
	stored := map[string]any{"name": name}
	if value, ok := function["description"]; ok {
		description, err := playgroundDeveloperText(value, playgroundDeveloperDescriptionMaxBytes)
		if err != nil {
			return nil, err
		}
		stored["description"] = description
	}
	if value, ok := function["parameters"]; ok {
		parameters, err := playgroundDeveloperSchema(value)
		if err != nil {
			return nil, err
		}
		stored["parameters"] = parameters
	}
	if value, ok := function["strict"]; ok {
		var strict bool
		if err := common.Unmarshal(value, &strict); err != nil {
			return nil, invalid
		}
		stored["strict"] = strict
	}
	return map[string]any{"type": "function", "function": stored}, nil
}

// playgroundDeveloperEncodeResponseFormat validates the response format a
// conversation asks for. `json_schema` carries a named JSON Schema the client
// validates answers against; `text` and `json_object` accept no schema.
func playgroundDeveloperEncodeResponseFormat(raw json.RawMessage) (map[string]any, error) {
	invalid := common.NewMessage("Invalid Playground configuration.")
	format, err := playgroundDeveloperDecodeObject(raw, "type", "json_schema")
	if err != nil {
		return nil, err
	}
	var formatType string
	if err := common.Unmarshal(format["type"], &formatType); err != nil || !slices.Contains(playgroundDeveloperResponseFormatTypes, formatType) {
		return nil, invalid
	}
	if formatType != "json_schema" {
		if _, ok := format["json_schema"]; ok {
			return nil, invalid
		}
		return map[string]any{"type": formatType}, nil
	}
	rawSchema, ok := format["json_schema"]
	if !ok {
		return nil, invalid
	}
	schema, err := playgroundDeveloperDecodeObject(rawSchema, "name", "description", "schema", "strict")
	if err != nil {
		return nil, err
	}
	name, err := playgroundDeveloperText(schema["name"], playgroundDeveloperJSONSchemaNameMaxLength)
	if err != nil || name == "" {
		return nil, invalid
	}
	stored := map[string]any{"name": name}
	if value, ok := schema["description"]; ok {
		description, err := playgroundDeveloperText(value, playgroundDeveloperDescriptionMaxBytes)
		if err != nil {
			return nil, err
		}
		stored["description"] = description
	}
	body, ok := schema["schema"]
	if !ok {
		return nil, invalid
	}
	body, err = playgroundDeveloperSchema(body)
	if err != nil {
		return nil, err
	}
	stored["schema"] = body
	if value, ok := schema["strict"]; ok {
		var strict bool
		if err := common.Unmarshal(value, &strict); err != nil {
			return nil, invalid
		}
		stored["strict"] = strict
	}
	return map[string]any{"type": "json_schema", "json_schema": stored}, nil
}

// encodePlaygroundDeveloperOptions validates the request-side developer
// settings one request may store: the enabled switch, the function tool
// definitions and the response format. Unknown keys at every level, hosted or
// executable tool types and a tool choice without a tool are rejected, each
// schema and the total value are bounded, and the accepted value is stored as
// compact canonical JSON. An explicit null clears the stored options; an
// absent value keeps them.
func encodePlaygroundDeveloperOptions(raw json.RawMessage) (encoded string, clear bool, err error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "", false, nil
	}
	if string(trimmed) == "null" {
		return "", true, nil
	}
	top, err := playgroundDeveloperDecodeObject(trimmed, "enabled", "tools", "tool_choice", "response_format")
	if err != nil {
		return "", false, err
	}
	invalid := common.NewMessage("Invalid Playground configuration.")
	options := playgroundDeveloperOptions{}
	if value, ok := top["enabled"]; ok {
		if err := common.Unmarshal(value, &options.Enabled); err != nil {
			return "", false, invalid
		}
	}
	if value, ok := top["tools"]; ok {
		var rawTools []json.RawMessage
		if err := common.Unmarshal(value, &rawTools); err != nil {
			return "", false, invalid
		}
		if len(rawTools) > playgroundDeveloperToolMaxCount {
			return "", false, model.ErrPlaygroundDeveloperOptionsLimit
		}
		tools := make([]map[string]any, 0, len(rawTools))
		names := make(map[string]bool, len(rawTools))
		for _, rawTool := range rawTools {
			tool, err := playgroundDeveloperEncodeTool(rawTool, names)
			if err != nil {
				return "", false, err
			}
			tools = append(tools, tool)
		}
		options.Tools = tools
	}
	if value, ok := top["tool_choice"]; ok {
		choice, err := playgroundDeveloperText(value, 16)
		if err != nil || !slices.Contains(playgroundDeveloperToolChoiceValues, choice) {
			return "", false, invalid
		}
		options.ToolChoice = choice
	}
	// A tool choice without any tool is contradictory: it would be injected
	// into a request that defines nothing to call.
	if options.ToolChoice != "" && len(options.Tools) == 0 {
		return "", false, invalid
	}
	if value, ok := top["response_format"]; ok {
		format, err := playgroundDeveloperEncodeResponseFormat(value)
		if err != nil {
			return "", false, err
		}
		options.ResponseFormat = format
	}
	payload, err := common.Marshal(options)
	if err != nil {
		return "", false, err
	}
	if len(payload) > playgroundDeveloperOptionsMaxBytes {
		return "", false, model.ErrPlaygroundDeveloperOptionsLimit
	}
	return string(payload), false, nil
}

// encodePlaygroundSessionTags normalizes the complete tag list of one
// conversation. Tags are trimmed, blank entries are dropped, exact duplicates
// keep their first position, and the resulting list must fit the stored
// contract. The whole list is replaced on every write, so removal is expressed
// by sending the remaining tags (or an empty list).
func encodePlaygroundSessionTags(tags []string) (string, error) {
	values := make([]string, 0, min(len(tags), playgroundSessionTagMaxCount))
	seen := make(map[string]bool, len(tags))
	for _, raw := range tags {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if utf8.RuneCountInString(value) > playgroundSessionTagMaxLength || strings.ContainsRune(value, 0) {
			return "", common.NewMessage("Invalid Playground conversation tags.")
		}
		if seen[value] {
			continue
		}
		seen[value] = true
		values = append(values, value)
	}
	if len(values) > playgroundSessionTagMaxCount {
		return "", common.NewMessage("Invalid Playground conversation tags.")
	}
	encoded, err := common.Marshal(values)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// encodePlaygroundSettings validates the session settings one request may
// carry. A system prompt is bounded by the owner's policy; it stays optional so
// a request that only renames a conversation keeps the stored prompt. The
// context settings are the complete settings object the client wants stored —
// an absent object keeps the previous one — and the compression node is an
// object to store or an explicit null to remove.
func encodePlaygroundSettings(request playgroundSessionRequest, systemPromptMaxBytes int64) (map[string]any, error) {
	updates := map[string]any{}
	if request.Title != nil {
		title := strings.TrimSpace(*request.Title)
		if title == "" || utf8.RuneCountInString(title) > 200 {
			return nil, common.NewMessage("Playground conversation name must contain 1 to 200 characters.")
		}
		updates["title"] = title
	}
	if request.SystemPrompt != nil {
		prompt := *request.SystemPrompt
		if int64(len(prompt)) > systemPromptMaxBytes {
			return nil, model.ErrPlaygroundSystemPromptLimit
		}
		// PostgreSQL rejects NUL bytes inside text, so the prompt is validated
		// before it reaches any dialect.
		if strings.ContainsRune(prompt, 0) {
			return nil, common.NewMessage("Invalid Playground configuration.")
		}
		updates["system_prompt"] = prompt
	}
	if request.OpeningMessage != nil {
		message := *request.OpeningMessage
		if len(message) > playgroundPresetOpeningMessageMaxBytes {
			return nil, common.NewMessage("The opening message is too long.")
		}
		if strings.ContainsRune(message, 0) {
			return nil, common.NewMessage("Invalid Playground configuration.")
		}
		updates["opening_message"] = message
	}
	if request.SuggestedQuestions != nil {
		encoded, err := encodePlaygroundSuggestedQuestions(*request.SuggestedQuestions)
		if err != nil {
			return nil, err
		}
		updates["suggested_questions"] = encoded
	}
	if request.Tags != nil {
		encoded, err := encodePlaygroundSessionTags(*request.Tags)
		if err != nil {
			return nil, err
		}
		updates["tags"] = encoded
	}
	if request.Context != nil {
		encoded, err := encodePlaygroundContextSettings(request.Context)
		if err != nil {
			return nil, err
		}
		if encoded != "" {
			updates["context_config"] = encoded
		}
	}
	if request.ContextSummary != nil {
		encoded, clear, err := encodePlaygroundContextSummary(request.ContextSummary)
		if err != nil {
			return nil, err
		}
		if clear {
			updates["context_summary"] = ""
		} else if encoded != "" {
			updates["context_summary"] = encoded
		}
	}
	if request.DeveloperOptions != nil {
		encoded, clear, err := encodePlaygroundDeveloperOptions(request.DeveloperOptions)
		if err != nil {
			return nil, err
		}
		if clear {
			updates["developer_options"] = ""
		} else if encoded != "" {
			updates["developer_options"] = encoded
		}
	}
	if request.Config != nil {
		for key, value := range request.Config {
			valid := false
			switch key {
			case "model", "group":
				text, ok := value.(string)
				valid = ok && len(text) <= 512
			case "stream":
				_, valid = value.(bool)
			case "temperature", "top_p", "max_tokens", "frequency_penalty", "presence_penalty":
				_, valid = value.(float64)
			case "seed":
				_, valid = value.(float64)
				valid = valid || value == nil
			case "reasoning_effort":
				text, ok := value.(string)
				valid = ok && (text == "" || slices.Contains(playgroundReasoningEffortValues, text))
			}
			if !valid {
				return nil, common.NewMessage("Invalid Playground configuration.")
			}
		}
		encoded, err := common.Marshal(request.Config)
		if err != nil {
			return nil, err
		}
		updates["config"] = string(encoded)
	}
	if request.ParameterEnabled != nil {
		for key := range request.ParameterEnabled {
			switch key {
			case "temperature", "top_p", "max_tokens", "frequency_penalty", "presence_penalty", "seed", "reasoning_effort":
			default:
				return nil, common.NewMessage("Invalid Playground configuration.")
			}
		}
		encoded, err := common.Marshal(request.ParameterEnabled)
		if err != nil {
			return nil, err
		}
		updates["parameter_enabled"] = string(encoded)
	}
	return updates, nil
}

// encodePlaygroundKnowledgeBaseIDs validates the conversation binding. The
// list is owner-scoped, capped at three distinct ids, and stored as compact
// JSON so the response can round-trip an explicit empty list.
func encodePlaygroundKnowledgeBaseIDs(userID int, knowledgeBaseIDs []string) (string, error) {
	if len(knowledgeBaseIDs) > playgroundSessionKnowledgeBaseMax {
		return "", common.NewMessage("A conversation can bind at most three knowledge bases.")
	}
	normalized := make([]string, 0, len(knowledgeBaseIDs))
	seen := make(map[string]bool, len(knowledgeBaseIDs))
	for _, knowledgeBaseID := range knowledgeBaseIDs {
		if knowledgeBaseID == "" || len(knowledgeBaseID) > playgroundSessionKnowledgeBaseIDMaxBytes ||
			strings.ContainsRune(knowledgeBaseID, 0) || seen[knowledgeBaseID] {
			return "", common.NewMessage("Invalid Playground knowledge base binding.")
		}
		seen[knowledgeBaseID] = true
		normalized = append(normalized, knowledgeBaseID)
	}
	if err := model.ValidatePlaygroundKnowledgeBaseIDs(userID, normalized); err != nil {
		if errors.Is(err, model.ErrPlaygroundKnowledgeBaseNotFound) {
			return "", common.NewMessage("Playground knowledge base not found.")
		}
		return "", err
	}
	encoded, err := common.Marshal(normalized)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// validatePlaygroundToolCalls bounds the persisted tool call state of one
// message version. Arguments and results are opaque text here; the gateway
// only checks who may carry calls, their identity, size and status, and never
// executes anything.
func validatePlaygroundToolCalls(from string, toolCalls []playgroundMessageToolCall, policy playground_setting.PlaygroundQuotaPolicy) error {
	if from != "assistant" || len(toolCalls) > policy.ToolCallMaxCount {
		return common.NewMessage("Invalid Playground message.")
	}
	ids := make(map[string]bool, len(toolCalls))
	for _, toolCall := range toolCalls {
		if toolCall.ID == "" || len(toolCall.ID) > 200 || ids[toolCall.ID] {
			return common.NewMessage("Invalid Playground message.")
		}
		ids[toolCall.ID] = true
		if toolCall.Name == "" || len(toolCall.Name) > 200 || int64(len(toolCall.Arguments)) > policy.ToolCallArgumentsMaxBytes {
			return common.NewMessage("Invalid Playground message.")
		}
		if toolCall.Result != nil && int64(len(*toolCall.Result)) > policy.ToolCallResultMaxBytes {
			return common.NewMessage("Invalid Playground message.")
		}
		if toolCall.ErrorMessage != nil && int64(len(*toolCall.ErrorMessage)) > policy.ToolCallResultMaxBytes {
			return common.NewMessage("Invalid Playground message.")
		}
		switch toolCall.Status {
		case "pending", "completed", "denied", "error":
		default:
			return common.NewMessage("Invalid Playground message.")
		}
	}
	return nil
}

// validatePlaygroundMessageUsage bounds the optional display metadata one
// stored version may carry. The request id associates the version with the
// owner's consume log and the token counts only label it; neither is billing
// input, so a single sanity ceiling on the numbers is enough.
func validatePlaygroundMessageUsage(requestId *string, usage *playgroundMessageUsage) error {
	if requestId != nil && (*requestId == "" || len(*requestId) > playgroundMessageRequestIdMaxLength) {
		return common.NewMessage("Invalid Playground message.")
	}
	if usage == nil {
		return nil
	}
	if usage.PromptTokens == nil || usage.CompletionTokens == nil || usage.TotalTokens == nil {
		return common.NewMessage("Invalid Playground message.")
	}
	for _, value := range []float64{*usage.PromptTokens, *usage.CompletionTokens, *usage.TotalTokens} {
		if value < 0 || value > playgroundMessageTokenMax || value != math.Trunc(value) {
			return common.NewMessage("Invalid Playground message.")
		}
	}
	return nil
}

// validatePlaygroundMessages normalizes stored payloads and resolves attachment
// references against the session's owned attachments. Create-time snapshots
// cannot reference attachments yet, so allowAttachments is false there.
func validatePlaygroundMessages(userID int, sessionID string, inputs []playgroundMessageInput, allowAttachments bool, policy playground_setting.PlaygroundQuotaPolicy) ([]model.PlaygroundMessage, error) {
	if len(inputs) > policy.MessageMaxCount {
		return nil, model.ErrPlaygroundMessageLimit
	}
	payloads := make([]playgroundMessagePayload, 0, len(inputs))
	keys := make(map[string]bool, len(inputs))
	attachmentIDs := make(map[string]bool)
	for _, input := range inputs {
		var payload playgroundMessagePayload
		if err := common.Unmarshal(input.Payload, &payload); err != nil {
			return nil, common.NewMessage("Invalid Playground message.")
		}
		if input.ClientKey == "" || len(input.ClientKey) > 200 || keys[input.ClientKey] || payload.Key != input.ClientKey || len(payload.Versions) == 0 || len(payload.Versions) > policy.MessageMaxVersions {
			return nil, common.NewMessage("Invalid Playground message.")
		}
		keys[input.ClientKey] = true
		// A branch selection must point at a stored version; otherwise the
		// client could persist an index no renderer can resolve.
		if payload.ActiveVersionIndex != nil && (*payload.ActiveVersionIndex < 0 || *payload.ActiveVersionIndex >= len(payload.Versions)) {
			return nil, common.NewMessage("Invalid Playground message.")
		}
		if payload.ErrorCode != nil && len(*payload.ErrorCode) > playgroundMessageErrorCodeMaxLength {
			return nil, common.NewMessage("Invalid Playground message.")
		}
		switch payload.From {
		case "user", "assistant", "system":
		default:
			return nil, common.NewMessage("Invalid Playground message.")
		}
		switch payload.Status {
		case "", "loading", "streaming", "complete", "error":
		default:
			return nil, common.NewMessage("Invalid Playground message.")
		}
		if payload.Parallel != nil && *payload.Parallel {
			// A comparison is a group of assistant replies: it only makes sense
			// with several versions, and every version must name the model it
			// came from. The owner's policy caps how many models one group may
			// compare; the cap is enforced here, where the group is stored.
			if payload.From != "assistant" || len(payload.Versions) < playgroundParallelMinVersions {
				return nil, common.NewMessage("Invalid Playground message.")
			}
			if len(payload.Versions) > policy.ParallelCompareMaxModels {
				return nil, model.ErrPlaygroundParallelLimit
			}
			for versionIndex := range payload.Versions {
				version := &payload.Versions[versionIndex]
				if version.Model == nil || *version.Model == "" {
					return nil, common.NewMessage("Invalid Playground message.")
				}
			}
		}
		for versionIndex := range payload.Versions {
			version := &payload.Versions[versionIndex]
			if version.ID == "" || len(version.ID) > 200 {
				return nil, common.NewMessage("Invalid Playground message.")
			}
			if version.Model != nil && (len(*version.Model) > playgroundMessageModelMaxLength || strings.ContainsRune(*version.Model, 0)) {
				return nil, common.NewMessage("Invalid Playground message.")
			}
			switch version.Status {
			case "", "loading", "streaming", "complete", "error":
			default:
				return nil, common.NewMessage("Invalid Playground message.")
			}
			if version.ErrorCode != nil && len(*version.ErrorCode) > playgroundMessageErrorCodeMaxLength {
				return nil, common.NewMessage("Invalid Playground message.")
			}
			if version.FinishReason != nil && (len(*version.FinishReason) > playgroundMessageFinishReasonMaxLength || strings.ContainsRune(*version.FinishReason, 0)) {
				return nil, common.NewMessage("Invalid Playground message.")
			}
			if err := validatePlaygroundMessageUsage(version.RequestId, version.Usage); err != nil {
				return nil, err
			}
			if len(version.ToolCalls) > 0 {
				if err := validatePlaygroundToolCalls(payload.From, version.ToolCalls, policy); err != nil {
					return nil, err
				}
			}
			if len(version.Attachments) > 0 {
				if !allowAttachments || payload.From != "user" || len(version.Attachments) > policy.AttachmentMaxCount {
					return nil, common.NewMessage("Invalid Playground message.")
				}
				seen := make(map[string]bool, len(version.Attachments))
				for _, attachment := range version.Attachments {
					if attachment.ID == "" || len(attachment.ID) > 200 || seen[attachment.ID] {
						return nil, common.NewMessage("Invalid Playground message.")
					}
					seen[attachment.ID] = true
					attachmentIDs[attachment.ID] = true
				}
			}
			// Cached read-aloud audio is a reference like an attachment, but
			// it belongs to a user or assistant reply, never to a system
			// message.
			if version.Speech != nil {
				if !allowAttachments || (payload.From != "user" && payload.From != "assistant") || version.Speech.ID == "" || len(version.Speech.ID) > 200 {
					return nil, common.NewMessage("Invalid Playground message.")
				}
				attachmentIDs[version.Speech.ID] = true
			}
		}
		if len(payload.Sources) > 100 {
			return nil, common.NewMessage("Invalid Playground message.")
		}
		for _, source := range payload.Sources {
			parsed, err := url.Parse(source.Href)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || len(source.Href) > 4096 || len(source.Title) > 500 {
				return nil, common.NewMessage("Invalid Playground message.")
			}
		}
		if payload.Search != nil {
			if err := validatePlaygroundMessageSearch(payload.From, payload.Search); err != nil {
				return nil, err
			}
		}
		if payload.Knowledge != nil {
			if err := validatePlaygroundMessageKnowledge(payload.From, payload.Knowledge); err != nil {
				return nil, err
			}
		}
		payloads = append(payloads, payload)
	}

	resolved := map[string]model.PlaygroundAttachment{}
	if len(attachmentIDs) > 0 {
		ids := make([]string, 0, len(attachmentIDs))
		for id := range attachmentIDs {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		var err error
		resolved, err = model.GetPlaygroundAttachmentsByIDs(userID, sessionID, ids)
		if err != nil {
			return nil, err
		}
		if len(resolved) != len(ids) {
			return nil, common.NewMessage("Playground attachment not found.")
		}
	}

	messages := make([]model.PlaygroundMessage, 0, len(payloads))
	total := 0
	for index := range payloads {
		payload := &payloads[index]
		for versionIndex := range payload.Versions {
			version := &payload.Versions[versionIndex]
			for attachmentIndex := range version.Attachments {
				attachment := &version.Attachments[attachmentIndex]
				stored := resolved[attachment.ID]
				attachment.MediaType = stored.MediaType
				attachment.Filename = stored.Filename
				attachment.ByteSize = stored.ByteSize
			}
			if version.Speech != nil {
				stored := resolved[version.Speech.ID]
				version.Speech.MediaType = stored.MediaType
				version.Speech.Filename = stored.Filename
				version.Speech.ByteSize = stored.ByteSize
			}
		}
		// Only the message contract is persisted; unknown credential/provider fields are discarded.
		encoded, err := common.Marshal(payload)
		if err != nil {
			return nil, err
		}
		total += len(encoded)
		if int64(total) > policy.MessageMaxBytes {
			return nil, model.ErrPlaygroundMessageLimit
		}
		messages = append(messages, model.PlaygroundMessage{ClientKey: payload.Key, Payload: model.LongText(encoded)})
	}
	return messages, nil
}

// validatePlaygroundMessageSearch bounds the search snapshot a stored message
// may carry and keeps it on user turns only. The snapshot is context the user
// already saw, so it is validated instead of trusted, while an oversized or
// malformed list is rejected exactly like any other invalid message.
func validatePlaygroundMessageSearch(from string, search *playgroundMessageSearch) error {
	if from != "user" || search == nil {
		return common.NewMessage("Invalid Playground message.")
	}
	query := strings.TrimSpace(search.Query)
	if query == "" || utf8.RuneCountInString(query) > playgroundMessageSearchMaxQueryRunes {
		return common.NewMessage("Invalid Playground message.")
	}
	if len(search.Provider) > playgroundMessageSearchMaxProviderBytes {
		return common.NewMessage("Invalid Playground message.")
	}
	if len(search.Results) > playgroundMessageSearchMaxResults {
		return common.NewMessage("Invalid Playground message.")
	}
	totalBytes := 0
	for _, result := range search.Results {
		resultURL := strings.TrimSpace(result.URL)
		parsed, err := url.Parse(resultURL)
		if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return common.NewMessage("Invalid Playground message.")
		}
		if len(resultURL) > playgroundMessageSearchMaxURLBytes ||
			len(result.Title) > playgroundMessageSearchMaxTitleBytes ||
			len(result.Snippet) > playgroundMessageSearchMaxSnippetBytes {
			return common.NewMessage("Invalid Playground message.")
		}
		totalBytes += len(result.Title) + len(resultURL) + len(result.Snippet)
		if totalBytes > playgroundMessageSearchMaxResultListBytes {
			return common.NewMessage("Invalid Playground message.")
		}
	}
	return nil
}

// validatePlaygroundMessageKnowledge bounds the retrieval snapshot a stored
// user message keeps. The client sends the merged top-k result it injected;
// the server only checks shape, ownership-agnostic metadata bounds and total
// size, because retrieval was authorized when it ran.
func validatePlaygroundMessageKnowledge(from string, knowledge *playgroundMessageKnowledge) error {
	if from != "user" || knowledge == nil {
		return common.NewMessage("Invalid Playground message.")
	}
	if strings.TrimSpace(knowledge.Query) == "" || utf8.RuneCountInString(knowledge.Query) > playgroundMessageKnowledgeMaxQueryRunes {
		return common.NewMessage("Invalid Playground message.")
	}
	if len(knowledge.Results) > playgroundMessageKnowledgeMaxResults {
		return common.NewMessage("Invalid Playground message.")
	}
	seen := make(map[string]bool, len(knowledge.Results))
	totalBytes := len(knowledge.Query)
	for _, result := range knowledge.Results {
		for _, value := range []string{result.KnowledgeBaseID, result.DocumentID, result.Filename, result.ChunkID} {
			if value == "" || len(value) > playgroundMessageKnowledgeMaxIDBytes || strings.ContainsRune(value, 0) {
				return common.NewMessage("Invalid Playground message.")
			}
		}
		if len(result.KnowledgeBaseName) > playgroundMessageKnowledgeMaxBaseNameBytes ||
			len(result.Filename) > playgroundMessageKnowledgeMaxFilenameBytes ||
			result.ChunkIndex < 0 ||
			len(result.Text) > playgroundMessageKnowledgeMaxChunkTextBytes ||
			math.IsNaN(result.Score) || math.IsInf(result.Score, 0) {
			return common.NewMessage("Invalid Playground message.")
		}
		if seen[result.ChunkID] {
			return common.NewMessage("Invalid Playground message.")
		}
		seen[result.ChunkID] = true
		totalBytes += len(result.KnowledgeBaseName) + len(result.DocumentID) + len(result.Filename) + len(result.ChunkID) + len(result.Text)
		if totalBytes > playgroundMessageKnowledgeMaxResultListBytes {
			return common.NewMessage("Invalid Playground message.")
		}
	}
	return nil
}

// validatePlaygroundMessageDeletes bounds the client keys one delta removes.
// Removing an already absent key is allowed so a retried delta stays replayable.
func validatePlaygroundMessageDeletes(keys []string) ([]string, error) {
	deletes := make([]string, 0, len(keys))
	seen := make(map[string]bool, len(keys))
	for _, key := range keys {
		if key == "" || len(key) > 200 || seen[key] {
			return nil, common.NewMessage("Invalid Playground request.")
		}
		seen[key] = true
		deletes = append(deletes, key)
	}
	return deletes, nil
}

func ListPlaygroundSessions(c *gin.Context) {
	page := common.GetPageQuery(c)
	if page.Page < 1 || page.Page > 1000000 || page.PageSize < 1 {
		writePlaygroundError(c, common.NewMessage("Invalid Playground pagination."))
		return
	}
	sessions, total, err := model.ListPlaygroundSessions(c.GetInt("id"), page.GetStartIdx(), page.PageSize)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	responses := make([]playgroundSessionResponse, 0, len(sessions))
	for i := range sessions {
		response, err := playgroundDecodeSession(&sessions[i])
		if err != nil {
			common.ApiError(c, err)
			return
		}
		responses = append(responses, response)
	}
	page.SetItems(responses)
	page.SetTotal(int(total))
	common.ApiSuccess(c, page)
}

func CreatePlaygroundSession(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundSessionRequest
	if !decodePlaygroundRequest(c, &request, policy.MessageMaxBytes+(64<<10)+playgroundContextSummaryMaxBytes+playgroundDeveloperOptionsMaxBytes) {
		return
	}
	if len(request.ClientID) > 128 {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	updates, err := encodePlaygroundSettings(request, policy.SystemPromptMaxBytes)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	if request.KnowledgeBaseIDs != nil {
		encoded, err := encodePlaygroundKnowledgeBaseIDs(c.GetInt("id"), *request.KnowledgeBaseIDs)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		updates["knowledge_base_ids"] = encoded
	}
	messages, err := validatePlaygroundMessages(c.GetInt("id"), "", request.Messages, false, policy)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	session := &model.PlaygroundSession{Title: "New conversation", Config: "{}", ParameterEnabled: "{}", ContextConfig: "{}"}
	if knowledgeBaseIDs, ok := updates["knowledge_base_ids"]; ok {
		session.KnowledgeBaseIDs = knowledgeBaseIDs.(string)
	}
	if title, ok := updates["title"]; ok {
		session.Title = title.(string)
	}
	if config, ok := updates["config"]; ok {
		session.Config = config.(string)
	}
	if flags, ok := updates["parameter_enabled"]; ok {
		session.ParameterEnabled = flags.(string)
	}
	if prompt, ok := updates["system_prompt"]; ok {
		session.SystemPrompt = prompt.(string)
	}
	if contextConfig, ok := updates["context_config"]; ok {
		session.ContextConfig = contextConfig.(string)
	}
	if contextSummary, ok := updates["context_summary"]; ok {
		session.ContextSummary = contextSummary.(string)
	}
	if developerOptions, ok := updates["developer_options"]; ok {
		session.DeveloperOptions = developerOptions.(string)
	}
	if openingMessage, ok := updates["opening_message"]; ok {
		session.OpeningMessage = model.LongText(openingMessage.(string))
	}
	if suggestedQuestions, ok := updates["suggested_questions"]; ok {
		session.SuggestedQuestions = suggestedQuestions.(string)
	}
	if tags, ok := updates["tags"]; ok {
		session.Tags = tags.(string)
	}
	now := common.GetTimestamp()
	if request.Archived != nil && *request.Archived {
		session.ArchivedAt = now
	}
	// Archiving wins over a simultaneous pin, matching the update contract:
	// archived conversations are never pinned.
	if request.Pinned != nil && *request.Pinned && session.ArchivedAt == 0 {
		session.PinnedAt = now
	}
	if request.ClientID != "" {
		session.ClientID = &request.ClientID
	}
	if err = model.CreatePlaygroundSession(c.GetInt("id"), session, messages); err != nil {
		writePlaygroundError(c, err)
		return
	}
	response, err := playgroundDecodeSession(session)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

func GetPlaygroundSession(c *gin.Context) {
	session, err := model.GetPlaygroundSession(c.GetInt("id"), c.Param("id"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	response, err := playgroundDecodeSession(session)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

func UpdatePlaygroundSession(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundSessionRequest
	if !decodePlaygroundRequest(c, &request, policy.MessageMaxBytes+(64<<10)+playgroundContextSummaryMaxBytes+playgroundDeveloperOptionsMaxBytes) {
		return
	}
	if request.Revision == nil || *request.Revision < 0 {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	updates, err := encodePlaygroundSettings(request, policy.SystemPromptMaxBytes)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	if request.KnowledgeBaseIDs != nil {
		encoded, err := encodePlaygroundKnowledgeBaseIDs(c.GetInt("id"), *request.KnowledgeBaseIDs)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		updates["knowledge_base_ids"] = encoded
	}
	session, err := model.UpdatePlaygroundSessionFields(c.GetInt("id"), c.Param("id"), *request.Revision, updates, model.PlaygroundSessionOrganization{
		Pinned: request.Pinned, Archived: request.Archived,
	})
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	response, err := playgroundDecodeSession(session)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, response)
}

func DeletePlaygroundSession(c *gin.Context) {
	if err := model.DeletePlaygroundSession(c.GetInt("id"), c.Param("id")); err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("id")})
}

func ListPlaygroundMessages(c *gin.Context) {
	messages, revision, err := model.ListPlaygroundMessages(c.GetInt("id"), c.Param("id"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	responses := make([]playgroundMessageResponse, 0, len(messages))
	for _, message := range messages {
		responses = append(responses, playgroundMessageResponse{ClientKey: message.ClientKey, Payload: json.RawMessage(message.Payload)})
	}
	common.ApiSuccess(c, gin.H{"revision": revision, "messages": responses})
}

// ReplacePlaygroundMessages is the deprecated full-snapshot writer. It stays
// available for one release so clients that still send the complete message
// list keep working; the server translates the snapshot into incremental
// writes, so unchanged rows are never rewritten. It is scheduled for removal
// once every client uses PATCH /sessions/:id/messages (the delta endpoint).
//
// Deprecated: use ApplyPlaygroundMessagesDelta.
func ReplacePlaygroundMessages(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundMessagesRequest
	if !decodePlaygroundRequest(c, &request, policy.MessageMaxBytes+(64<<10)) {
		return
	}
	if request.Messages == nil || request.Revision == nil || *request.Revision < 0 {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	messages, err := validatePlaygroundMessages(c.GetInt("id"), c.Param("id"), *request.Messages, true, policy)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	revision, err := model.ReplacePlaygroundMessages(c.GetInt("id"), c.Param("id"), *request.Revision, messages)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	responses := make([]playgroundMessageResponse, 0, len(messages))
	for _, message := range messages {
		responses = append(responses, playgroundMessageResponse{ClientKey: message.ClientKey, Payload: json.RawMessage(message.Payload)})
	}
	common.ApiSuccess(c, gin.H{"revision": revision, "messages": responses})
}

// ApplyPlaygroundMessagesDelta applies one incremental message write: only the
// upserted and deleted rows are touched, and the caller's revision is the CAS
// token that serializes concurrent writers. A delta that changes nothing keeps
// the stored revision.
func ApplyPlaygroundMessagesDelta(c *gin.Context) {
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	var request playgroundMessageDeltaRequest
	if !decodePlaygroundRequest(c, &request, policy.MessageMaxBytes+(64<<10)) {
		return
	}
	if request.Revision == nil || *request.Revision < 0 || (request.Upserts == nil && request.Deletes == nil) {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	upserts := make([]playgroundMessageInput, 0)
	if request.Upserts != nil {
		upserts = *request.Upserts
	}
	deletes := make([]string, 0)
	if request.Deletes != nil {
		var err error
		deletes, err = validatePlaygroundMessageDeletes(*request.Deletes)
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
	}
	if len(upserts) == 0 && len(deletes) == 0 {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	messages, err := validatePlaygroundMessages(c.GetInt("id"), c.Param("id"), upserts, true, policy)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	// One key cannot be upserted and deleted in the same delta: the two would
	// fight over the stored row and silently move the message to the end.
	if len(deletes) > 0 {
		deleted := make(map[string]bool, len(deletes))
		for _, key := range deletes {
			deleted[key] = true
		}
		for _, message := range messages {
			if deleted[message.ClientKey] {
				writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
				return
			}
		}
	}
	revision, err := model.ApplyPlaygroundMessagesDelta(c.GetInt("id"), c.Param("id"), *request.Revision, model.PlaygroundMessageDelta{Upserts: messages, Deletes: deletes})
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	upserted := make([]string, 0, len(messages))
	for _, message := range messages {
		upserted = append(upserted, message.ClientKey)
	}
	// The response echoes the keys the request carried; rows whose stored payload
	// already matched were not rewritten and the revision stayed the same.
	common.ApiSuccess(c, gin.H{"revision": revision, "upserted": upserted, "deleted": deletes})
}
