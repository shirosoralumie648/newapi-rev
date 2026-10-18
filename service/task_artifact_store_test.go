package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service/objectstore"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var (
	_ TaskArtifactStore = disabledArtifactStore{}
	_ TaskArtifactStore = (*objectTaskArtifactStore)(nil)
)

// installServiceDefaultObjectStore points the process-wide object store at a
// temporary local directory so the persistence pipeline and the read path
// exercise the real write, head, and serve behavior.
func installServiceDefaultObjectStore(t *testing.T) *objectstore.Local {
	t.Helper()
	store, err := objectstore.NewLocal(system_setting.ObjectStoreConfig{
		Backend:           system_setting.ObjectStoreBackendLocal,
		LocalDir:          t.TempDir(),
		PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
	})
	require.NoError(t, err)
	previousStore := objectstore.DefaultStore()
	previousTTL := objectstore.DefaultPresignTTL()
	objectstore.SetDefaultStore(store, time.Minute)
	t.Cleanup(func() {
		objectstore.SetDefaultStore(previousStore, previousTTL)
		_ = store.Close()
	})
	return store
}

func clearServiceDefaultObjectStore(t *testing.T) {
	t.Helper()
	previousStore := objectstore.DefaultStore()
	previousTTL := objectstore.DefaultPresignTTL()
	objectstore.SetDefaultStore(nil, previousTTL)
	t.Cleanup(func() { objectstore.SetDefaultStore(previousStore, previousTTL) })
}

// installTaskArtifactTestFetchClient swaps the SSRF-fetching client and the
// pre-flight target check of the store pass for permissive ones, so an
// httptest server on the loopback address can act as the provider. The
// dedicated SSRF test uses the real client and validator.
func installTaskArtifactTestFetchClient(t *testing.T) {
	t.Helper()
	previousClient := taskArtifactFetchClient
	previousValidator := taskArtifactFetchTargetValidator
	taskArtifactFetchClient = &http.Client{}
	taskArtifactFetchTargetValidator = func(context.Context, *url.URL) error { return nil }
	t.Cleanup(func() {
		taskArtifactFetchClient = previousClient
		taskArtifactFetchTargetValidator = previousValidator
	})
}

func usePlaygroundArtifactQuota(t *testing.T, mutate func(policy *playground_setting.PlaygroundQuotaPolicy)) {
	t.Helper()
	defaults := playground_setting.GetPlaygroundSetting().Defaults
	previous := *defaults
	mutate(defaults)
	t.Cleanup(func() { *defaults = previous })
}

// mp4Fixture builds a minimal MP4 header that the content sniffer identifies as
// video/mp4, so media-type validation accepts a realistic provider result.
func mp4Fixture(size int) []byte {
	payload := make([]byte, size)
	copy(payload, []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'm', 'p', '4', '2'})
	return payload
}

func seedPlaygroundArtifactTask(t *testing.T, taskID string, userID int) *model.Task {
	t.Helper()
	now := common.GetTimestamp()
	task := &model.Task{
		TaskID: taskID, Platform: "sunoapi", UserId: userID, Status: model.TaskStatusSuccess,
		SubmitTime: now, FinishTime: now, CreatedAt: now, Progress: "100%",
		PrivateData: model.TaskPrivateData{PlaygroundOrigin: true},
	}
	require.NoError(t, model.DB.Create(task).Error)
	return task
}

// fakeArtifactCollector drives the store pass without a relay adaptor: it
// returns fixed seeds and one provider request.
type fakeArtifactCollector struct {
	seeds  []model.PlaygroundTaskArtifactSeed
	source *TaskArtifactSource
	err    error
}

func (f fakeArtifactCollector) ListTaskArtifacts(*model.Task) ([]model.PlaygroundTaskArtifactSeed, error) {
	return f.seeds, nil
}

func (f fakeArtifactCollector) BuildTaskArtifactRequest(context.Context, *model.Task, string) (*TaskArtifactSource, error) {
	if f.err != nil {
		return nil, f.err
	}
	source := *f.source
	return &source, nil
}

