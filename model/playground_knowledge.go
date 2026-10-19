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
package model

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service/documenttext"
	"github.com/QuantumNous/new-api/service/objectstore"
	"github.com/QuantumNous/new-api/setting/playground_setting"

	"gorm.io/gorm"
)

// Playground knowledge bases (plan LB-07). A knowledge base is an account-owned
// collection of documents; every document keeps its original bytes in the
// shared object store, the text extracted by the CH-05 reader, and the embedding
// chunks the browser computes through the ordinary /pg/embeddings relay. The
// server never calls an embedding provider itself: indexing is a client-driven
// pipeline whose inputs and outputs are validated and stored here, with the
// same group, channel and billing rules as every other Playground request.

const (
	// Knowledge document indexing states. Upload starts pending; a successful
	// chunk replacement makes the document ready, and a client-reported
	// embedding failure keeps the extracted text so a later reindex can retry
	// without uploading the file again.
	PlaygroundKnowledgeDocumentStatusPending = "pending"
	PlaygroundKnowledgeDocumentStatusReady   = "ready"
	PlaygroundKnowledgeDocumentStatusFailed  = "failed"

	// playgroundKnowledgeObjectTimeout bounds one object-store operation.
	playgroundKnowledgeObjectTimeout = 30 * time.Second
	// playgroundKnowledgeErrorLength bounds a client-reported failure message
	// so it can never overflow its column.
	playgroundKnowledgeErrorLength = 500
	// playgroundKnowledgeChunkPrefix names generated chunk ids.
	playgroundKnowledgeChunkPrefix = "pgkc_"
)

var (
	ErrPlaygroundKnowledgeBaseNotFound     = errors.New("Playground knowledge base not found.")
	ErrPlaygroundKnowledgeDocumentNotFound = errors.New("Playground knowledge document not found.")
	ErrPlaygroundKnowledgeInvalid          = errors.New("Invalid Playground knowledge base request.")
	ErrPlaygroundKnowledgeConflict         = errors.New("Playground knowledge base request ID was already used for different content.")
	ErrPlaygroundKnowledgeBaseLimit        = errors.New("Playground knowledge base limit exceeded.")
	ErrPlaygroundKnowledgeDocumentLimit    = errors.New("Playground knowledge document limit exceeded.")
	ErrPlaygroundKnowledgeChunkLimit       = errors.New("Playground knowledge chunk limit exceeded.")
	ErrPlaygroundKnowledgeTextLimit        = errors.New("A knowledge chunk exceeds the text size limit.")
	ErrPlaygroundKnowledgeEmbedding        = errors.New("The knowledge chunk embedding is invalid.")
	ErrPlaygroundKnowledgeEmbeddingModel   = errors.New("The knowledge chunk embedding model does not match the knowledge base.")
	ErrPlaygroundKnowledgeStorage          = errors.New("Playground knowledge base storage is unavailable.")
)

// PlaygroundKnowledgeBase is one account-owned document collection. The
// embedding model is stored with the base because every chunk of every
// document must come from that model: a document indexed with another model is
// reported as stale and can be reindexed.
type PlaygroundKnowledgeBase struct {
	ID     string `json:"id" gorm:"size:32;primaryKey"`
	UserID int    `json:"user_id" gorm:"not null;uniqueIndex:uk_playground_knowledge_base_client,priority:1;index:idx_playground_knowledge_base_user,priority:1"`
	// ClientKeyHash makes base creation idempotent: a retry after a lost
	// response returns the stored base instead of creating a duplicate.
	ClientKeyHash  string `json:"-" gorm:"size:64;not null;uniqueIndex:uk_playground_knowledge_base_client,priority:2"`
	Name           string `json:"name" gorm:"size:100;not null"`
	EmbeddingModel string `json:"embedding_model" gorm:"size:100;not null"`
	CreatedAt      int64  `json:"created_at" gorm:"not null"`
	UpdatedAt      int64  `json:"updated_at" gorm:"not null;index:idx_playground_knowledge_base_user,priority:2"`
}

func (PlaygroundKnowledgeBase) TableName() string {
	return "playground_knowledge_bases"
}

