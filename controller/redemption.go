package controller

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/gin-gonic/gin"
)

func GetAllRedemptions(c *gin.Context) {
	pageInfo := common.GetPageQuery(c)
	redemptions, total, err := model.GetAllRedemptions(pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(redemptions)
	common.ApiSuccess(c, pageInfo)
	return
}

func SearchRedemptions(c *gin.Context) {
	keyword := c.Query("keyword")
	status := c.Query("status")
	redemptionType := c.Query("type")
	pageInfo := common.GetPageQuery(c)
	redemptions, total, err := model.SearchRedemptions(keyword, status, redemptionType, pageInfo.GetStartIdx(), pageInfo.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	pageInfo.SetTotal(int(total))
	pageInfo.SetItems(redemptions)
	common.ApiSuccess(c, pageInfo)
	return
}

func GetRedemption(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	redemption, err := model.GetRedemptionById(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    redemption,
	})
	return
}

func AddRedemption(c *gin.Context) {
	if !operation_setting.IsPaymentComplianceConfirmed() {
		common.ApiErrorT(c, "Payment, redemption, subscription, and invitation reward features are disabled. The administrator must confirm compliance terms before enabling them.")
		return
	}

	redemption := model.Redemption{}
	err := c.ShouldBindJSON(&redemption)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if utf8.RuneCountInString(redemption.Name) == 0 || utf8.RuneCountInString(redemption.Name) > 20 {
		common.ApiErrorT(c, "Redemption code name length must be between 1-20")
		return
	}
	if redemption.Count <= 0 {
		common.ApiErrorT(c, "Redemption code count must be greater than 0")
		return
	}
	if redemption.Count > 100 {
		common.ApiErrorT(c, "Maximum 100 redemption codes can be generated at once")
		return
	}
	if !validateRedemptionPayload(c, &redemption) {
		return
	}
	if err := validateExpiredTime(redemption.ExpiredTime); err != nil {
		common.ApiError(c, err)
		return
	}
	var keys []string
	for i := 0; i < redemption.Count; i++ {
		key := common.GetUUID()
		cleanRedemption := model.Redemption{
			UserId:          c.GetInt("id"),
			Name:            redemption.Name,
			Key:             key,
			CreatedTime:     common.GetTimestamp(),
			Quota:           redemption.Quota,
			ExpiredTime:     redemption.ExpiredTime,
			Type:            redemption.Type,
			PlanId:          redemption.PlanId,
			DurationUnit:    redemption.DurationUnit,
			DurationValue:   redemption.DurationValue,
			DurationSeconds: redemption.DurationSeconds,
		}
		err = cleanRedemption.Insert()
		if err != nil {
			common.SysError(common.LogText("failed to insert redemption: %s", err.Error()))
			common.ApiErrorStatus(c, http.StatusOK, common.NewMessage("Failed to create redemption code, please try again later"), gin.H{"data": keys})
			return
		}
		keys = append(keys, key)
	}
	auditParams := map[string]any{
		"name":  redemption.Name,
		"count": redemption.Count,
		"type":  redemption.Type,
	}
	if redemption.Type == model.RedemptionTypeSubscription {
		auditParams["plan_id"] = redemption.PlanId
	} else {
		auditParams["quota"] = logger.FormatQuota(redemption.Quota)
	}
	recordManageAudit(c, "redemption.create", auditParams)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    keys,
	})
	return
}

// validateRedemptionPayload normalizes and validates the shared fields of a
// create/update request, writing the API error itself when the payload is
// rejected.
func validateRedemptionPayload(c *gin.Context, redemption *model.Redemption) bool {
	redemptionType, ok := model.NormalizeRedemptionType(redemption.Type)
	if !ok {
		common.ApiErrorT(c, "Redemption code type must be quota or subscription")
		return false
	}
	redemption.Type = redemptionType
	if redemptionType == model.RedemptionTypeSubscription {
		if redemption.PlanId <= 0 {
			common.ApiErrorT(c, "Select a subscription plan for this redemption code")
			return false
		}
		if _, err := model.GetSubscriptionPlanById(redemption.PlanId); err != nil {
			common.ApiErrorT(c, "The selected subscription plan does not exist")
			return false
		}
		redemption.Quota = 0
		redemption.DurationUnit = strings.TrimSpace(redemption.DurationUnit)
		switch err := model.ValidateRedemptionDuration(redemption.DurationUnit, redemption.DurationValue, redemption.DurationSeconds); {
		case errors.Is(err, model.ErrRedemptionDurationTooLong):
			common.ApiErrorT(c, "Duration override cannot exceed 10 years")
			return false
		case err != nil:
			common.ApiErrorT(c, "Duration override must be a positive duration")
			return false
		}
		return true
	}
	if redemption.Quota <= 0 {
		common.ApiErrorT(c, "Redemption quota must be positive")
		return false
	}
	if err := common.ValidateWalletQuota(redemption.Quota); err != nil {
		common.ApiError(c, err)
		return false
	}
	redemption.PlanId = 0
	redemption.DurationUnit = ""
	redemption.DurationValue = 0
	redemption.DurationSeconds = 0
	return true
}

func DeleteRedemption(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	err := model.DeleteRedemptionById(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
	})
	return
}

func UpdateRedemption(c *gin.Context) {
	statusOnly := c.Query("status_only")
	redemption := model.Redemption{}
	err := c.ShouldBindJSON(&redemption)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	cleanRedemption, err := model.GetRedemptionById(redemption.Id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if statusOnly == "" {
		if !validateRedemptionPayload(c, &redemption) {
			return
		}
		if err := validateExpiredTime(redemption.ExpiredTime); err != nil {
			common.ApiError(c, err)
			return
		}
		// If you add more fields, please also update redemption.Update()
		cleanRedemption.Name = redemption.Name
		cleanRedemption.Quota = redemption.Quota
		cleanRedemption.ExpiredTime = redemption.ExpiredTime
		cleanRedemption.Type = redemption.Type
		cleanRedemption.PlanId = redemption.PlanId
		cleanRedemption.DurationUnit = redemption.DurationUnit
		cleanRedemption.DurationValue = redemption.DurationValue
		cleanRedemption.DurationSeconds = redemption.DurationSeconds
	}
	if statusOnly != "" {
		cleanRedemption.Status = redemption.Status
		err = cleanRedemption.SelectUpdate()
	} else {
		err = cleanRedemption.Update()
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    cleanRedemption,
	})
	return
}

func DeleteInvalidRedemption(c *gin.Context) {
	rows, err := model.DeleteInvalidRedemptions()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    rows,
	})
	return
}

func validateExpiredTime(expired int64) error {
	if expired != 0 && expired < common.GetTimestamp() {
		return common.NewMessage("Expiration time cannot be earlier than current time")
	}
	return nil
}

func DeleteRedemptionBatch(c *gin.Context) {
	var request struct {
		Ids []int `json:"ids" binding:"required,min=1,max=1000,dive,gt=0"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	count, err := model.BatchDeleteRedemptions(request.Ids)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAudit(c, "redemption.delete_batch", map[string]any{
		"count":                    count,
		"total":                    len(request.Ids),
		"requested_redemption_ids": request.Ids,
	})
	common.ApiSuccess(c, count)
}
