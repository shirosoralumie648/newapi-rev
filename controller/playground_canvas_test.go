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
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/playground_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The stored node kind is a shared contract between the canvas editor and the
// server. Every workflow kind the editor can create must survive document
// normalization, so a board that arranges a prompt into a model call, a
// generation task and its results is never rejected on save.
func TestPlaygroundCanvasDocumentAcceptsWorkflowNodeKinds(t *testing.T) {
	policy := playground_setting.GetPlaygroundQuotaPolicy("")
	for _, kind := range []string{
		"text", "note", "prompt", "message", "attachment", "image", "artifact",
		"model", "task", "task-result", "video", "audio", "group",
	} {
		var request playgroundCanvasRequest
		require.NoError(t, common.UnmarshalJsonStr(`{
			"document": {
				"nodes": [
					{"id": "n1", "type": "`+kind+`", "position": {"x": 1, "y": 2}, "data": {"kind": "`+kind+`"}},
					{"id": "n2", "type": "task-result", "position": {"x": 3, "y": 4}}
				],
				"edges": [{"id": "e1", "source": "n1", "target": "n2"}]
			}
		}`, &request))
		require.NotNil(t, request.Document, kind)
		_, nodeCount, edgeCount, err := normalizePlaygroundCanvasDocument(request.Document, policy)
		require.NoError(t, err, "node kind %q must be accepted", kind)
		assert.Equal(t, 2, nodeCount)
		assert.Equal(t, 1, edgeCount)
	}
}

func TestPlaygroundCanvasDocumentRejectsUnknownNodeKinds(t *testing.T) {
	policy := playground_setting.GetPlaygroundQuotaPolicy("")
	var request playgroundCanvasRequest
	require.NoError(t, common.UnmarshalJsonStr(`{
		"document": {
			"nodes": [{"id": "n1", "type": "script", "position": {"x": 0, "y": 0}}],
			"edges": []
		}
	}`, &request))
	require.NotNil(t, request.Document)

	_, _, _, err := normalizePlaygroundCanvasDocument(request.Document, policy)
	assert.ErrorIs(t, err, model.ErrPlaygroundCanvasInvalid)
}

// Workflow node data only carries display configuration and ID references, and
// it stays inside the same per-node byte budget as every other node kind.
func TestPlaygroundCanvasWorkflowNodeDataStaysBounded(t *testing.T) {
	policy := playground_setting.GetPlaygroundQuotaPolicy("")
	oversized := strings.Repeat("a", int(policy.CanvasNodeDataMaxBytes)+1)
	var request playgroundCanvasRequest
	require.NoError(t, common.UnmarshalJsonStr(`{
		"document": {
			"nodes": [{
				"id": "n1",
				"type": "model",
				"position": {"x": 0, "y": 0},
				"data": {"kind": "model", "text": "`+oversized+`"}
			}],
			"edges": []
		}
	}`, &request))
	require.NotNil(t, request.Document)

	_, _, _, err := normalizePlaygroundCanvasDocument(request.Document, policy)
	assert.ErrorIs(t, err, model.ErrPlaygroundCanvasLimit)
}