func oneVideoArtifactCollector(source *TaskArtifactSource) fakeArtifactCollector {
	return fakeArtifactCollector{
		seeds:  []model.PlaygroundTaskArtifactSeed{{Key: "video", Type: "video", MimeType: "video/mp4"}},
		source: source,
	}
}

func TestDisabledTaskArtifactStoreHasNoStorageBehavior(t *testing.T) {
	truncate(t)
	clearServiceDefaultObjectStore(t)
	store := GetTaskArtifactStore()
	require.NotNil(t, store)
	assert.False(t, store.Enabled())
	assert.False(t, TaskArtifactStoreConfigured())

	task := &model.Task{TaskID: "task-disabled-store", UserId: 7}
	ref, err := store.Resolve(t.Context(), task, types.TaskArtifact{Key: "video", Type: "video"})
	require.NoError(t, err)
	assert.Nil(t, ref)

	ref, err = store.Persist(t.Context(), task, types.TaskArtifact{Key: "video", Type: "video"}, strings.NewReader("content"))
	assert.Nil(t, ref)
	assert.ErrorIs(t, err, ErrTaskArtifactStoreDisabled)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/task/task-disabled-store/artifacts/video/content", nil)
	ref = &StoredArtifactRef{Backend: "local", ArtifactKey: "video", ObjectKey: "pg/7/task/2026/10/task-disabled-store/video"}
	assert.ErrorIs(t, store.Serve(c, task, ref), ErrTaskArtifactStoreDisabled)
	assert.Same(t, store, GetTaskArtifactStore())
}

