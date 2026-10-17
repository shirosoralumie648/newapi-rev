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
	"github.com/QuantumNous/new-api/setting/playground_setting"
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
	canvasPolicy := playground_setting.GetPlaygroundQuotaPolicy("default")
	tooManyNodes := make([]any, 0, canvasPolicy.CanvasMaxNodes+1)
	for index := range canvasPolicy.CanvasMaxNodes + 1 {
		tooManyNodes = append(tooManyNodes, canvasNode(fmt.Sprintf("n%d", index), "text", 0, 0))
	}
	reject("too many nodes", withDocument(canvasDocument(tooManyNodes, nil)), http.StatusUnprocessableEntity)
	fullEdges := make([]any, 0, canvasPolicy.CanvasMaxEdges+1)
	for index := range canvasPolicy.CanvasMaxEdges + 1 {
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

	// A message key without a session is structurally invalid.
	assert.Equal(t, http.StatusBadRequest, create(7, []any{canvasRefNode("n1", "message", map[string]any{"messageKey": "m1"})}).Code)

	// References whose resource no longer exists are accepted for the owner so
	// the board stays editable; the read path reports them as "source deleted".
	detached := create(7, []any{
		canvasRefNode("d1", "message", map[string]any{"sessionId": "pgs_missing"}),
		canvasRefNode("d2", "message", map[string]any{"sessionId": sessionID, "messageKey": "missing"}),
		canvasRefNode("d3", "attachment", map[string]any{"sessionId": sessionID, "attachmentId": "pgf_missing"}),
		canvasRefNode("d4", "artifact", map[string]any{"sessionId": artifactSession, "artifactId": "pga_missing"}),
	})
	require.Equal(t, http.StatusOK, detached.Code, detached.Body.String())
	detachedID := canvasEnvelope(t, detached.Body.Bytes())["id"].(string)
	detail := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases/"+detachedID, nil, controller.GetPlaygroundCanvasProject)
	var detailEnvelope struct {
		Success bool
		Data    struct {
			UnavailableNodeIDs []string `json:"unavailable_node_ids"`
		}
	}
	require.NoError(t, common.Unmarshal(detail.Body.Bytes(), &detailEnvelope))
	require.True(t, detailEnvelope.Success, detail.Body.String())
	assert.ElementsMatch(t, []string{"d1", "d2", "d3", "d4"}, detailEnvelope.Data.UnavailableNodeIDs)

	// The same validation runs on update, so an existing canvas cannot be
	// edited into a reference owned by another account.
	foreignSession := createPlayground(t, 8, "canvas-refs-foreign")["id"].(string)
	update := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+id, map[string]any{
		"revision": 0, "document": canvasDocument([]any{canvasRefNode("n1", "message", map[string]any{"sessionId": foreignSession})}, nil),
	}, controller.UpdatePlaygroundCanvasProject)
	assert.Equal(t, http.StatusBadRequest, update.Code, update.Body.String())
}

// A canvas node can reference one async generation task the account owns. The
// task row is the ownership record; the artifact key is a display-only
// selector, and the bytes stay behind the owner-scoped task artifact
// endpoints.
func TestPlaygroundCanvasTaskReferences(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	require.NoError(t, db.Create(&model.Task{
		TaskID: "pg-canvas-task-owner", Platform: "sunoapi", UserId: 7,
		Status: model.TaskStatusSuccess, SubmitTime: 10,
	}).Error)
	require.NoError(t, db.Create(&model.Task{
		TaskID: "pg-canvas-task-other", Platform: "sunoapi", UserId: 8,
		Status: model.TaskStatusSuccess, SubmitTime: 11,
	}).Error)

	create := func(user int, nodes []any) *httptest.ResponseRecorder {
		return playgroundRequest(t, user, http.MethodPost, "/api/playground/canvases", map[string]any{
			"title": "Task refs", "document": canvasDocument(nodes, nil),
		}, controller.CreatePlaygroundCanvasProject)
	}

	// The owner may reference the task with or without one artifact key.
	owner := create(7, []any{
		canvasRefNode("n1", "task-result", map[string]any{"taskId": "pg-canvas-task-owner", "taskArtifactKey": "video"}),
		canvasRefNode("n2", "task", map[string]any{"taskId": "pg-canvas-task-owner"}),
	})
	require.Equal(t, http.StatusOK, owner.Code, owner.Body.String())

	// Another account referencing the task is rejected on save.
	foreign := create(8, []any{canvasRefNode("n1", "task-result", map[string]any{"taskId": "pg-canvas-task-owner"})})
	assert.Equal(t, http.StatusBadRequest, foreign.Code, foreign.Body.String())

	// An artifact key without its task is structurally invalid.
	assert.Equal(t, http.StatusBadRequest, create(7, []any{
		canvasRefNode("n1", "task-result", map[string]any{"taskArtifactKey": "video"}),
	}).Code)

	// A deleted task is accepted so the board stays editable and is reported
	// as an unavailable source on read.
	detached := create(7, []any{canvasRefNode("d1", "task-result", map[string]any{"taskId": "pg-canvas-task-missing"})})
	require.Equal(t, http.StatusOK, detached.Code, detached.Body.String())
	detachedID := canvasEnvelope(t, detached.Body.Bytes())["id"].(string)
	detail := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases/"+detachedID, nil, controller.GetPlaygroundCanvasProject)
	var detailEnvelope struct {
		Success bool
		Data    struct {
			UnavailableNodeIDs []string `json:"unavailable_node_ids"`
		}
	}
	require.NoError(t, common.Unmarshal(detail.Body.Bytes(), &detailEnvelope))
	require.True(t, detailEnvelope.Success, detail.Body.String())
	assert.ElementsMatch(t, []string{"d1"}, detailEnvelope.Data.UnavailableNodeIDs)
}

