/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
package model

import (
	"strings"

	"github.com/QuantumNous/new-api/setting/operation_setting"

	"gorm.io/gorm"
)

// ReferralInvitationQuery filters one invitation statistics query. InviterId
// restricts the rows to one inviter (0 lists every inviter, the administrator
// view); Keyword matches the invitee's username, display name or email
// literally; Source restricts the recorded binding channel and Status the
// status of the invitation's commission events, the empty string meaning
// "any". The query is read-only: it never moves a balance.
type ReferralInvitationQuery struct {
	InviterId int
	Keyword   string
	Source    string
	Status    string
}

// ReferralInvitation is one recorded invitation with the aggregates of its
// commission events. The identifier fields stay raw in the model; the
// user-facing API masks them before responding. Pending, locked and settled
// are the states of the payable pipeline; review, blocked and rejected are
// the states that still wait for a decision or never pay out, so only the
// administrator API exposes them. CommissionEndsAt is the last second of the
// commission trigger window (0 when the configured window does not expire, or
// rewards only the first paid order).
type ReferralInvitation struct {
	InviteeId        int
	Username         string
	Email            string
	DisplayName      string
	InviterId        int
	InviterUsername  string
	Source           string
	BoundAt          int64
	RegisteredAt     int64
	CommissionEndsAt int64
	PendingQuota     int64
	LockedQuota      int64
	SettledQuota     int64
	ReviewQuota      int64
	BlockedQuota     int64
	RejectedQuota    int64
	TotalPaidQuota   int64
	CommissionCount  int64
}

// ReferralStatsSummary aggregates invitations and their commission events
// under the same filters as the listed page, so a filtered summary always
// describes the listed invitations. Amounts are quota; TotalCommissionQuota
// sums every recorded event, while the per-status buckets split it by every
// known commission state, refused events (blocked, rejected) included.
type ReferralStatsSummary struct {
	TotalInvitees          int64 `json:"total_invitees"`
	InviteesWithCommission int64 `json:"invitees_with_commission"`
	TotalPaidQuota         int64 `json:"total_paid_quota"`
	TotalCommissionQuota   int64 `json:"total_commission_quota"`
	PendingQuota           int64 `json:"pending_quota"`
	LockedQuota            int64 `json:"locked_quota"`
	SettledQuota           int64 `json:"settled_quota"`
	ReviewQuota            int64 `json:"review_quota"`
	BlockedQuota           int64 `json:"blocked_quota"`
	RejectedQuota          int64 `json:"rejected_quota"`
}

// IsReferralSource reports whether source is a recorded invitation channel;
// the empty string means "any source".
func IsReferralSource(source string) bool {
	return source == "" || isReferralSource(source)
}

// IsReferralCommissionStatus reports whether status is a commission state the
// statistics can bucket; the empty string means "any status".
func IsReferralCommissionStatus(status string) bool {
	switch status {
	case "",
		ReferralCommissionStatusPending,
		ReferralCommissionStatusReview,
		ReferralCommissionStatusBlocked,
		ReferralCommissionStatusRejected,
		ReferralCommissionStatusLocked,
		ReferralCommissionStatusSettled:
		return true
	default:
		return false
	}
}

// MaskReferralIdentifier hides the invitee's account identifier while keeping
// it recognizable: the local part of an email and all but the first characters
// of a username are replaced with "***". The user-facing invitation list must
// never expose the raw email or username.
func MaskReferralIdentifier(username, email string) string {
	if at := strings.LastIndex(email, "@"); at > 0 {
		local := []rune(email[:at])
		return string(local[:1]) + "***" + email[at:]
	}
	if username == "" {
		return ""
	}
	runes := []rune(username)
	return string(runes[:min(2, len(runes))]) + "***"
}

// CountReferralInvitations returns how many invitations match the query.
func CountReferralInvitations(query ReferralInvitationQuery) (int64, error) {
	var total int64
	err := referralInvitationScope(query).Count(&total).Error
	return total, err
}

// ListReferralInvitations returns one page of invitations ordered by binding
// time (newest first) with the aggregates of their commission events. The
// window end is derived from the current configuration and the invitee's
// registration time.
func ListReferralInvitations(query ReferralInvitationQuery, offset, limit int) ([]ReferralInvitation, error) {
	invitations := make([]ReferralInvitation, 0)
	err := referralInvitationScope(query).
		Select("b.invitee_id, u.username, u.email, u.display_name, b.inviter_id, i.username AS inviter_username, b.source, b.bound_at, u.created_at AS registered_at").
		Order("b.bound_at DESC, b.id DESC").
		Offset(offset).
		Limit(limit).
		Scan(&invitations).Error
	if err != nil {
		return nil, err
	}
	if len(invitations) == 0 {
		return invitations, nil
	}
	if err := attachReferralCommissionAggregates(query.InviterId, invitations); err != nil {
		return nil, err
	}
	if windowMonths := operation_setting.GetReferralSetting().WindowMonths; windowMonths > 0 {
		for i := range invitations {
			invitations[i].CommissionEndsAt = referralCommissionWindowEnd(invitations[i].RegisteredAt, windowMonths)
		}
	}
	return invitations, nil
}

