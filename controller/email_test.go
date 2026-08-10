package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
)

func stringPointer(value string) *string {
	return &value
}

func TestBuildSMTPTestEmail(t *testing.T) {
	originalSystemName := common.SystemName
	common.SystemName = "Example API"
	t.Cleanup(func() {
		common.SystemName = originalSystemName
	})

	tests := []struct {
		name         string
		request      SMTPTestRequest
		wantSubject  string
		wantContents []string
	}{
		{
			name: "smtp connection",
			request: SMTPTestRequest{
				Email:        "user@example.com",
				TemplateType: common.EmailTemplateTypeSMTPTest,
			},
			wantSubject:  "Example API SMTP 测试邮件",
			wantContents: []string{"Example API", "SMTP 配置测试成功"},
		},
		{
			name: "verification draft",
			request: SMTPTestRequest{
				Email:        "user@example.com",
				TemplateType: common.EmailTemplateTypeVerification,
				Subject:      stringPointer("{{system_name}} test code"),
				Content:      stringPointer("<strong>{{code}}</strong> for {{email}}"),
			},
			wantSubject:  "Example API test code",
			wantContents: []string{"<strong>123456</strong>", "user@example.com"},
		},
		{
			name: "password reset draft",
			request: SMTPTestRequest{
				Email:        "user@example.com",
				TemplateType: common.EmailTemplateTypePasswordReset,
				Subject:      stringPointer("{{system_name}} reset"),
				Content:      stringPointer("<a href=\"{{reset_link}}\">reset</a>"),
			},
			wantSubject:  "Example API reset",
			wantContents: []string{"/user/reset?", "test-token"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			subject, content, err := buildSMTPTestEmail(test.request)
			if err != nil {
				t.Fatalf("buildSMTPTestEmail() error = %v", err)
			}
			if subject != test.wantSubject {
				t.Fatalf("subject = %q, want %q", subject, test.wantSubject)
			}
			for _, want := range test.wantContents {
				if !strings.Contains(content, want) {
					t.Errorf("content %q does not contain %q", content, want)
				}
			}
		})
	}
}

func TestBuildSMTPTestEmailRejectsUnknownTemplate(t *testing.T) {
	_, _, err := buildSMTPTestEmail(SMTPTestRequest{
		Email:        "user@example.com",
		TemplateType: "unknown",
	})
	if err == nil {
		t.Fatal("buildSMTPTestEmail() expected an error")
	}
}

func TestBuildSMTPTestEmailRejectsExplicitlyEmptyDraft(t *testing.T) {
	_, _, err := buildSMTPTestEmail(SMTPTestRequest{
		Email:        "user@example.com",
		TemplateType: common.EmailTemplateTypeVerification,
		Subject:      stringPointer("subject"),
		Content:      stringPointer(""),
	})
	if err == nil {
		t.Fatal("buildSMTPTestEmail() expected an error")
	}
}

func TestUpdateEmailTemplates(t *testing.T) {
	originalSaver := saveEmailTemplates
	t.Cleanup(func() {
		saveEmailTemplates = originalSaver
	})

	var saved map[string]string
	saveEmailTemplates = func(values map[string]string) error {
		saved = values
		return nil
	}
	request := EmailTemplatesUpdateRequest{
		EmailVerificationSubject: "{{system_name}} verification",
		EmailVerificationContent: "<strong>{{code}}</strong>",
		PasswordResetSubject:     "{{system_name}} reset",
		PasswordResetContent:     "<a href=\"{{reset_link}}\">reset</a>",
	}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(
		http.MethodPut,
		"/api/option/email_templates",
		strings.NewReader(string(payload)),
	)
	context.Request.Header.Set("Content-Type", "application/json")

	UpdateEmailTemplates(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if !strings.Contains(recorder.Body.String(), `"success":true`) {
		t.Fatalf("response = %s", recorder.Body.String())
	}
	if saved[common.EmailVerificationContentOption] != request.EmailVerificationContent ||
		saved[common.PasswordResetContentOption] != request.PasswordResetContent {
		t.Fatalf("saved templates = %#v", saved)
	}
}

func TestUpdateEmailTemplatesRejectsInvalidPair(t *testing.T) {
	originalSaver := saveEmailTemplates
	t.Cleanup(func() {
		saveEmailTemplates = originalSaver
	})
	saveEmailTemplates = func(map[string]string) error {
		t.Fatal("template saver must not be called")
		return nil
	}
	request := EmailTemplatesUpdateRequest{
		EmailVerificationSubject: "verification",
		EmailVerificationContent: "<p>missing code</p>",
		PasswordResetSubject:     "reset",
		PasswordResetContent:     "<a href=\"{{reset_link}}\">reset</a>",
	}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(
		http.MethodPut,
		"/api/option/email_templates",
		strings.NewReader(string(payload)),
	)
	context.Request.Header.Set("Content-Type", "application/json")

	UpdateEmailTemplates(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if !strings.Contains(recorder.Body.String(), `"success":false`) ||
		!strings.Contains(recorder.Body.String(), "{{code}}") {
		t.Fatalf("response = %s", recorder.Body.String())
	}
}

func TestSendSMTPTestEmail(t *testing.T) {
	originalSender := sendEmailForSMTPTest
	t.Cleanup(func() {
		sendEmailForSMTPTest = originalSender
	})

	var gotSubject string
	var gotEmail string
	var gotContent string
	sendEmailForSMTPTest = func(subject string, email string, content string) error {
		gotSubject = subject
		gotEmail = email
		gotContent = content
		return nil
	}

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(
		http.MethodPost,
		"/api/option/smtp_test",
		strings.NewReader(`{"email":"user@example.com","template_type":"smtp_test"}`),
	)
	context.Request.Header.Set("Content-Type", "application/json")

	SendSMTPTestEmail(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if !strings.Contains(recorder.Body.String(), `"success":true`) {
		t.Fatalf("response = %s", recorder.Body.String())
	}
	if gotEmail != "user@example.com" || gotSubject == "" || gotContent == "" {
		t.Fatalf("sender received subject=%q email=%q content=%q", gotSubject, gotEmail, gotContent)
	}
}

func TestSendSMTPTestEmailRejectsInvalidRecipient(t *testing.T) {
	originalSender := sendEmailForSMTPTest
	t.Cleanup(func() {
		sendEmailForSMTPTest = originalSender
	})
	sendEmailForSMTPTest = func(string, string, string) error {
		t.Fatal("email sender must not be called")
		return nil
	}

	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(
		http.MethodPost,
		"/api/option/smtp_test",
		strings.NewReader(`{"email":"invalid","template_type":"smtp_test"}`),
	)
	context.Request.Header.Set("Content-Type", "application/json")

	SendSMTPTestEmail(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if !strings.Contains(recorder.Body.String(), `"success":false`) {
		t.Fatalf("response = %s", recorder.Body.String())
	}
}
