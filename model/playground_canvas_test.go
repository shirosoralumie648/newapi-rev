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
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service/objectstore"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
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
	reject("unknown node type", withDocument(canvasDocument([]any{canvasNode("n1", "script", 0, 0)}, nil)), http.StatusBadRequest)
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
	// The deleted board stays in the trash, where it keeps its slot, and only
	// the purge that follows the retention window releases it.
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/canvases/"+first["id"].(string), nil, controller.DeletePlaygroundCanvasProject).Code)
	third = playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
		"title": "Third", "document": canvasDocument(nil, nil),
	}, controller.CreatePlaygroundCanvasProject)
	assert.Equal(t, http.StatusUnprocessableEntity, third.Code, third.Body.String())
	require.NoError(t, model.PurgePlaygroundCanvasProject(7, first["id"].(string)))
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

	// The deleted canvas stays in the trash with its pin intact, so the bytes
	// stay protected until the purge releases the pin and the cleanup collects it.
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/canvases/"+canvasID, nil, controller.DeletePlaygroundCanvasProject).Code)
	require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", canvasID).Count(&pins).Error)
	assert.EqualValues(t, 1, pins)
	require.NoError(t, model.PurgePlaygroundCanvasProject(7, canvasID))
	require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", canvasID).Count(&pins).Error)
	assert.Zero(t, pins)
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", attachmentID).Update("updated_at", now-100000).Error)
	deleted, err = model.DeleteOrphanedPlaygroundAttachments(now-3600, 100)
	require.NoError(t, err)
	assert.EqualValues(t, 1, deleted)
}

func playgroundUploadCanvasAttachment(t *testing.T, user int, canvasID, clientKey, mediaType string, data []byte) map[string]any {
	t.Helper()
	response := playgroundRequest(t, user, http.MethodPost, "/api/playground/canvases/"+canvasID+"/attachments", map[string]any{
		"client_key": clientKey, "media_type": mediaType, "filename": "dropped.png",
		"data": base64.StdEncoding.EncodeToString(data),
	}, controller.CreatePlaygroundCanvasAttachment)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	return canvasEnvelope(t, response.Body.Bytes())
}

// A file dropped on the canvas is uploaded into the canvas' own attachment
// partition: the project row is locked and checked for the account before the
// bytes are stored, and the saved document pins the attachment so its bytes
// outlive the upload. The content route resolves a row by owner and partition,
// so a canvas attachment needs no second read route.
func TestPlaygroundCanvasAttachmentUpload(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			canvasID := createCanvasProject(t, 7, "canvas-drop")["id"].(string)
			png := playgroundPNGFixture(64)
			uploaded := playgroundUploadCanvasAttachment(t, 7, canvasID, "drop-1", "image/png", png)
			attachmentID, _ := uploaded["id"].(string)
			require.NotEmpty(t, attachmentID)
			assert.True(t, strings.HasPrefix(attachmentID, "pgf_"))
			assert.Equal(t, canvasID, uploaded["session_id"])
			assert.Equal(t, true, uploaded["created"])

			var stored model.PlaygroundAttachment
			require.NoError(t, db.Where("id = ?", attachmentID).First(&stored).Error)
			assert.Equal(t, canvasID, stored.SessionID)
			assert.Nil(t, stored.Data)
			objectStore := objectstore.DefaultStore()
			require.NotNil(t, objectStore)
			objectReader, _, objectErr := objectStore.Get(context.Background(), stored.ObjectKey)
			require.NoError(t, objectErr)
			objectBytes, objectErr := io.ReadAll(objectReader)
			require.NoError(t, objectErr)
			require.NoError(t, objectReader.Close())
			assert.Equal(t, png, objectBytes)

			// The client key is an idempotency key for a canvas upload too.
			replay := playgroundUploadCanvasAttachment(t, 7, canvasID, "drop-1", "image/png", png)
			assert.Equal(t, attachmentID, replay["id"])
			assert.NotEqual(t, true, replay["created"])

			// Content is served byte-exact through the shared partition route.
			content := playgroundRequest(t, 7, http.MethodGet, "/api/playground/sessions/"+canvasID+"/attachments/"+attachmentID+"/content", nil, controller.GetPlaygroundAttachmentContent)
			require.Equal(t, http.StatusOK, content.Code, content.Body.String())
			assert.Equal(t, png, content.Body.Bytes())

			// A foreign or unknown canvas is rejected before anything is written.
			for _, foreign := range []struct {
				user  int
				param string
			}{{8, canvasID}, {7, "pgc_missing"}} {
				response := playgroundRequest(t, foreign.user, http.MethodPost, "/api/playground/canvases/"+foreign.param+"/attachments", map[string]any{
					"client_key": "drop-foreign", "media_type": "image/png",
					"data": base64.StdEncoding.EncodeToString(png),
				}, controller.CreatePlaygroundCanvasAttachment)
				assert.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
			}
			var foreignRows int64
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("user_id = ?", 8).Count(&foreignRows).Error)
			assert.Zero(t, foreignRows)

			// The saved document pins the attachment; the cleanup task leaves a
			// pinned attachment alone, and the bytes return to the orphan
			// countdown once the project is deleted.
			created := canvasEnvelope(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
				"title": "Dropped",
				"document": canvasDocument([]any{
					canvasRefNode("a1", "attachment", map[string]any{"sessionId": canvasID, "attachmentId": attachmentID}),
				}, nil),
			}, controller.CreatePlaygroundCanvasProject).Body.Bytes())
			boardID := created["id"].(string)
			var pins int64
			require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", boardID).Count(&pins).Error)
			assert.EqualValues(t, 1, pins)
			now := common.GetTimestamp()
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", attachmentID).Update("updated_at", now-100000).Error)
			deleted, err := model.DeleteOrphanedPlaygroundAttachments(now-3600, 100)
			require.NoError(t, err)
			assert.Zero(t, deleted)

			// Another account can neither upload into the partition nor
			// reference the attachment from its own board.
			cross := playgroundRequest(t, 8, http.MethodPost, "/api/playground/canvases", map[string]any{
				"title": "Foreign",
				"document": canvasDocument([]any{
					canvasRefNode("a1", "attachment", map[string]any{"sessionId": canvasID, "attachmentId": attachmentID}),
				}, nil),
			}, controller.CreatePlaygroundCanvasProject)
			assert.Equal(t, http.StatusBadRequest, cross.Code, cross.Body.String())

			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/canvases/"+boardID, nil, controller.DeletePlaygroundCanvasProject).Code)
			// The trashed board keeps pinning the bytes; purging it returns the
			// attachment to the orphan countdown.
			require.NoError(t, model.PurgePlaygroundCanvasProject(7, boardID))
			require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("id = ?", attachmentID).Update("updated_at", now-100000).Error)
			deleted, err = model.DeleteOrphanedPlaygroundAttachments(now-3600, 100)
			require.NoError(t, err)
			assert.EqualValues(t, 1, deleted)
		})
	}
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

	// The deleted conversation moves to the trash: it keeps its attachments,
	// the pins that protect their bytes, and a reachable canvas node, until the
	// purge cascades.
	require.NoError(t, model.DeletePlaygroundSession(7, sessionID))
	var attachments, pins int64
	var envelope struct {
		Success bool
		Data    struct {
			UnavailableNodeIDs []string `json:"unavailable_node_ids"`
		}
	}
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("session_id = ?", sessionID).Count(&attachments).Error)
	assert.EqualValues(t, 1, attachments)
	require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", canvasID).Count(&pins).Error)
	assert.EqualValues(t, 1, pins)
	detail := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases/"+canvasID, nil, controller.GetPlaygroundCanvasProject)
	require.NoError(t, common.Unmarshal(detail.Body.Bytes(), &envelope))
	require.True(t, envelope.Success, detail.Body.String())
	assert.Empty(t, envelope.Data.UnavailableNodeIDs)

	// The purge releases the attachments and pins, and the canvas reports the
	// now-missing source instead of silently losing the node.
	require.NoError(t, model.PurgePlaygroundSession(7, sessionID))
	require.NoError(t, db.Model(&model.PlaygroundAttachment{}).Where("session_id = ?", sessionID).Count(&attachments).Error)
	assert.Zero(t, attachments)
	require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", canvasID).Count(&pins).Error)
	assert.Zero(t, pins)
	detail = playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases/"+canvasID, nil, controller.GetPlaygroundCanvasProject)
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

