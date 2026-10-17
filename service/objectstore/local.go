package objectstore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/setting/system_setting"
)

const localBackend = system_setting.ObjectStoreBackendLocal

var _ Store = (*Local)(nil)

// Local stores objects below a single directory. os.Root resolves every
// operation relative to that directory and rejects symlinks that escape it.
type Local struct {
	root   *os.Root
	prefix string
}

// NewLocal opens (and, if necessary, creates) the configured local directory.
func NewLocal(config system_setting.ObjectStoreConfig) (*Local, error) {
	if config.Backend == "" {
		config.Backend = localBackend
	}
	if config.PresignTTLSeconds == 0 {
		config.PresignTTLSeconds = system_setting.DefaultTaskArtifactStorePresignTTLSeconds
	}
	if config.Backend != localBackend {
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedBackend, config.Backend)
	}
	if err := system_setting.ValidateObjectStoreConfig(config); err != nil {
		return nil, err
	}

	root, err := os.OpenRoot(config.LocalDir)
	if errors.Is(err, fs.ErrNotExist) {
		if mkdirErr := os.MkdirAll(config.LocalDir, 0o750); mkdirErr != nil {
			return nil, fmt.Errorf("object store: create local directory: %w", mkdirErr)
		}
		root, err = os.OpenRoot(config.LocalDir)
	}
	if err != nil {
		return nil, fmt.Errorf("object store: open local directory: %w", err)
	}
	return &Local{root: root, prefix: strings.Trim(config.Prefix, "/")}, nil
}

// New returns the Store implementation selected by config. Only the local
// backend is implemented in this release.
func New(config system_setting.ObjectStoreConfig) (Store, error) {
	backend := config.Backend
	if backend == "" {
		backend = localBackend
	}
	switch backend {
	case localBackend:
		return NewLocal(config)
	default:
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedBackend, backend)
	}
}

func (s *Local) Backend() string {
	return localBackend
}

// Close releases the directory handle held by the backend.
func (s *Local) Close() error {
	if s == nil || s.root == nil {
		return nil
	}
	return s.root.Close()
}

func (s *Local) Put(ctx context.Context, key string, body io.Reader) (ObjectInfo, error) {
	if body == nil {
		return ObjectInfo{}, errors.New("object store: object body is required")
	}
	storageKey, err := s.storageKey(key)
	if err != nil {
		return ObjectInfo{}, err
	}
	if err := ctx.Err(); err != nil {
		return ObjectInfo{}, err
	}

	if directory := path.Dir(storageKey); directory != "." {
		if err := s.root.MkdirAll(directory, 0o750); err != nil {
			return ObjectInfo{}, fmt.Errorf("object store: create object directory: %w", err)
		}
	}

	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return ObjectInfo{}, fmt.Errorf("object store: create temporary name: %w", err)
	}
	tempKey := storageKey + ".tmp-" + hex.EncodeToString(random[:])
	file, err := s.root.OpenFile(tempKey, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return ObjectInfo{}, fmt.Errorf("object store: create object: %w", err)
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = s.root.Remove(tempKey)
		}
	}()

	if _, err := copyWithContext(ctx, file, body); err != nil {
		return ObjectInfo{}, fmt.Errorf("object store: write object: %w", err)
	}
	if err := file.Close(); err != nil {
		return ObjectInfo{}, fmt.Errorf("object store: close object: %w", err)
	}
	if err := s.root.Rename(tempKey, storageKey); err != nil {
		return ObjectInfo{}, fmt.Errorf("object store: commit object: %w", err)
	}
	committed = true

	stat, err := s.root.Stat(storageKey)
	if err != nil {
		return ObjectInfo{}, localObjectError(key, err)
	}
	return objectInfo(key, stat), nil
}

func (s *Local) Get(ctx context.Context, key string) (io.ReadCloser, ObjectInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, ObjectInfo{}, err
	}
	storageKey, err := s.storageKey(key)
	if err != nil {
		return nil, ObjectInfo{}, err
	}
	file, err := s.root.Open(storageKey)
	if err != nil {
		return nil, ObjectInfo{}, localObjectError(key, err)
	}
	stat, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, ObjectInfo{}, localObjectError(key, err)
	}
	if !stat.Mode().IsRegular() {
		_ = file.Close()
		return nil, ObjectInfo{}, fmt.Errorf("%w: %s", ErrObjectNotFound, key)
	}
	return file, objectInfo(key, stat), nil
}

func (s *Local) Head(ctx context.Context, key string) (ObjectInfo, error) {
	if err := ctx.Err(); err != nil {
		return ObjectInfo{}, err
	}
	storageKey, err := s.storageKey(key)
	if err != nil {
		return ObjectInfo{}, err
	}
	stat, err := s.root.Stat(storageKey)
	if err != nil {
		return ObjectInfo{}, localObjectError(key, err)
	}
	if !stat.Mode().IsRegular() {
		return ObjectInfo{}, fmt.Errorf("%w: %s", ErrObjectNotFound, key)
	}
	return objectInfo(key, stat), nil
}

func (s *Local) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	storageKey, err := s.storageKey(key)
	if err != nil {
		return err
	}
	stat, err := s.root.Lstat(storageKey)
	if err != nil {
		return localObjectError(key, err)
	}
	if !stat.Mode().IsRegular() {
		return fmt.Errorf("%w: %s", ErrObjectNotFound, key)
	}
	if err := s.root.Remove(storageKey); err != nil {
		return localObjectError(key, err)
	}
	return nil
}

func (s *Local) PresignPut(ctx context.Context, key string, ttl time.Duration) (string, error) {
	return s.presign(ctx, key, ttl)
}

func (s *Local) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	return s.presign(ctx, key, ttl)
}

func (s *Local) presign(ctx context.Context, key string, ttl time.Duration) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if _, err := s.storageKey(key); err != nil {
		return "", err
	}
	if ttl <= 0 {
		return "", errors.New("object store: presign TTL must be positive")
	}
	return "", ErrPresignUnsupported
}

func (s *Local) storageKey(key string) (string, error) {
	if err := ValidateKey(key); err != nil {
		return "", err
	}
	if s.prefix == "" {
		return key, nil
	}
	return s.prefix + "/" + key, nil
}

func objectInfo(key string, stat fs.FileInfo) ObjectInfo {
	return ObjectInfo{Key: key, Size: stat.Size(), ModTime: stat.ModTime()}
}

func localObjectError(key string, err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w: %s", ErrObjectNotFound, key)
	}
	return fmt.Errorf("object store: %s: %w", key, err)
}
