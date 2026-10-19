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
import { expect, test } from 'vitest'

import {
  parsePromptSnippetFile,
  PROMPT_SNIPPET_FILE_ERROR,
} from '../prompt-template-file'

const document = {
  format: 'new-api-playground-prompt-template',
  schema_version: 1,
  exported_at: 1700000000,
  template: {
    name: '  Review checklist  ',
    production_version: 2,
    versions: [
      { version: 1, content: 'First body.', created_at: 100 },
      { version: 2, content: 'Second body.', created_at: 200 },
    ],
  },
}

test('parsing a round-tripped export preserves versions, pointer and timestamps', () => {
  expect(parsePromptSnippetFile(JSON.stringify(document))).toEqual({
    format: 'new-api-playground-prompt-template',
    schemaVersion: 1,
    exportedAt: 1700000000,
    template: {
      name: 'Review checklist',
      productionVersion: 2,
      versions: [
        { version: 1, content: 'First body.', createdAt: 100 },
        { version: 2, content: 'Second body.', createdAt: 200 },
      ],
    },
  })
})

test.each([
  ['broken JSON', '{"format":'],
  ['unknown format', JSON.stringify({ ...document, format: 'other' })],
  ['unknown schema', JSON.stringify({ ...document, schema_version: 2 })],
  [
    'missing template',
    JSON.stringify({ format: document.format, schema_version: 1 }),
  ],
  [
    'blank name',
    JSON.stringify({
      ...document,
      template: { ...document.template, name: '  ' },
    }),
  ],
  [
    'empty versions',
    JSON.stringify({
      ...document,
      template: { ...document.template, versions: [] },
    }),
  ],
  [
    'gapped versions',
    JSON.stringify({
      ...document,
      template: {
        ...document.template,
        versions: [
          { version: 1, content: 'First body.' },
          { version: 3, content: 'Third body.' },
        ],
      },
    }),
  ],
  [
    'missing production pointer',
    JSON.stringify({
      ...document,
      template: { ...document.template, production_version: 0 },
    }),
  ],
  [
    'out-of-range production pointer',
    JSON.stringify({
      ...document,
      template: { ...document.template, production_version: 3 },
    }),
  ],
  [
    'non-string content',
    JSON.stringify({
      ...document,
      template: {
        ...document.template,
        versions: [{ version: 1, content: 42 }],
      },
    }),
  ],
])('rejects an %s document with the stable file error', (_, input) => {
  expect(() => parsePromptSnippetFile(input)).toThrow(
    new Error(PROMPT_SNIPPET_FILE_ERROR)
  )
})
