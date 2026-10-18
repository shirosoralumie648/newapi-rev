package controller

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/alicebob/miniredis/v2"
	"github.com/go-redis/redis/v8"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupManageUserTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	require.NoError(t, i18n.Init())
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousRedisEnabled, previousSecret := common.RedisEnabled, common.SessionSecret
	previousMainDatabaseType, previousLogDatabaseType := common.MainDatabaseType(), common.LogDatabaseType()
	dialect := os.Getenv("TEST_MANAGE_USER_DIALECT")
	if dialect == "" {
		dialect = "sqlite"
	}
	databaseTypes := map[string]common.DatabaseType{
		"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL,
	}
	require.Contains(t, databaseTypes, dialect)
	dsn := os.Getenv("TEST_" + strings.ToUpper(dialect) + "_DSN")
	db, _ := newAuditTestDatabase(t, dialect, dsn)
	logDB := db
	if os.Getenv("TEST_MANAGE_USER_SEPARATE_LOG_DB") == "1" {
		logDB, _ = newAuditTestDatabase(t, dialect, dsn)
	}
	model.DB, model.LOG_DB = db, logDB
	common.RedisEnabled = false
	common.SessionSecret = "manage-user-test-secret"
	common.SetDatabaseTypes(databaseTypes[dialect], databaseTypes[dialect])

	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.RedisEnabled, common.SessionSecret = previousRedisEnabled, previousSecret
		common.SetDatabaseTypes(previousMainDatabaseType, previousLogDatabaseType)
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
		if logDB != db {
			sqlLogDB, err := logDB.DB()
			if err == nil {
				_ = sqlLogDB.Close()
			}
		}
	})
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.CasbinRule{}, &model.AuthzRole{}, &model.AuthFlow{}, &model.TwoFA{}, &model.PasskeyCredential{}, &model.UserAccessToken{}, &model.WalletLedgerEntry{}, &model.CreditGrant{}, &model.ReferralBinding{}, &model.ReferralCommission{}, &model.ReferralRegistrationSignal{}, &model.ReferralIdentity{}, &model.ReferralFlag{}, &model.ReferralAgent{}))
	require.NoError(t, logDB.AutoMigrate(&model.Log{}, &model.AuditLog{}))
	versionQuery := "SELECT version()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	var version string
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("database: %s %s, separate log database: %v", dialect, version, logDB != db)
	return db
}

func performManageUserRequest(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	return performVerifiedManageUserRequest(t, body, service.AuthIdentity{UserID: 9999}, "")
}

// performVerifiedManageUserRequest drives ManageUser as the root operator from
// a dashboard login session, carrying the step-up proof status or role changes need.
func performVerifiedManageUserRequest(t *testing.T, body string, identity service.AuthIdentity, proof string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/manage", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	if proof != "" {
		c.Request.Header.Set("X-Security-Proof", proof)
	}
	c.Set("id", identity.UserID)
	c.Set("role", common.RoleRootUser)
	c.Set("username", "root-operator")
	c.Set("session_id", identity.SessionID)
	c.Set("auth_version", identity.UserAuthVersion)
	c.Set("session_version", identity.SessionVersion)
	c.Set(common.RequestIdKey, "quota-test-request")
	ManageUser(c)
	return recorder
}

// manageUserProof signs the root operator in and issues a password-method proof
// bound to one ManageUser operation.
func manageUserProof(t *testing.T, db *gorm.DB, operation service.VerificationOperation) (service.AuthIdentity, string) {
	t.Helper()
	operator := createQuotaTestOperator(t, db, common.RoleRootUser)
	require.NoError(t, model.PublishUserAuthCache(operator.Id))
	bundle, err := service.CreateLoginSession(operator.Id, "password", "127.0.0.1", "manage-user-test")
	require.NoError(t, err)
	identity, err := service.ParseAccessToken(bundle.AccessToken)
	require.NoError(t, err)
	binding, err := service.BindVerificationOperation(operation)
	require.NoError(t, err)
	proof, _, err := service.IssueSecurityProof(identity, service.VerificationMethodPassword, binding)
	require.NoError(t, err)
	return identity, proof
}

func TestManageUserDisableAdvancesAuthVersionOnceAndRevokesSession(t *testing.T) {
	db := setupManageUserTestDB(t)
	now := time.Now().Unix()
	user := model.User{
		Username: "managed-disable-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
	}
	require.NoError(t, db.Create(&user).Error)
	require.NoError(t, db.Create(&model.UserSession{
		SID: "managed-disable-session", UserID: user.Id, Version: 1, UserAuthVersion: 1,
		Status: model.UserSessionStatusActive, RefreshHash: "refresh-hash", LoginMethod: "password",
		LastActiveAt: now, ExpiresAt: now + 3600,
	}).Error)

	identity, proof := manageUserProof(t, db, service.VerificationOperation{Scope: service.VerificationScopeAdminUserManage, Context: []byte(fmt.Sprintf(`{"user_id":%d,"action":"disable"}`, user.Id))})
	recorder := performVerifiedManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"disable"}`, user.Id), identity, proof)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)

	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	assert.Equal(t, common.UserStatusDisabled, updated.Status)
	assert.EqualValues(t, 2, updated.AuthVersion)
	var session model.UserSession
	require.NoError(t, db.First(&session, "sid = ?", "managed-disable-session").Error)
	assert.Equal(t, model.UserSessionStatusRevoked, session.Status)
}

func TestManageUserDemoteAdvancesAuthVersionAndRevokesSessionsOnce(t *testing.T) {
	db := setupManageUserTestDB(t)
	previousMaster := common.IsMasterNode
	common.IsMasterNode = false
	t.Cleanup(func() { common.IsMasterNode = previousMaster })
	require.NoError(t, authz.Init(db))

	now := time.Now().Unix()
	user := model.User{
		Username: "managed-demote-user", Password: "password", Role: common.RoleAdminUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
	}
	require.NoError(t, db.Create(&user).Error)
	for _, sid := range []string{"managed-demote-session-one", "managed-demote-session-two"} {
		require.NoError(t, db.Create(&model.UserSession{
			SID: sid, UserID: user.Id, Version: 1, UserAuthVersion: 1,
			Status: model.UserSessionStatusActive, RefreshHash: "refresh-" + sid, LoginMethod: "password",
			LastActiveAt: now, ExpiresAt: now + 3600,
		}).Error)
	}

	sessionUpdateCount := 0
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:count_demote_session_updates", func(tx *gorm.DB) {
		if tx.Statement != nil && tx.Statement.Table == "user_sessions" {
			sessionUpdateCount++
		}
	}))

	identity, proof := manageUserProof(t, db, service.VerificationOperation{Scope: service.VerificationScopeAdminUserManage, Context: []byte(fmt.Sprintf(`{"user_id":%d,"action":"demote"}`, user.Id))})
	recorder := performVerifiedManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"demote"}`, user.Id), identity, proof)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)

	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	assert.Equal(t, common.RoleCommonUser, updated.Role)
	assert.EqualValues(t, 2, updated.AuthVersion)
	var sessions []model.UserSession
	require.NoError(t, db.Where("user_id = ?", user.Id).Order("sid asc").Find(&sessions).Error)
	require.Len(t, sessions, 2)
	for _, session := range sessions {
		assert.Equal(t, model.UserSessionStatusRevoked, session.Status)
		assert.Equal(t, "admin_demote", session.RevokedReason)
	}
	assert.Equal(t, 1, sessionUpdateCount)
}

