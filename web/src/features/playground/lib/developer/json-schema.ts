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
 * Machine reason of one schema mismatch. The renderer translates each reason
 * instead of storing English text here, so the check itself stays
 * presentation-free and testable.
 */
export type JsonSchemaViolationReason =
  | 'type'
  | 'required'
  | 'additionalProperties'
  | 'enum'
  | 'const'
  | 'minimum'
  | 'maximum'
  | 'minLength'
  | 'maxLength'
  | 'minItems'
  | 'maxItems'
  | 'anyOf'
  | 'allOf'

export interface JsonSchemaViolation {
  /** JSON path of the offending value, for example `$.items[0].name`. */
  path: string
  reason: JsonSchemaViolationReason
  /** Property name, expected type or similar detail of the reason. */
  detail?: string
}

export interface JsonSchemaCheckResult {
  /** True while the value satisfies the supported subset of the schema. */
  valid: boolean
  violations: JsonSchemaViolation[]
}

// A response is user-facing text, not a data pipeline: the checker bounds its
// own work so a pathological schema or payload cannot freeze the renderer.
const MAX_CHECKED_DEPTH = 32
const MAX_REPORTED_VIOLATIONS = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isRecord(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      // An unknown type keyword is not checkable, so it never fails a value.
      return true
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Checks a value against the subset of JSON Schema the Playground understands:
 * `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`,
 * `const`, the numeric/length/item bounds, and `anyOf`/`allOf` combinations.
 * Keywords outside this subset are ignored, exactly like a validator that does
 * not implement them: the preview never claims a mismatch it cannot prove.
 */
function checkSchemaNode(
  schema: unknown,
  value: unknown,
  path: string,
  violations: JsonSchemaViolation[],
  depth: number
): void {
  if (
    !isRecord(schema) ||
    violations.length >= MAX_REPORTED_VIOLATIONS ||
    depth > MAX_CHECKED_DEPTH
  ) {
    return
  }

  const types = Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : []
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    violations.push({ path, reason: 'type', detail: types.join(' | ') })
    return
  }

  if (schema.const !== undefined && !sameJson(schema.const, value)) {
    violations.push({ path, reason: 'const' })
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((allowed) => sameJson(allowed, value))
  ) {
    violations.push({ path, reason: 'enum' })
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      checkSchemaNode(sub, value, path, violations, depth + 1)
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((sub) => {
      const probe: JsonSchemaViolation[] = []
      checkSchemaNode(sub, value, path, probe, depth + 1)
      return probe.length === 0
    })
    if (!matches) {
      violations.push({ path, reason: 'anyOf' })
    }
  }

  if (typeof value === 'string') {
    if (
      typeof schema.minLength === 'number' &&
      value.length < schema.minLength
    ) {
      violations.push({
        path,
        reason: 'minLength',
        detail: String(schema.minLength),
      })
    }
    if (
      typeof schema.maxLength === 'number' &&
      value.length > schema.maxLength
    ) {
      violations.push({
        path,
        reason: 'maxLength',
        detail: String(schema.maxLength),
      })
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      violations.push({
        path,
        reason: 'minimum',
        detail: String(schema.minimum),
      })
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      violations.push({
        path,
        reason: 'maximum',
        detail: String(schema.maximum),
      })
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      violations.push({
        path,
        reason: 'minItems',
        detail: String(schema.minItems),
      })
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      violations.push({
        path,
        reason: 'maxItems',
        detail: String(schema.maxItems),
      })
    }
    if (isRecord(schema.items)) {
      value.forEach((item, index) => {
        checkSchemaNode(
          schema.items,
          item,
          `${path}[${index}]`,
          violations,
          depth + 1
        )
      })
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : []
    for (const key of required) {
      if (!(key in value)) {
        violations.push({ path, reason: 'required', detail: key })
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${path}.${key}`
      if (key in properties) {
        checkSchemaNode(properties[key], item, childPath, violations, depth + 1)
        continue
      }
      if (schema.additionalProperties === false) {
        violations.push({ path, reason: 'additionalProperties', detail: key })
        continue
      }
      if (isRecord(schema.additionalProperties)) {
        checkSchemaNode(
          schema.additionalProperties,
          item,
          childPath,
          violations,
          depth + 1
        )
      }
    }
  }
}

/** Checks one parsed response value against a stored JSON Schema. */
export function checkJsonAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>
): JsonSchemaCheckResult {
  const violations: JsonSchemaViolation[] = []
  checkSchemaNode(schema, value, '$', violations, 0)
  return { valid: violations.length === 0, violations }
}

/**
 * Parses one assistant answer as JSON. Models frequently wrap structured
 * answers in a fenced code block, so a single outer fence is unwrapped before
 * parsing; anything else is invalid JSON and reported as such.
 */
export function parseStructuredJson(
  content: string
): { ok: true; value: unknown } | { ok: false } {
  let text = content.trim()
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fence) {
    text = fence[1].trim()
  }
  if (!text) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}
