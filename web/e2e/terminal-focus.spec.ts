import { createSession, expect, expectTerminal, test } from './fixtures'

// The terminal shows a ring while it has keyboard focus.
test('terminal focus ring follows focus', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'work')
  await expectTerminal(page, 'ready>')
  const ring = page.getByTestId('terminal-focus-ring').first()
  await page.getByTestId('terminal').first().click()
  await expect(ring).toHaveAttribute('data-focused', 'true')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(ring).toHaveAttribute('data-focused', 'false')
})
