import { expect, test } from '@playwright/test'

import { signIn } from './support/auth'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('a renamed conversation survives a reload and a fresh sign-in', async ({
  browser,
  page,
}) => {
  const title = `E2E sync ${Date.now()}`

  await page.goto('/playground')
  await page.getByRole('button', { name: 'New session' }).click()

  const activeItem = page.locator('[data-active="true"]')
  await activeItem.getByRole('button', { name: /^Rename / }).click()
  const nameInput = page.getByRole('textbox', { name: 'Session name' })
  await nameInput.fill(title)
  // Wait for the write that persists the new title: either the create request
  // already carries it, or the server-bound session update finishes with it.
  // Without this the reload can cut the debounced save short.
  const persisted = page.waitForResponse((response) => {
    if (!response.ok()) return false
    const url = response.url()
    const method = response.request().method()
    const body = response.request().postData() ?? ''
    if (method === 'POST' && url.endsWith('/api/playground/sessions')) {
      return body.includes(title)
    }
    if (method === 'PATCH' && /\/api\/playground\/sessions\/[^/]+$/.test(url)) {
      return body.includes(title)
    }
    return false
  })
  await nameInput.press('Enter')
  await persisted
  await expect(
    page.getByRole('button', { name: title, exact: true })
  ).toBeVisible()

  await page.reload()
  await expect(
    page.getByRole('button', { name: title, exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Conversation sync failed' })
  ).toHaveCount(0)

  const freshContext = await browser.newContext()
  const freshPage = await freshContext.newPage()
  await signIn(freshPage)
  await freshPage.goto('/playground')
  await expect(
    freshPage.getByRole('button', { name: title, exact: true })
  ).toBeVisible()

  await freshPage
    .getByRole('button', { name: `Delete ${title}`, exact: true })
    .click()
  await freshPage.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(
    freshPage.getByRole('button', { name: title, exact: true })
  ).toHaveCount(0)

  await freshContext.close()
})

test('desktop artifact toggle docks the panel beside the chat', async ({
  page,
}) => {
  await page.goto('/playground')
  await page.getByRole('button', { name: 'New session' }).click()

  const toggle = page.getByRole('button', { name: 'Artifacts', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  await toggle.click()

  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-slot="resizable-handle"]')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('the conversation list scrolls without moving the page', async ({
  page,
}) => {
  await page.goto('/playground')

  const newSession = page.getByRole('button', { name: 'New session' })
  for (let index = 0; index < 20; index += 1) {
    await newSession.click()
  }

  const viewport = page.locator('[data-slot="scroll-area-viewport"]').first()
  await expect
    .poll(async () =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight
      )
    )
    .toBeGreaterThan(0)

  const pageScrollBefore = await page.evaluate(() => window.scrollY)
  await viewport.hover()
  await page.mouse.wheel(0, 600)

  await expect
    .poll(async () => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore)
})
