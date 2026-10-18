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
	"github.com/gin-gonic/gin"
)

// The reservation body only carries metadata: the bytes either go straight to
// the object store through a presigned URL or arrive on the relay route, so the
// JSON envelope stays tiny no matter how large the file is.
const playgroundUploadRequestMaxBytes = 64 << 10

// The three ways one upload can travel. The client acts on the mode: it PUTs to
// url (presigned), PUTs to the relay content route (relay), or records the
// attachment the reservation already produced (completed).
const (
	playgroundUploadModePresigned = "presigned"
	playgroundUploadModeRelay     = "relay"
	playgroundUploadModeCompleted = "completed"
)

type playgroundUploadCreateRequest struct {
	ClientKey string `json:"client_key"`
	MediaType string `json:"media_type"`
	Filename  string `json:"filename"`
	ByteSize  int64  `json:"byte_size"`
	SessionID string `json:"session_id"`
	CanvasID  string `json:"canvas_id"`
}

type playgroundUploadResponse struct {
	ID         string                        `json:"id,omitempty"`
	Mode       string                        `json:"mode"`
	URL        string                        `json:"url,omitempty"`
	Headers    map[string]string             `json:"headers,omitempty"`
	ExpiresAt  int64                         `json:"expires_at,omitempty"`
	Attachment *playgroundAttachmentResponse `json:"attachment,omitempty"`
}

// resolvePlaygroundUploadPartition reads the owning resource of one reservation
// request. Exactly one partition id must be present, so an upload can never be
// filed against a resource the request did not name.
func resolvePlaygroundUploadPartition(c *gin.Context, request *playgroundUploadCreateRequest) (string, string, bool) {
	sessionID := strings.TrimSpace(request.SessionID)
	canvasID := strings.TrimSpace(request.CanvasID)
	if (sessionID == "") == (canvasID == "") {
		writePlaygroundAttachmentError(c, model.ErrPlaygroundAttachmentInvalid)
		return "", "", false
	}
	if sessionID != "" {
		if len(sessionID) > 128 {
			writePlaygroundAttachmentError(c, model.ErrPlaygroundAttachmentInvalid)
			return "", "", false
		}
		return model.PlaygroundUploadPartitionSession, sessionID, true
	}
	if len(canvasID) > 128 {
		writePlaygroundAttachmentError(c, model.ErrPlaygroundAttachmentInvalid)
		return "", "", false
	}
	return model.PlaygroundUploadPartitionCanvas, canvasID, true
}

// CreatePlaygroundUpload reserves the account's attachment and object budgets
// for one declared file and tells the client how to send its bytes: a presigned
// PUT straight to the object store when the backend can sign one, or the relay
// content route of this gateway otherwise. A client key that already finished
// answers with the stored attachment, so a retry after a lost response never
// uploads the same file twice.
func CreatePlaygroundUpload(c *gin.Context) {
	// 欠款只读：有未结清欠款的账号不能上传新附件（读取与导出不受影响）。
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	var request playgroundUploadCreateRequest
	if !decodePlaygroundJsonRequest(c, playgroundUploadRequestMaxBytes, &request) {
		return
	}
	partition, partitionID, ok := resolvePlaygroundUploadPartition(c, &request)
	if !ok {
		return
	}
	reservation, err := model.CreatePlaygroundUpload(c.GetInt("id"), partition, partitionID, model.PlaygroundUploadRequest{
		ClientKey: request.ClientKey,
		MediaType: request.MediaType,
		Filename:  request.Filename,
		ByteSize:  request.ByteSize,
	})
	if err != nil {
		writePlaygroundAttachmentError(c, err)
		return
	}
	if reservation.Attachment != nil {
		attachment := playgroundDecodeAttachment(reservation.Attachment, request.ClientKey, false)
		common.ApiSuccess(c, playgroundUploadResponse{Mode: playgroundUploadModeCompleted, Attachment: &attachment})
		return
	}
	upload := reservation.Upload
	location, err := model.PlaygroundUploadPresignedPut(c.Request.Context(), upload)
	if err != nil {
		// The reservation already holds the account budget; a signing failure
		// must not leak it.
		_ = model.ReleasePlaygroundUpload(upload.UserID, upload.ID)
		writePlaygroundAttachmentError(c, err)
		return
	}
	if location == "" {
		common.ApiSuccess(c, playgroundUploadResponse{
			ID: upload.ID, Mode: playgroundUploadModeRelay, ExpiresAt: upload.ExpiresAt,
		})
		return
	}
	common.ApiSuccess(c, playgroundUploadResponse{
		ID: upload.ID, Mode: playgroundUploadModePresigned, URL: location,
		Headers:   map[string]string{"Content-Type": upload.MediaType},
		ExpiresAt: upload.ExpiresAt,
	})
}

// PutPlaygroundUploadContent relays the bytes of one reservation through the
// gateway for backends that cannot hand out a presigned URL (the local object
// store). The body is bounded to the declared size plus one byte: an overlong
// body then fails as a size mismatch instead of being truncated into a valid
// attachment.
func PutPlaygroundUploadContent(c *gin.Context) {
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	upload, err := model.GetPlaygroundUpload(c.GetInt("id"), c.Param("uploadId"))
	if err != nil {
		writePlaygroundAttachmentError(c, err)
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, upload.ByteSize+1)
	written, err := model.WritePlaygroundUploadContent(c.Request.Context(), upload, c.Request.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writePlaygroundAttachmentError(c, model.ErrPlaygroundAttachmentLimit)
			return
		}
		writePlaygroundAttachmentError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": upload.ID, "byte_size": written})
}

// CompletePlaygroundUpload verifies the stored object against its reservation
// and returns the attachment it produced. The server re-checks the size and the
// leading bytes of the stored object, so a presigned upload that lied about the
// media type or the size is dropped together with its reservation.
func CompletePlaygroundUpload(c *gin.Context) {
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	attachment, created, err := model.CompletePlaygroundUpload(c.Request.Context(), c.GetInt("id"), c.Param("uploadId"))
	if err != nil {
		writePlaygroundAttachmentError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeAttachment(attachment, "", created))
}

// DeletePlaygroundUpload cancels one reservation and releases the quota it
// held, including any bytes the client already wrote.
func DeletePlaygroundUpload(c *gin.Context) {
	if err := model.ReleasePlaygroundUpload(c.GetInt("id"), c.Param("uploadId")); err != nil {
		writePlaygroundAttachmentError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("uploadId")})
}
