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
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service/objectstore"
	"github.com/gin-gonic/gin"
)

// The request allows for base64 expansion of one maximum-size attachment plus
// the JSON envelope.
const playgroundAttachmentRequestMaxBytes = 12 << 20

type playgroundAttachmentRequest struct {
	ClientKey string `json:"client_key"`
	MediaType string `json:"media_type"`
	Filename  string `json:"filename"`
	Data      string `json:"data"`
}

type playgroundAttachmentResponse struct {
	Created   bool   `json:"created,omitempty"`
	ID        string `json:"id"`
	ClientKey string `json:"client_key,omitempty"`
	SessionID string `json:"session_id"`
	MediaType string `json:"media_type"`
	Filename  string `json:"filename"`
	ByteSize  int64  `json:"byte_size"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

func writePlaygroundAttachmentError(c *gin.Context, err error) {
	status, code, message := http.StatusInternalServerError, "PLAYGROUND_STORAGE_ERROR", "Unable to load or save Playground attachments."
	switch {
	case errors.Is(err, model.ErrPlaygroundSessionNotFound):
		status, code, message = http.StatusNotFound, "PLAYGROUND_NOT_FOUND", "Playground conversation not found."
	case errors.Is(err, model.ErrPlaygroundCanvasNotFound):
		// A canvas-scoped upload of an unknown or foreign project is a 404,
		// exactly like the conversation case.
		status, code, message = http.StatusNotFound, "PLAYGROUND_NOT_FOUND", err.Error()
	case errors.Is(err, model.ErrPlaygroundAttachmentNotFound):
		status, code, message = http.StatusNotFound, "PLAYGROUND_NOT_FOUND", err.Error()
	case errors.Is(err, model.ErrPlaygroundAttachmentConflict):
		status, code, message = http.StatusConflict, "PLAYGROUND_ATTACHMENT_REQUEST_CONFLICT", err.Error()
	case errors.Is(err, model.ErrPlaygroundAttachmentInUse):
		status, code, message = http.StatusConflict, "PLAYGROUND_ATTACHMENT_IN_USE", err.Error()
	case errors.Is(err, model.ErrPlaygroundAttachmentLimit):
		status, code, message = http.StatusUnprocessableEntity, "PLAYGROUND_ATTACHMENT_LIMIT_EXCEEDED", err.Error()
	case errors.Is(err, model.ErrPlaygroundAttachmentInvalid):
		status, code, message = http.StatusBadRequest, "PLAYGROUND_INVALID_REQUEST", err.Error()
	}
	common.ApiErrorStatus(c, status, common.NewMessage(message), gin.H{"code": code})
}

func decodePlaygroundAttachmentRequest(c *gin.Context, target any) bool {
	if c.GetInt("id") <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, playgroundAttachmentRequestMaxBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			common.ApiErrorStatus(c, http.StatusRequestEntityTooLarge, common.NewMessage("Playground request is too large."), gin.H{"code": "PLAYGROUND_REQUEST_TOO_LARGE"})
		} else {
			writePlaygroundAttachmentError(c, model.ErrPlaygroundAttachmentInvalid)
		}
		return false
	}
	if !utf8.Valid(body) || common.Unmarshal(body, target) != nil {
		writePlaygroundAttachmentError(c, model.ErrPlaygroundAttachmentInvalid)
		return false
	}
	return true
}

func playgroundDecodeAttachment(attachment *model.PlaygroundAttachment, clientKey string, created bool) playgroundAttachmentResponse {
	return playgroundAttachmentResponse{
		Created: created, ID: attachment.ID, ClientKey: clientKey, SessionID: attachment.SessionID,
		MediaType: attachment.MediaType, Filename: attachment.Filename, ByteSize: attachment.ByteSize,
		CreatedAt: attachment.CreatedAt, UpdatedAt: attachment.UpdatedAt,
	}
}

// decodePlaygroundAttachmentUpload reads one upload request and decodes its
// payload for either attachment partition (a conversation or a canvas).
func decodePlaygroundAttachmentUpload(c *gin.Context) (model.PlaygroundAttachmentInput, bool) {
	var request playgroundAttachmentRequest
	if !decodePlaygroundAttachmentRequest(c, &request) {
		return model.PlaygroundAttachmentInput{}, false
	}
	data, err := base64.StdEncoding.DecodeString(request.Data)
	if err != nil {
		writePlaygroundAttachmentError(c, model.ErrPlaygroundAttachmentInvalid)
		return model.PlaygroundAttachmentInput{}, false
	}
	return model.PlaygroundAttachmentInput{
		ClientKey: request.ClientKey,
		MediaType: request.MediaType,
		Filename:  request.Filename,
		Data:      data,
	}, true
}

// respondPlaygroundAttachmentUpload writes the stored attachment or maps the
// failure of either upload partition to its stable error code.
func respondPlaygroundAttachmentUpload(c *gin.Context, input model.PlaygroundAttachmentInput, attachment *model.PlaygroundAttachment, created bool, err error) {
	if err != nil {
		writePlaygroundAttachmentError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeAttachment(attachment, input.ClientKey, created))
}

func CreatePlaygroundAttachment(c *gin.Context) {
	// 欠款只读：有未结清欠款的账号不能上传新附件（读取与导出不受影响）。
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	input, ok := decodePlaygroundAttachmentUpload(c)
	if !ok {
		return
	}
	attachment, created, err := model.CreatePlaygroundAttachment(c.Request.Context(), c.GetInt("id"), c.Param("id"), input)
	respondPlaygroundAttachmentUpload(c, input, attachment, created, err)
}

// CreatePlaygroundCanvasAttachment stores one upload of the canvas workspace.
// The canvas id is the attachment partition: the model layer locks the project
// row for the account before anything is written, so a foreign or missing
// canvas answers exactly like a foreign conversation.
func CreatePlaygroundCanvasAttachment(c *gin.Context) {
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	input, ok := decodePlaygroundAttachmentUpload(c)
	if !ok {
		return
	}
	attachment, created, err := model.CreatePlaygroundCanvasAttachment(c.Request.Context(), c.GetInt("id"), c.Param("canvasId"), input)
	respondPlaygroundAttachmentUpload(c, input, attachment, created, err)
}

func ListPlaygroundAttachments(c *gin.Context) {
	page, ok := playgroundStrictPage(c)
	if !ok {
		writePlaygroundAttachmentError(c, model.ErrPlaygroundAttachmentInvalid)
		return
	}
	attachments, total, err := model.ListPlaygroundAttachments(c.GetInt("id"), c.Param("id"), page.GetStartIdx(), page.PageSize)
	if err != nil {
		writePlaygroundAttachmentError(c, err)
		return
	}
	items := make([]playgroundAttachmentResponse, 0, len(attachments))
	for index := range attachments {
		items = append(items, playgroundDecodeAttachment(&attachments[index], "", false))
	}
	page.SetItems(items)
	page.SetTotal(int(total))
	common.ApiSuccess(c, page)
}

func GetPlaygroundAttachment(c *gin.Context) {
	attachment, err := model.GetPlaygroundAttachment(c.GetInt("id"), c.Param("id"), c.Param("attachmentId"))
	if err != nil {
		writePlaygroundAttachmentError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeAttachment(attachment, "", false))
}

func GetPlaygroundAttachmentContent(c *gin.Context) {
	attachment, err := model.GetPlaygroundAttachment(c.GetInt("id"), c.Param("id"), c.Param("attachmentId"))
	if err != nil {
		writePlaygroundAttachmentError(c, err)
		return
	}
	// Rows written before the object store existed, and rows restored during a
	// rollback, keep their bytes inline in the database.
	if attachment.StoredInDatabase() {
		if attachment.Data == nil {
			writePlaygroundAttachmentError(c, errors.New("stored attachment data is missing"))
			return
		}
		data, err := base64.StdEncoding.DecodeString(string(*attachment.Data))
		if err != nil {
			writePlaygroundAttachmentError(c, errors.New("decoded attachment is invalid"))
			return
		}
		// Inline rendering is restricted to the stored media type, and the
		// filename is wrapped so it can never split the response headers.
		c.Header("Content-Disposition", "inline; filename*=UTF-8''"+url.PathEscape(attachment.Filename))
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Content-Security-Policy", "sandbox; default-src 'none'")
		c.Header("Referrer-Policy", "no-referrer")
		c.Data(http.StatusOK, attachment.MediaType, data)
		return
	}
	store := objectstore.DefaultStore()
	if store == nil {
		writePlaygroundAttachmentError(c, errors.New("Playground attachment object store is not configured."))
		return
	}
	// Attachments are private; neither the redirect nor the streamed body may
	// be cached by shared proxies.
	c.Header("Cache-Control", "private, no-store")
	// A backend that hands out short-lived presigned links (S3 compatible)
	// redirects instead of streaming through the gateway. Only absolute
	// http(s) links are trusted; anything else falls back to streaming.
	if location, presignErr := store.PresignGet(c.Request.Context(), attachment.ObjectKey, objectstore.DefaultPresignTTL()); presignErr == nil {
		if parsed, parseErr := url.Parse(location); parseErr == nil && parsed.Host != "" && (parsed.Scheme == "http" || parsed.Scheme == "https") {
			c.Redirect(http.StatusFound, location)
			return
		}
	}
	if err := objectstore.Serve(c.Request.Context(), store, c.Writer, attachment.ObjectKey, objectstore.ServeOptions{
		Filename: attachment.Filename, ContentType: attachment.MediaType,
	}); err != nil && !c.Writer.Written() {
		writePlaygroundAttachmentError(c, err)
	}
}

func DeletePlaygroundAttachment(c *gin.Context) {
	if err := model.DeletePlaygroundAttachment(c.GetInt("id"), c.Param("id"), c.Param("attachmentId")); err != nil {
		writePlaygroundAttachmentError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("attachmentId")})
}
