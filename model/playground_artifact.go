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
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

const (
	PlaygroundArtifactContentMaxBytes   = 256 << 10
	PlaygroundArtifactMaxVersions       = 100
	PlaygroundArtifactMaxBytes          = 8 << 20
	PlaygroundSessionMaxArtifacts       = 32
	PlaygroundSessionArtifactMaxBytes   = 32 << 20
	PlaygroundSessionMaxArtifactRecords = 256
)

var (
	ErrPlaygroundArtifactInvalid         = errors.New("Invalid Playground artifact request.")
	ErrPlaygroundArtifactLimit           = errors.New("Playground artifact storage limit exceeded.")
	ErrPlaygroundArtifactSourceConflict  = errors.New("Playground source message changed. Reload before creating an artifact.")
	ErrPlaygroundArtifactRequestConflict = errors.New("Playground request ID was already used for a different operation.")
	playgroundArtifactRequestPattern     = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,128}$`)
	playgroundArtifactLanguagePattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9+#._-]{0,31}$`)
)

// DeletedAt is an explicit tombstone, not a GORM soft delete. Deleted rows retain
// only identity, creation deduplication and lifecycle fields; no snapshots remain.
type PlaygroundArtifact struct {
	ID               string `gorm:"size:32;primaryKey"`
	UserID           int    `gorm:"not null;uniqueIndex:uk_pg_artifact_create,priority:1"`
	SessionID        string `gorm:"size:128;not null;index"`
	Kind             string `gorm:"size:16;not null"`
	Revision         int64  `gorm:"not null"`
	CurrentVersionID string `gorm:"size:32;not null"`
	Title            string `gorm:"size:200;not null"`
	Language         string `gorm:"size:32;not null"`
	Source           string `gorm:"type:text;not null"`
	CreateRequestID  string `gorm:"size:128;not null"`
	// Hashing the ID makes uniqueness case-sensitive even with MySQL's default collation.
	CreateRequestKey  string `gorm:"size:64;not null;uniqueIndex:uk_pg_artifact_create,priority:2"`
	CreateRequestHash string `gorm:"size:64;not null"`
	CreatedAt         int64  `gorm:"not null"`
	UpdatedAt         int64  `gorm:"not null"`
	DeletedAt         int64  `gorm:"not null;index"`
}

type PlaygroundArtifactVersion struct {
	ID                    string   `json:"id" gorm:"size:32;primaryKey"`
	ArtifactID            string   `json:"artifact_id" gorm:"size:32;not null;uniqueIndex:uk_pg_artifact_number,priority:1;uniqueIndex:uk_pg_artifact_request,priority:1"`
	Number                int64    `json:"number" gorm:"not null;uniqueIndex:uk_pg_artifact_number,priority:2"`
	Title                 string   `json:"title" gorm:"size:200;not null"`
	Language              string   `json:"language" gorm:"size:32;not null"`
	Content               LongText `json:"content" gorm:"not null"`
	ByteSize              int64    `json:"byte_size" gorm:"not null"`
	CreatedAt             int64    `json:"created_at" gorm:"not null"`
	RequestID             string   `json:"-" gorm:"size:128;not null"`
	RequestKey            string   `json:"-" gorm:"size:64;not null;uniqueIndex:uk_pg_artifact_request,priority:2"`
	RequestHash           string   `json:"-" gorm:"size:64;not null"`
	RestoredFromVersionID string   `json:"restored_from_version_id,omitempty" gorm:"size:32;not null"`
}

type PlaygroundArtifactSummary struct {
	ID               string `json:"id"`
	SessionID        string `json:"session_id"`
	Kind             string `json:"kind"`
	Revision         int64  `json:"revision"`
	CurrentVersionID string `json:"current_version_id"`
	Title            string `json:"title"`
	Language         string `json:"language"`
	CreatedAt        int64  `json:"created_at"`
	UpdatedAt        int64  `json:"updated_at"`
}

