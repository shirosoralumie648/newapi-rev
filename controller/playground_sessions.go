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
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

const playgroundSnapshotMaxBytes = 1 << 20

type playgroundSessionRequest struct {
	Title            *string                  `json:"title"`
	ClientID         string                   `json:"client_id"`
	Config           map[string]any           `json:"config"`
	ParameterEnabled map[string]bool          `json:"parameter_enabled"`
	Revision         *int64                   `json:"revision"`
	Messages         []playgroundMessageInput `json:"messages"`
}

type playgroundSessionResponse struct {
	Created          bool            `json:"created,omitempty"`
	ID               string          `json:"id"`
	ClientID         *string         `json:"client_id,omitempty"`
	Title            string          `json:"title"`
	Config           map[string]any  `json:"config"`
	ParameterEnabled map[string]bool `json:"parameter_enabled"`
	Revision         int64           `json:"revision"`
	MessageRevision  int64           `json:"message_revision"`
	CreatedAt        int64           `json:"created_at"`
	UpdatedAt        int64           `json:"updated_at"`
}

type playgroundMessageInput struct {
	ClientKey string          `json:"client_key"`
	Payload   json.RawMessage `json:"payload"`
}

type playgroundMessagesRequest struct {
	Revision *int64                    `json:"revision"`
	Messages *[]playgroundMessageInput `json:"messages"`
}

type playgroundMessagePayload struct {
	Key      string `json:"key"`
	From     string `json:"from"`
	Versions []struct {
		ID          string                        `json:"id"`
		Content     string                        `json:"content"`
		Attachments []playgroundMessageAttachment `json:"attachments,omitempty"`
	} `json:"versions"`
	CreatedAt   *float64 `json:"createdAt,omitempty"`
	StartedAt   *float64 `json:"startedAt,omitempty"`
	CompletedAt *float64 `json:"completedAt,omitempty"`
	DurationMs  *float64 `json:"durationMs,omitempty"`
	Sources     []struct {
		Href  string `json:"href"`
		Title string `json:"title"`
	} `json:"sources,omitempty"`
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
	if errors.Is(err, model.ErrPlaygroundConflict) {
		status = http.StatusConflict
		code = "PLAYGROUND_CONFLICT"
		err = common.NewMessage(err.Error())
	}
	common.ApiErrorStatus(c, status, err, gin.H{"code": code})
}

func decodePlaygroundRequest(c *gin.Context, target any) bool {
	if c.GetInt("id") <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, playgroundSnapshotMaxBytes+(64<<10)))
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
		CreatedAt: session.CreatedAt, UpdatedAt: session.UpdatedAt, Config: map[string]any{}, ParameterEnabled: map[string]bool{}}
	if err := common.Unmarshal([]byte(session.Config), &response.Config); err != nil {
		return response, err
	}
	if err := common.Unmarshal([]byte(session.ParameterEnabled), &response.ParameterEnabled); err != nil {
		return response, err
	}
	return response, nil
}