func TestNewTaskArtifactStoreRequiresCompleteS3Configuration(t *testing.T) {
	clearServiceDefaultObjectStore(t)
	upstream := newTaskArtifactStore(system_setting.TaskArtifactStoreConfig{
		Mode:                system_setting.TaskArtifactStoreModeUpstream,
		S3PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
		RetentionDays:       system_setting.DefaultTaskArtifactRetentionDays,
	})
	assert.False(t, upstream.Enabled(), "no object store is configured yet")

	// A bucket without endpoint, region, or credentials must not enable the
	// backend; artifacts keep flowing through the provider proxy.
	incomplete := newTaskArtifactStore(system_setting.TaskArtifactStoreConfig{
		Mode:                system_setting.TaskArtifactStoreModeS3,
		S3Prefix:            "tasks/v1",
		S3PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
		RetentionDays:       system_setting.DefaultTaskArtifactRetentionDays,
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
		RetentionDays:       system_setting.DefaultTaskArtifactRetentionDays,
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

func TestS3TaskArtifactStorePersistsRecordsAndServes(t *testing.T) {
	truncate(t)
	seedUser(t, 7, 0)
	server := newFakeArtifactS3()
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	store := newTestS3ArtifactStore(t, httpServer.URL)
	task := testArtifactTask()
	require.NoError(t, model.DB.Create(task).Error)
	artifact := types.TaskArtifact{Key: "video", Type: "video", MimeType: "video/mp4"}

	ref, err := store.Persist(t.Context(), task, artifact, bytes.NewReader([]byte("video-bytes")))
	require.NoError(t, err)
	require.NotNil(t, ref)
	assert.Equal(t, system_setting.ObjectStoreBackendS3, ref.Backend)
	assert.Equal(t, "artifact-bucket", ref.Bucket)
	assert.Equal(t, "video", ref.ArtifactKey)
	assert.Equal(t, "pg/7/task/2026/10/task-1/video", ref.ObjectKey)
	assert.Equal(t, "video/mp4", ref.MimeType)
	assert.Equal(t, int64(len("video-bytes")), ref.Size)
	body, ok := server.object("tasks/v1/" + ref.ObjectKey)
	require.True(t, ok)
	assert.Equal(t, []byte("video-bytes"), body)
	assert.Equal(t, "video/mp4", server.contentType("tasks/v1/"+ref.ObjectKey))
	// The bucket path carries the configured prefix and the deterministic key.
	assert.Equal(t, "artifact-bucket/tasks/v1/"+ref.ObjectKey, server.lastRequestPath())

	// Bytes without a record are never served: the caller keeps proxying the
	// provider reference until the store pass records the object.
	resolved, err := store.Resolve(t.Context(), task, artifact)
	require.NoError(t, err)
	assert.Nil(t, resolved)

	records, err := model.EnsurePlaygroundTaskArtifacts(7, "task-1", []model.PlaygroundTaskArtifactSeed{{Key: "video", Type: "video", MimeType: "video/mp4"}})
	require.NoError(t, err)
	require.Len(t, records, 1)
	require.NoError(t, model.MarkPlaygroundTaskArtifactStored(records[0].ID, ref.Backend, ref.ObjectKey, ref.MimeType, ref.Size, "hash", common.GetTimestamp()+3600, ""))

	resolved, err = store.Resolve(t.Context(), task, artifact)
	require.NoError(t, err)
	require.NotNil(t, resolved)
	assert.Equal(t, ref.ObjectKey, resolved.ObjectKey)
	assert.Equal(t, ref.Size, resolved.Size)
	assert.Equal(t, "video/mp4", resolved.MimeType)

	// Another task never resolves the object through its own key.
	other := &model.Task{TaskID: "task-2", UserId: 7, CreatedAt: task.CreatedAt}
	otherRef, err := store.Resolve(t.Context(), other, artifact)
	require.NoError(t, err)
	assert.Nil(t, otherRef)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/task/task-1/artifacts/video", nil)
	require.NoError(t, store.Serve(c, task, resolved))
	assert.Equal(t, http.StatusFound, recorder.Code)
	assert.Equal(t, "private, no-store", recorder.Header().Get("Cache-Control"))
	location := recorder.Header().Get("Location")
	require.NotEmpty(t, location)
	assert.Contains(t, location, "X-Amz-Signature=")
	assert.Contains(t, location, "X-Amz-Expires=900")
	assert.Contains(t, location, "/artifact-bucket/tasks/v1/pg/7/task/2026/10/task-1/video")

	// A record whose object vanished is not served, so the caller falls back.
	require.NoError(t, store.(*objectTaskArtifactStore).objects.Delete(t.Context(), ref.ObjectKey))
	resolved, err = store.Resolve(t.Context(), task, artifact)
	require.NoError(t, err)
	assert.Nil(t, resolved)

	// A reference that belongs to another backend is refused before anything
	// is written to the response.
	foreign := &StoredArtifactRef{
		Backend:     system_setting.ObjectStoreBackendLocal,
		ArtifactKey: "video",
		ObjectKey:   "pg/9/task/2026/10/task-9/video",
	}
	foreignRecorder := httptest.NewRecorder()
	foreignContext, _ := gin.CreateTestContext(foreignRecorder)
	foreignContext.Request = httptest.NewRequest(http.MethodGet, "/api/task/task-1/artifacts/video", nil)
	assert.ErrorContains(t, store.Serve(foreignContext, task, foreign), "does not belong")
	assert.Equal(t, http.StatusOK, foreignRecorder.Code)
}

func TestTaskArtifactStoreRejectsUnsafeIdentifiers(t *testing.T) {
	truncate(t)
	seedUser(t, 7, 0)
	server := newFakeArtifactS3()
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	store := newTestS3ArtifactStore(t, httpServer.URL)
	task := testArtifactTask()
	require.NoError(t, model.DB.Create(task).Error)

	for _, key := range []string{"", ".", "..", "nested/video", "video\\key", "video\x00key"} {
		artifact := types.TaskArtifact{Key: key, Type: "video"}
		resolved, err := store.Resolve(t.Context(), task, artifact)
		assert.NoError(t, err)
		assert.Nil(t, resolved)
		_, err = store.Persist(t.Context(), task, artifact, strings.NewReader("x"))
		assert.Error(t, err, "persist key %q", key)
	}

	unsafeTask := &model.Task{TaskID: "task-1/../task-9", UserId: 7, CreatedAt: task.CreatedAt}
	_, err := store.Persist(t.Context(), unsafeTask, types.TaskArtifact{Key: "video", Type: "video"}, strings.NewReader("x"))
	assert.ErrorContains(t, err, "unsafe task or artifact key")

	_, err = store.Persist(t.Context(), task, types.TaskArtifact{Key: "video", Type: "video"}, nil)
	assert.ErrorContains(t, err, "content is required")

	// No malformed key ever reached the bucket.
	assert.Zero(t, server.requestCount())
}

// The persistence pipeline pulls a provider URL, verifies the bytes, writes
// them into the shared object store, records the retention window, and marks
// the task as projected so a second pass does not re-list it.
func TestPlaygroundTaskArtifactStorePersistsProviderURLResult(t *testing.T) {
	truncate(t)
	seedUser(t, 7, 0)
	installTaskArtifactTestFetchClient(t)
	store := installServiceDefaultObjectStore(t)
	task := seedPlaygroundArtifactTask(t, "task-artifact-http", 7)
	payload := mp4Fixture(512)
	var requests int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		_, _ = w.Write(payload)
	}))
	defer provider.Close()

	collector := oneVideoArtifactCollector(&TaskArtifactSource{URL: provider.URL + "/result.mp4", Method: http.MethodGet, Credentialless: true})
	summary, err := StorePendingPlaygroundTaskArtifacts(t.Context(), collector, 4)
	require.NoError(t, err)
	assert.Equal(t, 1, summary.TasksScanned)
	assert.Equal(t, 1, summary.ArtifactsStored)

	records, err := model.PlaygroundTaskArtifactsForTask(7, task.TaskID)
	require.NoError(t, err)
	require.Len(t, records, 1)
	record := records[0]
	assert.Equal(t, model.TaskArtifactStateStored, record.State)
	assert.EqualValues(t, len(payload), record.ByteSize)
	assert.Equal(t, playgroundArtifactContentHashHex(payload), record.ContentHash)
	assert.Equal(t, "video/mp4", record.MimeType)
	assert.Greater(t, record.ExpiresAt, common.GetTimestamp())
	assert.Contains(t, record.ObjectKey, "pg/7/task/")
	assert.NotEmpty(t, record.UpstreamRef)

	// The stored object holds the provider bytes.
	reader, info, err := store.Get(t.Context(), record.ObjectKey)
	require.NoError(t, err)
	stored, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	assert.Equal(t, payload, stored)
	assert.EqualValues(t, len(payload), info.Size)

	// The read path resolves the stored copy and streams it with safe headers
	// instead of asking the provider again.
	ref, err := GetTaskArtifactStore().Resolve(t.Context(), task, types.TaskArtifact{Key: "video", Type: "video", MimeType: "video/mp4"})
	require.NoError(t, err)
	require.NotNil(t, ref)
	assert.Equal(t, record.ObjectKey, ref.ObjectKey)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/task/task-artifact-http/artifacts/video/content", nil)
	require.NoError(t, GetTaskArtifactStore().Serve(c, task, ref))
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, payload, recorder.Body.Bytes())
	assert.Equal(t, "video/mp4", recorder.Header().Get("Content-Type"))
	assert.Equal(t, "nosniff", recorder.Header().Get("X-Content-Type-Options"))
	assert.Equal(t, "private, no-store", recorder.Header().Get("Cache-Control"))

	// The projection marker stops the next pass from listing the task again.
	summary, err = StorePendingPlaygroundTaskArtifacts(t.Context(), collector, 4)
	require.NoError(t, err)
	assert.Zero(t, summary.TasksScanned)
	assert.EqualValues(t, 1, atomic.LoadInt32(&requests))

	// The stored bytes count against the account result budget.
	storedBytes, err := model.PlaygroundTaskResultStorageBytes(7)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, storedBytes, int64(len(payload)))
}

