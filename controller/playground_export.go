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
package controller

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

const (
	playgroundExportFormatJSON     = "json"
	playgroundExportFormatMarkdown = "markdown"
	// playgroundExportFilenameMaxLength bounds the file name derived from the
	// conversation title so the download stays portable.
	playgroundExportFilenameMaxLength = 80
)

// playgroundExportEnvelope is the download contract: the server renders the
// file and the client saves `content` under `filename` with `content_type`.
// Rendering server-side keeps the Markdown and JSON shapes in one place and
// lets a trashed conversation be exported without restoring it first.
type playgroundExportEnvelope struct {
	Format      string `json:"format"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Content     string `json:"content"`
}

// playgroundExportSession is the machine-readable conversation record. Stored
// JSON columns are embedded as raw values so consumers do not have to decode a
// string twice; a legacy NULL column reads back as an empty object (or null
// for the summary).
type playgroundExportSession struct {
	ID               string          `json:"id"`
	Title            string          `json:"title"`
	ClientID         *string         `json:"client_id,omitempty"`
	SystemPrompt     string          `json:"system_prompt,omitempty"`
	Config           json.RawMessage `json:"config"`
	ParameterEnabled json.RawMessage `json:"parameter_enabled"`
	Context          json.RawMessage `json:"context"`
	ContextSummary   json.RawMessage `json:"context_summary"`
	Trashed          bool            `json:"trashed"`
	CreatedAt        int64           `json:"created_at"`
	UpdatedAt        int64           `json:"updated_at"`
	MessageRevision  int64           `json:"message_revision"`
}

type playgroundExportMessage struct {
	ClientKey string          `json:"client_key"`
	Payload   json.RawMessage `json:"payload"`
}

type playgroundExportDocument struct {
	ExportedAt int64                     `json:"exported_at"`
	Session    playgroundExportSession   `json:"session"`
	Messages   []playgroundExportMessage `json:"messages"`
}

// ExportPlaygroundSession renders one owned conversation as Markdown or JSON.
// It accepts a trashed conversation so a user can still download something
// they deleted, and it never reads attachment bodies: attachment references
// are exported as links to the owner-scoped content endpoint.
func ExportPlaygroundSession(c *gin.Context) {
	format := strings.ToLower(strings.TrimSpace(c.Query("format")))
	if format == "" {
		format = playgroundExportFormatMarkdown
	}
	if format != playgroundExportFormatMarkdown && format != playgroundExportFormatJSON {
		writePlaygroundError(c, common.NewMessage("Invalid Playground request."))
		return
	}
	export, err := model.LoadPlaygroundSessionExport(c.GetInt("id"), c.Param("id"))
	if err != nil {
		writePlaygroundError(c, err)
		return
	}
	envelope := playgroundExportEnvelope{Format: format}
	if format == playgroundExportFormatJSON {
		content, err := playgroundExportJSON(export)
		if err != nil {
			common.ApiError(c, err)
			return
		}
		envelope.ContentType = "application/json; charset=utf-8"
		envelope.Filename = playgroundExportFilename(export.Session.Title, "json")
		envelope.Content = content
	} else {
		envelope.ContentType = "text/markdown; charset=utf-8"
		envelope.Filename = playgroundExportFilename(export.Session.Title, "md")
		envelope.Content = playgroundExportMarkdown(export)
	}
	common.ApiSuccess(c, envelope)
}

func playgroundExportJSON(export *model.PlaygroundSessionExport) (string, error) {
	session := &export.Session
	document := playgroundExportDocument{
		ExportedAt: common.GetTimestamp(),
		Session: playgroundExportSession{
			ID: session.ID, Title: session.Title, ClientID: session.ClientID,
			SystemPrompt:     session.SystemPrompt,
			Config:           playgroundExportRawJSON(session.Config, "{}"),
			ParameterEnabled: playgroundExportRawJSON(session.ParameterEnabled, "{}"),
			Context:          playgroundExportRawJSON(session.ContextConfig, "{}"),
			ContextSummary:   playgroundExportRawJSON(session.ContextSummary, "null"),
			Trashed:          session.DeletedAt > 0,
			CreatedAt:        session.CreatedAt,
			UpdatedAt:        session.UpdatedAt,
			MessageRevision:  session.MessageRevision,
		},
		Messages: make([]playgroundExportMessage, 0, len(export.Messages)),
	}
	for index := range export.Messages {
		document.Messages = append(document.Messages, playgroundExportMessage{
			ClientKey: export.Messages[index].ClientKey,
			Payload:   playgroundExportRawJSON(string(export.Messages[index].Payload), "null"),
		})
	}
	encoded, err := common.Marshal(document)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// playgroundExportRawJSON embeds a stored JSON column as a raw value without
// re-encoding it; an empty or NULL column falls back to the value the client
// applies for that field.
func playgroundExportRawJSON(stored string, fallback string) json.RawMessage {
	trimmed := strings.TrimSpace(stored)
	if trimmed == "" || trimmed == "null" {
		return json.RawMessage(fallback)
	}
	return json.RawMessage(trimmed)
}

// playgroundExportMarkdown renders the human-readable export: the conversation
// metadata, the conversation-level instructions, and every stored message with
// its content, status, attachment links, tool calls and sources. Reasoning is
// rendered as a blockquote so it stays distinguishable from the answer.
func playgroundExportMarkdown(export *model.PlaygroundSessionExport) string {
	session := &export.Session
	var builder strings.Builder
	builder.WriteString("# " + playgroundExportSingleLine(session.Title) + "\n\n")
	builder.WriteString("- Conversation ID: " + session.ID + "\n")
	builder.WriteString("- Created: " + playgroundExportTime(session.CreatedAt) + "\n")
	builder.WriteString("- Updated: " + playgroundExportTime(session.UpdatedAt) + "\n")
	if session.DeletedAt > 0 {
		builder.WriteString("- In trash since: " + playgroundExportTime(session.DeletedAt) + "\n")
	}
	builder.WriteString("\n")
	if config := strings.TrimSpace(session.Config); config != "" && config != "{}" && config != "null" {
		builder.WriteString("## Configuration\n\n```json\n" + config + "\n```\n\n")
	}
	if prompt := strings.TrimSpace(session.SystemPrompt); prompt != "" {
		builder.WriteString("## System prompt\n\n" + prompt + "\n\n")
	}
	if summary := playgroundExportContextSummary(session.ContextSummary); summary != "" {
		builder.WriteString("## Context summary\n\n" + summary + "\n\n")
	}
	builder.WriteString("## Messages\n\n")
	if len(export.Messages) == 0 {
		builder.WriteString("_No messages._\n\n")
	}
	for index := range export.Messages {
		playgroundExportWriteMessage(&builder, session.ID, index+1, &export.Messages[index])
	}
	return builder.String()
}

func playgroundExportWriteMessage(builder *strings.Builder, sessionID string, position int, message *model.PlaygroundMessage) {
	var payload playgroundMessagePayload
	if err := common.UnmarshalJsonStr(string(message.Payload), &payload); err != nil {
		// A stored payload that no longer parses is exported verbatim so the
		// export never silently drops data.
		fmt.Fprintf(builder, "### %d. Message\n\n```json\n%s\n```\n\n", position, message.Payload)
		return
	}
	heading := fmt.Sprintf("### %d. %s", position, playgroundExportRoleName(payload.From))
	if len(payload.Versions) == 1 && payload.Versions[0].Model != nil && *payload.Versions[0].Model != "" {
		heading += " (" + playgroundExportSingleLine(*payload.Versions[0].Model) + ")"
	}
	builder.WriteString(heading + "\n\n")
	if payload.Status == "error" && payload.ErrorCode != nil && *payload.ErrorCode != "" {
		builder.WriteString("> Error: " + playgroundExportSingleLine(*payload.ErrorCode) + "\n\n")
	}
	for versionIndex := range payload.Versions {
		version := &payload.Versions[versionIndex]
		if len(payload.Versions) > 1 {
			label := fmt.Sprintf("Version %d", versionIndex+1)
			if version.Model != nil && *version.Model != "" {
				label += " (" + playgroundExportSingleLine(*version.Model) + ")"
			}
			builder.WriteString("#### " + label + "\n\n")
		}
		if content := strings.TrimRight(version.Content, "\n"); strings.TrimSpace(content) != "" {
			builder.WriteString(content + "\n\n")
		}
		if version.Status == "error" {
			reason := "failed"
			if version.ErrorCode != nil && *version.ErrorCode != "" {
				reason = playgroundExportSingleLine(*version.ErrorCode)
			}
			builder.WriteString("> Error: " + reason + "\n\n")
		}
		for _, attachment := range version.Attachments {
			label := attachment.Filename
			if label == "" {
				label = attachment.ID
			}
			url := "/api/playground/sessions/" + sessionID + "/attachments/" + attachment.ID + "/content"
			builder.WriteString("- [" + playgroundExportSingleLine(label) + "](" + url + ")\n")
		}
		if len(version.Attachments) > 0 {
			builder.WriteString("\n")
		}
		for _, toolCall := range version.ToolCalls {
			builder.WriteString("- Tool call `" + playgroundExportSingleLine(toolCall.Name) + "` (`" + toolCall.Status + "`)\n")
			if arguments := strings.TrimSpace(toolCall.Arguments); arguments != "" {
				builder.WriteString("\n  ```json\n  " + strings.ReplaceAll(arguments, "\n", "\n  ") + "\n  ```\n")
			}
			if toolCall.Result != nil && strings.TrimSpace(*toolCall.Result) != "" {
				builder.WriteString("\n  Result:\n\n  ```\n  " + strings.ReplaceAll(strings.TrimRight(*toolCall.Result, "\n"), "\n", "\n  ") + "\n  ```\n")
			}
			builder.WriteString("\n")
		}
		for _, source := range payload.Sources {
			builder.WriteString("- [" + playgroundExportSingleLine(source.Title) + "](" + source.Href + ")\n")
		}
		if len(payload.Sources) > 0 {
			builder.WriteString("\n")
		}
		if payload.Reasoning != nil && strings.TrimSpace(payload.Reasoning.Content) != "" {
			reasoning := strings.TrimRight(payload.Reasoning.Content, "\n")
			builder.WriteString("> " + strings.ReplaceAll(reasoning, "\n", "\n> ") + "\n\n")
		}
	}
}

func playgroundExportRoleName(from string) string {
	switch from {
	case "user":
		return "User"
	case "assistant":
		return "Assistant"
	case "system":
		return "System"
	}
	return "Message"
}

func playgroundExportContextSummary(stored string) string {
	trimmed := strings.TrimSpace(stored)
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	var summary playgroundContextSummary
	if err := common.UnmarshalJsonStr(trimmed, &summary); err != nil {
		return ""
	}
	return strings.TrimSpace(summary.Content)
}

func playgroundExportTime(timestamp int64) string {
	return time.Unix(timestamp, 0).UTC().Format(time.RFC3339)
}

// playgroundExportSingleLine keeps an exported title or label on one line so
// user input can never break the Markdown structure of the file.
func playgroundExportSingleLine(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// playgroundExportFilename derives a portable download name from the
// conversation title. Path separators and control characters become dashes,
// whitespace is collapsed, and an empty title falls back to a stable name.
func playgroundExportFilename(title string, extension string) string {
	var builder strings.Builder
	for _, symbol := range strings.TrimSpace(title) {
		switch {
		case symbol == '/' || symbol == '\\' || symbol == ':' || symbol == '*' ||
			symbol == '?' || symbol == '"' || symbol == '<' || symbol == '>' ||
			symbol == '|' || symbol < 0x20:
			builder.WriteRune('-')
		default:
			builder.WriteRune(symbol)
		}
	}
	name := strings.Join(strings.Fields(builder.String()), " ")
	name = strings.Trim(name, ". ")
	if name == "" {
		name = "conversation"
	}
	if runes := []rune(name); len(runes) > playgroundExportFilenameMaxLength {
		name = string(runes[:playgroundExportFilenameMaxLength])
	}
	return name + "." + extension
}
