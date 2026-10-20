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

/**
 * Catalog of actionable Playground failures (PG2-18). Every stable error code
 * of the gateway maps to one translatable title, one translatable description
 * and the buttons that can actually fix the failure. A code outside the
 * catalog returns null so the caller keeps showing the original error text.
 *
 * Only the static catalog strings are rendered for a known code; the raw
 * upstream message is never interpolated, so a channel address or key that
 * leaked into an error text cannot reach the reader through a catalog entry.
 */
export type PlaygroundErrorAction =
  | 'retry'
  | 'open-context'
  | 'remove-images'
  | 'change-model'
  | 'switch-group'
  | 'open-wallet'
  | 'use-chat-protocol'

export type PlaygroundErrorCategory =
  | 'context-too-long'
  | 'insufficient-quota'
  | 'rate-limited'
  | 'model-unavailable'
  | 'service-unavailable'
  | 'vision-unsupported'
  | 'content-filtered'
  | 'protocol-mismatch'
  | 'invalid-request'
  | 'attachment'
  | 'playground-limit'
  | 'conflict'
  | 'not-found'
  | 'forbidden'
  | 'model-price'

export interface PlaygroundErrorCatalogEntry {
  category: PlaygroundErrorCategory
  /** Normalized code the entry was resolved from; empty for message matches. */
  code: string
  /** English source key of the alert title. */
  titleKey: string
  /** English source key of the alert description. */
  descriptionKey: string
  actions: readonly PlaygroundErrorAction[]
}

type PlaygroundErrorCatalogTemplate = Omit<PlaygroundErrorCatalogEntry, 'code'>

const CATALOG_TEMPLATES: Record<
  PlaygroundErrorCategory,
  PlaygroundErrorCatalogTemplate
> = {
  'context-too-long': {
    category: 'context-too-long',
    titleKey: 'The conversation is too long for this model',
    descriptionKey:
      'Compress older messages or lower the history limit, then try again.',
    actions: ['open-context', 'retry'],
  },
  'insufficient-quota': {
    category: 'insufficient-quota',
    titleKey: 'Not enough balance',
    descriptionKey:
      'Top up your wallet or switch to a group with a lower cost.',
    actions: ['open-wallet', 'switch-group'],
  },
  'rate-limited': {
    category: 'rate-limited',
    titleKey: 'Too many requests',
    descriptionKey: 'Wait a moment and try again, or switch to another group.',
    actions: ['retry', 'switch-group'],
  },
  'model-unavailable': {
    category: 'model-unavailable',
    titleKey: 'This model is unavailable',
    descriptionKey: 'Choose another model or group, then try again.',
    actions: ['change-model', 'switch-group', 'retry'],
  },
  'service-unavailable': {
    category: 'service-unavailable',
    titleKey: 'The upstream service is unavailable',
    descriptionKey: 'Retry in a moment or switch to another group.',
    actions: ['retry', 'switch-group'],
  },
  'vision-unsupported': {
    category: 'vision-unsupported',
    titleKey: 'This model cannot read images',
    descriptionKey:
      'Remove the images from the message, or choose a vision-capable model.',
    actions: ['remove-images', 'change-model'],
  },
  'content-filtered': {
    category: 'content-filtered',
    titleKey: 'The content was blocked',
    descriptionKey:
      'Edit the message to remove the blocked content, or try another model.',
    actions: ['change-model'],
  },
  'protocol-mismatch': {
    category: 'protocol-mismatch',
    titleKey: 'This protocol is not supported',
    descriptionKey: 'Switch to Chat Completions, or choose another model.',
    actions: ['use-chat-protocol', 'change-model'],
  },
  'invalid-request': {
    category: 'invalid-request',
    titleKey: 'The request was rejected',
    descriptionKey: 'Check the message and parameters, then try again.',
    actions: ['retry', 'open-context'],
  },
  attachment: {
    category: 'attachment',
    titleKey: 'The attachment cannot be used',
    descriptionKey:
      'Remove the images or attachments, or choose another model.',
    actions: ['remove-images', 'change-model'],
  },
  'playground-limit': {
    category: 'playground-limit',
    titleKey: 'A Playground limit was reached',
    descriptionKey:
      'Remove some stored content or shorten this request, then try again.',
    actions: ['open-context', 'retry'],
  },
  conflict: {
    category: 'conflict',
    titleKey: 'The conversation changed elsewhere',
    descriptionKey:
      'Reload by retrying, or start a new conversation from this draft.',
    actions: ['retry'],
  },
  'not-found': {
    category: 'not-found',
    titleKey: 'This item no longer exists',
    descriptionKey: 'Retry, or start a new conversation.',
    actions: ['retry'],
  },
  forbidden: {
    category: 'forbidden',
    titleKey: 'You do not have access',
    descriptionKey:
      'Switch to an allowed group, or ask your administrator for access.',
    actions: ['switch-group', 'change-model'],
  },
  'model-price': {
    category: 'model-price',
    titleKey: 'Model Price Not Configured',
    descriptionKey:
      'The selected model has no billing price. Ask an administrator to configure it.',
    actions: [],
  },
}

