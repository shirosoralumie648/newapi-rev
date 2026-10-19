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
  isPromptTemplateVariableResolved,
  parsePromptTemplateVariables,
  renderPromptTemplate,
  unresolvedPromptTemplateVariables,
} from '../prompt-template'

test('parsing keeps first-appearance order, defaults and occurrence counts', () => {
  const variables = parsePromptTemplateVariables(
    'Summarize {{topic:general}} for {{audience}} in {{topic}} tone.'
  )

  expect(variables).toEqual([
    {
      name: 'topic',
      hasDefault: true,
      defaultValue: 'general',
      occurrences: 2,
    },
    {
      name: 'audience',
      hasDefault: false,
      defaultValue: '',
      occurrences: 1,
    },
  ])
})

test('malformed placeholders stay literal instead of becoming variables', () => {
  const content = 'Keep {{not a valid name}} and {{}} and {{ok}}.'

  expect(parsePromptTemplateVariables(content)).toEqual([
    {
      name: 'ok',
      hasDefault: false,
      defaultValue: '',
      occurrences: 1,
    },
  ])
  expect(renderPromptTemplate(content, { ok: 'value' })).toBe(
    'Keep {{not a valid name}} and {{}} and value.'
  )
})

test('rendering prefers a supplied value and falls back to the declared default', () => {
  expect(
    renderPromptTemplate('Hello {{name:world}}, {{name}}!', {
      name: 'Ada',
    })
  ).toBe('Hello Ada, Ada!')
  expect(renderPromptTemplate('Hello {{name:world}}!', {})).toBe('Hello world!')
  expect(renderPromptTemplate('Hello {{name:world}}!', { name: '   ' })).toBe(
    'Hello world!'
  )
})

test('a variable without a default stays literal until the owner fills it', () => {
  expect(renderPromptTemplate('Hello {{name}}!', {})).toBe('Hello {{name}}!')
  expect(renderPromptTemplate('Hello {{name}}!', { name: 'Ada' })).toBe(
    'Hello Ada!'
  )
})

test('a default declared by one occurrence applies to every occurrence of the name', () => {
  expect(renderPromptTemplate('{{topic:general}} / {{topic}}', {})).toBe(
    'general / general'
  )
  expect(
    renderPromptTemplate('{{topic}} / {{topic:general}}', {
      topic: 'custom',
    })
  ).toBe('custom / custom')
})

test('variables with a default count as resolved while blank required variables do not', () => {
  const [withDefault, required] = parsePromptTemplateVariables(
    '{{tone:neutral}} {{subject}}'
  )

  expect(isPromptTemplateVariableResolved(withDefault, '')).toBe(true)
  expect(isPromptTemplateVariableResolved(required, '')).toBe(false)
  expect(isPromptTemplateVariableResolved(required, '   ')).toBe(false)
  expect(isPromptTemplateVariableResolved(required, 'release notes')).toBe(true)
  expect(
    unresolvedPromptTemplateVariables([withDefault, required], {
      subject: 'release notes',
    })
  ).toEqual([])
})

test('parsing stops at the variable count bound without dropping later text', () => {
  const variables = Array.from(
    { length: 33 },
    (_, index) => `{{v${index}}}`
  ).join(' ')
  const parsed = parsePromptTemplateVariables(variables)

  expect(parsed).toHaveLength(32)
  expect(parsed[31].name).toBe('v31')
  expect(renderPromptTemplate(variables, { v32: 'late' })).toContain('late')
})