// History listings intentionally cannot serialize content or private request IDs.
type PlaygroundArtifactVersionMetadata struct {
	ID                    string `json:"id"`
	ArtifactID            string `json:"artifact_id"`
	Number                int64  `json:"number"`
	Title                 string `json:"title"`
	Language              string `json:"language"`
	ByteSize              int64  `json:"byte_size"`
	CreatedAt             int64  `json:"created_at"`
	RestoredFromVersionID string `json:"restored_from_version_id,omitempty"`
}

type PlaygroundArtifactResult struct {
	Artifact PlaygroundArtifactSummary `json:"artifact"`
	Version  PlaygroundArtifactVersion `json:"version"`
}

type PlaygroundArtifactSource struct {
	MessageKey      string `json:"message_key"`
	VersionID       string `json:"version_id"`
	MessageRevision *int64 `json:"message_revision"`
	ContentHash     string `json:"content_hash"`
	CodeBlockIndex  *int   `json:"code_block_index,omitempty"`
}

type CreatePlaygroundArtifactInput struct {
	RequestID string                   `json:"request_id"`
	Kind      string                   `json:"kind"`
	Title     string                   `json:"title"`
	Language  string                   `json:"language"`
	Content   *string                  `json:"content"`
	Source    PlaygroundArtifactSource `json:"source"`
}

type SavePlaygroundArtifactInput struct {
	RequestID        string  `json:"request_id"`
	ExpectedRevision *int64  `json:"expected_revision"`
	Title            string  `json:"title"`
	Language         string  `json:"language"`
	Content          *string `json:"content"`
}

type RestorePlaygroundArtifactInput struct {
	RequestID        string `json:"request_id"`
	ExpectedRevision *int64 `json:"expected_revision"`
	VersionID        string `json:"version_id"`
}

func playgroundArtifactHash(text string) string {
	hash := sha256.Sum256([]byte(text))
	return hex.EncodeToString(hash[:])
}

func playgroundArtifactFingerprint(operation, sessionID string, input any) (string, error) {
	encoded, err := common.Marshal(struct {
		Operation string `json:"operation"`
		SessionID string `json:"session_id"`
		Input     any    `json:"input"`
	}{operation, sessionID, input})
	if err != nil {
		return "", err
	}
	return playgroundArtifactHash(string(encoded)), nil
}

func normalizePlaygroundArtifactSnapshot(kind string, title, language *string, content *string) error {
	*title = strings.TrimSpace(*title)
	*language = strings.ToLower(strings.TrimSpace(*language))
	if *language == "" {
		*language = "plaintext"
		if kind == "markdown" {
			*language = "markdown"
		}
	}
	if *title == "" || len(*title) > 800 || !utf8.ValidString(*title) || utf8.RuneCountInString(*title) > 200 ||
		strings.ContainsRune(*title, 0) || !playgroundArtifactLanguagePattern.MatchString(*language) ||
		content == nil || !utf8.ValidString(*content) || strings.ContainsRune(*content, 0) {
		return ErrPlaygroundArtifactInvalid
	}
	if len(*content) > PlaygroundArtifactContentMaxBytes {
		return ErrPlaygroundArtifactLimit
	}
	return nil
}

// Every artifact transaction acquires its parent first, matching message snapshot
// writes and session deletion. This serializes capacity checks as well as CAS.
func lockPlaygroundArtifactSession(tx *gorm.DB, userID int, sessionID string) (*PlaygroundSession, error) {
	return lockPlaygroundSession(tx, userID, sessionID)
}

func lockPlaygroundArtifact(tx *gorm.DB, userID int, sessionID, artifactID string) (*PlaygroundArtifact, error) {
	var artifact PlaygroundArtifact
	err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND session_id = ? AND deleted_at = 0", artifactID, userID, sessionID).First(&artifact).Error
	if err != nil {
		return nil, err
	}
	if artifact.ID != artifactID {
		return nil, gorm.ErrRecordNotFound
	}
	return &artifact, nil
}

