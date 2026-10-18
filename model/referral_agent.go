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
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"gorm.io/gorm"
)

// Referral agent mark (RF-08). An administrator may mark an account as a
// 推荐官/代理 of the single-level referral program and attach one configured
// tier and/or a single-account commission rate override. The mark only scales
// the commission of the account's own invitations: it never introduces
// uplines, downlines or team compensation.
var (
	// ErrReferralAgentTierUnknown refuses a tier identifier that is not
	// configured in referral_setting.agent_tiers.
	ErrReferralAgentTierUnknown = errors.New("unknown referral agent tier")
	// ErrReferralAgentRateInvalid refuses a rate outside the supported range.
	ErrReferralAgentRateInvalid = errors.New("referral agent rate is invalid")
)

// ReferralAgent is the administrator's agent mark on one account: the optional
// tier, the optional single-account rate override (nil inherits the tier or
// the group configuration) and the operator who set it. The row is a
// configuration record only — it never moves a balance.
type ReferralAgent struct {
	Id     int    `json:"id" gorm:"primaryKey;autoIncrement"`
	UserId int    `json:"user_id" gorm:"not null;uniqueIndex"`
	TierId string `json:"tier_id" gorm:"type:varchar(40);not null;default:''"`
	// RatePercent overrides every configured rate when it is set; a nil value
	// inherits the tier, the group override or the global default.
	RatePercent *float64 `json:"rate_percent"`
	Note        string   `json:"note" gorm:"type:varchar(255);not null;default:''"`
	MarkedBy    int      `json:"marked_by" gorm:"not null;default:0"`
	CreatedAt   int64    `json:"created_at" gorm:"bigint;not null"`
	UpdatedAt   int64    `json:"updated_at" gorm:"bigint;not null"`
}

func (ReferralAgent) TableName() string {
	return "referral_agents"
}

// ReferralAgentItem is one marked agent with the account context the
// administrator lists it by and the effective rate the commission engine will
// apply.
type ReferralAgentItem struct {
	ReferralAgent
	Username      string  `json:"username"`
	DisplayName   string  `json:"display_name"`
	Group         string  `json:"group"`
	TierName      string  `json:"tier_name"`
	EffectiveRate float64 `json:"effective_rate_percent"`
	RateSource    string  `json:"rate_source"`
}

// GetReferralAgent returns the agent mark of an account, or nil when the
// account carries none.
func GetReferralAgent(userId int) (*ReferralAgent, error) {
	if userId <= 0 {
		return nil, nil
	}
	agent := &ReferralAgent{}
	err := DB.Where("user_id = ?", userId).First(agent).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return agent, nil
}

// referralAgentWithTx reads the agent mark of one account inside the caller's
// transaction.
func referralAgentWithTx(tx *gorm.DB, userId int) (*ReferralAgent, error) {
	agent := &ReferralAgent{}
	err := tx.Where("user_id = ?", userId).First(agent).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return agent, nil
}

// ReferralCommissionRateFor resolves the effective commission rate of one
// account from its agent mark and user group. The resolution order is
// single-account override → agent tier → group override → global default; the
// second return value names the winning source.
func ReferralCommissionRateFor(agent *ReferralAgent, group string) (float64, string) {
	setting := operation_setting.GetReferralSetting()
	if agent == nil {
		return setting.ResolveCommissionRatePercent(group, "", nil)
	}
	return setting.ResolveCommissionRatePercent(group, agent.TierId, agent.RatePercent)
}

// SetReferralAgent marks one account as a referral agent with the provided
// tier and/or single-account rate override. A non-empty tier must be
// configured and a non-nil rate must stay inside the supported range; an empty
// tier and a nil rate mark the account while inheriting the group
// configuration. Re-setting keeps the original creation time.
func SetReferralAgent(userId int, tierId string, ratePercent *float64, note string, markedBy int) (*ReferralAgent, error) {
	if userId <= 0 {
		return nil, errors.New("referral agent user is invalid")
	}
	tierId = strings.TrimSpace(tierId)
	if tierId != "" {
		if _, ok := operation_setting.GetReferralSetting().AgentTier(tierId); !ok {
			return nil, fmt.Errorf("%w: %s", ErrReferralAgentTierUnknown, tierId)
		}
	}
	if ratePercent != nil {
		rate := *ratePercent
		if math.IsNaN(rate) || math.IsInf(rate, 0) || rate < 0 || rate > operation_setting.ReferralCommissionRateMaxPercent {
			return nil, fmt.Errorf("%w: %v", ErrReferralAgentRateInvalid, rate)
		}
	}
	note = strings.TrimSpace(note)
	if runes := []rune(note); len(runes) > 255 {
		note = string(runes[:255])
	}
	now := common.GetTimestamp()
	agent := &ReferralAgent{
		UserId:      userId,
		TierId:      tierId,
		RatePercent: ratePercent,
		Note:        note,
		MarkedBy:    markedBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	err := DB.Transaction(func(tx *gorm.DB) error {
		var existing ReferralAgent
		err := tx.Where("user_id = ?", userId).First(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return tx.Create(agent).Error
		}
		if err != nil {
			return err
		}
		agent.Id = existing.Id
		agent.CreatedAt = existing.CreatedAt
		return tx.Model(&existing).Updates(map[string]any{
			"tier_id":      tierId,
			"rate_percent": ratePercent,
			"note":         note,
			"marked_by":    markedBy,
			"updated_at":   now,
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return agent, nil
}

// ClearReferralAgent removes the agent mark of an account; the account then
// falls back to its group configuration.
func ClearReferralAgent(userId int) error {
	if userId <= 0 {
		return errors.New("referral agent user is invalid")
	}
	return DB.Where("user_id = ?", userId).Delete(&ReferralAgent{}).Error
}

// ListReferralAgents lists the marked agent accounts newest first with the
// account context and the effective rate of each mark.
func ListReferralAgents(pageInfo *common.PageInfo) ([]ReferralAgentItem, int64, error) {
	var total int64
	if err := DB.Model(&ReferralAgent{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := make([]ReferralAgentItem, 0)
	if total == 0 {
		return items, 0, nil
	}
	pageSize, offset := 20, 0
	if pageInfo != nil {
		pageSize = pageInfo.GetPageSize()
		offset = pageInfo.GetStartIdx()
	}
	var agents []ReferralAgent
	if err := DB.Order("updated_at DESC, id DESC").Limit(pageSize).Offset(offset).Find(&agents).Error; err != nil {
		return nil, total, err
	}
	userIds := make([]int, 0, len(agents))
	for i := range agents {
		userIds = append(userIds, agents[i].UserId)
	}
	var users []User
	if err := DB.Select("id", "username", "display_name", "group").Where("id IN ?", userIds).Find(&users).Error; err != nil {
		return nil, total, err
	}
	usersById := make(map[int]User, len(users))
	for i := range users {
		usersById[users[i].Id] = users[i]
	}
	setting := operation_setting.GetReferralSetting()
	for i := range agents {
		user, ok := usersById[agents[i].UserId]
		if !ok {
			// The account was deleted; a removed account cannot be an agent.
			continue
		}
		item := ReferralAgentItem{ReferralAgent: agents[i], Username: user.Username, DisplayName: user.DisplayName, Group: user.Group}
		item.EffectiveRate, item.RateSource = ReferralCommissionRateFor(&agents[i], user.Group)
		if tier, ok := setting.AgentTier(agents[i].TierId); ok {
			item.TierName = tier.Name
		}
		items = append(items, item)
	}
	return items, total, nil
}
