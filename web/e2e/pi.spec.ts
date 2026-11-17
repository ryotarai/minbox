import { createSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'

// Pi as a second coding agent (docs/agents.md), driven by the fake pi (e2e/fake-pi.py): the New
// session dialog offers the installed agents, a Pi session gets Pi's command line and tool names,
// and status / messages / replies flow through the same inbox as for Claude Code.

test('with two agents installed the dialog offers both and starts a Pi session', async ({ page, piMinbox }) => {
  await page.goto(piMinbox.url)
  await createSession(page, piMinbox.dataDir, 'pi-demo', 'pi')

  // The fake pi got the extension, a conversation id, and Pi's instructions (its tool names, no orchestrator).
  await expectTerminal(page, /fake-pi session=[0-9a-f-]{36}[\s\S]*extension=minbox\.ts/)
  await expectTerminal(page, 'hello agent=pi orchestration=no tools=minbox_')
  await expect(page.getByTestId('agent-tag').first()).toHaveText('Pi')

  await typeInTerminal(page, 'args')
  await expectTerminal(page, /args \[[\s\S]*\]\s*ready>/)
  const flat = (await terminalText(page)).replace(/\s+/g, '')
  expect(flat).toMatch(/"-e","[^"]*pi-extension[^"]*minbox\.ts","-e","[^"]*pi-extension[^"]*subagent\.ts","--session-id","[0-9a-f-]{36}","--append-system-prompt"/)

  // The API says so too.
  const sessions = await (await fetch(piMinbox.url + '/api/sessions')).json()
  expect(sessions.map((s: any) => s.agent)).toEqual(['pi'])
})

// v3: drove the thread-centric UI (thread list / thread view / new-session dialog), which is gone; see docs/v3/usecases.md for its v3 counterpart.
test.skip('a Pi session reports status and its messages and the replies flow through the inbox', async ({ page, piMinbox }) => {
  await page.goto(piMinbox.url)
  await createSession(page, piMinbox.dataDir, 'pi-flow', 'pi')
  await expectTerminal(page, 'ready>')

  // Pi sends a question (as the extension's minbox_send_message does).
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  const row = page.getByTestId('thread-row').filter({ hasText: 'Pick a database' })
  await expect(row).toBeVisible()
  await expect(page.getByTestId('filter-waiting-count')).toHaveText('1')
  await row.click()
  const card = page.getByTestId('question-card').first()
  await card.getByTestId('accept-recommended').click()
  await page.getByTestId('reply-box').fill('Go with it.')
  await page.getByTestId('reply-send').click()

  // The reply is picked up (claim -> delivered) by the Pi side.
  await expectTerminal(page, '<<< inbox [Pick a database]')
  expect(await terminalText(page)).toContain('Answer: SQLite (your recommendation)')
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')

  // The person starts a thread of their own; the session title the agent sets shows up.
  await page.getByTestId('quick-body').fill('Please also update the README')
  await page.getByTestId('quick-send').click()
  await expectTerminal(page, '<<< inbox [Please also update the README]')
  await typeInTerminal(page, 'title Choose the database')
  await expect(page.getByTestId('terminal-session-title')).toHaveText('Choose the database')

  // working / idle reach the session status.
  await typeInTerminal(page, 'work')
  await expect.poll(async () => (await (await fetch(piMinbox.url + '/api/sessions')).json())[0].status).toBe('working')
  await typeInTerminal(page, 'idle')
  await expect.poll(async () => (await (await fetch(piMinbox.url + '/api/sessions')).json())[0].status).toBe('idle')
})

test('a restarted Pi session continues the same conversation id', async ({ page, piMinbox }) => {
  await page.goto(piMinbox.url)
  await createSession(page, piMinbox.dataDir, 'pi-restart', 'pi')
  await expectTerminal(page, /fake-pi session=[0-9a-f-]{36}/)
  const [s] = await (await fetch(piMinbox.url + '/api/sessions')).json()
  const r = await fetch(piMinbox.url + `/api/sessions/${s.id}/restart`, { method: 'POST' })
  expect(r.status).toBe(200)
  await expectTerminal(page, `fake-pi session=${s.claude_session_id}`)
  const after = (await (await fetch(piMinbox.url + '/api/sessions')).json())[0]
  expect(after.claude_session_id).toBe(s.claude_session_id)
})

// v3: drove the thread-centric UI (thread list / thread view / new-session dialog), which is gone; see docs/v3/usecases.md for its v3 counterpart.
test.skip('with only Pi installed there is no picker, Pi is the default, and nothing needs claude', async ({ page, piOnlyMinbox }) => {
  const agents = await (await fetch(piOnlyMinbox.url + '/api/agents')).json()
  expect(agents.default).toBe('pi')
  expect(agents.agents.map((a: any) => [a.kind, a.installed])).toEqual([
    ['claude', false],
    ['pi', true],
    ['opencode', false],
  ])

  await page.goto(piOnlyMinbox.url)
  // The dialog: no agent choice, and the button names the only agent.
  const form = page.getByTestId('new-session-cwd').or(page.getByTestId('new-session-project'))
  for (let i = 0; i < 30 && !(await form.isVisible()); i++) await page.getByTestId('new-session').click({ timeout: 500 }).catch(() => {})
  await expect(form).toBeVisible()
  await expect(page.getByTestId('new-session-start')).toContainText('Start Pi')
  await expect(page.getByTestId('new-session-agent')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await createSession(page, piOnlyMinbox.dataDir, 'solo')
  await expectTerminal(page, 'hello agent=pi')
  const [s] = await (await fetch(piOnlyMinbox.url + '/api/sessions')).json()
  expect(s.agent).toBe('pi')

})

test('Settings lists the agents; the default can be chosen when both are installed', async ({ page, piMinbox, minbox }) => {
  await page.goto(piMinbox.url + '/#v=settings&ss=capabilities')
  await expect(page.getByTestId('agent-status-claude')).toHaveText('installed')
  await expect(page.getByTestId('agent-status-pi')).toHaveText('installed')
  await page.getByTestId('default-agent').selectOption('pi')
  await expect.poll(async () => (await (await fetch(piMinbox.url + '/api/settings')).json()).default_agent).toBe('pi')

  // Pi not installed: it is listed as missing and there is no default to choose.
  await page.goto(minbox.url + '/#v=settings&ss=capabilities')
  await expect(page.getByTestId('agent-status-pi')).toHaveText('not installed')
  await expect(page.getByTestId('default-agent')).toHaveCount(0)
})
