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
package documenttext

import (
	"bytes"
	"compress/zlib"
	"encoding/ascii85"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"
)

const (
	// maxPDFDecompressedBytes bounds the total bytes inflated from one PDF so a
	// stream bomb cannot exhaust memory before the text limit applies.
	maxPDFDecompressedBytes = 32 << 20
	// maxPDFStreams bounds how many stream objects one document may declare.
	maxPDFStreams = 4096
	// pdfSpaceGap is the horizontal move (in text space units, which are points
	// in almost every document) that a text matrix must exceed to count as a
	// word break: per-word positioning moves by at least a word, while
	// per-glyph positioning stays far below it.
	pdfSpaceGap = 20.0
	// pdfSamePositionEpsilon is the tolerance for a vertical text position that
	// equals the previous one.
	pdfSamePositionEpsilon = 0.5
)

// errPDFStreamSkip reports that one stream cannot hold extractable text: it is
// an image or font program, its filter chain is unsupported, or its declared
// encoding does not decode.
var errPDFStreamSkip = errors.New("document text: stream is not text")

// extractPDFText reads the text-showing operators of a PDF's content streams.
// It is a small reader for the common case on purpose: Flate, ASCIIHex and
// ASCII85 streams are decoded, images, fonts and object streams are skipped,
// and a document that cannot be scanned is reported as unreadable instead of
// returning partial nonsense.
func extractPDFText(data []byte, limits Limits) (Result, error) {
	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		return Result{}, ErrUnreadable
	}
	// An encrypted document cannot be scanned: its strings are ciphertext, so a
	// permissive reader would return gibberish as text.
	if bytes.Contains(data, []byte("/Encrypt")) {
		return Result{}, ErrUnreadable
	}
	pageCount := countPDFPages(data)
	if pageCount > limits.MaxPages {
		return Result{}, ErrLimit
	}
	extractor := &pdfTextExtractor{maxTextBytes: limits.MaxTextBytes}
	budget := int64(maxPDFDecompressedBytes)
	offset := 0
	for scanned := 0; scanned < maxPDFStreams; scanned++ {
		start, dictionary := nextPDFStream(data, offset)
		if start < 0 {
			break
		}
		end := bytes.Index(data[start:], []byte("endstream"))
		if end < 0 {
			break
		}
		raw := trimPDFStreamBytes(data[start : start+end])
		offset = start + end + len("endstream")
		content, err := decodePDFStream(dictionary, raw, &budget)
		switch {
		case errors.Is(err, errPDFStreamSkip):
			continue
		case err != nil:
			return Result{}, ErrLimit
		}
		extractor.scanContent(content)
		extractor.newLine()
		if extractor.overflow {
			return Result{}, ErrLimit
		}
	}
	text := normalizePDFText(string(extractor.text))
	if text == "" {
		return Result{}, ErrNoText
	}
	return Result{Text: text, PageCount: pageCount}, nil
}

// countPDFPages reports how many pages the document declares. Visible page
// objects are counted directly; when the page tree lives inside an object
// stream (a PDF 1.5 and later option) the largest /Count of a page tree node is
// used instead, which is the number of page leaves below that node.
func countPDFPages(data []byte) int {
	if pages := countPDFPageObjects(data); pages > 0 {
		return pages
	}
	return largestPDFCountValue(data)
}

// countPDFPageObjects counts the visible page objects: a `/Type` followed by
// `/Page` with a name boundary after it, so the `/Pages` tree node never counts
// as a page.
func countPDFPageObjects(data []byte) int {
	count := 0
	for offset := 0; ; {
		index := bytes.Index(data[offset:], []byte("/Type"))
		if index < 0 {
			return count
		}
		position := offset + index + len("/Type")
		if position < len(data) && isPDFNameChar(data[position]) {
			offset = position
			continue
		}
		for position < len(data) && isPDFWhitespace(data[position]) {
			position++
		}
		if bytes.HasPrefix(data[position:], []byte("/Page")) {
			end := position + len("/Page")
			if end >= len(data) || !isPDFNameChar(data[end]) {
				count++
			}
		}
		offset = position
	}
}

