package service

import (
	"net/http"
	"slices"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/common/admission"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
)

// Admission scopes name the two admission subjects of a relay dispatch.
const (
	AdmissionScopeChannel = "channel"
	AdmissionScopeToken   = "token"
)

// AttemptAdmission is the outcome of reserving capacity for one relay attempt.
type AttemptAdmission struct {
	Admitted bool
	// Scope and Reason name the exhausted limit when Admitted is false.
	Scope  string
	Reason admission.RejectReason
}

// ChannelAdmissionLimits returns the admission limits configured on the
// channel; a channel without settings has no limits.
func ChannelAdmissionLimits(channel *model.Channel) admission.Limits {
	if channel == nil {
		return admission.Limits{}
	}
	setting := channel.GetSetting()
	return admission.Limits{
		MaxConcurrency: setting.MaxConcurrency,
		RPMLimit:       setting.RPMLimit,
		TPMLimit:       setting.TPMLimit,
	}
}

// TokenAdmissionLimits returns the admission limits of the token that
// authenticated the request; they were copied into the request context during
// token authentication. A request without a token has no token limits.
func TokenAdmissionLimits(c *gin.Context) admission.Limits {
	if c == nil {
		return admission.Limits{}
	}
	return admission.Limits{
		RPMLimit: common.GetContextKeyInt(c, constant.ContextKeyTokenRPMLimit),
		TPMLimit: common.GetContextKeyInt(c, constant.ContextKeyTokenTPMLimit),
	}
}

// AdmitChannelAttempt reserves channel and token capacity for one upstream
// dispatch. The leases are stored on the request: settlement corrects the token
// reservation and the end of the attempt releases the concurrency slot. The
// previous attempt's leases are retired first, because a request that retries
// no longer occupies the retired attempt's slot.
func AdmitChannelAttempt(c *gin.Context, channel *model.Channel, estimatedTokens int) AttemptAdmission {
	admission.ReleaseLeases(c)
	lease, reason := admission.Acquire(
		admission.SubjectKey(AdmissionScopeChannel, channel.Id),
		ChannelAdmissionLimits(channel),
		estimatedTokens,
	)
	if reason != "" {
		return AttemptAdmission{Scope: AdmissionScopeChannel, Reason: reason}
	}
	admission.StoreLease(c, admission.ChannelLeaseContextKey, lease)

	tokenID := common.GetContextKeyInt(c, constant.ContextKeyTokenId)
	if tokenID == 0 {
		return AttemptAdmission{Admitted: true}
	}
	limits := TokenAdmissionLimits(c)
	if limits.RPMLimit <= 0 && limits.TPMLimit <= 0 {
		return AttemptAdmission{Admitted: true}
	}
	tokenLease, tokenReason := admission.Acquire(admission.SubjectKey(AdmissionScopeToken, tokenID), limits, estimatedTokens)
	if tokenReason != "" {
		// The dispatch is refused, so the channel slot reserved for it is
		// returned immediately.
		admission.RetireLease(c, admission.ChannelLeaseContextKey)
		return AttemptAdmission{Scope: AdmissionScopeToken, Reason: tokenReason}
	}
	admission.StoreLease(c, admission.TokenLeaseContextKey, tokenLease)
	return AttemptAdmission{Admitted: true}
}

// ReleaseAdmissionAttempt releases the attempt leases of the request: the
// concurrency slot is freed and a token reservation that settlement never used
// is returned. It is safe to call when no admission was tracked.
func ReleaseAdmissionAttempt(c *gin.Context) {
	admission.ReleaseLeases(c)
}

// ExcludeSaturatedChannel keeps a channel out of the remaining selections of
// the request after its admission was rejected.
func ExcludeSaturatedChannel(c *gin.Context, channelID int) {
	if c == nil || channelID == 0 {
		return
	}
	constraints := GetChannelConstraints(c)
	for i := range constraints.Filters {
		filter := &constraints.Filters[i]
		if filter.Kind != dto.FilterExcludeChannels {
			continue
		}
		if !slices.Contains(filter.ExcludedChannelIDs, channelID) {
			filter.ExcludedChannelIDs = append(filter.ExcludedChannelIDs, channelID)
		}
		return
	}
	constraints.AddFilter(dto.ChannelFilter{Kind: dto.FilterExcludeChannels, ExcludedChannelIDs: []int{channelID}})
}

// HasExcludedChannels reports whether the request already skipped a channel
// because of its capacity, so an empty selection can be attributed to capacity
// rather than to a missing channel.
func HasExcludedChannels(c *gin.Context) bool {
	if c == nil {
		return false
	}
	return slices.ContainsFunc(GetChannelConstraints(c).Filters, func(filter dto.ChannelFilter) bool {
		return filter.Kind == dto.FilterExcludeChannels && len(filter.ExcludedChannelIDs) > 0
	})
}

// ChannelCapacityExhaustedError reports that every candidate channel of the
// request refused admission. The code is stable so clients can back off.
func ChannelCapacityExhaustedError(c *gin.Context, modelName string) *ChannelSelectError {
	return &ChannelSelectError{
		StatusCode: http.StatusTooManyRequests,
		Code:       types.ErrorCodeChannelCapacityExhausted,
		MessageID:  i18n.MsgRelayChannelCapacityExhausted,
		Params:     map[string]any{"Group": common.GetContextKeyString(c, constant.ContextKeyUsingGroup), "Model": modelName},
	}
}

// TokenRateLimitExceededError reports that the token's own admission limits
// refused the dispatch.
func TokenRateLimitExceededError() *ChannelSelectError {
	return &ChannelSelectError{
		StatusCode: http.StatusTooManyRequests,
		Code:       types.ErrorCodeTokenRateLimitExceeded,
		MessageID:  i18n.MsgRelayTokenRateLimitExceeded,
	}
}
