package common

import (
	"sync"
	"time"

	"github.com/QuantumNous/new-api/constant"

	"github.com/gin-gonic/gin"
)

// RequestTimingPhase is one observable milestone in the lifecycle of a relay
// request. Each milestone is recorded by the layer that owns it, so the log
// shows where the request actually spent its time.
type RequestTimingPhase int

const (
	// RequestTimingPhaseAuthenticated marks the end of authentication and the
	// pre-channel admission that follows it (token/model checks, admission
	// rate limiting, plugin endpoint pinning).
	RequestTimingPhaseAuthenticated RequestTimingPhase = iota
	// RequestTimingPhaseChannelSelected marks the point where the channel the
	// request will be tried on has been chosen.
	RequestTimingPhaseChannelSelected
	// RequestTimingPhaseUpstreamFirstByte marks the first response byte of the
	// earliest upstream attempt that answered.
	RequestTimingPhaseUpstreamFirstByte
	// RequestTimingPhaseFirstToken marks the first streamed data chunk parsed
	// from the upstream response, or the completed non-stream response the
	// handler wrote.
	RequestTimingPhaseFirstToken
)

// RequestTimingSession collects the phase timestamps of one relay request so
// its log row can expose the breakdown. Milestones are recorded once: a
// channel retry never rewrites the first upstream answer, and a response
// written after the first streamed chunk never moves the first-token
// milestone.
type RequestTimingSession struct {
	mu                sync.Mutex
	arrival           time.Time
	authenticated     time.Time
	channelSelected   time.Time
	upstreamFirstByte time.Time
	firstToken        time.Time
	// clock is time.Now in production. Tests set it to assert the phase
	// arithmetic deterministically, without sleeping.
	clock func() time.Time
}

// NewRequestTimingSession starts a session at the moment the request reached
// the gateway, which is the baseline of every reported phase.
func NewRequestTimingSession() *RequestTimingSession {
	return &RequestTimingSession{arrival: time.Now()}
}

func (s *RequestTimingSession) currentTime() time.Time {
	if s.clock != nil {
		return s.clock()
	}
	return time.Now()
}

// Mark records phase at its first occurrence.
func (s *RequestTimingSession) Mark(phase RequestTimingPhase) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.currentTime()
	switch phase {
	case RequestTimingPhaseAuthenticated:
		if s.authenticated.IsZero() {
			s.authenticated = now
		}
	case RequestTimingPhaseChannelSelected:
		if s.channelSelected.IsZero() {
			s.channelSelected = now
		}
	case RequestTimingPhaseUpstreamFirstByte:
		if s.upstreamFirstByte.IsZero() {
			s.upstreamFirstByte = now
		}
	case RequestTimingPhaseFirstToken:
		if s.firstToken.IsZero() {
			s.firstToken = now
		}
	}
}

// RequestTimingPayload is the log and API shape of a request's phase
// breakdown. Phases the gateway never reached stay nil and are omitted; a
// legitimate zero-millisecond phase is kept, because it happened.
type RequestTimingPayload struct {
	// TotalMs is the elapsed time from request arrival to the moment the log
	// row is written.
	TotalMs *int64 `json:"total_ms,omitempty"`
	// AuthMs is authentication plus the pre-channel admission behind it.
	AuthMs *int64 `json:"auth_ms,omitempty"`
	// ChannelSelectMs is channel selection after admission.
	ChannelSelectMs *int64 `json:"channel_select_ms,omitempty"`
	// UpstreamMs is the wait for the first upstream response byte after the
	// channel was selected.
	UpstreamMs *int64 `json:"upstream_ms,omitempty"`
	// FirstTokenMs is the end-to-end wait for the first streamed data chunk, or
	// for the completed non-stream response.
	FirstTokenMs *int64 `json:"first_token_ms,omitempty"`
	// Retries is the number of channel retries the request used. Zero means
	// the first channel answered.
	Retries *int `json:"retries,omitempty"`
}

// Snapshot renders the phases observed so far. retries is the request's retry
// index and is always recorded, because zero (no retry) is a real answer.
func (s *RequestTimingSession) Snapshot(retries int) *RequestTimingPayload {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	arrival := s.arrival
	authenticated := s.authenticated
	channelSelected := s.channelSelected
	upstreamFirstByte := s.upstreamFirstByte
	firstToken := s.firstToken
	s.mu.Unlock()

	payload := &RequestTimingPayload{
		TotalMs:         timingMillisBetween(arrival, s.currentTime()),
		AuthMs:          timingMillisBetween(arrival, authenticated),
		ChannelSelectMs: timingMillisBetween(authenticated, channelSelected),
		UpstreamMs:      timingMillisBetween(channelSelected, upstreamFirstByte),
		FirstTokenMs:    timingMillisBetween(arrival, firstToken),
		Retries:         &retries,
	}
	if payload.TotalMs == nil {
		return nil
	}
	return payload
}

// timingMillisBetween returns the elapsed milliseconds from start to end, or
// nil when either milestone was never reached (or the clock went backwards).
func timingMillisBetween(start, end time.Time) *int64 {
	if start.IsZero() || end.IsZero() || end.Before(start) {
		return nil
	}
	elapsed := end.Sub(start).Milliseconds()
	return &elapsed
}

// SetRequestTimingSession attaches the session to the request context.
func SetRequestTimingSession(c *gin.Context, session *RequestTimingSession) {
	if c == nil || session == nil {
		return
	}
	SetContextKey(c, constant.ContextKeyRequestTiming, session)
}

// GetRequestTimingSession returns the session started for this request, or nil
// when the route does not record a breakdown.
func GetRequestTimingSession(c *gin.Context) *RequestTimingSession {
	if c == nil {
		return nil
	}
	session, ok := GetContextKeyType[*RequestTimingSession](c, constant.ContextKeyRequestTiming)
	if !ok {
		return nil
	}
	return session
}

// MarkRequestTiming records one phase on the request's session. It is a no-op
// for requests that never started one.
func MarkRequestTiming(c *gin.Context, phase RequestTimingPhase) {
	if session := GetRequestTimingSession(c); session != nil {
		session.Mark(phase)
	}
}

// ParseRequestTimingPayload extracts request_timing from a stored log `other`
// document. It reads only that key, so a caller can hand the result to the
// request's owner without exposing the rest of the log metadata (admin_info
// and friends). Absent, empty or malformed values yield nil.
func ParseRequestTimingPayload(other string) *RequestTimingPayload {
	if other == "" {
		return nil
	}
	var stored struct {
		RequestTiming *RequestTimingPayload `json:"request_timing"`
	}
	if err := UnmarshalJsonStr(other, &stored); err != nil {
		return nil
	}
	payload := stored.RequestTiming
	if payload == nil {
		return nil
	}
	if payload.TotalMs == nil && payload.AuthMs == nil && payload.ChannelSelectMs == nil &&
		payload.UpstreamMs == nil && payload.FirstTokenMs == nil && payload.Retries == nil {
		return nil
	}
	return payload
}
