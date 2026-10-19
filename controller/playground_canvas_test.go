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
package controller

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// The stored node kind is a shared contract between the canvas editor and the
// server. Every workflow kind the editor can create must survive document
// normalization, so a board that arranges a prompt into a model call, a
// generation task and its results is never rejected on save.
func TestPlaygroundCanvasDocumentAcceptsWorkflowNodeKinds(t *testing.T) {
	policy := playground_setting.GetPlaygroundQuotaPolicy("")
	for _, kind := range []string{
		"text", "note", "prompt", "message", "attachment", "image", "artifact",
		"model", "task", "task-result", "video", "audio", "group", "frame", "sticky",
	} {
		var request playgroundCanvasRequest
		require.NoError(t, common.UnmarshalJsonStr(`{
			"document": {
				"nodes": [
					{"id": "n1", "type": "`+kind+`", "position": {"x": 1, "y": 2}, "data": {"kind": "`+kind+`"}},
					{"id": "n2", "type": "task-result", "position": {"x": 3, "y": 4}}
				],
				"edges": [{"id": "e1", "source": "n1", "target": "n2"}]
			}
		}`, &request))
		require.NotNil(t, request.Document, kind)
		_, nodeCount, edgeCount, err := normalizePlaygroundCanvasDocument(request.Document, policy)
		require.NoError(t, err, "node kind %q must be accepted", kind)
		assert.Equal(t, 2, nodeCount)
		assert.Equal(t, 1, edgeCount)
	}
}

func TestPlaygroundCanvasAnnotationKindsRoundTrip(t *testing.T) {
	policy := playground_setting.GetPlaygroundQuotaPolicy("")
	var request playgroundCanvasRequest
	require.NoError(t, common.UnmarshalJsonStr(`{
		"document": {
			"nodes": [
				{"id": "f1", "type": "frame", "position": {"x": 20, "y": 30}, "width": 480, "height": 320, "data": {"kind": "frame", "text": "Scene"}},
				{"id": "s1", "type": "sticky", "position": {"x": 60, "y": 80}, "width": 224, "height": 160, "data": {"kind": "sticky", "text": "Draft"}},
				{"id": "g1", "type": "group", "position": {"x": 0, "y": 0}, "width": 200, "height": 120, "data": {"kind": "group", "collapsed": true}}
			],
			"edges": []
		}
	}`, &request))
	require.NotNil(t, request.Document)

	encoded, nodeCount, edgeCount, err := normalizePlaygroundCanvasDocument(request.Document, policy)
	require.NoError(t, err)
	assert.Equal(t, 3, nodeCount)
	assert.Zero(t, edgeCount)
	assert.Contains(t, encoded, `"type":"frame"`)
	assert.Contains(t, encoded, `"type":"sticky"`)
	assert.Contains(t, encoded, `"collapsed":true`)
	assert.Contains(t, encoded, `"width":480`)
}

func TestPlaygroundCanvasDocumentRejectsUnknownNodeKinds(t *testing.T) {
	policy := playground_setting.GetPlaygroundQuotaPolicy("")
	var request playgroundCanvasRequest
	require.NoError(t, common.UnmarshalJsonStr(`{
		"document": {
			"nodes": [{"id": "n1", "type": "script", "position": {"x": 0, "y": 0}}],
			"edges": []
		}
	}`, &request))
	require.NotNil(t, request.Document)

	_, _, _, err := normalizePlaygroundCanvasDocument(request.Document, policy)
	assert.ErrorIs(t, err, model.ErrPlaygroundCanvasInvalid)
}

