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
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

const (
	// playgroundShareRequestMaxBytes bounds the optional expiry selector. The
	// endpoint has no free-form input, so a larger body is a client mistake.
	playgroundShareRequestMaxBytes = 4 << 10
	// playgroundShareExpiryMaxDays bounds the lifetime an owner may request;
	// zero means the link does not expire on its own.
	playgroundShareExpiryMaxDays = 365
	// playgroundShareTokenMaxLength rejects nonsense tokens before hashing
	// without revealing whether a shorter token exists.
	playgroundShareTokenMaxLength = 256
)

type playgroundSessionShareRequest struct {
	// ExpiresInDays is optional: absent or zero creates a link without a
	// self-expiry. A pointer keeps an explicit zero distinguishable from a
	// missing field in validation.
	ExpiresInDays *int `json:"expires_in_days"`
}

type playgroundSessionShareResponse struct {
	Token     string `json:"token"`
	URLPath   string `json:"url_path"`
	ExpiresAt int64  `json:"expires_at"`
	CreatedAt int64  `json:"created_at"`
}

// playgroundSharedConversation is the complete public read contract. It never
// carries the owner, session id, attachment ids, model parameters, reasoning,
// sources, usage, request ids or stored attachment bytes: an anonymous viewer
// only receives the text the messages display and a summary of each tool call.
type playgroundSharedConversation struct {
	Title          string                    `json:"title"`
	OpeningMessage string                    `json:"opening_message,omitempty"`
	Messages       []playgroundSharedMessage `json:"messages"`
}

type playgroundSharedMessage struct {
	Key         string                       `json:"key"`
	From        string                       `json:"from"`
	Content     string                       `json:"content"`
	ToolCalls   []playgroundSharedToolCall   `json:"tool_calls,omitempty"`
	Attachments []playgroundSharedAttachment `json:"attachments,omitempty"`
}

type playgroundSharedToolCall struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// playgroundSharedAttachment is a placeholder for an attachment. It carries
// only the label the owner already sees on the file; no id, URL or content is
// exposed, so the public page cannot fetch the bytes.
type playgroundSharedAttachment struct {
	Filename  string `json:"filename,omitempty"`
	MediaType string `json:"media_type,omitempty"`
}

// CreatePlaygroundSessionShare creates a new public link to one owned
// conversation. The plaintext token is returned once and never stored; every
// older link of the same conversation is revoked in the same transaction.
func CreatePlaygroundSessionShare(c *gin.Context) {
	sessionID := c.Param("id")
	expiresInDays := 0
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, playgroundShareRequestMaxBytes))
	if err != nil {
		common.ApiErrorStatus(c, http.StatusRequestEntityTooLarge, common.NewMessage("Playground request is too large."), gin.H{"code": "PLAYGROUND_REQUEST_TOO_LARGE"})
		return
	}
	if len(bytes.TrimSpace(body)) > 0 {
		var request playgroundSessionShareRequest
		if err := common.Unmarshal(body, &request); err != nil {
			writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
			return
		}
		if request.ExpiresInDays != nil {
			expiresInDays = *request.ExpiresInDays
			if expiresInDays < 0 || expiresInDays > playgroundShareExpiryMaxDays {
				writePlaygroundError(c, common.NewMessage("Share link expiration must be between 0 and 365 days."))
				return
			}
		}
	}
	share, token, err := model.CreatePlaygroundSessionShare(c.GetInt("id"), sessionID, expiresInDays)
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundSessionShareResponse{
		Token:     token,
		URLPath:   "/share/" + token,
		ExpiresAt: share.ExpiresAt,
		CreatedAt: share.CreatedAt,
	})
}

// DeletePlaygroundSessionShare revokes every active link of one owned
// conversation. Repeating the call succeeds, which lets a client retry a
// revocation without special handling.
func DeletePlaygroundSessionShare(c *gin.Context) {
	if err := model.RevokePlaygroundSessionShare(c.GetInt("id"), c.Param("id")); err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"revoked": true})
}

// GetSharedPlaygroundSession serves the anonymous read-only snapshot. The
// handler marks every response as unindexable and non-referring; the token
// itself never appears in the response body.
func GetSharedPlaygroundSession(c *gin.Context) {
	c.Header("X-Robots-Tag", "noindex, nofollow, noarchive")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Content-Type-Options", "nosniff")
	token := strings.TrimSpace(c.Param("token"))
	if token == "" || len(token) > playgroundShareTokenMaxLength {
		writePlaygroundShareNotFound(c)
		return
	}
	snapshot, err := model.LoadPlaygroundSharedSession(token)
	if errors.Is(err, model.ErrPlaygroundShareNotFound) {
		writePlaygroundShareNotFound(c)
		return
	}
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundSharedConversation{
		Title:          snapshot.Session.Title,
		OpeningMessage: string(snapshot.Session.OpeningMessage),
		Messages:       playgroundSharedMessages(snapshot.Messages),
	})
}

func writePlaygroundShareNotFound(c *gin.Context) {
	common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Shared conversation not found."), gin.H{"code": "PLAYGROUND_SHARE_NOT_FOUND"})
}

// playgroundSharedMessages sanitizes stored payloads for the public view. Only
// the active version of a user or assistant message is included, and only its
// text, tool-call name/status and attachment labels survive. Invalid stored
// JSON or a version the owner cannot currently see is omitted rather than
// echoed.
func playgroundSharedMessages(stored []model.PlaygroundMessage) []playgroundSharedMessage {
	messages := make([]playgroundSharedMessage, 0, len(stored))
	for index := range stored {
		var payload playgroundMessagePayload
		if err := common.UnmarshalJsonStr(string(stored[index].Payload), &payload); err != nil {
			continue
		}
		if payload.From != "user" && payload.From != "assistant" {
			continue
		}
		activeIndex := 0
		if payload.ActiveVersionIndex != nil {
			activeIndex = *payload.ActiveVersionIndex
		}
		if activeIndex < 0 || activeIndex >= len(payload.Versions) {
			continue
		}
		version := payload.Versions[activeIndex]
		message := playgroundSharedMessage{
			Key:     payload.Key,
			From:    payload.From,
			Content: version.Content,
		}
		if message.Key == "" {
			message.Key = stored[index].ClientKey
		}
		for _, toolCall := range version.ToolCalls {
			if toolCall.Name == "" {
				continue
			}
			message.ToolCalls = append(message.ToolCalls, playgroundSharedToolCall{Name: toolCall.Name, Status: toolCall.Status})
		}
		for _, attachment := range version.Attachments {
			message.Attachments = append(message.Attachments, playgroundSharedAttachment{
				Filename:  attachment.Filename,
				MediaType: attachment.MediaType,
			})
		}
		// A version that displays nothing is not worth a public bubble. An
		// attachment-only or tool-call-only message still carries information.
		if message.Content == "" && len(message.ToolCalls) == 0 && len(message.Attachments) == 0 {
			continue
		}
		messages = append(messages, message)
	}
	return messages
}
