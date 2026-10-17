package objectstore

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestLocalStore(t *testing.T, root, prefix string) *Local {
	t.Helper()
	store, err := NewLocal(system_setting.ObjectStoreConfig{
		Backend:           system_setting.ObjectStoreBackendLocal,
		LocalDir:          root,
		Prefix:            prefix,
		PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, store.Close()) })
	return store
}

func TestLocalStoreRoundTrip(t *testing.T) {
	root := t.TempDir()
	store := newTestLocalStore(t, root, "")
	ctx := t.Context()
	key := "pg/7/attachments/2026/10/object-a"

	payload := bytes.Repeat([]byte("streaming-object-store-"), 4096)
	info, err := store.Put(ctx, key, bytes.NewReader(payload))
	require.NoError(t, err)
	assert.Equal(t, key, info.Key)
	assert.Equal(t, int64(len(payload)), info.Size)
	assert.Equal(t, system_setting.ObjectStoreBackendLocal, store.Backend())

	head, err := store.Head(ctx, key)
	require.NoError(t, err)
	assert.Equal(t, int64(len(payload)), head.Size)

	reader, object, err := store.Get(ctx, key)
	require.NoError(t, err)
	assert.Equal(t, int64(len(payload)), object.Size)
	body, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	assert.Equal(t, payload, body)

	stored, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(key)))
	require.NoError(t, err)
	assert.Equal(t, payload, stored)

	replacement := []byte("replacement")
	_, err = store.Put(ctx, key, bytes.NewReader(replacement))
	require.NoError(t, err)
	body, err = os.ReadFile(filepath.Join(root, filepath.FromSlash(key)))
	require.NoError(t, err)
	assert.Equal(t, replacement, body)

	require.NoError(t, store.Delete(ctx, key))
	_, _, err = store.Get(ctx, key)
	assert.ErrorIs(t, err, ErrObjectNotFound)
	_, err = store.Head(ctx, key)
	assert.ErrorIs(t, err, ErrObjectNotFound)
	assert.ErrorIs(t, store.Delete(ctx, key), ErrObjectNotFound)
}

func TestLocalStoreStreamsLargeObject(t *testing.T) {
	store := newTestLocalStore(t, t.TempDir(), "")
	const size = 4 << 20
	reader := &patternReader{remaining: size}
	info, err := store.Put(t.Context(), "pg/1/canvas/snapshot", reader)
	require.NoError(t, err)
	assert.Equal(t, int64(size), info.Size)

	object, _, err := store.Get(t.Context(), "pg/1/canvas/snapshot")
	require.NoError(t, err)
	defer object.Close()
	buffer := make([]byte, 64<<10)
	total := 0
	for {
		count, readErr := object.Read(buffer)
		total += count
		if readErr == io.EOF {
			break
		}
		require.NoError(t, readErr)
	}
	assert.Equal(t, size, total)
}

type patternReader struct {
	remaining int
}

func (r *patternReader) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	count := len(p)
	if count > r.remaining {
		count = r.remaining
	}
	for i := range count {
		p[i] = byte(i % 251)
	}
	r.remaining -= count
	return count, nil
}

func TestLocalStoreRejectsTraversalKeys(t *testing.T) {
	root := t.TempDir()
	store := newTestLocalStore(t, root, "")
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
			_, err = store.PresignGet(t.Context(), key, 900)
			assert.ErrorIs(t, err, ErrInvalidKey)
		})
	}
	assert.NoFileExists(t, filepath.Join(root, "..", "escape"))
}

func TestLocalStoreRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600))
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}
	store := newTestLocalStore(t, root, "")

	_, _, err := store.Get(t.Context(), "link/secret.txt")
	require.Error(t, err)

	_, err = store.Put(t.Context(), "link/written.txt", strings.NewReader("x"))
	require.Error(t, err)
	assert.NoFileExists(t, filepath.Join(outside, "written.txt"))
}

func TestLocalStoreAppliesPrefix(t *testing.T) {
	root := t.TempDir()
	store := newTestLocalStore(t, root, "pg")
	key := "attachments/2026/10/item"
	_, err := store.Put(t.Context(), key, strings.NewReader("prefixed"))
	require.NoError(t, err)
	content, err := os.ReadFile(filepath.Join(root, "pg", filepath.FromSlash(key)))
	require.NoError(t, err)
	assert.Equal(t, "prefixed", string(content))

	info, err := store.Head(t.Context(), key)
	require.NoError(t, err)
	assert.Equal(t, key, info.Key)
}

