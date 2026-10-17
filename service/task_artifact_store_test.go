package service

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var (
	_ TaskArtifactStore = disabledArtifactStore{}
	_ TaskArtifactStore = (*s3TaskArtifactStore)(nil)
)

func TestDisabledTaskArtifactStoreHasNoStorageBehavior(t *testing.T) {
	store := GetTaskArtifactStore()
	require.NotNil(t, store)
	assert.False(t, store.Enabled())

	task := &model.Task{TaskID: "task-disabled-store"}
	ref, err := store.Resolve(t.Context(), task, types.TaskArtifact{Key: "video", Type: "video"})
	require.NoError(t, err)
	assert.Nil(t, ref)

	ref, err = store.Persist(t.Context(), task, types.TaskArtifact{Key: "video", Type: "video"}, strings.NewReader("content"))
	assert.Nil(t, ref)
	assert.ErrorIs(t, err, ErrTaskArtifactStoreDisabled)
	assert.ErrorIs(t, store.Serve(&gin.Context{}, task, &StoredArtifactRef{Backend: "s3"}), ErrTaskArtifactStoreDisabled)
	assert.Same(t, store, GetTaskArtifactStore())
}

func TestNewTaskArtifactStoreRequiresCompleteS3Configuration(t *testing.T) {
	upstream := newTaskArtifactStore(system_setting.TaskArtifactStoreConfig{
		Mode:                system_setting.TaskArtifactStoreModeUpstream,
		S3PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
	})
	assert.False(t, upstream.Enabled())

	// A bucket without endpoint, region, or credentials must not enable the
	// backend; artifacts keep flowing through the provider proxy.
	incomplete := newTaskArtifactStore(system_setting.TaskArtifactStoreConfig{
		Mode:                system_setting.TaskArtifactStoreModeS3,
		S3Prefix:            "tasks/v1",
		S3PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
	})
	assert.False(t, incomplete.Enabled())
	task := &model.Task{TaskID: "task-incomplete", UserId: 1, CreatedAt: time.Now().Unix()}
	_, err := incomplete.Persist(t.Context(), task, types.TaskArtifact{Key: "video", Type: "video"}, strings.NewReader("content"))
	assert.ErrorIs(t, err, ErrTaskArtifactStoreDisabled)
}

// fakeArtifactS3 is an in-memory path-style S3 endpoint for httptest.
type fakeArtifactS3 struct {
	mu        sync.Mutex
	objects   map[string][]byte
	requests  int
	lastPath  string
	lastTypes map[string]string
}

func newFakeArtifactS3() *fakeArtifactS3 {
	return &fakeArtifactS3{
		objects:   make(map[string][]byte),
		lastTypes: make(map[string]string),
	}
}

func (f *fakeArtifactS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	f.mu.Lock()
	f.requests++
	f.lastPath = path
	f.mu.Unlock()

	bucket, key, found := strings.Cut(path, "/")
	if !found || bucket != "artifact-bucket" {
		writeFakeArtifactS3Error(w, http.StatusNotFound, "NoSuchBucket")
		return
	}
	switch r.Method {
	case http.MethodPut:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeFakeArtifactS3Error(w, http.StatusInternalServerError, "InternalError")
			return
		}
		f.mu.Lock()
		f.objects[key] = body
		f.lastTypes[key] = r.Header.Get("Content-Type")
		f.mu.Unlock()
		w.Header().Set("ETag", `"fake-etag"`)
		w.WriteHeader(http.StatusOK)
	case http.MethodHead, http.MethodGet:
		body, ok := f.object(key)
		if !ok {
			code := "NoSuchKey"
			if r.Method == http.MethodHead {
				code = "NotFound"
			}
			writeFakeArtifactS3Error(w, http.StatusNotFound, code)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Header().Set("Last-Modified", time.Now().UTC().Truncate(time.Second).Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = w.Write(body)
		}
	case http.MethodDelete:
		f.mu.Lock()
		delete(f.objects, key)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		writeFakeArtifactS3Error(w, http.StatusMethodNotAllowed, "MethodNotAllowed")
	}
}

func (f *fakeArtifactS3) object(key string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, ok := f.objects[key]
	return body, ok
}

func (f *fakeArtifactS3) lastRequestPath() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastPath
}

func (f *fakeArtifactS3) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests
}

func (f *fakeArtifactS3) contentType(key string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastTypes[key]
}