func TestManageUserDeleteReturnsImmediatelyAndUnknownActionFails(t *testing.T) {
	db := setupManageUserTestDB(t)
	deleted := model.User{
		Username: "managed-delete-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: "delete-aff",
	}
	require.NoError(t, db.Create(&deleted).Error)

	identity, proof := manageUserProof(t, db, service.VerificationOperation{Scope: service.VerificationScopeAdminUserDelete, Context: []byte(fmt.Sprintf(`{"user_id":%d}`, deleted.Id))})
	recorder := performVerifiedManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"delete"}`, deleted.Id), identity, proof)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	var deletedCount int64
	require.NoError(t, db.Unscoped().Model(&model.User{}).Where("id = ? AND deleted_at IS NOT NULL", deleted.Id).Count(&deletedCount).Error)
	assert.EqualValues(t, 1, deletedCount)

	unchanged := model.User{
		Username: "managed-unknown-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: "unknown-aff",
	}
	require.NoError(t, db.Create(&unchanged).Error)
	recorder = performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"unknown"}`, unchanged.Id))
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	require.NoError(t, db.First(&unchanged, unchanged.Id).Error)
	assert.EqualValues(t, 1, unchanged.AuthVersion)
	assert.Equal(t, common.UserStatusEnabled, unchanged.Status)
}

func createQuotaTestOperator(t *testing.T, db *gorm.DB, role int) model.User {
	t.Helper()
	if role == 0 {
		role = common.RoleRootUser
	}
	operator := model.User{Id: 9999, Username: "root-operator", Password: "root-operator-hash", Role: role, Status: common.UserStatusEnabled, AuthVersion: 1, AffCode: "root-operator-aff"}
	require.NoError(t, db.Create(&operator).Error)
	return operator
}

func TestManageUserQuotaRecordsTopupAndAudit(t *testing.T) {
	for _, tc := range []struct {
		name, mode, action, content string
		value, wantQuota            int
	}{
		{"add", "add", "user.quota_add", "Increased user quota by 500", 500, 1500},
		{"subtract", "subtract", "user.quota_subtract", "Decreased user quota by 500", 500, 500},
		{"override_up", "override", "user.quota_override", "Overrode user quota from 1000 to 1500", 1500, 1500},
		{"override_down", "override", "user.quota_override", "Overrode user quota from 1000 to 500", 500, 500},
		{"override_unchanged", "override", "user.quota_override", "Overrode user quota from 1000 to 1000", 1000, 1000},
		{"override_zero", "override", "user.quota_override", "Overrode user quota from 1000 to 0", 0, 0},
		{"override_negative", "override", "user.quota_override", "Overrode user quota from 1000 to -1", -1, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			user := model.User{Username: "quota-owner", Role: common.RoleCommonUser, Quota: 1000, AffCode: "quota-owner-aff"}
			require.NoError(t, db.Create(&user).Error)
			createQuotaTestOperator(t, db, common.RoleRootUser)

			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, user.Id, tc.mode, tc.value))
			assert.Equal(t, http.StatusOK, recorder.Code)
			require.Contains(t, recorder.Body.String(), `"success":true`)
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, tc.wantQuota, user.Quota)

			logs, total, err := model.GetAllLogs(model.LogFilter{Type: model.LogTypeTopup}, 0, 20)
			require.NoError(t, err)
			assert.EqualValues(t, 1, total)
			require.Len(t, logs, 1)
			assert.Equal(t, user.Id, logs[0].UserId)
			assert.Equal(t, user.Username, logs[0].Username)
			assert.Equal(t, tc.content, logs[0].Content)
			model.FormatAdminLogs(logs)
			var other model.AuditOther
			require.NoError(t, common.UnmarshalJsonStr(logs[0].Other, &other))
			assert.Equal(t, &model.AuditAdminInfo{AdminID: 9999, AdminUsername: "root-operator", AdminRole: common.RoleRootUser, AuthMethod: "session"}, other.AdminInfo)

			logs, total, err = model.GetUserLogs(user.Id, model.LogFilter{Type: model.LogTypeTopup}, 0, 20)
			require.NoError(t, err)
			assert.EqualValues(t, 1, total)
			require.Len(t, logs, 1)
			other = model.AuditOther{}
			require.NoError(t, common.UnmarshalJsonStr(logs[0].Other, &other))
			assert.Nil(t, other.AdminInfo)
			require.NotNil(t, other.Op)
			assert.Equal(t, tc.action, other.Op.Action)
			params, err := common.Marshal(other.Op.Params)
			require.NoError(t, err)
			expectedParams := model.AuditFields{"target_user_id": user.Id, "target_username": user.Username, "mode": tc.mode, "requested_quota": tc.value, "from": 1000, "to": tc.wantQuota}
			if tc.mode != "override" {
				expectedParams["quota"] = tc.value
			}
			expected, err := common.Marshal(expectedParams)
			require.NoError(t, err)
			assert.JSONEq(t, string(expected), string(params))
			assert.Equal(t, "quota-test-request", logs[0].RequestId)
			assert.Empty(t, logs[0].Ip, "recipient logs must not disclose the administrator IP")

			logs, total, err = model.GetUserLogs(9999, model.LogFilter{Type: model.LogTypeTopup}, 0, 20)
			require.NoError(t, err)
			assert.Zero(t, total)
			assert.Empty(t, logs)
			var audits []model.AuditLog
			require.NoError(t, model.LOG_DB.Find(&audits).Error)
			require.Len(t, audits, 1)
			assert.Equal(t, 9999, audits[0].UserId)
			assert.Equal(t, "root-operator", audits[0].Username)
			assert.Equal(t, tc.action, audits[0].Action)
			assert.True(t, audits[0].Success)
			params, err = common.Marshal(audits[0].Other.Op.Params)
			require.NoError(t, err)
			assert.JSONEq(t, string(expected), string(params))
			assert.Equal(t, "quota-test-request", audits[0].RequestId)
		})
	}
}

func TestManageUserQuotaFailuresDoNotRecordTopup(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		value      int
		failUpdate bool
	}{
		{"zero_add", "add", 0, false},
		{"negative_subtract", "subtract", -1, false},
		{"invalid_mode", "invalid", 500, false},
		{"add_update_error", "add", 500, true},
		{"subtract_update_error", "subtract", 500, true},
		{"override_update_error", "override", 500, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			createQuotaTestOperator(t, db, common.RoleRootUser)
			user := model.User{Username: "quota-owner", Role: common.RoleCommonUser, Quota: 1000}
			require.NoError(t, db.Create(&user).Error)
			if tc.failUpdate {
				require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:fail_quota_update", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" {
						tx.AddError(errors.New("quota update unavailable"))
					}
				}))
			}
			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, user.Id, tc.mode, tc.value))
			assert.Contains(t, recorder.Body.String(), `"success":false`)
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, 1000, user.Quota)
			var logCount, auditCount int64
			require.NoError(t, model.LOG_DB.Model(&model.Log{}).Count(&logCount).Error)
			require.NoError(t, model.LOG_DB.Model(&model.AuditLog{}).Count(&auditCount).Error)
			assert.Zero(t, logCount)
			assert.EqualValues(t, 1, auditCount)
			var audit model.AuditLog
			require.NoError(t, model.LOG_DB.First(&audit).Error)
			assert.False(t, audit.Success)
			params, err := common.Marshal(audit.Other.Op.Params)
			require.NoError(t, err)
			assert.NotContains(t, string(params), `"from"`)
			assert.NotContains(t, string(params), `"to"`)
			assert.NotContains(t, string(params), `"target_username"`)
			assert.NotContains(t, string(params), "quota update unavailable")
			reason := "invalid_parameters"
			if tc.failUpdate {
				reason = "database_error"
			}
			assert.Contains(t, string(params), `"failure_reason":"`+reason+`"`)
			assert.Contains(t, string(params), fmt.Sprintf(`"requested_quota":%d`, tc.value))
		})
	}
}

