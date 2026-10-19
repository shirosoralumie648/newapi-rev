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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import type { ChatCompletionRequest } from '../../../types'
import { PlaygroundRequestViewer } from '../playground-request-viewer'

const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const payload: ChatCompletionRequest = {
  model: 'gpt-4o',
  group: 'default',
  stream: false,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${PIXEL_PNG_BASE64}` },
        },
      ],
    },
  ],
}

test('offers an empty state before the first send was captured', () => {
  render(
    <PlaygroundRequestViewer
      open
      onOpenChange={() => undefined}
      request={null}
    />
  )

  expect(screen.getByText('No request captured')).toBeVisible()
  expect(screen.queryByRole('tab', { name: 'Messages JSON' })).toBeNull()
})

test('copies the redacted Messages JSON of the captured request', async () => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText')
  render(
    <PlaygroundRequestViewer
      open
      onOpenChange={() => undefined}
      request={{ payload, capturedAt: Date.now() }}
    />
  )

  const panel = await screen.findByRole('textbox', { name: 'Messages JSON' })
  expect(panel).toHaveTextContent('attachment://attachment-1.png')
  expect(panel).not.toHaveTextContent(PIXEL_PNG_BASE64)
  expect(
    screen.getByText(
      '"group" is a Playground-only routing field; the /v1 endpoint uses the API token group instead.'
    )
  ).toBeVisible()

  await user.click(screen.getByRole('button', { name: 'Copy Messages JSON' }))

  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('attachment://attachment-1.png')
    )
  )
  expect(writeText.mock.calls[0][0]).not.toContain(PIXEL_PNG_BASE64)
})

test('serves every export tab and shows the cURL command with a placeholder key', async () => {
  const user = userEvent.setup()
  render(
    <PlaygroundRequestViewer
      open
      onOpenChange={() => undefined}
      request={{ payload, capturedAt: Date.now() }}
    />
  )

  expect(screen.getByRole('tab', { name: 'Python' })).toBeVisible()
  expect(screen.getByRole('tab', { name: 'Node.js' })).toBeVisible()

  await user.click(screen.getByRole('tab', { name: 'cURL' }))

  const panel = await screen.findByRole('textbox', { name: 'cURL' })
  expect(panel).toHaveTextContent('/v1/chat/completions')
  expect(panel).toHaveTextContent('$NEWAPI_API_KEY')
  expect(panel).not.toHaveTextContent(PIXEL_PNG_BASE64)
})

test('every export tab copies its own snippet without attachment bytes', async () => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText')
  render(
    <PlaygroundRequestViewer
      open
      onOpenChange={() => undefined}
      request={{ payload, capturedAt: Date.now() }}
    />
  )

  const tabs = [
    {
      name: 'Messages JSON',
      copy: 'Copy Messages JSON',
      snippets: ['"gpt-4o"', 'attachment://attachment-1.png'],
    },
    {
      name: 'cURL',
      copy: 'Copy cURL',
      snippets: ['/v1/chat/completions', 'attachment://attachment-1.png'],
    },
    {
      name: 'Python',
      copy: 'Copy Python',
      snippets: [
        'from openai import OpenAI',
        '_attachment_data_url("attachment-1.png", "image/png")',
      ],
    },
    {
      name: 'Node.js',
      copy: 'Copy Node.js',
      snippets: [
        'import OpenAI from "openai"',
        'attachmentDataUrl("attachment-1.png", "image/png")',
      ],
    },
  ] as const

  for (const tab of tabs) {
    await user.click(screen.getByRole('tab', { name: tab.name }))
    await user.click(await screen.findByRole('button', { name: tab.copy }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0][0]
    for (const snippet of tab.snippets) {
      expect(copied).toContain(snippet)
    }
    // The bytes of the inline data URL never reach the clipboard.
    expect(copied).not.toContain(PIXEL_PNG_BASE64)
    writeText.mockClear()
  }
})
