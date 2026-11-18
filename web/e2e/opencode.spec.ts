import { createSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'

// OpenCode 2.x as the third coding agent (docs/opencode.md), driven by the fake opencode
// (e2e/fake-opencode.py, no model, no real OpenCode): the dialog offers it, minbox creates the
// OpenCode session before the TUI starts and passes the plugin in OPENCODE_CONFIG_CONTENT, and status,
// messages, replies (into a running turn too) and the heartbeat flow through the same inbox as for the other agents.

test('the dialog offers OpenCode; its session gets the plugin, a created session and OpenCode tool names', async ({ page, ocMinbox }) => {
  await page.goto(ocMinbox.url)
  await createSession(page, ocMinbox.dataDir, 'oc-demo', 'opencode')

  // minbox created the session (exists=yes) before the TUI started, and the plugin folder has its entry.
  await expectTerminal(page, /fake-opencode session=ses_[0-9A-Za-z]{26} exists=yes[\s\S]*plugin=index\.ts/)
  await expectTerminal(page, 'hello agent=opencode orchestration=yes tools=minbox_')
  await expectTerminal(page, 'subagents=opencode')
  await expect(page.getByTestId('agent-tag').first()).toHaveText('OpenCode')

  await typeInTerminal(page, 'args')
  await expectTerminal(page, /args \[[\s\S]*\]\s*ready>/)
  const flat = (await terminalText(page)).replace(/\s+/g, '')
  expect(flat).toMatch(/"--standalone","--auto","--session","ses_[0-9A-Za-z]{26}"\]/)
  await typeInTerminal(page, 'env')
  await expectTerminal(page, /env \{[\s\S]*\}\s*ready>/)
  const envFlat = (await terminalText(page)).replace(/\s+/g, '')
  for (const k of ['MINBOX_OPENCODE_DIR', 'MINBOX_OPENCODE_SESSION', 'OPENCODE_CONFIG_CONTENT', 'MINBOX_TOKEN']) expect(envFlat).toContain(`"${k}":"set"`)

  const sessions = await (await fetch(ocMinbox.url + '/api/sessions')).json()
  expect(sessions.map((s: any) => s.agent)).toEqual(['opencode'])
  expect(sessions[0].claude_session_id).toMatch(/^ses_[0-9A-Za-z]{26}$/)
})

test('an OpenCode session reports status, its messages and replies flow, a reply steers a running turn, and the heartbeat shows', async ({ page, ocMinbox }) => {
  await page.goto(ocMinbox.url)
  await createSession(page, ocMinbox.dataDir, 'oc-flow', 'opencode')
  await expectTerminal(page, 'ready>')

  // Its question waits on the Board; a message from its stream reaches it.
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, 'sent question: Sent to the person in minbox asking 1 question.')
  await expect(page.getByTestId('board-badge')).toHaveText('1')
  await page.getByTestId('composer-text').fill('Go with it.')
  await page.getByTestId('composer-send').click()
  await expectTerminal(page, '<<< inbox')
  await expectTerminal(page, 'Go with it.')

  await typeInTerminal(page, 'title Choose the database')
  await expect(page.getByTestId('agent-row').filter({ hasText: 'oc-flow' })).toContainText('Choose the database')

  // Working: the person's reply goes into the running turn at once (steered), no Send now needed.
  await typeInTerminal(page, 'work')
  await expect.poll(async () => (await (await fetch(ocMinbox.url + '/api/sessions')).json())[0].status).toBe('working')
  const [s] = await (await fetch(ocMinbox.url + '/api/sessions')).json()
  const threads = await (await fetch(ocMinbox.url + `/api/sessions/${s.id}/threads`)).json()
  const r = await fetch(ocMinbox.url + `/api/threads/${threads[0].id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ words: 'Also add an index' }) })
  expect(r.ok).toBe(true)
  await expectTerminal(page, /Also add an index \(steered\)/)
  await typeInTerminal(page, 'idle')
  await expect.poll(async () => (await (await fetch(ocMinbox.url + '/api/sessions')).json())[0].status).toBe('idle')

  // The diagnostics see an OpenCode integration with a heartbeat.
  await expect
    .poll(async () => {
      const c = await (await fetch(ocMinbox.url + `/api/sessions/${s.id}/connection`)).json()
      return `${c.state} ${c.agent} ${c.heartbeat}`
    })
    .toBe('connected opencode true')
})

test('a restarted OpenCode session opens the same OpenCode session', async ({ page, ocMinbox }) => {
  await page.goto(ocMinbox.url)
  await createSession(page, ocMinbox.dataDir, 'oc-restart', 'opencode')
  await expectTerminal(page, /fake-opencode session=ses_\w+ exists=yes/)
  const [s] = await (await fetch(ocMinbox.url + '/api/sessions')).json()
  expect((await fetch(ocMinbox.url + `/api/sessions/${s.id}/restart`, { method: 'POST' })).status).toBe(200)
  await expectTerminal(page, `fake-opencode session=${s.claude_session_id} exists=yes`)
  const after = (await (await fetch(ocMinbox.url + '/api/sessions')).json())[0]
  expect(after.claude_session_id).toBe(s.claude_session_id)
})

test('with only OpenCode installed there is no picker and OpenCode is the default', async ({ page, ocOnlyMinbox }) => {
  const agents = await (await fetch(ocOnlyMinbox.url + '/api/agents')).json()
  expect(agents.default).toBe('opencode')
  expect(agents.agents.map((a: any) => [a.kind, a.installed])).toEqual([
    ['claude', false],
    ['pi', false],
    ['opencode', true],
  ])
  await page.goto(ocOnlyMinbox.url)
  const form = page.getByTestId('new-session-cwd').or(page.getByTestId('new-session-project'))
  await page.getByTestId('sidebar-new-agent').click()
  await expect(form).toBeVisible()
  await expect(page.getByTestId('new-session-start')).toContainText('Start OpenCode')
  await expect(page.getByTestId('new-session-agent')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await createSession(page, ocOnlyMinbox.dataDir, 'solo')
  await expectTerminal(page, 'hello agent=opencode')
})

test('Settings shows the OpenCode version; OpenCode 1.x is listed as unsupported and not offered', async ({ page, ocMinbox, ocV1Minbox }) => {
  await page.goto(ocMinbox.url + '/#v=settings&ss=capabilities')
  await expect(page.getByTestId('agent-status-opencode')).toHaveText('installed · 2.1.4')
  await expect(page.getByTestId('opencode-note')).toBeVisible()
  await page.getByTestId('default-agent').selectOption('opencode')
  await expect.poll(async () => (await (await fetch(ocMinbox.url + '/api/settings')).json()).default_agent).toBe('opencode')

  await page.goto(ocV1Minbox.url + '/#v=settings&ss=capabilities')
  await expect(page.getByTestId('agent-status-opencode')).toHaveText('unsupported')
  await expect(page.getByText(/OpenCode 1\.0\.150 is OpenCode 1\.x; minbox needs OpenCode 2/)).toBeVisible()
  // Only Claude Code can start: no agent choice.
  await expect(page.getByTestId('default-agent')).toHaveCount(0)
  const r = await fetch(ocV1Minbox.url + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: ocV1Minbox.dataDir, name: 'x', agent: 'opencode' }) })
  expect(r.status).toBe(400)
})
