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
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"gorm.io/gorm"
)

// Referral flag levels (RF-06). A watched account's commissions always take
// the manual review path; a frozen account neither earns commissions nor
// commissions its inviter until the mark is cleared.
const (
	ReferralFlagLevelWatch  = "watch"
	ReferralFlagLevelFrozen = "frozen"
	// ReferralFlagLevelClear is the pseudo level that removes the mark.
	ReferralFlagLevelClear = "clear"
)

var (
	// ErrReferralIdentityInvalid refuses an empty or unusable real-name
	// identity before anything is hashed or stored.
	ErrReferralIdentityInvalid = errors.New("referral identity is invalid")
	// ErrReferralFlagLevelInvalid refuses a flag level outside the supported
	// set.
	ErrReferralFlagLevelInvalid = errors.New("unknown referral flag level")
)

// ReferralRegistrationSignal records the registration environment of one
// account: the IP and user agent of the registration request, the client device
// identifier stored only as a hash, and the normalized email domain. The row is
// written in the same transaction as the account, so a binding can never exist
// without its signal. A missing row means the environment was not observable
// (for example an administrator-created account), and the corresponding
// anti-abuse bound simply does not apply to that account.
type ReferralRegistrationSignal struct {
	Id          int    `json:"id" gorm:"primaryKey"`
	UserId      int    `json:"user_id" gorm:"not null;uniqueIndex"`
	Ip          string `json:"ip" gorm:"type:varchar(64);not null;index"`
	DeviceHash  string `json:"device_hash" gorm:"type:varchar(64);not null;index"`
	EmailDomain string `json:"email_domain" gorm:"type:varchar(190);not null;index"`
	UserAgent   string `json:"user_agent" gorm:"type:varchar(512);not null"`
	CreatedAt   int64  `json:"created_at" gorm:"bigint;not null"`
}

func (ReferralRegistrationSignal) TableName() string {
	return "referral_registration_signals"
}

// ReferralIdentity records the administrator-verified real-name identity of one
// account as a one-way hash; the raw document number is never stored or logged.
// identity_hash is deliberately not unique: an administrator can record the
// same identity on several accounts, and the payout layer then treats the
// smallest user id as the canonical account and blocks the duplicates.
type ReferralIdentity struct {
	Id           int    `json:"id" gorm:"primaryKey"`
	UserId       int    `json:"user_id" gorm:"not null;uniqueIndex"`
	IdentityHash string `json:"identity_hash" gorm:"type:varchar(64);not null;index"`
	VerifiedAt   int64  `json:"verified_at" gorm:"bigint;not null"`
	UpdatedAt    int64  `json:"updated_at" gorm:"bigint;not null"`
}

func (ReferralIdentity) TableName() string {
	return "referral_identities"
}

// ReferralFlag is the administrator's anti-abuse mark on one account: a watch
// review requirement or a payout freeze that stays until it is cleared.
type ReferralFlag struct {
	Id        int    `json:"id" gorm:"primaryKey"`
	UserId    int    `json:"user_id" gorm:"not null;uniqueIndex"`
	Level     string `json:"level" gorm:"type:varchar(16);not null"`
	Note      string `json:"note" gorm:"type:varchar(255);not null"`
	MarkedBy  int    `json:"marked_by" gorm:"not null"`
	CreatedAt int64  `json:"created_at" gorm:"bigint;not null"`
	UpdatedAt int64  `json:"updated_at" gorm:"bigint;not null"`
}

func (ReferralFlag) TableName() string {
	return "referral_flags"
}

// Referral commission gate reasons. A blocked or reviewed event records the
// reason that produced the decision, so the payout history stays auditable.
const (
	ReferralCommissionReasonFrozenInviter          = "frozen_inviter"
	ReferralCommissionReasonFrozenInvitee          = "frozen_invitee"
	ReferralCommissionReasonSelfInvite             = "self_invite"
	ReferralCommissionReasonDuplicateIdentity      = "duplicate_identity"
	ReferralCommissionReasonRealNameRequired       = "real_name_required"
	ReferralCommissionReasonInviteLimitIP          = "invite_limit_ip"
	ReferralCommissionReasonInviteLimitDevice      = "invite_limit_device"
	ReferralCommissionReasonInviteLimitEmailDomain = "invite_limit_email_domain"
	ReferralCommissionReasonDailyCap               = "daily_cap"
	ReferralCommissionReasonMonthlyCap             = "monthly_cap"
	ReferralCommissionReasonInviteeCap             = "invitee_cap"
	ReferralCommissionReasonWatchFlag              = "watch_flag"
	ReferralCommissionReasonReviewThreshold        = "review_threshold"
)

