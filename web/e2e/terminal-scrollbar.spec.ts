import { createSession, expect, expectTerminal, terminalText, test } from './fixtures'

// ghostty-web paints an overlay scrollbar over the right edge of the text. It is never shown;
// scrolling itself keeps working.
test('the terminal scrolls with the wheel and never paints a scrollbar', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'work')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('shell-toggle').click()
  const pane = page.getByTestId('shell-pane').getByTestId('terminal')
  await pane.click()
  await page.keyboard.type('seq 1 300; echo done-$((6*7))')
  await page.keyboard.press('Enter')
  await expect.poll(() => terminalText(page, 'shell'), { timeout: 15_000 }).toContain('done-42')

  const state = () =>
    page.evaluate(() => {
      const t = (window as any).__minboxShellTerminal
      const c = document.querySelector('[data-testid="shell-pane"] canvas') as HTMLCanvasElement
      const ctx = c.getContext('2d')!
      const dpr = c.width / c.getBoundingClientRect().width
      // The strip where ghostty's scrollbar would be: the 8px track, 4px from the right edge.
      const x0 = Math.floor(c.width - 12 * dpr)
      const w = Math.floor(8 * dpr)
      const data = ctx.getImageData(x0, 0, w, c.height).data
      const seen = new Set<number>()
      for (let i = 0; i < data.length; i += 4) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
      return { viewportY: t.viewportY as number, colors: seen.size, scrollback: t.wasmTerm.getScrollbackLength() as number }
    })

  const before = await state()
  expect(before.scrollback).toBeGreaterThan(100)
  await pane.hover()
  await page.mouse.wheel(0, -600)
  await expect.poll(async () => (await state()).viewportY, { timeout: 5000 }).toBeGreaterThan(0)
  await page.waitForTimeout(500) // past the 200 ms fade-in
  // Sampled while the scroll would have faded the bar in (it stays up 1.5 s).
  expect((await state()).colors).toBe(1)
})
