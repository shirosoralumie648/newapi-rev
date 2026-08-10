package common

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

func TestParseEmailRecipients(t *testing.T) {
	recipients, header, err := parseEmailRecipients("first@example.com; Second User <second@example.com>")
	if err != nil {
		t.Fatalf("parseEmailRecipients() error = %v", err)
	}
	if len(recipients) != 2 || recipients[0] != "first@example.com" || recipients[1] != "second@example.com" {
		t.Fatalf("recipients = %#v", recipients)
	}
	if !strings.Contains(header, "first@example.com") || !strings.Contains(header, "second@example.com") {
		t.Fatalf("header = %q", header)
	}
}

func TestParseEmailRecipientsRejectsHeaderInjection(t *testing.T) {
	_, _, err := parseEmailRecipients("user@example.com\r\nBcc: victim@example.com")
	if err == nil {
		t.Fatal("parseEmailRecipients() expected an error")
	}
}

func TestGenerateMessageIDUsesSenderDomain(t *testing.T) {
	id, err := generateMessageID("Sender <sender@example.com>")
	if err != nil {
		t.Fatalf("generateMessageID() error = %v", err)
	}
	if !strings.HasPrefix(id, "<") || !strings.HasSuffix(id, "@example.com>") {
		t.Fatalf("message ID = %q", id)
	}
}

func TestSendEmailReportsMissingServerWithoutMutatingSender(t *testing.T) {
	originalServer := SMTPServer
	originalFrom := SMTPFrom
	originalAccount := SMTPAccount
	t.Cleanup(func() {
		SMTPServer = originalServer
		SMTPFrom = originalFrom
		SMTPAccount = originalAccount
	})

	SMTPServer = ""
	SMTPFrom = ""
	SMTPAccount = "sender@example.com"
	err := SendEmail("subject", "receiver@example.com", "content")
	if err == nil || !strings.Contains(err.Error(), "SMTP 服务器未配置") {
		t.Fatalf("SendEmail() error = %v", err)
	}
	if SMTPFrom != "" {
		t.Fatalf("SendEmail() mutated SMTPFrom to %q", SMTPFrom)
	}
}

func TestValidateSMTPOption(t *testing.T) {
	tests := []struct {
		name      string
		key       string
		value     string
		wantError bool
	}{
		{name: "valid port", key: "SMTPPort", value: "587"},
		{name: "port is not a number", key: "SMTPPort", value: "abc", wantError: true},
		{name: "port is out of range", key: "SMTPPort", value: "65536", wantError: true},
		{name: "valid sender", key: "SMTPFrom", value: "Sender <sender@example.com>"},
		{name: "empty sender uses account fallback", key: "SMTPFrom", value: ""},
		{name: "invalid sender", key: "SMTPFrom", value: "invalid", wantError: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateSMTPOption(test.key, test.value)
			if test.wantError && err == nil {
				t.Fatal("ValidateSMTPOption() expected an error")
			}
			if !test.wantError && err != nil {
				t.Fatalf("ValidateSMTPOption() error = %v", err)
			}
		})
	}
}

func TestSendEmailWithPlainSMTPServer(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	defer listener.Close()

	messages := make(chan string, 1)
	serverErrors := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErrors <- acceptErr
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		writer := bufio.NewWriter(connection)
		writeResponse := func(response string) error {
			if _, err := fmt.Fprintf(writer, "%s\r\n", response); err != nil {
				return err
			}
			return writer.Flush()
		}
		if err := writeResponse("220 localhost ready"); err != nil {
			serverErrors <- err
			return
		}

		var body strings.Builder
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				serverErrors <- readErr
				return
			}
			command := strings.TrimSpace(line)
			switch {
			case strings.HasPrefix(command, "EHLO"):
				if err := writeResponse("250 localhost"); err != nil {
					serverErrors <- err
					return
				}
			case strings.HasPrefix(command, "MAIL FROM:"):
				if err := writeResponse("250 sender accepted"); err != nil {
					serverErrors <- err
					return
				}
			case strings.HasPrefix(command, "RCPT TO:"):
				if err := writeResponse("250 recipient accepted"); err != nil {
					serverErrors <- err
					return
				}
			case command == "DATA":
				if err := writeResponse("354 send message"); err != nil {
					serverErrors <- err
					return
				}
				for {
					messageLine, bodyErr := reader.ReadString('\n')
					if bodyErr != nil {
						serverErrors <- bodyErr
						return
					}
					if strings.TrimRight(messageLine, "\r\n") == "." {
						break
					}
					body.WriteString(messageLine)
				}
				if err := writeResponse("250 message accepted"); err != nil {
					serverErrors <- err
					return
				}
			case command == "QUIT":
				if err := writeResponse("221 bye"); err != nil {
					serverErrors <- err
					return
				}
				messages <- body.String()
				return
			default:
				if err := writeResponse("250 ok"); err != nil {
					serverErrors <- err
					return
				}
			}
		}
	}()

	originalServer := SMTPServer
	originalPort := SMTPPort
	originalSSL := SMTPSSLEnabled
	originalAccount := SMTPAccount
	originalFrom := SMTPFrom
	originalSystemName := SystemName
	t.Cleanup(func() {
		SMTPServer = originalServer
		SMTPPort = originalPort
		SMTPSSLEnabled = originalSSL
		SMTPAccount = originalAccount
		SMTPFrom = originalFrom
		SystemName = originalSystemName
	})

	SMTPServer = "127.0.0.1"
	_, portString, _ := net.SplitHostPort(listener.Addr().String())
	SMTPPort = 0
	fmt.Sscanf(portString, "%d", &SMTPPort)
	SMTPSSLEnabled = false
	SMTPAccount = ""
	SMTPFrom = "sender@example.com"
	SystemName = "Example API"

	if err := SendEmail("测试主题", "Recipient <recipient@example.com>", "<p>hello</p>"); err != nil {
		t.Fatalf("SendEmail() error = %v", err)
	}

	select {
	case message := <-messages:
		if !strings.Contains(message, "To: \"Recipient\" <recipient@example.com>") {
			t.Errorf("message is missing recipient header: %s", message)
		}
		if !strings.Contains(message, "Subject: =?UTF-8?") {
			t.Errorf("message is missing encoded subject: %s", message)
		}
		if !strings.Contains(message, "<p>hello</p>") {
			t.Errorf("message is missing body: %s", message)
		}
	case serverErr := <-serverErrors:
		t.Fatalf("fake SMTP server error = %v", serverErr)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for fake SMTP server")
	}
}