func TestManageUserQuotaLogFailureKeepsSuccessfulAdjustment(t *testing.T) {
	for _, failedTable := range []string{"logs", "audit_logs"} {
		t.Run(failedTable, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			createQuotaTestOperator(t, db, common.RoleRootUser)
			user := model.User{Username: "quota-owner", Role: common.RoleCommonUser, Quota: 1000}
			require.NoError(t, db.Create(&user).Error)
			require.NoError(t, model.LOG_DB.Callback().Create().Before("gorm:create").Register("test:fail_quota_log", func(tx *gorm.DB) {
				if tx.Statement.Table == failedTable {
					tx.AddError(errors.New("quota log unavailable"))
				}
			}))
			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":"add","value":500}`, user.Id))
			assert.Contains(t, recorder.Body.String(), `"success":true`)
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, 1500, user.Quota)
			var logCount, auditCount int64
			require.NoError(t, model.LOG_DB.Model(&model.Log{}).Count(&logCount).Error)
			require.NoError(t, model.LOG_DB.Model(&model.AuditLog{}).Count(&auditCount).Error)
			if failedTable == "logs" {
				assert.Zero(t, logCount)
				assert.EqualValues(t, 1, auditCount)
			} else {
				assert.EqualValues(t, 1, logCount)
				assert.Zero(t, auditCount)
			}
		})
	}
}

