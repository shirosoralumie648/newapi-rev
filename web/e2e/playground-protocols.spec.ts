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
import { expect, test } from '@playwright/test'

import { signIn } from './support/auth'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

// A minimal Anthropic stream: start, one text block, usage, stop.
const MESSAGES_STREAM = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_e2e","type":"message","role":"assistant","model":"gpt-4o","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok from messages"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

test('the Messages protocol sends the Anthropic payload and exposes the raw stream', async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === '/api/user/models',
    (route) => route.fulfill({ json: { success: true, data: ['gpt-4o'] } })
  )
  await page.route(
    (url) => url.pathname === '/api/user/self/groups',
    (route) =>
      route.fulfill({
        json: { success: true, data: { default: { desc: '', ratio: 1 } } },
      })
  )
  await page.route(
    (url) => url.pathname === '/pg/messages',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: MESSAGES_STREAM,
      })
  )

  await page.goto('/playground')

  await page.getByRole('combobox', { name: 'API protocol' }).click()
  await page.getByRole('option', { name: 'Anthropic Messages' }).click()
  await page.getByPlaceholder('Ask anything').fill('Hello from E2E')

  const requestPromise = page.waitForRequest((request) =>
    request.url().endsWith('/pg/messages')
  )
  await page.getByRole('button', { name: /Send/ }).first().click()

  // The same prompt travels as an Anthropic body: max_tokens is mandatory and
  // the message list is the converted chat history.
  const request = await requestPromise
  const body = request.postDataJSON() as {
    max_tokens?: number
    messages?: Array<{ role: string; content: string }>
  }
  expect(body.max_tokens).toBeGreaterThan(0)
  expect(body.messages).toEqual([{ role: 'user', content: 'Hello from E2E' }])

  await expect(
    page.getByText('ok from messages', { exact: true })
  ).toBeVisible()

  await page.getByRole('button', { name: 'Request preview' }).click()
  await expect(page.getByText('Protocol: Anthropic Messages')).toBeVisible()
  await page.getByRole('tab', { name: 'Raw response' }).click()
  await expect(page.getByText('content_block_delta').first()).toBeVisible()
})
