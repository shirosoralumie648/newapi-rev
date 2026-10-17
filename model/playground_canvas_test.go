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
package model_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func canvasNode(id, nodeType string, x, y float64) map[string]any {
	return map[string]any{"id": id, "type": nodeType, "position": map[string]any{"x": x, "y": y}}
}

func canvasRefNode(id, nodeType string, ref map[string]any) map[string]any {
	return map[string]any{
		"id": id, "type": nodeType, "position": map[string]any{"x": 0, "y": 0},
		"data": map[string]any{"kind": nodeType, "ref": ref},
	}
}

func canvasDocument(nodes, edges []any) map[string]any {
	if nodes == nil {
		nodes = []any{}
	}
	if edges == nil {
		edges = []any{}
	}
	return map[string]any{
		"viewport": map[string]any{"x": 1.5, "y": -2, "zoom": 1.25},
		"nodes":    nodes,
		"edges":    edges,
	}
}

func createCanvasProject(t *testing.T, user int, clientID string) map[string]any {
	t.Helper()
	response := playgroundRequest(t, user, http.MethodPost, "/api/playground/canvases", map[string]any{
		"client_id": clientID,
		"title":     "Board",
		"document": canvasDocument(
			[]any{canvasNode("n1", "prompt", 10, 20), canvasNode("n2", "text", 40, 60)},
			[]any{map[string]any{"id": "e1", "source": "n1", "target": "n2"}},
		),
	}, controller.CreatePlaygroundCanvasProject)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var envelope struct {
		Success bool
		Data    map[string]any
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, response.Body.String())
	return envelope.Data
}

func canvasEnvelope(t *testing.T, response []byte) map[string]any {
	t.Helper()
	var envelope struct {
		Success bool
		Data    map[string]any
	}
	require.NoError(t, common.Unmarshal(response, &envelope))
	require.True(t, envelope.Success, string(response))
	return envelope.Data
}

func TestPlaygroundCanvasPersistenceMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			playgroundTestDB(t, dialect)
			created := createCanvasProject(t, 7, "canvas-local")
			id, _ := created["id"].(string)
			require.True(t, strings.HasPrefix(id, "pgc_"))
			assert.Equal(t, true, created["created"])
			assert.EqualValues(t, 0, created["revision"])
			assert.EqualValues(t, 2, created["node_count"])
			assert.EqualValues(t, 1, created["edge_count"])
			assert.Equal(t, "Board", created["title"])

			// The stored document round-trips through the detail endpoint.
			detail := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases/"+id, nil, controller.GetPlaygroundCanvasProject)
			document := canvasEnvelope(t, detail.Body.Bytes())["document"].(map[string]any)
			assert.EqualValues(t, 1.25, document["viewport"].(map[string]any)["zoom"])
			assert.Len(t, document["nodes"].([]any), 2)
			assert.Len(t, document["edges"].([]any), 1)

			// The create key is idempotent: a replay returns the stored project
			// even when the retry body differs, because the client already owns
			// a project under that key.
			replay := playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
				"client_id": "canvas-local", "title": "Changed",
				"document": canvasDocument([]any{canvasNode("x", "text", 0, 0)}, nil),
			}, controller.CreatePlaygroundCanvasProject)
			replayed := canvasEnvelope(t, replay.Body.Bytes())
			assert.Equal(t, id, replayed["id"])
			assert.NotEqual(t, true, replayed["created"])
			assert.Equal(t, "Board", replayed["title"])

			// Summaries keep the document out of list responses.
			listed := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases?page_size=50", nil, controller.ListPlaygroundCanvasProjects)
			var listing struct {
				Data struct {
					Items []map[string]any
					Total int
				}
			}
			require.NoError(t, common.Unmarshal(listed.Body.Bytes(), &listing))
			require.Equal(t, 1, listing.Data.Total)
			require.Len(t, listing.Data.Items, 1)
			assert.EqualValues(t, 2, listing.Data.Items[0]["node_count"])
			assert.NotContains(t, listing.Data.Items[0], "document")
			other := playgroundRequest(t, 8, http.MethodGet, "/api/playground/canvases?page_size=50", nil, controller.ListPlaygroundCanvasProjects)
			var foreignListing struct {
				Data struct{ Total int }
			}
			require.NoError(t, common.Unmarshal(other.Body.Bytes(), &foreignListing))
			assert.Zero(t, foreignListing.Data.Total)

			// Revision CAS: the first write advances, then a stale write conflicts.
			updated := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+id, map[string]any{
				"revision": 0, "title": "Renamed",
				"document": canvasDocument(
					[]any{canvasNode("n1", "prompt", 1, 2), canvasNode("n2", "artifact", 3, 4), canvasNode("n3", "image", 5, 6)},
					[]any{map[string]any{"id": "e1", "source": "n1", "target": "n2"}},
				),
			}, controller.UpdatePlaygroundCanvasProject)
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			updatedData := canvasEnvelope(t, updated.Body.Bytes())
			assert.EqualValues(t, 1, updatedData["revision"])
			assert.EqualValues(t, 3, updatedData["node_count"])
			assert.Equal(t, "Renamed", updatedData["title"])
			stale := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+id, map[string]any{
				"revision": 0, "title": "Stale", "document": canvasDocument(nil, nil),
			}, controller.UpdatePlaygroundCanvasProject)
			assert.Equal(t, http.StatusConflict, stale.Code, stale.Body.String())
			titleOnly := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+id, map[string]any{
				"revision": 1, "title": "Title only",
			}, controller.UpdatePlaygroundCanvasProject)
			require.Equal(t, http.StatusOK, titleOnly.Code, titleOnly.Body.String())
			titleData := canvasEnvelope(t, titleOnly.Body.Bytes())
			assert.EqualValues(t, 2, titleData["revision"])
			assert.EqualValues(t, 3, titleData["node_count"])

			// Cross-user access is a 404; the owner can delete once.
			foreign := playgroundRequest(t, 8, http.MethodGet, "/api/playground/canvases/"+id, nil, controller.GetPlaygroundCanvasProject)
			assert.Equal(t, http.StatusNotFound, foreign.Code)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/canvases/"+id, nil, controller.DeletePlaygroundCanvasProject).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases/"+id, nil, controller.GetPlaygroundCanvasProject).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/canvases/"+id, nil, controller.DeletePlaygroundCanvasProject).Code)
		})
	}
}