// Workflow node data only carries display configuration and ID references, and
// it stays inside the same per-node byte budget as every other node kind.
func TestPlaygroundCanvasWorkflowNodeDataStaysBounded(t *testing.T) {
	policy := playground_setting.GetPlaygroundQuotaPolicy("")
	oversized := strings.Repeat("a", int(policy.CanvasNodeDataMaxBytes)+1)
	var request playgroundCanvasRequest
	require.NoError(t, common.UnmarshalJsonStr(`{
		"document": {
			"nodes": [{
				"id": "n1",
				"type": "model",
				"position": {"x": 0, "y": 0},
				"data": {"kind": "model", "text": "`+oversized+`"}
			}],
			"edges": []
		}
	}`, &request))
	require.NotNil(t, request.Document)

	_, _, _, err := normalizePlaygroundCanvasDocument(request.Document, policy)
	assert.ErrorIs(t, err, model.ErrPlaygroundCanvasLimit)
}

// The workspace workflow budget endpoints are the contract between the canvas
// run-budget dialog and the wallet: the estimate prices every step through the
// relay pricing helpers, a run budget reserves its cap from the wallet as a
// parent hold, and settling returns what the steps did not spend. The matrix
// runs on SQLite, MySQL and PostgreSQL.
func TestPlaygroundWorkflowBudgetEndpoints(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver gorm.Dialector
			dbType := common.DatabaseTypeSQLite
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(":memory:")
			case "mysql":
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN is not configured")
				}
				driver = mysql.Open(dsn)
				dbType = common.DatabaseTypeMySQL
			case "postgres":
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN is not configured")
				}
				driver = postgres.Open(dsn)
				dbType = common.DatabaseTypePostgreSQL
			}
			db, err := gorm.Open(driver, &gorm.Config{})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
			var version string
			query := "SELECT version()"
			if dialect == "sqlite" {
				query = "SELECT sqlite_version()"
			}
			require.NoError(t, db.Raw(query).Scan(&version).Error)
			t.Logf("database version: %s", version)

			previousDB, previousLogDB := model.DB, model.LOG_DB
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousRedis := common.RedisEnabled
			previousBatchUpdate := common.BatchUpdateEnabled
			previousSessionSecret := common.SessionSecret
			model.DB, model.LOG_DB = db, db
			common.SetDatabaseTypes(dbType, dbType)
			common.RedisEnabled = false
			common.BatchUpdateEnabled = false
			common.SessionSecret = "canvas-workflow-budget-test-secret"
			t.Cleanup(func() {
				model.DB, model.LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.RedisEnabled = previousRedis
				common.BatchUpdateEnabled = previousBatchUpdate
				common.SessionSecret = previousSessionSecret
			})
			for _, table := range []any{
				&model.User{}, &model.UserSession{}, &model.Option{}, &model.WalletHold{},
				&model.WalletHoldGrant{}, &model.CreditGrant{}, &model.WalletDebt{},
				&model.WalletLedgerEntry{},
			} {
				require.False(t, db.Migrator().HasTable(table), "use an empty test database")
				require.NoError(t, db.AutoMigrate(table))
				t.Cleanup(func() { require.NoError(t, db.Migrator().DropTable(table)) })
			}
			require.NoError(t, model.EnsureLegacyAccessTokenRetireAt(time.Now().Unix()))
			// The estimate prices through the relay helpers, whose built-in
			// ratio maps main.go initializes for real runs.
			ratio_setting.InitRatioSettings()

			// The workflow budget endpoints belong to the session-only
			// Playground workspace, so the two accounts authenticate with real
			// dashboard login sessions instead of opaque access tokens.
			owner := model.User{
				Username: "canvas-budget-owner", Password: "unused",
				Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
				Group: "default", Quota: 1_000_000, AffCode: "canvas-budget-owner-aff",
				AuthVersion: 1,
			}
			require.NoError(t, db.Create(&owner).Error)
			other := model.User{
				Username: "canvas-budget-other", Password: "unused",
				Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
				Group: "default", Quota: 1_000_000, AffCode: "canvas-budget-other-aff",
				AuthVersion: 1,
			}
			require.NoError(t, db.Create(&other).Error)
			ownerBundle, err := service.CreateLoginSession(owner.Id, "password", "127.0.0.1", "canvas-budget-owner")
			require.NoError(t, err)
			ownerToken := ownerBundle.AccessToken
			otherBundle, err := service.CreateLoginSession(other.Id, "password", "127.0.0.1", "canvas-budget-other")
			require.NoError(t, err)
			otherToken := otherBundle.AccessToken

			router := gin.New()
			router.Use(middleware.RequestId())
			workflows := router.Group("/api/playground/workflows", middleware.UserAuth())
			workflows.POST("/estimate", PlaygroundWorkflowEstimate)
			workflows.POST("/runs", PlaygroundWorkflowRunCreate)
			workflows.POST("/runs/:runId/settle", PlaygroundWorkflowRunSettle)

			do := func(token, path, body string) *httptest.ResponseRecorder {
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
				request.Header.Set("Authorization", "Bearer "+token)
				request.Header.Set("Content-Type", "application/json")
				router.ServeHTTP(response, request)
				return response
			}
			type budgetResult struct {
				Success bool `json:"success"`
				Data    struct {
					Steps []struct {
						NodeId      string `json:"node_id"`
						Quota       int    `json:"quota"`
						Available   bool   `json:"available"`
						Approximate bool   `json:"approximate"`
					} `json:"steps"`
					TotalQuota int    `json:"total_quota"`
					Available  bool   `json:"available"`
					RunId      string `json:"run_id"`
					Cap        int64  `json:"cap"`
					Spent      int64  `json:"spent"`
					Remaining  int64  `json:"remaining"`
					Status     string `json:"status"`
				} `json:"data"`
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
					Type    string `json:"type"`
				} `json:"error"`
			}
			var result budgetResult
			decode := func(response *httptest.ResponseRecorder) {
				t.Helper()
				result = budgetResult{}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
			}

			// A malformed estimate and an over-long plan are refused before
			// anything is priced.
			response := do(ownerToken, "/api/playground/workflows/estimate", "{")
			assert.Equal(t, http.StatusBadRequest, response.Code)
			decode(response)
			assert.False(t, result.Success)
			assert.Equal(t, PlaygroundWorkflowBudgetUnavailableCode, result.Error.Code)

			tooMany, err := common.Marshal(map[string]any{
				"steps": make([]map[string]any, maxPlaygroundWorkflowEstimateSteps+1),
			})
			require.NoError(t, err)
			response = do(ownerToken, "/api/playground/workflows/estimate", string(tooMany))
			assert.Equal(t, http.StatusBadRequest, response.Code)
			decode(response)
			assert.Equal(t, PlaygroundWorkflowBudgetUnavailableCode, result.Error.Code)

			// A group the account may not use is refused instead of priced.
			response = do(ownerToken, "/api/playground/workflows/estimate",
				`{"group":"canvas-budget-hidden","steps":[{"node_id":"m1","kind":"chat","model":"gpt-4o","tokens":100}]}`)
			assert.Equal(t, http.StatusForbidden, response.Code)
			decode(response)
			assert.Equal(t, PlaygroundWorkflowBudgetUnavailableCode, result.Error.Code)

			// The estimate prices prompt tokens with the model ratio of the
			// requested group: gpt-4o holds ratio 1.25, so 100 tokens reserve
			// 125 quota.
			response = do(ownerToken, "/api/playground/workflows/estimate",
				`{"group":"default","steps":[{"node_id":"m1","kind":"chat","model":"gpt-4o","tokens":100}]}`)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			decode(response)
			require.True(t, result.Success)
			assert.True(t, result.Data.Available)
			assert.Equal(t, 125, result.Data.TotalQuota)
			require.Len(t, result.Data.Steps, 1)
			assert.Equal(t, "m1", result.Data.Steps[0].NodeId)
			assert.Equal(t, 125, result.Data.Steps[0].Quota)
			assert.True(t, result.Data.Steps[0].Available)

			// A kind without a billing path is reported as unavailable without
			// failing the whole estimate.
			response = do(ownerToken, "/api/playground/workflows/estimate",
				`{"group":"default","steps":[{"node_id":"x1","kind":"embedding","model":"gpt-4o","tokens":10}]}`)
			require.Equal(t, http.StatusOK, response.Code)
			decode(response)
			require.True(t, result.Success)
			assert.False(t, result.Data.Available)
			assert.Equal(t, 0, result.Data.TotalQuota)

			// A cap must be a positive quota amount.
			response = do(ownerToken, "/api/playground/workflows/runs", `{"cap":0}`)
			assert.Equal(t, http.StatusBadRequest, response.Code)
			decode(response)
			assert.Equal(t, PlaygroundWorkflowBudgetUnavailableCode, result.Error.Code)

			// A cap the wallet cannot cover is refused without reserving.
			response = do(ownerToken, "/api/playground/workflows/runs", `{"cap":2000000}`)
			assert.Equal(t, http.StatusForbidden, response.Code)
			decode(response)
			assert.Equal(t, PlaygroundWorkflowBudgetInsufficientCode, result.Error.Code)

			// A covered cap reserves from the wallet and opens one run budget.
			response = do(ownerToken, "/api/playground/workflows/runs", `{"cap":500000}`)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			decode(response)
			require.True(t, result.Success)
			runId := result.Data.RunId
			require.True(t, strings.HasPrefix(runId, playgroundWorkflowRunPrefix))
			assert.EqualValues(t, 500000, result.Data.Cap)
			assert.EqualValues(t, 0, result.Data.Spent)
			assert.EqualValues(t, 500000, result.Data.Remaining)
			assert.Equal(t, model.WalletHoldStatusActive, result.Data.Status)
			var wallet model.User
			require.NoError(t, db.First(&wallet, owner.Id).Error)
			assert.Equal(t, 500000, wallet.Quota)

			// Another account cannot see or settle the run budget.
			response = do(otherToken, "/api/playground/workflows/runs/"+runId+"/settle", "{}")
			assert.Equal(t, http.StatusNotFound, response.Code)
			decode(response)
			assert.Equal(t, PlaygroundWorkflowRunNotFoundCode, result.Error.Code)
			response = do(otherToken, "/api/playground/workflows/runs/pgw_missing/settle", "{}")
			assert.Equal(t, http.StatusNotFound, response.Code)
			decode(response)
			assert.Equal(t, PlaygroundWorkflowRunNotFoundCode, result.Error.Code)

			// Settling with no step allocations returns the whole cap, and a
			// replay reports the same summary without moving quota again.
			response = do(ownerToken, "/api/playground/workflows/runs/"+runId+"/settle", "{}")
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			decode(response)
			require.True(t, result.Success)
			assert.Equal(t, runId, result.Data.RunId)
			assert.EqualValues(t, 500000, result.Data.Cap)
			assert.EqualValues(t, 0, result.Data.Spent)
			assert.EqualValues(t, 500000, result.Data.Remaining)
			assert.Equal(t, model.WalletHoldStatusSettled, result.Data.Status)
			require.NoError(t, db.First(&wallet, owner.Id).Error)
			assert.Equal(t, 1_000_000, wallet.Quota)

			response = do(ownerToken, "/api/playground/workflows/runs/"+runId+"/settle", "{}")
			require.Equal(t, http.StatusOK, response.Code)
			decode(response)
			require.True(t, result.Success)
			assert.EqualValues(t, 500000, result.Data.Cap)
			assert.EqualValues(t, 0, result.Data.Spent)
			assert.EqualValues(t, 500000, result.Data.Remaining)
			require.NoError(t, db.First(&wallet, owner.Id).Error)
			assert.Equal(t, 1_000_000, wallet.Quota)
		})
	}
}
