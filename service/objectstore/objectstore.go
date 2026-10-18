// Package objectstore defines the byte-storage boundary shared by Playground
// attachments, task artifacts, artifact versions, and canvas snapshots. The
// database keeps ownership and metadata; this package only stores bytes.
package objectstore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/QuantumNous/new-api/setting/system_setting"
)

const (
	maxObjectKeyLength = 1024
	// maxPresignTTL bounds how long a generated presigned URL stays usable.
	maxPresignTTL = time.Duration(system_setting.MaxTaskArtifactStorePresignTTLSeconds) * time.Second
)

var (
	ErrObjectNotFound     = errors.New("object store: object not found")
	ErrInvalidKey         = errors.New("object store: invalid object key")
	ErrUnsupportedBackend = errors.New("object store: unsupported backend")
	ErrPresignUnsupported = errors.New("object store: presigning is not supported by this backend")
)

// ObjectInfo describes a stored object without exposing its bytes.
type ObjectInfo struct {
	Key     string
	Size    int64
	ModTime time.Time
}

// Store is the persistence boundary for object bytes. Implementations must
// treat keys as opaque, reject path traversal, and stream data instead of
// buffering complete objects in memory.
type Store interface {
	Put(ctx context.Context, key string, body io.Reader) (ObjectInfo, error)
	Get(ctx context.Context, key string) (io.ReadCloser, ObjectInfo, error)
	Head(ctx context.Context, key string) (ObjectInfo, error)
	Delete(ctx context.Context, key string) error
	PresignPut(ctx context.Context, key string, ttl time.Duration) (string, error)
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
	Backend() string
}

// ObjectStore is the plan-facing name for Store.
type ObjectStore = Store

// ContentTypePutter is an optional Store capability for backends that persist
// the media type with the object bytes, so presigned downloads render with the
// content type the artifact was generated with.
type ContentTypePutter interface {
	PutWithContentType(ctx context.Context, key string, body io.Reader, contentType string) (ObjectInfo, error)
}

// PresignPutter is an optional Store capability for backends that can sign a
// direct upload for one declared media type: the client uploads straight to the
// backend, and the signed request carries the type the caller declared. The
// complete step re-verifies the stored bytes, so a forged type can never
// smuggle a different file kind into an attachment.
type PresignPutter interface {
	PresignPutWithContentType(ctx context.Context, key, contentType string, ttl time.Duration) (string, error)
}

// MultipartAborter is an optional Store capability for backends that accept
// multipart uploads. A presigned single PUT never starts one, but an
// interrupted direct multipart upload can leave parts behind; releasing the
// reservation aborts every in-progress upload that targets the same key so the
// parts do not outlive their reservation.
type MultipartAborter interface {
	AbortMultipartUploads(ctx context.Context, key string) error
}

// ServeOptions controls the response headers used when Serve streams an
// object. Filename is sanitized and escaped before it is written to
// Content-Disposition.
type ServeOptions struct {
	Filename    string
	ContentType string
	Attachment  bool
}

// Serve streams key to an HTTP client with headers that prevent content
// sniffing and script execution. Callers MUST verify that the authenticated
// user owns key before calling Serve: object stores enforce key syntax and
// backend isolation, not application ownership.
func Serve(ctx context.Context, store Store, w http.ResponseWriter, key string, options ServeOptions) error {
	reader, info, err := store.Get(ctx, key)
	if err != nil {
		return err
	}
	defer reader.Close()

	contentType := "application/octet-stream"
	if parsed, _, parseErr := mime.ParseMediaType(options.ContentType); parseErr == nil && parsed != "" {
		contentType = parsed
	}
	disposition := "inline"
	if options.Attachment {
		disposition = "attachment"
	}
	if options.Filename != "" {
		// An untrusted filename must never carry a control character into the
		// header: truncate at the first one so a CR/LF payload cannot split the
		// response headers or smuggle extra parameters into the disposition.
		filename := options.Filename
		if index := strings.IndexFunc(filename, unicode.IsControl); index >= 0 {
			filename = strings.TrimSpace(filename[:index])
		}
		if filename != "" {
			disposition = mime.FormatMediaType(disposition, map[string]string{"filename": filename})
		}
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(http.StatusOK)
	_, err = copyWithContext(ctx, w, reader)
	return err
}

// ValidateKey accepts only relative slash-separated object keys. Empty
// segments and dot segments are rejected, so a key can never address a path
// outside the configured backend root.
func ValidateKey(key string) error {
	if key == "" || len(key) > maxObjectKeyLength {
		return fmt.Errorf("%w: length", ErrInvalidKey)
	}
	if strings.HasPrefix(key, "/") || strings.HasSuffix(key, "/") || strings.Contains(key, "\\") {
		return fmt.Errorf("%w: %q", ErrInvalidKey, key)
	}
	if path.Clean(key) != key {
		return fmt.Errorf("%w: %q", ErrInvalidKey, key)
	}
	for part := range strings.SplitSeq(key, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("%w: %q", ErrInvalidKey, key)
		}
	}
	for _, character := range key {
		if unicode.IsControl(character) {
			return fmt.Errorf("%w: control character", ErrInvalidKey)
		}
	}
	return nil
}

// resolvePresignTTL applies the backend default when the caller does not
// request a specific lifetime and enforces the upper bound of seven days.
func resolvePresignTTL(ttl, fallback time.Duration) (time.Duration, error) {
	if ttl <= 0 {
		ttl = fallback
	}
	if ttl <= 0 {
		return 0, errors.New("object store: presign TTL must be positive")
	}
	if ttl > maxPresignTTL {
		return 0, fmt.Errorf("object store: presign TTL must not exceed %s", maxPresignTTL)
	}
	return ttl, nil
}

// storageKey validates key and joins it with the backend prefix. Keys are
// opaque and always stay below the configured prefix.
func storageKey(prefix, key string) (string, error) {
	if err := ValidateKey(key); err != nil {
		return "", err
	}
	if prefix == "" {
		return key, nil
	}
	return prefix + "/" + key, nil
}

func copyWithContext(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	buffer := make([]byte, 32<<10)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		read, readErr := src.Read(buffer)
		if read > 0 {
			count, writeErr := dst.Write(buffer[:read])
			written += int64(count)
			if writeErr != nil {
				return written, writeErr
			}
			if count != read {
				return written, io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}
