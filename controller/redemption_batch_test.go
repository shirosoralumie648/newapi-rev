package controller

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestDeleteRedemptionBatch(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver, logDriver gorm.Dialector
			dbType := common.DatabaseTypeSQLite
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(":memory:")
				logDriver = sqlite.Open(":memory:")
			case "mysql":
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN is not configured")
				}
				driver = mysql.Open(dsn)
				logDSN := os.Getenv("TEST_MYSQL_LOG_DSN")
				if logDSN == "" {
					logDSN = dsn
				}
				logDriver = mysql.Open(logDSN)
				dbType = common.DatabaseTypeMySQL
			case "postgres":
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN is not configured")
				}
				driver = postgres.Open(dsn)
				logDSN := os.Getenv("TEST_POSTGRES_LOG_DSN")
				if logDSN == "" {
					logDSN = dsn
				}
				logDriver = postgres.Open(logDSN)
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

			logDB, err := gorm.Open(logDriver, &gorm.Config{})
			require.NoError(t, err)
			logSQL, err := logDB.DB()
			require.NoError(t, err)
			logSQL.SetMaxOpenConns(1)
			t.Cleanup(func() { require.NoError(t, logSQL.Close()) })
			previousDB, previousLogDB := model.DB, model.LOG_DB
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousRedis := common.RedisEnabled
			model.DB, model.LOG_DB = db, logDB
			common.SetDatabaseTypes(dbType, dbType)
			common.RedisEnabled = false
			t.Cleanup(func() {
				model.DB, model.LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.RedisEnabled = previousRedis
			})
			for _, table := range []any{&model.User{}, &model.Redemption{}} {
				require.False(t, db.Migrator().HasTable(table), "use an empty test database")
				require.NoError(t, db.AutoMigrate(table))
				t.Cleanup(func() { require.NoError(t, db.Migrator().DropTable(table)) })
			}
			require.False(t, logDB.Migrator().HasTable(&model.AuditLog{}), "use an empty test log database")
			require.NoError(t, logDB.AutoMigrate(&model.AuditLog{}))
			t.Cleanup(func() { require.NoError(t, logDB.Migrator().DropTable(&model.AuditLog{})) })
			token := "redemption-audit-test-token"
			admin := model.User{Username: "redemption-audit-admin", Password: "unused", Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Group: "default", AccessToken: &token}
			require.NoError(t, db.Create(&admin).Error)
			codes := make([]model.Redemption, 16)
			for index := range codes {
				codes[index] = model.Redemption{Name: "selected", Key: fmt.Sprintf("%032d", index+1), Quota: 100, Status: common.RedemptionCodeStatusEnabled}
			}
			codes[1].Status = common.RedemptionCodeStatusUsed
			codes[15].Name = "unselected"
			codes[15].Status = common.RedemptionCodeStatusDisabled
			require.NoError(t, model.DB.Create(&codes).Error)
			router := gin.New()
			router.Use(middleware.RequestId())
			router.POST("/api/redemption/batch", middleware.AdminAuth(), DeleteRedemptionBatch)

			overLimit := make([]int, 1001)
			for index := range overLimit {
				overLimit[index] = codes[0].Id
			}
			oversized, err := common.Marshal(map[string]any{"ids": overLimit})
			require.NoError(t, err)
			for _, body := range []string{"{}", `{"ids":[]}`, `{"ids":null}`, `{"ids":[0]}`, `{"ids":[1,-1]}`, `{"ids":["1"]}`, "{", string(oversized)} {
				t.Run("invalid_"+body[:min(len(body), 30)], func(t *testing.T) {
					response := httptest.NewRecorder()
					request := httptest.NewRequest(http.MethodPost, "/api/redemption/batch", bytes.NewBufferString(body))
					request.Header.Set("Authorization", "Bearer "+token)
					router.ServeHTTP(response, request)
					var result struct {
						Success bool `json:"success"`
					}
					require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
					assert.False(t, result.Success)
					var count int64
					require.NoError(t, model.DB.Model(&model.Redemption{}).Count(&count).Error)
					assert.EqualValues(t, 16, count)
					var events []model.AuditLog
					require.NoError(t, logDB.Where("request_id = ? AND category = ?", response.Header().Get(common.RequestIdKey), model.AuditCategoryOperation).Find(&events).Error)
					require.Len(t, events, 1)
					assert.False(t, events[0].Success)
					assert.Equal(t, "redemption.delete_batch", events[0].Action)
				})
			}
			_, err = model.BatchDeleteRedemptions(nil)
			require.Error(t, err)
			requestedIDs := make([]int, 0, 17)
			for _, code := range codes[:15] {
				requestedIDs = append(requestedIDs, code.Id)
			}
			requestedIDs = append(requestedIDs, codes[0].Id, 999999)
			payload, err := common.Marshal(map[string]any{"ids": requestedIDs})
			require.NoError(t, err)
			for _, expectedCount := range []int64{15, 0} {
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPost, "/api/redemption/batch", bytes.NewReader(payload))
				request.Header.Set("Authorization", "Bearer "+token)
				router.ServeHTTP(response, request)
				assert.Equal(t, http.StatusOK, response.Code)
				var result struct {
					Success bool  `json:"success"`
					Data    int64 `json:"data"`
				}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
				assert.True(t, result.Success)
				assert.Equal(t, expectedCount, result.Data)
				var events []model.AuditLog
				require.NoError(t, logDB.Where("request_id = ? AND category = ?", response.Header().Get(common.RequestIdKey), model.AuditCategoryOperation).Find(&events).Error)
				require.Len(t, events, 1, "one operation event, without a duplicate single-delete fallback")
				event := events[0]
				assert.Equal(t, "redemption.delete_batch", event.Action)
				assert.Equal(t, fmt.Sprintf("Batch deleted %d redemption codes", expectedCount), event.Content)
				assert.True(t, event.Success)
				assert.Equal(t, admin.Id, event.UserId)
				assert.Equal(t, "/api/redemption/batch", event.Route)
				require.NotNil(t, event.Other.Op)
				encoded, err := common.Marshal(event.Other.Op.Params)
				require.NoError(t, err)
				var params struct {
					Count int64 `json:"count"`
					Total int   `json:"total"`
					IDs   []int `json:"requested_redemption_ids"`
				}
				require.NoError(t, common.Unmarshal(encoded, &params))
				assert.Equal(t, expectedCount, params.Count)
				assert.Equal(t, len(requestedIDs), params.Total)
				assert.Equal(t, requestedIDs, params.IDs)
				encoded, err = common.Marshal(event)
				require.NoError(t, err)
				assert.NotContains(t, string(encoded), token)
				for _, code := range codes {
					assert.NotContains(t, string(encoded), code.Key)
				}
			}
			var active []model.Redemption
			require.NoError(t, model.DB.Find(&active).Error)
			require.Len(t, active, 1)
			assert.Equal(t, codes[15], active[0])
			var all []model.Redemption
			require.NoError(t, model.DB.Unscoped().Order("id").Find(&all).Error)
			require.Len(t, all, 16)
			for _, code := range all[:15] {
				assert.True(t, code.DeletedAt.Valid)
			}
			assert.False(t, all[15].DeletedAt.Valid)
		})
	}
}

