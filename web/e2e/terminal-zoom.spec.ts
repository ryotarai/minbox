import { createSession, createShellSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'

// Text size zooms the page (CSS zoom on #root). A drag in the terminal must
// select the row under the mouse, not one lower by the zoom's share.
test.use({ deviceScaleFactor: 2 }) // a Retina screen, where the offset showed
test('under a larger text size, a drag selects the row under the mouse', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(minbox.url)
  await createShellSession(page, minbox, 'zoomed')
  await typeInTerminal(page, 'for i in $(seq 1 120); do echo "row$i"; done')
  await expectTerminal(page, 'row120')
  await page.evaluate(() => ((document.getElementById('root') as HTMLElement).style.zoom = '1.2'))

  const canvas = page.locator('.mb-term canvas')
  await expect.poll(() => canvas.evaluate((c) => c.getBoundingClientRect().width / (c as HTMLElement).offsetWidth)).toBeCloseTo(1.2)
  await page.waitForTimeout(500) // the refit after the zoom
  const rows = await page.evaluate(() => (window as any).__minboxTerminal.rows as number)
  const screen = (await terminalText(page)).split('\n').slice(-rows)
  const box = (await canvas.boundingBox())!
  for (const row of [5, 15, rows - 8]) {
    const y = box.y + (box.height / rows) * (row + 0.5)
    await page.mouse.move(box.x + 2, y)
    await page.mouse.down()
    await page.mouse.move(box.x + 60, y, { steps: 4 })
    await page.mouse.up()
    expect(await page.evaluate(() => (window as any).__minboxTerminal.getSelection())).toBe(screen[row].slice(0, 7).trimEnd())
  }
})