// largestPDFCountValue returns the largest integer that follows a /Count name,
// which is how a page tree node declares the number of pages below it.
func largestPDFCountValue(data []byte) int {
	largest := 0
	for offset := 0; ; {
		index := bytes.Index(data[offset:], []byte("/Count"))
		if index < 0 {
			return largest
		}
		position := offset + index + len("/Count")
		if position < len(data) && isPDFNameChar(data[position]) {
			offset = position
			continue
		}
		for position < len(data) && isPDFWhitespace(data[position]) {
			position++
		}
		start := position
		for position < len(data) && data[position] >= '0' && data[position] <= '9' {
			position++
		}
		if value, err := strconv.Atoi(string(data[start:position])); err == nil && value > largest {
			largest = value
		}
		offset = position
	}
}

// nextPDFStream finds the next stream object at or after offset. It returns the
// index of the first data byte and the stream's dictionary, or -1 when the
// document has no further stream. The keyword must directly follow the `>>`
// that ends the dictionary, so a `stream` inside content data is never read as
// a new object.
func nextPDFStream(data []byte, offset int) (int, []byte) {
	for {
		index := bytes.Index(data[offset:], []byte("stream"))
		if index < 0 {
			return -1, nil
		}
		position := offset + index
		if position > 0 && isPDFNameChar(data[position-1]) {
			offset = position + len("stream")
			continue
		}
		dictionaryEnd := position
		for dictionaryEnd > 0 && isPDFWhitespace(data[dictionaryEnd-1]) {
			dictionaryEnd--
		}
		if dictionaryEnd < 2 || !bytes.Equal(data[dictionaryEnd-2:dictionaryEnd], []byte(">>")) {
			offset = position + len("stream")
			continue
		}
		start := position + len("stream")
		switch {
		case start+1 < len(data) && data[start] == '\r' && data[start+1] == '\n':
			start += 2
		case start < len(data) && (data[start] == '\n' || data[start] == '\r'):
			start++
		default:
			offset = start
			continue
		}
		return start, pdfStreamDictionary(data[:dictionaryEnd])
	}
}

// pdfStreamDictionary returns the top level dictionary of a stream whose `>>`
// ends the prefix. The backwards scan matches nested dictionaries, so a
// /DecodeParms dictionary never hides the /Filter entry beside it.
func pdfStreamDictionary(prefix []byte) []byte {
	depth := 0
	for position := len(prefix) - 1; position >= 1; position-- {
		if prefix[position] == '>' && prefix[position-1] == '>' {
			depth++
			position--
			continue
		}
		if prefix[position] == '<' && prefix[position-1] == '<' {
			depth--
			if depth == 0 {
				return prefix[position-1:]
			}
			position--
		}
	}
	return nil
}

// trimPDFStreamBytes removes the end-of-line that separates the stream data
// from the `endstream` keyword; the specification excludes it from the data.
func trimPDFStreamBytes(raw []byte) []byte {
	if len(raw) > 0 && raw[len(raw)-1] == '\n' {
		raw = raw[:len(raw)-1]
	}
	if len(raw) > 0 && raw[len(raw)-1] == '\r' {
		raw = raw[:len(raw)-1]
	}
	return raw
}

// decodePDFStream applies the declared filter chain of one stream in order. A
// stream with an unsupported filter or a predictor is skipped: it cannot hold
// content stream text. An output above the remaining decompression budget is
// the only error that fails the extraction, because it means the document
// itself is oversized.
func decodePDFStream(dictionary, raw []byte, budget *int64) ([]byte, error) {
	// An image stream holds pixels, not text; a stored image without a filter
	// would otherwise be scanned as operators.
	if string(pdfDictionaryValue(dictionary, "/Subtype")) == "/Image" {
		return nil, errPDFStreamSkip
	}
	if pdfStreamHasPredictor(dictionary) {
		return nil, errPDFStreamSkip
	}
	filters := pdfStreamFilters(dictionary)
	if len(filters) == 0 {
		return raw, nil
	}
	for _, filter := range filters {
		var reader io.Reader
		switch filter {
		case "FlateDecode", "Fl":
			zlibReader, err := zlib.NewReader(bytes.NewReader(raw))
			if err != nil {
				return nil, errPDFStreamSkip
			}
			defer zlibReader.Close()
			reader = zlibReader
		case "ASCIIHexDecode", "AHx":
			reader = hex.NewDecoder(bytes.NewReader(raw))
		case "ASCII85Decode", "A85":
			reader = ascii85.NewDecoder(bytes.NewReader(raw))
		default:
			return nil, errPDFStreamSkip
		}
		decoded, err := readPDFDecodedStream(reader, budget)
		if err != nil {
			return nil, err
		}
		raw = decoded
	}
	return raw, nil
}