// HashReferralIdentity normalizes a real-name document number (spaces and
// dashes removed, upper-cased) and returns its one-way hash. The raw value is
// discarded by the caller and never stored.
func HashReferralIdentity(identity string) (string, error) {
	normalized := strings.ToUpper(strings.NewReplacer(" ", "", "-", "").Replace(strings.TrimSpace(identity)))
	if normalized == "" {
		return "", ErrReferralIdentityInvalid
	}
	sum := sha256.Sum256([]byte("referral-identity:" + normalized))
	return hex.EncodeToString(sum[:]), nil
}

// hashReferralDeviceId returns the stored form of a client device identifier.
// The raw identifier never reaches the database.
func hashReferralDeviceId(deviceId string) string {
	deviceId = strings.TrimSpace(deviceId)
	if deviceId == "" {
		return ""
	}
	sum := sha256.Sum256([]byte("referral-device:" + deviceId))
	return hex.EncodeToString(sum[:])
}

// referralEmailDomain returns the normalized domain part of an email address,
// or an empty string when the address carries none.
func referralEmailDomain(email string) string {
	_, domain, ok := strings.Cut(NormalizeEmail(email), "@")
	if !ok {
		return ""
	}
	return domain
}

// GetReferralFlag returns the anti-abuse mark of an account, or nil when the
// account carries none.
func GetReferralFlag(userId int) (*ReferralFlag, error) {
	if userId <= 0 {
		return nil, nil
	}
	flag := &ReferralFlag{}
	err := DB.Where("user_id = ?", userId).First(flag).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return flag, nil
}

