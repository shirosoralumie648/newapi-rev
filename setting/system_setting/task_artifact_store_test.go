package system_setting

import (
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func validTaskArtifactStoreConfig() TaskArtifactStoreConfig {
	return TaskArtifactStoreConfig{
		Mode: TaskArtifactStoreModeS3,
		S3: S3Settings{
			Endpoint:  "https://objects.example.com/storage",
			Bucket:    "task-artifacts",
			Region:    "us-east-1",
			AccessKey: "access-key",
			SecretKey: "secret-key",
			PathStyle: true,
		},
		S3Prefix:            "tasks/v1/",
		S3PresignTTLSeconds: 900,
	}
}

func TestValidateTaskArtifactStoreConfig(t *testing.T) {
	require.NoError(t, ValidateTaskArtifactStoreConfig(validTaskArtifactStoreConfig()))
	require.NoError(t, ValidateTaskArtifactStoreConfig(TaskArtifactStoreConfig{
		Mode:                TaskArtifactStoreModeUpstream,
		S3PresignTTLSeconds: DefaultTaskArtifactStorePresignTTLSeconds,
	}))

	tests := []struct {
		name   string
		mutate func(*TaskArtifactStoreConfig)
		match  string
	}{
		{name: "mode", mutate: func(config *TaskArtifactStoreConfig) { config.Mode = "filesystem" }, match: "unsupported mode"},
		{name: "missing endpoint", mutate: func(config *TaskArtifactStoreConfig) { config.S3.Endpoint = "" }, match: "endpoint is required"},
		{name: "endpoint scheme", mutate: func(config *TaskArtifactStoreConfig) { config.S3.Endpoint = "ftp://objects.example.com" }, match: "http or https"},
		{name: "endpoint credentials", mutate: func(config *TaskArtifactStoreConfig) { config.S3.Endpoint = "https://user:pass@objects.example.com" }, match: "without userinfo"},
		{name: "endpoint query", mutate: func(config *TaskArtifactStoreConfig) { config.S3.Endpoint = "https://objects.example.com?token=secret" }, match: "query or fragment"},
		{name: "missing bucket", mutate: func(config *TaskArtifactStoreConfig) { config.S3.Bucket = "" }, match: "bucket is required"},
		{name: "bucket", mutate: func(config *TaskArtifactStoreConfig) { config.S3.Bucket = "Invalid_Bucket" }, match: "bucket syntax"},
		{name: "IP bucket", mutate: func(config *TaskArtifactStoreConfig) { config.S3.Bucket = "192.168.1.1" }, match: "bucket syntax"},
		{name: "missing region", mutate: func(config *TaskArtifactStoreConfig) { config.S3.Region = "" }, match: "region is required"},
		{name: "region", mutate: func(config *TaskArtifactStoreConfig) { config.S3.Region = "bad region" }, match: "region syntax"},
		{name: "missing credentials", mutate: func(config *TaskArtifactStoreConfig) {
			config.S3.AccessKey = ""
			config.S3.SecretKey = ""
		}, match: "access key is required"},
		{name: "partial credentials", mutate: func(config *TaskArtifactStoreConfig) { config.S3.SecretKey = "" }, match: "set together"},
		{name: "access key", mutate: func(config *TaskArtifactStoreConfig) { config.S3.AccessKey = " access-key" }, match: "access key syntax"},
		{name: "secret key", mutate: func(config *TaskArtifactStoreConfig) { config.S3.SecretKey = "secret\nkey" }, match: "secret key syntax"},
		{name: "prefix root", mutate: func(config *TaskArtifactStoreConfig) { config.S3Prefix = "/tasks" }, match: "prefix syntax"},
		{name: "prefix traversal", mutate: func(config *TaskArtifactStoreConfig) { config.S3Prefix = "tasks/../private" }, match: "dot segments"},
		{name: "TTL zero", mutate: func(config *TaskArtifactStoreConfig) { config.S3PresignTTLSeconds = 0 }, match: "presign TTL"},
		{name: "TTL too long", mutate: func(config *TaskArtifactStoreConfig) {
			config.S3PresignTTLSeconds = MaxTaskArtifactStorePresignTTLSeconds + 1
		}, match: "presign TTL"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			config := validTaskArtifactStoreConfig()
			testCase.mutate(&config)
			assert.ErrorContains(t, ValidateTaskArtifactStoreConfig(config), testCase.match)
		})
	}
}

