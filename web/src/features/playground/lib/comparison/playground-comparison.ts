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
import type { CanvasWorkflowEstimateStepInput } from '@/features/canvas/lib/canvas-workflow-budget'

import {
  PLAYGROUND_COMPARISON_ERROR_MAX_BYTES,
  PLAYGROUND_COMPARISON_MAX_MODELS,
  PLAYGROUND_COMPARISON_OUTPUT_MAX_BYTES,
  PLAYGROUND_COMPARISON_STOP_ERROR_CODES,
} from '../../constants'
import type {
  ChatCompletionResponse,
  PlaygroundComparisonCell,
  PlaygroundComparisonRun,
  PlaygroundMessageCost,
} from '../../types'
import { estimateTextTokens } from '../context/playground-context'

/** One prompt line the JSONL parser could not read. */
export interface ComparisonPromptParseResult {
  prompts: string[]
  invalidLines: number[]
}

function comparisonPromptFromJson(value: unknown): string | null {
  if (typeof value === 'string') {
    const prompt = value.trim()
    return prompt || null
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const prompt = comparisonPromptFromJson(entry)
      if (prompt) return prompt
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of ['prompt', 'content', 'text', 'input']) {
    const prompt = comparisonPromptFromJson(record[key])
    if (prompt) return prompt
  }
  const messages = record.messages
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (!message || typeof message !== 'object') continue
      const role = (message as Record<string, unknown>).role
      if (role !== undefined && role !== 'user') continue
      const prompt = comparisonPromptFromJson(message)
      if (prompt) return prompt
    }
  }
  return null
}

/**
 * Reads the prompt editor. Every non-empty line is one prompt; a line that
 * starts with `{`, `[` or `"` is also accepted as JSONL and may carry the text
 * under `prompt`, `content`, `text`, `input` or the last user message of
 * `messages`. A malformed JSON line is reported by number instead of being
 * sent verbatim, so a typo cannot silently become a different prompt.
 */
export function parseComparisonPrompts(
  raw: string
): ComparisonPromptParseResult {
  const prompts: string[] = []
  const invalidLines: number[] = []
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '').trim()
    if (!line) continue
    const first = line[0]
    if (first === '{' || first === '[' || first === '"') {
      try {
        const prompt = comparisonPromptFromJson(JSON.parse(line))
        if (prompt) {
          prompts.push(prompt)
          continue
        }
        invalidLines.push(index + 1)
        continue
      } catch {
        invalidLines.push(index + 1)
        continue
      }
    }
    prompts.push(line)
  }
  return { prompts, invalidLines }
}

/**
 * Trims, deduplicates and caps a model selection in the order the user picked
 * it. The server applies the owner's effective model limit again.
 */
export function normalizeComparisonModels(values: string[]): string[] {
  const seen = new Set<string>()
  const models: string[] = []
  for (const raw of values) {
    const model = raw.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }
  return models.slice(0, PLAYGROUND_COMPARISON_MAX_MODELS)
}

/**
 * One estimate step per model x prompt cell. A chat step prices the prompt's
 * pre-charge, which is what starting the cell reserves; the prompt tokens are
 * measured from the text itself and bounded by the estimate endpoint.
 */
export function buildComparisonEstimateSteps(
  models: string[],
  prompts: string[],
  group: string
): CanvasWorkflowEstimateStepInput[] {
  const steps: CanvasWorkflowEstimateStepInput[] = []
  for (let promptIndex = 0; promptIndex < prompts.length; promptIndex++) {
    const tokens = estimateTextTokens(prompts[promptIndex])
    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
      steps.push({
        nodeId: `pgc-${promptIndex}-${modelIndex}`,
        kind: 'chat',
        model: models[modelIndex],
        tokens,
        group,
      })
    }
  }
  return steps
}

/** Stable matrix key of one cell; results always carry both indices. */
export function comparisonCellKey(
  cell: Pick<PlaygroundComparisonCell, 'promptIndex' | 'modelIndex'>
): string {
  return `${cell.promptIndex}:${cell.modelIndex}`
}

/** Looks a cell up by prompt and model row of a run's matrix. */
export function comparisonRunCell(
  run: PlaygroundComparisonRun,
  promptIndex: number,
  modelIndex: number
): PlaygroundComparisonCell | undefined {
  return run.results.find(
    (cell) => cell.promptIndex === promptIndex && cell.modelIndex === modelIndex
  )
}

/**
 * Request ids of the run's finished cells, deduplicated and bounded by the
 * server lookup cap. Only ids the cost lookup can resolve are returned.
 */
export function comparisonRequestIds(run: PlaygroundComparisonRun): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const cell of run.results) {
    const requestId = cell.requestId.trim()
    if (!requestId || seen.has(requestId)) continue
    seen.add(requestId)
    ids.push(requestId)
  }
  return ids
}

/** How many cells a settle row should exist for, and how many already do. */
export interface PlaygroundComparisonCostSummary {
  actualQuota: number
  settledCells: number
  expectedCells: number
  /** True once every succeeded cell has its settle row. */
  hasAllCosts: boolean
}

