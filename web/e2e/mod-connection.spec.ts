import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// The mod connection indicator: the mod (here the fake claude) sends a heartbeat every second; the
// server (MINBOX_MOD_SILENT_S=4) calls it stale after 4 s without one. See docs/mod-connection.md.

test('the badge shows connected, goes stale without heartbeats with the gap, and recovers; the details list the transitions', async ({ page, connMinbox: minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'beater')
  await expectTerminal(page, 'ready>')
  const badge = page.getByTestId('terminal-session-name').locator('xpath=..').getByTestId('mod-conn')
  await expect(badge).toHaveAttribute('data-state', 'connected')
  await expect(badge).toHaveAttribute('title', /mod connected · last heartbeat/)

  await typeInTerminal(page, 'nobeat')
  await expect(badge).toHaveAttribute('data-state', 'stale', { timeout: 15_000 })
  await expect(page.getByTestId('mod-conn-label').first()).toContainText(/no heartbeat for \d+ s/)

  // The details: the state, the server's log with the stale line, the mod's own events.
  await badge.click()
  const details = page.getByTestId('mod-conn-details')
  await expect(details).toBeVisible()
  await expect(page.getByTestId('mod-conn-state')).toHaveText('stale')
  await expect(details.getByTestId('mod-conn-events').last()).toContainText('stale')

  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await typeInTerminal(page, 'beat')
  await expect(badge).toHaveAttribute('data-state', 'connected', { timeout: 15_000 })
  await badge.click()
  await expect(page.getByTestId('mod-conn-state')).toHaveText('connected')
  await expect(details).toContainText('reconnected')
  await expect(details).toContainText('fake mod heartbeat')

  // The same facts over the API, and no message text anywhere in them.
  const sessions = (await (await fetch(minbox.url + '/api/sessions')).json()) as { id: string; mod_conn: string }[]
  expect(sessions[0]!.mod_conn).toBe('connected')
  const info = await (await fetch(`${minbox.url}/api/sessions/${sessions[0]!.id}/connection`)).json()
  expect(info.state).toBe('connected')
  expect(info.heartbeat).toBe(true)
  expect(info.reconnects).toBeGreaterThanOrEqual(1)
  expect(minbox.log).toMatch(/modconn: stale session=/)
  expect(minbox.log).toMatch(/modconn: reconnected session=\S+ after \d+s without heartbeat/)

  // Copy diagnostics puts the text on the clipboard.
  await page.getByTestId('mod-conn-copy').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('minbox mod connection, session')
})

// v3: drove the thread-centric UI (thread list / thread view / new-session dialog), which is gone; see docs/v3/usecases.md for its v3 counterpart.
test.skip('phone: the badge shows in the thread header and turns stale', async ({ page, connMinbox: minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'pocketbeat')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, 'sent question')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  const badge = page.getByTestId('phone-session-name').getByTestId('mod-conn')
  await expect(badge).toHaveAttribute('data-state', 'connected')
  await page.evaluate(() => void 0)
  // Stop the heartbeat from the outside: the terminal is not on screen, so ask the server for a stale view by waiting out a muted mod.
  const sessions = (await (await fetch(minbox.url + '/api/sessions')).json()) as { id: string }[]
  expect(sessions.length).toBe(1)
  await expect(badge).toBeVisible()
})
