package controller

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/group_setting"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

type tokenAutoGroupsInput struct {
	Set    bool
	Groups []string
}

func (input *tokenAutoGroupsInput) UnmarshalJSON(data []byte) error {
	input.Set = true
	if strings.TrimSpace(string(data)) == "null" {
		input.Groups = nil
		return nil
	}
	return common.Unmarshal(data, &input.Groups)
}

type tokenRequest struct {
	model.Token
	AutoGroups tokenAutoGroupsInput `json:"auto_groups"`
	// 指针区分“未传”和显式 false：新建时未传即开启，更新时未传则保留原值。
	AllowUserQuotaQuery *bool `json:"allow_user_quota_query"`
}

type tokenResponse struct {
	*model.Token
	AutoGroups []string `json:"auto_groups"`
}

func maxTokenQuota() int {
	quota, err := common.WalletQuotaFromDecimalStrict(
		decimal.NewFromInt(1_000_000_000).Mul(decimal.NewFromFloat(common.QuotaPerUnit)),
	)
	if err != nil {
		return common.MaxWalletQuota
	}
	return quota
}

// validateTokenPeriodQuota 校验并归一化令牌的周期预算配置：未启用时清空重置
// 周期；启用时必须给出 day/week/month 且预算在有效范围内。周期窗口状态由
// 服务端维护，这里只处理客户端可写的配置列。
func validateTokenPeriodQuota(c *gin.Context, token *model.Token) bool {
	if token.PeriodQuota < 0 {
		common.ApiErrorT(c, "Quota value cannot be negative")
		return false
	}
	token.PeriodResetPeriod = strings.TrimSpace(token.PeriodResetPeriod)
	if token.PeriodQuota == 0 || token.PeriodResetPeriod == "" {
		token.PeriodQuota = 0
		token.PeriodResetPeriod = ""
		return true
	}
	switch token.PeriodResetPeriod {
	case model.TokenPeriodDaily, model.TokenPeriodWeekly, model.TokenPeriodMonthly:
	default:
		common.ApiErrorT(c, "Invalid periodic reset cycle")
		return false
	}
	maxQuotaValue := maxTokenQuota()
	if token.PeriodQuota > maxQuotaValue {
		common.ApiErrorT(c, "Quota value exceeds valid range, maximum is {{max}}", map[string]any{"max": logger.FormatQuota(maxQuotaValue)})
		return false
	}
	return true
}

// validateTokenRateLimits 校验令牌级准入限制：0 表示不限制，负值或超出上限
// 时拒绝保存，避免错字造成长期限流或绕过限制。并发数不适用于令牌，按 0 传入。
func validateTokenRateLimits(c *gin.Context, token *model.Token) bool {
	if err := dto.ValidateRateLimits(0, token.RPMLimit, token.TPMLimit); err != nil {
		common.ApiErrorT(c, "Invalid token rate limits: {{error}}", map[string]any{"error": err.Error()})
		return false
	}
	return true
}

func buildMaskedTokenResponse(token *model.Token) *tokenResponse {
	if token == nil {
		return nil
	}
	maskedToken := *token
	maskedToken.Key = token.GetMaskedKey()
	autoGroups, err := token.GetAutoGroups()
	if err != nil {
		common.SysError(common.LogText("failed to parse auto groups for token %d: %v", token.Id, err))
		autoGroups = nil
	}
	if len(autoGroups) == 0 {
		autoGroups = nil
	}
	return &tokenResponse{Token: &maskedToken, AutoGroups: autoGroups}
}

func buildMaskedTokenResponses(tokens []*model.Token) []*tokenResponse {
	maskedTokens := make([]*tokenResponse, 0, len(tokens))
	for _, token := range tokens {
		maskedTokens = append(maskedTokens, buildMaskedTokenResponse(token))
	}
	return maskedTokens
}

func getTokenRequestUserGroup(c *gin.Context) (string, error) {
	if userGroup := common.GetContextKeyString(c, constant.ContextKeyUserGroup); userGroup != "" {
		return userGroup, nil
	}
	if userGroup := c.GetString("group"); userGroup != "" {
		return userGroup, nil
	}
	return model.GetUserGroup(c.GetInt("id"), false)
}