const CATEGORY_CODES: Record<PlaygroundErrorCategory, readonly string[]> = {
  'context-too-long': [
    'context_length_exceeded',
    'context_too_long',
    'maximum_context_length_exceeded',
    'max_context_length_exceeded',
    'model_context_window_exceeded',
    'string_above_max_length',
    'prompt_too_long',
    'input_too_long',
    'too_many_tokens',
    'tokens_exceeded',
    'token_limit_exceeded',
    'exceed_context_size_error',
  ],
  'insufficient-quota': [
    'insufficient_user_quota',
    'insufficient_quota',
    'insufficient_balance',
    'insufficient_funds',
    'insufficient_credits',
    'insufficient_wallet_quota',
    'quota_exceeded',
    'quota_exhausted',
    'billing_hard_limit_reached',
    'credit_balance_too_low',
    'payment_required',
    'pre_consume_token_quota_failed',
    'token_period_quota_exhausted',
    'workflow_budget_exceeded',
    'playground_wallet_debt_read_only',
    'playground_search_insufficient_quota',
    'playground_workflow_budget_insufficient',
  ],
  'rate-limited': [
    'rate_limit',
    'rate_limit_exceeded',
    'rate_limit_error',
    'rate_limit_reached',
    'too_many_requests',
    'requests_per_minute_exceeded',
    'tokens_per_minute_exceeded',
    'token_rate_limit_exceeded',
    'channel_capacity_exhausted',
    'resource_exhausted',
    'playground_task_limit_exceeded',
    'playground_task_storage_limit_exceeded',
  ],
  'model-unavailable': [
    'model_not_found',
    'model_not_available',
    'model_unavailable',
    'model_not_supported',
    'unsupported_model',
    'invalid_model',
    'model_decommissioned',
    'model_deprecated',
    'no_available_channel',
    'channel:model_mapped_error',
  ],
  'service-unavailable': [
    'channel:no_available_key',
    'channel:invalid_key',
    'channel:response_time_exceeded',
    'channel:first_token_timeout',
    'channel:param_override_invalid',
    'channel:header_override_invalid',
    'channel:aws_client_error',
    'get_channel_failed',
    'gen_relay_info_failed',
    'do_request_failed',
    'bad_response',
    'bad_response_body',
    'bad_response_status_code',
    'empty_response',
    'read_response_body_failed',
    'aws_invoke_error',
    'upstream_error',
    'overloaded_error',
    'service_unavailable',
    'server_error',
    'internal_server_error',
    'internal_error',
    'bad_gateway',
    'gateway_timeout',
    'timeout',
    'connection_error',
    'api_error',
    'new_api_error',
    'openai_error',
    'provider_error',
    'provider_failed',
    'invalid_api_key',
    'api_key_invalid',
    'api_key_expired',
    'api_key_service_blocked',
    'invalid_authentication',
    'image_generation_failed',
    'task_protocol_error',
    'query_data_error',
    'update_data_error',
    'playground_storage_error',
    'playground_task_cancel_failed',
    'playground_task_limit_unavailable',
    'playground_wallet_debt_unavailable',
    'playground_workflow_run_settle_failed',
    'playground_workflow_budget_unavailable',
    'playground_search_disabled',
    'playground_search_failed',
    'playground_search_unavailable',
    'playground_search_reservation_failed',
    'playground_mcp_disabled',
    'playground_mcp_server_disabled',
    'playground_mcp_server_not_found',
    'playground_mcp_timeout',
    'playground_mcp_unavailable',
    'playground_knowledge_embedding_failed',
    'playground_knowledge_embedding_invalid',
    'playground_knowledge_embedding_model_mismatch',
    'playground_comparison_unavailable',
    'playground_task_queue_interrupted',
    'playground_task_queue_unavailable',
    'playground_workflow_run_unavailable',
  ],
  'vision-unsupported': [
    'vision_not_supported',
    'vision_unsupported',
    'image_not_supported',
    'image_unsupported',
    'images_not_supported',
    'unsupported_image',
    'unsupported_image_input',
    'image_input_not_supported',
    'invalid_image',
    'invalid_image_url',
    'image_url_invalid',
    'image_too_large',
    'unsupported_media_type',
    'multimodal_not_supported',
  ],
  'content-filtered': [
    'content_filter',
    'content_filtered',
    'content_policy_violation',
    'content_blocked',
    'sensitive_words_detected',
    'prompt_blocked',
    'moderation_blocked',
    'safety_check_failed',
    'violation_fee.grok.csam',
  ],
  'protocol-mismatch': [
    'invalid_api_type',
    'convert_request_failed',
    'unsupported_protocol',
    'channel_not_support',
    'protocol_not_supported',
    'protocol_mismatch',
    'task_protocol_not_available',
  ],
  'invalid-request': [
    'bad_request_body',
    'invalid_parameter',
    'invalid_argument',
    'invalid_input',
    'missing_required_parameter',
    'unprocessable_entity',
    'read_request_body_failed',
    'json_marshal_failed',
    'count_token_failed',
    'playground_invalid_request',
    'playground_mcp_invalid_request',
    'playground_search_invalid_query',
    'playground_arena_vote_invalid',
    'playground_request_too_large',
    'playground_canvas_reference_invalid',
    'playground_comparison_invalid',
    'playground_workflow_run_invalid',
  ],
  attachment: [
    'playground_attachment_limit_exceeded',
    'playground_upload_content_mismatch',
    'playground_upload_incomplete',
    'playground_document_unsupported',
    'playground_document_limit_exceeded',
    'playground_document_unreadable',
    'playground_document_no_text',
    'playground_egress_limit_exceeded',
  ],
  'playground-limit': [
    'playground_session_limit_exceeded',
    'playground_message_limit_exceeded',
    'playground_artifact_limit_exceeded',
    'playground_canvas_limit_exceeded',
    'playground_canvas_template_limit_exceeded',
    'playground_context_summary_limit_exceeded',
    'playground_developer_options_limit_exceeded',
    'playground_parallel_limit_exceeded',
    'playground_memory_limit_exceeded',
    'playground_memory_content_limit_exceeded',
    'playground_snippet_limit_exceeded',
    'playground_snippet_content_limit_exceeded',
    'playground_snippet_version_limit_exceeded',
    'playground_knowledge_base_limit_exceeded',
    'playground_knowledge_chunk_limit_exceeded',
    'playground_knowledge_document_limit_exceeded',
    'playground_knowledge_text_limit_exceeded',
    'playground_embedding_limit_exceeded',
    'playground_rerank_limit_exceeded',
    'playground_moderation_limit_exceeded',
    'playground_preset_limit_exceeded',
    'playground_system_prompt_limit_exceeded',
    'playground_comparison_limit_exceeded',
    'playground_comparison_storage_limit_exceeded',
    'playground_workflow_run_limit_exceeded',
    'playground_workflow_run_storage_limit_exceeded',
    'playground_task_queue_full',
    'playground_task_queue_payload_too_large',
  ],
  conflict: [
    'conflict',
    'resource_conflict',
    'playground_conflict',
    'playground_attachment_in_use',
    'playground_attachment_request_conflict',
    'playground_artifact_request_conflict',
    'playground_artifact_source_conflict',
    'playground_knowledge_conflict',
    'playground_session_archived',
    'playground_task_not_ready',
    'playground_task_not_cancelable',
    'playground_comparison_conflict',
    'playground_task_queue_not_cancelable',
  ],
  'not-found': [
    'not_found',
    'resource_not_found',
    'response_not_found',
    'artifact_not_found',
    'task_not_found',
    'playground_not_found',
    'playground_task_not_found',
    'playground_task_artifact_not_found',
    'playground_workflow_run_not_found',
    'playground_share_not_found',
    'playground_upload_not_found',
    'playground_log_not_found',
    'playground_comparison_not_found',
    'playground_task_queue_not_found',
    'playground_task_queue_no_task',
  ],
  forbidden: [
    'forbidden',
    'permission_denied',
    'access_denied',
    'playground_group_forbidden',
    'playground_arena_summary_forbidden',
    'playground_task_queue_group_unavailable',
  ],
  'model-price': ['model_price_error'],
}

