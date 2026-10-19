package middleware

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newPlaygroundGenerationTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/pg/images/generations", PlaygroundRelayBridge("/v1/images/generations"), func(c *gin.Context) {
		var payload struct {
			Seed *int64 `json:"seed"`
			Size string `json:"size"`
		}
		if err := common.UnmarshalBodyReusable(c, &payload); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"path": c.Request.URL.Path,
			"seed": payload.Seed,
			"size": payload.Size,
		})
	})
	router.POST("/pg/videos", PlaygroundRelayBridge("/v1/videos"), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"path": c.Request.URL.Path})
	})
	return router
}

func TestPlaygroundGenerationParametersBoundCustomSizesAndSeeds(t *testing.T) {
	router := newPlaygroundGenerationTestRouter()

	tests := []struct {
		name    string
		path    string
		body    string
		status  int
		message string
	}{
		{name: "preset size", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","size":"1024x1024","seed":42}`, status: http.StatusOK},
		{name: "minimum custom size", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","size":"64x64"}`, status: http.StatusOK},
		{name: "maximum custom size", path: "/pg/videos", body: `{"model":"sora","prompt":"cat","size":"8192x8192"}`, status: http.StatusOK},
		{name: "provider size label", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","size":"auto"}`, status: http.StatusOK},
		{name: "maximum seed", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","seed":2147483647}`, status: http.StatusOK},
		{name: "null seed", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","seed":null}`, status: http.StatusOK},
		{name: "width below minimum", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","size":"63x1024"}`, status: http.StatusBadRequest, message: playgroundGenerationSizeMessage},
		{name: "height above maximum", path: "/pg/videos", body: `{"model":"sora","prompt":"cat","size":"1024x8193"}`, status: http.StatusBadRequest, message: playgroundGenerationSizeMessage},
		{name: "zero side", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","size":"0x0"}`, status: http.StatusBadRequest, message: playgroundGenerationSizeMessage},
		{name: "multiplication sign", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","size":"1024×1024"}`, status: http.StatusBadRequest, message: playgroundGenerationSizeMessage},
		{name: "oversized number", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","size":"99999999999999999999x1024"}`, status: http.StatusBadRequest, message: playgroundGenerationSizeMessage},
		{name: "zero seed", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","seed":0}`, status: http.StatusBadRequest, message: playgroundGenerationSeedMessage},
		{name: "negative seed", path: "/pg/videos", body: `{"model":"sora","prompt":"cat","seed":-1}`, status: http.StatusBadRequest, message: playgroundGenerationSeedMessage},
		{name: "seed above maximum", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","seed":2147483648}`, status: http.StatusBadRequest, message: playgroundGenerationSeedMessage},
		{name: "fractional seed", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","seed":1.5}`, status: http.StatusBadRequest, message: playgroundGenerationSeedMessage},
		{name: "string seed", path: "/pg/images/generations", body: `{"model":"gpt-image-1","prompt":"cat","seed":"42"}`, status: http.StatusBadRequest, message: playgroundGenerationSeedMessage},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, tt.path, bytes.NewBufferString(tt.body))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(recorder, request)

			require.Equal(t, tt.status, recorder.Code, recorder.Body.String())
			if tt.message != "" {
				assert.Contains(t, recorder.Body.String(), tt.message)
				assert.Contains(t, recorder.Body.String(), `"code":"invalid_request"`)
				return
			}
			assert.Contains(t, recorder.Body.String(), `"path":"/v1/`)
		})
	}
}

func TestPlaygroundGenerationParameterValidationKeepsBodyReplayable(t *testing.T) {
	router := newPlaygroundGenerationTestRouter()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/pg/images/generations", bytes.NewBufferString(`{"model":"gpt-image-1","prompt":"cat","size":"512x512","seed":7}`))
	request.Header.Set("Content-Type", "application/json")

	router.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	assert.Contains(t, recorder.Body.String(), `"size":"512x512"`)
	assert.Contains(t, recorder.Body.String(), `"seed":7`)
}
