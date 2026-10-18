package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service/objectstore"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
)

// StoredArtifactRef describes a persisted artifact object.
type StoredArtifactRef struct {
	Backend     string
	Bucket      string
	ArtifactKey string
	ObjectKey   string
	MimeType    string
	Size        int64
}

// TaskArtifactStore is the persistence boundary for generated artifact bytes.
// types.TaskArtifact is re-exported by relay/channel as channel.TaskArtifact.
// Callers resolve an artifact only after verifying that the requesting user
// owns the task.
type TaskArtifactStore interface {
	Enabled() bool
	Resolve(ctx context.Context, task *model.Task, artifact types.TaskArtifact) (*StoredArtifactRef, error)
	Persist(ctx context.Context, task *model.Task, artifact types.TaskArtifact, content io.Reader) (*StoredArtifactRef, error)
	Serve(c *gin.Context, task *model.Task, ref *StoredArtifactRef) error
}

var ErrTaskArtifactStoreDisabled = errors.New("task artifact store is disabled")

type disabledArtifactStore struct{}

func (disabledArtifactStore) Enabled() bool {
	return false
}

func (disabledArtifactStore) Resolve(context.Context, *model.Task, types.TaskArtifact) (*StoredArtifactRef, error) {
	return nil, nil
}

func (disabledArtifactStore) Persist(context.Context, *model.Task, types.TaskArtifact, io.Reader) (*StoredArtifactRef, error) {
	return nil, ErrTaskArtifactStoreDisabled
}

func (disabledArtifactStore) Serve(*gin.Context, *model.Task, *StoredArtifactRef) error {
	return ErrTaskArtifactStoreDisabled
}

// objectTaskArtifactStore keeps generated artifact bytes in an object store and
// the ownership, key, hash, and retention metadata in the database. It writes
// into the explicitly configured S3 bucket when TASK_ARTIFACT_STORE_MODE is
// s3, and into the process-wide object store (local disk by default)
// otherwise. Ownership is enforced before Resolve, Persist, or Serve is
// called, and every read re-checks the record so a collected artifact is never
// served from a stale key.
type objectTaskArtifactStore struct {
	// objects is the explicitly configured bucket. It is nil when the shared
	// process-wide store is used, which is resolved lazily because the store is
	// installed after this value is built.
	objects    objectstore.Store
	bucket     string
	presignTTL time.Duration
}

func (s *objectTaskArtifactStore) objectStore() objectstore.Store {
	if s != nil && s.objects != nil {
		return s.objects
	}
	return objectstore.DefaultStore()
}

func (s *objectTaskArtifactStore) Enabled() bool {
	return s.objectStore() != nil
}