// PlaygroundKnowledgeDocument is one uploaded source file of a knowledge base.
// Original bytes live in the object store, Text is the CH-05 extraction kept for
// reindexing, and chunks store the vectors computed by the browser.
type PlaygroundKnowledgeDocument struct {
	ID              string `json:"id" gorm:"size:32;primaryKey"`
	UserID          int    `json:"user_id" gorm:"not null;uniqueIndex:uk_playground_knowledge_document_client,priority:1;index:idx_playground_knowledge_document_owner,priority:1"`
	KnowledgeBaseID string `json:"knowledge_base_id" gorm:"size:32;not null;index:idx_playground_knowledge_document_owner,priority:2"`
	ClientKeyHash   string `json:"-" gorm:"size:64;not null;uniqueIndex:uk_playground_knowledge_document_client,priority:2"`
	Filename        string `json:"filename" gorm:"size:255;not null"`
	MediaType       string `json:"media_type" gorm:"size:100;not null"`
	ByteSize        int64  `json:"byte_size" gorm:"not null"`
	ContentHash     string `json:"-" gorm:"size:64;not null"`
	StorageBackend  string `json:"-" gorm:"size:32"`
	ObjectKey       string `json:"-" gorm:"size:512"`
	// Text is the extracted plain text. It stays after a failed or reset
	// indexing attempt, so reindexing never needs the original upload again.
	Text         *LongText `json:"-"`
	TextBytes    int64     `json:"text_bytes" gorm:"not null;default:0"`
	PageCount    int       `json:"page_count" gorm:"not null;default:0"`
	Status       string    `json:"status" gorm:"size:16;not null"`
	ErrorMessage string    `json:"error_message" gorm:"size:500;not null;default:''"`
	// EmbeddingModel and EmbeddingDims describe the chunks stored last. A base
	// whose model changed reports every ready document as stale until it is
	// reindexed.
	EmbeddingModel string `json:"embedding_model" gorm:"size:100;not null;default:''"`
	EmbeddingDims  int    `json:"embedding_dims" gorm:"not null;default:0"`
	ChunkCount     int    `json:"chunk_count" gorm:"not null;default:0"`
	CreatedAt      int64  `json:"created_at" gorm:"not null"`
	UpdatedAt      int64  `json:"updated_at" gorm:"not null"`
}

func (PlaygroundKnowledgeDocument) TableName() string {
	return "playground_knowledge_documents"
}

// PlaygroundKnowledgeChunk is one embedded slice of a document. Embedding holds
// dims little-endian float32 values as opaque bytes: the server validates the
// size and finiteness, stores it verbatim, and never needs a database-specific
// vector type.
type PlaygroundKnowledgeChunk struct {
	ID              string   `json:"id" gorm:"size:32;primaryKey"`
	UserID          int      `json:"user_id" gorm:"not null;index:idx_playground_knowledge_chunk_owner,priority:1"`
	KnowledgeBaseID string   `json:"knowledge_base_id" gorm:"size:32;not null;index:idx_playground_knowledge_chunk_owner,priority:2"`
	DocumentID      string   `json:"document_id" gorm:"size:32;not null;uniqueIndex:uk_playground_knowledge_chunk_position,priority:1;index:idx_playground_knowledge_chunk_document"`
	ChunkIndex      int      `json:"chunk_index" gorm:"not null;uniqueIndex:uk_playground_knowledge_chunk_position,priority:2"`
	Text            LongText `json:"text" gorm:"not null"`
	ByteSize        int64    `json:"byte_size" gorm:"not null"`
	EmbeddingModel  string   `json:"embedding_model" gorm:"size:100;not null"`
	EmbeddingDims   int      `json:"embedding_dims" gorm:"not null"`
	Embedding       []byte   `json:"embedding" gorm:"not null"`
	CreatedAt       int64    `json:"created_at" gorm:"not null"`
	UpdatedAt       int64    `json:"updated_at" gorm:"not null"`
}

func (PlaygroundKnowledgeChunk) TableName() string {
	return "playground_knowledge_chunks"
}

// PlaygroundKnowledgeBaseStats is the owner-scoped footprint of one base.
type PlaygroundKnowledgeBaseStats struct {
	DocumentCount int64 `json:"document_count"`
	ChunkCount    int64 `json:"chunk_count"`
	ByteSize      int64 `json:"byte_size"`
}

// PlaygroundKnowledgeBaseView is one base together with the counts the manager
// displays. It is never persisted.
type PlaygroundKnowledgeBaseView struct {
	Base  PlaygroundKnowledgeBase
	Stats PlaygroundKnowledgeBaseStats
}

// PlaygroundKnowledgeDocumentInput is one upload of a knowledge document. The
// client key makes the upload idempotent.
type PlaygroundKnowledgeDocumentInput struct {
	ClientKey string
	MediaType string
	Filename  string
	Data      []byte
}

// PlaygroundKnowledgeChunkInput is one client-computed chunk. Index must equal
// the position in the submitted slice, Text is the source slice, and Embedding
// is the little-endian float32 vector produced by the embedding relay.
type PlaygroundKnowledgeChunkInput struct {
	Index     int
	Text      string
	Embedding []byte
}

// ValidatePlaygroundKnowledgeEmbedding reports whether one opaque embedding is
// exactly dims finite float32 values. NaN and infinities are rejected because
// they cannot be compared or serialized meaningfully.
func ValidatePlaygroundKnowledgeEmbedding(embedding []byte, dims int) bool {
	if dims <= 0 || len(embedding) != dims*4 {
		return false
	}
	for offset := 0; offset < len(embedding); offset += 4 {
		value := math.Float32frombits(binary.LittleEndian.Uint32(embedding[offset:]))
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return false
		}
	}
	return true
}

func playgroundKnowledgeBaseClientKeyHash(clientKey string) string {
	hash := sha256.Sum256([]byte(clientKey))
	return hex.EncodeToString(hash[:])
}

