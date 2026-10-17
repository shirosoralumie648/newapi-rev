package objectstore

import (
	"sync"
	"time"

	"github.com/QuantumNous/new-api/setting/system_setting"
)

// The process-wide store selected by the object store configuration at
// startup. Callers must verify ownership before reading an object; the store
// only isolates backends, not application data.
var (
	defaultStoreMu    sync.RWMutex
	defaultStore      Store
	defaultPresignTTL = time.Duration(system_setting.DefaultTaskArtifactStorePresignTTLSeconds) * time.Second
)

// InitDefaultStore opens the configured backend and installs it as the
// process-wide object store. It runs once during resource initialization.
func InitDefaultStore() error {
	config := system_setting.LoadObjectStoreConfig()
	store, err := New(config)
	if err != nil {
		return err
	}
	SetDefaultStore(store, time.Duration(config.PresignTTLSeconds)*time.Second)
	return nil
}

// SetDefaultStore installs store as the process-wide object store. Tests use
// it to point object bytes at a temporary directory; passing a nil store
// clears it again. A non-positive ttl keeps the currently configured value.
func SetDefaultStore(store Store, presignTTL time.Duration) {
	defaultStoreMu.Lock()
	defer defaultStoreMu.Unlock()
	defaultStore = store
	if presignTTL > 0 {
		defaultPresignTTL = presignTTL
	}
}

// DefaultStore returns the process-wide object store, or nil while no store
// is configured.
func DefaultStore() Store {
	defaultStoreMu.RLock()
	defer defaultStoreMu.RUnlock()
	return defaultStore
}

// DefaultPresignTTL is the lifetime of download links handed out through
// PresignGet.
func DefaultPresignTTL() time.Duration {
	defaultStoreMu.RLock()
	defer defaultStoreMu.RUnlock()
	return defaultPresignTTL
}