func (s *objectTaskArtifactStore) Resolve(ctx context.Context, task *model.Task, artifact types.TaskArtifact) (*StoredArtifactRef, error) {
	store := s.objectStore()
	if store == nil || task == nil || model.DB == nil {
		return nil, nil
	}
	record, err := model.GetPlaygroundTaskArtifact(task.UserId, task.TaskID, artifact.Key)
	if err != nil {
		return nil, err
	}
	if record == nil || record.State != model.TaskArtifactStateStored || record.ObjectKey == "" {
		// The artifact was never persisted (or was collected): the caller keeps
		// proxying the provider reference.
		return nil, nil
	}
	pinned, err := model.IsPlaygroundTaskArtifactPinned(record.UserID, record.TaskID, record.ArtifactKey)
	if err != nil {
		return nil, err
	}
	if !pinned && record.ExpiresAt > 0 && record.ExpiresAt < common.GetTimestamp() {
		// The retention window ended but the scheduled cleanup has not run yet.
		return nil, nil
	}
	info, err := store.Head(ctx, record.ObjectKey)
	if errors.Is(err, objectstore.ErrObjectNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	mimeType := record.MimeType
	if mimeType == "" {
		mimeType = artifact.MimeType
	}
	return &StoredArtifactRef{
		Backend:     store.Backend(),
		Bucket:      s.bucket,
		ArtifactKey: record.ArtifactKey,
		ObjectKey:   record.ObjectKey,
		MimeType:    mimeType,
		Size:        info.Size,
	}, nil
}

func (s *objectTaskArtifactStore) Persist(ctx context.Context, task *model.Task, artifact types.TaskArtifact, content io.Reader) (*StoredArtifactRef, error) {
	if content == nil {
		return nil, errors.New("task artifact store: artifact content is required")
	}
	store := s.objectStore()
	if store == nil {
		return nil, ErrTaskArtifactStoreDisabled
	}
	objectKey, err := taskArtifactObjectKey(task, artifact.Key)
	if err != nil {
		return nil, err
	}
	var info objectstore.ObjectInfo
	if putter, ok := store.(objectstore.ContentTypePutter); ok {
		info, err = putter.PutWithContentType(ctx, objectKey, content, artifact.MimeType)
	} else {
		info, err = store.Put(ctx, objectKey, content)
	}
	if err != nil {
		return nil, err
	}
	return &StoredArtifactRef{
		Backend:     store.Backend(),
		Bucket:      s.bucket,
		ArtifactKey: artifact.Key,
		ObjectKey:   objectKey,
		MimeType:    artifact.MimeType,
		Size:        info.Size,
	}, nil
}

func (s *objectTaskArtifactStore) Serve(c *gin.Context, task *model.Task, ref *StoredArtifactRef) error {
	if c == nil || c.Request == nil {
		return errors.New("task artifact store: request context is required")
	}
	if ref == nil || ref.ObjectKey == "" {
		return errors.New("task artifact store: artifact reference is required")
	}
	store := s.objectStore()
	if store == nil {
		return ErrTaskArtifactStoreDisabled
	}
	if ref.Backend != "" && ref.Backend != store.Backend() {
		return errors.New("task artifact store: artifact reference does not belong to this store")
	}

	ctx := c.Request.Context()
	// The bytes belong to one account, so no shared cache may hold them.
	c.Header("Cache-Control", "private, no-store")
	ttl := s.presignTTL
	if ttl <= 0 {
		ttl = objectstore.DefaultPresignTTL()
	}
	if url, presignErr := store.PresignGet(ctx, ref.ObjectKey, ttl); presignErr == nil {
		// Ownership was verified before Serve. The redirect carries a
		// short-lived credential in its query string.
		c.Redirect(http.StatusFound, url)
		return nil
	}
	return objectstore.Serve(ctx, store, c.Writer, ref.ObjectKey, objectstore.ServeOptions{
		ContentType: ref.MimeType,
	})
}

// taskArtifactObjectStore returns the byte backend generated results are
// persisted into: the explicitly configured S3 bucket, or the process-wide
// object store. It is nil while no store is configured.
func taskArtifactObjectStore() objectstore.Store {
	if store, ok := taskArtifactStore.(*objectTaskArtifactStore); ok {
		return store.objectStore()
	}
	return nil
}

// TaskArtifactStoreConfigured reports whether generated results can be
// persisted. The scheduled store pass is only scheduled while a backend is
// available, and release deployments without an object store keep the
// provider-proxy behavior.
func TaskArtifactStoreConfigured() bool {
	return taskArtifactObjectStore() != nil
}

// taskArtifactObjectKey derives the deterministic object key of one artifact
// from its task:
// pg/{user_id}/task/{yyyy}/{mm}/{task_id}/{artifact_key}
func taskArtifactObjectKey(task *model.Task, artifactKey string) (string, error) {
	if task == nil {
		return "", errors.New("task artifact store: task is required")
	}
	taskID := strings.TrimSpace(task.TaskID)
	artifactKey = strings.TrimSpace(artifactKey)
	if !isSafeObjectKeySegment(taskID) || !isSafeObjectKeySegment(artifactKey) {
		return "", errors.New("task artifact store: unsafe task or artifact key")
	}
	createdAt := task.CreatedAt
	if createdAt == 0 {
		createdAt = task.SubmitTime
	}
	if createdAt == 0 {
		createdAt = time.Now().Unix()
	}
	return fmt.Sprintf("pg/%d/task/%s/%s/%s",
		task.UserId,
		time.Unix(createdAt, 0).UTC().Format("2006/01"),
		taskID,
		artifactKey,
	), nil
}

// isSafeObjectKeySegment rejects task and artifact identifiers that would add
// or remove object key segments.
func isSafeObjectKeySegment(segment string) bool {
	if segment == "" || segment == "." || segment == ".." || len(segment) > 191 {
		return false
	}
	for _, character := range segment {
		if character == '/' || character == '\\' || unicode.IsControl(character) {
			return false
		}
	}
	return true
}

// GetTaskArtifactStore returns the process-wide artifact storage backend.
// Generated results are persisted through the configured S3 bucket when
// TASK_ARTIFACT_STORE_MODE is s3, and through the shared object store
// otherwise; the gateway keeps proxying provider URLs only while no store is
// configured.
func GetTaskArtifactStore() TaskArtifactStore {
	return taskArtifactStore
}

// taskArtifactStore is initialized at startup so an incomplete S3
// configuration is reported once instead of on the first artifact request.
var taskArtifactStore = newTaskArtifactStore(system_setting.LoadTaskArtifactStoreConfig())

func newTaskArtifactStore(config system_setting.TaskArtifactStoreConfig) TaskArtifactStore {
	if config.Mode == system_setting.TaskArtifactStoreModeS3 {
		objects, err := objectstore.NewS3(config.ObjectStoreConfig())
		if err != nil {
			// Configuration errors never repeat credential values. An explicit
			// S3 configuration is never silently redirected to local disk.
			common.SysError(common.LogText("failed to initialize the task artifact S3 store: %s; generated artifacts fall back to the upstream provider", err.Error()))
			return &disabledArtifactStore{}
		}
		return &objectTaskArtifactStore{
			objects:    objects,
			bucket:     config.S3.Bucket,
			presignTTL: time.Duration(config.S3PresignTTLSeconds) * time.Second,
		}
	}
	return &objectTaskArtifactStore{
		presignTTL: time.Duration(config.S3PresignTTLSeconds) * time.Second,
	}
}
