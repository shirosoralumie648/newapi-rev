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
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

// The request body carries the canvas document plus its JSON envelope; the
// stored document itself is capped at model.PlaygroundCanvasDocumentMaxBytes.
const playgroundCanvasRequestMaxBytes = 2 << 20

var playgroundCanvasNodeTypes = map[string]bool{
	"text":        true,
	"note":        true,
	"prompt":      true,
	"image":       true,
	"attachment":  true,
	"artifact":    true,
	"message":     true,
	"task":        true,
	"task-result": true,
}

type playgroundCanvasViewport struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Zoom float64 `json:"zoom"`
}

type playgroundCanvasPosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type playgroundCanvasNode struct {
	ID       string                   `json:"id"`
	Type     string                   `json:"type"`
	Position playgroundCanvasPosition `json:"position"`
	Width    *float64                 `json:"width,omitempty"`
	Height   *float64                 `json:"height,omitempty"`
	Data     json.RawMessage          `json:"data,omitempty"`
}

// playgroundCanvasNodeReference mirrors the reference an imported or saved
// node may carry in its opaque `data` payload. Only these IDs are treated as
// resource ownership claims; everything else stays display-only.
type playgroundCanvasNodeReference struct {
	SessionID    string `json:"sessionId"`
	MessageKey   string `json:"messageKey"`
	AttachmentID string `json:"attachmentId"`
	ArtifactID   string `json:"artifactId"`
}

type playgroundCanvasNodeData struct {
	Ref *playgroundCanvasNodeReference `json:"ref"`
}

type playgroundCanvasEdge struct {
	ID           string  `json:"id"`
	Source       string  `json:"source"`
	Target       string  `json:"target"`
	SourceHandle *string `json:"source_handle,omitempty"`
	TargetHandle *string `json:"target_handle,omitempty"`
	Label        *string `json:"label,omitempty"`
}

type playgroundCanvasDocument struct {
	Viewport *playgroundCanvasViewport `json:"viewport,omitempty"`
	Nodes    []playgroundCanvasNode    `json:"nodes"`
	Edges    []playgroundCanvasEdge    `json:"edges"`
}

type playgroundCanvasRequest struct {
	ClientID string                    `json:"client_id"`
	Title    *string                   `json:"title"`
	Revision *int64                    `json:"revision"`
	Document *playgroundCanvasDocument `json:"document"`
}

type playgroundCanvasResponse struct {
	Created       bool            `json:"created,omitempty"`
	ID            string          `json:"id"`
	ClientID      *string         `json:"client_id,omitempty"`
	Title         string          `json:"title"`
	NodeCount     int             `json:"node_count"`
	EdgeCount     int             `json:"edge_count"`
	DocumentBytes int64           `json:"document_bytes"`
	Revision      int64           `json:"revision"`
	CreatedAt     int64           `json:"created_at"`
	UpdatedAt     int64           `json:"updated_at"`
	Document      json.RawMessage `json:"document,omitempty"`
}

func writePlaygroundCanvasError(c *gin.Context, err error) {
	status, code, message := http.StatusInternalServerError, "PLAYGROUND_STORAGE_ERROR", "Unable to load or save Playground canvases."
	switch {
	case errors.Is(err, model.ErrPlaygroundCanvasNotFound):
		status, code, message = http.StatusNotFound, "PLAYGROUND_NOT_FOUND", err.Error()
	case errors.Is(err, model.ErrPlaygroundConflict):
		status, code, message = http.StatusConflict, "PLAYGROUND_CONFLICT", err.Error()
	case errors.Is(err, model.ErrPlaygroundCanvasLimit):
		status, code, message = http.StatusUnprocessableEntity, "PLAYGROUND_CANVAS_LIMIT_EXCEEDED", err.Error()
	case errors.Is(err, model.ErrPlaygroundCanvasReference):
		status, code, message = http.StatusBadRequest, "PLAYGROUND_CANVAS_REFERENCE_INVALID", err.Error()
	case errors.Is(err, model.ErrPlaygroundCanvasInvalid):
		status, code, message = http.StatusBadRequest, "PLAYGROUND_INVALID_REQUEST", err.Error()
	}
	common.ApiErrorStatus(c, status, common.NewMessage(message), gin.H{"code": code})
}

func decodePlaygroundCanvasRequest(c *gin.Context, target any) bool {
	if c.GetInt("id") <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return false
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, playgroundCanvasRequestMaxBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			common.ApiErrorStatus(c, http.StatusRequestEntityTooLarge, common.NewMessage("Playground request is too large."), gin.H{"code": "PLAYGROUND_REQUEST_TOO_LARGE"})
		} else {
			writePlaygroundCanvasError(c, model.ErrPlaygroundCanvasInvalid)
		}
		return false
	}
	if !utf8.Valid(body) || common.Unmarshal(body, target) != nil {
		writePlaygroundCanvasError(c, model.ErrPlaygroundCanvasInvalid)
		return false
	}
	return true
}