func TestPlaygroundCanvasLimits(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
		policy.CanvasUserMaxProjects, policy.CanvasUserMaxBytes = 2, 4096
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

// A canvas node that references an attachment pins the bytes: removing the
// message that uploaded it must not let orphan cleanup collect the image, and
// deleting the canvas must release it again.
func TestPlaygroundCanvasAttachmentPins(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	session := createPlayground(t, 7, "canvas-pins")
	sessionID := session["id"].(string)
	attachment := playgroundUploadAttachment(t, 7, sessionID, "pin-a", "image/png", playgroundPNGFixture(64))
	attachmentID := attachment["id"].(string)
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+sessionID+"/messages", map[string]any{
		"revision": 0, "messages": []any{map[string]any{"client_key": "m1", "payload": map[string]any{
			"key": "m1", "from": "user", "versions": []any{map[string]any{"id": "v1", "content": "see image", "attachments": []any{map[string]any{"id": attachmentID}}}},
		}}},
	}, controller.ReplacePlaygroundMessages).Code)

	created := canvasEnvelope(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
		"title": "Pins",
		"document": canvasDocument([]any{
			canvasRefNode("a1", "attachment", map[string]any{"sessionId": sessionID, "attachmentId": attachmentID}),
		}, nil),
	}, controller.CreatePlaygroundCanvasProject).Body.Bytes())
	canvasID := created["id"].(string)
	var pins int64
	require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", canvasID).Count(&pins).Error)
	assert.EqualValues(t, 1, pins)

	// Dropping the message reference clears referenced_at, but the canvas pin
	// still protects the bytes from the orphan cleanup.
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, "/api/playground/sessions/"+sessionID+"/messages", map[string]any{
		"revision": 1, "messages": []any{},
	}, controller.ReplacePlaygroundMessages).Code)
	now := common.GetTimestamp()
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", attachmentID).Update("updated_at", now-100000).Error)
	deleted, err := model.DeleteOrphanedPlaygroundAttachments(now-3600, 100)
	require.NoError(t, err)
	assert.Zero(t, deleted)
	_, err = model.GetPlaygroundAttachment(7, sessionID, attachmentID)
	require.NoError(t, err)

	// A pinned attachment cannot be deleted directly.
	inUse := playgroundRequest(t, 7, http.MethodDelete, "/api/playground/sessions/"+sessionID+"/attachments/"+attachmentID, nil, controller.DeletePlaygroundAttachment)
	assert.Equal(t, http.StatusConflict, inUse.Code, inUse.Body.String())

	// Deleting the canvas releases the pin, after which the cleanup collects it.
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/canvases/"+canvasID, nil, controller.DeletePlaygroundCanvasProject).Code)
	require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", canvasID).Count(&pins).Error)
	assert.Zero(t, pins)
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", attachmentID).Update("updated_at", now-100000).Error)
	deleted, err = model.DeleteOrphanedPlaygroundAttachments(now-3600, 100)
	require.NoError(t, err)
	assert.EqualValues(t, 1, deleted)
}

// Saving a document that no longer references an attachment releases its pin,
// so the bytes return to the orphan cleanup countdown.
func TestPlaygroundCanvasAttachmentDereference(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	session := createPlayground(t, 7, "canvas-deref")
	sessionID := session["id"].(string)
	attachment := playgroundUploadAttachment(t, 7, sessionID, "deref-a", "image/png", playgroundPNGFixture(64))
	attachmentID := attachment["id"].(string)
	created := canvasEnvelope(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
		"title": "Deref",
		"document": canvasDocument([]any{
			canvasRefNode("a1", "attachment", map[string]any{"sessionId": sessionID, "attachmentId": attachmentID}),
		}, nil),
	}, controller.CreatePlaygroundCanvasProject).Body.Bytes())
	canvasID := created["id"].(string)
	var pins int64
	require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", canvasID).Count(&pins).Error)
	require.EqualValues(t, 1, pins)

	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+canvasID, map[string]any{
		"revision": 0, "document": canvasDocument(nil, nil),
	}, controller.UpdatePlaygroundCanvasProject).Code)
	pins = 0
	require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", canvasID).Count(&pins).Error)
	assert.Zero(t, pins)

	now := common.GetTimestamp()
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", attachmentID).Update("updated_at", now-100000).Error)
	deleted, err := model.DeleteOrphanedPlaygroundAttachments(now-3600, 100)
	require.NoError(t, err)
	assert.EqualValues(t, 1, deleted)
}