export function comparisonCostSummary(
  run: PlaygroundComparisonRun,
  costs: Map<string, PlaygroundMessageCost>
): PlaygroundComparisonCostSummary {
  let actualQuota = 0
  let settledCells = 0
  let expectedCells = 0
  let missing = 0
  for (const cell of run.results) {
    if (cell.status !== 'succeeded') continue
    expectedCells++
    const requestId = cell.requestId.trim()
    const cost = requestId ? costs.get(requestId) : undefined
    if (cost) {
      actualQuota += cost.quota
      settledCells++
      continue
    }
    missing++
  }
  return {
    actualQuota,
    settledCells,
    expectedCells,
    hasAllCosts: expectedCells > 0 && missing === 0,
  }
}

/** Settled minus estimated quota; positive means the run cost more. */
export function comparisonDifferenceQuota(
  run: PlaygroundComparisonRun,
  summary: PlaygroundComparisonCostSummary
): number {
  return summary.actualQuota - run.estimateQuota
}

/** The output one completion choice contributes to the table. */
export function comparisonChoiceOutput(
  response: ChatCompletionResponse
): string | null {
  const choice = response.choices?.[0]
  if (!choice) return null
  const content = choice.message?.content?.trim()
  if (content) return content
  const reasoning = (
    choice.message?.reasoning_content ??
    choice.message?.reasoning ??
    ''
  ).trim()
  if (reasoning) return reasoning
  const toolCalls = choice.message?.tool_calls ?? []
  if (toolCalls.length > 0) return JSON.stringify(toolCalls, null, 2)
  return ''
}

/**
 * Cuts a stored value to a UTF-8 byte budget. The browser measures the same
 * budget the server enforces, so a multi-byte answer is never refused as an
 * invalid snapshot.
 */
export function truncateComparisonText(
  value: string,
  maxBytes: number
): string {
  const encoder = new TextEncoder()
  if (encoder.encode(value).length <= maxBytes) return value
  const ellipsis = '…'
  const budget = Math.max(0, maxBytes - encoder.encode(ellipsis).length)
  let used = 0
  let result = ''
  for (const char of value) {
    const size = encoder.encode(char).length
    if (used + size > budget) break
    result += char
    used += size
  }
  return result + ellipsis
}

/** The bounded output stored for one succeeded cell. */
export function comparisonStoredOutput(output: string): string {
  return truncateComparisonText(output, PLAYGROUND_COMPARISON_OUTPUT_MAX_BYTES)
}

/** The bounded error text stored for one failed cell. */
export function comparisonStoredError(error: string): string {
  return truncateComparisonText(error, PLAYGROUND_COMPARISON_ERROR_MAX_BYTES)
}

interface ComparisonErrorLike {
  response?: {
    data?: {
      code?: unknown
      error?: { code?: unknown }
    }
  }
}

/** Stable error code of a failed relay call, from either wire shape. */
export function comparisonErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const source = error as ComparisonErrorLike
  const nested = source.response?.data?.error?.code
  if (typeof nested === 'string') return nested.trim()
  const topLevel = source.response?.data?.code
  if (typeof topLevel === 'string') return topLevel.trim()
  return ''
}

/** Whether a cell error means every later cell would fail too. */
export function comparisonShouldStopAfterError(code: string): boolean {
  return PLAYGROUND_COMPARISON_STOP_ERROR_CODES.includes(code)
}

/** One flattened row of a comparison export. */
export interface PlaygroundComparisonExportRow {
  promptIndex: number
  prompt: string
  modelIndex: number
  model: string
  status: string
  output: string
  error: string
  errorCode: string
  requestId: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  /** Settled quota of the cell; absent while no settle row exists yet. */
  quota?: number
  /** Provider-observed time to first token, when the settle row recorded it. */
  ttftMs?: number
  /** Provider-observed total time, when the settle row recorded it. */
  totalMs?: number
}

/**
 * Flattens a run into matrix rows for every export format. Token counts prefer
 * the settled row; they fall back to the relay's reported usage. The quota and
 * timing columns stay empty while settlement has not produced a row.
 */
export function comparisonExportRows(
  run: PlaygroundComparisonRun,
  costs: Map<string, PlaygroundMessageCost>
): PlaygroundComparisonExportRow[] {
  const rows: PlaygroundComparisonExportRow[] = []
  for (let promptIndex = 0; promptIndex < run.prompts.length; promptIndex++) {
    for (let modelIndex = 0; modelIndex < run.models.length; modelIndex++) {
      const cell = comparisonRunCell(run, promptIndex, modelIndex)
      if (!cell) continue
      const cost = cell.requestId ? costs.get(cell.requestId) : undefined
      rows.push({
        promptIndex,
        prompt: run.prompts[promptIndex],
        modelIndex,
        model: run.models[modelIndex],
        status: cell.status,
        output: cell.output,
        error: cell.error,
        errorCode: cell.errorCode,
        requestId: cell.requestId,
        promptTokens: cost?.promptTokens ?? cell.promptTokens,
        completionTokens: cost?.completionTokens ?? cell.completionTokens,
        totalTokens: cost?.totalTokens ?? cell.totalTokens,
        latencyMs: cell.latencyMs,
        ...(cost ? { quota: cost.quota } : {}),
        ...(cost?.timing?.first_token_ms !== undefined
          ? { ttftMs: cost.timing.first_token_ms }
          : {}),
        ...(cost?.timing?.total_ms !== undefined
          ? { totalMs: cost.timing.total_ms }
          : {}),
      })
    }
  }
  return rows
}

