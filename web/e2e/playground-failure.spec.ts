import { expect, test } from '@playwright/test'

import { signIn } from './support/auth'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('a failed conversation list offers a retry that recovers', async ({
  page,
}) => {
  let failListRequests = true
  await page.route(
    (url) => url.pathname === '/api/playground/sessions',
    async (route) => {
      if (failListRequests && route.request().method() === 'GET') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            message: 'E2E simulated failure',
          }),
        })
        return
      }
      await route.fallback()
    }
  )

  await page.goto('/playground')

  const errorAlert = page
    .getByRole('alert')
    .filter({ hasText: 'Conversation sync failed' })
  await expect(errorAlert).toBeVisible()

  failListRequests = false
  await errorAlert.getByRole('button', { name: 'Retry' }).click()

  await expect(errorAlert).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible()
})
