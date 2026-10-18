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
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/gin-gonic/gin"
)

const (
	// playgroundCanvasArchiveFormat identifies the archive a canvas export
	// writes and the import accepts. The format name and version guard the
	// manifest contract, exactly like the client document carries its own
	// version.
	playgroundCanvasArchiveFormat  = "new-api-canvas"
	playgroundCanvasArchiveVersion = 1
	// playgroundCanvasArchiveManifestEntry is the archive member that stores
	// the manifest with the document and the resource table.
	playgroundCanvasArchiveManifestEntry = "canvas.json"
	// playgroundCanvasArchiveResourceDir is the archive folder that stores the
	// controlled-read bytes of the resources a document references.
	playgroundCanvasArchiveResourceDir = "resources/"
	// playgroundCanvasArchiveMaxUploadBytes bounds one import request: the
	// default account attachment quota plus one document and the zip overhead.
	// The per-file budgets of the importing account still apply to every
	// resource, so a configured smaller quota is enforced as usual.
	playgroundCanvasArchiveMaxUploadBytes = 96 << 20
	// playgroundCanvasArchiveManifestMaxBytes bounds the manifest member. It
	// carries one document and one row per resource, so a few MiB cover the
	// largest valid archive.
	playgroundCanvasArchiveManifestMaxBytes = 4 << 20
	// playgroundCanvasArchiveMaxEntries bounds the members of one archive so a
	// hand-crafted zip cannot force a scan of an unbounded file table.
	playgroundCanvasArchiveMaxEntries = 512
	// playgroundCanvasArchiveClientKeyPrefix marks the attachment client key an
	// import derives, so a restored resource is never mistaken for an upload of
	// the same archive twice.
	playgroundCanvasArchiveClientKeyPrefix = "canvas-archive-"
	// playgroundCanvasArchiveEmptyDocument is the document a canvas is created
	// with before its resources are uploaded; it is replaced in the same
	// request, and a failed import leaves nothing behind.
	playgroundCanvasArchiveEmptyDocument = `{"nodes":[],"edges":[]}`
)

// errPlaygroundCanvasArchiveInvalid reports an upload that is not a canvas
// archive. It maps to the same 400 as an invalid canvas request.
var errPlaygroundCanvasArchiveInvalid = errors.New("Invalid Playground canvas archive.")

// playgroundCanvasArchiveResource describes one stored resource inside an
// archive: the member that carries the bytes and the metadata the import needs
// to restore it as an attachment of the new canvas.
type playgroundCanvasArchiveResource struct {
	Entry        string `json:"entry"`
	AttachmentID string `json:"attachment_id"`
	SessionID    string `json:"session_id,omitempty"`
	Filename     string `json:"filename"`
	MediaType    string `json:"media_type"`
	ByteSize     int64  `json:"byte_size"`
	ContentHash  string `json:"content_hash"`
}

// playgroundCanvasArchiveManifest is the self-describing archive header. The
// document is embedded raw so the archive stays readable without the server,
// and every resource row describes exactly one member of the resource folder.
type playgroundCanvasArchiveManifest struct {
	Format     string                            `json:"format"`
	Version    int                               `json:"version"`
	Title      string                            `json:"title,omitempty"`
	ExportedAt int64                             `json:"exported_at"`
	Document   json.RawMessage                   `json:"document"`
	Resources  []playgroundCanvasArchiveResource `json:"resources"`
}

// playgroundCanvasArchiveImportResponse reports a completed import: the created
// canvas, how many resources were restored, and what the archive or the account
// could not carry over.
type playgroundCanvasArchiveImportResponse struct {
	Project           playgroundCanvasResponse `json:"project"`
	ResourcesImported int                      `json:"resources_imported"`
	ResourcesMissing  int                      `json:"resources_missing"`
	ReferencesDropped int                      `json:"references_dropped"`
}