func playgroundKnowledgeDocumentContentHash(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// normalizePlaygroundKnowledgeEmbeddingModel validates the model identifier
// stored with a base. The server does not maintain an embedding model catalog:
// the identifier is passed to the ordinary relay, which resolves channels and
// prices it like any other request.
func normalizePlaygroundKnowledgeEmbeddingModel(model string) (string, error) {
	model = strings.TrimSpace(model)
	if model == "" || utf8.RuneCountInString(model) > 100 {
		return "", ErrPlaygroundKnowledgeInvalid
	}
	for _, character := range model {
		if character == 0 || character < 0x20 || character == 0x7f {
			return "", ErrPlaygroundKnowledgeInvalid
		}
	}
	return model, nil
}

func normalizePlaygroundKnowledgeBaseName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 100 {
		return "", ErrPlaygroundKnowledgeInvalid
	}
	if strings.ContainsRune(name, 0) {
		return "", ErrPlaygroundKnowledgeInvalid
	}
	return name, nil
}

func playgroundKnowledgeObjectKey(userID int, createdAt int64, documentID string) string {
	month := time.Unix(createdAt, 0).UTC().Format("2006/01")
	return fmt.Sprintf("pg/%d/knowledge/%s/%s", userID, month, documentID)
}

// playgroundKnowledgeStats measures one owner's bases, documents and chunks.
// The grouped queries keep listing a bounded set of bases proportional to the
// account's footprint instead of issuing one query per base.
func playgroundKnowledgeStats(tx *gorm.DB, userID int) (map[string]PlaygroundKnowledgeBaseStats, error) {
	stats := map[string]PlaygroundKnowledgeBaseStats{}
	type documentRow struct {
		KnowledgeBaseID string
		DocumentCount   int64
		DocumentBytes   int64
		TextBytes       int64
	}
	var documents []documentRow
	if err := tx.Model(&PlaygroundKnowledgeDocument{}).Where("user_id = ?", userID).
		Select("knowledge_base_id, COUNT(*) AS document_count, COALESCE(SUM(byte_size), 0) AS document_bytes, COALESCE(SUM(text_bytes), 0) AS text_bytes").
		Group("knowledge_base_id").Scan(&documents).Error; err != nil {
		return nil, err
	}
	for _, row := range documents {
		stats[row.KnowledgeBaseID] = PlaygroundKnowledgeBaseStats{
			DocumentCount: row.DocumentCount,
			ByteSize:      row.DocumentBytes + row.TextBytes,
		}
	}
	type chunkRow struct {
		KnowledgeBaseID string
		ChunkCount      int64
		ChunkBytes      int64
	}
	var chunks []chunkRow
	if err := tx.Model(&PlaygroundKnowledgeChunk{}).Where("user_id = ?", userID).
		Select("knowledge_base_id, COUNT(*) AS chunk_count, COALESCE(SUM(byte_size), 0) AS chunk_bytes").
		Group("knowledge_base_id").Scan(&chunks).Error; err != nil {
		return nil, err
	}
	for _, row := range chunks {
		entry := stats[row.KnowledgeBaseID]
		entry.ChunkCount = row.ChunkCount
		entry.ByteSize += row.ChunkBytes
		stats[row.KnowledgeBaseID] = entry
	}
	return stats, nil
}

// ListPlaygroundKnowledgeBases lists the owner's bases newest first with their
// live document, chunk and byte counts.
func ListPlaygroundKnowledgeBases(userID int) ([]PlaygroundKnowledgeBaseView, error) {
	if userID <= 0 {
		return nil, nil
	}
	var bases []PlaygroundKnowledgeBase
	if err := DB.Where("user_id = ?", userID).Order("updated_at DESC, id ASC").Find(&bases).Error; err != nil {
		return nil, err
	}
	stats, err := playgroundKnowledgeStats(DB, userID)
	if err != nil {
		return nil, err
	}
	views := make([]PlaygroundKnowledgeBaseView, 0, len(bases))
	for index := range bases {
		views = append(views, PlaygroundKnowledgeBaseView{Base: bases[index], Stats: stats[bases[index].ID]})
	}
	return views, nil
}

// GetPlaygroundKnowledgeBase resolves one owner-scoped base.
func GetPlaygroundKnowledgeBase(userID int, knowledgeBaseID string) (*PlaygroundKnowledgeBase, error) {
	var base PlaygroundKnowledgeBase
	err := DB.Where("id = ? AND user_id = ?", knowledgeBaseID, userID).First(&base).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundKnowledgeBaseNotFound
	}
	if err != nil {
		return nil, err
	}
	return &base, nil
}