func playgroundArtifactContentHashHex(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// An inline base64 provider result is decoded, validated, and stored like an
// HTTP result.
func TestPlaygroundTaskArtifactStoreDecodesInlineBase64Result(t *testing.T) {
	truncate(t)
	seedUser(t, 7, 0)
	installTaskArtifactTestFetchClient(t)
	store := installServiceDefaultObjectStore(t)
	task := seedPlaygroundArtifactTask(t, "task-artifact-inline", 7)
	payload := mp4Fixture(256)

	source := &TaskArtifactSource{
		URL:    "data:video/mp4;base64," + base64.StdEncoding.EncodeToString(payload),
		Method: http.MethodGet,
	}
	summary, err := StorePendingPlaygroundTaskArtifacts(t.Context(), oneVideoArtifactCollector(source), 4)
	require.NoError(t, err)
	assert.Equal(t, 1, summary.ArtifactsStored)

	records, err := model.PlaygroundTaskArtifactsForTask(7, task.TaskID)
	require.NoError(t, err)
	require.Len(t, records, 1)
	assert.Equal(t, model.TaskArtifactStateStored, records[0].State)
	reader, _, err := store.Get(t.Context(), records[0].ObjectKey)
	require.NoError(t, err)
	stored, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	assert.Equal(t, payload, stored)
}

// A provider result that cannot be trusted (wrong media type, too large, or a
// dead link) is marked expired with a diagnostic reason instead of being
// retried forever or silently dropped.
func TestPlaygroundTaskArtifactStoreRejectsUnsupportedProviderContent(t *testing.T) {
	cases := []struct {
		name    string
		payload []byte
		headers map[string]string
		status  int
		// lowerMax shrinks the per-object cap so an oversize result is
		// rejected without a 512 MiB fixture.
		lowerMax bool
	}{
		{name: "html body behind a video content type", payload: []byte("<html><body>not a video</body></html>"), headers: map[string]string{"Content-Type": "video/mp4"}},
		{name: "oversize body", payload: mp4Fixture(4096), headers: map[string]string{"Content-Type": "video/mp4"}, lowerMax: true},
		{name: "provider not found", payload: []byte("gone"), headers: map[string]string{"Content-Type": "video/mp4"}, status: http.StatusNotFound},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			truncate(t)
			seedUser(t, 7, 0)
			installTaskArtifactTestFetchClient(t)
			installServiceDefaultObjectStore(t)
			if testCase.lowerMax {
				previous := taskArtifactObjectMaxBytes
				taskArtifactObjectMaxBytes = 128
				t.Cleanup(func() { taskArtifactObjectMaxBytes = previous })
			}
			task := seedPlaygroundArtifactTask(t, "task-artifact-reject", 7)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for name, value := range testCase.headers {
					w.Header().Set(name, value)
				}
				// A zero status means the case serves a plain 200; writing it
				// would panic the handler and turn the case into a dead link.
				if testCase.status != 0 {
					w.WriteHeader(testCase.status)
				}
				_, _ = w.Write(testCase.payload)
			}))
			defer provider.Close()

			collector := oneVideoArtifactCollector(&TaskArtifactSource{URL: provider.URL + "/result.mp4", Method: http.MethodGet, Credentialless: true})
			summary, err := StorePendingPlaygroundTaskArtifacts(t.Context(), collector, 4)
			require.NoError(t, err)
			assert.Equal(t, 1, summary.ArtifactsExpired)

			records, err := model.PlaygroundTaskArtifactsForTask(7, task.TaskID)
			require.NoError(t, err)
			require.Len(t, records, 1)
			assert.Equal(t, model.TaskArtifactStateExpired, records[0].State)
			assert.NotEmpty(t, records[0].LastError)
			assert.Zero(t, records[0].ByteSize)
			assert.NotEmpty(t, records[0].UpstreamRef, "the provider reference is kept so the artifact is never silently dropped")

			ref, err := GetTaskArtifactStore().Resolve(t.Context(), task, types.TaskArtifact{Key: "video", Type: "video"})
			require.NoError(t, err)
			assert.Nil(t, ref)

			// The projection is complete, so the pass stops listing the task.
			summary, err = StorePendingPlaygroundTaskArtifacts(t.Context(), collector, 4)
			require.NoError(t, err)
			assert.Zero(t, summary.TasksScanned)
		})
	}
}

