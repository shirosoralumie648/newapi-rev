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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const renderMock = vi.fn()

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: renderMock,
  },
}))

vi.mock('dompurify', () => ({
  default: {
    sanitize: (value: string) => value.replace(/<script[\s\S]*?<\/script>/gi, ''),
  },
}))

import { renderMermaid } from '../mermaid-render'

beforeEach(() => {
  renderMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('renderMermaid', () => {
  test('returns the sanitized svg for a valid diagram', async () => {
    renderMock.mockResolvedValue({
      svg: '<svg><text>ok</text><script>alert(1)</script></svg>',
    })
    const result = await renderMermaid('graph TD; A-->B', false)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.svg).toContain('<svg>')
      expect(result.svg).not.toContain('<script')
    }
  })

  test('reports a parse failure instead of throwing', async () => {
    renderMock.mockRejectedValue(new Error('Parse error on line 1'))
    const result = await renderMermaid('not a diagram', false)
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.message).toContain('Parse error')
    }
  })

  test('rejects an empty source before touching mermaid', async () => {
    const result = await renderMermaid('   ', false)
    expect(result.status).toBe('error')
    expect(renderMock).not.toHaveBeenCalled()
  })

  test('renders each call with a fresh element id', async () => {
    renderMock.mockResolvedValue({ svg: '<svg></svg>' })
    await renderMermaid('graph TD; A-->B', false)
    await renderMermaid('graph TD; A-->B', false)
    const ids = renderMock.mock.calls.map((call) => call[0] as string)
    expect(new Set(ids).size).toBe(2)
  })
})
