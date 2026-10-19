import { expect, test } from '@playwright/test'

import { signIn } from './support/auth'

const REPLAY_REQUEST_ID = 'e2e-replay-log'

function usageLog(overrides: Record<string, unknown>) {
  return {
    id: 901,
    user_id: 1,
    created_at: 1_760_000_000,
    type: 2,
    content: '',
    username: 'e2e-root',
    token_name: 'e2e-token',
    model_name: 'gpt-4o',
    quota: 1200,
    prompt_tokens: 12,
    completion_tokens: 6,
    use_time: 1,
    is_stream: false,
    channel: 1,
    channel_name: 'mock',
    token_id: 1,
    group: 'default',
    ip: '',
    other: JSON.stringify({ request_path: '/v1/chat/completions' }),
    request_id: REPLAY_REQUEST_ID,
    upstream_request_id: '',
    ...overrides,
  }
}

test('opens a replayable usage log as a Playground draft without sending it', async ({
  context,
  page,
}) => {
  const logs = [
    usageLog({}),
    usageLog({
      id: 902,
      created_at: 1_759_999_000,
      model_name: 'gpt-image-1',
      request_id: 'e2e-image-log',
      other: JSON.stringify({ request_path: '/v1/images/generations' }),
    }),
  ]

  for (const pathname of ['/api/log', '/api/log/self']) {
    await context.route(
      (url) => url.pathname === pathname,
      (route) =>
        route.fulfill({
          json: {
            success: true,
            data: { items: logs, total: logs.length, page: 1, page_size: 100 },
          },
        })
    )
  }

  await context.route(
    (url) =>
      url.pathname === `/api/playground/logs/${REPLAY_REQUEST_ID}/replay`,
    (route) =>
      route.fulfill({
        json: {
          success: true,
          data: {
            request_id: REPLAY_REQUEST_ID,
            model: 'gpt-4o',
            group: 'default',
            stream: false,
            content_available: true,
            sampling: { temperature: 0.4, max_tokens: 512 },
            capture: {
              request: {
                messages: [
                  { role: 'system', content: 'Answer briefly.' },
                  { role: 'user', content: 'reproduce this request' },
                ],
              },
            },
          },
        },
      })
  )

  await context.route(
    (url) => url.pathname === '/api/user/models',
    (route) => route.fulfill({ json: { success: true, data: ['gpt-4o'] } })
  )
  await context.route(
    (url) => url.pathname === '/api/user/self/groups',
    (route) =>
      route.fulfill({
        json: { success: true, data: { default: { desc: '', ratio: 1 } } },
      })
  )

  let chatRequests = 0
  await context.route(
    (url) => url.pathname === '/pg/chat/completions',
    (route) => {
      chatRequests += 1
      return route.fulfill({
        json: {
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'unexpected' },
              finish_reason: 'stop',
            },
          ],
        },
      })
    }
  )

  await signIn(page)
  await page.goto('/usage-logs/common')

  const replayLinks = page.getByRole('link', { name: 'Open in Playground' })
  await expect(replayLinks).toHaveCount(1)
  await expect(replayLinks.first()).toHaveAttribute(
    'href',
    `/playground?replay=${REPLAY_REQUEST_ID}&replayUser=1`
  )

  const [playground] = await Promise.all([
    page.waitForEvent('popup'),
    replayLinks.first().click(),
  ])
  await playground.waitForLoadState()

  const composer = playground.getByPlaceholder('Ask anything')
  await expect(composer).toHaveValue('reproduce this request')
  await expect(
    playground.getByRole('combobox').filter({ hasText: 'gpt-4o' }).first()
  ).toBeVisible()

  await playground.getByRole('button', { name: 'Parameters' }).click()
  await expect(
    playground.getByRole('switch', { name: 'Enable Temperature' })
  ).toBeChecked()
  await playground.keyboard.press('Escape')

  // Replaying only restores a draft: the user still has to press send.
  expect(chatRequests).toBe(0)
})
