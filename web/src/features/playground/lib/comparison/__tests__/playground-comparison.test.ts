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
import { describe, expect, test } from 'vitest'

import type {
  ChatCompletionResponse,
  PlaygroundComparisonCell,
  PlaygroundComparisonRun,
  PlaygroundMessageCost,
} from '../../../types'
import {
  buildComparisonEstimateSteps,
  comparisonCellKey,
  comparisonChoiceOutput,
  comparisonCostSummary,
  comparisonDifferenceQuota,
  comparisonErrorCode,
  comparisonExportContent,
  comparisonExportFileName,
  comparisonExportRows,
  comparisonRequestIds,
  comparisonRunCell,
  comparisonShouldStopAfterError,
  comparisonStoredError,
  comparisonStoredOutput,
  normalizeComparisonModels,
  parseComparisonPrompts,
  truncateComparisonText,
} from '../playground-comparison'

function makeCell(
  overrides: Partial<PlaygroundComparisonCell> = {}
): PlaygroundComparisonCell {
  return {
    promptIndex: 0,
    modelIndex: 0,
    status: 'succeeded',
    output: 'answer',
    error: '',
    errorCode: '',
    requestId: 'req-1',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    latencyMs: 120,
    ...overrides,
  }
}

function makeRun(
  overrides: Partial<PlaygroundComparisonRun> = {}
): PlaygroundComparisonRun {
  const models = overrides.models ?? ['a', 'b']
  const prompts = overrides.prompts ?? ['p1', 'p2']
  return {
    id: 'run-1',
    title: 'Example run',
    group: 'default',
    models,
    prompts,
    results: [makeCell()],
    status: 'completed',
    strategy: 'concurrent',
    concurrency: 2,
    estimateQuota: 100,
    budgetCap: 0,
    baselineModel: '',
    modelCount: models.length,
    promptCount: prompts.length,
    byteSize: 512,
    revision: 1,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    ...overrides,
  }
}

function makeCost(
  overrides: Partial<PlaygroundMessageCost> = {}
): PlaygroundMessageCost {
  return {
    requestId: 'req-1',
    quota: 42,
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
    modelName: 'a',
    createdAt: 1_700_000_000,
    ...overrides,
  }
}

function makeResponse(content: string): ChatCompletionResponse {
  return {
    id: 'chat-1',
    object: 'chat.completion',
    created: 1,
    model: 'a',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
  }
}

describe('parseComparisonPrompts', () => {
  test('treats each non-empty line as one trimmed prompt', () => {
    expect(parseComparisonPrompts(' first \r\n\nsecond\n')).toEqual({
      prompts: ['first', 'second'],
      invalidLines: [],
    })
  })

  test('reads JSONL objects with prompt, content and last-user-message shapes', () => {
    const raw = [
      '{"prompt":"alpha"}',
      '"beta"',
      '{"content":"gamma"}',
      '{"messages":[{"role":"assistant","content":"no"},{"role":"user","content":"delta"}]}',
      '{"text":["epsilon"]}',
    ].join('\n')
    expect(parseComparisonPrompts(raw)).toEqual({
      prompts: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
      invalidLines: [],
    })
  })

  test('reports malformed JSONL lines by 1-based line number', () => {
    expect(parseComparisonPrompts('{"prompt":"ok"}\n{"prompt":\nlast')).toEqual(
      {
        prompts: ['ok', 'last'],
        invalidLines: [2],
      }
    )
  })

  test('reports a JSONL object that carries no prompt text', () => {
    expect(parseComparisonPrompts('{"other":1}')).toEqual({
      prompts: [],
      invalidLines: [1],
    })
  })
})

