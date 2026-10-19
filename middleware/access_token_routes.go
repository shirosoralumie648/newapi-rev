package middleware

import (
	"fmt"
	"maps"
	"slices"
	"sync"

	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
)

type accessTokenRuleKind int

const (
	// accessTokenRuleScope requires the token to carry scope.
	accessTokenRuleScope accessTokenRuleKind = iota + 1
	// accessTokenRuleAny accepts every valid scoped token; the handler applies
	// its own checks.
	accessTokenRuleAny
	// accessTokenRuleSession rejects every access token, legacy ones included.
	accessTokenRuleSession
)

type accessTokenRouteRule struct {
	kind  accessTokenRuleKind
	scope string
}

var (
	accessTokenAnyRule     = accessTokenRouteRule{kind: accessTokenRuleAny}
	accessTokenSessionRule = accessTokenRouteRule{kind: accessTokenRuleSession}
)

func accessTokenScopeRule(scope string) accessTokenRouteRule {
	return accessTokenRouteRule{kind: accessTokenRuleScope, scope: scope}
}

// accessTokenRouteRules declares the token rule of every dashboard route that
// is not guarded by RequirePermission, keyed by method and gin full path.
// Casbin-guarded routes declare themselves through
// DeclareAccessTokenPermissionRoute when they are registered.
var accessTokenRouteRules = map[string]accessTokenRouteRule{
	// router/api-router.go: top level
	"GET /api/models":                     accessTokenScopeRule("profile:read"),
	"GET /api/status/test":                accessTokenScopeRule("log:read"),
	"GET /api/pricing":                    accessTokenAnyRule,
	"GET /api/perf-metrics/summary":       accessTokenAnyRule,
	"GET /api/perf-metrics":               accessTokenAnyRule,
	"GET /api/rankings":                   accessTokenAnyRule,
	"POST /api/oauth/state":               accessTokenSessionRule,
	"POST /api/oauth/email/bind/start":    accessTokenScopeRule("account_security:write"),
	"POST /api/oauth/email/bind/resend":   accessTokenScopeRule("account_security:write"),
	"POST /api/oauth/email/bind":          accessTokenScopeRule("account_security:write"),
	"POST /api/oauth/wechat/bind":         accessTokenScopeRule("account_security:write"),
	"POST /api/oauth/telegram/bind/start": accessTokenSessionRule,
	"GET /api/oauth/:provider":            accessTokenSessionRule,
	"GET /api/verify/methods":             accessTokenAnyRule,
	"POST /api/verify":                    accessTokenAnyRule,

	// router/api-router.go: /api/playground
	"GET /api/playground/usage":                                                  accessTokenSessionRule,
	"GET /api/playground/storage/billing":                                        accessTokenSessionRule,
	"POST /api/playground/workflows/estimate":                                    accessTokenSessionRule,
	"POST /api/playground/workflows/runs":                                        accessTokenSessionRule,
	"POST /api/playground/workflows/runs/:runId/settle":                          accessTokenSessionRule,
	"GET /api/playground/settings":                                               accessTokenSessionRule,
	"GET /api/playground/message-costs":                                          accessTokenSessionRule,
	"GET /api/playground/trash":                                                  accessTokenSessionRule,
	"GET /api/playground/assets":                                                 accessTokenSessionRule,
	"POST /api/playground/tasks/:taskId/cancel":                                  accessTokenSessionRule,
	"PUT /api/playground/tasks/:taskId/artifacts/:artifactKey/pin":               accessTokenSessionRule,
	"GET /api/playground/presets":                                                accessTokenSessionRule,
	"POST /api/playground/presets":                                               accessTokenSessionRule,
	"GET /api/playground/presets/market":                                         accessTokenSessionRule,
	"POST /api/playground/presets/market/:presetId/copy":                         accessTokenSessionRule,
	"POST /api/playground/presets/import":                                        accessTokenSessionRule,
	"GET /api/playground/presets/:presetId":                                      accessTokenSessionRule,
	"PATCH /api/playground/presets/:presetId":                                    accessTokenSessionRule,
	"DELETE /api/playground/presets/:presetId":                                   accessTokenSessionRule,
	"GET /api/playground/presets/:presetId/export":                               accessTokenSessionRule,
	"GET /api/playground/presets/global":                                         accessTokenScopeRule("option:read"),
	"POST /api/playground/presets/global":                                        accessTokenScopeRule("option:write"),
	"POST /api/playground/presets/global/import":                                 accessTokenScopeRule("option:write"),
	"GET /api/playground/presets/global/:presetId":                               accessTokenScopeRule("option:read"),
	"PATCH /api/playground/presets/global/:presetId":                             accessTokenScopeRule("option:write"),
	"DELETE /api/playground/presets/global/:presetId":                            accessTokenScopeRule("option:write"),
	"GET /api/playground/presets/global/:presetId/export":                        accessTokenScopeRule("option:read"),
	"GET /api/playground/knowledge-bases":                                        accessTokenSessionRule,
	"POST /api/playground/knowledge-bases":                                       accessTokenSessionRule,
	"GET /api/playground/knowledge-bases/:kbId":                                  accessTokenSessionRule,
	"PATCH /api/playground/knowledge-bases/:kbId":                                accessTokenSessionRule,
	"DELETE /api/playground/knowledge-bases/:kbId":                               accessTokenSessionRule,
	"GET /api/playground/knowledge-bases/:kbId/documents":                        accessTokenSessionRule,
	"POST /api/playground/knowledge-bases/:kbId/documents":                       accessTokenSessionRule,
	"GET /api/playground/knowledge-bases/:kbId/documents/:documentId":            accessTokenSessionRule,
	"DELETE /api/playground/knowledge-bases/:kbId/documents/:documentId":         accessTokenSessionRule,
	"POST /api/playground/knowledge-bases/:kbId/documents/:documentId/reindex":   accessTokenSessionRule,
	"POST /api/playground/knowledge-bases/:kbId/documents/:documentId/failure":   accessTokenSessionRule,
	"PUT /api/playground/knowledge-bases/:kbId/documents/:documentId/chunks":     accessTokenSessionRule,
	"GET /api/playground/snippets":                                               accessTokenSessionRule,
	"POST /api/playground/snippets":                                              accessTokenSessionRule,
	"GET /api/playground/snippets/:snippetId":                                    accessTokenSessionRule,
	"PATCH /api/playground/snippets/:snippetId":                                  accessTokenSessionRule,
	"DELETE /api/playground/snippets/:snippetId":                                 accessTokenSessionRule,
	"GET /api/playground/memories":                                               accessTokenSessionRule,
	"POST /api/playground/memories":                                              accessTokenSessionRule,
	"GET /api/playground/memories/:memoryId":                                     accessTokenSessionRule,
	"PATCH /api/playground/memories/:memoryId":                                   accessTokenSessionRule,
	"DELETE /api/playground/memories/:memoryId":                                  accessTokenSessionRule,
	"GET /api/playground/sessions":                                               accessTokenSessionRule,
	"POST /api/playground/sessions":                                              accessTokenSessionRule,
	"GET /api/playground/sessions/:id":                                           accessTokenSessionRule,
	"PATCH /api/playground/sessions/:id":                                         accessTokenSessionRule,
	"DELETE /api/playground/sessions/:id":                                        accessTokenSessionRule,
	"POST /api/playground/sessions/:id/restore":                                  accessTokenSessionRule,
	"GET /api/playground/sessions/:id/export":                                    accessTokenSessionRule,
	"GET /api/playground/sessions/:id/messages":                                  accessTokenSessionRule,
	"PATCH /api/playground/sessions/:id/messages":                                accessTokenSessionRule,
	"PUT /api/playground/sessions/:id/messages":                                  accessTokenSessionRule,
	"GET /api/playground/sessions/:id/artifacts":                                 accessTokenSessionRule,
	"POST /api/playground/sessions/:id/artifacts":                                accessTokenSessionRule,
	"GET /api/playground/sessions/:id/artifacts/:artifactId":                     accessTokenSessionRule,
	"GET /api/playground/sessions/:id/artifacts/:artifactId/versions":            accessTokenSessionRule,
	"GET /api/playground/sessions/:id/artifacts/:artifactId/versions/:versionId": accessTokenSessionRule,
	"POST /api/playground/sessions/:id/artifacts/:artifactId/versions":           accessTokenSessionRule,
	"POST /api/playground/sessions/:id/artifacts/:artifactId/restore":            accessTokenSessionRule,
	"DELETE /api/playground/sessions/:id/artifacts/:artifactId":                  accessTokenSessionRule,
	"GET /api/playground/sessions/:id/attachments":                               accessTokenSessionRule,
	"POST /api/playground/sessions/:id/attachments":                              accessTokenSessionRule,
	"GET /api/playground/sessions/:id/attachments/:attachmentId":                 accessTokenSessionRule,
	"GET /api/playground/sessions/:id/attachments/:attachmentId/content":         accessTokenSessionRule,
	"GET /api/playground/sessions/:id/attachments/:attachmentId/text":            accessTokenSessionRule,
	"DELETE /api/playground/sessions/:id/attachments/:attachmentId":              accessTokenSessionRule,
	"GET /api/playground/canvases":                                               accessTokenSessionRule,
	"POST /api/playground/canvases":                                              accessTokenSessionRule,
	"POST /api/playground/canvases/import":                                       accessTokenSessionRule,
	"GET /api/playground/canvases/:canvasId":                                     accessTokenSessionRule,
	"PATCH /api/playground/canvases/:canvasId":                                   accessTokenSessionRule,
	"DELETE /api/playground/canvases/:canvasId":                                  accessTokenSessionRule,
	"POST /api/playground/canvases/:canvasId/restore":                            accessTokenSessionRule,
	"GET /api/playground/canvases/:canvasId/snapshots":                           accessTokenSessionRule,
	"POST /api/playground/canvases/:canvasId/snapshots/:snapshotId/restore":      accessTokenSessionRule,
	"POST /api/playground/canvases/:canvasId/attachments":                        accessTokenSessionRule,
	"GET /api/playground/canvases/:canvasId/export":                              accessTokenSessionRule,
	"POST /api/playground/uploads":                                               accessTokenSessionRule,
	"PUT /api/playground/uploads/:uploadId/content":                              accessTokenSessionRule,
	"POST /api/playground/uploads/:uploadId/complete":                            accessTokenSessionRule,
	"DELETE /api/playground/uploads/:uploadId":                                   accessTokenSessionRule,

	// router/api-router.go: /api/user (self)
	"GET /api/user/sessions":                       accessTokenSessionRule,
	"DELETE /api/user/sessions/:sid":               accessTokenSessionRule,
	"POST /api/user/sessions/revoke-others":        accessTokenSessionRule,
	"GET /api/user/self/groups":                    accessTokenScopeRule("profile:read"),
	"GET /api/user/self":                           accessTokenScopeRule("profile:read"),
	"GET /api/user/models":                         accessTokenScopeRule("profile:read"),
	"PUT /api/user/self":                           accessTokenScopeRule("profile:write"),
	"DELETE /api/user/self":                        accessTokenScopeRule("account_security:write"),
	"GET /api/user/access_tokens":                  accessTokenSessionRule,
	"GET /api/user/access_tokens/catalog":          accessTokenSessionRule,
	"GET /api/user/access_tokens/scopes":           accessTokenSessionRule,
	"POST /api/user/access_tokens":                 accessTokenSessionRule,
	"PATCH /api/user/access_tokens/:id":            accessTokenSessionRule,
	"DELETE /api/user/access_tokens/:id":           accessTokenSessionRule,
	"DELETE /api/user/access_tokens/legacy":        accessTokenSessionRule,
	"GET /api/user/passkey":                        accessTokenScopeRule("account_security:read"),
	"POST /api/user/passkey/register/begin":        accessTokenScopeRule("account_security:write"),
	"POST /api/user/passkey/register/finish":       accessTokenScopeRule("account_security:write"),
	"POST /api/user/passkey/verify/begin":          accessTokenAnyRule,
	"POST /api/user/passkey/verify/finish":         accessTokenAnyRule,
	"DELETE /api/user/passkey":                     accessTokenScopeRule("account_security:write"),
	"GET /api/user/aff":                            accessTokenScopeRule("wallet:read"),
	"GET /api/user/topup/info":                     accessTokenScopeRule("wallet:read"),
	"GET /api/user/topup/self":                     accessTokenScopeRule("wallet:read"),
	"POST /api/user/topup":                         accessTokenScopeRule("wallet:write"),
	"POST /api/user/pay":                           accessTokenScopeRule("wallet:write"),
	"POST /api/user/amount":                        accessTokenScopeRule("wallet:read"),
	"POST /api/user/stripe/pay":                    accessTokenScopeRule("wallet:write"),
	"POST /api/user/stripe/amount":                 accessTokenScopeRule("wallet:read"),
	"POST /api/user/creem/pay":                     accessTokenScopeRule("wallet:write"),
	"POST /api/user/waffo/amount":                  accessTokenScopeRule("wallet:read"),
	"POST /api/user/waffo/pay":                     accessTokenScopeRule("wallet:write"),
	"POST /api/user/waffo-pancake/amount":          accessTokenScopeRule("wallet:read"),
	"POST /api/user/waffo-pancake/pay":             accessTokenScopeRule("wallet:write"),
	"POST /api/user/aff_transfer":                  accessTokenScopeRule("wallet:write"),
	"PUT /api/user/setting":                        accessTokenScopeRule("profile:write"),
	"GET /api/user/2fa/status":                     accessTokenScopeRule("account_security:read"),
	"POST /api/user/2fa/setup":                     accessTokenScopeRule("account_security:write"),
	"POST /api/user/2fa/enable":                    accessTokenScopeRule("account_security:write"),
	"POST /api/user/2fa/disable":                   accessTokenScopeRule("account_security:write"),
	"POST /api/user/2fa/backup_codes":              accessTokenScopeRule("account_security:write"),
	"GET /api/user/checkin":                        accessTokenScopeRule("wallet:read"),
	"POST /api/user/checkin":                       accessTokenScopeRule("wallet:write"),
	"GET /api/user/self/wallet/ledger":             accessTokenScopeRule("wallet:read"),
	"GET /api/user/self/wallet/ledger/export":      accessTokenScopeRule("wallet:read"),
	"GET /api/user/self/wallet/grants":             accessTokenScopeRule("wallet:read"),
	"GET /api/user/self/referrals":                 accessTokenScopeRule("wallet:read"),
	"GET /api/user/self/referral-agent":            accessTokenScopeRule("wallet:read"),
	"GET /api/user/oauth/bindings":                 accessTokenScopeRule("account_security:read"),
	"DELETE /api/user/oauth/bindings/:provider_id": accessTokenScopeRule("account_security:write"),

	// router/api-router.go: /api/user (admin)
	"GET /api/user/":                                   accessTokenScopeRule("user:read"),
	"GET /api/user/topup":                              accessTokenScopeRule("billing:read"),
	"POST /api/user/topup/complete":                    accessTokenScopeRule("billing:write"),
	"POST /api/user/topup/refund":                      accessTokenScopeRule("billing:write"),
	"GET /api/user/search":                             accessTokenScopeRule("user:read"),
	"GET /api/user/:id/oauth/bindings":                 accessTokenScopeRule("user:read"),
	"DELETE /api/user/:id/oauth/bindings/:provider_id": accessTokenScopeRule("user:write"),
	"DELETE /api/user/:id/bindings/:binding_type":      accessTokenScopeRule("user:write"),
	"POST /api/user/:id/inviter":                       accessTokenScopeRule("user:write"),
	"GET /api/user/referral/reviews":                   accessTokenScopeRule("user:read"),
	"POST /api/user/referral/reviews/:id":              accessTokenScopeRule("user:write"),
	"GET /api/user/referral/agents":                    accessTokenScopeRule("user:read"),
	"PUT /api/user/:id/referral-agent":                 accessTokenScopeRule("user:write"),
	"DELETE /api/user/:id/referral-agent":              accessTokenScopeRule("user:write"),
	"GET /api/user/:id/referral-profile":               accessTokenScopeRule("user:read"),
	"POST /api/user/:id/referral-flag":                 accessTokenScopeRule("user:write"),
	"POST /api/user/:id/referral-identity":             accessTokenScopeRule("user:write"),
	"DELETE /api/user/:id/referral-identity":           accessTokenScopeRule("user:write"),
	"GET /api/user/:id":                                accessTokenScopeRule("user:read"),
	"POST /api/user/":                                  accessTokenScopeRule("user:write"),
	"POST /api/user/manage":                            accessTokenScopeRule("user:write"),
	"PUT /api/user/":                                   accessTokenScopeRule("user:write"),
	"DELETE /api/user/:id":                             accessTokenScopeRule("user:write"),
	"DELETE /api/user/:id/reset_passkey":               accessTokenScopeRule("user:write"),
	"GET /api/user/2fa/stats":                          accessTokenScopeRule("user:read"),
	"DELETE /api/user/:id/2fa":                         accessTokenScopeRule("user:write"),
	"GET /api/user/:id/wallet/ledger":                  accessTokenScopeRule("user:read"),
	"GET /api/user/:id/wallet/ledger/export":           accessTokenScopeRule("user:read"),
	"GET /api/user/:id/wallet/reconcile":               accessTokenScopeRule("user:read"),
	"GET /api/user/:id/wallet/grants":                  accessTokenScopeRule("user:read"),
	"GET /api/user/wallet/debts":                       accessTokenScopeRule("user:read"),
	"GET /api/user/playground/storage/ledger":          accessTokenScopeRule("user:read"),
	"GET /api/user/playground/storage/ledger/export":   accessTokenScopeRule("user:read"),
	"GET /api/user/playground/storage/reconcile":       accessTokenScopeRule("user:read"),
	"GET /api/user/wallet/grants/stats":                accessTokenScopeRule("user:read"),
	"POST /api/user/wallet/grants":                     accessTokenScopeRule("user:write"),
	"GET /api/user/referrals":                          accessTokenScopeRule("user:read"),
	"GET /api/user/referrals/export":                   accessTokenScopeRule("user:read"),

	// router/api-router.go: /api/subscription
	"GET /api/subscription/plans":                                    accessTokenScopeRule("wallet:read"),
	"GET /api/subscription/self":                                     accessTokenScopeRule("wallet:read"),
	"PUT /api/subscription/self/preference":                          accessTokenScopeRule("wallet:write"),
	"POST /api/subscription/balance/pay":                             accessTokenScopeRule("wallet:write"),
	"POST /api/subscription/epay/pay":                                accessTokenScopeRule("wallet:write"),
	"POST /api/subscription/stripe/pay":                              accessTokenScopeRule("wallet:write"),
	"POST /api/subscription/creem/pay":                               accessTokenScopeRule("wallet:write"),
	"POST /api/subscription/waffo-pancake/pay":                       accessTokenScopeRule("wallet:write"),
	"GET /api/subscription/admin/plans":                              accessTokenScopeRule("billing:read"),
	"POST /api/subscription/admin/plans":                             accessTokenScopeRule("billing:write"),
	"PUT /api/subscription/admin/plans/:id":                          accessTokenScopeRule("billing:write"),
	"PATCH /api/subscription/admin/plans/:id":                        accessTokenScopeRule("billing:write"),
	"POST /api/subscription/admin/bind":                              accessTokenScopeRule("billing:write"),
	"POST /api/subscription/admin/plans/:id/subscriptions/reset":     accessTokenScopeRule("billing:write"),
	"GET /api/subscription/admin/users/:id/subscriptions":            accessTokenScopeRule("billing:read"),
	"POST /api/subscription/admin/users/:id/subscriptions":           accessTokenScopeRule("billing:write"),
	"POST /api/subscription/admin/users/:id/subscriptions/reset":     accessTokenScopeRule("billing:write"),
	"POST /api/subscription/admin/user_subscriptions/:id/invalidate": accessTokenScopeRule("billing:write"),
	"DELETE /api/subscription/admin/user_subscriptions/:id":          accessTokenScopeRule("billing:write"),

	// router/api-router.go: /api/option
	"GET /api/option/":                                           accessTokenScopeRule("option:read"),
	"GET /api/option/request_policy":                             accessTokenScopeRule("option:read"),
	"PATCH /api/option/request_policy":                           accessTokenScopeRule("option:write"),
	"PUT /api/option/":                                           accessTokenScopeRule("option:write"),
	"PUT /api/option/passkey/domains":                            accessTokenScopeRule("option:write"),
	"GET /api/option/model_pricing":                              accessTokenScopeRule("option:read"),
	"PATCH /api/option/model_pricing":                            accessTokenScopeRule("option:write"),
	"POST /api/option/model_pricing/convert":                     accessTokenScopeRule("option:read"),
	"POST /api/option/model_pricing/preview":                     accessTokenScopeRule("option:read"),
	"POST /api/option/payment_compliance":                        accessTokenSessionRule,
	"GET /api/option/channel_affinity_cache":                     accessTokenScopeRule("option:read"),
	"DELETE /api/option/channel_affinity_cache":                  accessTokenScopeRule("option:write"),
	"POST /api/option/rest_model_ratio":                          accessTokenScopeRule("option:write"),
	"GET /api/option/waffo-pancake/catalog":                      accessTokenScopeRule("option:read"),
	"POST /api/option/waffo-pancake/pair":                        accessTokenScopeRule("option:write"),
	"POST /api/option/waffo-pancake/save":                        accessTokenScopeRule("option:write"),
	"POST /api/option/waffo-pancake/subscription-product":        accessTokenScopeRule("option:write"),
	"GET /api/option/waffo-pancake/subscription-product-options": accessTokenScopeRule("option:read"),

	// router/api-router.go: /api/custom-oauth-provider, /api/ratio_sync
	"POST /api/custom-oauth-provider/discovery": accessTokenScopeRule("option:write"),
	"GET /api/custom-oauth-provider/":           accessTokenScopeRule("option:read"),
	"GET /api/custom-oauth-provider/:id":        accessTokenScopeRule("option:read"),
	"POST /api/custom-oauth-provider/":          accessTokenScopeRule("option:write"),
	"PUT /api/custom-oauth-provider/:id":        accessTokenScopeRule("option:write"),
	"DELETE /api/custom-oauth-provider/:id":     accessTokenScopeRule("option:write"),
	"GET /api/ratio_sync/channels":              accessTokenScopeRule("option:read"),
	"POST /api/ratio_sync/fetch":                accessTokenScopeRule("option:write"),

	// router/api-router.go: /api/performance, /api/system-task, /api/system-info
	"GET /api/performance/stats":                   accessTokenScopeRule("ops:read"),
	"DELETE /api/performance/disk_cache":           accessTokenScopeRule("ops:write"),
	"POST /api/performance/reset_stats":            accessTokenScopeRule("ops:write"),
	"POST /api/performance/gc":                     accessTokenScopeRule("ops:write"),
	"GET /api/performance/logs":                    accessTokenScopeRule("ops:read"),
	"DELETE /api/performance/logs":                 accessTokenScopeRule("ops:write"),
	"POST /api/system-task/log-cleanup":            accessTokenScopeRule("ops:write"),
	"GET /api/system-task/list":                    accessTokenScopeRule("ops:read"),
	"DELETE /api/system-task/history":              accessTokenScopeRule("ops:write"),
	"GET /api/system-task/current":                 accessTokenScopeRule("ops:read"),
	"GET /api/system-task/:task_id":                accessTokenScopeRule("ops:read"),
	"GET /api/system-info/instances":               accessTokenScopeRule("ops:read"),
	"DELETE /api/system-info/stale-instances":      accessTokenScopeRule("ops:write"),
	"DELETE /api/system-info/instances/:node_name": accessTokenScopeRule("ops:write"),

	// router/api-router.go: /api/plugin/task
	"GET /api/plugin/task":                           accessTokenScopeRule("plugin:read"),
	"POST /api/plugin/task":                          accessTokenScopeRule("plugin:write"),
	"PUT /api/plugin/task":                           accessTokenScopeRule("plugin:write"),
	"GET /api/plugin/task/runtime/status":            accessTokenScopeRule("plugin:read"),
	"GET /api/plugin/task/marketplace/sources":       accessTokenScopeRule("plugin:read"),
	"PUT /api/plugin/task/marketplace/sources":       accessTokenScopeRule("plugin:write"),
	"GET /api/plugin/task/:key":                      accessTokenScopeRule("plugin:read"),
	"GET /api/plugin/task/:key/icon":                 accessTokenScopeRule("plugin:read"),
	"GET /api/plugin/task/:key/versions":             accessTokenScopeRule("plugin:read"),
	"POST /api/plugin/task/:key/activate":            accessTokenScopeRule("plugin:write"),
	"POST /api/plugin/task/:key/status":              accessTokenScopeRule("plugin:write"),
	"POST /api/plugin/task/:key/dryrun":              accessTokenScopeRule("plugin:write"),
	"DELETE /api/plugin/task/:key/versions/:version": accessTokenScopeRule("plugin:write"),

	// router/channel-router.go: the key route is RootAuth, not Casbin-guarded.
	"POST /api/channel/:id/key": accessTokenScopeRule(service.AccessTokenScopeOf(authz.ChannelSecretView)),

	// router/authz-router.go
	"GET /api/authz/catalog": accessTokenScopeRule("user:read"),

	// router/api-router.go: /api/token
	"GET /api/token/":            accessTokenScopeRule("api_key:read"),
	"GET /api/token/search":      accessTokenScopeRule("api_key:read"),
	"GET /api/token/auto-groups": accessTokenScopeRule("api_key:read"),
	"GET /api/token/:id":         accessTokenScopeRule("api_key:read"),
	"POST /api/token/:id/key":    accessTokenScopeRule("api_key:reveal"),
	"POST /api/token/":           accessTokenScopeRule("api_key:write"),
	"PUT /api/token/":            accessTokenScopeRule("api_key:write"),
	"DELETE /api/token/:id":      accessTokenScopeRule("api_key:write"),
	"POST /api/token/batch":      accessTokenScopeRule("api_key:write"),
	"POST /api/token/batch/keys": accessTokenScopeRule("api_key:reveal"),

	// router/api-router.go: /api/redemption
	"GET /api/redemption/":           accessTokenScopeRule("redemption:read"),
	"GET /api/redemption/search":     accessTokenScopeRule("redemption:read"),
	"GET /api/redemption/:id":        accessTokenScopeRule("redemption:read"),
	"POST /api/redemption/":          accessTokenScopeRule("redemption:write"),
	"POST /api/redemption/batch":     accessTokenScopeRule("redemption:write"),
	"PUT /api/redemption/":           accessTokenScopeRule("redemption:write"),
	"DELETE /api/redemption/invalid": accessTokenScopeRule("redemption:write"),
	"DELETE /api/redemption/:id":     accessTokenScopeRule("redemption:write"),

	// router/api-router.go: /api/audit, /api/log, /api/data
	"GET /api/audit/self":                       accessTokenScopeRule("usage:read"),
	"GET /api/log/":                             accessTokenScopeRule("log:read"),
	"GET /api/log/stat":                         accessTokenScopeRule("log:read"),
	"GET /api/log/self/stat":                    accessTokenScopeRule("usage:read"),
	"GET /api/log/channel_affinity_usage_cache": accessTokenScopeRule("log:read"),
	"GET /api/log/search":                       accessTokenScopeRule("log:read"),
	"GET /api/log/self":                         accessTokenScopeRule("usage:read"),
	"GET /api/log/self/search":                  accessTokenScopeRule("usage:read"),
	"GET /api/log/export":                       accessTokenScopeRule("log:read"),
	"GET /api/log/self/export":                  accessTokenScopeRule("usage:read"),
	"GET /api/data/":                            accessTokenScopeRule("log:read"),
	"GET /api/data/users":                       accessTokenScopeRule("log:read"),
	"GET /api/data/self":                        accessTokenScopeRule("usage:read"),
	"GET /api/data/flow":                        accessTokenScopeRule("log:read"),
	"GET /api/data/flow/self":                   accessTokenScopeRule("usage:read"),

	// router/api-router.go: /api/group, /api/prefill_group
	"GET /api/group/":               accessTokenScopeRule("group:read"),
	"GET /api/prefill_group/":       accessTokenScopeRule("group:read"),
	"POST /api/prefill_group/":      accessTokenScopeRule("group:write"),
	"PUT /api/prefill_group/":       accessTokenScopeRule("group:write"),
	"DELETE /api/prefill_group/:id": accessTokenScopeRule("group:write"),

	// router/api-router.go: /api/mj, /api/task
	"GET /api/mj/self":                 accessTokenScopeRule("usage:read"),
	"GET /api/mj/":                     accessTokenScopeRule("log:read"),
	"GET /api/task/self":               accessTokenScopeRule("usage:read"),
	"GET /api/task":                    accessTokenScopeRule("log:read"),
	"GET /api/task/:task_id/artifacts": accessTokenScopeRule("usage:read"),

	// router/api-router.go: /api/vendors, /api/models (admin)
	"POST /api/vendors/operations/preview":  accessTokenScopeRule("model:read"),
	"POST /api/vendors/operations":          accessTokenScopeRule("model:write"),
	"GET /api/vendors/":                     accessTokenScopeRule("model:read"),
	"GET /api/vendors/search":               accessTokenScopeRule("model:read"),
	"GET /api/vendors/:id":                  accessTokenScopeRule("model:read"),
	"POST /api/vendors/":                    accessTokenScopeRule("model:write"),
	"PUT /api/vendors/":                     accessTokenScopeRule("model:write"),
	"DELETE /api/vendors/:id":               accessTokenScopeRule("model:write"),
	"GET /api/models/sync_upstream/preview": accessTokenScopeRule("model:read"),
	"POST /api/models/sync_upstream":        accessTokenScopeRule("model:write"),
	"POST /api/models/delete":               accessTokenScopeRule("model:write"),
	"GET /api/models/missing":               accessTokenScopeRule("model:read"),
	"GET /api/models/":                      accessTokenScopeRule("model:read"),
	"GET /api/models/search":                accessTokenScopeRule("model:read"),
	"GET /api/models/:id":                   accessTokenScopeRule("model:read"),
	"POST /api/models/":                     accessTokenScopeRule("model:write"),
	"PUT /api/models/":                      accessTokenScopeRule("model:write"),
	"DELETE /api/models/:id":                accessTokenScopeRule("model:write"),

	// router/api-router.go: /api/deployments
	"GET /api/deployments/settings":                     accessTokenScopeRule("deployment:read"),
	"POST /api/deployments/settings/test-connection":    accessTokenScopeRule("deployment:write"),
	"GET /api/deployments/":                             accessTokenScopeRule("deployment:read"),
	"GET /api/deployments/search":                       accessTokenScopeRule("deployment:read"),
	"POST /api/deployments/test-connection":             accessTokenScopeRule("deployment:write"),
	"GET /api/deployments/hardware-types":               accessTokenScopeRule("deployment:read"),
	"GET /api/deployments/locations":                    accessTokenScopeRule("deployment:read"),
	"GET /api/deployments/available-replicas":           accessTokenScopeRule("deployment:read"),
	"POST /api/deployments/price-estimation":            accessTokenScopeRule("deployment:read"),
	"GET /api/deployments/check-name":                   accessTokenScopeRule("deployment:read"),
	"POST /api/deployments/":                            accessTokenScopeRule("deployment:write"),
	"GET /api/deployments/:id":                          accessTokenScopeRule("deployment:read"),
	"GET /api/deployments/:id/logs":                     accessTokenScopeRule("deployment:read"),
	"GET /api/deployments/:id/containers":               accessTokenScopeRule("deployment:read"),
	"GET /api/deployments/:id/containers/:container_id": accessTokenScopeRule("deployment:read"),
	"PUT /api/deployments/:id":                          accessTokenScopeRule("deployment:write"),
	"PUT /api/deployments/:id/name":                     accessTokenScopeRule("deployment:write"),
	"POST /api/deployments/:id/extend":                  accessTokenScopeRule("deployment:write"),
	"DELETE /api/deployments/:id":                       accessTokenScopeRule("deployment:write"),

	// router/relay-router.go: the Playground workspace, chat and media
	// bridges alike, is session-only.
	"POST /pg/chat/completions":     accessTokenSessionRule,
	"POST /pg/images/generations":   accessTokenSessionRule,
	"POST /pg/images/edits":         accessTokenSessionRule,
	"POST /pg/videos":               accessTokenSessionRule,
	"POST /pg/embeddings":           accessTokenSessionRule,
	"POST /pg/audio/speech":         accessTokenSessionRule,
	"POST /pg/audio/transcriptions": accessTokenSessionRule,
}