// Canvas history: the first document save stores an entry, later saves only
// store one when the policy trigger or interval fires, identical states are
// never stored twice, the per-board cap prunes the oldest entry, a full
// account budget skips the new entry without failing the save, restore rewrites
// the document and captures the state it replaces, and a purge removes rows,
// objects and counters together.
func TestPlaygroundCanvasSnapshotHistory(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			var defaults *playground_setting.PlaygroundQuotaPolicy
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				defaults = policy
				policy.CanvasSnapshotEverySaves = 2
				policy.CanvasSnapshotPerCanvasMaxCount = 4
			})
			created := createCanvasProject(t, 7, "canvas-history")
			id := created["id"].(string)
			path := "/api/playground/canvases/" + id
			snapshotsPath := path + "/snapshots"

			save := func(revision int64, marker string) map[string]any {
				t.Helper()
				response := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
					"revision": revision,
					"document": canvasDocument([]any{
						canvasNode("n1", "prompt", 1, 2),
						map[string]any{"id": "n2", "type": "text", "position": map[string]any{"x": 3, "y": 4},
							"data": map[string]any{"kind": "text", "text": marker}},
					}, nil),
				}, controller.UpdatePlaygroundCanvasProject)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				return canvasEnvelope(t, response.Body.Bytes())
			}
			list := func() []map[string]any {
				t.Helper()
				response := playgroundRequest(t, 7, http.MethodGet, snapshotsPath+"?p=1&page_size=50", nil, controller.ListPlaygroundCanvasSnapshots)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				var listing struct {
					Data struct {
						Items []map[string]any `json:"items"`
						Total int              `json:"total"`
					} `json:"data"`
				}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &listing))
				require.Len(t, listing.Data.Items, listing.Data.Total)
				return listing.Data.Items
			}
			revisions := func(items []map[string]any) []int64 {
				result := make([]int64, 0, len(items))
				for _, item := range items {
					result = append(result, int64(item["revision"].(float64)))
				}
				return result
			}
			nodeText := func(project map[string]any) string {
				for _, item := range project["document"].(map[string]any)["nodes"].([]any) {
					node := item.(map[string]any)
					if node["id"] == "n2" {
						return node["data"].(map[string]any)["text"].(string)
					}
				}
				return ""
			}
			restore := func(snapshotID string, revision int64) *httptest.ResponseRecorder {
				return playgroundRequest(t, 7, http.MethodPost, snapshotsPath+"/"+snapshotID+"/restore",
					map[string]any{"revision": revision}, controller.RestorePlaygroundCanvasSnapshot)
			}

			// The create itself stores no history; the first document save does.
			assert.Empty(t, list())
			assert.EqualValues(t, 1, save(0, "alpha")["revision"])
			items := list()
			require.Len(t, items, 1)
			assert.EqualValues(t, 1, items[0]["revision"])
			assert.EqualValues(t, 2, items[0]["node_count"])
			assert.EqualValues(t, 0, items[0]["edge_count"])
			assert.Equal(t, id, items[0]["canvas_id"])
			assert.NotEmpty(t, items[0]["byte_size"])
			assert.NotZero(t, items[0]["created_at"])
			assert.NotContains(t, items[0], "content")
			assert.NotContains(t, items[0], "object_key")
			alphaSnapshotID := items[0]["id"].(string)

			// A save below the trigger stores nothing; the save whose revision
			// distance reaches the policy stores one entry.
			save(1, "beta")
			require.Equal(t, []int64{1}, revisions(list()))
			save(2, "gamma")
			items = list()
			require.Equal(t, []int64{3, 1}, revisions(items))
			gammaSnapshotID := items[0]["id"].(string)

			// An identical state is never stored twice, even when the trigger fires.
			defaults.CanvasSnapshotEverySaves = 1
			save(3, "gamma")
			require.Equal(t, []int64{3, 1}, revisions(list()))
			save(4, "delta")
			require.Equal(t, []int64{5, 3, 1}, revisions(list()))

			// A restore rewrites the document and answers with the restored
			// state; the replaced state is already the newest entry here, so
			// deduplication keeps the history at one entry per state.
			restored := restore(alphaSnapshotID, 5)
			require.Equal(t, http.StatusOK, restored.Code, restored.Body.String())
			restoredData := canvasEnvelope(t, restored.Body.Bytes())
			assert.EqualValues(t, 6, restoredData["revision"])
			assert.Equal(t, "alpha", nodeText(restoredData))
			require.Equal(t, []int64{6, 5, 3, 1}, revisions(list()))

			// A save the trigger skips leaves the live document newer than the
			// newest entry; the next restore captures that replaced state first
			// and prunes the oldest entry to honor the per-board cap.
			defaults.CanvasSnapshotEverySaves = 5
			save(6, "epsilon")
			require.Equal(t, []int64{6, 5, 3, 1}, revisions(list()))
			restored = restore(gammaSnapshotID, 7)
			require.Equal(t, http.StatusOK, restored.Code, restored.Body.String())
			restoredData = canvasEnvelope(t, restored.Body.Bytes())
			assert.EqualValues(t, 8, restoredData["revision"])
			assert.Equal(t, "gamma", nodeText(restoredData))
			items = list()
			require.Equal(t, []int64{7, 6, 5, 3}, revisions(items))

			// A stale revision conflicts; unknown, foreign and trashed-canvas
			// snapshots are 404.
			assert.Equal(t, http.StatusConflict, restore(gammaSnapshotID, 7).Code)
			assert.Equal(t, http.StatusNotFound, restore("pgs_missing", 8).Code)
			foreign := playgroundRequest(t, 8, http.MethodGet, snapshotsPath+"?p=1&page_size=50", nil, controller.ListPlaygroundCanvasSnapshots)
			assert.Equal(t, http.StatusNotFound, foreign.Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodPost, snapshotsPath+"/"+gammaSnapshotID+"/restore",
				map[string]any{"revision": 0}, controller.RestorePlaygroundCanvasSnapshot).Code)

			// A full account snapshot budget skips the new entry instead of
			// failing the save or deleting existing history.
			defaults.CanvasSnapshotEverySaves = 1
			defaults.CanvasSnapshotUserMaxCount = 4
			assert.EqualValues(t, 9, save(8, "zeta")["revision"])
			require.Equal(t, []int64{7, 6, 5, 3}, revisions(list()))

			// The account counters and the usage view agree with the stored rows.
			var measured struct {
				Count int64
				Bytes int64
			}
			require.NoError(t, db.Model(&model.PlaygroundCanvasSnapshot{}).Where("canvas_id = ?", id).
				Select("COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes").Scan(&measured).Error)
			var usage model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&usage).Error)
			assert.EqualValues(t, measured.Count, usage.CanvasSnapshotCount)
			assert.EqualValues(t, measured.Bytes, usage.CanvasSnapshotBytes)
			usageView, err := model.PlaygroundUsageForUser(7)
			require.NoError(t, err)
			assert.EqualValues(t, 4, usageView.CanvasSnapshots.Used)
			assert.EqualValues(t, measured.Bytes, usageView.CanvasSnapshots.UsedBytes)
			assert.EqualValues(t, 4, usageView.CanvasSnapshots.Limit)

			// A trashed board keeps its history; the purge removes the rows and
			// their objects, and the counters return to zero.
			rows := make([]model.PlaygroundCanvasSnapshot, 0)
			require.NoError(t, db.Where("canvas_id = ?", id).Find(&rows).Error)
			require.Len(t, rows, 4)
			require.NoError(t, model.DeletePlaygroundCanvasProject(7, id))
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodGet, snapshotsPath, nil, controller.ListPlaygroundCanvasSnapshots).Code)
			require.NoError(t, model.PurgePlaygroundCanvasProject(7, id))
			var remaining int64
			require.NoError(t, db.Model(&model.PlaygroundCanvasSnapshot{}).Where("canvas_id = ?", id).Count(&remaining).Error)
			assert.Zero(t, remaining)
			require.NoError(t, db.Where("user_id = ?", 7).First(&usage).Error)
			assert.Zero(t, usage.CanvasSnapshotCount)
			assert.Zero(t, usage.CanvasSnapshotBytes)
			assert.Zero(t, usage.CanvasCount)
			store := objectstore.DefaultStore()
			require.NotNil(t, store)
			for index := range rows {
				_, objectErr := store.Head(context.Background(), rows[index].ObjectKey)
				assert.ErrorIs(t, objectErr, objectstore.ErrObjectNotFound, rows[index].ObjectKey)
			}
		})
	}
}