func TestValidateTaskArtifactStoreConfigNeverRepeatsSecrets(t *testing.T) {
	config := validTaskArtifactStoreConfig()
	config.S3.Bucket = "Invalid_Bucket"
	config.S3.AccessKey = "AKIAEXAMPLEACCESS"
	config.S3.SecretKey = "example-secret-value"
	err := ValidateTaskArtifactStoreConfig(config)
	require.Error(t, err)
	assert.NotContains(t, err.Error(), config.S3.AccessKey)
	assert.NotContains(t, err.Error(), config.S3.SecretKey)
}

func TestValidateTaskArtifactStoreConfigRequiresCredentialsInS3Mode(t *testing.T) {
	config := validTaskArtifactStoreConfig()
	config.S3.AccessKey = ""
	config.S3.SecretKey = ""
	err := ValidateTaskArtifactStoreConfig(config)
	require.ErrorContains(t, err, "access key is required")

	// A half-configured credential pair is rejected in every mode.
	config = validTaskArtifactStoreConfig()
	config.S3.SecretKey = ""
	require.ErrorContains(t, ValidateTaskArtifactStoreConfig(config), "set together")

	// Upstream mode tolerates an empty S3 group, but a half-configured
	// credential pair is always rejected.
	config = TaskArtifactStoreConfig{
		Mode:                TaskArtifactStoreModeUpstream,
		S3PresignTTLSeconds: DefaultTaskArtifactStorePresignTTLSeconds,
	}
	require.NoError(t, ValidateTaskArtifactStoreConfig(config))
	config.S3.AccessKey = "only-the-access-key"
	assert.ErrorContains(t, ValidateTaskArtifactStoreConfig(config), "set together")
}

func TestLoadTaskArtifactStoreConfigFallsBackToUpstream(t *testing.T) {
	t.Setenv(TaskArtifactStoreModeEnv, "filesystem")
	t.Setenv(TaskArtifactStoreS3PresignTTLEnv, "900")
	config := LoadTaskArtifactStoreConfig()
	assert.Equal(t, TaskArtifactStoreModeUpstream, config.Mode)

	t.Setenv(TaskArtifactStoreModeEnv, TaskArtifactStoreModeS3)
	t.Setenv(TaskArtifactStoreS3EndpointEnv, "https://objects.example.com")
	t.Setenv(TaskArtifactStoreS3BucketEnv, "task-artifacts")
	t.Setenv(TaskArtifactStoreS3RegionEnv, "us-east-1")
	t.Setenv(TaskArtifactStoreS3AccessKeyEnv, "access-key")
	t.Setenv(TaskArtifactStoreS3SecretKeyEnv, "secret-key")
	t.Setenv(TaskArtifactStoreS3PrefixEnv, "tasks/v1")
	t.Setenv(TaskArtifactStoreS3PresignTTLEnv, "600")
	t.Setenv(TaskArtifactStoreS3PathStyleEnv, "true")
	config = LoadTaskArtifactStoreConfig()

	// A complete configuration enables S3 mode (the mode fallback above only
	// applies to an invalid or incomplete one); the loader still parses the
	// S3 settings of that configuration.
	assert.Equal(t, TaskArtifactStoreModeS3, config.Mode)
	assert.Equal(t, "https://objects.example.com", config.S3.Endpoint)
	assert.Equal(t, 600, config.S3PresignTTLSeconds)
}