func TestLocalStoreRejectsCanceledContext(t *testing.T) {
	store := newTestLocalStore(t, t.TempDir(), "")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := store.Put(ctx, "pg/1/item", strings.NewReader("x"))
	assert.ErrorIs(t, err, context.Canceled)
	_, _, err = store.Get(ctx, "pg/1/item")
	assert.ErrorIs(t, err, context.Canceled)
}

func TestLocalStorePresignIsUnsupported(t *testing.T) {
	store := newTestLocalStore(t, t.TempDir(), "")
	_, err := store.PresignPut(t.Context(), "pg/1/item", time.Minute)
	assert.ErrorIs(t, err, ErrPresignUnsupported)
	_, err = store.PresignGet(t.Context(), "pg/1/item", time.Minute)
	assert.ErrorIs(t, err, ErrPresignUnsupported)
	// A non-positive TTL falls back to the configured default.
	_, err = store.PresignGet(t.Context(), "pg/1/item", 0)
	assert.ErrorIs(t, err, ErrPresignUnsupported)
	_, err = store.PresignGet(t.Context(), "pg/1/item", maxPresignTTL+time.Second)
	assert.ErrorContains(t, err, "TTL")
}

func TestNewSelectsLocalBackend(t *testing.T) {
	root := t.TempDir()
	store, err := New(system_setting.ObjectStoreConfig{
		LocalDir:          root,
		PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
	})
	require.NoError(t, err)
	// Store does not own the directory-handle lifecycle, so release it through
	// the concrete backend type that New selects.
	local, ok := store.(*Local)
	require.True(t, ok, "New must return the local backend implementation")
	t.Cleanup(func() { require.NoError(t, local.Close()) })
	assert.Equal(t, system_setting.ObjectStoreBackendLocal, store.Backend())

	_, err = New(system_setting.ObjectStoreConfig{
		Backend:           "ftp",
		LocalDir:          root,
		PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
	})
	assert.ErrorIs(t, err, ErrUnsupportedBackend)

	_, err = NewLocal(system_setting.ObjectStoreConfig{
		Backend:           system_setting.ObjectStoreBackendS3,
		LocalDir:          root,
		PresignTTLSeconds: system_setting.DefaultTaskArtifactStorePresignTTLSeconds,
	})
	assert.ErrorIs(t, err, ErrUnsupportedBackend)
}

func TestServeStreamsWithSafetyHeaders(t *testing.T) {
	store := newTestLocalStore(t, t.TempDir(), "")
	content := []byte("image-bytes")
	_, err := store.Put(t.Context(), "pg/1/attachments/image.png", bytes.NewReader(content))
	require.NoError(t, err)

	recorder := httptest.NewRecorder()
	require.NoError(t, Serve(t.Context(), store, recorder, "pg/1/attachments/image.png", ServeOptions{
		Filename:    "report\r\nX-Injected: yes.png",
		ContentType: "image/png",
	}))
	response := recorder.Result()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, response.StatusCode)
	assert.Equal(t, content, body)
	assert.Equal(t, "image/png", response.Header.Get("Content-Type"))
	assert.Equal(t, "nosniff", response.Header.Get("X-Content-Type-Options"))
	assert.Equal(t, "sandbox; default-src 'none'", response.Header.Get("Content-Security-Policy"))
	assert.Equal(t, "no-referrer", response.Header.Get("Referrer-Policy"))
	disposition := response.Header.Get("Content-Disposition")
	assert.Contains(t, disposition, "inline")
	assert.Contains(t, disposition, "filename")
	assert.NotContains(t, disposition, "X-Injected")
	assert.NotContains(t, disposition, "\r")

	attachment := httptest.NewRecorder()
	require.NoError(t, Serve(t.Context(), store, attachment, "pg/1/attachments/image.png", ServeOptions{
		Filename:    "image.png",
		ContentType: "not a media type",
		Attachment:  true,
	}))
	assert.Contains(t, attachment.Header().Get("Content-Disposition"), "attachment")
	assert.Equal(t, "application/octet-stream", attachment.Header().Get("Content-Type"))

	missing := httptest.NewRecorder()
	err = Serve(t.Context(), store, missing, "pg/1/attachments/missing.png", ServeOptions{})
	assert.ErrorIs(t, err, ErrObjectNotFound)
}