// GetPlaygroundKnowledgeBaseView resolves one base together with its counts.
func GetPlaygroundKnowledgeBaseView(userID int, knowledgeBaseID string) (*PlaygroundKnowledgeBaseView, error) {
	base, err := GetPlaygroundKnowledgeBase(userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	stats, err := playgroundKnowledgeStats(DB, userID)
	if err != nil {
		return nil, err
	}
	return &PlaygroundKnowledgeBaseView{Base: *base, Stats: stats[base.ID]}, nil
}

// CreatePlaygroundKnowledgeBase creates one base under the account's count
// budget. The client key is idempotent: the same key returns the stored base
// while a different payload under the same key is a conflict.
func CreatePlaygroundKnowledgeBase(userID int, clientKey, name, embeddingModel string) (*PlaygroundKnowledgeBase, bool, error) {
	if userID <= 0 {
		return nil, false, gorm.ErrRecordNotFound
	}
	clientKey = strings.TrimSpace(clientKey)
	if clientKey == "" || len(clientKey) > 200 || !utf8.ValidString(clientKey) || strings.ContainsRune(clientKey, 0) {
		return nil, false, ErrPlaygroundKnowledgeInvalid
	}
	name, err := normalizePlaygroundKnowledgeBaseName(name)
	if err != nil {
		return nil, false, err
	}
	embeddingModel, err = normalizePlaygroundKnowledgeEmbeddingModel(embeddingModel)
	if err != nil {
		return nil, false, err
	}
	clientKeyHash := playgroundKnowledgeBaseClientKeyHash(clientKey)
	var existing PlaygroundKnowledgeBase
	err = DB.Where("user_id = ? AND client_key_hash = ?", userID, clientKeyHash).First(&existing).Error
	if err == nil {
		if existing.Name != name || existing.EmbeddingModel != embeddingModel {
			return nil, false, ErrPlaygroundKnowledgeConflict
		}
		return &existing, false, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, err
	}

	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return nil, false, err
	}
	now := common.GetTimestamp()
	base := &PlaygroundKnowledgeBase{
		ID: "pgkb_" + key, UserID: userID, ClientKeyHash: clientKeyHash,
		Name: name, EmbeddingModel: embeddingModel, CreatedAt: now, UpdatedAt: now,
	}
	err = DB.Transaction(func(tx *gorm.DB) error {
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		if usage.KnowledgeBaseCount >= int64(policy.KnowledgeBaseUserMaxCount) {
			return ErrPlaygroundKnowledgeBaseLimit
		}
		if err := tx.Create(base).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{KnowledgeBaseCount: 1})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		// A concurrent create with the same client key may have won the unique
		// index; an identical replay acknowledges that winner.
		if findErr := DB.Where("user_id = ? AND client_key_hash = ?", userID, clientKeyHash).First(&existing).Error; findErr == nil {
			if existing.Name != name || existing.EmbeddingModel != embeddingModel {
				return nil, false, ErrPlaygroundKnowledgeConflict
			}
			return &existing, false, nil
		}
		return nil, false, err
	}
	return base, true, nil
}

