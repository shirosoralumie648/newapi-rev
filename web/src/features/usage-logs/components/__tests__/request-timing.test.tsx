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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import i18next from 'i18next'
import { beforeAll, describe, expect, test } from 'vitest'

import type { UsageLog } from '../../data/schema'
import type { LogOtherData } from '../../types'
import { DetailsDialog } from '../dialogs/details-dialog'
import { RequestTimingBreakdown } from '../request-timing-breakdown'

const i18nKeys = {
  'Request timing': 'Request timing',
  Auth: 'Auth',
  'Channel selection': 'Channel selection',
  'Upstream first byte': 'Upstream first byte',
  'First token': 'First token',
  Total: 'Total',
  Retries: 'Retries',
  '{{value}}ms': '{{value}}ms',
  '{{value}}s': '{{value}}s',
}

beforeAll(() => {
  i18next.addResourceBundle('en', 'translation', i18nKeys)
})

// The value of a breakdown row is its sibling, exactly like the other
// label/value rows of the log details.
function rowValue(label: string): string | null {
  return screen.getByText(label).nextElementSibling?.textContent ?? null
}

function makeLog(other: LogOtherData): UsageLog {
  return {
    id: 1,
    user_id: 1,
    created_at: 1,
    type: 2,
    content: '',
    username: 'user',
    token_name: 'token',
    model_name: 'gpt-test',
    quota: 5000,
    prompt_tokens: 10,
    completion_tokens: 20,
    use_time: 2,
    is_stream: true,
    channel: 1,
    channel_name: 'channel',
    token_id: 1,
    group: 'default',
    ip: '',
    other: JSON.stringify(other),
    request_id: 'req-1',
    upstream_request_id: '',
  }
}

function renderDetails(other: LogOtherData): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const freshAt = Date.now() + 60_000
  queryClient.setQueryData(['status'], {}, { updatedAt: freshAt })
  queryClient.setQueryData(
    ['pricing'],
    { data: [], vendors: [] },
    { updatedAt: freshAt }
  )

  render(
    <QueryClientProvider client={queryClient}>
      <DetailsDialog
        log={makeLog(other)}
        isAdmin={false}
        isRoot={false}
        open
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>
  )
  return queryClient
}

describe('request timing breakdown', () => {
  test('renders the observed phases with millisecond and second units', () => {
    render(
      <RequestTimingBreakdown
        timing={{ auth_ms: 24, upstream_ms: 411, first_token_ms: 1320 }}
      />
    )

    expect(rowValue('Auth')).toBe('24ms')
    expect(rowValue('Upstream first byte')).toBe('411ms')
    expect(rowValue('First token')).toBe('1.32s')
    // Phases the gateway never reached are absent, not zero.
    expect(screen.queryByText('Channel selection')).toBeNull()
    expect(screen.queryByText('Total')).toBeNull()
  })

  test('keeps a legitimate zero-millisecond phase and reports retries', () => {
    render(<RequestTimingBreakdown timing={{ total_ms: 0, retries: 2 }} />)

    expect(rowValue('Total')).toBe('0ms')
    expect(rowValue('Retries')).toBe('2')
  })

  test('does not report retries when the first channel answered', () => {
    render(<RequestTimingBreakdown timing={{ total_ms: 120 }} />)

    expect(screen.queryByText('Retries')).toBeNull()
  })

  test('renders nothing when no phase was recorded', () => {
    const { container } = render(<RequestTimingBreakdown timing={{}} />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('request timing in log details', () => {
  test('shows every recorded phase of a main entry', () => {
    const queryClient = renderDetails({
      request_timing: {
        total_ms: 1320,
        auth_ms: 24,
        channel_select_ms: 8,
        upstream_ms: 411,
        first_token_ms: 445,
        retries: 1,
      },
    })

    expect(screen.getByText('Request timing')).toBeInTheDocument()
    expect(rowValue('Auth')).toBe('24ms')
    expect(rowValue('Channel selection')).toBe('8ms')
    expect(rowValue('Upstream first byte')).toBe('411ms')
    expect(rowValue('First token')).toBe('445ms')
    expect(rowValue('Total')).toBe('1.32s')
    expect(rowValue('Retries')).toBe('1')
    queryClient.clear()
  })

  test('omits the section for a log stored before the field existed', () => {
    const queryClient = renderDetails({
      request_path: '/v1/chat/completions',
    })

    expect(screen.queryByText('Request timing')).toBeNull()
    queryClient.clear()
  })
})
