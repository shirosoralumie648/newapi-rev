package common

import (
	"bytes"
	"fmt"
	htmltemplate "html/template"
	"strings"
	texttemplate "text/template"
)

const (
	EmailTemplateTypeVerification  = "verification"
	EmailTemplateTypePasswordReset = "password_reset"
	EmailTemplateTypeSMTPTest      = "smtp_test"

	EmailVerificationSubjectOption = "EmailVerificationSubject"
	EmailVerificationContentOption = "EmailVerificationContent"
	PasswordResetSubjectOption     = "PasswordResetSubject"
	PasswordResetContentOption     = "PasswordResetContent"

	DefaultEmailVerificationSubject = "{{system_name}}邮箱验证邮件"
	DefaultEmailVerificationContent = "<p>您好，你正在进行{{system_name}}邮箱验证。</p>" +
		"<p>您的验证码为: <strong>{{code}}</strong></p>" +
		"<p>验证码 {{valid_minutes}} 分钟内有效，如果不是本人操作，请忽略。</p>"
	DefaultPasswordResetSubject = "{{system_name}}密码重置"
	DefaultPasswordResetContent = "<p>您好，你正在进行{{system_name}}密码重置。</p>" +
		"<p>点击 <a href=\"{{reset_link}}\">此处</a> 进行密码重置。</p>" +
		"<p>如果链接无法点击，请尝试点击下面的链接或将其复制到浏览器中打开：<br>{{reset_link}}</p>" +
		"<p>重置链接 {{valid_minutes}} 分钟内有效，如果不是本人操作，请忽略。</p>"
)

const (
	maxEmailSubjectTemplateLength = 255
	maxEmailContentTemplateLength = 256 * 1024
)

var (
	EmailVerificationSubject = DefaultEmailVerificationSubject
	EmailVerificationContent = DefaultEmailVerificationContent
	PasswordResetSubject     = DefaultPasswordResetSubject
	PasswordResetContent     = DefaultPasswordResetContent
)

type EmailTemplateData struct {
	SystemName   string
	Email        string
	Code         string
	ResetLink    string
	ValidMinutes int
}

func DefaultEmailTemplate(templateType string) (subject string, content string, ok bool) {
	switch templateType {
	case EmailTemplateTypeVerification:
		return DefaultEmailVerificationSubject, DefaultEmailVerificationContent, true
	case EmailTemplateTypePasswordReset:
		return DefaultPasswordResetSubject, DefaultPasswordResetContent, true
	default:
		return "", "", false
	}
}

func ConfiguredEmailTemplate(templateType string) (subject string, content string, ok bool) {
	OptionMapRWMutex.RLock()
	defer OptionMapRWMutex.RUnlock()

	switch templateType {
	case EmailTemplateTypeVerification:
		return EmailVerificationSubject, EmailVerificationContent, true
	case EmailTemplateTypePasswordReset:
		return PasswordResetSubject, PasswordResetContent, true
	default:
		return "", "", false
	}
}

func emailTemplateFuncs(templateType string, data EmailTemplateData) (texttemplate.FuncMap, error) {
	funcs := texttemplate.FuncMap{
		"system_name": func() string { return data.SystemName },
		"email":       func() string { return data.Email },
	}

	switch templateType {
	case EmailTemplateTypeVerification:
		funcs["code"] = func() string { return data.Code }
		funcs["valid_minutes"] = func() int { return data.ValidMinutes }
	case EmailTemplateTypePasswordReset:
		funcs["reset_link"] = func() string { return data.ResetLink }
		funcs["valid_minutes"] = func() int { return data.ValidMinutes }
	default:
		return nil, fmt.Errorf("不支持的邮件模板类型: %s", templateType)
	}

	return funcs, nil
}

