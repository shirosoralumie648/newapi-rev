package router

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
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

// TestClaudeTokenCountingEndpointRequiresAuthAndAvailableModel covers the
// restored POST /v1/messages/count_tokens route: the parent middleware keeps
// enforcing the token and model availability, while the handler answers from
// the request body alone (no channel call, no billing).
func TestClaudeTokenCountingEndpointRequiresAuthAndAvailableModel(t *testing.T) {
	setupRelayRouterTestDB(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Ability{}, &model.Log{}))

	user := model.User{
		Username: "count-tokens-user",
		AffCode:  "count-tokens-user",
		Status:   common.UserStatusEnabled,
		Group:    "default",
		Quota:    100,
	}
	require.NoError(t, model.DB.Create(&user).Error)

	const tokenKey = "claudecounttokenskey"
	require.NoError(t, model.DB.Create(&model.Token{
		UserId:         user.Id,
		Key:            tokenKey,
		Status:         common.TokenStatusEnabled,
		ExpiredTime:    -1,
		UnlimitedQuota: true,
	}).Error)

	channel := model.Channel{
		Name:   "count-tokens-channel",
		Type:   constant.ChannelTypeAnthropic,
		Key:    "sk-count-tokens",
		Status: common.ChannelStatusEnabled,
		Models: "count-tokens-model",
		Group:  "default",
	}
	require.NoError(t, model.DB.Create(&channel).Error)
	require.NoError(t, model.DB.Create(&model.Ability{
		ChannelId: channel.Id,
		Model:     "count-tokens-model",
		Group:     "default",
		Enabled:   true,
	}).Error)

	engine := gin.New()
	SetRelayRouter(engine)

	post := func(t *testing.T, body string, token string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		engine.ServeHTTP(recorder, request)
		return recorder
	}

	t.Run("anonymous callers are rejected", func(t *testing.T) {
		recorder := post(t, `{"model":"count-tokens-model","messages":[{"role":"user","content":"count this prompt"}]}`, "")
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
	})

	t.Run("models without a channel fail the availability check", func(t *testing.T) {
		recorder := post(t, `{"model":"count-tokens-missing","messages":[{"role":"user","content":"count this prompt"}]}`, tokenKey)
		require.Equal(t, http.StatusServiceUnavailable, recorder.Code)
	})

	t.Run("available models are counted locally without billing", func(t *testing.T) {
		recorder := post(t, `{
			"model":"count-tokens-model",
			"messages":[{"role":"user","content":"count this prompt"}],
			"tools":[{"name":"lookup","description":"Look up a value","input_schema":{"type":"object","properties":{"query":{"type":"string"}}}}]
		}`, tokenKey)
		require.Equal(t, http.StatusOK, recorder.Code)

		var response struct {
			InputTokens int `json:"input_tokens"`
		}
		require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
		assert.Positive(t, response.InputTokens)

		var stored model.User
		require.NoError(t, model.DB.First(&stored, user.Id).Error)
		assert.Equal(t, 100, stored.Quota, "the local estimate never consumes quota")

		var consumeLogs int64
		require.NoError(t, model.LOG_DB.Model(&model.Log{}).Where("user_id = ?", user.Id).Count(&consumeLogs).Error)
		assert.Zero(t, consumeLogs, "the local estimate writes no consume log")
	})
}

