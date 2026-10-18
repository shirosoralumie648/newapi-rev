package service

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service/objectstore"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/QuantumNous/new-api/types"
	"golang.org/x/net/http/httpguts"
)

const (
	// playgroundTaskArtifactStoreBatch bounds how many tasks one store pass
	// handles. Each task may download large media, so the pass stays small and
	// the scheduled runner repeats it.
	playgroundTaskArtifactStoreBatch = 4
	// taskArtifactMaxAttempts bounds retryable failures before an artifact is
	// marked expired. Its provider reference is kept either way.
	taskArtifactMaxAttempts = 5
	// taskArtifactDataURLMaxEncodedBytes caps an inline base64 provider result.
	taskArtifactDataURLMaxEncodedBytes = 64 << 20
	// taskArtifactFetchTimeout bounds one artifact download end to end.
	taskArtifactFetchTimeout = 5 * time.Minute

	taskArtifactMaxURLLength = 8 << 10
	taskArtifactSniffBytes   = 512
)

var (
	// errTaskArtifactPermanent marks a failure that retrying cannot fix
	// (unsupported scheme, rejected media type, upstream 404). Permanent
	// failures expire the artifact immediately instead of burning retries.
	errTaskArtifactPermanent = errors.New("permanent task artifact failure")

	// taskArtifactObjectMaxBytes caps one generated result. The provider proxy
	// applies the same order of magnitude; a larger object is refused instead
	// of filling the deployment disk. Tests lower it to exercise the cap.
	taskArtifactObjectMaxBytes int64 = 512 << 20

	// taskArtifactFetchClient rejects private, loopback, and link-local
	// addresses at dial time regardless of the global fetch settings, so a
	// provider response can never make the gateway read its own network.
	taskArtifactFetchClient = newTaskArtifactFetchClient()

	// taskArtifactFetchTargetValidator is the pre-flight network check of a
	// provider URL. Tests replace it to point the pipeline at a loopback
	// httptest provider; production keeps the strict default.
	taskArtifactFetchTargetValidator = validateTaskArtifactFetchTarget
)

// TaskArtifactSource is one provider request that yields the bytes of an
// artifact. Credentialless requests carry no headers or body and are verified
// again before they are sent.
type TaskArtifactSource struct {
	URL            string
	Method         string
	Headers        map[string]string
	Body           []byte
	Credentialless bool
}

// TaskArtifactCollector enumerates the artifacts of a completed task and
// builds the provider request for one of them. The controller implements it
// with the plugin adaptor and the legacy result URL; the store pass itself
// stays free of relay imports.
type TaskArtifactCollector interface {
	ListTaskArtifacts(task *model.Task) ([]model.PlaygroundTaskArtifactSeed, error)
	BuildTaskArtifactRequest(ctx context.Context, task *model.Task, artifactKey string) (*TaskArtifactSource, error)
}

// TaskArtifactStoreSummary reports one store pass.
type TaskArtifactStoreSummary struct {
	TasksScanned     int `json:"tasks_scanned"`
	ArtifactsStored  int `json:"artifacts_stored"`
	ArtifactsExpired int `json:"artifacts_expired"`
	ArtifactsPending int `json:"artifacts_pending"`
	ArtifactsFailed  int `json:"artifacts_failed"`
}

type taskArtifactStoreOutcome int

const (
	taskArtifactOutcomeStored taskArtifactStoreOutcome = iota
	taskArtifactOutcomeExpired
	taskArtifactOutcomePending
	taskArtifactOutcomeFailed
)

// TaskArtifactRetention is the configured lifetime of a stored generation
// result. Results pinned by the asset library or a canvas never expire.
func TaskArtifactRetention() time.Duration {
	return time.Duration(system_setting.LoadTaskArtifactRetentionDays()) * 24 * time.Hour
}

