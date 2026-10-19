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
	Kind           string                    `json:"kind,omitempty"`
	Title          string                    `json:"title"`
	OpeningMessage string                    `json:"opening_message,omitempty"`
	Messages       []playgroundSharedMessage `json:"messages"`
}

// playgroundSharedCanvas is the anonymous canvas contract. The document keeps
// only the drawing layout and the previews a node already displays; every
// reference id, provider URL, task id and stored input/error is stripped by
// playgroundSharedCanvasDocument. No endpoint below it serves material bytes.
type playgroundSharedCanvas struct {
	Kind      string                    `json:"kind"`
	Title     string                    `json:"title"`
	Document  playgroundSharedCanvasDoc `json:"document"`
	UpdatedAt int64                     `json:"updated_at,omitempty"`
}

type playgroundSharedCanvasDoc struct {
	Viewport *playgroundCanvasViewport    `json:"viewport,omitempty"`
	Nodes    []playgroundSharedCanvasNode `json:"nodes"`
	Edges    []playgroundCanvasEdge       `json:"edges"`
}

type playgroundSharedCanvasNode struct {
	ID       string                         `json:"id"`
	Type     string                         `json:"type"`
	Position playgroundCanvasPosition       `json:"position"`
	Width    *float64                       `json:"width,omitempty"`
	Height   *float64                       `json:"height,omitempty"`
	Data     playgroundSharedCanvasNodeData `json:"data"`
}

type playgroundSharedCanvasNodeData struct {
	Kind      string                        `json:"kind,omitempty"`
	Text      string                        `json:"text,omitempty"`
	Snapshot  *playgroundSharedNodeSnapshot `json:"snapshot,omitempty"`
	Label     string                        `json:"label,omitempty"`
	MediaType string                        `json:"media_type,omitempty"`
	Workflow  *playgroundSharedWorkflow     `json:"workflow,omitempty"`
	ParentID  string                        `json:"parentId,omitempty"`
}

type playgroundSharedNodeSnapshot struct {
	Role string `json:"role,omitempty"`
	Text string `json:"text,omitempty"`
}

type playgroundSharedWorkflow struct {
	Status           string `json:"status,omitempty"`
	Generation       string `json:"generation,omitempty"`
	Output           string `json:"output,omitempty"`
	ResultImageCount int    `json:"resultImageCount,omitempty"`
	Attempts         int    `json:"attempts,omitempty"`
	UpdatedAt        int64  `json:"updatedAt,omitempty"`
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

// decodePlaygroundShareExpiry reads the optional expiry selector shared by
// conversation and canvas link creation. An absent body creates a link that
// does not expire on its own.
func decodePlaygroundShareExpiry(c *gin.Context) (int, bool) {
	expiresInDays := 0
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, playgroundShareRequestMaxBytes))
	if err != nil {
		common.ApiErrorStatus(c, http.StatusRequestEntityTooLarge, common.NewMessage("Playground request is too large."), gin.H{"code": "PLAYGROUND_REQUEST_TOO_LARGE"})
		return 0, false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return 0, true
	}
	var request playgroundSessionShareRequest
	if err := common.Unmarshal(body, &request); err != nil {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return 0, false
	}
	if request.ExpiresInDays != nil {
		expiresInDays = *request.ExpiresInDays
		if expiresInDays < 0 || expiresInDays > playgroundShareExpiryMaxDays {
			writePlaygroundError(c, common.NewMessage("Share link expiration must be between 0 and 365 days."))
			return 0, false
		}
	}
	return expiresInDays, true
}