// UpdatePlaygroundKnowledgeBase renames a base and/or changes its embedding
// model. Changing the model does not delete chunks: the manager marks older
// documents stale through the stored per-document model and offers reindexing.
func UpdatePlaygroundKnowledgeBase(userID int, knowledgeBaseID, name, embeddingModel string) (*PlaygroundKnowledgeBase, error) {
	name, err := normalizePlaygroundKnowledgeBaseName(name)
	if err != nil {
		return nil, err
	}
	embeddingModel, err = normalizePlaygroundKnowledgeEmbeddingModel(embeddingModel)
	if err != nil {
		return nil, err
	}
	var base PlaygroundKnowledgeBase
	err = DB.Transaction(func(tx *gorm.DB) error {
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", knowledgeBaseID, userID).First(&base).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundKnowledgeBaseNotFound
			}
			return err
		}
		base.Name = name
		base.EmbeddingModel = embeddingModel
		base.UpdatedAt = common.GetTimestamp()
		return tx.Model(&PlaygroundKnowledgeBase{}).Where("id = ? AND user_id = ?", base.ID, userID).Updates(map[string]any{
			"name":            base.Name,
			"embedding_model": base.EmbeddingModel,
			"updated_at":      base.UpdatedAt,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return &base, nil
}

// DeletePlaygroundKnowledgeBase removes one base, its documents and chunks, and
// releases the stored objects through the delete outbox. Every counter change is
// applied to the locked account row in the same transaction.
func DeletePlaygroundKnowledgeBase(userID int, knowledgeBaseID string) error {
	var queued []playgroundQueuedObjectDelete
	err := DB.Transaction(func(tx *gorm.DB) error {
		var base PlaygroundKnowledgeBase
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", knowledgeBaseID, userID).First(&base).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundKnowledgeBaseNotFound
			}
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		var documents []PlaygroundKnowledgeDocument
		if err := tx.Select("id", "byte_size", "text_bytes", "object_key", "storage_backend").
			Where("user_id = ? AND knowledge_base_id = ?", userID, knowledgeBaseID).Find(&documents).Error; err != nil {
			return err
		}
		var chunks struct {
			ChunkCount int64
			ChunkBytes int64
		}
		if err := tx.Model(&PlaygroundKnowledgeChunk{}).Where("user_id = ? AND knowledge_base_id = ?", userID, knowledgeBaseID).
			Select("COUNT(*) AS chunk_count, COALESCE(SUM(byte_size), 0) AS chunk_bytes").Scan(&chunks).Error; err != nil {
			return err
		}
		var documentBytes, objectBytes int64
		objects := make([]playgroundStoredObject, 0, len(documents))
		for index := range documents {
			documentBytes += documents[index].ByteSize + documents[index].TextBytes
			if documents[index].ObjectKey != "" {
				objects = append(objects, playgroundStoredObject{ObjectKey: documents[index].ObjectKey})
				objectBytes += documents[index].ByteSize
			}
		}
		if err := tx.Where("user_id = ? AND knowledge_base_id = ?", userID, knowledgeBaseID).Delete(&PlaygroundKnowledgeChunk{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ? AND knowledge_base_id = ?", userID, knowledgeBaseID).Delete(&PlaygroundKnowledgeDocument{}).Error; err != nil {
			return err
		}
		if err := tx.Where("id = ? AND user_id = ?", knowledgeBaseID, userID).Delete(&PlaygroundKnowledgeBase{}).Error; err != nil {
			return err
		}
		queued, err = enqueuePlaygroundObjectDeletes(tx, objects, playgroundObjectOriginKnowledgeDocument)
		if err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{
			KnowledgeBaseCount:         -1,
			KnowledgeBaseDocumentCount: -int64(len(documents)),
			KnowledgeBaseChunkCount:    -chunks.ChunkCount,
			KnowledgeBaseBytes:         -(documentBytes + chunks.ChunkBytes),
			ObjectBytes:                -objectBytes,
		})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		return err
	}
	drainPlaygroundObjectDeletes(objectstore.DefaultStore(), queued)
	return nil
}

// ListPlaygroundKnowledgeDocuments lists the documents of one owner-scoped base
// newest first. The extracted text is omitted: listing can hold hundreds of
// rows and the manager reads one document when it needs the text.
func ListPlaygroundKnowledgeDocuments(userID int, knowledgeBaseID string) ([]PlaygroundKnowledgeDocument, error) {
	if _, err := GetPlaygroundKnowledgeBase(userID, knowledgeBaseID); err != nil {
		return nil, err
	}
	var documents []PlaygroundKnowledgeDocument
	err := DB.Select("id", "user_id", "knowledge_base_id", "filename", "media_type", "byte_size", "text_bytes", "page_count", "status", "error_message", "embedding_model", "embedding_dims", "chunk_count", "created_at", "updated_at").
		Where("user_id = ? AND knowledge_base_id = ?", userID, knowledgeBaseID).
		Order("created_at DESC, id ASC").Find(&documents).Error
	if err != nil {
		return nil, err
	}
	return documents, nil
}

// GetPlaygroundKnowledgeDocument resolves one owner-scoped document including
// its extracted text.
func GetPlaygroundKnowledgeDocument(userID int, knowledgeBaseID, documentID string) (*PlaygroundKnowledgeDocument, error) {
	var document PlaygroundKnowledgeDocument
	err := DB.Where("id = ? AND user_id = ? AND knowledge_base_id = ?", documentID, userID, knowledgeBaseID).First(&document).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrPlaygroundKnowledgeDocumentNotFound
	}
	if err != nil {
		return nil, err
	}
	return &document, nil
}

// CreatePlaygroundKnowledgeDocument stores one uploaded document, extracts its
// text with the CH-05 reader and keeps both under the account's document and
// byte budgets. The document stays pending until the client submits chunks.
func CreatePlaygroundKnowledgeDocument(ctx context.Context, userID int, knowledgeBaseID string, input PlaygroundKnowledgeDocumentInput) (*PlaygroundKnowledgeDocument, bool, error) {
	if userID <= 0 {
		return nil, false, gorm.ErrRecordNotFound
	}
	policy, err := PlaygroundQuotaPolicyForUser(userID)
	if err != nil {
		return nil, false, err
	}
	attachmentInput := PlaygroundAttachmentInput{ClientKey: input.ClientKey, MediaType: input.MediaType, Filename: input.Filename, Data: input.Data}
	if err := normalizePlaygroundAttachmentText(&attachmentInput); err != nil {
		return nil, false, ErrPlaygroundKnowledgeInvalid
	}
	if !IsPlaygroundDocumentMediaType(attachmentInput.MediaType) {
		return nil, false, ErrPlaygroundKnowledgeInvalid
	}
	if err := ValidatePlaygroundAttachmentInput(&attachmentInput, policy.AttachmentDocumentMaxFileBytes); err != nil {
		if errors.Is(err, ErrPlaygroundAttachmentLimit) {
			return nil, false, ErrPlaygroundDocumentLimit
		}
		return nil, false, ErrPlaygroundKnowledgeInvalid
	}
	clientKeyHash := playgroundKnowledgeBaseClientKeyHash(attachmentInput.ClientKey)
	contentHash := playgroundKnowledgeDocumentContentHash(attachmentInput.Data)
	var existing PlaygroundKnowledgeDocument
	err = DB.Where("user_id = ? AND client_key_hash = ?", userID, clientKeyHash).First(&existing).Error
	if err == nil {
		if existing.KnowledgeBaseID != knowledgeBaseID || existing.MediaType != attachmentInput.MediaType ||
			existing.Filename != attachmentInput.Filename || existing.ContentHash != contentHash {
			return nil, false, ErrPlaygroundKnowledgeConflict
		}
		return &existing, false, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, err
	}

	extracted, err := documenttext.Extract(attachmentInput.MediaType, attachmentInput.Data, documenttext.Limits{
		MaxTextBytes: policy.DocumentTextMaxBytes,
		MaxPages:     policy.DocumentTextMaxPages,
	})
	if err != nil {
		switch {
		case errors.Is(err, documenttext.ErrLimit):
			return nil, false, ErrPlaygroundDocumentLimit
		case errors.Is(err, documenttext.ErrNoText):
			return nil, false, ErrPlaygroundDocumentNoText
		case errors.Is(err, documenttext.ErrUnsupported):
			return nil, false, ErrPlaygroundDocumentUnsupported
		default:
			return nil, false, ErrPlaygroundDocumentUnreadable
		}
	}

	store := objectstore.DefaultStore()
	if store == nil {
		return nil, false, ErrPlaygroundKnowledgeStorage
	}
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return nil, false, err
	}
	now := common.GetTimestamp()
	documentID := "pgkd_" + key
	objectKey := playgroundKnowledgeObjectKey(userID, now, documentID)
	info, err := store.Put(ctx, objectKey, bytes.NewReader(attachmentInput.Data))
	if err != nil {
		return nil, false, err
	}
	if info.Size != int64(len(attachmentInput.Data)) {
		deletePlaygroundKnowledgeObject(store, objectKey)
		return nil, false, errors.New("Playground knowledge object store wrote an unexpected size.")
	}

	text := LongText(extracted.Text)
	document := &PlaygroundKnowledgeDocument{
		ID: documentID, UserID: userID, KnowledgeBaseID: knowledgeBaseID,
		ClientKeyHash: clientKeyHash, Filename: attachmentInput.Filename,
		MediaType: attachmentInput.MediaType, ByteSize: int64(len(attachmentInput.Data)),
		ContentHash: contentHash, StorageBackend: store.Backend(), ObjectKey: objectKey,
		Text: &text, TextBytes: int64(len(extracted.Text)), PageCount: extracted.PageCount,
		Status: PlaygroundKnowledgeDocumentStatusPending, CreatedAt: now, UpdatedAt: now,
	}
	err = DB.Transaction(func(tx *gorm.DB) error {
		var base PlaygroundKnowledgeBase
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", knowledgeBaseID, userID).First(&base).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundKnowledgeBaseNotFound
			}
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		if int64(len(attachmentInput.Data)) > policy.AttachmentDocumentMaxFileBytes {
			return ErrPlaygroundDocumentLimit
		}
		var documentCount int64
		if err := tx.Model(&PlaygroundKnowledgeDocument{}).
			Where("user_id = ? AND knowledge_base_id = ?", userID, knowledgeBaseID).Count(&documentCount).Error; err != nil {
			return err
		}
		if documentCount >= int64(policy.KnowledgeBaseDocumentMaxCount) {
			return ErrPlaygroundKnowledgeDocumentLimit
		}
		if usage.KnowledgeBaseDocumentCount >= int64(policy.KnowledgeBaseDocumentUserMaxCount) {
			return ErrPlaygroundKnowledgeDocumentLimit
		}
		addedBytes := document.ByteSize + document.TextBytes
		if usage.KnowledgeBaseBytes+addedBytes > policy.KnowledgeBaseUserMaxBytes {
			return ErrPlaygroundKnowledgeDocumentLimit
		}
		if usage.ObjectBytes+document.ByteSize > policy.ObjectUserMaxBytes {
			return ErrPlaygroundKnowledgeDocumentLimit
		}
		if err := tx.Create(document).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{
			KnowledgeBaseDocumentCount: 1,
			KnowledgeBaseBytes:         addedBytes,
			ObjectBytes:                document.ByteSize,
		})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		deletePlaygroundKnowledgeObject(store, objectKey)
		if findErr := DB.Where("user_id = ? AND client_key_hash = ?", userID, clientKeyHash).First(&existing).Error; findErr == nil {
			if existing.KnowledgeBaseID != knowledgeBaseID || existing.MediaType != attachmentInput.MediaType ||
				existing.Filename != attachmentInput.Filename || existing.ContentHash != contentHash {
				return nil, false, ErrPlaygroundKnowledgeConflict
			}
			return &existing, false, nil
		}
		return nil, false, err
	}
	return document, true, nil
}

