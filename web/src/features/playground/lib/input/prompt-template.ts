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
 * A variable placeholder of a prompt template. `{{name}}` has no default;
 * `{{name:default}}` falls back to `defaultValue` when the fill panel leaves
 * the field empty. The same name may appear several times and is only listed
 * once.
 */
export interface PromptTemplateVariable {
  name: string
  hasDefault: boolean
  defaultValue: string
  /** How often the placeholder occurs in the template body. */
  occurrences: number
}

/** One placeholder resolved down to its name and optional default. */
interface PromptTemplatePlaceholder {
  name: string
  hasDefault: boolean
  defaultValue: string
}

export const PROMPT_TEMPLATE_VARIABLE_MAX_COUNT = 32
export const PROMPT_TEMPLATE_VARIABLE_NAME_MAX_LENGTH = 64

const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g
const VARIABLE_NAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u

function parsePlaceholder(raw: string): PromptTemplatePlaceholder | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const separator = trimmed.indexOf(':')
  const name = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim()
  if (
    !name ||
    Array.from(name).length > PROMPT_TEMPLATE_VARIABLE_NAME_MAX_LENGTH ||
    !VARIABLE_NAME_PATTERN.test(name)
  ) {
    return null
  }
  if (separator === -1) {
    return { name, hasDefault: false, defaultValue: '' }
  }
  return {
    name,
    hasDefault: true,
    defaultValue: trimmed.slice(separator + 1).trim(),
  }
}

/**
 * List the variables of one template body in first-appearance order. Malformed
 * or unsupported placeholders stay literal text: the composer must never drop
 * text the owner wrote. The list stops at the UI bound so a pathological body
 * cannot render an unbounded form.
 */
export function parsePromptTemplateVariables(
  content: string
): PromptTemplateVariable[] {
  const variables = new Map<string, PromptTemplateVariable>()
  for (const match of content.matchAll(PLACEHOLDER_PATTERN)) {
    const placeholder = parsePlaceholder(match[1])
    if (!placeholder) continue
    const existing = variables.get(placeholder.name)
    if (existing) {
      existing.occurrences += 1
      if (!existing.hasDefault && placeholder.hasDefault) {
        existing.hasDefault = true
        existing.defaultValue = placeholder.defaultValue
      }
      continue
    }
    if (variables.size >= PROMPT_TEMPLATE_VARIABLE_MAX_COUNT) continue
    variables.set(placeholder.name, {
      name: placeholder.name,
      hasDefault: placeholder.hasDefault,
      defaultValue: placeholder.defaultValue,
      occurrences: 1,
    })
  }
  return Array.from(variables.values())
}

/**
 * Fill every placeholder of a template body. A non-blank value wins, an empty
 * value falls back to the declared default, and an unresolved placeholder is
 * left verbatim so the owner can still see and edit it. When one name occurs
 * with and without a default, the merged default from
 * `parsePromptTemplateVariables` applies to every occurrence so the fill panel
 * and the rendered text cannot disagree.
 */
export function renderPromptTemplate(
  content: string,
  values: Record<string, string>
): string {
  const defaults = new Map<string, string>()
  for (const variable of parsePromptTemplateVariables(content)) {
    if (variable.hasDefault) defaults.set(variable.name, variable.defaultValue)
  }
  return content.replace(PLACEHOLDER_PATTERN, (placeholder, raw: string) => {
    const parsed = parsePlaceholder(raw)
    if (!parsed) return placeholder
    const provided = values[parsed.name]
    if (typeof provided === 'string' && provided.trim() !== '') return provided
    const merged = defaults.get(parsed.name)
    if (merged !== undefined) return merged
    if (parsed.hasDefault) return parsed.defaultValue
    return placeholder
  })
}

/** Whether a variable is ready to insert with the given fill-panel value. */
export function isPromptTemplateVariableResolved(
  variable: PromptTemplateVariable,
  value: string | undefined
): boolean {
  if (variable.hasDefault) return true
  return typeof value === 'string' && value.trim() !== ''
}

/** The variables the fill panel still needs before the template can be used. */
export function unresolvedPromptTemplateVariables(
  variables: PromptTemplateVariable[],
  values: Record<string, string>
): PromptTemplateVariable[] {
  return variables.filter(
    (variable) =>
      !isPromptTemplateVariableResolved(variable, values[variable.name])
  )
}