// StorePendingPlaygroundTaskArtifacts pulls the provider results of finished
// workspace tasks into the object store. It first retries artifacts that are
// still pending, then discovers tasks that were never projected, so one pass
// both makes progress on failures and picks up new completions. Every artifact
// ends either stored, expired (with its provider reference kept), or pending
// for the next run — nothing is silently dropped.
func StorePendingPlaygroundTaskArtifacts(ctx context.Context, collector TaskArtifactCollector, limit int) (TaskArtifactStoreSummary, error) {
	summary := TaskArtifactStoreSummary{}
	if collector == nil {
		return summary, errors.New("task artifact collector is required")
	}
	if taskArtifactObjectStore() == nil {
		return summary, ErrTaskArtifactStoreDisabled
	}
	if limit <= 0 {
		limit = playgroundTaskArtifactStoreBatch
	}

	owners := make([]model.TaskArtifactOwner, 0, limit)
	seen := make(map[string]bool, limit)
	retry, err := model.PendingTaskArtifactOwners(limit)
	if err != nil {
		return summary, err
	}
	for _, owner := range retry {
		key := taskArtifactOwnerKey(owner.UserID, owner.TaskID)
		if seen[key] {
			continue
		}
		seen[key] = true
		owners = append(owners, owner)
	}
	if remaining := limit - len(owners); remaining > 0 {
		cutoff := common.GetTimestamp() - int64(TaskArtifactRetention().Seconds())
		tasks, err := model.ListPlaygroundTasksMissingArtifactSync(cutoff, remaining)
		if err != nil {
			return summary, err
		}
		for _, task := range tasks {
			key := taskArtifactOwnerKey(task.UserId, task.TaskID)
			if seen[key] {
				continue
			}
			seen[key] = true
			owners = append(owners, model.TaskArtifactOwner{UserID: task.UserId, TaskID: task.TaskID})
		}
	}

	for _, owner := range owners {
		if err := ctx.Err(); err != nil {
			return summary, err
		}
		summary.TasksScanned++
		if err := storeTaskArtifactsForOwner(ctx, collector, &summary, owner); err != nil {
			logger.LogWarn(ctx, fmt.Sprintf("Failed to store artifacts of task %s (user %d): %v", owner.TaskID, owner.UserID, err))
		}
	}
	return summary, nil
}

func taskArtifactOwnerKey(userID int, taskID string) string {
	return strconv.Itoa(userID) + "\x00" + taskID
}

