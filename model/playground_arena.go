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
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	// PlaygroundArenaChoiceA and PlaygroundArenaChoiceB mean the reader prefers
	// the first or second anonymous reply. Tie means neither is better, and
	// BothBad means neither reply is usable.
	PlaygroundArenaChoiceA       = "a"
	PlaygroundArenaChoiceB       = "b"
	PlaygroundArenaChoiceTie     = "tie"
	PlaygroundArenaChoiceBothBad = "both_bad"

	// PlaygroundArenaNoteMaxRunes bounds the optional one-sentence note. It is
	// a request-shape limit, not a resource quota.
	PlaygroundArenaNoteMaxRunes = 500

	PlaygroundArenaScopePersonal = "personal"
	PlaygroundArenaScopeInstance = "instance"

	playgroundArenaVersionCount = 2
)

var (
	// ErrPlaygroundArenaVoteInvalid rejects a vote for anything that is not a
	// stored anonymous A/B assistant group, or a choice/note outside the
	// contract.
	ErrPlaygroundArenaVoteInvalid = errors.New("Invalid Playground arena vote.")
	// ErrPlaygroundArenaMessageNotFound hides whether a message exists for a
	// different account or was removed; the caller returns the usual 404.
	ErrPlaygroundArenaMessageNotFound = errors.New("Playground message not found.")
)

// PlaygroundArenaVote is one owner-scoped raw preference for one anonymous
// message group. The unique key makes voting idempotent: a repeated vote
// updates the same row instead of counting twice, which also makes changing a
// vote a plain upsert.
type PlaygroundArenaVote struct {
	ID         int64  `json:"id" gorm:"primaryKey"`
	UserID     int    `json:"user_id" gorm:"not null;uniqueIndex:uk_playground_arena_vote_user_message,priority:1"`
	SessionID  string `json:"session_id" gorm:"size:128;not null;uniqueIndex:uk_playground_arena_vote_user_message,priority:2"`
	MessageKey string `json:"message_key" gorm:"size:200;not null;uniqueIndex:uk_playground_arena_vote_user_message,priority:3"`
	Choice     string `json:"choice" gorm:"size:16;not null"`
	Note       string `json:"note" gorm:"size:500;not null;default:''"`
	CreatedAt  int64  `json:"created_at" gorm:"not null"`
	UpdatedAt  int64  `json:"updated_at" gorm:"not null"`
}

// PlaygroundArenaVoteCounts is the fixed choice breakdown of a vote summary.
// Every choice is always present so the client renders a stable shape even
// before the first vote.
type PlaygroundArenaVoteCounts struct {
	A       int64 `json:"a"`
	B       int64 `json:"b"`
	Tie     int64 `json:"tie"`
	BothBad int64 `json:"both_bad"`
}

// PlaygroundArenaVoteSummary is a read-only aggregate. Personal summaries count
// only the caller's votes; instance summaries count every account and are
// exposed to administrators by the controller.
type PlaygroundArenaVoteSummary struct {
	Scope   string                    `json:"scope"`
	Total   int64                     `json:"total"`
	Choices PlaygroundArenaVoteCounts `json:"choices"`
	Notes   int64                     `json:"notes"`
}

// playgroundArenaStoredGroup decodes only the group identity and models of a
// stored message. The message contract was validated on write, so the vote only
// re-checks that this is an anonymous two-model assistant group.
type playgroundArenaStoredGroup struct {
	From      string `json:"from"`
	Parallel  bool   `json:"parallel"`
	Anonymous bool   `json:"anonymous"`
	Versions  []struct {
		Model *string `json:"model"`
	} `json:"versions"`
}

func validPlaygroundArenaChoice(choice string) bool {
	switch choice {
	case PlaygroundArenaChoiceA, PlaygroundArenaChoiceB, PlaygroundArenaChoiceTie, PlaygroundArenaChoiceBothBad:
		return true
	default:
		return false
	}
}

