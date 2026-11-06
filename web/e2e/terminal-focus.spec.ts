import { createSession, expect, expectTerminal, test } from './fixtures'

// The terminal's own outer border turns accent while the terminal has keyboard focus (no extra inner border).
test('terminal pane border follows focus', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'work')
  await expectTerminal(page, 'ready>')
  const color = () =>
    page.getByTestId('terminal').first().evaluate((el) => {
      let n: HTMLElement | null = el.parentElement
      while (n && getComputedStyle(n).borderTopWidth === '0px') n = n.parentElement
      return n ? getComputedStyle(n).borderTopColor : ''
    })
  await page.getByTestId('terminal').first().click()
  const focused = await color()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect.poll(color).not.toBe(focused)
  await page.getByTestId('terminal').first().click()
  await expect.poll(color).toBe(focused)
  await expect(page.getByTestId('terminal-focus-ring')).toHaveCount(0)
})
