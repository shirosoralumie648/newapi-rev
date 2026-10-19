import { expect, test, type Page } from '@playwright/test'

import { signIn } from './support/auth'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

async function mockWorkflowCatalog(page: Page) {
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
  // Price every step the estimate names so the run dialog becomes startable
  // without depending on the instance's model pricing.
  await page.route(
    (url) => url.pathname === '/api/playground/workflows/estimate',
    (route) => {
      const body = route.request().postDataJSON() as {
        steps?: Array<{ node_id: string }>
      }
      const steps = (body.steps ?? []).map((step) => ({
        node_id: step.node_id,
        quota: 10,
        available: true,
        approximate: false,
      }))
      route.fulfill({
        json: {
          success: true,
          data: {
            steps,
            total_quota: steps.length * 10,
            available: true,
          },
        },
      })
    }
  )
}

test('nudges, deletes, drags and exports a canvas node', async ({ page }) => {
  await page.goto('/playground/canvas')

  const newCanvas = page.getByRole('button', { name: 'New canvas' })
  if ((await newCanvas.count()) > 0) {
    await newCanvas.first().click()
  }

  await page.getByRole('button', { name: 'Add node' }).click()
  await page.getByRole('menuitem', { name: 'Text', exact: true }).click()

  const node = page.locator('.react-flow__node').first()
  await expect(node).toBeVisible()
  await node.click()

  const initialBounds = await node.boundingBox()
  if (!initialBounds) throw new Error('canvas node has no bounds')

  await page.keyboard.press('Shift+ArrowRight')
  await expect
    .poll(async () => (await node.boundingBox())?.x ?? initialBounds.x)
    .toBeGreaterThan(initialBounds.x + 5)

  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(page.locator('.react-flow__node')).toHaveCount(1)

  const beforeDrag = await node.boundingBox()
  if (!beforeDrag) throw new Error('restored canvas node has no bounds')
  await page.mouse.move(
    beforeDrag.x + beforeDrag.width / 2,
    beforeDrag.y + beforeDrag.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    beforeDrag.x + beforeDrag.width / 2 + 120,
    beforeDrag.y + beforeDrag.height / 2 + 40,
    { steps: 8 }
  )
  await page.mouse.up()
  await expect
    .poll(async () => (await node.boundingBox())?.x ?? beforeDrag.x)
    .toBeGreaterThan(beforeDrag.x + 40)

  await page.keyboard.press('Control+z')
  await expect
    .poll(async () =>
      Math.abs(((await node.boundingBox())?.x ?? 0) - beforeDrag.x)
    )
    .toBeLessThan(2)

  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('menuitem', { name: 'PNG image' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PNG' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/\.png$/)
})

test('an unchanged second run reuses the cached step without calling the relay', async ({
  page,
}) => {
  // Only the catalog, the estimate and the model reply are mocked. The canvas,
  // the node-cache lookup and both history rows reach the real backend, so a
  // hit has to come from the stored run rather than from a stubbed response.
  await mockWorkflowCatalog(page)
  let relayCalls = 0
  await page.route(
    (url) => url.pathname === '/pg/chat/completions',
    (route) => {
      relayCalls += 1
      return route.fulfill({
        status: 200,
        headers: { 'X-Oneapi-Request-Id': `cache-${relayCalls}` },
        json: {
          id: `chat-${relayCalls}`,
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'cached fox' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
      })
    }
  )

  await page.goto('/playground/canvas')
  const newCanvas = page.getByRole('button', { name: 'New canvas' })
  if ((await newCanvas.count()) > 0) {
    await newCanvas.first().click()
  }

  await page.getByRole('button', { name: 'Add node' }).click()
  await page.getByRole('menuitem', { name: 'Model call', exact: true }).click()

  const node = page.locator('.react-flow__node').first()
  await node.click()
  const model = page.getByRole('combobox', { name: 'Model' })
  await expect(model).toBeEnabled()
  await model.selectOption('gpt-4o')
  await page.getByLabel('Instruction').fill('a red fox')

  const runOnce = async () => {
    await page
      .getByRole('button', { name: 'Run workflow', exact: true })
      .click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog
      .getByRole('button', { name: 'Run workflow', exact: true })
      .click()
    await expect(page.getByText('cached fox').first()).toBeVisible()
    await expect(dialog).toBeHidden()
    // The runner only reports idle after the closing history write, so this
    // also proves the second run can see the first run's stored node.
    await expect(
      page.getByRole('button', { name: 'Run workflow', exact: true })
    ).toBeVisible()
  }

  await runOnce()
  expect(relayCalls).toBe(1)

  await runOnce()
  expect(relayCalls).toBe(1)
  await expect(page.getByText('cached fox').first()).toBeVisible()
  await expect(node.getByText('Cached', { exact: true })).toBeVisible()
})