describe('normalizeComparisonModels', () => {
  test('trims, drops empties and duplicates, and caps the selection', () => {
    expect(
      normalizeComparisonModels([' a ', '', 'a', 'b', 'c', 'd', 'e', 'f', 'g'])
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })
})

describe('buildComparisonEstimateSteps', () => {
  test('builds one prompt-major chat step per cell with the group', () => {
    const steps = buildComparisonEstimateSteps(
      ['a', 'b'],
      ['one', 'two'],
      'pro'
    )
    expect(steps.map((step) => step.nodeId)).toEqual([
      'pgc-0-0',
      'pgc-0-1',
      'pgc-1-0',
      'pgc-1-1',
    ])
    expect(steps.map((step) => step.model)).toEqual(['a', 'b', 'a', 'b'])
    expect(steps.every((step) => step.kind === 'chat')).toBe(true)
    expect(steps.every((step) => step.group === 'pro')).toBe(true)
    expect(steps[0].tokens).toBeGreaterThan(0)
    expect(steps[0].tokens).toBe(steps[1].tokens)
  })
})

describe('matrix lookups', () => {
  test('keys a cell by both indices and looks it up in the run', () => {
    const cell = makeCell({ promptIndex: 1, modelIndex: 2 })
    expect(comparisonCellKey(cell)).toBe('1:2')
    const run = makeRun({ results: [cell] })
    expect(comparisonRunCell(run, 1, 2)).toBe(cell)
    expect(comparisonRunCell(run, 0, 0)).toBeUndefined()
  })

  test('collects unique non-empty request ids in matrix order', () => {
    const run = makeRun({
      results: [
        makeCell({ requestId: 'r1' }),
        makeCell({ modelIndex: 1, requestId: 'r1' }),
        makeCell({ modelIndex: 2, requestId: '' }),
        makeCell({ modelIndex: 3, requestId: 'r2' }),
      ],
    })
    expect(comparisonRequestIds(run)).toEqual(['r1', 'r2'])
  })
})

describe('comparisonChoiceOutput', () => {
  test('prefers content, then reasoning, then serialized tool calls', () => {
    expect(comparisonChoiceOutput(makeResponse('hi'))).toBe('hi')

    const reasoning = makeResponse('')
    reasoning.choices[0].message.reasoning_content = ' thinking '
    expect(comparisonChoiceOutput(reasoning)).toBe('thinking')

    const tool = makeResponse('   ')
    tool.choices[0].message.tool_calls = [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'f', arguments: '{}' },
      },
    ]
    expect(comparisonChoiceOutput(tool)).toContain('"name": "f"')
  })

  test('returns null when the response has no choice', () => {
    const empty = makeResponse('')
    empty.choices = []
    expect(comparisonChoiceOutput(empty)).toBeNull()
  })
})

describe('bounded text', () => {
  test('leaves a value under the byte budget untouched', () => {
    expect(truncateComparisonText('short', 64)).toBe('short')
  })

  test('cuts multi-byte text without splitting a character', () => {
    const result = truncateComparisonText('模型对比结果', 10)
    expect(result.endsWith('…')).toBe(true)
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(10)
    expect(result).toBe('模型…')
  })

  test('stores outputs and errors under their own budgets', () => {
    expect(comparisonStoredOutput('x'.repeat(100)).length).toBeLessThanOrEqual(
      12 * 1024
    )
    expect(comparisonStoredError('y'.repeat(5000)).length).toBeLessThanOrEqual(
      1500
    )
  })
})

describe('cell error classification', () => {
  test('reads the error code from both relay wire shapes', () => {
    expect(
      comparisonErrorCode({
        response: { data: { error: { code: 'insufficient_user_quota' } } },
      })
    ).toBe('insufficient_user_quota')
    expect(
      comparisonErrorCode({ response: { data: { code: 'bad_request' } } })
    ).toBe('bad_request')
    expect(comparisonErrorCode(new Error('offline'))).toBe('')
  })

  test('stops the run only for stable budget and quota codes', () => {
    expect(comparisonShouldStopAfterError('workflow_budget_exceeded')).toBe(
      true
    )
    expect(comparisonShouldStopAfterError('insufficient_user_quota')).toBe(true)
    expect(comparisonShouldStopAfterError('invalid_request_error')).toBe(false)
  })
})

describe('cost summary', () => {
  test('sums only settled cells and reports missing rows', () => {
    const run = makeRun({
      results: [
        makeCell({ requestId: 'r1' }),
        makeCell({ promptIndex: 1, requestId: 'r2' }),
        makeCell({ promptIndex: 1, modelIndex: 1, status: 'failed' }),
      ],
    })
    const costs = new Map<string, PlaygroundMessageCost>([
      ['r1', makeCost({ requestId: 'r1', quota: 30 })],
    ])
    const summary = comparisonCostSummary(run, costs)
    expect(summary).toEqual({
      actualQuota: 30,
      settledCells: 1,
      expectedCells: 2,
      hasAllCosts: false,
    })
    expect(comparisonDifferenceQuota(run, summary)).toBe(-70)

    const complete = comparisonCostSummary(
      run,
      new Map([
        ['r1', makeCost({ requestId: 'r1', quota: 30 })],
        ['r2', makeCost({ requestId: 'r2', quota: 90 })],
      ])
    )
    expect(complete.hasAllCosts).toBe(true)
    expect(complete.actualQuota).toBe(120)
  })
})

