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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { PlaygroundSharedConversation } from '../components/share/playground-shared-conversation'

const clients: QueryClient[] = []

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <PlaygroundSharedConversation token='share-token' />
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

test('a public share renders text, tool summaries and attachment placeholders without attachment bytes', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: {
        title: 'Shared notes',
        opening_message: 'Welcome to the shared copy',
        messages: [
          {
            key: 'm1',
            from: 'user',
            content: 'Hello <script>alert(1)</script>',
            attachments: [{ filename: 'diagram.png', media_type: 'image/png' }],
          },
          {
            key: 'm2',
            from: 'assistant',
            content: 'Here is the answer.',
            tool_calls: [{ name: 'lookup', status: 'completed' }],
          },
        ],
      },
    },
  })

  mount()

  expect(
    await screen.findByRole('heading', { name: 'Shared notes' })
  ).toBeVisible()
  expect(screen.getByText('Welcome to the shared copy')).toBeVisible()
  expect(screen.getByText('Hello <script>alert(1)</script>')).toBeVisible()
  expect(document.querySelector('script')).toBeNull()
  expect(screen.getByText('lookup · Completed')).toBeVisible()
  expect(screen.getByText('diagram.png')).toBeVisible()
  expect(screen.getByText('image/png')).toBeVisible()
  expect(
    screen.getByText(
      'Attachment content is not available in shared conversations.'
    )
  ).toBeVisible()
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelector('a[href*="attachment"]')).toBeNull()
})

test('a revoked, expired or missing share link shows the same not-found state', async () => {
  vi.spyOn(api, 'get').mockRejectedValue({
    response: {
      status: 404,
      data: {
        success: false,
        code: 'PLAYGROUND_SHARE_NOT_FOUND',
        message: 'Shared conversation not found.',
      },
    },
  })

  mount()

  expect(await screen.findByText('Shared conversation not found')).toBeVisible()
  expect(
    screen.getByText('This link may have been revoked or has expired.')
  ).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})
