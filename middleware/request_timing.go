package middleware

import (
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"

	"github.com/gin-gonic/gin"
)

// requestTimingPaths are the main LLM entry points whose logs carry the phase
// breakdown. Other relay endpoints (embeddings, images, audio, tasks,
// websocket) keep their current logs and pay no timing bookkeeping.
var requestTimingPaths = map[string]struct{}{
	"/v1/chat/completions": {},
	"/v1/completions":      {},
	"/v1/messages":         {},
	"/v1/responses":        {},
	// The Playground chat entry runs through the same relay pipeline, and its
	// message metadata shows the same breakdown. The protocol bridges are
	// observed before they rewrite the path to their /v1 counterparts.
	"/pg/chat/completions": {},
	"/pg/responses":        {},
	"/pg/messages":         {},
}

// RequestTiming starts a per-request timing session for the main LLM entry
// points, so their consume and error logs can expose where the time went. It
// must be registered before authentication to observe the whole request; it
// does nothing for routes outside the observed entries.
func RequestTiming() gin.HandlerFunc {
	return func(c *gin.Context) {
		if tracksRequestTiming(c.Request.Method, c.Request.URL.Path) {
			common.SetRequestTimingSession(c, common.NewRequestTimingSession())
		}
		c.Next()
	}
}

// tracksRequestTiming reports whether the request is one of the observed
// entries. Gemini generateContent routes are matched by suffix because the
// model name is part of the path.
func tracksRequestTiming(method, path string) bool {
	if method != http.MethodPost {
		return false
	}
	if _, ok := requestTimingPaths[path]; ok {
		return true
	}
	if strings.HasPrefix(path, "/v1beta/models/") {
		return strings.HasSuffix(path, ":generateContent") || strings.HasSuffix(path, ":streamGenerateContent")
	}
	return false
}
