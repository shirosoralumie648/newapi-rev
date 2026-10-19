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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { PlaygroundWebSearchSection } from '../playground-web-search-section'

type WebSearchBody = { web_search: string; api_key?: string }

function webSearchBody(): WebSearchBody | undefined {
  return vi
    .mocked(api.put)
    .mock.calls.map((call) => [call[0], call[1]] as [string, WebSearchBody])
    .find(([url]) => url === '/api/option/playground/web_search')?.[1]
}

function Fixture(props: { webSearchJson: string }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <PlaygroundWebSearchSection webSearchJson={props.webSearchJson} />
      </SettingsPageProvider>
    </>
  )
}

function renderSection(webSearch: Record<string, unknown> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Fixture webSearchJson={JSON.stringify(webSearch)} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

test('saving an enabled hosted provider sends the config and a replacement key together', async () => {
  const user = userEvent.setup()
  renderSection()

  await user.click(
    screen.getByRole('switch', {
      name: 'Enable web search for Playground turns',
    })
  )
  fireEvent.change(
    screen.getByRole('spinbutton', { name: 'Web search unit price (USD)' }),
    { target: { value: '0.02' } }
  )
  await user.type(
    screen.getByLabelText('Search provider API key'),
    'tvly-secret'
  )
  await user.click(screen.getByRole('button', { name: 'Save web search' }))

  await waitFor(() => expect(webSearchBody()).toBeDefined())
  const body = webSearchBody()
  expect(JSON.parse(body?.web_search ?? '{}')).toEqual({
    enabled: true,
    provider: 'tavily',
    base_url: '',
    price_usd_per_call: 0.02,
    group_price_usd_per_call: {},
  })
  expect(body?.api_key).toBe('tvly-secret')
})

test('a group override is saved in the same provider JSON', async () => {
  const user = userEvent.setup()
  renderSection()

  await user.type(screen.getByPlaceholderText('Enter a group name'), 'vip')
  await user.click(screen.getByRole('button', { name: 'Add group' }))
  fireEvent.change(
    screen.getByRole('spinbutton', { name: 'Price per search (USD)' }),
    { target: { value: '0.01' } }
  )
  await user.click(screen.getByRole('button', { name: 'Save web search' }))

  await waitFor(() => expect(webSearchBody()).toBeDefined())
  const body = webSearchBody()
  expect(JSON.parse(body?.web_search ?? '{}')).toMatchObject({
    group_price_usd_per_call: { vip: 0.01 },
  })
  expect(body?.api_key).toBeUndefined()
})

test('SearXNG without a base URL shows a field error and does not save', async () => {
  renderSection({
    enabled: false,
    provider: 'searxng',
    base_url: '',
    price_usd_per_call: 0,
    group_price_usd_per_call: {},
  })

  fireEvent.click(screen.getByRole('button', { name: 'Save web search' }))

  const baseURL = screen.getByLabelText('Provider base URL')
  await waitFor(() => expect(baseURL).toHaveAttribute('aria-invalid', 'true'))
  expect(screen.getByText('A SearXNG base URL is required.')).toBeVisible()
  expect(api.put).not.toHaveBeenCalled()
})

test('an unchanged configuration without a replacement key is not saved again', async () => {
  renderSection({
    enabled: true,
    provider: 'brave',
    base_url: 'https://api.search.brave.com',
    price_usd_per_call: 0.02,
    group_price_usd_per_call: {},
  })

  fireEvent.click(screen.getByRole('button', { name: 'Save web search' }))

  await waitFor(() => expect(api.put).not.toHaveBeenCalled())
})
