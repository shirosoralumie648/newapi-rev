package router

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestListModelsSupportsOpenAIAndGeminiAuthentication(t *testing.T) {
	setupRelayRouterTestDB(t)

	user := model.User{
		Username: "models-user",
		Status:   common.UserStatusEnabled,
		Group:    "default",
		Quota:    100,
	}
	require.NoError(t, model.DB.Create(&user).Error)
	require.NoError(t, model.DB.Create(&model.Token{
		UserId:         user.Id,
		Key:            "modelstestkey",
		Status:         common.TokenStatusEnabled,
		ExpiredTime:    -1,
		UnlimitedQuota: true,
	}).Error)

	engine := gin.New()
	SetRelayRouter(engine)

	tests := []struct {
		name           string
		path           string
		headerName     string
		expectedObject string
		expectedField  string
	}{
		{
			name:           "OpenAI bearer token",
			path:           "/v1/models",
			headerName:     "Authorization",
			expectedObject: "list",
			expectedField:  "data",
		},
		{
			name:          "Gemini API key header",
			path:          "/v1/models",
			headerName:    "x-goog-api-key",
			expectedField: "models",
		},
		{
			name:          "Gemini API key query",
			path:          "/v1/models?key=modelstestkey",
			expectedField: "models",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			if test.headerName != "" {
				value := "modelstestkey"
				if test.headerName == "Authorization" {
					value = "Bearer " + value
				}
				request.Header.Set(test.headerName, value)
			}

			engine.ServeHTTP(recorder, request)

			require.Equal(t, http.StatusOK, recorder.Code)
			var payload map[string]any
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
			assert.Contains(t, payload, test.expectedField)
			assert.NotContains(t, payload, "error")
			if test.expectedObject != "" {
				assert.Equal(t, test.expectedObject, payload["object"])
			}
		})
	}
}

// TestMidjourneyImageAccessControl covers the accepted proofs of
// GET /mj/image/:id: authentication with task ownership, signed links, and the
// legacy open mode.
func TestMidjourneyImageAccessControl(t *testing.T) {
	setupRelayRouterTestDB(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Midjourney{}))

	// The handler fetches the forwarded image; production initializes this
	// client in main, so the route test must build it too.
	service.InitHttpClient()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("image-bytes"))
	}))
	t.Cleanup(upstream.Close)

	fetchSetting := system_setting.GetFetchSetting()
	originalFetchSetting := *fetchSetting
	fetchSetting.EnableSSRFProtection = false
	t.Cleanup(func() { *fetchSetting = originalFetchSetting })

	originalAccessMode := setting.MjImageAccessMode
	t.Cleanup(func() { setting.MjImageAccessMode = originalAccessMode })

	owner := model.User{Username: "mj-image-owner", Status: common.UserStatusEnabled, Group: "default", Quota: 100}
	require.NoError(t, model.DB.Create(&owner).Error)
	stranger := model.User{Username: "mj-image-stranger", Status: common.UserStatusEnabled, Group: "default", Quota: 100}
	require.NoError(t, model.DB.Create(&stranger).Error)
	admin := model.User{Username: "mj-image-admin", Status: common.UserStatusEnabled, Group: "default", Quota: 100, Role: common.RoleAdminUser}
	require.NoError(t, model.DB.Create(&admin).Error)

	ownerToken, strangerToken, adminToken := "mjimageownertoken", "mjimagestrangerkey", "mjimageadmintoken"
	for userId, key := range map[int]string{
		owner.Id:    ownerToken,
		stranger.Id: strangerToken,
		admin.Id:    adminToken,
	} {
		require.NoError(t, model.DB.Create(&model.Token{
			UserId:         userId,
			Key:            key,
			Status:         common.TokenStatusEnabled,
			ExpiredTime:    -1,
			UnlimitedQuota: true,
		}).Error)
	}

	require.NoError(t, model.DB.Create(&model.Midjourney{
		UserId:   owner.Id,
		MjId:     "mj-image-task",
		Status:   "SUCCESS",
		ImageUrl: upstream.URL + "/owner.png",
	}).Error)
	require.NoError(t, model.DB.Create(&model.Midjourney{
		UserId:   stranger.Id,
		MjId:     "mj-image-stranger-task",
		Status:   "SUCCESS",
		ImageUrl: upstream.URL + "/stranger.png",
	}).Error)

	signature, expiresAt, err := service.SignMjImageLink("mj-image-task")
	require.NoError(t, err)
	expiry := strconv.FormatInt(expiresAt, 10)
	tamperedSignature := signature[:len(signature)-1]
	if strings.HasSuffix(signature, "A") {
		tamperedSignature += "B"
	} else {
		tamperedSignature += "A"
	}

	engine := gin.New()
	SetRelayRouter(engine)

	tests := []struct {
		name         string
		mode         string
		path         string
		token        string
		wantStatus   int
		wantsImage   bool
		wantsMissing bool
	}{
		{
			name:       "anonymous requests need a credential",
			mode:       setting.MjImageAccessAuth,
			path:       "/mj/image/mj-image-task",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "the task owner may load the image",
			mode:       setting.MjImageAccessAuth,
			path:       "/mj/image/mj-image-task",
			token:      ownerToken,
			wantStatus: http.StatusOK,
			wantsImage: true,
		},
		{
			name:         "another user cannot load the image",
			mode:         setting.MjImageAccessAuth,
			path:         "/mj/image/mj-image-task",
			token:        strangerToken,
			wantStatus:   http.StatusNotFound,
			wantsMissing: true,
		},
		{
			name:       "an administrator may load any image",
			mode:       setting.MjImageAccessAuth,
			path:       "/mj/image/mj-image-task",
			token:      adminToken,
			wantStatus: http.StatusOK,
			wantsImage: true,
		},
		{
			name:         "an unknown task looks the same as a foreign task",
			mode:         setting.MjImageAccessAuth,
			path:         "/mj/image/mj-image-unknown",
			token:        ownerToken,
			wantStatus:   http.StatusNotFound,
			wantsMissing: true,
		},
		{
			name:       "a signed link does not bypass authentication",
			mode:       setting.MjImageAccessAuth,
			path:       "/mj/image/mj-image-task?sig=" + signature + "&exp=" + expiry,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "a valid signature grants anonymous access",
			mode:       setting.MjImageAccessSigned,
			path:       "/mj/image/mj-image-task?sig=" + signature + "&exp=" + expiry,
			wantStatus: http.StatusOK,
			wantsImage: true,
		},
		{
			name:       "a signature is bound to one task",
			mode:       setting.MjImageAccessSigned,
			path:       "/mj/image/mj-image-stranger-task?sig=" + signature + "&exp=" + expiry,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "an expired signature is rejected",
			mode:       setting.MjImageAccessSigned,
			path:       "/mj/image/mj-image-task?sig=" + signature + "&exp=" + strconv.FormatInt(expiresAt-7200, 10),
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "a tampered signature is rejected",
			mode:       setting.MjImageAccessSigned,
			path:       "/mj/image/mj-image-task?sig=" + tamperedSignature + "&exp=" + expiry,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "signed mode still accepts a token",
			mode:       setting.MjImageAccessSigned,
			path:       "/mj/image/mj-image-task",
			token:      ownerToken,
			wantStatus: http.StatusOK,
			wantsImage: true,
		},
		{
			name:       "a signature needs no token",
			mode:       setting.MjImageAccessSigned,
			path:       "/mj/image/mj-image-task?sig=" + signature + "&exp=" + expiry,
			token:      strangerToken,
			wantStatus: http.StatusOK,
			wantsImage: true,
		},
		{
			name:       "legacy mode keeps anonymous access",
			mode:       setting.MjImageAccessLegacy,
			path:       "/mj/image/mj-image-task",
			wantStatus: http.StatusOK,
			wantsImage: true,
		},
		{
			name:       "an unknown mode falls back to authentication",
			mode:       "unexpected",
			path:       "/mj/image/mj-image-task",
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			setting.MjImageAccessMode = test.mode
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			if test.token != "" {
				request.Header.Set("Authorization", "Bearer "+test.token)
			}

			engine.ServeHTTP(recorder, request)

			require.Equal(t, test.wantStatus, recorder.Code)
			switch {
			case test.wantsImage:
				assert.Equal(t, "image-bytes", recorder.Body.String())
				assert.Equal(t, "image/png", recorder.Header().Get("Content-Type"))
			case test.wantsMissing:
				assert.JSONEq(t, `{"error":"midjourney_task_not_found"}`, recorder.Body.String())
			}
		})
	}
}