// Deleting a conversation still cascades into its attachments and pins, and the
// canvas reports the now-missing source instead of silently losing the node.
func TestPlaygroundCanvasSessionCascade(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	session := createPlayground(t, 7, "canvas-cascade")
	sessionID := session["id"].(string)
	attachment := playgroundUploadAttachment(t, 7, sessionID, "cascade-a", "image/png", playgroundPNGFixture(64))
	attachmentID := attachment["id"].(string)
	created := canvasEnvelope(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
		"title": "Cascade",
		"document": canvasDocument([]any{
			canvasRefNode("a1", "attachment", map[string]any{"sessionId": sessionID, "attachmentId": attachmentID}),
		}, nil),
	}, controller.CreatePlaygroundCanvasProject).Body.Bytes())
	canvasID := created["id"].(string)

	require.NoError(t, model.DeletePlaygroundSession(7, sessionID))
	var attachments, pins int64
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("session_id = ?", sessionID).Count(&attachments).Error)
	assert.Zero(t, attachments)
	require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", canvasID).Count(&pins).Error)
	assert.Zero(t, pins)

	detail := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases/"+canvasID, nil, controller.GetPlaygroundCanvasProject)
	var envelope struct {
		Success bool
		Data    struct {
			UnavailableNodeIDs []string `json:"unavailable_node_ids"`
		}
	}
	require.NoError(t, common.Unmarshal(detail.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, detail.Body.String())
	assert.Equal(t, []string{"a1"}, envelope.Data.UnavailableNodeIDs)

	// Nothing is left for the orphan cleanup, and another account cannot read
	// the board.
	deleted, err := model.DeleteOrphanedPlaygroundAttachments(common.GetTimestamp(), 100)
	require.NoError(t, err)
	assert.Zero(t, deleted)
	assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodGet, "/api/playground/canvases/"+canvasID, nil, controller.GetPlaygroundCanvasProject).Code)
}

// Deleting the referenced message marks its node as "source deleted" while the
// stored snapshot keeps the node visible and the board editable.
func TestPlaygroundCanvasReferenceSourceDeleted(t *testing.T) {
	playgroundTestDB(t, "sqlite")
	session := createPlayground(t, 7, "canvas-source-deleted")
	sessionID := session["id"].(string)
	messagePath := "/api/playground/sessions/" + sessionID + "/messages"
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, messagePath, map[string]any{
		"revision": 0, "messages": []any{map[string]any{"client_key": "m1", "payload": map[string]any{
			"key": "m1", "from": "assistant", "status": "complete",
			"versions": []any{map[string]any{"id": "v1", "content": "snapshot text"}},
		}}},
	}, controller.ReplacePlaygroundMessages).Code)

	created := canvasEnvelope(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
		"title": "Deleted source",
		"document": canvasDocument([]any{
			canvasRefNode("m1", "message", map[string]any{"sessionId": sessionID, "messageKey": "m1"}),
		}, nil),
	}, controller.CreatePlaygroundCanvasProject).Body.Bytes())
	canvasID := created["id"].(string)
	var revision int64
	unavailable := func() []string {
		detail := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases/"+canvasID, nil, controller.GetPlaygroundCanvasProject)
		var envelope struct {
			Data struct {
				UnavailableNodeIDs []string `json:"unavailable_node_ids"`
				Revision           int64    `json:"revision"`
			}
		}
		require.NoError(t, common.Unmarshal(detail.Body.Bytes(), &envelope))
		revision = envelope.Data.Revision
		return envelope.Data.UnavailableNodeIDs
	}
	assert.Empty(t, unavailable())

	// The message disappears, so the node's source is now deleted.
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPut, messagePath, map[string]any{
		"revision": 1, "messages": []any{},
	}, controller.ReplacePlaygroundMessages).Code)
	assert.Equal(t, []string{"m1"}, unavailable())

	// The dangling reference does not block an unrelated edit: the node keeps
	// its snapshot and the document stays saveable.
	updated := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+canvasID, map[string]any{
		"revision": revision,
		"document": canvasDocument([]any{map[string]any{
			"id": "m1", "type": "message", "position": map[string]any{"x": 120, "y": 40},
			"data": map[string]any{"kind": "message", "text": "snapshot text", "snapshot": map[string]any{
				"sessionId": sessionID, "messageKey": "m1", "role": "assistant", "text": "snapshot text",
			}, "ref": map[string]any{"sessionId": sessionID, "messageKey": "m1"}},
		}}, nil),
	}, controller.UpdatePlaygroundCanvasProject)
	require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
	assert.Contains(t, updated.Body.String(), "snapshot text")
}
