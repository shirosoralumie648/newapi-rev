package model

import (
	"errors"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// playgroundLogReplayRefMaxLength mirrors the request id column so a replay
// reference can never address an unindexed prefix of another value.
const playgroundLogReplayRefMaxLength = 64

// Why a replay carries no request content. The client renders one of these
// codes next to the restored parameters instead of pretending a prompt exists.
const (
	PlaygroundLogReplayContentCaptureDisabled = "capture_disabled"
	PlaygroundLogReplayContentNotCaptured     = "not_captured"
	PlaygroundLogReplayContentExpired         = "expired"
)

// PlaygroundLogCapture stores the desensitized summary of one Playground chat
// request behind the optional PLAYGROUND_LOG_CAPTURE switch. The row is keyed
// by (owner, request id): the request id exists on every supported log
// database, including ClickHouse, whose log rows carry no usable numeric id.
// Summaries are bounded and leave with their retention window.
type PlaygroundLogCapture struct {
	Id        int    `json:"id" gorm:"primaryKey;autoIncrement"`
	UserId    int    `json:"user_id" gorm:"not null;uniqueIndex:idx_playground_log_capture_owner_request,priority:1"`
	RequestId string `json:"request_id" gorm:"type:varchar(64);not null;default:'';uniqueIndex:idx_playground_log_capture_owner_request,priority:2"`
	ModelName string `json:"model_name" gorm:"type:varchar(255);not null;default:''"`
	Group     string `json:"group" gorm:"type:varchar(64);not null;default:''"`
	IsStream  bool   `json:"is_stream" gorm:"not null"`
	// StatusCode is the HTTP status the client received, so a replay of a
	// failed call says so even when the body was discarded.
	StatusCode int `json:"status_code" gorm:"not null;default:0"`
	// RequestSummary and ResponseSummary hold the desensitized JSON documents
	// the service built; SummaryBytes is their combined size.
	RequestSummary  string `json:"request_summary" gorm:"type:text"`
	ResponseSummary string `json:"response_summary" gorm:"type:text"`
	SummaryBytes    int    `json:"summary_bytes" gorm:"not null;default:0"`
	Truncated       bool   `json:"truncated" gorm:"not null"`
	CreatedAt       int64  `json:"created_at" gorm:"not null;default:0"`
	ExpiresAt       int64  `json:"expires_at" gorm:"not null;default:0;index"`
}

// SavePlaygroundLogCapture upserts the summary of one Playground chat request
// under its owner and request id. A repeated request id converges on the same
// row instead of accumulating duplicates.
func SavePlaygroundLogCapture(capture *PlaygroundLogCapture) error {
	if capture == nil || capture.UserId <= 0 || capture.RequestId == "" {
		return errors.New("invalid playground log capture")
	}
	return DB.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}, {Name: "request_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"model_name", "group", "is_stream", "status_code",
			"request_summary", "response_summary", "summary_bytes",
			"truncated", "created_at", "expires_at",
		}),
	}).Create(capture).Error
}

// GetPlaygroundLogCapture reads the stored summary of one request of the given
// owner. An unknown or other user's request id simply has no row.
func GetPlaygroundLogCapture(userId int, requestId string) (*PlaygroundLogCapture, error) {
	if userId <= 0 || requestId == "" {
		return nil, nil
	}
	capture := &PlaygroundLogCapture{}
	err := DB.Where("user_id = ? AND request_id = ?", userId, requestId).First(capture).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return capture, nil
}

// DeletePlaygroundLogCapture removes one request's stored summary. The owner
// scoping is part of the query, so a foreign request id deletes nothing.
func DeletePlaygroundLogCapture(userId int, requestId string) (int64, error) {
	if userId <= 0 || requestId == "" {
		return 0, nil
	}
	result := DB.Where("user_id = ? AND request_id = ?", userId, requestId).Delete(&PlaygroundLogCapture{})
	return result.RowsAffected, result.Error
}

