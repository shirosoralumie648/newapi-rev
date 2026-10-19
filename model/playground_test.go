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
package model_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/router"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/objectstore"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
)

// installPlaygroundTestObjectStore points the process-wide object store at a
// temporary directory so attachment tests exercise the real write, read, and
// delete paths instead of the legacy inline payload.
func installPlaygroundTestObjectStore(t *testing.T) {
	t.Helper()
	previousStore := objectstore.DefaultStore()
	previousTTL := objectstore.DefaultPresignTTL()
	store, err := objectstore.NewLocal(system_setting.ObjectStoreConfig{
		Backend:           system_setting.ObjectStoreBackendLocal,
		LocalDir:          t.TempDir(),
		PresignTTLSeconds: 60,
	})
	require.NoError(t, err)
	objectstore.SetDefaultStore(store, time.Minute)
	t.Cleanup(func() {
		objectstore.SetDefaultStore(previousStore, previousTTL)
		_ = store.Close()
	})
}

// playgroundContentHashHex mirrors the content hash the model stores so tests
// can insert database-backed rows and corrupt them deliberately.
func playgroundContentHashHex(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func playgroundTestDB(t *testing.T, dialect string) *gorm.DB {
	t.Helper()
	gin.SetMode(gin.TestMode)
	installPlaygroundTestObjectStore(t)
	var driver gorm.Dialector
	switch dialect {
	case "mysql":
		dsn := os.Getenv("TEST_MYSQL_DSN")
		if dsn == "" {
			t.Skip("TEST_MYSQL_DSN not configured")
		}
		driver = mysql.Open(dsn)
	case "postgres":
		dsn := os.Getenv("TEST_POSTGRES_DSN")
		if dsn == "" {
			t.Skip("TEST_POSTGRES_DSN not configured")
		}
		driver = postgres.Open(dsn)
	default:
		driver = sqlite.Open(":memory:")
	}
	prefix := fmt.Sprintf("pgtest_%d_", os.Getpid())
	db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: prefix}, Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	if dialect == "sqlite" {
		sqlDB, err := db.DB()
		require.NoError(t, err)
		sqlDB.SetMaxOpenConns(1)
	}
	previous := model.DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	common.SetDatabaseTypes(common.DatabaseType(dialect), previousLog)
	model.DB = db
	t.Cleanup(func() {
		require.NoError(t, db.Migrator().DropTable(&model.PlaygroundKnowledgeChunk{}, &model.PlaygroundKnowledgeDocument{}, &model.PlaygroundKnowledgeBase{}, &model.PlaygroundTaskArtifactPin{}, &model.PlaygroundTaskArtifactSync{}, &model.PlaygroundObjectDeleteOutbox{}, &model.PlaygroundTaskArtifact{}, &model.PlaygroundCanvasAsset{}, &model.PlaygroundCanvasSnapshot{}, &model.PlaygroundCanvasProject{}, &model.PlaygroundUserUsage{}, &model.PlaygroundUpload{}, &model.PlaygroundAttachment{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundArtifact{}, &model.PlaygroundPreset{}, &model.PlaygroundSnippet{}, &model.PlaygroundMemory{}, &model.PlaygroundMessage{}, &model.PlaygroundSessionShare{}, &model.PlaygroundSession{}, &model.Task{}, &model.PlaygroundStorageLedger{}, &model.WalletDebt{}, &model.WalletLedgerEntry{}, &model.User{}))
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
		model.DB = previous
		common.SetDatabaseTypes(previousMain, previousLog)
	})
	require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundSessionShare{}, &model.PlaygroundMessage{}, &model.PlaygroundPreset{}, &model.PlaygroundSnippet{}, &model.PlaygroundMemory{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundUpload{}, &model.PlaygroundUserUsage{}, &model.PlaygroundCanvasProject{}, &model.PlaygroundCanvasSnapshot{}, &model.PlaygroundCanvasAsset{}, &model.PlaygroundKnowledgeBase{}, &model.PlaygroundKnowledgeDocument{}, &model.PlaygroundKnowledgeChunk{}, &model.PlaygroundTaskArtifact{}, &model.PlaygroundTaskArtifactPin{}, &model.PlaygroundTaskArtifactSync{}, &model.PlaygroundObjectDeleteOutbox{}, &model.Task{}, &model.PlaygroundStorageLedger{}, &model.WalletDebt{}, &model.WalletLedgerEntry{}, &model.User{}))
	var version string
	versionQuery := "SELECT version()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("Database version: %s", version)
	// Playground writes lock the account counter row instead of the users row,
	// so the fixture only needs the accounts themselves.
	for _, userID := range []int{7, 8, 9} {
		user := model.User{Id: userID, Username: fmt.Sprintf("playground-%d", userID), AffCode: fmt.Sprintf("pg-aff-%d", userID), Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1}
		require.NoError(t, db.Create(&user).Error)
	}
	return db
}

func playgroundRequest(t *testing.T, user int, method, path string, body any, handler gin.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	encoded, raw := body.([]byte)
	if !raw {
		var err error
		encoded, err = common.Marshal(body)
		require.NoError(t, err)
	}
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("id", user)
	c.Request = httptest.NewRequest(method, path, bytes.NewReader(encoded))
	parsed, err := url.Parse(path)
	require.NoError(t, err)
	parts := strings.Split(parsed.Path, "/")
	if len(parts) > 4 {
		c.Params = gin.Params{{Key: "id", Value: parts[4]}}
		if parts[3] == "shared" {
			c.Params = append(c.Params, gin.Param{Key: "token", Value: parts[4]})
		}
		if parts[3] == "canvases" {
			c.Params = append(c.Params, gin.Param{Key: "canvasId", Value: parts[4]})
		}
		if parts[3] == "presets" {
			presetID := parts[4]
			if (presetID == "global" || presetID == "market") && len(parts) > 5 {
				presetID = parts[5]
			}
			c.Params = append(c.Params, gin.Param{Key: "presetId", Value: presetID})
		}
		if parts[3] == "snippets" {
			c.Params = append(c.Params, gin.Param{Key: "snippetId", Value: parts[4]})
		}
		if parts[3] == "memories" {
			c.Params = append(c.Params, gin.Param{Key: "memoryId", Value: parts[4]})
		}
		if parts[3] == "tasks" {
			c.Params = append(c.Params, gin.Param{Key: "taskId", Value: parts[4]})
		}
		if parts[3] == "uploads" {
			c.Params = append(c.Params, gin.Param{Key: "uploadId", Value: parts[4]})
		}
		if parts[3] == "knowledge-bases" {
			c.Params = append(c.Params, gin.Param{Key: "kbId", Value: parts[4]})
			if len(parts) > 6 {
				c.Params = append(c.Params, gin.Param{Key: "documentId", Value: parts[6]})
			}
		}
	}
	if len(parts) > 6 {
		c.Params = append(c.Params, gin.Param{Key: "artifactId", Value: parts[6]})
		c.Params = append(c.Params, gin.Param{Key: "attachmentId", Value: parts[6]})
		c.Params = append(c.Params, gin.Param{Key: "artifactKey", Value: parts[6]})
		if parts[3] == "canvases" && parts[5] == "snapshots" {
			c.Params = append(c.Params, gin.Param{Key: "snapshotId", Value: parts[6]})
		}
	}
	if len(parts) > 8 {
		c.Params = append(c.Params, gin.Param{Key: "versionId", Value: parts[8]})
	}
	handler(c)
	return recorder
}

func createPlayground(t *testing.T, user int, clientID string) map[string]any {
	t.Helper()
	response := playgroundRequest(t, user, http.MethodPost, "/api/playground/sessions", map[string]any{
		"title": "Conversation", "client_id": clientID, "config": map[string]any{"model": "test-model"},
		"parameter_enabled": map[string]bool{"temperature": false},
	}, controller.CreatePlaygroundSession)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var envelope struct {
		Success bool
		Data    map[string]any
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, response.Body.String())
	return envelope.Data
}

func TestPlaygroundPersistenceMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			session := createPlayground(t, 7, "local-session")
			id := session["id"].(string)
			assert.Equal(t, id, createPlayground(t, 7, "local-session")["id"])
			assert.NotEqual(t, id, createPlayground(t, 8, "local-session")["id"])
			require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundPreset{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundCanvasProject{}, &model.PlaygroundCanvasAsset{}, &model.WalletDebt{}, &model.User{}))
			require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundPreset{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundCanvasProject{}, &model.PlaygroundCanvasAsset{}, &model.WalletDebt{}, &model.User{}))
			reloaded, err := model.GetPlaygroundSession(7, id)
			require.NoError(t, err)
			assert.Equal(t, "Conversation", reloaded.Title)
			for _, handler := range []gin.HandlerFunc{controller.GetPlaygroundSession, controller.ListPlaygroundMessages, controller.DeletePlaygroundSession} {
				response := playgroundRequest(t, 8, http.MethodGet, "/api/playground/sessions/"+id, nil, handler)
				assert.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
			}
			foreignUpdate := playgroundRequest(t, 8, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{"revision": 0, "title": "Hijacked"}, controller.UpdatePlaygroundSession)
			assert.Equal(t, http.StatusNotFound, foreignUpdate.Code)
			foreignMessages := playgroundRequest(t, 8, http.MethodPut, "/api/playground/sessions/"+id+"/messages", map[string]any{"revision": 0, "messages": []any{}}, controller.ReplacePlaygroundMessages)
			assert.Equal(t, http.StatusNotFound, foreignMessages.Code)
			listed := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions?page_size=1", nil, controller.ListPlaygroundSessions)
			var listing struct {
				Success bool
				Data    struct {
					Total int
					Items []struct{ ID string }
				}
			}
			require.NoError(t, common.Unmarshal(listed.Body.Bytes(), &listing))
			assert.Equal(t, 1, listing.Data.Total)
			require.Len(t, listing.Data.Items, 1)
			assert.Equal(t, id, listing.Data.Items[0].ID)

			// Snapshots preserve order and large UTF-8 content; MySQL TEXT alone cannot hold this payload.
			content := strings.Repeat("海", 25000)
			message := map[string]any{"client_key": "m1", "payload": map[string]any{"key": "m1", "from": "user", "versions": []map[string]any{{"id": "v1", "content": content}}}}
			body := map[string]any{"revision": 0, "messages": []any{message}}
			response := playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+id+"/messages", body, controller.ReplacePlaygroundMessages)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			var stored struct {
				Success bool
				Data    struct {
					Revision int64
					Messages []struct {
						ClientKey string `json:"client_key"`
						Payload   struct{ Versions []struct{ Content string } }
					}
				}
			}
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &stored))
			require.True(t, stored.Success)
			assert.EqualValues(t, 1, stored.Data.Revision)
			require.Len(t, stored.Data.Messages, 1)
			assert.Equal(t, content, stored.Data.Messages[0].Payload.Versions[0].Content)
			stale := playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+id+"/messages", body, controller.ReplacePlaygroundMessages)
			assert.Equal(t, http.StatusConflict, stale.Code)
			response = playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+id+"/messages", map[string]any{"revision": 1, "messages": []any{}}, controller.ReplacePlaygroundMessages)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			response = playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{"revision": 0, "title": "Renamed"}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			reloaded, err = model.GetPlaygroundSession(7, id)
			require.NoError(t, err)
			assert.Contains(t, reloaded.Config, "test-model")
			// Reasoning effort is part of the stored configuration; only the
			// effort strings the relay accepts are storable.
			response = playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{
				"revision": 1, "config": map[string]any{"reasoning_effort": "high"},
				"parameter_enabled": map[string]bool{"reasoning_effort": true},
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			reloaded, err = model.GetPlaygroundSession(7, id)
			require.NoError(t, err)
			assert.Contains(t, reloaded.Config, `"reasoning_effort":"high"`)
			assert.Contains(t, reloaded.ParameterEnabled, `"reasoning_effort":true`)
			invalidEffort := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{
				"revision": 2, "config": map[string]any{"reasoning_effort": "turbo"},
			}, controller.UpdatePlaygroundSession)
			assert.Equal(t, http.StatusBadRequest, invalidEffort.Code, invalidEffort.Body.String())
			response = playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id, nil, controller.DeletePlaygroundSession)
			require.Equal(t, http.StatusOK, response.Code)
			_, err = model.GetPlaygroundSession(7, id)
			assert.ErrorIs(t, err, model.ErrPlaygroundSessionNotFound)
			var count int64
			require.NoError(t, db.Model(&model.PlaygroundMessage{}).Where("session_id = ?", id).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}

func TestPlaygroundRejectsInvalidSnapshotsWithoutReplacingHistory(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	session := createPlayground(t, 9, "validation")
	path := "/api/playground/sessions/" + session["id"].(string) + "/messages"
	_, err := model.ReplacePlaygroundMessages(9, session["id"].(string), 0, []model.PlaygroundMessage{{ClientKey: "kept", Payload: `{"key":"kept","from":"user","versions":[{"id":"v","content":"Keep this history"}]}`}})
	require.NoError(t, err)
	tests := []struct {
		name string
		body any
	}{
		{"missing snapshot", map[string]any{"revision": 0}},
		{"missing revision", map[string]any{"messages": []any{}}},
		{"non-object payload", map[string]any{"revision": 0, "messages": []any{map[string]any{"client_key": "m", "payload": "text"}}}},
		{"invalid role", map[string]any{"revision": 0, "messages": []any{map[string]any{"client_key": "m", "payload": map[string]any{"key": "m", "from": "owner", "versions": []any{map[string]any{"id": "v", "content": "text"}}}}}}},
		{"oversized body", map[string]any{"revision": 0, "messages": []any{map[string]any{"client_key": "m", "payload": map[string]any{"key": "m", "from": "user", "versions": []any{map[string]any{"id": "v", "content": strings.Repeat("x", 2<<20)}}}}}}},
		{"oversized request id", map[string]any{"revision": 0, "messages": []any{map[string]any{"client_key": "m", "payload": map[string]any{"key": "m", "from": "assistant", "versions": []any{map[string]any{"id": "v", "content": "text", "requestId": strings.Repeat("r", 65)}}}}}}},
		{"oversized finish reason", map[string]any{"revision": 0, "messages": []any{map[string]any{"client_key": "m", "payload": map[string]any{"key": "m", "from": "assistant", "versions": []any{map[string]any{"id": "v", "content": "text", "finishReason": strings.Repeat("f", 65)}}}}}}},
		{"empty request id", map[string]any{"revision": 0, "messages": []any{map[string]any{"client_key": "m", "payload": map[string]any{"key": "m", "from": "assistant", "versions": []any{map[string]any{"id": "v", "content": "text", "requestId": ""}}}}}}},
		{"negative usage", map[string]any{"revision": 0, "messages": []any{map[string]any{"client_key": "m", "payload": map[string]any{"key": "m", "from": "assistant", "versions": []any{map[string]any{"id": "v", "content": "text", "usage": map[string]any{"promptTokens": -1, "completionTokens": 0, "totalTokens": 0}}}}}}}},
		{"fractional usage", map[string]any{"revision": 0, "messages": []any{map[string]any{"client_key": "m", "payload": map[string]any{"key": "m", "from": "assistant", "versions": []any{map[string]any{"id": "v", "content": "text", "usage": map[string]any{"promptTokens": 1.5, "completionTokens": 0, "totalTokens": 1.5}}}}}}}},
		{"partial usage", map[string]any{"revision": 0, "messages": []any{map[string]any{"client_key": "m", "payload": map[string]any{"key": "m", "from": "assistant", "versions": []any{map[string]any{"id": "v", "content": "text", "usage": map[string]any{"promptTokens": 1}}}}}}}},
		{"oversized usage", map[string]any{"revision": 0, "messages": []any{map[string]any{"client_key": "m", "payload": map[string]any{"key": "m", "from": "assistant", "versions": []any{map[string]any{"id": "v", "content": "text", "usage": map[string]any{"promptTokens": 1 << 41, "completionTokens": 0, "totalTokens": 1 << 41}}}}}}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := playgroundRequest(t, 9, http.MethodPut, path, test.body, controller.ReplacePlaygroundMessages)
			assert.True(t, response.Code == http.StatusBadRequest || response.Code == http.StatusRequestEntityTooLarge, response.Body.String())
			messages, revision, err := model.ListPlaygroundMessages(9, session["id"].(string))
			require.NoError(t, err)
			require.Len(t, messages, 1)
			assert.EqualValues(t, 1, revision)
			assert.Contains(t, string(messages[0].Payload), "Keep this history")
		})
	}
}

// Web-search snapshots are part of the user turn: the normalized query and
// hits are stored verbatim so a reload or replay rebuilds the same prompt and
// citations. The gateway bounds every field and keeps the snapshot on user
// messages only; an invalid snapshot leaves the stored history untouched.
func TestPlaygroundMessageSearchSnapshots(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			playgroundTestDB(t, dialect)
			session := createPlayground(t, 7, "web-search")
			path := "/api/playground/sessions/" + session["id"].(string) + "/messages"
			result := map[string]any{
				"title":   "Go releases",
				"url":     "https://go.dev/blog",
				"snippet": "The latest Go release notes.",
			}
			accepted := map[string]any{"revision": 0, "messages": []any{map[string]any{
				"client_key": "user-search",
				"payload": map[string]any{
					"key": "user-search", "from": "user",
					"search": map[string]any{
						"query":    "latest go release",
						"provider": "tavily",
						"results":  []any{result},
					},
					"versions": []any{map[string]any{"id": "u1", "content": "What changed?"}},
				},
			}}}
			response := playgroundRequest(t, 7, http.MethodPut, path, accepted, controller.ReplacePlaygroundMessages)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			messages, revision, err := model.ListPlaygroundMessages(7, session["id"].(string))
			require.NoError(t, err)
			require.EqualValues(t, 1, revision)
			require.Len(t, messages, 1)
			var stored struct {
				Search struct {
					Query    string `json:"query"`
					Provider string `json:"provider"`
					Results  []struct {
						Title   string `json:"title"`
						URL     string `json:"url"`
						Snippet string `json:"snippet"`
					} `json:"results"`
				} `json:"search"`
			}
			require.NoError(t, common.UnmarshalJsonStr(string(messages[0].Payload), &stored))
			assert.Equal(t, "latest go release", stored.Search.Query)
			assert.Equal(t, "tavily", stored.Search.Provider)
			require.Len(t, stored.Search.Results, 1)
			assert.Equal(t, "Go releases", stored.Search.Results[0].Title)
			assert.Equal(t, "https://go.dev/blog", stored.Search.Results[0].URL)
			assert.Equal(t, "The latest Go release notes.", stored.Search.Results[0].Snippet)

			tooManyResults := make([]any, 7)
			for index := range tooManyResults {
				tooManyResults[index] = map[string]any{
					"title": fmt.Sprintf("Result %d", index), "url": "https://example.com", "snippet": "text",
				}
			}
			largeResults := make([]any, 6)
			for index := range largeResults {
				largeResults[index] = map[string]any{
					"title": strings.Repeat("t", 300), "url": "https://example.com/" + strings.Repeat("u", 3000), "snippet": strings.Repeat("s", 1200),
				}
			}
			rejects := []struct {
				name   string
				from   string
				search map[string]any
			}{
				{"snapshot on an assistant message", "assistant", map[string]any{"query": "q", "results": []any{}}},
				{"blank query", "user", map[string]any{"query": " ", "results": []any{}}},
				{"oversized provider", "user", map[string]any{"query": "q", "provider": strings.Repeat("p", 33), "results": []any{}}},
				{"excess result count", "user", map[string]any{"query": "q", "results": tooManyResults}},
				{"non-http result URL", "user", map[string]any{"query": "q", "results": []any{map[string]any{"title": "t", "url": "ftp://example.com", "snippet": "s"}}}},
				{"result URL with credentials", "user", map[string]any{"query": "q", "results": []any{map[string]any{"title": "t", "url": "https://user:pass@example.com", "snippet": "s"}}}},
				{"oversized title", "user", map[string]any{"query": "q", "results": []any{map[string]any{"title": strings.Repeat("t", 301), "url": "https://example.com", "snippet": "s"}}}},
				{"oversized snippet", "user", map[string]any{"query": "q", "results": []any{map[string]any{"title": "t", "url": "https://example.com", "snippet": strings.Repeat("s", 1201)}}}},
				{"oversized result list", "user", map[string]any{"query": "q", "results": largeResults}},
			}
			for _, test := range rejects {
				t.Run(test.name, func(t *testing.T) {
					body := map[string]any{"revision": 1, "messages": []any{map[string]any{
						"client_key": "user-search",
						"payload": map[string]any{
							"key": "user-search", "from": test.from, "search": test.search,
							"versions": []any{map[string]any{"id": "u1", "content": "What changed?"}},
						},
					}}}
					rejected := playgroundRequest(t, 7, http.MethodPut, path, body, controller.ReplacePlaygroundMessages)
					assert.Equal(t, http.StatusBadRequest, rejected.Code, rejected.Body.String())
					messages, revision, err := model.ListPlaygroundMessages(7, session["id"].(string))
					require.NoError(t, err)
					require.EqualValues(t, 1, revision)
					require.Len(t, messages, 1)
					assert.Contains(t, string(messages[0].Payload), "latest go release")
				})
			}
		})
	}
}

// Tool call snapshots keep the requested call and the user-provided result
// verbatim. The gateway only bounds the state: calls on non-assistant messages,
// excess counts, duplicate or missing identities, oversized payloads and
// unknown statuses are rejected while the stored history stays intact, and no
// call is ever executed.
func TestPlaygroundToolCallSnapshots(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			playgroundTestDB(t, dialect)
			policy := playground_setting.GetPlaygroundQuotaPolicy("default")
			session := createPlayground(t, 7, "tool-calls")
			path := "/api/playground/sessions/" + session["id"].(string) + "/messages"
			result := "Sunny, 21 C (obtained elsewhere)"
			accepted := map[string]any{"revision": 0, "messages": []any{map[string]any{
				"client_key": "assistant-tools",
				"payload": map[string]any{
					"key": "assistant-tools", "from": "assistant", "status": "complete",
					"versions": []any{map[string]any{"id": "a1", "content": "", "toolCalls": []any{
						map[string]any{"id": "call_weather", "name": "get_weather", "arguments": `{"city":"Paris"}`, "status": "completed", "result": result},
						map[string]any{"id": "call_time", "name": "get_time", "arguments": `{"zone":"UTC"}`, "status": "denied"},
						map[string]any{"id": "call_search", "name": "search", "arguments": `{"q":"golang"}`, "status": "pending"},
					}}},
				},
			}}}
			response := playgroundRequest(t, 7, http.MethodPut, path, accepted, controller.ReplacePlaygroundMessages)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			messages, revision, err := model.ListPlaygroundMessages(7, session["id"].(string))
			require.NoError(t, err)
			require.EqualValues(t, 1, revision)
			require.Len(t, messages, 1)
			var stored struct {
				From     string `json:"from"`
				Versions []struct {
					ToolCalls []struct {
						ID     string  `json:"id"`
						Status string  `json:"status"`
						Result *string `json:"result"`
					} `json:"toolCalls"`
				} `json:"versions"`
			}
			require.NoError(t, common.UnmarshalJsonStr(string(messages[0].Payload), &stored))
			assert.Equal(t, "assistant", stored.From)
			require.Len(t, stored.Versions, 1)
			require.Len(t, stored.Versions[0].ToolCalls, 3)
			assert.Equal(t, "pending", stored.Versions[0].ToolCalls[2].Status)
			assert.Nil(t, stored.Versions[0].ToolCalls[2].Result)
			assert.Equal(t, "denied", stored.Versions[0].ToolCalls[1].Status)
			require.NotNil(t, stored.Versions[0].ToolCalls[0].Result)
			assert.Equal(t, result, *stored.Versions[0].ToolCalls[0].Result)

			tooMany := make([]any, policy.ToolCallMaxCount+1)
			for index := range tooMany {
				tooMany[index] = map[string]any{"id": fmt.Sprintf("call_%d", index), "name": "tool", "arguments": `{}`, "status": "pending"}
			}
			rejects := []struct {
				name  string
				from  string
				calls []any
			}{
				{"calls on a user message", "user", []any{map[string]any{"id": "call_1", "name": "tool", "arguments": `{}`, "status": "pending"}}},
				{"excess call count", "assistant", tooMany},
				{"duplicate call ids", "assistant", []any{
					map[string]any{"id": "call_1", "name": "tool", "arguments": `{}`, "status": "pending"},
					map[string]any{"id": "call_1", "name": "tool", "arguments": `{}`, "status": "pending"},
				}},
				{"missing call id", "assistant", []any{map[string]any{"id": "", "name": "tool", "arguments": `{}`, "status": "pending"}}},
				{"oversized arguments", "assistant", []any{map[string]any{"id": "call_1", "name": "tool", "arguments": strings.Repeat("a", int(policy.ToolCallArgumentsMaxBytes)+1), "status": "pending"}}},
				{"oversized result", "assistant", []any{map[string]any{"id": "call_1", "name": "tool", "arguments": `{}`, "status": "completed", "result": strings.Repeat("b", int(policy.ToolCallResultMaxBytes)+1)}}},
				{"unknown status", "assistant", []any{map[string]any{"id": "call_1", "name": "tool", "arguments": `{}`, "status": "running"}}},
			}
			for _, test := range rejects {
				t.Run(test.name, func(t *testing.T) {
					body := map[string]any{"revision": 1, "messages": []any{map[string]any{
						"client_key": "assistant-tools",
						"payload": map[string]any{
							"key": "assistant-tools", "from": test.from, "status": "complete",
							"versions": []any{map[string]any{"id": "a1", "content": "", "toolCalls": test.calls}},
						},
					}}}
					rejected := playgroundRequest(t, 7, http.MethodPut, path, body, controller.ReplacePlaygroundMessages)
					assert.Equal(t, http.StatusBadRequest, rejected.Code, rejected.Body.String())
					messages, revision, err := model.ListPlaygroundMessages(7, session["id"].(string))
					require.NoError(t, err)
					require.EqualValues(t, 1, revision)
					require.Len(t, messages, 1)
					assert.Contains(t, string(messages[0].Payload), "call_weather")
				})
			}
		})
	}
}

// A parallel comparison is stored as one assistant message group whose versions
// each name the model that produced them. The gateway validates and stores the
// group only: every compared reply is an ordinary /pg call on its own, and the
// owner's policy caps how many models one group may hold.
func TestPlaygroundParallelCompareGroups(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			playgroundTestDB(t, dialect)
			policy := playground_setting.GetPlaygroundQuotaPolicy("default")
			require.Equal(t, 4, policy.ParallelCompareMaxModels, "the built-in comparison budget matches the client ceiling")
			session := createPlayground(t, 7, "parallel-compare")
			path := "/api/playground/sessions/" + session["id"].(string) + "/messages"

			group := func(parallel bool, from string, versions []any) map[string]any {
				return map[string]any{"revision": 1, "messages": []any{map[string]any{
					"client_key": "assistant-compare",
					"payload": map[string]any{
						"key": "assistant-compare", "from": from, "parallel": parallel,
						"status": "complete", "activeVersionIndex": 0, "versions": versions,
					},
				}}}
			}
			version := func(id, model, status string) map[string]any {
				entry := map[string]any{"id": id, "content": "Reply from " + model, "model": model}
				if status != "" {
					entry["status"] = status
				}
				return entry
			}

			accepted := map[string]any{"revision": 0, "messages": []any{map[string]any{
				"client_key": "assistant-compare",
				"payload": map[string]any{
					"key": "assistant-compare", "from": "assistant", "parallel": true,
					"status": "complete", "activeVersionIndex": 1,
					"versions": []any{
						map[string]any{"id": "a1", "content": "Answer from model one", "model": "model-one", "status": "complete",
							"requestId": "req-one", "usage": map[string]any{"promptTokens": 10, "completionTokens": 20, "totalTokens": 30}},
						map[string]any{"id": "a2", "content": "Answer from model two", "model": "model-two", "status": "error",
							"errorCode": "model_price_error", "requestId": "req-two"},
						map[string]any{"id": "a3", "content": "", "model": "model-three", "status": "loading"},
					},
				},
			}}}
			response := playgroundRequest(t, 7, http.MethodPut, path, accepted, controller.ReplacePlaygroundMessages)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			messages, revision, err := model.ListPlaygroundMessages(7, session["id"].(string))
			require.NoError(t, err)
			require.EqualValues(t, 1, revision)
			require.Len(t, messages, 1)
			var stored struct {
				Parallel *bool `json:"parallel"`
				Active   *int  `json:"activeVersionIndex"`
				Versions []struct {
					Model  *string `json:"model"`
					Status string  `json:"status"`
				} `json:"versions"`
			}
			require.NoError(t, common.UnmarshalJsonStr(string(messages[0].Payload), &stored))
			require.NotNil(t, stored.Parallel)
			assert.True(t, *stored.Parallel)
			require.Len(t, stored.Versions, 3)
			require.NotNil(t, stored.Versions[0].Model)
			assert.Equal(t, "model-one", *stored.Versions[0].Model)
			assert.Equal(t, "error", stored.Versions[1].Status)
			assert.Equal(t, "loading", stored.Versions[2].Status)
			require.NotNil(t, stored.Active)
			assert.Equal(t, 1, *stored.Active)

			rejects := []struct {
				name string
				body map[string]any
			}{
				{"parallel group on a user message", group(true, "user", []any{version("v1", "model-one", ""), version("v2", "model-two", "")})},
				{"single-version comparison", group(true, "assistant", []any{version("v1", "model-one", "")})},
				{"version without a model", group(true, "assistant", []any{version("v1", "model-one", ""), map[string]any{"id": "v2", "content": "Reply"}})},
				{"unknown version status", group(true, "assistant", []any{version("v1", "model-one", "running"), version("v2", "model-two", "")})},
				{"oversized model name", group(true, "assistant", []any{version("v1", strings.Repeat("m", 513), ""), version("v2", "model-two", "")})},
				{"oversized version error code", group(true, "assistant", []any{
					version("v1", "model-one", "error"),
					func() map[string]any {
						entry := version("v2", "model-two", "")
						entry["errorCode"] = strings.Repeat("e", 501)
						return entry
					}(),
				})},
			}
			for _, test := range rejects {
				t.Run(test.name, func(t *testing.T) {
					rejected := playgroundRequest(t, 7, http.MethodPut, path, test.body, controller.ReplacePlaygroundMessages)
					assert.Equal(t, http.StatusBadRequest, rejected.Code, rejected.Body.String())
					messages, revision, err := model.ListPlaygroundMessages(7, session["id"].(string))
					require.NoError(t, err)
					require.EqualValues(t, 1, revision)
					require.Len(t, messages, 1)
					assert.Contains(t, string(messages[0].Payload), "Answer from model one")
				})
			}

			// One model over the owner's budget is rejected with the stable
			// capacity code, and the stored group stays untouched.
			tooMany := make([]any, policy.ParallelCompareMaxModels+1)
			for index := range tooMany {
				tooMany[index] = version(fmt.Sprintf("v%d", index), fmt.Sprintf("model-%d", index), "")
			}
			overflow := playgroundRequest(t, 7, http.MethodPut, path, group(true, "assistant", tooMany), controller.ReplacePlaygroundMessages)
			require.Equal(t, http.StatusUnprocessableEntity, overflow.Code, overflow.Body.String())
			assert.Contains(t, overflow.Body.String(), "PLAYGROUND_PARALLEL_LIMIT_EXCEEDED")

			// A group override lowers the comparison budget for one user group;
			// the same group accepts at most that many models afterwards.
			usePlaygroundGroupQuota(t, "default", playground_setting.PlaygroundQuotaPolicy{ParallelCompareMaxModels: 2})
			threeModels := playgroundRequest(t, 7, http.MethodPut, path, group(true, "assistant", []any{
				version("v1", "model-one", ""), version("v2", "model-two", ""), version("v3", "model-three", ""),
			}), controller.ReplacePlaygroundMessages)
			require.Equal(t, http.StatusUnprocessableEntity, threeModels.Code, threeModels.Body.String())
			assert.Contains(t, threeModels.Body.String(), "PLAYGROUND_PARALLEL_LIMIT_EXCEEDED")
			twoModels := playgroundRequest(t, 7, http.MethodPut, path, group(true, "assistant", []any{
				version("v1", "model-one", ""), version("v2", "model-two", ""),
			}), controller.ReplacePlaygroundMessages)
			require.Equal(t, http.StatusOK, twoModels.Code, twoModels.Body.String())
			_, revision, err = model.ListPlaygroundMessages(7, session["id"].(string))
			require.NoError(t, err)
			assert.EqualValues(t, 2, revision)
		})
	}
}

func TestPlaygroundMigrationCreateIsAtomicAndReplayDoesNotOverwriteMessages(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	body := map[string]any{"title": "迁移会话", "client_id": "migration", "messages": []any{map[string]any{"client_key": "m", "payload": map[string]any{"key": "m", "from": "user", "versions": []any{map[string]any{"id": "v", "content": "Imported history"}}}}}}
	response := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions", body, controller.CreatePlaygroundSession)
	var first struct {
		Success bool
		Data    struct {
			ID      string
			Created bool
		}
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &first))
	require.True(t, first.Success)
	assert.True(t, first.Data.Created)
	body["messages"] = []any{}
	response = playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions", body, controller.CreatePlaygroundSession)
	var replay struct {
		Data struct {
			ID      string
			Created bool
		}
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &replay))
	assert.Equal(t, first.Data.ID, replay.Data.ID)
	assert.False(t, replay.Data.Created)
	messages, _, err := model.ListPlaygroundMessages(7, first.Data.ID)
	require.NoError(t, err)
	require.Len(t, messages, 1)
	assert.Contains(t, string(messages[0].Payload), "Imported history")
	// Repeated startup migrations retain populated payloads and the owner/client uniqueness guarantee.
	require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundCanvasProject{}, &model.WalletDebt{}, &model.User{}))
	require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundCanvasProject{}, &model.WalletDebt{}, &model.User{}))
	messages, _, err = model.ListPlaygroundMessages(7, first.Data.ID)
	require.NoError(t, err)
	require.Len(t, messages, 1)
}

// The API fixtures exercise production controllers; the real-router test below
// separately verifies dashboard authentication, exact route matching and caching.
func playgroundArtifactSourceFixture(t *testing.T, user int, clientID string) (string, model.CreatePlaygroundArtifactInput) {
	t.Helper()
	session := createPlayground(t, user, clientID)
	id := session["id"].(string)
	rawContent := "<think>Private reasoning</think># Visible document\n\n```go\nfmt.Println(1)\n```"
	response := playgroundRequest(t, user, http.MethodPut, "/api/playground/sessions/"+id+"/messages", map[string]any{
		"revision": 0, "messages": []any{map[string]any{"client_key": "assistant", "payload": map[string]any{
			"key": "assistant", "from": "assistant", "status": "complete", "isContentComplete": true,
			"versions": []any{map[string]any{"id": "source-v1", "content": rawContent}},
		}}},
	}, controller.ReplacePlaygroundMessages)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	hash := sha256.Sum256([]byte(rawContent))
	revision := int64(1)
	content := "# Visible document\n\n```go\nfmt.Println(1)\n```"
	return id, model.CreatePlaygroundArtifactInput{RequestID: "create_1", Kind: "markdown", Title: "Document", Language: "markdown", Content: &content,
		Source: model.PlaygroundArtifactSource{MessageKey: "assistant", VersionID: "source-v1", MessageRevision: &revision, ContentHash: hex.EncodeToString(hash[:])}}
}

func artifactResult(t *testing.T, response *httptest.ResponseRecorder) model.PlaygroundArtifactResult {
	t.Helper()
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var envelope struct {
		Success bool
		Data    model.PlaygroundArtifactResult
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, response.Body.String())
	require.Equal(t, envelope.Data.Version.Number, envelope.Data.Artifact.Revision)
	require.Equal(t, envelope.Data.Version.ID, envelope.Data.Artifact.CurrentVersionID)
	assert.Equal(t, envelope.Data.Version.Title, envelope.Data.Artifact.Title)
	assert.Equal(t, envelope.Data.Version.Language, envelope.Data.Artifact.Language)
	assert.EqualValues(t, len(envelope.Data.Version.Content), envelope.Data.Version.ByteSize)
	return envelope.Data
}

func TestPlaygroundArtifactPersistenceMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			sessionID, input := playgroundArtifactSourceFixture(t, 7, "artifact-upgrade")
			// Upgrade a populated Phase 2 schema, then migrate populated artifacts
			// twice. This is not a substitute for the latest released-schema matrix.
			// The requests above need the schema AutoMigrate already established at
			// startup, so the drop simulates the missing tables only from here on.
			require.NoError(t, db.Migrator().DropTable(&model.PlaygroundArtifactVersion{}, &model.PlaygroundArtifact{}))
			require.NoError(t, db.AutoMigrate(&model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}))
			path := "/api/playground/sessions/" + sessionID + "/artifacts"
			created := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact))
			artifactPath := path + "/" + created.Artifact.ID
			require.NoError(t, db.AutoMigrate(&model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}))
			require.NoError(t, db.AutoMigrate(&model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}))
			assert.EqualValues(t, 1, created.Artifact.Revision)
			assert.Equal(t, *input.Content, string(created.Version.Content))
			assert.NotContains(t, string(created.Version.Content), "Private reasoning")

			// Source replacement changes physical message IDs and revision, but
			// artifact snapshots and even the original create replay remain valid.
			response := playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+sessionID+"/messages", map[string]any{"revision": 1, "messages": []any{}}, controller.ReplacePlaygroundMessages)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			got := artifactResult(t, playgroundRequest(t, 7, http.MethodGet, artifactPath, nil, controller.GetPlaygroundArtifact))
			assert.Equal(t, created, got)
			changed := input
			changed.Title = "Different fingerprint"
			assert.Equal(t, http.StatusConflict, playgroundRequest(t, 7, http.MethodPost, path, changed, controller.CreatePlaygroundArtifact).Code)
			changed.RequestID = "new-stale-source"
			assert.Equal(t, http.StatusConflict, playgroundRequest(t, 7, http.MethodPost, path, changed, controller.CreatePlaygroundArtifact).Code)

			revision := int64(1)
			content := strings.Repeat("海", 25000) // exceeds MySQL TEXT's 64 KiB
			save := model.SavePlaygroundArtifactInput{RequestID: "save_1", ExpectedRevision: &revision, Title: "Saved title", Language: "markdown", Content: &content}
			saved := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/versions", save, controller.SavePlaygroundArtifactVersion))
			assert.EqualValues(t, 2, saved.Version.Number)
			assert.EqualValues(t, 75000, saved.Version.ByteSize)
			assert.Equal(t, content, string(saved.Version.Content))
			// A version larger than the externalization threshold keeps only
			// metadata in its row; the body is a gzip object, and the reads
			// above hydrated it from there.
			var storedVersion model.PlaygroundArtifactVersion
			require.NoError(t, db.Where("id = ?", saved.Version.ID).First(&storedVersion).Error)
			assert.Equal(t, system_setting.ObjectStoreBackendLocal, storedVersion.StorageBackend)
			assert.True(t, strings.HasPrefix(storedVersion.ObjectKey, "pg/7/artifacts/"), storedVersion.ObjectKey)
			assert.Equal(t, "gzip", storedVersion.ContentEncoding)
			assert.Empty(t, string(storedVersion.Content))
			assert.EqualValues(t, 75000, storedVersion.ByteSize)
			restoreRevision := int64(2)
			restore := model.RestorePlaygroundArtifactInput{RequestID: "restore_1", ExpectedRevision: &restoreRevision, VersionID: created.Version.ID}
			restored := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/restore", restore, controller.RestorePlaygroundArtifactVersion))
			assert.EqualValues(t, 3, restored.Artifact.Revision)
			assert.Equal(t, created.Version.ID, restored.Version.RestoredFromVersionID)
			assert.Equal(t, created.Version.Content, restored.Version.Content)
			assert.Equal(t, created.Version.Title, restored.Version.Title)
			assert.NotEqual(t, created.Version.ID, restored.Version.ID)
			assert.Equal(t, saved, artifactResult(t, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/versions", save, controller.SavePlaygroundArtifactVersion)))
			assert.Equal(t, created, artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact)))
			assert.Equal(t, created, artifactResult(t, playgroundRequest(t, 7, http.MethodGet, artifactPath+"/versions/"+created.Version.ID, nil, controller.GetPlaygroundArtifact)))
			assert.Equal(t, saved, artifactResult(t, playgroundRequest(t, 7, http.MethodGet, artifactPath+"/versions/"+saved.Version.ID, nil, controller.GetPlaygroundArtifact)))
			changedSave := save
			changedSave.Title = "Same key, new body"
			assert.Equal(t, http.StatusConflict, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/versions", changedSave, controller.SavePlaygroundArtifactVersion).Code)
			changedSave.RequestID = "stale-save"
			assert.Equal(t, http.StatusConflict, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/versions", changedSave, controller.SavePlaygroundArtifactVersion).Code)
			changedRestore := restore
			changedRestore.VersionID = saved.Version.ID
			assert.Equal(t, http.StatusConflict, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/restore", changedRestore, controller.RestorePlaygroundArtifactVersion).Code)
			changedRestore.RequestID = save.RequestID // save and restore namespace cannot collide
			assert.Equal(t, http.StatusConflict, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/restore", changedRestore, controller.RestorePlaygroundArtifactVersion).Code)

			foreignSession, foreignInput := playgroundArtifactSourceFixture(t, 7, "other-session")
			foreignInput.RequestID = "other-create"
			foreign := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+foreignSession+"/artifacts", foreignInput, controller.CreatePlaygroundArtifact))
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodGet, artifactPath+"/versions/"+foreign.Version.ID, nil, controller.GetPlaygroundArtifact).Code)
			changedRestore.VersionID, changedRestore.RequestID = foreign.Version.ID, "foreign-restore"
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/restore", changedRestore, controller.RestorePlaygroundArtifactVersion).Code)
			for _, scope := range []struct {
				user      int
				sessionID string
			}{{8, sessionID}, {7, foreignSession}} {
				base := "/api/playground/sessions/" + scope.sessionID + "/artifacts"
				target := base + "/" + created.Artifact.ID
				for _, test := range []struct {
					method, path string
					body         any
					handler      gin.HandlerFunc
				}{
					{http.MethodGet, target, nil, controller.GetPlaygroundArtifact},
					{http.MethodGet, target + "/versions", nil, controller.ListPlaygroundArtifactVersions},
					{http.MethodGet, target + "/versions/" + created.Version.ID, nil, controller.GetPlaygroundArtifact},
					{http.MethodPost, target + "/versions", save, controller.SavePlaygroundArtifactVersion},
					{http.MethodPost, target + "/restore", restore, controller.RestorePlaygroundArtifactVersion},
					{http.MethodDelete, target + "?expected_revision=3", nil, controller.DeletePlaygroundArtifact},
				} {
					response := playgroundRequest(t, scope.user, test.method, test.path, test.body, test.handler)
					assert.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
				}
			}
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodGet, path, nil, controller.ListPlaygroundArtifacts).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodPost, path, input, controller.CreatePlaygroundArtifact).Code)
			assert.Equal(t, http.StatusConflict, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+foreignSession+"/artifacts", input, controller.CreatePlaygroundArtifact).Code)

			// Later writes do not change restore replay acknowledgements.
			latestRevision := int64(3)
			latest := save
			latest.RequestID, latest.ExpectedRevision = "save-latest", &latestRevision
			final := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/versions", latest, controller.SavePlaygroundArtifactVersion))
			var duplicate model.PlaygroundArtifactVersion
			require.NoError(t, db.Where("id = ?", final.Version.ID).First(&duplicate).Error)
			duplicate.ID = "pgv_duplicate"
			assert.Error(t, db.Create(&duplicate).Error)
			duplicate.Number++
			assert.Error(t, db.Create(&duplicate).Error)
			var duplicateArtifact model.PlaygroundArtifact
			require.NoError(t, db.Where("id = ?", final.Artifact.ID).First(&duplicateArtifact).Error)
			duplicateArtifact.ID = "pga_duplicate"
			assert.Error(t, db.Create(&duplicateArtifact).Error)
			assert.Equal(t, restored, artifactResult(t, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/restore", restore, controller.RestorePlaygroundArtifactVersion)))
			listed := playgroundRequest(t, 7, http.MethodGet, artifactPath+"/versions?p=2&page_size=2", nil, controller.ListPlaygroundArtifactVersions)
			require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
			var listing struct {
				Data struct {
					Items []map[string]any
					Total int
				}
			}
			require.NoError(t, common.Unmarshal(listed.Body.Bytes(), &listing))
			assert.Equal(t, 4, listing.Data.Total)
			require.Len(t, listing.Data.Items, 2)
			assert.EqualValues(t, 2, listing.Data.Items[0]["number"])
			for _, item := range listing.Data.Items {
				assert.NotContains(t, item, "content")
				assert.NotContains(t, item, "request_id")
			}
			listed = playgroundRequest(t, 7, http.MethodGet, path, nil, controller.ListPlaygroundArtifacts)
			require.NoError(t, common.Unmarshal(listed.Body.Bytes(), &listing))
			require.Len(t, listing.Data.Items, 1)
			assert.EqualValues(t, 4, listing.Data.Items[0]["revision"])
			assert.NotContains(t, listing.Data.Items[0], "content")
			assert.Equal(t, http.StatusConflict, playgroundRequest(t, 7, http.MethodDelete, artifactPath+"?expected_revision=3", nil, controller.DeletePlaygroundArtifact).Code)
			assert.Equal(t, final, artifactResult(t, playgroundRequest(t, 7, http.MethodGet, artifactPath, nil, controller.GetPlaygroundArtifact)))
			deletedPath := artifactPath
			assert.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, deletedPath+"?expected_revision=4", nil, controller.DeletePlaygroundArtifact).Code)
			assert.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, deletedPath+"?expected_revision=4", nil, controller.DeletePlaygroundArtifact).Code)
			// The externalized version body leaves the object store together
			// with the row that owned it.
			objectStore := objectstore.DefaultStore()
			require.NotNil(t, objectStore)
			_, objectErr := objectStore.Head(context.Background(), storedVersion.ObjectKey)
			assert.ErrorIs(t, objectErr, objectstore.ErrObjectNotFound)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/versions", latest, controller.SavePlaygroundArtifactVersion).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPost, artifactPath+"/restore", restore, controller.RestorePlaygroundArtifactVersion).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodGet, artifactPath, nil, controller.GetPlaygroundArtifact).Code)
			var count int64
			require.NoError(t, db.Model(&model.PlaygroundArtifactVersion{}).Where("artifact_id = ?", created.Artifact.ID).Count(&count).Error)
			assert.Zero(t, count)
			var tombstone model.PlaygroundArtifact
			require.NoError(t, db.Where("id = ?", created.Artifact.ID).First(&tombstone).Error)
			assert.NotZero(t, tombstone.DeletedAt)
			assert.Empty(t, tombstone.Title)
			assert.Empty(t, tombstone.Source)
			assert.Empty(t, tombstone.CurrentVersionID)
			listed = playgroundRequest(t, 7, http.MethodGet, path, nil, controller.ListPlaygroundArtifacts)
			require.NoError(t, common.Unmarshal(listed.Body.Bytes(), &listing))
			assert.Zero(t, listing.Data.Total)
			assert.Empty(t, listing.Data.Items)
			// Deleting a session moves it to the trash, where its tombstones
			// and live bodies stay until the purge clears them.
			for _, id := range []string{sessionID, foreignSession} {
				response := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id, nil, controller.DeletePlaygroundSession)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			}
			require.NoError(t, db.Model(&model.PlaygroundArtifact{}).Count(&count).Error)
			assert.EqualValues(t, 2, count)
			require.NoError(t, db.Model(&model.PlaygroundArtifactVersion{}).Count(&count).Error)
			assert.EqualValues(t, 1, count)
			for _, id := range []string{sessionID, foreignSession} {
				require.NoError(t, model.PurgePlaygroundSession(7, id))
			}
			require.NoError(t, db.Model(&model.PlaygroundArtifact{}).Count(&count).Error)
			assert.Zero(t, count)
			require.NoError(t, db.Model(&model.PlaygroundArtifactVersion{}).Count(&count).Error)
			assert.Zero(t, count)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact).Code)
		})
	}
}

func TestPlaygroundArtifactValidationAndUTF8Boundaries(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	sessionID, input := playgroundArtifactSourceFixture(t, 7, "boundaries")
	path := "/api/playground/sessions/" + sessionID + "/artifacts"
	atLimit := strings.Repeat("海", (256<<10)/3) + "x"
	input.Content, input.Title, input.Language, input.RequestID = &atLimit, strings.Repeat("🦀", 200), strings.Repeat("a", 32), strings.Repeat("A", 128)
	created := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact))
	assert.EqualValues(t, 256<<10, created.Version.ByteSize)
	assert.Equal(t, atLimit, string(created.Version.Content))
	tests := []struct {
		name   string
		change func(*model.CreatePlaygroundArtifactInput)
		status int
	}{
		{"title rune overflow", func(v *model.CreatePlaygroundArtifactInput) { v.Title = strings.Repeat("a", 201) }, 400},
		{"title byte overflow", func(v *model.CreatePlaygroundArtifactInput) { v.Title = strings.Repeat("🦀", 201) }, 400},
		{"empty title", func(v *model.CreatePlaygroundArtifactInput) { v.Title = "  " }, 400},
		{"content byte overflow", func(v *model.CreatePlaygroundArtifactInput) { text := atLimit + "海"; v.Content = &text }, 422},
		{"missing content", func(v *model.CreatePlaygroundArtifactInput) { v.Content = nil }, 400},
		{"nul content", func(v *model.CreatePlaygroundArtifactInput) { text := "a\x00b"; v.Content = &text }, 400},
		{"language overflow", func(v *model.CreatePlaygroundArtifactInput) { v.Language = strings.Repeat("a", 33) }, 400},
		{"language non ascii", func(v *model.CreatePlaygroundArtifactInput) { v.Language = "汉" }, 400},
		{"language separator", func(v *model.CreatePlaygroundArtifactInput) { v.Language = "../js" }, 400},
		{"request id overflow", func(v *model.CreatePlaygroundArtifactInput) { v.RequestID = strings.Repeat("a", 129) }, 400},
		{"request id invalid", func(v *model.CreatePlaygroundArtifactInput) { v.RequestID = "bad/id" }, 400},
		{"request id unicode", func(v *model.CreatePlaygroundArtifactInput) { v.RequestID = "请求" }, 400},
		{"request id missing", func(v *model.CreatePlaygroundArtifactInput) { v.RequestID = "" }, 400},
		{"kind invalid", func(v *model.CreatePlaygroundArtifactInput) { v.Kind = "pdf" }, 400},
		{"kind case sensitive", func(v *model.CreatePlaygroundArtifactInput) { v.Kind = "HTML" }, 400},
		{"revision missing", func(v *model.CreatePlaygroundArtifactInput) { v.Source.MessageRevision = nil }, 400},
		{"hash invalid", func(v *model.CreatePlaygroundArtifactInput) { v.Source.ContentHash = "hash" }, 400},
		{"hash changed", func(v *model.CreatePlaygroundArtifactInput) { v.Source.ContentHash = strings.Repeat("0", 64) }, 409},
		{"key missing", func(v *model.CreatePlaygroundArtifactInput) { v.Source.MessageKey = "missing" }, 409},
		{"version changed", func(v *model.CreatePlaygroundArtifactInput) { v.Source.VersionID = "missing" }, 409},
		{"markdown code block", func(v *model.CreatePlaygroundArtifactInput) { index := 0; v.Source.CodeBlockIndex = &index }, 400},
		{"negative code block", func(v *model.CreatePlaygroundArtifactInput) { index := -1; v.Source.CodeBlockIndex = &index }, 400},
	}
	for i, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := input
			candidate.RequestID = fmt.Sprintf("invalid-%d", i)
			test.change(&candidate)
			response := playgroundRequest(t, 7, http.MethodPost, path, candidate, controller.CreatePlaygroundArtifact)
			assert.Equal(t, test.status, response.Code, response.Body.String())
		})
	}
	for _, query := range []string{"page_size=51", "page_size=100000", "page_size=bad", "page_size=-1", "ps=51", "size=51", "p=-1", "p=1000001", "page_size=1&page_size=2"} {
		assert.Equal(t, 400, playgroundRequest(t, 7, http.MethodGet, path+"?"+query, nil, controller.ListPlaygroundArtifacts).Code)
	}
	for _, query := range []string{"", "?expected_revision=0", "?expected_revision=no", "?expected_revision=1&expected_revision=2"} {
		assert.Equal(t, 400, playgroundRequest(t, 7, http.MethodDelete, path+"/"+created.Artifact.ID+query, nil, controller.DeletePlaygroundArtifact).Code)
	}
	var count int64
	require.NoError(t, db.Model(&model.PlaygroundArtifact{}).Count(&count).Error)
	assert.EqualValues(t, 1, count)
	candidate := input
	candidate.RequestID, candidate.Kind, candidate.Language = "nanoid_A-z:._-09", "code", " C++ "
	index := 0
	candidate.Source.CodeBlockIndex = &index
	candidate.Title = " Code "
	content := "fmt.Println(1)"
	candidate.Content = &content
	encoded, err := common.Marshal(candidate)
	require.NoError(t, err)
	bodyAtLimit := append(encoded, bytes.Repeat([]byte(" "), (2<<20)-len(encoded))...)
	code := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, bodyAtLimit, controller.CreatePlaygroundArtifact))
	assert.Equal(t, "c++", code.Version.Language)
	assert.Equal(t, "Code", code.Version.Title)
	assert.Equal(t, 413, playgroundRequest(t, 7, http.MethodPost, path, append(bodyAtLimit, ' '), controller.CreatePlaygroundArtifact).Code)
	assert.Equal(t, 400, playgroundRequest(t, 7, http.MethodPost, path, append(encoded, []byte(" {}")...), controller.CreatePlaygroundArtifact).Code)
	assert.Equal(t, 400, playgroundRequest(t, 7, http.MethodPost, path, []byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'}, controller.CreatePlaygroundArtifact).Code)
	// Request IDs are case-sensitive on all dialects, independent of collation.
	candidate.RequestID = "NANOID_A-z:._-09"
	different := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, candidate, controller.CreatePlaygroundArtifact))
	assert.NotEqual(t, code.Artifact.ID, different.Artifact.ID)
	// html and svg are accepted so the sandbox can preview them, and an empty
	// language records the format for the renderer. All three code-block kinds
	// may carry the index of the block they were derived from.
	for _, kind := range []string{"html", "svg"} {
		previewable := input
		previewable.RequestID = "kind-" + kind
		previewable.Kind = kind
		previewable.Language = ""
		previewable.Source.CodeBlockIndex = &index
		preview := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, previewable, controller.CreatePlaygroundArtifact))
		assert.Equal(t, kind, preview.Artifact.Kind)
		assert.Equal(t, kind, preview.Version.Language)
	}
}

func TestPlaygroundArtifactRejectsUnfinishedOrNonAssistantSources(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	sessionID, input := playgroundArtifactSourceFixture(t, 7, "source-status")
	path := "/api/playground/sessions/" + sessionID
	for _, test := range []struct {
		role, status        string
		complete, streaming bool
	}{
		{"user", "complete", true, false}, {"system", "complete", true, false}, {"assistant", "streaming", false, false},
		{"assistant", "error", true, false}, {"assistant", "complete", false, false}, {"assistant", "complete", true, true},
	} {
		revision := *input.Source.MessageRevision
		content := "same version ID, replaced content"
		response := playgroundRequest(t, 7, http.MethodPut, path+"/messages", map[string]any{"revision": revision, "messages": []any{map[string]any{
			"client_key": "assistant", "payload": map[string]any{"key": "assistant", "from": test.role, "status": test.status,
				"isContentComplete": test.complete, "isReasoningStreaming": test.streaming, "versions": []any{map[string]any{"id": "source-v1", "content": content}}},
		}}}, controller.ReplacePlaygroundMessages)
		require.Equal(t, 200, response.Code, response.Body.String())
		*input.Source.MessageRevision++
		hash := sha256.Sum256([]byte(content))
		input.Source.ContentHash = hex.EncodeToString(hash[:])
		response = playgroundRequest(t, 7, http.MethodPost, path+"/artifacts", input, controller.CreatePlaygroundArtifact)
		assert.Equal(t, 409, response.Code, response.Body.String())
	}
}

func TestPlaygroundArtifactCapacity(t *testing.T) {
	t.Run("version count and replay before capacity", func(t *testing.T) {
		playgroundTestDB(t, "sqlite")
		sessionID, input := playgroundArtifactSourceFixture(t, 7, "versions")
		path := "/api/playground/sessions/" + sessionID + "/artifacts"
		created := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact))
		path += "/" + created.Artifact.ID
		content := ""
		var last model.SavePlaygroundArtifactInput
		var saved model.PlaygroundArtifactResult
		for number := int64(2); number <= 100; number++ {
			revision := number - 1
			last = model.SavePlaygroundArtifactInput{RequestID: fmt.Sprintf("save-%d", number), ExpectedRevision: &revision, Title: "Empty document", Language: "markdown", Content: &content}
			saved = artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path+"/versions", last, controller.SavePlaygroundArtifactVersion))
		}
		assert.EqualValues(t, 100, saved.Version.Number)
		assert.Equal(t, saved, artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path+"/versions", last, controller.SavePlaygroundArtifactVersion)))
		revision := int64(100)
		last.RequestID, last.ExpectedRevision = "over-limit", &revision
		assert.Equal(t, 422, playgroundRequest(t, 7, http.MethodPost, path+"/versions", last, controller.SavePlaygroundArtifactVersion).Code)
		restore := model.RestorePlaygroundArtifactInput{RequestID: "restore-over-limit", ExpectedRevision: &revision, VersionID: created.Version.ID}
		assert.Equal(t, 422, playgroundRequest(t, 7, http.MethodPost, path+"/restore", restore, controller.RestorePlaygroundArtifactVersion).Code)
		assert.Equal(t, saved, artifactResult(t, playgroundRequest(t, 7, http.MethodGet, path, nil, controller.GetPlaygroundArtifact)))
	})
	t.Run("artifact and session byte budgets", func(t *testing.T) {
		playgroundTestDB(t, "sqlite")
		sessionID, input := playgroundArtifactSourceFixture(t, 7, "byte-budgets")
		path := "/api/playground/sessions/" + sessionID + "/artifacts"
		content := strings.Repeat("x", 256<<10)
		input.Content = &content
		var first model.PlaygroundArtifactResult
		for artifactNumber := range 4 {
			input.RequestID = fmt.Sprintf("create-%d", artifactNumber)
			created := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact))
			if artifactNumber == 0 {
				first = created
			}
			for number := int64(2); number <= 32; number++ {
				revision := number - 1
				save := model.SavePlaygroundArtifactInput{RequestID: fmt.Sprintf("save-%d", number), ExpectedRevision: &revision, Title: "Large", Language: "markdown", Content: &content}
				artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path+"/"+created.Artifact.ID+"/versions", save, controller.SavePlaygroundArtifactVersion))
			}
			// This artifact is exactly 8 MiB, below 100 versions.
			revision := int64(32)
			restore := model.RestorePlaygroundArtifactInput{RequestID: "too-many-bytes", ExpectedRevision: &revision, VersionID: created.Version.ID}
			assert.Equal(t, 422, playgroundRequest(t, 7, http.MethodPost, path+"/"+created.Artifact.ID+"/restore", restore, controller.RestorePlaygroundArtifactVersion).Code)
		}
		// Four full artifacts are exactly 32 MiB. A zero-byte snapshot fits;
		// either creating or saving one byte more must be rejected atomically.
		empty, one := "", "1"
		input.Content, input.RequestID = &empty, "empty-at-session-limit"
		created := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact))
		input.Content, input.RequestID = &one, "over-session-limit"
		assert.Equal(t, 422, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact).Code)
		revision := int64(1)
		save := model.SavePlaygroundArtifactInput{RequestID: "one-byte", ExpectedRevision: &revision, Title: "One", Language: "markdown", Content: &one}
		assert.Equal(t, 422, playgroundRequest(t, 7, http.MethodPost, path+"/"+created.Artifact.ID+"/versions", save, controller.SavePlaygroundArtifactVersion).Code)
		assert.Equal(t, 200, playgroundRequest(t, 7, http.MethodDelete, path+"/"+first.Artifact.ID+"?expected_revision=32", nil, controller.DeletePlaygroundArtifact).Code)
		// Deletion immediately frees body capacity, not the creation record.
		artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path+"/"+created.Artifact.ID+"/versions", save, controller.SavePlaygroundArtifactVersion))
	})
	t.Run("active artifacts", func(t *testing.T) {
		playgroundTestDB(t, "sqlite")
		sessionID, input := playgroundArtifactSourceFixture(t, 7, "active-budget")
		path := "/api/playground/sessions/" + sessionID + "/artifacts"
		var first model.PlaygroundArtifactResult
		var firstInput model.CreatePlaygroundArtifactInput
		for i := range 32 {
			input.RequestID = fmt.Sprintf("create-%d", i)
			created := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact))
			if i == 0 {
				first, firstInput = created, input
			}
		}
		input.RequestID = "over-active-limit"
		assert.Equal(t, 422, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact).Code)
		assert.Equal(t, first, artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, firstInput, controller.CreatePlaygroundArtifact)))
		assert.Equal(t, 200, playgroundRequest(t, 7, http.MethodDelete, path+"/"+first.Artifact.ID+"?expected_revision=1", nil, controller.DeletePlaygroundArtifact).Code)
		artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact))
	})
	t.Run("tombstones count toward creation budget", func(t *testing.T) {
		db := playgroundTestDB(t, "sqlite")
		sessionID, input := playgroundArtifactSourceFixture(t, 7, "creation-budget")
		path := "/api/playground/sessions/" + sessionID + "/artifacts"
		for i := range 256 {
			input.RequestID = fmt.Sprintf("create-%d", i)
			created := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact))
			response := playgroundRequest(t, 7, http.MethodDelete, path+"/"+created.Artifact.ID+"?expected_revision=1", nil, controller.DeletePlaygroundArtifact)
			require.Equal(t, 200, response.Code, response.Body.String())
		}
		assert.Equal(t, 404, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact).Code)
		input.RequestID = "over-record-limit"
		assert.Equal(t, 422, playgroundRequest(t, 7, http.MethodPost, path, input, controller.CreatePlaygroundArtifact).Code)
		var count int64
		require.NoError(t, db.Model(&model.PlaygroundArtifact{}).Count(&count).Error)
		assert.EqualValues(t, 256, count)
		require.NoError(t, db.Model(&model.PlaygroundArtifactVersion{}).Count(&count).Error)
		assert.Zero(t, count)
	})
}

func playgroundPNGFixture(size int) []byte {
	data := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
	for len(data) < size {
		data = append(data, byte(len(data)%251))
	}
	return data
}

// playgroundExtendedMediaFixtures returns one minimal sample per extended
// media type. Every sample carries the signature the server verifies, so the
// upload tests exercise the real sniffing rules instead of bypassing them.
func playgroundExtendedMediaFixtures() map[string][]byte {
	isoBaseMedia := func(brand string) []byte {
		return append([]byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p'}, brand...)
	}
	webm := []byte{0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00}
	webm = append(webm, []byte("docTypewebm")...)
	return map[string][]byte{
		"video/mp4":       isoBaseMedia("mp42"),
		"video/quicktime": isoBaseMedia("qt  "),
		"video/webm":      webm,
		"audio/mpeg":      append([]byte("ID3\x04\x00\x00\x00\x00\x00\x00"), []byte("audio")...),
		"audio/wav":       append([]byte("RIFF\x24\x00\x00\x00WAVEfmt "), []byte("audio")...),
		"audio/ogg":       append([]byte("OggS\x00\x02\x00\x00\x00\x00"), []byte("audio")...),
		"audio/mp4":       isoBaseMedia("M4A "),
		"application/pdf": []byte("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"),
	}
}

// playgroundMP3Fixture builds an ID3-tagged payload the audio validator
// accepts as audio/mpeg.
func playgroundMP3Fixture(size int) []byte {
	data := []byte("ID3")
	for len(data) < size {
		data = append(data, byte(len(data)%251))
	}
	return data
}

// playgroundPDFFixture builds a PDF with one content stream per entry, so the
// document tests upload bytes a real reader parses instead of a stub.
func playgroundPDFFixture(t *testing.T, streams ...string) []byte {
	t.Helper()
	var body strings.Builder
	body.WriteString("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	writeObject := func(id int, content string) {
		fmt.Fprintf(&body, "%d 0 obj\n%s\nendobj\n", id, content)
	}
	kids := make([]string, len(streams))
	for index := range streams {
		kids[index] = fmt.Sprintf("%d 0 R", 3+index*2)
	}
	writeObject(1, "<< /Type /Catalog /Pages 2 0 R >>")
	writeObject(2, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), len(streams)))
	for index, stream := range streams {
		pageID, contentID := 3+index*2, 4+index*2
		writeObject(pageID, fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R >>", contentID))
		fmt.Fprintf(&body, "%d 0 obj\n<< /Length %d >>\nstream\n%s\nendstream\nendobj\n", contentID, len(stream), stream)
	}
	body.WriteString("trailer\n<< /Root 1 0 R >>\n%%EOF\n")
	return []byte(body.String())
}

// usePlaygroundQuotaDefaults overrides the global resource budget for one test
// and restores it afterwards. The policy is the single source of the limits, so
// tests no longer reach into package variables.
func usePlaygroundQuotaDefaults(t *testing.T, mutate func(policy *playground_setting.PlaygroundQuotaPolicy)) {
	t.Helper()
	defaults := playground_setting.GetPlaygroundSetting().Defaults
	previous := *defaults
	mutate(defaults)
	t.Cleanup(func() { *defaults = previous })
}

// usePlaygroundGroupQuota sets one user group's override and restores it.
func usePlaygroundGroupQuota(t *testing.T, group string, override playground_setting.PlaygroundQuotaPolicy) {
	t.Helper()
	settings := playground_setting.GetPlaygroundSetting()
	previous, existed := settings.GroupOverrides[group]
	settings.GroupOverrides[group] = override
	t.Cleanup(func() {
		if existed {
			settings.GroupOverrides[group] = previous
			return
		}
		delete(settings.GroupOverrides, group)
	})
}

// usePlaygroundStorageBilling overrides the optional metered storage tier for
// one test and restores it afterwards, group free-allowance overrides included.
func usePlaygroundStorageBilling(t *testing.T, mutate func(setting *playground_setting.PlaygroundStorageBillingSetting)) {
	t.Helper()
	setting := playground_setting.GetPlaygroundStorageBillingSetting()
	previous := *setting
	previousGroupFreeGB := make(map[string]float64, len(setting.GroupFreeGB))
	for group, freeGB := range setting.GroupFreeGB {
		previousGroupFreeGB[group] = freeGB
	}
	mutate(setting)
	t.Cleanup(func() {
		*setting = previous
		setting.GroupFreeGB = previousGroupFreeGB
	})
}

func playgroundUploadAttachment(t *testing.T, user int, sessionID, clientKey, mediaType string, data []byte) map[string]any {
	t.Helper()
	response := playgroundRequest(t, user, http.MethodPost, "/api/playground/sessions/"+sessionID+"/attachments", map[string]any{
		"client_key": clientKey, "media_type": mediaType, "filename": "image.png",
		"data": base64.StdEncoding.EncodeToString(data),
	}, controller.CreatePlaygroundAttachment)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var envelope struct {
		Success bool
		Data    map[string]any
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, response.Body.String())
	return envelope.Data
}

// presigningUploadStore delegates every backend operation to a real store and
// adds the optional capabilities of an S3-style backend: a content-typed
// presigned PUT and a multipart abort that records the keys it aborted.
type presigningUploadStore struct {
	objectstore.Store
	location string
	aborted  []string
}

func (store *presigningUploadStore) PresignPutWithContentType(context.Context, string, string, time.Duration) (string, error) {
	return store.location, nil
}

func (store *presigningUploadStore) AbortMultipartUploads(_ context.Context, key string) error {
	store.aborted = append(store.aborted, key)
	return nil
}

// playgroundUploadResponseData decodes one upload endpoint response and asserts
// its status, so every step of the flow reads exactly like the client would.
func playgroundUploadResponseData(t *testing.T, response *httptest.ResponseRecorder, status int) map[string]any {
	t.Helper()
	require.Equal(t, status, response.Code, response.Body.String())
	var envelope struct {
		Success bool
		Data    map[string]any
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, response.Body.String())
	return envelope.Data
}

// playgroundReserveUpload posts one reservation and returns its response data.
func playgroundReserveUpload(t *testing.T, user int, body map[string]any, status int) map[string]any {
	t.Helper()
	return playgroundUploadResponseData(t, playgroundRequest(t, user, http.MethodPost, "/api/playground/uploads", body, controller.CreatePlaygroundUpload), status)
}

// playgroundUploadErrorCode asserts one failed upload response and its stable
// error code, which is what the client branches on.
func playgroundUploadErrorCode(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	require.Equal(t, status, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), code)
}

func TestPlaygroundAttachmentPersistenceMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.AttachmentMaxFileBytes, policy.AttachmentUserMaxBytes = 4096, 8192
			})
			session := createPlayground(t, 7, "attachments")
			id := session["id"].(string)
			png := playgroundPNGFixture(64)
			uploaded := playgroundUploadAttachment(t, 7, id, "file-1", "image/png", png)
			attachmentID, _ := uploaded["id"].(string)
			require.NotEmpty(t, attachmentID)
			assert.Equal(t, true, uploaded["created"])
			assert.EqualValues(t, len(png), uploaded["byte_size"])
			assert.Equal(t, "image/png", uploaded["media_type"])

			// New uploads keep only metadata in the database; the bytes live in
			// the object store under the key the row records.
			var stored model.PlaygroundAttachment
			require.NoError(t, db.Where("id = ?", attachmentID).First(&stored).Error)
			assert.Equal(t, system_setting.ObjectStoreBackendLocal, stored.StorageBackend)
			assert.True(t, strings.HasPrefix(stored.ObjectKey, "pg/7/attachment/"), stored.ObjectKey)
			assert.Nil(t, stored.Data)
			objectStore := objectstore.DefaultStore()
			require.NotNil(t, objectStore)
			objectReader, objectInfo, objectErr := objectStore.Get(context.Background(), stored.ObjectKey)
			require.NoError(t, objectErr)
			objectBytes, objectErr := io.ReadAll(objectReader)
			require.NoError(t, objectErr)
			require.NoError(t, objectReader.Close())
			assert.Equal(t, png, objectBytes)
			assert.EqualValues(t, len(png), objectInfo.Size)

			// Idempotent replay acknowledges the stored attachment; different
			// bytes under the same client key are a conflict.
			replay := playgroundUploadAttachment(t, 7, id, "file-1", "image/png", png)
			assert.Equal(t, attachmentID, replay["id"])
			assert.NotEqual(t, true, replay["created"])
			conflict := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+id+"/attachments", map[string]any{
				"client_key": "file-1", "media_type": "image/png",
				"data": base64.StdEncoding.EncodeToString(playgroundPNGFixture(65)),
			}, controller.CreatePlaygroundAttachment)
			assert.Equal(t, http.StatusConflict, conflict.Code, conflict.Body.String())

			// Metadata is listable without exposing stored bytes.
			listed := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments?page_size=50", nil, controller.ListPlaygroundAttachments)
			require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
			assert.Contains(t, listed.Body.String(), `"total":1`)
			assert.Contains(t, listed.Body.String(), attachmentID)
			assert.NotContains(t, listed.Body.String(), base64.StdEncoding.EncodeToString(png))
			invalidPage := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments?page_size=100", nil, controller.ListPlaygroundAttachments)
			assert.Equal(t, http.StatusBadRequest, invalidPage.Code)

			// Content is served byte-exact with the stored type and hardening headers.
			content := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments/"+attachmentID+"/content", nil, controller.GetPlaygroundAttachmentContent)
			require.Equal(t, http.StatusOK, content.Code)
			assert.Equal(t, png, content.Body.Bytes())
			assert.Equal(t, "image/png", content.Header().Get("Content-Type"))
			assert.Equal(t, "nosniff", content.Header().Get("X-Content-Type-Options"))
			assert.Contains(t, content.Header().Get("Content-Disposition"), "inline")

			// Another user or session never sees the attachment.
			for _, foreign := range []gin.HandlerFunc{controller.GetPlaygroundAttachment, controller.GetPlaygroundAttachmentContent} {
				foreignGet := playgroundRequest(t, 8, http.MethodGet, "/api/playground/sessions/"+id+"/attachments/"+attachmentID, nil, foreign)
				assert.Equal(t, http.StatusNotFound, foreignGet.Code)
			}
			other := createPlayground(t, 7, "attachments-other")
			otherID := other["id"].(string)
			crossSession := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+otherID+"/attachments/"+attachmentID, nil, controller.GetPlaygroundAttachment)
			assert.Equal(t, http.StatusNotFound, crossSession.Code)

			// The trashed conversation keeps its attachments and their stored
			// objects; purging it cascades into both.
			require.NoError(t, model.DeletePlaygroundSession(7, id))
			var count int64
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("session_id = ?", id).Count(&count).Error)
			assert.EqualValues(t, 1, count)
			_, objectErr = objectStore.Head(context.Background(), stored.ObjectKey)
			require.NoError(t, objectErr)
			require.NoError(t, model.PurgePlaygroundSession(7, id))
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("session_id = ?", id).Count(&count).Error)
			assert.Zero(t, count)
			_, objectErr = objectStore.Head(context.Background(), stored.ObjectKey)
			assert.ErrorIs(t, objectErr, objectstore.ErrObjectNotFound)
		})
	}
}

func TestPlaygroundAttachmentValidationLimits(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.AttachmentMaxFileBytes, policy.AttachmentUserMaxBytes = 4096, 8192
		policy.AttachmentVideoMaxFileBytes, policy.AttachmentAudioMaxFileBytes, policy.AttachmentDocumentMaxFileBytes = 4096, 4096, 4096
	})
	session := createPlayground(t, 7, "attachment-limits")
	id := session["id"].(string)
	path := "/api/playground/sessions/" + id + "/attachments"
	reject := func(name string, body map[string]any, status int) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			response := playgroundRequest(t, 7, http.MethodPost, path, body, controller.CreatePlaygroundAttachment)
			assert.Equal(t, status, response.Code, response.Body.String())
		})
	}
	png := playgroundPNGFixture(64)
	encoded := base64.StdEncoding.EncodeToString(png)
	reject("unsupported media type", map[string]any{"client_key": "a", "media_type": "application/json", "data": encoded}, http.StatusBadRequest)
	reject("mismatched media type", map[string]any{"client_key": "b", "media_type": "image/webp", "data": encoded}, http.StatusBadRequest)
	reject("invalid base64", map[string]any{"client_key": "c", "media_type": "image/png", "data": "not-base64!!"}, http.StatusBadRequest)
	reject("empty client key", map[string]any{"client_key": " ", "media_type": "image/png", "data": encoded}, http.StatusBadRequest)
	reject("oversized attachment", map[string]any{"client_key": "d", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(playgroundPNGFixture(4097))}, http.StatusUnprocessableEntity)
	reject("audio bytes under an image type", map[string]any{"client_key": "e", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(playgroundMP3Fixture(64))}, http.StatusBadRequest)
	reject("unsupported audio type", map[string]any{"client_key": "f", "media_type": "audio/flac", "data": base64.StdEncoding.EncodeToString(playgroundMP3Fixture(64))}, http.StatusBadRequest)

	// The per-account budget counts every stored byte, including replays of one file.
	playgroundUploadAttachment(t, 7, id, "budget-a", "image/png", playgroundPNGFixture(4096))
	playgroundUploadAttachment(t, 7, id, "budget-b", "image/png", playgroundPNGFixture(4096))
	reject("per-user byte budget", map[string]any{"client_key": "budget-c", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(playgroundPNGFixture(64))}, http.StatusUnprocessableEntity)

	// The extended kinds are accepted by the classic path as well, each with
	// its own signature check and per-kind size budget.
	fixtures := playgroundExtendedMediaFixtures()
	extendedSession := createPlayground(t, 8, "attachment-limits-extended")
	extendedPath := "/api/playground/sessions/" + extendedSession["id"].(string) + "/attachments"
	for mediaType, data := range fixtures {
		response := playgroundRequest(t, 8, http.MethodPost, extendedPath, map[string]any{
			"client_key": "extended-" + mediaType, "media_type": mediaType, "filename": "sample",
			"data": base64.StdEncoding.EncodeToString(data),
		}, controller.CreatePlaygroundAttachment)
		require.Equal(t, http.StatusOK, response.Code, mediaType+": "+response.Body.String())
	}
	// Bytes that only claim an extended type are rejected: the signature, not
	// the declared text, decides what may be stored.
	mismatched := playgroundRequest(t, 8, http.MethodPost, extendedPath, map[string]any{
		"client_key": "extended-mismatch", "media_type": "video/mp4",
		"data": base64.StdEncoding.EncodeToString(fixtures["video/webm"]),
	}, controller.CreatePlaygroundAttachment)
	assert.Equal(t, http.StatusBadRequest, mismatched.Code, mismatched.Body.String())
	// An extended kind above its own per-file budget is rejected even while the
	// account budget still has room.
	oversizedVideo := playgroundRequest(t, 8, http.MethodPost, extendedPath, map[string]any{
		"client_key": "extended-oversized", "media_type": "video/mp4",
		"data": base64.StdEncoding.EncodeToString(append(append([]byte{}, fixtures["video/mp4"]...), make([]byte, 4200)...)),
	}, controller.CreatePlaygroundAttachment)
	assert.Equal(t, http.StatusUnprocessableEntity, oversizedVideo.Code, oversizedVideo.Body.String())
}

// Documents contribute their text as chat context. The first read extracts and
// caches the outcome on the attachment row, and an unsupported, oversized,
// unreadable or text-free document answers with its stable code so the client
// keeps the attachment without its text.
func TestPlaygroundAttachmentDocumentText(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.AttachmentDocumentMaxFileBytes = 4096
		policy.DocumentTextMaxBytes, policy.DocumentTextMaxPages = 256, 2
	})
	session := createPlayground(t, 7, "document-text")
	id := session["id"].(string)
	base := "/api/playground/sessions/" + id + "/attachments"
	readText := func(t *testing.T, user int, attachmentID string) *httptest.ResponseRecorder {
		t.Helper()
		return playgroundRequest(t, user, http.MethodGet, base+"/"+attachmentID+"/text", nil, controller.GetPlaygroundAttachmentText)
	}
	textData := func(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var envelope struct {
			Success bool
			Data    map[string]any
		}
		require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
		require.True(t, envelope.Success, response.Body.String())
		return envelope.Data
	}

	// A text document is stored after the UTF-8 signature check and read back
	// with unified line endings. The extraction is cached on the row.
	plain := playgroundUploadAttachment(t, 7, id, "doc-plain", "text/plain", []byte("Hello document\r\nsecond line\r"))
	plainData := textData(t, readText(t, 7, plain["id"].(string)))
	assert.Equal(t, "Hello document\nsecond line", plainData["text"])
	assert.EqualValues(t, 0, plainData["page_count"])
	assert.EqualValues(t, len("Hello document\nsecond line"), plainData["byte_size"])
	var cached model.PlaygroundAttachment
	require.NoError(t, db.Where("id = ?", plain["id"].(string)).First(&cached).Error)
	assert.Equal(t, model.PlaygroundDocumentTextStatusReady, cached.TextStatus)
	assert.NotZero(t, cached.TextExtractedAt)
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", cached.ID).UpdateColumn("text_content", "cached answer").Error)
	assert.Equal(t, "cached answer", textData(t, readText(t, 7, cached.ID))["text"])

	// Markdown uses the same extractor, and a PDF contributes its page text and
	// page count.
	markdown := playgroundUploadAttachment(t, 7, id, "doc-markdown", "text/markdown", []byte("# Title\n\nBody\n"))
	assert.Equal(t, "# Title\n\nBody", textData(t, readText(t, 7, markdown["id"].(string)))["text"])
	pdf := playgroundUploadAttachment(t, 7, id, "doc-pdf", "application/pdf", playgroundPDFFixture(t,
		"BT (First page) Tj ET", "BT (Second page) Tj ET"))
	pdfData := textData(t, readText(t, 7, pdf["id"].(string)))
	assert.Equal(t, "First page\nSecond page", pdfData["text"])
	assert.EqualValues(t, 2, pdfData["page_count"])

	// The failure outcomes are stable codes as well: page count, text size,
	// media type, readability and an empty document each have their own. The
	// code stays the same on the cached second read.
	pages := playgroundUploadAttachment(t, 7, id, "doc-pages", "application/pdf", playgroundPDFFixture(t,
		"BT (One) Tj ET", "BT (Two) Tj ET", "BT (Three) Tj ET"))
	playgroundUploadErrorCode(t, readText(t, 7, pages["id"].(string)), http.StatusUnprocessableEntity, "PLAYGROUND_DOCUMENT_LIMIT_EXCEEDED")
	playgroundUploadErrorCode(t, readText(t, 7, pages["id"].(string)), http.StatusUnprocessableEntity, "PLAYGROUND_DOCUMENT_LIMIT_EXCEEDED")

	oversized := playgroundUploadAttachment(t, 7, id, "doc-oversized", "text/plain", []byte(strings.Repeat("x", 257)))
	playgroundUploadErrorCode(t, readText(t, 7, oversized["id"].(string)), http.StatusUnprocessableEntity, "PLAYGROUND_DOCUMENT_LIMIT_EXCEEDED")

	png := playgroundUploadAttachment(t, 7, id, "doc-image", "image/png", playgroundPNGFixture(64))
	playgroundUploadErrorCode(t, readText(t, 7, png["id"].(string)), http.StatusBadRequest, "PLAYGROUND_DOCUMENT_UNSUPPORTED")
	var unsupported model.PlaygroundAttachment
	require.NoError(t, db.Where("id = ?", png["id"].(string)).First(&unsupported).Error)
	assert.Equal(t, model.PlaygroundDocumentTextStatusUnsupported, unsupported.TextStatus)

	encrypted := playgroundUploadAttachment(t, 7, id, "doc-encrypted", "application/pdf", []byte("%PDF-1.7\n/Encrypt 9 0 R\ntrailer\n"))
	playgroundUploadErrorCode(t, readText(t, 7, encrypted["id"].(string)), http.StatusUnprocessableEntity, "PLAYGROUND_DOCUMENT_UNREADABLE")

	empty := playgroundUploadAttachment(t, 7, id, "doc-empty", "application/pdf", playgroundPDFFixture(t, "0 0 m 10 10 l S"))
	playgroundUploadErrorCode(t, readText(t, 7, empty["id"].(string)), http.StatusUnprocessableEntity, "PLAYGROUND_DOCUMENT_NO_TEXT")

	// Only the account that owns the attachment reads its text, and bytes that
	// are not UTF-8 text are rejected before the declared type is stored.
	assert.Equal(t, http.StatusNotFound, readText(t, 8, plain["id"].(string)).Code)
	binary := playgroundRequest(t, 7, http.MethodPost, base, map[string]any{
		"client_key": "doc-binary", "media_type": "text/plain",
		"data": base64.StdEncoding.EncodeToString([]byte{0xff, 0xfe, 0x00}),
	}, controller.CreatePlaygroundAttachment)
	assert.Equal(t, http.StatusBadRequest, binary.Code, binary.Body.String())
}

// The presigned upload flow reserves the account budgets before a byte moves,
// verifies the stored object server-side, and releases everything it reserved
// when an upload fails, is canceled or expires.
func TestPlaygroundUploadFlow(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			const fileBytes = 4096
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.AttachmentMaxFileBytes, policy.AttachmentUserMaxBytes = fileBytes, 4*fileBytes
				policy.AttachmentVideoMaxFileBytes, policy.AttachmentAudioMaxFileBytes, policy.AttachmentDocumentMaxFileBytes = fileBytes, fileBytes, fileBytes
			})
			session := createPlayground(t, 7, "uploads")
			sessionID := session["id"].(string)
			pdf := playgroundExtendedMediaFixtures()["application/pdf"]
			objectStore := objectstore.DefaultStore()
			require.NotNil(t, objectStore)
			uploadPath := func(uploadID string) string { return "/api/playground/uploads/" + uploadID }

			// A reservation answers with the relay mode on the local backend
			// (which cannot sign a direct upload), records the object key the
			// completing attachment will own, and holds the account budgets
			// before any byte exists.
			request := map[string]any{
				"client_key": "upload-relay", "media_type": "application/pdf", "filename": "notes.pdf",
				"byte_size": len(pdf), "session_id": sessionID,
			}
			reserved := playgroundReserveUpload(t, 7, request, http.StatusOK)
			assert.Equal(t, "relay", reserved["mode"])
			uploadID, _ := reserved["id"].(string)
			require.True(t, strings.HasPrefix(uploadID, "pgu_"), uploadID)
			var reservation model.PlaygroundUpload
			require.NoError(t, db.Where("id = ?", uploadID).First(&reservation).Error)
			assert.Equal(t, model.PlaygroundUploadPartitionSession, reservation.Partition)
			assert.Equal(t, sessionID, reservation.SessionID)
			assert.Equal(t, "application/pdf", reservation.MediaType)
			assert.True(t, strings.HasPrefix(reservation.ObjectKey, "pg/7/attachment/"), reservation.ObjectKey)
			var pending model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&pending).Error)
			assert.EqualValues(t, 1, pending.AttachmentPendingCount)
			assert.EqualValues(t, len(pdf), pending.AttachmentPendingBytes)
			assert.Zero(t, pending.AttachmentCount)

			// The same client key replays the reservation instead of reserving
			// the budgets twice; different content under it is a conflict.
			replayed := playgroundReserveUpload(t, 7, request, http.StatusOK)
			assert.Equal(t, uploadID, replayed["id"])
			var replayedPending model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&replayedPending).Error)
			assert.EqualValues(t, 1, replayedPending.AttachmentPendingCount)
			playgroundUploadErrorCode(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/uploads", map[string]any{
				"client_key": "upload-relay", "media_type": "application/pdf", "filename": "notes.pdf",
				"byte_size": len(pdf) + 1, "session_id": sessionID,
			}, controller.CreatePlaygroundUpload), http.StatusConflict, "PLAYGROUND_ATTACHMENT_REQUEST_CONFLICT")

			// The gateway relay stores the declared bytes under the reserved key.
			relayed := playgroundUploadResponseData(t, playgroundRequest(t, 7, http.MethodPut, uploadPath(uploadID)+"/content", pdf, controller.PutPlaygroundUploadContent), http.StatusOK)
			assert.EqualValues(t, len(pdf), relayed["byte_size"])
			head, headErr := objectStore.Head(context.Background(), reservation.ObjectKey)
			require.NoError(t, headErr)
			assert.EqualValues(t, len(pdf), head.Size)

			// Completing verifies size and signature, stores the attachment and
			// releases the reservation in one transaction.
			completed := playgroundUploadResponseData(t, playgroundRequest(t, 7, http.MethodPost, uploadPath(uploadID)+"/complete", nil, controller.CompletePlaygroundUpload), http.StatusOK)
			attachmentID, _ := completed["id"].(string)
			require.True(t, strings.HasPrefix(attachmentID, "pgf_"), attachmentID)
			assert.Equal(t, true, completed["created"])
			assert.Equal(t, "application/pdf", completed["media_type"])
			assert.EqualValues(t, len(pdf), completed["byte_size"])
			var gone model.PlaygroundUpload
			assert.ErrorIs(t, db.Where("id = ?", uploadID).First(&gone).Error, gorm.ErrRecordNotFound)
			var settled model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&settled).Error)
			assert.Zero(t, settled.AttachmentPendingCount)
			assert.Zero(t, settled.AttachmentPendingBytes)
			assert.EqualValues(t, 1, settled.AttachmentCount)
			assert.EqualValues(t, len(pdf), settled.AttachmentBytes)
			assert.EqualValues(t, len(pdf), settled.ObjectBytes)

			// The attachment serves its stored bytes through the content route.
			content := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+sessionID+"/attachments/"+attachmentID+"/content", nil, controller.GetPlaygroundAttachmentContent)
			require.Equal(t, http.StatusOK, content.Code, content.Body.String())
			assert.Equal(t, pdf, content.Body.Bytes())
			assert.Equal(t, "application/pdf", content.Header().Get("Content-Type"))

			// A client key that already finished answers with the attachment, so
			// a retry after a lost response never uploads the same file twice.
			finished := playgroundReserveUpload(t, 7, request, http.StatusOK)
			assert.Equal(t, "completed", finished["mode"])
			finishedAttachment, _ := finished["attachment"].(map[string]any)
			require.NotNil(t, finishedAttachment)
			assert.Equal(t, attachmentID, finishedAttachment["id"])

			// A relayed body that is not the declared size is dropped while the
			// reservation stays retryable; completing without the bytes then
			// fails and releases the reservation.
			shortID := playgroundReserveUpload(t, 7, map[string]any{
				"client_key": "upload-short", "media_type": "application/pdf", "filename": "short.pdf",
				"byte_size": len(pdf), "session_id": sessionID,
			}, http.StatusOK)["id"].(string)
			playgroundUploadErrorCode(t, playgroundRequest(t, 7, http.MethodPut, uploadPath(shortID)+"/content", pdf[:len(pdf)-4], controller.PutPlaygroundUploadContent), http.StatusUnprocessableEntity, "PLAYGROUND_UPLOAD_INCOMPLETE")
			var retryable model.PlaygroundUpload
			require.NoError(t, db.Where("id = ?", shortID).First(&retryable).Error)
			playgroundUploadErrorCode(t, playgroundRequest(t, 7, http.MethodPost, uploadPath(shortID)+"/complete", nil, controller.CompletePlaygroundUpload), http.StatusUnprocessableEntity, "PLAYGROUND_UPLOAD_INCOMPLETE")
			assert.ErrorIs(t, db.Where("id = ?", shortID).First(&retryable).Error, gorm.ErrRecordNotFound)

			// An object the gateway never relayed is verified all the same: a
			// stored size that does not match the reservation deletes the object
			// together with the reservation.
			mismatchID := playgroundReserveUpload(t, 7, map[string]any{
				"client_key": "upload-size-mismatch", "media_type": "application/pdf", "filename": "big.pdf",
				"byte_size": len(pdf) + 8, "session_id": sessionID,
			}, http.StatusOK)["id"].(string)
			var mismatchRow model.PlaygroundUpload
			require.NoError(t, db.Where("id = ?", mismatchID).First(&mismatchRow).Error)
			_, writeErr := objectStore.Put(context.Background(), mismatchRow.ObjectKey, bytes.NewReader(pdf))
			require.NoError(t, writeErr)
			playgroundUploadErrorCode(t, playgroundRequest(t, 7, http.MethodPost, uploadPath(mismatchID)+"/complete", nil, controller.CompletePlaygroundUpload), http.StatusUnprocessableEntity, "PLAYGROUND_UPLOAD_INCOMPLETE")
			_, mismatchHeadErr := objectStore.Head(context.Background(), mismatchRow.ObjectKey)
			assert.ErrorIs(t, mismatchHeadErr, objectstore.ErrObjectNotFound)
			assert.ErrorIs(t, db.Where("id = ?", mismatchID).First(&mismatchRow).Error, gorm.ErrRecordNotFound)

			// Bytes that are not the declared media type are rejected: a PDF can
			// never be stored as an image.
			fakeID := playgroundReserveUpload(t, 7, map[string]any{
				"client_key": "upload-type-mismatch", "media_type": "image/png", "filename": "fake.png",
				"byte_size": len(pdf), "session_id": sessionID,
			}, http.StatusOK)["id"].(string)
			var fakeRow model.PlaygroundUpload
			require.NoError(t, db.Where("id = ?", fakeID).First(&fakeRow).Error)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, uploadPath(fakeID)+"/content", pdf, controller.PutPlaygroundUploadContent).Code)
			playgroundUploadErrorCode(t, playgroundRequest(t, 7, http.MethodPost, uploadPath(fakeID)+"/complete", nil, controller.CompletePlaygroundUpload), http.StatusBadRequest, "PLAYGROUND_UPLOAD_CONTENT_MISMATCH")
			_, fakeHeadErr := objectStore.Head(context.Background(), fakeRow.ObjectKey)
			assert.ErrorIs(t, fakeHeadErr, objectstore.ErrObjectNotFound)
			assert.ErrorIs(t, db.Where("id = ?", fakeID).First(&fakeRow).Error, gorm.ErrRecordNotFound)

			// Canceling releases the reservation together with the bytes already
			// written, and a second cancel answers like a missing upload.
			cancelID := playgroundReserveUpload(t, 7, map[string]any{
				"client_key": "upload-cancel", "media_type": "application/pdf", "filename": "cancel.pdf",
				"byte_size": len(pdf), "session_id": sessionID,
			}, http.StatusOK)["id"].(string)
			var cancelRow model.PlaygroundUpload
			require.NoError(t, db.Where("id = ?", cancelID).First(&cancelRow).Error)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, uploadPath(cancelID)+"/content", pdf, controller.PutPlaygroundUploadContent).Code)
			canceled := playgroundUploadResponseData(t, playgroundRequest(t, 7, http.MethodDelete, uploadPath(cancelID), nil, controller.DeletePlaygroundUpload), http.StatusOK)
			assert.Equal(t, cancelID, canceled["id"])
			_, cancelHeadErr := objectStore.Head(context.Background(), cancelRow.ObjectKey)
			assert.ErrorIs(t, cancelHeadErr, objectstore.ErrObjectNotFound)
			assert.ErrorIs(t, db.Where("id = ?", cancelID).First(&cancelRow).Error, gorm.ErrRecordNotFound)
			playgroundUploadErrorCode(t, playgroundRequest(t, 7, http.MethodDelete, uploadPath(cancelID), nil, controller.DeletePlaygroundUpload), http.StatusNotFound, "PLAYGROUND_UPLOAD_NOT_FOUND")

			// Another account never sees, completes, relays to or cancels an
			// owned reservation, and the reservation survives those attempts.
			foreignID := playgroundReserveUpload(t, 7, map[string]any{
				"client_key": "upload-foreign", "media_type": "application/pdf", "filename": "foreign.pdf",
				"byte_size": len(pdf), "session_id": sessionID,
			}, http.StatusOK)["id"].(string)
			playgroundUploadErrorCode(t, playgroundRequest(t, 8, http.MethodPost, uploadPath(foreignID)+"/complete", nil, controller.CompletePlaygroundUpload), http.StatusNotFound, "PLAYGROUND_UPLOAD_NOT_FOUND")
			playgroundUploadErrorCode(t, playgroundRequest(t, 8, http.MethodPut, uploadPath(foreignID)+"/content", pdf, controller.PutPlaygroundUploadContent), http.StatusNotFound, "PLAYGROUND_UPLOAD_NOT_FOUND")
			playgroundUploadErrorCode(t, playgroundRequest(t, 8, http.MethodDelete, uploadPath(foreignID), nil, controller.DeletePlaygroundUpload), http.StatusNotFound, "PLAYGROUND_UPLOAD_NOT_FOUND")
			var untouched model.PlaygroundUpload
			require.NoError(t, db.Where("id = ?", foreignID).First(&untouched).Error)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, uploadPath(foreignID), nil, controller.DeletePlaygroundUpload).Code)

			// A reservation names exactly one partition, and the partition must
			// exist for the account before any budget can be reserved for it.
			for _, body := range []map[string]any{
				{"client_key": "upload-no-partition", "media_type": "application/pdf", "byte_size": len(pdf)},
				{
					"client_key": "upload-two-partitions", "media_type": "application/pdf", "byte_size": len(pdf),
					"session_id": sessionID, "canvas_id": "pgc_missing",
				},
			} {
				playgroundUploadErrorCode(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/uploads", body, controller.CreatePlaygroundUpload), http.StatusBadRequest, "PLAYGROUND_INVALID_REQUEST")
			}
			playgroundUploadErrorCode(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/uploads", map[string]any{
				"client_key": "upload-missing-session", "media_type": "application/pdf", "byte_size": len(pdf),
				"session_id": "pgs_missing",
			}, controller.CreatePlaygroundUpload), http.StatusNotFound, "PLAYGROUND_NOT_FOUND")

			// A canvas reservation locks the project row and files the eventual
			// attachment under the canvas partition.
			canvas := createCanvasProject(t, 7, "upload-canvas")
			canvasID, _ := canvas["id"].(string)
			require.NotEmpty(t, canvasID)
			clip := playgroundExtendedMediaFixtures()["video/mp4"]
			canvasUploadID := playgroundReserveUpload(t, 7, map[string]any{
				"client_key": "upload-canvas", "media_type": "video/mp4", "filename": "clip.mp4",
				"byte_size": len(clip), "canvas_id": canvasID,
			}, http.StatusOK)["id"].(string)
			var canvasRow model.PlaygroundUpload
			require.NoError(t, db.Where("id = ?", canvasUploadID).First(&canvasRow).Error)
			assert.Equal(t, model.PlaygroundUploadPartitionCanvas, canvasRow.Partition)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, uploadPath(canvasUploadID)+"/content", clip, controller.PutPlaygroundUploadContent).Code)
			canvasCompleted := playgroundUploadResponseData(t, playgroundRequest(t, 7, http.MethodPost, uploadPath(canvasUploadID)+"/complete", nil, controller.CompletePlaygroundUpload), http.StatusOK)
			assert.Equal(t, canvasID, canvasCompleted["session_id"])
			assert.Equal(t, "video/mp4", canvasCompleted["media_type"])
			canvasContent := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+canvasID+"/attachments/"+canvasCompleted["id"].(string)+"/content", nil, controller.GetPlaygroundAttachmentContent)
			require.Equal(t, http.StatusOK, canvasContent.Code, canvasContent.Body.String())
			assert.Equal(t, clip, canvasContent.Body.Bytes())

			// Pending reservations count against the account byte budget: only
			// as many 4096-byte uploads fit as the remaining budget allows, and
			// the next reservation is rejected before any byte moves.
			limit := playground_setting.GetPlaygroundSetting().Defaults.AttachmentUserMaxBytes
			var settledBytes model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&settledBytes).Error)
			require.Zero(t, settledBytes.AttachmentPendingBytes)
			fitting := int((limit - settledBytes.AttachmentBytes) / fileBytes)
			require.Positive(t, fitting)
			held := make([]string, 0, fitting)
			for index := range fitting {
				held = append(held, playgroundReserveUpload(t, 7, map[string]any{
					"client_key": fmt.Sprintf("upload-budget-%d", index), "media_type": "application/pdf",
					"filename": "budget.pdf", "byte_size": fileBytes, "session_id": sessionID,
				}, http.StatusOK)["id"].(string))
			}
			playgroundUploadErrorCode(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/uploads", map[string]any{
				"client_key": "upload-budget-over", "media_type": "application/pdf",
				"filename": "budget.pdf", "byte_size": fileBytes, "session_id": sessionID,
			}, controller.CreatePlaygroundUpload), http.StatusUnprocessableEntity, "PLAYGROUND_ATTACHMENT_LIMIT_EXCEEDED")
			for _, heldID := range held {
				require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, uploadPath(heldID), nil, controller.DeletePlaygroundUpload).Code)
			}

			// An abandoned reservation is released by the scheduled cleanup
			// together with the bytes the client already wrote, and its quota
			// returns to the account.
			expiringID := playgroundReserveUpload(t, 7, map[string]any{
				"client_key": "upload-expiring", "media_type": "application/pdf", "filename": "stale.pdf",
				"byte_size": len(pdf), "session_id": sessionID,
			}, http.StatusOK)["id"].(string)
			var expiringRow model.PlaygroundUpload
			require.NoError(t, db.Where("id = ?", expiringID).First(&expiringRow).Error)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, uploadPath(expiringID)+"/content", pdf, controller.PutPlaygroundUploadContent).Code)
			require.NoError(t, db.Model(&model.PlaygroundUpload{}).Where("id = ?", expiringID).
				UpdateColumn("expires_at", common.GetTimestamp()-1).Error)
			released, err := model.DeleteExpiredPlaygroundUploads(common.GetTimestamp(), 10)
			require.NoError(t, err)
			assert.EqualValues(t, 1, released)
			var expired model.PlaygroundUpload
			assert.ErrorIs(t, db.Where("id = ?", expiringID).First(&expired).Error, gorm.ErrRecordNotFound)
			_, expiredHeadErr := objectStore.Head(context.Background(), expiringRow.ObjectKey)
			assert.ErrorIs(t, expiredHeadErr, objectstore.ErrObjectNotFound)
			var afterCleanup model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&afterCleanup).Error)
			assert.Zero(t, afterCleanup.AttachmentPendingCount)
			assert.Zero(t, afterCleanup.AttachmentPendingBytes)

			// A backend that can sign a direct upload answers with the presigned
			// mode; the client writes straight to the object store and the
			// completion still verifies the stored bytes server-side.
			direct := &presigningUploadStore{Store: objectStore, location: "https://objects.example.test/uploads/signed?signature=test"}
			objectstore.SetDefaultStore(direct, 5*time.Minute)
			t.Cleanup(func() { objectstore.SetDefaultStore(objectStore, time.Minute) })
			presigned := playgroundReserveUpload(t, 7, map[string]any{
				"client_key": "upload-presigned", "media_type": "video/mp4", "filename": "clip.mp4",
				"byte_size": len(clip), "session_id": sessionID,
			}, http.StatusOK)
			assert.Equal(t, "presigned", presigned["mode"])
			assert.Equal(t, direct.location, presigned["url"])
			headers, _ := presigned["headers"].(map[string]any)
			require.NotNil(t, headers)
			assert.Equal(t, "video/mp4", headers["Content-Type"])
			presignedID := presigned["id"].(string)
			var presignedRow model.PlaygroundUpload
			require.NoError(t, db.Where("id = ?", presignedID).First(&presignedRow).Error)
			_, directErr := objectStore.Put(context.Background(), presignedRow.ObjectKey, bytes.NewReader(clip))
			require.NoError(t, directErr)
			presignedCompleted := playgroundUploadResponseData(t, playgroundRequest(t, 7, http.MethodPost, uploadPath(presignedID)+"/complete", nil, controller.CompletePlaygroundUpload), http.StatusOK)
			assert.Equal(t, "video/mp4", presignedCompleted["media_type"])

			// Releasing a reservation aborts any in-progress multipart upload
			// that still targets its key.
			abortedBefore := len(direct.aborted)
			multipartID := playgroundReserveUpload(t, 7, map[string]any{
				"client_key": "upload-multipart", "media_type": "video/mp4", "filename": "clip.mp4",
				"byte_size": len(clip), "session_id": sessionID,
			}, http.StatusOK)["id"].(string)
			var multipartRow model.PlaygroundUpload
			require.NoError(t, db.Where("id = ?", multipartID).First(&multipartRow).Error)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, uploadPath(multipartID), nil, controller.DeletePlaygroundUpload).Code)
			require.Greater(t, len(direct.aborted), abortedBefore)
			assert.Contains(t, direct.aborted[abortedBefore:], multipartRow.ObjectKey)
		})
	}
}

func TestPlaygroundAttachmentMessageReferences(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	session := createPlayground(t, 7, "attachment-references")
	id := session["id"].(string)
	path := "/api/playground/sessions/" + id + "/messages"
	png := playgroundPNGFixture(64)
	first := playgroundUploadAttachment(t, 7, id, "ref-a", "image/png", png)
	second := playgroundUploadAttachment(t, 7, id, "ref-b", "image/png", png)
	firstID, secondID := first["id"].(string), second["id"].(string)
	var firstRow, secondRow model.PlaygroundAttachment
	require.NoError(t, db.Where("id = ?", firstID).First(&firstRow).Error)
	require.NoError(t, db.Where("id = ?", secondID).First(&secondRow).Error)
	objectStore := objectstore.DefaultStore()
	require.NotNil(t, objectStore)

	message := func(key string, from string, attachments []map[string]any) map[string]any {
		version := map[string]any{"id": key + "-v1", "content": "look at this"}
		if attachments != nil {
			version["attachments"] = attachments
		}
		return map[string]any{"client_key": key, "payload": map[string]any{"key": key, "from": from, "versions": []any{version}}}
	}

	// Referencing an owned attachment stores the normalized metadata.
	response := playgroundRequest(t, 7, http.MethodPut, path, map[string]any{
		"revision": 0, "messages": []any{message("u1", "user", []map[string]any{{"id": firstID, "media_type": "text/plain", "filename": "spoofed"}})},
	}, controller.ReplacePlaygroundMessages)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), firstID)
	assert.Contains(t, response.Body.String(), `"media_type":"image/png"`)
	assert.Contains(t, response.Body.String(), `"filename":"image.png"`)
	assert.NotContains(t, response.Body.String(), "spoofed")

	// A referenced attachment cannot be deleted; an unrelated one still can,
	// and deleting it removes its stored object.
	inUse := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id+"/attachments/"+firstID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusConflict, inUse.Code, inUse.Body.String())
	_, objectErr := objectStore.Head(context.Background(), firstRow.ObjectKey)
	require.NoError(t, objectErr, "a referenced attachment keeps its object")
	unused := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id+"/attachments/"+secondID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusOK, unused.Code, unused.Body.String())
	_, objectErr = objectStore.Head(context.Background(), secondRow.ObjectKey)
	assert.ErrorIs(t, objectErr, objectstore.ErrObjectNotFound)
	missing := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id+"/attachments/"+secondID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusNotFound, missing.Code)

	// Dropping the reference releases the attachment for deletion.
	response = playgroundRequest(t, 7, http.MethodPut, path, map[string]any{"revision": 1, "messages": []any{}}, controller.ReplacePlaygroundMessages)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	released := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id+"/attachments/"+firstID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusOK, released.Code, released.Body.String())
	_, objectErr = objectStore.Head(context.Background(), firstRow.ObjectKey)
	assert.ErrorIs(t, objectErr, objectstore.ErrObjectNotFound)

	// Invalid references never replace the stored history.
	kept := playgroundRequest(t, 7, http.MethodPut, path, map[string]any{"revision": 2, "messages": []any{message("u2", "user", []map[string]any{{"id": firstID}})}}, controller.ReplacePlaygroundMessages)
	assert.Equal(t, http.StatusBadRequest, kept.Code, kept.Body.String())
	unknown := playgroundRequest(t, 7, http.MethodPut, path, map[string]any{"revision": 2, "messages": []any{message("u3", "user", []map[string]any{{"id": "pgf_missing"}})}}, controller.ReplacePlaygroundMessages)
	assert.Equal(t, http.StatusBadRequest, unknown.Code)
	assistant := playgroundUploadAttachment(t, 7, id, "ref-c", "image/png", png)
	assistantID := assistant["id"].(string)
	roleRejected := playgroundRequest(t, 7, http.MethodPut, path, map[string]any{"revision": 2, "messages": []any{message("a1", "assistant", []map[string]any{{"id": assistantID}})}}, controller.ReplacePlaygroundMessages)
	assert.Equal(t, http.StatusBadRequest, roleRejected.Code)
	manyLimit := playground_setting.GetPlaygroundQuotaPolicy("default").AttachmentMaxCount
	many := make([]map[string]any, 0, manyLimit+1)
	for index := range manyLimit + 1 {
		many = append(many, map[string]any{"id": fmt.Sprintf("pgf_%d", index)})
	}
	tooMany := playgroundRequest(t, 7, http.MethodPut, path, map[string]any{"revision": 2, "messages": []any{message("u4", "user", many)}}, controller.ReplacePlaygroundMessages)
	assert.Equal(t, http.StatusBadRequest, tooMany.Code)
	// A brand-new session cannot reference attachments that only exist in another one.
	create := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions", map[string]any{
		"client_id": "attachment-create", "messages": []any{message("u5", "user", []map[string]any{{"id": assistantID}})},
	}, controller.CreatePlaygroundSession)
	assert.Equal(t, http.StatusBadRequest, create.Code, create.Body.String())

	// The failed replacements never touched the stored snapshot.
	var stored int64
	require.NoError(t, db.Model(&model.PlaygroundMessage{}).Where("session_id = ?", id).Count(&stored).Error)
	assert.Zero(t, stored)
}

// Playground message speech references are the cached read-aloud audio of a
// user or assistant reply. They follow the attachment reference contract: only
// an owned id is accepted, the stored metadata always comes from the row, and
// a lingering reference keeps the audio bytes alive.
func TestPlaygroundMessageSpeechReferences(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	session := createPlayground(t, 7, "speech-references")
	id := session["id"].(string)
	path := "/api/playground/sessions/" + id + "/messages"
	speech := playgroundUploadAttachment(t, 7, id, "speech-a", "audio/mpeg", playgroundMP3Fixture(64))
	speechID := speech["id"].(string)

	message := func(key, from string, version map[string]any) map[string]any {
		return map[string]any{"client_key": key, "payload": map[string]any{"key": key, "from": from, "versions": []any{version}}}
	}

	// An assistant reply keeps its cached read-aloud audio; the stored
	// reference carries the owned metadata, not the client's claims.
	response := playgroundRequest(t, 7, http.MethodPut, path, map[string]any{
		"revision": 0,
		"messages": []any{message("a1", "assistant", map[string]any{
			"id": "a1-v1", "content": "Read this aloud",
			"speech": map[string]any{"id": speechID, "media_type": "text/plain", "filename": "spoofed.mp3"},
		})},
	}, controller.ReplacePlaygroundMessages)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), speechID)
	assert.Contains(t, response.Body.String(), `"media_type":"audio/mpeg"`)
	assert.NotContains(t, response.Body.String(), "spoofed.mp3")

	// The cached audio is a real reference: the attachment cannot be deleted.
	inUse := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id+"/attachments/"+speechID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusConflict, inUse.Code, inUse.Body.String())

	// A system message can never carry speech, and an unowned id is rejected
	// without replacing the stored history.
	systemRejected := playgroundRequest(t, 7, http.MethodPut, path, map[string]any{
		"revision": 1,
		"messages": []any{message("s1", "system", map[string]any{"id": "s1-v1", "content": "Read this aloud", "speech": map[string]any{"id": speechID}})},
	}, controller.ReplacePlaygroundMessages)
	assert.Equal(t, http.StatusBadRequest, systemRejected.Code)
	unknownRejected := playgroundRequest(t, 7, http.MethodPut, path, map[string]any{
		"revision": 1,
		"messages": []any{message("a2", "assistant", map[string]any{"id": "a2-v1", "content": "Read this aloud", "speech": map[string]any{"id": "pgf_missing"}})},
	}, controller.ReplacePlaygroundMessages)
	assert.Equal(t, http.StatusBadRequest, unknownRejected.Code)

	// Dropping the reference releases the audio for deletion.
	released := playgroundRequest(t, 7, http.MethodPut, path, map[string]any{
		"revision": 1,
		"messages": []any{message("a1", "assistant", map[string]any{"id": "a1-v1", "content": "Read this aloud"})},
	}, controller.ReplacePlaygroundMessages)
	require.Equal(t, http.StatusOK, released.Code, released.Body.String())
	deleted := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id+"/attachments/"+speechID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())

	var stored int64
	require.NoError(t, db.Model(&model.PlaygroundMessage{}).Where("session_id = ?", id).Count(&stored).Error)
	assert.EqualValues(t, 1, stored)
}

func TestPlaygroundAttachmentOrphanCleanup(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	session := createPlayground(t, 7, "attachment-cleanup")
	id := session["id"].(string)
	png := playgroundPNGFixture(64)
	orphan := playgroundUploadAttachment(t, 7, id, "cleanup-a", "image/png", png)
	referenced := playgroundUploadAttachment(t, 7, id, "cleanup-b", "image/png", png)
	orphanID, referencedID := orphan["id"].(string), referenced["id"].(string)
	var orphanRow, referencedRow model.PlaygroundAttachment
	require.NoError(t, db.Where("id = ?", orphanID).First(&orphanRow).Error)
	require.NoError(t, db.Where("id = ?", referencedID).First(&referencedRow).Error)
	response := playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+id+"/messages", map[string]any{
		"revision": 0, "messages": []any{map[string]any{"client_key": "u1", "payload": map[string]any{
			"key": "u1", "from": "user", "versions": []any{map[string]any{"id": "v1", "content": "keep", "attachments": []any{map[string]any{"id": referencedID}}}},
		}}},
	}, controller.ReplacePlaygroundMessages)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	// Age both rows: only the unreferenced one may be collected, and its stored
	// object goes with it while the referenced attachment keeps its bytes.
	now := common.GetTimestamp()
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("session_id = ?", id).Update("updated_at", now-100000).Error)
	deleted, err := model.DeleteOrphanedPlaygroundAttachments(now-3600, 100)
	require.NoError(t, err)
	assert.EqualValues(t, 1, deleted)
	var remaining []model.PlaygroundAttachment
	require.NoError(t, db.Where("session_id = ?", id).Find(&remaining).Error)
	require.Len(t, remaining, 1)
	assert.Equal(t, referencedID, remaining[0].ID)
	_, err = model.GetPlaygroundAttachment(7, id, orphanID)
	assert.ErrorIs(t, err, model.ErrPlaygroundAttachmentNotFound)
	objectStore := objectstore.DefaultStore()
	require.NotNil(t, objectStore)
	_, objectErr := objectStore.Head(context.Background(), orphanRow.ObjectKey)
	assert.ErrorIs(t, objectErr, objectstore.ErrObjectNotFound)
	_, objectErr = objectStore.Head(context.Background(), referencedRow.ObjectKey)
	require.NoError(t, objectErr)
}

// insertLegacyPlaygroundAttachment writes a row the way releases before the
// object store did: the canonical base64 payload lives in data and the row is
// marked database-backed.
func insertLegacyPlaygroundAttachment(t *testing.T, db *gorm.DB, userID int, sessionID, id string, data []byte, createdAt int64) model.PlaygroundAttachment {
	t.Helper()
	encoded := model.LongText(base64.StdEncoding.EncodeToString(data))
	row := model.PlaygroundAttachment{
		ID: id, UserID: userID, SessionID: sessionID,
		MediaType: "image/png", Filename: "legacy.png",
		ByteSize: int64(len(data)), ContentHash: playgroundContentHashHex(data),
		ClientKeyHash:  playgroundContentHashHex([]byte("client-" + id)),
		StorageBackend: system_setting.ObjectStoreBackendDB,
		Data:           &encoded,
		CreatedAt:      createdAt, UpdatedAt: createdAt,
	}
	require.NoError(t, db.Create(&row).Error)
	return row
}

// presigningPlaygroundStore delegates every backend operation to a real store
// and only overrides PresignGet, so one test can exercise an S3-style backend
// without the S3 implementation.
type presigningPlaygroundStore struct {
	objectstore.Store
	location string
	err      error
}

func (store presigningPlaygroundStore) PresignGet(context.Context, string, time.Duration) (string, error) {
	return store.location, store.err
}

// Attachment content is served from its storage backend: object-backed rows
// stream through the gateway, presign-capable backends redirect with a
// short-lived link, and rows written before the object store existed are still
// served from their inline payload.
func TestPlaygroundAttachmentObjectStoreContentServing(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	session := createPlayground(t, 7, "attachment-serving")
	id := session["id"].(string)
	png := playgroundPNGFixture(64)
	objectStore := objectstore.DefaultStore()
	require.NotNil(t, objectStore)

	uploaded := playgroundUploadAttachment(t, 7, id, "serving-object", "image/png", png)
	objectID := uploaded["id"].(string)
	content := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments/"+objectID+"/content", nil, controller.GetPlaygroundAttachmentContent)
	require.Equal(t, http.StatusOK, content.Code, content.Body.String())
	assert.Equal(t, png, content.Body.Bytes())
	assert.Equal(t, "image/png", content.Header().Get("Content-Type"))
	assert.Equal(t, "nosniff", content.Header().Get("X-Content-Type-Options"))
	assert.Equal(t, "private, no-store", content.Header().Get("Cache-Control"))

	// A pre-migration row is served from the database until the background
	// migration moves it.
	legacyData := playgroundPNGFixture(32)
	legacy := insertLegacyPlaygroundAttachment(t, db, 7, id, "pgf_legacy-serving", legacyData, common.GetTimestamp())
	legacyContent := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments/"+legacy.ID+"/content", nil, controller.GetPlaygroundAttachmentContent)
	require.Equal(t, http.StatusOK, legacyContent.Code, legacyContent.Body.String())
	assert.Equal(t, legacyData, legacyContent.Body.Bytes())

	// An S3-style backend hands the browser a short-lived presigned URL.
	presigned := presigningPlaygroundStore{Store: objectStore, location: "https://objects.example.test/attachments/presigned?signature=test"}
	objectstore.SetDefaultStore(presigned, 5*time.Minute)
	redirect := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments/"+objectID+"/content", nil, controller.GetPlaygroundAttachmentContent)
	require.Equal(t, http.StatusFound, redirect.Code, redirect.Body.String())
	assert.Equal(t, presigned.location, redirect.Header().Get("Location"))
	assert.Equal(t, "private, no-store", redirect.Header().Get("Cache-Control"))

	// A presign failure falls back to gateway streaming; a backend that does
	// not presign at all (the local backend) never redirects.
	objectstore.SetDefaultStore(presigningPlaygroundStore{Store: objectStore, err: objectstore.ErrPresignUnsupported}, time.Minute)
	fallback := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments/"+objectID+"/content", nil, controller.GetPlaygroundAttachmentContent)
	require.Equal(t, http.StatusOK, fallback.Code, fallback.Body.String())
	assert.Equal(t, png, fallback.Body.Bytes())

	// Only absolute http(s) locations are trusted as redirect targets.
	objectstore.SetDefaultStore(presigningPlaygroundStore{Store: objectStore, location: "javascript:alert(1)"}, time.Minute)
	untrusted := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments/"+objectID+"/content", nil, controller.GetPlaygroundAttachmentContent)
	require.Equal(t, http.StatusOK, untrusted.Code, untrusted.Body.String())
	assert.Equal(t, png, untrusted.Body.Bytes())
	objectstore.SetDefaultStore(objectStore, time.Minute)
}

// The background migration moves database-backed bytes into the object store
// after verifying the content hash, keeps corrupt rows untouched for a later
// retry, and the rollback path restores database bytes and removes the
// objects.
func TestPlaygroundAttachmentObjectStoreMigration(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	store := objectstore.DefaultStore()
	require.NotNil(t, store)
	session := createPlayground(t, 7, "attachment-migration")
	id := session["id"].(string)
	png := playgroundPNGFixture(48)
	legacy := insertLegacyPlaygroundAttachment(t, db, 7, id, "pgf_legacy-migrate", png, 1_700_000_000)
	brokenData := playgroundPNGFixture(16)
	broken := insertLegacyPlaygroundAttachment(t, db, 7, id, "pgf_legacy-broken", brokenData, 1_700_000_100)
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", broken.ID).UpdateColumn("content_hash", strings.Repeat("0", 64)).Error)

	result, err := model.MigratePlaygroundAttachmentsToObjectStore(store, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, result.Moved)
	assert.EqualValues(t, 1, result.Failed)

	row, err := model.GetPlaygroundAttachment(7, id, legacy.ID)
	require.NoError(t, err)
	assert.Equal(t, system_setting.ObjectStoreBackendLocal, row.StorageBackend)
	assert.True(t, strings.HasPrefix(row.ObjectKey, "pg/7/attachment/"), row.ObjectKey)
	assert.Nil(t, row.Data)
	reader, _, err := store.Get(context.Background(), row.ObjectKey)
	require.NoError(t, err)
	body, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.NoError(t, reader.Close())
	assert.Equal(t, png, body)

	// The corrupt row keeps its payload and stays retryable.
	brokenRow, err := model.GetPlaygroundAttachment(7, id, broken.ID)
	require.NoError(t, err)
	assert.True(t, brokenRow.StoredInDatabase())
	require.NotNil(t, brokenRow.Data)
	assert.Equal(t, base64.StdEncoding.EncodeToString(brokenData), string(*brokenRow.Data))
	_, headErr := store.Head(context.Background(), row.ObjectKey)
	require.NoError(t, headErr)

	// Migrated content is still served byte-exact.
	content := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments/"+legacy.ID+"/content", nil, controller.GetPlaygroundAttachmentContent)
	require.Equal(t, http.StatusOK, content.Code, content.Body.String())
	assert.Equal(t, png, content.Body.Bytes())

	// Once the metadata is fixed the next run migrates the retried row.
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", broken.ID).UpdateColumn("content_hash", playgroundContentHashHex(brokenData)).Error)
	result, err = model.MigratePlaygroundAttachmentsToObjectStore(store, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 1, result.Moved)
	assert.Zero(t, result.Failed)

	// The rollback path restores database bytes and deletes the objects, so a
	// downgrade can read every attachment.
	result, err = model.RestorePlaygroundAttachmentsToDatabase(store, 10)
	require.NoError(t, err)
	assert.EqualValues(t, 2, result.Moved)
	restored, err := model.GetPlaygroundAttachment(7, id, legacy.ID)
	require.NoError(t, err)
	assert.True(t, restored.StoredInDatabase())
	require.NotNil(t, restored.Data)
	assert.Equal(t, base64.StdEncoding.EncodeToString(png), string(*restored.Data))
	_, headErr = store.Head(context.Background(), row.ObjectKey)
	assert.ErrorIs(t, headErr, objectstore.ErrObjectNotFound)
	content = playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments/"+legacy.ID+"/content", nil, controller.GetPlaygroundAttachmentContent)
	require.Equal(t, http.StatusOK, content.Code, content.Body.String())
	assert.Equal(t, png, content.Body.Bytes())
}

// The asset library lists the owner's attachments and artifacts with a kind
// filter, literal filename/title search and pagination. Responses carry
// metadata only, and in_use mirrors the deletion guards the server enforces.
func TestPlaygroundAssetLibraryListing(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			session := createPlayground(t, 7, "asset-library")
			sessionID := session["id"].(string)
			png := playgroundPNGFixture(64)
			referenced := playgroundUploadAttachment(t, 7, sessionID, "asset-ref", "image/png", png)
			pinned := playgroundUploadAttachment(t, 7, sessionID, "asset-pin", "image/png", png)
			free := playgroundUploadAttachment(t, 7, sessionID, "asset-free", "image/png", png)
			referencedID, pinnedID, freeID := referenced["id"].(string), pinned["id"].(string), free["id"].(string)

			// Distinct filenames and upload times keep search and pagination
			// deterministic even when the uploads share one timestamp.
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", referencedID).
				Updates(map[string]any{"filename": "Studio Sunset.PNG", "created_at": 100, "updated_at": 100}).Error)
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", pinnedID).
				Updates(map[string]any{"filename": "campaign-map.png", "created_at": 200, "updated_at": 200}).Error)
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", freeID).
				Updates(map[string]any{"filename": "notes.png", "created_at": 300, "updated_at": 300}).Error)

			// A message reference and a canvas pin each mark one attachment in
			// use; the third attachment stays deletable.
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+sessionID+"/messages", map[string]any{
				"revision": 0, "messages": []any{map[string]any{"client_key": "m1", "payload": map[string]any{
					"key": "m1", "from": "user", "versions": []any{map[string]any{"id": "v1", "content": "see image", "attachments": []any{map[string]any{"id": referencedID}}}},
				}}},
			}, controller.ReplacePlaygroundMessages).Code)
			canvasEnvelope(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
				"title":    "Pins",
				"document": canvasDocument([]any{canvasRefNode("a1", "attachment", map[string]any{"sessionId": sessionID, "attachmentId": pinnedID})}, nil),
			}, controller.CreatePlaygroundCanvasProject).Body.Bytes())

			// One live artifact and one tombstone: only the live one is listable.
			artifactSession, artifactInput := playgroundArtifactSourceFixture(t, 7, "asset-artifact")
			artifactPath := "/api/playground/sessions/" + artifactSession + "/artifacts"
			live := artifactInput
			live.Title = "Sunset Report"
			liveArtifact := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, artifactPath, live, controller.CreatePlaygroundArtifact))
			tombstone := artifactInput
			tombstone.RequestID, tombstone.Title = "create_2", "Chart"
			tombstoneArtifact := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, artifactPath, tombstone, controller.CreatePlaygroundArtifact))
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, artifactPath+"/"+tombstoneArtifact.Artifact.ID+"?expected_revision=1", nil, controller.DeletePlaygroundArtifact).Code)

			// Another account's assets never appear in this account's library.
			foreignSession := createPlayground(t, 8, "asset-library-foreign")
			foreignUpload := playgroundUploadAttachment(t, 8, foreignSession["id"].(string), "asset-foreign", "image/png", png)
			foreignArtifactSession, foreignArtifactInput := playgroundArtifactSourceFixture(t, 8, "asset-artifact-foreign")
			artifactResult(t, playgroundRequest(t, 8, http.MethodPost, "/api/playground/sessions/"+foreignArtifactSession+"/artifacts", foreignArtifactInput, controller.CreatePlaygroundArtifact))

			type assetListing struct {
				Data struct {
					Items []map[string]any
					Total int
				}
			}
			list := func(user int, query string) assetListing {
				t.Helper()
				response := playgroundRequest(t, user, http.MethodGet, "/api/playground/assets?"+query, nil, controller.ListPlaygroundAssets)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				var listing assetListing
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &listing))
				return listing
			}

			attachments := list(7, "kind=attachment&page_size=50")
			require.Equal(t, 3, attachments.Data.Total)
			require.Len(t, attachments.Data.Items, 3)
			byID := map[string]map[string]any{}
			for _, item := range attachments.Data.Items {
				byID[item["id"].(string)] = item
				assert.NotContains(t, item, "data")
			}
			assert.Equal(t, true, byID[referencedID]["in_use"])
			assert.Equal(t, true, byID[pinnedID]["in_use"])
			assert.Equal(t, false, byID[freeID]["in_use"])
			assert.Equal(t, "notes.png", byID[freeID]["title"])
			assert.EqualValues(t, len(png), byID[freeID]["byte_size"])
			rawAttachments := playgroundRequest(t, 7, http.MethodGet, "/api/playground/assets?kind=attachment&page_size=50", nil, controller.ListPlaygroundAssets)
			assert.NotContains(t, rawAttachments.Body.String(), base64.StdEncoding.EncodeToString(png))
			assert.NotContains(t, rawAttachments.Body.String(), foreignUpload["id"].(string))

			firstPage := list(7, "kind=attachment&page_size=2&p=1")
			assert.Equal(t, 3, firstPage.Data.Total)
			require.Len(t, firstPage.Data.Items, 2)
			assert.Equal(t, freeID, firstPage.Data.Items[0]["id"])
			assert.Equal(t, pinnedID, firstPage.Data.Items[1]["id"])
			secondPage := list(7, "kind=attachment&page_size=2&p=2")
			assert.Equal(t, 3, secondPage.Data.Total)
			require.Len(t, secondPage.Data.Items, 1)
			assert.Equal(t, referencedID, secondPage.Data.Items[0]["id"])

			// Search is a case-insensitive literal substring, so wildcards do
			// not turn a keyword into a match-everything pattern.
			assert.Equal(t, 1, list(7, "kind=attachment&search=sunset").Data.Total)
			assert.Equal(t, 1, list(7, "kind=attachment&search=MAP").Data.Total)
			assert.Equal(t, 1, list(7, "kind=attachment&search=studio%20sunset").Data.Total)
			assert.Zero(t, list(7, "kind=attachment&search=missing").Data.Total)
			assert.Zero(t, list(7, "kind=attachment&search=%25").Data.Total)
			assert.Zero(t, list(7, "kind=attachment&search=_").Data.Total)

			artifacts := list(7, "kind=artifact&page_size=50")
			require.Equal(t, 1, artifacts.Data.Total)
			require.Len(t, artifacts.Data.Items, 1)
			liveItem := artifacts.Data.Items[0]
			assert.Equal(t, liveArtifact.Artifact.ID, liveItem["id"])
			assert.Equal(t, "Sunset Report", liveItem["title"])
			assert.Equal(t, "markdown", liveItem["language"])
			assert.EqualValues(t, 1, liveItem["revision"])
			assert.Equal(t, false, liveItem["in_use"])
			assert.NotContains(t, liveItem, "content")
			assert.NotContains(t, liveItem, "source")
			assert.NotContains(t, liveItem, "request_id")
			rawArtifacts := playgroundRequest(t, 7, http.MethodGet, "/api/playground/assets?kind=artifact&page_size=50", nil, controller.ListPlaygroundAssets)
			assert.NotContains(t, rawArtifacts.Body.String(), "Visible document")
			assert.NotContains(t, rawArtifacts.Body.String(), "Private reasoning")
			assert.Equal(t, 1, list(7, "kind=artifact&search=report").Data.Total)
			assert.Zero(t, list(7, "kind=artifact&search=CHART").Data.Total)

			// The same owner scoping applies to every page and kind.
			foreignList := list(8, "kind=attachment&page_size=50")
			require.Equal(t, 1, foreignList.Data.Total)
			assert.Equal(t, foreignUpload["id"], foreignList.Data.Items[0]["id"])
			assert.Equal(t, false, foreignList.Data.Items[0]["in_use"])
			assert.Equal(t, 1, list(8, "kind=artifact&page_size=50").Data.Total)

			// Malformed or out-of-range queries are rejected, and generation
			// results are not an asset kind: they stay behind /api/task/self.
			for name, query := range map[string]string{
				"kind is required":      "page_size=50",
				"task results stay out": "kind=task",
				"page size over cap":    "kind=attachment&page_size=100",
				"search over cap":       "kind=attachment&search=" + strings.Repeat("a", 101),
			} {
				response := playgroundRequest(t, 7, http.MethodGet, "/api/playground/assets?"+query, nil, controller.ListPlaygroundAssets)
				assert.Equal(t, http.StatusBadRequest, response.Code, name)
			}
		})
	}
}

func playgroundAuthenticatedRequest(t *testing.T, engine *gin.Engine, token, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := common.Marshal(body)
	require.NoError(t, err)
	request := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	return response
}

func TestPlaygroundRealRouterAuthentication(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.UserAccessToken{}, &model.AuditLog{}, &model.Option{}))
	oldLog, oldRedis, oldSecret, oldLimit := model.LOG_DB, common.RedisEnabled, common.SessionSecret, common.GlobalApiRateLimitEnable
	model.LOG_DB, common.RedisEnabled, common.SessionSecret, common.GlobalApiRateLimitEnable = db, false, "playground-artifact-auth-test", false
	t.Cleanup(func() {
		model.LOG_DB, common.RedisEnabled, common.SessionSecret, common.GlobalApiRateLimitEnable = oldLog, oldRedis, oldSecret, oldLimit
	})
	user := model.User{Id: 990087, Username: "artifact-owner", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1}
	require.NoError(t, db.Create(&user).Error)
	now := time.Now().Unix()
	key, err := common.GenerateRandomCharsKey(32)
	require.NoError(t, err)
	session := model.UserSession{SID: key, UserID: user.Id, Version: 1, UserAuthVersion: 1, Status: model.UserSessionStatusActive,
		RefreshHash: "unused-test-refresh-hash", LoginMethod: "password", LastActiveAt: now, ExpiresAt: now + 3600}
	require.NoError(t, model.CreateUserSession(&session))
	token, _, err := service.IssueAccessToken(service.AuthIdentity{UserID: user.Id, SessionID: session.SID, UserAuthVersion: 1, SessionVersion: 1})
	require.NoError(t, err)
	patRaw := model.AccessTokenPrefix + strings.Repeat("a", 43)
	pat := model.UserAccessToken{Name: "artifact route denial", TokenHash: model.AccessTokenFingerprint(patRaw), TokenHint: model.AccessTokenHint(patRaw)}
	require.NoError(t, pat.SetScopes([]string{"profile:read"}))
	require.NoError(t, model.CreateUserAccessToken(user.Id, &pat, service.AccessTokenMaxPerUser))
	engine := gin.New()
	router.SetApiRouter(engine)
	router.SetRelayRouter(engine)
	sessionID, input := playgroundArtifactSourceFixture(t, user.Id, "authenticated")
	attachmentBase := "/api/playground/sessions/" + sessionID + "/attachments"
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/playground/usage"},
		{http.MethodGet, "/api/playground/settings"},
		{http.MethodGet, "/api/playground/message-costs?request_ids=route-cost"},
		{http.MethodGet, "/api/playground/assets?kind=attachment"},
		{http.MethodGet, "/api/playground/trash"},
		{http.MethodGet, "/api/playground/sessions/" + sessionID + "/export"},
		{http.MethodPost, "/api/playground/sessions/" + sessionID + "/share"},
		{http.MethodDelete, "/api/playground/sessions/" + sessionID + "/share"},
		{http.MethodPost, "/api/playground/sessions/" + sessionID + "/restore"},
		{http.MethodPost, "/api/playground/tasks/missing/cancel"},
		{http.MethodPost, "/pg/embeddings"},
		{http.MethodGet, "/api/playground/presets"},
		{http.MethodPost, "/api/playground/presets"},
		{http.MethodGet, "/api/playground/presets/market"},
		{http.MethodPost, "/api/playground/presets/market/missing/copy"},
		{http.MethodPost, "/api/playground/presets/import"},
		{http.MethodGet, "/api/playground/presets/missing/export"},
		{http.MethodGet, "/api/playground/presets/missing"},
		{http.MethodPatch, "/api/playground/presets/missing"},
		{http.MethodDelete, "/api/playground/presets/missing"},
		{http.MethodGet, "/api/playground/knowledge-bases"},
		{http.MethodPost, "/api/playground/knowledge-bases"},
		{http.MethodGet, "/api/playground/knowledge-bases/missing"},
		{http.MethodPatch, "/api/playground/knowledge-bases/missing"},
		{http.MethodDelete, "/api/playground/knowledge-bases/missing"},
		{http.MethodGet, "/api/playground/knowledge-bases/missing/documents"},
		{http.MethodPost, "/api/playground/knowledge-bases/missing/documents"},
		{http.MethodGet, "/api/playground/knowledge-bases/missing/documents/missing"},
		{http.MethodDelete, "/api/playground/knowledge-bases/missing/documents/missing"},
		{http.MethodPost, "/api/playground/knowledge-bases/missing/documents/missing/reindex"},
		{http.MethodPost, "/api/playground/knowledge-bases/missing/documents/missing/failure"},
		{http.MethodPut, "/api/playground/knowledge-bases/missing/documents/missing/chunks"},
		{http.MethodGet, "/api/playground/snippets"},
		{http.MethodPost, "/api/playground/snippets"},
		{http.MethodGet, "/api/playground/snippets/missing"},
		{http.MethodPatch, "/api/playground/snippets/missing"},
		{http.MethodDelete, "/api/playground/snippets/missing"},
		{http.MethodGet, "/api/playground/memories"},
		{http.MethodPost, "/api/playground/memories"},
		{http.MethodGet, "/api/playground/memories/missing"},
		{http.MethodPatch, "/api/playground/memories/missing"},
		{http.MethodDelete, "/api/playground/memories/missing"},
		{http.MethodGet, attachmentBase}, {http.MethodPost, attachmentBase},
		{http.MethodGet, attachmentBase + "/missing"}, {http.MethodGet, attachmentBase + "/missing/content"},
		{http.MethodGet, attachmentBase + "/missing/text"},
		{http.MethodDelete, attachmentBase + "/missing"},
		{http.MethodPost, "/api/playground/uploads"},
		{http.MethodPut, "/api/playground/uploads/missing/content"},
		{http.MethodPost, "/api/playground/uploads/missing/complete"},
		{http.MethodDelete, "/api/playground/uploads/missing"},
	} {
		response := playgroundAuthenticatedRequest(t, engine, "", route.method, route.path, input)
		assert.Equal(t, 401, response.Code, response.Body.String())
		assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
		response = playgroundAuthenticatedRequest(t, engine, patRaw, route.method, route.path, input)
		assert.Equal(t, 403, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), "AUTH_SESSION_REQUIRED")
	}

	// A share link is readable anonymously through the real router, while an
	// unknown token uses the same non-enumerable 404 contract.
	shareResponse := playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, "/api/playground/sessions/"+sessionID+"/share", map[string]any{})
	require.Equal(t, 200, shareResponse.Code, shareResponse.Body.String())
	var shareEnvelope struct {
		Success bool
		Data    struct {
			Token   string `json:"token"`
			URLPath string `json:"url_path"`
		}
	}
	require.NoError(t, common.Unmarshal(shareResponse.Body.Bytes(), &shareEnvelope))
	require.True(t, shareEnvelope.Success, shareResponse.Body.String())
	require.NotEmpty(t, shareEnvelope.Data.Token)
	anonymousRead := playgroundAuthenticatedRequest(t, engine, "", http.MethodGet, "/api/playground/shared/"+shareEnvelope.Data.Token, nil)
	require.Equal(t, 200, anonymousRead.Code, anonymousRead.Body.String())
	assert.Contains(t, anonymousRead.Header().Get("Cache-Control"), "no-store")
	assert.Contains(t, anonymousRead.Body.String(), `"kind":"conversation"`)
	assert.Equal(t, "noindex, nofollow, noarchive", anonymousRead.Header().Get("X-Robots-Tag"))
	anonymousMissing := playgroundAuthenticatedRequest(t, engine, "", http.MethodGet, "/api/playground/shared/unknown-token", nil)
	assert.Equal(t, 404, anonymousMissing.Code)
	assert.Contains(t, anonymousMissing.Body.String(), "PLAYGROUND_SHARE_NOT_FOUND")

	// Global preset maintenance is administrator-only. A personal access
	// token is admitted by the dashboard authentication layer only with the
	// option scope, and a common-user session is still rejected by AdminAuth.
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/playground/presets/global"},
		{http.MethodPost, "/api/playground/presets/global"},
		{http.MethodPost, "/api/playground/presets/global/import"},
		{http.MethodGet, "/api/playground/presets/global/missing"},
		{http.MethodPatch, "/api/playground/presets/global/missing"},
		{http.MethodDelete, "/api/playground/presets/global/missing"},
		{http.MethodGet, "/api/playground/presets/global/missing/export"},
	} {
		response := playgroundAuthenticatedRequest(t, engine, "", route.method, route.path, input)
		assert.Equal(t, 401, response.Code, route.method+" "+route.path+": "+response.Body.String())
		response = playgroundAuthenticatedRequest(t, engine, patRaw, route.method, route.path, input)
		assert.Equal(t, 403, response.Code, route.method+" "+route.path+": "+response.Body.String())
		response = playgroundAuthenticatedRequest(t, engine, token, route.method, route.path, input)
		assert.Equal(t, 403, response.Code, route.method+" "+route.path+": "+response.Body.String())
		assert.Contains(t, response.Body.String(), "AUTH_INSUFFICIENT_PRIVILEGE")
	}

	base := "/api/playground/sessions/" + sessionID + "/artifacts"
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, base}, {http.MethodPost, base}, {http.MethodGet, base + "/missing"},
		{http.MethodGet, base + "/missing/versions"}, {http.MethodGet, base + "/missing/versions/missing"},
		{http.MethodPost, base + "/missing/versions"}, {http.MethodPost, base + "/missing/restore"}, {http.MethodDelete, base + "/missing?expected_revision=1"},
	} {
		response := playgroundAuthenticatedRequest(t, engine, "", route.method, route.path, input)
		assert.Equal(t, 401, response.Code, response.Body.String())
		assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
		response = playgroundAuthenticatedRequest(t, engine, patRaw, route.method, route.path, input)
		assert.Equal(t, 403, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), "AUTH_SESSION_REQUIRED")
	}
	created := artifactResult(t, playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, base, input))
	path := base + "/" + created.Artifact.ID
	assert.Equal(t, created, artifactResult(t, playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, path, nil)))
	assert.Equal(t, created, artifactResult(t, playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, path+"/versions/"+created.Version.ID, nil)))
	for _, list := range []string{base, path + "/versions"} {
		response := playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, list, nil)
		require.Equal(t, 200, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), `"total":1`)
	}
	revision := int64(1)
	text := "edited"
	save := model.SavePlaygroundArtifactInput{RequestID: "real-save", ExpectedRevision: &revision, Title: "Edited", Language: "markdown", Content: &text}
	artifactResult(t, playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, path+"/versions", save))
	revision = 2
	restore := model.RestorePlaygroundArtifactInput{RequestID: "real-restore", ExpectedRevision: &revision, VersionID: created.Version.ID}
	artifactResult(t, playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, path+"/restore", restore))
	response := playgroundAuthenticatedRequest(t, engine, token, http.MethodDelete, path+"?expected_revision=3", nil)
	require.Equal(t, 200, response.Code, response.Body.String())
	assert.Equal(t, 404, playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, base, input).Code)
	// An authenticated session uploads an attachment and reads its bytes back.
	png := playgroundPNGFixture(48)
	upload := playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, attachmentBase, map[string]any{
		"client_key": "router-file", "media_type": "image/png",
		"data": base64.StdEncoding.EncodeToString(png),
	})
	require.Equal(t, 200, upload.Code, upload.Body.String())
	var uploaded struct {
		Data struct{ ID string }
	}
	require.NoError(t, common.Unmarshal(upload.Body.Bytes(), &uploaded))
	require.NotEmpty(t, uploaded.Data.ID)
	content := playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, attachmentBase+"/"+uploaded.Data.ID+"/content", nil)
	require.Equal(t, 200, content.Code)
	assert.Equal(t, png, content.Body.Bytes())

	// The unified usage endpoint answers only for the authenticated session.
	usageResponse := playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, "/api/playground/usage", nil)
	require.Equal(t, 200, usageResponse.Code, usageResponse.Body.String())
	assert.Contains(t, usageResponse.Body.String(), `"sessions"`)
	assert.Contains(t, usageResponse.Body.String(), `"tasks"`)

	// The settings endpoint reports the server-side sandbox preview switch and
	// defaults to disabled until an administrator opts in.
	settingsResponse := playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, "/api/playground/settings", nil)
	require.Equal(t, 200, settingsResponse.Code, settingsResponse.Body.String())
	assert.Contains(t, settingsResponse.Body.String(), `"sandbox_preview_enabled":false`)

	// Canvas routes share the same session-only authentication contract.
	canvasBase := "/api/playground/canvases"
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, canvasBase}, {http.MethodPost, canvasBase},
		{http.MethodGet, canvasBase + "/missing"}, {http.MethodPatch, canvasBase + "/missing"},
		{http.MethodDelete, canvasBase + "/missing"},
		{http.MethodPost, canvasBase + "/missing/share"}, {http.MethodDelete, canvasBase + "/missing/share"},
		{http.MethodPost, canvasBase + "/missing/restore"},
		{http.MethodPost, canvasBase + "/missing/attachments"},
		{http.MethodGet, canvasBase + "/missing/snapshots"},
		{http.MethodPost, canvasBase + "/missing/snapshots/missing/restore"},
		{http.MethodGet, canvasBase + "/missing/export"},
		{http.MethodPost, canvasBase + "/import"},
	} {
		response := playgroundAuthenticatedRequest(t, engine, "", route.method, route.path, upload)
		assert.Equal(t, 401, response.Code, response.Body.String())
		assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
		response = playgroundAuthenticatedRequest(t, engine, patRaw, route.method, route.path, upload)
		assert.Equal(t, 403, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), "AUTH_SESSION_REQUIRED")
	}
	canvasCreated := playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, canvasBase, map[string]any{
		"client_id": "router-canvas",
		"title":     "Router board",
		"document":  canvasDocument(nil, nil),
	})
	require.Equal(t, 200, canvasCreated.Code, canvasCreated.Body.String())
	var canvasEnvelope struct {
		Data struct{ ID string }
	}
	require.NoError(t, common.Unmarshal(canvasCreated.Body.Bytes(), &canvasEnvelope))
	require.NotEmpty(t, canvasEnvelope.Data.ID)
	canvasDetail := playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, canvasBase+"/"+canvasEnvelope.Data.ID, nil)
	require.Equal(t, 200, canvasDetail.Code, canvasDetail.Body.String())
	canvasShare := playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, canvasBase+"/"+canvasEnvelope.Data.ID+"/share", map[string]any{})
	require.Equal(t, 200, canvasShare.Code, canvasShare.Body.String())
	var canvasShareEnvelope struct {
		Data struct{ Token string }
	}
	require.NoError(t, common.Unmarshal(canvasShare.Body.Bytes(), &canvasShareEnvelope))
	require.NotEmpty(t, canvasShareEnvelope.Data.Token)
	anonymousCanvas := playgroundAuthenticatedRequest(t, engine, "", http.MethodGet, "/api/playground/shared/"+canvasShareEnvelope.Data.Token, nil)
	require.Equal(t, 200, anonymousCanvas.Code, anonymousCanvas.Body.String())
	assert.Contains(t, anonymousCanvas.Body.String(), `"kind":"canvas"`)
	assert.Contains(t, anonymousCanvas.Body.String(), `"document"`)
	assert.NotContains(t, anonymousCanvas.Body.String(), `"ref"`)
	require.Equal(t, 200, playgroundAuthenticatedRequest(t, engine, token, http.MethodDelete, canvasBase+"/"+canvasEnvelope.Data.ID+"/share", nil).Code)
	assert.Equal(t, 404, playgroundAuthenticatedRequest(t, engine, "", http.MethodGet, "/api/playground/shared/"+canvasShareEnvelope.Data.Token, nil).Code)
	require.Equal(t, 200, playgroundAuthenticatedRequest(t, engine, token, http.MethodDelete, canvasBase+"/"+canvasEnvelope.Data.ID, nil).Code)

	// Assistant presets share the same session-only contract and stay
	// owner-scoped through the real router.
	presetBase := "/api/playground/presets"
	presetCreated := playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, presetBase, map[string]any{
		"name": "Router preset", "system_prompt": "Be brief.",
	})
	require.Equal(t, 200, presetCreated.Code, presetCreated.Body.String())
	var presetEnvelope struct {
		Data struct{ ID string }
	}
	require.NoError(t, common.Unmarshal(presetCreated.Body.Bytes(), &presetEnvelope))
	require.NotEmpty(t, presetEnvelope.Data.ID)
	presetList := playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, presetBase, nil)
	require.Equal(t, 200, presetList.Code, presetList.Body.String())
	assert.Contains(t, presetList.Body.String(), `"total":1`)
	presetUpdated := playgroundAuthenticatedRequest(t, engine, token, http.MethodPatch, presetBase+"/"+presetEnvelope.Data.ID, map[string]any{"name": "Router preset v2"})
	require.Equal(t, 200, presetUpdated.Code, presetUpdated.Body.String())
	assert.Contains(t, presetUpdated.Body.String(), `"name":"Router preset v2"`)
	presetRead := playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, presetBase+"/"+presetEnvelope.Data.ID, nil)
	require.Equal(t, 200, presetRead.Code, presetRead.Body.String())
	assert.Contains(t, presetRead.Body.String(), `"system_prompt":"Be brief."`)
	require.Equal(t, 200, playgroundAuthenticatedRequest(t, engine, token, http.MethodDelete, presetBase+"/"+presetEnvelope.Data.ID, nil).Code)

	// Cross-session memories share the same contract and stay owner-scoped.
	memoryBase := "/api/playground/memories"
	memoryCreated := playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, memoryBase, map[string]any{
		"content": "Prefers short status updates.", "category": "preference",
	})
	require.Equal(t, 200, memoryCreated.Code, memoryCreated.Body.String())
	var memoryEnvelope struct {
		Data struct{ ID string }
	}
	require.NoError(t, common.Unmarshal(memoryCreated.Body.Bytes(), &memoryEnvelope))
	require.NotEmpty(t, memoryEnvelope.Data.ID)
	memoryList := playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, memoryBase, nil)
	require.Equal(t, 200, memoryList.Code, memoryList.Body.String())
	assert.Contains(t, memoryList.Body.String(), `"total":1`)
	memoryUpdated := playgroundAuthenticatedRequest(t, engine, token, http.MethodPatch, memoryBase+"/"+memoryEnvelope.Data.ID, map[string]any{"enabled": false})
	require.Equal(t, 200, memoryUpdated.Code, memoryUpdated.Body.String())
	assert.Contains(t, memoryUpdated.Body.String(), `"enabled":false`)
	memoryRead := playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, memoryBase+"/"+memoryEnvelope.Data.ID, nil)
	require.Equal(t, 200, memoryRead.Code, memoryRead.Body.String())
	assert.Contains(t, memoryRead.Body.String(), "Prefers short status updates.")
	require.Equal(t, 200, playgroundAuthenticatedRequest(t, engine, token, http.MethodDelete, memoryBase+"/"+memoryEnvelope.Data.ID, nil).Code)

	// A conversation created through the router carries its system prompt.
	sessionWithPrompt := playgroundAuthenticatedRequest(t, engine, token, http.MethodPost, "/api/playground/sessions", map[string]any{
		"title": "Router prompt", "config": map[string]any{"model": "test-model"}, "system_prompt": "Be brief.",
	})
	require.Equal(t, 200, sessionWithPrompt.Code, sessionWithPrompt.Body.String())
	assert.Contains(t, sessionWithPrompt.Body.String(), `"system_prompt":"Be brief."`)

	// Ambient cookies are not accepted as authorization by these bearer APIs.
	cookieOnly := httptest.NewRequest(http.MethodGet, base, nil)
	cookieOnly.AddCookie(&http.Cookie{Name: "refresh_token", Value: "not-authority"})
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, cookieOnly)
	assert.Equal(t, 401, recorder.Code)
	_, err = model.RevokeUserSession(user.Id, session.SID, "test")
	require.NoError(t, err)
	assert.Equal(t, 401, playgroundAuthenticatedRequest(t, engine, token, http.MethodGet, base, nil).Code)
}

func TestPlaygroundArtifactConcurrentWritesMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			sessionID, input := playgroundArtifactSourceFixture(t, 7, "concurrency")
			type outcome struct {
				result *model.PlaygroundArtifactResult
				err    error
			}
			outcomes := make(chan outcome, 2)
			start := make(chan struct{})
			for range 2 {
				go func() {
					<-start
					result, err := model.CreatePlaygroundArtifact(7, sessionID, input)
					outcomes <- outcome{result, err}
				}()
			}
			close(start)
			one, two := <-outcomes, <-outcomes
			require.NoError(t, one.err)
			require.NoError(t, two.err)
			assert.Equal(t, one.result, two.result)
			artifactID := one.result.Artifact.ID
			text, revision := "concurrent", int64(1)
			start = make(chan struct{})
			for i := range 2 {
				go func() {
					<-start
					result, err := model.SavePlaygroundArtifactVersion(7, sessionID, artifactID, model.SavePlaygroundArtifactInput{RequestID: fmt.Sprintf("concurrent-%d", i), ExpectedRevision: &revision, Title: "Concurrent", Language: "markdown", Content: &text})
					outcomes <- outcome{result, err}
				}()
			}
			close(start)
			one, two = <-outcomes, <-outcomes
			if one.err != nil {
				one, two = two, one
			}
			require.NoError(t, one.err)
			assert.ErrorIs(t, two.err, model.ErrPlaygroundConflict)
			assert.EqualValues(t, 2, one.result.Artifact.Revision)
			revision = 2
			start = make(chan struct{})
			for range 2 {
				go func() {
					<-start
					result, err := model.SavePlaygroundArtifactVersion(7, sessionID, artifactID, model.SavePlaygroundArtifactInput{RequestID: "same-request", ExpectedRevision: &revision, Title: "Concurrent retry", Language: "markdown", Content: &text})
					outcomes <- outcome{result, err}
				}()
			}
			close(start)
			one, two = <-outcomes, <-outcomes
			require.NoError(t, one.err)
			require.NoError(t, two.err)
			assert.Equal(t, one.result, two.result)
			assert.EqualValues(t, 3, one.result.Artifact.Revision)
			revision = 3
			start = make(chan struct{})
			deletion := make(chan error, 1)
			go func() { <-start; deletion <- model.DeletePlaygroundArtifact(7, sessionID, artifactID, revision) }()
			go func() {
				<-start
				result, err := model.SavePlaygroundArtifactVersion(7, sessionID, artifactID, model.SavePlaygroundArtifactInput{RequestID: "delete-race", ExpectedRevision: &revision, Title: "Racing", Language: "markdown", Content: &text})
				outcomes <- outcome{result, err}
			}()
			close(start)
			deleteErr, written := <-deletion, <-outcomes
			if deleteErr == nil {
				assert.ErrorIs(t, written.err, model.ErrPlaygroundSessionNotFound)
			} else {
				assert.ErrorIs(t, deleteErr, model.ErrPlaygroundConflict)
				require.NoError(t, written.err)
				require.NoError(t, model.DeletePlaygroundArtifact(7, sessionID, artifactID, 4))
			}
			_, err := model.CreatePlaygroundArtifact(7, sessionID, input)
			assert.ErrorIs(t, err, model.ErrPlaygroundSessionNotFound)
			var count int64
			require.NoError(t, db.Model(&model.PlaygroundArtifactVersion{}).Count(&count).Error)
			assert.Zero(t, count)
			// A late creation cannot leave an orphan when the parent is deleted.
			input.RequestID = "session-delete-race"
			start = make(chan struct{})
			go func() { <-start; deletion <- model.DeletePlaygroundSession(7, sessionID) }()
			go func() {
				<-start
				result, err := model.CreatePlaygroundArtifact(7, sessionID, input)
				outcomes <- outcome{result, err}
			}()
			close(start)
			require.NoError(t, <-deletion)
			written = <-outcomes
			if written.err != nil {
				assert.ErrorIs(t, written.err, model.ErrPlaygroundSessionNotFound)
			}
			// The trash keeps whatever the race wrote, and the purge proves the
			// late creation left no orphan behind.
			require.NoError(t, model.PurgePlaygroundSession(7, sessionID))
			require.NoError(t, db.Model(&model.PlaygroundArtifact{}).Count(&count).Error)
			assert.Zero(t, count)
			require.NoError(t, db.Model(&model.PlaygroundArtifactVersion{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}

// Editing or regenerating a Playground message keeps its earlier answers as
// switchable versions. The snapshot must round-trip every version and the
// selected branch index across all three supported databases, reject invalid
// branch indexes and over-capacity payloads, and stay owner-scoped.
func TestPlaygroundMessageVersionBranches(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			playgroundTestDB(t, dialect)
			session := createPlayground(t, 7, "branches")
			id := session["id"].(string)
			path := "/api/playground/sessions/" + id + "/messages"
			body := map[string]any{
				"revision": 0,
				"messages": []any{
					map[string]any{"client_key": "user-1", "payload": map[string]any{
						"key": "user-1", "from": "user", "activeVersionIndex": 1,
						"versions": []any{
							map[string]any{"id": "u1", "content": "First question"},
							map[string]any{"id": "u2", "content": "Edited question"},
						},
					}},
					map[string]any{"client_key": "assistant-1", "payload": map[string]any{
						"key": "assistant-1", "from": "assistant", "status": "complete", "isContentComplete": true,
						"activeVersionIndex": 1,
						"versions": []any{
							map[string]any{"id": "a1", "content": "First answer"},
							map[string]any{"id": "a2", "content": "Regenerated answer",
								"requestId":    "req-branch-2",
								"finishReason": "length",
								"usage":        map[string]any{"promptTokens": 12, "completionTokens": 34, "totalTokens": 46}},
						},
					}},
				},
			}
			response := playgroundRequest(t, 7, http.MethodPut, path, body, controller.ReplacePlaygroundMessages)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())

			messages, revision, err := model.ListPlaygroundMessages(7, id)
			require.NoError(t, err)
			require.EqualValues(t, 1, revision)
			require.Len(t, messages, 2)
			assert.Contains(t, string(messages[0].Payload), `"activeVersionIndex":1`)
			assert.Contains(t, string(messages[0].Payload), "First question")
			assert.Contains(t, string(messages[0].Payload), "Edited question")
			assert.Contains(t, string(messages[1].Payload), "First answer")
			assert.Contains(t, string(messages[1].Payload), "Regenerated answer")
			// The generation record of the selected version round-trips verbatim.
			assert.Contains(t, string(messages[1].Payload), `"requestId":"req-branch-2"`)
			assert.Contains(t, string(messages[1].Payload), `"totalTokens":46`)
			// A truncated reply keeps its provider finish reason so the client
			// can offer "continue generation" after a reload.
			assert.Contains(t, string(messages[1].Payload), `"finishReason":"length"`)

			for _, index := range []int{-1, 2} {
				invalid := map[string]any{
					"revision": 1,
					"messages": []any{map[string]any{"client_key": "user-1", "payload": map[string]any{
						"key": "user-1", "from": "user", "activeVersionIndex": index,
						"versions": []any{map[string]any{"id": "u1", "content": "First question"}},
					}}},
				}
				rejected := playgroundRequest(t, 7, http.MethodPut, path, invalid, controller.ReplacePlaygroundMessages)
				assert.Equal(t, http.StatusBadRequest, rejected.Code, rejected.Body.String())
			}

			versions := make([]any, playground_setting.GetPlaygroundQuotaPolicy("default").MessageMaxVersions+1)
			for versionIndex := range versions {
				versions[versionIndex] = map[string]any{"id": fmt.Sprintf("v%d", versionIndex), "content": "x"}
			}
			overflow := map[string]any{
				"revision": 1,
				"messages": []any{map[string]any{"client_key": "user-1", "payload": map[string]any{
					"key": "user-1", "from": "user", "versions": versions,
				}}},
			}
			assert.Equal(t, http.StatusBadRequest, playgroundRequest(t, 7, http.MethodPut, path, overflow, controller.ReplacePlaygroundMessages).Code)
			messages, revision, err = model.ListPlaygroundMessages(7, id)
			require.NoError(t, err)
			assert.EqualValues(t, 1, revision)
			require.Len(t, messages, 2)

			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodGet, path, nil, controller.ListPlaygroundMessages).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodPut, path, body, controller.ReplacePlaygroundMessages).Code)

			// The model re-checks the snapshot capacity inside the write
			// transaction; an over-limit write rolls back and keeps history.
			tooMany := make([]model.PlaygroundMessage, playground_setting.GetPlaygroundQuotaPolicy("default").MessageMaxCount+1)
			for index := range tooMany {
				tooMany[index] = model.PlaygroundMessage{ClientKey: fmt.Sprintf("m%d", index), Payload: `{"key":"m","from":"user","versions":[{"id":"v","content":"x"}]}`}
			}
			_, err = model.ReplacePlaygroundMessages(7, id, 1, tooMany)
			assert.Error(t, err)
			messages, revision, err = model.ListPlaygroundMessages(7, id)
			require.NoError(t, err)
			assert.EqualValues(t, 1, revision)
			require.Len(t, messages, 2)
		})
	}
}

// Incremental message writes touch only the rows a client changed: stored rows
// keep their identity and position, new rows append after the highest position,
// removed keys are deleted, an unchanged delta keeps the revision, and the
// deprecated snapshot endpoint keeps its contract on top of the same path.
func TestPlaygroundMessageDeltaWrites(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			session := createPlayground(t, 7, "message-delta")
			id := session["id"].(string)
			path := "/api/playground/sessions/" + id + "/messages"
			userMessage := func(key string, content string) map[string]any {
				return map[string]any{"client_key": key, "payload": map[string]any{
					"key": key, "from": "user", "versions": []any{map[string]any{"id": key + "-v1", "content": content}},
				}}
			}
			delta := func(body map[string]any) *httptest.ResponseRecorder {
				t.Helper()
				return playgroundRequest(t, 7, http.MethodPatch, path, body, controller.ApplyPlaygroundMessagesDelta)
			}
			revision := func(response *httptest.ResponseRecorder) int64 {
				t.Helper()
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				var envelope struct {
					Success bool
					Data    struct {
						Revision int64
						Upserted []string
						Deleted  []string
					}
				}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
				require.True(t, envelope.Success, response.Body.String())
				return envelope.Data.Revision
			}
			rows := func() []model.PlaygroundMessage {
				t.Helper()
				stored := make([]model.PlaygroundMessage, 0)
				require.NoError(t, db.Where("session_id = ?", id).Order("position").Order("id").Find(&stored).Error)
				return stored
			}

			// The compatibility snapshot endpoint still accepts the complete
			// message list; it is stored in order with sparse positions.
			require.EqualValues(t, 1, revision(playgroundRequest(t, 7, http.MethodPut, path, map[string]any{
				"revision": 0, "messages": []any{userMessage("m1", "first"), userMessage("m2", "second")},
			}, controller.ReplacePlaygroundMessages)))
			first := rows()
			require.Len(t, first, 2)
			assert.Equal(t, "m1", first[0].ClientKey)
			assert.Equal(t, "m2", first[1].ClientKey)
			assert.Less(t, first[0].Position, first[1].Position)
			// Age the untouched row so a rewrite of it would be observable.
			agedAt := first[0].UpdatedAt - 100000
			require.NoError(t, db.Model(&model.PlaygroundMessage{}).Where("id = ?", first[0].ID).Update("updated_at", agedAt).Error)

			// One changed and one new message: the untouched row keeps its
			// identity, position and timestamp, the new row appends after the
			// highest stored position.
			require.EqualValues(t, 2, revision(delta(map[string]any{
				"revision": 1, "upserts": []any{userMessage("m2", "second edited"), userMessage("m3", "third")},
			})))
			updated := rows()
			require.Len(t, updated, 3)
			assert.Equal(t, first[0].ID, updated[0].ID)
			assert.Equal(t, first[0].Position, updated[0].Position)
			assert.Equal(t, agedAt, updated[0].UpdatedAt, "an unchanged row is not rewritten")
			assert.Contains(t, string(updated[0].Payload), "first")
			assert.Equal(t, first[1].ID, updated[1].ID)
			assert.Contains(t, string(updated[1].Payload), "second edited")
			assert.Greater(t, updated[2].Position, updated[1].Position)
			assert.Contains(t, string(updated[2].Payload), "third")

			// Deleting one key removes exactly that row.
			require.EqualValues(t, 3, revision(delta(map[string]any{"revision": 2, "deletes": []string{"m1"}})))
			remaining := rows()
			require.Len(t, remaining, 2)
			assert.Equal(t, []string{"m2", "m3"}, []string{remaining[0].ClientKey, remaining[1].ClientKey})

			// Re-sending an unchanged payload and re-deleting an absent key write
			// nothing and keep the stored revision.
			require.EqualValues(t, 3, revision(delta(map[string]any{
				"revision": 3, "upserts": []any{userMessage("m2", "second edited")}, "deletes": []string{"m1"},
			})))
			unchanged := rows()
			require.Len(t, unchanged, 2)
			assert.Equal(t, remaining[0].UpdatedAt, unchanged[0].UpdatedAt)

			// A stale revision conflicts without touching the snapshot, and
			// another account cannot reach the conversation at all.
			assert.Equal(t, http.StatusConflict, delta(map[string]any{"revision": 2, "upserts": []any{userMessage("m4", "late")}}).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodPatch, path, map[string]any{
				"revision": 3, "upserts": []any{userMessage("m4", "foreign")},
			}, controller.ApplyPlaygroundMessagesDelta).Code)
			assert.Len(t, rows(), 2)

			// Malformed deltas are rejected before anything is written.
			for name, body := range map[string]map[string]any{
				"missing revision":  {"upserts": []any{userMessage("m4", "text")}},
				"empty delta":       {"revision": 3, "upserts": []any{}, "deletes": []string{}},
				"duplicate delete":  {"revision": 3, "deletes": []string{"m2", "m2"}},
				"blank delete":      {"revision": 3, "deletes": []string{""}},
				"upsert and delete": {"revision": 3, "upserts": []any{userMessage("m2", "text")}, "deletes": []string{"m2"}},
				"mismatched key": {"revision": 3, "upserts": []any{map[string]any{"client_key": "m4", "payload": map[string]any{
					"key": "other", "from": "user", "versions": []any{map[string]any{"id": "v", "content": "text"}},
				}}}},
			} {
				assert.Equal(t, http.StatusBadRequest, delta(body).Code, name)
			}
			assert.Len(t, rows(), 2)

			// The (session_id, client_key) unique index is part of the migrated
			// schema, repeated startup migrations keep it, and it rejects a
			// duplicate row.
			require.True(t, db.Migrator().HasIndex(&model.PlaygroundMessage{}, "uk_playground_message_session_client"))
			require.NoError(t, db.AutoMigrate(&model.PlaygroundMessage{}))
			require.NoError(t, db.AutoMigrate(&model.PlaygroundMessage{}))
			require.True(t, db.Migrator().HasIndex(&model.PlaygroundMessage{}, "uk_playground_message_session_client"))
			assert.Error(t, db.Create(&model.PlaygroundMessage{
				SessionID: id, UserID: 7, ClientKey: "m2", Position: 1 << 20,
				Payload: `{"key":"m2","from":"user","versions":[{"id":"v","content":"duplicate"}]}`, CreatedAt: 1, UpdatedAt: 1,
			}).Error)
		})
	}
}

// Two incremental writers that share one revision serialize on the session row:
// exactly one applies and the loser is told to reload.
func TestPlaygroundMessageDeltaConcurrentRevision(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			playgroundTestDB(t, dialect)
			session := createPlayground(t, 7, "message-delta-concurrency")
			id := session["id"].(string)
			path := "/api/playground/sessions/" + id + "/messages"
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, path, map[string]any{
				"revision": 0, "messages": []any{map[string]any{"client_key": "m1", "payload": map[string]any{
					"key": "m1", "from": "user", "versions": []any{map[string]any{"id": "v1", "content": "stored"}},
				}}},
			}, controller.ReplacePlaygroundMessages).Code)

			start := make(chan struct{})
			outcomes := make(chan error, 2)
			for index := range 2 {
				go func() {
					<-start
					key := fmt.Sprintf("c%d", index)
					_, err := model.ApplyPlaygroundMessagesDelta(7, id, 1, model.PlaygroundMessageDelta{
						Upserts: []model.PlaygroundMessage{{ClientKey: key, Payload: model.LongText(fmt.Sprintf(`{"key":%q,"from":"user","versions":[{"id":"v1","content":"concurrent"}]}`, key))}},
					})
					outcomes <- err
				}()
			}
			close(start)
			one, two := <-outcomes, <-outcomes
			if one != nil {
				one, two = two, one
			}
			require.NoError(t, one)
			assert.ErrorIs(t, two, model.ErrPlaygroundConflict)

			messages, revision, err := model.ListPlaygroundMessages(7, id)
			require.NoError(t, err)
			assert.EqualValues(t, 2, revision)
			assert.Len(t, messages, 2, "only the winner's write is stored")
		})
	}
}

// A delta that would push the stored snapshot past the account's message budget
// is rejected inside the write transaction: the revision and the stored rows
// stay exactly as they were, and replacing a message fits the budget again.
func TestPlaygroundMessageDeltaLimitRollback(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.MessageMaxCount = 2
	})
	session := createPlayground(t, 7, "message-delta-limit")
	id := session["id"].(string)
	path := "/api/playground/sessions/" + id + "/messages"
	userMessage := func(key string) map[string]any {
		return map[string]any{"client_key": key, "payload": map[string]any{
			"key": key, "from": "user", "versions": []any{map[string]any{"id": key + "-v1", "content": "text"}},
		}}
	}
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, path, map[string]any{
		"revision": 0, "messages": []any{userMessage("m1"), userMessage("m2")},
	}, controller.ReplacePlaygroundMessages).Code)

	overflow := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
		"revision": 1, "upserts": []any{userMessage("m3")},
	}, controller.ApplyPlaygroundMessagesDelta)
	assert.Equal(t, http.StatusUnprocessableEntity, overflow.Code, overflow.Body.String())
	assert.Contains(t, overflow.Body.String(), "PLAYGROUND_MESSAGE_LIMIT_EXCEEDED")
	messages, revision, err := model.ListPlaygroundMessages(7, id)
	require.NoError(t, err)
	assert.EqualValues(t, 1, revision)
	require.Len(t, messages, 2)

	response := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
		"revision": 1, "upserts": []any{userMessage("m3")}, "deletes": []string{"m1"},
	}, controller.ApplyPlaygroundMessagesDelta)
	assert.Equal(t, http.StatusOK, response.Code, response.Body.String())
	messages, revision, err = model.ListPlaygroundMessages(7, id)
	require.NoError(t, err)
	assert.EqualValues(t, 2, revision)
	require.Len(t, messages, 2)
	assert.Contains(t, string(messages[0].Payload), "m2")
	assert.Contains(t, string(messages[1].Payload), "m3")
}

// The Playground resource quota policy resolves an effective budget from the
// user group: built-in defaults, then the global configuration, then the group
// override. Capacity is enforced server-side and reported as a stable error.
func TestPlaygroundQuotaPolicyResolutionAndSessionLimit(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.SessionMaxCount = 2
		policy.ObjectUserMaxBytes = 4096
	})
	usePlaygroundGroupQuota(t, "default", playground_setting.PlaygroundQuotaPolicy{SessionMaxCount: 1, ObjectUserMaxBytes: 8192})

	policy, err := model.PlaygroundQuotaPolicyForUser(7)
	require.NoError(t, err)
	assert.Equal(t, 1, policy.SessionMaxCount, "the group override wins over the global default")
	assert.EqualValues(t, 8192, policy.ObjectUserMaxBytes, "a group override can grant a larger storage entitlement")
	assert.Equal(t, playground_setting.GetPlaygroundQuotaPolicy("").MessageMaxCount, policy.MessageMaxCount, "unset group fields inherit")

	first := createPlayground(t, 7, "quota-first")
	overflow := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions", map[string]any{
		"title": "Overflow", "config": map[string]any{}, "parameter_enabled": map[string]any{},
	}, controller.CreatePlaygroundSession)
	assert.Equal(t, http.StatusUnprocessableEntity, overflow.Code, overflow.Body.String())
	assert.Contains(t, overflow.Body.String(), "PLAYGROUND_SESSION_LIMIT_EXCEEDED")

	// A trashed conversation keeps its slot; the purge that follows the
	// retention window frees it for the next create.
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+first["id"].(string), nil, controller.DeletePlaygroundSession).Code)
	trashed := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions", map[string]any{
		"title": "Overflow", "config": map[string]any{}, "parameter_enabled": map[string]any{},
	}, controller.CreatePlaygroundSession)
	assert.Equal(t, http.StatusUnprocessableEntity, trashed.Code, trashed.Body.String())
	require.NoError(t, model.PurgePlaygroundSession(7, first["id"].(string)))
	assert.NotEmpty(t, createPlayground(t, 7, "quota-second")["id"])
}

// A snapshot over the configured message count must be rejected inside the
// write transaction with the stable message code.
func TestPlaygroundMessageQuotaLimit(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.MessageMaxCount = 2
	})
	session := createPlayground(t, 7, "message-quota")
	message := func(key string) map[string]any {
		return map[string]any{"client_key": key, "payload": map[string]any{
			"key": key, "from": "user", "versions": []any{map[string]any{"id": key + "-v1", "content": "text"}},
		}}
	}
	response := playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+session["id"].(string)+"/messages", map[string]any{
		"revision": 0, "messages": []any{message("m1"), message("m2"), message("m3")},
	}, controller.ReplacePlaygroundMessages)
	assert.Equal(t, http.StatusUnprocessableEntity, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "PLAYGROUND_MESSAGE_LIMIT_EXCEEDED")
}

// The per-account attachment file count is part of the quota policy, separate
// from the byte budget.
func TestPlaygroundAttachmentCountLimit(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.AttachmentUserMaxCount = 1
	})
	session := createPlayground(t, 7, "attachment-count")
	png := playgroundPNGFixture(64)
	playgroundUploadAttachment(t, 7, session["id"].(string), "count-a", "image/png", png)
	response := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+session["id"].(string)+"/attachments", map[string]any{
		"client_key": "count-b", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(png),
	}, controller.CreatePlaygroundAttachment)
	assert.Equal(t, http.StatusUnprocessableEntity, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "PLAYGROUND_ATTACHMENT_LIMIT_EXCEEDED")
}

// The account-level object-store budget is part of the resource quota policy,
// so the group a subscription plan upgrades the buyer into can grant a larger
// storage entitlement. A write over the budget is rejected with the stable
// attachment code while the stored objects stay readable.
func TestPlaygroundObjectStorageQuotaLimit(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.AttachmentUserMaxCount = 10
		policy.AttachmentUserMaxBytes = 1 << 20
		policy.ObjectUserMaxBytes = 64
	})
	session := createPlayground(t, 7, "object-budget")
	id := session["id"].(string)
	stored := playgroundUploadAttachment(t, 7, id, "object-a", "image/png", playgroundPNGFixture(64))

	overflow := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+id+"/attachments", map[string]any{
		"client_key": "object-b", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(playgroundPNGFixture(16)),
	}, controller.CreatePlaygroundAttachment)
	require.Equal(t, http.StatusUnprocessableEntity, overflow.Code, overflow.Body.String())
	assert.Contains(t, overflow.Body.String(), "PLAYGROUND_ATTACHMENT_LIMIT_EXCEEDED")

	// Over budget only blocks new writes: the stored attachment is still
	// listed and its bytes are still served.
	listed := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments", nil, controller.ListPlaygroundAttachments)
	require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
	assert.Contains(t, listed.Body.String(), stored["id"].(string))
	content := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/attachments/"+stored["id"].(string)+"/content", nil, controller.GetPlaygroundAttachmentContent)
	require.Equal(t, http.StatusOK, content.Code, content.Body.String())
	assert.Equal(t, playgroundPNGFixture(64), content.Body.Bytes())

	// The upgrade target group's override grants the larger entitlement the
	// plan sells, and the same upload then succeeds.
	usePlaygroundGroupQuota(t, "default", playground_setting.PlaygroundQuotaPolicy{ObjectUserMaxBytes: 1 << 20})
	playgroundUploadAttachment(t, 7, id, "object-c", "image/png", playgroundPNGFixture(16))
}

// The unified usage view reports the owner's stored conversations,
// artifacts and canvases against the effective policy, and never mixes in
// another account's rows. The limit column must follow the group override, so
// it always matches what the write paths enforce.
func TestPlaygroundUsageForUserReportsOwnerTotals(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.SessionMaxCount = 5
		policy.AttachmentUserMaxCount = 4
		policy.AttachmentUserMaxBytes = 4096
		policy.ArtifactUserMaxCount = 3
		policy.ArtifactUserMaxBytes = 8192
		policy.CanvasUserMaxProjects = 6
		policy.CanvasUserMaxBytes = 16384
		policy.MemoryUserMaxCount = 7
		policy.TaskMaxConcurrency = 4
		policy.TaskUserResultMaxBytes = 1 << 20
		policy.ObjectUserMaxBytes = 1 << 21
	})
	usePlaygroundGroupQuota(t, "default", playground_setting.PlaygroundQuotaPolicy{CanvasUserMaxProjects: 9, ObjectUserMaxBytes: 1 << 22})

	sessionID, input := playgroundArtifactSourceFixture(t, 7, "usage-owner")
	artifactResult(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+sessionID+"/artifacts", input, controller.CreatePlaygroundArtifact))
	playgroundUploadAttachment(t, 7, sessionID, "usage-file", "image/png", playgroundPNGFixture(64))
	createCanvasProject(t, 7, "usage-canvas")
	memoryCreated := playgroundRequest(t, 7, http.MethodPost, "/api/playground/memories", map[string]any{
		"content": "Likes concise status updates.", "category": "preference",
	}, controller.CreatePlaygroundMemory)
	require.Equal(t, http.StatusOK, memoryCreated.Code, memoryCreated.Body.String())

	otherSession, otherInput := playgroundArtifactSourceFixture(t, 8, "usage-other")
	artifactResult(t, playgroundRequest(t, 8, http.MethodPost, "/api/playground/sessions/"+otherSession+"/artifacts", otherInput, controller.CreatePlaygroundArtifact))
	playgroundUploadAttachment(t, 8, otherSession, "usage-file-other", "image/png", playgroundPNGFixture(32))
	createCanvasProject(t, 8, "usage-canvas-other")

	usageTasks := []model.Task{
		{TaskID: "usage-pg-active", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusInProgress, SubmitTime: common.GetTimestamp(), PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
		{TaskID: "usage-pg-finished", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusSuccess, SubmitTime: common.GetTimestamp(), FinishTime: common.GetTimestamp(),
			Data: []byte(playgroundTaskDataFixture(512)), PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
		{TaskID: "usage-api-finished", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusSuccess, SubmitTime: common.GetTimestamp(), FinishTime: common.GetTimestamp(),
			Data: []byte(playgroundTaskDataFixture(256))},
		{TaskID: "usage-pg-other", Platform: "sunoapi", UserId: 8, Status: model.TaskStatusInProgress, SubmitTime: common.GetTimestamp(), PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
	}
	for index := range usageTasks {
		require.NoError(t, model.DB.Create(&usageTasks[index]).Error)
	}

	usage, err := model.PlaygroundUsageForUser(7)
	require.NoError(t, err)

	assert.Equal(t, "default", usage.Group, "the view names the group its limits came from")
	assert.EqualValues(t, 1, usage.Sessions.Used)
	assert.EqualValues(t, 5, usage.Sessions.Limit)
	assert.EqualValues(t, 1, usage.Memories.Used)
	assert.EqualValues(t, 7, usage.Memories.Limit)
	assert.EqualValues(t, 1, usage.Attachments.Used)
	assert.EqualValues(t, 4, usage.Attachments.Limit)
	assert.EqualValues(t, 64, usage.Attachments.UsedBytes)
	assert.EqualValues(t, 4096, usage.Attachments.LimitBytes)
	assert.EqualValues(t, 1, usage.Artifacts.Used)
	assert.EqualValues(t, 3, usage.Artifacts.Limit)
	assert.EqualValues(t, len(*input.Content), usage.Artifacts.UsedBytes)
	assert.EqualValues(t, 8192, usage.Artifacts.LimitBytes)
	assert.EqualValues(t, 1, usage.Canvas.Used)
	assert.EqualValues(t, 9, usage.Canvas.Limit)
	assert.NotZero(t, usage.Canvas.UsedBytes)
	assert.EqualValues(t, 16384, usage.Canvas.LimitBytes)
	assert.EqualValues(t, 64, usage.Storage.UsedBytes, "object-store bytes are the upload budget figure")
	assert.EqualValues(t, 1<<22, usage.Storage.LimitBytes, "the group override sets the storage entitlement")
	assert.EqualValues(t, 1, usage.Tasks.Used)
	assert.EqualValues(t, 4, usage.Tasks.Limit)
	assert.EqualValues(t, len(playgroundTaskDataFixture(512)), usage.Tasks.UsedBytes)
	assert.EqualValues(t, 1<<20, usage.Tasks.LimitBytes)
}

// The account counters of every Playground resource are maintained inside the
// write transactions that create or remove the resource, and the unified usage
// view reports those counters. Deleting a conversation releases everything its
// cascade removed.
func TestPlaygroundUserUsageCounters(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			sessionID, input := playgroundArtifactSourceFixture(t, 7, "usage-counters")
			counters := playgroundUsageCounters(t, db, 7)
			assert.EqualValues(t, 1, counters.Sessions)
			assert.Zero(t, counters.Presets)
			assert.Zero(t, counters.AttachmentCount)
			assert.Zero(t, counters.ArtifactCount)
			assert.Zero(t, counters.CanvasCount)

			png := playgroundPNGFixture(64)
			uploaded := playgroundUploadAttachment(t, 7, sessionID, "usage-counter-file", "image/png", png)
			attachmentID := uploaded["id"].(string)
			created := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+sessionID+"/artifacts", input, controller.CreatePlaygroundArtifact))
			canvas := createCanvasProject(t, 7, "usage-counters-canvas")
			preset := model.PlaygroundPreset{Name: "Preset", Config: "{}", ParameterEnabled: "{}"}
			require.NoError(t, model.CreatePlaygroundPreset(7, &preset))

			counters = playgroundUsageCounters(t, db, 7)
			assert.EqualValues(t, 1, counters.AttachmentCount)
			assert.EqualValues(t, len(png), counters.AttachmentBytes)
			assert.EqualValues(t, len(png), counters.ObjectBytes)
			assert.EqualValues(t, 1, counters.ArtifactCount)
			assert.EqualValues(t, len(*input.Content), counters.ArtifactBytes)
			assert.EqualValues(t, 1, counters.CanvasCount)
			var storedCanvas model.PlaygroundCanvasProject
			require.NoError(t, db.Where("id = ?", canvas["id"].(string)).First(&storedCanvas).Error)
			assert.EqualValues(t, storedCanvas.DocumentBytes, counters.CanvasBytes)
			assert.EqualValues(t, 1, counters.Presets)

			// A new artifact version adds its bytes; the counts stay put.
			revision := created.Artifact.Revision
			saved := strings.Repeat("题", 100)
			savedResult := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+sessionID+"/artifacts/"+created.Artifact.ID+"/versions",
				model.SavePlaygroundArtifactInput{RequestID: "usage-counter-save", ExpectedRevision: &revision, Title: "Saved", Language: "markdown", Content: &saved}, controller.SavePlaygroundArtifactVersion))
			counters = playgroundUsageCounters(t, db, 7)
			assert.EqualValues(t, 1, counters.ArtifactCount)
			assert.EqualValues(t, len(*input.Content)+len(saved), counters.ArtifactBytes)

			usage, err := model.PlaygroundUsageForUser(7)
			require.NoError(t, err)
			assert.EqualValues(t, counters.Sessions, usage.Sessions.Used)
			assert.EqualValues(t, counters.AttachmentCount, usage.Attachments.Used)
			assert.EqualValues(t, counters.AttachmentBytes, usage.Attachments.UsedBytes)
			assert.EqualValues(t, counters.ArtifactCount, usage.Artifacts.Used)
			assert.EqualValues(t, counters.ArtifactBytes, usage.Artifacts.UsedBytes)
			assert.EqualValues(t, counters.CanvasCount, usage.Canvas.Used)
			assert.EqualValues(t, counters.CanvasBytes, usage.Canvas.UsedBytes)
			assert.EqualValues(t, counters.ObjectBytes, usage.Storage.UsedBytes)
			assert.Equal(t, "default", usage.Group)

			// Another account never observes these counters.
			var foreignCount int64
			require.NoError(t, db.Model(&model.PlaygroundUserUsage{}).Where("user_id = ?", 8).Count(&foreignCount).Error)
			assert.Zero(t, foreignCount)

			// Removing each resource decrements its counter.
			require.NoError(t, model.DeletePlaygroundPreset(7, preset.ID))
			require.NoError(t, model.DeletePlaygroundArtifact(7, sessionID, created.Artifact.ID, savedResult.Artifact.Revision))
			counters = playgroundUsageCounters(t, db, 7)
			assert.Zero(t, counters.Presets)
			assert.Zero(t, counters.ArtifactCount)
			assert.Zero(t, counters.ArtifactBytes)

			// A trashed canvas keeps its slot and bytes in the counters; the
			// purge releases them.
			require.NoError(t, model.DeletePlaygroundCanvasProject(7, storedCanvas.ID))
			counters = playgroundUsageCounters(t, db, 7)
			assert.EqualValues(t, 1, counters.CanvasCount)
			assert.NotZero(t, counters.CanvasBytes)
			require.NoError(t, model.PurgePlaygroundCanvasProject(7, storedCanvas.ID))
			counters = playgroundUsageCounters(t, db, 7)
			assert.Zero(t, counters.CanvasCount)
			assert.Zero(t, counters.CanvasBytes)

			require.NoError(t, model.DeletePlaygroundAttachment(7, sessionID, attachmentID))
			counters = playgroundUsageCounters(t, db, 7)
			assert.Zero(t, counters.AttachmentCount)
			assert.Zero(t, counters.AttachmentBytes)
			assert.Zero(t, counters.ObjectBytes)

			// A trashed conversation keeps counting until its purge releases
			// everything the cascade removes.
			require.NoError(t, model.DeletePlaygroundSession(7, sessionID))
			counters = playgroundUsageCounters(t, db, 7)
			assert.EqualValues(t, 1, counters.Sessions)
			require.NoError(t, model.PurgePlaygroundSession(7, sessionID))
			counters = playgroundUsageCounters(t, db, 7)
			assert.EqualValues(t, 0, counters.Sessions)
			assert.Zero(t, counters.AttachmentBytes)
			assert.Zero(t, counters.ArtifactBytes)
			assert.Zero(t, counters.CanvasBytes)
			assert.Zero(t, counters.ObjectBytes)
		})
	}
}

// The counter row is derived state: an account measured before the counters
// existed is initialized lazily by the first write (or by the reconciliation),
// the read path measures on the fly without writing, and the daily
// reconciliation repairs a drifted row without touching any resource.
func TestPlaygroundUserUsageLazyInitAndReconcile(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			sessionID, input := playgroundArtifactSourceFixture(t, 7, "usage-lazy")
			png := playgroundPNGFixture(64)
			playgroundUploadAttachment(t, 7, sessionID, "usage-lazy-file", "image/png", png)
			artifactResult(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+sessionID+"/artifacts", input, controller.CreatePlaygroundArtifact))
			createCanvasProject(t, 7, "usage-lazy-canvas")
			expected := playgroundUsageCounters(t, db, 7)

			// Simulate a database written before the counters existed: the
			// stored resources stay, only the derived row is gone.
			require.NoError(t, db.Where("user_id = ?", 7).Delete(&model.PlaygroundUserUsage{}).Error)
			usage, err := model.PlaygroundUsageForUser(7)
			require.NoError(t, err)
			assert.EqualValues(t, expected.Sessions, usage.Sessions.Used)
			assert.EqualValues(t, expected.AttachmentCount, usage.Attachments.Used)
			assert.EqualValues(t, expected.AttachmentBytes, usage.Attachments.UsedBytes)
			assert.EqualValues(t, expected.ArtifactCount, usage.Artifacts.Used)
			assert.EqualValues(t, expected.ArtifactBytes, usage.Artifacts.UsedBytes)
			assert.EqualValues(t, expected.CanvasCount, usage.Canvas.Used)
			assert.EqualValues(t, expected.CanvasBytes, usage.Canvas.UsedBytes)
			var count int64
			require.NoError(t, db.Model(&model.PlaygroundUserUsage{}).Where("user_id = ?", 7).Count(&count).Error)
			assert.Zero(t, count, "the usage read must not create the counter row")

			// The reconciliation initializes the missing row from the rows.
			report, err := model.ReconcilePlaygroundUserUsage(10)
			require.NoError(t, err)
			assert.EqualValues(t, 1, report.UserCount)
			assert.Zero(t, report.RepairedCount, "initialization is not a repair")
			assert.Equal(t, playgroundUsageCounterValues(expected), playgroundUsageCounterValues(playgroundUsageCounters(t, db, 7)))

			// The read path trusts the stored counter: a manual drift is
			// visible until the reconciliation repairs it.
			require.NoError(t, db.Model(&model.PlaygroundUserUsage{}).Where("user_id = ?", 7).
				Updates(map[string]any{"sessions": 9, "attachment_bytes": 1, "artifact_count": 0}).Error)
			usage, err = model.PlaygroundUsageForUser(7)
			require.NoError(t, err)
			assert.EqualValues(t, 9, usage.Sessions.Used)
			assert.EqualValues(t, 1, usage.Attachments.UsedBytes)

			report, err = model.ReconcilePlaygroundUserUsage(10)
			require.NoError(t, err)
			assert.EqualValues(t, 1, report.RepairedCount)
			require.Len(t, report.Repairs, 1)
			assert.Equal(t, 7, report.Repairs[0].UserID)
			assert.EqualValues(t, 9, report.Repairs[0].Stored.Sessions)
			assert.EqualValues(t, expected.Sessions, report.Repairs[0].Actual.Sessions)
			assert.Equal(t, playgroundUsageCounterValues(expected), playgroundUsageCounterValues(playgroundUsageCounters(t, db, 7)))

			// A converged account is not reported again and keeps its data.
			report, err = model.ReconcilePlaygroundUserUsage(10)
			require.NoError(t, err)
			assert.Zero(t, report.RepairedCount)
			var sessions int64
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("user_id = ?", 7).Count(&sessions).Error)
			assert.EqualValues(t, 1, sessions)
		})
	}
}

// The counter row is the serialization point of the per-account budgets, so two
// uploads to different partitions cannot both pass a byte budget they jointly
// exceed.
func TestPlaygroundUserUsageBudgetSerialization(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.AttachmentUserMaxBytes = 100
			})
			sessionID, _ := playgroundArtifactSourceFixture(t, 7, "usage-budget")
			canvas := createCanvasProject(t, 7, "usage-budget-canvas")
			canvasID := canvas["id"].(string)

			outcomes := make(chan error, 2)
			start := make(chan struct{})
			upload := func(create func(context.Context, int, string, model.PlaygroundAttachmentInput) (*model.PlaygroundAttachment, bool, error), partition, clientKey string) {
				<-start
				_, _, err := create(context.Background(), 7, partition, model.PlaygroundAttachmentInput{
					ClientKey: clientKey, MediaType: "image/png", Filename: "image.png", Data: playgroundPNGFixture(64),
				})
				outcomes <- err
			}
			// Each upload locks its own partition first, so the two only
			// serialize on the shared account counter row.
			go upload(model.CreatePlaygroundAttachment, sessionID, "usage-budget-a")
			go upload(model.CreatePlaygroundCanvasAttachment, canvasID, "usage-budget-b")
			close(start)
			first, second := <-outcomes, <-outcomes
			if first == nil {
				assert.ErrorIs(t, second, model.ErrPlaygroundAttachmentLimit)
			} else {
				assert.ErrorIs(t, first, model.ErrPlaygroundAttachmentLimit)
				require.NoError(t, second)
			}
			counters := playgroundUsageCounters(t, db, 7)
			assert.EqualValues(t, 1, counters.AttachmentCount)
			assert.EqualValues(t, 64, counters.AttachmentBytes)
			assert.EqualValues(t, 64, counters.ObjectBytes)
		})
	}
}

// playgroundUsageCounters reads one account's stored counter row.
func playgroundUsageCounters(t *testing.T, db *gorm.DB, userID int) model.PlaygroundUserUsage {
	t.Helper()
	var usage model.PlaygroundUserUsage
	require.NoError(t, db.Where("user_id = ?", userID).First(&usage).Error)
	return usage
}

// playgroundUsageCounterValues compares counters without the row's identity and
// timestamps, which the model keeps private.
func playgroundUsageCounterValues(usage model.PlaygroundUserUsage) []int64 {
	return []int64{
		usage.Sessions, usage.Presets,
		usage.AttachmentCount, usage.AttachmentBytes, usage.ObjectBytes,
		usage.AttachmentPendingCount, usage.AttachmentPendingBytes,
		usage.ArtifactCount, usage.ArtifactBytes,
		usage.CanvasCount, usage.CanvasBytes,
		usage.KnowledgeBaseCount, usage.KnowledgeBaseDocumentCount,
		usage.KnowledgeBaseChunkCount, usage.KnowledgeBaseBytes,
	}
}

// The account-level artifact budget is enforced on the write path, so the
// unified usage view never advertises room the server would refuse.
func TestPlaygroundArtifactAccountLimit(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.ArtifactUserMaxCount = 1
	})
	firstSession, firstInput := playgroundArtifactSourceFixture(t, 7, "artifact-account-a")
	artifactResult(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+firstSession+"/artifacts", firstInput, controller.CreatePlaygroundArtifact))
	secondSession, secondInput := playgroundArtifactSourceFixture(t, 7, "artifact-account-b")
	secondInput.RequestID = "create_2"
	response := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+secondSession+"/artifacts", secondInput, controller.CreatePlaygroundArtifact)
	assert.Equal(t, http.StatusUnprocessableEntity, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "PLAYGROUND_ARTIFACT_LIMIT_EXCEEDED")
}

// Async generation task concurrency is an independent Playground resource
// budget: the count reads durable task rows of one account and never touches
// token quota, and a group override replaces the global default.
func TestPlaygroundTaskConcurrencyCount(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.TaskMaxConcurrency = 2
	})
	usePlaygroundGroupQuota(t, "default", playground_setting.PlaygroundQuotaPolicy{TaskMaxConcurrency: 1})

	tasks := []model.Task{
		{TaskID: "pg-task-queued", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusQueued, SubmitTime: 1},
		{TaskID: "pg-task-running", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusInProgress, SubmitTime: 2},
		{TaskID: "pg-task-failed", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusFailure, SubmitTime: 3},
		{TaskID: "pg-task-done", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusSuccess, SubmitTime: 4},
		{TaskID: "pg-task-other", Platform: "sunoapi", UserId: 8, Status: model.TaskStatusSubmitted, SubmitTime: 5},
	}
	for index := range tasks {
		require.NoError(t, db.Create(&tasks[index]).Error)
	}

	count, err := model.CountActivePlaygroundTasks(7)
	require.NoError(t, err)
	assert.EqualValues(t, 2, count, "only unfinished tasks of the owner consume the budget")
	count, err = model.CountActivePlaygroundTasks(8)
	require.NoError(t, err)
	assert.EqualValues(t, 1, count)
	count, err = model.CountActivePlaygroundTasks(0)
	require.NoError(t, err)
	assert.EqualValues(t, 0, count)

	policy, err := model.PlaygroundQuotaPolicyForUser(7)
	require.NoError(t, err)
	assert.Equal(t, 1, policy.TaskMaxConcurrency, "the group override replaces the global default")

	// Finishing one task frees a slot without deleting the row.
	require.NoError(t, db.Model(&model.Task{}).Where("task_id = ?", "pg-task-queued").Update("status", model.TaskStatusSuccess).Error)
	count, err = model.CountActivePlaygroundTasks(7)
	require.NoError(t, err)
	assert.EqualValues(t, 1, count)
}

// playgroundTaskDataFixture builds a valid result snapshot whose serialized
// size is deterministic, so storage assertions do not depend on the exact
// bytes the database serializes back.
func playgroundTaskDataFixture(size int) string {
	return `{"url":"https://cdn.example.com/` + strings.Repeat("a", size) + `.mp4"}`
}

// The account-level result storage budget counts only Playground-origin task
// snapshots and is enforced before a new workspace submission is accepted.
func TestPlaygroundTaskStorageBudget(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.TaskMaxConcurrency = 3
				policy.TaskUserResultMaxBytes = 1 << 20
			})

			snapshot := playgroundTaskDataFixture(2048)
			keep := model.Task{TaskID: "pg-budget-finished", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusSuccess,
				SubmitTime: common.GetTimestamp(), FinishTime: common.GetTimestamp(),
				Data: []byte(snapshot), PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}}
			require.NoError(t, db.Create(&keep).Error)

			stored, err := model.PlaygroundTaskResultStorageBytes(7)
			require.NoError(t, err)
			assert.GreaterOrEqual(t, stored, int64(len(snapshot)))
			assert.LessOrEqual(t, stored, int64(len(snapshot)+64))

			// A direct API task snapshot never consumes the workspace budget.
			direct := model.Task{TaskID: "api-budget-finished", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusSuccess,
				SubmitTime: common.GetTimestamp(), FinishTime: common.GetTimestamp(), Data: []byte(playgroundTaskDataFixture(4096))}
			require.NoError(t, db.Create(&direct).Error)
			storedWithDirect, err := model.PlaygroundTaskResultStorageBytes(7)
			require.NoError(t, err)
			assert.Equal(t, stored, storedWithDirect)

			stored, err = model.PlaygroundTaskResultStorageBytes(8)
			require.NoError(t, err)
			assert.Zero(t, stored)

			// Over the limit, a workspace submission is rejected with the
			// stable storage code before the relay pipeline starts.
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.TaskUserResultMaxBytes = 1024
			})
			active := model.Task{TaskID: "pg-budget-active", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusInProgress,
				SubmitTime: common.GetTimestamp(), PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}}
			require.NoError(t, db.Create(&active).Error)
			response := playgroundRequest(t, 7, http.MethodPost, "/v1/videos", map[string]any{"model": "kling-v1", "prompt": "fox"}, controller.PlaygroundVideoTask)
			assert.Equal(t, http.StatusTooManyRequests, response.Code, response.Body.String())
			assert.Contains(t, response.Body.String(), controller.PlaygroundTaskStorageLimitErrorCode)
		})
	}
}

// The workspace rejects new billable work (generation and uploads) from an
// account with unsettled wallet debt; the debt is re-read on the server and the
// account recovers automatically once a recharge covers it.
func TestPlaygroundWalletDebtGatesNewWork(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			// The recharge below can only collect the debt from money above the
			// account's overdraft credit line, so pin that line to zero.
			previousQuotaSetting := *operation_setting.GetQuotaSetting()
			operation_setting.GetQuotaSetting().OverdraftLimitUSD = 0
			operation_setting.GetQuotaSetting().OverdraftGroupOverrides = nil
			t.Cleanup(func() { *operation_setting.GetQuotaSetting() = previousQuotaSetting })
			require.NoError(t, db.Create(&model.WalletDebt{UserId: 9, Amount: 2_500}).Error)

			generation := playgroundRequest(t, 9, http.MethodPost, "/v1/videos", map[string]any{"model": "kling-v1", "prompt": "fox"}, controller.PlaygroundVideoTask)
			assert.Equal(t, http.StatusForbidden, generation.Code, generation.Body.String())
			assert.Contains(t, generation.Body.String(), controller.PlaygroundWalletDebtErrorCode)

			upload := playgroundRequest(t, 9, http.MethodPost, "/api/playground/sessions/session-1/attachments", map[string]any{}, controller.CreatePlaygroundAttachment)
			assert.Equal(t, http.StatusForbidden, upload.Code, upload.Body.String())
			assert.Contains(t, upload.Body.String(), controller.PlaygroundWalletDebtErrorCode)

			// Reads stay available while the wallet holds debt.
			read := playgroundRequest(t, 9, http.MethodGet, "/api/playground/sessions", nil, controller.ListPlaygroundSessions)
			assert.NotEqual(t, http.StatusForbidden, read.Code, read.Body.String())

			// Recharging covers the debt, so the read-only lock clears by itself.
			_, err := model.ApplyWalletLedgerDeltaDB(9, model.WalletLedgerKindTopUp, 5_000, model.WalletLedgerRefTopUp, "pg-debt-topup", "")
			require.NoError(t, err)
			recovered := playgroundRequest(t, 9, http.MethodPost, "/v1/videos", map[string]any{"model": "kling-v1", "prompt": "fox"}, controller.PlaygroundVideoTask)
			assert.NotContains(t, recovered.Body.String(), controller.PlaygroundWalletDebtErrorCode, recovered.Body.String())
			balance, err := model.GetUserQuota(9, true)
			require.NoError(t, err)
			assert.Equal(t, 2_500, balance, "the recharge paid the debt instead of becoming spendable")
		})
	}
}

// The scheduled cleanup removes only terminal Playground-origin task rows that
// outlived the retention window; running, recent, and direct API rows stay.
func TestPlaygroundTaskExpiryCleanup(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			now := common.GetTimestamp()
			expired := now - int64((8 * 24 * time.Hour).Seconds())
			recent := now - int64(time.Hour.Seconds())
			tasks := []model.Task{
				{TaskID: "pg-expired", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusSuccess, SubmitTime: expired, FinishTime: expired,
					Data: []byte(playgroundTaskDataFixture(128)), PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
				{TaskID: "pg-expired-failed", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusFailure, SubmitTime: expired, FinishTime: expired,
					PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
				{TaskID: "pg-recent", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusSuccess, SubmitTime: recent, FinishTime: recent,
					Data: []byte(playgroundTaskDataFixture(128)), PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
				{TaskID: "pg-running", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusInProgress, SubmitTime: expired,
					PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
				{TaskID: "pg-no-finish", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusSuccess, SubmitTime: expired,
					PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
				{TaskID: "api-expired", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusSuccess, SubmitTime: expired, FinishTime: expired,
					Data: []byte(playgroundTaskDataFixture(128))},
			}
			for index := range tasks {
				require.NoError(t, db.Create(&tasks[index]).Error)
			}

			deleted, err := model.DeleteExpiredPlaygroundTasks(now-int64((7*24*time.Hour).Seconds()), 100)
			require.NoError(t, err)
			assert.EqualValues(t, 2, deleted)

			var remaining []string
			require.NoError(t, db.Model(&model.Task{}).Where("user_id = ?", 7).Order("task_id ASC").Pluck("task_id", &remaining).Error)
			assert.Equal(t, []string{"api-expired", "pg-no-finish", "pg-recent", "pg-running"}, remaining)
		})
	}
}

// Cancellation is owner-scoped to Playground-origin tasks and transitions the
// row with a status CAS, so a task that already completed cannot be canceled
// and its reserved quota stays intact for the caller's refund.
func TestPlaygroundTaskCancellation(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	now := common.GetTimestamp()
	tasks := []model.Task{
		{TaskID: "pg-cancel-active", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusInProgress, SubmitTime: now,
			Quota: 50, PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
		{TaskID: "pg-cancel-done", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusSuccess, SubmitTime: now, FinishTime: now,
			Data: []byte(playgroundTaskDataFixture(64)), PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
		{TaskID: "pg-cancel-other", Platform: "sunoapi", UserId: 8, Status: model.TaskStatusQueued, SubmitTime: now,
			PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}},
		{TaskID: "api-cancel-active", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusInProgress, SubmitTime: now},
	}
	for index := range tasks {
		require.NoError(t, db.Create(&tasks[index]).Error)
	}

	// Another account's rows and direct API rows are invisible to the workspace.
	for _, foreign := range []struct {
		user   int
		taskID string
	}{
		{8, "pg-cancel-active"},
		{7, "api-cancel-active"},
		{7, "pg-cancel-missing"},
		{0, "pg-cancel-active"},
	} {
		_, err := model.CancelPlaygroundTask(foreign.user, foreign.taskID)
		assert.ErrorIs(t, err, model.ErrPlaygroundTaskNotFound, "task %s for user %d", foreign.taskID, foreign.user)
	}

	// A task that already reached a terminal state cannot be canceled twice.
	_, err := model.CancelPlaygroundTask(7, "pg-cancel-done")
	assert.ErrorIs(t, err, model.ErrPlaygroundTaskNotCancelable)

	canceled, err := model.CancelPlaygroundTask(7, "pg-cancel-active")
	require.NoError(t, err)
	assert.Equal(t, model.TaskStatus(model.TaskStatusFailure), canceled.Status)
	assert.Equal(t, "100%", canceled.Progress)
	assert.Equal(t, model.PlaygroundTaskCanceledReason, canceled.FailReason)
	assert.NotZero(t, canceled.FinishTime)
	assert.Equal(t, 50, canceled.Quota, "the caller refunds the reserved quota after the CAS win")

	_, err = model.CancelPlaygroundTask(7, "pg-cancel-active")
	assert.ErrorIs(t, err, model.ErrPlaygroundTaskNotCancelable)

	var stored model.Task
	require.NoError(t, db.Where("task_id = ?", "pg-cancel-active").First(&stored).Error)
	assert.Equal(t, model.TaskStatus(model.TaskStatusFailure), stored.Status)
	assert.Equal(t, model.PlaygroundTaskCanceledReason, stored.FailReason)

	// The route contract maps owner scope to 404 and terminal rows to 409.
	response := playgroundRequest(t, 7, http.MethodPost, "/api/playground/tasks/pg-cancel-other/cancel", nil, controller.PlaygroundTaskCancel)
	assert.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "PLAYGROUND_TASK_NOT_FOUND")
	response = playgroundRequest(t, 7, http.MethodPost, "/api/playground/tasks/pg-cancel-done/cancel", nil, controller.PlaygroundTaskCancel)
	assert.Equal(t, http.StatusConflict, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "PLAYGROUND_TASK_NOT_CANCELABLE")

	// A quota-free running task cancels through the route with the stable success envelope.
	zeroQuota := model.Task{TaskID: "pg-cancel-zero", Platform: "sunoapi", UserId: 7, Status: model.TaskStatusQueued, SubmitTime: now,
		PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}}
	require.NoError(t, db.Create(&zeroQuota).Error)
	response = playgroundRequest(t, 7, http.MethodPost, "/api/playground/tasks/pg-cancel-zero/cancel", nil, controller.PlaygroundTaskCancel)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), `"success":true`)
	// First() pins the destination's primary key into the query, so drop the
	// previously loaded row before looking up the next task.
	stored = model.Task{}
	require.NoError(t, db.Where("task_id = ?", "pg-cancel-zero").First(&stored).Error)
	assert.Equal(t, model.TaskStatus(model.TaskStatusFailure), stored.Status)
	assert.Equal(t, model.PlaygroundTaskCanceledReason, stored.FailReason)
}

// Assistant presets are owner-scoped server resources: another account can
// neither list nor mutate them, every display field is validated on write, and
// the per-account budget comes from the shared resource quota policy.
func TestPlaygroundPresetPersistenceAndOwnership(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			// The new table is part of the migration contract and must stay
			// idempotent on every dialect.
			require.NoError(t, db.AutoMigrate(&model.PlaygroundPreset{}))

			created := playgroundRequest(t, 7, http.MethodPost, "/api/playground/presets", map[string]any{
				"name": "  Code reviewer  ", "avatar": "🧑💻",
				"config":            map[string]any{"model": "test-model", "temperature": 0.2},
				"parameter_enabled": map[string]bool{"temperature": true},
				"system_prompt":     "Review code carefully.",
				"opening_message":   "Welcome aboard.",
				"suggested_questions": []string{
					"Explain the diff", "  Find bugs  ", "Explain the diff",
				},
				"visibility": "global",
			}, controller.CreatePlaygroundPreset)
			require.Equal(t, http.StatusOK, created.Code, created.Body.String())
			var envelope struct {
				Success bool
				Data    struct {
					ID                 string          `json:"id"`
					Name               string          `json:"name"`
					Avatar             string          `json:"avatar"`
					Config             map[string]any  `json:"config"`
					ParameterEnabled   map[string]bool `json:"parameter_enabled"`
					SystemPrompt       string          `json:"system_prompt"`
					Visibility         string          `json:"visibility"`
					OpeningMessage     string          `json:"opening_message"`
					SuggestedQuestions []string        `json:"suggested_questions"`
					CreatedAt          int64           `json:"created_at"`
					UpdatedAt          int64           `json:"updated_at"`
				}
			}
			require.NoError(t, common.Unmarshal(created.Body.Bytes(), &envelope))
			require.True(t, envelope.Success, created.Body.String())
			id := envelope.Data.ID
			require.True(t, strings.HasPrefix(id, "pgp_"), id)
			assert.Equal(t, "Code reviewer", envelope.Data.Name)
			assert.Equal(t, "🧑💻", envelope.Data.Avatar)
			assert.Equal(t, "Review code carefully.", envelope.Data.SystemPrompt)
			assert.Equal(t, "Welcome aboard.", envelope.Data.OpeningMessage)
			assert.Equal(t, []string{"Explain the diff", "Find bugs"}, envelope.Data.SuggestedQuestions)
			assert.Equal(t, model.PlaygroundPresetVisibilityPrivate, envelope.Data.Visibility, "a user request can never promote a preset")
			assert.EqualValues(t, 0.2, envelope.Data.Config["temperature"])
			assert.True(t, envelope.Data.ParameterEnabled["temperature"])
			assert.NotZero(t, envelope.Data.CreatedAt)

			// The listing is owner-scoped and reports the effective budget.
			listed := playgroundRequest(t, 7, http.MethodGet, "/api/playground/presets", nil, controller.ListPlaygroundPresets)
			var listing struct {
				Success bool
				Data    struct {
					Items []struct{ ID string }
					Total int
					Limit int
				}
			}
			require.NoError(t, common.Unmarshal(listed.Body.Bytes(), &listing))
			require.True(t, listing.Success, listed.Body.String())
			require.Len(t, listing.Data.Items, 1)
			assert.Equal(t, id, listing.Data.Items[0].ID)
			assert.Equal(t, 1, listing.Data.Total)
			assert.Equal(t, playground_setting.GetPlaygroundQuotaPolicy("default").PresetUserMaxCount, listing.Data.Limit)
			foreignList := playgroundRequest(t, 8, http.MethodGet, "/api/playground/presets", nil, controller.ListPlaygroundPresets)
			assert.Contains(t, foreignList.Body.String(), `"total":0`)

			// Mutation is owner-scoped; another account gets the same 404.
			foreignRead := playgroundRequest(t, 8, http.MethodGet, "/api/playground/presets/"+id, nil, controller.GetPlaygroundPreset)
			assert.Equal(t, http.StatusNotFound, foreignRead.Code, foreignRead.Body.String())
			ownRead := playgroundRequest(t, 7, http.MethodGet, "/api/playground/presets/"+id, nil, controller.GetPlaygroundPreset)
			require.Equal(t, http.StatusOK, ownRead.Code, ownRead.Body.String())
			assert.Contains(t, ownRead.Body.String(), `"name":"Code reviewer"`)
			foreignUpdate := playgroundRequest(t, 8, http.MethodPatch, "/api/playground/presets/"+id, map[string]any{"name": "Hijacked"}, controller.UpdatePlaygroundPreset)
			assert.Equal(t, http.StatusNotFound, foreignUpdate.Code, foreignUpdate.Body.String())
			assert.Contains(t, foreignUpdate.Body.String(), "PLAYGROUND_NOT_FOUND")
			foreignDelete := playgroundRequest(t, 8, http.MethodDelete, "/api/playground/presets/"+id, nil, controller.DeletePlaygroundPreset)
			assert.Equal(t, http.StatusNotFound, foreignDelete.Code, foreignDelete.Body.String())

			updated := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/presets/"+id, map[string]any{
				"name": "Reviewer", "avatar": "https://example.com/avatar.png", "system_prompt": "Review twice.",
				"opening_message": "Welcome back.", "suggested_questions": []string{"Review again"},
				"visibility": "global",
			}, controller.UpdatePlaygroundPreset)
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			var updatedEnvelope struct {
				Data struct {
					Name               string         `json:"name"`
					Avatar             string         `json:"avatar"`
					SystemPrompt       string         `json:"system_prompt"`
					Visibility         string         `json:"visibility"`
					OpeningMessage     string         `json:"opening_message"`
					SuggestedQuestions []string       `json:"suggested_questions"`
					Config             map[string]any `json:"config"`
				}
			}
			require.NoError(t, common.Unmarshal(updated.Body.Bytes(), &updatedEnvelope))
			assert.Equal(t, "Reviewer", updatedEnvelope.Data.Name)
			assert.Equal(t, "https://example.com/avatar.png", updatedEnvelope.Data.Avatar)
			assert.Equal(t, "Review twice.", updatedEnvelope.Data.SystemPrompt)
			assert.Equal(t, "Welcome back.", updatedEnvelope.Data.OpeningMessage)
			assert.Equal(t, []string{"Review again"}, updatedEnvelope.Data.SuggestedQuestions)
			assert.Equal(t, model.PlaygroundPresetVisibilityPrivate, updatedEnvelope.Data.Visibility)
			assert.EqualValues(t, 0.2, updatedEnvelope.Data.Config["temperature"], "unsent fields keep their stored value")

			for name, body := range map[string]map[string]any{
				"empty name":       {"name": "   "},
				"overlong name":    {"name": strings.Repeat("n", 101)},
				"non-http avatar":  {"name": "A", "avatar": "ftp://example.com/a.png"},
				"long text avatar": {"name": "A", "avatar": strings.Repeat("x", 65)},
				"invalid config":   {"name": "A", "config": map[string]any{"temperature": "hot"}},
				"long opening":     {"name": "A", "opening_message": strings.Repeat("x", (8<<10)+1)},
				"nul opening":      {"name": "A", "opening_message": "a\x00b"},
				"too many questions": {
					"name": "A", "suggested_questions": []string{"1", "2", "3", "4", "5", "6", "7"},
				},
				"blank question": {"name": "A", "suggested_questions": []string{"ok", "  "}},
				"long question":  {"name": "A", "suggested_questions": []string{strings.Repeat("q", 201)}},
			} {
				response := playgroundRequest(t, 7, http.MethodPost, "/api/playground/presets", body, controller.CreatePlaygroundPreset)
				assert.Equal(t, http.StatusBadRequest, response.Code, name+": "+response.Body.String())
			}
			emptyPatch := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/presets/"+id, map[string]any{}, controller.UpdatePlaygroundPreset)
			assert.Equal(t, http.StatusBadRequest, emptyPatch.Code, emptyPatch.Body.String())
			assert.Contains(t, emptyPatch.Body.String(), "Invalid assistant preset.")

			// The resource policy bounds both the stored prompt and the account
			// preset count with stable capacity errors.
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.SystemPromptMaxBytes = 16
			})
			tooLong := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/presets/"+id, map[string]any{
				"system_prompt": strings.Repeat("x", 17),
			}, controller.UpdatePlaygroundPreset)
			assert.Equal(t, http.StatusUnprocessableEntity, tooLong.Code, tooLong.Body.String())
			assert.Contains(t, tooLong.Body.String(), "PLAYGROUND_SYSTEM_PROMPT_LIMIT_EXCEEDED")
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.PresetUserMaxCount = 1
			})
			overflow := playgroundRequest(t, 7, http.MethodPost, "/api/playground/presets", map[string]any{"name": "One too many"}, controller.CreatePlaygroundPreset)
			assert.Equal(t, http.StatusUnprocessableEntity, overflow.Code, overflow.Body.String())
			assert.Contains(t, overflow.Body.String(), "PLAYGROUND_PRESET_LIMIT_EXCEEDED")

			deleted := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/presets/"+id, nil, controller.DeletePlaygroundPreset)
			require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
			repeat := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/presets/"+id, nil, controller.DeletePlaygroundPreset)
			assert.Equal(t, http.StatusNotFound, repeat.Code, repeat.Body.String())
			var stored int64
			require.NoError(t, db.Model(&model.PlaygroundPreset{}).Where("user_id = ?", 7).Count(&stored).Error)
			assert.Zero(t, stored)
		})
	}
}

// The preset market is administrator-maintained platform content. A global
// preset is readable by every account, a copy is an independent private row,
// and the private endpoints never expose or mutate the global row.
func TestPlaygroundPresetMarketAndGlobalManagement(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)

			type presetPayload struct {
				ID                 string          `json:"id"`
				Name               string          `json:"name"`
				Visibility         string          `json:"visibility"`
				OpeningMessage     string          `json:"opening_message"`
				SuggestedQuestions []string        `json:"suggested_questions"`
				SystemPrompt       string          `json:"system_prompt"`
				Config             map[string]any  `json:"config"`
				ParameterEnabled   map[string]bool `json:"parameter_enabled"`
			}
			decode := func(recorder *httptest.ResponseRecorder) presetPayload {
				t.Helper()
				var envelope struct {
					Success bool
					Data    presetPayload
				}
				require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &envelope))
				require.True(t, envelope.Success, recorder.Body.String())
				return envelope.Data
			}

			global := decode(playgroundRequest(t, 9, http.MethodPost, "/api/playground/presets/global", map[string]any{
				"name": "Market reviewer", "avatar": "🌍",
				"config":            map[string]any{"model": "market-model"},
				"parameter_enabled": map[string]bool{"temperature": true},
				"system_prompt":     "Review for everyone.",
				"opening_message":   "Welcome to the market.",
				"suggested_questions": []string{
					"Start here", "Explain this",
				},
			}, controller.CreateGlobalPlaygroundPreset))
			require.True(t, strings.HasPrefix(global.ID, "pgp_"), global.ID)
			assert.Equal(t, model.PlaygroundPresetVisibilityGlobal, global.Visibility)
			assert.Equal(t, "Welcome to the market.", global.OpeningMessage)
			assert.Equal(t, []string{"Start here", "Explain this"}, global.SuggestedQuestions)

			// Global presets are platform content: they have no owner and do
			// not consume the administrator's private budget.
			var stored model.PlaygroundPreset
			require.NoError(t, db.Where("id = ?", global.ID).First(&stored).Error)
			assert.Zero(t, stored.UserID)
			assert.Equal(t, model.PlaygroundPresetVisibilityGlobal, stored.Visibility)
			privateList := playgroundRequest(t, 9, http.MethodGet, "/api/playground/presets", nil, controller.ListPlaygroundPresets)
			assert.Contains(t, privateList.Body.String(), `"total":0`)

			// Every account sees the same row in the market.
			market := playgroundRequest(t, 7, http.MethodGet, "/api/playground/presets/market", nil, controller.ListPlaygroundPresetMarket)
			require.Equal(t, http.StatusOK, market.Code, market.Body.String())
			assert.Contains(t, market.Body.String(), `"total":1`)
			assert.Contains(t, market.Body.String(), `"visibility":"global"`)
			adminMarket := playgroundRequest(t, 9, http.MethodGet, "/api/playground/presets/global", nil, controller.ListGlobalPlaygroundPresets)
			assert.Contains(t, adminMarket.Body.String(), global.ID)

			// The private endpoints are owner-scoped: a global id behaves
			// exactly like an id the caller does not own.
			for name, response := range map[string]*httptest.ResponseRecorder{
				"read":   playgroundRequest(t, 7, http.MethodGet, "/api/playground/presets/"+global.ID, nil, controller.GetPlaygroundPreset),
				"update": playgroundRequest(t, 7, http.MethodPatch, "/api/playground/presets/"+global.ID, map[string]any{"name": "Hijacked"}, controller.UpdatePlaygroundPreset),
				"delete": playgroundRequest(t, 7, http.MethodDelete, "/api/playground/presets/"+global.ID, nil, controller.DeletePlaygroundPreset),
			} {
				assert.Equal(t, http.StatusNotFound, response.Code, name+": "+response.Body.String())
			}

			// Copying creates an independent private row for the caller.
			copied := decode(playgroundRequest(t, 7, http.MethodPost, "/api/playground/presets/market/"+global.ID+"/copy", nil, controller.CopyPlaygroundPresetFromMarket))
			assert.NotEqual(t, global.ID, copied.ID)
			assert.Equal(t, model.PlaygroundPresetVisibilityPrivate, copied.Visibility)
			assert.Equal(t, global.Name, copied.Name)
			assert.Equal(t, global.OpeningMessage, copied.OpeningMessage)
			assert.Equal(t, global.SuggestedQuestions, copied.SuggestedQuestions)
			assert.Equal(t, global.SystemPrompt, copied.SystemPrompt)
			var copiedRow model.PlaygroundPreset
			require.NoError(t, db.Where("id = ?", copied.ID).First(&copiedRow).Error)
			assert.Equal(t, 7, copiedRow.UserID)
			assert.Equal(t, model.PlaygroundPresetVisibilityPrivate, copiedRow.Visibility)

			// JSON export carries the portable fields; importing it into
			// another account runs the ordinary validation and creates a
			// private copy owned by that account.
			exported := playgroundRequest(t, 9, http.MethodGet, "/api/playground/presets/global/"+global.ID+"/export", nil, controller.ExportGlobalPlaygroundPreset)
			require.Equal(t, http.StatusOK, exported.Code, exported.Body.String())
			var exportEnvelope struct {
				Data struct {
					Format      string `json:"format"`
					Filename    string `json:"filename"`
					ContentType string `json:"content_type"`
					Content     string `json:"content"`
				}
			}
			require.NoError(t, common.Unmarshal(exported.Body.Bytes(), &exportEnvelope))
			assert.Equal(t, "application/json; charset=utf-8", exportEnvelope.Data.ContentType)
			assert.True(t, strings.HasSuffix(exportEnvelope.Data.Filename, ".json"))
			imported := decode(playgroundRequest(t, 8, http.MethodPost, "/api/playground/presets/import", []byte(exportEnvelope.Data.Content), controller.ImportPlaygroundPreset))
			assert.Equal(t, model.PlaygroundPresetVisibilityPrivate, imported.Visibility)
			assert.Equal(t, global.Name, imported.Name)
			assert.Equal(t, global.OpeningMessage, imported.OpeningMessage)
			assert.Equal(t, global.SuggestedQuestions, imported.SuggestedQuestions)
			var importedRow model.PlaygroundPreset
			require.NoError(t, db.Where("id = ?", imported.ID).First(&importedRow).Error)
			assert.Equal(t, 8, importedRow.UserID)

			// The administrator updates and deletes the global row without
			// touching the copies users already made.
			updated := decode(playgroundRequest(t, 9, http.MethodPatch, "/api/playground/presets/global/"+global.ID, map[string]any{
				"name": "Market reviewer v2", "opening_message": "Updated greeting.",
				"suggested_questions": []string{"Only question"},
			}, controller.UpdateGlobalPlaygroundPreset))
			assert.Equal(t, "Market reviewer v2", updated.Name)
			assert.Equal(t, "Updated greeting.", updated.OpeningMessage)
			assert.Equal(t, []string{"Only question"}, updated.SuggestedQuestions)
			deleted := playgroundRequest(t, 9, http.MethodDelete, "/api/playground/presets/global/"+global.ID, nil, controller.DeleteGlobalPlaygroundPreset)
			require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
			emptyMarket := playgroundRequest(t, 7, http.MethodGet, "/api/playground/presets/market", nil, controller.ListPlaygroundPresetMarket)
			assert.Contains(t, emptyMarket.Body.String(), `"total":0`)
			var privateCount int64
			require.NoError(t, db.Model(&model.PlaygroundPreset{}).Where("user_id = ?", 7).Count(&privateCount).Error)
			assert.EqualValues(t, 1, privateCount)
			require.NoError(t, db.Where("id = ?", copied.ID).First(&copiedRow).Error)
			assert.Equal(t, "Market reviewer", copiedRow.Name, "a copy is independent of later global edits")

			// The copy path uses the same per-account budget as a direct
			// create, so a full account cannot grow through the market.
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.PresetUserMaxCount = 1
			})
			overflow := playgroundRequest(t, 7, http.MethodPost, "/api/playground/presets/market/"+global.ID+"/copy", nil, controller.CopyPlaygroundPresetFromMarket)
			assert.Equal(t, http.StatusNotFound, overflow.Code, overflow.Body.String(), "the deleted global id is no longer copyable")
			second := decode(playgroundRequest(t, 9, http.MethodPost, "/api/playground/presets/global", map[string]any{"name": "Second global"}, controller.CreateGlobalPlaygroundPreset))
			overflow = playgroundRequest(t, 7, http.MethodPost, "/api/playground/presets/market/"+second.ID+"/copy", nil, controller.CopyPlaygroundPresetFromMarket)
			assert.Equal(t, http.StatusUnprocessableEntity, overflow.Code, overflow.Body.String())
			assert.Contains(t, overflow.Body.String(), "PLAYGROUND_PRESET_LIMIT_EXCEEDED")
		})
	}
}

// Prompt snippets are owner-scoped server resources: another account can

// neither list nor mutate them, every field is validated on write, and the
// per-account budget and per-snippet text bound come from the shared resource
// quota policy.
func TestPlaygroundSnippetPersistenceAndOwnership(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			// The new table is part of the migration contract and must stay
			// idempotent on every dialect.
			require.NoError(t, db.AutoMigrate(&model.PlaygroundSnippet{}))

			created := playgroundRequest(t, 7, http.MethodPost, "/api/playground/snippets", map[string]any{
				"name": "  Review checklist  ", "content": "Check every endpoint for owner scoping.",
			}, controller.CreatePlaygroundSnippet)
			require.Equal(t, http.StatusOK, created.Code, created.Body.String())
			var envelope struct {
				Success bool
				Data    struct {
					ID        string `json:"id"`
					Name      string `json:"name"`
					Content   string `json:"content"`
					CreatedAt int64  `json:"created_at"`
					UpdatedAt int64  `json:"updated_at"`
				}
			}
			require.NoError(t, common.Unmarshal(created.Body.Bytes(), &envelope))
			require.True(t, envelope.Success, created.Body.String())
			id := envelope.Data.ID
			require.True(t, strings.HasPrefix(id, "pgs_"), id)
			assert.Equal(t, "Review checklist", envelope.Data.Name)
			assert.Equal(t, "Check every endpoint for owner scoping.", envelope.Data.Content)
			assert.NotZero(t, envelope.Data.CreatedAt)

			// The write keeps the account counter row exact.
			var usage model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&usage).Error)
			assert.EqualValues(t, 1, usage.Snippets)

			// The listing is owner-scoped and reports the effective budget.
			listed := playgroundRequest(t, 7, http.MethodGet, "/api/playground/snippets", nil, controller.ListPlaygroundSnippets)
			var listing struct {
				Success bool
				Data    struct {
					Items []struct{ ID string }
					Total int
					Limit int
				}
			}
			require.NoError(t, common.Unmarshal(listed.Body.Bytes(), &listing))
			require.True(t, listing.Success, listed.Body.String())
			require.Len(t, listing.Data.Items, 1)
			assert.Equal(t, id, listing.Data.Items[0].ID)
			assert.Equal(t, 1, listing.Data.Total)
			assert.Equal(t, playground_setting.GetPlaygroundQuotaPolicy("default").SnippetUserMaxCount, listing.Data.Limit)
			foreignList := playgroundRequest(t, 8, http.MethodGet, "/api/playground/snippets", nil, controller.ListPlaygroundSnippets)
			assert.Contains(t, foreignList.Body.String(), `"total":0`)

			// Mutation is owner-scoped; another account gets the same 404.
			foreignRead := playgroundRequest(t, 8, http.MethodGet, "/api/playground/snippets/"+id, nil, controller.GetPlaygroundSnippet)
			assert.Equal(t, http.StatusNotFound, foreignRead.Code, foreignRead.Body.String())
			foreignUpdate := playgroundRequest(t, 8, http.MethodPatch, "/api/playground/snippets/"+id, map[string]any{"name": "Hijacked"}, controller.UpdatePlaygroundSnippet)
			assert.Equal(t, http.StatusNotFound, foreignUpdate.Code, foreignUpdate.Body.String())
			foreignDelete := playgroundRequest(t, 8, http.MethodDelete, "/api/playground/snippets/"+id, nil, controller.DeletePlaygroundSnippet)
			assert.Equal(t, http.StatusNotFound, foreignDelete.Code, foreignDelete.Body.String())

			updated := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/snippets/"+id, map[string]any{"name": "Checklist"}, controller.UpdatePlaygroundSnippet)
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			assert.Contains(t, updated.Body.String(), `"name":"Checklist"`)
			assert.Contains(t, updated.Body.String(), "Check every endpoint for owner scoping.", "unsent content keeps its stored value")

			for name, body := range map[string]map[string]any{
				"empty name":      {"name": "   ", "content": "x"},
				"overlong name":   {"name": strings.Repeat("n", 101), "content": "x"},
				"missing content": {"name": "A"},
				"blank content":   {"name": "A", "content": "  \n"},
			} {
				response := playgroundRequest(t, 7, http.MethodPost, "/api/playground/snippets", body, controller.CreatePlaygroundSnippet)
				assert.Equal(t, http.StatusBadRequest, response.Code, name+": "+response.Body.String())
			}
			emptyPatch := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/snippets/"+id, map[string]any{}, controller.UpdatePlaygroundSnippet)
			assert.Equal(t, http.StatusBadRequest, emptyPatch.Code, emptyPatch.Body.String())
			assert.Contains(t, emptyPatch.Body.String(), "Invalid prompt snippet.")

			// The resource policy bounds the text of one snippet and the
			// account count with stable capacity errors.
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.SnippetContentMaxBytes = 16
			})
			tooLong := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/snippets/"+id, map[string]any{
				"content": strings.Repeat("x", 17),
			}, controller.UpdatePlaygroundSnippet)
			assert.Equal(t, http.StatusUnprocessableEntity, tooLong.Code, tooLong.Body.String())
			assert.Contains(t, tooLong.Body.String(), "PLAYGROUND_SNIPPET_CONTENT_LIMIT_EXCEEDED")
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.SnippetUserMaxCount = 1
			})
			overflow := playgroundRequest(t, 7, http.MethodPost, "/api/playground/snippets", map[string]any{"name": "One too many", "content": "x"}, controller.CreatePlaygroundSnippet)
			assert.Equal(t, http.StatusUnprocessableEntity, overflow.Code, overflow.Body.String())
			assert.Contains(t, overflow.Body.String(), "PLAYGROUND_SNIPPET_LIMIT_EXCEEDED")

			deleted := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/snippets/"+id, nil, controller.DeletePlaygroundSnippet)
			require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
			repeat := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/snippets/"+id, nil, controller.DeletePlaygroundSnippet)
			assert.Equal(t, http.StatusNotFound, repeat.Code, repeat.Body.String())
			var stored int64
			require.NoError(t, db.Model(&model.PlaygroundSnippet{}).Where("user_id = ?", 7).Count(&stored).Error)
			assert.Zero(t, stored)
			require.NoError(t, db.Where("user_id = ?", 7).First(&usage).Error)
			assert.Zero(t, usage.Snippets)
		})
	}
}

// Memories are the cross-session notes an account keeps: owner-scoped CRUD
// over a locked counter, an owner-checked source conversation, and the same
// stable capacity errors the resource policy produces. The source pointer
// outlives a purge but is cleared with it, so a dangling conversation can
// never be opened from the memory panel.
func TestPlaygroundMemoryPersistenceAndOwnership(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			// The new table is part of the migration contract and must stay
			// idempotent on every dialect.
			require.NoError(t, db.AutoMigrate(&model.PlaygroundMemory{}))

			source := createPlayground(t, 7, "memory-source")
			sourceID := source["id"].(string)
			otherSource := createPlayground(t, 8, "memory-other-source")
			otherSourceID := otherSource["id"].(string)

			created := playgroundRequest(t, 7, http.MethodPost, "/api/playground/memories", map[string]any{
				"content": "  Prefers concise answers with short examples.  ", "category": "preference", "source_session_id": sourceID,
			}, controller.CreatePlaygroundMemory)
			require.Equal(t, http.StatusOK, created.Code, created.Body.String())
			var envelope struct {
				Success bool
				Data    struct {
					ID              string  `json:"id"`
					Content         string  `json:"content"`
					Category        string  `json:"category"`
					SourceSessionID *string `json:"source_session_id"`
					Enabled         bool    `json:"enabled"`
					CreatedAt       int64   `json:"created_at"`
					UpdatedAt       int64   `json:"updated_at"`
				}
			}
			require.NoError(t, common.Unmarshal(created.Body.Bytes(), &envelope))
			require.True(t, envelope.Success, created.Body.String())
			id := envelope.Data.ID
			require.True(t, strings.HasPrefix(id, "pgm_"), id)
			assert.Equal(t, "Prefers concise answers with short examples.", envelope.Data.Content)
			assert.Equal(t, "preference", envelope.Data.Category)
			require.NotNil(t, envelope.Data.SourceSessionID)
			assert.Equal(t, sourceID, *envelope.Data.SourceSessionID)
			assert.True(t, envelope.Data.Enabled, "a new memory is enabled by default")
			assert.NotZero(t, envelope.Data.CreatedAt)

			// The write keeps the account counter row exact, and the unified
			// usage view reports the same count against the policy limit.
			var usage model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&usage).Error)
			assert.EqualValues(t, 1, usage.Memories)
			usageView, err := model.PlaygroundUsageForUser(7)
			require.NoError(t, err)
			assert.EqualValues(t, 1, usageView.Memories.Used)
			assert.EqualValues(t, playground_setting.GetPlaygroundQuotaPolicy("default").MemoryUserMaxCount, usageView.Memories.Limit)

			// The listing is owner-scoped and reports the effective budget.
			listed := playgroundRequest(t, 7, http.MethodGet, "/api/playground/memories", nil, controller.ListPlaygroundMemories)
			var listing struct {
				Success bool
				Data    struct {
					Items []struct {
						ID              string  `json:"id"`
						SourceSessionID *string `json:"source_session_id"`
					}
					Total int
					Limit int
				}
			}
			require.NoError(t, common.Unmarshal(listed.Body.Bytes(), &listing))
			require.True(t, listing.Success, listed.Body.String())
			require.Len(t, listing.Data.Items, 1)
			assert.Equal(t, id, listing.Data.Items[0].ID)
			require.NotNil(t, listing.Data.Items[0].SourceSessionID)
			assert.Equal(t, sourceID, *listing.Data.Items[0].SourceSessionID)
			assert.Equal(t, 1, listing.Data.Total)
			assert.Equal(t, playground_setting.GetPlaygroundQuotaPolicy("default").MemoryUserMaxCount, listing.Data.Limit)
			foreignList := playgroundRequest(t, 8, http.MethodGet, "/api/playground/memories", nil, controller.ListPlaygroundMemories)
			assert.Contains(t, foreignList.Body.String(), `"total":0`)

			// Mutation is owner-scoped; another account gets the same 404.
			foreignRead := playgroundRequest(t, 8, http.MethodGet, "/api/playground/memories/"+id, nil, controller.GetPlaygroundMemory)
			assert.Equal(t, http.StatusNotFound, foreignRead.Code, foreignRead.Body.String())
			foreignUpdate := playgroundRequest(t, 8, http.MethodPatch, "/api/playground/memories/"+id, map[string]any{"content": "Hijacked"}, controller.UpdatePlaygroundMemory)
			assert.Equal(t, http.StatusNotFound, foreignUpdate.Code, foreignUpdate.Body.String())
			foreignDelete := playgroundRequest(t, 8, http.MethodDelete, "/api/playground/memories/"+id, nil, controller.DeletePlaygroundMemory)
			assert.Equal(t, http.StatusNotFound, foreignDelete.Code, foreignDelete.Body.String())

			// A memory can only point at an active conversation of the same
			// account; an explicit null clears the source, an absent field
			// keeps it.
			foreignSource := playgroundRequest(t, 7, http.MethodPost, "/api/playground/memories", map[string]any{
				"content": "Stolen source", "source_session_id": otherSourceID,
			}, controller.CreatePlaygroundMemory)
			assert.Equal(t, http.StatusBadRequest, foreignSource.Code, foreignSource.Body.String())
			assert.Contains(t, foreignSource.Body.String(), "PLAYGROUND_INVALID_REQUEST")
			unknownSource := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/memories/"+id, map[string]any{
				"source_session_id": "pgs_missing",
			}, controller.UpdatePlaygroundMemory)
			assert.Equal(t, http.StatusBadRequest, unknownSource.Code, unknownSource.Body.String())

			updated := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/memories/"+id, map[string]any{
				"content": "Prefers bullet points.", "category": "style", "enabled": false, "source_session_id": nil,
			}, controller.UpdatePlaygroundMemory)
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			assert.Contains(t, updated.Body.String(), `"content":"Prefers bullet points."`)
			assert.Contains(t, updated.Body.String(), `"category":"style"`)
			assert.Contains(t, updated.Body.String(), `"enabled":false`)
			assert.Contains(t, updated.Body.String(), `"source_session_id":null`)
			kept := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/memories/"+id, map[string]any{"category": "tone"}, controller.UpdatePlaygroundMemory)
			require.Equal(t, http.StatusOK, kept.Code, kept.Body.String())
			assert.Contains(t, kept.Body.String(), "Prefers bullet points.", "unsent content keeps its stored value")
			assert.Contains(t, kept.Body.String(), `"source_session_id":null`, "an absent field keeps the cleared source")

			// Purging the source conversation keeps the memory and only drops
			// the pointer, so the panel can never open a purged conversation.
			second := playgroundRequest(t, 7, http.MethodPost, "/api/playground/memories", map[string]any{
				"content": "Works on the gateway project.", "source_session_id": sourceID,
			}, controller.CreatePlaygroundMemory)
			require.Equal(t, http.StatusOK, second.Code, second.Body.String())
			var secondEnvelope struct {
				Data struct{ ID string }
			}
			require.NoError(t, common.Unmarshal(second.Body.Bytes(), &secondEnvelope))
			secondID := secondEnvelope.Data.ID
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+sourceID, nil, controller.DeletePlaygroundSession).Code)
			require.NoError(t, model.PurgePlaygroundSession(7, sourceID))
			purged := playgroundRequest(t, 7, http.MethodGet, "/api/playground/memories/"+secondID, nil, controller.GetPlaygroundMemory)
			require.Equal(t, http.StatusOK, purged.Code, purged.Body.String())
			assert.Contains(t, purged.Body.String(), `"source_session_id":null`)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/memories/"+secondID, nil, controller.DeletePlaygroundMemory).Code)

			for name, body := range map[string]map[string]any{
				"missing content":  {"category": "fact"},
				"blank content":    {"content": "  \n"},
				"overlong label":   {"content": "x", "category": strings.Repeat("c", 51)},
				"numeric source":   {"content": "x", "source_session_id": 7},
				"empty source":     {"content": "x", "source_session_id": ""},
				"malformed source": {"content": "x", "source_session_id": map[string]any{"id": "pgs_x"}},
			} {
				response := playgroundRequest(t, 7, http.MethodPost, "/api/playground/memories", body, controller.CreatePlaygroundMemory)
				assert.Equal(t, http.StatusBadRequest, response.Code, name+": "+response.Body.String())
			}
			emptyPatch := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/memories/"+id, map[string]any{}, controller.UpdatePlaygroundMemory)
			assert.Equal(t, http.StatusBadRequest, emptyPatch.Code, emptyPatch.Body.String())
			assert.Contains(t, emptyPatch.Body.String(), "Invalid Playground memory.")

			// The resource policy bounds the text of one memory and the account
			// count with stable capacity errors.
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.MemoryContentMaxBytes = 16
			})
			tooLong := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/memories/"+id, map[string]any{
				"content": strings.Repeat("x", 17),
			}, controller.UpdatePlaygroundMemory)
			assert.Equal(t, http.StatusUnprocessableEntity, tooLong.Code, tooLong.Body.String())
			assert.Contains(t, tooLong.Body.String(), "PLAYGROUND_MEMORY_CONTENT_LIMIT_EXCEEDED")
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.MemoryUserMaxCount = 1
			})
			overflow := playgroundRequest(t, 7, http.MethodPost, "/api/playground/memories", map[string]any{"content": "One too many"}, controller.CreatePlaygroundMemory)
			assert.Equal(t, http.StatusUnprocessableEntity, overflow.Code, overflow.Body.String())
			assert.Contains(t, overflow.Body.String(), "PLAYGROUND_MEMORY_LIMIT_EXCEEDED")

			deleted := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/memories/"+id, nil, controller.DeletePlaygroundMemory)
			require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
			repeat := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/memories/"+id, nil, controller.DeletePlaygroundMemory)
			assert.Equal(t, http.StatusNotFound, repeat.Code, repeat.Body.String())
			var stored int64
			require.NoError(t, db.Model(&model.PlaygroundMemory{}).Where("user_id = ?", 7).Count(&stored).Error)
			assert.Zero(t, stored)
			require.NoError(t, db.Where("user_id = ?", 7).First(&usage).Error)
			assert.Zero(t, usage.Memories)
		})
	}
}

// The conversation-level system prompt is stored on the session and bounded by
// the resource policy. A row written before the column existed (NULL) reads
// back as an empty prompt instead of failing the request.
func TestPlaygroundSessionSystemPrompt(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			created := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions", map[string]any{
				"title": "Prompted", "client_id": "prompt-session",
				"config": map[string]any{"model": "test-model"}, "parameter_enabled": map[string]bool{},
				"system_prompt": "Answer in French.", "opening_message": "Hello!",
				"suggested_questions": []string{"Explain this", "  Find bugs  ", "Explain this"},
			}, controller.CreatePlaygroundSession)
			require.Equal(t, http.StatusOK, created.Code, created.Body.String())
			var envelope struct {
				Success bool
				Data    struct {
					ID                 string   `json:"id"`
					SystemPrompt       string   `json:"system_prompt"`
					OpeningMessage     string   `json:"opening_message"`
					SuggestedQuestions []string `json:"suggested_questions"`
				}
			}
			require.NoError(t, common.Unmarshal(created.Body.Bytes(), &envelope))
			require.True(t, envelope.Success, created.Body.String())
			id := envelope.Data.ID
			assert.Equal(t, "Answer in French.", envelope.Data.SystemPrompt)
			assert.Equal(t, "Hello!", envelope.Data.OpeningMessage)
			assert.Equal(t, []string{"Explain this", "Find bugs"}, envelope.Data.SuggestedQuestions)

			read := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id, nil, controller.GetPlaygroundSession)
			require.Equal(t, http.StatusOK, read.Code, read.Body.String())
			assert.Contains(t, read.Body.String(), `"system_prompt":"Answer in French."`)
			assert.Contains(t, read.Body.String(), `"opening_message":"Hello!"`)
			assert.Contains(t, read.Body.String(), `"suggested_questions":["Explain this","Find bugs"]`)

			// An update that does not send the prompt keeps it; an explicit
			// value replaces it. The intro fields follow the same rule.
			renamed := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{"revision": 0, "title": "Renamed"}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, renamed.Code, renamed.Body.String())
			assert.Contains(t, renamed.Body.String(), `"system_prompt":"Answer in French."`)
			assert.Contains(t, renamed.Body.String(), `"opening_message":"Hello!"`)
			replaced := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{
				"revision": 1, "system_prompt": "Answer in English.",
				"opening_message": "Bonjour!", "suggested_questions": []string{"Continuer"},
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, replaced.Code, replaced.Body.String())
			assert.Contains(t, replaced.Body.String(), `"system_prompt":"Answer in English."`)
			assert.Contains(t, replaced.Body.String(), `"opening_message":"Bonjour!"`)
			assert.Contains(t, replaced.Body.String(), `"suggested_questions":["Continuer"]`)

			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.SystemPromptMaxBytes = 8
			})
			tooLong := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{"revision": 2, "system_prompt": strings.Repeat("x", 9)}, controller.UpdatePlaygroundSession)
			assert.Equal(t, http.StatusUnprocessableEntity, tooLong.Code, tooLong.Body.String())
			assert.Contains(t, tooLong.Body.String(), "PLAYGROUND_SYSTEM_PROMPT_LIMIT_EXCEEDED")
			// A NUL byte is rejected as a malformed request; the payload stays
			// inside the byte limit so this case exercises the NUL validation
			// instead of the capacity error above.
			nul := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{"revision": 2, "system_prompt": "a\x00b"}, controller.UpdatePlaygroundSession)
			assert.Equal(t, http.StatusBadRequest, nul.Code, nul.Body.String())
			nulIntro := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{"revision": 2, "opening_message": "a\x00b"}, controller.UpdatePlaygroundSession)
			assert.Equal(t, http.StatusBadRequest, nulIntro.Code, nulIntro.Body.String())
			tooMany := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{
				"revision": 2, "suggested_questions": []string{"1", "2", "3", "4", "5", "6", "7"},
			}, controller.UpdatePlaygroundSession)
			assert.Equal(t, http.StatusBadRequest, tooMany.Code, tooMany.Body.String())

			// A legacy row without the columns reads back as an empty prompt
			// and intro instead of failing the request.
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ? AND user_id = ?", id, 7).Updates(map[string]any{
				"system_prompt": gorm.Expr("NULL"), "opening_message": gorm.Expr("NULL"), "suggested_questions": gorm.Expr("NULL"),
			}).Error)
			reloaded, err := model.GetPlaygroundSession(7, id)
			require.NoError(t, err)
			assert.Empty(t, reloaded.SystemPrompt)
			assert.Empty(t, reloaded.OpeningMessage)
			assert.Empty(t, reloaded.SuggestedQuestions)
			legacyRead := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id, nil, controller.GetPlaygroundSession)
			require.Equal(t, http.StatusOK, legacyRead.Code, legacyRead.Body.String())
			assert.Contains(t, legacyRead.Body.String(), `"opening_message":""`)
			assert.Contains(t, legacyRead.Body.String(), `"suggested_questions":[]`)
		})
	}
}

// Conversation organization: pinning and archiving are explicit PATCH
// switches, tags replace the whole list under the stored bounds, archived
// conversations stay in the ordinary list page, and a legacy NULL tags column
// reads back as no tags. A pin request against an archived conversation is a
// stable 400 and leaves the revision untouched.
func TestPlaygroundSessionOrganization(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)

			type sessionView struct {
				ID         string   `json:"id"`
				Revision   int64    `json:"revision"`
				Pinned     bool     `json:"pinned"`
				Archived   bool     `json:"archived"`
				PinnedAt   int64    `json:"pinned_at"`
				ArchivedAt int64    `json:"archived_at"`
				Tags       []string `json:"tags"`
			}
			decode := func(recorder *httptest.ResponseRecorder) sessionView {
				t.Helper()
				var envelope struct {
					Success bool        `json:"success"`
					Data    sessionView `json:"data"`
				}
				require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &envelope))
				require.True(t, envelope.Success, recorder.Body.String())
				return envelope.Data
			}

			created := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions", map[string]any{
				"title": "Organize me", "client_id": "organization-session",
				"config": map[string]any{"model": "test-model"}, "parameter_enabled": map[string]bool{},
				"pinned": true, "tags": []string{" Work ", "ideas", "Work"},
			}, controller.CreatePlaygroundSession)
			require.Equal(t, http.StatusOK, created.Code, created.Body.String())
			session := decode(created)
			assert.True(t, session.Pinned)
			assert.False(t, session.Archived)
			assert.NotZero(t, session.PinnedAt)
			assert.Zero(t, session.ArchivedAt)
			assert.Equal(t, []string{"Work", "ideas"}, session.Tags)
			id := session.ID
			path := "/api/playground/sessions/" + id

			archived := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": session.Revision, "archived": true,
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, archived.Code, archived.Body.String())
			session = decode(archived)
			assert.True(t, session.Archived)
			assert.False(t, session.Pinned)
			assert.NotZero(t, session.ArchivedAt)
			assert.Zero(t, session.PinnedAt)

			pinArchived := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": session.Revision, "pinned": true,
			}, controller.UpdatePlaygroundSession)
			assert.Equal(t, http.StatusBadRequest, pinArchived.Code, pinArchived.Body.String())
			assert.Contains(t, pinArchived.Body.String(), "PLAYGROUND_SESSION_ARCHIVED")

			// An archive request in the same update wins over a simultaneous
			// pin, so the archived row is never pinned.
			archiveWins := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": session.Revision, "archived": true, "pinned": true,
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, archiveWins.Code, archiveWins.Body.String())
			session = decode(archiveWins)
			assert.True(t, session.Archived)
			assert.False(t, session.Pinned)

			// Repeating the archived state keeps the original archive time
			// instead of moving it forward on every metadata save.
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ? AND user_id = ?", id, 7).
				Update("archived_at", int64(123)).Error)
			repeatArchive := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": session.Revision, "archived": true,
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, repeatArchive.Code, repeatArchive.Body.String())
			session = decode(repeatArchive)
			assert.EqualValues(t, 123, session.ArchivedAt)
			assert.False(t, session.Pinned)

			// The rejected pin left the revision untouched; the successful
			// archive requests above advanced it, and that revision can now
			// unarchive the conversation.
			unarchived := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": session.Revision, "archived": false,
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, unarchived.Code, unarchived.Body.String())
			session = decode(unarchived)
			assert.False(t, session.Archived)
			assert.False(t, session.Pinned)

			pinned := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": session.Revision, "pinned": true,
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, pinned.Code, pinned.Body.String())
			session = decode(pinned)
			assert.True(t, session.Pinned)
			assert.NotZero(t, session.PinnedAt)

			// Repeating the pinned state keeps the original pin time.
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ? AND user_id = ?", id, 7).
				Update("pinned_at", int64(456)).Error)
			repeatPin := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": session.Revision, "pinned": true,
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, repeatPin.Code, repeatPin.Body.String())
			session = decode(repeatPin)
			assert.EqualValues(t, 456, session.PinnedAt)

			// Omitting the switches keeps the stored state.
			renamed := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": session.Revision, "title": "Renamed",
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, renamed.Code, renamed.Body.String())
			session = decode(renamed)
			assert.True(t, session.Pinned)
			assert.Equal(t, []string{"Work", "ideas"}, session.Tags)

			cleared := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": session.Revision, "tags": []string{},
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, cleared.Code, cleared.Body.String())
			session = decode(cleared)
			assert.Empty(t, session.Tags)
			assert.True(t, session.Pinned)

			for name, tags := range map[string][]string{
				"too many": {"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"},
				// One more than the 24-character server bound.
				"too long": {strings.Repeat("界", 25)},
				"nul byte": {"a\x00b"},
			} {
				t.Run(name, func(t *testing.T) {
					rejected := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
						"revision": session.Revision, "tags": tags,
					}, controller.UpdatePlaygroundSession)
					assert.Equal(t, http.StatusBadRequest, rejected.Code, rejected.Body.String())
				})
			}

			// The rejected tag writes did not consume the revision either.
			archived = playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": session.Revision, "archived": true,
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, archived.Code, archived.Body.String())
			session = decode(archived)
			assert.True(t, session.Archived)
			assert.False(t, session.Pinned)

			// The server list keeps archived conversations in the ordinary
			// updated_at ordering; grouping happens in the client.
			list := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions?p=1&page_size=20", nil, controller.ListPlaygroundSessions)
			require.Equal(t, http.StatusOK, list.Code, list.Body.String())
			var page struct {
				Success bool `json:"success"`
				Data    struct {
					Items []sessionView `json:"items"`
					Total int           `json:"total"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(list.Body.Bytes(), &page))
			require.True(t, page.Success, list.Body.String())
			assert.Equal(t, 1, page.Data.Total)
			require.Len(t, page.Data.Items, 1)
			assert.True(t, page.Data.Items[0].Archived)

			// A row written before the tags column existed keeps NULL and reads
			// back as an empty list on every dialect.
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ? AND user_id = ?", id, 7).
				Update("tags", gorm.Expr("NULL")).Error)
			legacy := playgroundRequest(t, 7, http.MethodGet, path, nil, controller.GetPlaygroundSession)
			require.Equal(t, http.StatusOK, legacy.Code, legacy.Body.String())
			assert.Empty(t, decode(legacy).Tags)
		})
	}
}

// Conversation context management: the per-session context settings and the
// persisted compression node round-trip through the owner-scoped session
// endpoints on every dialect. A request that omits them keeps the stored
// values, an explicit null removes the summary, malformed or oversized values
// are rejected without touching the stored snapshot, and a legacy NULL column
// reads back as the defaults.
func TestPlaygroundSessionContextManagement(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			created := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions", map[string]any{
				"title": "Budgeted", "client_id": "context-session",
				"config": map[string]any{"model": "test-model"}, "parameter_enabled": map[string]bool{},
				"context": map[string]any{
					"history_limit": 12, "token_budget": 20000,
					"auto_summarize": false, "summary_model": "",
				},
			}, controller.CreatePlaygroundSession)
			require.Equal(t, http.StatusOK, created.Code, created.Body.String())

			type contextSummaryView struct {
				ID                string   `json:"id"`
				Content           string   `json:"content"`
				ThroughMessageKey string   `json:"through_message_key"`
				MessageCount      *int     `json:"message_count"`
				Model             string   `json:"model"`
				CreatedAt         *float64 `json:"created_at"`
				RequestID         string   `json:"request_id"`
				Usage             *struct {
					TotalTokens int `json:"totalTokens"`
				} `json:"usage"`
			}
			type sessionView struct {
				ID             string              `json:"id"`
				Context        map[string]any      `json:"context"`
				ContextSummary *contextSummaryView `json:"context_summary"`
			}
			decode := func(t *testing.T, body []byte) sessionView {
				t.Helper()
				var envelope struct {
					Success bool        `json:"success"`
					Data    sessionView `json:"data"`
				}
				require.NoError(t, common.Unmarshal(body, &envelope))
				require.True(t, envelope.Success, string(body))
				return envelope.Data
			}
			session := decode(t, created.Body.Bytes())
			createdID := session.ID
			readSession := func(t *testing.T) sessionView {
				t.Helper()
				response := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+createdID, nil, controller.GetPlaygroundSession)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				return decode(t, response.Body.Bytes())
			}

			assert.EqualValues(t, 12, session.Context["history_limit"])
			assert.EqualValues(t, 20000, session.Context["token_budget"])
			assert.Equal(t, false, session.Context["auto_summarize"])
			assert.Equal(t, "", session.Context["summary_model"])
			require.Nil(t, session.ContextSummary)

			// A full settings object replaces the stored one; a request that
			// does not carry the object keeps it.
			updated := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+createdID, map[string]any{
				"revision": 0,
				"context": map[string]any{
					"history_limit": 24, "token_budget": 60000,
					"auto_summarize": true, "summary_model": "summary-model",
				},
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			state := decode(t, updated.Body.Bytes())
			assert.EqualValues(t, 24, state.Context["history_limit"])
			assert.Equal(t, true, state.Context["auto_summarize"])
			assert.Equal(t, "summary-model", state.Context["summary_model"])
			renamed := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+createdID, map[string]any{"revision": 1, "title": "Renamed"}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, renamed.Code, renamed.Body.String())
			assert.Equal(t, "summary-model", decode(t, renamed.Body.Bytes()).Context["summary_model"])

			// The compression node stores and replaces the summary, and the
			// usage record of the summarization call survives the round trip.
			stored := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+createdID, map[string]any{
				"revision": 2,
				"context_summary": map[string]any{
					"id": "pgc_1", "content": "Earlier messages were compressed.",
					"through_message_key": "m2", "message_count": 4,
					"model": "summary-model", "created_at": 100, "request_id": "req-summary-1",
					"usage": map[string]any{"promptTokens": 10, "completionTokens": 5, "totalTokens": 15},
				},
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, stored.Code, stored.Body.String())
			node := decode(t, stored.Body.Bytes()).ContextSummary
			require.NotNil(t, node)
			assert.Equal(t, "pgc_1", node.ID)
			assert.Equal(t, "Earlier messages were compressed.", node.Content)
			assert.Equal(t, "m2", node.ThroughMessageKey)
			require.NotNil(t, node.MessageCount)
			assert.Equal(t, 4, *node.MessageCount)
			assert.Equal(t, "summary-model", node.Model)
			assert.Equal(t, "req-summary-1", node.RequestID)
			require.NotNil(t, node.Usage)
			assert.Equal(t, 15, node.Usage.TotalTokens)
			require.NotNil(t, readSession(t).ContextSummary)

			replaced := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+createdID, map[string]any{
				"revision": 3,
				"context_summary": map[string]any{
					"id": "pgc_2", "content": "Second summary.", "through_message_key": "m6", "model": "summary-model",
				},
			}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, replaced.Code, replaced.Body.String())
			current := decode(t, replaced.Body.Bytes()).ContextSummary
			require.NotNil(t, current)
			assert.Equal(t, "pgc_2", current.ID)
			assert.Equal(t, "Second summary.", current.Content)

			// Invalid writes leave the stored snapshot untouched: the summary
			// is still the second one after every rejected request.
			overlongContent := strings.Repeat("x", (32<<10)+1)
			rejected := []struct {
				name   string
				body   map[string]any
				status int
			}{
				{"unknown context key", map[string]any{"revision": 4, "context": map[string]any{"history_limit": 1, "unknown": true}}, http.StatusBadRequest},
				{"negative history limit", map[string]any{"revision": 4, "context": map[string]any{"history_limit": -1}}, http.StatusBadRequest},
				{"fractional token budget", map[string]any{"revision": 4, "context": map[string]any{"token_budget": 1.5}}, http.StatusBadRequest},
				{"string auto summarize", map[string]any{"revision": 4, "context": map[string]any{"auto_summarize": "yes"}}, http.StatusBadRequest},
				{"oversized summary model", map[string]any{"revision": 4, "context": map[string]any{"summary_model": strings.Repeat("m", 513)}}, http.StatusBadRequest},
				{"missing summary content", map[string]any{"revision": 4, "context_summary": map[string]any{"id": "pgc_3", "through_message_key": "m1"}}, http.StatusBadRequest},
				{"empty summary content", map[string]any{"revision": 4, "context_summary": map[string]any{"id": "pgc_3", "content": "", "through_message_key": "m1"}}, http.StatusBadRequest},
				{"nul summary content", map[string]any{"revision": 4, "context_summary": map[string]any{"id": "pgc_3", "content": "bad\x00summary", "through_message_key": "m1"}}, http.StatusBadRequest},
				{"overlong request id", map[string]any{"revision": 4, "context_summary": map[string]any{"id": "pgc_3", "content": "ok", "through_message_key": "m1", "request_id": strings.Repeat("r", 65)}}, http.StatusBadRequest},
				{"negative usage", map[string]any{"revision": 4, "context_summary": map[string]any{"id": "pgc_3", "content": "ok", "through_message_key": "m1", "usage": map[string]any{"promptTokens": -1, "completionTokens": 1, "totalTokens": 0}}}, http.StatusBadRequest},
				{"oversized summary content", map[string]any{"revision": 4, "context_summary": map[string]any{"id": "pgc_3", "content": overlongContent, "through_message_key": "m1"}}, http.StatusUnprocessableEntity},
			}
			for _, test := range rejected {
				response := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+createdID, test.body, controller.UpdatePlaygroundSession)
				assert.Equal(t, test.status, response.Code, test.name+": "+response.Body.String())
			}
			still := readSession(t)
			require.NotNil(t, still.ContextSummary)
			assert.Equal(t, "pgc_2", still.ContextSummary.ID)
			assert.Equal(t, "summary-model", still.Context["summary_model"])

			// The compression node is removed with an explicit null.
			cleared := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+createdID, map[string]any{"revision": 4, "context_summary": nil}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, cleared.Code, cleared.Body.String())
			assert.Nil(t, decode(t, cleared.Body.Bytes()).ContextSummary)
			assert.Nil(t, readSession(t).ContextSummary)

			// Another account cannot write to the conversation at all.
			foreign := playgroundRequest(t, 8, http.MethodPatch, "/api/playground/sessions/"+createdID, map[string]any{"revision": 5, "context_summary": nil}, controller.UpdatePlaygroundSession)
			assert.Equal(t, http.StatusNotFound, foreign.Code, foreign.Body.String())

			// A legacy row without the columns reads back as empty defaults.
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ? AND user_id = ?", createdID, 7).
				Updates(map[string]any{"context_config": gorm.Expr("NULL"), "context_summary": gorm.Expr("NULL")}).Error)
			legacy, err := model.GetPlaygroundSession(7, createdID)
			require.NoError(t, err)
			assert.Empty(t, legacy.ContextConfig)
			assert.Empty(t, legacy.ContextSummary)
			legacyView := readSession(t)
			assert.Empty(t, legacyView.Context)
			assert.Nil(t, legacyView.ContextSummary)
		})
	}
}

// Message costs are read back from the owner's settled consume rows. The
// lookup is owner- and type-scoped, so another account's request id, a
// non-consume row and an unknown id all yield nothing, and a malformed query
// is rejected before any query runs.
func TestPlaygroundMessageCostLookup(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			previousLog := model.LOG_DB
			model.LOG_DB = db
			require.NoError(t, db.AutoMigrate(&model.Log{}))
			t.Cleanup(func() {
				model.LOG_DB = previousLog
				require.NoError(t, db.Migrator().DropTable(&model.Log{}))
			})
			require.NoError(t, db.Create(&[]model.Log{
				{UserId: 7, Type: model.LogTypeConsume, RequestId: "pg-cost-owner", Quota: 1234, PromptTokens: 10, CompletionTokens: 20, ModelName: "cost-model", CreatedAt: 100,
					Other: `{"request_timing":{"total_ms":1320,"auth_ms":24,"channel_select_ms":8,"upstream_ms":411,"first_token_ms":445,"retries":1},"admin_info":{"use_channel":[3]}}`},
				{UserId: 7, Type: model.LogTypeConsume, RequestId: "pg-cost-no-timing", Quota: 50, PromptTokens: 2, CompletionTokens: 3, ModelName: "cost-model", CreatedAt: 100,
					Other: `{"request_path":"/v1/chat/completions"}`},
				{UserId: 8, Type: model.LogTypeConsume, RequestId: "pg-cost-other", Quota: 9999, PromptTokens: 1, CompletionTokens: 1, ModelName: "other-model", CreatedAt: 100},
				{UserId: 7, Type: model.LogTypeError, RequestId: "pg-cost-error", Quota: 0, CreatedAt: 100},
			}).Error)

			logs, err := model.GetUserConsumeLogsByRequestIds(7, []string{"pg-cost-owner", "pg-cost-other", "pg-cost-error", "pg-cost-missing"})
			require.NoError(t, err)
			require.Len(t, logs, 1)
			assert.Equal(t, "pg-cost-owner", logs[0].RequestId)
			assert.Equal(t, 1234, logs[0].Quota)
			// The stored other document is loaded so the caller can project the
			// public request timing out of it.
			assert.Contains(t, logs[0].Other, "request_timing")

			empty, err := model.GetUserConsumeLogsByRequestIds(7, nil)
			require.NoError(t, err)
			assert.Empty(t, empty)

			response := playgroundRequest(t, 7, http.MethodGet, "/api/playground/message-costs?request_ids=pg-cost-owner,pg-cost-other,pg-cost-missing", nil, controller.GetPlaygroundMessageCosts)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			// The client relies on this flag to stop waiting for a row that a
			// deployment with consume logs switched off would never write.
			expectedEnabled := common.LogConsumeEnabled
			var envelope struct {
				Success bool `json:"success"`
				Data    struct {
					Enabled bool `json:"enabled"`
					Items   []struct {
						RequestID        string `json:"request_id"`
						Quota            int    `json:"quota"`
						PromptTokens     int    `json:"prompt_tokens"`
						CompletionTokens int    `json:"completion_tokens"`
						TotalTokens      int    `json:"total_tokens"`
						ModelName        string `json:"model_name"`
						CreatedAt        int64  `json:"created_at"`
						Timing           *struct {
							TotalMs         *int64 `json:"total_ms"`
							AuthMs          *int64 `json:"auth_ms"`
							ChannelSelectMs *int64 `json:"channel_select_ms"`
							UpstreamMs      *int64 `json:"upstream_ms"`
							FirstTokenMs    *int64 `json:"first_token_ms"`
							Retries         *int   `json:"retries"`
						} `json:"timing"`
					} `json:"items"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
			require.True(t, envelope.Success, response.Body.String())
			assert.Equal(t, expectedEnabled, envelope.Data.Enabled)
			require.Len(t, envelope.Data.Items, 1)
			item := envelope.Data.Items[0]
			assert.Equal(t, "pg-cost-owner", item.RequestID)
			assert.Equal(t, 1234, item.Quota)
			assert.Equal(t, 10, item.PromptTokens)
			assert.Equal(t, 20, item.CompletionTokens)
			assert.Equal(t, 30, item.TotalTokens)
			assert.Equal(t, "cost-model", item.ModelName)
			assert.EqualValues(t, 100, item.CreatedAt)
			// The public phase breakdown of the settle row is projected for the
			// conversation metadata; nothing else from the stored other is.
			require.NotNil(t, item.Timing)
			require.NotNil(t, item.Timing.TotalMs)
			assert.EqualValues(t, 1320, *item.Timing.TotalMs)
			require.NotNil(t, item.Timing.UpstreamMs)
			assert.EqualValues(t, 411, *item.Timing.UpstreamMs)
			require.NotNil(t, item.Timing.Retries)
			assert.Equal(t, 1, *item.Timing.Retries)
			assert.NotContains(t, response.Body.String(), "use_channel")

			// A settle row stored before the timing field existed answers with
			// the cost figures and no timing object.
			legacyResponse := playgroundRequest(t, 7, http.MethodGet, "/api/playground/message-costs?request_ids=pg-cost-no-timing", nil, controller.GetPlaygroundMessageCosts)
			require.Equal(t, http.StatusOK, legacyResponse.Code, legacyResponse.Body.String())
			var legacyEnvelope struct {
				Data struct {
					Items []struct {
						RequestID string `json:"request_id"`
						Timing    *struct {
							TotalMs *int64 `json:"total_ms"`
						} `json:"timing"`
					} `json:"items"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(legacyResponse.Body.Bytes(), &legacyEnvelope))
			require.Len(t, legacyEnvelope.Data.Items, 1)
			assert.Equal(t, "pg-cost-no-timing", legacyEnvelope.Data.Items[0].RequestID)
			assert.Nil(t, legacyEnvelope.Data.Items[0].Timing)

			invalidQueries := []string{
				"",
				"pg-cost-owner,",
				"pg-cost-owner,pg-cost-owner",
				strings.Repeat("r", 65),
			}
			tooMany := make([]string, 101)
			for index := range tooMany {
				tooMany[index] = fmt.Sprintf("req-%d", index)
			}
			invalidQueries = append(invalidQueries, strings.Join(tooMany, ","))
			for _, query := range invalidQueries {
				path := "/api/playground/message-costs"
				if query != "" {
					path += "?request_ids=" + url.QueryEscape(query)
				}
				rejected := playgroundRequest(t, 7, http.MethodGet, path, nil, controller.GetPlaygroundMessageCosts)
				assert.Equal(t, http.StatusBadRequest, rejected.Code, path)
				assert.Contains(t, rejected.Body.String(), "PLAYGROUND_INVALID_REQUEST", path)
			}
		})
	}
}

// Persisted generation results are owner-scoped records with a retention
// window. Their bytes count against the account result budget, the pin
// endpoints and canvas documents keep a result past the window, and the
// scheduled cleanup never removes a task whose result is still pinned.
func TestPlaygroundTaskArtifactRecordsAndPins(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			now := common.GetTimestamp()
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.TaskUserResultMaxBytes = 1 << 20
			})
			task := model.Task{TaskID: "pg-artifact-task", Platform: "kling", UserId: 7, Status: model.TaskStatusSuccess,
				Action: "text_to_video", SubmitTime: now, FinishTime: now,
				PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}}
			require.NoError(t, db.Create(&task).Error)

			seeds := []model.PlaygroundTaskArtifactSeed{
				{Key: "video", Type: "video", MimeType: "video/mp4"},
				{Key: "thumb", Type: "image", MimeType: "image/png"},
			}
			records, err := model.EnsurePlaygroundTaskArtifacts(7, task.TaskID, seeds)
			require.NoError(t, err)
			require.Len(t, records, 2)
			// Re-registering the same projection keeps the existing rows, so a
			// retry can never reset a stored record.
			again, err := model.EnsurePlaygroundTaskArtifacts(7, task.TaskID, seeds)
			require.NoError(t, err)
			require.Len(t, again, 2)
			assert.Equal(t, records[0].ID, again[0].ID)
			otherUserRecords, err := model.PlaygroundTaskArtifactsForTask(8, task.TaskID)
			require.NoError(t, err)
			assert.Empty(t, otherUserRecords)

			expiresAt := now - 60
			recordsByKey := make(map[string]model.PlaygroundTaskArtifact, len(records))
			for index := range records {
				recordsByKey[records[index].ArtifactKey] = records[index]
			}
			videoRecord, videoOK := recordsByKey["video"]
			thumbRecord, thumbOK := recordsByKey["thumb"]
			require.True(t, videoOK && thumbOK)
			require.NoError(t, model.MarkPlaygroundTaskArtifactStored(videoRecord.ID, "local", "pg/7/task/x/video", "video/mp4", 2048, "hash-video", expiresAt, "https://upstream.invalid/video.mp4"))
			require.NoError(t, model.MarkPlaygroundTaskArtifactStored(thumbRecord.ID, "local", "pg/7/task/x/thumb", "image/png", 1024, "hash-thumb", expiresAt, "https://upstream.invalid/thumb.png"))
			storedBytes, err := model.PlaygroundTaskArtifactStoredBytes(7)
			require.NoError(t, err)
			assert.EqualValues(t, 3072, storedBytes)
			totalBytes, err := model.PlaygroundTaskResultStorageBytes(7)
			require.NoError(t, err)
			assert.GreaterOrEqual(t, totalBytes, storedBytes)

			// Stored results count against the account budget, so the next
			// workspace submission is refused with the stable storage code.
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.TaskUserResultMaxBytes = 1024
			})
			overBudget := playgroundRequest(t, 7, http.MethodPost, "/v1/videos", map[string]any{"model": "kling-v1", "prompt": "fox"}, controller.PlaygroundVideoTask)
			assert.Equal(t, http.StatusTooManyRequests, overBudget.Code, overBudget.Body.String())
			assert.Contains(t, overBudget.Body.String(), controller.PlaygroundTaskStorageLimitErrorCode)

			// A pinned artifact is excluded from the expiry pass and cannot be
			// collected; an unpinned expired artifact is.
			require.NoError(t, model.SetPlaygroundTaskArtifactPin(7, task.TaskID, "thumb", true))
			expired, err := model.ListExpiredPlaygroundTaskArtifacts(now, 10)
			require.NoError(t, err)
			expiredKeys := make([]string, 0, len(expired))
			for index := range expired {
				expiredKeys = append(expiredKeys, expired[index].ArtifactKey)
			}
			assert.Equal(t, []string{"video"}, expiredKeys)
			deleted, err := model.DeletePlaygroundTaskArtifact(videoRecord.ID)
			require.NoError(t, err)
			assert.True(t, deleted)
			deleted, err = model.DeletePlaygroundTaskArtifact(thumbRecord.ID)
			require.NoError(t, err)
			assert.False(t, deleted, "a pinned result is never collected")
			pinned, err := model.IsPlaygroundTaskArtifactPinned(7, task.TaskID, "thumb")
			require.NoError(t, err)
			assert.True(t, pinned)
			otherPinned, err := model.IsPlaygroundTaskArtifactPinned(8, task.TaskID, "thumb")
			require.NoError(t, err)
			assert.False(t, otherPinned)

			// The owner-scoped pin endpoint rejects another account, an unknown
			// key, and an unfinished task; the owner can pin and release.
			foreignPin := playgroundRequest(t, 8, http.MethodPut, "/api/playground/tasks/"+task.TaskID+"/artifacts/thumb/pin", map[string]any{"pinned": true}, controller.PlaygroundTaskArtifactPin)
			assert.Equal(t, http.StatusNotFound, foreignPin.Code, foreignPin.Body.String())
			unknownPin := playgroundRequest(t, 7, http.MethodPut, "/api/playground/tasks/"+task.TaskID+"/artifacts/missing/pin", map[string]any{"pinned": true}, controller.PlaygroundTaskArtifactPin)
			assert.Equal(t, http.StatusNotFound, unknownPin.Code, unknownPin.Body.String())
			require.NoError(t, db.Model(&model.Task{}).Where("task_id = ?", task.TaskID).Update("status", model.TaskStatusInProgress).Error)
			notReady := playgroundRequest(t, 7, http.MethodPut, "/api/playground/tasks/"+task.TaskID+"/artifacts/thumb/pin", map[string]any{"pinned": true}, controller.PlaygroundTaskArtifactPin)
			assert.Equal(t, http.StatusConflict, notReady.Code, notReady.Body.String())
			require.NoError(t, db.Model(&model.Task{}).Where("task_id = ?", task.TaskID).Update("status", model.TaskStatusSuccess).Error)
			release := playgroundRequest(t, 7, http.MethodPut, "/api/playground/tasks/"+task.TaskID+"/artifacts/thumb/pin", map[string]any{"pinned": false}, controller.PlaygroundTaskArtifactPin)
			require.Equal(t, http.StatusOK, release.Code, release.Body.String())
			pinned, err = model.IsPlaygroundTaskArtifactPinned(7, task.TaskID, "thumb")
			require.NoError(t, err)
			assert.False(t, pinned)

			// A canvas node referencing a result pins it until the document no
			// longer does (or the canvas is deleted).
			createCanvasPin := func(documentNodes []any) *httptest.ResponseRecorder {
				return playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
					"client_id": "artifact-pin-canvas",
					"title":     "Board",
					"document":  canvasDocument(documentNodes, nil),
				}, controller.CreatePlaygroundCanvasProject)
			}
			canvas := createCanvasPin([]any{canvasRefNode("n1", "task-result", map[string]any{"taskId": task.TaskID, "taskArtifactKey": "thumb"})})
			require.Equal(t, http.StatusOK, canvas.Code, canvas.Body.String())
			canvasID, _ := canvasEnvelope(t, canvas.Body.Bytes())["id"].(string)
			require.NotEmpty(t, canvasID)
			require.NoError(t, model.SetPlaygroundTaskArtifactPin(7, task.TaskID, "thumb", true))
			pinned, err = model.IsPlaygroundTaskArtifactPinned(7, task.TaskID, "thumb")
			require.NoError(t, err)
			assert.True(t, pinned)
			detached := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+canvasID, map[string]any{
				"revision": 0,
				"document": canvasDocument([]any{canvasNode("n1", "text", 0, 0)}, nil),
				"title":    "Board",
			}, controller.UpdatePlaygroundCanvasProject)
			require.Equal(t, http.StatusOK, detached.Code, detached.Body.String())
			// The user pin survives the canvas release; deleting the canvas
			// releases its own pins only.
			pinned, err = model.IsPlaygroundTaskArtifactPinned(7, task.TaskID, "thumb")
			require.NoError(t, err)
			assert.True(t, pinned)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/canvases/"+canvasID, nil, controller.DeletePlaygroundCanvasProject).Code)
			pinned, err = model.IsPlaygroundTaskArtifactPinned(7, task.TaskID, "thumb")
			require.NoError(t, err)
			assert.True(t, pinned)

			// The scheduled cleanup deletes only expired, unpinned tasks and
			// forgets their projection markers.
			oldFinish := now - int64((40 * 24 * time.Hour).Seconds())
			expiredTask := model.Task{TaskID: "pg-artifact-expired", Platform: "kling", UserId: 7, Status: model.TaskStatusSuccess,
				SubmitTime: oldFinish, FinishTime: oldFinish, PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}}
			pinnedTask := model.Task{TaskID: "pg-artifact-pinned", Platform: "kling", UserId: 7, Status: model.TaskStatusSuccess,
				SubmitTime: oldFinish, FinishTime: oldFinish, PrivateData: model.TaskPrivateData{PlaygroundOrigin: true}}
			require.NoError(t, db.Create(&expiredTask).Error)
			require.NoError(t, db.Create(&pinnedTask).Error)
			require.NoError(t, model.MarkPlaygroundTaskArtifactsSynced(7, "pg-artifact-expired"))
			require.NoError(t, model.MarkPlaygroundTaskArtifactsSynced(7, "pg-artifact-pinned"))
			require.NoError(t, model.SetPlaygroundTaskArtifactPin(7, "pg-artifact-pinned", "video", true))

			deletedTasks, err := model.DeleteExpiredPlaygroundTasks(now-int64((30*24*time.Hour).Seconds()), 50)
			require.NoError(t, err)
			assert.EqualValues(t, 1, deletedTasks)
			var remaining []string
			require.NoError(t, db.Model(&model.Task{}).Where("user_id = ?", 7).Order("task_id ASC").Pluck("task_id", &remaining).Error)
			assert.Contains(t, remaining, "pg-artifact-pinned")
			assert.NotContains(t, remaining, "pg-artifact-expired")
			var markers []string
			require.NoError(t, db.Model(&model.PlaygroundTaskArtifactSync{}).Order("task_id ASC").Pluck("task_id", &markers).Error)
			assert.Equal(t, []string{"pg-artifact-pinned"}, markers)

			// The projection pass lists only successful, recent, unprojected
			// workspace tasks.
			missing, err := model.ListPlaygroundTasksMissingArtifactSync(now-int64((30*24*time.Hour).Seconds()), 10)
			require.NoError(t, err)
			missingIDs := make([]string, 0, len(missing))
			for index := range missing {
				missingIDs = append(missingIDs, missing[index].TaskID)
			}
			assert.Equal(t, []string{"pg-artifact-task"}, missingIDs)

			// The scheduled store pass is only scheduled while it has work.
			cutoff := now - int64((30 * 24 * time.Hour).Seconds())
			hasWork, err := model.HasPlaygroundTasksAwaitingArtifacts(cutoff)
			require.NoError(t, err)
			assert.True(t, hasWork)
			require.NoError(t, model.MarkPlaygroundTaskArtifactsSynced(7, "pg-artifact-task"))
			hasWork, err = model.HasPlaygroundTasksAwaitingArtifacts(cutoff)
			require.NoError(t, err)
			assert.False(t, hasWork)
		})
	}
}

// playgroundExportDownload is the server-rendered download contract of the
// conversation export endpoint.
type playgroundExportDownload struct {
	Format      string `json:"format"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Content     string `json:"content"`
}

// playgroundExportDownloadFixture exports one owned conversation through the
// production handler and returns the parsed download contract.
func playgroundExportDownloadFixture(t *testing.T, user int, sessionID string, format string) playgroundExportDownload {
	t.Helper()
	path := "/api/playground/sessions/" + sessionID + "/export?format=" + format
	response := playgroundRequest(t, user, http.MethodGet, path, nil, controller.ExportPlaygroundSession)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var envelope struct {
		Success bool
		Data    playgroundExportDownload
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, response.Body.String())
	require.Equal(t, format, envelope.Data.Format)
	return envelope.Data
}

// playgroundTrashListingFixture reads one account's trash through the
// production handler.
func playgroundTrashListingFixture(t *testing.T, user int) model.PlaygroundTrashListing {
	t.Helper()
	response := playgroundRequest(t, user, http.MethodGet, "/api/playground/trash", nil, controller.ListPlaygroundTrash)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var envelope struct {
		Success bool
		Data    model.PlaygroundTrashListing
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, response.Body.String())
	return envelope.Data
}

// The conversation trash lifecycle: export renders a conversation in both
// formats — active or trashed — without reading attachment bytes; deleting
// hides it from every active read and blocks new writes while its rows and its
// share of the account budgets stay stored; restore returns it intact and
// accepts only a trashed row; and the retention sweep purges only the entries
// whose owner-configured window elapsed.
func TestPlaygroundTrashLifecycle(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			usePlaygroundGroupQuota(t, "default", playground_setting.PlaygroundQuotaPolicy{TrashRetentionDays: 2})
			usePlaygroundGroupQuota(t, "team", playground_setting.PlaygroundQuotaPolicy{TrashRetentionDays: 30})
			require.NoError(t, db.Model(&model.User{}).Where("id = ?", 9).Update("group", "team").Error)

			session := createPlayground(t, 7, "trash-lifecycle")
			id := session["id"].(string)
			attachment := playgroundUploadAttachment(t, 7, id, "trash-file", "image/png", playgroundPNGFixture(64))
			attachmentID := attachment["id"].(string)
			messagePath := "/api/playground/sessions/" + id + "/messages"
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, messagePath, map[string]any{
				"revision": 0, "messages": []any{map[string]any{"client_key": "u1", "payload": map[string]any{
					"key": "u1", "from": "user",
					"versions": []any{map[string]any{"id": "u1-v1", "content": "hello trash",
						"attachments": []any{map[string]any{"id": attachmentID}}}},
				}}},
			}, controller.ReplacePlaygroundMessages).Code)

			// Export renders both formats server-side, derives the file name
			// from the title and links attachments through the owner-scoped
			// content endpoint instead of embedding their bytes.
			markdown := playgroundExportDownloadFixture(t, 7, id, "markdown")
			assert.Equal(t, "Conversation.md", markdown.Filename)
			assert.Equal(t, "text/markdown; charset=utf-8", markdown.ContentType)
			assert.Contains(t, markdown.Content, "# Conversation")
			assert.Contains(t, markdown.Content, "hello trash")
			assert.Contains(t, markdown.Content, "- [image.png](/api/playground/sessions/"+id+"/attachments/"+attachmentID+"/content)")
			jsonExport := playgroundExportDownloadFixture(t, 7, id, "json")
			assert.Equal(t, "Conversation.json", jsonExport.Filename)
			assert.Equal(t, "application/json; charset=utf-8", jsonExport.ContentType)
			var document struct {
				Session struct {
					ID      string `json:"id"`
					Title   string `json:"title"`
					Trashed bool   `json:"trashed"`
				} `json:"session"`
				Messages []struct {
					ClientKey string `json:"client_key"`
				} `json:"messages"`
			}
			require.NoError(t, common.UnmarshalJsonStr(jsonExport.Content, &document))
			assert.Equal(t, id, document.Session.ID)
			assert.Equal(t, "Conversation", document.Session.Title)
			assert.False(t, document.Session.Trashed)
			require.Len(t, document.Messages, 1)
			assert.Equal(t, "u1", document.Messages[0].ClientKey)

			// Export stays owner-scoped and rejects an unknown format.
			assert.Equal(t, http.StatusBadRequest, playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/export?format=pdf", nil, controller.ExportPlaygroundSession).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodGet, "/api/playground/sessions/"+id+"/export?format=json", nil, controller.ExportPlaygroundSession).Code)

			before := playgroundUsageCounters(t, db, 7)
			require.EqualValues(t, 1, before.Sessions)
			require.EqualValues(t, 1, before.AttachmentCount)
			require.Positive(t, before.ObjectBytes)
			assert.Empty(t, playgroundTrashListingFixture(t, 7).Items)
			// Restore is trash-only: an active conversation is not found.
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+id+"/restore", nil, controller.RestorePlaygroundSession).Code)

			// Moving the conversation to the trash hides it from every active
			// read and blocks new writes while its rows and counters stay.
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id, nil, controller.DeletePlaygroundSession).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id, nil, controller.GetPlaygroundSession).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodGet, messagePath, nil, controller.ListPlaygroundMessages).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPut, messagePath, map[string]any{"revision": 1, "messages": []any{}}, controller.ReplacePlaygroundMessages).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodGet, "/api/playground/sessions/"+id, nil, controller.GetPlaygroundSession).Code)
			assert.Contains(t, playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions", nil, controller.ListPlaygroundSessions).Body.String(), `"total":0`)
			assert.Equal(t, playgroundUsageCounterValues(before), playgroundUsageCounterValues(playgroundUsageCounters(t, db, 7)))
			var rows int64
			require.NoError(t, db.Model(&model.PlaygroundMessage{}).Where("session_id = ?", id).Count(&rows).Error)
			assert.EqualValues(t, 1, rows)
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("session_id = ?", id).Count(&rows).Error)
			assert.EqualValues(t, 1, rows)

			// The trash listing reports the entry, the account's retention
			// window and the moment the cleanup may purge it.
			listing := playgroundTrashListingFixture(t, 7)
			assert.Equal(t, 2, listing.RetentionDays)
			require.Len(t, listing.Items, 1)
			assert.Equal(t, "session", listing.Items[0].Kind)
			assert.Equal(t, id, listing.Items[0].ID)
			assert.Equal(t, "Conversation", listing.Items[0].Title)
			assert.Positive(t, listing.Items[0].DeletedAt)
			assert.Equal(t, listing.Items[0].DeletedAt+2*24*60*60, listing.Items[0].PurgeAt)

			// A trashed conversation still exports, and the file says so.
			trashedMarkdown := playgroundExportDownloadFixture(t, 7, id, "markdown")
			assert.Contains(t, trashedMarkdown.Content, "In trash since")
			trashedJSON := playgroundExportDownloadFixture(t, 7, id, "json")
			require.NoError(t, common.UnmarshalJsonStr(trashedJSON.Content, &document))
			assert.True(t, document.Session.Trashed)
			require.Len(t, document.Messages, 1)

			// Restore accepts only the owner's trashed row and returns the
			// conversation with its messages and counters untouched.
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodPost, "/api/playground/sessions/"+id+"/restore", nil, controller.RestorePlaygroundSession).Code)
			restored := playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+id+"/restore", nil, controller.RestorePlaygroundSession)
			require.Equal(t, http.StatusOK, restored.Code, restored.Body.String())
			restoredRow, err := model.GetPlaygroundSession(7, id)
			require.NoError(t, err)
			assert.Zero(t, restoredRow.DeletedAt)
			messages, _, err := model.ListPlaygroundMessages(7, id)
			require.NoError(t, err)
			require.Len(t, messages, 1)
			assert.Equal(t, playgroundUsageCounterValues(before), playgroundUsageCounterValues(playgroundUsageCounters(t, db, 7)))
			assert.Empty(t, playgroundTrashListingFixture(t, 7).Items)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+id+"/restore", nil, controller.RestorePlaygroundSession).Code)

			// A fresh trashing survives a sweep: the candidate age floors the
			// window before the owner's policy is re-checked under the lock.
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id, nil, controller.DeletePlaygroundSession).Code)
			sweep, err := model.PurgeExpiredPlaygroundTrash(100)
			require.NoError(t, err)
			assert.Zero(t, sweep.Sessions)
			assert.Zero(t, sweep.Canvases)

			// A group with a longer window keeps its entry while the same
			// sweep purges the default group's aged one.
			groupSession := createPlayground(t, 9, "trash-lifecycle-group")
			groupID := groupSession["id"].(string)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 9, http.MethodDelete, "/api/playground/sessions/"+groupID, nil, controller.DeletePlaygroundSession).Code)
			expired := common.GetTimestamp() - 3*24*60*60
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ?", id).Update("deleted_at", expired).Error)
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ?", groupID).Update("deleted_at", expired).Error)
			sweep, err = model.PurgeExpiredPlaygroundTrash(100)
			require.NoError(t, err)
			assert.EqualValues(t, 1, sweep.Sessions)
			assert.Zero(t, sweep.Canvases)

			// The purge released the rows, the stored bytes and the counter
			// share, and the conversation is no longer exportable or
			// restorable.
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ?", id).Count(&rows).Error)
			assert.Zero(t, rows)
			require.NoError(t, db.Model(&model.PlaygroundMessage{}).Where("session_id = ?", id).Count(&rows).Error)
			assert.Zero(t, rows)
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("session_id = ?", id).Count(&rows).Error)
			assert.Zero(t, rows)
			assert.Equal(t, playgroundUsageCounterValues(model.PlaygroundUserUsage{}), playgroundUsageCounterValues(playgroundUsageCounters(t, db, 7)))
			assert.Empty(t, playgroundTrashListingFixture(t, 7).Items)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id+"/export?format=json", nil, controller.ExportPlaygroundSession).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+id+"/restore", nil, controller.RestorePlaygroundSession).Code)

			// The preserved entry waits through its own window and still
			// restores with its messages.
			groupListing := playgroundTrashListingFixture(t, 9)
			assert.Equal(t, 30, groupListing.RetentionDays)
			require.Len(t, groupListing.Items, 1)
			assert.Equal(t, "session", groupListing.Items[0].Kind)
			assert.Equal(t, groupID, groupListing.Items[0].ID)
			assert.Equal(t, groupListing.Items[0].DeletedAt+30*24*60*60, groupListing.Items[0].PurgeAt)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 9, http.MethodPost, "/api/playground/sessions/"+groupID+"/restore", nil, controller.RestorePlaygroundSession).Code)
			_, err = model.GetPlaygroundSession(9, groupID)
			require.NoError(t, err)
		})
	}
}

// The optional metered storage tier samples each account's peak footprint into
// one row per account and day, charges finished days exactly once to the same
// wallet the relay consumes from, records the charge in the unified wallet
// ledger and turns an uncovered remainder into wallet debt that locks the
// account read-only until it is paid. Sampling, replay and the daily reference
// are all idempotent, and the (user_id, date) unique index keeps the day row
// single.
func TestPlaygroundStorageBillingSettlement(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			previousLog := model.LOG_DB
			model.LOG_DB = db
			require.NoError(t, db.AutoMigrate(&model.Log{}))
			t.Cleanup(func() {
				model.LOG_DB = previousLog
				require.NoError(t, db.Migrator().DropTable(&model.Log{}))
			})
			// The uncovered charge of the second account can only become debt
			// when its overdraft credit line is zero.
			previousQuotaSetting := *operation_setting.GetQuotaSetting()
			operation_setting.GetQuotaSetting().OverdraftLimitUSD = 0
			operation_setting.GetQuotaSetting().OverdraftGroupOverrides = nil
			t.Cleanup(func() { *operation_setting.GetQuotaSetting() = previousQuotaSetting })

			usePlaygroundStorageBilling(t, func(setting *playground_setting.PlaygroundStorageBillingSetting) {
				setting.Enabled = true
				setting.PriceUSDPerGBMonth = 15
				setting.FreeGB = 0
				setting.GroupFreeGB = map[string]float64{}
				setting.ApplyGroupRatio = false
				setting.GraceDays = 7
				setting.Egress = playground_setting.PlaygroundStorageEgressSetting{
					Mode:          playground_setting.PlaygroundStorageEgressModeMetered,
					PriceUSDPerGB: 1,
				}
			})

			// Account 7 stores one GiB and can pay; account 8 stores two GiB
			// and holds nothing, so its whole charge becomes debt.
			session := createPlayground(t, 7, "storage-billing")
			require.NotEmpty(t, session["id"])
			require.NoError(t, db.Model(&model.User{}).Where("id = ?", 7).Update("quota", 1_000_000).Error)
			usage7 := model.PlaygroundUserUsage{UserID: 7}
			require.NoError(t, db.Where("user_id = ?", 7).Assign(map[string]any{"attachment_bytes": int64(1) << 30}).FirstOrCreate(&usage7).Error)
			usage8 := model.PlaygroundUserUsage{UserID: 8}
			require.NoError(t, db.Where("user_id = ?", 8).Assign(map[string]any{"attachment_bytes": int64(2) << 30}).FirstOrCreate(&usage8).Error)

			now := common.GetTimestamp()
			today := time.Unix(now, 0).Format("2006-01-02")
			yesterday := time.Unix(now, 0).AddDate(0, 0, -1).Format("2006-01-02")

			// The hourly sampler folds the measured footprint into today's row
			// as a running peak.
			sampled, err := model.SamplePlaygroundStoragePeaks(now)
			require.NoError(t, err)
			assert.EqualValues(t, 1, sampled)
			var todayRow model.PlaygroundStorageLedger
			require.NoError(t, db.Where("user_id = ? AND date = ?", 7, today).First(&todayRow).Error)
			assert.EqualValues(t, int64(1)<<30, todayRow.PeakBytes)
			assert.Equal(t, model.PlaygroundStorageLedgerStatusPending, todayRow.Status)

			// One row per account and day is a database guarantee.
			require.Error(t, db.Create(&model.PlaygroundStorageLedger{UserId: 7, Date: today, Status: model.PlaygroundStorageLedgerStatusPending}).Error)

			// A finished day bills storage and metered egress exactly once:
			// one GiB stored is 0.5 USD and one GiB served is 1 USD, so the day
			// charges 1.5 USD = 750000 quota from the wallet.
			require.NoError(t, db.Create(&model.PlaygroundStorageLedger{
				UserId: 7, Date: yesterday, PeakBytes: int64(1) << 30, EgressBytes: int64(1) << 30,
				Status: model.PlaygroundStorageLedgerStatusPending,
			}).Error)
			require.NoError(t, db.Create(&model.PlaygroundStorageLedger{
				UserId: 8, Date: yesterday, PeakBytes: int64(2) << 30,
				Status: model.PlaygroundStorageLedgerStatusPending,
			}).Error)

			report, err := model.SettlePlaygroundStorageLedgers(now, 10)
			require.NoError(t, err)
			assert.EqualValues(t, 1, report.SettledCount)
			assert.EqualValues(t, 1, report.GraceCount)
			assert.EqualValues(t, 750_000, report.ChargedQuota)
			assert.EqualValues(t, 500_000, report.GraceQuota)

			var settled model.PlaygroundStorageLedger
			require.NoError(t, db.Where("user_id = ? AND date = ?", 7, yesterday).First(&settled).Error)
			assert.Equal(t, model.PlaygroundStorageLedgerStatusSettled, settled.Status)
			assert.EqualValues(t, 750_000, settled.Quota)
			assert.Zero(t, settled.DebtQuota)
			assert.EqualValues(t, 500_000, settled.EgressQuota)
			assert.EqualValues(t, int64(1)<<30, settled.BillableBytes)
			balance, err := model.GetUserQuota(7, true)
			require.NoError(t, err)
			assert.EqualValues(t, 250_000, balance)

			// The charge is one wallet-account movement under the (user, date)
			// reference that makes the day replay-safe.
			var entries []model.WalletLedgerEntry
			require.NoError(t, db.Where("user_id = ? AND ref_type = ?", 7, model.WalletLedgerRefStorageDaily).Find(&entries).Error)
			require.Len(t, entries, 1)
			assert.Equal(t, model.WalletLedgerKindStorageDaily, entries[0].Kind)
			assert.EqualValues(t, -750_000, entries[0].Amount)
			assert.Equal(t, "7:"+yesterday, entries[0].RefId)

			// The settlement is visible as an ordinary consume log.
			var logs []model.Log
			require.NoError(t, db.Where("user_id = ? AND type = ?", 7, model.LogTypeConsume).Find(&logs).Error)
			require.Len(t, logs, 1)
			assert.Equal(t, model.PlaygroundStorageBillingModelName, logs[0].ModelName)
			assert.Equal(t, 750_000, logs[0].Quota)
			assert.Contains(t, logs[0].Other, "storage_date")

			// Replaying the pass charges nothing again.
			replay, err := model.SettlePlaygroundStorageLedgers(now, 10)
			require.NoError(t, err)
			assert.Zero(t, replay.SettledCount)
			assert.Zero(t, replay.ChargedQuota)
			balance, err = model.GetUserQuota(7, true)
			require.NoError(t, err)
			assert.EqualValues(t, 250_000, balance)
			require.NoError(t, db.Where("user_id = ? AND ref_type = ?", 7, model.WalletLedgerRefStorageDaily).Find(&entries).Error)
			assert.Len(t, entries, 1)

			// The ledger agrees with the unified wallet ledger.
			reconcile, err := model.ReconcilePlaygroundStorageBilling(50, 0)
			require.NoError(t, err)
			assert.Zero(t, reconcile.DeviationCount, "%+v", reconcile.Deviations)

			// Even a row forced back to pending cannot charge twice: the
			// claimed wallet reference refuses the replay.
			require.NoError(t, db.Model(&model.PlaygroundStorageLedger{}).Where("user_id = ? AND date = ?", 7, yesterday).Update("status", model.PlaygroundStorageLedgerStatusPending).Error)
			forced, err := model.SettlePlaygroundStorageLedgers(now, 10)
			require.NoError(t, err)
			assert.Zero(t, forced.ChargedQuota)
			balance, err = model.GetUserQuota(7, true)
			require.NoError(t, err)
			assert.EqualValues(t, 250_000, balance)
			require.NoError(t, db.Where("user_id = ? AND ref_type = ?", 7, model.WalletLedgerRefStorageDaily).Find(&entries).Error)
			assert.Len(t, entries, 1)

			// Account 8's uncovered day is debt and mirrors the shared
			// read-only lock: the workspace status reports it and new billable
			// work is refused until the wallet pays.
			var graced model.PlaygroundStorageLedger
			require.NoError(t, db.Where("user_id = ? AND date = ?", 8, yesterday).First(&graced).Error)
			assert.Equal(t, model.PlaygroundStorageLedgerStatusGrace, graced.Status)
			assert.EqualValues(t, 500_000, graced.DebtQuota)
			assert.Zero(t, graced.Quota)
			assert.EqualValues(t, now+7*24*60*60, graced.GraceUntil)
			debt, readOnly, err := model.ResolveWalletDebtStatus(8)
			require.NoError(t, err)
			assert.EqualValues(t, 500_000, debt)
			assert.True(t, readOnly)

			status := playgroundRequest(t, 8, http.MethodGet, "/api/playground/storage/billing", nil, controller.GetPlaygroundStorageBilling)
			require.Equal(t, http.StatusOK, status.Code, status.Body.String())
			assert.Contains(t, status.Body.String(), `"read_only":true`)
			assert.Contains(t, status.Body.String(), `"debt_quota":500000`)
			blocked := playgroundRequest(t, 8, http.MethodPost, "/v1/videos", map[string]any{"model": "kling-v1", "prompt": "fox"}, controller.PlaygroundVideoTask)
			assert.Equal(t, http.StatusForbidden, blocked.Code, blocked.Body.String())
			assert.Contains(t, blocked.Body.String(), controller.PlaygroundWalletDebtErrorCode)

			// A recharge pays the debt and the lock clears by itself.
			_, err = model.ApplyWalletLedgerDeltaDB(8, model.WalletLedgerKindTopUp, 500_000, model.WalletLedgerRefTopUp, "pg-storage-topup", "")
			require.NoError(t, err)
			debt, readOnly, err = model.ResolveWalletDebtStatus(8)
			require.NoError(t, err)
			assert.Zero(t, debt)
			assert.False(t, readOnly)
			balance, err = model.GetUserQuota(8, true)
			require.NoError(t, err)
			assert.Zero(t, balance, "the recharge paid the debt instead of becoming spendable")
		})
	}
}

// The metered tier bounds attachment downloads per day: the byte and request
// ceilings refuse the transfer that would cross them before a byte is served,
// the served volume is accumulated for settlement, and the enforcement only
// applies while the tier is enabled.
func TestPlaygroundStorageBillingEgressLimits(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			png := playgroundPNGFixture(64)
			usePlaygroundStorageBilling(t, func(setting *playground_setting.PlaygroundStorageBillingSetting) {
				setting.Enabled = true
				setting.FreeGB = 0
				setting.GroupFreeGB = map[string]float64{}
				setting.Egress = playground_setting.PlaygroundStorageEgressSetting{
					Mode:               playground_setting.PlaygroundStorageEgressModeMetered,
					PriceUSDPerGB:      1,
					DailyBytesLimit:    int64(len(png)) + 8,
					DailyRequestsLimit: 3,
				}
			})
			session := createPlayground(t, 7, "storage-egress")
			id := session["id"].(string)
			uploaded := playgroundUploadAttachment(t, 7, id, "egress-1", "image/png", png)
			attachmentID, _ := uploaded["id"].(string)
			require.NotEmpty(t, attachmentID)
			contentPath := "/api/playground/sessions/" + id + "/attachments/" + attachmentID + "/content"

			content := playgroundRequest(t, 7, http.MethodGet, contentPath, nil, controller.GetPlaygroundAttachmentContent)
			require.Equal(t, http.StatusOK, content.Code, content.Body.String())
			assert.Equal(t, png, content.Body.Bytes())

			// The next full download would cross the daily byte budget.
			refused := playgroundRequest(t, 7, http.MethodGet, contentPath, nil, controller.GetPlaygroundAttachmentContent)
			assert.Equal(t, http.StatusTooManyRequests, refused.Code, refused.Body.String())
			assert.Contains(t, refused.Body.String(), controller.PlaygroundEgressLimitErrorCode)

			today := time.Unix(common.GetTimestamp(), 0).Format("2006-01-02")
			var row model.PlaygroundStorageLedger
			require.NoError(t, db.Where("user_id = ? AND date = ?", 7, today).First(&row).Error)
			assert.EqualValues(t, len(png), row.EgressBytes)
			assert.EqualValues(t, 1, row.EgressRequests)

			// The request ceiling refuses independently of the byte budget.
			setting := playground_setting.GetPlaygroundStorageBillingSetting()
			setting.Egress.DailyBytesLimit = 0
			setting.Egress.DailyRequestsLimit = 1
			refused = playgroundRequest(t, 7, http.MethodGet, contentPath, nil, controller.GetPlaygroundAttachmentContent)
			assert.Equal(t, http.StatusTooManyRequests, refused.Code, refused.Body.String())
			assert.Contains(t, refused.Body.String(), controller.PlaygroundEgressLimitErrorCode)
			require.NoError(t, db.Where("user_id = ? AND date = ?", 7, today).First(&row).Error)
			assert.EqualValues(t, 1, row.EgressRequests)

			// Disabling the tier lifts the limits without deleting anything.
			setting.Enabled = false
			content = playgroundRequest(t, 7, http.MethodGet, contentPath, nil, controller.GetPlaygroundAttachmentContent)
			require.Equal(t, http.StatusOK, content.Code, content.Body.String())
			assert.Equal(t, png, content.Body.Bytes())
		})
	}
}

// playgroundKnowledgeEmbedding encodes one vector exactly as the browser sends
// it: little-endian float32 values, base64-decoded by the handler before the
// model validates the dimension and finiteness.
func playgroundKnowledgeEmbedding(values ...float32) []byte {
	encoded := make([]byte, len(values)*4)
	for index, value := range values {
		binary.LittleEndian.PutUint32(encoded[index*4:], math.Float32bits(value))
	}
	return encoded
}

type playgroundKnowledgeDocumentJSON struct {
	ID              string `json:"id"`
	KnowledgeBaseID string `json:"knowledge_base_id"`
	Filename        string `json:"filename"`
	MediaType       string `json:"media_type"`
	ByteSize        int64  `json:"byte_size"`
	TextBytes       int64  `json:"text_bytes"`
	PageCount       int    `json:"page_count"`
	Status          string `json:"status"`
	ErrorMessage    string `json:"error_message"`
	EmbeddingModel  string `json:"embedding_model"`
	EmbeddingDims   int    `json:"embedding_dims"`
	ChunkCount      int    `json:"chunk_count"`
	Text            string `json:"text"`
}

func playgroundKnowledgeResponseData(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var envelope struct {
		Success bool
		Data    json.RawMessage
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, response.Body.String())
	require.NoError(t, common.Unmarshal(envelope.Data, target))
}

// TestPlaygroundKnowledgeBaseMatrix covers the LB-07 pipeline end to end on
// every supported database: base/document quotas, upload plus CH-05 extraction,
// client-computed embedding storage, reindex/retry, counter and usage figures,
// object cleanup and owner isolation. Embedding itself runs through the normal
// relay, so no provider is called here; the test feeds the exact wire shape the
// browser submits after calling /pg/embeddings.
func TestPlaygroundKnowledgeBaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.KnowledgeBaseUserMaxCount = 1
				policy.KnowledgeBaseDocumentUserMaxCount = 3
				policy.KnowledgeBaseDocumentMaxCount = 2
				policy.KnowledgeBaseChunkUserMaxCount = 4
				policy.KnowledgeBaseChunkMaxCount = 3
				policy.KnowledgeBaseChunkTextMaxBytes = 8
				policy.KnowledgeBaseEmbeddingMaxDims = 8
				policy.KnowledgeBaseUserMaxBytes = 1 << 20
			})
			basePath := "/api/playground/knowledge-bases"
			var baseEnvelope struct {
				Created       bool `json:"created"`
				KnowledgeBase struct {
					ID             string `json:"id"`
					Name           string `json:"name"`
					EmbeddingModel string `json:"embedding_model"`
					DocumentCount  int64  `json:"document_count"`
					ChunkCount     int64  `json:"chunk_count"`
					ByteSize       int64  `json:"byte_size"`
				} `json:"knowledge_base"`
			}
			playgroundKnowledgeResponseData(t, playgroundRequest(t, 7, http.MethodPost, basePath, map[string]any{
				"client_key": "kb-one", "name": "Handbook", "embedding_model": "embedding-3-small",
			}, controller.CreatePlaygroundKnowledgeBase), &baseEnvelope)
			require.True(t, baseEnvelope.Created)
			baseID := baseEnvelope.KnowledgeBase.ID
			require.NotEmpty(t, baseID)
			assert.Equal(t, "Handbook", baseEnvelope.KnowledgeBase.Name)
			assert.Equal(t, "embedding-3-small", baseEnvelope.KnowledgeBase.EmbeddingModel)

			// A replay acknowledges the stored base; a different payload under
			// the same client key is a conflict, and the account base budget is
			// enforced.
			playgroundKnowledgeResponseData(t, playgroundRequest(t, 7, http.MethodPost, basePath, map[string]any{
				"client_key": "kb-one", "name": "Handbook", "embedding_model": "embedding-3-small",
			}, controller.CreatePlaygroundKnowledgeBase), &baseEnvelope)
			assert.False(t, baseEnvelope.Created)
			assert.Equal(t, baseID, baseEnvelope.KnowledgeBase.ID)
			conflict := playgroundRequest(t, 7, http.MethodPost, basePath, map[string]any{
				"client_key": "kb-one", "name": "Other", "embedding_model": "embedding-3-small",
			}, controller.CreatePlaygroundKnowledgeBase)
			assert.Equal(t, http.StatusConflict, conflict.Code, conflict.Body.String())
			secondBase := playgroundRequest(t, 7, http.MethodPost, basePath, map[string]any{
				"client_key": "kb-two", "name": "Second", "embedding_model": "embedding-3-small",
			}, controller.CreatePlaygroundKnowledgeBase)
			assert.Equal(t, http.StatusUnprocessableEntity, secondBase.Code, secondBase.Body.String())

			// A base is always owner-scoped.
			foreign := playgroundRequest(t, 8, http.MethodGet, basePath+"/"+baseID, nil, controller.GetPlaygroundKnowledgeBase)
			assert.Equal(t, http.StatusNotFound, foreign.Code, foreign.Body.String())

			documentPath := basePath + "/" + baseID + "/documents"
			var documentEnvelope struct {
				Created  bool                            `json:"created"`
				Document playgroundKnowledgeDocumentJSON `json:"document"`
			}
			source := []byte("Alpha paragraph.\r\nBeta paragraph.\r\n")
			playgroundKnowledgeResponseData(t, playgroundRequest(t, 7, http.MethodPost, documentPath, map[string]any{
				"client_key": "doc-one", "media_type": "text/plain", "filename": "handbook.txt",
				"data": base64.StdEncoding.EncodeToString(source),
			}, controller.CreatePlaygroundKnowledgeDocument), &documentEnvelope)
			require.True(t, documentEnvelope.Created)
			documentID := documentEnvelope.Document.ID
			require.NotEmpty(t, documentID)
			assert.Equal(t, model.PlaygroundKnowledgeDocumentStatusPending, documentEnvelope.Document.Status)
			assert.Equal(t, "Alpha paragraph.\nBeta paragraph.", documentEnvelope.Document.Text)
			assert.EqualValues(t, len(source), documentEnvelope.Document.ByteSize)
			assert.EqualValues(t, len(documentEnvelope.Document.Text), documentEnvelope.Document.TextBytes)

			// The source bytes live in the object store under the documented key.
			var stored model.PlaygroundKnowledgeDocument
			require.NoError(t, db.Where("id = ?", documentID).First(&stored).Error)
			assert.True(t, strings.HasPrefix(stored.ObjectKey, "pg/7/knowledge/"), stored.ObjectKey)
			store := objectstore.DefaultStore()
			require.NotNil(t, store)
			reader, _, err := store.Get(context.Background(), stored.ObjectKey)
			require.NoError(t, err)
			objectBytes, err := io.ReadAll(reader)
			require.NoError(t, err)
			require.NoError(t, reader.Close())
			assert.Equal(t, source, objectBytes)

			// Replaying the same client key acknowledges the document, while a
			// different body is a conflict.
			playgroundKnowledgeResponseData(t, playgroundRequest(t, 7, http.MethodPost, documentPath, map[string]any{
				"client_key": "doc-one", "media_type": "text/plain", "filename": "handbook.txt",
				"data": base64.StdEncoding.EncodeToString(source),
			}, controller.CreatePlaygroundKnowledgeDocument), &documentEnvelope)
			assert.False(t, documentEnvelope.Created)
			assert.Equal(t, documentID, documentEnvelope.Document.ID)
			docConflict := playgroundRequest(t, 7, http.MethodPost, documentPath, map[string]any{
				"client_key": "doc-one", "media_type": "text/plain", "filename": "handbook.txt",
				"data": base64.StdEncoding.EncodeToString([]byte("different")),
			}, controller.CreatePlaygroundKnowledgeDocument)
			assert.Equal(t, http.StatusConflict, docConflict.Code, docConflict.Body.String())

			// A client-reported embedding failure keeps the extracted text, and
			// reindexing resets the chunks so the same text can be tried again.
			failed := playgroundRequest(t, 7, http.MethodPost, documentPath+"/"+documentID+"/failure", map[string]any{
				"message": "embedding provider rejected the request",
			}, controller.FailPlaygroundKnowledgeDocument)
			require.Equal(t, http.StatusOK, failed.Code, failed.Body.String())
			var failedDocument playgroundKnowledgeDocumentJSON
			playgroundKnowledgeResponseData(t, failed, &failedDocument)
			assert.Equal(t, model.PlaygroundKnowledgeDocumentStatusFailed, failedDocument.Status)
			assert.Equal(t, "embedding provider rejected the request", failedDocument.ErrorMessage)
			detail := playgroundRequest(t, 7, http.MethodGet, documentPath+"/"+documentID, nil, controller.GetPlaygroundKnowledgeDocument)
			var detailDocument playgroundKnowledgeDocumentJSON
			playgroundKnowledgeResponseData(t, detail, &detailDocument)
			assert.Equal(t, documentEnvelope.Document.Text, detailDocument.Text)
			reindexed := playgroundRequest(t, 7, http.MethodPost, documentPath+"/"+documentID+"/reindex", nil, controller.ReindexPlaygroundKnowledgeDocument)
			var reindexedDocument playgroundKnowledgeDocumentJSON
			playgroundKnowledgeResponseData(t, reindexed, &reindexedDocument)
			assert.Equal(t, model.PlaygroundKnowledgeDocumentStatusPending, reindexedDocument.Status)
			assert.Zero(t, reindexedDocument.ChunkCount)
			assert.Equal(t, documentEnvelope.Document.Text, reindexedDocument.Text)

			// Store one complete set of client-computed chunks. The wire shape
			// mirrors the browser after /pg/embeddings: base64 float32 vectors
			// plus contiguous indexes.
			chunksPath := documentPath + "/" + documentID + "/chunks"
			chunksBody := map[string]any{
				"embedding_model": "embedding-3-small",
				"dims":            3,
				"chunks": []map[string]any{
					{"index": 0, "text": "Alpha", "embedding": base64.StdEncoding.EncodeToString(playgroundKnowledgeEmbedding(0.1, 0.2, 0.3))},
					{"index": 1, "text": "Beta", "embedding": base64.StdEncoding.EncodeToString(playgroundKnowledgeEmbedding(0.4, 0.5, 0.6))},
				},
			}
			ready := playgroundRequest(t, 7, http.MethodPut, chunksPath, chunksBody, controller.ReplacePlaygroundKnowledgeDocumentChunks)
			var readyDocument playgroundKnowledgeDocumentJSON
			playgroundKnowledgeResponseData(t, ready, &readyDocument)
			assert.Equal(t, model.PlaygroundKnowledgeDocumentStatusReady, readyDocument.Status)
			assert.Equal(t, 2, readyDocument.ChunkCount)
			assert.Equal(t, 3, readyDocument.EmbeddingDims)
			assert.Equal(t, "embedding-3-small", readyDocument.EmbeddingModel)

			// A late failure report from a reordered client request cannot mark
			// already indexed chunks as failed.
			lateFailure := playgroundRequest(t, 7, http.MethodPost, documentPath+"/"+documentID+"/failure", map[string]any{
				"message": "late browser failure",
			}, controller.FailPlaygroundKnowledgeDocument)
			require.Equal(t, http.StatusOK, lateFailure.Code, lateFailure.Body.String())
			var lateDocument playgroundKnowledgeDocumentJSON
			playgroundKnowledgeResponseData(t, lateFailure, &lateDocument)
			assert.Equal(t, model.PlaygroundKnowledgeDocumentStatusReady, lateDocument.Status)
			assert.Empty(t, lateDocument.ErrorMessage)

			counters := playgroundUsageCounters(t, db, 7)
			assert.EqualValues(t, 1, counters.KnowledgeBaseCount)
			assert.EqualValues(t, 1, counters.KnowledgeBaseDocumentCount)
			assert.EqualValues(t, 2, counters.KnowledgeBaseChunkCount)
			assert.Positive(t, counters.KnowledgeBaseBytes)
			usage, err := model.PlaygroundUsageForUser(7)
			require.NoError(t, err)
			assert.EqualValues(t, 1, usage.KnowledgeBases.Used)
			assert.EqualValues(t, 1, usage.KnowledgeBases.Limit)
			assert.EqualValues(t, 1, usage.KnowledgeBaseDocuments.Used)
			assert.EqualValues(t, 2, usage.KnowledgeBaseChunks.Used)
			assert.EqualValues(t, counters.KnowledgeBaseBytes, usage.KnowledgeBaseChunks.UsedBytes)
			assert.EqualValues(t, counters.ObjectBytes, usage.Storage.UsedBytes)
			footprint, err := model.PlaygroundStorageBillableFootprint(7)
			require.NoError(t, err)
			assert.GreaterOrEqual(t, footprint, counters.KnowledgeBaseBytes)

			// Replacing the set adjusts the counters by the difference rather
			// than accumulating stale chunks.
			chunksBody["chunks"] = []map[string]any{
				{"index": 0, "text": "Gamma", "embedding": base64.StdEncoding.EncodeToString(playgroundKnowledgeEmbedding(0.7, 0.8, 0.9))},
			}
			playgroundKnowledgeResponseData(t, playgroundRequest(t, 7, http.MethodPut, chunksPath, chunksBody, controller.ReplacePlaygroundKnowledgeDocumentChunks), &readyDocument)
			assert.Equal(t, 1, readyDocument.ChunkCount)
			counters = playgroundUsageCounters(t, db, 7)
			assert.EqualValues(t, 1, counters.KnowledgeBaseChunkCount)

			// Non-contiguous indexes, false dimensions and oversized text are
			// rejected before anything is stored.
			badIndex := playgroundRequest(t, 7, http.MethodPut, chunksPath, map[string]any{
				"embedding_model": "embedding-3-small", "dims": 3,
				"chunks": []map[string]any{{"index": 1, "text": "Alpha", "embedding": base64.StdEncoding.EncodeToString(playgroundKnowledgeEmbedding(0.1, 0.2, 0.3))}},
			}, controller.ReplacePlaygroundKnowledgeDocumentChunks)
			assert.Equal(t, http.StatusBadRequest, badIndex.Code, badIndex.Body.String())
			badDims := playgroundRequest(t, 7, http.MethodPut, chunksPath, map[string]any{
				"embedding_model": "embedding-3-small", "dims": 4,
				"chunks": []map[string]any{{"index": 0, "text": "Alpha", "embedding": base64.StdEncoding.EncodeToString(playgroundKnowledgeEmbedding(0.1, 0.2, 0.3))}},
			}, controller.ReplacePlaygroundKnowledgeDocumentChunks)
			assert.Equal(t, http.StatusBadRequest, badDims.Code, badDims.Body.String())
			oversizedText := playgroundRequest(t, 7, http.MethodPut, chunksPath, map[string]any{
				"embedding_model": "embedding-3-small", "dims": 3,
				"chunks": []map[string]any{{"index": 0, "text": "123456789", "embedding": base64.StdEncoding.EncodeToString(playgroundKnowledgeEmbedding(0.1, 0.2, 0.3))}},
			}, controller.ReplacePlaygroundKnowledgeDocumentChunks)
			assert.Equal(t, http.StatusUnprocessableEntity, oversizedText.Code, oversizedText.Body.String())

			// Changing the base model makes old chunks stale; the client must
			// reindex with the new model, and a mismatch is refused.
			var updatedBase struct {
				EmbeddingModel string `json:"embedding_model"`
			}
			playgroundKnowledgeResponseData(t, playgroundRequest(t, 7, http.MethodPatch, basePath+"/"+baseID, map[string]any{
				"embedding_model": "embedding-3-large",
			}, controller.UpdatePlaygroundKnowledgeBase), &updatedBase)
			assert.Equal(t, "embedding-3-large", updatedBase.EmbeddingModel)
			stale := playgroundRequest(t, 7, http.MethodPut, chunksPath, chunksBody, controller.ReplacePlaygroundKnowledgeDocumentChunks)
			assert.Equal(t, http.StatusBadRequest, stale.Code, stale.Body.String())
			assert.Contains(t, stale.Body.String(), "PLAYGROUND_KNOWLEDGE_EMBEDDING_MODEL_MISMATCH")
			playgroundRequest(t, 7, http.MethodPost, documentPath+"/"+documentID+"/reindex", nil, controller.ReindexPlaygroundKnowledgeDocument)
			chunksBody["embedding_model"] = "embedding-3-large"
			playgroundKnowledgeResponseData(t, playgroundRequest(t, 7, http.MethodPut, chunksPath, chunksBody, controller.ReplacePlaygroundKnowledgeDocumentChunks), &readyDocument)
			assert.Equal(t, "embedding-3-large", readyDocument.EmbeddingModel)

			// A second document is allowed; a third crosses the per-base cap.
			secondSource := []byte("Second document body.")
			playgroundKnowledgeResponseData(t, playgroundRequest(t, 7, http.MethodPost, documentPath, map[string]any{
				"client_key": "doc-two", "media_type": "text/plain", "filename": "second.txt",
				"data": base64.StdEncoding.EncodeToString(secondSource),
			}, controller.CreatePlaygroundKnowledgeDocument), &documentEnvelope)
			secondDocumentID := documentEnvelope.Document.ID
			require.NotEmpty(t, secondDocumentID)
			thirdDocument := playgroundRequest(t, 7, http.MethodPost, documentPath, map[string]any{
				"client_key": "doc-three", "media_type": "text/plain", "filename": "third.txt",
				"data": base64.StdEncoding.EncodeToString([]byte("Third document body.")),
			}, controller.CreatePlaygroundKnowledgeDocument)
			assert.Equal(t, http.StatusUnprocessableEntity, thirdDocument.Code, thirdDocument.Body.String())
			listed := playgroundRequest(t, 7, http.MethodGet, documentPath, nil, controller.ListPlaygroundKnowledgeDocuments)
			require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
			assert.Contains(t, listed.Body.String(), `"total":2`)

			// Deleting one document releases its chunks, bytes and object.
			var secondStored model.PlaygroundKnowledgeDocument
			require.NoError(t, db.Where("id = ?", secondDocumentID).First(&secondStored).Error)
			require.NoError(t, model.DeletePlaygroundKnowledgeDocument(7, baseID, documentID))
			counters = playgroundUsageCounters(t, db, 7)
			assert.EqualValues(t, 1, counters.KnowledgeBaseDocumentCount)
			assert.Zero(t, counters.KnowledgeBaseChunkCount)
			_, err = store.Head(context.Background(), stored.ObjectKey)
			assert.ErrorIs(t, err, objectstore.ErrObjectNotFound)
			foreignDocument := playgroundRequest(t, 8, http.MethodGet, documentPath+"/"+secondDocumentID, nil, controller.GetPlaygroundKnowledgeDocument)
			assert.Equal(t, http.StatusNotFound, foreignDocument.Code)

			// Deleting the base releases the remaining document and all counters.
			require.NoError(t, model.DeletePlaygroundKnowledgeBase(7, baseID))
			counters = playgroundUsageCounters(t, db, 7)
			assert.Zero(t, counters.KnowledgeBaseCount)
			assert.Zero(t, counters.KnowledgeBaseDocumentCount)
			assert.Zero(t, counters.KnowledgeBaseChunkCount)
			assert.Zero(t, counters.KnowledgeBaseBytes)
			assert.Zero(t, counters.ObjectBytes)
			_, err = store.Head(context.Background(), secondStored.ObjectKey)
			assert.ErrorIs(t, err, objectstore.ErrObjectNotFound)
			var remaining int64
			require.NoError(t, db.Model(&model.PlaygroundKnowledgeChunk{}).Where("user_id = ?", 7).Count(&remaining).Error)
			assert.Zero(t, remaining)
		})
	}
}

// TestPlaygroundSessionShares protects the public read-only link contract:
// hash-only storage, rotation, anonymous sanitization, indistinguishable 404s,
// expiry, trash/purge cleanup and owner isolation on all supported databases.
func TestPlaygroundSessionShares(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			session := createPlayground(t, 7, "share-session")
			sessionID := session["id"].(string)
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ?", sessionID).
				Update("opening_message", "Welcome to the shared conversation").Error)

			now := common.GetTimestamp()
			storedPayloads := []map[string]any{
				{
					"key": "shared-user", "from": "user",
					"versions": []any{map[string]any{
						"id": "shared-user-v1", "content": "Hello from the user",
						"attachments": []any{map[string]any{
							"id": "att-secret", "media_type": "image/png", "filename": "diagram.png", "byte_size": 42,
						}},
					}},
				},
				{
					"key": "shared-assistant", "from": "assistant", "activeVersionIndex": 1,
					"versions": []any{
						map[string]any{"id": "shared-assistant-v0", "content": "Draft answer"},
						map[string]any{
							"id": "shared-assistant-v1", "content": "Final answer",
							"toolCalls": []any{map[string]any{
								"id": "call-secret", "name": "web_search", "arguments": "private arguments",
								"status": "completed", "result": "private result",
							}},
							"attachments": []any{map[string]any{
								"id": "att-secret-assistant", "media_type": "application/pdf", "filename": "notes.pdf", "byte_size": 99,
							}},
						},
					},
					"reasoning": map[string]any{"content": "private reasoning", "duration": 1},
					"sources":   []any{map[string]any{"href": "https://private.example", "title": "Private source"}},
					"requestId": "private-request-id",
				},
				// Internal senders and unusable version pointers are never part
				// of a public snapshot, even if legacy or corrupt rows contain
				// them. They must not shift the two visible messages.
				{
					"key": "shared-system", "from": "system",
					"versions": []any{map[string]any{"id": "shared-system-v1", "content": "system secret"}},
				},
				{
					"key": "shared-empty", "from": "assistant",
					"versions": []any{map[string]any{"id": "shared-empty-v1", "content": ""}},
				},
				{
					"key": "shared-out-of-range", "from": "assistant", "activeVersionIndex": 9,
					"versions": []any{map[string]any{"id": "shared-out-of-range-v1", "content": "unreachable secret"}},
				},
			}
			for index, payload := range storedPayloads {
				encoded, err := common.Marshal(payload)
				require.NoError(t, err)
				require.NoError(t, db.Create(&model.PlaygroundMessage{
					SessionID: sessionID, UserID: 7, ClientKey: payload["key"].(string),
					Position: index * 1024, Payload: model.LongText(encoded), CreatedAt: now, UpdatedAt: now,
				}).Error)
			}
			require.NoError(t, db.Create(&model.PlaygroundMessage{
				SessionID: sessionID, UserID: 7, ClientKey: "shared-invalid-json",
				Position: len(storedPayloads) * 1024, Payload: model.LongText(`{"from":"assistant","versions":[`),
				CreatedAt: now, UpdatedAt: now,
			}).Error)

			createPath := "/api/playground/sessions/" + sessionID + "/share"
			missingToken := "this-token-does-not-exist"
			missing := playgroundRequest(t, 0, http.MethodGet, "/api/playground/shared/"+missingToken, nil, controller.GetSharedPlaygroundSession)
			require.Equal(t, http.StatusNotFound, missing.Code, missing.Body.String())
			assert.Contains(t, missing.Body.String(), "PLAYGROUND_SHARE_NOT_FOUND")
			notFoundBody := missing.Body.String()
			oversized := playgroundRequest(t, 0, http.MethodGet, "/api/playground/shared/"+strings.Repeat("a", 257), nil, controller.GetSharedPlaygroundSession)
			assert.Equal(t, http.StatusNotFound, oversized.Code)
			assert.Equal(t, notFoundBody, oversized.Body.String())

			foreignCreate := playgroundRequest(t, 8, http.MethodPost, createPath, map[string]any{"expires_in_days": 7}, controller.CreatePlaygroundSessionShare)
			assert.Equal(t, http.StatusNotFound, foreignCreate.Code, foreignCreate.Body.String())
			foreignDelete := playgroundRequest(t, 8, http.MethodDelete, createPath, nil, controller.DeletePlaygroundSessionShare)
			assert.Equal(t, http.StatusNotFound, foreignDelete.Code, foreignDelete.Body.String())
			var shareCount int64
			require.NoError(t, db.Model(&model.PlaygroundSessionShare{}).Where("session_id = ?", sessionID).Count(&shareCount).Error)
			assert.Zero(t, shareCount)

			createShare := func(expiresInDays int) (string, int64) {
				response := playgroundRequest(t, 7, http.MethodPost, createPath, map[string]any{"expires_in_days": expiresInDays}, controller.CreatePlaygroundSessionShare)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				var envelope struct {
					Success bool
					Data    struct {
						Token     string `json:"token"`
						URLPath   string `json:"url_path"`
						ExpiresAt int64  `json:"expires_at"`
						CreatedAt int64  `json:"created_at"`
					}
				}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
				require.True(t, envelope.Success, response.Body.String())
				require.NotEmpty(t, envelope.Data.Token)
				assert.Equal(t, "/share/"+envelope.Data.Token, envelope.Data.URLPath)
				assert.NotContains(t, envelope.Data.URLPath, "..")
				return envelope.Data.Token, envelope.Data.ExpiresAt
			}
			readShared := func(token string) *httptest.ResponseRecorder {
				return playgroundRequest(t, 0, http.MethodGet, "/api/playground/shared/"+token, nil, controller.GetSharedPlaygroundSession)
			}

			firstToken, firstExpiry := createShare(7)
			assert.GreaterOrEqual(t, firstExpiry, now+7*24*60*60)
			decodedToken, decodeErr := base64.RawURLEncoding.DecodeString(firstToken)
			require.NoError(t, decodeErr)
			assert.Len(t, decodedToken, 16, "the plaintext token carries exactly 128 random bits")
			var storedShare model.PlaygroundSessionShare
			require.NoError(t, db.Where("session_id = ? AND revoked_at = 0", sessionID).First(&storedShare).Error)
			hash := sha256.Sum256([]byte(firstToken))
			assert.Equal(t, hex.EncodeToString(hash[:]), storedShare.TokenHash)
			assert.NotEqual(t, firstToken, storedShare.TokenHash)
			assert.NotContains(t, storedShare.TokenHash, firstToken)

			read := readShared(firstToken)
			require.Equal(t, http.StatusOK, read.Code, read.Body.String())
			assert.Equal(t, "noindex, nofollow, noarchive", read.Header().Get("X-Robots-Tag"))
			assert.Equal(t, "no-referrer", read.Header().Get("Referrer-Policy"))
			assert.Equal(t, "nosniff", read.Header().Get("X-Content-Type-Options"))
			var snapshot struct {
				Success bool
				Data    struct {
					Title          string `json:"title"`
					OpeningMessage string `json:"opening_message"`
					Messages       []struct {
						Key       string `json:"key"`
						From      string `json:"from"`
						Content   string `json:"content"`
						ToolCalls []struct {
							Name   string `json:"name"`
							Status string `json:"status"`
						} `json:"tool_calls"`
						Attachments []struct {
							Filename  string `json:"filename"`
							MediaType string `json:"media_type"`
						} `json:"attachments"`
					} `json:"messages"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(read.Body.Bytes(), &snapshot))
			require.True(t, snapshot.Success)
			assert.Equal(t, "Conversation", snapshot.Data.Title)
			assert.Equal(t, "Welcome to the shared conversation", snapshot.Data.OpeningMessage)
			require.Len(t, snapshot.Data.Messages, 2)
			assert.Equal(t, "shared-user", snapshot.Data.Messages[0].Key)
			assert.Equal(t, "Hello from the user", snapshot.Data.Messages[0].Content)
			require.Len(t, snapshot.Data.Messages[0].Attachments, 1)
			assert.Equal(t, "diagram.png", snapshot.Data.Messages[0].Attachments[0].Filename)
			assert.Equal(t, "image/png", snapshot.Data.Messages[0].Attachments[0].MediaType)
			assert.Equal(t, "shared-assistant", snapshot.Data.Messages[1].Key)
			assert.Equal(t, "Final answer", snapshot.Data.Messages[1].Content)
			require.Len(t, snapshot.Data.Messages[1].ToolCalls, 1)
			assert.Equal(t, "web_search", snapshot.Data.Messages[1].ToolCalls[0].Name)
			assert.Equal(t, "completed", snapshot.Data.Messages[1].ToolCalls[0].Status)
			require.Len(t, snapshot.Data.Messages[1].Attachments, 1)
			assert.Equal(t, "notes.pdf", snapshot.Data.Messages[1].Attachments[0].Filename)
			assert.Equal(t, "application/pdf", snapshot.Data.Messages[1].Attachments[0].MediaType)
			for _, secret := range []string{
				"Draft answer", "private arguments", "private result", "private reasoning",
				"private-request-id", "private.example", "att-secret", "call-secret",
				"system secret", "unreachable secret", sessionID,
			} {
				assert.NotContains(t, read.Body.String(), secret)
			}
			assert.NotContains(t, read.Body.String(), `"user_id"`)
			assert.NotContains(t, read.Body.String(), `"token"`)

			// Exporting the conversation never includes link material: the
			// share table is an access mechanism, not conversation content.
			exported := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+sessionID+"/export", nil, controller.ExportPlaygroundSession)
			require.Equal(t, http.StatusOK, exported.Code, exported.Body.String())
			assert.NotContains(t, exported.Body.String(), firstToken)
			assert.NotContains(t, exported.Body.String(), storedShare.TokenHash)

			// Creating a link revokes the previous one; only the new token
			// resolves, and the response never echoes the old token.
			secondToken, _ := createShare(0)
			assert.NotEqual(t, firstToken, secondToken)
			old := readShared(firstToken)
			assert.Equal(t, http.StatusNotFound, old.Code)
			assert.Equal(t, notFoundBody, old.Body.String())
			require.Equal(t, http.StatusOK, readShared(secondToken).Code)

			for _, invalid := range []int{-1, 366} {
				response := playgroundRequest(t, 7, http.MethodPost, createPath, map[string]any{"expires_in_days": invalid}, controller.CreatePlaygroundSessionShare)
				assert.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			}

			// An expired link returns exactly the same response as an unknown
			// one; the row remains for audit until the conversation is purged.
			expiredToken, _ := createShare(1)
			expiredHash := sha256.Sum256([]byte(expiredToken))
			require.NoError(t, db.Model(&model.PlaygroundSessionShare{}).
				Where("token_hash = ?", hex.EncodeToString(expiredHash[:])).
				Update("expires_at", common.GetTimestamp()-1).Error)
			expired := readShared(expiredToken)
			assert.Equal(t, http.StatusNotFound, expired.Code)
			assert.Equal(t, notFoundBody, expired.Body.String())

			// Revocation is idempotent and revoked links are indistinguishable
			// from a token that never existed.
			for range 2 {
				response := playgroundRequest(t, 7, http.MethodDelete, createPath, nil, controller.DeletePlaygroundSessionShare)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				assert.Contains(t, response.Body.String(), `"revoked":true`)
			}
			revoked := readShared(secondToken)
			assert.Equal(t, http.StatusNotFound, revoked.Code)
			assert.Equal(t, notFoundBody, revoked.Body.String())

			// Entering the trash revokes the current link, restoring does not
			// resurrect it, and a purge removes every share row.
			trashToken, _ := createShare(30)
			require.Equal(t, http.StatusOK, readShared(trashToken).Code)
			require.NoError(t, model.DeletePlaygroundSession(7, sessionID))
			trashedRead := readShared(trashToken)
			assert.Equal(t, http.StatusNotFound, trashedRead.Code)
			assert.Equal(t, notFoundBody, trashedRead.Body.String())
			trashedCreate := playgroundRequest(t, 7, http.MethodPost, createPath, nil, controller.CreatePlaygroundSessionShare)
			assert.Equal(t, http.StatusNotFound, trashedCreate.Code)
			trashedRevoke := playgroundRequest(t, 7, http.MethodDelete, createPath, nil, controller.DeletePlaygroundSessionShare)
			assert.Equal(t, http.StatusOK, trashedRevoke.Code, trashedRevoke.Body.String())
			_, err := model.RestorePlaygroundSession(7, sessionID)
			require.NoError(t, err)
			assert.Equal(t, http.StatusNotFound, readShared(trashToken).Code)
			require.NoError(t, model.DeletePlaygroundSession(7, sessionID))
			require.NoError(t, model.PurgePlaygroundSession(7, sessionID))
			require.NoError(t, db.Model(&model.PlaygroundSessionShare{}).Where("session_id = ?", sessionID).Count(&shareCount).Error)
			assert.Zero(t, shareCount)
		})
	}
}