func setTokenAutoGroups(c *gin.Context, token *model.Token, groups []string) bool {
	if len(groups) == 0 {
		if err := token.SetAutoGroups(nil); err != nil {
			common.ApiError(c, err)
			return false
		}
		return true
	}

	maxCount := setting.GetMaxTokenAutoGroups()
	if len(groups) > maxCount {
		common.ApiErrorT(c, "A token can select at most {{max}} Auto groups", map[string]any{"max": maxCount})
		return false
	}

	userGroup, err := getTokenRequestUserGroup(c)
	if err != nil {
		common.ApiError(c, err)
		return false
	}
	// Store the stable identifiers: a submitted display name is translated so a
	// later rename can never invalidate the snapshot.
	resolved := make([]string, 0, len(groups))
	seen := make(map[string]struct{}, len(groups))
	for _, group := range groups {
		group = group_setting.ResolveGroupID(group)
		if _, ok := seen[group]; ok {
			common.ApiErrorT(c, "Auto group {{group}} is duplicated", map[string]any{"group": group})
			return false
		}
		seen[group] = struct{}{}
		if !service.IsUserSelectableGroup(userGroup, group) {
			common.ApiErrorT(c, "Auto group {{group}} is unavailable or unauthorized", map[string]any{"group": group})
			return false
		}
		resolved = append(resolved, group)
	}

	if err := token.SetAutoGroups(resolved); err != nil {
		common.ApiError(c, err)
		return false
	}
	return true
}

func GetAllTokens(c *gin.Context) {
	userId := c.GetInt("id")
	pageInfo := common.GetPageQuery(c)
	tokens, err := model.GetAllUserTokens(userId, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	total, _ := model.CountUserTokens(userId)
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(buildMaskedTokenResponses(tokens))
	common.ApiSuccess(c, pageInfo)
}

func SearchTokens(c *gin.Context) {
	userId := c.GetInt("id")
	keyword := c.Query("keyword")
	token := c.Query("token")

	pageInfo := common.GetPageQuery(c)

	tokens, total, err := model.SearchUserTokens(userId, keyword, token, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(buildMaskedTokenResponses(tokens))
	common.ApiSuccess(c, pageInfo)
}

func GetToken(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	userId := c.GetInt("id")
	if err != nil {
		common.ApiError(c, err)
		return
	}
	token, err := model.GetTokenByIds(id, userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, buildMaskedTokenResponse(token))
}

func GetTokenAutoGroups(c *gin.Context) {
	userGroup, err := getTokenRequestUserGroup(c)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"groups":    service.GetUserAutoGroup(userGroup),
		"max_count": setting.GetMaxTokenAutoGroups(),
	})
}

func GetTokenKey(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	userId := c.GetInt("id")
	if err != nil {
		common.ApiError(c, err)
		return
	}
	token, err := model.GetTokenByIds(id, userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	params := tokenAuditParams(c)
	params["id"], params["name"] = token.Id, token.Name
	common.SetContextKey(c, constant.ContextKeyTokenAuditSucceeded, true)
	common.ApiSuccess(c, gin.H{
		"key": token.GetFullKey(),
	})
}

func GetTokenStatus(c *gin.Context) {
	tokenId := c.GetInt("token_id")
	userId := c.GetInt("id")
	token, err := model.GetTokenByIds(tokenId, userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	expiredAt := token.ExpiredTime
	if expiredAt == -1 {
		expiredAt = 0
	}
	c.JSON(http.StatusOK, gin.H{
		"object":          "credit_summary",
		"total_granted":   token.RemainQuota,
		"total_used":      0, // not supported currently
		"total_available": token.RemainQuota,
		"expires_at":      expiredAt * 1000,
	})
}

func GetTokenUsage(c *gin.Context) {
	authHeader := c.GetHeader("Authorization")
	if authHeader == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"success": false,
			"message": "No Authorization header",
		})
		return
	}

	parts := strings.Split(authHeader, " ")
	if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"success": false,
			"message": "Invalid Bearer token",
		})
		return
	}
	tokenKey := parts[1]

	token, err := model.GetTokenByKey(strings.TrimPrefix(tokenKey, "sk-"), false)
	if err != nil {
		common.SysError(common.LogText("failed to get token by key: %s", err.Error()))
		common.ApiErrorI18n(c, i18n.MsgTokenGetInfoFailed)
		return
	}

	expiredAt := token.ExpiredTime
	if expiredAt == -1 {
		expiredAt = 0
	}

	data := gin.H{
		"object":               "token_usage",
		"name":                 token.Name,
		"total_granted":        token.RemainQuota + token.UsedQuota,
		"total_used":           token.UsedQuota,
		"total_available":      token.RemainQuota,
		"unlimited_quota":      token.UnlimitedQuota,
		"model_limits":         token.GetModelLimitsMap(),
		"model_limits_enabled": token.ModelLimitsEnabled,
		"expires_at":           expiredAt,
		"period_quota":         token.PeriodQuota,
		"period_reset_period":  token.PeriodResetPeriod,
		"period_used":          token.PeriodBudgetUsed(common.GetTimestamp()),
		"period_window_start":  token.PeriodWindowStart,
	}
	// 用户额度只在令牌允许时返回；IP 白名单已由 TokenAuthReadOnly 检查。
	if token.AllowUserQuotaQuery {
		userQuota, err := model.GetUserQuota(token.UserId, false)
		var userUsedQuota int
		if err == nil {
			userUsedQuota, err = model.GetUserUsedQuota(token.UserId)
		}
		if err != nil {
			common.SysError(common.LogText("failed to get user quota: %s", err.Error()))
			common.ApiErrorI18n(c, i18n.MsgTokenGetInfoFailed)
			return
		}
		data["user_quota"] = gin.H{
			"total_available": userQuota,
			"total_used":      userUsedQuota,
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    true,
		"message": "ok",
		"data":    data,
	})
}

