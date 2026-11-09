import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Desktop: the Claude Code terminal pane is hidden by default (the threads are the way in). A button
// in the thread header shows and hides it; the choice survives a reload; the session keeps running.

test('desktop: the terminal is hidden by default, the toggle shows and hides it, a reload keeps the choice', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'keepme-42')
  await expectTerminal(page, 'echo: keepme-42')

  // Nothing stored: hidden.
  await page.evaluate(() => localStorage.removeItem('minbox:layout'))
  await page.reload()
  const toggle = page.getByTestId('terminal-toggle')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toHaveAttribute('aria-label', 'Show terminal')
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  // The freed space goes to the thread pane.
  const thread = (await page.getByTestId('thread-pane').boundingBox())!
  const desktop = (await page.getByTestId('desktop').boundingBox())!
  expect(thread.x + thread.width).toBeGreaterThan(desktop.x + desktop.width - 2)

  await toggle.click()
  await expect(page.getByTestId('terminal')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAttribute('aria-label', 'Hide terminal')
  await expectTerminal(page, 'echo: keepme-42') // the session output is intact after attaching again

  await page.reload()
  await expect(page.getByTestId('terminal')).toBeVisible()
  await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('terminal')).toHaveCount(0)
})