// SetReferralFlag sets or clears the anti-abuse mark of one account. Clearing
// removes the row entirely; watch and frozen keep a note, the operator and the
// original creation time.
func SetReferralFlag(userId int, level string, note string, markedBy int) (*ReferralFlag, error) {
	if userId <= 0 {
		return nil, errors.New("referral flag user is invalid")
	}
	if level == ReferralFlagLevelClear {
		if err := DB.Where("user_id = ?", userId).Delete(&ReferralFlag{}).Error; err != nil {
			return nil, err
		}
		return nil, nil
	}
	if level != ReferralFlagLevelWatch && level != ReferralFlagLevelFrozen {
		return nil, fmt.Errorf("%w: %s", ErrReferralFlagLevelInvalid, level)
	}
	note = strings.TrimSpace(note)
	if runes := []rune(note); len(runes) > 255 {
		note = string(runes[:255])
	}
	now := common.GetTimestamp()
	flag := &ReferralFlag{
		UserId:    userId,
		Level:     level,
		Note:      note,
		MarkedBy:  markedBy,
		CreatedAt: now,
		UpdatedAt: now,
	}
	err := DB.Transaction(func(tx *gorm.DB) error {
		var existing ReferralFlag
		err := tx.Where("user_id = ?", userId).First(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return tx.Create(flag).Error
		}
		if err != nil {
			return err
		}
		flag.Id = existing.Id
		flag.CreatedAt = existing.CreatedAt
		return tx.Model(&existing).Updates(map[string]any{
			"level": level, "note": note, "marked_by": markedBy, "updated_at": now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return flag, nil
}

// GetReferralIdentity returns the recorded identity of an account, or nil when
// none is recorded.
func GetReferralIdentity(userId int) (*ReferralIdentity, error) {
	if userId <= 0 {
		return nil, nil
	}
	identity := &ReferralIdentity{}
	err := DB.Where("user_id = ?", userId).First(identity).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return identity, nil
}

// SetReferralIdentity records the verified real-name identity of one account.
// Only the one-way hash is stored; the raw document number is discarded.
func SetReferralIdentity(userId int, identity string) (*ReferralIdentity, error) {
	if userId <= 0 {
		return nil, errors.New("referral identity user is invalid")
	}
	hash, err := HashReferralIdentity(identity)
	if err != nil {
		return nil, err
	}
	now := common.GetTimestamp()
	record := &ReferralIdentity{
		UserId:       userId,
		IdentityHash: hash,
		VerifiedAt:   now,
		UpdatedAt:    now,
	}
	err = DB.Transaction(func(tx *gorm.DB) error {
		var existing ReferralIdentity
		err := tx.Where("user_id = ?", userId).First(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return tx.Create(record).Error
		}
		if err != nil {
			return err
		}
		record.Id = existing.Id
		record.VerifiedAt = existing.VerifiedAt
		return tx.Model(&existing).Updates(map[string]any{
			"identity_hash": hash, "updated_at": now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return record, nil
}

// ClearReferralIdentity removes the recorded identity of an account.
func ClearReferralIdentity(userId int) error {
	if userId <= 0 {
		return errors.New("referral identity user is invalid")
	}
	return DB.Where("user_id = ?", userId).Delete(&ReferralIdentity{}).Error
}

// ReferralCommissionStatusCount is one status bucket of an account's commission
// history, used by the administrator profile view.
type ReferralCommissionStatusCount struct {
	Status string `json:"status"`
	Count  int64  `json:"count"`
	Quota  int64  `json:"quota"`
}

// ReferralProfile is the administrator's read-only anti-abuse view of one
// account: the registration environment, the recorded identity (exposed as an
// 8-character correlation prefix, never the full hash), the flag and the
// commission summary.
type ReferralProfile struct {
	UserId         int                             `json:"user_id"`
	Signal         *ReferralRegistrationSignal     `json:"signal"`
	IdentityLinked bool                            `json:"identity_linked"`
	IdentityRef    string                          `json:"identity_ref"`
	Flag           *ReferralFlag                   `json:"flag"`
	Invitees       int64                           `json:"invitees"`
	Commissions    []ReferralCommissionStatusCount `json:"commissions"`
}

// referralIdentityRef shortens an identity hash to the prefix administrators
// correlate on; the full hash never leaves the database.
func referralIdentityRef(hash string) string {
	if len(hash) > 8 {
		return hash[:8]
	}
	return hash
}

// GetReferralProfile assembles the anti-abuse profile of one account for the
// administrator endpoints.
func GetReferralProfile(userId int) (*ReferralProfile, error) {
	if userId <= 0 {
		return nil, errors.New("referral profile user is invalid")
	}
	profile := &ReferralProfile{UserId: userId, Commissions: make([]ReferralCommissionStatusCount, 0)}

	signal := &ReferralRegistrationSignal{}
	err := DB.Where("user_id = ?", userId).First(signal).Error
	if err == nil {
		profile.Signal = signal
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	identity := &ReferralIdentity{}
	err = DB.Where("user_id = ?", userId).First(identity).Error
	if err == nil {
		profile.IdentityLinked = true
		profile.IdentityRef = referralIdentityRef(identity.IdentityHash)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	flag, err := GetReferralFlag(userId)
	if err != nil {
		return nil, err
	}
	profile.Flag = flag

	if err := DB.Model(&ReferralBinding{}).Where("inviter_id = ?", userId).Count(&profile.Invitees).Error; err != nil {
		return nil, err
	}
	err = DB.Model(&ReferralCommission{}).
		Select("status, COUNT(*) AS count, COALESCE(SUM(commission_quota), 0) AS quota").
		Where("inviter_id = ?", userId).
		Group("status").
		Scan(&profile.Commissions).Error
	if err != nil {
		return nil, err
	}
	return profile, nil
}

// referralFlagWithTx reads the flag of one account inside the caller's
// transaction.
func referralFlagWithTx(tx *gorm.DB, userId int) (*ReferralFlag, error) {
	flag := &ReferralFlag{}
	err := tx.Where("user_id = ?", userId).First(flag).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return flag, nil
}

// referralIdentityWithTx reads the recorded identity of one account inside the
// caller's transaction.
func referralIdentityWithTx(tx *gorm.DB, userId int) (*ReferralIdentity, error) {
	identity := &ReferralIdentity{}
	err := tx.Where("user_id = ?", userId).First(identity).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return identity, nil
}

// referralCanonicalIdentityUserId returns the smallest user id that carries the
// identity hash: the one account of a real person that may earn commissions.
func referralCanonicalIdentityUserId(tx *gorm.DB, hash string) (int, error) {
	var userId int
	err := tx.Model(&ReferralIdentity{}).
		Select("MIN(user_id)").
		Where("identity_hash = ?", hash).
		Scan(&userId).Error
	return userId, err
}

// referralRegistrationSignalWithTx reads the registration signal of one account
// inside the caller's transaction.
func referralRegistrationSignalWithTx(tx *gorm.DB, userId int) (*ReferralRegistrationSignal, error) {
	signal := &ReferralRegistrationSignal{}
	err := tx.Where("user_id = ?", userId).First(signal).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return signal, nil
}

// referralCommissionGate decides the initial status of one commission event:
// pending when it may settle, review when an administrator must approve it
// first, or blocked with the reason when an anti-abuse rule refuses it. The
// checks run in a fixed order so the recorded reason is deterministic. Blocked
// events still carry the would-be amount and stay in the table as audit
// evidence.
func referralCommissionGate(tx *gorm.DB, inviter *User, inviteeId int, commissionQuota int64, now int64) (string, string, error) {
	setting := operation_setting.GetReferralSetting()

	// Frozen marks block payouts immediately and in both directions.
	inviterFlag, err := referralFlagWithTx(tx, inviter.Id)
	if err != nil {
		return "", "", err
	}
	if inviterFlag != nil && inviterFlag.Level == ReferralFlagLevelFrozen {
		return ReferralCommissionStatusBlocked, ReferralCommissionReasonFrozenInviter, nil
	}
	inviteeFlag, err := referralFlagWithTx(tx, inviteeId)
	if err != nil {
		return "", "", err
	}
	if inviteeFlag != nil && inviteeFlag.Level == ReferralFlagLevelFrozen {
		return ReferralCommissionStatusBlocked, ReferralCommissionReasonFrozenInvitee, nil
	}

	// Identity rules: the configured real-name requirement, the payout-layer
	// self-invite recheck (a binding that slipped through before the identities
	// were recorded) and one canonical account per real person.
	inviterIdentity, err := referralIdentityWithTx(tx, inviter.Id)
	if err != nil {
		return "", "", err
	}
	inviteeIdentity, err := referralIdentityWithTx(tx, inviteeId)
	if err != nil {
		return "", "", err
	}
	if setting.RequireRealName && inviterIdentity == nil {
		return ReferralCommissionStatusBlocked, ReferralCommissionReasonRealNameRequired, nil
	}
	if inviterIdentity != nil && inviteeIdentity != nil && inviterIdentity.IdentityHash == inviteeIdentity.IdentityHash {
		return ReferralCommissionStatusBlocked, ReferralCommissionReasonSelfInvite, nil
	}
	for _, candidate := range []struct {
		userId   int
		identity *ReferralIdentity
	}{
		{inviteeId, inviteeIdentity},
		{inviter.Id, inviterIdentity},
	} {
		if candidate.identity == nil {
			continue
		}
		canonical, err := referralCanonicalIdentityUserId(tx, candidate.identity.IdentityHash)
		if err != nil {
			return "", "", err
		}
		if canonical != candidate.userId {
			return ReferralCommissionStatusBlocked, ReferralCommissionReasonDuplicateIdentity, nil
		}
	}

	// Registration-environment recheck and per-signal invitation bounds. The
	// binding layer already refuses a self-invite; a binding that slipped
	// through before the environment was recorded is caught here by the shared
	// device hash. Invitees whose registrations share one signal value then
	// consume the inviter's allowance while their own commissions are
	// effective (not blocked or rejected).
	inviterSignal, err := referralRegistrationSignalWithTx(tx, inviter.Id)
	if err != nil {
		return "", "", err
	}
	signal, err := referralRegistrationSignalWithTx(tx, inviteeId)
	if err != nil {
		return "", "", err
	}
	if inviterSignal != nil && signal != nil && inviterSignal.DeviceHash != "" && inviterSignal.DeviceHash == signal.DeviceHash {
		return ReferralCommissionStatusBlocked, ReferralCommissionReasonSelfInvite, nil
	}
	if signal != nil {
		reason, err := referralSignalLimitReason(tx, inviter.Id, inviteeId, signal)
		if err != nil {
			return "", "", err
		}
		if reason != "" {
			return ReferralCommissionStatusBlocked, reason, nil
		}
	}

	// Daily, monthly and per-invitee payable caps.
	reason, err := referralCommissionCapReason(tx, inviter.Id, inviteeId, commissionQuota, now)
	if err != nil {
		return "", "", err
	}
	if reason != "" {
		return ReferralCommissionStatusBlocked, reason, nil
	}

	// Manual review: the administrator's watch mark and the configured amount
	// threshold both keep the commission out of settlement until it is decided.
	if inviterFlag != nil && inviterFlag.Level == ReferralFlagLevelWatch {
		return ReferralCommissionStatusReview, ReferralCommissionReasonWatchFlag, nil
	}
	if inviteeFlag != nil && inviteeFlag.Level == ReferralFlagLevelWatch {
		return ReferralCommissionStatusReview, ReferralCommissionReasonWatchFlag, nil
	}
	if threshold := setting.ReviewThresholdQuota(); threshold > 0 && commissionQuota > threshold {
		return ReferralCommissionStatusReview, ReferralCommissionReasonReviewThreshold, nil
	}
	return ReferralCommissionStatusPending, "", nil
}

// referralSignalLimitReason checks the invitee's registration signal against
// the configured per-IP, per-device and per-email-domain invitation limits of
// the inviter. A missing signal value or a limit of 0 disables its bound; the
// current invitee never counts towards its own limit.
func referralSignalLimitReason(tx *gorm.DB, inviterId, inviteeId int, signal *ReferralRegistrationSignal) (string, error) {
	setting := operation_setting.GetReferralSetting()
	bounds := []struct {
		column string
		value  string
		limit  int
		reason string
	}{
		{"ip", signal.Ip, setting.InviteLimitPerIP, ReferralCommissionReasonInviteLimitIP},
		{"device_hash", signal.DeviceHash, setting.InviteLimitPerDevice, ReferralCommissionReasonInviteLimitDevice},
		{"email_domain", signal.EmailDomain, setting.InviteLimitPerEmailDomain, ReferralCommissionReasonInviteLimitEmailDomain},
	}
	for _, bound := range bounds {
		if bound.limit <= 0 || bound.value == "" {
			continue
		}
		count, err := referralEffectiveInvitationCount(tx, inviterId, inviteeId, bound.column, bound.value)
		if err != nil {
			return "", err
		}
		if count >= int64(bound.limit) {
			return bound.reason, nil
		}
	}
	return "", nil
}

// referralEffectiveInvitationCount counts the invitees of one inviter whose
// registration signal shares one value and whose own commission event is still
// effective. The current invitee is excluded so it never consumes its own
// allowance.
func referralEffectiveInvitationCount(tx *gorm.DB, inviterId, inviteeId int, column string, value string) (int64, error) {
	var count int64
	err := tx.Model(&ReferralRegistrationSignal{}).
		Joins("JOIN referral_commissions ON referral_commissions.invitee_id = referral_registration_signals.user_id").
		Where("referral_registration_signals."+column+" = ?", value).
		Where("referral_commissions.inviter_id = ?", inviterId).
		Where("referral_commissions.invitee_id <> ?", inviteeId).
		Where("referral_commissions.status NOT IN ?", referralCommissionUnpayableStatuses).
		Distinct("user_id").
		Count(&count).Error
	return count, err
}

// referralCommissionCapReason checks the payable commission of one event
// against the daily, monthly and per-invitee caps. Blocked and rejected events
// never count, so a refused event does not consume the allowance.
func referralCommissionCapReason(tx *gorm.DB, inviterId, inviteeId int, commissionQuota int64, now int64) (string, error) {
	setting := operation_setting.GetReferralSetting()
	dailyCap := setting.DailyCommissionCapQuota()
	monthlyCap := setting.MonthlyCommissionCapQuota()
	inviteeCap := setting.InviteeCommissionCapQuota()
	if dailyCap <= 0 && monthlyCap <= 0 && inviteeCap <= 0 {
		return "", nil
	}
	at := time.Unix(now, 0)
	if dailyCap > 0 {
		dayStart := time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, at.Location()).Unix()
		sum, err := referralPayableCommissionSum(tx, "inviter_id = ? AND created_at >= ?", inviterId, dayStart)
		if err != nil {
			return "", err
		}
		if commissionQuota > dailyCap-sum {
			return ReferralCommissionReasonDailyCap, nil
		}
	}
	if monthlyCap > 0 {
		monthStart := time.Date(at.Year(), at.Month(), 1, 0, 0, 0, 0, at.Location()).Unix()
		sum, err := referralPayableCommissionSum(tx, "inviter_id = ? AND created_at >= ?", inviterId, monthStart)
		if err != nil {
			return "", err
		}
		if commissionQuota > monthlyCap-sum {
			return ReferralCommissionReasonMonthlyCap, nil
		}
	}
	if inviteeCap > 0 {
		sum, err := referralPayableCommissionSum(tx, "invitee_id = ?", inviteeId)
		if err != nil {
			return "", err
		}
		if commissionQuota > inviteeCap-sum {
			return ReferralCommissionReasonInviteeCap, nil
		}
	}
	return "", nil
}

// referralPayableCommissionSum sums the commission quota that is still
// effective under one condition; blocked and rejected events are excluded.
func referralPayableCommissionSum(tx *gorm.DB, condition string, args ...any) (int64, error) {
	var sum int64
	err := tx.Model(&ReferralCommission{}).
		Where(condition, args...).
		Where("status NOT IN ?", referralCommissionUnpayableStatuses).
		Select("COALESCE(SUM(commission_quota), 0)").
		Scan(&sum).Error
	return sum, err
}
