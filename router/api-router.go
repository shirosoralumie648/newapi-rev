package router

import (
	"net/http"

	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/service/authz"

	// Import oauth package to register providers via init()
	_ "github.com/QuantumNous/new-api/oauth"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
)

func SetApiRouter(router *gin.Engine) {
	apiRouter := router.Group("/api")
	apiRouter.Use(middleware.RouteTag("api"))
	apiRouter.Use(gzip.Gzip(gzip.DefaultCompression))
	apiRouter.Use(middleware.AccessTokenAudit())
	apiRouter.Use(middleware.BodyStorageCleanup()) // 清理请求体存储
	apiRouter.Use(middleware.GlobalAPIRateLimit())
	anonymousRequestBodyLimit := middleware.AnonymousRequestBodyLimit()
	{
		apiRouter.GET("/setup", controller.GetSetup)
		apiRouter.POST("/setup", anonymousRequestBodyLimit, controller.PostSetup)
		apiRouter.GET("/status", controller.GetStatus)
		apiRouter.GET("/uptime/status", controller.GetUptimeKumaStatus)
		apiRouter.GET("/models", middleware.UserAuth(), controller.DashboardListModels)
		apiRouter.GET("/status/test", middleware.AdminAuth(), controller.TestStatus)
		apiRouter.GET("/notice", controller.GetNotice)
		apiRouter.GET("/user-agreement", controller.GetUserAgreement)
		apiRouter.GET("/privacy-policy", controller.GetPrivacyPolicy)
		apiRouter.GET("/about", controller.GetAbout)
		//apiRouter.GET("/midjourney", controller.GetMidjourney)
		apiRouter.GET("/home_page_content", controller.GetHomePageContent)
		apiRouter.GET("/pricing", middleware.HeaderNavModuleAuth("pricing"), controller.GetPricing)
		perfMetricsRoute := apiRouter.Group("/perf-metrics")
		perfMetricsRoute.Use(middleware.HeaderNavModulePublicOrUserAuth("pricing"))
		{
			perfMetricsRoute.GET("/summary", controller.GetPerfMetricsSummary)
			perfMetricsRoute.GET("", controller.GetPerfMetrics)
		}
		apiRouter.GET("/rankings", middleware.HeaderNavModuleAuth("rankings"), controller.GetRankings)
		apiRouter.GET("/verification", middleware.EmailVerificationRateLimit(), middleware.TurnstileCheck(), controller.SendEmailVerification)
		apiRouter.GET("/reset_password", middleware.CriticalRateLimit(), middleware.TurnstileCheck(), controller.SendPasswordResetEmail)
		apiRouter.POST("/user/reset", middleware.CriticalRateLimit(), anonymousRequestBodyLimit, controller.ResetPassword)
		// OAuth routes - specific routes must come before :provider wildcard
		apiRouter.POST("/oauth/state", middleware.CriticalRateLimit(), middleware.DisableCache(), middleware.TryUserAuth(), anonymousRequestBodyLimit, controller.GenerateOAuthCode)
		apiRouter.POST("/oauth/email/bind/start", middleware.UserAuth(), middleware.CriticalRateLimit(), middleware.UserCriticalRateLimit("account-security"), middleware.EmailVerificationRateLimit(), middleware.DisableCache(), controller.EmailBindStart)
		apiRouter.POST("/oauth/email/bind/resend", middleware.UserAuth(), middleware.CriticalRateLimit(), middleware.UserCriticalRateLimit("account-security"), middleware.EmailVerificationRateLimit(), middleware.DisableCache(), controller.EmailBindResend)
		apiRouter.POST("/oauth/email/bind", middleware.UserAuth(), middleware.CriticalRateLimit(), middleware.UserCriticalRateLimit("account-security"), middleware.DisableCache(), controller.EmailBind)
		// WeChat uses its existing authorization-code service.
		apiRouter.GET("/oauth/wechat", middleware.CriticalRateLimit(), middleware.DisableCache(), controller.WeChatAuth)
		apiRouter.POST("/oauth/wechat/bind", middleware.UserAuth(), middleware.CriticalRateLimit(), controller.WeChatBind)
		apiRouter.GET("/oauth/telegram/login", middleware.CriticalRateLimit(), middleware.DisableCache(), controller.TelegramLegacyAuth)
		apiRouter.POST("/oauth/telegram/bind/start", middleware.UserAuth(), middleware.CriticalRateLimit(), middleware.DisableCache(), controller.TelegramLegacyAuth)
		apiRouter.GET("/oauth/telegram/bind/:flow_token", middleware.CriticalRateLimit(), middleware.DisableCache(), controller.TelegramLegacyAuth)
		// Standard OAuth providers (GitHub, Discord, OIDC, LinuxDO, Telegram) - unified route
		apiRouter.GET("/oauth/:provider", middleware.CriticalRateLimit(), middleware.DisableCache(), middleware.TryUserAuth(), controller.HandleOAuth)
		apiRouter.GET("/ratio_config", middleware.CriticalRateLimit(), controller.GetRatioConfig)

		apiRouter.POST("/stripe/webhook", anonymousRequestBodyLimit, controller.StripeWebhook)
		apiRouter.POST("/creem/webhook", anonymousRequestBodyLimit, controller.CreemWebhook)
		apiRouter.POST("/waffo/webhook", anonymousRequestBodyLimit, controller.WaffoWebhook)
		// :env separates test vs prod URLs so the operator can register each
		// in Pancake's matching webhook slot; handler enforces env match.
		apiRouter.POST("/waffo-pancake/webhook/:env", anonymousRequestBodyLimit, controller.WaffoPancakeWebhook)

		// Universal secure verification routes
		apiRouter.GET("/verify/methods", middleware.UserAuth(), middleware.DisableCache(), controller.GetVerificationMethods)
		apiRouter.POST("/verify", middleware.UserAuth(), middleware.CriticalRateLimit(), middleware.UserCriticalRateLimit("security-verification"), middleware.DisableCache(), controller.UniversalVerify)

		// A public share link is anonymous and read-only. It is registered
		// outside the authenticated /playground group; the handler still
		// validates the token hash on every request and returns one identical
		// 404 for revoked, expired and unknown links.
		apiRouter.GET("/playground/shared/:token", middleware.CriticalRateLimit(), middleware.DisableCache(), controller.GetSharedPlaygroundSession)

		playgroundRoute := apiRouter.Group("/playground")
		playgroundRoute.Use(middleware.DisableCache(), middleware.UserAuth())
		{
			playgroundRoute.GET("/usage", controller.GetPlaygroundUsage)
			playgroundRoute.GET("/storage/billing", controller.GetPlaygroundStorageBilling)
			// One canvas workflow run may open a budget cap and settle it when
			// the run stops (BL-03).
			playgroundRoute.POST("/workflows/estimate", controller.PlaygroundWorkflowEstimate)
			playgroundRoute.POST("/workflows/runs", controller.PlaygroundWorkflowRunCreate)
			playgroundRoute.POST("/workflows/runs/:runId/settle", controller.PlaygroundWorkflowRunSettle)
			playgroundRoute.GET("/comparisons", controller.ListPlaygroundComparisonRuns)
			playgroundRoute.POST("/comparisons", controller.CreatePlaygroundComparisonRun)
			playgroundRoute.GET("/comparisons/:runId", controller.GetPlaygroundComparisonRun)
			playgroundRoute.PATCH("/comparisons/:runId", controller.UpdatePlaygroundComparisonRun)
			playgroundRoute.DELETE("/comparisons/:runId", controller.DeletePlaygroundComparisonRun)
			playgroundRoute.GET("/settings", controller.GetPlaygroundSettings)
			playgroundRoute.POST("/search", middleware.SearchRateLimit(), controller.PlaygroundWebSearch)
			playgroundRoute.GET("/message-costs", controller.GetPlaygroundMessageCosts)
			playgroundRoute.GET("/logs/:logRef/replay", controller.GetPlaygroundLogReplay)
			playgroundRoute.DELETE("/logs/:logRef/capture", controller.DeletePlaygroundLogCapture)
			playgroundRoute.GET("/trash", controller.ListPlaygroundTrash)
			playgroundRoute.GET("/assets", controller.ListPlaygroundAssets)
			playgroundRoute.POST("/tasks/:taskId/cancel", controller.PlaygroundTaskCancel)
			playgroundRoute.PUT("/tasks/:taskId/artifacts/:artifactKey/pin", controller.PlaygroundTaskArtifactPin)
			playgroundRoute.GET("/presets", controller.ListPlaygroundPresets)
			playgroundRoute.POST("/presets", controller.CreatePlaygroundPreset)
			playgroundRoute.GET("/presets/market", controller.ListPlaygroundPresetMarket)
			playgroundRoute.POST("/presets/market/:presetId/copy", controller.CopyPlaygroundPresetFromMarket)
			playgroundRoute.POST("/presets/import", controller.ImportPlaygroundPreset)
			playgroundRoute.GET("/presets/:presetId", controller.GetPlaygroundPreset)
			playgroundRoute.PATCH("/presets/:presetId", controller.UpdatePlaygroundPreset)
			playgroundRoute.DELETE("/presets/:presetId", controller.DeletePlaygroundPreset)
			playgroundRoute.GET("/presets/:presetId/export", controller.ExportPlaygroundPreset)
			playgroundRoute.GET("/presets/global", middleware.AdminAuth(), controller.ListGlobalPlaygroundPresets)
			playgroundRoute.POST("/presets/global", middleware.AdminAuth(), controller.CreateGlobalPlaygroundPreset)
			playgroundRoute.POST("/presets/global/import", middleware.AdminAuth(), controller.ImportGlobalPlaygroundPreset)
			playgroundRoute.GET("/presets/global/:presetId", middleware.AdminAuth(), controller.GetGlobalPlaygroundPreset)
			playgroundRoute.PATCH("/presets/global/:presetId", middleware.AdminAuth(), controller.UpdateGlobalPlaygroundPreset)
			playgroundRoute.DELETE("/presets/global/:presetId", middleware.AdminAuth(), controller.DeleteGlobalPlaygroundPreset)
			playgroundRoute.GET("/presets/global/:presetId/export", middleware.AdminAuth(), controller.ExportGlobalPlaygroundPreset)
			playgroundRoute.GET("/knowledge-bases", controller.ListPlaygroundKnowledgeBases)
			playgroundRoute.POST("/knowledge-bases", controller.CreatePlaygroundKnowledgeBase)
			playgroundRoute.GET("/knowledge-bases/:kbId", controller.GetPlaygroundKnowledgeBase)
			playgroundRoute.PATCH("/knowledge-bases/:kbId", controller.UpdatePlaygroundKnowledgeBase)
			playgroundRoute.DELETE("/knowledge-bases/:kbId", controller.DeletePlaygroundKnowledgeBase)
			playgroundRoute.GET("/knowledge-bases/:kbId/documents", controller.ListPlaygroundKnowledgeDocuments)
			playgroundRoute.POST("/knowledge-bases/:kbId/search", controller.SearchPlaygroundKnowledgeBase)
			playgroundRoute.POST("/knowledge-bases/:kbId/documents", controller.CreatePlaygroundKnowledgeDocument)
			playgroundRoute.GET("/knowledge-bases/:kbId/documents/:documentId", controller.GetPlaygroundKnowledgeDocument)
			playgroundRoute.DELETE("/knowledge-bases/:kbId/documents/:documentId", controller.DeletePlaygroundKnowledgeDocument)
			playgroundRoute.POST("/knowledge-bases/:kbId/documents/:documentId/reindex", controller.ReindexPlaygroundKnowledgeDocument)
			playgroundRoute.POST("/knowledge-bases/:kbId/documents/:documentId/failure", controller.FailPlaygroundKnowledgeDocument)
			playgroundRoute.PUT("/knowledge-bases/:kbId/documents/:documentId/chunks", controller.ReplacePlaygroundKnowledgeDocumentChunks)
			playgroundRoute.GET("/snippets", controller.ListPlaygroundSnippets)
			playgroundRoute.POST("/snippets", controller.CreatePlaygroundSnippet)
			playgroundRoute.GET("/snippets/:snippetId", controller.GetPlaygroundSnippet)
			playgroundRoute.PATCH("/snippets/:snippetId", controller.UpdatePlaygroundSnippet)
			playgroundRoute.DELETE("/snippets/:snippetId", controller.DeletePlaygroundSnippet)
			playgroundRoute.GET("/memories", controller.ListPlaygroundMemories)
			playgroundRoute.POST("/memories", controller.CreatePlaygroundMemory)
			playgroundRoute.GET("/memories/:memoryId", controller.GetPlaygroundMemory)
			playgroundRoute.PATCH("/memories/:memoryId", controller.UpdatePlaygroundMemory)
			playgroundRoute.DELETE("/memories/:memoryId", controller.DeletePlaygroundMemory)
			playgroundRoute.GET("/sessions", controller.ListPlaygroundSessions)
			playgroundRoute.POST("/sessions", controller.CreatePlaygroundSession)
			playgroundRoute.GET("/sessions/:id", controller.GetPlaygroundSession)
			playgroundRoute.PATCH("/sessions/:id", controller.UpdatePlaygroundSession)
			playgroundRoute.DELETE("/sessions/:id", controller.DeletePlaygroundSession)
			// A share link is revocable; creating a new one rotates (revokes)
			// the previous link because the plaintext is never stored.
			playgroundRoute.POST("/sessions/:id/share", controller.CreatePlaygroundSessionShare)
			playgroundRoute.DELETE("/sessions/:id/share", controller.DeletePlaygroundSessionShare)
			// The trash keeps a deleted conversation recoverable for the
			// configured window; export also works while it waits there.
			playgroundRoute.POST("/sessions/:id/restore", controller.RestorePlaygroundSession)
			playgroundRoute.GET("/sessions/:id/export", controller.ExportPlaygroundSession)
			playgroundRoute.GET("/sessions/:id/messages", controller.ListPlaygroundMessages)
			playgroundRoute.PATCH("/sessions/:id/messages", controller.ApplyPlaygroundMessagesDelta)
			// Deprecated compatibility shim: the full snapshot endpoint is kept for
			// one release and translated into incremental writes server-side.
			playgroundRoute.PUT("/sessions/:id/messages", controller.ReplacePlaygroundMessages)
			playgroundRoute.GET("/sessions/:id/artifacts", controller.ListPlaygroundArtifacts)
			playgroundRoute.POST("/sessions/:id/artifacts", controller.CreatePlaygroundArtifact)
			playgroundRoute.GET("/sessions/:id/artifacts/:artifactId", controller.GetPlaygroundArtifact)
			playgroundRoute.GET("/sessions/:id/artifacts/:artifactId/versions", controller.ListPlaygroundArtifactVersions)
			playgroundRoute.GET("/sessions/:id/artifacts/:artifactId/versions/:versionId", controller.GetPlaygroundArtifact)
			playgroundRoute.POST("/sessions/:id/artifacts/:artifactId/versions", controller.SavePlaygroundArtifactVersion)
			playgroundRoute.POST("/sessions/:id/artifacts/:artifactId/restore", controller.RestorePlaygroundArtifactVersion)
			playgroundRoute.DELETE("/sessions/:id/artifacts/:artifactId", controller.DeletePlaygroundArtifact)
			playgroundRoute.GET("/sessions/:id/attachments", controller.ListPlaygroundAttachments)
			playgroundRoute.POST("/sessions/:id/attachments", controller.CreatePlaygroundAttachment)
			playgroundRoute.GET("/sessions/:id/attachments/:attachmentId", controller.GetPlaygroundAttachment)
			playgroundRoute.GET("/sessions/:id/attachments/:attachmentId/content", controller.GetPlaygroundAttachmentContent)
			playgroundRoute.GET("/sessions/:id/attachments/:attachmentId/text", controller.GetPlaygroundAttachmentText)
			playgroundRoute.DELETE("/sessions/:id/attachments/:attachmentId", controller.DeletePlaygroundAttachment)
			playgroundRoute.GET("/canvases", controller.ListPlaygroundCanvasProjects)
			playgroundRoute.POST("/canvases", controller.CreatePlaygroundCanvasProject)
			// An import restores a canvas archive as a new board of the account.
			// It is registered next to the collection so the static segment is
			// matched before the parameterized canvas routes.
			playgroundRoute.POST("/canvases/import", controller.ImportPlaygroundCanvasArchive)
			playgroundRoute.GET("/canvases/:canvasId", controller.GetPlaygroundCanvasProject)
			playgroundRoute.PATCH("/canvases/:canvasId", controller.UpdatePlaygroundCanvasProject)
			playgroundRoute.DELETE("/canvases/:canvasId", controller.DeletePlaygroundCanvasProject)
			// Canvas links follow the conversation share contract: a new link
			// rotates the old one, and the anonymous route is the same.
			playgroundRoute.POST("/canvases/:canvasId/share", controller.CreatePlaygroundCanvasShare)
			playgroundRoute.DELETE("/canvases/:canvasId/share", controller.DeletePlaygroundCanvasShare)
			// A trashed canvas waits in the shared trash window and comes back
			// with its document, pins and counter share intact.
			playgroundRoute.POST("/canvases/:canvasId/restore", controller.RestorePlaygroundCanvasProject)
			// The board history: list stored snapshots and restore one as the
			// canvas document, keeping the replaced state as a snapshot too.
			playgroundRoute.GET("/canvases/:canvasId/snapshots", controller.ListPlaygroundCanvasSnapshots)
			playgroundRoute.POST("/canvases/:canvasId/snapshots/:snapshotId/restore", controller.RestorePlaygroundCanvasSnapshot)
			// The whole board, or the selected nodes, download as an archive
			// that carries the bytes of every referenced attachment.
			playgroundRoute.GET("/canvases/:canvasId/export", controller.ExportPlaygroundCanvasArchive)
			// A canvas owns its own attachment partition, so a file dropped on
			// the board is uploaded without inventing a conversation for it.
			playgroundRoute.POST("/canvases/:canvasId/attachments", controller.CreatePlaygroundCanvasAttachment)
			// Canvas templates are structure-level copies of a saved document
			// with optional inline attachment bytes. The collection routes stay
			// next to canvas routes; the static market/global segments are
			// registered before the parameterized template routes.
			playgroundRoute.GET("/canvas-templates", controller.ListPlaygroundCanvasTemplates)
			playgroundRoute.POST("/canvas-templates", controller.CreatePlaygroundCanvasTemplate)
			playgroundRoute.GET("/canvas-templates/market", controller.ListPlaygroundCanvasTemplateMarket)
			playgroundRoute.POST("/canvas-templates/market/:templateId/copy", controller.CopyPlaygroundCanvasTemplateFromMarket)
			playgroundRoute.POST("/canvas-templates/import", controller.ImportPlaygroundCanvasTemplate)
			playgroundRoute.GET("/canvas-templates/global", middleware.AdminAuth(), controller.ListGlobalPlaygroundCanvasTemplates)
			playgroundRoute.POST("/canvas-templates/global", middleware.AdminAuth(), controller.CreateGlobalPlaygroundCanvasTemplate)
			playgroundRoute.POST("/canvas-templates/global/import", middleware.AdminAuth(), controller.ImportGlobalPlaygroundCanvasTemplate)
			playgroundRoute.GET("/canvas-templates/global/:templateId", middleware.AdminAuth(), controller.GetGlobalPlaygroundCanvasTemplate)
			playgroundRoute.PATCH("/canvas-templates/global/:templateId", middleware.AdminAuth(), controller.UpdateGlobalPlaygroundCanvasTemplate)
			playgroundRoute.DELETE("/canvas-templates/global/:templateId", middleware.AdminAuth(), controller.DeleteGlobalPlaygroundCanvasTemplate)
			playgroundRoute.GET("/canvas-templates/global/:templateId/export", middleware.AdminAuth(), controller.ExportPlaygroundCanvasTemplate)
			playgroundRoute.GET("/canvas-templates/:templateId", controller.GetPlaygroundCanvasTemplate)
			playgroundRoute.PATCH("/canvas-templates/:templateId", controller.UpdatePlaygroundCanvasTemplate)
			playgroundRoute.DELETE("/canvas-templates/:templateId", controller.DeletePlaygroundCanvasTemplate)
			playgroundRoute.GET("/canvas-templates/:templateId/export", controller.ExportPlaygroundCanvasTemplate)
			playgroundRoute.GET("/canvas-templates/:templateId/assets/:assetId/content", controller.GetPlaygroundCanvasTemplateAssetContent)
			// Large files and the extended kinds (video, audio, PDF) upload in
			// two steps: a reservation returns a presigned PUT when the object
			// store can sign one (otherwise the content route relays the bytes),
			// and completing it verifies the stored object and stores the
			// attachment. Both partitions share these routes.
			playgroundRoute.POST("/uploads", controller.CreatePlaygroundUpload)
			playgroundRoute.PUT("/uploads/:uploadId/content", controller.PutPlaygroundUploadContent)
			playgroundRoute.POST("/uploads/:uploadId/complete", controller.CompletePlaygroundUpload)
			playgroundRoute.DELETE("/uploads/:uploadId", controller.DeletePlaygroundUpload)
		}

		userRoute := apiRouter.Group("/user")
		{
			userRoute.POST("/auth/refresh", middleware.SessionCookieOriginGuard(), middleware.CriticalRateLimit(), middleware.DisableCache(), controller.RefreshAuth)
			userRoute.POST("/auth/logout", middleware.SessionCookieOriginGuard(), middleware.CriticalRateLimit(), middleware.DisableCache(), controller.AuthLogout)
			userRoute.POST("/register", middleware.CriticalRateLimit(), anonymousRequestBodyLimit, middleware.TurnstileCheck(), controller.Register)
			userRoute.GET("/login/encryption-key", middleware.DisableCache(), controller.GetPasswordEncryptionKey)
			userRoute.POST("/login", middleware.CriticalRateLimit(), middleware.DisableCache(), anonymousRequestBodyLimit, middleware.TurnstileCheck(), controller.Login)
			userRoute.POST("/login/2fa", middleware.CriticalRateLimit(), middleware.DisableCache(), anonymousRequestBodyLimit, controller.Verify2FALogin)
			userRoute.POST("/login/verify", middleware.CriticalRateLimit(), middleware.DisableCache(), anonymousRequestBodyLimit, controller.VerifyLogin)
			userRoute.POST("/login/passkey/begin", middleware.CriticalRateLimit(), middleware.DisableCache(), anonymousRequestBodyLimit, controller.LoginPasskeyBegin)
			userRoute.POST("/login/passkey/finish", middleware.CriticalRateLimit(), middleware.DisableCache(), anonymousRequestBodyLimit, controller.LoginPasskeyFinish)
			userRoute.POST("/passkey/login/begin", middleware.CriticalRateLimit(), middleware.DisableCache(), anonymousRequestBodyLimit, controller.PasskeyLoginBegin)
			userRoute.POST("/passkey/login/finish", middleware.CriticalRateLimit(), middleware.DisableCache(), anonymousRequestBodyLimit, controller.PasskeyLoginFinish)
			//userRoute.POST("/tokenlog", middleware.CriticalRateLimit(), controller.TokenLog)
			userRoute.POST("/epay/notify", anonymousRequestBodyLimit, controller.EpayNotify)
			userRoute.GET("/epay/notify", controller.EpayNotify)
			userRoute.GET("/groups", controller.GetUserGroups)

			selfRoute := userRoute.Group("/")

			selfRoute.Use(middleware.DisableCache(), middleware.UserAuth())
			{
				selfRoute.GET("/sessions", middleware.DisableCache(), controller.GetLoginSessions)
				selfRoute.DELETE("/sessions/:sid", middleware.DisableCache(), controller.DeleteLoginSession)
				selfRoute.POST("/sessions/revoke-others", middleware.DisableCache(), controller.RevokeOtherLoginSessions)
				selfRoute.GET("/self/groups", controller.GetUserGroups)
				selfRoute.GET("/self", controller.GetSelf)
				selfRoute.GET("/models", controller.GetUserModels)
				selfRoute.PUT("/self", middleware.CriticalRateLimit(), middleware.DisableCache(), controller.UpdateSelf)
				selfRoute.DELETE("/self", middleware.DisableCache(), controller.DeleteSelf)
				accessTokenRoute := selfRoute.Group("/access_tokens")
				accessTokenRoute.Use(middleware.DisableCache())
				{
					accessTokenRoute.GET("", controller.ListAccessTokens)
					accessTokenRoute.GET("/catalog", controller.GetAccessTokenCatalog)
					accessTokenRoute.GET("/scopes", controller.GetAccessTokenScopes)
					accessTokenRoute.POST("", middleware.CriticalRateLimit(), middleware.UserCriticalRateLimit("access-token"), controller.CreateAccessToken)
					accessTokenRoute.PATCH("/:id", middleware.CriticalRateLimit(), middleware.UserCriticalRateLimit("access-token"), controller.UpdateAccessToken)
					accessTokenRoute.DELETE("/:id", middleware.CriticalRateLimit(), middleware.UserCriticalRateLimit("access-token"), controller.DeleteAccessToken)
					accessTokenRoute.DELETE("/legacy", middleware.CriticalRateLimit(), middleware.UserCriticalRateLimit("access-token"), controller.RevokeLegacyAccessToken)
				}
				selfRoute.GET("/passkey", controller.PasskeyStatus)
				selfRoute.POST("/passkey/register/begin", middleware.UserCriticalRateLimit("security-verification"), middleware.DisableCache(), controller.PasskeyRegisterBegin)
				selfRoute.POST("/passkey/register/finish", middleware.UserCriticalRateLimit("security-verification"), middleware.DisableCache(), controller.PasskeyRegisterFinish)
				selfRoute.POST("/passkey/verify/begin", middleware.UserCriticalRateLimit("security-verification"), middleware.DisableCache(), controller.PasskeyVerifyBegin)
				selfRoute.POST("/passkey/verify/finish", middleware.UserCriticalRateLimit("security-verification"), middleware.DisableCache(), controller.PasskeyVerifyFinish)
				selfRoute.DELETE("/passkey", middleware.DisableCache(), controller.PasskeyDelete)
				selfRoute.GET("/aff", controller.GetAffCode)
				selfRoute.GET("/topup/info", controller.GetTopUpInfo)
				selfRoute.GET("/topup/self", controller.GetUserTopUps)
				selfRoute.GET("/self/wallet/ledger", controller.GetSelfWalletLedger)
				selfRoute.GET("/self/wallet/ledger/export", controller.ExportSelfWalletLedger)
				selfRoute.GET("/self/wallet/grants", controller.GetSelfCreditGrantWallet)
				selfRoute.GET("/self/referrals", controller.GetSelfReferralInvitations)
				selfRoute.GET("/self/referral-agent", controller.GetSelfReferralAgent)
				selfRoute.POST("/topup", middleware.CriticalRateLimit(), controller.TopUp)
				selfRoute.POST("/pay", middleware.CriticalRateLimit(), controller.RequestEpay)
				selfRoute.POST("/amount", controller.RequestAmount)
				selfRoute.POST("/stripe/pay", middleware.CriticalRateLimit(), controller.RequestStripePay)
				selfRoute.POST("/stripe/amount", controller.RequestStripeAmount)
				selfRoute.POST("/creem/pay", middleware.CriticalRateLimit(), controller.RequestCreemPay)
				selfRoute.POST("/waffo/amount", controller.RequestWaffoAmount)
				selfRoute.POST("/waffo/pay", middleware.CriticalRateLimit(), controller.RequestWaffoPay)
				selfRoute.POST("/waffo-pancake/amount", controller.RequestWaffoPancakeAmount)
				selfRoute.POST("/waffo-pancake/pay", middleware.CriticalRateLimit(), controller.RequestWaffoPancakePay)
				selfRoute.POST("/aff_transfer", middleware.UserCriticalRateLimit("aff-transfer"), controller.TransferAffQuota)
				selfRoute.PUT("/setting", controller.UpdateUserSetting)

				// 2FA routes
				selfRoute.GET("/2fa/status", controller.Get2FAStatus)
				selfRoute.POST("/2fa/setup", middleware.UserCriticalRateLimit("security-verification"), middleware.DisableCache(), controller.Setup2FA)
				selfRoute.POST("/2fa/enable", middleware.UserCriticalRateLimit("security-verification"), middleware.DisableCache(), controller.Enable2FA)
				selfRoute.POST("/2fa/disable", middleware.DisableCache(), controller.Disable2FA)
				selfRoute.POST("/2fa/backup_codes", middleware.DisableCache(), controller.RegenerateBackupCodes)

				// Check-in routes
				selfRoute.GET("/checkin", controller.GetCheckinStatus)
				selfRoute.POST("/checkin", middleware.TurnstileCheck(), controller.DoCheckin)

				// Custom OAuth bindings
				selfRoute.GET("/oauth/bindings", controller.GetUserOAuthBindings)
				selfRoute.DELETE("/oauth/bindings/:provider_id", controller.UnbindCustomOAuth)
			}

			adminRoute := userRoute.Group("/")
			adminRoute.Use(middleware.AdminAuth())
			{
				adminRoute.GET("/", controller.GetAllUsers)
				adminRoute.GET("/topup", controller.GetAllTopUps)
				adminRoute.POST("/topup/complete", controller.AdminCompleteTopUp)
				adminRoute.POST("/topup/refund", controller.AdminRefundTopUp)
				adminRoute.GET("/search", controller.SearchUsers)
				adminRoute.GET("/:id/oauth/bindings", controller.GetUserOAuthBindingsByAdmin)
				adminRoute.DELETE("/:id/oauth/bindings/:provider_id", controller.UnbindCustomOAuthByAdmin)
				adminRoute.DELETE("/:id/bindings/:binding_type", controller.AdminClearUserBinding)
				adminRoute.POST("/:id/inviter", middleware.CriticalRateLimit(), controller.BindUserInviter)
				adminRoute.GET("/referral/reviews", controller.ListReferralCommissionReviews)
				adminRoute.POST("/referral/reviews/:id", middleware.CriticalRateLimit(), controller.ReviewReferralCommission)
				adminRoute.GET("/referral/agents", controller.GetReferralAgents)
				adminRoute.PUT("/:id/referral-agent", middleware.CriticalRateLimit(), controller.SetUserReferralAgent)
				adminRoute.DELETE("/:id/referral-agent", middleware.CriticalRateLimit(), controller.ClearUserReferralAgent)
				adminRoute.GET("/:id/referral-profile", controller.GetUserReferralProfile)
				adminRoute.POST("/:id/referral-flag", middleware.CriticalRateLimit(), controller.SetUserReferralFlag)
				adminRoute.POST("/:id/referral-identity", middleware.CriticalRateLimit(), controller.SetUserReferralIdentity)
				adminRoute.DELETE("/:id/referral-identity", middleware.CriticalRateLimit(), controller.ClearUserReferralIdentity)
				adminRoute.GET("/:id", controller.GetUser)
				adminRoute.POST("/", controller.CreateUser)
				adminRoute.POST("/manage", controller.ManageUser)
				adminRoute.PUT("/", controller.UpdateUser)
				adminRoute.DELETE("/:id", controller.DeleteUser)
				adminRoute.DELETE("/:id/reset_passkey", controller.AdminResetPasskey)
				adminRoute.GET("/:id/wallet/ledger", controller.GetUserWalletLedger)
				adminRoute.GET("/:id/wallet/ledger/export", controller.ExportUserWalletLedger)
				adminRoute.GET("/:id/wallet/reconcile", controller.GetUserWalletReconcile)
				adminRoute.GET("/:id/wallet/grants", controller.GetUserCreditGrantWallet)
				adminRoute.GET("/wallet/debts", controller.GetWalletDebtors)
				adminRoute.GET("/playground/storage/ledger", controller.GetPlaygroundStorageLedger)
				adminRoute.GET("/playground/storage/ledger/export", controller.ExportPlaygroundStorageLedger)
				adminRoute.GET("/playground/storage/reconcile", controller.GetPlaygroundStorageReconcile)
				adminRoute.GET("/wallet/grants/stats", controller.GetCreditGrantStats)
				adminRoute.POST("/wallet/grants", middleware.CriticalRateLimit(), controller.IssueCreditGrant)
				adminRoute.GET("/referrals", controller.GetReferralInvitations)
				adminRoute.GET("/referrals/export", controller.ExportReferralInvitations)

				// Admin 2FA routes
				adminRoute.GET("/2fa/stats", controller.Admin2FAStats)
				adminRoute.DELETE("/:id/2fa", controller.AdminDisable2FA)
			}
		}

		// Subscription billing (plans, purchase, admin management)
		subscriptionRoute := apiRouter.Group("/subscription")
		subscriptionRoute.Use(middleware.UserAuth())
		{
			subscriptionRoute.GET("/plans", controller.GetSubscriptionPlans)
			subscriptionRoute.GET("/self", controller.GetSubscriptionSelf)
			subscriptionRoute.PUT("/self/preference", controller.UpdateSubscriptionPreference)
			subscriptionRoute.POST("/balance/pay", middleware.CriticalRateLimit(), controller.SubscriptionRequestBalancePay)
			subscriptionRoute.POST("/epay/pay", middleware.CriticalRateLimit(), controller.SubscriptionRequestEpay)
			subscriptionRoute.POST("/stripe/pay", middleware.CriticalRateLimit(), controller.SubscriptionRequestStripePay)
			subscriptionRoute.POST("/creem/pay", middleware.CriticalRateLimit(), controller.SubscriptionRequestCreemPay)
			subscriptionRoute.POST("/waffo-pancake/pay", middleware.CriticalRateLimit(), controller.SubscriptionRequestWaffoPancakePay)
		}
		subscriptionAdminRoute := apiRouter.Group("/subscription/admin")
		subscriptionAdminRoute.Use(middleware.AdminAuth())
		{
			subscriptionAdminRoute.GET("/plans", controller.AdminListSubscriptionPlans)
			subscriptionAdminRoute.POST("/plans", controller.AdminCreateSubscriptionPlan)
			subscriptionAdminRoute.PUT("/plans/:id", controller.AdminUpdateSubscriptionPlan)
			subscriptionAdminRoute.PATCH("/plans/:id", controller.AdminUpdateSubscriptionPlanStatus)
			subscriptionAdminRoute.POST("/bind", controller.AdminBindSubscription)
			subscriptionAdminRoute.POST("/plans/:id/subscriptions/reset", controller.AdminResetPlanSubscriptions)

			// User subscription management (admin)
			subscriptionAdminRoute.GET("/users/:id/subscriptions", controller.AdminListUserSubscriptions)
			subscriptionAdminRoute.POST("/users/:id/subscriptions", controller.AdminCreateUserSubscription)
			subscriptionAdminRoute.POST("/users/:id/subscriptions/reset", controller.AdminResetUserSubscriptionsByPlan)
			subscriptionAdminRoute.POST("/user_subscriptions/:id/invalidate", controller.AdminInvalidateUserSubscription)
			subscriptionAdminRoute.DELETE("/user_subscriptions/:id", controller.AdminDeleteUserSubscription)
		}

		// Subscription payment callbacks (no auth)
		apiRouter.POST("/subscription/epay/notify", anonymousRequestBodyLimit, controller.SubscriptionEpayNotify)
		apiRouter.GET("/subscription/epay/notify", controller.SubscriptionEpayNotify)
		apiRouter.GET("/subscription/epay/return", controller.SubscriptionEpayReturn)
		apiRouter.POST("/subscription/epay/return", anonymousRequestBodyLimit, controller.SubscriptionEpayReturn)
		optionRoute := apiRouter.Group("/option")
		optionRoute.Use(middleware.RootAuth())
		{
			optionRoute.GET("/", controller.GetOptions)
			optionRoute.GET("/request_policy", controller.GetRequestPolicy)
			optionRoute.PATCH("/request_policy", controller.UpdateRequestPolicy)
			optionRoute.PUT("/", controller.UpdateOption)
			optionRoute.PUT("/playground/web_search", controller.UpdatePlaygroundWebSearch)
			optionRoute.PUT("/passkey/domains", controller.UpdatePasskeyDomains)
			optionRoute.GET("/model_pricing", controller.GetModelPricingConfig)
			optionRoute.PATCH("/model_pricing", controller.UpdateModelPricingConfig)
			optionRoute.POST("/model_pricing/convert", controller.PreviewModelPricingConversion)
			optionRoute.POST("/model_pricing/preview", controller.PreviewModelPricing)
			optionRoute.POST("/payment_compliance", controller.ConfirmPaymentCompliance)
			optionRoute.GET("/channel_affinity_cache", controller.GetChannelAffinityCacheStats)
			optionRoute.DELETE("/channel_affinity_cache", controller.ClearChannelAffinityCache)
			optionRoute.POST("/rest_model_ratio", controller.ResetModelRatio)
			optionRoute.GET("/waffo-pancake/catalog", controller.ListWaffoPancakeCatalog)
			optionRoute.POST("/waffo-pancake/pair", controller.CreateWaffoPancakePair)
			optionRoute.POST("/waffo-pancake/save", controller.SaveWaffoPancake)
			optionRoute.POST("/waffo-pancake/subscription-product", controller.CreateWaffoPancakeSubscriptionProduct)
			optionRoute.GET("/waffo-pancake/subscription-product-options", controller.ListWaffoPancakeSubscriptionProductOptions)
		}

		// Custom OAuth provider management (root only)
		customOAuthRoute := apiRouter.Group("/custom-oauth-provider")
		customOAuthRoute.Use(middleware.RootAuth())
		{
			customOAuthRoute.POST("/discovery", controller.FetchCustomOAuthDiscovery)
			customOAuthRoute.GET("/", controller.GetCustomOAuthProviders)
			customOAuthRoute.GET("/:id", controller.GetCustomOAuthProvider)
			customOAuthRoute.POST("/", controller.CreateCustomOAuthProvider)
			customOAuthRoute.PUT("/:id", controller.UpdateCustomOAuthProvider)
			customOAuthRoute.DELETE("/:id", controller.DeleteCustomOAuthProvider)
		}
		performanceRoute := apiRouter.Group("/performance")
		performanceRoute.Use(middleware.RootAuth())
		{
			performanceRoute.GET("/stats", controller.GetPerformanceStats)
			performanceRoute.DELETE("/disk_cache", controller.ClearDiskCache)
			performanceRoute.POST("/reset_stats", controller.ResetPerformanceStats)
			performanceRoute.POST("/gc", controller.ForceGC)
			performanceRoute.GET("/logs", controller.GetLogFiles)
			performanceRoute.DELETE("/logs", controller.CleanupLogFiles)
		}
		ratioSyncRoute := apiRouter.Group("/ratio_sync")
		ratioSyncRoute.Use(middleware.RootAuth())
		{
			ratioSyncRoute.GET("/channels", controller.GetSyncableChannels)
			ratioSyncRoute.POST("/fetch", controller.FetchUpstreamRatios)
		}
		taskPluginRoute := apiRouter.Group("/plugin/task")
		taskPluginRoute.Use(middleware.RootAuth())
		{
			taskPluginRoute.GET("", controller.ListTaskPlugins)
			taskPluginRoute.POST("", controller.UploadTaskPlugin)
			taskPluginRoute.PUT("", controller.UploadTaskPlugin)
			taskPluginRoute.GET("/runtime/status", controller.GetTaskPluginRuntime)
			taskPluginRoute.GET("/marketplace/sources", controller.GetTaskPluginMarketplaceSources)
			taskPluginRoute.PUT("/marketplace/sources", controller.UpdateTaskPluginMarketplaceSources)
			taskPluginRoute.GET("/:key", controller.GetTaskPlugin)
			taskPluginRoute.GET("/:key/icon", controller.GetTaskPluginIcon)
			taskPluginRoute.GET("/:key/versions", controller.GetTaskPluginVersions)
			taskPluginRoute.POST("/:key/activate", controller.ActivateTaskPlugin)
			taskPluginRoute.POST("/:key/status", controller.SetTaskPluginStatus)
			taskPluginRoute.POST("/:key/dryrun", controller.DryRunTaskPlugin)
			taskPluginRoute.DELETE("/:key/versions/:version", controller.DeleteTaskPluginVersion)
		}
		handlePermissionRoute(apiRouter.Group("", middleware.AdminAuth()), http.MethodGet, "/task_plugin_options", authz.TaskPluginBind, controller.GetTaskPluginOptions)
		registerChannelRoutes(apiRouter)
		registerAuthzRoutes(apiRouter)
		tokenRoute := apiRouter.Group("/token")
		tokenRoute.Use(middleware.UserAuth())
		tokenRoute.Use(middleware.TokenOperationAudit())
		{
			tokenRoute.GET("/", controller.GetAllTokens)
			tokenRoute.GET("/search", middleware.SearchRateLimit(), controller.SearchTokens)
			tokenRoute.GET("/auto-groups", controller.GetTokenAutoGroups)
			tokenRoute.GET("/:id", controller.GetToken)
			tokenRoute.POST("/:id/key", middleware.CriticalRateLimit(), middleware.DisableCache(), controller.GetTokenKey)
			tokenRoute.POST("/", controller.AddToken)
			tokenRoute.PUT("/", controller.UpdateToken)
			tokenRoute.DELETE("/:id", controller.DeleteToken)
			tokenRoute.POST("/batch", controller.DeleteTokenBatch)
			tokenRoute.POST("/batch/keys", middleware.CriticalRateLimit(), middleware.DisableCache(), controller.GetTokenKeysBatch)
		}

		usageRoute := apiRouter.Group("/usage")
		usageRoute.Use(middleware.CORS(), middleware.CriticalRateLimit())
		{
			tokenUsageRoute := usageRoute.Group("/token")
			tokenUsageRoute.Use(middleware.TokenAuthReadOnly())
			{
				tokenUsageRoute.GET("/", controller.GetTokenUsage)
			}
		}

		redemptionRoute := apiRouter.Group("/redemption")
		redemptionRoute.Use(middleware.AdminAuth())
		{
			redemptionRoute.GET("/", controller.GetAllRedemptions)
			redemptionRoute.GET("/search", controller.SearchRedemptions)
			redemptionRoute.GET("/:id", controller.GetRedemption)
			redemptionRoute.POST("/", controller.AddRedemption)
			redemptionRoute.POST("/batch", controller.DeleteRedemptionBatch)
			redemptionRoute.PUT("/", controller.UpdateRedemption)
			redemptionRoute.DELETE("/invalid", controller.DeleteInvalidRedemption)
			redemptionRoute.DELETE("/:id", controller.DeleteRedemption)
		}
		handlePermissionRoute(apiRouter.Group("", middleware.DisableCache(), middleware.AdminAuth()), http.MethodGet, "/audit", authz.AuditRead, controller.GetAuditLogs)
		apiRouter.GET("/audit/self", middleware.DisableCache(), middleware.UserAuth(), controller.GetAuditLogs)
		logRoute := apiRouter.Group("/log")
		logRoute.GET("/", middleware.AdminAuth(), controller.GetAllLogs)
		logRoute.GET("/stat", middleware.AdminAuth(), controller.GetLogsStat)
		logRoute.GET("/self/stat", middleware.UserAuth(), controller.GetLogsSelfStat)
		logRoute.GET("/channel_affinity_usage_cache", middleware.AdminAuth(), controller.GetChannelAffinityUsageCacheStats)
		logRoute.GET("/search", middleware.AdminAuth(), controller.SearchAllLogs)
		logRoute.GET("/self", middleware.UserAuth(), controller.GetUserLogs)
		logRoute.GET("/export", middleware.AdminAuth(), controller.ExportAllLogs)
		logRoute.GET("/self/export", middleware.UserAuth(), controller.ExportUserLogs)
		logRoute.GET("/self/search", middleware.UserAuth(), middleware.SearchRateLimit(), controller.SearchUserLogs)

		systemTaskRoute := apiRouter.Group("/system-task")
		systemTaskRoute.Use(middleware.RootAuth())
		{
			systemTaskRoute.POST("/log-cleanup", controller.CreateLogCleanupSystemTask)
			systemTaskRoute.GET("/list", controller.ListSystemTasks)
			systemTaskRoute.DELETE("/history", controller.DeleteSystemTaskHistory)
			systemTaskRoute.GET("/current", controller.GetCurrentSystemTask)
			systemTaskRoute.GET("/:task_id", controller.GetSystemTask)
		}
		systemInfoRoute := apiRouter.Group("/system-info")
		systemInfoRoute.Use(middleware.RootAuth())
		{
			systemInfoRoute.GET("/instances", controller.ListSystemInstances)
			systemInfoRoute.DELETE("/stale-instances", controller.DeleteStaleSystemInstances)
			systemInfoRoute.DELETE("/instances/:node_name", controller.DeleteStaleSystemInstance)
		}

		dataRoute := apiRouter.Group("/data")
		dataRoute.GET("/", middleware.AdminAuth(), controller.GetAllQuotaDates)
		dataRoute.GET("/users", middleware.AdminAuth(), controller.GetQuotaDatesByUser)
		dataRoute.GET("/self", middleware.UserAuth(), controller.GetUserQuotaDates)
		dataRoute.GET("/flow", middleware.AdminAuth(), controller.GetAllFlowQuotaDates)
		dataRoute.GET("/flow/self", middleware.UserAuth(), controller.GetUserFlowQuotaDates)

		logRoute.Use(middleware.CORS(), middleware.CriticalRateLimit())
		{
			logRoute.GET("/token", middleware.TokenAuthReadOnly(), controller.GetLogByKey)
		}
		groupRoute := apiRouter.Group("/group")
		groupRoute.Use(middleware.AdminAuth())
		{
			groupRoute.GET("/", controller.GetGroups)
		}

		prefillGroupRoute := apiRouter.Group("/prefill_group")
		prefillGroupRoute.Use(middleware.AdminAuth())
		{
			prefillGroupRoute.GET("/", controller.GetPrefillGroups)
			prefillGroupRoute.POST("/", controller.CreatePrefillGroup)
			prefillGroupRoute.PUT("/", controller.UpdatePrefillGroup)
			prefillGroupRoute.DELETE("/:id", controller.DeletePrefillGroup)
		}

		mjRoute := apiRouter.Group("/mj")
		mjRoute.GET("/self", middleware.UserAuth(), controller.GetUserMidjourney)
		mjRoute.GET("/", middleware.AdminAuth(), controller.GetAllMidjourney)

		taskRoute := apiRouter.Group("/task")
		{
			taskRoute.GET("/self", middleware.UserAuth(), controller.GetUserTask)
			taskRoute.GET("", middleware.AdminAuth(), controller.GetAllTask)
			taskRoute.GET("/:task_id/artifacts", middleware.UserAuth(), controller.GetDashboardTaskArtifacts)
		}

		vendorRoute := apiRouter.Group("/vendors")
		vendorRoute.Use(middleware.AdminAuth())
		{
			vendorRoute.POST("/operations/preview", controller.PreviewVendorOperation)
			vendorRoute.POST("/operations", controller.ApplyVendorOperation)
			vendorRoute.GET("/", controller.GetAllVendors)
			vendorRoute.GET("/search", controller.SearchVendors)
			vendorRoute.GET("/:id", controller.GetVendorMeta)
			vendorRoute.POST("/", controller.CreateVendorMeta)
			vendorRoute.PUT("/", controller.UpdateVendorMeta)
			vendorRoute.DELETE("/:id", controller.DeleteVendorMeta)
		}

		modelsRoute := apiRouter.Group("/models")
		modelsRoute.Use(middleware.AdminAuth())
		{
			modelsRoute.GET("/sync_upstream/preview", controller.SyncUpstreamPreview)
			modelsRoute.POST("/sync_upstream", controller.SyncUpstreamModels)
			modelsRoute.POST("/delete", controller.BatchDeleteModelMeta)
			modelsRoute.GET("/missing", controller.GetMissingModels)
			modelsRoute.GET("/", controller.GetAllModelsMeta)
			modelsRoute.GET("/search", controller.SearchModelsMeta)
			modelsRoute.GET("/:id", controller.GetModelMeta)
			modelsRoute.POST("/", controller.CreateModelMeta)
			modelsRoute.PUT("/", controller.UpdateModelMeta)
			modelsRoute.DELETE("/:id", controller.DeleteModelMeta)
		}

		// Deployments (model deployment management)
		deploymentsRoute := apiRouter.Group("/deployments")
		deploymentsRoute.Use(middleware.AdminAuth())
		{
			deploymentsRoute.GET("/settings", controller.GetModelDeploymentSettings)
			deploymentsRoute.POST("/settings/test-connection", controller.TestIoNetConnection)
			deploymentsRoute.GET("/", controller.GetAllDeployments)
			deploymentsRoute.GET("/search", controller.SearchDeployments)
			deploymentsRoute.POST("/test-connection", controller.TestIoNetConnection)
			deploymentsRoute.GET("/hardware-types", controller.GetHardwareTypes)
			deploymentsRoute.GET("/locations", controller.GetLocations)
			deploymentsRoute.GET("/available-replicas", controller.GetAvailableReplicas)
			deploymentsRoute.POST("/price-estimation", controller.GetPriceEstimation)
			deploymentsRoute.GET("/check-name", controller.CheckClusterNameAvailability)
			deploymentsRoute.POST("/", controller.CreateDeployment)

			deploymentsRoute.GET("/:id", controller.GetDeployment)
			deploymentsRoute.GET("/:id/logs", controller.GetDeploymentLogs)
			deploymentsRoute.GET("/:id/containers", controller.ListDeploymentContainers)
			deploymentsRoute.GET("/:id/containers/:container_id", controller.GetContainerDetails)
			deploymentsRoute.PUT("/:id", controller.UpdateDeployment)
			deploymentsRoute.PUT("/:id/name", controller.UpdateDeploymentName)
			deploymentsRoute.POST("/:id/extend", controller.ExtendDeployment)
			deploymentsRoute.DELETE("/:id", controller.DeleteDeployment)
		}
	}
}