// DeletePlaygroundKnowledgeDocument removes one document and its chunks under
// the account budgets and queues the stored object for deletion.
func DeletePlaygroundKnowledgeDocument(userID int, knowledgeBaseID, documentID string) error {
	var queued []playgroundQueuedObjectDelete
	err := DB.Transaction(func(tx *gorm.DB) error {
		var base PlaygroundKnowledgeBase
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", knowledgeBaseID, userID).First(&base).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundKnowledgeBaseNotFound
			}
			return err
		}
		var document PlaygroundKnowledgeDocument
		if err := lockForUpdate(tx).Select("id", "byte_size", "text_bytes", "object_key").
			Where("id = ? AND user_id = ? AND knowledge_base_id = ?", documentID, userID, knowledgeBaseID).First(&document).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundKnowledgeDocumentNotFound
			}
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		var chunks struct {
			ChunkCount int64
			ChunkBytes int64
		}
		if err := tx.Model(&PlaygroundKnowledgeChunk{}).Where("document_id = ? AND user_id = ?", documentID, userID).
			Select("COUNT(*) AS chunk_count, COALESCE(SUM(byte_size), 0) AS chunk_bytes").Scan(&chunks).Error; err != nil {
			return err
		}
		if err := tx.Where("document_id = ? AND user_id = ?", documentID, userID).Delete(&PlaygroundKnowledgeChunk{}).Error; err != nil {
			return err
		}
		if err := tx.Where("id = ? AND user_id = ?", documentID, userID).Delete(&PlaygroundKnowledgeDocument{}).Error; err != nil {
			return err
		}
		objects := []playgroundStoredObject{}
		if document.ObjectKey != "" {
			objects = append(objects, playgroundStoredObject{ObjectKey: document.ObjectKey})
		}
		queued, err = enqueuePlaygroundObjectDeletes(tx, objects, playgroundObjectOriginKnowledgeDocument)
		if err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{
			KnowledgeBaseDocumentCount: -1,
			KnowledgeBaseChunkCount:    -chunks.ChunkCount,
			KnowledgeBaseBytes:         -(document.ByteSize + document.TextBytes + chunks.ChunkBytes),
			ObjectBytes:                -document.ByteSize,
		})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		return err
	}
	drainPlaygroundObjectDeletes(objectstore.DefaultStore(), queued)
	return nil
}

