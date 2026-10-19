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
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

// The document request allows base64 expansion of one 16 MiB source file plus
// the JSON envelope; the chunk request allows the largest policy-compliant
// index (500 chunks x 4 KiB text + a 4096-dimension vector each).
const (
	playgroundKnowledgeMetadataRequestMaxBytes = 4 << 10
	playgroundKnowledgeDocumentRequestMaxBytes = 24 << 20
	playgroundKnowledgeChunksRequestMaxBytes   = 32 << 20
)

type playgroundKnowledgeBaseCreateRequest struct {
	ClientKey      string `json:"client_key"`
	Name           string `json:"name"`
	EmbeddingModel string `json:"embedding_model"`
}

type playgroundKnowledgeBaseUpdateRequest struct {
	Name           *string `json:"name"`
	EmbeddingModel *string `json:"embedding_model"`
}

type playgroundKnowledgeDocumentCreateRequest struct {
	ClientKey string `json:"client_key"`
	MediaType string `json:"media_type"`
	Filename  string `json:"filename"`
	Data      string `json:"data"`
}

type playgroundKnowledgeDocumentFailureRequest struct {
	Message string `json:"message"`
}

type playgroundKnowledgeChunkRequest struct {
	Index     int    `json:"index"`
	Text      string `json:"text"`
	Embedding string `json:"embedding"`
}

type playgroundKnowledgeChunksRequest struct {
	EmbeddingModel string                            `json:"embedding_model"`
	Dims           int                               `json:"dims"`
	Chunks         []playgroundKnowledgeChunkRequest `json:"chunks"`
}

type playgroundKnowledgeBaseResponse struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	EmbeddingModel string `json:"embedding_model"`
	DocumentCount  int64  `json:"document_count"`
	ChunkCount     int64  `json:"chunk_count"`
	ByteSize       int64  `json:"byte_size"`
	CreatedAt      int64  `json:"created_at"`
	UpdatedAt      int64  `json:"updated_at"`
}

type playgroundKnowledgeDocumentResponse struct {
	ID              string `json:"id"`
	KnowledgeBaseID string `json:"knowledge_base_id"`
	Filename        string `json:"filename"`
	MediaType       string `json:"media_type"`
	ByteSize        int64  `json:"byte_size"`
	TextBytes       int64  `json:"text_bytes"`
	PageCount       int    `json:"page_count"`
	Status          string `json:"status"`
	ErrorMessage    string `json:"error_message"`
	EmbeddingModel  string `json:"embedding_model"`
	EmbeddingDims   int    `json:"embedding_dims"`
	ChunkCount      int    `json:"chunk_count"`
	CreatedAt       int64  `json:"created_at"`
	UpdatedAt       int64  `json:"updated_at"`
	Text            string `json:"text,omitempty"`
}

func writePlaygroundKnowledgeError(c *gin.Context, err error) {
	// Extraction failures already have their stable document codes shared with
	// conversation attachments.
	if errors.Is(err, model.ErrPlaygroundDocumentUnsupported) ||
		errors.Is(err, model.ErrPlaygroundDocumentLimit) ||
		errors.Is(err, model.ErrPlaygroundDocumentUnreadable) ||
		errors.Is(err, model.ErrPlaygroundDocumentNoText) {
		writePlaygroundAttachmentError(c, err)
		return
	}
	status, code, message := http.StatusInternalServerError, "PLAYGROUND_STORAGE_ERROR", "Unable to load or save Playground knowledge bases."
	switch {
	case errors.Is(err, model.ErrPlaygroundKnowledgeBaseNotFound), errors.Is(err, model.ErrPlaygroundKnowledgeDocumentNotFound):
		status, code, message = http.StatusNotFound, "PLAYGROUND_NOT_FOUND", err.Error()
	case errors.Is(err, model.ErrPlaygroundKnowledgeConflict):
		status, code, message = http.StatusConflict, "PLAYGROUND_KNOWLEDGE_CONFLICT", err.Error()
	case errors.Is(err, model.ErrPlaygroundKnowledgeInvalid):
		status, code, message = http.StatusBadRequest, "PLAYGROUND_INVALID_REQUEST", err.Error()
	case errors.Is(err, model.ErrPlaygroundKnowledgeEmbedding):
		status, code, message = http.StatusBadRequest, "PLAYGROUND_KNOWLEDGE_EMBEDDING_INVALID", err.Error()
	case errors.Is(err, model.ErrPlaygroundKnowledgeEmbeddingModel):
		status, code, message = http.StatusBadRequest, "PLAYGROUND_KNOWLEDGE_EMBEDDING_MODEL_MISMATCH", err.Error()
	case errors.Is(err, model.ErrPlaygroundKnowledgeBaseLimit):
		status, code, message = http.StatusUnprocessableEntity, "PLAYGROUND_KNOWLEDGE_BASE_LIMIT_EXCEEDED", err.Error()
	case errors.Is(err, model.ErrPlaygroundKnowledgeDocumentLimit):
		status, code, message = http.StatusUnprocessableEntity, "PLAYGROUND_KNOWLEDGE_DOCUMENT_LIMIT_EXCEEDED", err.Error()
	case errors.Is(err, model.ErrPlaygroundKnowledgeChunkLimit):
		status, code, message = http.StatusUnprocessableEntity, "PLAYGROUND_KNOWLEDGE_CHUNK_LIMIT_EXCEEDED", err.Error()
	case errors.Is(err, model.ErrPlaygroundKnowledgeTextLimit):
		status, code, message = http.StatusUnprocessableEntity, "PLAYGROUND_KNOWLEDGE_TEXT_LIMIT_EXCEEDED", err.Error()
	case errors.Is(err, model.ErrPlaygroundKnowledgeStorage):
		status, code, message = http.StatusInternalServerError, "PLAYGROUND_STORAGE_ERROR", err.Error()
	default:
		var apiMessage *common.Message
		if errors.As(err, &apiMessage) {
			writePlaygroundError(c, err)
			return
		}
	}
	common.ApiErrorStatus(c, status, common.NewMessage(message), gin.H{"code": code})
}