func playgroundArtifactSummary(artifact *PlaygroundArtifact) PlaygroundArtifactSummary {
	return PlaygroundArtifactSummary{ID: artifact.ID, SessionID: artifact.SessionID, Kind: artifact.Kind,
		Revision: artifact.Revision, CurrentVersionID: artifact.CurrentVersionID, Title: artifact.Title, Language: artifact.Language,
		CreatedAt: artifact.CreatedAt, UpdatedAt: artifact.UpdatedAt}
}

func playgroundArtifactResult(artifact *PlaygroundArtifact, version *PlaygroundArtifactVersion) *PlaygroundArtifactResult {
	summary := playgroundArtifactSummary(artifact)
	// Replays and historical reads acknowledge this snapshot, never today's head.
	summary.Revision, summary.CurrentVersionID = version.Number, version.ID
	summary.Title, summary.Language, summary.UpdatedAt = version.Title, version.Language, version.CreatedAt
	return &PlaygroundArtifactResult{Artifact: summary, Version: *version}
}

func validatePlaygroundArtifactSource(tx *gorm.DB, session *PlaygroundSession, source PlaygroundArtifactSource) error {
	if session.MessageRevision != *source.MessageRevision {
		return ErrPlaygroundArtifactSourceConflict
	}
	var message PlaygroundMessage
	err := tx.Where("user_id = ? AND session_id = ? AND client_key = ?", session.UserID, session.ID, source.MessageKey).First(&message).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrPlaygroundArtifactSourceConflict
	}
	if err != nil {
		return err
	}
	var payload struct {
		Key                  string `json:"key"`
		From                 string `json:"from"`
		Status               string `json:"status"`
		IsContentComplete    *bool  `json:"isContentComplete"`
		IsReasoningStreaming bool   `json:"isReasoningStreaming"`
		Versions             []struct {
			ID      string `json:"id"`
			Content string `json:"content"`
		} `json:"versions"`
	}
	if err := common.UnmarshalJsonStr(string(message.Payload), &payload); err != nil {
		return err
	}
	if message.ClientKey != source.MessageKey || payload.Key != source.MessageKey || payload.From != "assistant" ||
		(payload.Status != "" && payload.Status != "complete") || payload.IsReasoningStreaming ||
		(payload.IsContentComplete != nil && !*payload.IsContentComplete) || len(payload.Versions) == 0 ||
		payload.Versions[0].ID != source.VersionID || playgroundArtifactHash(payload.Versions[0].Content) != source.ContentHash {
		return ErrPlaygroundArtifactSourceConflict
	}
	return nil
}

func checkPlaygroundArtifactCapacity(tx *gorm.DB, userID int, sessionID, artifactID string, addedBytes int64, creating bool) error {
	artifacts := tx.Model(&PlaygroundArtifact{}).Where("user_id = ? AND session_id = ?", userID, sessionID)
	if creating {
		var records, active int64
		if err := artifacts.Count(&records).Error; err != nil {
			return err
		}
		if err := tx.Model(&PlaygroundArtifact{}).Where("user_id = ? AND session_id = ? AND deleted_at = 0", userID, sessionID).Count(&active).Error; err != nil {
			return err
		}
		if records >= PlaygroundSessionMaxArtifactRecords || active >= PlaygroundSessionMaxArtifacts {
			return ErrPlaygroundArtifactLimit
		}
	} else {
		var usage struct {
			Count int64
			Bytes int64
		}
		if err := tx.Model(&PlaygroundArtifactVersion{}).Where("artifact_id = ?", artifactID).
			Select("COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes").Scan(&usage).Error; err != nil {
			return err
		}
		if usage.Count >= PlaygroundArtifactMaxVersions || usage.Bytes+addedBytes > PlaygroundArtifactMaxBytes {
			return ErrPlaygroundArtifactLimit
		}
	}
	var bytes int64
	if err := tx.Model(&PlaygroundArtifactVersion{}).Where("artifact_id IN (?)", artifacts.Select("id")).
		Select("COALESCE(SUM(byte_size), 0)").Scan(&bytes).Error; err != nil {
		return err
	}
	if bytes+addedBytes > PlaygroundSessionArtifactMaxBytes {
		return ErrPlaygroundArtifactLimit
	}
	return nil
}