// writePlaygroundCanvasArchiveInvalid answers a malformed import upload the
// same way an invalid canvas request is answered.
func writePlaygroundCanvasArchiveInvalid(c *gin.Context) {
	common.ApiErrorStatus(c, http.StatusBadRequest, common.NewMessage(errPlaygroundCanvasArchiveInvalid.Error()), gin.H{"code": "PLAYGROUND_INVALID_REQUEST"})
}

// ExportPlaygroundCanvasArchive streams one owned canvas as a zip archive: the
// manifest with the document plus the bytes of every attachment its nodes
// reference, read through the same controlled path as the content endpoint. A
// `nodes` query with a comma-separated node list exports just those nodes and
// the edges between them, so a selection can be moved to another board or
// account. The export never fails on a resource that is already gone: the node
// keeps its id and the importer reports the source as missing, exactly like the
// board does.
func ExportPlaygroundCanvasArchive(c *gin.Context) {
	userID := c.GetInt("id")
	if userID <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	project, err := model.GetPlaygroundCanvasProject(userID, c.Param("canvasId"))
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	var document playgroundCanvasDocument
	if common.UnmarshalJsonStr(string(project.Document), &document) != nil {
		writePlaygroundCanvasError(c, model.ErrPlaygroundCanvasInvalid)
		return
	}
	selected, err := playgroundCanvasArchiveSelection(c.Query("nodes"), &document)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	exported := playgroundCanvasArchiveDocument(&document, selected)
	encodedDocument, err := common.Marshal(exported)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	manifest := playgroundCanvasArchiveManifest{
		Format: playgroundCanvasArchiveFormat, Version: playgroundCanvasArchiveVersion,
		Title: project.Title, ExportedAt: common.GetTimestamp(),
		Document: encodedDocument, Resources: make([]playgroundCanvasArchiveResource, 0),
	}
	for _, attachmentID := range playgroundCanvasArchiveAttachmentIDs(exported) {
		attachment, err := model.GetPlaygroundAttachmentForUser(userID, attachmentID)
		if err != nil {
			if errors.Is(err, model.ErrPlaygroundAttachmentNotFound) {
				continue
			}
			writePlaygroundCanvasError(c, err)
			return
		}
		manifest.Resources = append(manifest.Resources, playgroundCanvasArchiveResource{
			Entry: playgroundCanvasArchiveEntryName(attachment), AttachmentID: attachment.ID,
			SessionID: attachment.SessionID, Filename: attachment.Filename, MediaType: attachment.MediaType,
			ByteSize: attachment.ByteSize, ContentHash: attachment.ContentHash,
		})
	}
	encodedManifest, err := common.Marshal(manifest)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	// The response is a stream: after the first member is written an error can
	// only abort the download. A partial archive still imports, because every
	// member that is absent or damaged is reported as a missing resource.
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
		"filename": playgroundExportFilename(project.Title, "zip"),
	}))
	c.Header("Cache-Control", "private, no-store")
	writer := zip.NewWriter(c.Writer)
	if err := playgroundCanvasArchiveWriteEntry(writer, playgroundCanvasArchiveManifestEntry, manifest.ExportedAt, int64(len(encodedManifest)), bytes.NewReader(encodedManifest)); err != nil {
		_ = writer.Close()
		return
	}
	for index := range manifest.Resources {
		resource := &manifest.Resources[index]
		attachment, err := model.GetPlaygroundAttachmentForUser(userID, resource.AttachmentID)
		if err != nil {
			// The row vanished while the archive was streaming; the member
			// stays absent and the import reports the resource as missing.
			continue
		}
		reader, err := model.OpenPlaygroundAttachmentContent(c.Request.Context(), attachment)
		if err != nil {
			continue
		}
		err = playgroundCanvasArchiveWriteEntry(writer, resource.Entry, manifest.ExportedAt, resource.ByteSize, reader)
		_ = reader.Close()
		if err != nil {
			_ = writer.Close()
			return
		}
	}
	_ = writer.Close()
}

