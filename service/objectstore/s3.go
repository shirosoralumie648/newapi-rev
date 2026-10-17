package objectstore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"

	"github.com/QuantumNous/new-api/setting/system_setting"
)

const s3Backend = system_setting.ObjectStoreBackendS3

var _ Store = (*S3)(nil)

// S3 stores objects in an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO,
// Backblaze B2, or an Alibaba OSS compatible endpoint). Keys stay below the
// configured prefix; credentials are held by the SDK client and never logged.
type S3 struct {
	client     *awss3.Client
	presigner  *awss3.PresignClient
	bucket     string
	prefix     string
	presignTTL time.Duration
}

// NewS3 builds the S3-compatible backend described by config. The
// configuration is validated without contacting the endpoint.
func NewS3(config system_setting.ObjectStoreConfig) (*S3, error) {
	if config.Backend == "" {
		config.Backend = s3Backend
	}
	if config.PresignTTLSeconds == 0 {
		config.PresignTTLSeconds = system_setting.DefaultTaskArtifactStorePresignTTLSeconds
	}
	if config.Backend != s3Backend {
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedBackend, config.Backend)
	}
	if err := system_setting.ValidateObjectStoreConfig(config); err != nil {
		return nil, err
	}

	awsConfig := aws.Config{
		Region:      config.S3.Region,
		Credentials: aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider(config.S3.AccessKey, config.S3.SecretKey, "")),
		// S3-compatible endpoints do not all support the newer default
		// request checksums, so only the explicitly requested ones are sent.
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	}
	client := awss3.NewFromConfig(awsConfig, func(options *awss3.Options) {
		options.UsePathStyle = config.S3.PathStyle
		options.BaseEndpoint = aws.String(config.S3.Endpoint)
	})
	return &S3{
		client:     client,
		presigner:  awss3.NewPresignClient(client),
		bucket:     config.S3.Bucket,
		prefix:     strings.Trim(config.Prefix, "/"),
		presignTTL: time.Duration(config.PresignTTLSeconds) * time.Second,
	}, nil
}

func (s *S3) Backend() string {
	return s3Backend
}

func (s *S3) Put(ctx context.Context, key string, body io.Reader) (ObjectInfo, error) {
	return s.PutWithContentType(ctx, key, body, "")
}

// PutWithContentType stores an object together with its media type so that
// presigned downloads render with the content type the artifact was generated
// with.
func (s *S3) PutWithContentType(ctx context.Context, key string, body io.Reader, contentType string) (ObjectInfo, error) {
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

	upload, err := prepareUpload(ctx, body)
	if err != nil {
		return ObjectInfo{}, err
	}
	defer upload.Close()

	input := &awss3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(objectKey),
		Body:   upload,
	}
	if upload.size >= 0 {
		input.ContentLength = aws.Int64(upload.size)
	}
	if contentType != "" {
		input.ContentType = aws.String(contentType)
	}
	if _, err := s.client.PutObject(ctx, input); err != nil {
		return ObjectInfo{}, s3ObjectError(key, err)
	}
	// The backend does not re-read server metadata after a write; Head returns
	// the authoritative size and modification time.
	return ObjectInfo{Key: key, Size: max(upload.size, 0), ModTime: time.Now()}, nil
}

func (s *S3) Get(ctx context.Context, key string) (io.ReadCloser, ObjectInfo, error) {
	objectKey, err := storageKey(s.prefix, key)
	if err != nil {
		return nil, ObjectInfo{}, err
	}
	if err := ctx.Err(); err != nil {
		return nil, ObjectInfo{}, err
	}
	output, err := s.client.GetObject(ctx, &awss3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		return nil, ObjectInfo{}, s3ObjectError(key, err)
	}
	return output.Body, s3ObjectInfo(key, output.ContentLength, output.LastModified), nil
}

func (s *S3) Head(ctx context.Context, key string) (ObjectInfo, error) {
	objectKey, err := storageKey(s.prefix, key)
	if err != nil {
		return ObjectInfo{}, err
	}
	if err := ctx.Err(); err != nil {
		return ObjectInfo{}, err
	}
	output, err := s.client.HeadObject(ctx, &awss3.HeadObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		return ObjectInfo{}, s3ObjectError(key, err)
	}
	return s3ObjectInfo(key, output.ContentLength, output.LastModified), nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	objectKey, err := storageKey(s.prefix, key)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// S3 deletes are idempotent: removing a missing object succeeds, so
	// retried outbox deletes stay replayable.
	if _, err := s.client.DeleteObject(ctx, &awss3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(objectKey),
	}); err != nil && !s3IsNotFound(err) {
		return s3ObjectError(key, err)
	}
	return nil
}