// storeTaskArtifactsForOwner projects one task's artifacts and persists every
// pending one. The task is only marked as projected once nothing is left
// pending, so a transient failure is retried by the next pass.
func storeTaskArtifactsForOwner(ctx context.Context, collector TaskArtifactCollector, summary *TaskArtifactStoreSummary, owner model.TaskArtifactOwner) error {
	task, exists, err := model.GetByTaskId(owner.UserID, owner.TaskID)
	if err != nil {
		return err
	}
	if !exists || task == nil {
		// The owner deleted nothing, but the task row itself expired; the
		// pending records can never be fetched again, so they are closed out
		// with the reason instead of being retried forever.
		return expireTaskArtifactsOfMissingTask(owner)
	}
	seeds, err := collector.ListTaskArtifacts(task)
	if err != nil {
		return err
	}
	records, err := model.EnsurePlaygroundTaskArtifacts(owner.UserID, owner.TaskID, seeds)
	if err != nil {
		return err
	}
	pending := 0
	for index := range records {
		record := records[index]
		if record.State != model.TaskArtifactStatePending {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		outcome, err := storeOneTaskArtifact(ctx, collector, task, record)
		if err != nil {
			return err
		}
		switch outcome {
		case taskArtifactOutcomeStored:
			summary.ArtifactsStored++
		case taskArtifactOutcomeExpired:
			summary.ArtifactsExpired++
		case taskArtifactOutcomePending:
			summary.ArtifactsPending++
			pending++
		case taskArtifactOutcomeFailed:
			summary.ArtifactsFailed++
			pending++
		}
	}
	if pending == 0 {
		return model.MarkPlaygroundTaskArtifactsSynced(owner.UserID, owner.TaskID)
	}
	return nil
}

// expireTaskArtifactsOfMissingTask closes the pending records of a task row
// that no longer exists. The provider reference died with the row, so the
// artifacts are reported as expired instead of being retried.
func expireTaskArtifactsOfMissingTask(owner model.TaskArtifactOwner) error {
	records, err := model.PlaygroundTaskArtifactsForTask(owner.UserID, owner.TaskID)
	if err != nil {
		return err
	}
	for index := range records {
		if records[index].State != model.TaskArtifactStatePending {
			continue
		}
		if err := model.MarkPlaygroundTaskArtifactExpired(records[index].ID, "", "The task row expired before its result could be stored."); err != nil {
			return err
		}
	}
	return model.MarkPlaygroundTaskArtifactsSynced(owner.UserID, owner.TaskID)
}

// storeOneTaskArtifact fetches and stores one artifact, then records the
// outcome. The quota is checked with the same account budget the submission
// path enforces; when it is exhausted the artifact keeps its provider
// reference and is marked expired, never dropped.
func storeOneTaskArtifact(ctx context.Context, collector TaskArtifactCollector, task *model.Task, record model.PlaygroundTaskArtifact) (taskArtifactStoreOutcome, error) {
	source, err := collector.BuildTaskArtifactRequest(ctx, task, record.ArtifactKey)
	if err != nil {
		return settleTaskArtifactFailure(ctx, record, "", err)
	}
	fetched, err := fetchTaskArtifactContent(ctx, source, record)
	if err != nil {
		return settleTaskArtifactFailure(ctx, record, taskArtifactUpstreamRef(source), err)
	}
	defer fetched.cleanup()

	policy, err := model.PlaygroundQuotaPolicyForUser(task.UserId)
	if err != nil {
		return taskArtifactOutcomeFailed, err
	}
	if policy.TaskUserResultMaxBytes > 0 {
		stored, err := model.PlaygroundTaskResultStorageBytes(task.UserId)
		if err != nil {
			return taskArtifactOutcomeFailed, err
		}
		if stored+fetched.size > policy.TaskUserResultMaxBytes {
			reason := fmt.Sprintf("Playground task result storage limit of %d bytes is exhausted.", policy.TaskUserResultMaxBytes)
			if err := model.MarkPlaygroundTaskArtifactExpired(record.ID, taskArtifactUpstreamRef(source), reason); err != nil {
				return taskArtifactOutcomeFailed, err
			}
			return taskArtifactOutcomeExpired, nil
		}
	}

	file, err := os.Open(fetched.path)
	if err != nil {
		return taskArtifactOutcomeFailed, err
	}
	defer file.Close()
	artifact := types.TaskArtifact{Key: record.ArtifactKey, Type: record.ArtifactType, MimeType: fetched.mimeType}
	ref, err := taskArtifactStore.Persist(ctx, task, artifact, file)
	if err != nil {
		return settleTaskArtifactFailure(ctx, record, taskArtifactUpstreamRef(source), err)
	}
	expiresAt := common.GetTimestamp() + int64(TaskArtifactRetention().Seconds())
	if err := model.MarkPlaygroundTaskArtifactStored(record.ID, ref.Backend, ref.ObjectKey, fetched.mimeType, fetched.size, fetched.hash, expiresAt, taskArtifactUpstreamRef(source)); err != nil {
		// The object exists but no record points at it; remove it instead of
		// leaking bytes that only a retry could reach.
		if store := taskArtifactObjectStore(); store != nil {
			_ = store.Delete(ctx, ref.ObjectKey)
		}
		return taskArtifactOutcomeFailed, err
	}
	return taskArtifactOutcomeStored, nil
}

// settleTaskArtifactFailure records a retryable or permanent failure. A
// permanent failure, or a record that exhausted its attempts, expires the
// artifact while keeping the provider reference.
func settleTaskArtifactFailure(ctx context.Context, record model.PlaygroundTaskArtifact, upstreamRef string, failure error) (taskArtifactStoreOutcome, error) {
	reason := failure.Error()
	if errors.Is(failure, errTaskArtifactPermanent) || record.Attempts+1 >= taskArtifactMaxAttempts {
		if err := model.MarkPlaygroundTaskArtifactExpired(record.ID, upstreamRef, reason); err != nil {
			return taskArtifactOutcomeFailed, err
		}
		return taskArtifactOutcomeExpired, nil
	}
	if err := model.MarkPlaygroundTaskArtifactFailure(record.ID, reason); err != nil {
		return taskArtifactOutcomeFailed, err
	}
	return taskArtifactOutcomePending, nil
}

// DeleteExpiredTaskArtifactObjects deletes the stored bytes of artifacts whose
// retention window ended and that no pin keeps alive. The object is deleted
// before the row, so a failed object deletion leaves the record for the next
// run instead of leaking bytes nobody can reach.
func DeleteExpiredTaskArtifactObjects(ctx context.Context, limit int) (int64, error) {
	store := taskArtifactObjectStore()
	if store == nil {
		return 0, ErrTaskArtifactStoreDisabled
	}
	records, err := model.ListExpiredPlaygroundTaskArtifacts(common.GetTimestamp(), limit)
	if err != nil {
		return 0, err
	}
	var deleted int64
	for index := range records {
		if err := ctx.Err(); err != nil {
			return deleted, err
		}
		record := records[index]
		pinned, err := model.IsPlaygroundTaskArtifactPinned(record.UserID, record.TaskID, record.ArtifactKey)
		if err != nil {
			return deleted, err
		}
		if pinned {
			continue
		}
		if record.ObjectKey != "" {
			if err := store.Delete(ctx, record.ObjectKey); err != nil && !errors.Is(err, objectstore.ErrObjectNotFound) {
				logger.LogWarn(ctx, fmt.Sprintf("Failed to delete stored artifact %s of task %s: %v", record.ArtifactKey, record.TaskID, err))
				continue
			}
		}
		won, err := model.DeletePlaygroundTaskArtifact(record.ID)
		if err != nil {
			return deleted, err
		}
		if won {
			deleted++
		}
	}
	return deleted, nil
}

// fetchedTaskArtifact is the verified, spooled result of one provider fetch.
// The bytes live in a temporary file so the object store upload never buffers
// a whole video in memory.
type fetchedTaskArtifact struct {
	path     string
	size     int64
	hash     string
	mimeType string
}

func (f *fetchedTaskArtifact) cleanup() {
	if f == nil || f.path == "" {
		return
	}
	_ = os.Remove(f.path)
}

// fetchTaskArtifactContent resolves one provider reference into verified
// bytes: http(s) URLs go through the SSRF-protected client, data URLs are
// decoded inline, and both paths enforce the size cap and the media type
// contract before anything is written to the object store.
func fetchTaskArtifactContent(ctx context.Context, source *TaskArtifactSource, record model.PlaygroundTaskArtifact) (*fetchedTaskArtifact, error) {
	if source == nil {
		return nil, fmt.Errorf("%w: the provider request is missing", errTaskArtifactPermanent)
	}
	rawURL := strings.TrimSpace(source.URL)
	if rawURL == "" {
		return nil, fmt.Errorf("%w: the provider result is no longer available", errTaskArtifactPermanent)
	}
	fetchContext, cancel := context.WithTimeout(ctx, taskArtifactFetchTimeout)
	defer cancel()
	if strings.HasPrefix(strings.ToLower(rawURL), "data:") {
		return decodeTaskArtifactDataURL(rawURL, record)
	}
	parsed, err := validateTaskArtifactFetchURL(rawURL)
	if err != nil {
		return nil, err
	}
	if err := taskArtifactFetchTargetValidator(fetchContext, parsed); err != nil {
		return nil, err
	}
	method := strings.ToUpper(strings.TrimSpace(source.Method))
	if method == "" {
		method = http.MethodGet
	}
	switch method {
	case http.MethodGet, http.MethodPost:
	default:
		return nil, fmt.Errorf("%w: artifact fetch method %s is not supported", errTaskArtifactPermanent, method)
	}
	if source.Credentialless && (len(source.Headers) != 0 || len(source.Body) != 0) {
		return nil, fmt.Errorf("%w: credentialless artifact requests cannot carry headers or a body", errTaskArtifactPermanent)
	}
	if len(source.Body) > 1<<20 {
		return nil, fmt.Errorf("%w: artifact request body is too large", errTaskArtifactPermanent)
	}
	if len(source.Headers) > 32 {
		return nil, fmt.Errorf("%w: too many artifact request headers", errTaskArtifactPermanent)
	}

	request, err := http.NewRequestWithContext(fetchContext, method, parsed.String(), bytes.NewReader(source.Body))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errTaskArtifactPermanent, err)
	}
	if err := applyTaskArtifactFetchHeaders(request.Header, source.Headers); err != nil {
		return nil, err
	}
	response, err := taskArtifactFetchClient.Do(request)
	if err != nil {
		if fetchContext.Err() != nil {
			return nil, fmt.Errorf("artifact fetch timed out: %w", err)
		}
		return nil, fmt.Errorf("artifact fetch failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone {
			return nil, fmt.Errorf("%w: provider returned HTTP %d", errTaskArtifactPermanent, response.StatusCode)
		}
		if response.StatusCode >= 400 && response.StatusCode < 500 &&
			response.StatusCode != http.StatusRequestTimeout && response.StatusCode != http.StatusTooManyRequests {
			return nil, fmt.Errorf("%w: provider returned HTTP %d", errTaskArtifactPermanent, response.StatusCode)
		}
		return nil, fmt.Errorf("provider returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > taskArtifactObjectMaxBytes {
		return nil, fmt.Errorf("%w: provider result is %d bytes, above the %d byte limit", errTaskArtifactPermanent, response.ContentLength, taskArtifactObjectMaxBytes)
	}

	reader := bufio.NewReader(response.Body)
	prefix, _ := reader.Peek(taskArtifactSniffBytes)
	sniffed := http.DetectContentType(prefix)
	mimeType, err := resolveTaskArtifactMediaType(record.ArtifactType, record.MimeType, response.Header.Get("Content-Type"), sniffed)
	if err != nil {
		return nil, err
	}
	return spoolTaskArtifact(reader, mimeType)
}

