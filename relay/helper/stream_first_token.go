package helper

import (
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
)

// resolveFirstTokenTimeout returns the streaming first-token (TTFB) window of
// this request, or zero when the feature is off. A channel setting overrides
// the global STREAMING_FIRST_TOKEN_TIMEOUT default; both being zero keeps the
// existing behavior, where only STREAMING_TIMEOUT guards the wait for the
// first data chunk.
func resolveFirstTokenTimeout(info *relaycommon.RelayInfo) time.Duration {
	seconds := constant.StreamingFirstTokenTimeout
	if info != nil && info.ChannelMeta != nil && info.ChannelSetting.FirstTokenTimeout > 0 {
		seconds = info.ChannelSetting.FirstTokenTimeout
	}
	if seconds <= 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

// firstTokenGate decides what happens when the first-token window closes while
// the stream is still silent. It fails closed in both directions: a channel is
// only dropped while nothing reached the client, and once it is dropped no
// further chunk is written, so a stream either delivers output or switches
// channels, never both.
type firstTokenGate struct {
	mu        sync.Mutex
	committed bool
	abandoned bool
}

// committedOutput reports whether a write already reached the client. Keepalive
// pings may only be sent after that point, because a ping would commit the
// response and block the channel fallback.
func (g *firstTokenGate) committedOutput() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.committed
}

// claim reserves the client write for this chunk. It reports false when the
// first-token timeout already gave up on the channel, and the chunk is dropped.
func (g *firstTokenGate) claim() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.abandoned {
		return false
	}
	g.committed = true
	return true
}

// abandon gives up on the channel when nothing reached the client yet. It
// reports false when output is already committed, because the relay must not
// switch channels after the response started.
func (g *firstTokenGate) abandon() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.committed {
		return false
	}
	g.abandoned = true
	return true
}

const sealedStreamWriterKey = "sealed_stream_writer"

// sealedStreamWriter drops every write of a failed attempt. Adaptors emit
// synthetic final frames after StreamScannerHandler returns, and a first-token
// timeout must not let those frames commit a partial stream before the retry
// starts. The relay lifts the seal with ResetSealedStreamResponse before the
// next attempt and before it writes the final error.
type sealedStreamWriter struct {
	gin.ResponseWriter
}

func (w *sealedStreamWriter) Write(body []byte) (int, error) {
	return len(body), nil
}

func (w *sealedStreamWriter) WriteString(body string) (int, error) {
	return len(body), nil
}

func (w *sealedStreamWriter) WriteHeader(int) {}

func (w *sealedStreamWriter) WriteHeaderNow() {}

func (w *sealedStreamWriter) Flush() {}

func sealStreamResponse(c *gin.Context) {
	if _, sealed := sealedStreamWriterOrigin(c); sealed {
		return
	}
	if c == nil || c.Writer == nil {
		return
	}
	c.Set(sealedStreamWriterKey, c.Writer)
	c.Writer = &sealedStreamWriter{ResponseWriter: c.Writer}
}

// sealedStreamWriterOrigin returns the writer stored for a sealed response.
// The key keeps a nil value once the seal was lifted.
func sealedStreamWriterOrigin(c *gin.Context) (gin.ResponseWriter, bool) {
	if c == nil {
		return nil, false
	}
	writer, exists := c.Get(sealedStreamWriterKey)
	if !exists || writer == nil {
		return nil, false
	}
	original, ok := writer.(gin.ResponseWriter)
	return original, ok
}

// ResetSealedStreamResponse restores the original response writer of a request
// whose stream was abandoned by a first-token timeout. It is safe to call when
// nothing was sealed.
func ResetSealedStreamResponse(c *gin.Context) {
	original, sealed := sealedStreamWriterOrigin(c)
	if !sealed {
		return
	}
	c.Set(sealedStreamWriterKey, nil)
	c.Writer = original
}

// FirstTokenTimeoutError turns a first-token timeout that fired before any byte
// reached the client into a retryable channel error. Every other stream end,
// including a timeout after output was delivered, returns nil.
func FirstTokenTimeoutError(info *relaycommon.RelayInfo) *types.NewAPIError {
	if info == nil || info.StreamStatus == nil ||
		info.StreamStatus.EndReason != relaycommon.StreamEndReasonFirstTokenTimeout {
		return nil
	}
	message := "upstream did not send the first streamed chunk in time"
	if endErr := info.StreamStatus.EndError; endErr != nil {
		message = endErr.Error()
	}
	return types.NewError(errors.New(message), types.ErrorCodeChannelFirstTokenTimeout,
		types.ErrOptionWithStatusCode(http.StatusBadGateway))
}