// DeleteExpiredPlaygroundLogCaptures deletes up to limit summaries whose
// retention window elapsed. Rows are selected first because SQLite has no
// DELETE ... LIMIT, and the selection keeps every dialect on the same path.
func DeleteExpiredPlaygroundLogCaptures(now int64, limit int) (int64, error) {
	if limit <= 0 {
		limit = 100
	}
	ids := make([]int, 0, limit)
	if err := DB.Model(&PlaygroundLogCapture{}).
		Where("expires_at <= ?", now).
		Order("id").
		Limit(limit).
		Pluck("id", &ids).Error; err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}
	result := DB.Where("id IN ?", ids).Delete(&PlaygroundLogCapture{})
	return result.RowsAffected, result.Error
}

// GetPlaygroundReplayLog resolves the log a replay deep link points at for one
// owner. A numeric reference is the log table's id; on the ClickHouse log
// database rows have no meaningful id, so numeric references are skipped and
// only the request id can address them. Any other reference is a request id.
func GetPlaygroundReplayLog(userId int, logRef string) (*Log, error) {
	logRef = strings.TrimSpace(logRef)
	if userId <= 0 || logRef == "" || len(logRef) > playgroundLogReplayRefMaxLength {
		return nil, nil
	}
	tx := LOG_DB.Model(&Log{}).Where("user_id = ?", userId)
	if isNumericLogRef(logRef) {
		if common.UsingLogDatabase(common.DatabaseTypeClickHouse) {
			return nil, nil
		}
		id, err := strconv.Atoi(logRef)
		if err != nil || id <= 0 {
			return nil, nil
		}
		tx = tx.Where("id = ?", id)
	} else {
		tx = tx.Where("request_id = ?", logRef)
	}
	logs := make([]Log, 0, 1)
	if err := tx.Order("created_at desc, id desc").Limit(1).Find(&logs).Error; err != nil {
		return nil, err
	}
	if len(logs) == 0 {
		return nil, nil
	}
	return &logs[0], nil
}

func isNumericLogRef(logRef string) bool {
	for i := range len(logRef) {
		if logRef[i] < '0' || logRef[i] > '9' {
			return false
		}
	}
	return true
}

// PlaygroundLogReplaySampling carries only the parameters a log or its stored
// summary revealed; an absent field was never recorded and stays at the
// client's default.
type PlaygroundLogReplaySampling struct {
	Temperature      *float64 `json:"temperature,omitempty"`
	TopP             *float64 `json:"top_p,omitempty"`
	MaxTokens        *int     `json:"max_tokens,omitempty"`
	FrequencyPenalty *float64 `json:"frequency_penalty,omitempty"`
	PresencePenalty  *float64 `json:"presence_penalty,omitempty"`
	Seed             *int     `json:"seed,omitempty"`
	ReasoningEffort  string   `json:"reasoning_effort,omitempty"`
}

// PlaygroundLogReplayCapture is the retained summary of a request and its
// response. Request and Response stay generic documents: the stored schema is
// owned by the capture writer, and the client renders what it recognizes.
type PlaygroundLogReplayCapture struct {
	ExpiresAt int64          `json:"expires_at"`
	Truncated bool           `json:"truncated"`
	Request   map[string]any `json:"request,omitempty"`
	Response  map[string]any `json:"response,omitempty"`
}

// PlaygroundLogReplay is the read-only projection a replay deep link loads. It
// never contains credentials: only the log metadata every owner already
// receives plus, while the optional capture is on and unexpired, the
// desensitized summaries.
type PlaygroundLogReplay struct {
	RequestId                string                       `json:"request_id"`
	LogId                    int                          `json:"log_id"`
	UserId                   int                          `json:"user_id"`
	CreatedAt                int64                        `json:"created_at"`
	Type                     int                          `json:"type"`
	ModelName                string                       `json:"model"`
	Group                    string                       `json:"group"`
	IsStream                 bool                         `json:"stream"`
	Path                     string                       `json:"path"`
	PromptTokens             int                          `json:"prompt_tokens"`
	CompletionTokens         int                          `json:"completion_tokens"`
	Quota                    int                          `json:"quota"`
	ParamOverrides           []string                     `json:"param_overrides,omitempty"`
	CaptureEnabled           bool                         `json:"capture_enabled"`
	ContentAvailable         bool                         `json:"content_available"`
	ContentUnavailableReason string                       `json:"content_unavailable_reason,omitempty"`
	Sampling                 *PlaygroundLogReplaySampling `json:"sampling,omitempty"`
	Capture                  *PlaygroundLogReplayCapture  `json:"capture,omitempty"`
}