func TestManageUserQuotaTargetsAndWalletBounds(t *testing.T) {
	for _, tc := range []struct {
		name, mode, reason                                string
		before, value, targetID, targetRole, operatorRole int
		deleted, failRead                                 bool
	}{
		{name: "zero_id", mode: "add", value: 1, reason: "invalid_parameters"},
		{name: "negative_id", mode: "subtract", value: 1, targetID: -1, reason: "invalid_parameters"},
		{name: "missing", mode: "override", value: 1, targetID: 12345, reason: "target_not_found"},
		{name: "deleted", mode: "add", value: 1, targetID: 1, deleted: true, reason: "target_not_found"},
		{name: "peer_admin", mode: "add", value: 1, targetID: 1, targetRole: common.RoleAdminUser, operatorRole: common.RoleAdminUser, reason: "permission_denied"},
		{name: "higher_role", mode: "override", value: 1, targetID: 1, targetRole: common.RoleRootUser, operatorRole: common.RoleAdminUser, reason: "permission_denied"},
		{name: "read_error", mode: "add", value: 1, targetID: 1, failRead: true, reason: "database_error"},
		{name: "add_overflow", mode: "add", before: common.MaxWalletQuota, value: 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "subtract_underflow", mode: "subtract", before: -common.MaxWalletQuota, value: 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "oversized_add", mode: "add", value: common.MaxWalletQuota + 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "oversized_subtract", mode: "subtract", value: common.MaxWalletQuota + 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "oversized_override", mode: "override", value: -common.MaxWalletQuota - 1, targetID: 1, reason: "quota_limit_exceeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			createQuotaTestOperator(t, db, tc.operatorRole)
			user := model.User{Id: 1, Username: "private-target-name", Role: tc.targetRole, Quota: tc.before}
			require.NoError(t, db.Create(&user).Error)
			if tc.deleted {
				require.NoError(t, db.Delete(&user).Error)
			}
			if tc.failRead {
				require.NoError(t, db.Callback().Query().Before("gorm:query").Register("test:quota_read_error", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" && len(tx.Statement.Selects) == 0 {
						tx.AddError(errors.New("private database error"))
					}
				}))
			}
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodPost, "/api/user/manage", strings.NewReader(fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, tc.targetID, tc.mode, tc.value)))
			role := tc.operatorRole
			if role == 0 {
				role = common.RoleRootUser
			}
			c.Set("id", 9999)
			c.Set("role", role)
			ManageUser(c)
			require.Contains(t, recorder.Body.String(), `"success":false`)
			if tc.failRead {
				require.NoError(t, db.Callback().Query().Remove("test:quota_read_error"))
			}
			require.NoError(t, db.Unscoped().First(&user, user.Id).Error)
			assert.Equal(t, tc.before, user.Quota)
			var audits []model.AuditLog
			require.NoError(t, model.LOG_DB.Find(&audits).Error)
			require.Len(t, audits, 1)
			assert.False(t, audits[0].Success)
			params, err := common.Marshal(audits[0].Other.Op.Params)
			require.NoError(t, err)
			expected, err := common.Marshal(model.AuditFields{"target_user_id": tc.targetID, "mode": tc.mode, "requested_quota": tc.value, "failure_reason": tc.reason})
			require.NoError(t, err)
			assert.JSONEq(t, string(expected), string(params))
			assert.NotContains(t, audits[0].Content, user.Username)
			var count int64
			require.NoError(t, model.LOG_DB.Model(&model.Log{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}

func TestManageUserQuotaMiddlewareKeepsOneOperationPerRequest(t *testing.T) {
	db := setupManageUserTestDB(t)
	pat := "quota-middleware-test-token"
	operator := model.User{Id: 9999, Username: "root-operator", Role: common.RoleRootUser, Status: common.UserStatusEnabled, AuthVersion: 1, AccessToken: &pat, Quota: 1000}
	require.NoError(t, db.Create(&operator).Error)
	router := gin.New()
	router.Use(middleware.RequestId(), middleware.AccessTokenAudit())
	router.POST("/api/user/manage", middleware.AdminAuth(), ManageUser)
	for _, tc := range []struct {
		body, action string
		success      bool
	}{
		{`{"id":9999,"action":"add_quota","mode":"add","value":100}`, "user.quota_add", true},
		{`{"id":9999,"action":"add_quota","mode":"subtract","value":0}`, "user.quota_subtract", false},
		{`{"id":9999,"action":"add_quota","mode":"invalid","value":1}`, "generic", false},
		{`{"id":`, "generic", false},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/user/manage", strings.NewReader(tc.body))
		request.Header.Set("Authorization", "Bearer "+pat)
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(recorder, request)
		assert.Equal(t, http.StatusOK, recorder.Code)
		assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"success":%t`, tc.success))
		requestID := recorder.Header().Get(common.RequestIdKey)
		require.NotEmpty(t, requestID)
		var audits []model.AuditLog
		require.NoError(t, model.LOG_DB.Where("request_id = ?", requestID).Find(&audits).Error)
		require.Len(t, audits, 2, "one operation audit and one PAT request audit")
		for _, audit := range audits {
			assert.Equal(t, tc.success, audit.Success)
			if audit.Category != model.AuditCategoryOperation {
				continue
			}
			assert.Equal(t, tc.action, audit.Action)
			assert.Equal(t, operator.Id, audit.UserId)
			assert.Equal(t, "/api/user/manage", audit.Route)
			if tc.success {
				params, err := common.Marshal(audit.Other.Op.Params)
				require.NoError(t, err)
				assert.Contains(t, string(params), `"target_user_id":9999`)
				assert.Contains(t, string(params), `"target_username":"root-operator"`)
			}
		}
		var count int64
		require.NoError(t, model.LOG_DB.Model(&model.Log{}).Where("request_id = ?", requestID).Count(&count).Error)
		if tc.success {
			assert.EqualValues(t, 1, count)
		} else {
			assert.Zero(t, count)
		}
	}
	require.NoError(t, db.First(&operator, operator.Id).Error)
	assert.Equal(t, 1100, operator.Quota)
}

func TestManageUserQuotaConcurrentSnapshots(t *testing.T) {
	db := setupManageUserTestDB(t)
	user := model.User{Username: "concurrent-quota", Quota: 1000}
	require.NoError(t, db.Create(&user).Error)
	var ready sync.WaitGroup
	ready.Add(2)
	release := make(chan struct{})
	require.NoError(t, db.Callback().Query().Before("gorm:query").Register("test:concurrent_quota_start", func(tx *gorm.DB) {
		if tx.Statement.Table == "users" {
			ready.Done()
			<-release
		}
	}))
	type result struct {
		adjustment *model.UserQuotaAdjustment
		err        error
		value      int
	}
	results := make(chan result, 2)
	for _, value := range []int{10, 20} {
		go func(value int) {
			adjustment, err := model.AdjustUserQuota(user.Id, common.RoleRootUser, "add", value)
			results <- result{adjustment, err, value}
		}(value)
	}
	ready.Wait()
	close(release)
	var committed []model.UserQuotaAdjustment
	for range 2 {
		result := <-results
		if result.err != nil {
			require.True(t, common.UsingMainDatabase(common.DatabaseTypeSQLite), "row-locking databases must serialize both adjustments: %v", result.err)
			assert.Contains(t, strings.ToLower(result.err.Error()), "locked")
			assert.Nil(t, result.adjustment)
			continue
		}
		require.NotNil(t, result.adjustment)
		assert.Equal(t, result.value, result.adjustment.After-result.adjustment.Before)
		committed = append(committed, *result.adjustment)
	}
	require.NoError(t, db.Callback().Query().Remove("test:concurrent_quota_start"))
	require.NotEmpty(t, committed)
	sort.Slice(committed, func(i, j int) bool { return committed[i].Before < committed[j].Before })
	balance := 1000
	for _, adjustment := range committed {
		assert.Equal(t, balance, adjustment.Before)
		balance = adjustment.After
	}
	require.NoError(t, db.First(&user, user.Id).Error)
	assert.Equal(t, balance, user.Quota)
}

func TestManageUserQuotaCacheUsesCommittedIntegerDifference(t *testing.T) {
	for _, tc := range []struct {
		name, mode                               string
		before, cached, value, after, wantCached int
		failUpdate, failCache, missingCache      bool
	}{
		{name: "add_preserves_reservations", mode: "add", before: 1000, cached: 900, value: 500, after: 1500, wantCached: 1400},
		{name: "subtract_preserves_reservations", mode: "subtract", before: 1000, cached: 900, value: 500, after: 500, wantCached: 400},
		{name: "override_preserves_reservations", mode: "override", before: 1000, cached: 900, value: 2000, after: 2000, wantCached: 1900},
		{name: "large_odd_difference", mode: "override", before: common.MaxWalletQuota - 1, cached: common.MaxWalletQuota - 1, value: -common.MaxWalletQuota, after: -common.MaxWalletQuota, wantCached: -common.MaxWalletQuota},
		{name: "rollback_does_not_change_cache", mode: "subtract", before: 1000, cached: 900, value: 500, after: 1000, wantCached: 900, failUpdate: true},
		{name: "cache_error_keeps_committed_change", mode: "add", before: 1000, value: 500, after: 1500, failCache: true},
		{name: "missing_cache_is_not_partially_created", mode: "add", before: 1000, value: 500, after: 1500, missingCache: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			operator := createQuotaTestOperator(t, db, common.RoleRootUser)
			server := miniredis.RunT(t)
			oldRDB := common.RDB
			common.RDB = redis.NewClient(&redis.Options{Addr: server.Addr(), MaxRetries: -1})
			common.RedisEnabled = true
			t.Cleanup(func() { _ = common.RDB.Close(); common.RDB = oldRDB })
			user := model.User{Username: "cached-quota", Quota: tc.before, AuthVersion: 1}
			require.NoError(t, db.Create(&user).Error)
			cache, err := model.GetUserCache(user.Id)
			require.NoError(t, err)
			assert.Equal(t, tc.before, cache.Quota)
			_, err = model.GetUserCache(operator.Id)
			require.NoError(t, err)
			keys := server.Keys()
			var quotaKey string
			for _, key := range keys {
				if server.HGet(key, "Id") == strconv.Itoa(user.Id) && server.HGet(key, "Quota") != "" {
					quotaKey = key
					break
				}
			}
			require.NotEmpty(t, quotaKey)
			server.HSet(quotaKey, "Quota", strconv.Itoa(tc.cached))
			if tc.missingCache {
				server.Del(quotaKey)
			}
			if tc.failCache {
				server.SetError("ERR quota cache unavailable")
			}
			if tc.failUpdate {
				require.NoError(t, db.Callback().Update().After("gorm:update").Register("test:cache_quota_rollback", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" {
						tx.AddError(errors.New("quota rollback"))
					}
				}))
			}
			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, user.Id, tc.mode, tc.value))
			assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"success":%t`, !tc.failUpdate))
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, tc.after, user.Quota)
			if tc.missingCache {
				// Log username lookup may hydrate the whole user after commit.
				if server.Exists(quotaKey) {
					assert.Equal(t, strconv.Itoa(user.Id), server.HGet(quotaKey, "Id"))
					assert.NotEmpty(t, server.HGet(quotaKey, "CacheSchema"))
					assert.Equal(t, strconv.Itoa(tc.after), server.HGet(quotaKey, "Quota"))
				}
			} else if !tc.failCache {
				assert.Equal(t, strconv.Itoa(tc.wantCached), server.HGet(quotaKey, "Quota"))
			}
		})
	}
}

