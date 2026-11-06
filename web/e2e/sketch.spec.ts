import { writeFileSync } from 'node:fs'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'
import type { Locator, Page } from '@playwright/test'

// The diagram sketcher: drawn in a modal from either compose box, attached as a
// PNG, editable (and an attached image can be drawn on) before the message is sent.

const modal = (page: Page) => page.getByTestId('sketch-modal')
const shapes = (page: Page) => modal(page).getByTestId('sketch-shape')

async function canvasBox(page: Page) {
  const box = await modal(page).getByTestId('sketch-canvas').boundingBox()
  if (!box) throw new Error('no canvas')
  return box
}

async function drag(page: Page, from: [number, number], to: [number, number], opts: { shift?: boolean } = {}) {
  const b = await canvasBox(page)
  await page.mouse.move(b.x + from[0], b.y + from[1])
  await page.mouse.down()
  if (opts.shift) await page.keyboard.down('Shift')
  await page.mouse.move(b.x + (from[0] + to[0]) / 2, b.y + (from[1] + to[1]) / 2, { steps: 3 })
  await page.mouse.move(b.x + to[0], b.y + to[1], { steps: 3 })
  await page.mouse.up()
  if (opts.shift) await page.keyboard.up('Shift')
}

async function tool(page: Page, name: string) {
  await modal(page).getByTestId(`sketch-tool-${name}`).click()
}

const num = async (l: Locator, a: string) => Number(await l.getAttribute(a))

/** The newest sent message's first image attachment: content type and PNG size. */
async function sentImage(page: Page) {
  const img = page.getByTestId('message').filter({ hasText: 'You' }).getByTestId('attachment-card').first().locator('img').first()
  await expect(img).toBeVisible()
  const res = await page.request.get(new URL((await img.getAttribute('src'))!, page.url()).toString())
  expect(res.ok()).toBeTruthy()
  const body = await res.body()
  return { type: res.headers()['content-type'], w: body.readUInt32BE(16), h: body.readUInt32BE(20) }
}

