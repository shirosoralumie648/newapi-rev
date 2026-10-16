import { expect, test } from '@playwright/test'

import { signIn } from './support/auth'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('dark mode applies and persists across a reload', async ({ page }) => {
  await page.goto('/playground')

  const html = page.locator('html')
  await expect(html).not.toHaveClass(/\bdark\b/)

  const lightBackground = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue('--background')
      .trim()
  )

  await page.evaluate(() => {
    window.localStorage.setItem('newapi:theme:v1:mode', 'dark')
  })
  await page.reload()

  await expect(html).toHaveClass(/\bdark\b/)
  const darkBackground = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue('--background')
      .trim()
  )

  expect(darkBackground).not.toBe('')
  expect(darkBackground).not.toBe(lightBackground)
})