// ImportPlaygroundCanvasArchive restores one canvas archive as a new canvas of
// the account: the manifest is validated first, every resource is re-uploaded
// through the regular attachment path, the document references are rewritten to
// the new rows, and references the account is not allowed to keep are dropped.
// A failure after the canvas row is created removes it again, so an import is
// all-or-nothing for the board. Resources the archive no longer carries stay
// referenced and are reported as missing, which is the same state a board shows
// after its source was deleted.
func ImportPlaygroundCanvasArchive(c *gin.Context) {
	userID := c.GetInt("id")
	if userID <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	if !enforcePlaygroundWalletWritable(c) {
		return
	}
	policy, ok := playgroundRequestPolicy(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, playgroundCanvasArchiveMaxUploadBytes)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			common.ApiErrorStatus(c, http.StatusRequestEntityTooLarge, common.NewMessage("Playground request is too large."), gin.H{"code": "PLAYGROUND_REQUEST_TOO_LARGE"})
			return
		}
		writePlaygroundCanvasArchiveInvalid(c)
		return
	}
	defer file.Close()
	if header.Size <= 0 {
		writePlaygroundCanvasArchiveInvalid(c)
		return
	}
	archive, err := zip.NewReader(file, header.Size)
	if err != nil || len(archive.File) > playgroundCanvasArchiveMaxEntries {
		writePlaygroundCanvasArchiveInvalid(c)
		return
	}
	manifest, document, err := playgroundCanvasArchiveReadManifest(archive, policy)
	if err != nil {
		if errors.Is(err, errPlaygroundCanvasArchiveInvalid) {
			writePlaygroundCanvasArchiveInvalid(c)
			return
		}
		writePlaygroundCanvasError(c, err)
		return
	}
	if _, _, _, err := normalizePlaygroundCanvasDocument(document, policy); err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	title := strings.TrimSpace(manifest.Title)
	if title != "" {
		validated, err := playgroundCanvasTitle(&title)
		if err != nil {
			writePlaygroundCanvasError(c, err)
			return
		}
		title = validated
	}
	project, _, err := model.CreatePlaygroundCanvasProject(userID, &model.PlaygroundCanvasProject{
		Title: title, Document: model.LongText(playgroundCanvasArchiveEmptyDocument),
		DocumentBytes: int64(len(playgroundCanvasArchiveEmptyDocument)),
	}, model.PlaygroundCanvasPins{})
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	uploaded := make(map[string]string, len(manifest.Resources))
	missing := 0
	for index := range manifest.Resources {
		resource := &manifest.Resources[index]
		attachment, restored, err := playgroundCanvasArchiveRestoreResource(c.Request.Context(), userID, project.ID, archive, resource, policy)
		if err != nil {
			playgroundCanvasArchiveDiscard(userID, project.ID)
			writePlaygroundAttachmentError(c, err)
			return
		}
		if !restored {
			missing++
			continue
		}
		uploaded[resource.AttachmentID] = attachment.ID
	}
	dropped, err := playgroundCanvasArchiveRewriteDocument(userID, document, uploaded, project.ID)
	if err != nil {
		playgroundCanvasArchiveDiscard(userID, project.ID)
		writePlaygroundCanvasError(c, err)
		return
	}
	normalized, nodeCount, edgeCount, err := normalizePlaygroundCanvasDocument(document, policy)
	if err != nil {
		playgroundCanvasArchiveDiscard(userID, project.ID)
		writePlaygroundCanvasError(c, err)
		return
	}
	pins, err := validatePlaygroundCanvasReferences(userID, document)
	if err != nil {
		playgroundCanvasArchiveDiscard(userID, project.ID)
		writePlaygroundCanvasError(c, err)
		return
	}
	stored, err := model.UpdatePlaygroundCanvasProject(userID, project.ID, project.Revision, model.UpdatePlaygroundCanvasInput{
		Document: &normalized, NodeCount: nodeCount, EdgeCount: edgeCount, Pins: pins,
	})
	if err != nil {
		playgroundCanvasArchiveDiscard(userID, project.ID)
		writePlaygroundCanvasError(c, err)
		return
	}
	response := playgroundCanvasArchiveImportResponse{
		Project:           playgroundDecodeCanvasProject(stored, false),
		ResourcesImported: len(uploaded),
		ResourcesMissing:  missing,
		ReferencesDropped: dropped,
	}
	response.Project.UnavailableNodeIDs = playgroundCanvasUnavailableNodeIDs(userID, normalized)
	common.ApiSuccess(c, response)
}