func RenderEmailTemplate(templateType string, subjectSource string, contentSource string, data EmailTemplateData) (string, string, error) {
	if strings.TrimSpace(subjectSource) == "" {
		return "", "", fmt.Errorf("邮件主题不能为空")
	}
	if strings.ContainsAny(subjectSource, "\r\n") {
		return "", "", fmt.Errorf("邮件主题不能包含换行符")
	}
	if len(subjectSource) > maxEmailSubjectTemplateLength {
		return "", "", fmt.Errorf("邮件主题不能超过 %d 个字符", maxEmailSubjectTemplateLength)
	}
	if strings.TrimSpace(contentSource) == "" {
		return "", "", fmt.Errorf("邮件正文不能为空")
	}
	if len(contentSource) > maxEmailContentTemplateLength {
		return "", "", fmt.Errorf("邮件正文不能超过 %d 字节", maxEmailContentTemplateLength)
	}

	funcs, err := emailTemplateFuncs(templateType, data)
	if err != nil {
		return "", "", err
	}

	subjectTemplate, err := texttemplate.New("email_subject").Funcs(funcs).Parse(subjectSource)
	if err != nil {
		return "", "", fmt.Errorf("邮件主题模板格式错误: %w", err)
	}
	var subject bytes.Buffer
	if err = subjectTemplate.Execute(&subject, nil); err != nil {
		return "", "", fmt.Errorf("邮件主题模板渲染失败: %w", err)
	}
	if strings.ContainsAny(subject.String(), "\r\n") {
		return "", "", fmt.Errorf("渲染后的邮件主题不能包含换行符")
	}

	contentTemplate, err := htmltemplate.New("email_content").Funcs(htmltemplate.FuncMap(funcs)).Parse(contentSource)
	if err != nil {
		return "", "", fmt.Errorf("邮件正文模板格式错误: %w", err)
	}
	var content bytes.Buffer
	if err = contentTemplate.Execute(&content, nil); err != nil {
		return "", "", fmt.Errorf("邮件正文模板渲染失败: %w", err)
	}

	return subject.String(), content.String(), nil
}

func ValidateEmailTemplate(templateType string, subject string, content string) error {
	data := EmailTemplateData{
		SystemName:   "New API",
		Email:        "test@example.com",
		Code:         "123456",
		ResetLink:    "https://example.com/reset/test-token",
		ValidMinutes: VerificationValidMinutes,
	}
	_, _, err := RenderEmailTemplate(templateType, subject, content, data)
	if err != nil {
		return err
	}

	switch templateType {
	case EmailTemplateTypeVerification:
		if !strings.Contains(content, "{{code}}") {
			return fmt.Errorf("邮箱验证码正文必须包含 {{code}} 占位符")
		}
	case EmailTemplateTypePasswordReset:
		if !strings.Contains(content, "{{reset_link}}") {
			return fmt.Errorf("密码重置正文必须包含 {{reset_link}} 占位符")
		}
	}

	return nil
}

func ValidateEmailTemplateOption(key string, value string) error {
	switch key {
	case EmailVerificationSubjectOption:
		_, content, _ := ConfiguredEmailTemplate(EmailTemplateTypeVerification)
		return ValidateEmailTemplate(EmailTemplateTypeVerification, value, content)
	case EmailVerificationContentOption:
		subject, _, _ := ConfiguredEmailTemplate(EmailTemplateTypeVerification)
		return ValidateEmailTemplate(EmailTemplateTypeVerification, subject, value)
	case PasswordResetSubjectOption:
		_, content, _ := ConfiguredEmailTemplate(EmailTemplateTypePasswordReset)
		return ValidateEmailTemplate(EmailTemplateTypePasswordReset, value, content)
	case PasswordResetContentOption:
		subject, _, _ := ConfiguredEmailTemplate(EmailTemplateTypePasswordReset)
		return ValidateEmailTemplate(EmailTemplateTypePasswordReset, subject, value)
	default:
		return nil
	}
}

func RenderConfiguredEmailTemplate(templateType string, data EmailTemplateData) (string, string, error) {
	subject, content, ok := ConfiguredEmailTemplate(templateType)
	if !ok {
		return "", "", fmt.Errorf("不支持的邮件模板类型: %s", templateType)
	}
	return RenderEmailTemplate(templateType, subject, content, data)
}
