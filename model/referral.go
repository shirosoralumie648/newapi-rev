package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
)

// Referral binding sources. A binding is created once — at sign-up or by an
// administrator — and records which channel carried the invitation.
const (
	ReferralSourceLink  = "link"
	ReferralSourceCode  = "code"
	ReferralSourceOAuth = "oauth"
	ReferralSourceAdmin = "admin"
)

var (
	// ErrReferralSelfInvite refuses a binding that would make an account its
	// own inviter.
	ErrReferralSelfInvite = errors.New("a user cannot be their own inviter")
	// ErrReferralInviterNotFound refuses a binding to an account that no
	// longer exists.
	ErrReferralInviterNotFound = errors.New("inviter does not exist")
	// ErrReferralInviterDisabled refuses a binding to a disabled (banned)
	// account so it cannot accumulate invitees or referral rewards.
	ErrReferralInviterDisabled = errors.New("inviter account is disabled")
	// ErrReferralAlreadyBound reports a second binding attempt for one
	// invitee. Bindings are append-once: neither users nor administrators
	// rewrite an existing attribution.
	ErrReferralAlreadyBound = errors.New("invitee already has an inviter")
)

// ReferralAttribution is the invitation carried by a registration request. The
// zero value means the account was created without an invitation.
type ReferralAttribution struct {
	InviterId int
	Source    string
}

// ReferralBinding is the single invitation attribution of an account: one
// immutable row per invitee recording the inviter, the attribution channel and
// the binding time. users.inviter_id mirrors this row for the user-facing APIs,
// and the binding is the source the reward layer reads.
type ReferralBinding struct {
	Id        int    `json:"id" gorm:"primaryKey"`
	InviteeId int    `json:"invitee_id" gorm:"not null;uniqueIndex"`
	InviterId int    `json:"inviter_id" gorm:"not null;index"`
	Source    string `json:"source" gorm:"type:varchar(16);not null"`
	BoundAt   int64  `json:"bound_at" gorm:"not null"`
}

func (ReferralBinding) TableName() string {
	return "referral_bindings"
}

func isReferralSource(source string) bool {
	switch source {
	case ReferralSourceLink, ReferralSourceCode, ReferralSourceOAuth, ReferralSourceAdmin:
		return true
	default:
		return false
	}
}

// LookupReferralInviter resolves an invitation code to its account. Unknown and
// empty codes resolve to 0 without an error so a stale invitation link never
// blocks registration and never reveals which codes exist; a code owned by a
// disabled (banned) account returns ErrReferralInviterDisabled so callers drop
// the attribution instead of rewarding it.
func LookupReferralInviter(affCode string) (int, error) {
	affCode = strings.TrimSpace(affCode)
	if affCode == "" {
		return 0, nil
	}
	var inviter User
	err := DB.Select("id", "status").First(&inviter, "aff_code = ?", affCode).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if inviter.Status != common.UserStatusEnabled {
		return 0, ErrReferralInviterDisabled
	}
	return inviter.Id, nil
}

// CreateReferralBindingWithTx records the single referral relation of an
// existing account and mirrors it to users.inviter_id in the same transaction.
// It enforces the relation invariants for every caller: an account can never be
// its own inviter (including by reusing the inviter's email), a deleted or
// disabled inviter is refused, and an invitee that already has an inviter is
// never rebound (the upstream #3249 self-rebinding approach is not adopted).
func CreateReferralBindingWithTx(tx *gorm.DB, invitee *User, inviterId int, source string) (*ReferralBinding, error) {
	if tx == nil || invitee == nil || invitee.Id == 0 || inviterId == 0 {
		return nil, errors.New("referral binding is invalid")
	}
	if !isReferralSource(source) {
		return nil, fmt.Errorf("unknown referral source %q", source)
	}
	if invitee.Id == inviterId {
		return nil, ErrReferralSelfInvite
	}

	var inviter User
	if err := tx.Select("id", "email", "status").First(&inviter, inviterId).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrReferralInviterNotFound
		}
		return nil, err
	}
	if inviter.Status != common.UserStatusEnabled {
		return nil, ErrReferralInviterDisabled
	}
	if invitee.Email != "" && NormalizeEmail(invitee.Email) == NormalizeEmail(inviter.Email) {
		return nil, ErrReferralSelfInvite
	}

	var existing ReferralBinding
	err := tx.Where("invitee_id = ?", invitee.Id).First(&existing).Error
	if err == nil {
		return nil, ErrReferralAlreadyBound
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	binding := &ReferralBinding{
		InviteeId: invitee.Id,
		InviterId: inviterId,
		Source:    source,
		BoundAt:   common.GetTimestamp(),
	}
	if err := tx.Create(binding).Error; err != nil {
		if isReferralBindingDuplicateError(err) {
			return nil, ErrReferralAlreadyBound
		}
		return nil, err
	}

	// Mirror the relation onto the user row the existing APIs read. The
	// conditional update refuses to overwrite a different inviter; RowsAffected
	// is not trusted directly because MySQL reports 0 for an unchanged value.
	update := tx.Model(&User{}).
		Where("id = ? AND (inviter_id = 0 OR inviter_id IS NULL OR inviter_id = ?)", invitee.Id, inviterId).
		Update("inviter_id", inviterId)
	if update.Error != nil {
		return nil, update.Error
	}
	if update.RowsAffected == 0 {
		var current User
		if err := tx.Select("inviter_id").First(&current, invitee.Id).Error; err != nil {
			return nil, err
		}
		if current.InviterId != inviterId {
			return nil, ErrReferralAlreadyBound
		}
	}
	invitee.InviterId = inviterId
	return binding, nil
}