// The store pass refuses a provider URL that points back at the deployment's
// own network: only http(s) is accepted, and loopback or private addresses are
// rejected before a connection is opened.
func TestPlaygroundTaskArtifactStoreRefusesInternalProviderURLs(t *testing.T) {
	truncate(t)
	seedUser(t, 7, 0)
	installServiceDefaultObjectStore(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(mp4Fixture(128))
	}))
	defer provider.Close()

	task := seedPlaygroundArtifactTask(t, "task-artifact-ssrf", 7)
	collector := oneVideoArtifactCollector(&TaskArtifactSource{URL: provider.URL + "/result.mp4", Method: http.MethodGet, Credentialless: true})
	summary, err := StorePendingPlaygroundTaskArtifacts(t.Context(), collector, 4)
	require.NoError(t, err)
	assert.Equal(t, 1, summary.ArtifactsExpired)

	records, err := model.PlaygroundTaskArtifactsForTask(7, task.TaskID)
	require.NoError(t, err)
	require.Len(t, records, 1)
	assert.Equal(t, model.TaskArtifactStateExpired, records[0].State)
	assert.Contains(t, records[0].LastError, "private IP")

	// A scheme outside http(s) never reaches the network either.
	other := seedPlaygroundArtifactTask(t, "task-artifact-scheme", 7)
	schemeCollector := oneVideoArtifactCollector(&TaskArtifactSource{URL: "file:///etc/passwd", Method: http.MethodGet})
	summary, err = StorePendingPlaygroundTaskArtifacts(t.Context(), schemeCollector, 4)
	require.NoError(t, err)
	assert.Equal(t, 1, summary.ArtifactsExpired)
	records, err = model.PlaygroundTaskArtifactsForTask(7, other.TaskID)
	require.NoError(t, err)
	require.Len(t, records, 1)
	assert.Contains(t, records[0].LastError, "http or https")
}