// validateTaskArtifactFetchURL performs the syntax checks of a provider URL.
// Network-level checks (private, loopback, and link-local rejection) run in
// the dialer of the protected client on every connection and redirect.
func validateTaskArtifactFetchURL(raw string) (*url.URL, error) {
	if len(raw) > taskArtifactMaxURLLength {
		return nil, fmt.Errorf("%w: the provider URL is too long", errTaskArtifactPermanent)
	}
	if strings.ContainsAny(raw, "\x00\r\n") {
		return nil, fmt.Errorf("%w: the provider URL contains control characters", errTaskArtifactPermanent)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil {
		return nil, fmt.Errorf("%w: the provider URL is invalid", errTaskArtifactPermanent)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("%w: the provider URL must use http or https", errTaskArtifactPermanent)
	}
	if parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, fmt.Errorf("%w: the provider URL must be absolute without userinfo or fragment", errTaskArtifactPermanent)
	}
	return parsed, nil
}

// applyTaskArtifactFetchHeaders copies the plugin-provided headers after
// validating them, and refuses headers the transport owns.
func applyTaskArtifactFetchHeaders(destination http.Header, headers map[string]string) error {
	for name, value := range headers {
		name = strings.TrimSpace(name)
		if !httpguts.ValidHeaderFieldName(name) || !httpguts.ValidHeaderFieldValue(value) {
			return fmt.Errorf("%w: invalid artifact request header", errTaskArtifactPermanent)
		}
		switch http.CanonicalHeaderKey(name) {
		case "Host", "Content-Length", "Connection", "Transfer-Encoding", "Upgrade", "Proxy-Authorization":
			return fmt.Errorf("%w: artifact request header %s is reserved", errTaskArtifactPermanent, name)
		}
		destination.Set(name, value)
	}
	return nil
}