func TestLoadTaskArtifactStoreConfigEnablesS3WhenComplete(t *testing.T) {
	t.Setenv(TaskArtifactStoreModeEnv, TaskArtifactStoreModeS3)
	t.Setenv(TaskArtifactStoreS3EndpointEnv, "https://objects.example.com")
	t.Setenv(TaskArtifactStoreS3BucketEnv, "task-artifacts")
	t.Setenv(TaskArtifactStoreS3RegionEnv, "us-east-1")
	t.Setenv(TaskArtifactStoreS3AccessKeyEnv, "access-key")
	t.Setenv(TaskArtifactStoreS3SecretKeyEnv, "secret-key")
	t.Setenv(TaskArtifactStoreS3PrefixEnv, "tasks/v1")
	t.Setenv(TaskArtifactStoreS3PresignTTLEnv, "600")
	t.Setenv(TaskArtifactStoreS3PathStyleEnv, "true")

	config := LoadTaskArtifactStoreConfig()
	assert.Equal(t, TaskArtifactStoreModeS3, config.Mode)
	assert.Equal(t, "https://objects.example.com", config.S3.Endpoint)
	assert.Equal(t, "task-artifacts", config.S3.Bucket)
	assert.Equal(t, "us-east-1", config.S3.Region)
	assert.Equal(t, "access-key", config.S3.AccessKey)
	assert.Equal(t, "secret-key", config.S3.SecretKey)
	assert.True(t, config.S3.PathStyle)
	assert.Equal(t, "tasks/v1", config.S3Prefix)
	assert.Equal(t, 600, config.S3PresignTTLSeconds)

	objectStore := config.ObjectStoreConfig()
	assert.Equal(t, ObjectStoreBackendS3, objectStore.Backend)
	assert.Equal(t, config.S3, objectStore.S3)
	assert.Equal(t, config.S3Prefix, objectStore.Prefix)
	assert.Equal(t, config.S3PresignTTLSeconds, objectStore.PresignTTLSeconds)
	require.NoError(t, ValidateObjectStoreConfig(objectStore))
}

func TestValidateObjectStoreConfig(t *testing.T) {
	validLocal := ObjectStoreConfig{
		Backend:           ObjectStoreBackendLocal,
		LocalDir:          "data/objectstore",
		Prefix:            "pg/v1",
		PresignTTLSeconds: DefaultTaskArtifactStorePresignTTLSeconds,
	}
	require.NoError(t, ValidateObjectStoreConfig(validLocal))

	validS3 := ObjectStoreConfig{
		Backend:           ObjectStoreBackendS3,
		Prefix:            "pg/v1",
		PresignTTLSeconds: DefaultTaskArtifactStorePresignTTLSeconds,
		S3: S3Settings{
			Endpoint:  "https://objects.example.com",
			Bucket:    "playground-objects",
			Region:    "auto",
			AccessKey: "access-key",
			SecretKey: "secret-key",
		},
	}
	require.NoError(t, ValidateObjectStoreConfig(validS3))

	localTests := []struct {
		name   string
		mutate func(*ObjectStoreConfig)
		match  string
	}{
		{name: "empty backend", mutate: func(config *ObjectStoreConfig) { config.Backend = "" }, match: "unsupported object store backend"},
		{name: "unknown backend", mutate: func(config *ObjectStoreConfig) { config.Backend = "ftp" }, match: "unsupported object store backend"},
		{name: "reserved db backend", mutate: func(config *ObjectStoreConfig) { config.Backend = ObjectStoreBackendDB }, match: "not implemented"},
		{name: "missing directory", mutate: func(config *ObjectStoreConfig) { config.LocalDir = "" }, match: "directory is required"},
		{name: "padded directory", mutate: func(config *ObjectStoreConfig) { config.LocalDir = " data/objects " }, match: "directory syntax"},
		{name: "control directory", mutate: func(config *ObjectStoreConfig) { config.LocalDir = "data\nobjects" }, match: "control characters"},
		{name: "traversal directory", mutate: func(config *ObjectStoreConfig) { config.LocalDir = "data/../objects" }, match: "dot segments"},
		{name: "windows traversal directory", mutate: func(config *ObjectStoreConfig) { config.LocalDir = `data\..\objects` }, match: "dot segments"},
		{name: "prefix root", mutate: func(config *ObjectStoreConfig) { config.Prefix = "/objects" }, match: "prefix syntax"},
		{name: "prefix backslash", mutate: func(config *ObjectStoreConfig) { config.Prefix = `objects\v1` }, match: "prefix syntax"},
		{name: "prefix traversal", mutate: func(config *ObjectStoreConfig) { config.Prefix = "objects/../private" }, match: "dot segments"},
		{name: "TTL zero", mutate: func(config *ObjectStoreConfig) { config.PresignTTLSeconds = 0 }, match: "presign TTL"},
		{name: "TTL too long", mutate: func(config *ObjectStoreConfig) {
			config.PresignTTLSeconds = MaxTaskArtifactStorePresignTTLSeconds + 1
		}, match: "presign TTL"},
	}
	for _, testCase := range localTests {
		t.Run("local/"+testCase.name, func(t *testing.T) {
			config := validLocal
			testCase.mutate(&config)
			assert.ErrorContains(t, ValidateObjectStoreConfig(config), testCase.match)
		})
	}

	s3Tests := []struct {
		name   string
		mutate func(*ObjectStoreConfig)
		match  string
	}{
		{name: "missing endpoint", mutate: func(config *ObjectStoreConfig) { config.S3.Endpoint = "" }, match: "endpoint is required"},
		{name: "endpoint userinfo", mutate: func(config *ObjectStoreConfig) { config.S3.Endpoint = "https://user:pass@objects.example.com" }, match: "without userinfo"},
		{name: "missing bucket", mutate: func(config *ObjectStoreConfig) { config.S3.Bucket = "" }, match: "bucket is required"},
		{name: "bucket syntax", mutate: func(config *ObjectStoreConfig) { config.S3.Bucket = "Invalid_Bucket" }, match: "bucket syntax"},
		{name: "missing region", mutate: func(config *ObjectStoreConfig) { config.S3.Region = "" }, match: "region is required"},
		{name: "region syntax", mutate: func(config *ObjectStoreConfig) { config.S3.Region = "bad region" }, match: "region syntax"},
		{name: "missing credentials", mutate: func(config *ObjectStoreConfig) {
			config.S3.AccessKey = ""
			config.S3.SecretKey = ""
		}, match: "access key is required"},
		{name: "partial credentials", mutate: func(config *ObjectStoreConfig) { config.S3.SecretKey = "" }, match: "set together"},
		{name: "prefix traversal", mutate: func(config *ObjectStoreConfig) { config.Prefix = "objects/../private" }, match: "dot segments"},
		{name: "TTL too long", mutate: func(config *ObjectStoreConfig) {
			config.PresignTTLSeconds = MaxTaskArtifactStorePresignTTLSeconds + 1
		}, match: "presign TTL"},
	}
	for _, testCase := range s3Tests {
		t.Run("s3/"+testCase.name, func(t *testing.T) {
			config := validS3
			testCase.mutate(&config)
			assert.ErrorContains(t, ValidateObjectStoreConfig(config), testCase.match)
		})
	}
}

