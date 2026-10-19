import { expect, test } from '@playwright/test'

import { signIn } from './support/auth'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

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