// Saving notification settings starts from what the user stored: fields the
// form does not manage stay, and switches an older client leaves out keep
// their stored values. Only administrators change the channel and upstream
// switches, and a threshold of 0 means the site default.
func TestUpdateUserSettingKeepsWhatTheRequestLeavesOut(t *testing.T) {
	on, off := true, false
	stored := dto.UserSetting{
		NotifyType:                       dto.NotifyTypeBark,
		BarkUrl:                          "https://api.day.app/key/{{title}}/{{content}}",
		QuotaWarningThreshold:            500000,
		QuotaWarningEnabled:              &off,
		ChannelNotifyEnabled:             &on,
		UpstreamModelUpdateNotifyEnabled: true,
		Language:                         "zhCN",
		SidebarModules:                   `{"chat":{"enabled":true}}`,
		BillingPreference:                "wallet_only",
	}
	kept := func(setting dto.UserSetting) dto.UserSetting {
		setting.Language, setting.SidebarModules, setting.BillingPreference = stored.Language, stored.SidebarModules, stored.BillingPreference
		return setting
	}
	switchesChanged := `{"notify_type":"email","quota_warning_threshold":0,"quota_warning_enabled":true,"channel_notify_enabled":false,"upstream_model_update_notify_enabled":false}`
	for _, tc := range []struct {
		name        string
		role        int
		body        string
		wantSuccess bool
		want        dto.UserSetting
	}{
		{
			name:        "older client without the new switches",
			role:        common.RoleAdminUser,
			body:        `{"notify_type":"webhook","quota_warning_threshold":2000,"webhook_url":"https://example.com/hook","webhook_secret":"hook-secret","accept_unset_model_ratio_model":true,"record_ip_log":true}`,
			wantSuccess: true,
			want: kept(dto.UserSetting{
				NotifyType: dto.NotifyTypeWebhook, WebhookUrl: "https://example.com/hook", WebhookSecret: "hook-secret",
				QuotaWarningThreshold: 2000, QuotaWarningEnabled: &off, ChannelNotifyEnabled: &on, UpstreamModelUpdateNotifyEnabled: true,
				AcceptUnsetRatioModel: true, RecordIpLog: true,
			}),
		},
		{
			name:        "administrator changes the switches and uses the site default threshold",
			role:        common.RoleAdminUser,
			body:        switchesChanged,
			wantSuccess: true,
			want:        kept(dto.UserSetting{NotifyType: dto.NotifyTypeEmail, QuotaWarningEnabled: &on, ChannelNotifyEnabled: &off}),
		},
		{
			name:        "user cannot change the administrator switches",
			role:        common.RoleCommonUser,
			body:        switchesChanged,
			wantSuccess: true,
			want:        kept(dto.UserSetting{NotifyType: dto.NotifyTypeEmail, QuotaWarningEnabled: &on, ChannelNotifyEnabled: &on, UpstreamModelUpdateNotifyEnabled: true}),
		},
		{
			name: "negative threshold",
			role: common.RoleCommonUser,
			body: `{"notify_type":"email","quota_warning_threshold":-1}`,
			want: stored,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			setting, err := common.Marshal(stored)
			require.NoError(t, err)
			user := model.User{Username: "setting-owner", Role: tc.role, Status: common.UserStatusEnabled, AffCode: "setting-owner-aff", Setting: string(setting)}
			require.NoError(t, db.Create(&user).Error)

			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodPut, "/api/user/setting", strings.NewReader(tc.body))
			c.Request.Header.Set("Content-Type", "application/json")
			c.Set("id", user.Id)
			UpdateUserSetting(c)

			assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"success":%t`, tc.wantSuccess))
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, tc.want, user.GetSetting())
		})
	}
}

// TestBindUserInviterAdminContract pins the administrator binding endpoint:
// relation errors surface as translatable messages, the success response
// carries the recorded binding, an existing attribution is never replaced, and
// only the successful call is audited with the target context.
func TestBindUserInviterAdminContract(t *testing.T) {
	db := setupManageUserTestDB(t)
	createQuotaTestOperator(t, db, common.RoleRootUser)
	invitee := model.User{Username: "bind-invitee", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AffCode: "bind-invitee-aff"}
	require.NoError(t, db.Create(&invitee).Error)
	inviter := model.User{Username: "bind-inviter", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AffCode: "bind-inviter-aff"}
	require.NoError(t, db.Create(&inviter).Error)
	disabled := model.User{Username: "bind-disabled", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusDisabled, AffCode: "bind-disabled-aff"}
	require.NoError(t, db.Create(&disabled).Error)

	bind := func(targetID int, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/user/%d/inviter", targetID), strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Params = gin.Params{{Key: "id", Value: strconv.Itoa(targetID)}}
		c.Set("id", 9999)
		c.Set("role", common.RoleRootUser)
		c.Set("username", "root-operator")
		BindUserInviter(c)
		return recorder
	}

	for _, tc := range []struct {
		name, body, message string
	}{
		{"invalid parameters", `{"inviter_id":0}`, "Invalid parameters"},
		{"self invite", fmt.Sprintf(`{"inviter_id":%d}`, invitee.Id), "A user cannot invite themselves"},
		{"missing inviter", `{"inviter_id":424242}`, "Inviter does not exist"},
		{"disabled inviter", fmt.Sprintf(`{"inviter_id":%d}`, disabled.Id), "Inviter account is disabled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := bind(invitee.Id, tc.body)
			assert.Equal(t, http.StatusOK, recorder.Code)
			assert.Contains(t, recorder.Body.String(), `"success":false`)
			assert.Contains(t, recorder.Body.String(), tc.message)
		})
	}

	recorder := bind(invitee.Id, fmt.Sprintf(`{"inviter_id":%d}`, inviter.Id))
	assert.Equal(t, http.StatusOK, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"success":true`)
	assert.Contains(t, recorder.Body.String(), "Inviter bound")
	assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"inviter_id":%d`, inviter.Id))
	assert.Contains(t, recorder.Body.String(), `"source":"admin"`)

	binding, err := model.GetReferralBindingForInvitee(invitee.Id)
	require.NoError(t, err)
	require.NotNil(t, binding)
	assert.Equal(t, inviter.Id, binding.InviterId)
	assert.Equal(t, model.ReferralSourceAdmin, binding.Source)
	require.NoError(t, db.First(&invitee, invitee.Id).Error)
	assert.Equal(t, inviter.Id, invitee.InviterId, "the binding must mirror onto users.inviter_id")

	other := model.User{Username: "bind-second-inviter", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AffCode: "bind-second-aff"}
	require.NoError(t, db.Create(&other).Error)
	recorder = bind(invitee.Id, fmt.Sprintf(`{"inviter_id":%d}`, other.Id))
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	assert.Contains(t, recorder.Body.String(), "The user already has an inviter")
	require.NoError(t, db.First(&invitee, invitee.Id).Error)
	assert.Equal(t, inviter.Id, invitee.InviterId, "an existing attribution is never replaced")

	var audits []model.AuditLog
	require.NoError(t, model.LOG_DB.Where("action = ?", "user.inviter_bind").Find(&audits).Error)
	require.Len(t, audits, 1, "only the successful binding is audited")
	audit := audits[0]
	assert.Equal(t, 9999, audit.UserId)
	assert.Equal(t, "root-operator", audit.Username)
	assert.Equal(t, model.AuditCategoryOperation, audit.Category)
	assert.True(t, audit.Success)
	assert.Equal(t, fmt.Sprintf("Bound user %s (ID: %d) to inviter %d", invitee.Username, invitee.Id, inviter.Id), audit.Content)
	params, err := common.Marshal(audit.Other.Op.Params)
	require.NoError(t, err)
	expected, err := common.Marshal(map[string]any{"username": invitee.Username, "id": invitee.Id, "inviter_id": inviter.Id, "source": model.ReferralSourceAdmin, "target_user_id": invitee.Id})
	require.NoError(t, err)
	assert.JSONEq(t, string(expected), string(params))
}

// TestReferralAntiAbuseAdminEndpoints pins the RF-06 administrator surface:
// the anti-abuse mark, the hashed real-name identity, the profile view, the
// manual review queue and its exactly-once decisions, each audited with the
// target context and without secrets.
func TestReferralAntiAbuseAdminEndpoints(t *testing.T) {
	db := setupManageUserTestDB(t)
	createQuotaTestOperator(t, db, common.RoleRootUser)
	inviter := model.User{Username: "abuse-inviter", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AffCode: "abuse-inviter-aff"}
	require.NoError(t, db.Create(&inviter).Error)
	invitee := model.User{Username: "abuse-invitee", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AffCode: "abuse-invitee-aff"}
	require.NoError(t, db.Create(&invitee).Error)

	invoke := func(method, path, body string, params gin.Params, handler gin.HandlerFunc) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(method, path, strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Params = params
		c.Set("id", 9999)
		c.Set("role", common.RoleRootUser)
		c.Set("username", "root-operator")
		handler(c)
		return recorder
	}
	userParams := func(id int) gin.Params {
		return gin.Params{{Key: "id", Value: strconv.Itoa(id)}}
	}

	recorder := invoke(http.MethodPost, fmt.Sprintf("/api/user/%d/referral-flag", invitee.Id), `{"level":"frozen","note":"signup farm"}`, userParams(invitee.Id), SetUserReferralFlag)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	assert.Contains(t, recorder.Body.String(), "Referral flag updated")
	flag, err := model.GetReferralFlag(invitee.Id)
	require.NoError(t, err)
	require.NotNil(t, flag)
	assert.Equal(t, model.ReferralFlagLevelFrozen, flag.Level)
	assert.Equal(t, "signup farm", flag.Note)

	recorder = invoke(http.MethodPost, fmt.Sprintf("/api/user/%d/referral-flag", invitee.Id), `{"level":"ban"}`, userParams(invitee.Id), SetUserReferralFlag)
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	recorder = invoke(http.MethodPost, fmt.Sprintf("/api/user/%d/referral-flag", invitee.Id), `{"level":"clear"}`, userParams(invitee.Id), SetUserReferralFlag)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	flag, err = model.GetReferralFlag(invitee.Id)
	require.NoError(t, err)
	assert.Nil(t, flag)

	recorder = invoke(http.MethodPost, fmt.Sprintf("/api/user/%d/referral-identity", inviter.Id), `{"identity":"ID CARD 42"}`, userParams(inviter.Id), SetUserReferralIdentity)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	assert.Contains(t, recorder.Body.String(), "Referral identity updated")
	identity, err := model.GetReferralIdentity(inviter.Id)
	require.NoError(t, err)
	require.NotNil(t, identity)
	identityHash, err := model.HashReferralIdentity("idcard42")
	require.NoError(t, err)
	assert.Equal(t, identityHash, identity.IdentityHash, "the stored hash must come from the normalized value")
	assert.NotContains(t, recorder.Body.String(), identityHash, "the full hash never leaves the server")
	assert.Contains(t, recorder.Body.String(), `"identity_ref":"`+identityHash[:8]+`"`)

	require.NoError(t, db.Create(&model.ReferralRegistrationSignal{
		UserId: invitee.Id, Ip: "203.0.113.77", EmailDomain: "example.com", CreatedAt: time.Now().Unix(),
	}).Error)
	require.NoError(t, db.Create(&model.ReferralBinding{
		InviteeId: invitee.Id, InviterId: inviter.Id, Source: model.ReferralSourceCode, BoundAt: time.Now().Unix(),
	}).Error)
	recorder = invoke(http.MethodGet, fmt.Sprintf("/api/user/%d/referral-profile", inviter.Id), "", userParams(inviter.Id), GetUserReferralProfile)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	assert.Contains(t, recorder.Body.String(), `"invitees":1`)
	recorder = invoke(http.MethodGet, fmt.Sprintf("/api/user/%d/referral-profile", invitee.Id), "", userParams(invitee.Id), GetUserReferralProfile)
	assert.Contains(t, recorder.Body.String(), `"ip":"203.0.113.77"`)

	recorder = invoke(http.MethodDelete, fmt.Sprintf("/api/user/%d/referral-identity", inviter.Id), "", userParams(inviter.Id), ClearUserReferralIdentity)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	assert.Contains(t, recorder.Body.String(), "Referral identity cleared")
	identity, err = model.GetReferralIdentity(inviter.Id)
	require.NoError(t, err)
	assert.Nil(t, identity)

	now := time.Now().Unix()
	review := model.ReferralCommission{
		InviterId: inviter.Id, InviteeId: invitee.Id, Source: model.ReferralCommissionSourceTopUp,
		RefType: model.WalletLedgerRefTopUp, RefId: "contract-review-1",
		BaseQuota: 5000000, RatePercent: "10", CommissionQuota: 500000,
		Status: model.ReferralCommissionStatusReview, Reason: model.ReferralCommissionReasonReviewThreshold,
		CreatedAt: now, UpdatedAt: now,
	}
	require.NoError(t, db.Create(&review).Error)
	rejected := review
	rejected.Id = 0
	rejected.RefId = "contract-review-2"
	require.NoError(t, db.Create(&rejected).Error)

	recorder = invoke(http.MethodGet, "/api/user/referral/reviews?p=1&page_size=10", "", nil, ListReferralCommissionReviews)
	assert.Contains(t, recorder.Body.String(), `"total":2`)
	assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"id":%d`, review.Id))

	recorder = invoke(http.MethodPost, fmt.Sprintf("/api/user/referral/reviews/%d", review.Id), `{"decision":"approve"}`, userParams(review.Id), ReviewReferralCommission)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	assert.Contains(t, recorder.Body.String(), "Referral review updated")
	var reloaded model.ReferralCommission
	require.NoError(t, db.First(&reloaded, review.Id).Error)
	assert.Equal(t, model.ReferralCommissionStatusPending, reloaded.Status)

	recorder = invoke(http.MethodPost, fmt.Sprintf("/api/user/referral/reviews/%d", review.Id), `{"decision":"reject"}`, userParams(review.Id), ReviewReferralCommission)
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	assert.Contains(t, recorder.Body.String(), "The referral review is no longer pending")
	require.NoError(t, db.First(&reloaded, review.Id).Error)
	assert.Equal(t, model.ReferralCommissionStatusPending, reloaded.Status, "a decided review keeps its decision")

	recorder = invoke(http.MethodPost, fmt.Sprintf("/api/user/referral/reviews/%d", rejected.Id), `{"decision":"reject"}`, userParams(rejected.Id), ReviewReferralCommission)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	var rejectedRow model.ReferralCommission
	require.NoError(t, db.First(&rejectedRow, rejected.Id).Error)
	assert.Equal(t, model.ReferralCommissionStatusRejected, rejectedRow.Status)

	for _, expected := range []struct {
		action   string
		contents []string
	}{
		{"user.referral_flag", []string{
			"Updated the referral flag of user " + invitee.Username + " to frozen",
			"Updated the referral flag of user " + invitee.Username + " to clear",
		}},
		{"user.referral_identity", []string{"Recorded the referral identity of user " + inviter.Username}},
		{"user.referral_identity_clear", []string{"Cleared the referral identity of user " + inviter.Username}},
	} {
		var audits []model.AuditLog
		require.NoError(t, model.LOG_DB.Where("action = ?", expected.action).Order("id").Find(&audits).Error)
		require.Len(t, audits, len(expected.contents), "%s must be audited once per call", expected.action)
		for i, content := range expected.contents {
			assert.Equal(t, content, audits[i].Content)
			assert.Equal(t, 9999, audits[i].UserId)
			assert.Equal(t, "root-operator", audits[i].Username)
		}
	}
	var identityAudits []model.AuditLog
	require.NoError(t, model.LOG_DB.Where("action = ?", "user.referral_identity").Find(&identityAudits).Error)
	identityParams, err := common.Marshal(identityAudits[0].Other.Op.Params)
	require.NoError(t, err)
	assert.NotContains(t, string(identityParams), "ID CARD 42")
	assert.NotContains(t, string(identityParams), identityHash)

	var reviewAudits []model.AuditLog
	require.NoError(t, model.LOG_DB.Where("action = ?", "user.referral_review").Order("id").Find(&reviewAudits).Error)
	require.Len(t, reviewAudits, 2)
	assert.Equal(t, fmt.Sprintf("Decided referral commission review #%d as approve", review.Id), reviewAudits[0].Content)
	assert.Equal(t, fmt.Sprintf("Decided referral commission review #%d as reject", rejected.Id), reviewAudits[1].Content)
}