func findPlaygroundArtifactCreation(tx *gorm.DB, userID int, sessionID, requestID, fingerprint string) (*PlaygroundArtifactResult, error) {
	var artifact PlaygroundArtifact
	// Do not lock a different session's artifact while holding this session's lock.
	err := tx.Where("user_id = ? AND create_request_key = ?", userID, playgroundArtifactHash(requestID)).First(&artifact).Error
	if err != nil {
		return nil, err
	}
	if artifact.SessionID != sessionID {
		return nil, ErrPlaygroundArtifactRequestConflict
	}
	if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND session_id = ?", artifact.ID, userID, sessionID).First(&artifact).Error; err != nil {
		return nil, err
	}
	if artifact.CreateRequestID != requestID || artifact.CreateRequestHash != fingerprint {
		return nil, ErrPlaygroundArtifactRequestConflict
	}
	if artifact.DeletedAt != 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var version PlaygroundArtifactVersion
	if err := tx.Where("artifact_id = ? AND number = 1", artifact.ID).First(&version).Error; err != nil {
		return nil, err
	}
	return playgroundArtifactResult(&artifact, &version), nil
}

func CreatePlaygroundArtifact(userID int, sessionID string, input CreatePlaygroundArtifactInput) (*PlaygroundArtifactResult, error) {
	source := &input.Source
	source.ContentHash = strings.ToLower(source.ContentHash)
	hashBytes, hashErr := hex.DecodeString(source.ContentHash)
	if !playgroundArtifactRequestPattern.MatchString(input.RequestID) || (input.Kind != "markdown" && input.Kind != "code") ||
		source.MessageKey == "" || len(source.MessageKey) > 200 || source.VersionID == "" || len(source.VersionID) > 200 ||
		source.MessageRevision == nil || *source.MessageRevision < 0 || hashErr != nil || len(hashBytes) != sha256.Size ||
		(source.CodeBlockIndex != nil && (*source.CodeBlockIndex < 0 || input.Kind != "code")) {
		return nil, ErrPlaygroundArtifactInvalid
	}
	if err := normalizePlaygroundArtifactSnapshot(input.Kind, &input.Title, &input.Language, input.Content); err != nil {
		return nil, err
	}
	fingerprint, err := playgroundArtifactFingerprint("create", sessionID, input)
	if err != nil {
		return nil, err
	}
	var result *PlaygroundArtifactResult
	err = DB.Transaction(func(tx *gorm.DB) error {
		session, err := lockPlaygroundArtifactSession(tx, userID, sessionID)
		if err != nil {
			return err
		}
		// Tombstones must be distinguished from a key that has never existed.
		var count int64
		if err := tx.Model(&PlaygroundArtifact{}).Where("user_id = ? AND create_request_key = ?", userID, playgroundArtifactHash(input.RequestID)).Count(&count).Error; err != nil {
			return err
		}
		if count != 0 {
			result, err = findPlaygroundArtifactCreation(tx, userID, sessionID, input.RequestID, fingerprint)
			return err
		}
		if err := validatePlaygroundArtifactSource(tx, session, input.Source); err != nil {
			return err
		}
		if err := checkPlaygroundArtifactCapacity(tx, userID, sessionID, "", int64(len(*input.Content)), true); err != nil {
			return err
		}
		key, err := common.GenerateRandomCharsKey(24)
		if err != nil {
			return err
		}
		encoded, err := common.Marshal(input.Source)
		if err != nil {
			return err
		}
		now := common.GetTimestamp()
		artifact := PlaygroundArtifact{ID: "pga_" + key, UserID: userID, SessionID: session.ID, Kind: input.Kind,
			Source: string(encoded), CreateRequestID: input.RequestID, CreateRequestKey: playgroundArtifactHash(input.RequestID),
			CreateRequestHash: fingerprint, CreatedAt: now, UpdatedAt: now}
		if err := tx.Create(&artifact).Error; err != nil {
			return err
		}
		result, err = appendPlaygroundArtifactVersion(tx, &artifact, input.RequestID, fingerprint, input.Title, input.Language, *input.Content, "")
		return err
	})
	if err != nil && !isPlaygroundArtifactDomainError(err) {
		// PostgreSQL aborts a transaction after a uniqueness violation. Replay
		// only after it has rolled back, and never repeat the write implicitly.
		replayErr := DB.Transaction(func(tx *gorm.DB) error {
			if _, err := lockPlaygroundArtifactSession(tx, userID, sessionID); err != nil {
				return err
			}
			var lookupErr error
			result, lookupErr = findPlaygroundArtifactCreation(tx, userID, sessionID, input.RequestID, fingerprint)
			return lookupErr
		})
		if replayErr == nil || errors.Is(replayErr, ErrPlaygroundArtifactRequestConflict) {
			return result, replayErr
		}
	}
	return result, err
}

