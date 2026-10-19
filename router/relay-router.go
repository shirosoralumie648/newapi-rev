package router

import (
	"strings"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/relay"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
)

func SetRelayRouter(router *gin.Engine) {
	router.Use(middleware.CORS())
	router.Use(middleware.DecompressRequestMiddleware())
	router.Use(middleware.BodyStorageCleanup()) // 清理请求体存储
	router.Use(middleware.StatsMiddleware())
	// https://platform.openai.com/docs/api-reference/introduction
	modelsRouter := router.Group("/v1/models")
	modelsRouter.Use(middleware.RouteTag("relay"))
	modelsRouter.Use(middleware.TokenAuth())
	{
		modelsRouter.GET("", func(c *gin.Context) {
			switch {
			case c.GetHeader("x-api-key") != "" && c.GetHeader("anthropic-version") != "":
				controller.ListModels(c, constant.ChannelTypeAnthropic)
			case c.GetHeader("x-goog-api-key") != "" || c.Query("key") != "": // 单独的适配
				controller.ListModels(c, constant.ChannelTypeGemini)
			default:
				controller.ListModels(c, constant.ChannelTypeOpenAI)
			}
		})

		modelsRouter.GET("/:model", func(c *gin.Context) {
			switch {
			case c.GetHeader("x-api-key") != "" && c.GetHeader("anthropic-version") != "":
				controller.RetrieveModel(c, constant.ChannelTypeAnthropic)
			default:
				controller.RetrieveModel(c, constant.ChannelTypeOpenAI)
			}
		})
	}

	geminiRouter := router.Group("/v1beta/models")
	geminiRouter.Use(middleware.RouteTag("relay"))
	geminiRouter.Use(middleware.TokenAuth())
	{
		geminiRouter.GET("", func(c *gin.Context) {
			controller.ListModels(c, constant.ChannelTypeGemini)
		})
	}

	geminiCompatibleRouter := router.Group("/v1beta/openai/models")
	geminiCompatibleRouter.Use(middleware.RouteTag("relay"))
	geminiCompatibleRouter.Use(middleware.TokenAuth())
	{
		geminiCompatibleRouter.GET("", func(c *gin.Context) {
			controller.ListModels(c, constant.ChannelTypeOpenAI)
		})
	}

	playgroundRouter := router.Group("/pg")
	playgroundRouter.Use(middleware.RouteTag("relay"))
	playgroundRouter.Use(middleware.RequestTiming())
	playgroundRouter.Use(middleware.SystemPerformanceCheck())
	// The run budget header of a canvas workflow step is consumed before the
	// relay reads the account context, exactly like the media bridge does.
	playgroundRouter.Use(middleware.PlaygroundWorkflowRun())
	playgroundRouter.Use(middleware.UserAuth(), middleware.Distribute())
	{
		playgroundRouter.POST("/chat/completions", controller.Playground)
	}

	// Media generation routes mirror their /v1 counterparts behind UserAuth.
	// The bridge rewrites the path before pinning and channel selection, so
	// task plugins, model grouping and billing see the canonical request.
	playgroundMediaRouter := router.Group("/pg")
	playgroundMediaRouter.Use(middleware.RouteTag("relay"))
	playgroundMediaRouter.Use(middleware.RequestTiming())
	playgroundMediaRouter.Use(middleware.DisableCache())
	playgroundMediaRouter.Use(middleware.SystemPerformanceCheck())
	playgroundMediaRouter.Use(middleware.UserAuth())
	{
		// The chat, Responses and Messages protocols share one Relay pipeline.
		// The bridge rewrites the playground path before relay-mode detection,
		// channel selection and billing, so each protocol behaves exactly like
		// its direct /v1 endpoint.
		playgroundMediaRouter.POST("/responses",
			middleware.PlaygroundRelayBridge("/v1/responses"),
			middleware.Distribute(),
			controller.PlaygroundResponses,
		)
		playgroundMediaRouter.POST("/messages",
			middleware.PlaygroundRelayBridge("/v1/messages"),
			middleware.Distribute(),
			controller.PlaygroundMessages,
		)
		playgroundMediaRouter.POST("/images/generations",
			middleware.PlaygroundRelayBridge("/v1/images/generations"),
			middleware.PinTaskPluginEndpoint(),
			middleware.PrepareTaskPluginEndpoint(),
			middleware.Distribute(),
			controller.PlaygroundImageGeneration,
		)
		playgroundMediaRouter.POST("/images/edits",
			middleware.PlaygroundRelayBridge("/v1/images/edits"),
			middleware.PinTaskPluginEndpoint(),
			middleware.PrepareTaskPluginEndpoint(),
			middleware.Distribute(),
			controller.PlaygroundImageEdit,
		)
		playgroundMediaRouter.POST("/videos",
			middleware.PlaygroundRelayBridge("/v1/videos"),
			middleware.PinTaskPluginEndpoint(),
			middleware.PrepareTaskPluginEndpoint(),
			middleware.Distribute(),
			controller.PlaygroundVideoTask,
		)
		// Embeddings are synchronous and bill like a direct /v1/embeddings call.
		// The knowledge indexer computes its vectors here, so the group header
		// and ordinary channel selection apply unchanged.
		playgroundMediaRouter.POST("/embeddings",
			middleware.PlaygroundRelayBridge("/v1/embeddings"),
			middleware.Distribute(),
			controller.PlaygroundEmbeddings,
		)
		playgroundMediaRouter.POST("/audio/speech",
			middleware.PlaygroundRelayBridge("/v1/audio/speech"),
			middleware.Distribute(),
			controller.PlaygroundAudioSpeech,
		)
		// Dictation is multipart, so its group override arrives in the
		// X-Playground-Group header; the bridge consumes it before the relay
		// pipeline sees the canonical request.
		playgroundMediaRouter.POST("/audio/transcriptions",
			middleware.PlaygroundRelayBridge("/v1/audio/transcriptions"),
			middleware.Distribute(),
			controller.PlaygroundAudioTranscription,
		)
	}
	relayV1Router := router.Group("/v1")
	relayV1Router.Use(middleware.RouteTag("relay"))
	relayV1Router.Use(middleware.RequestTiming())
	relayV1Router.Use(middleware.SystemPerformanceCheck())
	relayV1Router.Use(middleware.TokenAuth())
	{
		// Responses WebSocket route. Channel selection happens after the first
		// response.create event; each event runs the ordinary request limiter.
		relayV1Router.GET("/responses", controller.ResponsesWebSocket)
		// Asynchronous image generation poll. The submission settled the task
		// and stored its upstream id, so polling only reads the durable row:
		// it selects no channel and enforces no model limit. The endpoint is
		// owner-scoped and renders the images of a finished task.
		relayV1Router.GET("/images/generations/:task_id", controller.RelayImageGenerationTask)
	}
	relayV1Router.Use(middleware.ModelRequestRateLimit())
	{
		// WebSocket 路由（统一到 Relay）
		wsRouter := relayV1Router.Group("")
		wsRouter.Use(middleware.Distribute())
		wsRouter.GET("/realtime", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatOpenAIRealtime)
		})
	}
	{
		//http router
		httpRouter := relayV1Router.Group("")
		httpRouter.Use(middleware.Distribute())

		// claude related routes
		// Anthropic's count_tokens endpoint is answered locally with the same
		// tokenizer the relay uses to size a Messages request: it never calls an
		// upstream channel and never bills. The parent TokenAuth and Distribute
		// middleware still enforce token, group, and model availability first, and
		// a fast 200 here keeps Claude Code and other SDKs from falling back to
		// max_tokens=1 probe requests when the route is missing.
		httpRouter.POST("/messages/count_tokens", controller.CountClaudeTokens)
		httpRouter.POST("/messages", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatClaude)
		})

		// chat related routes
		httpRouter.POST("/completions", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatOpenAI)
		})
		httpRouter.POST("/chat/completions", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatOpenAI)
		})

		// response related routes
		httpRouter.POST("/responses/compact", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatOpenAIResponsesCompaction)
		})

		// alpha search related routes (Codex standalone web search)
		httpRouter.POST("/alpha/search", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatOpenAIAlphaSearch)
		})

		// DeepSeek Search and Fetch API routes
		httpRouter.POST("/tools/search", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatDeepSeekTools)
		})
		httpRouter.POST("/tools/fetch", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatDeepSeekTools)
		})

		// image related routes. /images/generations and /images/edits are
		// host protocol endpoints (openai_image) registered by
		// SetTaskPluginProtocolRouter; unclaimed models fall back to Relay.
		httpRouter.POST("/edits", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatOpenAIImage)
		})

		// embedding related routes
		httpRouter.POST("/embeddings", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatEmbedding)
		})

		// audio related routes
		httpRouter.POST("/audio/transcriptions", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatOpenAIAudio)
		})
		httpRouter.POST("/audio/translations", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatOpenAIAudio)
		})
		httpRouter.POST("/audio/speech", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatOpenAIAudio)
		})

		// rerank related routes
		httpRouter.POST("/rerank", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatRerank)
		})

		// gemini relay routes
		httpRouter.POST("/engines/:model/embeddings", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatGemini)
		})
		httpRouter.POST("/models/*path", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatGemini)
		})

		// other relay routes
		httpRouter.POST("/moderations", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatOpenAI)
		})

		// not implemented
		httpRouter.POST("/images/variations", controller.RelayNotImplemented)
		httpRouter.GET("/files", controller.RelayNotImplemented)
		httpRouter.POST("/files", controller.RelayNotImplemented)
		httpRouter.DELETE("/files/:id", controller.RelayNotImplemented)
		httpRouter.GET("/files/:id", controller.RelayNotImplemented)
		httpRouter.GET("/files/:id/content", controller.RelayNotImplemented)
		httpRouter.POST("/fine-tunes", controller.RelayNotImplemented)
		httpRouter.GET("/fine-tunes", controller.RelayNotImplemented)
		httpRouter.GET("/fine-tunes/:id", controller.RelayNotImplemented)
		httpRouter.POST("/fine-tunes/:id/cancel", controller.RelayNotImplemented)
		httpRouter.GET("/fine-tunes/:id/events", controller.RelayNotImplemented)
		httpRouter.DELETE("/models/:model", controller.RelayNotImplemented)
	}

	relayMjRouter := router.Group("/mj")
	relayMjRouter.Use(middleware.RouteTag("relay"))
	relayMjRouter.Use(middleware.SystemPerformanceCheck())
	registerMjRouterGroup(relayMjRouter)

	relayMjModeRouter := router.Group("/:mode/mj")
	relayMjModeRouter.Use(middleware.RouteTag("relay"))
	relayMjModeRouter.Use(middleware.SystemPerformanceCheck())
	registerMjRouterGroup(relayMjModeRouter)
	//relayMjRouter.Use()

	relayGeminiRouter := router.Group("/v1beta")
	// :countTokens is not implemented. Answer it like an unregistered route
	// before auth/channel selection instead of silently relaying it as
	// generateContent (#7283).
	relayGeminiRouter.Use(func(c *gin.Context) {
		if strings.HasSuffix(c.Request.URL.Path, ":countTokens") {
			controller.RelayNotFound(c)
			c.Abort()
		}
	})
	relayGeminiRouter.Use(middleware.RouteTag("relay"))
	relayGeminiRouter.Use(middleware.RequestTiming())
	relayGeminiRouter.Use(middleware.SystemPerformanceCheck())
	relayGeminiRouter.Use(middleware.TokenAuth())
	relayGeminiRouter.Use(middleware.ModelRequestRateLimit())
	relayGeminiRouter.Use(middleware.Distribute())
	{
		// Gemini API 路径格式: /v1beta/models/{model_name}:{action}
		relayGeminiRouter.POST("/models/*path", func(c *gin.Context) {
			controller.Relay(c, types.RelayFormatGemini)
		})
	}
}

