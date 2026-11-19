import { writeFileSync } from 'node:fs'
import { expect, test, type Minbox } from './fixtures'
import { startAgent } from './v3'
import type { Locator, Page } from '@playwright/test'

// v3 (ported from sketch.spec.ts): the diagram sketcher in an agent stream's reply box (and a task's):
// The diagram sketcher: drawn in a modal from the reply box, attached as a
// PNG, editable (and an attached image can be drawn on) before the message is sent.

async function openStream(page: Page, minbox: Minbox, name: string) {
  const a = await startAgent(minbox, name)
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('composer-text')).toBeVisible()
}

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
  const img = page.locator('[data-testid="v3-message"][data-author="user"]').getByTestId('attachment-card').first().locator('img').first()
  await expect(img).toBeVisible()
  const res = await page.request.get(new URL((await img.getAttribute('src'))!, page.url()).toString())
  expect(res.ok()).toBeTruthy()
  const body = await res.body()
  return { type: res.headers()['content-type'], w: body.readUInt32BE(16), h: body.readUInt32BE(20) }
}

test('draw shapes in the reply box, attach the PNG, and send it', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk1')

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
  await page.keyboard.press('ControlOrMeta+Enter')
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

  await page.getByTestId('composer-text').fill('See the diagram')
  await page.getByTestId('composer-send').click()
  await expect(page.locator('[data-testid="v3-message"][data-author="user"]').filter({ hasText: 'See the diagram' })).toBeVisible()
  const img = await sentImage(page)
  expect(img.type).toBe('image/png')
  expect(img.w).toBeGreaterThan(100)
  await expect(page.locator('[data-testid="v3-message"][data-author="user"]').getByTestId('attachment-card')).toContainText(/sketch-\d{8}-\d{6}\.png/)
})

test('a reply: edit the drawing before sending, cancel adds nothing, then send', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk2')

  // Esc with nothing drawn closes at once and adds nothing.
  await page.getByTestId('stream-view').getByTestId('compose-draw').click()
  await expect(modal(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(modal(page)).toBeHidden()
  await expect(page.getByTestId('compose-file')).toHaveCount(0)

  // A changed drawing asks before it is dropped.
  await page.getByTestId('stream-view').getByTestId('compose-draw').click()
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
  await page.getByTestId('stream-view').getByTestId('compose-draw').click()
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

  await page.getByTestId('composer-text').fill('Like this?')
  await page.getByTestId('composer-send').click()
  await expect(page.getByTestId('delivery')).toHaveAttribute('data-delivery', 'delivered')
  await expect(page.getByTestId('compose-file')).toHaveCount(0)
  const img = await sentImage(page)
  expect(img.type).toBe('image/png')
})

test('draw on an attached image; the tile becomes the annotated PNG', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk3')

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

  await page.getByTestId('composer-text').fill('Here')
  await page.getByTestId('composer-send').click()
  await expect(page.getByTestId('delivery')).toHaveAttribute('data-delivery', 'delivered')
  const img = await sentImage(page)
  expect(img.type).toBe('image/png')
  expect([img.w, img.h]).toEqual([400, 300])
})

test('tile icons never overlap the file name (long name, a narrow reply box)', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk5')
  // The files beside the stream leave the reply box narrow.
  await page.getByTestId('files-toggle').click()
  await expect(page.getByTestId('side-files')).toBeVisible()
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 40
    c.height = 30
    c.getContext('2d')!.fillRect(0, 0, 40, 30)
    return c.toDataURL('image/png').split(',')[1]
  })
  // Paste a file with a long name into it.
  await page.getByTestId('composer-text').evaluate((el, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'pasted-image-2026-11-06-1027-with-a-very-long-descriptive-name.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, b64)
  const tile = page.getByTestId('compose-file')
  await expect(tile).toHaveAttribute('data-state', 'done')
  await expect(tile.getByTestId('file-annotate')).toBeVisible()
  const name = tile.getByText(/pasted-image-2026/)
  const quick = (await page.getByTestId('composer-text').boundingBox())!
  expect(quick.width).toBeLessThan(500)
  const n = (await name.boundingBox())!
  const clear = async (l: Locator) => {
    const r = (await l.boundingBox())!
    expect(r.x).toBeGreaterThanOrEqual(n.x + n.width - 0.5)
  }
  await clear(tile.getByTestId('file-annotate'))
  await clear(tile.getByRole('button', { name: /Remove/ }))
  const t = (await tile.boundingBox())!
  const x = (await tile.getByRole('button', { name: /Remove/ }).boundingBox())!
  expect(x.x + x.width).toBeLessThanOrEqual(t.x + t.width + 0.5)
})