// Creating redemption codes validates the type, plan, duration override and
// batch size before anything is stored, and every generated subscription code
// carries the granted plan.
func TestAddRedemptionSubscriptionCodes(t *testing.T) {
	confirmPaymentComplianceForTest(t)
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver, logDriver gorm.Dialector
			dbType := common.DatabaseTypeSQLite
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(":memory:")
				logDriver = sqlite.Open(":memory:")
			case "mysql":
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN is not configured")
				}
				driver = mysql.Open(dsn)
				logDriver = mysql.Open(dsn)
				dbType = common.DatabaseTypeMySQL
			case "postgres":
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN is not configured")
				}
				driver = postgres.Open(dsn)
				logDriver = postgres.Open(dsn)
				dbType = common.DatabaseTypePostgreSQL
			}
			db, err := gorm.Open(driver, &gorm.Config{})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(1)
			t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
			logDB, err := gorm.Open(logDriver, &gorm.Config{})
			require.NoError(t, err)
			logSQL, err := logDB.DB()
			require.NoError(t, err)
			logSQL.SetMaxOpenConns(1)
			t.Cleanup(func() { require.NoError(t, logSQL.Close()) })
			previousDB, previousLogDB := model.DB, model.LOG_DB
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			previousRedis := common.RedisEnabled
			model.DB, model.LOG_DB = db, logDB
			common.SetDatabaseTypes(dbType, dbType)
			common.RedisEnabled = false
			t.Cleanup(func() {
				model.DB, model.LOG_DB = previousDB, previousLogDB
				common.SetDatabaseTypes(previousMain, previousLog)
				common.RedisEnabled = previousRedis
			})
			for _, table := range []any{&model.User{}, &model.Redemption{}, &model.SubscriptionPlan{}, &model.UserSubscription{}} {
				require.False(t, db.Migrator().HasTable(table), "use an empty test database")
				require.NoError(t, db.AutoMigrate(table))
				t.Cleanup(func() { require.NoError(t, db.Migrator().DropTable(table)) })
			}
			require.False(t, logDB.Migrator().HasTable(&model.AuditLog{}), "use an empty test log database")
			require.NoError(t, logDB.AutoMigrate(&model.AuditLog{}))
			t.Cleanup(func() { require.NoError(t, logDB.Migrator().DropTable(&model.AuditLog{})) })

			token := "redemption-subscription-test-token"
			admin := model.User{Username: "redemption-subscription-admin", Password: "unused", Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Group: "default", AccessToken: &token}
			require.NoError(t, db.Create(&admin).Error)
			plan := &model.SubscriptionPlan{Title: "controller plan", DurationUnit: model.SubscriptionDurationMonth, DurationValue: 1, TotalAmount: 100, Enabled: true}
			require.NoError(t, db.Create(plan).Error)
			t.Cleanup(func() { model.InvalidateSubscriptionPlanCache(plan.Id) })

			router := gin.New()
			router.Use(middleware.RequestId())
			router.POST("/api/redemption/", middleware.AdminAuth(), AddRedemption)

			invalidBodies := map[string]string{
				"unknown type":          `{"name":"invalid","type":"coupon","quota":100,"count":1}`,
				"missing plan":          `{"name":"invalid","type":"subscription","count":1}`,
				"unknown plan":          fmt.Sprintf(`{"name":"invalid","type":"subscription","plan_id":%d,"count":1}`, plan.Id+999),
				"override too long":     fmt.Sprintf(`{"name":"invalid","type":"subscription","plan_id":%d,"duration_unit":"year","duration_value":11,"count":1}`, plan.Id),
				"override without unit": fmt.Sprintf(`{"name":"invalid","type":"subscription","plan_id":%d,"duration_value":2,"count":1}`, plan.Id),
				"override zero value":   fmt.Sprintf(`{"name":"invalid","type":"subscription","plan_id":%d,"duration_unit":"month","duration_value":0,"count":1}`, plan.Id),
				"zero quota":            `{"name":"invalid","type":"quota","quota":0,"count":1}`,
				"batch over limit":      `{"name":"invalid","type":"quota","quota":100,"count":101}`,
			}
			for name, body := range invalidBodies {
				t.Run(name, func(t *testing.T) {
					response := httptest.NewRecorder()
					request := httptest.NewRequest(http.MethodPost, "/api/redemption/", bytes.NewBufferString(body))
					request.Header.Set("Authorization", "Bearer "+token)
					router.ServeHTTP(response, request)
					var result struct {
						Success bool   `json:"success"`
						Message string `json:"message"`
					}
					require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
					assert.False(t, result.Success)
					assert.NotEmpty(t, result.Message)
					var count int64
					require.NoError(t, model.DB.Model(&model.Redemption{}).Count(&count).Error)
					assert.EqualValues(t, 0, count)
				})
			}

			payload := fmt.Sprintf(`{"name":"subscription batch","type":"subscription","plan_id":%d,"duration_unit":"day","duration_value":3,"count":2}`, plan.Id)
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/redemption/", bytes.NewBufferString(payload))
			request.Header.Set("Authorization", "Bearer "+token)
			router.ServeHTTP(response, request)
			assert.Equal(t, http.StatusOK, response.Code)
			var result struct {
				Success bool     `json:"success"`
				Data    []string `json:"data"`
			}
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
			require.True(t, result.Success)
			require.Len(t, result.Data, 2)

			var codes []model.Redemption
			require.NoError(t, model.DB.Order("id").Find(&codes).Error)
			require.Len(t, codes, 2)
			for index, code := range codes {
				assert.Equal(t, result.Data[index], code.Key)
				assert.Equal(t, model.RedemptionTypeSubscription, code.Type)
				assert.Equal(t, plan.Id, code.PlanId)
				assert.Equal(t, model.SubscriptionDurationDay, code.DurationUnit)
				assert.Equal(t, 3, code.DurationValue)
				assert.Equal(t, 0, code.Quota)
				assert.Equal(t, admin.Id, code.UserId)
				assert.Equal(t, common.RedemptionCodeStatusEnabled, code.Status)
			}
			// The generated codes are immediately redeemable.
			redeemResult, err := model.Redeem(codes[0].Key, admin.Id)
			require.NoError(t, err)
			assert.Equal(t, model.RedemptionTypeSubscription, redeemResult.Type)
			assert.Equal(t, plan.Id, redeemResult.PlanId)
		})
	}
}