func isPlaygroundArtifactDomainError(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound) || errors.Is(err, ErrPlaygroundConflict) || errors.Is(err, ErrPlaygroundArtifactInvalid) ||
		errors.Is(err, ErrPlaygroundArtifactLimit) || errors.Is(err, ErrPlaygroundArtifactSourceConflict) || errors.Is(err, ErrPlaygroundArtifactRequestConflict)
}

func appendPlaygroundArtifactVersion(tx *gorm.DB, artifact *PlaygroundArtifact, requestID, fingerprint, title, language, content, restoredFrom string) (*PlaygroundArtifactResult, error) {
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return nil, err
	}
	version := PlaygroundArtifactVersion{ID: "pgv_" + key, ArtifactID: artifact.ID, Number: artifact.Revision + 1,
		Title: title, Language: language, Content: LongText(content), ByteSize: int64(len(content)), CreatedAt: common.GetTimestamp(),
		RequestID: requestID, RequestKey: playgroundArtifactHash(requestID), RequestHash: fingerprint, RestoredFromVersionID: restoredFrom}
	if err := tx.Create(&version).Error; err != nil {
		return nil, err
	}
	updated := tx.Model(&PlaygroundArtifact{}).Where("id = ? AND user_id = ? AND session_id = ? AND revision = ? AND deleted_at = 0", artifact.ID, artifact.UserID, artifact.SessionID, artifact.Revision).
		Updates(map[string]any{"revision": version.Number, "current_version_id": version.ID, "title": title, "language": language, "updated_at": version.CreatedAt})
	if updated.Error != nil {
		return nil, updated.Error
	}
	if updated.RowsAffected != 1 {
		return nil, ErrPlaygroundConflict
	}
	return playgroundArtifactResult(artifact, &version), nil
}

func findPlaygroundArtifactWrite(tx *gorm.DB, artifact *PlaygroundArtifact, requestID, fingerprint string) (*PlaygroundArtifactResult, error) {
	var version PlaygroundArtifactVersion
	err := tx.Where("artifact_id = ? AND request_key = ?", artifact.ID, playgroundArtifactHash(requestID)).First(&version).Error
	if err != nil {
		return nil, err
	}
	if version.RequestID != requestID || version.RequestHash != fingerprint {
		return nil, ErrPlaygroundArtifactRequestConflict
	}
	return playgroundArtifactResult(artifact, &version), nil
}

