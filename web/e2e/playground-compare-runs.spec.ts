import { expect, test, type Page } from '@playwright/test'

import { signIn } from './support/auth'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

// Routes the catalog, the BL-03 estimate and the relay of a throwaway instance.
// Only the estimate and the model replies are mocked; every compare-run REST
// call reaches the real SQLite backend so storage and counters are exercised.
async function mockComparisonPage(
  page: Page,
  options: { delayMs?: number; failFirstClaude?: boolean } = {}
) {
  await page.route(
    (url) => url.pathname === '/api/user/models',
    (route) =>
      route.fulfill({
        json: {
          success: true,
          data: ['gpt-4o', 'claude-3-5-sonnet'],
        },
      })
  )
  await page.route(
    (url) => url.pathname === '/api/user/self/groups',
    (route) =>
      route.fulfill({
        json: { success: true, data: { default: { desc: '', ratio: 1 } } },
      })
  )
  await page.route(
    (url) => url.pathname === '/api/playground/workflows/estimate',
    (route) =>
      route.fulfill({
        json: {
          success: true,
          data: {
            steps: [0, 1, 2, 3, 4, 5].map((index) => ({
              node_id: `pgc-${index}`,
              quota: 10,
              available: true,
              approximate: false,
            })),
            total_quota: 60,
            available: true,
          },
        },
      })
  )

  let calls = 0
  const attempts = new Map<string, number>()
  await page.route(
    (url) => url.pathname === '/pg/chat/completions',
    async (route) => {
      calls += 1
      const body = route.request().postDataJSON() as { model: string }
      const attempt = (attempts.get(body.model) ?? 0) + 1
      attempts.set(body.model, attempt)

      if (
        options.failFirstClaude &&
        body.model === 'claude-3-5-sonnet' &&
        attempt === 1
      ) {
        await route.fulfill({
          status: 429,
          json: {
            message: 'Upstream is busy',
            error: { code: 'rate_limit_exceeded' },
          },
        })
        return
      }

      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      }
      await route.fulfill({
        status: 200,
        headers: { 'X-Oneapi-Request-Id': `cmp-${calls}` },
        json: {
          id: `chat-${calls}`,
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `reply ${calls}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
      })
    }
  )
}

async function openWorkbench(page: Page) {
  await page.goto('/playground')
  const trigger = page.getByRole('button', { name: 'Compare runs' })
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

// Base UI's multiple combobox keeps the popup open after a pick in some
// versions and closes it in others, so open it again only when it is closed.
async function selectComparisonModels(page: Page) {
  const input = page.getByRole('combobox', { name: 'Models to compare' })
  await input.click()
  await page.getByRole('option', { name: 'gpt-4o' }).click()

  const second = page.getByRole('option', { name: 'claude-3-5-sonnet' })
  if (!(await second.isVisible())) {
    await input.click()
  }
  await second.click()
}

test('compares two models across three prompts, retries a failed cell and exports CSV', async ({
  page,
}) => {
  await mockComparisonPage(page, { failFirstClaude: true })
  await openWorkbench(page)

  await page.getByLabel('Run title (optional)').fill('Batch check')
  await page
    .getByLabel('Prompts')
    .fill('first prompt\nsecond prompt\nthird prompt')
  await selectComparisonModels(page)

  await page.getByRole('button', { name: 'Run comparison' }).click()
  await page.getByRole('tab', { name: 'Results' }).click()

  await expect(page.getByText('2 models x 3 prompts')).toBeVisible()
  await expect(page.getByText('reply 1')).toBeVisible()
  await expect(page.getByText('reply 3')).toBeVisible()
  await expect(page.getByText('reply 4')).toBeVisible()
  await expect(page.getByText('reply 5')).toBeVisible()
  await expect(page.getByText('reply 6')).toBeVisible()
  await expect(
    page.getByText('Upstream is busy · rate_limit_exceeded')
  ).toBeVisible()
  await expect(page.getByText('Completed', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByText('reply 7')).toBeVisible()
  await expect(
    page.getByText('Upstream is busy · rate_limit_exceeded')
  ).toHaveCount(0)
  await expect(page.getByText('4 / 2')).toHaveCount(6)
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Mark as baseline' }).first().click()
  await expect(
    page.getByRole('button', { name: 'Clear baseline' })
  ).toHaveCount(1)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('menuitem', { name: 'Export as CSV' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('Batch-check.csv')
})

test('finishes while the workbench is closed and reloads from history', async ({
  page,
}) => {
  await mockComparisonPage(page, { delayMs: 150 })
  await openWorkbench(page)

  await page.getByLabel('Run title (optional)').fill('Background batch')
  await page.getByLabel('Prompts').fill('alpha\nbeta')
  await selectComparisonModels(page)
  const firstCell = page.waitForRequest((request) =>
    request.url().endsWith('/pg/chat/completions')
  )
  await page.getByRole('button', { name: 'Run comparison' }).click()
  await firstCell

  // The runner lives in the page, so hiding the workbench must not cancel it.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  await page.getByRole('button', { name: 'Compare runs' }).click()
  await page.getByRole('tab', { name: 'Results' }).click()
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText('reply 4')).toBeVisible()

  await page.getByRole('tab', { name: 'History' }).click()
  const dialog = page.getByRole('dialog')
  const historyRow = dialog
    .locator('div.p-3')
    .filter({ hasText: 'Background batch' })
  await expect(historyRow).toBeVisible()

  await historyRow.getByRole('button', { name: 'Open' }).click()
  await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByText('reply 4')).toBeVisible()

  await page.getByRole('tab', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Delete Background batch' }).click()
  await expect(page.getByText('Delete this comparison run?')).toBeVisible()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('Background batch')).toHaveCount(0)
})