// A canvas document larger than the externalization threshold moves into the
// object store as gzip bytes while the row keeps only metadata; reads hydrate
// it, a replacing save deletes the previous object, a small document returns
// to the inline column, and the account byte counter measures the logical
// document size throughout.
func TestPlaygroundCanvasLargeDocumentExternalization(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			blob := strings.Repeat("x", 40<<10)
			largeDocument := func(marker string) map[string]any {
				data := map[string]any{"kind": "text", "text": marker}
				return canvasDocument([]any{
					map[string]any{"id": "n1", "type": "text", "position": map[string]any{"x": 1, "y": 2}, "data": data},
					map[string]any{"id": "n2", "type": "text", "position": map[string]any{"x": 3, "y": 4}, "data": data},
				}, nil)
			}

			response := playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
				"client_id": "canvas-externalized", "title": "Big", "document": largeDocument(blob),
			}, controller.CreatePlaygroundCanvasProject)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			created := canvasEnvelope(t, response.Body.Bytes())
			id := created["id"].(string)
			documentBytes := int64(created["document_bytes"].(float64))
			require.Greater(t, documentBytes, int64(64<<10))
			path := "/api/playground/canvases/" + id

			// The row keeps only metadata; the object store holds the gzip bytes.
			var stored model.PlaygroundCanvasProject
			require.NoError(t, db.Where("id = ?", id).First(&stored).Error)
			assert.Empty(t, string(stored.Document))
			assert.Equal(t, system_setting.ObjectStoreBackendLocal, stored.StorageBackend)
			assert.Equal(t, "gzip", stored.ContentEncoding)
			assert.Equal(t, documentBytes, stored.DocumentBytes)
			assert.True(t, strings.HasPrefix(stored.ObjectKey, "pg/7/canvases/"), stored.ObjectKey)
			firstKey := stored.ObjectKey
			store := objectstore.DefaultStore()
			require.NotNil(t, store)
			reader, _, objectErr := store.Get(context.Background(), firstKey)
			require.NoError(t, objectErr)
			gzipReader, objectErr := gzip.NewReader(reader)
			require.NoError(t, objectErr)
			decompressed, objectErr := io.ReadAll(gzipReader)
			require.NoError(t, objectErr)
			require.NoError(t, gzipReader.Close())
			require.NoError(t, reader.Close())
			assert.EqualValues(t, documentBytes, len(decompressed))
			var persisted any
			require.NoError(t, common.Unmarshal(decompressed, &persisted))

			// The detail read decompresses the object back into the document.
			detail := playgroundRequest(t, 7, http.MethodGet, path, nil, controller.GetPlaygroundCanvasProject)
			require.Equal(t, http.StatusOK, detail.Code, detail.Body.String())
			fetched := canvasEnvelope(t, detail.Body.Bytes())
			assert.Equal(t, fetched["document"], persisted)
			for _, item := range fetched["document"].(map[string]any)["nodes"].([]any) {
				assert.Equal(t, blob, item.(map[string]any)["data"].(map[string]any)["text"])
			}

			// A replacing save writes a new object and deletes the old one.
			updated := playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": 0, "document": largeDocument(strings.Repeat("y", 40<<10)),
			}, controller.UpdatePlaygroundCanvasProject)
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			require.NoError(t, db.Where("id = ?", id).First(&stored).Error)
			assert.NotEmpty(t, stored.ObjectKey)
			assert.NotEqual(t, firstKey, stored.ObjectKey)
			_, objectErr = store.Head(context.Background(), firstKey)
			assert.ErrorIs(t, objectErr, objectstore.ErrObjectNotFound)
			secondKey := stored.ObjectKey

			// A small document returns to the inline column and releases the object.
			updated = playgroundRequest(t, 7, http.MethodPatch, path, map[string]any{
				"revision": 1, "document": canvasDocument([]any{canvasNode("n1", "text", 0, 0)}, nil),
			}, controller.UpdatePlaygroundCanvasProject)
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			require.NoError(t, db.Where("id = ?", id).First(&stored).Error)
			assert.Empty(t, stored.ObjectKey)
			assert.Empty(t, stored.StorageBackend)
			assert.NotEmpty(t, string(stored.Document))
			_, objectErr = store.Head(context.Background(), secondKey)
			assert.ErrorIs(t, objectErr, objectstore.ErrObjectNotFound)

			// The account counter measures logical document bytes throughout.
			var usage model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&usage).Error)
			assert.EqualValues(t, len(string(stored.Document)), usage.CanvasBytes)
		})
	}
}

// The canvas trash lifecycle: deleting a board moves it into the same trash as
// conversations while its document, attachment pins and counter share stay
// stored, restore returns the same board with its reachable nodes, and the
// retention sweep releases the document bytes and the pins it held.
func TestPlaygroundCanvasTrashLifecycle(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			usePlaygroundGroupQuota(t, "default", playground_setting.PlaygroundQuotaPolicy{TrashRetentionDays: 2})
			session := createPlayground(t, 7, "canvas-trash")
			sessionID := session["id"].(string)
			attachment := playgroundUploadAttachment(t, 7, sessionID, "canvas-trash-file", "image/png", playgroundPNGFixture(64))
			attachmentID := attachment["id"].(string)
			created := canvasEnvelope(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
				"client_id": "canvas-trash-board",
				"title":     "Trash board",
				"document": canvasDocument([]any{
					canvasNode("n1", "prompt", 10, 20),
					canvasRefNode("a1", "attachment", map[string]any{"sessionId": sessionID, "attachmentId": attachmentID}),
				}, nil),
			}, controller.CreatePlaygroundCanvasProject).Body.Bytes())
			canvasID := created["id"].(string)
			canvasPath := "/api/playground/canvases/" + canvasID
			countPins := func() int64 {
				var pins int64
				require.NoError(t, db.Model(&model.PlaygroundCanvasAsset{}).Where("canvas_id = ?", canvasID).Count(&pins).Error)
				return pins
			}
			require.EqualValues(t, 1, countPins())
			before := playgroundUsageCounters(t, db, 7)
			require.EqualValues(t, 1, before.CanvasCount)
			require.Positive(t, before.CanvasBytes)
			require.EqualValues(t, 1, before.Sessions)

			// Moving the board to the trash hides it from every active read
			// while its document, pins and counter share stay stored.
			assert.Empty(t, playgroundTrashListingFixture(t, 7).Items)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, canvasPath, nil, controller.DeletePlaygroundCanvasProject).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodGet, canvasPath, nil, controller.GetPlaygroundCanvasProject).Code)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodGet, canvasPath, nil, controller.GetPlaygroundCanvasProject).Code)
			assert.Contains(t, playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases", nil, controller.ListPlaygroundCanvasProjects).Body.String(), `"total":0`)
			assert.EqualValues(t, 1, countPins())
			assert.Equal(t, playgroundUsageCounterValues(before), playgroundUsageCounterValues(playgroundUsageCounters(t, db, 7)))
			listing := playgroundTrashListingFixture(t, 7)
			assert.Equal(t, 2, listing.RetentionDays)
			require.Len(t, listing.Items, 1)
			assert.Equal(t, "canvas", listing.Items[0].Kind)
			assert.Equal(t, canvasID, listing.Items[0].ID)
			assert.Equal(t, "Trash board", listing.Items[0].Title)
			assert.Positive(t, listing.Items[0].DeletedAt)
			assert.Equal(t, listing.Items[0].DeletedAt+2*24*60*60, listing.Items[0].PurgeAt)

			// Restore is trash-only and owner-scoped, and returns the same
			// board with its reachable nodes, pins and counters intact.
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodPost, canvasPath+"/restore", nil, controller.RestorePlaygroundCanvasProject).Code)
			restored := playgroundRequest(t, 7, http.MethodPost, canvasPath+"/restore", nil, controller.RestorePlaygroundCanvasProject)
			require.Equal(t, http.StatusOK, restored.Code, restored.Body.String())
			restoredCanvas := canvasEnvelope(t, restored.Body.Bytes())
			assert.Equal(t, canvasID, restoredCanvas["id"])
			detail := canvasEnvelope(t, playgroundRequest(t, 7, http.MethodGet, canvasPath, nil, controller.GetPlaygroundCanvasProject).Body.Bytes())
			assert.Empty(t, detail["unavailable_node_ids"])
			assert.EqualValues(t, 1, countPins())
			assert.Equal(t, playgroundUsageCounterValues(before), playgroundUsageCounterValues(playgroundUsageCounters(t, db, 7)))
			assert.Empty(t, playgroundTrashListingFixture(t, 7).Items)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPost, canvasPath+"/restore", nil, controller.RestorePlaygroundCanvasProject).Code)

			// A fresh trashing survives a sweep; once the owner's window
			// elapses the sweep purges the board, releases its pins and returns
			// the document bytes to the account budget.
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, canvasPath, nil, controller.DeletePlaygroundCanvasProject).Code)
			sweep, err := model.PurgeExpiredPlaygroundTrash(100)
			require.NoError(t, err)
			assert.Zero(t, sweep.Canvases)
			require.NoError(t, db.Model(&model.PlaygroundCanvasProject{}).Where("id = ?", canvasID).Update("deleted_at", common.GetTimestamp()-3*24*60*60).Error)
			sweep, err = model.PurgeExpiredPlaygroundTrash(100)
			require.NoError(t, err)
			assert.EqualValues(t, 1, sweep.Canvases)
			assert.Zero(t, sweep.Sessions)
			var rows int64
			require.NoError(t, db.Model(&model.PlaygroundCanvasProject{}).Where("id = ?", canvasID).Count(&rows).Error)
			assert.Zero(t, rows)
			assert.Zero(t, countPins())
			after := playgroundUsageCounters(t, db, 7)
			assert.Zero(t, after.CanvasCount)
			assert.Zero(t, after.CanvasBytes)
			// The conversation behind the pinned attachment is untouched.
			assert.EqualValues(t, 1, after.Sessions)
			assert.EqualValues(t, 1, after.AttachmentCount)
			assert.Empty(t, playgroundTrashListingFixture(t, 7).Items)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 7, http.MethodPost, canvasPath+"/restore", nil, controller.RestorePlaygroundCanvasProject).Code)
		})
	}
}