test('Option/Alt-drag duplicates a shape; an Alt-click does not', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk-dup')
  await page.getByTestId('compose-draw').click()
  await expect(modal(page)).toBeVisible()
  await tool(page, 'rect')
  await drag(page, [60, 60], [200, 140])
  await tool(page, 'select')
  await expect(shapes(page)).toHaveCount(1)
  const x0 = await num(shapes(page).nth(0), 'data-x')
  const y0 = await num(shapes(page).nth(0), 'data-y')
  const b = await canvasBox(page)

  // Alt-click without movement leaves no copy.
  await page.keyboard.down('Alt')
  await page.mouse.click(b.x + 130, b.y + 60)
  await page.keyboard.up('Alt')
  await expect(shapes(page)).toHaveCount(1)

  // Alt-drag by the top edge: the original stays, the copy moves, and shows the copy cursor.
  await page.keyboard.down('Alt')
  await page.mouse.move(b.x + 130, b.y + 60)
  await page.mouse.down()
  await page.mouse.move(b.x + 160, b.y + 80, { steps: 3 })
  await page.mouse.move(b.x + 230, b.y + 190, { steps: 3 })
  await expect(modal(page).getByTestId('sketch-canvas')).toHaveCSS('cursor', 'copy')
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await expect(shapes(page)).toHaveCount(2)
  await expect(shapes(page).nth(0)).toHaveAttribute('data-x', String(x0))
  await expect(shapes(page).nth(0)).toHaveAttribute('data-y', String(y0))
  await expect(shapes(page).nth(1)).toHaveAttribute('data-x', String(x0 + 100))
  await expect(shapes(page).nth(1)).toHaveAttribute('data-y', String(y0 + 130))
  await expect(modal(page).getByTestId('sketch-handle')).toHaveCount(4)

  // One undo removes only the copy.
  await page.getByTestId('sketch-undo').click()
  await expect(shapes(page)).toHaveCount(1)
  await expect(shapes(page).nth(0)).toHaveAttribute('data-x', String(x0))
})

test('double-click on a text edits it, from the select tool and from other tools', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk-dbl')
  await page.getByTestId('compose-draw').click()
  await expect(modal(page)).toBeVisible()
  const b = await canvasBox(page)
  await tool(page, 'text')
  await page.mouse.click(b.x + 100, b.y + 100)
  await page.getByTestId('sketch-text-input').fill('Hello')
  await page.keyboard.press('ControlOrMeta+Enter')
  await tool(page, 'rect')
  await drag(page, [300, 200], [400, 260])
  await expect(shapes(page)).toHaveCount(2)
  const text = shapes(page).nth(0)
  const tb = (await text.boundingBox())!
  const at = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 }
  const input = page.getByTestId('sketch-text-input')

  // From the rectangle tool: edit, change, ⌘/Ctrl+Enter commits.
  await page.mouse.dblclick(at.x, at.y)
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('Hello')
  await expect(modal(page).getByTestId('sketch-tool-select')).toHaveAttribute('aria-pressed', 'true')
  await input.fill('World')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(input).toBeHidden()
  await expect(shapes(page)).toHaveCount(2)
  await expect(shapes(page).nth(0)).toContainText('World')

  // Esc cancels (select tool now active).
  await page.mouse.dblclick(at.x, at.y)
  await expect(input).toHaveValue('World')
  await input.fill('Nope')
  await page.keyboard.press('Escape')
  await expect(input).toBeHidden()
  await expect(modal(page)).toBeVisible()
  await expect(shapes(page).nth(0)).toContainText('World')

  // From the text tool: no new text is created.
  await tool(page, 'text')
  await page.mouse.dblclick(at.x, at.y)
  await expect(input).toHaveValue('World')
  await input.fill('')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(shapes(page)).toHaveCount(1)

  // A double-click on a rectangle does nothing special.
  await tool(page, 'select')
  await page.mouse.dblclick(b.x + 350, b.y + 200)
  await expect(input).toHaveCount(0)
  await expect(shapes(page)).toHaveCount(1)
})