// readPDFDecodedStream reads one decoded stream under the remaining budget.
func readPDFDecodedStream(reader io.Reader, budget *int64) ([]byte, error) {
	remaining := *budget
	data, err := io.ReadAll(io.LimitReader(reader, remaining+1))
	if err != nil {
		return nil, errPDFStreamSkip
	}
	if int64(len(data)) > remaining {
		return nil, ErrLimit
	}
	*budget -= int64(len(data))
	return data, nil
}

// pdfStreamFilters lists the declared filters of one stream in application
// order. A missing or empty /Filter means the data is stored as is.
func pdfStreamFilters(dictionary []byte) []string {
	value := pdfDictionaryValue(dictionary, "/Filter")
	if len(value) == 0 {
		return nil
	}
	if open := bytes.IndexByte(value, '['); open >= 0 {
		if close := bytes.IndexByte(value[open:], ']'); close >= 0 {
			value = value[open+1 : open+close]
		}
	}
	filters := make([]string, 0, 2)
	position := 0
	for position < len(value) {
		nameStart := bytes.IndexByte(value[position:], '/')
		if nameStart < 0 {
			break
		}
		position += nameStart + 1
		nameEnd := position
		for nameEnd < len(value) && isPDFNameChar(value[nameEnd]) {
			nameEnd++
		}
		if nameEnd > position {
			filters = append(filters, string(value[position:nameEnd]))
		}
		position = nameEnd
	}
	return filters
}

// pdfStreamHasPredictor reports whether the stream declares a predictor above
// 1. A predictor recodes the data after decoding and is never used by a content
// stream, so such a stream is skipped instead of being read as text.
func pdfStreamHasPredictor(dictionary []byte) bool {
	value := pdfDictionaryValue(dictionary, "/Predictor")
	if len(value) == 0 {
		return false
	}
	position := 0
	for position < len(value) && isPDFWhitespace(value[position]) {
		position++
	}
	start := position
	for position < len(value) && value[position] >= '0' && value[position] <= '9' {
		position++
	}
	if start == position {
		return true
	}
	value2, err := strconv.Atoi(string(value[start:position]))
	if err != nil {
		return true
	}
	return value2 > 1
}

// pdfDictionaryValue returns the value of one top level dictionary key: a
// bracketed array with its brackets, or a single unspaced token. A value that
// is absent or empty yields nil, so a caller can tell an omitted key from a
// present one.
func pdfDictionaryValue(dictionary []byte, key string) []byte {
	index := bytes.Index(dictionary, []byte(key))
	if index < 0 {
		return nil
	}
	start := index + len(key)
	if start < len(dictionary) && isPDFNameChar(dictionary[start]) {
		return nil
	}
	value := dictionary[start:]
	position := 0
	for position < len(value) && isPDFWhitespace(value[position]) {
		position++
	}
	if position < len(value) && value[position] == '[' {
		end := bytes.IndexByte(value[position:], ']')
		if end < 0 {
			return nil
		}
		return value[position : position+end+1]
	}
	if position < len(value) && value[position] == '/' {
		end := position + 1
		for end < len(value) && isPDFNameChar(value[end]) {
			end++
		}
		return value[position:end]
	}
	end := position
	for end < len(value) && isPDFNameChar(value[end]) {
		end++
	}
	return value[position:end]
}

// pdfTextOperand is one operand of a content stream operator: a string, a
// number, or a name the scan does not need to keep.
type pdfTextOperand struct {
	text     string
	number   float64
	isString bool
	isNumber bool
}

// pdfTextExtractor collects the text of PDF content streams under the byte
// limit of one extraction. It keeps the last text matrix position so a moved
// line becomes a newline and a horizontal jump becomes a space.
type pdfTextExtractor struct {
	text         []byte
	maxTextBytes int64
	overflow     bool
	hasPosition  bool
	positionX    float64
	positionY    float64
}

