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
package middleware

import (
	"encoding/json"
	"net/http"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
)

const (
	playgroundEmbeddingMaxInputs      = 64
	playgroundEmbeddingMaxInputRunes  = 16000
	playgroundRerankMaxCandidates     = 32
	playgroundRerankMaxQueryRunes     = 16000
	playgroundRerankMaxCandidateRunes = 16000
	playgroundModerationMaxInputs     = 64
	playgroundModerationMaxInputRunes = 16000

	playgroundEmbeddingLimitMessage  = "Embedding requests accept up to 64 inputs of 16,000 characters each."
	playgroundRerankLimitMessage     = "Rerank requests accept a query of up to 16,000 characters and up to 32 candidates of 16,000 characters each."
	playgroundModerationLimitMessage = "Moderation requests accept up to 64 inputs of 16,000 characters each."

	playgroundEmbeddingLimitCode  types.ErrorCode = "PLAYGROUND_EMBEDDING_LIMIT_EXCEEDED"
	playgroundRerankLimitCode     types.ErrorCode = "PLAYGROUND_RERANK_LIMIT_EXCEEDED"
	playgroundModerationLimitCode types.ErrorCode = "PLAYGROUND_MODERATION_LIMIT_EXCEEDED"
)

// validatePlaygroundNonChatParameters bounds the inputs of the non-chat model
// workbench before channel selection and billing start. The body is parsed
// through the reusable storage, so the relay still receives the original bytes
// and a rejected request never consumes quota. Only explicit size limits are
// rejected here; required-field validation stays in the relay so direct /v1
// callers keep their existing errors.
func validatePlaygroundNonChatParameters(c *gin.Context, canonicalPath string) bool {
	switch canonicalPath {
	case "/v1/embeddings":
		return validatePlaygroundEmbeddingInputs(c)
	case "/v1/rerank":
		return validatePlaygroundRerankInputs(c)
	case "/v1/moderations":
		return validatePlaygroundModerationInputs(c)
	default:
		return true
	}
}

func validatePlaygroundEmbeddingInputs(c *gin.Context) bool {
	request := playgroundNonChatJSONBody(c)
	raw, exists := request["input"]
	if !exists || string(raw) == "null" {
		return true
	}
	items, ok := playgroundNonChatInputItems(raw)
	if !ok {
		return true
	}
	if len(items) > playgroundEmbeddingMaxInputs || playgroundNonChatItemsTooLong(items, playgroundEmbeddingMaxInputRunes) {
		abortWithOpenAiMessage(c, http.StatusBadRequest, playgroundEmbeddingLimitMessage, playgroundEmbeddingLimitCode)
		return false
	}
	return true
}

func validatePlaygroundModerationInputs(c *gin.Context) bool {
	request := playgroundNonChatJSONBody(c)
	raw, exists := request["input"]
	if !exists || string(raw) == "null" {
		return true
	}
	items, ok := playgroundNonChatInputItems(raw)
	if !ok {
		return true
	}
	if len(items) > playgroundModerationMaxInputs || playgroundNonChatItemsTooLong(items, playgroundModerationMaxInputRunes) {
		abortWithOpenAiMessage(c, http.StatusBadRequest, playgroundModerationLimitMessage, playgroundModerationLimitCode)
		return false
	}
	return true
}

func validatePlaygroundRerankInputs(c *gin.Context) bool {
	request := playgroundNonChatJSONBody(c)
	if raw, exists := request["query"]; exists && string(raw) != "null" {
		var query string
		if err := common.Unmarshal(raw, &query); err != nil || utf8.RuneCountInString(query) > playgroundRerankMaxQueryRunes {
			abortWithOpenAiMessage(c, http.StatusBadRequest, playgroundRerankLimitMessage, playgroundRerankLimitCode)
			return false
		}
	}
	raw, exists := request["documents"]
	if !exists || string(raw) == "null" {
		return true
	}
	var documents []any
	if err := common.Unmarshal(raw, &documents); err != nil {
		return true
	}
	if len(documents) > playgroundRerankMaxCandidates || playgroundNonChatItemsTooLong(documents, playgroundRerankMaxCandidateRunes) {
		abortWithOpenAiMessage(c, http.StatusBadRequest, playgroundRerankLimitMessage, playgroundRerankLimitCode)
		return false
	}
	return true
}

// playgroundNonChatInputItems accepts the string-or-string-array shape used by
// embeddings and moderations. Moderation providers also accept multimodal
// objects, so a non-string item is still bounded by its serialized size.
func playgroundNonChatInputItems(raw json.RawMessage) ([]any, bool) {
	var value any
	if err := common.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	switch input := value.(type) {
	case string:
		return []any{input}, true
	case []any:
		return input, true
	default:
		return nil, false
	}
}

// playgroundNonChatItemsTooLong measures the text of each item. A plain string
// counts by runes; any structured item (a rerank document object, a moderation
// image part) is measured by its serialized JSON so it cannot bypass the cap.
func playgroundNonChatItemsTooLong(items []any, maxRunes int) bool {
	for _, item := range items {
		if text, ok := item.(string); ok {
			if utf8.RuneCountInString(text) > maxRunes {
				return true
			}
			continue
		}
		serialized, err := common.Marshal(item)
		if err != nil || utf8.RuneCount(serialized) > maxRunes {
			return true
		}
	}
	return false
}

func playgroundNonChatJSONBody(c *gin.Context) map[string]json.RawMessage {
	var request map[string]json.RawMessage
	if err := common.UnmarshalBodyReusable(c, &request); err != nil {
		// The relay renders its own invalid-request error for the same body.
		return map[string]json.RawMessage{}
	}
	return request
}
