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
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// pdfFixture builds a PDF whose pages print the given texts. Each page carries
// one content stream of the form `BT /F1 12 Tf 72 720 Td (text) Tj ET`; streams
// are stored through encode, so a test can exercise the filter it declares.
func pdfFixture(t *testing.T, pages []string, encode func(stream string) (dictionaryEntries, storedBytes string)) []byte {
	t.Helper()
	streams := make([]string, len(pages))
	for index, page := range pages {
		streams[index] = fmt.Sprintf("BT /F1 12 Tf 72 720 Td (%s) Tj ET", page)
	}
	return pdfDocument(t, streams, encode)
}

// pdfDocument assembles a PDF with one page per content stream. Each stream is
// stored through encode so a test can exercise the filter it declares.
func pdfDocument(t *testing.T, streams []string, encode func(stream string) (dictionaryEntries, storedBytes string)) []byte {
	t.Helper()
	entries := make([]string, len(streams))
	for index, stream := range streams {
		entries[index], streams[index] = encode(stream)
	}
	var body strings.Builder
	body.WriteString("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	writeObject := func(id int, content string) {
		fmt.Fprintf(&body, "%d 0 obj\n%s\nendobj\n", id, content)
	}
	pageIDs := make([]int, len(streams))
	for index := range streams {
		pageIDs[index] = 3 + index*2
	}
	kids := make([]string, len(pageIDs))
	for index, id := range pageIDs {
		kids[index] = fmt.Sprintf("%d 0 R", id)
	}
	writeObject(1, "<< /Type /Catalog /Pages 2 0 R >>")
	writeObject(2, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), len(streams)))
	for index, stream := range streams {
		writeObject(pageIDs[index], fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R >>", pageIDs[index]+1))
		fmt.Fprintf(&body, "%d 0 obj\n<< /Length %d %s>>\nstream\n%s\nendstream\nendobj\n", pageIDs[index]+1, len(stream), entries[index], stream)
	}
	body.WriteString("trailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n")
	return []byte(body.String())
}

// pdfStreamFixture builds a one page PDF whose content stream is exactly the
// given bytes, so a test can print the operators it wants to see read.
func pdfStreamFixture(t *testing.T, stream string) []byte {
	t.Helper()
	return pdfDocument(t, []string{stream}, func(stream string) (string, string) { return "", stream })
}

// pdfStreams builds a page per entry, each printing the entry as page text with
// one unfiltered standard text-showing stream.
func pdfStreams(t *testing.T, streams ...string) []byte {
	t.Helper()
	return pdfFixture(t, streams, func(stream string) (string, string) { return "", stream })
}

func flateEncode(t *testing.T, stream string) string {
	t.Helper()
	var encoded bytes.Buffer
	writer := zlib.NewWriter(&encoded)
	_, err := writer.Write([]byte(stream))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	return encoded.String()
}

func defaultLimits() Limits {
	return Limits{MaxTextBytes: 1 << 20, MaxPages: 100}
}

func TestExtractPlainTextDocuments(t *testing.T) {
	result, err := Extract("text/plain", []byte("Hello\r\nWorld\r"), defaultLimits())
	require.NoError(t, err)
	assert.Equal(t, "Hello\nWorld", result.Text)
	assert.Zero(t, result.PageCount)

	result, err = Extract("text/markdown", []byte("# Title\n\nBody\n"), defaultLimits())
	require.NoError(t, err)
	assert.Equal(t, "# Title\n\nBody", result.Text)

	_, err = Extract("text/plain", []byte("  \n\t"), defaultLimits())
	assert.ErrorIs(t, err, ErrNoText)

	// Invalid UTF-8 and a byte above the limit are distinct failures: the first
	// means the stored bytes do not match the declared type, the second that the
	// document is oversized.
	_, err = Extract("text/plain", []byte{0xff, 0xfe, 'a'}, defaultLimits())
	assert.ErrorIs(t, err, ErrUnreadable)

	_, err = Extract("text/plain", []byte(strings.Repeat("a", 11)), Limits{MaxTextBytes: 10, MaxPages: 1})
	assert.ErrorIs(t, err, ErrLimit)

	_, err = Extract("application/json", []byte("{}"), defaultLimits())
	assert.ErrorIs(t, err, ErrUnsupported)

	_, err = Extract("text/plain", []byte("a"), Limits{})
	assert.ErrorIs(t, err, ErrLimit)
}