func playgroundDecodeKnowledgeBase(view *model.PlaygroundKnowledgeBaseView) playgroundKnowledgeBaseResponse {
	return playgroundKnowledgeBaseResponse{
		ID: view.Base.ID, Name: view.Base.Name, EmbeddingModel: view.Base.EmbeddingModel,
		DocumentCount: view.Stats.DocumentCount, ChunkCount: view.Stats.ChunkCount, ByteSize: view.Stats.ByteSize,
		CreatedAt: view.Base.CreatedAt, UpdatedAt: view.Base.UpdatedAt,
	}
}

func playgroundDecodeKnowledgeDocument(document *model.PlaygroundKnowledgeDocument, includeText bool) playgroundKnowledgeDocumentResponse {
	response := playgroundKnowledgeDocumentResponse{
		ID: document.ID, KnowledgeBaseID: document.KnowledgeBaseID,
		Filename: document.Filename, MediaType: document.MediaType,
		ByteSize: document.ByteSize, TextBytes: document.TextBytes, PageCount: document.PageCount,
		Status: document.Status, ErrorMessage: document.ErrorMessage,
		EmbeddingModel: document.EmbeddingModel, EmbeddingDims: document.EmbeddingDims,
		ChunkCount: document.ChunkCount, CreatedAt: document.CreatedAt, UpdatedAt: document.UpdatedAt,
	}
	if includeText && document.Text != nil {
		response.Text = string(*document.Text)
	}
	return response
}

func ListPlaygroundKnowledgeBases(c *gin.Context) {
	views, err := model.ListPlaygroundKnowledgeBases(c.GetInt("id"))
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	items := make([]playgroundKnowledgeBaseResponse, 0, len(views))
	for index := range views {
		items = append(items, playgroundDecodeKnowledgeBase(&views[index]))
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": len(items)})
}

func GetPlaygroundKnowledgeBase(c *gin.Context) {
	view, err := model.GetPlaygroundKnowledgeBaseView(c.GetInt("id"), c.Param("kbId"))
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeKnowledgeBase(view))
}

func CreatePlaygroundKnowledgeBase(c *gin.Context) {
	var request playgroundKnowledgeBaseCreateRequest
	if !decodePlaygroundRequest(c, &request, playgroundKnowledgeMetadataRequestMaxBytes) {
		return
	}
	base, created, err := model.CreatePlaygroundKnowledgeBase(c.GetInt("id"), request.ClientKey, request.Name, request.EmbeddingModel)
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"created":        created,
		"knowledge_base": playgroundDecodeKnowledgeBase(&model.PlaygroundKnowledgeBaseView{Base: *base}),
	})
}

func UpdatePlaygroundKnowledgeBase(c *gin.Context) {
	var request playgroundKnowledgeBaseUpdateRequest
	if !decodePlaygroundRequest(c, &request, playgroundKnowledgeMetadataRequestMaxBytes) {
		return
	}
	if request.Name == nil && request.EmbeddingModel == nil {
		writePlaygroundKnowledgeError(c, model.ErrPlaygroundKnowledgeInvalid)
		return
	}
	base, err := model.GetPlaygroundKnowledgeBase(c.GetInt("id"), c.Param("kbId"))
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	name, embeddingModel := base.Name, base.EmbeddingModel
	if request.Name != nil {
		name = *request.Name
	}
	if request.EmbeddingModel != nil {
		embeddingModel = *request.EmbeddingModel
	}
	updated, err := model.UpdatePlaygroundKnowledgeBase(c.GetInt("id"), c.Param("kbId"), name, embeddingModel)
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	view, err := model.GetPlaygroundKnowledgeBaseView(c.GetInt("id"), updated.ID)
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeKnowledgeBase(view))
}