test('text: an IME Enter never finishes it, Enter adds a line, ⌘/Ctrl+Enter finishes; two lines render and export', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk-ml')
  await page.getByTestId('compose-draw').click()
  await expect(modal(page)).toBeVisible()
  const b = await canvasBox(page)
  await tool(page, 'text')
  await page.mouse.click(b.x + 100, b.y + 100)
  const input = page.getByTestId('sketch-text-input')
  await expect(input).toBeFocused()
  await expect(modal(page).getByTestId('sketch-text-hint')).toContainText('to finish')
  await page.keyboard.type('日本語')

  // A composition: the Enter that confirms it (isComposing, keyCode 229, or Safari's Enter just
  // after compositionend), with or without ⌘/Ctrl, and an Esc during it, all leave it editing.
  await input.evaluate((el) => {
    const key = (init: KeyboardEventInit) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    key({ key: 'Enter', isComposing: true })
    key({ key: 'Enter', isComposing: true, metaKey: true, ctrlKey: true })
    key({ key: 'Escape', isComposing: true })
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' }))
    key({ key: 'Enter', ctrlKey: true, metaKey: true })
    key({ key: 'Enter', keyCode: 229 } as KeyboardEventInit)
  })
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('日本語')
  await expect(shapes(page)).toHaveCount(0)

  // A plain Enter inserts a newline.
  await page.keyboard.press('Enter')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('日本語\n')
  await page.keyboard.type('second line')
  await expect(input).toHaveValue('日本語\nsecond line')
  if (process.env.SKETCH_SHOT) await page.screenshot({ path: process.env.SKETCH_SHOT })

  // ⌘/Ctrl+Enter finishes it: one text shape, drawn on two lines.
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(input).toBeHidden()
  await expect(modal(page)).toBeVisible()
  await expect(shapes(page)).toHaveCount(1)
  const text = shapes(page).nth(0)
  const tspans = text.locator('text tspan')
  await expect(tspans).toHaveCount(2)
  await expect(tspans.nth(0)).toHaveText('日本語')
  await expect(tspans.nth(1)).toHaveText('second line')
  const y0 = Number(await tspans.nth(0).getAttribute('y'))
  const y1 = Number(await tspans.nth(1).getAttribute('y'))
  expect(y1 - y0).toBeGreaterThan(20)
  // The bounds (selection, hit area) cover both lines.
  expect(await num(text, 'data-h')).toBeGreaterThan(y1 - y0 + 20)
  if (process.env.SKETCH_SHOT) await page.screenshot({ path: process.env.SKETCH_SHOT.replace(/\.png$/, '-committed.png') })

  // A click on the second line hits it: double-click edits with the newline kept; Esc cancels.
  await tool(page, 'select')
  const l2 = (await tspans.nth(1).boundingBox())!
  await page.mouse.dblclick(l2.x + l2.width / 2, l2.y + l2.height / 2)
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('日本語\nsecond line')
  await page.keyboard.press('Escape')
  await expect(input).toBeHidden()
  await expect(modal(page)).toBeVisible()
  await expect(tspans).toHaveCount(2)

  // Switching tool while editing finishes the text.
  await tool(page, 'text')
  await page.mouse.click(b.x + 400, b.y + 300)
  await expect(input).toBeFocused()
  await page.keyboard.type('a')
  await page.keyboard.press('Enter')
  await page.keyboard.type('b')
  await tool(page, 'rect')
  await expect(input).toBeHidden()
  await expect(shapes(page)).toHaveCount(2)
  await expect(shapes(page).nth(1).locator('text tspan')).toHaveCount(2)
  await page.getByTestId('sketch-undo').click()
  await expect(shapes(page)).toHaveCount(1)

  // The exported PNG holds both lines: taller than one line of this size would make.
  await page.getByTestId('sketch-done').click()
  await expect(modal(page)).toBeHidden()
  await expect(page.getByTestId('compose-file')).toHaveAttribute('data-state', 'done')
  await page.getByTestId('composer-text').fill('Two lines')
  await page.getByTestId('composer-send').click()
  const img = await sentImage(page)
  // Scale 2, 24px padding each side, 30px text with a 1.25 line height: one line is about 170px.
  expect(img.h).toBeGreaterThan(215)
})

