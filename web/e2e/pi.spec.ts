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
  // Mod protocol 1: the tool set is the server's, and the session is not flagged as an old mod.
  await expectTerminal(page, 'tool set 12 tools, send=yes')
  await expect(page.locator('[data-testid="mod-conn"][data-outdated]')).toHaveCount(0)

  await typeInTerminal(page, 'args')
  await expectTerminal(page, /args \[[\s\S]*\]\s*ready>/)
  const flat = (await terminalText(page)).replace(/\s+/g, '')
  expect(flat).toMatch(/"-e","[^"]*pi-extension[^"]*minbox\.ts","-e","[^"]*pi-extension[^"]*subagent\.ts","--session-id","[0-9a-f-]{36}","--append-system-prompt"/)

  // The API says so too.
  const sessions = await (await fetch(piMinbox.url + '/api/sessions')).json()
  expect(sessions.map((s: any) => s.agent)).toEqual(['pi'])
})

test('a Pi session reports status and its messages; the person’s messages from its stream reach it', async ({ page, piMinbox }) => {
  await page.goto(piMinbox.url)
  await createSession(page, piMinbox.dataDir, 'pi-flow', 'pi')
  await expectTerminal(page, 'ready>')

  // Pi sends a question (as the extension's minbox_send_message does): it waits on the Board.
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, 'sent question: Sent to the person in minbox asking 1 question.')
  await expect(page.getByTestId('board-badge')).toHaveText('1')

  // A message from the agent's stream is picked up (claim -> delivered) by the Pi side.
  await page.getByTestId('composer-text').fill('Please also update the README')
  await page.getByTestId('composer-send').click()
  await expectTerminal(page, '<<< inbox')
  await expectTerminal(page, 'Please also update the README')
  // The session title the agent sets shows up in the agents list.
  await typeInTerminal(page, 'title Choose the database')
  await expect(page.getByTestId('agent-row').filter({ hasText: 'pi-flow' })).toContainText('Choose the database')

  // working / idle reach the session status; while working, the person's message goes into the
  // running turn at once (Pi steers it in).
  await typeInTerminal(page, 'work')
  await expect.poll(async () => (await (await fetch(piMinbox.url + '/api/sessions')).json())[0].status).toBe('working')
  await page.getByTestId('composer-text').fill('And the CHANGELOG')
  await page.getByTestId('composer-send').click()
  await expectTerminal(page, 'And the CHANGELOG')
  await typeInTerminal(page, 'idle')
  await expect.poll(async () => (await (await fetch(piMinbox.url + '/api/sessions')).json())[0].status).toBe('idle')
})

test('New agent offers the installed agents; picking Pi starts a Pi agent', async ({ page, piMinbox }) => {
  await page.goto(piMinbox.url)
  await page.getByTestId('project-new-agent').or(page.getByTestId('first-agent')).first().click()
  await expect(page.getByTestId('new-session-agent-option')).toHaveCount(2)
  await page.getByTestId('new-session-cwd').fill(piMinbox.dataDir)
  await page.locator('[data-testid="new-session-agent-option"][data-agent="pi"]').click()
  await expect(page.getByTestId('new-session-start')).toContainText('Start Pi')
  await page.getByTestId('new-session-name').fill('picked')
  await page.getByTestId('new-session-start').click()
  await expect(page.getByTestId('agent-name')).toContainText('picked')
  await expectTerminal(page, 'hello agent=pi')
  const [s] = await (await fetch(piMinbox.url + '/api/sessions')).json()
  expect(s.agent).toBe('pi')
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

test('with only Pi installed there is no picker, Pi is the default, and nothing needs claude', async ({ page, piOnlyMinbox }) => {
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
  await page.getByTestId('project-new-agent').or(page.getByTestId('first-agent')).first().click()
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
