// Image markup in the attachment viewer: pen strokes on a tall phone screenshot shown in Fit.
// It once blacked out the whole app (a stroke was added to the list as null: the state updater
// read the in-progress-stroke ref after pointerup had reset it); a crash in the viewer now stays
// inside the viewer.
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { startAgent } from './v3'

/** A 390x844 PNG made in the page (the size of the phone screenshot in the report). */
async function phonePng(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 390
    c.height = 844
    const g = c.getContext('2d')!
    g.fillStyle = '#ddeeff'
    g.fillRect(0, 0, 390, 844)
    return c.toDataURL('image/png').split(',')[1]!
  })
  return Buffer.from(b64, 'base64')
}

async function openImage(page: Page) {
  const png = await phonePng(page)
  await page.getByTestId('attach-input').setInputFiles({ name: 'card-phone.png', mimeType: 'image/png', buffer: png })
  const box = page.getByTestId('composer')
  await expect(box.locator('[data-testid="compose-file"][data-state="done"]')).toHaveCount(1)
  await box.getByTestId('composer-send').click()
  await page.getByRole('button', { name: /View card-phone\.png/ }).first().click()
  const viewer = page.getByTestId('attachment-viewer')
  await expect(viewer).toHaveAttribute('data-type', 'image')
  const img = viewer.getByTestId('image-view')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(390)
  return viewer
}

test('pen strokes on an image in Fit: several strokes, from outside the image, after Undo, never crash', async ({ page, minbox }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const a = await startAgent(minbox, 'api')
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const viewer = await openImage(page)
  await viewer.getByTestId('image-markup').click()
  await expect(viewer.getByTestId('markup-bar')).toBeVisible()
  const canvas = viewer.locator('canvas')
  const r = (await canvas.boundingBox())!

  const stroke = async (x0: number, y0: number, x1: number, y1: number, steps = 6) => {
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x1, y1, { steps })
    await page.mouse.up()
  }
  // Several pen strokes in a row (the second used to blank the app).
  await stroke(r.x + 20, r.y + 20, r.x + 80, r.y + 120)
  await stroke(r.x + 40, r.y + 200, r.x + 120, r.y + 260)
  await stroke(r.x + 60, r.y + 300, r.x + 90, r.y + 330, 2)
  // From the dark area right of the image, over it, and back out.
  await stroke(r.x + r.width + 60, r.y + 100, r.x + 30, r.y + 140)
  await stroke(r.x + 30, r.y + 160, r.x + r.width + 80, r.y + 180)
  // A move with no button and a stray up.
  await page.mouse.move(r.x + 50, r.y + 50)
  await page.mouse.up()
  expect(errors).toEqual([])
  await expect(viewer.getByTestId('markup-bar')).toBeVisible()
  // Undo, then draw again; arrow and circle too.
  await viewer.getByTestId('markup-bar').getByRole('button', { name: 'Undo', exact: true }).click()
  await stroke(r.x + 20, r.y + 400, r.x + 140, r.y + 420)
  await viewer.getByTestId('markup-bar').getByRole('button', { name: 'arrow', exact: true }).click()
  await stroke(r.x + 20, r.y + 450, r.x + 140, r.y + 500)
  await viewer.getByTestId('markup-bar').getByRole('button', { name: 'circle', exact: true }).click()
  await stroke(r.x + 20, r.y + 520, r.x + 140, r.y + 600)
  // Actual size, then a pen stroke.
  await viewer.getByTestId('markup-bar').getByRole('button', { name: 'pen', exact: true }).click()
  await viewer.getByRole('button', { name: 'Actual size' }).click()
  const r2 = (await canvas.boundingBox())!
  await stroke(r2.x + 20, r2.y + 20, r2.x + 100, r2.y + 60)

  expect(errors).toEqual([])
  await expect(viewer.getByTestId('markup-bar')).toBeVisible()
  await expect(viewer.getByTestId('markup-done')).toBeEnabled()
  // Something red was drawn on the canvas.
  const red = await canvas.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 200 && d[i + 1]! < 100 && d[i + 3]! > 0) n++
    return n
  })
  expect(red).toBeGreaterThan(50)
  // Done: the marked-up image becomes a comment.
  await viewer.getByTestId('markup-done').click()
  await expect(page.getByText('Added the marked-up image as a comment')).toBeVisible()
  expect(errors).toEqual([])
})

test.describe('touch', () => {
  test.use({ hasTouch: true })
  test('pen strokes by touch and pen pointers, and a cancelled one, never crash', async ({ page, minbox }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const a = await startAgent(minbox, 'api')
    await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
    const viewer = await openImage(page)
    await viewer.getByTestId('image-markup').click()
    const canvas = viewer.locator('canvas')
    // Synthetic pointer sequences: touch and pen, a move before any down, an up with no down,
    // a cancel mid-stroke, and a second pointer while one is down.
    await canvas.evaluate((c: HTMLCanvasElement) => {
      const r = c.getBoundingClientRect()
      const fire = (type: string, x: number, y: number, pointerType = 'touch', pointerId = 7) =>
        c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, pointerId, pointerType, isPrimary: pointerId === 7, buttons: type === 'pointerup' ? 0 : 1 }))
      fire('pointermove', 10, 10)
      fire('pointerup', 10, 10)
      for (const pt of ['touch', 'pen']) {
        fire('pointerdown', 20, 20, pt)
        for (let i = 1; i < 8; i++) fire('pointermove', 20 + i * 10, 20 + i * 12, pt)
        fire('pointerup', 100, 110, pt)
      }
      fire('pointerdown', 30, 200)
      fire('pointermove', 60, 230)
      fire('pointercancel', 60, 230)
      fire('pointermove', 90, 260)
      fire('pointerdown', 40, 300)
      fire('pointerdown', 50, 310, 'touch', 8)
      fire('pointermove', 80, 330, 'touch', 8)
      fire('pointermove', 90, 340)
      fire('pointerup', 80, 330, 'touch', 8)
      fire('pointerup', 90, 340)
    })
    await page.waitForTimeout(300)
    expect(errors).toEqual([])
    await expect(viewer.getByTestId('markup-done')).toBeEnabled()
    await expect(viewer.getByTestId('markup-bar').getByRole('button', { name: 'Undo', exact: true })).toBeEnabled()
  })
})
