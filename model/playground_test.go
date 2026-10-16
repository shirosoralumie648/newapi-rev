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
		require.NoError(t, db.Migrator().DropTable(&model.PlaygroundArtifactVersion{}, &model.PlaygroundArtifact{}, &model.PlaygroundMessage{}, &model.PlaygroundSession{}))
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
		model.DB = previous
		common.SetDatabaseTypes(previousMain, previousLog)
	})
	require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}))
	var version string
	versionQuery := "SELECT version()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("Database version: %s", version)
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
	}
	if len(parts) > 6 {
		c.Params = append(c.Params, gin.Param{Key: "artifactId", Value: parts[6]})
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
			require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}))
			require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}))
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
	require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}))
	require.NoError(t, db.AutoMigrate(&model.PlaygroundSession{}, &model.PlaygroundMessage{}, &model.PlaygroundArtifact{}, &model.PlaygroundArtifactVersion{}))
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

func TestPlaygroundArtifactRealRouterAuthentication(t *testing.T) {
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
