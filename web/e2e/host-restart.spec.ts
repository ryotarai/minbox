import { execFileSync, spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSession, expect, expectTerminal, terminalText, test } from './fixtures'
import type { Host, Session } from '../src/api'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Settings › Hosts › Restart: this machine's terminal host is replaced by a new one (the server keeps
// running); the sessions that ran in it resume there, or end when the person says so.

async function localHost(url: string): Promise<Host> {
  const hosts = (await fetch(url + '/api/hosts').then((r) => r.json())) as Host[]
  return hosts.find((h) => h.id === 'local')!
}

async function session(url: string, name: string): Promise<Session | undefined> {
  const list = (await fetch(url + '/api/sessions').then((r) => r.json())) as Session[]
  return list.find((s) => s.name === name)
}

// v3: drove the thread-centric UI (thread list / thread view / new-session dialog), which is gone; see docs/v3/usecases.md for its v3 counterpart.
test.skip('restart the local host from Settings: the session resumes in a new host, and new sessions start', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'keeper')
  await expectTerminal(page, 'ready>')

  const before = await localHost(minbox.url)
  expect(before.pid).toBeGreaterThan(0)
  expect(before.version_status).toBe('current')
  expect(before.started_at).toBeTruthy()

  await page.goto(minbox.url + '/#v=settings&ss=hosts')
  const row = page.getByTestId('host-row').filter({ hasText: 'This machine' })
  await expect(row.getByTestId('host-build')).toContainText(`pid ${before.pid}`)
  await expect(row.getByTestId('host-build')).toContainText('started')
  await expect(row.getByTestId('host-outdated')).toHaveCount(0)

  // The context menu offers it too; Cancel leaves the host alone.
  await row.click({ button: 'right' })
  await page.getByTestId('host-menu-restart').click()
  await expect(page.getByTestId('host-restart-session')).toHaveCount(1)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('host-restart-confirm')).toHaveCount(0)
  expect((await localHost(minbox.url)).pid).toBe(before.pid)

  await row.getByTestId('host-restart').click()
  const listed = page.getByTestId('host-restart-session')
  await expect(listed).toHaveCount(1)
  await expect(listed).toContainText('keeper')
  await expect(listed).toContainText('Claude Code')
  await expect(page.getByTestId('host-restart-resume')).toBeChecked()
  await page.getByTestId('host-restart-confirm').click()

  await expect(page.getByText(/Restarted the terminal host \(pid \d+\) · 1 session resumes/)).toBeVisible({ timeout: 30_000 })
  const after = await localHost(minbox.url)
  expect(after.status).toBe('online')
  expect(after.pid).toBeGreaterThan(0)
  expect(after.pid).not.toBe(before.pid)
  await expect(row.getByTestId('host-build')).toContainText(`pid ${after.pid}`)

  // The session was never closed: claude was started again in the new host, as a resume
  // (the fake starts afresh when it has no conversation to resume).
  const kept = await session(minbox.url, 'keeper')
  expect(kept?.status).not.toBe('ended')
  expect(minbox.log).toContain(`spawn session=${kept!.id} resume=true`)
  await page.goto(minbox.url)
  await page.getByText('keeper').first().click()
  await expect.poll(() => terminalText(page), { timeout: 20_000 }).toMatch(/fake-claude (new|resume) session=[\s\S]*ready>/)

  // A new session starts in the new host.
  await createSession(page, minbox.dataDir, 'newcomer')
  await expectTerminal(page, 'ready>')
})

test('a host left running from another build is outdated; Restart replaces it with the current one', async ({ page, minbox }) => {
  test.setTimeout(120_000)
  // Another build of minbox (another version stamped in): its binary differs from the server's.
  const old = join(minbox.dataDir, 'minbox-old')
  execFileSync('go', ['build', '-ldflags', '-X github.com/ryotarai/minbox/internal/server.Version=e2e-old', '-o', old, './cmd/minbox'], { cwd: ROOT, stdio: 'ignore' })
  await minbox.stop()
  minbox.killHost()
  // The old build's host, left running (as after `make build` + `minbox restart` without --host).
  const sock = join(minbox.dataDir, 'termhost.sock')
  spawn(old, ['host', 'start', '--socket', sock], { detached: true, stdio: 'ignore' }).unref()
  const answers = () => new Promise<boolean>((res) => connect(sock).once('connect', function (this: Socket) { this.destroy(); res(true) }).once('error', () => res(false)))
  await expect.poll(answers, { timeout: 10_000 }).toBe(true)
  await minbox.start()

  await page.goto(minbox.url + '/#v=settings&ss=hosts')
  const row = page.getByTestId('host-row').filter({ hasText: 'This machine' })
  await expect(row.getByTestId('host-outdated')).toBeVisible({ timeout: 15_000 })
  await expect(row.getByTestId('host-build')).toContainText('minbox e2e-old')

  await row.getByTestId('host-restart').click()
  await expect(page.getByTestId('host-restart-none')).toBeVisible()
  await page.getByTestId('host-restart-confirm').click()
  await expect(page.getByText(/Restarted the terminal host/)).toBeVisible({ timeout: 30_000 })
  await expect(row.getByTestId('host-outdated')).toHaveCount(0)
  await expect(row.getByTestId('host-build')).not.toContainText('e2e-old')
  expect((await localHost(minbox.url)).version_status).toBe('current')
})

test('restart the local host without resuming: its sessions end', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'goner')
  await expectTerminal(page, 'ready>')
  const before = await localHost(minbox.url)

  await page.goto(minbox.url + '/#v=settings&ss=hosts')
  await page.getByTestId('host-restart').click()
  await page.getByTestId('host-restart-resume').uncheck()
  await page.getByTestId('host-restart-confirm').click()
  await expect(page.getByText(/Restarted the terminal host .*1 session ended/)).toBeVisible({ timeout: 30_000 })
  expect((await localHost(minbox.url)).pid).not.toBe(before.pid)
  expect((await session(minbox.url, 'goner'))?.status).toBe('ended')
})