var (
	permissionRouteRulesMu sync.RWMutex
	permissionRouteRules   = map[string]accessTokenRouteRule{}
)

// DeclareAccessTokenPermissionRoute records that the Casbin permission guarding
// a route is also the token scope it requires. It runs while routes are
// registered and panics on conflicting declarations.
func DeclareAccessTokenPermissionRoute(method, fullPath string, permission authz.Permission) {
	key := method + " " + fullPath
	rule := accessTokenScopeRule(service.AccessTokenScopeOf(permission))
	if _, ok := accessTokenRouteRules[key]; ok {
		panic(fmt.Sprintf("access token route %s is declared twice", key))
	}
	permissionRouteRulesMu.Lock()
	defer permissionRouteRulesMu.Unlock()
	if existing, ok := permissionRouteRules[key]; ok && existing != rule {
		panic(fmt.Sprintf("access token route %s is declared with %s and %s", key, existing.scope, rule.scope))
	}
	permissionRouteRules[key] = rule
}

// AccessTokenRouteRule returns the rule for "METHOD /full/path".
func AccessTokenRouteRule(key string) (accessTokenRouteRule, bool) {
	if rule, ok := accessTokenRouteRules[key]; ok {
		return rule, true
	}
	permissionRouteRulesMu.RLock()
	defer permissionRouteRulesMu.RUnlock()
	rule, ok := permissionRouteRules[key]
	return rule, ok
}

// AccessTokenRouteRuleKeys lists every declared route key, sorted.
func AccessTokenRouteRuleKeys() []string {
	permissionRouteRulesMu.RLock()
	keys := slices.Collect(maps.Keys(permissionRouteRules))
	permissionRouteRulesMu.RUnlock()
	keys = slices.AppendSeq(keys, maps.Keys(accessTokenRouteRules))
	slices.Sort(keys)
	return keys
}

// Scope returns the token scope the rule requires, or "" for any/session rules.
func (rule accessTokenRouteRule) Scope() string {
	return rule.scope
}

// Kind names the rule category: "scope", "any" or "session".
func (rule accessTokenRouteRule) Kind() string {
	switch rule.kind {
	case accessTokenRuleScope:
		return "scope"
	case accessTokenRuleAny:
		return "any"
	case accessTokenRuleSession:
		return "session"
	}
	return ""
}
