package system_setting

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"github.com/QuantumNous/new-api/common"
)

const (
	TaskArtifactStoreModeUpstream = "upstream"
	TaskArtifactStoreModeS3       = "s3"

	ObjectStoreBackendLocal = "local"
	ObjectStoreBackendS3    = "s3"
	ObjectStoreBackendDB    = "db"

	DefaultObjectStoreLocalDir                = "data/objectstore"
	DefaultTaskArtifactStorePresignTTLSeconds = 900
	MaxTaskArtifactStorePresignTTLSeconds     = 7 * 24 * 60 * 60
)

const (
	TaskArtifactStoreModeEnv         = "TASK_ARTIFACT_STORE_MODE"
	TaskArtifactStoreS3EndpointEnv   = "TASK_ARTIFACT_STORE_S3_ENDPOINT"
	TaskArtifactStoreS3BucketEnv     = "TASK_ARTIFACT_STORE_S3_BUCKET"
	TaskArtifactStoreS3RegionEnv     = "TASK_ARTIFACT_STORE_S3_REGION"
	TaskArtifactStoreS3AccessKeyEnv  = "TASK_ARTIFACT_STORE_S3_ACCESS_KEY"
	TaskArtifactStoreS3SecretKeyEnv  = "TASK_ARTIFACT_STORE_S3_SECRET_KEY"
	TaskArtifactStoreS3PrefixEnv     = "TASK_ARTIFACT_STORE_S3_PREFIX"
	TaskArtifactStoreS3PresignTTLEnv = "TASK_ARTIFACT_STORE_S3_PRESIGN_TTL"
	TaskArtifactStoreS3PathStyleEnv  = "TASK_ARTIFACT_STORE_S3_PATH_STYLE"
)

const (
	ObjectStoreBackendEnv     = "OBJECT_STORE_BACKEND"
	ObjectStoreLocalDirEnv    = "OBJECT_STORE_LOCAL_DIR"
	ObjectStorePrefixEnv      = "OBJECT_STORE_PREFIX"
	ObjectStorePresignTTLEnv  = "OBJECT_STORE_PRESIGN_TTL"
	ObjectStoreS3EndpointEnv  = "OBJECT_STORE_S3_ENDPOINT"
	ObjectStoreS3BucketEnv    = "OBJECT_STORE_S3_BUCKET"
	ObjectStoreS3RegionEnv    = "OBJECT_STORE_S3_REGION"
	ObjectStoreS3AccessKeyEnv = "OBJECT_STORE_S3_ACCESS_KEY"
	ObjectStoreS3SecretKeyEnv = "OBJECT_STORE_S3_SECRET_KEY"
	ObjectStoreS3PathStyleEnv = "OBJECT_STORE_S3_PATH_STYLE"
)

