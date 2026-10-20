package constant

type ContextKey string

const (
	ContextKeyTokenCountMeta  ContextKey = "token_count_meta"
	ContextKeyPromptTokens    ContextKey = "prompt_tokens"
	ContextKeyEstimatedTokens ContextKey = "estimated_tokens"

	ContextKeyOriginalModel    ContextKey = "original_model"
	ContextKeyRequestStartTime ContextKey = "request_start_time"
	// ContextKeyRequestTiming carries the *common.RequestTimingSession of a
	// main LLM entry point whose log exposes the request's phase breakdown.
	ContextKeyRequestTiming ContextKey = "request_timing_session"

	/* token related keys */
	ContextKeyTokenUnlimited         ContextKey = "token_unlimited_quota"
	ContextKeyTokenKey               ContextKey = "token_key"
	ContextKeyTokenId                ContextKey = "token_id"
	ContextKeyTokenGroup             ContextKey = "token_group"
	ContextKeyOriginTasks            ContextKey = "origin_tasks"
	ContextKeyChannelConstraints     ContextKey = "channel_constraints"
	ContextKeyTokenModelLimitEnabled ContextKey = "token_model_limit_enabled"
	ContextKeyTokenModelLimit        ContextKey = "token_model_limit"
	ContextKeyTokenCrossGroupRetry   ContextKey = "token_cross_group_retry"
	ContextKeyTokenAutoGroups        ContextKey = "token_auto_groups"
	// ContextKeyTokenPeriodLimited marks a token whose periodic budget must be
	// enforced on every pre-consume, and ContextKeyTokenPeriodReset carries its
	// reset cycle (day/week/month).
	ContextKeyTokenPeriodLimited ContextKey = "token_period_limited"
	ContextKeyTokenPeriodReset   ContextKey = "token_period_reset"
	// ContextKeyTokenRPMLimit and ContextKeyTokenTPMLimit carry the token's
	// admission limits (0 = unlimited) to the relay admission.
	ContextKeyTokenRPMLimit ContextKey = "token_rpm_limit"
	ContextKeyTokenTPMLimit ContextKey = "token_tpm_limit"

	/* channel related keys */
	ContextKeyChannelId                ContextKey = "channel_id"
	ContextKeyChannelName              ContextKey = "channel_name"
	ContextKeyChannelCreateTime        ContextKey = "channel_create_time"
	ContextKeyChannelBaseUrl           ContextKey = "base_url"
	ContextKeyChannelType              ContextKey = "channel_type"
	ContextKeyChannelSetting           ContextKey = "channel_setting"
	ContextKeyChannelOtherSetting      ContextKey = "channel_other_setting"
	ContextKeyChannelParamOverride     ContextKey = "param_override"
	ContextKeyChannelHeaderOverride    ContextKey = "header_override"
	ContextKeyChannelOrganization      ContextKey = "channel_organization"
	ContextKeyChannelAutoBan           ContextKey = "auto_ban"
	ContextKeyChannelModelMapping      ContextKey = "model_mapping"
	ContextKeyChannelStatusCodeMapping ContextKey = "status_code_mapping"
	ContextKeyChannelIsMultiKey        ContextKey = "channel_is_multi_key"
	ContextKeyChannelMultiKeyIndex     ContextKey = "channel_multi_key_index"
	ContextKeyChannelKey               ContextKey = "channel_key"
	// ContextKeySelectedChannel carries the full channel record the distributor
	// selected for the first attempt, so the relay admission can read the
	// channel's limits without a second cache lookup.
	ContextKeySelectedChannel ContextKey = "selected_channel"

	// ContextKeyUpstreamRequestOrigin is the scheme and host of the last upstream
	// request, which differs from the base URL for absolute Advanced Custom routes
	// and for adaptors that build official endpoints themselves.
	ContextKeyUpstreamRequestOrigin ContextKey = "upstream_request_origin"

	ContextKeyAutoGroup           ContextKey = "auto_group"
	ContextKeyAutoGroupIndex      ContextKey = "auto_group_index"
	ContextKeyAutoGroupRetryIndex ContextKey = "auto_group_retry_index"

	/* user related keys */
	ContextKeyUserId      ContextKey = "id"
	ContextKeyUserSetting ContextKey = "user_setting"
	ContextKeyUserQuota   ContextKey = "user_quota"
	ContextKeyUserStatus  ContextKey = "user_status"
	ContextKeyUserEmail   ContextKey = "user_email"
	ContextKeyUserGroup   ContextKey = "user_group"
	ContextKeyUsingGroup  ContextKey = "group"
	ContextKeyUserName    ContextKey = "username"

	ContextKeyLocalCountTokens ContextKey = "local_count_tokens"

	ContextKeySystemPromptOverride ContextKey = "system_prompt_override"

	// ContextKeyFileSourcesToCleanup stores file sources that need cleanup when request ends
	ContextKeyFileSourcesToCleanup ContextKey = "file_sources_to_cleanup"

	// ContextKeyAdminRejectReason stores an admin-only reject/block reason extracted from upstream responses.
	// It is not returned to end users, but can be persisted into consume/error logs for debugging.
	ContextKeyAdminRejectReason ContextKey = "admin_reject_reason"

	// ContextKeyLanguage stores the user's language preference for i18n
	ContextKeyLanguage             ContextKey = "language"
	ContextKeyIsStream             ContextKey = "is_stream"
	ContextKeyResponseStreamStatus ContextKey = "response_stream_status"

	// ContextKeyAuditLogged marks that the current request has already recorded
	// a manage/operation audit log inside the handler. When set, the admin-audit
	// fallback in authHelper (finishAdminAudit) skips its record to avoid
	// duplicate entries.
	ContextKeyAuditLogged ContextKey = "audit_logged"

	// ContextKeyTokenAuditParams contains only the API token operation's safe metadata.
	ContextKeyTokenAuditParams ContextKey = "token_audit_params"
	// ContextKeyTokenAuditSucceeded disambiguates token responses that exceed the audit buffer.
	ContextKeyTokenAuditSucceeded ContextKey = "token_audit_succeeded"

	// ContextKeyPlaygroundOrigin marks a relay request that the Playground
	// workspace submitted, including a media bridge whose path was rewritten to
	// its canonical /v1 form. It scopes Playground lifecycle policies (result
	// storage budget, expiry cleanup, cancellation) and log metadata; wallet
	// billing still runs through the ordinary relay pipeline, while the synthetic
	// workspace token never carries its own quota.
	ContextKeyPlaygroundOrigin ContextKey = "playground_origin"
	// ContextKeyPlaygroundWorkflowRun carries the run budget a Playground
	// canvas step bills against (BL-03). It arrives in a workspace-only header
	// that the transport consumes, so it never reaches an upstream provider.
	ContextKeyPlaygroundWorkflowRun ContextKey = "playground_workflow_run"
	// ContextKeyPlaygroundGenerationParams carries the credential-free
	// generation request snapshot the Playground bridge validated. The relay
	// copies it into the durable task's private metadata so a finished result
	// can show its prompt, model and generation parameters.
	ContextKeyPlaygroundGenerationParams ContextKey = "playground_generation_params"
	// ContextKeyPlaygroundTaskQueueReplay marks a queued request replayed by
	// the internal worker. If another submission took the last concurrency slot
	// between selection and replay, the budget check must return the ordinary
	// rejection instead of enqueueing a duplicate; the worker then releases the
	// original entry back to the queue.
	ContextKeyPlaygroundTaskQueueReplay ContextKey = "playground_task_queue_replay"

	// ContextKeyImageTaskAsync marks an image generation request that runs as
	// a durable task instead of waiting for the images inside the request. The
	// submission answers with the task id, the task keeps the protocol request
	// that renders its result, and the polling endpoint serves that result.
	ContextKeyImageTaskAsync ContextKey = "image_task_async"
)