// BuildPlaygroundLogReplay projects a resolved log row and its optional stored
// summary. captureEnabled reports the administrator switch so the client can
// distinguish "never captured" from "capture is off on this deployment", and
// now bounds the retention window.
func BuildPlaygroundLogReplay(log *Log, capture *PlaygroundLogCapture, captureEnabled bool, now int64) *PlaygroundLogReplay {
	if log == nil {
		return nil
	}
	replay := &PlaygroundLogReplay{
		RequestId:        log.RequestId,
		LogId:            log.Id,
		UserId:           log.UserId,
		CreatedAt:        log.CreatedAt,
		Type:             log.Type,
		ModelName:        log.ModelName,
		Group:            log.Group,
		IsStream:         log.IsStream,
		PromptTokens:     log.PromptTokens,
		CompletionTokens: log.CompletionTokens,
		Quota:            log.Quota,
		CaptureEnabled:   captureEnabled,
	}
	// The public other document carries metadata the owner already receives;
	// only the replay-relevant keys are projected.
	var public struct {
		ReasoningEffort string   `json:"reasoning_effort"`
		ParamOverrides  []string `json:"po"`
		RequestPath     string   `json:"request_path"`
	}
	if log.Other != "" {
		_ = common.UnmarshalJsonStr(log.Other, &public)
	}
	replay.Path = public.RequestPath
	replay.ParamOverrides = public.ParamOverrides

	reasoningEffort := public.ReasoningEffort
	contentFromCapture := false
	switch {
	case !captureEnabled:
		replay.ContentUnavailableReason = PlaygroundLogReplayContentCaptureDisabled
	case capture == nil:
		replay.ContentUnavailableReason = PlaygroundLogReplayContentNotCaptured
	case capture.ExpiresAt <= now:
		replay.ContentUnavailableReason = PlaygroundLogReplayContentExpired
	default:
		contentFromCapture = true
		replay.ContentAvailable = true
		replay.Capture = &PlaygroundLogReplayCapture{ExpiresAt: capture.ExpiresAt, Truncated: capture.Truncated}
		var stored struct {
			Group    string                       `json:"group"`
			Sampling *PlaygroundLogReplaySampling `json:"sampling"`
		}
		if capture.RequestSummary != "" {
			var document map[string]any
			if err := common.UnmarshalJsonStr(capture.RequestSummary, &document); err == nil {
				replay.Capture.Request = document
			}
			if err := common.UnmarshalJsonStr(capture.RequestSummary, &stored); err == nil {
				replay.Sampling = stored.Sampling
				if replay.Group == "" {
					replay.Group = stored.Group
				}
			}
		}
		if capture.ResponseSummary != "" {
			var document map[string]any
			if err := common.UnmarshalJsonStr(capture.ResponseSummary, &document); err == nil {
				replay.Capture.Response = document
			}
		}
	}
	if replay.Sampling == nil && !contentFromCapture && reasoningEffort != "" {
		// The reasoning effort was recorded as public metadata long before the
		// optional capture existed, so it replays without any stored content.
		replay.Sampling = &PlaygroundLogReplaySampling{ReasoningEffort: reasoningEffort}
	}
	if replay.Sampling != nil && replay.Sampling.ReasoningEffort == "" {
		replay.Sampling.ReasoningEffort = reasoningEffort
	}
	return replay
}