func TestExtractPDFText(t *testing.T) {
	uncompressed := func(stream string) (string, string) { return "", stream }

	pdf := pdfFixture(t, []string{"Hello PDF"}, uncompressed)
	result, err := Extract("application/pdf", pdf, defaultLimits())
	require.NoError(t, err)
	assert.Equal(t, "Hello PDF", result.Text)
	assert.Equal(t, 1, result.PageCount)

	pdf = pdfFixture(t, []string{"First page", "Second page"}, uncompressed)
	result, err = Extract("application/pdf", pdf, defaultLimits())
	require.NoError(t, err)
	assert.Equal(t, "First page\nSecond page", result.Text)
	assert.Equal(t, 2, result.PageCount)

	pdf = pdfFixture(t, []string{"Compressed page"}, func(stream string) (string, string) {
		return "/Filter /FlateDecode ", flateEncode(t, stream)
	})
	result, err = Extract("application/pdf", pdf, defaultLimits())
	require.NoError(t, err)
	assert.Equal(t, "Compressed page", result.Text)

	pdf = pdfFixture(t, []string{"Hex page", "Hex page two"}, func(stream string) (string, string) {
		return "/Filter /ASCIIHexDecode ", hex.EncodeToString([]byte(stream))
	})
	result, err = Extract("application/pdf", pdf, defaultLimits())
	require.NoError(t, err)
	assert.Equal(t, "Hex page\nHex page two", result.Text)

	pdf = pdfFixture(t, []string{"Base85 page"}, func(stream string) (string, string) {
		var encoded bytes.Buffer
		writer := ascii85.NewEncoder(&encoded)
		_, encodeErr := writer.Write([]byte(stream))
		require.NoError(t, encodeErr)
		require.NoError(t, writer.Close())
		return "/Filter /ASCII85Decode ", encoded.String()
	})
	result, err = Extract("application/pdf", pdf, defaultLimits())
	require.NoError(t, err)
	assert.Equal(t, "Base85 page", result.Text)

	// A filter chain applies in declaration order: the stream is base85 encoded
	// after compression.
	pdf = pdfFixture(t, []string{"Chained page"}, func(stream string) (string, string) {
		var encoded bytes.Buffer
		writer := ascii85.NewEncoder(&encoded)
		_, encodeErr := writer.Write([]byte(flateEncode(t, stream)))
		require.NoError(t, encodeErr)
		require.NoError(t, writer.Close())
		return "/Filter [/ASCII85Decode /FlateDecode] ", encoded.String()
	})
	result, err = Extract("application/pdf", pdf, defaultLimits())
	require.NoError(t, err)
	assert.Equal(t, "Chained page", result.Text)
}

