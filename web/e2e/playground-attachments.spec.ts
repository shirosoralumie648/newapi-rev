import { expect, test, type Locator, type Page } from '@playwright/test'

import { signIn } from './support/auth'

// A real 1x1 PNG so the server signature check and the browser can process it.
const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const ATTACHMENT_PLACEHOLDER = 'attachment://attachment-1.png'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

// Reads the one code panel of a tab out of CodeMirror's line elements. The
// viewer shows four read-only editors, so the DOM is the only stable source
// for comparing the exported text with the request that was sent.
function readCodePanel(panel: Locator): Promise<string> {
  return panel.evaluate((element) =>
    Array.from(element.querySelectorAll('.cm-line'))
      .map((line) => line.textContent ?? '')
      .join('\n')
  )
}

// Routes the models, groups, and relay calls of a throwaway instance so the
// workspace can send and complete a message.
async function mockRelay(page: Page) {
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
}

test('an attached image reaches the model request and survives a reload', async ({
  page,
}) => {
  // The throwaway instance has no channels; answer the catalog and relay
  // requests so the workspace can send and complete a message.
  await mockRelay(page)

  await page.goto('/playground')
  const attach = page.getByRole('button', { name: 'Attach' })
  await expect(attach).toBeEnabled()

  const chooserPromise = page.waitForEvent('filechooser')
  await attach.click()
  await page.getByRole('button', { name: 'Choose files' }).click()
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
      response.request().method() !== 'PATCH' ||
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

test('the request preview matches the sent payload without attachment bytes', async ({
  page,
}) => {
  await mockRelay(page)
  await page.goto('/playground')

  const attach = page.getByRole('button', { name: 'Attach' })
  await expect(attach).toBeEnabled()
  const chooserPromise = page.waitForEvent('filechooser')
  await attach.click()
  await page.getByRole('button', { name: 'Choose files' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PIXEL_PNG_BASE64, 'base64'),
  })
  await expect(
    page.getByRole('button', { name: 'Remove attachment' })
  ).toBeVisible()

  const send = page.getByRole('button', { name: /Send/ }).first()
  await expect(send).toBeEnabled()
  const requestPromise = page.waitForRequest((request) =>
    request.url().endsWith('/pg/chat/completions')
  )
  await send.click()

  // The wire carries the inline image bytes.
  const sent = JSON.parse((await requestPromise).postData() ?? '{}') as {
    messages: Array<{ content: unknown }>
  }
  expect(JSON.stringify(sent)).toContain(PIXEL_PNG_BASE64)

  const viewerButton = page.getByRole('button', { name: 'Request preview' })
  await expect(viewerButton).toBeEnabled()
  await viewerButton.click()

  const messagesJson = page.getByRole('textbox', { name: 'Messages JSON' })
  await expect(messagesJson).toBeVisible()
  const exportedText = await readCodePanel(messagesJson)
  const exported = JSON.parse(exportedText) as typeof sent

  // Everything except the inline image bytes is exactly the sent request.
  const expectedMessages = sent.messages.map((message) => {
    if (typeof message.content === 'string') return message
    return {
      ...message,
      content: (message.content as Array<Record<string, unknown>>).map(
        (part) => {
          const image = part.image_url as { url: string } | undefined
          if (part.type !== 'image_url' || !image) return part
          return { ...part, image_url: { url: ATTACHMENT_PLACEHOLDER } }
        }
      ),
    }
  })
  expect(exported).toEqual({ ...sent, messages: expectedMessages })
  expect(exportedText).not.toContain(PIXEL_PNG_BASE64)

  // No session credential of the browser leaks into an export.
  for (const cookie of await page.context().cookies()) {
    if (cookie.value.length >= 8) {
      expect(exportedText).not.toContain(cookie.value)
    }
  }

  // The code exports target the public endpoint with a placeholder key.
  await page.getByRole('tab', { name: 'cURL' }).click()
  const curlPanel = page.getByRole('textbox', { name: 'cURL' })
  await expect(curlPanel).toBeVisible()
  const curl = await readCodePanel(curlPanel)
  expect(curl).toContain('$NEWAPI_API_KEY')
  expect(curl).toContain('/v1/chat/completions')
  expect(curl).toContain(ATTACHMENT_PLACEHOLDER)
  expect(curl).not.toContain(PIXEL_PNG_BASE64)
})
