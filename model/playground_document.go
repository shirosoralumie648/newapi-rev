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
	"context"
	"errors"
	"io"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service/documenttext"
	"github.com/QuantumNous/new-api/setting/playground_setting"
)

// Playground attachment text extraction states, cached on the attachment row
// so a stored revision is parsed once and every later read answers with the
// same outcome.
const (
	PlaygroundDocumentTextStatusReady       = "ready"
	PlaygroundDocumentTextStatusUnsupported = "unsupported"
	PlaygroundDocumentTextStatusUnreadable  = "unreadable"
	PlaygroundDocumentTextStatusNoText      = "no_text"
	PlaygroundDocumentTextStatusLimit       = "limit"
)

// The extraction failures as typed errors. The handler maps each one to a
// stable client code, and the message doubles as the English key the web
// console localizes.
var (
	ErrPlaygroundDocumentUnsupported = errors.New("This file type cannot be read as text.")
	ErrPlaygroundDocumentLimit       = errors.New("The document is too large to read as text.")
	ErrPlaygroundDocumentUnreadable  = errors.New("The document text could not be extracted.")
	ErrPlaygroundDocumentNoText      = errors.New("The document contains no extractable text.")
)

// PlaygroundDocumentText is the extracted text of one document attachment.
type PlaygroundDocumentText struct {
	Attachment *PlaygroundAttachment
	Text       string
	PageCount  int
}

// GetPlaygroundAttachmentDocumentText resolves one document attachment of a
// conversation or canvas partition and returns its extracted text. The result
// is cached on the attachment row: the first request extracts and stores the
// outcome, every later request answers from the cache, and a failure is cached
// as well so an unsupported or unreadable document is never parsed again on
// each turn.
func GetPlaygroundAttachmentDocumentText(ctx context.Context, userID int, sessionID, attachmentID string) (*PlaygroundDocumentText, error) {
	attachment, err := GetPlaygroundAttachment(userID, sessionID, attachmentID)
	if err != nil {
		return nil, err
	}
	if attachment.TextExtractedAt == 0 {
		policy, err := PlaygroundQuotaPolicyForUser(userID)
		if err != nil {
			return nil, err
		}
		status, text, pageCount := extractPlaygroundDocumentText(ctx, attachment, policy)
		if err := cachePlaygroundDocumentText(attachment, status, text, pageCount); err != nil {
			return nil, err
		}
		// A concurrent request may have cached its outcome first. The cache is
		// authoritative either way, so the row is read back instead of trusting
		// the local result.
		stored, err := GetPlaygroundAttachment(userID, sessionID, attachmentID)
		if err != nil {
			return nil, err
		}
		attachment = stored
	}
	return playgroundDocumentTextFromAttachment(attachment)
}

// extractPlaygroundDocumentText runs the extractor over the stored bytes of one
// attachment and returns the cache fields of the outcome. Every failure is a
// state rather than an error because the outcome is stored and served from the
// cache afterwards.
func extractPlaygroundDocumentText(ctx context.Context, attachment *PlaygroundAttachment, policy playground_setting.PlaygroundQuotaPolicy) (string, string, int) {
	if !IsPlaygroundDocumentMediaType(attachment.MediaType) {
		return PlaygroundDocumentTextStatusUnsupported, "", 0
	}
	if attachment.ByteSize <= 0 || attachment.ByteSize > policy.AttachmentDocumentMaxFileBytes {
		return PlaygroundDocumentTextStatusLimit, "", 0
	}
	reader, err := OpenPlaygroundAttachmentContent(ctx, attachment)
	if err != nil {
		return PlaygroundDocumentTextStatusUnreadable, "", 0
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, attachment.ByteSize+1))
	if err != nil || int64(len(data)) != attachment.ByteSize {
		return PlaygroundDocumentTextStatusUnreadable, "", 0
	}
	result, err := documenttext.Extract(attachment.MediaType, data, documenttext.Limits{
		MaxTextBytes: policy.DocumentTextMaxBytes,
		MaxPages:     policy.DocumentTextMaxPages,
	})
	switch {
	case err == nil:
		return PlaygroundDocumentTextStatusReady, result.Text, result.PageCount
	case errors.Is(err, documenttext.ErrLimit):
		return PlaygroundDocumentTextStatusLimit, "", 0
	case errors.Is(err, documenttext.ErrNoText):
		return PlaygroundDocumentTextStatusNoText, "", 0
	case errors.Is(err, documenttext.ErrUnsupported):
		return PlaygroundDocumentTextStatusUnsupported, "", 0
	default:
		return PlaygroundDocumentTextStatusUnreadable, "", 0
	}
}

// cachePlaygroundDocumentText stores the final outcome of one extraction. The
// write only matches a row no other request cached in the meantime, so the
// first outcome of a stored revision always wins.
func cachePlaygroundDocumentText(attachment *PlaygroundAttachment, status, text string, pageCount int) error {
	var content *LongText
	if status == PlaygroundDocumentTextStatusReady {
		stored := LongText(text)
		content = &stored
	}
	return DB.Model(&PlaygroundAttachment{}).
		Where("id = ? AND user_id = ? AND text_extracted_at = 0", attachment.ID, attachment.UserID).
		Updates(map[string]any{
			"text_status":       status,
			"text_content":      content,
			"text_bytes":        int64(len(text)),
			"text_page_count":   pageCount,
			"text_extracted_at": common.GetTimestamp(),
		}).Error
}

// playgroundDocumentTextFromAttachment turns the cached state of one
// attachment row into its result or its typed extraction error.
func playgroundDocumentTextFromAttachment(attachment *PlaygroundAttachment) (*PlaygroundDocumentText, error) {
	result := &PlaygroundDocumentText{Attachment: attachment, PageCount: attachment.TextPageCount}
	if attachment.TextContent != nil {
		result.Text = string(*attachment.TextContent)
	}
	switch attachment.TextStatus {
	case PlaygroundDocumentTextStatusReady:
		return result, nil
	case PlaygroundDocumentTextStatusUnsupported:
		return nil, ErrPlaygroundDocumentUnsupported
	case PlaygroundDocumentTextStatusLimit:
		return nil, ErrPlaygroundDocumentLimit
	case PlaygroundDocumentTextStatusNoText:
		return nil, ErrPlaygroundDocumentNoText
	default:
		return nil, ErrPlaygroundDocumentUnreadable
	}
}