func encodePlaygroundSettings(request playgroundSessionRequest) (map[string]any, error) {
	updates := map[string]any{}
	if request.Title != nil {
		title := strings.TrimSpace(*request.Title)
		if title == "" || utf8.RuneCountInString(title) > 200 {
			return nil, common.NewMessage("Playground conversation name must contain 1 to 200 characters.")
		}
		updates["title"] = title
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
			case "temperature", "top_p", "max_tokens", "frequency_penalty", "presence_penalty", "seed":
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

// validatePlaygroundMessages normalizes stored payloads and resolves attachment
// references against the session's owned attachments. The returned IDs are the
// attachments the stored snapshot references, ordered for a deterministic
// reference update. Create-time snapshots cannot reference attachments yet, so
// allowAttachments is false there.
func validatePlaygroundMessages(userID int, sessionID string, inputs []playgroundMessageInput, allowAttachments bool) ([]model.PlaygroundMessage, []string, error) {
	if len(inputs) > model.PlaygroundMessageMaxCount {
		return nil, nil, common.NewMessage("Playground conversations support at most 100 messages.")
	}
	payloads := make([]playgroundMessagePayload, 0, len(inputs))
	keys := make(map[string]bool, len(inputs))
	attachmentIDs := make(map[string]bool)
	for _, input := range inputs {
		var payload playgroundMessagePayload
		if err := common.Unmarshal(input.Payload, &payload); err != nil {
			return nil, nil, common.NewMessage("Invalid Playground message.")
		}
		if input.ClientKey == "" || len(input.ClientKey) > 200 || keys[input.ClientKey] || payload.Key != input.ClientKey || len(payload.Versions) == 0 || len(payload.Versions) > 100 {
			return nil, nil, common.NewMessage("Invalid Playground message.")
		}
		keys[input.ClientKey] = true
		if payload.ErrorCode != nil && len(*payload.ErrorCode) > 500 {
			return nil, nil, common.NewMessage("Invalid Playground message.")
		}
		switch payload.From {
		case "user", "assistant", "system":
		default:
			return nil, nil, common.NewMessage("Invalid Playground message.")
		}
		switch payload.Status {
		case "", "loading", "streaming", "complete", "error":
		default:
			return nil, nil, common.NewMessage("Invalid Playground message.")
		}
		for versionIndex := range payload.Versions {
			version := &payload.Versions[versionIndex]
			if version.ID == "" || len(version.ID) > 200 {
				return nil, nil, common.NewMessage("Invalid Playground message.")
			}
			if len(version.Attachments) == 0 {
				continue
			}
			if !allowAttachments || payload.From != "user" || len(version.Attachments) > model.PlaygroundAttachmentMaxCount {
				return nil, nil, common.NewMessage("Invalid Playground message.")
			}
			seen := make(map[string]bool, len(version.Attachments))
			for _, attachment := range version.Attachments {
				if attachment.ID == "" || len(attachment.ID) > 200 || seen[attachment.ID] {
					return nil, nil, common.NewMessage("Invalid Playground message.")
				}
				seen[attachment.ID] = true
				attachmentIDs[attachment.ID] = true
			}
		}
		if len(payload.Sources) > 100 {
			return nil, nil, common.NewMessage("Invalid Playground message.")
		}
		for _, source := range payload.Sources {
			parsed, err := url.Parse(source.Href)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || len(source.Href) > 4096 || len(source.Title) > 500 {
				return nil, nil, common.NewMessage("Invalid Playground message.")
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
			return nil, nil, err
		}
		if len(resolved) != len(ids) {
			return nil, nil, common.NewMessage("Playground attachment not found.")
		}
	}
	referenced := make([]string, 0, len(resolved))
	for id := range resolved {
		referenced = append(referenced, id)
	}
	sort.Strings(referenced)

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
		}
		// Only the message contract is persisted; unknown credential/provider fields are discarded.
		encoded, err := common.Marshal(payload)
		if err != nil {
			return nil, nil, err
		}
		total += len(encoded)
		if total > playgroundSnapshotMaxBytes {
			return nil, nil, common.NewMessage("Playground messages exceed the storage limit.")
		}
		messages = append(messages, model.PlaygroundMessage{ClientKey: payload.Key, Payload: model.LongText(encoded)})
	}
	return messages, referenced, nil
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
	var request playgroundSessionRequest
	if !decodePlaygroundRequest(c, &request) {
		return
	}
	if len(request.ClientID) > 128 {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	updates, err := encodePlaygroundSettings(request)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	messages, _, err := validatePlaygroundMessages(c.GetInt("id"), "", request.Messages, false)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	session := &model.PlaygroundSession{Title: "New conversation", Config: "{}", ParameterEnabled: "{}"}
	if title, ok := updates["title"]; ok {
		session.Title = title.(string)
	}
	if config, ok := updates["config"]; ok {
		session.Config = config.(string)
	}
	if flags, ok := updates["parameter_enabled"]; ok {
		session.ParameterEnabled = flags.(string)
	}
	if request.ClientID != "" {
		session.ClientID = &request.ClientID
	}
	if err = model.CreatePlaygroundSession(c.GetInt("id"), session, messages); err != nil {
		common.ApiError(c, err)
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
	var request playgroundSessionRequest
	if !decodePlaygroundRequest(c, &request) {
		return
	}
	if request.Revision == nil || *request.Revision < 0 {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	updates, err := encodePlaygroundSettings(request)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	session, err := model.UpdatePlaygroundSessionFields(c.GetInt("id"), c.Param("id"), *request.Revision, updates)
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

func ReplacePlaygroundMessages(c *gin.Context) {
	var request playgroundMessagesRequest
	if !decodePlaygroundRequest(c, &request) {
		return
	}
	if request.Messages == nil || request.Revision == nil || *request.Revision < 0 {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	messages, attachmentIDs, err := validatePlaygroundMessages(c.GetInt("id"), c.Param("id"), *request.Messages, true)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	revision, err := model.ReplacePlaygroundMessages(c.GetInt("id"), c.Param("id"), *request.Revision, messages, attachmentIDs)
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