func (s *S3) PresignPut(ctx context.Context, key string, ttl time.Duration) (string, error) {
	objectKey, err := storageKey(s.prefix, key)
	if err != nil {
		return "", err
	}
	resolvedTTL, err := resolvePresignTTL(ttl, s.presignTTL)
	if err != nil {
		return "", err
	}
	request, err := s.presigner.PresignPutObject(ctx, &awss3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(objectKey),
	}, func(options *awss3.PresignOptions) {
		options.Expires = resolvedTTL
	})
	if err != nil {
		return "", fmt.Errorf("object store: presign put %s: %w", key, err)
	}
	return request.URL, nil
}

func (s *S3) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	objectKey, err := storageKey(s.prefix, key)
	if err != nil {
		return "", err
	}
	resolvedTTL, err := resolvePresignTTL(ttl, s.presignTTL)
	if err != nil {
		return "", err
	}
	request, err := s.presigner.PresignGetObject(ctx, &awss3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(objectKey),
	}, func(options *awss3.PresignOptions) {
		options.Expires = resolvedTTL
	})
	if err != nil {
		return "", fmt.Errorf("object store: presign get %s: %w", key, err)
	}
	return request.URL, nil
}

func s3ObjectInfo(key string, size *int64, modified *time.Time) ObjectInfo {
	info := ObjectInfo{Key: key, Size: aws.ToInt64(size)}
	if modified != nil {
		info.ModTime = *modified
	}
	return info
}

func s3IsNotFound(err error) bool {
	var apiError smithy.APIError
	if !errors.As(err, &apiError) {
		return false
	}
	switch apiError.ErrorCode() {
	case "NoSuchKey", "NotFound":
		return true
	default:
		return false
	}
}

func s3ObjectError(key string, err error) error {
	if s3IsNotFound(err) {
		return fmt.Errorf("%w: %s", ErrObjectNotFound, key)
	}
	return fmt.Errorf("object store: %s: %w", key, err)
}

// uploadStream adapts an incoming body to the seekable stream that SigV4
// payload signing requires.
type uploadStream struct {
	io.ReadSeeker
	size    int64
	release func()
}

func (u *uploadStream) Close() {
	if u == nil || u.release == nil {
		return
	}
	u.release()
}

// prepareUpload returns a seekable view of body. Readers that are already
// seekable are used directly; streaming readers (for example upstream
// responses) are spooled to a temporary file so that a large artifact never
// has to fit in memory. A negative size means the length could not be
// determined.
func prepareUpload(ctx context.Context, body io.Reader) (*uploadStream, error) {
	if seeker, ok := body.(io.ReadSeeker); ok {
		if size, err := seekableLength(seeker); err == nil {
			return &uploadStream{ReadSeeker: seeker, size: size}, nil
		}
	}

	file, err := os.CreateTemp("", "objectstore-upload-*")
	if err != nil {
		return nil, fmt.Errorf("object store: spool upload: %w", err)
	}
	upload := &uploadStream{
		size: -1,
		release: func() {
			_ = file.Close()
			_ = os.Remove(file.Name())
		},
	}
	if _, err := copyWithContext(ctx, file, body); err != nil {
		upload.Close()
		return nil, fmt.Errorf("object store: spool upload: %w", err)
	}
	size, err := seekableLength(file)
	if err != nil {
		upload.Close()
		return nil, fmt.Errorf("object store: spool upload: %w", err)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		upload.Close()
		return nil, fmt.Errorf("object store: spool upload: %w", err)
	}
	upload.ReadSeeker = file
	upload.size = size
	return upload, nil
}

func seekableLength(seeker io.ReadSeeker) (int64, error) {
	position, err := seeker.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	end, err := seeker.Seek(0, io.SeekEnd)
	if err != nil {
		return 0, err
	}
	if _, err := seeker.Seek(position, io.SeekStart); err != nil {
		return 0, err
	}
	return end - position, nil
}
