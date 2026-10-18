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

// Package documenttext extracts the plain text of document attachments (PDF,
// plain text, Markdown) so the server can inject it as conversation context.
// Extraction is bounded on purpose: the caller's limits decide how much text
// and how many PDF pages are read, and every failure is a typed error the
// caller caches and maps to a stable client code.
package documenttext

import (
	"errors"
	"fmt"
	"unicode/utf8"
)

var (
	// ErrUnsupported reports a media type without a text extractor.
	ErrUnsupported = errors.New("document text: unsupported media type")
	// ErrUnreadable reports bytes whose document structure cannot be scanned,
	// for example an encrypted or corrupt PDF.
	ErrUnreadable = errors.New("document text: document is unreadable")
	// ErrNoText reports a readable document that carries no extractable text,
	// for example a scan consisting of page images only.
	ErrNoText = errors.New("document text: document has no text")
	// ErrLimit reports a document above the caller's text or page limit.
	ErrLimit = errors.New("document text: document exceeds the extraction limits")
)

// Limits bound one extraction. MaxTextBytes caps the extracted text and
// MaxPages caps the page count of a PDF; both must be positive, so a
// misconfigured policy can never disable the bounds.
type Limits struct {
	MaxTextBytes int64
	MaxPages     int
}

// Result is the text extracted from one document.
type Result struct {
	Text      string
	PageCount int
}

// Extract returns the text of one document in the requested media type. The
// caller has already verified that the bytes match the declared type.
func Extract(mediaType string, data []byte, limits Limits) (Result, error) {
	if limits.MaxTextBytes <= 0 || limits.MaxPages <= 0 {
		return Result{}, fmt.Errorf("%w: invalid extraction limits", ErrLimit)
	}
	switch mediaType {
	case "text/plain", "text/markdown":
		return extractPlainText(data, limits)
	case "application/pdf":
		return extractPDFText(data, limits)
	default:
		return Result{}, ErrUnsupported
	}
}

// extractPlainText normalizes the line endings of a text document. The upload
// signature check already proved the bytes are UTF-8; a document that no longer
// decodes means the stored bytes do not match the declared type.
func extractPlainText(data []byte, limits Limits) (Result, error) {
	if !utf8.Valid(data) {
		return Result{}, ErrUnreadable
	}
	text := normalizeDocumentLineEndings(string(data))
	if text == "" {
		return Result{}, ErrNoText
	}
	if int64(len(text)) > limits.MaxTextBytes {
		return Result{}, ErrLimit
	}
	return Result{Text: text}, nil
}
