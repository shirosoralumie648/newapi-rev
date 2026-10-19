import { expect, test } from '@playwright/test'

import { signIn } from './support/auth'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('uploads, indexes and rebuilds a knowledge document from the canvas manager', async ({
  page,
}) => {
  // The throwaway instance has no upstream channels. The document upload and
  // extraction run against the real API; only the embedding relay call is
  // answered here so the browser can complete chunking and persistence.
  let embeddingCalls = 0
  await page.route(
    (url) => url.pathname === '/api/user/self/groups',
    (route) =>
      route.fulfill({
        json: { success: true, data: { default: { desc: '', ratio: 1 } } },
      })
  )
  await page.route(
    (url) => url.pathname === '/pg/embeddings',
    (route) => {
      embeddingCalls += 1
      const body = route.request().postDataJSON() as {
        input: string | string[]
      }
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      return route.fulfill({
        json: {
          data: inputs.map((_, index) => ({
            index,
            embedding: [1, 0.5, 0.25],
          })),
        },
      })
    }
  )

  await page.goto('/playground/canvas')
  await page.getByRole('button', { name: 'Knowledge bases' }).click()

  const name = `E2E knowledge ${Date.now()}`
  await page.getByLabel('Knowledge base name').fill(name)
  await page.getByRole('button', { name: 'Create knowledge base' }).click()
  await expect(
    page.getByRole('button', { name: new RegExp(name) }).first()
  ).toBeVisible()

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Upload document' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'handbook.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Handbook\n\nAlpha beta gamma.'),
  })

  await expect(page.getByText('handbook.md', { exact: true })).toBeVisible()
  await expect(page.getByText('Indexed', { exact: true })).toBeVisible()
  await expect.poll(() => embeddingCalls).toBe(1)

  const chunksSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/chunks') &&
      response.ok()
  )
  await page
    .getByRole('button', { name: 'Rebuild the index of handbook.md' })
    .click()
  await chunksSaved
  await expect.poll(() => embeddingCalls).toBe(2)
  await expect(page.getByText('Indexed', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: `Delete ${name}` }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(name, { exact: true })).toHaveCount(0)
})