// A canvas link uses the same hash-only, revocable token contract as a
// conversation link, but the anonymous snapshot is a sanitized drawing: local
// layout and previews survive while every resource reference, task id,
// generation parameter and provider-facing field is removed.
func TestPlaygroundCanvasShares(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			// The column addition is idempotent and keeps the existing session
			// links usable.
			for range 2 {
				require.NoError(t, db.AutoMigrate(&model.PlaygroundSessionShare{}))
			}
			assert.True(t, db.Migrator().HasColumn(&model.PlaygroundSessionShare{}, "canvas_id"))

			session := createPlayground(t, 7, "canvas-share-session")
			sessionID := session["id"].(string)
			secretSessionID := sessionID
			created := canvasEnvelope(t, playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvases", map[string]any{
				"title": "Share board",
				"document": canvasDocument([]any{
					map[string]any{
						"id": "n-text", "type": "text", "position": map[string]any{"x": 10, "y": 20},
						"data": map[string]any{"kind": "text", "text": "Visible prompt preview"},
					},
					map[string]any{
						"id": "n-message", "type": "message", "position": map[string]any{"x": 30, "y": 40},
						"data": map[string]any{
							"kind": "message",
							"snapshot": map[string]any{
								"sessionId": secretSessionID, "messageKey": "secret-message-key",
								"role": "assistant", "text": "Visible snapshot preview",
							},
							"ref": map[string]any{"sessionId": secretSessionID, "messageKey": "secret-message-key"},
						},
					},
					map[string]any{
						"id": "n-artifact", "type": "artifact", "position": map[string]any{"x": 50, "y": 60},
						"data": map[string]any{
							"kind": "artifact", "label": "chart.png", "mediaType": "image/png",
							"ref": map[string]any{
								"sessionId": secretSessionID, "attachmentId": "pgf_secret_attachment",
								"artifactId": "pga_secret_artifact", "taskId": "task_secret_identifier",
								"taskArtifactKey": "secret-artifact-key",
							},
						},
					},
					map[string]any{
						"id": "n-model", "type": "model", "position": map[string]any{"x": 70, "y": 80},
						"data": map[string]any{
							"kind": "model", "text": "Visible step label",
							"workflow": map[string]any{
								"status": "failed", "model": "gpt-secret-model", "generation": "image",
								"size": "4096x4096", "quality": "ultra-secret", "group": "secret-group",
								"inputText": "secret input text", "inputImageCount": 2,
								"output": "Visible workflow output", "taskId": "task_secret_identifier",
								"sourceNodeId": "n-text", "error": "secret upstream failure",
								"attempts": 2, "updatedAt": 123,
							},
						},
					},
					map[string]any{
						"id": "n-result", "type": "task-result", "position": map[string]any{"x": 90, "y": 100},
						"data": map[string]any{
							"kind": "task-result",
							"workflow": map[string]any{
								"status": "succeeded", "generation": "image", "resultImageCount": 3,
								"attempts": 1, "updatedAt": 456,
								"taskId": "task_secret_identifier", "taskArtifactKey": "secret-artifact-key",
							},
						},
					},
					map[string]any{
						"id": "n-group", "type": "group", "position": map[string]any{"x": 0, "y": 0},
						"data": map[string]any{"kind": "group", "text": "Scene"},
					},
					map[string]any{
						"id": "n-child", "type": "text", "position": map[string]any{"x": 5, "y": 5},
						"data": map[string]any{"kind": "text", "text": "grouped child", "parentId": "n-group"},
					},
				}, []any{
					map[string]any{"id": "e1", "source": "n-text", "target": "n-model"},
					map[string]any{"id": "e2", "source": "n-model", "target": "n-result"},
				}),
			}, controller.CreatePlaygroundCanvasProject).Body.Bytes())
			canvasID := created["id"].(string)
			canvasPath := "/api/playground/canvases/" + canvasID
			sharePath := canvasPath + "/share"
			readShared := func(token string) *httptest.ResponseRecorder {
				return playgroundRequest(t, 0, http.MethodGet, "/api/playground/shared/"+token, nil, controller.GetSharedPlaygroundSession)
			}
			missing := playgroundRequest(t, 0, http.MethodGet, "/api/playground/shared/does-not-exist", nil, controller.GetSharedPlaygroundSession)
			require.Equal(t, http.StatusNotFound, missing.Code)
			assert.Contains(t, missing.Body.String(), "PLAYGROUND_SHARE_NOT_FOUND")
			notFoundBody := missing.Body.String()

			foreignCreate := playgroundRequest(t, 8, http.MethodPost, sharePath, map[string]any{"expires_in_days": 7}, controller.CreatePlaygroundCanvasShare)
			assert.Equal(t, http.StatusNotFound, foreignCreate.Code, foreignCreate.Body.String())
			foreignDelete := playgroundRequest(t, 8, http.MethodDelete, sharePath, nil, controller.DeletePlaygroundCanvasShare)
			assert.Equal(t, http.StatusNotFound, foreignDelete.Code, foreignDelete.Body.String())
			var shareCount int64
			require.NoError(t, db.Model(&model.PlaygroundSessionShare{}).Where("canvas_id = ?", canvasID).Count(&shareCount).Error)
			assert.Zero(t, shareCount)

			createShare := func(expiresInDays int) (string, int64, int64) {
				response := playgroundRequest(t, 7, http.MethodPost, sharePath, map[string]any{"expires_in_days": expiresInDays}, controller.CreatePlaygroundCanvasShare)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				data := canvasEnvelope(t, response.Body.Bytes())
				token, _ := data["token"].(string)
				require.NotEmpty(t, token)
				assert.Equal(t, "/share/"+token, data["url_path"])
				return token, int64(data["expires_at"].(float64)), int64(data["created_at"].(float64))
			}

			now := common.GetTimestamp()
			firstToken, firstExpiry, _ := createShare(7)
			assert.GreaterOrEqual(t, firstExpiry, now+7*24*60*60)
			decodedToken, decodeErr := base64.RawURLEncoding.DecodeString(firstToken)
			require.NoError(t, decodeErr)
			assert.Len(t, decodedToken, 16)
			var storedShare model.PlaygroundSessionShare
			require.NoError(t, db.Where("canvas_id = ? AND revoked_at = 0", canvasID).First(&storedShare).Error)
			hash := sha256.Sum256([]byte(firstToken))
			assert.Equal(t, hex.EncodeToString(hash[:]), storedShare.TokenHash)
			assert.Empty(t, storedShare.SessionID)
			assert.Equal(t, canvasID, storedShare.CanvasID)
			assert.NotContains(t, storedShare.TokenHash, firstToken)

			read := readShared(firstToken)
			require.Equal(t, http.StatusOK, read.Code, read.Body.String())
			assert.Equal(t, "noindex, nofollow, noarchive", read.Header().Get("X-Robots-Tag"))
			assert.Equal(t, "no-referrer", read.Header().Get("Referrer-Policy"))
			assert.Equal(t, "nosniff", read.Header().Get("X-Content-Type-Options"))
			snapshot := canvasEnvelope(t, read.Body.Bytes())
			assert.Equal(t, "canvas", snapshot["kind"])
			assert.Equal(t, "Share board", snapshot["title"])
			document := snapshot["document"].(map[string]any)
			assert.EqualValues(t, 1.25, document["viewport"].(map[string]any)["zoom"])
			nodes := document["nodes"].([]any)
			require.Len(t, nodes, 7)
			edges := document["edges"].([]any)
			require.Len(t, edges, 2)
			nodeByID := func(id string) map[string]any {
				for _, item := range nodes {
					node := item.(map[string]any)
					if node["id"] == id {
						return node
					}
				}
				t.Fatalf("node %s missing from the shared document", id)
				return nil
			}
			assert.Equal(t, "Visible prompt preview", nodeByID("n-text")["data"].(map[string]any)["text"])
			messageData := nodeByID("n-message")["data"].(map[string]any)
			messageSnapshot := messageData["snapshot"].(map[string]any)
			assert.Equal(t, "assistant", messageSnapshot["role"])
			assert.Equal(t, "Visible snapshot preview", messageSnapshot["text"])
			assert.NotContains(t, messageData, "ref")
			artifactData := nodeByID("n-artifact")["data"].(map[string]any)
			assert.Equal(t, "chart.png", artifactData["label"])
			assert.Equal(t, "image/png", artifactData["mediaType"])
			assert.NotContains(t, artifactData, "media_type")
			modelWorkflow := nodeByID("n-model")["data"].(map[string]any)["workflow"].(map[string]any)
			assert.Equal(t, "failed", modelWorkflow["status"])
			assert.Equal(t, "image", modelWorkflow["generation"])
			assert.Equal(t, "Visible workflow output", modelWorkflow["output"])
			assert.EqualValues(t, 2, modelWorkflow["attempts"])
			assert.EqualValues(t, 123, modelWorkflow["updatedAt"])
			resultWorkflow := nodeByID("n-result")["data"].(map[string]any)["workflow"].(map[string]any)
			assert.EqualValues(t, 3, resultWorkflow["resultImageCount"])
			assert.EqualValues(t, 456, resultWorkflow["updatedAt"])
			assert.Equal(t, "n-group", nodeByID("n-child")["data"].(map[string]any)["parentId"])

			for _, secret := range []string{
				secretSessionID, "secret-message-key", "pgf_secret_attachment", "pga_secret_artifact",
				"task_secret_identifier", "secret-artifact-key", "gpt-secret-model", "4096x4096",
				"ultra-secret", "secret-group", "secret input text", "secret upstream failure",
				"provider.example", firstToken, storedShare.TokenHash, canvasID,
			} {
				assert.NotContains(t, read.Body.String(), secret)
			}
			for _, forbiddenKey := range []string{
				`"ref"`, `"sessionId"`, `"messageKey"`, `"attachmentId"`, `"artifactId"`,
				`"taskId"`, `"taskArtifactKey"`, `"inputText"`, `"inputImageCount"`, `"error"`,
				`"model"`, `"size"`, `"quality"`, `"group"`, `"sourceNodeId"`, `"content_url"`,
				`"token"`, `"user_id"`,
			} {
				assert.NotContains(t, read.Body.String(), forbiddenKey+":")
			}

			// Rotation, expiry and revocation use the identical non-enumerable
			// response as an unknown token.
			secondToken, _, _ := createShare(0)
			assert.NotEqual(t, firstToken, secondToken)
			rotated := readShared(firstToken)
			assert.Equal(t, http.StatusNotFound, rotated.Code)
			assert.Equal(t, notFoundBody, rotated.Body.String())
			require.Equal(t, http.StatusOK, readShared(secondToken).Code)
			for _, invalid := range []int{-1, 366} {
				response := playgroundRequest(t, 7, http.MethodPost, sharePath, map[string]any{"expires_in_days": invalid}, controller.CreatePlaygroundCanvasShare)
				assert.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			}
			expiredToken, _, _ := createShare(1)
			expiredHash := sha256.Sum256([]byte(expiredToken))
			require.NoError(t, db.Model(&model.PlaygroundSessionShare{}).
				Where("token_hash = ?", hex.EncodeToString(expiredHash[:])).
				Update("expires_at", common.GetTimestamp()-1).Error)
			expired := readShared(expiredToken)
			assert.Equal(t, http.StatusNotFound, expired.Code)
			assert.Equal(t, notFoundBody, expired.Body.String())
			for range 2 {
				response := playgroundRequest(t, 7, http.MethodDelete, sharePath, nil, controller.DeletePlaygroundCanvasShare)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				assert.Contains(t, response.Body.String(), `"revoked":true`)
			}
			revoked := readShared(secondToken)
			assert.Equal(t, http.StatusNotFound, revoked.Code)
			assert.Equal(t, notFoundBody, revoked.Body.String())

			// Trash revokes the current link, restore does not resurrect it,
			// and purge removes the remaining share rows.
			trashToken, _, _ := createShare(30)
			require.Equal(t, http.StatusOK, readShared(trashToken).Code)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, canvasPath, nil, controller.DeletePlaygroundCanvasProject).Code)
			trashedRead := readShared(trashToken)
			assert.Equal(t, http.StatusNotFound, trashedRead.Code)
			assert.Equal(t, notFoundBody, trashedRead.Body.String())
			trashedCreate := playgroundRequest(t, 7, http.MethodPost, sharePath, nil, controller.CreatePlaygroundCanvasShare)
			assert.Equal(t, http.StatusNotFound, trashedCreate.Code)
			trashedRevoke := playgroundRequest(t, 7, http.MethodDelete, sharePath, nil, controller.DeletePlaygroundCanvasShare)
			assert.Equal(t, http.StatusOK, trashedRevoke.Code, trashedRevoke.Body.String())
			_, err := model.RestorePlaygroundCanvasProject(7, canvasID)
			require.NoError(t, err)
			assert.Equal(t, http.StatusNotFound, readShared(trashToken).Code)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, canvasPath, nil, controller.DeletePlaygroundCanvasProject).Code)
			require.NoError(t, model.PurgePlaygroundCanvasProject(7, canvasID))
			require.NoError(t, db.Model(&model.PlaygroundSessionShare{}).Where("canvas_id = ?", canvasID).Count(&shareCount).Error)
			assert.Zero(t, shareCount)
		})
	}
}

