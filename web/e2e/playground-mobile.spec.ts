import { expect, test } from '@playwright/test'

import { signIn } from './support/auth'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('the conversation sheet creates, focuses and handles keyboard on mobile', async ({
  page,
}) => {
  await page.goto('/playground')

  const openConversations = page.getByRole('button', {
    name: 'Open conversations',
  })
  await openConversations.click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()

  await sheet.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  await openConversations.click()
  const activeItem = page.getByRole('dialog').locator('[data-active="true"]')
  const activeButton = activeItem.getByRole('button', {
    name: 'New conversation',
    exact: true,
  })
  await expect(activeButton).toHaveAttribute('aria-pressed', 'true')

  await activeButton.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeHidden()
})

test('the composer attachment layer offers upload and saved assets', async ({
  page,
}) => {
  await page.goto('/playground')

  await page.getByRole('button', { name: 'Open conversations' }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'New session' })
    .click()

  await page.getByRole('button', { name: 'Attach' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('tab', { name: 'Upload files' })).toBeVisible()
  await expect(sheet.getByRole('tab', { name: 'My assets' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
})
