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
import {
  PLAYGROUND_REQUEST_API_KEY,
  normalizePlaygroundRequestBaseUrl,
} from '../developer/request-code'

export type NonChatRequestCodeTab = 'curl' | 'python' | 'node' | 'json'

/**
 * Mirrors the PG2-01 exports for the non-chat endpoints. `group` is stripped
 * before serialization because it is a Playground-only routing field; the
 * public /v1 endpoint selects the group from the API token instead.
 */
export function buildNonChatRequestBody(
  body: Record<string, unknown>
): Record<string, unknown> {
  const { group: _group, ...rest } = body
  return rest
}

export function buildNonChatRequestCode(
  tab: NonChatRequestCodeTab,
  canonicalPath: string,
  body: Record<string, unknown>,
  baseUrl: string
): string {
  const payload = buildNonChatRequestBody(body)
  const endpoint = `${normalizePlaygroundRequestBaseUrl(baseUrl)}${canonicalPath}`
  const notes = [
    '# New API Playground request: non-chat model endpoint.',
    '# It targets the OpenAI-compatible API with the placeholder key',
    `# ${PLAYGROUND_REQUEST_API_KEY}; replace it with a token of your own.`,
  ]
  if (body.group !== undefined) {
    notes.push(
      '# "group" is a Playground-only routing field.',
      `# ${canonicalPath} selects the group from the API token instead,`,
      '# so remove "group" if the endpoint rejects it.'
    )
  }
  const bodyJson = JSON.stringify(payload, null, 2)

  if (tab === 'json') return bodyJson

  if (tab === 'curl') {
    return [
      ...notes,
      `curl '${endpoint}' \\`,
      `  -H "Authorization: Bearer ${PLAYGROUND_REQUEST_API_KEY}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d '${bodyJson}'`,
    ].join('\n')
  }

  if (tab === 'python') {
    return [
      ...notes.map((note) => note.replace(/^# ?/, '# ')),
      '',
      'import json',
      'import urllib.request',
      '',
      `payload = ${bodyJson}`,
      '',
      'request = urllib.request.Request(',
      `    "${endpoint}",`,
      '    data=json.dumps(payload).encode("utf-8"),',
      '    headers={',
      `        "Authorization": "Bearer ${PLAYGROUND_REQUEST_API_KEY}",`,
      '        "Content-Type": "application/json",',
      '    },',
      '    method="POST",',
      ')',
      'with urllib.request.urlopen(request) as response:',
      '    print(json.dumps(json.load(response), indent=2, ensure_ascii=False))',
    ].join('\n')
  }

  return [
    ...notes.map((note) => note.replace(/^# ?/, '// ')),
    '',
    `const payload = ${bodyJson}`,
    '',
    `const response = await fetch('${endpoint}', {`,
    "  method: 'POST',",
    '  headers: {',
    `    Authorization: 'Bearer ${PLAYGROUND_REQUEST_API_KEY}',`,
    "    'Content-Type': 'application/json',",
    '  },',
    '  body: JSON.stringify(payload),',
    '})',
    'console.log(JSON.stringify(await response.json(), null, 2))',
  ].join('\n')
}