// canvasArchiveManifestFixture mirrors the manifest an archive export writes,
// so a test can assert the download contract without the controller types.
type canvasArchiveManifestFixture struct {
	Format    string          `json:"format"`
	Version   int             `json:"version"`
	Title     string          `json:"title"`
	Document  json.RawMessage `json:"document"`
	Resources []struct {
		Entry        string `json:"entry"`
		AttachmentID string `json:"attachment_id"`
		SessionID    string `json:"session_id"`
		MediaType    string `json:"media_type"`
		ByteSize     int64  `json:"byte_size"`
		ContentHash  string `json:"content_hash"`
	} `json:"resources"`
}

func playgroundExportCanvasArchive(t *testing.T, user int, path string) *httptest.ResponseRecorder {
	t.Helper()
	response := playgroundRequest(t, user, http.MethodGet, path, nil, controller.ExportPlaygroundCanvasArchive)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, "application/zip", response.Header().Get("Content-Type"))
	return response
}

func canvasArchiveMembers(t *testing.T, archive []byte) (canvasArchiveManifestFixture, map[string][]byte) {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	require.NoError(t, err)
	var manifest canvasArchiveManifestFixture
	members := make(map[string][]byte)
	for _, member := range reader.File {
		opened, err := member.Open()
		require.NoError(t, err)
		data, err := io.ReadAll(opened)
		require.NoError(t, err)
		require.NoError(t, opened.Close())
		if member.Name == "canvas.json" {
			require.NoError(t, common.Unmarshal(data, &manifest))
			continue
		}
		members[member.Name] = data
	}
	return manifest, members
}

// canvasArchiveManifestOnly rebuilds an archive without its resource members,
// which is the state a partially collected download leaves behind.
func canvasArchiveManifestOnly(t *testing.T, archive []byte) []byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	require.NoError(t, err)
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, member := range reader.File {
		if member.Name != "canvas.json" {
			continue
		}
		opened, err := member.Open()
		require.NoError(t, err)
		data, err := io.ReadAll(opened)
		require.NoError(t, err)
		require.NoError(t, opened.Close())
		entry, err := writer.Create("canvas.json")
		require.NoError(t, err)
		_, err = entry.Write(data)
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())
	return buffer.Bytes()
}

func playgroundImportCanvasArchive(t *testing.T, user int, archive []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "board.zip")
	require.NoError(t, err)
	_, err = part.Write(archive)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("id", user)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/playground/canvases/import", &body)
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())
	controller.ImportPlaygroundCanvasArchive(c)
	return recorder
}

func canvasArchiveNodes(t *testing.T, project map[string]any) []any {
	t.Helper()
	document, ok := project["document"].(map[string]any)
	require.True(t, ok, "project document missing: %v", project)
	nodes, ok := document["nodes"].([]any)
	require.True(t, ok, "document nodes missing: %v", document)
	return nodes
}

// A whole board, or a selected subset, downloads as an archive with the
// controlled-read bytes of its attachments, and an archive restores as a new
// canvas: the resources are re-uploaded into the new partition and the node
// references are rewritten to the new rows.
func TestPlaygroundCanvasArchiveRoundTrip(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)
			canvasID := createCanvasProject(t, 7, "canvas-archive")["id"].(string)
			png := playgroundPNGFixture(96)
			attachmentID := playgroundUploadCanvasAttachment(t, 7, canvasID, "archive-1", "image/png", png)["id"].(string)
			update := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+canvasID, map[string]any{
				"revision": 0,
				"document": canvasDocument([]any{
					canvasRefNode("n1", "image", map[string]any{"sessionId": canvasID, "attachmentId": attachmentID}),
					canvasNode("n2", "text", 40, 60),
					canvasNode("n3", "group", 0, 0),
					map[string]any{
						"id": "n4", "type": "text", "position": map[string]any{"x": 10, "y": 10},
						"data": map[string]any{"kind": "text", "text": "child", "parentId": "n3"},
					},
				}, []any{
					map[string]any{"id": "e1", "source": "n1", "target": "n2"},
					map[string]any{"id": "e2", "source": "n2", "target": "n4"},
				}),
			}, controller.UpdatePlaygroundCanvasProject)
			require.Equal(t, http.StatusOK, update.Code, update.Body.String())

			// Only the owner can download the archive.
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodGet, "/api/playground/canvases/"+canvasID+"/export", nil, controller.ExportPlaygroundCanvasArchive).Code)

			exported := playgroundExportCanvasArchive(t, 7, "/api/playground/canvases/"+canvasID+"/export")
			assert.Contains(t, exported.Header().Get("Content-Disposition"), "Board.zip")
			assert.Equal(t, "private, no-store", exported.Header().Get("Cache-Control"))
			manifest, members := canvasArchiveMembers(t, exported.Body.Bytes())
			assert.Equal(t, "new-api-canvas", manifest.Format)
			assert.EqualValues(t, 1, manifest.Version)
			assert.Equal(t, "Board", manifest.Title)
			require.Len(t, manifest.Resources, 1)
			resource := manifest.Resources[0]
			assert.Equal(t, attachmentID, resource.AttachmentID)
			assert.Equal(t, canvasID, resource.SessionID)
			assert.Equal(t, "image/png", resource.MediaType)
			assert.EqualValues(t, len(png), resource.ByteSize)
			require.Contains(t, members, resource.Entry)
			assert.Equal(t, png, members[resource.Entry])

			// A subset export carries the picked nodes and the edges between
			// them, and drops the group link of a child whose group stays.
			subset := playgroundExportCanvasArchive(t, 7, "/api/playground/canvases/"+canvasID+"/export?nodes=n4")
			subsetManifest, subsetMembers := canvasArchiveMembers(t, subset.Body.Bytes())
			assert.Empty(t, subsetManifest.Resources)
			assert.Empty(t, subsetMembers)
			var subsetDocument struct {
				Nodes []struct {
					ID   string          `json:"id"`
					Data json.RawMessage `json:"data"`
				} `json:"nodes"`
				Edges []any `json:"edges"`
			}
			require.NoError(t, common.Unmarshal(subsetManifest.Document, &subsetDocument))
			require.Len(t, subsetDocument.Nodes, 1)
			assert.Equal(t, "n4", subsetDocument.Nodes[0].ID)
			assert.Empty(t, subsetDocument.Edges)
			var subsetData map[string]any
			require.NoError(t, common.Unmarshal(subsetDocument.Nodes[0].Data, &subsetData))
			_, hasParent := subsetData["parentId"]
			assert.False(t, hasParent)
			assert.Equal(t, http.StatusBadRequest, playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvases/"+canvasID+"/export?nodes=missing", nil, controller.ExportPlaygroundCanvasArchive).Code)

			// Another account restores the board: the bytes are re-uploaded
			// into its own canvas partition and the references follow.
			imported := playgroundImportCanvasArchive(t, 8, exported.Body.Bytes())
			require.Equal(t, http.StatusOK, imported.Code, imported.Body.String())
			data := canvasEnvelope(t, imported.Body.Bytes())
			assert.EqualValues(t, 1, data["resources_imported"])
			assert.EqualValues(t, 0, data["resources_missing"])
			assert.EqualValues(t, 0, data["references_dropped"])
			project := data["project"].(map[string]any)
			newCanvasID := project["id"].(string)
			require.NotEqual(t, canvasID, newCanvasID)
			assert.Equal(t, "Board", project["title"])
			assert.Empty(t, project["unavailable_node_ids"])
			nodes := canvasArchiveNodes(t, project)
			require.Len(t, nodes, 4)
			reference := nodes[0].(map[string]any)["data"].(map[string]any)["ref"].(map[string]any)
			newAttachmentID := reference["attachmentId"].(string)
			require.NotEqual(t, attachmentID, newAttachmentID)
			assert.True(t, strings.HasPrefix(newAttachmentID, "pgf_"))
			assert.Equal(t, newCanvasID, reference["sessionId"])
			var restored model.PlaygroundAttachment
			require.NoError(t, db.Where("id = ?", newAttachmentID).First(&restored).Error)
			assert.Equal(t, newCanvasID, restored.SessionID)
			assert.Equal(t, int64(len(png)), restored.ByteSize)
			var source model.PlaygroundAttachment
			require.NoError(t, db.Where("id = ?", attachmentID).First(&source).Error)
			assert.Equal(t, canvasID, source.SessionID)

			// An import needs an authenticated account and a real archive.
			assert.Equal(t, http.StatusUnauthorized, playgroundImportCanvasArchive(t, 0, exported.Body.Bytes()).Code)
			assert.Equal(t, http.StatusBadRequest, playgroundImportCanvasArchive(t, 8, []byte("not an archive")).Code)
		})
	}
}