func playgroundCanvasTitle(title *string) (string, error) {
	if title == nil {
		return "", nil
	}
	value := strings.TrimSpace(*title)
	if value == "" || utf8.RuneCountInString(value) > 200 || strings.ContainsRune(value, 0) {
		return "", model.ErrPlaygroundCanvasInvalid
	}
	return value, nil
}

func isFinitePlaygroundCanvasPosition(value float64, limit float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Abs(value) <= limit
}

// normalizePlaygroundCanvasDocument validates the document contract and
// returns the canonical serialization plus its counters. Unknown node data
// travels untouched but stays bounded; every node/edge id is re-checked so a
// stored document can never contain dangling edges.
func normalizePlaygroundCanvasDocument(document *playgroundCanvasDocument) (string, int, int, error) {
	if document == nil {
		return "", 0, 0, model.ErrPlaygroundCanvasInvalid
	}
	if len(document.Nodes) > model.PlaygroundCanvasMaxNodes || len(document.Edges) > model.PlaygroundCanvasMaxEdges {
		return "", 0, 0, model.ErrPlaygroundCanvasLimit
	}
	if document.Viewport != nil {
		viewport := document.Viewport
		if !isFinitePlaygroundCanvasPosition(viewport.X, 1e7) || !isFinitePlaygroundCanvasPosition(viewport.Y, 1e7) ||
			math.IsNaN(viewport.Zoom) || viewport.Zoom < 0.05 || viewport.Zoom > 8 {
			return "", 0, 0, model.ErrPlaygroundCanvasInvalid
		}
	}
	nodeIDs := make(map[string]bool, len(document.Nodes))
	for index := range document.Nodes {
		node := &document.Nodes[index]
		if node.ID == "" || len(node.ID) > 200 || nodeIDs[node.ID] || !playgroundCanvasNodeTypes[node.Type] {
			return "", 0, 0, model.ErrPlaygroundCanvasInvalid
		}
		nodeIDs[node.ID] = true
		if !isFinitePlaygroundCanvasPosition(node.Position.X, 1e7) || !isFinitePlaygroundCanvasPosition(node.Position.Y, 1e7) {
			return "", 0, 0, model.ErrPlaygroundCanvasInvalid
		}
		for _, dimension := range []*float64{node.Width, node.Height} {
			if dimension != nil && (!isFinitePlaygroundCanvasPosition(*dimension, 4000) || *dimension < 16) {
				return "", 0, 0, model.ErrPlaygroundCanvasInvalid
			}
		}
		if len(node.Data) > 64<<10 {
			return "", 0, 0, model.ErrPlaygroundCanvasLimit
		}
	}
	edgeIDs := make(map[string]bool, len(document.Edges))
	for index := range document.Edges {
		edge := &document.Edges[index]
		if edge.ID == "" || len(edge.ID) > 200 || edgeIDs[edge.ID] ||
			!nodeIDs[edge.Source] || !nodeIDs[edge.Target] {
			return "", 0, 0, model.ErrPlaygroundCanvasInvalid
		}
		edgeIDs[edge.ID] = true
		for _, handle := range []*string{edge.SourceHandle, edge.TargetHandle} {
			if handle != nil && len(*handle) > 200 {
				return "", 0, 0, model.ErrPlaygroundCanvasInvalid
			}
		}
		if edge.Label != nil && utf8.RuneCountInString(*edge.Label) > 200 {
			return "", 0, 0, model.ErrPlaygroundCanvasInvalid
		}
	}
	encoded, err := common.Marshal(document)
	if err != nil {
		return "", 0, 0, err
	}
	if len(encoded) > model.PlaygroundCanvasDocumentMaxBytes {
		return "", 0, 0, model.ErrPlaygroundCanvasLimit
	}
	return string(encoded), len(document.Nodes), len(document.Edges), nil
}

// playgroundCanvasReferences collects the resources a document claims. Node
// data is opaque and bounded, so a node without a well-formed `ref` object
// contributes nothing; the model layer rejects any reference that belongs to
// another account or no longer exists.
func playgroundCanvasReferences(document *playgroundCanvasDocument) []model.PlaygroundCanvasReference {
	references := make([]model.PlaygroundCanvasReference, 0)
	if document == nil {
		return references
	}
	for index := range document.Nodes {
		data := document.Nodes[index].Data
		if len(data) == 0 {
			continue
		}
		var decoded playgroundCanvasNodeData
		if common.Unmarshal(data, &decoded) != nil || decoded.Ref == nil {
			continue
		}
		ref := decoded.Ref
		if ref.SessionID == "" && ref.MessageKey == "" && ref.AttachmentID == "" && ref.ArtifactID == "" {
			continue
		}
		references = append(references, model.PlaygroundCanvasReference{
			SessionID: ref.SessionID, MessageKey: ref.MessageKey,
			AttachmentID: ref.AttachmentID, ArtifactID: ref.ArtifactID,
		})
	}
	return references
}