test('draw shapes in the new-thread box, attach the PNG, and send it', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'sk1')
  await expectTerminal(page, 'ready>')

  await page.getByTestId('compose-draw').click()
  await expect(modal(page)).toBeVisible()
  const vp = page.viewportSize()!
  const m = (await modal(page).boundingBox())!
  expect(Math.abs(m.width - vp.width * 0.9)).toBeLessThan(3)
  expect(Math.abs(m.height - vp.height * 0.9)).toBeLessThan(3)

  await tool(page, 'rect')
  await drag(page, [60, 60], [200, 140])
  await tool(page, 'ellipse')
  await drag(page, [260, 60], [400, 140])
  await tool(page, 'line')
  await drag(page, [60, 200], [200, 200])
  await tool(page, 'arrow')
  await drag(page, [260, 200], [400, 260])
  await tool(page, 'text')
  const b = await canvasBox(page)
  await page.mouse.click(b.x + 60, b.y + 320)
  await page.getByTestId('sketch-text-input').fill('Hello')
  await page.keyboard.press('Enter')
  await expect(shapes(page)).toHaveCount(5)
  await expect(shapes(page).nth(0)).toHaveAttribute('data-kind', 'rect')
  await expect(shapes(page).nth(1)).toHaveAttribute('data-kind', 'ellipse')
  await expect(shapes(page).nth(2)).toHaveAttribute('data-kind', 'line')
  await expect(shapes(page).nth(3)).toHaveAttribute('data-kind', 'arrow')
  await expect(shapes(page).nth(4)).toHaveAttribute('data-kind', 'text')
  await expect(shapes(page).nth(4)).toContainText('Hello')

  // Shift: a nearly horizontal line snaps to 45 degree steps (here flat); a rectangle becomes a square.
  await tool(page, 'line')
  await drag(page, [500, 100], [600, 118], { shift: true })
  await expect(shapes(page)).toHaveCount(6)
  expect(await num(shapes(page).nth(5), 'data-h')).toBe(0)
  await tool(page, 'rect')
  await drag(page, [500, 200], [620, 260], { shift: true })
  await expect(shapes(page)).toHaveCount(7)
  expect(await num(shapes(page).nth(6), 'data-w')).toBe(await num(shapes(page).nth(6), 'data-h'))

  // Undo and redo.
  await page.getByTestId('sketch-undo').click()
  await page.getByTestId('sketch-undo').click()
  await expect(shapes(page)).toHaveCount(5)
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect(shapes(page)).toHaveCount(6)
  await page.getByTestId('sketch-redo').click()
  await expect(shapes(page)).toHaveCount(7)
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(shapes(page)).toHaveCount(6)

  // Select and move the rectangle by its edge; handles appear; a corner handle resizes; Delete removes it.
  await tool(page, 'select')
  const rect = shapes(page).nth(0)
  const x0 = await num(rect, 'data-x')
  const y0 = await num(rect, 'data-y')
  await drag(page, [130, 60], [180, 90])
  await expect(rect).toHaveAttribute('data-x', String(x0 + 50))
  await expect(rect).toHaveAttribute('data-y', String(y0 + 30))
  await expect(modal(page).getByTestId('sketch-handle')).toHaveCount(4)
  const w0 = await num(rect, 'data-w')
  const hb = (await modal(page).getByTestId('sketch-handle').nth(1).boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2 + 10, { steps: 3 })
  await page.mouse.up()
  await expect(rect).toHaveAttribute('data-w', String(w0 + 40))
  await page.keyboard.press('Delete')
  await expect(shapes(page)).toHaveCount(5)
  // The eraser removes a shape by clicking it (the ellipse's right edge).
  await tool(page, 'eraser')
  await page.mouse.click(b.x + 400, b.y + 100)
  await expect(shapes(page)).toHaveCount(4)
  await page.getByTestId('sketch-undo').click()
  await expect(shapes(page)).toHaveCount(5)
  // Freehand.
  await tool(page, 'pen')
  await drag(page, [500, 400], [560, 460])
  await expect(shapes(page).last()).toHaveAttribute('data-kind', 'pen')

  await page.getByTestId('sketch-done').click()
  await expect(modal(page)).toBeHidden()
  const tile = page.getByTestId('compose-file')
  await expect(tile).toHaveCount(1)
  await expect(tile).toHaveAttribute('data-state', 'done')
  await expect(tile).toContainText(/sketch-\d{8}-\d{6}\.png/)

  await page.getByTestId('quick-body').fill('See the diagram')
  await page.getByTestId('quick-send').click()
  await expect(page.getByTestId('thread-subject')).toContainText('See the diagram')
  const img = await sentImage(page)
  expect(img.type).toBe('image/png')
  expect(img.w).toBeGreaterThan(100)
  await expect(page.getByTestId('message').filter({ hasText: 'You' }).getByTestId('attachment-card')).toContainText(/sketch-\d{8}-\d{6}\.png/)
})

