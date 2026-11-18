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
