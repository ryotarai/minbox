import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chooseFolder, expect, expectTerminal, showTerminal, test, typeInTerminal } from './fixtures'

// A second machine's host (here: another `minbox host --listen` on this one),
// added through the wizard, paired with `minbox pair accept`, then used.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BIN = join(ROOT, 'bin/minbox')

test('add a host: Direct, find it, pair with a code accepted there, then run a session on it', async ({ page, minbox }) => {
  const dir = mkdtempSync('/tmp/mbh-')
  const port = 4950 + Math.floor(Math.random() * 40)
  let host: ChildProcess | null = spawn(BIN, ['host', '--listen', `127.0.0.1:${port}`, '--data-dir', dir], { stdio: 'ignore' })
  try {
    await expect.poll(async () => fetch(`http://127.0.0.1:${port}/version`).then((r) => r.status).catch(() => 0), { timeout: 10_000 }).toBe(200)

    await page.goto(minbox.url + '/#v=settings&ss=hosts')
    await expect(page.getByTestId('host-row')).toHaveCount(1)
    await expect(page.getByTestId('host-row')).toContainText('This machine')

    await page.getByTestId('host-add').click()
    await page.getByTestId('host-method-direct').click()
    await page.getByTestId('wizard-next').click()
    await expect(page.getByTestId('host-command')).toContainText('minbox host --listen 0.0.0.0:')
    await page.getByTestId('wizard-next').click()
    await page.getByTestId('host-url').fill(`http://127.0.0.1:${port}`)
    await expect(page.getByTestId('host-probe')).toContainText('Found · minbox host')
    await page.getByTestId('host-name').fill('devbox')
    await page.getByTestId('host-pair').click()

    const code = (await page.getByTestId('pair-code').textContent())!.trim()
    expect(code).toMatch(/^\d{3}-\d{3}$/)
    await expect(page.getByTestId('host-row').filter({ hasText: 'devbox' })).toContainText('Waiting for accept')
    // On "the other machine".
    expect(execFileSync(BIN, ['pair', 'list', '--data-dir', dir]).toString()).toContain(code)
    execFileSync(BIN, ['pair', 'accept', code, '--data-dir', dir])

    await expect(page.getByTestId('host-added')).toContainText('Added devbox', { timeout: 15_000 })
    const row = page.getByTestId('host-row').filter({ hasText: 'devbox' })
    await expect(row.getByTestId('host-status')).toContainText('Online')
    await expect(row.getByTestId('host-address')).toContainText(`http://127.0.0.1:${port} · paired`)

    await page.getByTestId('host-new-session').click()
    const devbox = page.getByTestId('new-session-host-option').filter({ hasText: 'devbox' })
    await expect(devbox).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('new-session-cwd').fill(dir)
    await page.getByTestId('new-session-name').fill('remote')
    await page.getByTestId('new-session-start').click()
    await showTerminal(page)
    await expect(page.getByTestId('terminal-session-name')).toHaveText('remote')
    await expect(page.getByTestId('host-tag').first()).toHaveText('devbox')
    await expectTerminal(page, 'ready>')

    // The mod's calls go through the host's relay: its question waits on the Board, a message from its stream reaches it.
    await typeInTerminal(page, 'ask')
    await expectTerminal(page, /sent question in thr_/)
    await expect(page.getByTestId('board-badge')).toHaveText('1')
    await page.getByTestId('composer-text').fill('SQLite it is')
    await page.getByTestId('composer-send').click()
    await expectTerminal(page, '<<< inbox')
    await expectTerminal(page, 'SQLite it is')
    const remote = ((await (await fetch(minbox.url + '/api/sessions')).json()) as any[]).find((s) => s.name === 'remote')

    // Removing the host ends its session and forgets this server there.
    await page.goto(minbox.url + '/#v=settings&ss=hosts')
    await page.getByTestId('host-row').filter({ hasText: 'devbox' }).getByTestId('host-menu').click()
    await page.getByTestId('host-remove').click()
    await page.getByTestId('host-remove-confirm').click()
    await expect(page.getByTestId('host-row')).toHaveCount(1)
    await page.goto(minbox.url + `/#v=agent&s=${remote.id}`)
    await expect(page.getByTestId('agent-state')).toHaveAttribute('data-state', 'ended')
  } finally {
    host?.kill('SIGTERM')
    host = null
    // Only the fakes of this test's servers: a bare fake-claude.py pattern killed other workers' sessions.
    for (const d of [dir, minbox.dataDir]) {
      try {
        execFileSync('pkill', ['-f', `fake-claude.py.*${d}`])
      } catch {
        /* none */
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

// Pi and OpenCode on another machine's host (docs/agents.md, "Remote hosts"): the host finds what is
// installed there (Node's version for Pi, `opencode --version`), New session offers per host what that
// host can run, and the sessions get the host's own copies of the extension and the plugin.
test('Pi and OpenCode sessions on a remote host: per-host detection, the host’s own extension and plugin', async ({ page, allAgentsMinbox: minbox }) => {
  const dir = mkdtempSync('/tmp/mbh-')
  const port = 4950 + Math.floor(Math.random() * 40)
  // "That machine" first has a Node too old for Pi.
  const oldNode = mkdtempSync('/tmp/mbn-')
  writeFileSync(join(oldNode, 'node'), '#!/bin/sh\necho v20.11.1\n', { mode: 0o755 })
  const hostEnv = (extra: Record<string, string>) => ({
    ...process.env,
    FAKE_OPENCODE_DIR: dir,
    FAKE_EXPECT_ROOT: dir,
    OPENCODE_CONFIG_CONTENT: '{"model":"mock/m"}',
    ...extra,
  })
  const startHost = (extra: Record<string, string>) => spawn(BIN, ['host', '--listen', `127.0.0.1:${port}`, '--data-dir', dir], { stdio: 'ignore', env: hostEnv(extra) })
  const hostUp = () => fetch(`http://127.0.0.1:${port}/version`).then((r) => r.status).catch(() => 0)
  let host: ChildProcess | null = startHost({ PATH: `${oldNode}:${process.env.PATH}` })
  // New agent: the full dialog (kind, folder, host).
  const openNew = async () => {
    const form = page.getByTestId('new-session-cwd').or(page.getByTestId('new-session-project'))
    await page.getByTestId('project-new-agent').or(page.getByTestId('first-agent')).first().click()
    await expect(form).toBeVisible()
  }
  try {
    await expect.poll(hostUp, { timeout: 10_000 }).toBe(200)
    // Paired through the API (the wizard has its own test), accepted "there".
    const added = await (await fetch(minbox.url + '/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'devbox', url: `http://127.0.0.1:${port}`, method: 'direct' }) })).json()
    execFileSync(BIN, ['pair', 'accept', added.code, '--data-dir', dir])
    const hostId = added.host.id as string

    await page.goto(minbox.url + '/#v=settings&ss=hosts')
    const row = page.getByTestId('host-row').filter({ hasText: 'devbox' })
    await expect(row.getByTestId('host-status')).toContainText('Online', { timeout: 15_000 })
    await expect(row.getByTestId('host-agents')).toContainText('OpenCode 2.1.4')
    await expect(row.getByTestId('host-agents')).not.toContainText('Pi')
    await expect(row.getByTestId('host-agents')).toHaveAttribute('title', /Pi: Node\.js 20\.11\.1 is too old: Pi needs Node 22\.19/)

    // New session: this machine offers Pi, devbox does not.
    await page.goto(minbox.url)
    await openNew()
    await chooseFolder(page)
    await expect(page.locator('[data-testid="new-session-agent-option"][data-agent="pi"]')).toBeVisible()
    await page.getByTestId('new-session-host-option').filter({ hasText: 'devbox' }).click()
    await expect(page.locator('[data-testid="new-session-agent-option"][data-agent="opencode"]')).toBeVisible()
    await expect(page.locator('[data-testid="new-session-agent-option"][data-agent="pi"]')).toHaveCount(0)
    // The API refuses it with the host's reason.
    const refused = await fetch(minbox.url + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: dir, host_id: hostId, agent: 'pi' }) })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toContain('Pi cannot be used on host devbox: Node.js 20.11.1 is too old')
    await page.keyboard.press('Escape')

    // Node is updated there and the host restarted: Pi is offered on devbox.
    host.kill('SIGTERM')
    await expect.poll(hostUp).toBe(0)
    host = startHost({})
    await expect.poll(hostUp, { timeout: 10_000 }).toBe(200)
    await fetch(minbox.url + `/api/hosts/${hostId}/retry`, { method: 'POST' })
    await expect
      .poll(async () => ((await (await fetch(minbox.url + '/api/hosts')).json()) as any[]).find((h) => h.id === hostId)?.agents?.find((a: any) => a.kind === 'pi')?.supported, { timeout: 15_000 })
      .toBe(true)

    // A Pi session on devbox: the host's extension files, the relay, the inbox.
    await page.reload()
    await openNew()
    await chooseFolder(page)
    await page.getByTestId('new-session-host-option').filter({ hasText: 'devbox' }).click()
    await page.getByTestId('new-session-cwd').fill(dir)
    await page.getByTestId('new-session-name').fill('remote-pi')
    await page.locator('[data-testid="new-session-agent-option"][data-agent="pi"]').click()
    await page.getByTestId('new-session-start').click()
    await showTerminal(page)
    await expect(page.getByTestId('terminal-session-name')).toHaveText('remote-pi')
    await expect(page.getByTestId('host-tag').first()).toHaveText('devbox')
    await expect(page.getByTestId('agent-tag').first()).toHaveText('Pi')
    await expectTerminal(page, 'hello agent=pi')
    await expectTerminal(page, 'ready>')
    await typeInTerminal(page, 'paths')
    await expectTerminal(page, 'paths n=2 under-root=yes')
    await typeInTerminal(page, 'ask')
    await expectTerminal(page, 'sent question: Sent to the person in minbox')
    await page.getByTestId('composer-text').fill('SQLite it is')
    await page.getByTestId('composer-send').click()
    await expectTerminal(page, '<<< inbox')

    // An OpenCode session in the same project: created on devbox before its start, the host's plugin
    // merged into the host's own OPENCODE_CONFIG_CONTENT.
    await openNew()
    await expect(page.getByTestId('new-session-project-name')).toBeVisible()
    await page.getByTestId('new-session-name').fill('remote-oc')
    await page.locator('[data-testid="new-session-agent-option"][data-agent="opencode"]').click()
    await page.getByTestId('new-session-start').click()
    await showTerminal(page)
    await expect(page.getByTestId('terminal-session-name')).toHaveText('remote-oc')
    await expect(page.getByTestId('agent-tag').first()).toHaveText('OpenCode')
    await expectTerminal(page, /fake-opencode session=ses_[0-9A-Za-z]{26} exists=yes[\s\S]*plugin=index\.ts/)
    await expectTerminal(page, 'hello agent=opencode')
    await typeInTerminal(page, 'paths')
    await expectTerminal(page, 'paths under-root=yes keys=model,plugins')
    const sessions = (await (await fetch(minbox.url + '/api/sessions')).json()) as any[]
    expect(sessions.filter((s) => s.host_id === hostId).map((s) => s.agent).sort()).toEqual(['opencode', 'pi'])
    // The heartbeat arrives through the host's relay.
    const oc = sessions.find((s) => s.agent === 'opencode')
    await expect.poll(async () => (await (await fetch(minbox.url + `/api/sessions/${oc.id}/connection`)).json()).state, { timeout: 20_000 }).toBe('connected')
  } finally {
    host?.kill('SIGTERM')
    host = null
    for (const pat of [`fake-pi.py.*${dir}`, `fake-claude.py.*${minbox.dataDir}`]) {
      try {
        execFileSync('pkill', ['-f', pat])
      } catch {
        /* none */
      }
    }
    try {
      for (const f of readdirSync(join(dir, 'fake-opencode')).filter((n) => n.startsWith('ses_'))) execFileSync('pkill', ['-f', `fake-opencode.py.*${f}`])
    } catch {
      /* none */
    }
    rmSync(dir, { recursive: true, force: true })
    rmSync(oldNode, { recursive: true, force: true })
  }
})
