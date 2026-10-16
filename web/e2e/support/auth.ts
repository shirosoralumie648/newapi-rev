import { expect, type Page } from '@playwright/test'

export const E2E_USERNAME = 'e2e-root'
export const E2E_PASSWORD = 'E2e!Passw0rd123'

export async function signIn(page: Page) {
  await page.goto('/sign-in')
  await page.getByLabel('Username or Email', { exact: true }).fill(E2E_USERNAME)
  await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD)

  const consent = page.getByRole('checkbox')
  if ((await consent.count()) > 0) {
    await consent.first().check()
  }

  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/sign-in/, { timeout: 30_000 })
}
