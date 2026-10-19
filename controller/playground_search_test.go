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
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// The search endpoint owns the wallet lifecycle of one search: the hold is
// created before the provider call, a successful call settles exactly one unit
// and writes one consume log, and a failed call refunds the hold without a
// charge. The provider itself is replaced by a local HTTP server.
func TestPlaygroundWebSearchBilling(t *testing.T) {
	t.Run("success settles exactly one unit", func(t *testing.T) {
		db, user := setupPlaygroundSearchTest(t)
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, http.MethodGet, r.Method)
			assert.Equal(t, "/search", r.URL.Path)
			assert.Equal(t, "golang testing", r.URL.Query().Get("q"))
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"results": [
					{"title": "Alpha", "url": "https://a.example/1", "content": "first hit"},
					{"title": "Duplicate", "url": "https://a.example/1", "content": "duplicate url"},
					{"title": "Script", "url": "javascript:alert(1)", "content": "rejected scheme"},
					{"title": "Relative", "url": "/relative", "content": "rejected host"},
					{"title": "<strong>Bold</strong> &amp; snippet", "url": "https://b.example/2", "content": "second hit"},
					{"title": "C", "url": "https://c.example/3", "content": "c"},
					{"title": "D", "url": "https://d.example/4", "content": "d"},
					{"title": "E", "url": "https://e.example/5", "content": "e"}
				]
			}`))
		}))
		t.Cleanup(provider.Close)
		quota := usePlaygroundSearchPrice(t, provider.URL, 2/common.QuotaPerUnit)

		router := playgroundSearchTestRouter(user)
		response := postPlaygroundSearch(router, `{"query":"  golang testing  "}`)

		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var payload struct {
			Success bool `json:"success"`
			Data    struct {
				Query    string `json:"query"`
				Provider string `json:"provider"`
				Results  []struct {
					Title string `json:"title"`
					URL   string `json:"url"`
				} `json:"results"`
			} `json:"data"`
		}
		require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
		require.True(t, payload.Success)
		assert.Equal(t, "golang testing", payload.Data.Query)
		assert.Equal(t, playground_setting.PlaygroundWebSearchProviderSearXNG, payload.Data.Provider)
		require.Len(t, payload.Data.Results, 5)
		assert.Equal(t, "Alpha", payload.Data.Results[0].Title)
		assert.Equal(t, "Bold & snippet", payload.Data.Results[1].Title)
		assert.Equal(t, "https://b.example/2", payload.Data.Results[1].URL)

		assert.Equal(t, user.Quota-quota, currentUserQuota(t, db, user.Id))
		requestID := response.Header().Get(common.RequestIdKey)
		require.NotEmpty(t, requestID)
		var hold model.WalletHold
		require.NoError(t, db.Where("request_id = ?", requestID).First(&hold).Error)
		assert.Equal(t, model.WalletHoldStatusSettled, hold.Status)
		assert.EqualValues(t, quota, hold.Amount)
		assert.Equal(t, int64(-quota), walletLedgerSum(t, db, user.Id, model.WalletLedgerKindConsumeHourly))
		assert.Zero(t, walletLedgerSum(t, db, user.Id, model.WalletLedgerKindRefund))
		var consumeLog model.Log
		require.NoError(t, db.Where("request_id = ? AND model_name = ?", requestID, playgroundWebSearchModelName).First(&consumeLog).Error)
		assert.Equal(t, quota, consumeLog.Quota)
		assert.Equal(t, "default", consumeLog.Group)
	})

	t.Run("provider failure refunds without a charge", func(t *testing.T) {
		db, user := setupPlaygroundSearchTest(t)
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		t.Cleanup(provider.Close)
		quota := usePlaygroundSearchPrice(t, provider.URL, 2/common.QuotaPerUnit)

		router := playgroundSearchTestRouter(user)
		response := postPlaygroundSearch(router, `{"query":"will fail"}`)

		require.Equal(t, http.StatusBadGateway, response.Code, response.Body.String())
		var payload struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		require.NoError(t, common.Unmarshal(response.Body.Bytes(), &payload))
		assert.Equal(t, playgroundWebSearchProviderErrorCode, payload.Error.Code)

		assert.Equal(t, user.Quota, currentUserQuota(t, db, user.Id))
		requestID := response.Header().Get(common.RequestIdKey)
		require.NotEmpty(t, requestID)
		var hold model.WalletHold
		require.NoError(t, db.Where("request_id = ?", requestID).First(&hold).Error)
		assert.Equal(t, model.WalletHoldStatusRefunded, hold.Status)
		assert.Equal(t, int64(quota), walletLedgerSum(t, db, user.Id, model.WalletLedgerKindRefund))
		assert.Zero(t, walletLedgerSum(t, db, user.Id, model.WalletLedgerKindConsumeHourly))
		var logCount int64
		require.NoError(t, db.Model(&model.Log{}).Where("model_name = ?", playgroundWebSearchModelName).Count(&logCount).Error)
		assert.Zero(t, logCount)
	})

	t.Run("disabled configuration rejects before any provider call", func(t *testing.T) {
		db, user := setupPlaygroundSearchTest(t)
		called := false
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			called = true
			w.WriteHeader(http.StatusOK)
		}))
		t.Cleanup(provider.Close)
		previous := playground_setting.GetPlaygroundWebSearchSetting()
		playground_setting.GetPlaygroundSetting().WebSearch = &playground_setting.PlaygroundWebSearchSetting{
			Enabled:  false,
			Provider: playground_setting.PlaygroundWebSearchProviderSearXNG,
			BaseURL:  provider.URL,
		}
		t.Cleanup(func() {
			playground_setting.GetPlaygroundSetting().WebSearch = previous
		})

		router := playgroundSearchTestRouter(user)
		response := postPlaygroundSearch(router, `{"query":"disabled"}`)

		require.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
		assert.False(t, called)
		assert.Equal(t, user.Quota, currentUserQuota(t, db, user.Id))
	})
}

func setupPlaygroundSearchTest(t *testing.T) (*gorm.DB, *model.User) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })

	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	previousRedis, previousBatch := common.RedisEnabled, common.BatchUpdateEnabled
	previousLogConsume := common.LogConsumeEnabled
	model.DB, model.LOG_DB = db, db
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	common.RedisEnabled = false
	common.BatchUpdateEnabled = false
	common.LogConsumeEnabled = true
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.RedisEnabled = previousRedis
		common.BatchUpdateEnabled = previousBatch
		common.LogConsumeEnabled = previousLogConsume
	})
	for _, table := range []any{
		&model.User{}, &model.WalletHold{}, &model.WalletHoldGrant{}, &model.CreditGrant{},
		&model.WalletDebt{}, &model.WalletLedgerEntry{}, &model.Log{},
	} {
		require.NoError(t, db.AutoMigrate(table))
	}
	user := &model.User{
		Username: "playground-search-owner", Password: "unused",
		Role: common.RoleCommonUser, Status: common.UserStatusEnabled,
		Group: "default", Quota: 1_000_000, AffCode: "playground-search-owner-aff",
	}
	require.NoError(t, db.Create(user).Error)
	return db, user
}

// usePlaygroundSearchPrice points the global configuration at the test
// provider and returns the quota the configured price must reserve.
func usePlaygroundSearchPrice(t *testing.T, baseURL string, priceUSD float64) int {
	t.Helper()
	previous := playground_setting.GetPlaygroundWebSearchSetting()
	previousKey := playground_setting.GetPlaygroundSetting().WebSearchAPIKey
	playground_setting.GetPlaygroundSetting().WebSearch = &playground_setting.PlaygroundWebSearchSetting{
		Enabled:         true,
		Provider:        playground_setting.PlaygroundWebSearchProviderSearXNG,
		BaseURL:         baseURL,
		PriceUSDPerCall: priceUSD,
	}
	playground_setting.GetPlaygroundSetting().WebSearchAPIKey = ""
	t.Cleanup(func() {
		playground_setting.GetPlaygroundSetting().WebSearch = previous
		playground_setting.GetPlaygroundSetting().WebSearchAPIKey = previousKey
	})
	quota, clamp := playgroundWebSearchQuota(priceUSD)
	require.Nil(t, clamp)
	require.Greater(t, quota, 0)
	return quota
}

func playgroundSearchTestRouter(user *model.User) *gin.Engine {
	router := gin.New()
	router.Use(middleware.RequestId())
	router.POST("/api/playground/search", func(c *gin.Context) {
		c.Set("id", user.Id)
		c.Set("username", user.Username)
		c.Set("group", user.Group)
		c.Next()
	}, PlaygroundWebSearch)
	return router
}

func postPlaygroundSearch(router *gin.Engine, body string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/playground/search", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, request)
	return response
}

func currentUserQuota(t *testing.T, db *gorm.DB, userID int) int {
	t.Helper()
	var quota int
	require.NoError(t, db.Model(&model.User{}).Where("id = ?", userID).Select("quota").Scan(&quota).Error)
	return quota
}

func walletLedgerSum(t *testing.T, db *gorm.DB, userID int, kind string) int64 {
	t.Helper()
	var sum int64
	require.NoError(t, db.Model(&model.WalletLedgerEntry{}).
		Where("user_id = ? AND kind = ?", userID, kind).
		Select("COALESCE(SUM(amount), 0)").
		Scan(&sum).Error)
	return sum
}
