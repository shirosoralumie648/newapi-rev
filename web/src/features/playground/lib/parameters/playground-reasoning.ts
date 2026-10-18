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
/**
 * The reasoning strengths the relay's conversion accepts for
 * `reasoning_effort` (see relaykit/relayconvert/reasoning.ParseEffort). The
 * empty value means the parameter stays unset and is never sent.
 */
export const PLAYGROUND_REASONING_EFFORT_VALUES = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export const PLAYGROUND_REASONING_EFFORT_OPTIONS: readonly {
  value: string
  labelKey: string
}[] = [
  { value: 'none', labelKey: 'None' },
  { value: 'minimal', labelKey: 'Minimal' },
  { value: 'low', labelKey: 'Low' },
  { value: 'medium', labelKey: 'Medium' },
  { value: 'high', labelKey: 'High' },
  { value: 'xhigh', labelKey: 'Extra high' },
  { value: 'max', labelKey: 'Maximum' },
]

// Model families whose providers accept an effort control through the relay
// conversion. The list only decides whether the Composer offers the control;
// the relay and the upstream provider stay authoritative and answer an
// unsupported combination with their own error. The heuristic compares the
// final segment of a possibly namespaced model id (for example `openai/gpt-5`).
const REASONING_EFFORT_MODEL_PATTERNS: readonly RegExp[] = [
  /^gpt-5(?:[.-]|$)/,
  /^gpt-oss/,
  /^o[1-9](?:[.-]|$)/,
  /^claude-(?:3-7|opus-[345]|sonnet-[345]|haiku-[345])/,
  /^gemini-(?:2\.5|3)(?:[.-]|$)/,
  /^deepseek-(?:reasoner|v4)/,
  /^kimi-.*thinking/,
  /^glm-(?:4\.[56]|5)(?:[.-]|$)/,
  /^qwen3(?:[.-]|$)/,
  /^grok-[34](?:[.-]|$)/,
  /^magistral/,
]

/**
 * Whether the Composer should offer the reasoning effort control for a model.
 * The server still validates the stored value and the relay validates the
 * request, so a wrong guess only hides or shows a control.
 */
export function modelSupportsReasoningEffort(model: string): boolean {
  const name = model.trim().toLowerCase()
  if (!name) return false
  const family = name.slice(name.lastIndexOf('/') + 1)
  return REASONING_EFFORT_MODEL_PATTERNS.some((pattern) => pattern.test(family))
}

/**
 * Coerces a stored or server-provided effort into a value that is safe to send,
 * or an empty string when it is absent or unknown.
 */
export function normalizeReasoningEffort(value: unknown): string {
  if (typeof value !== 'string') return ''
  const effort = value.trim().toLowerCase()
  return (PLAYGROUND_REASONING_EFFORT_VALUES as readonly string[]).includes(
    effort
  )
    ? effort
    : ''
}

/** The translation key of one effort option, or null when it is not one. */
export function getReasoningEffortLabelKey(value: unknown): string | null {
  const effort = normalizeReasoningEffort(value)
  if (!effort) return null
  const option = PLAYGROUND_REASONING_EFFORT_OPTIONS.find(
    (item) => item.value === effort
  )
  return option?.labelKey ?? null
}
