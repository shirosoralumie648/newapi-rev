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
 * One connection of the administrator-managed MCP list as the console edits
 * it. `token` holds only a credential typed in this session; an empty value
 * keeps the stored one, and `clearToken` removes it explicitly.
 */
export type PlaygroundMCPServerDraft = {
  /** Console-only identity of the row; never serialized. */
  rowId: string
  id: string
  name: string
  url: string
  enabled: boolean
  header: string
  token: string
  hasToken: boolean
  clearToken: boolean
}

let nextDraftRowId = 0

/**
 * Console-only identity of one editor row. It stays stable while the draft is
 * edited, so typing in a field never remounts the card and loses the focus.
 */
export function createPlaygroundMCPDraftRowId(): string {
  nextDraftRowId += 1
  return `mcp-server-${nextDraftRowId}`
}

export type PlaygroundMCPDraft = {
  enabled: boolean
  servers: PlaygroundMCPServerDraft[]
}

// Mirrors setting/playground_setting/playground_mcp.go so the console rejects
// the same drafts the gateway would refuse.
export const PLAYGROUND_MCP_MAX_SERVERS = 20
export const PLAYGROUND_MCP_SERVER_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/
export const PLAYGROUND_MCP_DEFAULT_AUTH_HEADER = 'Authorization'
export const PLAYGROUND_MCP_MAX_SERVER_NAME_RUNES = 100
export const PLAYGROUND_MCP_MAX_URL_BYTES = 2048
export const PLAYGROUND_MCP_MAX_HEADER_NAME_BYTES = 64
export const PLAYGROUND_MCP_MAX_TOKEN_BYTES = 4096

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
])

export const PLAYGROUND_MCP_DEFAULTS: PlaygroundMCPDraft = {
  enabled: false,
  servers: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseServer(value: unknown): PlaygroundMCPServerDraft | null {
  if (!isRecord(value)) return null
  const token = readString(value.auth_token)
  return {
    rowId: createPlaygroundMCPDraftRowId(),
    id: readString(value.id).trim(),
    name: readString(value.name).trim(),
    url: readString(value.url).trim(),
    enabled: value.enabled === true,
    header: readString(value.header).trim(),
    token: '',
    hasToken: value.has_token === true || token.trim() !== '',
    clearToken: false,
  }
}

/**
 * Reads the stored (or redacted) MCP configuration. Console-only fields are
 * dropped and a malformed document falls back to the empty default, so a
 * broken option never blocks the rest of the settings page.
 */
export function parsePlaygroundMCP(json: string): PlaygroundMCPDraft {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(json || '{}')
    if (isRecord(value)) parsed = value
  } catch {
    parsed = {}
  }
  const servers: PlaygroundMCPServerDraft[] = []
  if (Array.isArray(parsed.servers)) {
    for (const entry of parsed.servers) {
      const server = parseServer(entry)
      if (server) servers.push(server)
    }
  }
  return { enabled: parsed.enabled === true, servers }
}

/**
 * The stored wire shape of the draft. A typed token is sent, a cleared one is
 * sent as `clear_token`, and an untouched credential is omitted so the gateway
 * keeps it. Key order is fixed so an unchanged draft compares equal.
 */
export function serializePlaygroundMCP(draft: PlaygroundMCPDraft): string {
  return JSON.stringify({
    enabled: draft.enabled,
    servers: draft.servers.map((server) => {
      const entry: Record<string, unknown> = {
        id: server.id.trim(),
        name: server.name.trim(),
        url: server.url.trim(),
        enabled: server.enabled,
        header: server.header.trim(),
      }
      if (server.clearToken) {
        entry.clear_token = true
      } else if (server.token.trim() !== '') {
        entry.auth_token = server.token
      }
      return entry
    }),
  })
}

function isValidURL(raw: string): boolean {
  if (raw === '' || raw.length > PLAYGROUND_MCP_MAX_URL_BYTES) return false
  if (/\s/.test(raw)) return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.host !== '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === ''
  )
}

function countRunes(value: string): number {
  return Array.from(value).length
}

/**
 * Field-level validation of the whole draft. Values are i18n keys so the
 * section renders translated messages and the rules stay testable. The keys
 * are `server-<index>-<field>` plus `servers` for the list-level rule.
 */
export function findPlaygroundMCPDraftErrors(
  draft: PlaygroundMCPDraft
): Record<string, string> {
  const errors: Record<string, string> = {}
  if (draft.servers.length > PLAYGROUND_MCP_MAX_SERVERS) {
    errors.servers = 'At most 20 MCP connections can be configured.'
  }
  const seen = new Set<string>()
  draft.servers.forEach((server, index) => {
    const prefix = `server-${index}`
    const id = server.id.trim()
    if (!PLAYGROUND_MCP_SERVER_ID_PATTERN.test(id)) {
      errors[`${prefix}-id`] =
        'Use 1-24 letters, digits, hyphens or underscores, starting with a letter or digit.'
    } else if (seen.has(id)) {
      errors[`${prefix}-id`] = 'Each MCP connection needs a unique id.'
    }
    seen.add(id)

    const name = server.name.trim()
    if (
      name === '' ||
      countRunes(name) > PLAYGROUND_MCP_MAX_SERVER_NAME_RUNES
    ) {
      errors[`${prefix}-name`] = 'Enter a name of at most 100 characters.'
    }

    if (!isValidURL(server.url.trim())) {
      errors[`${prefix}-url`] =
        'Enter an http(s) URL without credentials, query parameters or fragments.'
    }

    const header = server.header.trim()
    if (header !== '') {
      if (
        header.length > PLAYGROUND_MCP_MAX_HEADER_NAME_BYTES ||
        !HEADER_NAME_PATTERN.test(header)
      ) {
        errors[`${prefix}-header`] = 'Enter a valid HTTP header name.'
      } else if (RESERVED_HEADERS.has(header.toLowerCase())) {
        errors[`${prefix}-header`] =
          'This header is reserved by the MCP client.'
      }
    }

    const token = server.token
    // An untouched stored credential is still a credential: saving the list
    // without its header would make the gateway reject the whole draft.
    const keepsStoredToken = server.hasToken && !server.clearToken
    if (token !== '' || keepsStoredToken) {
      if (
        token !== '' &&
        (token.length > PLAYGROUND_MCP_MAX_TOKEN_BYTES ||
          token.includes('\u0000') ||
          /[\r\n]/.test(token))
      ) {
        errors[`${prefix}-token`] = 'The token is invalid.'
      } else if (header === '') {
        errors[`${prefix}-token`] = 'Choose a header before storing a token.'
      }
    }
  })
  return errors
}