func playgroundDecodeCanvasProject(project *model.PlaygroundCanvasProject, created bool) playgroundCanvasResponse {
	response := playgroundCanvasResponse{
		Created: created, ID: project.ID, ClientID: project.ClientID, Title: project.Title,
		NodeCount: project.NodeCount, EdgeCount: project.EdgeCount,
		DocumentBytes: project.DocumentBytes, Revision: project.Revision,
		CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt,
	}
	if project.Document != "" {
		response.Document = json.RawMessage(project.Document)
	}
	return response
}

func playgroundCanvasPage(c *gin.Context) *common.PageInfo {
	page, ok := playgroundStrictPage(c)
	if !ok {
		writePlaygroundCanvasError(c, model.ErrPlaygroundCanvasInvalid)
		return nil
	}
	return page
}

func ListPlaygroundCanvasProjects(c *gin.Context) {
	page := playgroundCanvasPage(c)
	if page == nil {
		return
	}
	projects, total, err := model.ListPlaygroundCanvasProjects(c.GetInt("id"), page.GetStartIdx(), page.PageSize)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	items := make([]model.PlaygroundCanvasSummary, 0, len(projects))
	for index := range projects {
		items = append(items, model.PlaygroundCanvasSummary{
			ID: projects[index].ID, ClientID: projects[index].ClientID, Title: projects[index].Title,
			NodeCount: projects[index].NodeCount, EdgeCount: projects[index].EdgeCount,
			DocumentBytes: projects[index].DocumentBytes, Revision: projects[index].Revision,
			CreatedAt: projects[index].CreatedAt, UpdatedAt: projects[index].UpdatedAt,
		})
	}
	page.SetItems(items)
	page.SetTotal(int(total))
	common.ApiSuccess(c, page)
}

func CreatePlaygroundCanvasProject(c *gin.Context) {
	var request playgroundCanvasRequest
	if !decodePlaygroundCanvasRequest(c, &request) {
		return
	}
	if len(request.ClientID) > 128 {
		writePlaygroundCanvasError(c, model.ErrPlaygroundCanvasInvalid)
		return
	}
	title, err := playgroundCanvasTitle(request.Title)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	document, nodeCount, edgeCount, err := normalizePlaygroundCanvasDocument(request.Document)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	if err := model.ValidatePlaygroundCanvasReferences(c.GetInt("id"), playgroundCanvasReferences(request.Document)); err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	project := &model.PlaygroundCanvasProject{
		Title: title, Document: model.LongText(document),
		DocumentBytes: int64(len(document)), NodeCount: nodeCount, EdgeCount: edgeCount,
	}
	if request.ClientID != "" {
		project.ClientID = &request.ClientID
	}
	stored, created, err := model.CreatePlaygroundCanvasProject(c.GetInt("id"), project)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeCanvasProject(stored, created))
}

func GetPlaygroundCanvasProject(c *gin.Context) {
	project, err := model.GetPlaygroundCanvasProject(c.GetInt("id"), c.Param("canvasId"))
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeCanvasProject(project, false))
}

func UpdatePlaygroundCanvasProject(c *gin.Context) {
	var request playgroundCanvasRequest
	if !decodePlaygroundCanvasRequest(c, &request) {
		return
	}
	if request.Revision == nil || *request.Revision < 0 {
		writePlaygroundCanvasError(c, model.ErrPlaygroundCanvasInvalid)
		return
	}
	title, err := playgroundCanvasTitle(request.Title)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	input := model.UpdatePlaygroundCanvasInput{}
	if request.Title != nil {
		input.Title = &title
	}
	if request.Document != nil {
		document, nodeCount, edgeCount, err := normalizePlaygroundCanvasDocument(request.Document)
		if err != nil {
			writePlaygroundCanvasError(c, err)
			return
		}
		if err := model.ValidatePlaygroundCanvasReferences(c.GetInt("id"), playgroundCanvasReferences(request.Document)); err != nil {
			writePlaygroundCanvasError(c, err)
			return
		}
		input.Document = &document
		input.NodeCount = nodeCount
		input.EdgeCount = edgeCount
	}
	if input.Document == nil && input.Title == nil {
		writePlaygroundCanvasError(c, model.ErrPlaygroundCanvasInvalid)
		return
	}
	project, err := model.UpdatePlaygroundCanvasProject(c.GetInt("id"), c.Param("canvasId"), *request.Revision, input)
	if err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	common.ApiSuccess(c, playgroundDecodeCanvasProject(project, false))
}

func DeletePlaygroundCanvasProject(c *gin.Context) {
	if err := model.DeletePlaygroundCanvasProject(c.GetInt("id"), c.Param("canvasId")); err != nil {
		writePlaygroundCanvasError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"id": c.Param("canvasId")})
}