// validateTaskArtifactFetchTarget refuses provider URLs that point at the
// deployment's own network before any connection is opened: literal private and
// loopback addresses fail here, and a host name is rejected when any of its
// addresses is private. The dial-time protection of the fetch client repeats
// the check, so DNS rebinding between the two lookups is still caught.
func validateTaskArtifactFetchTarget(ctx context.Context, parsed *url.URL) error {
	if parsed == nil {
		return fmt.Errorf("%w: the provider URL is invalid", errTaskArtifactPermanent)
	}
	host := parsed.Hostname()
	if host == "" {
		return fmt.Errorf("%w: the provider URL has no host", errTaskArtifactPermanent)
	}
	if portText := parsed.Port(); portText != "" {
		parsedPort, err := strconv.Atoi(portText)
		if err != nil || parsedPort < 1 || parsedPort > 65535 {
			return fmt.Errorf("%w: the provider URL port is invalid", errTaskArtifactPermanent)
		}
	}
	protection := &common.SSRFProtection{
		AllowPrivateIp:         false,
		DomainFilterMode:       false,
		IpFilterMode:           false,
		ApplyIPFilterForDomain: true,
	}
	if ip := net.ParseIP(host); ip != nil {
		if err := protection.ValidateResolvedIP(host, ip); err != nil {
			return fmt.Errorf("%w: %v", errTaskArtifactPermanent, err)
		}
		return nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		// A resolution failure may be transient; the dial retries it.
		return nil
	}
	for _, addr := range addrs {
		if addr.IP == nil {
			continue
		}
		if err := protection.ValidateResolvedIP(host, addr.IP); err != nil {
			return fmt.Errorf("%w: %v", errTaskArtifactPermanent, err)
		}
	}
	return nil
}