// CreatePlaygroundSessionShare creates a new public link to one owned
// conversation. The plaintext token is returned once and never stored; every
// older link of the same conversation is revoked in the same transaction.
func CreatePlaygroundSessionShare(c *gin.Context) {
	expiresInDays, ok := decodePlaygroundShareExpiry(c)
	if !ok {
		return
	}
	share, token, err := model.CreatePlaygroundSessionShare(c.GetInt("id"), c.Param("id"), expiresInDays)
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

// CreatePlaygroundCanvasShare creates a new public link to one owned canvas.
// It follows the conversation contract: the plaintext is returned once, and
// creating a link revokes every older link of the same canvas.
func CreatePlaygroundCanvasShare(c *gin.Context) {
	expiresInDays, ok := decodePlaygroundShareExpiry(c)
	if !ok {
		return
	}
	share, token, err := model.CreatePlaygroundCanvasShare(c.GetInt("id"), c.Param("canvasId"), expiresInDays)
	if err != nil {
		writePlaygroundCanvasError(c, err)
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

// DeletePlaygroundCanvasShare revokes every active link of one owned canvas.
// Repeating the call succeeds, which lets a client retry a revocation.
func DeletePlaygroundCanvasShare(c *gin.Context) {
	if err := model.RevokePlaygroundCanvasShare(c.GetInt("id"), c.Param("canvasId")); err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"revoked": true})
}

// GetSharedPlaygroundSession serves the anonymous read-only snapshot of either
// a conversation or a canvas. The handler marks every response as unindexable
// and non-referring; the token itself never appears in the response body.
func GetSharedPlaygroundSession(c *gin.Context) {
	c.Header("X-Robots-Tag", "noindex, nofollow, noarchive")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Content-Type-Options", "nosniff")
	token := strings.TrimSpace(c.Param("token"))
	if token == "" || len(token) > playgroundShareTokenMaxLength {
		writePlaygroundShareNotFound(c)
		return
	}
	target, err := model.ResolvePlaygroundSharedToken(token)
	if errors.Is(err, model.ErrPlaygroundShareNotFound) {
		writePlaygroundShareNotFound(c)
		return
	}
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	if target.Kind == model.PlaygroundShareKindCanvas {
		document, err := playgroundSharedCanvasDocument(string(target.Canvas.Document))
		if err != nil {
			writePlaygroundError(c, err)
			return
		}
		common.ApiSuccess(c, playgroundSharedCanvas{
			Kind:      model.PlaygroundShareKindCanvas,
			Title:     target.Canvas.Title,
			Document:  document,
			UpdatedAt: target.Canvas.UpdatedAt,
		})
		return
	}
	common.ApiSuccess(c, playgroundSharedConversation{
		Kind:           model.PlaygroundShareKindConversation,
		Title:          target.Session.Session.Title,
		OpeningMessage: string(target.Session.Session.OpeningMessage),
		Messages:       playgroundSharedMessages(target.Session.Messages),
	})
}

func writePlaygroundShareNotFound(c *gin.Context) {
	common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage("Shared conversation not found."), gin.H{"code": "PLAYGROUND_SHARE_NOT_FOUND"})
}

// playgroundSharedCanvasDocument rebuilds a stored canvas document from the
// fields an anonymous viewer may see. Node ids, positions, sizes, edges and
// grouping are layout data. From each node only its kind, display text/label,
// message snapshot text/role, declared media type and bounded workflow preview
// survive; every reference id, provider URL, task id, input text, error and
// generation parameter is dropped. Attachment and artifact bytes are never
// fetched: the public page can only render the text it receives here.
func playgroundSharedCanvasDocument(stored string) (playgroundSharedCanvasDoc, error) {
	var decoded playgroundCanvasDocument
	if stored == "" || common.UnmarshalJsonStr(stored, &decoded) != nil {
		return playgroundSharedCanvasDoc{}, model.ErrPlaygroundCanvasInvalid
	}
	document := playgroundSharedCanvasDoc{
		Viewport: decoded.Viewport,
		Nodes:    make([]playgroundSharedCanvasNode, 0, len(decoded.Nodes)),
		Edges:    make([]playgroundCanvasEdge, 0, len(decoded.Edges)),
	}
	knownNodes := make(map[string]bool, len(decoded.Nodes))
	for _, node := range decoded.Nodes {
		if node.ID == "" || !playgroundCanvasNodeTypes[node.Type] {
			continue
		}
		var source playgroundSharedCanvasNodeData
		if len(node.Data) > 0 && common.Unmarshal(node.Data, &source) != nil {
			continue
		}
		source.Kind = node.Type
		document.Nodes = append(document.Nodes, playgroundSharedCanvasNode{
			ID:       node.ID,
			Type:     node.Type,
			Position: node.Position,
			Width:    node.Width,
			Height:   node.Height,
			Data:     source,
		})
		knownNodes[node.ID] = true
	}
	for index := range document.Nodes {
		parentID := document.Nodes[index].Data.ParentID
		if parentID != "" && !knownNodes[parentID] {
			document.Nodes[index].Data.ParentID = ""
		}
	}
	for _, edge := range decoded.Edges {
		if !knownNodes[edge.Source] || !knownNodes[edge.Target] {
			continue
		}
		document.Edges = append(document.Edges, edge)
	}
	return document, nil
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