func AddToken(c *gin.Context) {
	request := tokenRequest{}
	err := c.ShouldBindJSON(&request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	token := request.Token
	if len(token.Name) > 50 {
		common.ApiErrorT(c, "Token name is too long")
		return
	}
	params := tokenAuditParams(c)
	params["name"] = token.Name
	// 非无限额度时，检查额度值是否超出有效范围
	if !token.UnlimitedQuota {
		if token.RemainQuota < 0 {
			common.ApiErrorT(c, "Quota value cannot be negative")
			return
		}
		maxQuotaValue := maxTokenQuota()
		if token.RemainQuota > maxQuotaValue {
			common.ApiErrorT(c, "Quota value exceeds valid range, maximum is {{max}}", map[string]any{"max": logger.FormatQuota(maxQuotaValue)})
			return
		}
	}
	if !validateTokenPeriodQuota(c, &token) {
		return
	}
	if !validateTokenRateLimits(c, &token) {
		return
	}
	// 检查用户令牌数量是否已达上限
	maxTokens := operation_setting.GetMaxUserTokens()
	count, err := model.CountUserTokens(c.GetInt("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if int(count) >= maxTokens {
		common.ApiErrorT(c, "Maximum number of tokens reached ({{max}})", map[string]any{"max": maxTokens})
		return
	}
	// Store the stable identifier so a display-name change cannot invalidate the
	// token; an already-stored legacy reference keeps its original value.
	token.Group = group_setting.ResolveGroupID(token.Group)
	if token.Group == "auto" {
		if !setTokenAutoGroups(c, &token, request.AutoGroups.Groups) {
			return
		}
	} else {
		token.CrossGroupRetry = false
		_ = token.SetAutoGroups(nil)
	}
	key, err := common.GenerateKey()
	if err != nil {
		common.ApiErrorT(c, "Failed to generate token")
		common.SysLog(common.LogText("failed to generate token key: %s", err.Error()))
		return
	}
	cleanToken := model.Token{
		UserId:             c.GetInt("id"),
		Name:               token.Name,
		Key:                key,
		CreatedTime:        common.GetTimestamp(),
		AccessedTime:       common.GetTimestamp(),
		ExpiredTime:        token.ExpiredTime,
		RemainQuota:        token.RemainQuota,
		UnlimitedQuota:     token.UnlimitedQuota,
		ModelLimitsEnabled: token.ModelLimitsEnabled,
		ModelLimits:        token.ModelLimits,
		AllowIps:           token.AllowIps,
		Group:              token.Group,
		CrossGroupRetry:    token.CrossGroupRetry,
		AutoGroups:         token.AutoGroups,
		PeriodQuota:        token.PeriodQuota,
		PeriodResetPeriod:  token.PeriodResetPeriod,
		RPMLimit:           token.RPMLimit,
		TPMLimit:           token.TPMLimit,
	}
	cleanToken.AllowUserQuotaQuery = request.AllowUserQuotaQuery == nil || *request.AllowUserQuotaQuery
	err = cleanToken.Insert()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	params["id"] = cleanToken.Id
	common.SetContextKey(c, constant.ContextKeyTokenAuditSucceeded, true)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
	})
}