// newTaskArtifactFetchClient builds the dedicated client of the store pass.
// Unlike the general protected client it ignores the global fetch setting, so
// private addresses are rejected even on deployments that allow them for
// operator-configured fetches.
func newTaskArtifactFetchClient() *http.Client {
	protection := &common.SSRFProtection{
		AllowPrivateIp:         false,
		DomainFilterMode:       false,
		IpFilterMode:           false,
		ApplyIPFilterForDomain: true,
	}
	client := newProtectedFetchHTTPClientWithDialer(nil, nil, func() (*common.SSRFProtection, bool, error) {
		return protection, true, nil
	})
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return fmt.Errorf("%w: too many redirects", errTaskArtifactPermanent)
		}
		if request == nil || request.URL == nil {
			return fmt.Errorf("%w: invalid redirect", errTaskArtifactPermanent)
		}
		if _, err := validateTaskArtifactFetchURL(request.URL.String()); err != nil {
			return err
		}
		return nil
	}
	return client
}

// spoolTaskArtifact streams the provider body into a temporary file while
// enforcing the size cap and hashing the bytes, so the upload can be retried
// and verified without keeping the result in memory.
func spoolTaskArtifact(reader io.Reader, mimeType string) (*fetchedTaskArtifact, error) {
	file, err := os.CreateTemp("", "playground-task-artifact-*")
	if err != nil {
		return nil, err
	}
	path := file.Name()
	digest := sha256.New()
	size, copyErr := copyTaskArtifactBody(file, reader, digest)
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(path)
		return nil, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(path)
		return nil, closeErr
	}
	if size == 0 {
		_ = os.Remove(path)
		return nil, fmt.Errorf("%w: the provider returned an empty result", errTaskArtifactPermanent)
	}
	return &fetchedTaskArtifact{
		path:     path,
		size:     size,
		hash:     hex.EncodeToString(digest.Sum(nil)),
		mimeType: mimeType,
	}, nil
}

func copyTaskArtifactBody(destination io.Writer, source io.Reader, digest hash.Hash) (int64, error) {
	limit := taskArtifactObjectMaxBytes + 1
	buffer := make([]byte, 32<<10)
	var written int64
	for {
		read, readErr := source.Read(buffer)
		if read > 0 {
			if written+int64(read) > limit {
				return written, fmt.Errorf("%w: provider result is above the %d byte limit", errTaskArtifactPermanent, taskArtifactObjectMaxBytes)
			}
			if _, writeErr := destination.Write(buffer[:read]); writeErr != nil {
				return written, writeErr
			}
			_, _ = digest.Write(buffer[:read])
			written += int64(read)
		}
		if readErr == io.EOF {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}

// decodeTaskArtifactDataURL decodes an inline base64 provider result. The
// declared media type and the decoded prefix both go through the same
// media-type contract as an HTTP fetch.
func decodeTaskArtifactDataURL(rawURL string, record model.PlaygroundTaskArtifact) (*fetchedTaskArtifact, error) {
	if len(rawURL) > taskArtifactDataURLMaxEncodedBytes {
		return nil, fmt.Errorf("%w: inline provider result is too large", errTaskArtifactPermanent)
	}
	header, payload, found := strings.Cut(rawURL, ",")
	if !found || !strings.HasPrefix(strings.ToLower(header), "data:") {
		return nil, fmt.Errorf("%w: inline provider result is malformed", errTaskArtifactPermanent)
	}
	if !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return nil, fmt.Errorf("%w: inline provider result must be base64 encoded", errTaskArtifactPermanent)
	}
	declared := strings.TrimSuffix(header[len("data:"):], ";base64")
	var decoded *bufio.Reader
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		probe := bufio.NewReader(base64.NewDecoder(encoding, strings.NewReader(payload)))
		if _, err := probe.Peek(1); err == nil || errors.Is(err, io.EOF) {
			decoded = probe
			break
		}
	}
	if decoded == nil {
		return nil, fmt.Errorf("%w: inline provider result is not valid base64", errTaskArtifactPermanent)
	}
	prefix, _ := decoded.Peek(taskArtifactSniffBytes)
	sniffed := http.DetectContentType(prefix)
	mimeType, err := resolveTaskArtifactMediaType(record.ArtifactType, record.MimeType, declared, sniffed)
	if err != nil {
		return nil, err
	}
	return spoolTaskArtifact(decoded, mimeType)
}

