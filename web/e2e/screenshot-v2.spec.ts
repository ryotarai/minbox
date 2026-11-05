import { createSession, createShellSession, expect, expectTerminal, selectSession, test, typeInTerminal } from './fixtures'

// Not a check: screenshots of the threads-first UI for a look (SCREENSHOTS=1 SCREENSHOT_DIR=...).
test('screenshots: threads-first UI', async ({ page, minbox }) => {
  test.skip(process.env.SCREENSHOTS !== '1', 'set SCREENSHOTS=1')
  test.setTimeout(240_000)
  const out = process.env.SCREENSHOT_DIR ?? 'test-results'
  const shot = async (name: string) => {
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${out}/${name}.png` })
  }
  await page.emulateMedia({ colorScheme: process.env.LIGHT ? 'light' : 'dark' })
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)

  await createSession(page, minbox.dataDir, 'api-gateway')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'title Rate limiting for the public API')
  await typeInTerminal(page, 'say Finished the login page; tests pass.')
  await createSession(page, minbox.dataDir, 'istio-rollout')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'title Canary rollout of the mesh')
  await typeInTerminal(page, 'ask')
  await createSession(page, minbox.dataDir, 'minbox-ui')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'title Threads-first layout')
  await typeInTerminal(page, 'attach')
  await expectTerminal(page, /sent attach/)
  await typeInTerminal(page, 'actions')
  await expectTerminal(page, /sent actions/)
  await createSession(page, minbox.dataDir, 'docs-site')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Draft of the install guide is ready.')
  await createShellSession(page, minbox, 'scratch-shell')
  await expect(page.getByTestId('thread-row')).toHaveCount(5)

  // 1500px: a waiting question open, the composer's session selector open.
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('composer-target').click()
  await shot('01-desktop-1500-session-selector')
  await page.keyboard.press('Escape')

  // The default list: flat by activity.
  await shot('02-desktop-1500-thread-open')

  // Filters: Waiting, and the session filter popover.
  await page.getByTestId('filter-waiting').click()
  await shot('03-filter-waiting')
  await page.getByTestId('filter-all').click()
  await page.getByTestId('session-filter').click()
  await shot('04-filter-session-popover')
  await page.keyboard.press('Escape')
  await page.getByTestId('group-by').click()
  await page.getByTestId('group-session').click()
  await shot('05-group-by-session')
  await page.getByTestId('group-by').click()
  await page.getByTestId('group-activity').click()

  // The new-session path from the composer, with text typed.
  await page.getByTestId('quick-body').fill('Add a Retry-After header to the 429 responses')
  await page.getByTestId('composer-target').click()
  await page.getByTestId('composer-new-session').click()
  await page.getByTestId('new-session-cwd').fill(minbox.dataDir)
  await page.getByTestId('new-session-name').fill('retry-after')
  await shot('06-composer-new-session')
  await page.getByTestId('new-session-start').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('retry-after')
  await expect(page.getByTestId('thread-subject')).toBeVisible()
  await shot('07-after-new-session-send')

  // 1920px with the shell pane.
  await page.setViewportSize({ width: 1920, height: 1000 })
  await selectSession(page, 'minbox-ui')
  await page.getByTestId('session-filter').click()
  await page.getByTestId('session-all').click()
  await page.getByTestId('thread-row').filter({ hasText: 'Before the deploy' }).click()
  await shot('08-desktop-1920')
  await page.getByTestId('shell-toggle').click()
  await shot('09-desktop-1920-shell')

  // Phone.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await shot('10-phone-home')
  await page.getByTestId('composer-target').click()
  await shot('11-phone-composer-selector')
  await page.keyboard.press('Escape')
  await page.getByTestId('session-filter').click()
  await shot('12-phone-session-sheet')
  await page.getByTestId('sheet-close').click()
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await shot('13-phone-thread')
  await page.getByTestId('thread-open-terminal').click()
  await shot('14-phone-terminal')
})
