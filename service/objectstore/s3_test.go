package objectstore

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const fakeS3Bucket = "artifact-bucket"

type fakeS3Object struct {
	body        []byte
	contentType string
	modified    time.Time
}

// fakeS3Server is an in-memory S3 endpoint used with httptest. It implements
// just enough of the path-style REST API for the operations the store uses.
type fakeS3Server struct {
	mu      sync.Mutex
	objects map[string]fakeS3Object
	paths   []string
}

func newFakeS3Server() *fakeS3Server {
	return &fakeS3Server{objects: make(map[string]fakeS3Object)}
}

func (f *fakeS3Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	f.mu.Lock()
	f.paths = append(f.paths, path)
	f.mu.Unlock()

	bucket, key, found := strings.Cut(path, "/")
	if !found || bucket != fakeS3Bucket {
		writeFakeS3Error(w, http.StatusNotFound, "NoSuchBucket")
		return
	}
	switch r.Method {
	case http.MethodPut:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeFakeS3Error(w, http.StatusInternalServerError, "InternalError")
			return
		}
		f.mu.Lock()
		f.objects[key] = fakeS3Object{
			body:        body,
			contentType: r.Header.Get("Content-Type"),
			modified:    time.Now().UTC().Truncate(time.Second),
		}
		f.mu.Unlock()
		w.Header().Set("ETag", `"fake-etag"`)
		w.WriteHeader(http.StatusOK)
	case http.MethodHead, http.MethodGet:
		object, ok := f.object(key)
		if !ok {
			code := "NoSuchKey"
			if r.Method == http.MethodHead {
				code = "NotFound"
			}
			writeFakeS3Error(w, http.StatusNotFound, code)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(object.body)))
		if object.contentType != "" {
			w.Header().Set("Content-Type", object.contentType)
		}
		w.Header().Set("Last-Modified", object.modified.Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = w.Write(object.body)
		}
	case http.MethodDelete:
		f.mu.Lock()
		delete(f.objects, key)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		writeFakeS3Error(w, http.StatusMethodNotAllowed, "MethodNotAllowed")
	}
}

func (f *fakeS3Server) object(key string) (fakeS3Object, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	object, ok := f.objects[key]
	return object, ok
}

func (f *fakeS3Server) lastPath() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.paths) == 0 {
		return ""
	}
	return f.paths[len(f.paths)-1]
}

func (f *fakeS3Server) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.paths)
}