// TestPlaygroundProtocolBridgeBillsThroughRelay proves a workspace Messages
// request runs the ordinary relay pipeline: the upstream receives the canonical
// /v1/messages path, the caller's quota is settled and a consume log is written.
func TestPlaygroundProtocolBridgeBillsThroughRelay(t *testing.T) {
	setupRelayRouterTestDB(t)
	require.NoError(t, model.DB.AutoMigrate(
		&model.Channel{}, &model.Ability{}, &model.Log{}, &model.UserSession{},
		// The relay bills through the ordinary subscription/wallet pipeline,
		// which reads the subscription and wallet accounting tables.
		&model.UserSubscription{},
		&model.WalletHold{}, &model.WalletHoldGrant{}, &model.WalletDebt{},
		&model.CreditGrant{}, &model.WalletLedgerEntry{},
	))
	ratio_setting.InitRatioSettings()

	upstreamPaths := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamPaths <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"msg_pg","type":"message","role":"assistant","model":"claude-3-5-sonnet-20241022","content":[{"type":"text","text":"hello from upstream"}],"stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":4}}`))
	}))
	defer upstream.Close()

	user := model.User{
		Username:    "playground-messages-user",
		AffCode:     "playground-messages-user",
		Status:      common.UserStatusEnabled,
		Group:       "default",
		Quota:       1_000_000,
		AuthVersion: 1,
	}
	require.NoError(t, model.DB.Create(&user).Error)

	secret := common.SessionSecret
	common.SessionSecret = "playground-messages-billing-test"
	t.Cleanup(func() { common.SessionSecret = secret })
	now := time.Now().Unix()
	sid, err := common.GenerateRandomCharsKey(32)
	require.NoError(t, err)
	session := model.UserSession{SID: sid, UserID: user.Id, Version: 1, UserAuthVersion: 1, Status: model.UserSessionStatusActive,
		RefreshHash: "unused-test-refresh-hash", LoginMethod: "password", LastActiveAt: now, ExpiresAt: now + 3600}
	require.NoError(t, model.CreateUserSession(&session))
	accessToken, _, err := service.IssueAccessToken(service.AuthIdentity{UserID: user.Id, SessionID: session.SID, UserAuthVersion: 1, SessionVersion: 1})
	require.NoError(t, err)

	baseURL := upstream.URL
	channel := model.Channel{
		Name:    "playground-messages-channel",
		Type:    constant.ChannelTypeAnthropic,
		Key:     "sk-playground-messages",
		Status:  common.ChannelStatusEnabled,
		Models:  "claude-3-5-sonnet-20241022",
		Group:   "default",
		BaseURL: &baseURL,
	}
	require.NoError(t, model.DB.Create(&channel).Error)
	require.NoError(t, model.DB.Create(&model.Ability{
		ChannelId: channel.Id,
		Model:     "claude-3-5-sonnet-20241022",
		Group:     "default",
		Enabled:   true,
	}).Error)

	engine := gin.New()
	SetRelayRouter(engine)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/pg/messages", strings.NewReader(
		`{"model":"claude-3-5-sonnet-20241022","max_tokens":32,"messages":[{"role":"user","content":"hello"}],"stream":false}`,
	))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+accessToken)
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	assert.Contains(t, recorder.Body.String(), "hello from upstream")
	select {
	case path := <-upstreamPaths:
		assert.Equal(t, "/v1/messages", path)
	default:
		t.Fatal("the relay did not call the upstream channel")
	}

	var stored model.User
	require.NoError(t, model.DB.First(&stored, user.Id).Error)
	assert.Less(t, stored.Quota, 1_000_000, "the reply is billed through the ordinary relay pipeline")

	var consumeLogs int64
	require.NoError(t, model.LOG_DB.Model(&model.Log{}).Where("user_id = ?", user.Id).Count(&consumeLogs).Error)
	assert.EqualValues(t, 1, consumeLogs)
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

	// users.aff_code carries a unique index, so every fixture user needs its own
	// code; an empty one only fits the first row.
	owner := model.User{Username: "mj-image-owner", AffCode: "mj-image-owner", Status: common.UserStatusEnabled, Group: "default", Quota: 100}
	require.NoError(t, model.DB.Create(&owner).Error)
	stranger := model.User{Username: "mj-image-stranger", AffCode: "mj-image-stranger", Status: common.UserStatusEnabled, Group: "default", Quota: 100}
	require.NoError(t, model.DB.Create(&stranger).Error)
	admin := model.User{Username: "mj-image-admin", AffCode: "mj-image-admin", Status: common.UserStatusEnabled, Group: "default", Quota: 100, Role: common.RoleAdminUser}
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
	// UpdateOption publishes the normalized mode through common.OptionMap, which
	// production initializes in model.InitOptionMap.
	originalOptionMap := common.OptionMap
	common.OptionMap = map[string]string{}
	t.Cleanup(func() { common.OptionMap = originalOptionMap })

	require.NoError(t, model.UpdateOption("MjImageAccessMode", setting.MjImageAccessLegacy))
	require.Equal(t, setting.MjImageAccessLegacy, setting.MjImageAccessMode)
	require.Equal(t, setting.MjImageAccessLegacy, common.OptionMap["MjImageAccessMode"])

	require.NoError(t, model.UpdateOption("MjImageAccessMode", "unexpected"))
	require.Equal(t, setting.MjImageAccessAuth, setting.MjImageAccessMode)
	require.Equal(t, setting.MjImageAccessAuth, common.OptionMap["MjImageAccessMode"])
}

func setupRelayRouterTestDB(t *testing.T) {
	t.Helper()

	// Distributor errors localize their messages with i18n; an uninitialized
	// bundle panics inside the localizer.
	require.NoError(t, i18n.Init())
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