// SummarizeReferralInvitations aggregates the invitations matching the query
// and their commission events: how many invitees there are, how many of them
// produced an event, and the quota sums per state. It never moves a balance.
func SummarizeReferralInvitations(query ReferralInvitationQuery) (*ReferralStatsSummary, error) {
	summary := &ReferralStatsSummary{}
	err := referralInvitationScope(query).
		Joins("LEFT JOIN referral_commissions AS rc ON rc.invitee_id = b.invitee_id AND rc.inviter_id = b.inviter_id").
		Select(`COUNT(DISTINCT b.invitee_id) AS total_invitees,
			COUNT(DISTINCT CASE WHEN rc.id IS NOT NULL THEN b.invitee_id END) AS invitees_with_commission,
			COALESCE(SUM(rc.base_quota), 0) AS total_paid_quota,
			COALESCE(SUM(rc.commission_quota), 0) AS total_commission_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS pending_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS locked_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS settled_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS review_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS blocked_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS rejected_quota`,
			ReferralCommissionStatusPending,
			ReferralCommissionStatusLocked,
			ReferralCommissionStatusSettled,
			ReferralCommissionStatusReview,
			ReferralCommissionStatusBlocked,
			ReferralCommissionStatusRejected).
		Scan(summary).Error
	if err != nil {
		return nil, err
	}
	return summary, nil
}

// referralInvitationScope builds the invitation filter shared by the count,
// list and summary queries.
func referralInvitationScope(query ReferralInvitationQuery) *gorm.DB {
	// The account table derives its name from the model, so the raw join must
	// resolve it the same way every model query does and follow the active
	// naming strategy (the test databases run with a table prefix). The two
	// referral tables pin their names with TableName and stay verbatim.
	usersTable := "users"
	statement := &gorm.Statement{DB: DB}
	if err := statement.Parse(&User{}); err == nil {
		usersTable = statement.Table
	}
	scope := DB.Table("referral_bindings AS b").
		Joins("JOIN " + usersTable + " AS u ON u.id = b.invitee_id").
		Joins("JOIN " + usersTable + " AS i ON i.id = b.inviter_id")
	if query.InviterId > 0 {
		scope = scope.Where("b.inviter_id = ?", query.InviterId)
	}
	if keyword := strings.TrimSpace(query.Keyword); keyword != "" {
		pattern := "%" + referralKeywordEscaper.Replace(strings.ToLower(keyword)) + "%"
		scope = scope.Where(
			"(LOWER(u.username) LIKE ? ESCAPE '!' OR LOWER(u.display_name) LIKE ? ESCAPE '!' OR LOWER(u.email) LIKE ? ESCAPE '!')",
			pattern, pattern, pattern)
	}
	if query.Source != "" {
		scope = scope.Where("b.source = ?", query.Source)
	}
	if query.Status != "" {
		scope = scope.Where(
			"EXISTS (SELECT 1 FROM referral_commissions AS rc WHERE rc.invitee_id = b.invitee_id AND rc.inviter_id = b.inviter_id AND rc.status = ?)",
			query.Status)
	}
	return scope
}

// referralKeywordEscaper escapes the LIKE wildcards of an invitation keyword;
// '!' is the escape character of the keyword queries.
var referralKeywordEscaper = strings.NewReplacer("!", "!!", "%", "!%", "_", "!_")

// referralInvitationAggregate is one invitee's commission sums; the row only
// exists for invitees that produced at least one event.
type referralInvitationAggregate struct {
	InviteeId       int
	PendingQuota    int64
	LockedQuota     int64
	SettledQuota    int64
	ReviewQuota     int64
	BlockedQuota    int64
	RejectedQuota   int64
	TotalPaidQuota  int64
	CommissionCount int64
}

// attachReferralCommissionAggregates fills the commission sums of one page of
// invitations with a single grouped query, so a page of N invitees never runs
// N aggregate queries.
func attachReferralCommissionAggregates(inviterId int, invitations []ReferralInvitation) error {
	inviteeIds := make([]int, 0, len(invitations))
	position := make(map[int]int, len(invitations))
	for i := range invitations {
		inviteeIds = append(inviteeIds, invitations[i].InviteeId)
		position[invitations[i].InviteeId] = i
	}

	aggregates := make([]referralInvitationAggregate, 0, len(inviteeIds))
	aggregateQuery := DB.Table("referral_commissions AS rc").
		Select(`rc.invitee_id,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS pending_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS locked_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS settled_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS review_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS blocked_quota,
			COALESCE(SUM(CASE WHEN rc.status = ? THEN rc.commission_quota ELSE 0 END), 0) AS rejected_quota,
			COALESCE(SUM(rc.base_quota), 0) AS total_paid_quota,
			COUNT(*) AS commission_count`,
			ReferralCommissionStatusPending,
			ReferralCommissionStatusLocked,
			ReferralCommissionStatusSettled,
			ReferralCommissionStatusReview,
			ReferralCommissionStatusBlocked,
			ReferralCommissionStatusRejected).
		Where("rc.invitee_id IN ?", inviteeIds).
		Group("rc.invitee_id")
	if inviterId > 0 {
		aggregateQuery = aggregateQuery.Where("rc.inviter_id = ?", inviterId)
	}
	if err := aggregateQuery.Scan(&aggregates).Error; err != nil {
		return err
	}

	for i := range aggregates {
		target, ok := position[aggregates[i].InviteeId]
		if !ok {
			continue
		}
		invitations[target].PendingQuota = aggregates[i].PendingQuota
		invitations[target].LockedQuota = aggregates[i].LockedQuota
		invitations[target].SettledQuota = aggregates[i].SettledQuota
		invitations[target].ReviewQuota = aggregates[i].ReviewQuota
		invitations[target].BlockedQuota = aggregates[i].BlockedQuota
		invitations[target].RejectedQuota = aggregates[i].RejectedQuota
		invitations[target].TotalPaidQuota = aggregates[i].TotalPaidQuota
		invitations[target].CommissionCount = aggregates[i].CommissionCount
	}
	return nil
}