// UpsertPlaygroundArenaVote stores one vote for an authenticated owner. The
// session is locked first so a purge cannot race the write, then the message
// must still be an anonymous A/B group of this account. The unique key makes
// both a replay and a changed vote update the same row.
func UpsertPlaygroundArenaVote(userID int, sessionID, messageKey, choice, note string) (*PlaygroundArenaVote, error) {
	sessionID = strings.TrimSpace(sessionID)
	messageKey = strings.TrimSpace(messageKey)
	choice = strings.TrimSpace(choice)
	note = strings.TrimSpace(note)
	if userID <= 0 || messageKey == "" || len(messageKey) > 200 || !validPlaygroundArenaChoice(choice) ||
		utf8.RuneCountInString(note) > PlaygroundArenaNoteMaxRunes || strings.ContainsRune(note, 0) {
		return nil, ErrPlaygroundArenaVoteInvalid
	}

	var stored PlaygroundArenaVote
	err := DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundSession(tx, userID, sessionID); err != nil {
			return err
		}
		var message PlaygroundMessage
		if err := tx.Where("session_id = ? AND user_id = ? AND client_key = ?", sessionID, userID, messageKey).
			First(&message).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlaygroundArenaMessageNotFound
			}
			return err
		}
		var group playgroundArenaStoredGroup
		if err := common.Unmarshal([]byte(message.Payload), &group); err != nil {
			return ErrPlaygroundArenaVoteInvalid
		}
		if group.From != "assistant" || !group.Parallel || !group.Anonymous ||
			len(group.Versions) != playgroundArenaVersionCount {
			return ErrPlaygroundArenaVoteInvalid
		}
		for _, version := range group.Versions {
			if version.Model == nil || strings.TrimSpace(*version.Model) == "" {
				return ErrPlaygroundArenaVoteInvalid
			}
		}

		now := common.GetTimestamp()
		vote := PlaygroundArenaVote{
			UserID:     userID,
			SessionID:  sessionID,
			MessageKey: messageKey,
			Choice:     choice,
			Note:       note,
			CreatedAt:  now,
			UpdatedAt:  now,
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "user_id"}, {Name: "session_id"}, {Name: "message_key"}},
			DoUpdates: clause.Assignments(map[string]any{
				"choice":     choice,
				"note":       note,
				"updated_at": now,
			}),
		}).Create(&vote).Error; err != nil {
			return err
		}
		return tx.Where("user_id = ? AND session_id = ? AND message_key = ?", userID, sessionID, messageKey).
			First(&stored).Error
	})
	if err != nil {
		return nil, err
	}
	return &stored, nil
}

// ListPlaygroundArenaVotes returns the caller's own votes for one active
// conversation. Other accounts' votes are never included; an unknown or
// foreign conversation resolves to the standard not-found error.
func ListPlaygroundArenaVotes(userID int, sessionID string) ([]PlaygroundArenaVote, error) {
	votes := make([]PlaygroundArenaVote, 0)
	err := DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundSession(tx, userID, strings.TrimSpace(sessionID)); err != nil {
			return err
		}
		return tx.Where("user_id = ? AND session_id = ?", userID, strings.TrimSpace(sessionID)).
			Order("created_at ASC, id ASC").Find(&votes).Error
	})
	return votes, err
}

// PlaygroundArenaVoteSummaryForUser aggregates only the caller's votes.
func PlaygroundArenaVoteSummaryForUser(userID int) (PlaygroundArenaVoteSummary, error) {
	return playgroundArenaVoteSummary(PlaygroundArenaScopePersonal, userID)
}

// PlaygroundArenaVoteSummaryForInstance aggregates every account's votes. The
// controller restricts this projection to administrators.
func PlaygroundArenaVoteSummaryForInstance() (PlaygroundArenaVoteSummary, error) {
	return playgroundArenaVoteSummary(PlaygroundArenaScopeInstance, 0)
}

func playgroundArenaVoteSummary(scope string, userID int) (PlaygroundArenaVoteSummary, error) {
	summary := PlaygroundArenaVoteSummary{Scope: scope}
	query := DB.Model(&PlaygroundArenaVote{})
	if scope == PlaygroundArenaScopePersonal {
		query = query.Where("user_id = ?", userID)
	}
	var rows []struct {
		Choice string
		Count  int64
	}
	if err := query.Select("choice, COUNT(*) AS count").Group("choice").Scan(&rows).Error; err != nil {
		return summary, err
	}
	for _, row := range rows {
		switch row.Choice {
		case PlaygroundArenaChoiceA:
			summary.Choices.A = row.Count
		case PlaygroundArenaChoiceB:
			summary.Choices.B = row.Count
		case PlaygroundArenaChoiceTie:
			summary.Choices.Tie = row.Count
		case PlaygroundArenaChoiceBothBad:
			summary.Choices.BothBad = row.Count
		}
		summary.Total += row.Count
	}
	notes := DB.Model(&PlaygroundArenaVote{})
	if scope == PlaygroundArenaScopePersonal {
		notes = notes.Where("user_id = ?", userID)
	}
	if err := notes.Where("note <> ''").Count(&summary.Notes).Error; err != nil {
		return summary, err
	}
	return summary, nil
}