// scanContent reads the text-showing operators of one content stream.
func (extractor *pdfTextExtractor) scanContent(content []byte) {
	operands := make([]pdfTextOperand, 0, 8)
	position := 0
	for position < len(content) {
		switch current := content[position]; {
		case isPDFWhitespace(current):
			position++
		case current == '%':
			for position < len(content) && content[position] != '\n' && content[position] != '\r' {
				position++
			}
		case current == '(':
			text, next := parsePDFLiteralString(content, position)
			operands = append(operands, pdfTextOperand{text: text, isString: true})
			position = next
		case current == '<' && position+1 < len(content) && content[position+1] == '<':
			position = skipPDFDictionary(content, position)
		case current == '<':
			text, next := parsePDFHexString(content, position)
			operands = append(operands, pdfTextOperand{text: text, isString: true})
			position = next
		case current == '[':
			position++
		case current == ']':
			position++
		case current == '/':
			_, position = parsePDFName(content, position)
			operands = append(operands, pdfTextOperand{})
		case current == '+' || current == '-' || current == '.' || (current >= '0' && current <= '9'):
			number, next := parsePDFNumber(content, position)
			if next <= position {
				position++
				continue
			}
			operands = append(operands, pdfTextOperand{number: number, isNumber: true})
			position = next
		default:
			operator, next := parsePDFOperator(content, position)
			if next <= position {
				position++
				continue
			}
			position = next
			if operator == "BI" {
				// An inline image carries arbitrary binary data between BI and
				// its closing EI, which must not be scanned as text.
				position = skipPDFInlineImage(content, position)
				operands = operands[:0]
				continue
			}
			extractor.applyOperator(operator, operands)
			operands = operands[:0]
		}
	}
}

// applyOperator handles one content stream operator; every other operator
// (graphics state, color, path painting) has no text meaning.
func (extractor *pdfTextExtractor) applyOperator(operator string, operands []pdfTextOperand) {
	switch operator {
	case "Tj":
		extractor.appendText(lastPDFStringOperand(operands))
	case "'", "\"":
		extractor.newLine()
		extractor.appendText(lastPDFStringOperand(operands))
	case "TJ":
		for _, operand := range operands {
			switch {
			case operand.isString:
				extractor.appendText(operand.text)
			case operand.isNumber && (operand.number <= -pdfSpaceGap || operand.number >= pdfSpaceGap):
				extractor.appendSpace()
			}
		}
	case "Td", "TD", "T*", "BT", "ET":
		extractor.newLine()
	case "Tm":
		extractor.moveTextPosition(operands)
	}
}

// moveTextPosition applies one text matrix. A changed vertical position starts
// a new line; the same line that jumps horizontally by more than a word gap
// gets a space, which is how documents position their words without spaces in
// the strings.
func (extractor *pdfTextExtractor) moveTextPosition(operands []pdfTextOperand) {
	x, y, ok := lastPDFTextMatrixPosition(operands)
	if !ok {
		return
	}
	if extractor.hasPosition {
		if math.Abs(y-extractor.positionY) > pdfSamePositionEpsilon {
			extractor.newLine()
		} else if x-extractor.positionX > pdfSpaceGap {
			extractor.appendSpace()
		}
	}
	extractor.hasPosition = true
	extractor.positionX, extractor.positionY = x, y
}

func (extractor *pdfTextExtractor) appendText(text string) {
	if text == "" || extractor.overflow {
		return
	}
	remaining := extractor.maxTextBytes - int64(len(extractor.text))
	if remaining <= 0 {
		extractor.overflow = true
		return
	}
	if int64(len(text)) > remaining {
		extractor.text = append(extractor.text, text[:remaining]...)
		extractor.overflow = true
		return
	}
	extractor.text = append(extractor.text, text...)
}

func (extractor *pdfTextExtractor) appendSpace() {
	if extractor.overflow {
		return
	}
	if len(extractor.text) == 0 {
		return
	}
	switch extractor.text[len(extractor.text)-1] {
	case ' ', '\n', '\t':
		return
	}
	extractor.appendText(" ")
}

