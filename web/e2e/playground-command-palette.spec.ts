import { expect, test, type Page } from '@playwright/test'

import { signIn } from './support/auth'

const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function createNamedSession(page: Page, title: string) {
  await page.getByRole('button', { name: 'New session' }).click()
  const activeItem = page.locator('[data-active="true"]')
  await activeItem.getByRole('button', { name: /^Rename / }).click()

  const nameInput = page.getByRole('textbox', { name: 'Session name' })
  await nameInput.fill(title)
  await nameInput.press('Enter')
  await expect(
    page.getByRole('button', { name: title, exact: true })
  ).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('the command palette switches conversations and ? opens the shortcut reference', async ({
  page,
}) => {
  const first = `Palette first ${Date.now()}`
  const second = `Palette second ${Date.now()}`

  await page.goto('/playground')
  await createNamedSession(page, first)
  await createNamedSession(page, second)

  await page.keyboard.press(`${primaryModifier}+k`)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()

  await palette.getByRole('combobox').fill(first)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')

  await expect(
    page
      .locator('[data-active="true"]')
      .getByRole('button', { name: first, exact: true })
  ).toBeVisible()
  await expect(palette).toBeHidden()

  await page.keyboard.press('?')
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(shortcuts).toBeVisible()
  await expect(shortcuts).toContainText('Jump to message')

  await page.keyboard.press('Escape')
  await expect(shortcuts).toBeHidden()
})