test('white is the 7th color; a white shape keeps #ffffff', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk-white')
  await page.getByTestId('compose-draw').click()
  await expect(modal(page)).toBeVisible()
  await expect(modal(page).locator('[data-testid^="sketch-color-"]')).toHaveCount(7)
  await modal(page).getByTestId('sketch-color-6').click()
  await tool(page, 'rect')
  await drag(page, [60, 60], [200, 140])
  await expect(shapes(page).nth(0).locator('rect')).toHaveAttribute('stroke', '#ffffff')
})

test('rubber-band select, group move, shift-click, delete, alt-duplicate, undo', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk-multi')
  await page.getByTestId('compose-draw').click()
  await expect(modal(page)).toBeVisible()
  await tool(page, 'rect')
  await drag(page, [60, 60], [140, 120])
  await drag(page, [200, 60], [280, 120])
  await drag(page, [400, 60], [480, 120])
  await tool(page, 'select')
  const b = await canvasBox(page)
  const sel = modal(page).locator('[data-selected="true"]')
  const y0 = await num(shapes(page).nth(0), 'data-y')

  await drag(page, [30, 30], [320, 170])
  await expect(sel).toHaveCount(2)
  await expect(modal(page).getByTestId('sketch-handle')).toHaveCount(0)
  await expect(modal(page).getByTestId('sketch-group-box')).toHaveAttribute('data-count', '2')

  // Moving one selected shape moves both, not the third.
  await drag(page, [100, 60], [100, 260])
  await expect(shapes(page).nth(0)).toHaveAttribute('data-y', String(y0 + 200))
  await expect(shapes(page).nth(1)).toHaveAttribute('data-y', String(y0 + 200))
  await expect(shapes(page).nth(2)).toHaveAttribute('data-y', String(y0))

  // Shift-click adds the third.
  await page.keyboard.down('Shift')
  await page.mouse.click(b.x + 440, b.y + 60)
  await page.keyboard.up('Shift')
  await expect(sel).toHaveCount(3)

  // Alt-drag duplicates the whole group; undo restores.
  await page.keyboard.down('Alt')
  await page.mouse.move(b.x + 440, b.y + 60)
  await page.mouse.down()
  await page.mouse.move(b.x + 460, b.y + 90, { steps: 3 })
  await page.mouse.move(b.x + 500, b.y + 120, { steps: 3 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await expect(shapes(page)).toHaveCount(6)
  await expect(sel).toHaveCount(3)
  await page.getByTestId('sketch-undo').click()
  await expect(shapes(page)).toHaveCount(3)

  // Delete removes all selected; undo brings them back.
  await page.keyboard.press('ControlOrMeta+A')
  await expect(sel).toHaveCount(3)
  await page.keyboard.press('Delete')
  await expect(shapes(page)).toHaveCount(0)
  await page.getByTestId('sketch-undo').click()
  await expect(shapes(page)).toHaveCount(3)
})

/** Waits until the selection is exactly these kinds of shape, in drawing order. */
async function expectSel(page: Page, kinds: string[]) {
  await expect
    .poll(() => modal(page).locator('[data-testid="sketch-shape"][data-selected="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind'))))
    .toEqual(kinds)
}