test('a reply: edit the drawing before sending, cancel adds nothing, then send', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'sk2')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Need a picture')
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).click()

  // Esc with nothing drawn closes at once and adds nothing.
  await page.getByTestId('thread-view').getByTestId('compose-draw').click()
  await expect(modal(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(modal(page)).toBeHidden()
  await expect(page.getByTestId('compose-file')).toHaveCount(0)

  // A changed drawing asks before it is dropped.
  await page.getByTestId('thread-view').getByTestId('compose-draw').click()
  await tool(page, 'rect')
  await drag(page, [100, 100], [220, 180])
  await expect(shapes(page)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('sketch-discard')).toBeVisible()
  await page.getByTestId('sketch-keep').click()
  await expect(modal(page)).toBeVisible()
  await page.getByTestId('sketch-cancel').click()
  await page.getByTestId('sketch-discard-yes').click()
  await expect(modal(page)).toBeHidden()
  await expect(page.getByTestId('compose-file')).toHaveCount(0)

  // Draw, finish with Ctrl/Cmd+Enter.
  await page.getByTestId('thread-view').getByTestId('compose-draw').click()
  await tool(page, 'rect')
  await drag(page, [100, 100], [220, 180])
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(modal(page)).toBeHidden()
  const tile = page.getByTestId('compose-file')
  await expect(tile).toHaveCount(1)
  await expect(tile).toHaveAttribute('data-state', 'done')
  const name = (await tile.locator('span.truncate').first().textContent())!

  // Edit: the scene comes back; a new shape replaces the file.
  await tile.getByTestId('file-edit').click()
  await expect(shapes(page)).toHaveCount(1)
  await tool(page, 'ellipse')
  await drag(page, [300, 100], [420, 180])
  await expect(shapes(page)).toHaveCount(2)
  await page.getByTestId('sketch-done').click()
  await expect(modal(page)).toBeHidden()
  await expect(page.getByTestId('compose-file')).toHaveCount(1)
  await expect(page.getByTestId('compose-file')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('compose-file')).toContainText(name)
  await page.getByTestId('compose-file').getByTestId('file-edit').click()
  await expect(shapes(page)).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(modal(page)).toBeHidden()

  await page.getByTestId('reply-box').fill('Like this?')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')
  await expect(page.getByTestId('compose-file')).toHaveCount(0)
  const img = await sentImage(page)
  expect(img.type).toBe('image/png')
})

test('draw on an attached image; the tile becomes the annotated PNG', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'sk3')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Need a screenshot')
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).click()

  // A text file has no Annotate action.
  const txt = `${minbox.dataDir}/n.txt`
  writeFileSync(txt, 'x\n')
  await page.getByTestId('attach-input').setInputFiles(txt)
  await expect(page.getByTestId('compose-file')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('file-annotate')).toHaveCount(0)
  await page.getByTestId('compose-file').getByRole('button', { name: /Remove/ }).click()
  await expect(page.getByTestId('compose-file')).toHaveCount(0)

  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 400
    c.height = 300
    const g = c.getContext('2d')!
    g.fillStyle = '#88aa44'
    g.fillRect(0, 0, 400, 300)
    return c.toDataURL('image/png').split(',')[1]
  })
  const file = `${minbox.dataDir}/shot.png`
  writeFileSync(file, Buffer.from(b64, 'base64'))
  await page.getByTestId('attach-input').setInputFiles(file)
  const tile = page.getByTestId('compose-file')
  await expect(tile).toHaveAttribute('data-state', 'done')
  await tile.getByTestId('file-annotate').click()
  await expect(modal(page)).toBeVisible()
  await expect(modal(page).getByTestId('sketch-bg')).toBeVisible()
  await tool(page, 'rect')
  const box = await canvasBox(page)
  await drag(page, [box.width / 2 - 40, box.height / 2 - 30], [box.width / 2 + 40, box.height / 2 + 30])
  await expect(shapes(page)).toHaveCount(1)
  await page.getByTestId('sketch-done').click()
  await expect(modal(page)).toBeHidden()
  await expect(tile).toHaveCount(1)
  await expect(tile).toHaveAttribute('data-state', 'done')
  await expect(tile).toContainText('shot-annotated.png')
  await expect(tile.getByTestId('file-annotate')).toHaveCount(0)
  // The image stays underneath in the scene: edit again shows the image and the rectangle.
  await tile.getByTestId('file-edit').click()
  await expect(modal(page).getByTestId('sketch-bg')).toBeVisible()
  await expect(shapes(page)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(modal(page)).toBeHidden()

  await page.getByTestId('reply-box').fill('Here')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')
  const img = await sentImage(page)
  expect(img.type).toBe('image/png')
  expect([img.w, img.h]).toEqual([400, 300])
})
