import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { startAgent } from './v3'

// The Files pane's viewer: a Word wrap toggle beside Copy. On, long lines wrap (no horizontal
// scroll) and each line number stays on its line's first row; the choice is kept across reloads.

async function openFile(page: Page) {
  const row = (p: string) => page.getByTestId('files-tree').locator(`[data-item-path="${p}"]`)
  if (!(await page.getByTestId('files-pane').isVisible())) await page.getByTestId('files-toggle').click()
  await row('long.txt').click()
  await expect(page.getByTestId('file-viewer-code')).toContainText('second line')
}

test('the Files viewer: Word wrap removes the horizontal scroll and is kept after a reload', async ({ page, minbox }) => {
  const dir = join(minbox.dataDir, 'wproj')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'long.txt'), `${'word '.repeat(150)}end\nsecond line\n`)
  const a = await startAgent(minbox, 'alpha', 'wproj')
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('composer-text')).toBeVisible()
  await openFile(page)

  const wrapBtn = page.getByTestId('file-viewer-wrap')
  const scroll = page.getByTestId('file-viewer-scroll')
  const overflow = () => scroll.evaluate((el) => el.scrollWidth - el.clientWidth)
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'false')
  await expect(wrapBtn).toHaveAccessibleName('Word wrap')
  expect(await overflow()).toBeGreaterThan(0)

  await wrapBtn.click()
  await expect(wrapBtn).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(overflow).toBeLessThanOrEqual(0)
  // Line 2's number sits beside "second line", below the wrapped first line.
  const rows = page.getByTestId('file-viewer-code').locator(':scope > div')
  const first = await rows.nth(0).boundingBox()
  const second = await rows.nth(1).boundingBox()
  expect(first!.height).toBeGreaterThan(second!.height * 2)
  const num2 = await rows.nth(1).locator('span').first().boundingBox()
  expect(Math.abs(num2!.y - second!.y)).toBeLessThan(2)

  await page.reload()
  await expect(page.getByTestId('composer-text')).toBeVisible()
  await openFile(page)
  await expect(page.getByTestId('file-viewer-wrap')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(overflow).toBeLessThanOrEqual(0)

  // Off again: back to one row per line and a horizontal scroll.
  await page.getByTestId('file-viewer-wrap').click()
  await expect(page.getByTestId('file-viewer-wrap')).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(overflow).toBeGreaterThan(0)
})

// Full screen, as in the attachment viewer: the viewer covers the window with its toolbar (Word wrap,
// Copy, exit); Esc or the button returns it to the pane. Desktop, tablet and phone widths.
for (const [label, width, height] of [
  ['desktop', 1500, 900],
  ['tablet', 900, 1100],
  ['phone', 390, 800],
] as const) {
  test(`the Files viewer: full screen covers the window, keeps Word wrap and Esc returns (${label})`, async ({ page, minbox }) => {
    const dir = join(minbox.dataDir, 'fproj')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'long.txt'), `${'word '.repeat(150)}end\nsecond line\n`)
    const a = await startAgent(minbox, 'alpha', 'fproj')
    await page.setViewportSize({ width, height })
    await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
    await expect(page.getByTestId('composer-text')).toBeVisible()
    if (!(await page.getByTestId('files-toggle').isVisible())) {
      await page.locator('body').click({ position: { x: 1, y: 1 } })
      await page.keyboard.press('Shift+F')
    }
    await openFile(page)

    const viewer = page.getByTestId('file-viewer')
    const fsBtn = page.getByTestId('file-viewer-fullscreen')
    const area = async () => {
      const b = (await viewer.boundingBox())!
      return b.width * b.height
    }
    await expect(fsBtn).toHaveAccessibleName('Full screen')
    expect(await area()).toBeLessThan(width * height * 0.9)

    await fsBtn.click()
    await expect(fsBtn).toHaveAccessibleName('Exit full screen')
    await expect(viewer).toHaveAttribute('data-full', 'true')
    await expect.poll(async () => (await viewer.boundingBox())!).toEqual({ x: 0, y: 0, width, height })
    // On top of everything: the element at the middle and the bottom corners is the viewer's.
    const covers = await page.evaluate(
      ([w, h]) => {
        const v = document.querySelector('[data-testid="file-viewer"]')!
        return [[w / 2, h / 2], [5, h - 5], [w - 5, h - 5]].every(([x, y]) => v.contains(document.elementFromPoint(x!, y!)))
      },
      [width, height],
    )
    expect(covers).toBe(true)
    await expect(page.getByTestId('file-viewer-copy')).toBeVisible()
    await expect(page.getByTestId('file-viewer-path')).toContainText('long.txt')

    // Word wrap works in full screen.
    const scroll = page.getByTestId('file-viewer-scroll')
    const overflow = () => scroll.evaluate((el) => el.scrollWidth - el.clientWidth)
    const wrapBtn = page.getByTestId('file-viewer-wrap')
    if ((await wrapBtn.getAttribute('aria-pressed')) === 'true') await wrapBtn.click()
    await expect(wrapBtn).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(overflow).toBeGreaterThan(0)
    await wrapBtn.click()
    await expect(wrapBtn).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(overflow).toBeLessThanOrEqual(0)

    // Esc returns to the pane, with the file still open.
    await page.keyboard.press('Escape')
    await expect(viewer).not.toHaveAttribute('data-full', 'true')
    await expect(viewer).toBeVisible()
    await expect.poll(area).toBeLessThan(width * height * 0.9)

    // The button too: in and out again.
    await fsBtn.click()
    await expect(viewer).toHaveAttribute('data-full', 'true')
    await fsBtn.click()
    await expect(viewer).not.toHaveAttribute('data-full', 'true')
    await expect(page.getByTestId('file-viewer-code')).toContainText('second line')
  })
}