test('picking shapes: tolerance around strokes, inside closed shapes, smallest inside wins, topmost wins, drag from the box, text, hover', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk-pick')
  await page.getByTestId('compose-draw').click()
  await expect(modal(page)).toBeVisible()
  const b = await canvasBox(page)
  const click = (x: number, y: number) => page.mouse.click(b.x + x, b.y + y)

  // A thin pen stroke, a small ellipse with a big unfilled rectangle drawn over it, two crossing
  // lines, a diagonal arrow and a text.
  await modal(page).getByTestId('sketch-width-0').click()
  await tool(page, 'pen')
  await drag(page, [80, 100], [300, 100])
  await modal(page).getByTestId('sketch-width-1').click()
  await tool(page, 'ellipse')
  await drag(page, [600, 200], [660, 260])
  await tool(page, 'rect')
  await drag(page, [500, 100], [800, 400])
  await tool(page, 'line')
  await drag(page, [100, 600], [300, 600])
  await drag(page, [200, 500], [200, 700])
  await tool(page, 'arrow')
  await drag(page, [900, 100], [1100, 300])
  await tool(page, 'text')
  await click(900, 600)
  await page.getByTestId('sketch-text-input').fill('Hello world')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(shapes(page)).toHaveCount(7)
  await tool(page, 'select')
  await click(1250, 500)
  await expectSel(page, [])

  // 8px from a 2px pen stroke picks it (the old hit area reached 7px); 14px away is empty canvas.
  await click(200, 108)
  await expectSel(page, ['pen'])
  await click(200, 114)
  await expectSel(page, [])

  // Inside the unfilled rectangle picks it; inside the small ellipse in it picks the ellipse,
  // although the rectangle was drawn over it.
  await click(540, 360)
  await expectSel(page, ['rect'])
  await click(630, 230)
  await expectSel(page, ['ellipse'])

  // Where the two lines cross, the topmost (the vertical one, drawn last) wins.
  await click(200, 600)
  await expectSel(page, ['line'])
  expect(await num(modal(page).locator('[data-selected="true"]'), 'data-w')).toBe(0)

  // The text: anywhere in its box, also on its last letters.
  const tb = (await shapes(page).nth(6).boundingBox())!
  await page.mouse.click(tb.x + tb.width - 3, tb.y + tb.height / 2)
  await expectSel(page, ['text'])

  // Hover: in select mode the shape a click would pick gets an outline, with a move cursor.
  await click(1250, 500)
  await page.mouse.move(b.x + 1000, b.y + 208)
  await expect(modal(page).getByTestId('sketch-hover')).toHaveCount(1)
  await expect(modal(page).getByTestId('sketch-canvas')).toHaveCSS('cursor', 'move')
  if (process.env.SKETCH_SHOT) await page.screenshot({ path: process.env.SKETCH_SHOT })
  await page.mouse.move(b.x + 1250, b.y + 500)
  await expect(modal(page).getByTestId('sketch-hover')).toHaveCount(0)
  await expect(modal(page).getByTestId('sketch-canvas')).toHaveCSS('cursor', 'default')

  // A selected arrow drags from anywhere in its box, far from its line.
  await click(1000, 200)
  await expectSel(page, ['arrow'])
  const arrow = modal(page).locator('[data-kind="arrow"]')
  const ay = await num(arrow, 'data-y')
  await drag(page, [1060, 130], [1060, 230])
  await expect(arrow).toHaveAttribute('data-y', String(ay + 100))
  await expectSel(page, ['arrow'])
  // Unselected, it is not picked there: that press is on empty canvas.
  await click(1250, 500)
  await click(1060, 230)
  await expectSel(page, [])
  // A click (no drag) inside a selected rectangle, on the ellipse in it, picks the ellipse.
  await click(540, 360)
  await expectSel(page, ['rect'])
  await click(630, 230)
  await expectSel(page, ['ellipse'])
  // A rectangle picked by its inside drags from there.
  await click(540, 360)
  await expectSel(page, ['rect'])
  const rect = modal(page).locator('[data-kind="rect"]')
  const rx = await num(rect, 'data-x')
  await drag(page, [540, 360], [560, 360])
  await expect(rect).toHaveAttribute('data-x', String(rx + 20))

  // With a drawing tool, a click on a shape selects it (and switches to select); a drag still draws.
  await tool(page, 'pen')
  await click(250, 104)
  await expect(modal(page).getByTestId('sketch-tool-select')).toHaveAttribute('aria-pressed', 'true')
  await expectSel(page, ['pen'])
  await expect(shapes(page)).toHaveCount(7)
  await tool(page, 'pen')
  await drag(page, [150, 90], [150, 160])
  await expect(shapes(page)).toHaveCount(8)
  await tool(page, 'rect')
  await page.mouse.click(tb.x + 5, tb.y + tb.height / 2)
  await expectSel(page, ['text'])
  await expect(shapes(page)).toHaveCount(8)
  // A pen click inside an unfilled shape (not on its line) still leaves a dot.
  await tool(page, 'pen')
  await click(700, 330)
  await expect(shapes(page)).toHaveCount(9)
})