// ResetPlaygroundKnowledgeDocumentIndex releases the chunks of one document so
// the client can recompute them. The extracted text and the stored source file
// stay in place, so the retry never needs another upload.
func ResetPlaygroundKnowledgeDocumentIndex(userID int, knowledgeBaseID, documentID string) (*PlaygroundKnowledgeDocument, error) {
	var document PlaygroundKnowledgeDocument
	err := DB.Transaction(func(tx *gorm.DB) error {
		var base PlaygroundKnowledgeBase
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", knowledgeBaseID, userID).First(&base).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundKnowledgeBaseNotFound
			}
			return err
		}
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND knowledge_base_id = ?", documentID, userID, knowledgeBaseID).First(&document).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundKnowledgeDocumentNotFound
			}
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		var chunks struct {
			ChunkCount int64
			ChunkBytes int64
		}
		if err := tx.Model(&PlaygroundKnowledgeChunk{}).Where("document_id = ? AND user_id = ?", documentID, userID).
			Select("COUNT(*) AS chunk_count, COALESCE(SUM(byte_size), 0) AS chunk_bytes").Scan(&chunks).Error; err != nil {
			return err
		}
		if err := tx.Where("document_id = ? AND user_id = ?", documentID, userID).Delete(&PlaygroundKnowledgeChunk{}).Error; err != nil {
			return err
		}
		document.Status = PlaygroundKnowledgeDocumentStatusPending
		document.ErrorMessage = ""
		document.EmbeddingModel = ""
		document.EmbeddingDims = 0
		document.ChunkCount = 0
		document.UpdatedAt = common.GetTimestamp()
		if err := tx.Model(&PlaygroundKnowledgeDocument{}).Where("id = ? AND user_id = ?", documentID, userID).Updates(map[string]any{
			"status":          document.Status,
			"error_message":   document.ErrorMessage,
			"embedding_model": document.EmbeddingModel,
			"embedding_dims":  document.EmbeddingDims,
			"chunk_count":     document.ChunkCount,
			"updated_at":      document.UpdatedAt,
		}).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{
			KnowledgeBaseChunkCount: -chunks.ChunkCount,
			KnowledgeBaseBytes:      -chunks.ChunkBytes,
		})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		return nil, err
	}
	return &document, nil
}

// MarkPlaygroundKnowledgeDocumentFailed records a client-side embedding failure
// without losing the extracted text. A later reset and retry can index it again.
func MarkPlaygroundKnowledgeDocumentFailed(userID int, knowledgeBaseID, documentID, message string) (*PlaygroundKnowledgeDocument, error) {
	message = strings.TrimSpace(message)
	if runes := []rune(message); len(runes) > playgroundKnowledgeErrorLength {
		message = string(runes[:playgroundKnowledgeErrorLength])
	}
	document, err := GetPlaygroundKnowledgeDocument(userID, knowledgeBaseID, documentID)
	if err != nil {
		return nil, err
	}
	document.Status = PlaygroundKnowledgeDocumentStatusFailed
	document.ErrorMessage = message
	document.UpdatedAt = common.GetTimestamp()
	if err := DB.Model(&PlaygroundKnowledgeDocument{}).Where("id = ? AND user_id = ?", documentID, userID).Updates(map[string]any{
		"status":        document.Status,
		"error_message": document.ErrorMessage,
		"updated_at":    document.UpdatedAt,
	}).Error; err != nil {
		return nil, err
	}
	return document, nil
}