// taskArtifactMediaTypeClass returns the media class of one artifact type.
func taskArtifactMediaTypeClass(artifactType string) string {
	switch strings.TrimSpace(artifactType) {
	case "image":
		return "image"
	case "video":
		return "video"
	case "audio":
		return "audio"
	default:
		return "file"
	}
}

// resolveTaskArtifactMediaType validates the declared, response, and sniffed
// media types against the artifact type and returns the type the object is
// stored with. HTML, XML, SVG, and script media types are refused outright:
// a generated result is never served as active content.
func resolveTaskArtifactMediaType(artifactType, declared, response, sniffed string) (string, error) {
	resolved := ""
	for _, candidate := range []string{normalizeTaskArtifactMediaType(response), normalizeTaskArtifactMediaType(declared)} {
		if candidate == "" || isGenericTaskArtifactMediaType(candidate) {
			continue
		}
		if err := validateTaskArtifactMediaType(artifactType, candidate); err != nil {
			return "", err
		}
		if resolved == "" {
			resolved = candidate
		}
	}
	sniffed = normalizeTaskArtifactMediaType(sniffed)
	if !isGenericTaskArtifactMediaType(sniffed) {
		if err := validateTaskArtifactMediaType(artifactType, sniffed); err != nil {
			return "", err
		}
		if resolved == "" {
			resolved = sniffed
		}
	}
	if resolved == "" {
		resolved = "application/octet-stream"
	}
	return resolved, nil
}

func normalizeTaskArtifactMediaType(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parsed, _, err := mime.ParseMediaType(value)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed)
}

func isGenericTaskArtifactMediaType(value string) bool {
	switch value {
	case "", "application/octet-stream", "binary/octet-stream":
		return true
	default:
		return false
	}
}

var deniedTaskArtifactMediaTypes = map[string]bool{
	"text/html":              true,
	"application/xhtml+xml":  true,
	"image/svg+xml":          true,
	"application/xml":        true,
	"text/xml":               true,
	"application/javascript": true,
	"text/javascript":        true,
}

func validateTaskArtifactMediaType(artifactType, mediaType string) error {
	if deniedTaskArtifactMediaTypes[mediaType] {
		return fmt.Errorf("%w: media type %s is not allowed", errTaskArtifactPermanent, mediaType)
	}
	class := taskArtifactMediaTypeClass(artifactType)
	actual, _, _ := strings.Cut(mediaType, "/")
	switch class {
	case "image", "video", "audio":
		if actual != class {
			return fmt.Errorf("%w: media type %s does not match artifact type %s", errTaskArtifactPermanent, mediaType, class)
		}
	case "file":
		switch actual {
		case "image", "video", "audio", "application", "text":
		default:
			return fmt.Errorf("%w: media type %s is not an allowed file type", errTaskArtifactPermanent, mediaType)
		}
	}
	return nil
}

// taskArtifactUpstreamRef keeps a bounded copy of the provider reference for
// operators. Inline payloads are reduced to their media type so a base64 body
// never lands in the database.
func taskArtifactUpstreamRef(source *TaskArtifactSource) string {
	if source == nil {
		return ""
	}
	rawURL := strings.TrimSpace(source.URL)
	if strings.HasPrefix(strings.ToLower(rawURL), "data:") {
		if header, _, found := strings.Cut(rawURL, ","); found {
			return header
		}
		return "data:"
	}
	if len(rawURL) > 1024 {
		return rawURL[:1024]
	}
	return rawURL
}