test.describe('touch', () => {
  test.use({ hasTouch: true })
  test('a tap picks a thin line with a wider touch tolerance', async ({ page, minbox }) => {
    await page.setViewportSize({ width: 1500, height: 900 })
    await page.goto(minbox.url)
    await openStream(page, minbox, 'sk-touch')
    await page.getByTestId('compose-draw').click()
    await expect(modal(page)).toBeVisible()
    await modal(page).getByTestId('sketch-width-0').click()
    await tool(page, 'line')
    await drag(page, [100, 200], [400, 200])
    await tool(page, 'select')
    const b = await canvasBox(page)
    // 14px off the line: too far for a mouse, near enough for a finger.
    await page.mouse.click(b.x + 250, b.y + 214)
    await expectSel(page, [])
    await page.touchscreen.tap(b.x + 250, b.y + 214)
    await expectSel(page, ['line'])
  })
})

/** The newest sent message's first image, decoded in the page: the RGB of the pixel at (fx, fy),
 * fractions of its width and height. */
async function sentPixel(page: Page, fx: number, fy: number) {
  const img = page.locator('[data-testid="v3-message"][data-author="user"]').getByTestId('attachment-card').first().locator('img').first()
  await expect(img).toBeVisible()
  const src = new URL((await img.getAttribute('src'))!, page.url()).toString()
  return page.evaluate(
    async ({ src, fx, fy }) => {
      const bmp = await createImageBitmap(await (await fetch(src)).blob())
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const g = c.getContext('2d')!
      g.drawImage(bmp, 0, 0)
      const d = g.getImageData(Math.round(bmp.width * fx), Math.round(bmp.height * fy), 1, 1).data
      return [d[0], d[1], d[2]]
    },
    { src, fx, fy },
  )
}

const shots = process.env.SKETCH_FILL_SHOTS