func DeletePlaygroundKnowledgeBase(c *gin.Context) {
	if err := model.DeletePlaygroundKnowledgeBase(c.GetInt("id"), c.Param("kbId")); err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("kbId")})
}

func ListPlaygroundKnowledgeDocuments(c *gin.Context) {
	documents, err := model.ListPlaygroundKnowledgeDocuments(c.GetInt("id"), c.Param("kbId"))
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	items := make([]playgroundKnowledgeDocumentResponse, 0, len(documents))
	for index := range documents {
		items = append(items, playgroundDecodeKnowledgeDocument(&documents[index], false))
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": len(items)})
}

func GetPlaygroundKnowledgeDocument(c *gin.Context) {
	document, err := model.GetPlaygroundKnowledgeDocument(c.GetInt("id"), c.Param("kbId"), c.Param("documentId"))
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeKnowledgeDocument(document, true))
}

func CreatePlaygroundKnowledgeDocument(c *gin.Context) {
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	var request playgroundKnowledgeDocumentCreateRequest
	if !decodePlaygroundRequest(c, &request, playgroundKnowledgeDocumentRequestMaxBytes) {
		return
	}
	data, err := base64.StdEncoding.DecodeString(request.Data)
	if err != nil {
		writePlaygroundKnowledgeError(c, model.ErrPlaygroundKnowledgeInvalid)
		return
	}
	document, created, err := model.CreatePlaygroundKnowledgeDocument(c.Request.Context(), c.GetInt("id"), c.Param("kbId"), model.PlaygroundKnowledgeDocumentInput{
		ClientKey: request.ClientKey, MediaType: request.MediaType, Filename: request.Filename, Data: data,
	})
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"created":  created,
		"document": playgroundDecodeKnowledgeDocument(document, true),
	})
}

func DeletePlaygroundKnowledgeDocument(c *gin.Context) {
	if err := model.DeletePlaygroundKnowledgeDocument(c.GetInt("id"), c.Param("kbId"), c.Param("documentId")); err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("documentId")})
}

func ReindexPlaygroundKnowledgeDocument(c *gin.Context) {
	document, err := model.ResetPlaygroundKnowledgeDocumentIndex(c.GetInt("id"), c.Param("kbId"), c.Param("documentId"))
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeKnowledgeDocument(document, true))
}

func FailPlaygroundKnowledgeDocument(c *gin.Context) {
	var request playgroundKnowledgeDocumentFailureRequest
	if !decodePlaygroundRequest(c, &request, playgroundKnowledgeMetadataRequestMaxBytes) {
		return
	}
	document, err := model.MarkPlaygroundKnowledgeDocumentFailed(c.GetInt("id"), c.Param("kbId"), c.Param("documentId"), request.Message)
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeKnowledgeDocument(document, false))
}

func ReplacePlaygroundKnowledgeDocumentChunks(c *gin.Context) {
	var request playgroundKnowledgeChunksRequest
	if !decodePlaygroundRequest(c, &request, playgroundKnowledgeChunksRequestMaxBytes) {
		return
	}
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	if request.Dims <= 0 || request.Dims > policy.KnowledgeBaseEmbeddingMaxDims ||
		len(request.Chunks) == 0 || len(request.Chunks) > policy.KnowledgeBaseChunkMaxCount {
		writePlaygroundKnowledgeError(c, model.ErrPlaygroundKnowledgeInvalid)
		return
	}
	chunks := make([]model.PlaygroundKnowledgeChunkInput, 0, len(request.Chunks))
	for index := range request.Chunks {
		chunk := &request.Chunks[index]
		embedding, err := base64.StdEncoding.DecodeString(chunk.Embedding)
		if err != nil || !model.ValidatePlaygroundKnowledgeEmbedding(embedding, request.Dims) {
			writePlaygroundKnowledgeError(c, model.ErrPlaygroundKnowledgeEmbedding)
			return
		}
		chunks = append(chunks, model.PlaygroundKnowledgeChunkInput{Index: chunk.Index, Text: chunk.Text, Embedding: embedding})
	}
	document, err := model.ReplacePlaygroundKnowledgeDocumentChunks(c.GetInt("id"), c.Param("kbId"), c.Param("documentId"), request.EmbeddingModel, request.Dims, chunks)
	if err != nil {
		writePlaygroundKnowledgeError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeKnowledgeDocument(document, false))
}