func writeFakeArtifactS3Error(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>` + code + `</Code></Error>`))
}

func newTestS3ArtifactStore(t *testing.T, endpoint string) TaskArtifactStore {
	t.Helper()
	store := newTaskArtifactStore(system_setting.TaskArtifactStoreConfig{
		Mode: system_setting.TaskArtifactStoreModeS3,
		S3: system_setting.S3Settings{
			Endpoint:  endpoint,
			Bucket:    "artifact-bucket",
			Region:    "us-east-1",
			AccessKey: "access-key",
			SecretKey: "secret-key",
			PathStyle: true,
		},
		S3Prefix:            "tasks/v1",
		S3PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
	})
	require.True(t, store.Enabled())
	return store
}

func testArtifactTask() *model.Task {
	return &model.Task{
		TaskID:    "task-1",
		UserId:    7,
		CreatedAt: time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC).Unix(),
	}
}

func TestS3TaskArtifactStorePersistResolveAndServe(t *testing.T) {
	server := newFakeArtifactS3()
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	store := newTestS3ArtifactStore(t, httpServer.URL)
	task := testArtifactTask()
	artifact := types.TaskArtifact{Key: "video", Type: "video", MimeType: "video/mp4"}

	// Nothing was persisted yet, so the caller keeps proxying upstream.
	ref, err := store.Resolve(t.Context(), task, artifact)
	require.NoError(t, err)
	assert.Nil(t, ref)

	ref, err = store.Persist(t.Context(), task, artifact, bytes.NewReader([]byte("video-bytes")))
	require.NoError(t, err)
	require.NotNil(t, ref)
	assert.Equal(t, system_setting.ObjectStoreBackendS3, ref.Backend)
	assert.Equal(t, "artifact-bucket", ref.Bucket)
	assert.Equal(t, "video", ref.ArtifactKey)
	assert.Equal(t, "tasks/7/2026/10/task-1/video", ref.ObjectKey)
	assert.Equal(t, "video/mp4", ref.MimeType)
	assert.Equal(t, int64(len("video-bytes")), ref.Size)
	body, ok := server.object("tasks/v1/" + ref.ObjectKey)
	require.True(t, ok)
	assert.Equal(t, []byte("video-bytes"), body)
	assert.Equal(t, "video/mp4", server.contentType("tasks/v1/"+ref.ObjectKey))
	// The bucket path carries the configured prefix and the deterministic key.
	assert.Equal(t, "artifact-bucket/tasks/v1/"+ref.ObjectKey, server.lastRequestPath())

	resolved, err := store.Resolve(t.Context(), task, artifact)
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Equal(t, ref.ObjectKey, resolved.ObjectKey)
	assert.Equal(t, ref.Size, resolved.Size)
	assert.Equal(t, ref.MimeType, resolved.MimeType)

	// Another task never resolves the object through its own key.
	other := &model.Task{TaskID: "task-2", UserId: 7, CreatedAt: task.CreatedAt}
	otherRef, err := store.Resolve(t.Context(), other, artifact)
	require.NoError(t, err)
	assert.Nil(t, otherRef)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/task/task-1/artifacts/video", nil)
	require.NoError(t, store.Serve(c, task, ref))
	assert.Equal(t, http.StatusFound, recorder.Code)
	assert.Equal(t, "private, no-store", recorder.Header().Get("Cache-Control"))
	location := recorder.Header().Get("Location")
	require.NotEmpty(t, location)
	assert.Contains(t, location, "X-Amz-Signature=")
	assert.Contains(t, location, "X-Amz-Expires=900")
	assert.Contains(t, location, "/artifact-bucket/tasks/v1/tasks/7/2026/10/task-1/video")

	// A reference that belongs to another task or backend is refused before
	// anything is written to the response.
	foreign := &StoredArtifactRef{
		Backend:     system_setting.ObjectStoreBackendS3,
		ArtifactKey: "video",
		ObjectKey:   "tasks/9/2026/10/task-9/video",
	}
	foreignRecorder := httptest.NewRecorder()
	foreignContext, _ := gin.CreateTestContext(foreignRecorder)
	foreignContext.Request = httptest.NewRequest(http.MethodGet, "/api/task/task-1/artifacts/video", nil)
	assert.ErrorContains(t, store.Serve(foreignContext, task, foreign), "does not belong")
	assert.Equal(t, http.StatusOK, foreignRecorder.Code)
}

func TestS3TaskArtifactStoreRejectsUnsafeIdentifiers(t *testing.T) {
	server := newFakeArtifactS3()
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	store := newTestS3ArtifactStore(t, httpServer.URL)
	task := testArtifactTask()

	for _, key := range []string{"", ".", "..", "nested/video", "video\\key", "video\x00key"} {
		artifact := types.TaskArtifact{Key: key, Type: "video"}
		_, err := store.Resolve(t.Context(), task, artifact)
		assert.Error(t, err, "resolve key %q", key)
		_, err = store.Persist(t.Context(), task, artifact, strings.NewReader("x"))
		assert.Error(t, err, "persist key %q", key)
	}

	unsafeTask := &model.Task{TaskID: "task-1/../task-9", UserId: 7, CreatedAt: task.CreatedAt}
	_, err := store.Resolve(t.Context(), unsafeTask, types.TaskArtifact{Key: "video", Type: "video"})
	assert.ErrorContains(t, err, "unsafe task or artifact key")

	_, err = store.Persist(t.Context(), task, types.TaskArtifact{Key: "video", Type: "video"}, nil)
	assert.ErrorContains(t, err, "content is required")

	// No malformed key ever reached the bucket.
	assert.Zero(t, server.requestCount())
}