// Save and restore share the same request-ID namespace and transaction ordering.
func writePlaygroundArtifactVersion(userID int, sessionID, artifactID, requestID, fingerprint string, revision int64, title, language, content, restoreID string) (*PlaygroundArtifactResult, error) {
	var result *PlaygroundArtifactResult
	err := DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundArtifactSession(tx, userID, sessionID); err != nil {
			return err
		}
		artifact, err := lockPlaygroundArtifact(tx, userID, sessionID, artifactID)
		if err != nil {
			return err
		}
		result, err = findPlaygroundArtifactWrite(tx, artifact, requestID, fingerprint)
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if restoreID != "" {
			var version PlaygroundArtifactVersion
			if err := tx.Where("id = ? AND artifact_id = ?", restoreID, artifact.ID).First(&version).Error; err != nil {
				return err
			}
			if version.ID != restoreID {
				return gorm.ErrRecordNotFound
			}
			title, language, content = version.Title, version.Language, string(version.Content)
		}
		if artifact.Revision != revision {
			return ErrPlaygroundConflict
		}
		if err := checkPlaygroundArtifactCapacity(tx, userID, sessionID, artifactID, int64(len(content)), false); err != nil {
			return err
		}
		result, err = appendPlaygroundArtifactVersion(tx, artifact, requestID, fingerprint, title, language, content, restoreID)
		return err
	})
	if err != nil && !isPlaygroundArtifactDomainError(err) {
		replayErr := DB.Transaction(func(tx *gorm.DB) error {
			if _, err := lockPlaygroundArtifactSession(tx, userID, sessionID); err != nil {
				return err
			}
			artifact, err := lockPlaygroundArtifact(tx, userID, sessionID, artifactID)
			if err != nil {
				return err
			}
			result, err = findPlaygroundArtifactWrite(tx, artifact, requestID, fingerprint)
			return err
		})
		if replayErr == nil || errors.Is(replayErr, ErrPlaygroundArtifactRequestConflict) {
			return result, replayErr
		}
	}
	return result, err
}

func SavePlaygroundArtifactVersion(userID int, sessionID, artifactID string, input SavePlaygroundArtifactInput) (*PlaygroundArtifactResult, error) {
	if !playgroundArtifactRequestPattern.MatchString(input.RequestID) || input.ExpectedRevision == nil || *input.ExpectedRevision < 1 {
		return nil, ErrPlaygroundArtifactInvalid
	}
	// Empty save language is plaintext; the client sends markdown for Markdown documents.
	if err := normalizePlaygroundArtifactSnapshot("", &input.Title, &input.Language, input.Content); err != nil {
		return nil, err
	}
	fingerprint, err := playgroundArtifactFingerprint("save", sessionID, input)
	if err != nil {
		return nil, err
	}
	return writePlaygroundArtifactVersion(userID, sessionID, artifactID, input.RequestID, fingerprint, *input.ExpectedRevision, input.Title, input.Language, *input.Content, "")
}

func RestorePlaygroundArtifactVersion(userID int, sessionID, artifactID string, input RestorePlaygroundArtifactInput) (*PlaygroundArtifactResult, error) {
	if !playgroundArtifactRequestPattern.MatchString(input.RequestID) || input.ExpectedRevision == nil || *input.ExpectedRevision < 1 || input.VersionID == "" || len(input.VersionID) > 32 {
		return nil, ErrPlaygroundArtifactInvalid
	}
	fingerprint, err := playgroundArtifactFingerprint("restore", sessionID, input)
	if err != nil {
		return nil, err
	}
	return writePlaygroundArtifactVersion(userID, sessionID, artifactID, input.RequestID, fingerprint, *input.ExpectedRevision, "", "", "", input.VersionID)
}

