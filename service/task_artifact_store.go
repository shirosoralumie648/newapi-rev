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

// s3TaskArtifactStore keeps generated artifact bytes in an S3-compatible
// bucket. Ownership is enforced by the controller before Resolve, Persist, or
// Serve is called; the object key itself is derived from the task owner.
type s3TaskArtifactStore struct {
	objects    objectstore.Store
	bucket     string
	presignTTL time.Duration
}

func (s *s3TaskArtifactStore) Enabled() bool {
	return true
}

func (s *s3TaskArtifactStore) Resolve(ctx context.Context, task *model.Task, artifact types.TaskArtifact) (*StoredArtifactRef, error) {
	objectKey, err := taskArtifactObjectKey(task, artifact.Key)
	if err != nil {
		return nil, err
	}
	info, err := s.objects.Head(ctx, objectKey)
	if errors.Is(err, objectstore.ErrObjectNotFound) {
		// The artifact was never persisted; the caller keeps proxying the
		// provider URL.
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.artifactRef(artifact, objectKey, info.Size), nil
}

func (s *s3TaskArtifactStore) Persist(ctx context.Context, task *model.Task, artifact types.TaskArtifact, content io.Reader) (*StoredArtifactRef, error) {
	if content == nil {
		return nil, errors.New("task artifact store: artifact content is required")
	}
	objectKey, err := taskArtifactObjectKey(task, artifact.Key)
	if err != nil {
		return nil, err
	}
	var info objectstore.ObjectInfo
	if putter, ok := s.objects.(objectstore.ContentTypePutter); ok {
		info, err = putter.PutWithContentType(ctx, objectKey, content, artifact.MimeType)
	} else {
		info, err = s.objects.Put(ctx, objectKey, content)
	}
	if err != nil {
		return nil, err
	}
	return s.artifactRef(artifact, objectKey, info.Size), nil
}

func (s *s3TaskArtifactStore) Serve(c *gin.Context, task *model.Task, ref *StoredArtifactRef) error {
	if c == nil || c.Request == nil {
		return errors.New("task artifact store: request context is required")
	}
	if ref == nil {
		return errors.New("task artifact store: artifact reference is required")
	}
	objectKey, err := taskArtifactObjectKey(task, ref.ArtifactKey)
	if err != nil {
		return err
	}
	if objectKey != ref.ObjectKey || ref.Backend != s.objects.Backend() {
		return errors.New("task artifact store: artifact reference does not belong to this task")
	}

	ctx := c.Request.Context()
	if url, presignErr := s.objects.PresignGet(ctx, ref.ObjectKey, s.presignTTL); presignErr == nil {
		// Ownership was verified before Serve. The redirect carries a
		// short-lived credential in its query string, so no shared cache may
		// store the response.
		c.Header("Cache-Control", "private, no-store")
		c.Redirect(http.StatusFound, url)
		return nil
	}
	return objectstore.Serve(ctx, s.objects, c.Writer, ref.ObjectKey, objectstore.ServeOptions{
		ContentType: ref.MimeType,
	})
}

func (s *s3TaskArtifactStore) artifactRef(artifact types.TaskArtifact, objectKey string, size int64) *StoredArtifactRef {
	return &StoredArtifactRef{
		Backend:     s.objects.Backend(),
		Bucket:      s.bucket,
		ArtifactKey: artifact.Key,
		ObjectKey:   objectKey,
		MimeType:    artifact.MimeType,
		Size:        size,
	}
}

// taskArtifactObjectKey derives the deterministic object key of one artifact
// from its task, so Resolve never needs a database lookup:
// tasks/{user_id}/{yyyy}/{mm}/{task_id}/{artifact_key}
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
	return fmt.Sprintf("tasks/%d/%s/%s/%s",
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
// Artifacts are stored in the configured bucket when TASK_ARTIFACT_STORE_MODE
// is s3; otherwise the gateway keeps proxying provider URLs.
func GetTaskArtifactStore() TaskArtifactStore {
	return taskArtifactStore
}

// taskArtifactStore is initialized at startup so an incomplete S3
// configuration is reported once instead of on the first artifact request.
var taskArtifactStore = newTaskArtifactStore(system_setting.LoadTaskArtifactStoreConfig())

func newTaskArtifactStore(config system_setting.TaskArtifactStoreConfig) TaskArtifactStore {
	if config.Mode != system_setting.TaskArtifactStoreModeS3 {
		return &disabledArtifactStore{}
	}
	objects, err := objectstore.NewS3(config.ObjectStoreConfig())
	if err != nil {
		// Configuration errors never repeat credential values.
		common.SysError(common.LogText("failed to initialize the task artifact S3 store: %s; generated artifacts fall back to the upstream provider", err.Error()))
		return &disabledArtifactStore{}
	}
	return &s3TaskArtifactStore{
		objects:    objects,
		bucket:     config.S3.Bucket,
		presignTTL: time.Duration(config.S3PresignTTLSeconds) * time.Second,
	}
}