// The invitation statistics endpoints are read-only: the inviter sees exactly
// their own invitees with masked identifiers and without the anti-abuse
// commission states, the administrator list carries the refused states and
// the filtered summary, the export writes the same rows as CSV, and no call
// moves a balance.
func TestReferralInvitationStatisticsEndpoints(t *testing.T) {
	db := setupManageUserTestDB(t)
	now := time.Now().Unix()
	inviter := model.User{Username: "stats-inviter", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Quota: 12345, AffCode: "stats-inviter-aff"}
	require.NoError(t, db.Create(&inviter).Error)
	invitee := model.User{Username: "stats-invitee", Email: "stats-invitee@example.com", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AffCode: "stats-invitee-aff"}
	require.NoError(t, db.Create(&invitee).Error)
	otherInviter := model.User{Username: "stats-other-inviter", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AffCode: "stats-other-inviter-aff"}
	require.NoError(t, db.Create(&otherInviter).Error)
	otherInvitee := model.User{Username: "stats-other-invitee", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AffCode: "stats-other-invitee-aff"}
	require.NoError(t, db.Create(&otherInvitee).Error)

	require.NoError(t, db.Create(&model.ReferralBinding{InviteeId: invitee.Id, InviterId: inviter.Id, Source: model.ReferralSourceLink, BoundAt: now}).Error)
	require.NoError(t, db.Create(&model.ReferralBinding{InviteeId: otherInvitee.Id, InviterId: otherInviter.Id, Source: model.ReferralSourceCode, BoundAt: now + 1}).Error)
	require.NoError(t, db.Create(&model.ReferralCommission{
		InviterId: inviter.Id, InviteeId: invitee.Id, Source: model.ReferralCommissionSourceTopUp,
		RefType: model.WalletLedgerRefTopUp, RefId: "stats-order-1",
		BaseQuota: 5000000, RatePercent: "10", CommissionQuota: 500000,
		Status: model.ReferralCommissionStatusPending, CreatedAt: now, UpdatedAt: now,
	}).Error)
	require.NoError(t, db.Create(&model.ReferralCommission{
		InviterId: inviter.Id, InviteeId: invitee.Id, Source: model.ReferralCommissionSourceTopUp,
		RefType: model.WalletLedgerRefTopUp, RefId: "stats-order-2",
		BaseQuota: 2000000, RatePercent: "10", CommissionQuota: 200000,
		Status: model.ReferralCommissionStatusBlocked, Reason: model.ReferralCommissionReasonDailyCap,
		CreatedAt: now, UpdatedAt: now,
	}).Error)
	require.NoError(t, db.Create(&model.ReferralCommission{
		InviterId: inviter.Id, InviteeId: invitee.Id, Source: model.ReferralCommissionSourceTopUp,
		RefType: model.WalletLedgerRefTopUp, RefId: "stats-order-3",
		BaseQuota: 3000000, RatePercent: "10", CommissionQuota: 300000,
		Status: model.ReferralCommissionStatusRefunded, CreatedAt: now, UpdatedAt: now,
	}).Error)

	invoke := func(userID int, method, path string, handler gin.HandlerFunc) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(method, path, nil)
		c.Set("id", userID)
		c.Set("role", common.RoleAdminUser)
		c.Set("username", "stats-caller")
		handler(c)
		return recorder
	}

	recorder := invoke(inviter.Id, http.MethodGet, "/api/user/self/referrals?p=1&page_size=20", GetSelfReferralInvitations)
	assert.Equal(t, http.StatusOK, recorder.Code)
	selfBody := recorder.Body.String()
	assert.Contains(t, selfBody, `"success":true`)
	assert.Contains(t, selfBody, `"total":1`)
	assert.Contains(t, selfBody, `"identifier":"s***@example.com"`)
	assert.Contains(t, selfBody, fmt.Sprintf(`"invitee_id":%d`, invitee.Id))
	assert.Contains(t, selfBody, `"pending_quota":500000`)
	assert.Contains(t, selfBody, `"refunded_quota":300000`, "a revoked commission stays visible in the inviter's own history")
	assert.Contains(t, selfBody, `"commission_enabled":`)
	assert.NotContains(t, selfBody, "stats-invitee@example.com")
	assert.NotContains(t, selfBody, fmt.Sprintf(`"invitee_id":%d`, otherInvitee.Id))
	assert.NotContains(t, selfBody, `"blocked_quota"`, "the user view never exposes the anti-abuse states")

	recorder = invoke(9999, http.MethodGet, "/api/user/referrals?p=1&page_size=20", GetReferralInvitations)
	assert.Equal(t, http.StatusOK, recorder.Code)
	adminBody := recorder.Body.String()
	assert.Contains(t, adminBody, `"total":2`)
	assert.Contains(t, adminBody, `"username":"stats-invitee"`, "the administrator sees the raw identifiers")
	assert.Contains(t, adminBody, `"inviter_username":"stats-inviter"`)
	assert.Contains(t, adminBody, `"total_invitees":2`)
	assert.Contains(t, adminBody, `"invitees_with_commission":1`)
	assert.Contains(t, adminBody, `"total_paid_quota":10000000`)
	assert.Contains(t, adminBody, `"pending_quota":500000`)
	assert.Contains(t, adminBody, `"blocked_quota":200000`)
	assert.Contains(t, adminBody, `"refunded_quota":300000`)

	recorder = invoke(9999, http.MethodGet, "/api/user/referrals?p=1&page_size=20&status=blocked", GetReferralInvitations)
	assert.Contains(t, recorder.Body.String(), `"total":1`)
	recorder = invoke(9999, http.MethodGet, "/api/user/referrals?p=1&page_size=20&status=refunded", GetReferralInvitations)
	assert.Contains(t, recorder.Body.String(), `"total":1`, "the reversed state is a filterable outcome")
	recorder = invoke(9999, http.MethodGet, "/api/user/referrals?p=1&page_size=20&status=unknown", GetReferralInvitations)
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	recorder = invoke(9999, http.MethodGet, "/api/user/referrals?p=1&page_size=20&source=unknown", GetReferralInvitations)
	assert.Contains(t, recorder.Body.String(), `"success":false`)

	recorder = invoke(9999, http.MethodGet, "/api/user/referrals/export?status=blocked", ExportReferralInvitations)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "text/csv; charset=utf-8", recorder.Header().Get("Content-Type"))
	assert.Contains(t, recorder.Header().Get("Content-Disposition"), "referral-invitations.csv")
	csvLines := strings.Split(strings.TrimSpace(strings.TrimPrefix(recorder.Body.String(), "\xEF\xBB\xBF")), "\n")
	require.Len(t, csvLines, 2)
	header := strings.Split(strings.TrimSpace(csvLines[0]), ",")
	row := strings.Split(strings.TrimSpace(csvLines[1]), ",")
	require.Len(t, row, len(header))
	assert.Equal(t,
		[]string{
			"invitee_id", "username", "email", "display_name", "inviter_id", "inviter_username",
			"source", "bound_at", "commission_ends_at",
			"pending_quota", "locked_quota", "settled_quota",
			"review_quota", "blocked_quota", "rejected_quota", "refunded_quota",
			"total_paid_quota", "commission_count",
		},
		header)
	assert.Equal(t, strconv.Itoa(invitee.Id), row[0])
	assert.Equal(t, "stats-invitee", row[1])
	assert.Equal(t, model.ReferralSourceLink, row[6])
	assert.Equal(t, "500000", row[9])
	assert.Equal(t, "200000", row[13])
	assert.Equal(t, "300000", row[15], "the reversed commission keeps its recorded amount")

	var stored model.User
	require.NoError(t, db.First(&stored, inviter.Id).Error)
	assert.EqualValues(t, 12345, stored.Quota, "the read-only statistics never move a balance")
}