func TestPlaygroundCanvasDocumentValidation(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	path := "/api/playground/canvases"
	create := func(body map[string]any) *httptest.ResponseRecorder {
		return playgroundRequest(t, 7, http.MethodPost, path, body, controller.CreatePlaygroundCanvasProject)
	}
	reject := func(name string, body map[string]any, status int) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			response := create(body)
			assert.Equal(t, status, response.Code, response.Body.String())
		})
	}
	withDocument := func(document map[string]any) map[string]any {
		return map[string]any{"title": "Board", "document": document}
	}

	reject("missing document", map[string]any{"title": "Board"}, http.StatusBadRequest)
	reject("unknown node type", withDocument(canvasDocument([]any{canvasNode("n1", "video", 0, 0)}, nil)), http.StatusBadRequest)
	reject("duplicate node id", withDocument(canvasDocument([]any{canvasNode("n1", "text", 0, 0), canvasNode("n1", "text", 1, 1)}, nil)), http.StatusBadRequest)
	reject("dangling edge", withDocument(canvasDocument(
		[]any{canvasNode("n1", "text", 0, 0)},
		[]any{map[string]any{"id": "e1", "source": "n1", "target": "missing"}},
	)), http.StatusBadRequest)
	reject("viewport zoom out of range", withDocument(map[string]any{
		"viewport": map[string]any{"x": 0, "y": 0, "zoom": 0.01},
		"nodes":    []any{}, "edges": []any{},
	}), http.StatusBadRequest)
	reject("oversized node data", withDocument(canvasDocument(
		[]any{map[string]any{"id": "n1", "type": "text", "position": map[string]any{"x": 0, "y": 0},
			"data": map[string]any{"blob": strings.Repeat("x", (65 << 10))}}},
		nil,
	)), http.StatusUnprocessableEntity)
	tooManyNodes := make([]any, 0, model.PlaygroundCanvasMaxNodes+1)
	for index := range model.PlaygroundCanvasMaxNodes + 1 {
		tooManyNodes = append(tooManyNodes, canvasNode(fmt.Sprintf("n%d", index), "text", 0, 0))
	}
	reject("too many nodes", withDocument(canvasDocument(tooManyNodes, nil)), http.StatusUnprocessableEntity)
	fullEdges := make([]any, 0, model.PlaygroundCanvasMaxEdges+1)
	for index := range model.PlaygroundCanvasMaxEdges + 1 {
		fullEdges = append(fullEdges, map[string]any{"id": fmt.Sprintf("e%d", index), "source": "n1", "target": "n2"})
	}
	reject("too many edges", withDocument(canvasDocument(
		[]any{canvasNode("n1", "text", 0, 0), canvasNode("n2", "text", 1, 1)}, fullEdges,
	)), http.StatusUnprocessableEntity)
	bloated := make([]any, 0, 17)
	for index := range 17 {
		bloated = append(bloated, map[string]any{
			"id": fmt.Sprintf("n%d", index), "type": "text", "position": map[string]any{"x": 0, "y": 0},
			"data": map[string]any{"blob": strings.Repeat("x", 64<<10)},
		})
	}
	reject("document over the size budget", withDocument(canvasDocument(bloated, nil)), http.StatusUnprocessableEntity)
	reject("title too long", map[string]any{"title": strings.Repeat("a", 201), "document": canvasDocument(nil, nil)}, http.StatusBadRequest)

	// A minimal empty document is valid and patch requires a revision.
	created := canvasEnvelope(t, create(withDocument(canvasDocument(nil, nil))).Body.Bytes())
	id := created["id"].(string)
	missingRevision := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+id, map[string]any{"title": "Next"}, controller.UpdatePlaygroundCanvasProject)
	assert.Equal(t, http.StatusBadRequest, missingRevision.Code)
	emptyPatch := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+id, map[string]any{"revision": 0}, controller.UpdatePlaygroundCanvasProject)
	assert.Equal(t, http.StatusBadRequest, emptyPatch.Code)
}

// Canvas nodes may reference a session, message, attachment or artifact, but
// only when every referenced row belongs to the saving account. The stored
// document keeps references; it never becomes an ownership proof.
func TestPlaygroundCanvasReferenceOwnership(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	session := createPlayground(t, 7, "canvas-refs")
	sessionID := session["id"].(string)
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+sessionID+"/messages", map[string]any{
		"revision": 0, "messages": []any{map[string]any{"client_key": "m1", "payload": map[string]any{
			"key": "m1", "from": "user", "status": "complete",
			"versions": []any{map[string]any{"id": "v1", "content": "hello canvas"}},
		}}},
	}, controller.ReplacePlaygroundMessages).Code)
	attachment := playgroundUploadAttachment(t, 7, sessionID, "canvas-att", "image/png", playgroundPNGFixture(64))
	attachmentID := attachment["id"].(string)
	artifactSession, artifactInput := playgroundArtifactSourceFixture(t, 7, "canvas-ref-artifact")
	artifact := artifactResult(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/sessions/"+artifactSession+"/artifacts", artifactInput, controller.CreatePlaygroundArtifact))

	create := func(user int, nodes []any) *httptest.ResponseRecorder {
		return playgroundRequest(t, user, http.MethodPost, "/api/playground/canvases", map[string]any{
			"title": "Refs", "document": canvasDocument(nodes, nil),
		}, controller.CreatePlaygroundCanvasProject)
	}

	// The owner can reference all four resource kinds, including a node that
	// points at the artifact's session.
	owner := create(7, []any{
		canvasRefNode("n1", "message", map[string]any{"sessionId": sessionID, "messageKey": "m1"}),
		canvasRefNode("n2", "attachment", map[string]any{"sessionId": sessionID, "attachmentId": attachmentID}),
		canvasRefNode("n3", "artifact", map[string]any{"sessionId": artifactSession, "artifactId": artifact.Artifact.ID}),
		canvasRefNode("n4", "message", map[string]any{"sessionId": sessionID}),
	})
	require.Equal(t, http.StatusOK, owner.Code, owner.Body.String())
	id := canvasEnvelope(t, owner.Body.Bytes())["id"].(string)

	// Another account referencing the same resources is rejected on save.
	for index, ref := range []map[string]any{
		{"sessionId": sessionID},
		{"sessionId": sessionID, "messageKey": "m1"},
		{"sessionId": sessionID, "attachmentId": attachmentID},
		{"sessionId": artifactSession, "artifactId": artifact.Artifact.ID},
	} {
		response := create(8, []any{canvasRefNode("n1", "message", ref)})
		assert.Equal(t, http.StatusBadRequest, response.Code, "ref %d: %s", index, response.Body.String())
	}

	// Unknown ids, a message key without a session, and a mismatched session
	// are rejected for the owner too.
	for index, ref := range []map[string]any{
		{"sessionId": "pgs_missing"},
		{"messageKey": "m1"},
		{"sessionId": sessionID, "messageKey": "missing"},
		{"sessionId": sessionID, "attachmentId": "pgf_missing"},
		{"sessionId": "pgs_other", "artifactId": artifact.Artifact.ID},
	} {
		response := create(7, []any{canvasRefNode("n1", "message", ref)})
		assert.Equal(t, http.StatusBadRequest, response.Code, "ref %d: %s", index, response.Body.String())
	}

	// The same validation runs on update, so an existing canvas cannot be
	// edited into a reference owned by another account.
	foreignSession := createPlayground(t, 8, "canvas-refs-foreign")["id"].(string)
	update := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+id, map[string]any{
		"revision": 0, "document": canvasDocument([]any{canvasRefNode("n1", "message", map[string]any{"sessionId": foreignSession})}, nil),
	}, controller.UpdatePlaygroundCanvasProject)
	assert.Equal(t, http.StatusBadRequest, update.Code, update.Body.String())
}