func TestExtractPDFTextOperators(t *testing.T) {
	for name, testCase := range map[string]struct{ stream, expected string }{
		"literal string escapes": {`BT (A\tB\nC) Tj ET`, "A\tB\nC"},
		"nested parentheses":     {`BT (A (B) C) Tj ET`, "A (B) C"},
		"octal escape":           {`BT (Hi\040there) Tj ET`, "Hi there"},
		"hex string":             {`BT <48656C6C6F> Tj ET`, "Hello"},
		"tj array word gap":      {`BT [(Hello) -300 (World)] TJ ET`, "Hello World"},
		"tj array small gap":     {`BT [(Hello) -10 (World)] TJ ET`, "HelloWorld"},
		"moved text matrix":      {`BT 1 0 0 1 72 720 Tm (One) Tj 1 0 0 1 72 700 Tm (Two) Tj ET`, "One\nTwo"},
		"same line matrix gap":   {`BT 1 0 0 1 72 720 Tm (One) Tj 1 0 0 1 200 720 Tm (Two) Tj ET`, "One Two"},
		"text position move":     {`BT (One) Tj T* (Two) Tj ET`, "One\nTwo"},
		"quote operator":         {`BT (One) Tj (Two) ' ET`, "One\nTwo"},
		"double quote operator":  {`BT 1 0 0 (One) " ET`, "One"},
		"comment and whitespace": {`BT % a comment
(A % not a comment) Tj ET`, "A % not a comment"},
		// An inline image carries binary data between BI and EI; the scanner must
		// skip it instead of reading it as text operators.
		"inline image skipped": {"BT (Before) Tj ET BI /W 1 /H 1 ID \x00\x01(evil) EI BT (After) Tj ET", "Before\nAfter"},
	} {
		t.Run(name, func(t *testing.T) {
			result, err := Extract("application/pdf", pdfStreamFixture(t, testCase.stream), defaultLimits())
			require.NoError(t, err)
			assert.Equal(t, testCase.expected, result.Text)
		})
	}
}

func TestExtractPDFTextFailures(t *testing.T) {
	_, err := Extract("application/pdf", []byte("no header"), defaultLimits())
	assert.ErrorIs(t, err, ErrUnreadable)

	encrypted := bytes.Replace(pdfStreams(t, "BT (Secret) Tj ET"), []byte("trailer"), []byte("/Encrypt 9 0 R\ntrailer"), 1)
	_, err = Extract("application/pdf", encrypted, defaultLimits())
	assert.ErrorIs(t, err, ErrUnreadable)

	// A graphics-only page has a content stream but no text.
	_, err = Extract("application/pdf", pdfStreamFixture(t, "0 0 m 10 10 l S"), defaultLimits())
	assert.ErrorIs(t, err, ErrNoText)

	// Too many pages are refused before any stream is read.
	_, err = Extract("application/pdf", pdfStreams(t, "One", "Two", "Three"), Limits{MaxTextBytes: 1024, MaxPages: 2})
	assert.ErrorIs(t, err, ErrLimit)

	// Text above the byte limit is refused as well.
	_, err = Extract("application/pdf", pdfStreams(t, "Text over the limit"), Limits{MaxTextBytes: 4, MaxPages: 10})
	assert.ErrorIs(t, err, ErrLimit)

	// A stream bomb is refused by the decompression budget: the stream inflates
	// to more than the 32 MiB the reader is willing to decompress.
	bomb := strings.Repeat("(Overflow) Tj\n", 3<<20)
	pdf := pdfFixture(t, []string{bomb}, func(stream string) (string, string) {
		return "/Filter /FlateDecode ", flateEncode(t, stream)
	})
	_, err = Extract("application/pdf", pdf, Limits{MaxTextBytes: 64 << 20, MaxPages: 10})
	assert.ErrorIs(t, err, ErrLimit)
}

// TestExtractPDFTextPageCountFallback covers a document whose page tree lives
// inside an object stream: no page object is visible, so the declared /Count is
// the page count the limit applies to.
func TestExtractPDFTextPageCountFallback(t *testing.T) {
	var body strings.Builder
	body.WriteString("%PDF-1.7\n")
	body.WriteString("3 0 obj\n<< /Type /ObjStm /N 1 /Count 3 >>\nstream\nhidden\nendstream\nendobj\n")
	body.WriteString("5 0 obj\n<< /Length 30 >>\nstream\nBT (Visible) Tj ET\nendstream\nendobj\n")
	pdf := []byte(body.String())
	result, err := Extract("application/pdf", pdf, Limits{MaxTextBytes: 1024, MaxPages: 10})
	require.NoError(t, err)
	assert.Equal(t, "Visible", result.Text)
	assert.Equal(t, 3, result.PageCount)

	_, err = Extract("application/pdf", pdf, Limits{MaxTextBytes: 1024, MaxPages: 2})
	assert.ErrorIs(t, err, ErrLimit)
}