var (
	taskArtifactStoreBucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	taskArtifactStoreRegionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

// S3Settings describes one S3-compatible endpoint shared by the object store
// and the task artifact store: AWS S3, Cloudflare R2, MinIO, Backblaze B2, or
// an Alibaba OSS compatible endpoint. AccessKey and SecretKey are secrets; no
// log line or validation error may include their values.
type S3Settings struct {
	Endpoint  string
	Bucket    string
	Region    string
	AccessKey string
	SecretKey string
	// PathStyle selects path-style bucket addressing
	// (https://endpoint/bucket/key) instead of virtual-host style
	// (https://bucket.endpoint/key), which most self-hosted endpoints need.
	PathStyle bool
}

// TaskArtifactStoreConfig configures where generated task artifacts are
// persisted. Upstream mode keeps the current behavior of proxying the
// provider URL; S3 mode stores and serves bytes through the configured bucket.
type TaskArtifactStoreConfig struct {
	Mode                string
	S3                  S3Settings
	S3Prefix            string
	S3PresignTTLSeconds int
}

// ObjectStoreConfig is the unified object storage contract shared by
// Playground attachments and task artifacts.
type ObjectStoreConfig struct {
	Backend           string
	LocalDir          string
	Prefix            string
	PresignTTLSeconds int
	S3                S3Settings
}

// ObjectStoreConfig maps the task artifact bucket onto the object store
// contract so both use one S3 implementation.
func (config TaskArtifactStoreConfig) ObjectStoreConfig() ObjectStoreConfig {
	return ObjectStoreConfig{
		Backend:           ObjectStoreBackendS3,
		Prefix:            config.S3Prefix,
		PresignTTLSeconds: config.S3PresignTTLSeconds,
		S3:                config.S3,
	}
}

type s3EnvNames struct {
	endpoint  string
	bucket    string
	region    string
	accessKey string
	secretKey string
	pathStyle string
}

var (
	objectStoreS3Env = s3EnvNames{
		endpoint:  ObjectStoreS3EndpointEnv,
		bucket:    ObjectStoreS3BucketEnv,
		region:    ObjectStoreS3RegionEnv,
		accessKey: ObjectStoreS3AccessKeyEnv,
		secretKey: ObjectStoreS3SecretKeyEnv,
		pathStyle: ObjectStoreS3PathStyleEnv,
	}
	taskArtifactStoreS3Env = s3EnvNames{
		endpoint:  TaskArtifactStoreS3EndpointEnv,
		bucket:    TaskArtifactStoreS3BucketEnv,
		region:    TaskArtifactStoreS3RegionEnv,
		accessKey: TaskArtifactStoreS3AccessKeyEnv,
		secretKey: TaskArtifactStoreS3SecretKeyEnv,
		pathStyle: TaskArtifactStoreS3PathStyleEnv,
	}
)

func loadS3Settings(names s3EnvNames) S3Settings {
	return S3Settings{
		Endpoint:  common.GetEnvOrDefaultString(names.endpoint, ""),
		Bucket:    common.GetEnvOrDefaultString(names.bucket, ""),
		Region:    common.GetEnvOrDefaultString(names.region, ""),
		AccessKey: common.GetEnvOrDefaultString(names.accessKey, ""),
		SecretKey: common.GetEnvOrDefaultString(names.secretKey, ""),
		PathStyle: common.GetEnvOrDefaultBool(names.pathStyle, false),
	}
}

// isEmpty reports whether no connection detail was configured at all, which is
// the trigger for inheriting the shared task artifact store S3 settings.
func (settings S3Settings) isEmpty() bool {
	return settings.Endpoint == "" && settings.Bucket == "" && settings.Region == "" &&
		settings.AccessKey == "" && settings.SecretKey == ""
}

// LoadTaskArtifactStoreConfig reads and validates startup-only configuration.
// S3 mode is enabled when the configuration is complete; invalid or
// incomplete configuration falls back to upstream mode.
func LoadTaskArtifactStoreConfig() TaskArtifactStoreConfig {
	config := TaskArtifactStoreConfig{
		Mode:                common.GetEnvOrDefaultString(TaskArtifactStoreModeEnv, TaskArtifactStoreModeUpstream),
		S3:                  loadS3Settings(taskArtifactStoreS3Env),
		S3Prefix:            common.GetEnvOrDefaultString(TaskArtifactStoreS3PrefixEnv, ""),
		S3PresignTTLSeconds: common.GetEnvOrDefault(TaskArtifactStoreS3PresignTTLEnv, DefaultTaskArtifactStorePresignTTLSeconds),
	}
	if err := ValidateTaskArtifactStoreConfig(config); err != nil {
		common.SysError(common.LogText("invalid task artifact store configuration: %s; using upstream mode", err.Error()))
		config.Mode = TaskArtifactStoreModeUpstream
		return config
	}
	return config
}

// LoadObjectStoreConfig reads and validates startup-only configuration. The
// local backend is the default; invalid values fall back to local defaults.
// When the OBJECT_STORE_S3_* settings are empty, the S3 settings of the task
// artifact store are inherited so one bucket configuration can serve both.
func LoadObjectStoreConfig() ObjectStoreConfig {
	config := ObjectStoreConfig{
		Backend:           common.GetEnvOrDefaultString(ObjectStoreBackendEnv, ObjectStoreBackendLocal),
		LocalDir:          common.GetEnvOrDefaultString(ObjectStoreLocalDirEnv, DefaultObjectStoreLocalDir),
		Prefix:            common.GetEnvOrDefaultString(ObjectStorePrefixEnv, ""),
		PresignTTLSeconds: common.GetEnvOrDefault(ObjectStorePresignTTLEnv, DefaultTaskArtifactStorePresignTTLSeconds),
		S3:                loadS3Settings(objectStoreS3Env),
	}
	if config.S3.isEmpty() {
		config.S3 = loadS3Settings(taskArtifactStoreS3Env)
	}
	if err := ValidateObjectStoreConfig(config); err != nil {
		common.SysError(common.LogText("invalid object store configuration: %s; using local defaults", err.Error()))
		return ObjectStoreConfig{
			Backend:           ObjectStoreBackendLocal,
			LocalDir:          DefaultObjectStoreLocalDir,
			Prefix:            "",
			PresignTTLSeconds: DefaultTaskArtifactStorePresignTTLSeconds,
		}
	}
	return config
}

// ValidateObjectStoreConfig performs syntax checks only. It never resolves
// hosts, contacts an endpoint, or accesses the local directory.
func ValidateObjectStoreConfig(config ObjectStoreConfig) error {
	switch config.Backend {
	case ObjectStoreBackendLocal:
	case ObjectStoreBackendS3:
		if err := validateS3Settings(config.S3, true); err != nil {
			return err
		}
	case ObjectStoreBackendDB:
		return fmt.Errorf("object store backend %q is not implemented", config.Backend)
	default:
		return fmt.Errorf("unsupported object store backend %q", config.Backend)
	}
	if config.PresignTTLSeconds <= 0 || config.PresignTTLSeconds > MaxTaskArtifactStorePresignTTLSeconds {
		return fmt.Errorf("object store presign TTL must be between 1 and %d seconds", MaxTaskArtifactStorePresignTTLSeconds)
	}
	if config.Backend == ObjectStoreBackendLocal {
		if err := validateObjectStoreLocalDir(config.LocalDir); err != nil {
			return err
		}
	}
	if err := validateStoragePrefix(config.Prefix); err != nil {
		return fmt.Errorf("object store %w", err)
	}
	return nil
}

func validateObjectStoreLocalDir(directory string) error {
	if directory == "" {
		return errors.New("object store local directory is required")
	}
	if directory != strings.TrimSpace(directory) || len(directory) > 4096 {
		return errors.New("object store local directory syntax is invalid")
	}
	for _, character := range directory {
		if unicode.IsControl(character) {
			return errors.New("object store local directory must not contain control characters")
		}
	}
	normalized := strings.ReplaceAll(directory, "\\", "/")
	for part := range strings.SplitSeq(normalized, "/") {
		if part == "." || part == ".." {
			return errors.New("object store local directory must not contain dot segments")
		}
	}
	return nil
}

func validateStoragePrefix(prefix string) error {
	if prefix == "" {
		return nil
	}
	if prefix != strings.TrimSpace(prefix) || len(prefix) > 512 ||
		strings.HasPrefix(prefix, "/") || strings.Contains(prefix, "\\") {
		return errors.New("prefix syntax is invalid")
	}
	for part := range strings.SplitSeq(prefix, "/") {
		if part == "." || part == ".." {
			return errors.New("prefix must not contain dot segments")
		}
	}
	for _, character := range prefix {
		if unicode.IsControl(character) {
			return errors.New("prefix must not contain control characters")
		}
	}
	return nil
}

// ValidateTaskArtifactStoreConfig performs syntax checks only. It never
// resolves hosts, contacts an endpoint, or verifies credentials.
func ValidateTaskArtifactStoreConfig(config TaskArtifactStoreConfig) error {
	if config.Mode != TaskArtifactStoreModeUpstream && config.Mode != TaskArtifactStoreModeS3 {
		return fmt.Errorf("unsupported mode %q", config.Mode)
	}
	if config.S3PresignTTLSeconds <= 0 || config.S3PresignTTLSeconds > MaxTaskArtifactStorePresignTTLSeconds {
		return fmt.Errorf("S3 presign TTL must be between 1 and %d seconds", MaxTaskArtifactStorePresignTTLSeconds)
	}
	if err := validateS3Settings(config.S3, config.Mode == TaskArtifactStoreModeS3); err != nil {
		return err
	}
	if config.S3Prefix != "" {
		if err := validateStoragePrefix(config.S3Prefix); err != nil {
			return fmt.Errorf("S3 %w", err)
		}
	}
	return nil
}

// validateS3Settings checks endpoint, bucket, region, and credential syntax.
// Values are never repeated in the returned error, so a misconfigured secret
// cannot leak into logs.
func validateS3Settings(settings S3Settings, required bool) error {
	if required && settings.Endpoint == "" {
		return errors.New("S3 endpoint is required")
	}
	if settings.Endpoint != "" {
		if settings.Endpoint != strings.TrimSpace(settings.Endpoint) {
			return errors.New("S3 endpoint must not contain surrounding whitespace")
		}
		endpoint, err := url.Parse(settings.Endpoint)
		if err != nil || endpoint == nil || endpoint.Host == "" || endpoint.User != nil || endpoint.Opaque != "" {
			return errors.New("S3 endpoint must be an absolute URL without userinfo")
		}
		if endpoint.Scheme != "http" && endpoint.Scheme != "https" {
			return errors.New("S3 endpoint must use http or https")
		}
		if endpoint.RawQuery != "" || endpoint.ForceQuery || endpoint.Fragment != "" {
			return errors.New("S3 endpoint must not contain a query or fragment")
		}
	}

	if required && settings.Bucket == "" {
		return errors.New("S3 bucket is required")
	}
	if settings.Bucket != "" {
		if !taskArtifactStoreBucketPattern.MatchString(settings.Bucket) ||
			strings.Contains(settings.Bucket, "..") || net.ParseIP(settings.Bucket) != nil {
			return errors.New("S3 bucket syntax is invalid")
		}
	}

	if required && settings.Region == "" {
		return errors.New("S3 region is required")
	}
	if settings.Region != "" && !taskArtifactStoreRegionPattern.MatchString(settings.Region) {
		return errors.New("S3 region syntax is invalid")
	}

	if (settings.AccessKey == "") != (settings.SecretKey == "") {
		return errors.New("S3 access key and secret key must be set together")
	}
	if err := validateS3Credential("access key", settings.AccessKey, 256, required); err != nil {
		return err
	}
	if err := validateS3Credential("secret key", settings.SecretKey, 1024, required); err != nil {
		return err
	}
	return nil
}

func validateS3Credential(name, value string, maxLength int, required bool) error {
	if required && value == "" {
		return fmt.Errorf("S3 %s is required", name)
	}
	if value == "" {
		return nil
	}
	if value != strings.TrimSpace(value) || len(value) > maxLength {
		return fmt.Errorf("S3 %s syntax is invalid", name)
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return fmt.Errorf("S3 %s syntax is invalid", name)
		}
	}
	return nil
}