// bindReferralAttribution records the invitation of a freshly created account.
// An attribution that cannot form a valid relation — the inviter disappeared,
// is disabled (banned), or the invitee would invite themselves — is dropped
// with a log line instead of failing the registration: a stale invitation link
// must not block sign-up, and no relation means no referral reward (#4360).
func bindReferralAttribution(tx *gorm.DB, user *User, attribution ReferralAttribution) error {
	if attribution.InviterId == 0 {
		return nil
	}
	_, err := CreateReferralBindingWithTx(tx, user, attribution.InviterId, attribution.Source)
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, ErrReferralSelfInvite),
		errors.Is(err, ErrReferralInviterNotFound),
		errors.Is(err, ErrReferralInviterDisabled):
		common.SysLog(common.LogText("dropped the invitation of new user %s: %s", user.Username, err.Error()))
		return nil
	default:
		return err
	}
}

// GetReferralBindingForInvitee returns the recorded binding of an invitee, or
// nil when the account was created without an invitation.
func GetReferralBindingForInvitee(inviteeId int) (*ReferralBinding, error) {
	if inviteeId == 0 {
		return nil, nil
	}
	var binding ReferralBinding
	err := DB.Where("invitee_id = ?", inviteeId).First(&binding).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &binding, nil
}

// ActiveReferralInviter resolves the invitee's persisted binding and returns
// the inviter only while that account is still enabled. Reward issuance reads
// the relation through this function, so a banned inviter receives neither the
// sign-up bonus nor later commissions; RF-06 adds the remaining anti-abuse
// limits on top.
func ActiveReferralInviter(inviteeId int) (int, error) {
	binding, err := GetReferralBindingForInvitee(inviteeId)
	if err != nil || binding == nil {
		return 0, err
	}
	var inviter User
	err = DB.Select("id", "status").First(&inviter, binding.InviterId).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if inviter.Status != common.UserStatusEnabled {
		return 0, nil
	}
	return inviter.Id, nil
}

// BindReferralInviterByAdmin records the administrator-approved binding of an
// account that never had an inviter (source "admin"). The same relation rules
// as sign-up apply, and an existing inviter is never replaced.
func BindReferralInviterByAdmin(inviteeId, inviterId int) (*ReferralBinding, error) {
	if inviteeId == 0 || inviterId == 0 {
		return nil, errors.New("referral binding is invalid")
	}
	var binding *ReferralBinding
	err := DB.Transaction(func(tx *gorm.DB) error {
		var invitee User
		if err := tx.First(&invitee, inviteeId).Error; err != nil {
			return err
		}
		var err error
		binding, err = CreateReferralBindingWithTx(tx, &invitee, inviterId, ReferralSourceAdmin)
		return err
	})
	if err != nil {
		return nil, err
	}
	return binding, nil
}

// isReferralBindingDuplicateError reports whether err is the unique index on
// referral_bindings.invitee_id rejecting a second binding.
func isReferralBindingDuplicateError(err error) bool {
	return err != nil && isDuplicateKeyError(err) && strings.Contains(err.Error(), "invitee_id")
}