// TestReferralAgentAdminEndpoints pins the RF-08 administrator surface: the
// agent mark (tier and/or single-account rate override), its validation, the
// paginated agent list with the tier catalogue and the caller's own profile,
// each audited with the target context.
func TestReferralAgentAdminEndpoints(t *testing.T) {
	db := setupManageUserTestDB(t)
	createQuotaTestOperator(t, db, common.RoleRootUser)
	previousReferralSetting := *operation_setting.GetReferralSetting()
	*operation_setting.GetReferralSetting() = operation_setting.ReferralSetting{
		Enabled:               true,
		CommissionRatePercent: 20,
		WindowMonths:          operation_setting.ReferralWindowMonthsDefault,
		AgentTiers: []operation_setting.ReferralAgentTier{
			{Id: "partner", Name: "Partner", RatePercent: 40},
		},
	}
	t.Cleanup(func() { *operation_setting.GetReferralSetting() = previousReferralSetting })

	inviter := model.User{Username: "agent-inviter", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AffCode: "agent-inviter-aff"}
	require.NoError(t, db.Create(&inviter).Error)

	invoke := func(method, path, body string, params gin.Params, id int, handler gin.HandlerFunc) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(method, path, strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Params = params
		c.Set("id", id)
		c.Set("role", common.RoleRootUser)
		c.Set("username", "root-operator")
		handler(c)
		return recorder
	}
	userParams := func(id int) gin.Params {
		return gin.Params{{Key: "id", Value: strconv.Itoa(id)}}
	}

	// The caller's own profile before the mark: single-level, inheriting the
	// global default.
	recorder := invoke(http.MethodGet, "/api/user/self/referral-agent", "", nil, inviter.Id, GetSelfReferralAgent)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	assert.Contains(t, recorder.Body.String(), `"marked":false`)
	assert.Contains(t, recorder.Body.String(), `"rate_percent":20`)
	assert.Contains(t, recorder.Body.String(), `"rate_source":"default"`)

	// Validation failures keep the mark unset.
	recorder = invoke(http.MethodPut, fmt.Sprintf("/api/user/%d/referral-agent", inviter.Id), `{"tier_id":"missing"}`, userParams(inviter.Id), 9999, SetUserReferralAgent)
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	assert.Contains(t, recorder.Body.String(), "Unknown referral agent tier")
	recorder = invoke(http.MethodPut, fmt.Sprintf("/api/user/%d/referral-agent", inviter.Id), `{"rate_percent":150}`, userParams(inviter.Id), 9999, SetUserReferralAgent)
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	assert.Contains(t, recorder.Body.String(), "Referral agent rate must be between 0 and 100")
	agent, err := model.GetReferralAgent(inviter.Id)
	require.NoError(t, err)
	assert.Nil(t, agent)

	// Marking with a tier and one single-account override.
	recorder = invoke(http.MethodPut, fmt.Sprintf("/api/user/%d/referral-agent", inviter.Id), `{"tier_id":"partner","rate_percent":55,"note":"top partner"}`, userParams(inviter.Id), 9999, SetUserReferralAgent)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	assert.Contains(t, recorder.Body.String(), "Referral agent updated")
	agent, err = model.GetReferralAgent(inviter.Id)
	require.NoError(t, err)
	require.NotNil(t, agent)
	assert.Equal(t, "partner", agent.TierId)
	require.NotNil(t, agent.RatePercent)
	assert.Equal(t, 55.0, *agent.RatePercent)
	assert.Equal(t, "top partner", agent.Note)
	assert.Equal(t, 9999, agent.MarkedBy)

	// The caller's profile reflects the mark and its winning source.
	recorder = invoke(http.MethodGet, "/api/user/self/referral-agent", "", nil, inviter.Id, GetSelfReferralAgent)
	assert.Contains(t, recorder.Body.String(), `"marked":true`)
	assert.Contains(t, recorder.Body.String(), `"tier_name":"Partner"`)
	assert.Contains(t, recorder.Body.String(), `"rate_percent":55`)
	assert.Contains(t, recorder.Body.String(), `"rate_source":"user"`)

	// The administrator list carries the account context, the effective rate
	// and the configured tier catalogue.
	recorder = invoke(http.MethodGet, "/api/user/referral/agents?p=1&page_size=10", "", nil, 9999, GetReferralAgents)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	assert.Contains(t, recorder.Body.String(), `"username":"agent-inviter"`)
	assert.Contains(t, recorder.Body.String(), `"effective_rate_percent":55`)
	assert.Contains(t, recorder.Body.String(), `"rate_source":"user"`)
	assert.Contains(t, recorder.Body.String(), `"tier_name":"Partner"`)
	assert.Contains(t, recorder.Body.String(), `"tiers":[{"id":"partner","name":"Partner","rate_percent":40}]`)

	// Clearing the mark restores the inherited configuration.
	recorder = invoke(http.MethodDelete, fmt.Sprintf("/api/user/%d/referral-agent", inviter.Id), "", userParams(inviter.Id), 9999, ClearUserReferralAgent)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	assert.Contains(t, recorder.Body.String(), "Referral agent cleared")
	agent, err = model.GetReferralAgent(inviter.Id)
	require.NoError(t, err)
	assert.Nil(t, agent)

	// Both changes are audited exactly once with the target context.
	var agentAudits []model.AuditLog
	require.NoError(t, model.LOG_DB.Where("action = ?", "user.referral_agent").Find(&agentAudits).Error)
	require.Len(t, agentAudits, 1)
	assert.Equal(t, "Updated the referral agent settings of user agent-inviter", agentAudits[0].Content)
	assert.Equal(t, 9999, agentAudits[0].UserId)
	assert.Equal(t, "root-operator", agentAudits[0].Username)
	agentParams, err := common.Marshal(agentAudits[0].Other.Op.Params)
	require.NoError(t, err)
	assert.Contains(t, string(agentParams), `"tier_id":"partner"`)
	assert.Contains(t, string(agentParams), `"rate_percent":55`)

	var clearAudits []model.AuditLog
	require.NoError(t, model.LOG_DB.Where("action = ?", "user.referral_agent_clear").Find(&clearAudits).Error)
	require.Len(t, clearAudits, 1)
	assert.Equal(t, "Cleared the referral agent mark of user agent-inviter", clearAudits[0].Content)

	// The self route refuses an unauthenticated caller.
	recorder = invoke(http.MethodGet, "/api/user/self/referral-agent", "", nil, 0, GetSelfReferralAgent)
	assert.Contains(t, recorder.Body.String(), `"success":false`)
}