/**
 * Upstreams that answer with a single generic type instead of a specific code.
 * Only these may be refined by the message text; a specific code that is not in
 * the catalog still falls back to the raw error.
 */
const GENERIC_ERROR_CODES = new Set([
  'error',
  'invalid_request_error',
  'invalid_request',
  'bad_request',
  'request_error',
  'unknown_error',
])

const CONTEXT_PATTERNS = [
  /context length/i,
  /context window/i,
  /maximum context/i,
  /too many tokens/i,
  /token (?:limit|budget)/i,
  /(?:prompt|input|message) is too long/i,
  /reduce the length/i,
  /truncat(?:e|ed) the (?:prompt|input)/i,
  /上下文(?:长度|窗口|超长)/,
  /超出[^。]{0,10}(?:上下文|长度)/,
  /(?:输入|请求|消息)过长/,
]

const VISION_PATTERNS = [
  /(?:image|vision|multimodal)[^.]{0,80}(?:not supported|unsupported|does not support|doesn't support|cannot|invalid|too large)/i,
  /(?:not supported|unsupported|invalid|too large)[^.]{0,80}(?:image|vision|multimodal)/i,
  /(?:does not|doesn't|do not|don't|cannot|can't|not)\s+support[^.]{0,80}(?:image|vision|multimodal)/i,
  /(?:图片|图像)[^。]{0,60}(?:不支持|无法|无效|过大)/,
  /(?:不支持|无法处理|无效)[^。]{0,60}(?:图片|图像)/,
]

const CONTENT_FILTER_PATTERNS = [
  /content (?:filter|policy)/i,
  /content_filter/i,
  /policy violation/i,
  /blocked by (?:safety|policy|content)/i,
  /safety (?:check|system|policy)/i,
  /moderation/i,
  /sensitive word/i,
  /flagged/i,
  /内容(?:过滤|安全|违规)/,
  /敏感词/,
  /(?:已被|被)拦截/,
]

const INSUFFICIENT_PATTERNS = [
  /insufficient (?:quota|balance|credit|funds|wallet)/i,
  /not enough (?:quota|balance|credit|funds)/i,
  /exceeded your current quota/i,
  /billing hard limit/i,
  /payment required/i,
  /out of credits/i,
  /余额不足/,
  /额度不足/,
  /配额不足/,
  /积分不足/,
]

const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /rate_limit/i,
  /too many requests/i,
  /requests per (?:minute|second)/i,
  /\btpm\b/i,
  /resource exhausted/i,
  /限流/,
  /请求过多/,
  /请求频率/,
]

const PROTOCOL_PATTERNS = [
  /convert(?:ing)? (?:the )?request/i,
  /unsupported protocol/i,
  /protocol (?:is )?not (?:supported|available)/i,
  /channel[^.]{0,40}not support/i,
  /not support[^.]{0,40}protocol/i,
  /协议[^。]{0,20}不支持/,
  /不支持[^。]{0,20}协议/,
]

const MODEL_PATTERNS = [
  /model[^.]{0,80}(?:not found|not available|unavailable|does not exist|not supported|decommission|deprecat|unknown)/i,
  /(?:no|none of the) available channels?/i,
  /channel (?:is )?(?:not available|unavailable)/i,
  /模型[^。]{0,40}(?:不存在|不可用|不支持)/,
  /渠道[^。]{0,40}(?:不可用|不存在)/,
]

const SERVICE_PATTERNS = [
  /overloaded/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /upstream[^.]{0,40}(?:error|fail|unavailable)/i,
  /gateway timeout/i,
  /bad gateway/i,
  /timed out/i,
  /connection (?:error|failed|reset)/i,
  /internal server error/i,
  /服务[^。]{0,20}不可用/,
  /连接失败/,
  /超时/,
]

// First match wins: a message that names both an image and a provider outage
// stays in the more specific bucket, so the action buttons keep their point.
const MESSAGE_PATTERNS: readonly (readonly [
  PlaygroundErrorCategory,
  readonly RegExp[],
])[] = [
  ['context-too-long', CONTEXT_PATTERNS],
  ['vision-unsupported', VISION_PATTERNS],
  ['content-filtered', CONTENT_FILTER_PATTERNS],
  ['insufficient-quota', INSUFFICIENT_PATTERNS],
  ['rate-limited', RATE_LIMIT_PATTERNS],
  ['protocol-mismatch', PROTOCOL_PATTERNS],
  ['model-unavailable', MODEL_PATTERNS],
  ['service-unavailable', SERVICE_PATTERNS],
]

function buildCatalogByCode(): ReadonlyMap<
  string,
  PlaygroundErrorCatalogTemplate
> {
  const byCode = new Map<string, PlaygroundErrorCatalogTemplate>()
  for (const [category, codes] of Object.entries(CATEGORY_CODES) as [
    PlaygroundErrorCategory,
    readonly string[],
  ][]) {
    for (const code of codes) {
      byCode.set(code, CATALOG_TEMPLATES[category])
    }
  }
  return byCode
}

const CATALOG_BY_CODE = buildCatalogByCode()

export function normalizePlaygroundErrorCode(code?: string | null): string {
  return code?.trim().toLowerCase() ?? ''
}

function findCategoryByMessage(
  message?: string | null
): PlaygroundErrorCategory | null {
  const text = message?.trim()
  if (!text) return null

  for (const [category, patterns] of MESSAGE_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return category
    }
  }
  return null
}

/**
 * Resolve the catalog entry of an error. Returns null when the code is unknown
 * and the message carries no recognizable pattern, so unknown failures keep
 * rendering their original text.
 */
export function getPlaygroundErrorCatalogEntry(
  code?: string | null,
  message?: string | null
): PlaygroundErrorCatalogEntry | null {
  const normalizedCode = normalizePlaygroundErrorCode(code)
  if (normalizedCode) {
    const template = CATALOG_BY_CODE.get(normalizedCode)
    if (template) {
      return { ...template, code: normalizedCode }
    }
    if (!GENERIC_ERROR_CODES.has(normalizedCode)) {
      return null
    }
  }

  const category = findCategoryByMessage(message)
  if (!category) return null

  return { ...CATALOG_TEMPLATES[category], code: normalizedCode }
}
