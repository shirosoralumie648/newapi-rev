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
	"encoding/hex"
	"fmt"
	"io"
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
		require.NoError(t, db.Migrator().DropTable(&model.PlaygroundTaskArtifactPin{}, &model.PlaygroundTaskArtifactSync{}, &model.PlaygroundTaskArtifact{}, &model.PlaygroundCanvasAsset{}, &model.PlaygroundCanvasProject{}, &model.PlaygroundUserUsage{}, &model.PlaygroundAttachment{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundArtifact{}, &model.PlaygroundPreset{}, &model.PlaygroundMessage{}, &model.PlaygroundSession{}, &model.Task{}, &model.WalletDebt{}, &model.WalletLedgerEntry{}, &model.User{}))
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
		model.DB = previous
		common.SetDatabaseTypes(previousMain, previousLog)
	})
	require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundPreset{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundUserUsage{}, &model.PlaygroundCanvasProject{}, &model.PlaygroundCanvasAsset{}, &model.PlaygroundTaskArtifact{}, &model.PlaygroundTaskArtifactPin{}, &model.PlaygroundTaskArtifactSync{}, &model.Task{}, &model.WalletDebt{}, &model.WalletLedgerEntry{}, &model.User{}))
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
		if parts[3] == "canvases" {
			c.Params = append(c.Params, gin.Param{Key: "canvasId", Value: parts[4]})
		}
		if parts[3] == "presets" {
			c.Params = append(c.Params, gin.Param{Key: "presetId", Value: parts[4]})
		}
		if parts[3] == "tasks" {
			c.Params = append(c.Params, gin.Param{Key: "taskId", Value: parts[4]})
		}
	}
	if len(parts) > 6 {
		c.Params = append(c.Params, gin.Param{Key: "artifactId", Value: parts[6]})
		c.Params = append(c.Params, gin.Param{Key: "attachmentId", Value: parts[6]})
		c.Params = append(c.Params, gin.Param{Key: "artifactKey", Value: parts[6]})
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
			// Deleting a session clears tombstones; deleting another clears live bodies.
			for _, id := range []string{sessionID, foreignSession} {
				response := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id, nil, controller.DeletePlaygroundSession)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
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
		{"kind invalid", func(v *model.CreatePlaygroundArtifactInput) { v.Kind = "html" }, 400},
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

			// Deleting the conversation cascades into its attachments and
			// their stored objects.
			require.NoError(t, model.DeletePlaygroundSession(7, id))
			var count int64
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
	reject("unsupported media type", map[string]any{"client_key": "a", "media_type": "text/plain", "data": encoded}, http.StatusBadRequest)
	reject("mismatched media type", map[string]any{"client_key": "b", "media_type": "image/webp", "data": encoded}, http.StatusBadRequest)
	reject("invalid base64", map[string]any{"client_key": "c", "media_type": "image/png", "data": "not-base64!!"}, http.StatusBadRequest)
	reject("empty client key", map[string]any{"client_key": " ", "media_type": "image/png", "data": encoded}, http.StatusBadRequest)
	reject("oversized attachment", map[string]any{"client_key": "d", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(playgroundPNGFixture(4097))}, http.StatusUnprocessableEntity)

	// The per-account budget counts every stored byte, including replays of one file.
	playgroundUploadAttachment(t, 7, id, "budget-a", "image/png", playgroundPNGFixture(4096))
	playgroundUploadAttachment(t, 7, id, "budget-b", "image/png", playgroundPNGFixture(4096))
	reject("per-user byte budget", map[string]any{"client_key": "budget-c", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(playgroundPNGFixture(64))}, http.StatusUnprocessableEntity)
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
	sessionID, input := playgroundArtifactSourceFixture(t, user.Id, "authenticated")
	attachmentBase := "/api/playground/sessions/" + sessionID + "/attachments"
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/playground/usage"},
		{http.MethodGet, "/api/playground/message-costs?request_ids=route-cost"},
		{http.MethodGet, "/api/playground/assets?kind=attachment"},
		{http.MethodPost, "/api/playground/tasks/missing/cancel"},
		{http.MethodGet, "/api/playground/presets"},
		{http.MethodPost, "/api/playground/presets"},
		{http.MethodGet, "/api/playground/presets/missing"},
		{http.MethodPatch, "/api/playground/presets/missing"},
		{http.MethodDelete, "/api/playground/presets/missing"},
		{http.MethodGet, attachmentBase}, {http.MethodPost, attachmentBase},
		{http.MethodGet, attachmentBase + "/missing"}, {http.MethodGet, attachmentBase + "/missing/content"},
		{http.MethodDelete, attachmentBase + "/missing"},
	} {
		response := playgroundAuthenticatedRequest(t, engine, "", route.method, route.path, input)
		assert.Equal(t, 401, response.Code, response.Body.String())
		assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
		response = playgroundAuthenticatedRequest(t, engine, patRaw, route.method, route.path, input)
		assert.Equal(t, 403, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), "AUTH_SESSION_REQUIRED")
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

	// Canvas routes share the same session-only authentication contract.
	canvasBase := "/api/playground/canvases"
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, canvasBase}, {http.MethodPost, canvasBase},
		{http.MethodGet, canvasBase + "/missing"}, {http.MethodPatch, canvasBase + "/missing"},
		{http.MethodDelete, canvasBase + "/missing"},
		{http.MethodPost, canvasBase + "/missing/attachments"},
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
								"requestId": "req-branch-2",
								"usage":     map[string]any{"promptTokens": 12, "completionTokens": 34, "totalTokens": 46}},
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

	// Deleting a conversation frees its slot, so the next create succeeds.
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+first["id"].(string), nil, controller.DeletePlaygroundSession).Code)
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
		policy.TaskMaxConcurrency = 4
		policy.TaskUserResultMaxBytes = 1 << 20
		policy.ObjectUserMaxBytes = 1 << 21
	})
	usePlaygroundGroupQuota(t, "default", playground_setting.PlaygroundQuotaPolicy{CanvasUserMaxProjects: 9, ObjectUserMaxBytes: 1 << 22})

	sessionID, input := playgroundArtifactSourceFixture(t, 7, "usage-owner")
	artifactResult(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+sessionID+"/artifacts", input, controller.CreatePlaygroundArtifact))
	playgroundUploadAttachment(t, 7, sessionID, "usage-file", "image/png", playgroundPNGFixture(64))
	createCanvasProject(t, 7, "usage-canvas")

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

			require.NoError(t, model.DeletePlaygroundCanvasProject(7, storedCanvas.ID))
			counters = playgroundUsageCounters(t, db, 7)
			assert.Zero(t, counters.CanvasCount)
			assert.Zero(t, counters.CanvasBytes)

			require.NoError(t, model.DeletePlaygroundAttachment(7, sessionID, attachmentID))
			counters = playgroundUsageCounters(t, db, 7)
			assert.Zero(t, counters.AttachmentCount)
			assert.Zero(t, counters.AttachmentBytes)
			assert.Zero(t, counters.ObjectBytes)

			// The conversation cascade releases the messages it still holds.
			require.NoError(t, model.DeletePlaygroundSession(7, sessionID))
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
		usage.ArtifactCount, usage.ArtifactBytes,
		usage.CanvasCount, usage.CanvasBytes,
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
			}, controller.CreatePlaygroundPreset)
			require.Equal(t, http.StatusOK, created.Code, created.Body.String())
			var envelope struct {
				Success bool
				Data    struct {
					ID               string          `json:"id"`
					Name             string          `json:"name"`
					Avatar           string          `json:"avatar"`
					Config           map[string]any  `json:"config"`
					ParameterEnabled map[string]bool `json:"parameter_enabled"`
					SystemPrompt     string          `json:"system_prompt"`
					CreatedAt        int64           `json:"created_at"`
					UpdatedAt        int64           `json:"updated_at"`
				}
			}
			require.NoError(t, common.Unmarshal(created.Body.Bytes(), &envelope))
			require.True(t, envelope.Success, created.Body.String())
			id := envelope.Data.ID
			require.True(t, strings.HasPrefix(id, "pgp_"), id)
			assert.Equal(t, "Code reviewer", envelope.Data.Name)
			assert.Equal(t, "🧑💻", envelope.Data.Avatar)
			assert.Equal(t, "Review code carefully.", envelope.Data.SystemPrompt)
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
			}, controller.UpdatePlaygroundPreset)
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			var updatedEnvelope struct {
				Data struct {
					Name         string         `json:"name"`
					Avatar       string         `json:"avatar"`
					SystemPrompt string         `json:"system_prompt"`
					Config       map[string]any `json:"config"`
				}
			}
			require.NoError(t, common.Unmarshal(updated.Body.Bytes(), &updatedEnvelope))
			assert.Equal(t, "Reviewer", updatedEnvelope.Data.Name)
			assert.Equal(t, "https://example.com/avatar.png", updatedEnvelope.Data.Avatar)
			assert.Equal(t, "Review twice.", updatedEnvelope.Data.SystemPrompt)
			assert.EqualValues(t, 0.2, updatedEnvelope.Data.Config["temperature"], "unsent fields keep their stored value")

			for name, body := range map[string]map[string]any{
				"empty name":       {"name": "   "},
				"overlong name":    {"name": strings.Repeat("n", 101)},
				"non-http avatar":  {"name": "A", "avatar": "ftp://example.com/a.png"},
				"long text avatar": {"name": "A", "avatar": strings.Repeat("x", 65)},
				"invalid config":   {"name": "A", "config": map[string]any{"temperature": "hot"}},
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
				"system_prompt": "Answer in French.",
			}, controller.CreatePlaygroundSession)
			require.Equal(t, http.StatusOK, created.Code, created.Body.String())
			var envelope struct {
				Success bool
				Data    struct {
					ID           string `json:"id"`
					SystemPrompt string `json:"system_prompt"`
				}
			}
			require.NoError(t, common.Unmarshal(created.Body.Bytes(), &envelope))
			require.True(t, envelope.Success, created.Body.String())
			id := envelope.Data.ID
			assert.Equal(t, "Answer in French.", envelope.Data.SystemPrompt)

			read := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+id, nil, controller.GetPlaygroundSession)
			require.Equal(t, http.StatusOK, read.Code, read.Body.String())
			assert.Contains(t, read.Body.String(), `"system_prompt":"Answer in French."`)

			// An update that does not send the prompt keeps it; an explicit
			// value replaces it.
			renamed := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{"revision": 0, "title": "Renamed"}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, renamed.Code, renamed.Body.String())
			assert.Contains(t, renamed.Body.String(), `"system_prompt":"Answer in French."`)
			replaced := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/sessions/"+id, map[string]any{"revision": 1, "system_prompt": "Answer in English."}, controller.UpdatePlaygroundSession)
			require.Equal(t, http.StatusOK, replaced.Code, replaced.Body.String())
			assert.Contains(t, replaced.Body.String(), `"system_prompt":"Answer in English."`)

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

			// A legacy row without the column reads back as an empty prompt.
			require.NoError(t, db.Model(&model.PlaygroundSession{}).Where("id = ? AND user_id = ?", id, 7).Update("system_prompt", gorm.Expr("NULL")).Error)
			reloaded, err := model.GetPlaygroundSession(7, id)
			require.NoError(t, err)
			assert.Empty(t, reloaded.SystemPrompt)
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