// playgroundCanvasArchiveDiscard removes the canvas row of an import that
// failed after creation. The uploaded attachments become unreferenced and are
// collected by the orphan cleanup, which keeps this rollback to those two
// transactions instead of a second pass over the resources.
func playgroundCanvasArchiveDiscard(userID int, canvasID string) {
	if err := model.DeletePlaygroundCanvasProject(userID, canvasID); err != nil {
		common.SysError("Playground canvas import cleanup failed: " + err.Error())
		return
	}
	if err := model.PurgePlaygroundCanvasProject(userID, canvasID); err != nil {
		common.SysError("Playground canvas import purge failed: " + err.Error())
	}
}

// playgroundCanvasArchiveSelection parses the optional `nodes` query of an
// export request: the selected node ids, or nil when the whole board is
// exported. An id the stored document does not contain is rejected, so a stale
// selection cannot silently export a different board.
func playgroundCanvasArchiveSelection(query string, document *playgroundCanvasDocument) (map[string]bool, error) {
	if strings.TrimSpace(query) == "" {
		return nil, nil
	}
	known := make(map[string]bool, len(document.Nodes))
	for index := range document.Nodes {
		known[document.Nodes[index].ID] = true
	}
	selected := make(map[string]bool)
	for id := range strings.SplitSeq(query, ",") {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if len(id) > 200 || !known[id] {
			return nil, model.ErrPlaygroundCanvasInvalid
		}
		selected[id] = true
	}
	if len(selected) == 0 {
		return nil, nil
	}
	return selected, nil
}

// playgroundCanvasArchiveDocument returns the document an export writes: the
// whole board, or the selected nodes with the edges between them. A selected
// node that lived in a group outside the selection loses its parent link so the
// subset stands on its own.
func playgroundCanvasArchiveDocument(document *playgroundCanvasDocument, selected map[string]bool) *playgroundCanvasDocument {
	if selected == nil {
		return document
	}
	subset := &playgroundCanvasDocument{
		Nodes: make([]playgroundCanvasNode, 0, len(selected)),
		Edges: make([]playgroundCanvasEdge, 0, len(document.Edges)),
	}
	for index := range document.Nodes {
		node := document.Nodes[index]
		if !selected[node.ID] {
			continue
		}
		node.Data = playgroundCanvasArchiveSelectedNodeData(node.Data, selected)
		subset.Nodes = append(subset.Nodes, node)
	}
	for index := range document.Edges {
		edge := document.Edges[index]
		if selected[edge.Source] && selected[edge.Target] {
			subset.Edges = append(subset.Edges, edge)
		}
	}
	return subset
}

// playgroundCanvasArchiveSelectedNodeData removes the group link of a node
// whose group node is not part of the exported selection. The link lives in the
// opaque node data, so only the parent id is removed and every other field
// stays intact.
func playgroundCanvasArchiveSelectedNodeData(data json.RawMessage, selected map[string]bool) json.RawMessage {
	if len(data) == 0 {
		return data
	}
	var decoded map[string]json.RawMessage
	if common.Unmarshal(data, &decoded) != nil {
		return data
	}
	rawParent, ok := decoded["parentId"]
	if !ok {
		return data
	}
	var parentID string
	if common.Unmarshal(rawParent, &parentID) != nil || parentID == "" || selected[parentID] {
		return data
	}
	delete(decoded, "parentId")
	encoded, err := common.Marshal(decoded)
	if err != nil {
		return data
	}
	return encoded
}