export type PlaygroundComparisonExportFormat = 'csv' | 'json' | 'markdown'

const COMPARISON_CSV_COLUMNS = [
  'prompt_index',
  'prompt',
  'model_index',
  'model',
  'status',
  'output',
  'error',
  'error_code',
  'request_id',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'latency_ms',
  'quota',
  'ttft_ms',
  'total_ms',
] as const

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return ''
  const text = String(value)
  if (!/[",\r\n]/.test(text)) return text
  return `"${text.replaceAll('"', '""')}"`
}

/** RFC 4180 CSV of the whole matrix, UTF-8 without a byte-order mark. */
export function comparisonToCsv(
  run: PlaygroundComparisonRun,
  costs: Map<string, PlaygroundMessageCost>
): string {
  const lines = [COMPARISON_CSV_COLUMNS.join(',')]
  for (const row of comparisonExportRows(run, costs)) {
    lines.push(
      [
        row.promptIndex,
        row.prompt,
        row.modelIndex,
        row.model,
        row.status,
        row.output,
        row.error,
        row.errorCode,
        row.requestId,
        row.promptTokens,
        row.completionTokens,
        row.totalTokens,
        row.latencyMs,
        row.quota,
        row.ttftMs,
        row.totalMs,
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return lines.join('\n')
}

/** JSON export with the run metadata, estimate and settled totals. */
export function comparisonToJson(
  run: PlaygroundComparisonRun,
  costs: Map<string, PlaygroundMessageCost>
): string {
  const summary = comparisonCostSummary(run, costs)
  return JSON.stringify(
    {
      id: run.id,
      title: run.title,
      group: run.group,
      status: run.status,
      strategy: run.strategy,
      concurrency: run.concurrency,
      models: run.models,
      prompts: run.prompts,
      baseline_model: run.baselineModel,
      estimate_quota: run.estimateQuota,
      budget_cap: run.budgetCap,
      settled_quota: summary.actualQuota,
      difference_quota: comparisonDifferenceQuota(run, summary),
      settled_cells: summary.settledCells,
      expected_cells: summary.expectedCells,
      rows: comparisonExportRows(run, costs),
    },
    null,
    2
  )
}

function markdownCell(value: string | number | undefined): string {
  if (value === undefined) return ''
  return String(value)
    .replaceAll('|', '\\|')
    .replaceAll('\r\n', '<br>')
    .replaceAll('\n', '<br>')
}

/**
 * Markdown table of the matrix. Output is cut to a readable summary so one
 * long answer cannot dominate the document.
 */
export function comparisonToMarkdown(
  run: PlaygroundComparisonRun,
  costs: Map<string, PlaygroundMessageCost>
): string {
  const header =
    '| Prompt | Model | Status | Output | Tokens | Cost | TTFT | Total | Error |'
  const separator =
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |'
  const lines = [`# ${markdownCell(run.title)}`, '', header, separator]
  for (const row of comparisonExportRows(run, costs)) {
    const output = markdownCell(truncateComparisonText(row.output, 1200))
    const tokens = row.totalTokens > 0 ? String(row.totalTokens) : ''
    const cost = row.quota !== undefined ? String(row.quota) : ''
    const ttft = row.ttftMs !== undefined ? `${row.ttftMs} ms` : ''
    const total = row.totalMs !== undefined ? `${row.totalMs} ms` : ''
    const error = markdownCell(row.error)
    const errorCode = row.errorCode ? `\`${row.errorCode}\`` : ''
    lines.push(
      `| ${markdownCell(row.prompt)} | ${markdownCell(row.model)} | ${row.status} | ${output} | ${tokens} | ${cost} | ${ttft} | ${total} | ${[error, errorCode].filter(Boolean).join(' ')} |`
    )
  }
  return lines.join('\n')
}

/** The export body of one selected format. */
export function comparisonExportContent(
  format: PlaygroundComparisonExportFormat,
  run: PlaygroundComparisonRun,
  costs: Map<string, PlaygroundMessageCost>
): string {
  if (format === 'csv') return comparisonToCsv(run, costs)
  if (format === 'json') return comparisonToJson(run, costs)
  return comparisonToMarkdown(run, costs)
}

/** Download file name of one selected format. */
export function comparisonExportFileName(
  run: PlaygroundComparisonRun,
  format: PlaygroundComparisonExportFormat
): string {
  const extension = format === 'markdown' ? 'md' : format
  const base = run.title
    .trim()
    .replaceAll(/[^a-zA-Z0-9-_]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${base || 'comparison-run'}.${extension}`
}