func TestLoadObjectStoreConfigDefaultsAndFallback(t *testing.T) {
	t.Setenv(ObjectStoreBackendEnv, ObjectStoreBackendLocal)
	t.Setenv(ObjectStoreLocalDirEnv, "data/custom-objects")
	t.Setenv(ObjectStorePrefixEnv, "pg/v1")
	t.Setenv(ObjectStorePresignTTLEnv, "600")
	config := LoadObjectStoreConfig()
	assert.Equal(t, ObjectStoreBackendLocal, config.Backend)
	assert.Equal(t, "data/custom-objects", config.LocalDir)
	assert.Equal(t, "pg/v1", config.Prefix)
	assert.Equal(t, 600, config.PresignTTLSeconds)

	t.Setenv(ObjectStoreBackendEnv, "ftp")
	t.Setenv(ObjectStoreLocalDirEnv, "data/custom-objects")
	config = LoadObjectStoreConfig()
	assert.Equal(t, ObjectStoreBackendLocal, config.Backend)
	assert.Equal(t, DefaultObjectStoreLocalDir, config.LocalDir)
	assert.Equal(t, "", config.Prefix)
	assert.Equal(t, DefaultTaskArtifactStorePresignTTLSeconds, config.PresignTTLSeconds)
	assert.Equal(t, S3Settings{}, config.S3)
}

func TestLoadObjectStoreConfigReadsS3Settings(t *testing.T) {
	t.Setenv(ObjectStoreBackendEnv, ObjectStoreBackendS3)
	t.Setenv(ObjectStorePrefixEnv, "objects/v1")
	t.Setenv(ObjectStorePresignTTLEnv, "1200")
	t.Setenv(ObjectStoreS3EndpointEnv, "https://objects.example.com")
	t.Setenv(ObjectStoreS3BucketEnv, "playground-objects")
	t.Setenv(ObjectStoreS3RegionEnv, "auto")
	t.Setenv(ObjectStoreS3AccessKeyEnv, "access-key")
	t.Setenv(ObjectStoreS3SecretKeyEnv, "secret-key")
	t.Setenv(ObjectStoreS3PathStyleEnv, "true")

	config := LoadObjectStoreConfig()
	require.NoError(t, ValidateObjectStoreConfig(config))
	assert.Equal(t, ObjectStoreBackendS3, config.Backend)
	assert.Equal(t, "objects/v1", config.Prefix)
	assert.Equal(t, 1200, config.PresignTTLSeconds)
	assert.Equal(t, S3Settings{
		Endpoint:  "https://objects.example.com",
		Bucket:    "playground-objects",
		Region:    "auto",
		AccessKey: "access-key",
		SecretKey: "secret-key",
		PathStyle: true,
	}, config.S3)
}