// A damaged archive still restores what it can: a resource member that is gone
// is reported instead of failing the import, a reference another account is not
// allowed to keep is dropped, and an archive never carries bytes that do not
// belong to the exporting account.
func TestPlaygroundCanvasArchiveDegradedRestore(t *testing.T) {
	db := playgroundTestDB(t, "sqlite")
	canvasID := createCanvasProject(t, 7, "canvas-archive-degraded")["id"].(string)
	png := playgroundPNGFixture(48)
	attachmentID := playgroundUploadCanvasAttachment(t, 7, canvasID, "degraded-1", "image/png", png)["id"].(string)
	require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+canvasID, map[string]any{
		"revision": 0,
		"document": canvasDocument([]any{
			canvasRefNode("n1", "image", map[string]any{"sessionId": canvasID, "attachmentId": attachmentID}),
		}, nil),
	}, controller.UpdatePlaygroundCanvasProject).Code)
	archive := playgroundExportCanvasArchive(t, 7, "/api/playground/canvases/"+canvasID+"/export").Body.Bytes()
	damaged := canvasArchiveManifestOnly(t, archive)

	// The owner still gets a complete node: the kept reference resolves to the
	// original row, so only the archive lost the bytes.
	sameAccount := playgroundImportCanvasArchive(t, 7, damaged)
	require.Equal(t, http.StatusOK, sameAccount.Code, sameAccount.Body.String())
	sameData := canvasEnvelope(t, sameAccount.Body.Bytes())
	assert.EqualValues(t, 0, sameData["resources_imported"])
	assert.EqualValues(t, 1, sameData["resources_missing"])
	assert.EqualValues(t, 0, sameData["references_dropped"])
	sameProject := sameData["project"].(map[string]any)
	assert.Empty(t, sameProject["unavailable_node_ids"])
	sameReference := canvasArchiveNodes(t, sameProject)[0].(map[string]any)["data"].(map[string]any)["ref"].(map[string]any)
	assert.Equal(t, attachmentID, sameReference["attachmentId"])

	// Another account cannot claim the row: the reference is dropped while the
	// node keeps its own stored text.
	crossAccount := playgroundImportCanvasArchive(t, 8, damaged)
	require.Equal(t, http.StatusOK, crossAccount.Code, crossAccount.Body.String())
	crossData := canvasEnvelope(t, crossAccount.Body.Bytes())
	assert.EqualValues(t, 1, crossData["resources_missing"])
	assert.EqualValues(t, 1, crossData["references_dropped"])
	crossNode := canvasArchiveNodes(t, crossData["project"].(map[string]any))[0].(map[string]any)
	_, hasReference := crossNode["data"].(map[string]any)["ref"]
	assert.False(t, hasReference)

	// A saved document that claims a foreign resource never leaks its bytes
	// into an archive, and an import drops the claim again.
	foreignSession := createPlayground(t, 8, "canvas-archive-foreign")["id"].(string)
	foreignAttachment := playgroundUploadAttachment(t, 8, foreignSession, "foreign-1", "image/png", playgroundPNGFixture(32))["id"].(string)
	foreignDocument, err := common.Marshal(canvasDocument([]any{
		canvasRefNode("f1", "attachment", map[string]any{"sessionId": foreignSession, "attachmentId": foreignAttachment}),
	}, nil))
	require.NoError(t, err)
	require.NoError(t, db.Model(&model.PlaygroundCanvasProject{}).Where("id = ?", canvasID).Update("document", string(foreignDocument)).Error)
	foreignArchive := playgroundExportCanvasArchive(t, 7, "/api/playground/canvases/"+canvasID+"/export").Body.Bytes()
	foreignManifest, foreignMembers := canvasArchiveMembers(t, foreignArchive)
	assert.Empty(t, foreignManifest.Resources)
	assert.Empty(t, foreignMembers)
	foreignImport := playgroundImportCanvasArchive(t, 7, foreignArchive)
	require.Equal(t, http.StatusOK, foreignImport.Code, foreignImport.Body.String())
	foreignData := canvasEnvelope(t, foreignImport.Body.Bytes())
	assert.EqualValues(t, 0, foreignData["resources_imported"])
	assert.EqualValues(t, 1, foreignData["references_dropped"])
}

func canvasTemplateMembers(t *testing.T, archive []byte) (map[string]any, map[string][]byte) {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	require.NoError(t, err)
	var manifest map[string]any
	members := make(map[string][]byte)
	for _, member := range reader.File {
		opened, err := member.Open()
		require.NoError(t, err)
		data, err := io.ReadAll(opened)
		require.NoError(t, err)
		require.NoError(t, opened.Close())
		if member.Name == "template.json" {
			require.NoError(t, common.Unmarshal(data, &manifest))
			continue
		}
		members[member.Name] = data
	}
	require.NotNil(t, manifest)
	return manifest, members
}

func playgroundImportCanvasTemplate(t *testing.T, user int, path string, archive []byte, handler gin.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "template.zip")
	require.NoError(t, err)
	_, err = part.Write(archive)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("id", user)
	c.Request = httptest.NewRequest(http.MethodPost, path, &body)
	c.Request.Header.Set("Content-Type", writer.FormDataContentType())
	handler(c)
	return recorder
}