func registerMjRouterGroup(relayMjRouter *gin.RouterGroup) {
	// Images are loaded by browsers and MjProxy clients without an
	// Authorization header, so this route keeps its own access control (see
	// setting.MjImageAccessMode) instead of the TokenAuth below.
	relayMjRouter.GET("/image/:id", middleware.MjImageAccessControl(), relay.RelayMidjourneyImage)
	relayMjRouter.Use(middleware.TokenAuth(), middleware.Distribute())
	{
		relayMjRouter.POST("/submit/action", controller.RelayMidjourney)
		relayMjRouter.POST("/submit/shorten", controller.RelayMidjourney)
		relayMjRouter.POST("/submit/modal", controller.RelayMidjourney)
		relayMjRouter.POST("/submit/imagine", controller.RelayMidjourney)
		relayMjRouter.POST("/submit/change", controller.RelayMidjourney)
		relayMjRouter.POST("/submit/simple-change", controller.RelayMidjourney)
		relayMjRouter.POST("/submit/describe", controller.RelayMidjourney)
		relayMjRouter.POST("/submit/blend", controller.RelayMidjourney)
		relayMjRouter.POST("/submit/edits", controller.RelayMidjourney)
		relayMjRouter.POST("/submit/video", controller.RelayMidjourney)
		//relayMjRouter.POST("/notify", controller.RelayMidjourney)
		relayMjRouter.GET("/task/:id/fetch", controller.RelayMidjourney)
		relayMjRouter.GET("/task/:id/image-seed", controller.RelayMidjourney)
		relayMjRouter.POST("/task/list-by-condition", controller.RelayMidjourney)
		relayMjRouter.POST("/insight-face/swap", controller.RelayMidjourney)
		relayMjRouter.POST("/submit/upload-discord-images", controller.RelayMidjourney)
	}
}