// playgroundCanvasArchiveAttachmentIDs lists the attachments the exported
// document references, deduplicated and ordered so the same board always
// produces the same resource table.
func playgroundCanvasArchiveAttachmentIDs(document *playgroundCanvasDocument) []string {
	seen := make(map[string]bool)
	ids := make([]string, 0)
	for _, claim := range playgroundCanvasNodeReferences(document) {
		id := claim.Reference.AttachmentID
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// playgroundCanvasArchiveEntryName derives the archive member of one resource.
// The attachment id is generated, but the name is rebuilt from a safe character
// set anyway, so a hand-crafted row can never contribute a path separator.
func playgroundCanvasArchiveEntryName(attachment *model.PlaygroundAttachment) string {
	var builder strings.Builder
	builder.WriteString(playgroundCanvasArchiveResourceDir)
	for _, symbol := range attachment.ID {
		switch {
		case symbol == '_' || symbol == '-',
			symbol >= '0' && symbol <= '9',
			symbol >= 'a' && symbol <= 'z',
			symbol >= 'A' && symbol <= 'Z':
			builder.WriteRune(symbol)
		default:
			builder.WriteByte('-')
		}
	}
	if builder.Len() == len(playgroundCanvasArchiveResourceDir) {
		builder.WriteString("resource")
	}
	builder.WriteString(model.PlaygroundAttachmentExtension(attachment.MediaType))
	return builder.String()
}

// playgroundCanvasArchiveWriteEntry writes one member of the archive. size
// bounds the payload, so a member can never stream more bytes than the manifest
// promises.
func playgroundCanvasArchiveWriteEntry(writer *zip.Writer, name string, modified int64, size int64, content io.Reader) error {
	header := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Unix(modified, 0).UTC()}
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(entry, io.LimitReader(content, size))
	return err
}

// playgroundCanvasArchiveReadManifest finds and validates the manifest member
// and decodes the document it describes. Structural problems reject the whole
// archive; a resource member that is missing or damaged is handled per resource
// later, so a partially collected board still restores.
func playgroundCanvasArchiveReadManifest(archive *zip.Reader, policy playground_setting.PlaygroundQuotaPolicy) (*playgroundCanvasArchiveManifest, *playgroundCanvasDocument, error) {
	var member *zip.File
	for _, entry := range archive.File {
		if entry.Name == playgroundCanvasArchiveManifestEntry {
			member = entry
			break
		}
	}
	if member == nil || member.FileInfo().IsDir() {
		return nil, nil, errPlaygroundCanvasArchiveInvalid
	}
	reader, err := member.Open()
	if err != nil {
		return nil, nil, errPlaygroundCanvasArchiveInvalid
	}
	defer reader.Close()
	encoded, err := io.ReadAll(io.LimitReader(reader, playgroundCanvasArchiveManifestMaxBytes+1))
	if err != nil || len(encoded) > playgroundCanvasArchiveManifestMaxBytes {
		return nil, nil, errPlaygroundCanvasArchiveInvalid
	}
	var manifest playgroundCanvasArchiveManifest
	if common.Unmarshal(encoded, &manifest) != nil {
		return nil, nil, errPlaygroundCanvasArchiveInvalid
	}
	if manifest.Format != playgroundCanvasArchiveFormat || manifest.Version != playgroundCanvasArchiveVersion {
		return nil, nil, errPlaygroundCanvasArchiveInvalid
	}
	if len(manifest.Document) == 0 || len(manifest.Resources) > policy.CanvasMaxNodes {
		return nil, nil, errPlaygroundCanvasArchiveInvalid
	}
	var document playgroundCanvasDocument
	if common.Unmarshal(manifest.Document, &document) != nil {
		return nil, nil, errPlaygroundCanvasArchiveInvalid
	}
	members := make(map[string]bool, len(manifest.Resources))
	attachments := make(map[string]bool, len(manifest.Resources))
	for index := range manifest.Resources {
		resource := &manifest.Resources[index]
		if !playgroundCanvasArchiveMemberValid(resource.Entry) || members[resource.Entry] ||
			resource.AttachmentID == "" || len(resource.AttachmentID) > 64 || attachments[resource.AttachmentID] ||
			resource.ByteSize <= 0 || resource.Filename == "" || utf8.RuneCountInString(resource.Filename) > 255 ||
			len(resource.SessionID) > 64 || !model.IsPlaygroundAttachmentMediaType(resource.MediaType) {
			return nil, nil, errPlaygroundCanvasArchiveInvalid
		}
		if len(resource.ContentHash) != 64 {
			return nil, nil, errPlaygroundCanvasArchiveInvalid
		}
		if _, err := hex.DecodeString(resource.ContentHash); err != nil {
			return nil, nil, errPlaygroundCanvasArchiveInvalid
		}
		members[resource.Entry] = true
		attachments[resource.AttachmentID] = true
	}
	return &manifest, &document, nil
}

// playgroundCanvasArchiveMemberValid accepts a manifest entry that points at one
// direct child of the resource folder, so an import can never be steered outside
// the archive.
func playgroundCanvasArchiveMemberValid(name string) bool {
	base, ok := strings.CutPrefix(name, playgroundCanvasArchiveResourceDir)
	if !ok || base == "" || len(base) > 200 || base[0] == '.' {
		return false
	}
	return !strings.ContainsAny(base, `/\`) && !strings.ContainsRune(base, 0)
}

// playgroundCanvasArchiveResourceInput reads one resource member and verifies
// it against the manifest: the member must exist, match its recorded size and
// SHA-256, fit the importing account's per-file budget, and still match its
// declared media type. Anything else is reported as a missing resource instead
// of failing the import.
func playgroundCanvasArchiveResourceInput(archive *zip.Reader, resource *playgroundCanvasArchiveResource, policy playground_setting.PlaygroundQuotaPolicy) (model.PlaygroundAttachmentInput, bool) {
	budget := policy.AttachmentMediaMaxFileBytes(resource.MediaType)
	if resource.ByteSize <= 0 || resource.ByteSize > budget {
		return model.PlaygroundAttachmentInput{}, false
	}
	var member *zip.File
	for _, entry := range archive.File {
		if entry.Name == resource.Entry {
			member = entry
			break
		}
	}
	if member == nil || member.FileInfo().IsDir() {
		return model.PlaygroundAttachmentInput{}, false
	}
	reader, err := member.Open()
	if err != nil {
		return model.PlaygroundAttachmentInput{}, false
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, resource.ByteSize+1))
	if err != nil || int64(len(data)) != resource.ByteSize {
		return model.PlaygroundAttachmentInput{}, false
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != resource.ContentHash {
		return model.PlaygroundAttachmentInput{}, false
	}
	input := model.PlaygroundAttachmentInput{
		ClientKey: playgroundCanvasArchiveClientKeyPrefix,
		MediaType: resource.MediaType,
		Filename:  resource.Filename,
		Data:      data,
	}
	if model.ValidatePlaygroundAttachmentInput(&input, budget) != nil {
		return model.PlaygroundAttachmentInput{}, false
	}
	return input, true
}

// playgroundCanvasArchiveRestoreResource restores one archive resource as an
// attachment of the new canvas. A member that is missing or damaged reports
// false so the import keeps going; a rejected upload (quota, storage) returns
// the error and fails the whole import.
func playgroundCanvasArchiveRestoreResource(ctx context.Context, userID int, canvasID string, archive *zip.Reader, resource *playgroundCanvasArchiveResource, policy playground_setting.PlaygroundQuotaPolicy) (*model.PlaygroundAttachment, bool, error) {
	input, ok := playgroundCanvasArchiveResourceInput(archive, resource, policy)
	if !ok {
		return nil, false, nil
	}
	key, err := common.GenerateRandomCharsKey(24)
	if err != nil {
		return nil, false, err
	}
	input.ClientKey = playgroundCanvasArchiveClientKeyPrefix + key
	attachment, _, err := model.CreatePlaygroundCanvasAttachment(ctx, userID, canvasID, input)
	if err != nil {
		return nil, false, err
	}
	return attachment, true, nil
}

// playgroundCanvasArchiveRewriteDocument points an imported document at the
// resources the import just uploaded and drops the references the account is
// not allowed to keep. A restored attachment follows its bytes into the new
// canvas partition; a foreign or malformed reference is removed while the node
// keeps its own stored text, and a reference whose bytes the archive does not
// carry stays as the "source deleted" state it already shows.
func playgroundCanvasArchiveRewriteDocument(userID int, document *playgroundCanvasDocument, uploaded map[string]string, canvasID string) (int, error) {
	dropped := 0
	for index := range document.Nodes {
		data := document.Nodes[index].Data
		if len(data) == 0 {
			continue
		}
		var decoded map[string]json.RawMessage
		if common.Unmarshal(data, &decoded) != nil {
			continue
		}
		rawReference, present := decoded["ref"]
		if !present {
			continue
		}
		var reference map[string]json.RawMessage
		if common.Unmarshal(rawReference, &reference) != nil {
			continue
		}
		resolved := model.PlaygroundCanvasReference{
			SessionID:       playgroundCanvasArchiveReferenceField(reference, "sessionId"),
			MessageKey:      playgroundCanvasArchiveReferenceField(reference, "messageKey"),
			AttachmentID:    playgroundCanvasArchiveReferenceField(reference, "attachmentId"),
			ArtifactID:      playgroundCanvasArchiveReferenceField(reference, "artifactId"),
			TaskID:          playgroundCanvasArchiveReferenceField(reference, "taskId"),
			TaskArtifactKey: playgroundCanvasArchiveReferenceField(reference, "taskArtifactKey"),
		}
		if resolved.MessageKey == "" && resolved.AttachmentID == "" && resolved.ArtifactID == "" &&
			resolved.TaskID == "" && resolved.TaskArtifactKey == "" {
			continue
		}
		restored, attachmentRestored := "", false
		sessionMoved := false
		if resolved.AttachmentID != "" {
			restored, attachmentRestored = uploaded[resolved.AttachmentID]
		}
		if attachmentRestored {
			resolved.AttachmentID = restored
			// An attachment-only node follows its bytes into the imported canvas
			// partition; a reference that also names a message, artifact or task
			// keeps its session, because that is what those parts resolve by.
			sessionMoved = resolved.MessageKey == "" && resolved.ArtifactID == "" &&
				resolved.TaskID == "" && resolved.TaskArtifactKey == ""
			if sessionMoved {
				resolved.SessionID = canvasID
			}
		}
		owned, err := model.PlaygroundCanvasReferenceOwnership(userID, []model.PlaygroundCanvasReference{resolved})
		if err != nil {
			return dropped, err
		}
		if !owned[0] {
			delete(decoded, "ref")
			encoded, err := common.Marshal(decoded)
			if err != nil {
				return dropped, err
			}
			document.Nodes[index].Data = encoded
			dropped++
			continue
		}
		if !attachmentRestored {
			continue
		}
		if err := playgroundCanvasArchiveSetReferenceField(reference, "attachmentId", restored); err != nil {
			return dropped, err
		}
		if sessionMoved {
			if err := playgroundCanvasArchiveSetReferenceField(reference, "sessionId", canvasID); err != nil {
				return dropped, err
			}
		}
		encodedReference, err := common.Marshal(reference)
		if err != nil {
			return dropped, err
		}
		decoded["ref"] = encodedReference
		encoded, err := common.Marshal(decoded)
		if err != nil {
			return dropped, err
		}
		document.Nodes[index].Data = encoded
	}
	return dropped, nil
}

// playgroundCanvasArchiveReferenceField reads one optional string field of a
// decoded reference; a field of any other type is treated as absent, exactly
// like the reference parser treats it.
func playgroundCanvasArchiveReferenceField(reference map[string]json.RawMessage, key string) string {
	raw, present := reference[key]
	if !present {
		return ""
	}
	var value string
	if common.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value
}

// playgroundCanvasArchiveSetReferenceField replaces one string field of a
// decoded reference, preserving every field the canvas does not interpret.
func playgroundCanvasArchiveSetReferenceField(reference map[string]json.RawMessage, key string, value string) error {
	encoded, err := common.Marshal(value)
	if err != nil {
		return err
	}
	reference[key] = encoded
	return nil
}