func writeFakeS3Error(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message></Error>`, code, code)
}

func testS3Config(endpoint string) system_setting.ObjectStoreConfig {
	return system_setting.ObjectStoreConfig{
		Backend:           system_setting.ObjectStoreBackendS3,
		Prefix:            "v1",
		PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
		S3: system_setting.S3Settings{
			Endpoint:  endpoint,
			Bucket:    fakeS3Bucket,
			Region:    "us-east-1",
			AccessKey: "access-key",
			SecretKey: "secret-key",
			PathStyle: true,
		},
	}
}

func newTestS3Store(t *testing.T, server *fakeS3Server) (*S3, *httptest.Server) {
	t.Helper()
	httpServer := httptest.NewServer(server)
	t.Cleanup(httpServer.Close)
	store, err := NewS3(testS3Config(httpServer.URL))
	require.NoError(t, err)
	return store, httpServer
}

func TestS3StoreRoundTrip(t *testing.T) {
	server := newFakeS3Server()
	store, _ := newTestS3Store(t, server)
	ctx := t.Context()
	key := "tasks/7/2026/10/task-1/video"

	payload := bytes.Repeat([]byte("s3-object-store-"), 2048)
	info, err := store.Put(ctx, key, bytes.NewReader(payload))
	require.NoError(t, err)
	assert.Equal(t, key, info.Key)
	assert.Equal(t, int64(len(payload)), info.Size)
	assert.Equal(t, system_setting.ObjectStoreBackendS3, store.Backend())
	// The request path of path-style addressing starts with the bucket name.
	assert.Equal(t, fakeS3Bucket+"/v1/"+key, server.lastPath())

	head, err := store.Head(ctx, key)
	require.NoError(t, err)
	assert.Equal(t, int64(len(payload)), head.Size)
	stored, ok := server.object("v1/" + key)
	require.True(t, ok)
	assert.True(t, head.ModTime.UTC().Equal(stored.modified))

	reader, object, err := store.Get(ctx, key)
	require.NoError(t, err)
	assert.Equal(t, int64(len(payload)), object.Size)
	body, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	assert.Equal(t, payload, body)

	require.NoError(t, store.Delete(ctx, key))
	_, _, err = store.Get(ctx, key)
	assert.ErrorIs(t, err, ErrObjectNotFound)
	_, err = store.Head(ctx, key)
	assert.ErrorIs(t, err, ErrObjectNotFound)
	// S3 deletes are idempotent, so a replayed delete succeeds.
	require.NoError(t, store.Delete(ctx, key))
}

func TestS3StoreStoresContentType(t *testing.T) {
	server := newFakeS3Server()
	store, _ := newTestS3Store(t, server)
	key := "tasks/7/2026/10/task-1/video"

	_, err := store.PutWithContentType(t.Context(), key, strings.NewReader("video-bytes"), "video/mp4")
	require.NoError(t, err)
	stored, ok := server.object("v1/" + key)
	require.True(t, ok)
	assert.Equal(t, "video/mp4", stored.contentType)
}

func TestS3StoreSpoolsNonSeekableBody(t *testing.T) {
	server := newFakeS3Server()
	store, _ := newTestS3Store(t, server)
	key := "tasks/9/2026/10/task-2/image"
	payload := bytes.Repeat([]byte("streaming-upload-"), 4096)

	info, err := store.Put(t.Context(), key, streamingOnlyReader{reader: bytes.NewReader(payload)})
	require.NoError(t, err)
	assert.Equal(t, int64(len(payload)), info.Size)
	stored, ok := server.object("v1/" + key)
	require.True(t, ok)
	assert.Equal(t, payload, stored.body)
}

type streamingOnlyReader struct {
	reader io.Reader
}

func (r streamingOnlyReader) Read(p []byte) (int, error) {
	return r.reader.Read(p)
}

func TestS3StoreRejectsInvalidKeysBeforeReachingTheEndpoint(t *testing.T) {
	server := newFakeS3Server()
	store, _ := newTestS3Store(t, server)
	keys := []string{
		"",
		".",
		"..",
		"../escape",
		"nested/../../escape",
		"/etc/passwd",
		"nested//key",
		"nested/./key",
		"nested\\key",
		"bad\x00key",
		"trailing/",
		strings.Repeat("a", maxObjectKeyLength+1),
	}
	for index, key := range keys {
		t.Run(fmt.Sprintf("key_%d", index), func(t *testing.T) {
			_, err := store.Put(t.Context(), key, strings.NewReader("x"))
			assert.ErrorIs(t, err, ErrInvalidKey)
			_, _, err = store.Get(t.Context(), key)
			assert.ErrorIs(t, err, ErrInvalidKey)
			_, err = store.Head(t.Context(), key)
			assert.ErrorIs(t, err, ErrInvalidKey)
			assert.ErrorIs(t, store.Delete(t.Context(), key), ErrInvalidKey)
			_, err = store.PresignGet(t.Context(), key, time.Minute)
			assert.ErrorIs(t, err, ErrInvalidKey)
		})
	}
	assert.Zero(t, server.requestCount())
}

func TestS3StoreRejectsCanceledContext(t *testing.T) {
	server := newFakeS3Server()
	store, _ := newTestS3Store(t, server)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	_, err := store.Put(ctx, "tasks/1/2026/10/task-1/image", bytes.NewReader([]byte("x")))
	assert.ErrorIs(t, err, context.Canceled)
	_, _, err = store.Get(ctx, "tasks/1/2026/10/task-1/image")
	assert.ErrorIs(t, err, context.Canceled)
	_, err = store.Head(ctx, "tasks/1/2026/10/task-1/image")
	assert.ErrorIs(t, err, context.Canceled)
	assert.ErrorIs(t, store.Delete(ctx, "tasks/1/2026/10/task-1/image"), context.Canceled)
}

func TestS3StorePresignAppliesPrefixAddressingAndTTL(t *testing.T) {
	store, err := NewS3(testS3Config("https://objects.example.com"))
	require.NoError(t, err)

	// No explicit TTL falls back to the configured 900 seconds.
	presigned, err := store.PresignGet(t.Context(), "tasks/1/2026/10/task-1/image", 0)
	require.NoError(t, err)
	parsed, err := url.Parse(presigned)
	require.NoError(t, err)
	assert.Equal(t, "objects.example.com", parsed.Host)
	assert.Equal(t, "/artifact-bucket/v1/tasks/1/2026/10/task-1/image", parsed.Path)
	assert.Equal(t, "900", parsed.Query().Get("X-Amz-Expires"))
	assert.NotEmpty(t, parsed.Query().Get("X-Amz-Signature"))

	shortLived, err := store.PresignPut(t.Context(), "tasks/1/2026/10/task-1/image", 5*time.Minute)
	require.NoError(t, err)
	assert.Contains(t, shortLived, "X-Amz-Expires=300")
	assert.Contains(t, shortLived, "/artifact-bucket/v1/tasks/1/2026/10/task-1/image")

	_, err = store.PresignGet(t.Context(), "tasks/1/2026/10/task-1/image", maxPresignTTL+time.Second)
	assert.ErrorContains(t, err, "TTL")

	virtualHost := testS3Config("https://objects.example.com")
	virtualHost.S3.PathStyle = false
	virtualStore, err := NewS3(virtualHost)
	require.NoError(t, err)
	presigned, err = virtualStore.PresignGet(t.Context(), "tasks/1/2026/10/task-1/image", 0)
	require.NoError(t, err)
	parsed, err = url.Parse(presigned)
	require.NoError(t, err)
	assert.Equal(t, "artifact-bucket.objects.example.com", parsed.Host)
	assert.Equal(t, "/v1/tasks/1/2026/10/task-1/image", parsed.Path)
}

func TestNewSelectsS3Backend(t *testing.T) {
	store, err := New(testS3Config("https://objects.example.com"))
	require.NoError(t, err)
	s3Store, ok := store.(*S3)
	require.True(t, ok, "New must return the S3 backend implementation")
	assert.Equal(t, system_setting.ObjectStoreBackendS3, s3Store.Backend())

	_, err = NewLocal(testS3Config("https://objects.example.com"))
	assert.ErrorIs(t, err, ErrUnsupportedBackend)
}

func TestNewS3RequiresCompleteConfigurationWithoutLeakingCredentials(t *testing.T) {
	config := testS3Config("https://objects.example.com")
	config.S3.Bucket = ""
	_, err := NewS3(config)
	require.ErrorContains(t, err, "bucket is required")

	config = testS3Config("https://objects.example.com")
	config.S3.AccessKey = "AKIAEXAMPLEACCESSKEY"
	config.S3.SecretKey = "example-secret-value"
	config.S3.Endpoint = "ftp://objects.example.com"
	_, err = NewS3(config)
	require.ErrorContains(t, err, "http or https")
	assert.NotContains(t, err.Error(), "AKIAEXAMPLEACCESSKEY")
	assert.NotContains(t, err.Error(), "example-secret-value")

	config = testS3Config("https://objects.example.com")
	config.PresignTTLSeconds = system_setting.MaxTaskArtifactStorePresignTTLSeconds + 1
	_, err = NewS3(config)
	assert.ErrorContains(t, err, "presign TTL")
}

func TestS3StoreSurfacesEndpointFailures(t *testing.T) {
	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeFakeS3Error(w, http.StatusForbidden, "AccessDenied")
	}))
	defer denied.Close()
	store, err := NewS3(testS3Config(denied.URL))
	require.NoError(t, err)

	key := "tasks/1/2026/10/task-1/image"
	_, err = store.Head(t.Context(), key)
	require.Error(t, err)
	assert.NotErrorIs(t, err, ErrObjectNotFound)
	assert.Contains(t, err.Error(), key)
}
