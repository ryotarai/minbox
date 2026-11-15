import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// The agent terminal pane has a close (×) in its header, like the shell pane: it hides the pane and
// leaves the agent running.

test('desktop: the terminal pane closes from its own ×; the session keeps running', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'closer')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Hello thread')
  await expectTerminal(page, /sent .*thr_/)

  const close = page.locator('main').getByTestId('terminal-close')
  await expect(close).toHaveAttribute('aria-label', 'Close terminal')
  await expect(close).toHaveAttribute('title', /Close terminal/)
  await close.click()
  await expect(page.locator('main')).toHaveCount(0)
  await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'false')

  const sessions = await (await page.request.get(minbox.url + '/api/sessions')).json()
  expect(sessions[0].status).not.toBe('ended')

  // Shown again: the same process, its screen intact.
  await page.getByTestId('terminal-toggle').click()
  await expectTerminal(page, /sent .*thr_/)
})

test('tablet: the terminal × goes back to the list view', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'tab')
  await expectTerminal(page, 'ready>')
  await page.setViewportSize({ width: 900, height: 844 })
  await page.getByTestId('tablet-terminal').click()
  await expect(page.getByTestId('tablet')).toHaveAttribute('data-view', 'terminal')
  await page.getByTestId('terminal-close').click()
  await expect(page.getByTestId('tablet')).toHaveAttribute('data-view', 'list')
  const sessions = await (await page.request.get(minbox.url + '/api/sessions')).json()
  expect(sessions[0].status).not.toBe('ended')
})
