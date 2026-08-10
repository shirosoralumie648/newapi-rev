package common

import (
	"strings"
	"testing"
)

func TestRenderDefaultEmailTemplates(t *testing.T) {
	tests := []struct {
		name         string
		templateType string
		data         EmailTemplateData
		wantSubject  string
		wantContent  []string
	}{
		{
			name:         "verification",
			templateType: EmailTemplateTypeVerification,
			data: EmailTemplateData{
				SystemName:   "Example API",
				Email:        "user@example.com",
				Code:         "654321",
				ValidMinutes: 10,
			},
			wantSubject: "Example API邮箱验证邮件",
			wantContent: []string{"Example API", "<strong>654321</strong>", "10 分钟"},
		},
		{
			name:         "password reset",
			templateType: EmailTemplateTypePasswordReset,
			data: EmailTemplateData{
				SystemName:   "Example API",
				Email:        "user@example.com",
				ResetLink:    "https://example.com/reset?token=test&email=user@example.com",
				ValidMinutes: 10,
			},
			wantSubject: "Example API密码重置",
			wantContent: []string{"Example API", "https://example.com/reset?token=test", "10 分钟"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			subjectSource, contentSource, ok := DefaultEmailTemplate(test.templateType)
			if !ok {
				t.Fatalf("default template %q not found", test.templateType)
			}
			subject, content, err := RenderEmailTemplate(test.templateType, subjectSource, contentSource, test.data)
			if err != nil {
				t.Fatalf("RenderEmailTemplate() error = %v", err)
			}
			if subject != test.wantSubject {
				t.Fatalf("subject = %q, want %q", subject, test.wantSubject)
			}
			for _, want := range test.wantContent {
				if !strings.Contains(content, want) {
					t.Errorf("content %q does not contain %q", content, want)
				}
			}
		})
	}
}

func TestRenderEmailTemplateEscapesHTMLVariables(t *testing.T) {
	_, content, err := RenderEmailTemplate(
		EmailTemplateTypeVerification,
		"{{system_name}} verification",
		"<p>{{system_name}} {{code}}</p>",
		EmailTemplateData{
			SystemName: "<script>alert(1)</script>",
			Code:       "<b>123456</b>",
		},
	)
	if err != nil {
		t.Fatalf("RenderEmailTemplate() error = %v", err)
	}
	if strings.Contains(content, "<script>") || strings.Contains(content, "<b>") {
		t.Fatalf("rendered variables were not escaped: %s", content)
	}
	if !strings.Contains(content, "&lt;script&gt;") || !strings.Contains(content, "&lt;b&gt;") {
		t.Fatalf("escaped variables not found: %s", content)
	}
}

func TestValidateEmailTemplateRejectsInvalidTemplates(t *testing.T) {
	tests := []struct {
		name         string
		templateType string
		subject      string
		content      string
		wantError    string
	}{
		{
			name:         "missing verification code",
			templateType: EmailTemplateTypeVerification,
			subject:      "{{system_name}}",
			content:      "<p>No code</p>",
			wantError:    "{{code}}",
		},
		{
			name:         "literal verification sentinel is not a placeholder",
			templateType: EmailTemplateTypeVerification,
			subject:      "{{system_name}}",
			content:      "<p>NEW_API_REQUIRED_CODE</p>",
			wantError:    "{{code}}",
		},
		{
			name:         "missing reset link",
			templateType: EmailTemplateTypePasswordReset,
			subject:      "{{system_name}}",
			content:      "<p>No link</p>",
			wantError:    "{{reset_link}}",
		},
		{
			name:         "literal reset sentinel is not a placeholder",
			templateType: EmailTemplateTypePasswordReset,
			subject:      "{{system_name}}",
			content:      "<p>https://example.com/reset/NEW_API_REQUIRED_LINK</p>",
			wantError:    "{{reset_link}}",
		},
		{
			name:         "unknown placeholder",
			templateType: EmailTemplateTypeVerification,
			subject:      "{{unknown}}",
			content:      "{{code}}",
			wantError:    "unknown",
		},
		{
			name:         "header newline",
			templateType: EmailTemplateTypeVerification,
			subject:      "subject\r\nBcc: victim@example.com",
			content:      "{{code}}",
			wantError:    "换行符",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateEmailTemplate(test.templateType, test.subject, test.content)
			if err == nil {
				t.Fatal("ValidateEmailTemplate() expected an error")
			}
			if !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("error = %q, want it to contain %q", err, test.wantError)
			}
		})
	}
}