func TestPlaygroundCanvasLimits(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	previousProjects, previousBytes := model.PlaygroundCanvasMaxProjects, model.PlaygroundCanvasUserMaxBytes
	model.PlaygroundCanvasMaxProjects, model.PlaygroundCanvasUserMaxBytes = 2, 4096
	t.Cleanup(func() {
		model.PlaygroundCanvasMaxProjects, model.PlaygroundCanvasUserMaxBytes = previousProjects, previousBytes
	})

	// Both the project count and the byte budget reject the next create.
	first := createCanvasProject(t, 7, "limit-a")
	second := createCanvasProject(t, 7, "limit-b")
	third := playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
		"title": "Third", "document": canvasDocument(nil, nil),
	}, controller.CreatePlaygroundCanvasProject)
	assert.Equal(t, http.StatusUnprocessableEntity, third.Code, third.Body.String())
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/canvases/"+first["id"].(string), nil, controller.DeletePlaygroundCanvasProject).Code)
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
		"title": "Third", "document": canvasDocument(nil, nil),
	}, controller.CreatePlaygroundCanvasProject).Code)

	// The byte budget counts every stored document and is re-checked on update.
	secondID := second["id"].(string)
	bloated := func(size int) map[string]any {
		return canvasDocument([]any{map[string]any{
			"id": "n1", "type": "text", "position": map[string]any{"x": 0, "y": 0},
			"data": map[string]any{"blob": strings.Repeat("x", size)},
		}}, nil)
	}
	tooBig := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+secondID, map[string]any{
		"revision": 0, "document": bloated(4096),
	}, controller.UpdatePlaygroundCanvasProject)
	assert.Equal(t, http.StatusUnprocessableEntity, tooBig.Code, tooBig.Body.String())
	shrunk := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+secondID, map[string]any{
		"revision": 0, "document": bloated(100),
	}, controller.UpdatePlaygroundCanvasProject)
	require.Equal(t, http.StatusOK, shrunk.Code, shrunk.Body.String())
	doubleUpdate := playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
		"title": "Spare", "document": bloated(2000),
	}, controller.CreatePlaygroundCanvasProject)
	assert.Equal(t, http.StatusUnprocessableEntity, doubleUpdate.Code, doubleUpdate.Body.String())
}