func DeleteToken(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	userId := c.GetInt("id")
	token, err := model.GetTokenByIds(id, userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	params := tokenAuditParams(c)
	params["id"], params["name"] = token.Id, token.Name
	err = token.Delete()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.SetContextKey(c, constant.ContextKeyTokenAuditSucceeded, true)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
	})
}

func UpdateToken(c *gin.Context) {
	userId := c.GetInt("id")
	statusOnly := c.Query("status_only")
	request := tokenRequest{}
	err := c.ShouldBindJSON(&request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	token := request.Token
	params := tokenAuditParams(c)
	if token.Id > 0 {
		params["id"] = token.Id
	}
	if len(token.Name) > 50 {
		common.ApiErrorT(c, "Token name is too long")
		return
	}
	if !token.UnlimitedQuota {
		if token.RemainQuota < 0 {
			common.ApiErrorT(c, "Quota value cannot be negative")
			return
		}
		maxQuotaValue := maxTokenQuota()
		if token.RemainQuota > maxQuotaValue {
			common.ApiErrorT(c, "Quota value exceeds valid range, maximum is {{max}}", map[string]any{"max": logger.FormatQuota(maxQuotaValue)})
			return
		}
	}
	if !validateTokenPeriodQuota(c, &token) {
		return
	}
	if !validateTokenRateLimits(c, &token) {
		return
	}
	cleanToken, err := model.GetTokenByIds(token.Id, userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	params["name"] = cleanToken.Name
	previous := *cleanToken
	if token.Status == common.TokenStatusEnabled {
		if cleanToken.Status == common.TokenStatusExpired && cleanToken.ExpiredTime <= common.GetTimestamp() && cleanToken.ExpiredTime != -1 {
			common.ApiErrorT(c, "Token has expired and cannot be enabled. Please modify the expiration time or set it to never expire")
			return
		}
		if cleanToken.Status == common.TokenStatusExhausted && cleanToken.RemainQuota <= 0 && !cleanToken.UnlimitedQuota {
			common.ApiErrorT(c, "Token quota is exhausted and cannot be enabled. Please modify the remaining quota or set it to unlimited")
			return
		}
	}
	var quotaChange *model.TokenQuotaChange
	if statusOnly != "" {
		cleanToken.Status = token.Status
		// 状态单独更新不得顺带写回额度快照，否则会覆盖并发扣费。
		err = cleanToken.Update()
	} else {
		// If you add more fields, please also update token.Update()
		cleanToken.Name = token.Name
		cleanToken.ExpiredTime = token.ExpiredTime
		cleanToken.RemainQuota = token.RemainQuota
		cleanToken.UnlimitedQuota = token.UnlimitedQuota
		cleanToken.ModelLimitsEnabled = token.ModelLimitsEnabled
		cleanToken.ModelLimits = token.ModelLimits
		cleanToken.AllowIps = token.AllowIps
		if request.AllowUserQuotaQuery != nil {
			cleanToken.AllowUserQuotaQuery = *request.AllowUserQuotaQuery
		}
		// 周期窗口状态（period_used / period_window_start）由 UpdateWithQuotaTarget
		// 根据提交的配置推导，客户端 JSON 不能直接写入。
		cleanToken.PeriodQuota = token.PeriodQuota
		cleanToken.PeriodResetPeriod = token.PeriodResetPeriod
		cleanToken.RPMLimit = token.RPMLimit
		cleanToken.TPMLimit = token.TPMLimit
		// Store the stable identifier: a submitted display name is translated so
		// the token keeps working after the display name changes again.
		cleanToken.Group = group_setting.ResolveGroupID(token.Group)
		cleanToken.CrossGroupRetry = token.CrossGroupRetry
		if cleanToken.Group != "auto" {
			cleanToken.CrossGroupRetry = false
			_ = cleanToken.SetAutoGroups(nil)
		} else if request.AutoGroups.Set {
			if !setTokenAutoGroups(c, cleanToken, request.AutoGroups.Groups) {
				return
			}
		}
		// 差额更新额度：快照读取之后发生的并发扣费不能被旧快照覆盖。
		quotaChange, err = cleanToken.UpdateWithQuotaTarget(previous.RemainQuota)
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	params["name"] = cleanToken.Name
	if statusOnly != "" {
		params["from"], params["to"] = previous.Status, cleanToken.Status
	} else {
		changedFields := []string{}
		for _, field := range []struct {
			name    string
			changed bool
		}{
			{"name", previous.Name != cleanToken.Name},
			{"expired_time", previous.ExpiredTime != cleanToken.ExpiredTime},
			// 按请求意图判断；并发扣费导致的余额变化由 from/to 记录。
			{"remain_quota", previous.RemainQuota != token.RemainQuota},
			{"unlimited_quota", previous.UnlimitedQuota != cleanToken.UnlimitedQuota},
			{"model_limits_enabled", previous.ModelLimitsEnabled != cleanToken.ModelLimitsEnabled},
			{"model_limits", previous.ModelLimits != cleanToken.ModelLimits},
			{"allow_ips", (previous.AllowIps == nil) != (cleanToken.AllowIps == nil) ||
				(previous.AllowIps != nil && cleanToken.AllowIps != nil && *previous.AllowIps != *cleanToken.AllowIps)},
			{"allow_user_quota_query", previous.AllowUserQuotaQuery != cleanToken.AllowUserQuotaQuery},
			{"group", previous.Group != cleanToken.Group},
			{"cross_group_retry", previous.CrossGroupRetry != cleanToken.CrossGroupRetry},
			{"auto_groups", previous.AutoGroups != cleanToken.AutoGroups},
			{"period_quota", previous.PeriodQuota != cleanToken.PeriodQuota},
			{"period_reset_period", previous.PeriodResetPeriod != cleanToken.PeriodResetPeriod},
			{"rpm_limit", previous.RPMLimit != cleanToken.RPMLimit},
			{"tpm_limit", previous.TPMLimit != cleanToken.TPMLimit},
		} {
			if field.changed {
				changedFields = append(changedFields, field.name)
			}
		}
		params["changed_fields"] = changedFields
		// 管理日志记录已提交的额度变化（from/to 为提交后的前后值）。
		if quotaChange != nil {
			params["from"], params["to"] = quotaChange.Before, quotaChange.After
		}
	}
	common.SetContextKey(c, constant.ContextKeyTokenAuditSucceeded, true)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    buildMaskedTokenResponse(cleanToken),
	})
}

type TokenBatch struct {
	Ids []int `json:"ids"`
}

func DeleteTokenBatch(c *gin.Context) {
	tokenBatch := TokenBatch{}
	if err := c.ShouldBindJSON(&tokenBatch); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	params := tokenBatchAuditParams(c, tokenBatch.Ids)
	if len(tokenBatch.Ids) == 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	userId := c.GetInt("id")
	count, err := model.BatchDeleteTokens(tokenBatch.Ids, userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	params["count"] = count
	common.SetContextKey(c, constant.ContextKeyTokenAuditSucceeded, true)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    count,
	})
}

func GetTokenKeysBatch(c *gin.Context) {
	tokenBatch := TokenBatch{}
	if err := c.ShouldBindJSON(&tokenBatch); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	params := tokenBatchAuditParams(c, tokenBatch.Ids)
	if len(tokenBatch.Ids) == 0 {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	if len(tokenBatch.Ids) > 100 {
		common.ApiErrorT(c, "Too many items in batch request, maximum is {{max}}", map[string]any{"max": 100})
		return
	}
	userId := c.GetInt("id")
	tokens, err := model.GetTokenKeysByIds(tokenBatch.Ids, userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	keysMap := make(map[int]string)
	returnedIDs := make([]int, 0, len(tokens))
	for _, t := range tokens {
		keysMap[t.Id] = t.GetFullKey()
		returnedIDs = append(returnedIDs, t.Id)
	}
	params["count"] = len(tokens)
	params["returned_ids"] = returnedIDs
	common.SetContextKey(c, constant.ContextKeyTokenAuditSucceeded, true)
	common.ApiSuccess(c, gin.H{"keys": keysMap})
}