// ReplacePlaygroundKnowledgeDocumentChunks stores one complete set of embedded
// chunks for a document, replacing any previous set atomically. The server
// validates the embedding model, dimensions and sizes again: the client
// computed the vectors, but the stored data and every budget stay server
// enforced.
func ReplacePlaygroundKnowledgeDocumentChunks(userID int, knowledgeBaseID, documentID, embeddingModel string, dims int, chunks []PlaygroundKnowledgeChunkInput) (*PlaygroundKnowledgeDocument, error) {
	if len(chunks) == 0 {
		return nil, ErrPlaygroundKnowledgeInvalid
	}
	var document PlaygroundKnowledgeDocument
	err := DB.Transaction(func(tx *gorm.DB) error {
		var base PlaygroundKnowledgeBase
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", knowledgeBaseID, userID).First(&base).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundKnowledgeBaseNotFound
			}
			return err
		}
		if base.EmbeddingModel != embeddingModel {
			return ErrPlaygroundKnowledgeEmbeddingModel
		}
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND knowledge_base_id = ?", documentID, userID, knowledgeBaseID).First(&document).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundKnowledgeDocumentNotFound
			}
			return err
		}
		usage, err := lockPlaygroundUserUsage(tx, userID)
		if err != nil {
			return err
		}
		policy, err := playgroundPolicyForUser(tx, userID)
		if err != nil {
			return err
		}
		if dims <= 0 || dims > policy.KnowledgeBaseEmbeddingMaxDims {
			return ErrPlaygroundKnowledgeEmbedding
		}
		if len(chunks) > policy.KnowledgeBaseChunkMaxCount {
			return ErrPlaygroundKnowledgeChunkLimit
		}
		newChunkBytes := int64(0)
		for index := range chunks {
			chunk := &chunks[index]
			if chunk.Index != index || strings.TrimSpace(chunk.Text) == "" {
				return ErrPlaygroundKnowledgeInvalid
			}
			if int64(len(chunk.Text)) > policy.KnowledgeBaseChunkTextMaxBytes {
				return ErrPlaygroundKnowledgeTextLimit
			}
			if !utf8.ValidString(chunk.Text) || strings.ContainsRune(chunk.Text, 0) {
				return ErrPlaygroundKnowledgeInvalid
			}
			if !ValidatePlaygroundKnowledgeEmbedding(chunk.Embedding, dims) {
				return ErrPlaygroundKnowledgeEmbedding
			}
			newChunkBytes += int64(len(chunk.Text)) + int64(len(chunk.Embedding))
		}
		var previous struct {
			ChunkCount int64
			ChunkBytes int64
		}
		if err := tx.Model(&PlaygroundKnowledgeChunk{}).Where("document_id = ? AND user_id = ?", documentID, userID).
			Select("COUNT(*) AS chunk_count, COALESCE(SUM(byte_size), 0) AS chunk_bytes").Scan(&previous).Error; err != nil {
			return err
		}
		if usage.KnowledgeBaseChunkCount-previous.ChunkCount+int64(len(chunks)) > int64(policy.KnowledgeBaseChunkUserMaxCount) {
			return ErrPlaygroundKnowledgeChunkLimit
		}
		if usage.KnowledgeBaseBytes-previous.ChunkBytes+newChunkBytes > policy.KnowledgeBaseUserMaxBytes {
			return ErrPlaygroundKnowledgeChunkLimit
		}
		if err := tx.Where("document_id = ? AND user_id = ?", documentID, userID).Delete(&PlaygroundKnowledgeChunk{}).Error; err != nil {
			return err
		}
		now := common.GetTimestamp()
		rows := make([]PlaygroundKnowledgeChunk, 0, len(chunks))
		for index := range chunks {
			key, err := common.GenerateRandomCharsKey(24)
			if err != nil {
				return err
			}
			chunk := &chunks[index]
			rows = append(rows, PlaygroundKnowledgeChunk{
				ID: playgroundKnowledgeChunkPrefix + key, UserID: userID,
				KnowledgeBaseID: knowledgeBaseID, DocumentID: documentID, ChunkIndex: chunk.Index,
				Text: LongText(chunk.Text), ByteSize: int64(len(chunk.Text)) + int64(len(chunk.Embedding)),
				EmbeddingModel: embeddingModel, EmbeddingDims: dims, Embedding: chunk.Embedding,
				CreatedAt: now, UpdatedAt: now,
			})
		}
		if err := tx.CreateInBatches(rows, 100).Error; err != nil {
			return err
		}
		document.Status = PlaygroundKnowledgeDocumentStatusReady
		document.ErrorMessage = ""
		document.EmbeddingModel = embeddingModel
		document.EmbeddingDims = dims
		document.ChunkCount = len(chunks)
		document.UpdatedAt = now
		if err := tx.Model(&PlaygroundKnowledgeDocument{}).Where("id = ? AND user_id = ?", documentID, userID).Updates(map[string]any{
			"status":          document.Status,
			"error_message":   document.ErrorMessage,
			"embedding_model": document.EmbeddingModel,
			"embedding_dims":  document.EmbeddingDims,
			"chunk_count":     document.ChunkCount,
			"updated_at":      document.UpdatedAt,
		}).Error; err != nil {
			return err
		}
		usage.apply(playgroundUserUsageDelta{
			KnowledgeBaseChunkCount: int64(len(chunks)) - previous.ChunkCount,
			KnowledgeBaseBytes:      newChunkBytes - previous.ChunkBytes,
		})
		return savePlaygroundUserUsage(tx, usage)
	})
	if err != nil {
		return nil, err
	}
	return &document, nil
}

// deletePlaygroundKnowledgeObject removes one stored document object. The error
// is logged and ignored on the request path because the delete outbox keeps the
// durable retry.
func deletePlaygroundKnowledgeObject(store objectstore.Store, objectKey string) {
	if objectKey == "" {
		return
	}
	if store == nil {
		store = objectstore.DefaultStore()
	}
	if store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), playgroundKnowledgeObjectTimeout)
	defer cancel()
	if err := store.Delete(ctx, objectKey); err != nil && !errors.Is(err, objectstore.ErrObjectNotFound) {
		common.SysError(common.LogText("failed to delete Playground knowledge object %s: %s", objectKey, err.Error()))
	}
}
