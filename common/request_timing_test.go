package common

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestTimingSession builds a session whose clock the test advances by hand,
// so the phase arithmetic is asserted deterministically instead of by sleeping.
func newTestTimingSession(base time.Time) (*RequestTimingSession, func(time.Duration)) {
	now := base
	session := &RequestTimingSession{arrival: base, clock: func() time.Time { return now }}
	return session, func(step time.Duration) { now = now.Add(step) }
}

func TestRequestTimingSessionSnapshotRecordsObservedPhases(t *testing.T) {
	session, advance := newTestTimingSession(time.Unix(0, 0))
	advance(24 * time.Millisecond)
	session.Mark(RequestTimingPhaseAuthenticated)
	advance(8 * time.Millisecond)
	session.Mark(RequestTimingPhaseChannelSelected)
	advance(411 * time.Millisecond)
	session.Mark(RequestTimingPhaseUpstreamFirstByte)
	advance(2 * time.Millisecond)
	session.Mark(RequestTimingPhaseFirstToken)
	advance(875 * time.Millisecond)

	payload := session.Snapshot(1)

	require.NotNil(t, payload)
	require.NotNil(t, payload.TotalMs)
	assert.EqualValues(t, 1320, *payload.TotalMs)
	require.NotNil(t, payload.AuthMs)
	assert.EqualValues(t, 24, *payload.AuthMs)
	require.NotNil(t, payload.ChannelSelectMs)
	assert.EqualValues(t, 8, *payload.ChannelSelectMs)
	require.NotNil(t, payload.UpstreamMs)
	assert.EqualValues(t, 411, *payload.UpstreamMs)
	require.NotNil(t, payload.FirstTokenMs)
	assert.EqualValues(t, 445, *payload.FirstTokenMs)
	require.NotNil(t, payload.Retries)
	assert.Equal(t, 1, *payload.Retries)
}

func TestRequestTimingSessionSnapshotOmitsUnreachedPhases(t *testing.T) {
	session, advance := newTestTimingSession(time.Unix(0, 0))
	advance(5 * time.Millisecond)
	session.Mark(RequestTimingPhaseAuthenticated)
	advance(5 * time.Millisecond)

	payload := session.Snapshot(0)

	require.NotNil(t, payload)
	require.NotNil(t, payload.TotalMs)
	assert.EqualValues(t, 10, *payload.TotalMs)
	require.NotNil(t, payload.AuthMs)
	assert.EqualValues(t, 5, *payload.AuthMs)
	assert.Nil(t, payload.ChannelSelectMs)
	assert.Nil(t, payload.UpstreamMs)
	assert.Nil(t, payload.FirstTokenMs)
	require.NotNil(t, payload.Retries)
	assert.Equal(t, 0, *payload.Retries)

	encoded, err := Marshal(payload)
	require.NoError(t, err)
	// A legitimate zero (no retry) stays in the payload; unreached phases are
	// omitted instead of being reported as zero.
	assert.Contains(t, string(encoded), `"retries":0`)
	assert.NotContains(t, string(encoded), "channel_select_ms")
	assert.NotContains(t, string(encoded), "upstream_ms")
	assert.NotContains(t, string(encoded), "first_token_ms")
}

func TestRequestTimingSessionMarkKeepsTheFirstMilestone(t *testing.T) {
	session, advance := newTestTimingSession(time.Unix(0, 0))
	advance(10 * time.Millisecond)
	session.Mark(RequestTimingPhaseUpstreamFirstByte)
	first := session.Snapshot(0)
	advance(90 * time.Millisecond)
	// A channel retry answers later; it must not move the recorded milestone.
	session.Mark(RequestTimingPhaseUpstreamFirstByte)
	second := session.Snapshot(0)

	require.NotNil(t, first)
	require.NotNil(t, second)
	require.NotNil(t, first.UpstreamMs)
	require.NotNil(t, second.UpstreamMs)
	assert.EqualValues(t, 10, *first.UpstreamMs)
	assert.EqualValues(t, 10, *second.UpstreamMs)
	require.NotNil(t, second.TotalMs)
	assert.EqualValues(t, 100, *second.TotalMs)
}

func TestRequestTimingSessionNilSafety(t *testing.T) {
	var session *RequestTimingSession
	assert.Nil(t, session.Snapshot(0))
	assert.NotPanics(t, func() { session.Mark(RequestTimingPhaseFirstToken) })
}

func TestRequestTimingContextHelpers(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)

	assert.Nil(t, GetRequestTimingSession(ctx))
	assert.Nil(t, GetRequestTimingSession(nil))
	// Marking a request without a session is a no-op, not a panic.
	assert.NotPanics(t, func() { MarkRequestTiming(ctx, RequestTimingPhaseFirstToken) })
	SetRequestTimingSession(ctx, nil)
	assert.Nil(t, GetRequestTimingSession(ctx))

	session := NewRequestTimingSession()
	SetRequestTimingSession(ctx, session)
	assert.Same(t, session, GetRequestTimingSession(ctx))
	MarkRequestTiming(ctx, RequestTimingPhaseChannelSelected)

	payload := session.Snapshot(0)
	require.NotNil(t, payload)
	require.NotNil(t, payload.ChannelSelectMs)
	assert.Nil(t, payload.AuthMs)
}

func TestParseRequestTimingPayload(t *testing.T) {
	payload := ParseRequestTimingPayload(`{"request_timing":{"total_ms":1320,"auth_ms":24,"channel_select_ms":8,"upstream_ms":411,"first_token_ms":445,"retries":1},"admin_info":{"use_channel":[1]}}`)

	require.NotNil(t, payload)
	require.NotNil(t, payload.TotalMs)
	assert.EqualValues(t, 1320, *payload.TotalMs)
	require.NotNil(t, payload.UpstreamMs)
	assert.EqualValues(t, 411, *payload.UpstreamMs)
	require.NotNil(t, payload.FirstTokenMs)
	assert.EqualValues(t, 445, *payload.FirstTokenMs)
	require.NotNil(t, payload.Retries)
	assert.Equal(t, 1, *payload.Retries)
	// Only the timing object is projected: the rest of the stored log metadata
	// (admin_info and friends) must never ride along.
	encoded, err := Marshal(payload)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "admin_info")
	assert.Contains(t, string(encoded), `"total_ms":1320`)

	for _, test := range []struct {
		name  string
		other string
	}{
		{name: "empty", other: ""},
		{name: "malformed", other: "not-json"},
		{name: "missing key", other: `{"request_path":"/v1/chat/completions"}`},
		{name: "explicit null", other: `{"request_timing":null}`},
		{name: "empty object", other: `{"request_timing":{}}`},
		{name: "wrong type", other: `{"request_timing":42}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			assert.Nil(t, ParseRequestTimingPayload(test.other))
		})
	}

	zero := ParseRequestTimingPayload(`{"request_timing":{"total_ms":0,"retries":0}}`)
	require.NotNil(t, zero)
	require.NotNil(t, zero.TotalMs)
	assert.EqualValues(t, 0, *zero.TotalMs)
	require.NotNil(t, zero.Retries)
	assert.Equal(t, 0, *zero.Retries)
}
