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
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
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
	"github.com/QuantumNous/new-api/setting/playground_setting"
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

func playgroundTestDB(t *testing.T, dialect string) *gorm.DB {
	t.Helper()
	gin.SetMode(gin.TestMode)
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
		require.NoError(t, db.Migrator().DropTable(&model.PlaygroundCanvasAsset{}, &model.PlaygroundCanvasProject{}, &model.PlaygroundAttachment{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundArtifact{}, &model.PlaygroundMessage{}, &model.PlaygroundSession{}, &model.Task{}, &model.User{}))
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
		model.DB = previous
		common.SetDatabaseTypes(previousMain, previousLog)
	})
	require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundCanvasProject{}, &model.PlaygroundCanvasAsset{}, &model.Task{}, &model.User{}))
	var version string
	versionQuery := "SELECT version()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("Database version: %s", version)
	// Attachment uploads lock the owner row for the per-account byte budget.
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
	}
	if len(parts) > 6 {
		c.Params = append(c.Params, gin.Param{Key: "artifactId", Value: parts[6]})
		c.Params = append(c.Params, gin.Param{Key: "attachmentId", Value: parts[6]})
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
			require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundCanvasProject{}, &model.PlaygroundCanvasAsset{}, &model.User{}))
			require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundCanvasProject{}, &model.PlaygroundCanvasAsset{}, &model.User{}))
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
	_, err := model.ReplacePlaygroundMessages(9, session["id"].(string), 0, []model.PlaygroundMessage{{ClientKey: "kept", Payload: `{"key":"kept","from":"user","versions":[{"id":"v","content":"Keep this history"}]}`}}, nil)
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
	require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundCanvasProject{}, &model.User{}))
	require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}, &model.PlaygroundAttachment{}, &model.PlaygroundCanvasProject{}, &model.User{}))
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
			// Upgrade a populated Phase 2 schema, then migrate populated artifacts
			// twice. This is not a substitute for the latest released-schema matrix.
			require.NoError(t, db.Migrator().DropTable(&model.PlaygroundArtifactVersion{}, &model.PlaygroundArtifact{}))
			sessionID, input := playgroundArtifactSourceFixture(t, 7, "artifact-upgrade")
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

			// Deleting the conversation cascades into its attachments.
			require.NoError(t, model.DeletePlaygroundSession(7, id))
			var count int64
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("session_id = ?", id).Count(&count).Error)
			assert.Zero(t, count)
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

	// A referenced attachment cannot be deleted; an unrelated one still can.
	inUse := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id+"/attachments/"+firstID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusConflict, inUse.Code, inUse.Body.String())
	unused := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id+"/attachments/"+secondID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusOK, unused.Code, unused.Body.String())
	missing := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id+"/attachments/"+secondID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusNotFound, missing.Code)

	// Dropping the reference releases the attachment for deletion.
	response = playgroundRequest(t, 7, http.MethodPut, path, map[string]any{"revision": 1, "messages": []any{}}, controller.ReplacePlaygroundMessages)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	released := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+id+"/attachments/"+firstID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusOK, released.Code, released.Body.String())

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
	response := playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+id+"/messages", map[string]any{
		"revision": 0, "messages": []any{map[string]any{"client_key": "u1", "payload": map[string]any{
			"key": "u1", "from": "user", "versions": []any{map[string]any{"id": "v1", "content": "keep", "attachments": []any{map[string]any{"id": referencedID}}}},
		}}},
	}, controller.ReplacePlaygroundMessages)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	// Age both rows: only the unreferenced one may be collected.
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

	// Canvas routes share the same session-only authentication contract.
	canvasBase := "/api/playground/canvases"
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, canvasBase}, {http.MethodPost, canvasBase},
		{http.MethodGet, canvasBase + "/missing"}, {http.MethodPatch, canvasBase + "/missing"},
		{http.MethodDelete, canvasBase + "/missing"},
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
							map[string]any{"id": "a2", "content": "Regenerated answer"},
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
			_, err = model.ReplacePlaygroundMessages(7, id, 1, tooMany, nil)
			assert.Error(t, err)
			messages, revision, err = model.ListPlaygroundMessages(7, id)
			require.NoError(t, err)
			assert.EqualValues(t, 1, revision)
			require.Len(t, messages, 2)
		})
	}
}

// The Playground resource quota policy resolves an effective budget from the
// user group: built-in defaults, then the global configuration, then the group
// override. Capacity is enforced server-side and reported as a stable error.
func TestPlaygroundQuotaPolicyResolutionAndSessionLimit(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.SessionMaxCount = 2
	})
	usePlaygroundGroupQuota(t, "default", playground_setting.PlaygroundQuotaPolicy{SessionMaxCount: 1})

	policy, err := model.PlaygroundQuotaPolicyForUser(7)
	require.NoError(t, err)
	assert.Equal(t, 1, policy.SessionMaxCount, "the group override wins over the global default")
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

// The unified usage view reports the owner's stored conversations, attachments,
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
	})
	usePlaygroundGroupQuota(t, "default", playground_setting.PlaygroundQuotaPolicy{CanvasUserMaxProjects: 9})

	sessionID, input := playgroundArtifactSourceFixture(t, 7, "usage-owner")
	artifactResult(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+sessionID+"/artifacts", input, controller.CreatePlaygroundArtifact))
	playgroundUploadAttachment(t, 7, sessionID, "usage-file", "image/png", playgroundPNGFixture(64))
	createCanvasProject(t, 7, "usage-canvas")

	otherSession, otherInput := playgroundArtifactSourceFixture(t, 8, "usage-other")
	artifactResult(t, playgroundRequest(t, 8, http.MethodPost, "/api/playground/sessions/"+otherSession+"/artifacts", otherInput, controller.CreatePlaygroundArtifact))
	playgroundUploadAttachment(t, 8, otherSession, "usage-file-other", "image/png", playgroundPNGFixture(32))
	createCanvasProject(t, 8, "usage-canvas-other")

	usage, err := model.PlaygroundUsageForUser(7)
	require.NoError(t, err)

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
