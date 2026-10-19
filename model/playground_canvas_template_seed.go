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
package model

import (
	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// playgroundCanvasTemplateSeed is one built-in chain template. The seeds are
// structure only: they carry prompts, model/task steps and edges, but no
// session, message or attachment references, so every account can apply them
// without sharing another account's resources.
type playgroundCanvasTemplateSeed struct {
	ID          string
	SystemKey   string
	Name        string
	Description string
	Category    string
	Document    map[string]any
}

// SeedPlaygroundCanvasTemplates creates the official chain templates once per
// installation. A template is identified by its SystemKey and fixed id; the
// lookup deliberately includes soft-deleted rows, so an administrator who
// removes an official template does not get it back at the next startup.
//
// Seeding does not touch account counters: official templates are global
// platform content (user_id 0), not an account resource.
func SeedPlaygroundCanvasTemplates(db *gorm.DB) error {
	return db.Transaction(func(tx *gorm.DB) error {
		for _, seed := range playgroundCanvasTemplateSeeds() {
			var count int64
			if err := tx.Model(&PlaygroundCanvasTemplate{}).Where("system_key = ?", seed.SystemKey).Count(&count).Error; err != nil {
				return err
			}
			if count > 0 {
				continue
			}
			document, err := common.Marshal(seed.Document)
			if err != nil {
				return err
			}
			nodes, _ := seed.Document["nodes"].([]map[string]any)
			edges, _ := seed.Document["edges"].([]map[string]any)
			template := &PlaygroundCanvasTemplate{
				ID:            seed.ID,
				Name:          seed.Name,
				Description:   LongText(seed.Description),
				Category:      seed.Category,
				Visibility:    PlaygroundCanvasTemplateVisibilityGlobal,
				SystemKey:     seed.SystemKey,
				InlineAssets:  false,
				Document:      LongText(document),
				DocumentBytes: int64(len(document)),
				NodeCount:     len(nodes),
				EdgeCount:     len(edges),
			}
			if err := createPlaygroundCanvasTemplateRow(tx, 0, template, nil); err != nil {
				return err
			}
		}
		return nil
	})
}

// playgroundCanvasTemplateSeeds describes the four common chains the plan
// calls out: translation, summarization, a parallel style comparison and an
// image-to-video handoff. Model ids stay empty on purpose; the account picks a
// model it can actually call before running the chain.
func playgroundCanvasTemplateSeeds() []playgroundCanvasTemplateSeed {
	prompt := func(id, text string) map[string]any {
		return map[string]any{
			"id": id, "type": "prompt", "position": map[string]any{"x": 0, "y": 0},
			"data": map[string]any{"kind": "prompt", "text": text},
		}
	}
	step := func(id, kind, label string, x, y float64, workflow map[string]any) map[string]any {
		return map[string]any{
			"id": id, "type": kind, "position": map[string]any{"x": x, "y": y},
			"data": map[string]any{"kind": kind, "label": label, "workflow": workflow},
		}
	}
	edge := func(id, source, target string) map[string]any {
		return map[string]any{"id": id, "source": source, "target": target}
	}
	document := func(nodes, edges []map[string]any) map[string]any {
		return map[string]any{
			"viewport": map[string]any{"x": 0, "y": 0, "zoom": 0.8},
			"nodes":    nodes,
			"edges":    edges,
		}
	}
	return []playgroundCanvasTemplateSeed{
		{
			ID:          "pgct_official_translation",
			SystemKey:   "official-translation",
			Name:        "Translation chain",
			Description: "Translate a pasted text into English while preserving names, numbers and formatting.",
			Category:    "translation",
			Document: document(
				[]map[string]any{
					prompt("translate-prompt", "Paste the source text here. The model step translates it into English and only returns the translation."),
					step("translate-model", "model", "Translate", 360, 0, map[string]any{}),
				},
				[]map[string]any{edge("translate-edge", "translate-prompt", "translate-model")},
			),
		},
		{
			ID:          "pgct_official_summary",
			SystemKey:   "official-summary",
			Name:        "Summary chain",
			Description: "Summarize a long text into a short abstract followed by the key points.",
			Category:    "summary",
			Document: document(
				[]map[string]any{
					prompt("summary-prompt", "Paste the text to summarize. The model step returns a short abstract followed by the key points."),
					step("summary-model", "model", "Summarize", 360, 0, map[string]any{}),
				},
				[]map[string]any{edge("summary-edge", "summary-prompt", "summary-model")},
			),
		},
		{
			ID:          "pgct_official_style_compare",
			SystemKey:   "official-style-compare",
			Name:        "Parallel style comparison",
			Description: "Send one prompt to three model steps and compare their styles side by side.",
			Category:    "comparison",
			Document: document(
				[]map[string]any{
					prompt("compare-prompt", "Describe the subject once. The three model steps below each receive the same prompt so their styles can be compared."),
					step("compare-model-a", "model", "Model A", 360, -140, map[string]any{}),
					step("compare-model-b", "model", "Model B", 360, 40, map[string]any{}),
					step("compare-model-c", "model", "Model C", 360, 220, map[string]any{}),
				},
				[]map[string]any{
					edge("compare-edge-a", "compare-prompt", "compare-model-a"),
					edge("compare-edge-b", "compare-prompt", "compare-model-b"),
					edge("compare-edge-c", "compare-prompt", "compare-model-c"),
				},
			),
		},
		{
			ID:          "pgct_official_image_video",
			SystemKey:   "official-image-video",
			Name:        "Image to video chain",
			Description: "Generate a reference image, then pass its result into a video generation step.",
			Category:    "image-video",
			Document: document(
				[]map[string]any{
					prompt("video-prompt", "Describe the image to generate. Choose a model on the image step, then run the video step to animate the result."),
					step("video-image-step", "task", "Image generation", 360, 0, map[string]any{"generation": "image", "size": "1024x1024", "imageCount": 1}),
					step("video-image-result", "task-result", "Image result", 720, 0, map[string]any{}),
					step("video-video-step", "task", "Video generation", 1080, 0, map[string]any{"generation": "video", "duration": 5}),
					step("video-video-result", "task-result", "Video result", 1440, 0, map[string]any{}),
					map[string]any{
						"id": "video-note", "type": "note", "position": map[string]any{"x": 360, "y": 240},
						"data": map[string]any{"kind": "note", "text": "Run the image step first. Its result becomes the reference frame for the video step."},
					},
				},
				[]map[string]any{
					edge("video-edge-prompt-image", "video-prompt", "video-image-step"),
					edge("video-edge-image-result", "video-image-step", "video-image-result"),
					edge("video-edge-image-video", "video-image-result", "video-video-step"),
					edge("video-edge-video-result", "video-video-step", "video-video-result"),
				},
			),
		},
	}
}