// Canvas templates preserve the chain structure without leaking live resource
// references: a structure template drops every ref, an inline template
// snapshots the referenced bytes and keeps only the attachment id, and the
// official seeds are created once. The market mirrors the preset visibility
// contract, and a template archive round-trips through a zip on every
// supported database.
func TestPlaygroundCanvasTemplateLibrary(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := playgroundTestDB(t, dialect)

			// Official seeds are global, ownerless and idempotent. The seed run
			// is repeated to prove the SystemKey lookup does not duplicate rows.
			require.NoError(t, model.SeedPlaygroundCanvasTemplates(db))
			require.NoError(t, model.SeedPlaygroundCanvasTemplates(db))
			var seeded int64
			require.NoError(t, db.Model(&model.PlaygroundCanvasTemplate{}).Where("visibility = ? AND deleted_at = 0", model.PlaygroundCanvasTemplateVisibilityGlobal).Count(&seeded).Error)
			assert.EqualValues(t, 4, seeded)
			var translation model.PlaygroundCanvasTemplate
			require.NoError(t, db.Where("id = ?", "pgct_official_translation").First(&translation).Error)
			assert.Zero(t, translation.UserID)
			assert.False(t, translation.InlineAssets)
			assert.False(t, strings.Contains(string(translation.Document), `"ref"`))
			assert.Contains(t, string(translation.Document), `"translate-model"`)

			// Build a canvas with one attachment and one workflow step whose
			// last run must not travel into the template.
			canvasID := createCanvasProject(t, 7, "canvas-template")["id"].(string)
			png := playgroundPNGFixture(80)
			attachmentID := playgroundUploadCanvasAttachment(t, 7, canvasID, "template-1", "image/png", png)["id"].(string)
			document := canvasDocument([]any{
				canvasNode("p1", "prompt", 0, 0),
				canvasRefNode("a1", "attachment", map[string]any{"sessionId": canvasID, "attachmentId": attachmentID}),
				map[string]any{
					"id": "m1", "type": "model", "position": map[string]any{"x": 360, "y": 0},
					"data": map[string]any{
						"kind": "model", "label": "Generate", "preferred": true,
						"snapshot": map[string]any{"sessionId": "leaked-session", "text": "leaked preview"},
						"workflow": map[string]any{
							"model": "test-model", "size": "1024x1024", "imageCount": float64(1),
							"status": "succeeded", "output": "leaked output", "inputText": "leaked input",
							"resultImageCount": float64(1), "error": "leaked error", "attempts": float64(2),
							"lastSeed": float64(1234), "preferredResultNodeId": "m1-result-1",
						},
					},
				},
			}, []any{
				map[string]any{"id": "e1", "source": "p1", "target": "m1"},
			})
			require.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvases/"+canvasID, map[string]any{
				"revision": 0, "document": document,
			}, controller.UpdatePlaygroundCanvasProject).Code)

			type templateWriteResponse struct {
				Template struct {
					ID           string `json:"id"`
					Name         string `json:"name"`
					Visibility   string `json:"visibility"`
					InlineAssets bool   `json:"inline_assets"`
					AssetCount   int    `json:"asset_count"`
					AssetBytes   int64  `json:"asset_bytes"`
					Document     string `json:"document"`
				} `json:"template"`
				AssetsInlined     int `json:"assets_inlined"`
				ReferencesDropped int `json:"references_dropped"`
			}
			create := func(body map[string]any) templateWriteResponse {
				t.Helper()
				response := playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvas-templates", body, controller.CreatePlaygroundCanvasTemplate)
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				var envelope struct {
					Success bool                  `json:"success"`
					Data    templateWriteResponse `json:"data"`
				}
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &envelope))
				require.True(t, envelope.Success, response.Body.String())
				return envelope.Data
			}

			inline := create(map[string]any{
				"canvas_id": canvasID, "name": "  Inline chain  ", "description": "Carries its image.",
				"category": "comparison", "inline_assets": true,
			})
			require.True(t, strings.HasPrefix(inline.Template.ID, "pgct_"), inline.Template.ID)
			assert.Equal(t, "Inline chain", inline.Template.Name)
			assert.Equal(t, model.PlaygroundCanvasTemplateVisibilityPrivate, inline.Template.Visibility)
			assert.True(t, inline.Template.InlineAssets)
			assert.Equal(t, 1, inline.AssetsInlined)
			assert.Equal(t, 0, inline.ReferencesDropped)

			var stored model.PlaygroundCanvasTemplate
			require.NoError(t, db.Where("id = ?", inline.Template.ID).First(&stored).Error)
			assert.Equal(t, 7, stored.UserID)
			assert.EqualValues(t, len(stored.Document), stored.DocumentBytes)
			var storedDocument map[string]any
			require.NoError(t, common.UnmarshalJsonStr(string(stored.Document), &storedDocument))
			nodes := storedDocument["nodes"].([]any)
			require.Len(t, nodes, 3)
			attachmentNode := nodes[1].(map[string]any)["data"].(map[string]any)
			assert.Equal(t, map[string]any{"attachmentId": attachmentID}, attachmentNode["ref"], "only the attachment claim survives")
			modelData := nodes[2].(map[string]any)["data"].(map[string]any)
			workflow := modelData["workflow"].(map[string]any)
			assert.Equal(t, "test-model", workflow["model"])
			assert.Equal(t, "1024x1024", workflow["size"])
			for _, key := range []string{
				"status", "output", "inputText", "resultImageCount", "error", "attempts",
				"lastSeed", "preferredResultNodeId",
			} {
				_, present := workflow[key]
				assert.False(t, present, key)
			}
			for _, key := range []string{"preferred", "snapshot", "sourceDeleted"} {
				_, present := modelData[key]
				assert.False(t, present, key)
			}
			assets := make([]model.PlaygroundCanvasTemplateAsset, 0)
			require.NoError(t, db.Where("template_id = ?", stored.ID).Find(&assets).Error)
			require.Len(t, assets, 1)
			assert.Equal(t, attachmentID, assets[0].SourceAttachmentID)
			assert.Equal(t, "image/png", assets[0].MediaType)
			assert.EqualValues(t, len(png), assets[0].ByteSize)
			bytes, err := base64.StdEncoding.DecodeString(string(assets[0].Data))
			require.NoError(t, err)
			assert.Equal(t, png, bytes)
			inlineSize := int64(len(stored.Document)) + int64(len(png))

			// A structure-only template drops the ref and charges no asset
			// bytes; the node keeps its prompt and workflow configuration.
			structure := create(map[string]any{
				"canvas_id": canvasID, "name": "Structure chain", "inline_assets": false,
			})
			assert.False(t, structure.Template.InlineAssets)
			assert.Zero(t, structure.Template.AssetCount)
			assert.Equal(t, 1, structure.ReferencesDropped)
			var structureRow model.PlaygroundCanvasTemplate
			require.NoError(t, db.Where("id = ?", structure.Template.ID).First(&structureRow).Error)
			assert.False(t, strings.Contains(string(structureRow.Document), `"attachmentId"`))
			assert.Contains(t, string(structureRow.Document), `"test-model"`)

			// An administrator can save their own canvas directly as a global
			// market template. The row is ownerless, keeps no system key and
			// consumes no account quota; a foreign canvas stays unreadable.
			adminCanvasID := createCanvasProject(t, 9, "admin-global-template")["id"].(string)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 9, http.MethodPatch, "/api/playground/canvases/"+adminCanvasID, map[string]any{
				"revision": 0, "document": document,
			}, controller.UpdatePlaygroundCanvasProject).Code)
			globalResponse := playgroundRequest(t, 9, http.MethodPost, "/api/playground/canvas-templates/global", map[string]any{
				"canvas_id": adminCanvasID, "name": "Admin chain", "category": "translation", "inline_assets": false,
			}, controller.CreateGlobalPlaygroundCanvasTemplate)
			require.Equal(t, http.StatusOK, globalResponse.Code, globalResponse.Body.String())
			var globalEnvelope struct {
				Data templateWriteResponse `json:"data"`
			}
			require.NoError(t, common.Unmarshal(globalResponse.Body.Bytes(), &globalEnvelope))
			assert.Equal(t, "Admin chain", globalEnvelope.Data.Template.Name)
			assert.Equal(t, model.PlaygroundCanvasTemplateVisibilityGlobal, globalEnvelope.Data.Template.Visibility)
			var globalRow model.PlaygroundCanvasTemplate
			require.NoError(t, db.Where("id = ?", globalEnvelope.Data.Template.ID).First(&globalRow).Error)
			assert.Zero(t, globalRow.UserID)
			assert.Empty(t, globalRow.SystemKey)
			assert.NotContains(t, string(globalRow.Document), `"snapshot"`)
			assert.NotContains(t, string(globalRow.Document), `"lastSeed"`)
			var adminUsage model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 9).First(&adminUsage).Error)
			assert.Zero(t, adminUsage.CanvasTemplateCount)
			assert.Zero(t, adminUsage.CanvasTemplateBytes)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodPost, "/api/playground/canvas-templates/global", map[string]any{
				"canvas_id": adminCanvasID, "name": "Stolen chain", "inline_assets": false,
			}, controller.CreateGlobalPlaygroundCanvasTemplate).Code)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 9, http.MethodDelete, "/api/playground/canvas-templates/global/"+globalEnvelope.Data.Template.ID, nil, controller.DeleteGlobalPlaygroundCanvasTemplate).Code)

			var usage model.PlaygroundUserUsage
			require.NoError(t, db.Where("user_id = ?", 7).First(&usage).Error)
			assert.EqualValues(t, 2, usage.CanvasTemplateCount)
			assert.EqualValues(t, inlineSize+structureRow.DocumentBytes, usage.CanvasTemplateBytes)

			// Owner listing, foreign isolation and detail read contract.
			listed := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvas-templates", nil, controller.ListPlaygroundCanvasTemplates)
			require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
			assert.Contains(t, listed.Body.String(), `"total":2`)
			assert.Contains(t, listed.Body.String(), `"limit":`+fmt.Sprint(playground_setting.GetPlaygroundQuotaPolicy("default").CanvasTemplateUserMaxCount))
			foreign := playgroundRequest(t, 8, http.MethodGet, "/api/playground/canvas-templates", nil, controller.ListPlaygroundCanvasTemplates)
			assert.Contains(t, foreign.Body.String(), `"total":0`)
			for name, response := range map[string]*httptest.ResponseRecorder{
				"read":   playgroundRequest(t, 8, http.MethodGet, "/api/playground/canvas-templates/"+inline.Template.ID, nil, controller.GetPlaygroundCanvasTemplate),
				"update": playgroundRequest(t, 8, http.MethodPatch, "/api/playground/canvas-templates/"+inline.Template.ID, map[string]any{"name": "Hijacked"}, controller.UpdatePlaygroundCanvasTemplate),
				"delete": playgroundRequest(t, 8, http.MethodDelete, "/api/playground/canvas-templates/"+inline.Template.ID, nil, controller.DeletePlaygroundCanvasTemplate),
			} {
				assert.Equal(t, http.StatusNotFound, response.Code, name+": "+response.Body.String())
			}

			// A global official template is readable by every account, while
			// the private mutation routes stay owner-scoped.
			official := playgroundRequest(t, 8, http.MethodGet, "/api/playground/canvas-templates/pgct_official_translation", nil, controller.GetPlaygroundCanvasTemplate)
			require.Equal(t, http.StatusOK, official.Code, official.Body.String())
			assert.Contains(t, official.Body.String(), `"visibility":"global"`)
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodPatch, "/api/playground/canvas-templates/pgct_official_translation", map[string]any{"name": "Hijacked"}, controller.UpdatePlaygroundCanvasTemplate).Code)

			// Inline bytes are served through the template asset route.
			detail := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvas-templates/"+inline.Template.ID, nil, controller.GetPlaygroundCanvasTemplate)
			require.Equal(t, http.StatusOK, detail.Code, detail.Body.String())
			var detailEnvelope struct {
				Data struct {
					Assets []struct {
						ID string `json:"id"`
					} `json:"assets"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(detail.Body.Bytes(), &detailEnvelope))
			require.Len(t, detailEnvelope.Data.Assets, 1)
			assetID := detailEnvelope.Data.Assets[0].ID
			content := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvas-templates/"+inline.Template.ID+"/assets/"+assetID+"/content", nil, controller.GetPlaygroundCanvasTemplateAssetContent)
			require.Equal(t, http.StatusOK, content.Code, content.Body.String())
			assert.Equal(t, png, content.Body.Bytes())
			assert.Equal(t, http.StatusNotFound, playgroundRequest(t, 8, http.MethodGet, "/api/playground/canvas-templates/"+inline.Template.ID+"/assets/"+assetID+"/content", nil, controller.GetPlaygroundCanvasTemplateAssetContent).Code)

			// The market copy is an independent private row that consumes the
			// caller's budget and keeps the source document.
			copiedResponse := playgroundRequest(t, 8, http.MethodPost, "/api/playground/canvas-templates/market/pgct_official_translation/copy", nil, controller.CopyPlaygroundCanvasTemplateFromMarket)
			require.Equal(t, http.StatusOK, copiedResponse.Code, copiedResponse.Body.String())
			var copiedEnvelope struct {
				Data struct {
					ID           string `json:"id"`
					Visibility   string `json:"visibility"`
					InlineAssets bool   `json:"inline_assets"`
					Name         string `json:"name"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(copiedResponse.Body.Bytes(), &copiedEnvelope))
			assert.NotEqual(t, "pgct_official_translation", copiedEnvelope.Data.ID)
			assert.Equal(t, model.PlaygroundCanvasTemplateVisibilityPrivate, copiedEnvelope.Data.Visibility)
			assert.Equal(t, "Translation chain", copiedEnvelope.Data.Name)
			var copiedRow model.PlaygroundCanvasTemplate
			require.NoError(t, db.Where("id = ?", copiedEnvelope.Data.ID).First(&copiedRow).Error)
			assert.Equal(t, 8, copiedRow.UserID)

			// Updating display fields never promotes a private template.
			updated := playgroundRequest(t, 7, http.MethodPatch, "/api/playground/canvas-templates/"+structure.Template.ID, map[string]any{
				"name": "Structure chain v2", "description": "Updated.", "category": "summary", "visibility": "global",
			}, controller.UpdatePlaygroundCanvasTemplate)
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			assert.Contains(t, updated.Body.String(), `"name":"Structure chain v2"`)
			assert.Contains(t, updated.Body.String(), `"visibility":"private"`)
			var updatedRow model.PlaygroundCanvasTemplate
			require.NoError(t, db.Where("id = ?", structure.Template.ID).First(&updatedRow).Error)
			assert.Equal(t, model.PlaygroundCanvasTemplateVisibilityPrivate, updatedRow.Visibility)

			// Export the inline template as a zip; another account imports it
			// with its asset bytes and a rewritten source mapping.
			exported := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvas-templates/"+inline.Template.ID+"/export", nil, controller.ExportPlaygroundCanvasTemplate)
			require.Equal(t, http.StatusOK, exported.Code, exported.Body.String())
			assert.Contains(t, exported.Header().Get("Content-Disposition"), "Inline chain.zip")
			assert.Equal(t, "private, no-store", exported.Header().Get("Cache-Control"))
			manifest, members := canvasTemplateMembers(t, exported.Body.Bytes())
			assert.Equal(t, "new-api-canvas-template", manifest["format"])
			assert.Equal(t, "Inline chain", manifest["name"])
			resourcesList := manifest["resources"].([]any)
			require.Len(t, resourcesList, 1)
			resource := resourcesList[0].(map[string]any)
			assert.Equal(t, attachmentID, resource["attachment_id"])
			assert.Equal(t, png, members[resource["entry"].(string)])

			imported := playgroundImportCanvasTemplate(t, 9, "/api/playground/canvas-templates/import", exported.Body.Bytes(), controller.ImportPlaygroundCanvasTemplate)
			require.Equal(t, http.StatusOK, imported.Code, imported.Body.String())
			var importedEnvelope struct {
				Data struct {
					Template struct {
						ID           string `json:"id"`
						InlineAssets bool   `json:"inline_assets"`
						AssetCount   int    `json:"asset_count"`
					} `json:"template"`
					AssetsInlined     int `json:"assets_inlined"`
					ReferencesDropped int `json:"references_dropped"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(imported.Body.Bytes(), &importedEnvelope))
			assert.True(t, importedEnvelope.Data.Template.InlineAssets)
			assert.Equal(t, 1, importedEnvelope.Data.Template.AssetCount)
			assert.Equal(t, 1, importedEnvelope.Data.AssetsInlined)
			assert.Zero(t, importedEnvelope.Data.ReferencesDropped)
			var importedRow model.PlaygroundCanvasTemplate
			require.NoError(t, db.Where("id = ?", importedEnvelope.Data.Template.ID).First(&importedRow).Error)
			assert.Equal(t, 9, importedRow.UserID)
			assert.Contains(t, string(importedRow.Document), attachmentID)
			var importedAssets []model.PlaygroundCanvasTemplateAsset
			require.NoError(t, db.Where("template_id = ?", importedRow.ID).Find(&importedAssets).Error)
			require.Len(t, importedAssets, 1)
			assert.Equal(t, attachmentID, importedAssets[0].SourceAttachmentID)
			importedBytes, err := base64.StdEncoding.DecodeString(string(importedAssets[0].Data))
			require.NoError(t, err)
			assert.Equal(t, png, importedBytes)

			// A structure-only archive imports with no resources.
			structureArchive := playgroundRequest(t, 7, http.MethodGet, "/api/playground/canvas-templates/"+structure.Template.ID+"/export", nil, controller.ExportPlaygroundCanvasTemplate).Body.Bytes()
			structureManifest, structureMembers := canvasTemplateMembers(t, structureArchive)
			assert.Equal(t, false, structureManifest["inline_assets"])
			assert.Empty(t, structureMembers)
			structureImport := playgroundImportCanvasTemplate(t, 9, "/api/playground/canvas-templates/import", structureArchive, controller.ImportPlaygroundCanvasTemplate)
			require.Equal(t, http.StatusOK, structureImport.Code, structureImport.Body.String())
			assert.Contains(t, structureImport.Body.String(), `"assets_inlined":0`)

			// A malformed archive is rejected before any row is written.
			assert.Equal(t, http.StatusBadRequest, playgroundImportCanvasTemplate(t, 9, "/api/playground/canvas-templates/import", []byte("not a zip"), controller.ImportPlaygroundCanvasTemplate).Code)

			// The private budget is shared by create and market copy.
			usePlaygroundQuotaDefaults(t, func(policy *playground_setting.PlaygroundQuotaPolicy) {
				policy.CanvasTemplateUserMaxCount = 2
			})
			overflow := playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvas-templates", map[string]any{
				"canvas_id": canvasID, "name": "One too many", "inline_assets": false,
			}, controller.CreatePlaygroundCanvasTemplate)
			assert.Equal(t, http.StatusUnprocessableEntity, overflow.Code, overflow.Body.String())
			assert.Contains(t, overflow.Body.String(), "PLAYGROUND_CANVAS_TEMPLATE_LIMIT_EXCEEDED")
			assert.Equal(t, http.StatusOK, playgroundRequest(t, 7, http.MethodDelete, "/api/playground/canvas-templates/"+structure.Template.ID, nil, controller.DeletePlaygroundCanvasTemplate).Code)
			require.NoError(t, db.Where("user_id = ?", 7).First(&usage).Error)
			assert.EqualValues(t, 1, usage.CanvasTemplateCount)
			assert.EqualValues(t, inlineSize, usage.CanvasTemplateBytes)
			createdAfterDelete := playgroundRequest(t, 7, http.MethodPost, "/api/playground/canvas-templates", map[string]any{
				"canvas_id": canvasID, "name": "Replacement", "inline_assets": false,
			}, controller.CreatePlaygroundCanvasTemplate)
			assert.Equal(t, http.StatusOK, createdAfterDelete.Code, createdAfterDelete.Body.String())

			// A deleted official template is not resurrected by the next seed,
			// and the administrator can update the remaining global rows.
			require.Equal(t, http.StatusOK, playgroundRequest(t, 9, http.MethodPatch, "/api/playground/canvas-templates/global/pgct_official_summary", map[string]any{
				"name": "Official summary v2",
			}, controller.UpdateGlobalPlaygroundCanvasTemplate).Code)
			require.Equal(t, http.StatusOK, playgroundRequest(t, 9, http.MethodDelete, "/api/playground/canvas-templates/global/pgct_official_translation", nil, controller.DeleteGlobalPlaygroundCanvasTemplate).Code)
			require.NoError(t, model.SeedPlaygroundCanvasTemplates(db))
			market := playgroundRequest(t, 8, http.MethodGet, "/api/playground/canvas-templates/market", nil, controller.ListPlaygroundCanvasTemplateMarket)
			assert.Contains(t, market.Body.String(), `"total":3`)
			assert.NotContains(t, market.Body.String(), "pgct_official_translation")
			assert.Contains(t, market.Body.String(), "Official summary v2")
		})
	}
}