func (extractor *pdfTextExtractor) newLine() {
	if extractor.overflow {
		return
	}
	extractor.trimTrailingSpaces()
	if len(extractor.text) == 0 || extractor.text[len(extractor.text)-1] == '\n' {
		return
	}
	extractor.appendText("\n")
}

func (extractor *pdfTextExtractor) trimTrailingSpaces() {
	for len(extractor.text) > 0 {
		switch extractor.text[len(extractor.text)-1] {
		case ' ', '\t', '\n':
			extractor.text = extractor.text[:len(extractor.text)-1]
		default:
			return
		}
	}
}

// lastPDFStringOperand returns the text of the last string operand, which is
// the string Tj, ' and " display.
func lastPDFStringOperand(operands []pdfTextOperand) string {
	for index := len(operands) - 1; index >= 0; index-- {
		if operands[index].isString {
			return operands[index].text
		}
	}
	return ""
}

// lastPDFTextMatrixPosition reads the x and y translation of one text matrix
// (a b c d e f Tm). Fewer than six number operands are not a matrix.
func lastPDFTextMatrixPosition(operands []pdfTextOperand) (float64, float64, bool) {
	numbers := make([]float64, 0, 6)
	for index := len(operands) - 1; index >= 0 && len(numbers) < 6; index-- {
		if operands[index].isNumber {
			numbers = append(numbers, operands[index].number)
		}
	}
	if len(numbers) < 6 {
		return 0, 0, false
	}
	// numbers[0] is f (y) and numbers[1] is e (x) in document order.
	return numbers[1], numbers[0], true
}

// parsePDFLiteralString reads one `(...)` string with its escapes, nested
// parentheses and a trailing backslash.
func parsePDFLiteralString(content []byte, start int) (string, int) {
	var builder strings.Builder
	depth := 0
	position := start
	for position < len(content) {
		current := content[position]
		if current == '\\' {
			if position+1 >= len(content) {
				return builder.String(), len(content)
			}
			next := content[position+1]
			switch next {
			case 'n':
				builder.WriteByte('\n')
				position += 2
			case 'r':
				builder.WriteByte('\r')
				position += 2
			case 't':
				builder.WriteByte('\t')
				position += 2
			case 'b':
				builder.WriteByte('\b')
				position += 2
			case 'f':
				builder.WriteByte('\f')
				position += 2
			case '\n', '\r':
				position += 2
			case '(', ')', '\\':
				builder.WriteByte(next)
				position += 2
			case '0', '1', '2', '3', '4', '5', '6', '7':
				value, digits := 0, 0
				position++
				for digits < 3 && position < len(content) && content[position] >= '0' && content[position] <= '7' {
					value = value*8 + int(content[position]-'0')
					position++
					digits++
				}
				builder.WriteByte(byte(value))
			default:
				builder.WriteByte(next)
				position += 2
			}
			continue
		}
		switch current {
		case '(':
			depth++
			builder.WriteByte(current)
		case ')':
			if depth == 0 {
				return builder.String(), position + 1
			}
			depth--
			builder.WriteByte(current)
		default:
			builder.WriteByte(current)
		}
		position++
	}
	return builder.String(), position
}

// parsePDFHexString reads one `<...>` string. A single trailing digit is padded
// with a zero, as the specification requires.
func parsePDFHexString(content []byte, start int) (string, int) {
	position := start + 1
	digits := make([]byte, 0, 32)
	for position < len(content) && content[position] != '>' {
		if isPDFHexDigit(content[position]) {
			digits = append(digits, content[position])
		}
		position++
	}
	if position < len(content) {
		position++
	}
	if len(digits)%2 == 1 {
		digits = append(digits, '0')
	}
	var builder strings.Builder
	builder.Grow(len(digits) / 2)
	for index := 0; index+1 < len(digits); index += 2 {
		builder.WriteByte(pdfHexNibble(digits[index])<<4 | pdfHexNibble(digits[index+1]))
	}
	return builder.String(), position
}

