import { expect, test } from '@playwright/test'

import { signIn } from './support/auth'

// A real 1x1 PNG so the server signature check and the browser can process it.
const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('an attached image reaches the model request and survives a reload', async ({
  page,
}) => {
  // The throwaway instance has no channels; answer the catalog and relay
  // requests so the workspace can send and complete a message.
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
    (url) => url.pathname === '/pg/chat/completions',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      })
  )

  await page.goto('/playground')
  const attach = page.getByRole('button', { name: 'Attach' })
  await expect(attach).toBeEnabled()

  const chooserPromise = page.waitForEvent('filechooser')
  await attach.click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PIXEL_PNG_BASE64, 'base64'),
  })
  await expect(
    page.getByRole('button', { name: 'Remove attachment' })
  ).toBeVisible()

  const saved = page.waitForResponse((response) => {
    if (
      response.request().method() !== 'PUT' ||
      !/\/api\/playground\/sessions\/[^/]+\/messages$/.test(response.url()) ||
      !response.ok()
    ) {
      return false
    }
    return (response.request().postData() ?? '').includes('"ok"')
  })

  const send = page.getByRole('button', { name: /Send/ }).first()
  await expect(send).toBeEnabled()
  const requestPromise = page.waitForRequest((request) =>
    request.url().endsWith('/pg/chat/completions')
  )
  await send.click()

  // The model request carries the image as an inline content part.
  const request = await requestPromise
  const body = request.postData() ?? ''
  expect(body).toContain('"type":"image_url"')
  expect(body).toContain(PIXEL_PNG_BASE64)

  await expect(page.getByText('ok', { exact: true })).toBeVisible()
  const galleryImage = page.getByRole('img', { name: 'pixel.png' })
  await expect(galleryImage).toBeVisible()
  await saved

  // After a reload the message and its attachment come back from the server,
  // and the bytes load through the authenticated content endpoint.
  const contentResponse = page.waitForResponse(
    (response) =>
      /\/api\/playground\/sessions\/[^/]+\/attachments\/[^/]+\/content$/.test(
        response.url()
      ) && response.ok()
  )
  await page.reload()
  await expect(page.getByText('ok', { exact: true })).toBeVisible()
  await expect(galleryImage).toBeVisible()
  await contentResponse
})
