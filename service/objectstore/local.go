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
var _ ObjectLister = (*Local)(nil)

// Local stores objects below a single directory. os.Root resolves every
// operation relative to that directory and rejects symlinks that escape it.
type Local struct {
	root       *os.Root
	prefix     string
	presignTTL time.Duration
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
	return &Local{
		root:       root,
		prefix:     strings.Trim(config.Prefix, "/"),
		presignTTL: time.Duration(config.PresignTTLSeconds) * time.Second,
	}, nil
}

// New returns the Store implementation selected by config.
func New(config system_setting.ObjectStoreConfig) (Store, error) {
	backend := config.Backend
	if backend == "" {
		backend = localBackend
	}
	switch backend {
	case localBackend:
		return NewLocal(config)
	case s3Backend:
		return NewS3(config)
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
	objectKey, err := storageKey(s.prefix, key)
	if err != nil {
		return ObjectInfo{}, err
	}
	if err := ctx.Err(); err != nil {
		return ObjectInfo{}, err
	}

	if directory := path.Dir(objectKey); directory != "." {
		if err := s.root.MkdirAll(directory, 0o750); err != nil {
			return ObjectInfo{}, fmt.Errorf("object store: create object directory: %w", err)
		}
	}

	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return ObjectInfo{}, fmt.Errorf("object store: create temporary name: %w", err)
	}
	tempKey := objectKey + ".tmp-" + hex.EncodeToString(random[:])
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
	if err := s.root.Rename(tempKey, objectKey); err != nil {
		return ObjectInfo{}, fmt.Errorf("object store: commit object: %w", err)
	}
	committed = true

	stat, err := s.root.Stat(objectKey)
	if err != nil {
		return ObjectInfo{}, localObjectError(key, err)
	}
	return objectInfo(key, stat), nil
}

func (s *Local) Get(ctx context.Context, key string) (io.ReadCloser, ObjectInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, ObjectInfo{}, err
	}
	objectKey, err := storageKey(s.prefix, key)
	if err != nil {
		return nil, ObjectInfo{}, err
	}
	file, err := s.root.Open(objectKey)
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
	objectKey, err := storageKey(s.prefix, key)
	if err != nil {
		return ObjectInfo{}, err
	}
	stat, err := s.root.Stat(objectKey)
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
	objectKey, err := storageKey(s.prefix, key)
	if err != nil {
		return err
	}
	stat, err := s.root.Lstat(objectKey)
	if err != nil {
		return localObjectError(key, err)
	}
	if !stat.Mode().IsRegular() {
		return fmt.Errorf("%w: %s", ErrObjectNotFound, key)
	}
	if err := s.root.Remove(objectKey); err != nil {
		return localObjectError(key, err)
	}
	return nil
}

// List walks the stored objects below one logical key prefix in lexical order
// and reports each one through fn. The prefix is optional: an empty prefix
// lists the whole configured store. Only regular files below the configured
// directory are reported, and keys are returned in their logical form, without
// the backend prefix.
func (s *Local) List(ctx context.Context, prefix string, fn func(ObjectInfo) error) error {
	if fn == nil {
		return errors.New("object store: list callback is required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	walkRoot := "."
	logicalPrefix := ""
	if prefix != "" {
		objectPrefix, err := storageKey(s.prefix, prefix)
		if err != nil {
			return err
		}
		walkRoot, logicalPrefix = objectPrefix, prefix+"/"
	}
	err := fs.WalkDir(s.root.FS(), walkRoot, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() || !entry.Type().IsRegular() {
			return nil
		}
		logical := name
		if logicalPrefix != "" {
			logical = logicalPrefix + strings.TrimPrefix(name, walkRoot+"/")
		} else if s.prefix != "" {
			logical = strings.TrimPrefix(name, s.prefix+"/")
		}
		info, err := entry.Info()
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				// The object vanished between the directory read and the
				// stat; it is not stored anymore.
				return nil
			}
			return err
		}
		return fn(ObjectInfo{Key: logical, Size: info.Size(), ModTime: info.ModTime()})
	})
	if errors.Is(err, fs.ErrNotExist) {
		// Nothing was ever stored below the prefix.
		return nil
	}
	return err
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
	if _, err := storageKey(s.prefix, key); err != nil {
		return "", err
	}
	if _, err := resolvePresignTTL(ttl, s.presignTTL); err != nil {
		return "", err
	}
	return "", ErrPresignUnsupported
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