// TestMjImageAccessModeOptionRoundTrip covers the admin option that selects the
// access mode and its fail-closed normalization.
func TestMjImageAccessModeOptionRoundTrip(t *testing.T) {
	setupRelayRouterTestDB(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Option{}))

	originalAccessMode := setting.MjImageAccessMode
	t.Cleanup(func() { setting.MjImageAccessMode = originalAccessMode })

	require.NoError(t, model.UpdateOption("MjImageAccessMode", setting.MjImageAccessLegacy))
	require.Equal(t, setting.MjImageAccessLegacy, setting.MjImageAccessMode)

	require.NoError(t, model.UpdateOption("MjImageAccessMode", "unexpected"))
	require.Equal(t, setting.MjImageAccessAuth, setting.MjImageAccessMode)
}

func setupRelayRouterTestDB(t *testing.T) {
	t.Helper()

	gin.SetMode(gin.TestMode)
	originalIsMasterNode := common.IsMasterNode
	originalRedisEnabled := common.RedisEnabled
	originalSQLitePath := common.SQLitePath
	originalMainDatabaseType := common.MainDatabaseType()
	originalLogDatabaseType := common.LogDatabaseType()
	originalSQLDSN, hadSQLDSN := os.LookupEnv("SQL_DSN")

	common.IsMasterNode = false
	common.RedisEnabled = false
	common.SQLitePath = fmt.Sprintf("file:%s?mode=memory&cache=shared", strings.ReplaceAll(t.Name(), "/", "_"))
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	require.NoError(t, os.Setenv("SQL_DSN", "local"))
	require.NoError(t, model.InitDB())
	model.LOG_DB = model.DB
	require.NoError(t, model.DB.AutoMigrate(&model.User{}, &model.Token{}, &model.Ability{}))

	t.Cleanup(func() {
		if sqlDB, err := model.DB.DB(); err == nil {
			_ = sqlDB.Close()
		}
		common.IsMasterNode = originalIsMasterNode
		common.RedisEnabled = originalRedisEnabled
		common.SQLitePath = originalSQLitePath
		common.SetDatabaseTypes(originalMainDatabaseType, originalLogDatabaseType)
		if hadSQLDSN {
			require.NoError(t, os.Setenv("SQL_DSN", originalSQLDSN))
		} else {
			require.NoError(t, os.Unsetenv("SQL_DSN"))
		}
	})
}