// Exhausting the account result budget keeps the provider reference and marks
// the artifact expired; the bytes are not stored and the budget never
// overshoots.
func TestPlaygroundTaskArtifactStoreKeepsUpstreamReferenceWhenOverQuota(t *testing.T) {
	truncate(t)
	seedUser(t, 7, 0)
	installTaskArtifactTestFetchClient(t)
	installServiceDefaultObjectStore(t)
	usePlaygroundArtifactQuota(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.TaskUserResultMaxBytes = 1
	})
	task := seedPlaygroundArtifactTask(t, "task-artifact-quota", 7)
	payload := mp4Fixture(1024)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		_, _ = w.Write(payload)
	}))
	defer provider.Close()

	collector := oneVideoArtifactCollector(&TaskArtifactSource{URL: provider.URL + "/result.mp4", Method: http.MethodGet, Credentialless: true})
	summary, err := StorePendingPlaygroundTaskArtifacts(t.Context(), collector, 4)
	require.NoError(t, err)
	assert.Equal(t, 1, summary.ArtifactsExpired)

	records, err := model.PlaygroundTaskArtifactsForTask(7, task.TaskID)
	require.NoError(t, err)
	require.Len(t, records, 1)
	assert.Equal(t, model.TaskArtifactStateExpired, records[0].State)
	assert.Contains(t, records[0].LastError, "storage limit")
	assert.Zero(t, records[0].ByteSize)
	assert.Empty(t, records[0].ObjectKey)
	assert.NotEmpty(t, records[0].UpstreamRef)

	storedBytes, err := model.PlaygroundTaskArtifactStoredBytes(7)
	require.NoError(t, err)
	assert.Zero(t, storedBytes)
}