test('fill: pick a tint for new shapes, change it on a selection (undo), none, lines have none, export and re-edit', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await openStream(page, minbox, 'sk-fill')
  await page.getByTestId('compose-draw').click()
  await expect(modal(page)).toBeVisible()
  const m = modal(page)
  const fillBtn = m.getByTestId('sketch-fill')
  const menu = m.getByTestId('sketch-fill-menu')
  const b = await canvasBox(page)

  // The default is no fill; the picker offers none plus the palette.
  await tool(page, 'rect')
  await expect(fillBtn).toHaveAttribute('data-fill', 'none')
  await fillBtn.click()
  await expect(menu.getByRole('menuitemradio')).toHaveCount(8)
  await expect(m.getByTestId('sketch-fill-none')).toHaveAttribute('aria-checked', 'true')
  if (shots) await page.screenshot({ path: `${shots}/desktop-fill-menu.png` })
  // Esc closes the picker, not the sketcher.
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(m).toBeVisible()

  // A blue fill: the new rectangle is filled with its tint.
  await fillBtn.click()
  await m.getByTestId('sketch-fill-4').click()
  await expect(menu).toBeHidden()
  await expect(fillBtn).toHaveAttribute('data-fill', '#2563eb')
  await drag(page, [100, 100], [300, 250])
  const a = shapes(page).nth(0).locator('rect')
  await expect(a).toHaveAttribute('fill', '#2563eb')
  await expect(a).toHaveAttribute('fill-opacity', '0.3')

  // Lines, arrows, pen, text and the eraser have no fill: the control is off for them.
  for (const t of ['line', 'arrow', 'pen', 'text', 'eraser']) {
    await tool(page, t)
    await expect(fillBtn).toBeDisabled()
  }
  await tool(page, 'ellipse')
  await expect(fillBtn).toBeEnabled()

  // None: the next rectangle has no fill.
  await tool(page, 'rect')
  await fillBtn.click()
  await m.getByTestId('sketch-fill-none').click()
  await drag(page, [400, 100], [600, 250])
  await expect(shapes(page).nth(1).locator('rect')).toHaveAttribute('fill', 'none')

  // A click inside the filled rectangle selects it; the picker shows its fill. Changing the fill
  // and the stroke color of the selection updates it, and undo/redo step through.
  await tool(page, 'select')
  await page.mouse.click(b.x + 200, b.y + 175)
  await expectSel(page, ['rect'])
  await expect(fillBtn).toHaveAttribute('data-fill', '#2563eb')
  await fillBtn.click()
  await m.getByTestId('sketch-fill-1').click()
  await expect(a).toHaveAttribute('fill', '#dc2626')
  await m.getByTestId('sketch-color-3').click()
  await expect(a).toHaveAttribute('stroke', '#16a34a')
  await page.getByTestId('sketch-undo').click()
  await expect(a).toHaveAttribute('stroke', '#111827')
  await expect(a).toHaveAttribute('fill', '#dc2626')
  await page.getByTestId('sketch-undo').click()
  await expect(a).toHaveAttribute('fill', '#2563eb')
  await page.getByTestId('sketch-redo').click()
  await expect(a).toHaveAttribute('fill', '#dc2626')
  await page.getByTestId('sketch-undo').click()
  await expect(a).toHaveAttribute('fill', '#2563eb')
  await expect(shapes(page).nth(1).locator('rect')).toHaveAttribute('fill', 'none')

  // The unfilled rectangle shows none.
  await page.mouse.click(b.x + 400, b.y + 175)
  await expectSel(page, ['rect'])
  await expect(fillBtn).toHaveAttribute('data-fill', 'none')

  // Saved and edited again: the fill comes back.
  await page.getByTestId('sketch-done').click()
  await expect(m).toBeHidden()
  const tile = page.getByTestId('compose-file')
  await expect(tile).toHaveAttribute('data-state', 'done')
  await tile.getByTestId('file-edit').click()
  await expect(shapes(page)).toHaveCount(2)
  await expect(shapes(page).nth(0).locator('rect')).toHaveAttribute('fill', '#2563eb')
  await expect(shapes(page).nth(1).locator('rect')).toHaveAttribute('fill', 'none')
  await page.keyboard.press('Escape')
  await expect(m).toBeHidden()

  // The PNG: the inside of the filled rectangle is the blue tint, the unfilled one stays white.
  // The image spans the shapes' box (100..600 x 100..250) plus 24px on each side.
  await page.getByTestId('composer-text').fill('Filled')
  await page.getByTestId('composer-send').click()
  const fx = (x: number) => (x - 76) / 548
  const fy = (y: number) => (y - 76) / 198
  const filled = await sentPixel(page, fx(200), fy(175))
  const blue = [255 * 0.7 + 0x25 * 0.3, 255 * 0.7 + 0x63 * 0.3, 255 * 0.7 + 0xeb * 0.3]
  filled.forEach((v, i) => expect(Math.abs(v - blue[i])).toBeLessThan(8))
  expect(await sentPixel(page, fx(500), fy(175))).toEqual([255, 255, 255])
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('the toolbar with the fill picker fits the phone width', async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await openStream(page, minbox, 'sk-fill-phone')
    await page.getByTestId('reply-actions').click()
    await page.getByTestId('compose-draw').click()
    await expect(modal(page)).toBeVisible()
    const bar = modal(page).getByTestId('sketch-toolbar')
    const fillBtn = modal(page).getByTestId('sketch-fill')
    await expect(fillBtn).toBeVisible()
    await fillBtn.click()
    const menu = modal(page).getByTestId('sketch-fill-menu')
    await expect(menu).toBeVisible()
    const mb = (await menu.boundingBox())!
    expect(mb.x).toBeGreaterThanOrEqual(0)
    expect(mb.x + mb.width).toBeLessThanOrEqual(390)
    for (const el of [bar, modal(page)]) {
      const [sw, cw] = await el.evaluate((e) => [e.scrollWidth, e.clientWidth])
      expect(sw).toBeLessThanOrEqual(cw)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    if (shots) await page.screenshot({ path: `${shots}/phone-fill-menu.png` })
    await modal(page).getByTestId('sketch-fill-2').click()
    await expect(fillBtn).toHaveAttribute('data-fill', '#ea580c')
    if (shots) await page.screenshot({ path: `${shots}/phone-toolbar.png` })
  })
})