// skipPDFDictionary advances past one `<< ... >>` dictionary, including nested
// dictionaries.
func skipPDFDictionary(content []byte, start int) int {
	depth := 0
	position := start
	for position < len(content) {
		switch {
		case content[position] == '<' && position+1 < len(content) && content[position+1] == '<':
			depth++
			position += 2
		case content[position] == '>' && position+1 < len(content) && content[position+1] == '>':
			depth--
			position += 2
			if depth <= 0 {
				return position
			}
		default:
			position++
		}
	}
	return position
}

// parsePDFName advances past one /Name token. The name itself is an operator
// operand without a text meaning.
func parsePDFName(content []byte, start int) (string, int) {
	position := start + 1
	for position < len(content) && isPDFNameChar(content[position]) {
		position++
	}
	return string(content[start:position]), position
}

// parsePDFNumber reads one integer or real number; it reports a zero width when
// the token is not a number.
func parsePDFNumber(content []byte, start int) (float64, int) {
	position := start
	if position < len(content) && (content[position] == '+' || content[position] == '-') {
		position++
	}
	for position < len(content) && content[position] >= '0' && content[position] <= '9' {
		position++
	}
	if position < len(content) && content[position] == '.' {
		position++
		for position < len(content) && content[position] >= '0' && content[position] <= '9' {
			position++
		}
	}
	value, err := strconv.ParseFloat(string(content[start:position]), 64)
	if err != nil {
		return 0, start
	}
	return value, position
}

// parsePDFOperator reads one operator token: the letters of the content stream
// grammar plus the punctuation of `T*`, `'` and `"`.
func parsePDFOperator(content []byte, start int) (string, int) {
	position := start
	for position < len(content) && isPDFNameChar(content[position]) {
		position++
	}
	if position > start {
		return string(content[start:position]), position
	}
	switch content[start] {
	case '\'', '"':
		return string(content[start : start+1]), start + 1
	}
	return "", start
}

// skipPDFInlineImage advances past the binary data of an inline image, which
// ends at an `EI` token surrounded by whitespace.
func skipPDFInlineImage(content []byte, start int) int {
	position := start
	for position < len(content) {
		index := bytes.Index(content[position:], []byte("EI"))
		if index < 0 {
			return len(content)
		}
		candidate := position + index
		if (candidate == 0 || isPDFWhitespace(content[candidate-1])) &&
			(candidate+len("EI") >= len(content) || isPDFWhitespace(content[candidate+len("EI")])) {
			return candidate + len("EI")
		}
		position = candidate + len("EI")
	}
	return position
}

// normalizePDFText cleans scanned text for storage: line endings are unified,
// control bytes carry no text meaning and are dropped (a UTF-16 string
// interleaves NUL bytes between its characters), and invalid UTF-8 bytes are
// removed because the text is served inside a JSON response.
func normalizePDFText(text string) string {
	text = normalizeDocumentLineEndings(strings.ToValidUTF8(text, ""))
	var builder strings.Builder
	builder.Grow(len(text))
	for _, current := range text {
		switch {
		case current == '\n' || current == '\t':
			builder.WriteRune(current)
		case current < 0x20 || current == 0x7f:
		default:
			builder.WriteRune(current)
		}
	}
	return strings.TrimSpace(builder.String())
}

func isPDFWhitespace(current byte) bool {
	switch current {
	case 0x00, '\t', '\n', '\f', '\r', ' ':
		return true
	}
	return false
}

// isPDFNameChar reports whether a byte is a PDF regular character, the set that
// names and operators are built from.
func isPDFNameChar(current byte) bool {
	switch {
	case current >= 'a' && current <= 'z', current >= 'A' && current <= 'Z', current >= '0' && current <= '9':
		return true
	}
	switch current {
	case '!', '"', '#', '$', '&', '\'', '*', '+', '-', '.', ':', ';', '=', '?', '@', '^', '_', '`', '|', '~':
		return true
	}
	return false
}

func isPDFHexDigit(current byte) bool {
	switch {
	case current >= '0' && current <= '9', current >= 'a' && current <= 'f', current >= 'A' && current <= 'F':
		return true
	}
	return false
}

func pdfHexNibble(digit byte) byte {
	switch {
	case digit >= '0' && digit <= '9':
		return digit - '0'
	case digit >= 'a' && digit <= 'f':
		return digit - 'a' + 10
	default:
		return digit - 'A' + 10
	}
}
