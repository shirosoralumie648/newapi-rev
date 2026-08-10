package common

import (
	"crypto/tls"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	smtpDialTimeout      = 15 * time.Second
	smtpOperationTimeout = 30 * time.Second
)

func generateMessageID(from string) (string, error) {
	address, err := mail.ParseAddress(from)
	if err != nil {
		return "", fmt.Errorf("SMTP 发件人地址无效: %w", err)
	}
	parts := strings.Split(address.Address, "@")
	if len(parts) != 2 || parts[1] == "" {
		return "", fmt.Errorf("SMTP 发件人地址无效")
	}
	domain := parts[1]
	return fmt.Sprintf("<%d.%s@%s>", time.Now().UnixNano(), GetRandomString(12), domain), nil
}

func SendEmail(subject string, receiver string, content string) error {
	server := strings.TrimSpace(SMTPServer)
	if server == "" {
		return fmt.Errorf("SMTP 服务器未配置")
	}
	if SMTPPort < 1 || SMTPPort > 65535 {
		return fmt.Errorf("SMTP 端口无效")
	}

	from := strings.TrimSpace(SMTPFrom)
	if from == "" { // for compatibility
		from = strings.TrimSpace(SMTPAccount)
	}
	fromAddress, err := mail.ParseAddress(from)
	if err != nil {
		return fmt.Errorf("SMTP 发件人地址无效: %w", err)
	}
	recipients, toHeader, err := parseEmailRecipients(receiver)
	if err != nil {
		return err
	}
	if strings.ContainsAny(subject, "\r\n") {
		return fmt.Errorf("邮件主题不能包含换行符")
	}
	if strings.ContainsAny(SystemName, "\r\n") {
		return fmt.Errorf("系统名称不能包含换行符")
	}

	id, err := generateMessageID(fromAddress.Address)
	if err != nil {
		return err
	}
	encodedSubject := mime.QEncoding.Encode("UTF-8", subject)
	fromHeader := (&mail.Address{Name: SystemName, Address: fromAddress.Address}).String()
	mail := []byte(fmt.Sprintf("To: %s\r\n"+
		"From: %s\r\n"+
		"Subject: %s\r\n"+
		"Date: %s\r\n"+
		"Message-ID: %s\r\n"+ // 添加 Message-ID 头
		"MIME-Version: 1.0\r\n"+
		"Content-Type: text/html; charset=UTF-8\r\n\r\n%s\r\n",
		toHeader, fromHeader, encodedSubject, time.Now().Format(time.RFC1123Z), id, content))
	var auth smtp.Auth
	if SMTPAccount != "" {
		auth = smtp.PlainAuth("", SMTPAccount, SMTPToken, server)
	}
	if isOutlookServer(SMTPAccount) || slices.Contains(EmailLoginAuthServerList, server) {
		auth = LoginAuth(SMTPAccount, SMTPToken)
	}
	addr := net.JoinHostPort(server, strconv.Itoa(SMTPPort))
	err = sendSMTPMessage(addr, server, SMTPPort == 465 || SMTPSSLEnabled, auth, fromAddress.Address, recipients, mail)
	if err != nil {
		SysError(fmt.Sprintf("failed to send email: %v", err))
	}
	return err
}

func ValidateSMTPOption(key string, value string) error {
	switch key {
	case "SMTPPort":
		port, err := strconv.Atoi(value)
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("SMTP 端口必须是 1 到 65535 之间的整数")
		}
	case "SMTPFrom":
		value = strings.TrimSpace(value)
		if value == "" {
			return nil
		}
		if _, err := mail.ParseAddress(value); err != nil {
			return fmt.Errorf("SMTP 发件人地址无效: %w", err)
		}
	}
	return nil
}

func sendSMTPMessage(addr string, server string, implicitTLS bool, auth smtp.Auth, from string, recipients []string, message []byte) error {
	dialer := &net.Dialer{Timeout: smtpDialTimeout}
	tlsConfig := &tls.Config{
		ServerName: server,
		MinVersion: tls.VersionTLS12,
	}

	var conn net.Conn
	var err error
	if implicitTLS {
		// Keep compatibility with the previous implicit-TLS behavior. STARTTLS
		// connections below still use normal certificate verification.
		implicitTLSConfig := tlsConfig.Clone()
		implicitTLSConfig.InsecureSkipVerify = true
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, implicitTLSConfig)
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("SMTP 连接失败: %w", err)
	}
	defer conn.Close()
	if err = conn.SetDeadline(time.Now().Add(smtpOperationTimeout)); err != nil {
		return fmt.Errorf("SMTP 超时设置失败: %w", err)
	}

	client, err := smtp.NewClient(conn, server)
	if err != nil {
		return fmt.Errorf("SMTP 握手失败: %w", err)
	}
	defer client.Close()

	if !implicitTLS {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err = client.StartTLS(tlsConfig); err != nil {
				return fmt.Errorf("SMTP STARTTLS 失败: %w", err)
			}
		}
	}
	if auth != nil {
		if err = client.Auth(auth); err != nil {
			return fmt.Errorf("SMTP 认证失败: %w", err)
		}
	}
	if err = client.Mail(from); err != nil {
		return fmt.Errorf("SMTP 发件人被拒绝: %w", err)
	}
	for _, recipient := range recipients {
		if err = client.Rcpt(recipient); err != nil {
			return fmt.Errorf("SMTP 收件人被拒绝: %w", err)
		}
	}

	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("SMTP DATA 命令失败: %w", err)
	}
	if _, err = writer.Write(message); err != nil {
		_ = writer.Close()
		return fmt.Errorf("SMTP 邮件写入失败: %w", err)
	}
	if err = writer.Close(); err != nil {
		return fmt.Errorf("SMTP 邮件提交失败: %w", err)
	}
	if err = client.Quit(); err != nil {
		return fmt.Errorf("SMTP 连接关闭失败: %w", err)
	}
	return nil
}

func parseEmailRecipients(receiver string) ([]string, string, error) {
	parts := strings.Split(receiver, ";")
	recipients := make([]string, 0, len(parts))
	headers := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || strings.ContainsAny(part, "\r\n") {
			return nil, "", fmt.Errorf("收件人邮箱地址无效")
		}
		address, err := mail.ParseAddress(part)
		if err != nil {
			return nil, "", fmt.Errorf("收件人邮箱地址无效: %w", err)
		}
		recipients = append(recipients, address.Address)
		headers = append(headers, address.String())
	}
	if len(recipients) == 0 {
		return nil, "", fmt.Errorf("收件人邮箱地址不能为空")
	}
	return recipients, strings.Join(headers, ", "), nil
}