func TestLoadObjectStoreConfigInheritsTaskArtifactS3Settings(t *testing.T) {
	t.Setenv(ObjectStoreBackendEnv, ObjectStoreBackendS3)
	t.Setenv(TaskArtifactStoreS3EndpointEnv, "https://objects.example.com")
	t.Setenv(TaskArtifactStoreS3BucketEnv, "shared-bucket")
	t.Setenv(TaskArtifactStoreS3RegionEnv, "us-east-1")
	t.Setenv(TaskArtifactStoreS3AccessKeyEnv, "access-key")
	t.Setenv(TaskArtifactStoreS3SecretKeyEnv, "secret-key")
	t.Setenv(TaskArtifactStoreS3PathStyleEnv, "true")

	config := LoadObjectStoreConfig()
	require.NoError(t, ValidateObjectStoreConfig(config))
	assert.Equal(t, ObjectStoreBackendS3, config.Backend)
	assert.Equal(t, "shared-bucket", config.S3.Bucket)
	assert.Equal(t, "https://objects.example.com", config.S3.Endpoint)
	assert.True(t, config.S3.PathStyle)

	// The object store's own settings win over the inherited ones.
	t.Setenv(ObjectStoreS3BucketEnv, "playground-objects")
	t.Setenv(ObjectStoreS3EndpointEnv, "https://objects.example.com")
	t.Setenv(ObjectStoreS3RegionEnv, "us-east-1")
	t.Setenv(ObjectStoreS3AccessKeyEnv, "access-key-2")
	t.Setenv(ObjectStoreS3SecretKeyEnv, "secret-key-2")
	config = LoadObjectStoreConfig()
	require.NoError(t, ValidateObjectStoreConfig(config))
	assert.Equal(t, "playground-objects", config.S3.Bucket)
	assert.Equal(t, "access-key-2", config.S3.AccessKey)
}

// The generated-result retention window is configurable within a bounded
// range; an unset, malformed, or out-of-range value falls back to the default
// so a typo can never turn the lifecycle policy into "delete now".
func TestLoadTaskArtifactRetentionDays(t *testing.T) {
	assert.Equal(t, DefaultTaskArtifactRetentionDays, LoadTaskArtifactRetentionDays())

	t.Setenv(TaskArtifactRetentionDaysEnv, "7")
	assert.Equal(t, 7, LoadTaskArtifactRetentionDays())

	t.Setenv(TaskArtifactRetentionDaysEnv, "0")
	assert.Equal(t, DefaultTaskArtifactRetentionDays, LoadTaskArtifactRetentionDays())

	t.Setenv(TaskArtifactRetentionDaysEnv, "-1")
	assert.Equal(t, DefaultTaskArtifactRetentionDays, LoadTaskArtifactRetentionDays())

	t.Setenv(TaskArtifactRetentionDaysEnv, "abc")
	assert.Equal(t, DefaultTaskArtifactRetentionDays, LoadTaskArtifactRetentionDays())

	t.Setenv(TaskArtifactRetentionDaysEnv, strconv.Itoa(MaxTaskArtifactRetentionDays+1))
	assert.Equal(t, DefaultTaskArtifactRetentionDays, LoadTaskArtifactRetentionDays())

	// The loader exposes the same value on the store configuration.
	t.Setenv(TaskArtifactRetentionDaysEnv, "90")
	config := TaskArtifactStoreConfig{
		Mode:                TaskArtifactStoreModeUpstream,
		S3PresignTTLSeconds: DefaultTaskArtifactStorePresignTTLSeconds,
		RetentionDays:       LoadTaskArtifactRetentionDays(),
	}
	assert.Equal(t, 90, config.RetentionDays)
}