describe('export rows and formats', () => {
  test('flattens the matrix prompt-major and prefers settled figures', () => {
    const run = makeRun({
      results: [
        makeCell({ promptIndex: 0, modelIndex: 0 }),
        makeCell({ promptIndex: 0, modelIndex: 1, status: 'failed' }),
        makeCell({ promptIndex: 1, modelIndex: 0 }),
        makeCell({ promptIndex: 1, modelIndex: 1 }),
      ],
    })
    const costs = new Map([
      [
        'req-1',
        makeCost({
          quota: 42,
          promptTokens: 21,
          completionTokens: 9,
          totalTokens: 30,
          timing: {
            first_token_ms: 250,
            total_ms: 900,
            upstream_ms: 800,
            auth_ms: 5,
            channel_select_ms: 45,
          },
        }),
      ],
    ])
    const rows = comparisonExportRows(run, costs)
    expect(rows.map((row) => `${row.promptIndex}:${row.modelIndex}`)).toEqual([
      '0:0',
      '0:1',
      '1:0',
      '1:1',
    ])
    expect(rows[0]).toMatchObject({
      prompt: 'p1',
      model: 'a',
      quota: 42,
      promptTokens: 21,
      completionTokens: 9,
      totalTokens: 30,
      ttftMs: 250,
      totalMs: 900,
    })
    expect(rows[1].quota).toBeUndefined()
    expect(rows[1].ttftMs).toBeUndefined()
  })

  test('quotes CSV cells containing separators and quotes', () => {
    const run = makeRun({
      prompts: ['say "hi", now'],
      models: ['a'],
      results: [makeCell({ output: 'line1\nline2' })],
    })
    const csv = comparisonExportContent('csv', run, new Map())
    const lines = csv.split('\n')
    expect(lines[0]).toBe(
      'prompt_index,prompt,model_index,model,status,output,error,error_code,request_id,prompt_tokens,completion_tokens,total_tokens,latency_ms,quota,ttft_ms,total_ms'
    )
    expect(csv).toContain('"say ""hi"", now"')
    expect(csv).toContain('"line1\nline2"')
  })

  test('writes JSON metadata with the settled totals', () => {
    const run = makeRun({
      results: [makeCell({ requestId: 'r1' })],
    })
    const parsed = JSON.parse(
      comparisonExportContent(
        'json',
        run,
        new Map([['r1', makeCost({ quota: 60 })]])
      )
    ) as Record<string, unknown>
    expect(parsed.estimate_quota).toBe(100)
    expect(parsed.settled_quota).toBe(60)
    expect(parsed.difference_quota).toBe(-40)
    expect(parsed.settled_cells).toBe(1)
    expect(Array.isArray(parsed.rows)).toBe(true)
  })

  test('escapes separators in the Markdown table and truncates output', () => {
    const run = makeRun({
      prompts: ['a|b'],
      models: ['m'],
      results: [makeCell({ output: 'x'.repeat(5000), error: 'bad|news' })],
    })
    const markdown = comparisonExportContent('markdown', run, new Map())
    expect(markdown).toContain('| a\\|b | m |')
    expect(markdown).toContain('bad\\|news')
    expect(markdown).not.toContain('x'.repeat(1201))
  })

  test('derives a safe download name per format', () => {
    const run = makeRun({ title: 'GPT-4o vs. Claude!' })
    expect(comparisonExportFileName(run, 'csv')).toBe('GPT-4o-vs-Claude.csv')
    expect(comparisonExportFileName(run, 'json')).toBe('GPT-4o-vs-Claude.json')
    expect(comparisonExportFileName(run, 'markdown')).toBe(
      'GPT-4o-vs-Claude.md'
    )
    expect(comparisonExportFileName(makeRun({ title: '***' }), 'csv')).toBe(
      'comparison-run.csv'
    )
  })
})
