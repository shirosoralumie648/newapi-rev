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
)

const (
	ObjectStoreBackendEnv    = "OBJECT_STORE_BACKEND"
	ObjectStoreLocalDirEnv   = "OBJECT_STORE_LOCAL_DIR"
	ObjectStorePrefixEnv     = "OBJECT_STORE_PREFIX"
	ObjectStorePresignTTLEnv = "OBJECT_STORE_PRESIGN_TTL"
)

var (
	taskArtifactStoreBucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	taskArtifactStoreRegionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

// TaskArtifactStoreConfig reserves the configuration contract for a future S3
// implementation. The current release always falls back to upstream proxying.
type TaskArtifactStoreConfig struct {
	Mode                string
	S3Endpoint          string
	S3Bucket            string
	S3Region            string
	S3AccessKey         string
	S3SecretKey         string
	S3Prefix            string
	S3PresignTTLSeconds int
}

// LoadTaskArtifactStoreConfig reads and validates startup-only configuration.
// S3 mode is deliberately disabled until a storage implementation is shipped.
func LoadTaskArtifactStoreConfig() TaskArtifactStoreConfig {
	config := TaskArtifactStoreConfig{
		Mode:                common.GetEnvOrDefaultString(TaskArtifactStoreModeEnv, TaskArtifactStoreModeUpstream),
		S3Endpoint:          common.GetEnvOrDefaultString(TaskArtifactStoreS3EndpointEnv, ""),
		S3Bucket:            common.GetEnvOrDefaultString(TaskArtifactStoreS3BucketEnv, ""),
		S3Region:            common.GetEnvOrDefaultString(TaskArtifactStoreS3RegionEnv, ""),
		S3AccessKey:         common.GetEnvOrDefaultString(TaskArtifactStoreS3AccessKeyEnv, ""),
		S3SecretKey:         common.GetEnvOrDefaultString(TaskArtifactStoreS3SecretKeyEnv, ""),
		S3Prefix:            common.GetEnvOrDefaultString(TaskArtifactStoreS3PrefixEnv, ""),
		S3PresignTTLSeconds: common.GetEnvOrDefault(TaskArtifactStoreS3PresignTTLEnv, DefaultTaskArtifactStorePresignTTLSeconds),
	}
	if err := ValidateTaskArtifactStoreConfig(config); err != nil {
		common.SysError(common.LogText("invalid task artifact store configuration: %s; using upstream mode", err.Error()))
		config.Mode = TaskArtifactStoreModeUpstream
		return config
	}
	if config.Mode == TaskArtifactStoreModeS3 {
		common.SysError(common.LogText("task artifact S3 storage is not implemented; using upstream mode"))
		config.Mode = TaskArtifactStoreModeUpstream
	}
	return config
}

// ObjectStoreConfig is the unified object storage contract shared by
// Playground attachments and task artifacts. Only the local backend is
// implemented in this release.
type ObjectStoreConfig struct {
	Backend           string
	LocalDir          string
	Prefix            string
	PresignTTLSeconds int
}

// LoadObjectStoreConfig reads and validates startup-only configuration. The
// local backend is the default; invalid values fall back to local defaults.
func LoadObjectStoreConfig() ObjectStoreConfig {
	config := ObjectStoreConfig{
		Backend:           common.GetEnvOrDefaultString(ObjectStoreBackendEnv, ObjectStoreBackendLocal),
		LocalDir:          common.GetEnvOrDefaultString(ObjectStoreLocalDirEnv, DefaultObjectStoreLocalDir),
		Prefix:            common.GetEnvOrDefaultString(ObjectStorePrefixEnv, ""),
		PresignTTLSeconds: common.GetEnvOrDefault(ObjectStorePresignTTLEnv, DefaultTaskArtifactStorePresignTTLSeconds),
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
	case ObjectStoreBackendS3, ObjectStoreBackendDB:
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

	requireS3Fields := config.Mode == TaskArtifactStoreModeS3
	if requireS3Fields && config.S3Endpoint == "" {
		return errors.New("S3 endpoint is required")
	}
	if config.S3Endpoint != "" {
		if config.S3Endpoint != strings.TrimSpace(config.S3Endpoint) {
			return errors.New("S3 endpoint must not contain surrounding whitespace")
		}
		endpoint, err := url.Parse(config.S3Endpoint)
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

	if requireS3Fields && config.S3Bucket == "" {
		return errors.New("S3 bucket is required")
	}
	if config.S3Bucket != "" {
		if !taskArtifactStoreBucketPattern.MatchString(config.S3Bucket) ||
			strings.Contains(config.S3Bucket, "..") || net.ParseIP(config.S3Bucket) != nil {
			return errors.New("S3 bucket syntax is invalid")
		}
	}

	if requireS3Fields && config.S3Region == "" {
		return errors.New("S3 region is required")
	}
	if config.S3Region != "" && !taskArtifactStoreRegionPattern.MatchString(config.S3Region) {
		return errors.New("S3 region syntax is invalid")
	}
	if err := validateTaskArtifactStoreCredential("access key", config.S3AccessKey, 256, requireS3Fields); err != nil {
		return err
	}
	if err := validateTaskArtifactStoreCredential("secret key", config.S3SecretKey, 1024, requireS3Fields); err != nil {
		return err
	}

	if config.S3Prefix != "" {
		if err := validateStoragePrefix(config.S3Prefix); err != nil {
			return fmt.Errorf("S3 %w", err)
		}
	}
	return nil
}

func validateTaskArtifactStoreCredential(name, value string, maxLength int, required bool) error {
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
