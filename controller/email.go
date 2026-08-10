package controller

import (
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
)

type SMTPTestRequest struct {
	Email        string  `json:"email"`
	TemplateType string  `json:"template_type"`
	Subject      *string `json:"subject"`
	Content      *string `json:"content"`
}

type EmailTemplatesUpdateRequest struct {
	EmailVerificationSubject string `json:"email_verification_subject"`
	EmailVerificationContent string `json:"email_verification_content"`
	PasswordResetSubject     string `json:"password_reset_subject"`
	PasswordResetContent     string `json:"password_reset_content"`
}

var (
	sendEmailForSMTPTest = common.SendEmail
	saveEmailTemplates   = model.UpdateEmailTemplates
)

func UpdateEmailTemplates(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024*1024)
	var request EmailTemplatesUpdateRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": "无效的参数",
		})
		return
	}

	if err := validateEmailTemplatesUpdate(request); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := saveEmailTemplates(map[string]string{
		common.EmailVerificationSubjectOption: request.EmailVerificationSubject,
		common.EmailVerificationContentOption: request.EmailVerificationContent,
		common.PasswordResetSubjectOption:     request.PasswordResetSubject,
		common.PasswordResetContentOption:     request.PasswordResetContent,
	}); err != nil {
		common.ApiError(c, fmt.Errorf("保存邮件模板失败: %w", err))
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "邮件模板保存成功",
	})
}

func validateEmailTemplatesUpdate(request EmailTemplatesUpdateRequest) error {
	if err := common.ValidateEmailTemplate(
		common.EmailTemplateTypeVerification,
		request.EmailVerificationSubject,
		request.EmailVerificationContent,
	); err != nil {
		return fmt.Errorf("邮箱验证码模板无效: %w", err)
	}
	if err := common.ValidateEmailTemplate(
		common.EmailTemplateTypePasswordReset,
		request.PasswordResetSubject,
		request.PasswordResetContent,
	); err != nil {
		return fmt.Errorf("密码重置模板无效: %w", err)
	}
	return nil
}

func SendSMTPTestEmail(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 512*1024)
	var request SMTPTestRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": "无效的参数",
		})
		return
	}

	request.Email = strings.TrimSpace(request.Email)
	if err := common.Validate.Var(request.Email, "required,email"); err != nil {
		common.ApiErrorMsg(c, "请输入有效的测试收件人")
		return
	}

	if request.TemplateType == "" {
		request.TemplateType = common.EmailTemplateTypeSMTPTest
	}

	subject, content, err := buildSMTPTestEmail(request)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if err = sendEmailForSMTPTest(subject, request.Email, content); err != nil {
		common.ApiError(c, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "测试邮件发送成功",
	})
}

func buildSMTPTestEmail(request SMTPTestRequest) (string, string, error) {
	if request.TemplateType == common.EmailTemplateTypeSMTPTest {
		return fmt.Sprintf("%s SMTP 测试邮件", common.SystemName),
			fmt.Sprintf("<p>%s SMTP 配置测试成功。</p>", html.EscapeString(common.SystemName)), nil
	}

	configuredSubject, configuredContent, ok := common.ConfiguredEmailTemplate(request.TemplateType)
	if !ok {
		return "", "", fmt.Errorf("不支持的邮件模板类型: %s", request.TemplateType)
	}
	subject := configuredSubject
	if request.Subject != nil {
		subject = *request.Subject
	}
	content := configuredContent
	if request.Content != nil {
		content = *request.Content
	}
	if err := common.ValidateEmailTemplate(request.TemplateType, subject, content); err != nil {
		return "", "", err
	}

	serverAddress := strings.TrimRight(system_setting.ServerAddress, "/")
	if serverAddress == "" {
		serverAddress = "https://example.com"
	}
	query := url.Values{}
	query.Set("email", request.Email)
	query.Set("token", "test-token")

	return common.RenderEmailTemplate(
		request.TemplateType,
		subject,
		content,
		common.EmailTemplateData{
			SystemName:   common.SystemName,
			Email:        request.Email,
			Code:         "123456",
			ResetLink:    fmt.Sprintf("%s/user/reset?%s", serverAddress, query.Encode()),
			ValidMinutes: common.VerificationValidMinutes,
		},
	)
}