func GetPlaygroundArtifact(userID int, sessionID, artifactID, versionID string) (*PlaygroundArtifactResult, error) {
	var result *PlaygroundArtifactResult
	err := DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundArtifactSession(tx, userID, sessionID); err != nil {
			return err
		}
		artifact, err := lockPlaygroundArtifact(tx, userID, sessionID, artifactID)
		if err != nil {
			return err
		}
		if versionID == "" {
			versionID = artifact.CurrentVersionID
		}
		var version PlaygroundArtifactVersion
		if err := tx.Where("id = ? AND artifact_id = ?", versionID, artifact.ID).First(&version).Error; err != nil {
			return err
		}
		if version.ID != versionID {
			return gorm.ErrRecordNotFound
		}
		result = playgroundArtifactResult(artifact, &version)
		return nil
	})
	return result, err
}

func ListPlaygroundArtifacts(userID int, sessionID string, offset, limit int) ([]PlaygroundArtifactSummary, int64, error) {
	items := make([]PlaygroundArtifactSummary, 0)
	var count int64
	if offset < 0 || limit < 1 || limit > 50 {
		return items, 0, ErrPlaygroundArtifactInvalid
	}
	err := DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundArtifactSession(tx, userID, sessionID); err != nil {
			return err
		}
		query := tx.Model(&PlaygroundArtifact{}).Where("user_id = ? AND session_id = ? AND deleted_at = 0", userID, sessionID)
		if err := query.Count(&count).Error; err != nil {
			return err
		}
		return query.Select("id, session_id, kind, revision, current_version_id, title, language, created_at, updated_at").Order("updated_at DESC, id DESC").Offset(offset).Limit(limit).Scan(&items).Error
	})
	return items, count, err
}

func ListPlaygroundArtifactVersions(userID int, sessionID, artifactID string, offset, limit int) ([]PlaygroundArtifactVersionMetadata, int64, error) {
	items := make([]PlaygroundArtifactVersionMetadata, 0)
	var count int64
	if offset < 0 || limit < 1 || limit > 50 {
		return items, 0, ErrPlaygroundArtifactInvalid
	}
	err := DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundArtifactSession(tx, userID, sessionID); err != nil {
			return err
		}
		artifact, err := lockPlaygroundArtifact(tx, userID, sessionID, artifactID)
		if err != nil {
			return err
		}
		query := tx.Model(&PlaygroundArtifactVersion{}).Where("artifact_id = ?", artifact.ID)
		if err := query.Count(&count).Error; err != nil {
			return err
		}
		return query.Select("id, artifact_id, number, title, language, byte_size, created_at, restored_from_version_id").Order("number DESC").Offset(offset).Limit(limit).Scan(&items).Error
	})
	return items, count, err
}

func DeletePlaygroundArtifact(userID int, sessionID, artifactID string, revision int64) error {
	if revision < 1 {
		return ErrPlaygroundArtifactInvalid
	}
	return DB.Transaction(func(tx *gorm.DB) error {
		if _, err := lockPlaygroundArtifactSession(tx, userID, sessionID); err != nil {
			return err
		}
		var artifact PlaygroundArtifact
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND session_id = ?", artifactID, userID, sessionID).First(&artifact).Error; err != nil {
			return err
		}
		if artifact.DeletedAt != 0 {
			if artifact.Revision == revision+1 {
				return nil
			}
			return gorm.ErrRecordNotFound
		}
		if artifact.Revision != revision {
			return ErrPlaygroundConflict
		}
		if err := tx.Where("artifact_id = ?", artifact.ID).Delete(&PlaygroundArtifactVersion{}).Error; err != nil {
			return err
		}
		now := common.GetTimestamp()
		updated := tx.Model(&PlaygroundArtifact{}).Where("id = ? AND user_id = ? AND session_id = ? AND revision = ? AND deleted_at = 0", artifact.ID, userID, sessionID, revision).
			Updates(map[string]any{"deleted_at": now, "updated_at": now, "revision": revision + 1, "current_version_id": "", "title": "", "language": "", "kind": "", "source": ""})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return ErrPlaygroundConflict
		}
		return nil
	})
}