// A transient provider failure keeps the artifact pending and retries it; after
// the attempt budget the artifact is expired while its provider reference
// stays behind.
func TestPlaygroundTaskArtifactStoreRetriesTransientFailures(t *testing.T) {
	truncate(t)
	seedUser(t, 7, 0)
	installTaskArtifactTestFetchClient(t)
	installServiceDefaultObjectStore(t)
	task := seedPlaygroundArtifactTask(t, "task-artifact-retry", 7)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "busy", http.StatusInternalServerError)
	}))
	defer provider.Close()

	collector := oneVideoArtifactCollector(&TaskArtifactSource{URL: provider.URL + "/result.mp4", Method: http.MethodGet, Credentialless: true})
	for attempt := 1; attempt <= 4; attempt++ {
		summary, err := StorePendingPlaygroundTaskArtifacts(t.Context(), collector, 4)
		require.NoError(t, err)
		assert.Equal(t, 1, summary.ArtifactsPending, "attempt %d", attempt)
		records, err := model.PlaygroundTaskArtifactsForTask(7, task.TaskID)
		require.NoError(t, err)
		require.Len(t, records, 1)
		assert.Equal(t, model.TaskArtifactStatePending, records[0].State)
		assert.Equal(t, attempt, records[0].Attempts)
	}

	summary, err := StorePendingPlaygroundTaskArtifacts(t.Context(), collector, 4)
	require.NoError(t, err)
	assert.Equal(t, 1, summary.ArtifactsExpired)
	records, err := model.PlaygroundTaskArtifactsForTask(7, task.TaskID)
	require.NoError(t, err)
	require.Len(t, records, 1)
	assert.Equal(t, model.TaskArtifactStateExpired, records[0].State)
	assert.NotEmpty(t, records[0].UpstreamRef)
}

// The retention cleanup deletes the stored object and its record once the
// window ends, but never touches a result pinned by the asset library or a
// canvas.
func TestDeleteExpiredTaskArtifactObjectsSkipsPinnedResults(t *testing.T) {
	truncate(t)
	seedUser(t, 7, 0)
	store := installServiceDefaultObjectStore(t)
	task := seedPlaygroundArtifactTask(t, "task-artifact-expiry", 7)

	records, err := model.EnsurePlaygroundTaskArtifacts(7, task.TaskID, []model.PlaygroundTaskArtifactSeed{
		{Key: "video", Type: "video", MimeType: "video/mp4"},
		{Key: "thumb", Type: "image", MimeType: "image/png"},
	})
	require.NoError(t, err)
	require.Len(t, records, 2)
	expiredAt := common.GetTimestamp() - 60
	for index := range records {
		objectKey := "pg/7/task/2026/10/" + task.TaskID + "/" + records[index].ArtifactKey
		_, err := store.Put(t.Context(), objectKey, bytes.NewReader(mp4Fixture(64)))
		require.NoError(t, err)
		require.NoError(t, model.MarkPlaygroundTaskArtifactStored(records[index].ID, store.Backend(), objectKey, "video/mp4", 64, "hash", expiredAt, ""))
	}
	require.NoError(t, model.SetPlaygroundTaskArtifactPin(7, task.TaskID, "thumb", true))

	deleted, err := DeleteExpiredTaskArtifactObjects(t.Context(), 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, deleted)

	remaining, err := model.PlaygroundTaskArtifactsForTask(7, task.TaskID)
	require.NoError(t, err)
	require.Len(t, remaining, 1)
	assert.Equal(t, "thumb", remaining[0].ArtifactKey)
	assert.Equal(t, model.TaskArtifactStateStored, remaining[0].State)

	// The pinned artifact still resolves after the window; the collected one
	// does not.
	pinnedRef, err := GetTaskArtifactStore().Resolve(t.Context(), task, types.TaskArtifact{Key: "thumb", Type: "image"})
	require.NoError(t, err)
	require.NotNil(t, pinnedRef)
	collectedRef, err := GetTaskArtifactStore().Resolve(t.Context(), task, types.TaskArtifact{Key: "video", Type: "video"})
	require.NoError(t, err)
	assert.Nil(t, collectedRef)
}
