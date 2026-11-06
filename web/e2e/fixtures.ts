import { test as base, expect, type Page } from '@playwright/test'
import { spawn, execSync, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const BIN = join(ROOT, 'bin/minbox')
const FAKE = join(__dirname, 'fake-claude.py')
const FAKE_SUGGEST = join(__dirname, 'fake-suggest.py')

// Concurrent suites (other worktrees, other runs) must not share a server: ask the OS for a free
// port per instance. MINBOX_E2E_PORT, if set, is the first port to use (then counts up).
let overridePort = process.env.MINBOX_E2E_PORT ? Number(process.env.MINBOX_E2E_PORT) : 0
async function freePort(): Promise<number> {
  if (overridePort) return overridePort++
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      srv.close(() => res(port))
    })
  })
}

/**
 * A fake Slack Web API on 127.0.0.1 (no real Slack is ever contacted). Every Minbox gets one and
 * is told about it with MINBOX_SLACK_API_BASE (honoured by the server only for http loopback URLs).
 */
export class FakeSlackApi {
  calls: { method: string; auth: string; json: any }[] = []
  /** Slack error code to answer chat.postMessage / auth.test with ('' = succeed). */
  postError = ''
  authError = ''
  private seq = 0
  private srv: Server | null = null
  url = ''

  async start() {
    this.srv = createHttpServer((req, res) => {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => {
        const method = (req.url ?? '').replace(/^\//, '')
        this.calls.push({ method, auth: String(req.headers.authorization ?? ''), json: JSON.parse(b || '{}') })
        res.setHeader('content-type', 'application/json')
        const err = method === 'auth.test' ? this.authError : this.postError
        if (err) res.end(JSON.stringify({ ok: false, error: err }))
        else if (method === 'auth.test') res.end(JSON.stringify({ ok: true, team: 'Acme', user: 'minbot' }))
        else res.end(JSON.stringify({ ok: true, channel: 'C0123ABCD', ts: `1700000000.${String(++this.seq).padStart(6, '0')}` }))
      })
    })
    await new Promise<void>((r) => this.srv!.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.srv.address() as AddressInfo).port}`
  }

  /** chat.postMessage calls. */
  get posts() {
    return this.calls.filter((c) => c.method === 'chat.postMessage')
  }

  close() {
    return new Promise<void>((r) => (this.srv ? this.srv.close(() => r()) : r()))
  }
}

/** A minbox server with its own data directory, run with the fake claude. */
export class Minbox {
  proc: ChildProcess | null = null
  slackApi = new FakeSlackApi()
  log = ''
  constructor(
    public dataDir: string,
    public port: number,
  ) {}

  get url() {
    return `http://127.0.0.1:${this.port}`
  }

  async start() {
    if (!this.slackApi.url) await this.slackApi.start()
    this.proc = spawn(BIN, ['start', '--foreground', '--addr', `127.0.0.1:${this.port}`, '--data-dir', this.dataDir, '--no-open', '--claude', `python3 ${FAKE}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MINBOX_SUGGEST_COMMAND: `python3 ${FAKE_SUGGEST}`, MINBOX_SLACK_API_BASE: this.slackApi.url },
    })
    this.proc.stdout!.on('data', (d) => (this.log += d))
    this.proc.stderr!.on('data', (d) => (this.log += d))
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(this.url + '/api/sessions')
        if (r.ok) return
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('minbox did not start:\n' + this.log)
  }

  /** Stops the server only; the terminal host keeps running. */
  async stop() {
    if (!this.proc) return
    const p = this.proc
    this.proc = null
    const done = new Promise((r) => p.once('exit', r))
    p.kill('SIGTERM')
    await done
  }

  /** Kills the terminal host and everything in it, as an OS restart would. */
  killHost() {
    const pids = execSync(`ps -axo pid=,command=`)
      .toString()
      .split('\n')
      .filter((l) => l.includes('host start') && l.includes(this.dataDir))
    for (const l of pids) {
      const pid = Number(l.trim().split(/\s+/)[0])
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  }

  async cleanup() {
    await this.stop()
    await this.slackApi.close()
    this.killHost()
    // Fake claude processes left behind by a killed host.
    try {
      // Only this server's fakes: the command line carries `--plugin-dir <dataDir>/plugin/...`, so
      // suites in other worktrees and tests of other workers keep their own.
      execSync(`pkill -f "${FAKE}.*${this.dataDir}" || true`)
    } catch {
      /* none */
    }
    rmSync(this.dataDir, { recursive: true, force: true })
  }

}

export const test = base.extend<{ minbox: Minbox }>({
  minbox: async ({}, use, testInfo) => {
    // A short path: the host's Unix socket lives in the data directory.
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort())
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
})

export { expect }

/** The terminal's visible text (it is drawn on a canvas). */
export async function terminalText(page: Page, which: 'session' | 'shell' = 'session'): Promise<string> {
  return page.evaluate((which) => {
    const term = (window as any)[which === 'shell' ? '__minboxShellTerminal' : '__minboxTerminal']
    if (!term) return ''
    const buf = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (!line) continue
      // Cells a program skipped with cursor moves are empty: read them as spaces.
      let s = ''
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)
        if (cell && cell.getWidth() === 0) continue // the second half of a wide character
        s += cell?.getChars() || ' '
      }
      lines.push(s.trimEnd())
    }
    return lines.join('\n')
  }, which)
}

export async function expectTerminal(page: Page, re: RegExp | string) {
  await expect
    .poll(() => terminalText(page), { timeout: 15_000 })
    .toMatch(typeof re === 'string' ? new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : re)
}

/** Types a line into the terminal. */
export async function typeInTerminal(page: Page, text: string) {
  await page.getByTestId('terminal').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/**
 * The New session dialog starts in a project when there are projects (its folder field appears
 * only in folder mode). Waits until the dialog has settled, then switches to a folder if needed.
 */
export async function chooseFolder(page: Page) {
  const cwd = page.getByTestId('new-session-cwd')
  const project = page.getByTestId('new-session-project')
  await expect(cwd.or(project)).toBeVisible()
  if (await project.isVisible()) {
    await project.click()
    await page.getByTestId('new-session-project-folder').click()
  }
  await expect(cwd).toBeVisible()
}

/** Creates a session in the given directory through the UI. */
export async function createSession(page: Page, cwd: string, name: string) {
  // With no sessions the dialog opens by itself, maybe right after we look:
  // press New only while the dialog is not there, briefly each time.
  const form = page.getByTestId('new-session-cwd').or(page.getByTestId('new-session-project'))
  for (let i = 0; i < 30 && !(await form.isVisible()); i++) {
    await page.getByTestId('new-session').click({ timeout: 500 }).catch(() => {})
  }
  await chooseFolder(page)
  await page.getByTestId('new-session-cwd').fill(cwd)
  await page.getByTestId('new-session-name').fill(name)
  await page.getByTestId('new-session-start').click()
  await expect(page.getByTestId('terminal-session-name').or(page.getByTestId('phone'))).toBeVisible()
  await expect(page.getByTestId('terminal-session-name').filter({ hasText: name })).toBeVisible()
}

/**
 * Shell sessions can no longer be created (the UI and the API both refuse). This stands in for one
 * that an older build left in the database: the row is written while the server is stopped, the
 * server picks it up (and files it under a project) when it starts, and it is restarted into a
 * running login shell. Leaves `page` on that session's terminal (desktop layout).
 */
export async function createShellSession(page: Page, minbox: Minbox, name: string) {
  const id = 'ses_' + name.replace(/[^a-z0-9]/gi, '') + Math.random().toString(36).slice(2, 8)
  await minbox.stop()
  const py = `
import sqlite3, sys, time
c = sqlite3.connect(sys.argv[1])
now = int(time.time() * 1000)
vals = {'id': sys.argv[2], 'name': sys.argv[3], 'cwd': sys.argv[4], 'status': 'ended', 'kind': 'shell', 'host_id': 'local',
        'token': 'tok_' + sys.argv[2], 'created_at': now, 'updated_at': now, 'exit_code': 0}
row = c.execute("SELECT id FROM projects WHERE dir = ? AND host_id = 'local'", (sys.argv[4],)).fetchone()
if row: vals['project_id'] = row[0]  # else the server files it under a new project when it starts
cols = []
for _, n, t, notnull, dflt, _pk in c.execute('PRAGMA table_info(sessions)').fetchall():
    if n in vals: cols.append(n)
    elif notnull and dflt is None: vals[n] = 0 if 'INT' in t.upper() else ''; cols.append(n)
c.execute('INSERT INTO sessions (%s) VALUES (%s)' % (','.join(cols), ','.join('?' * len(cols))), [vals[n] for n in cols])
c.commit()
`
  execFileSync('python3', ['-I', '-c', py, join(minbox.dataDir, 'minbox.db'), id, name, minbox.dataDir])
  await minbox.start()
  const r = await fetch(`${minbox.url}/api/sessions/${id}/restart`, { method: 'POST' })
  if (!r.ok) throw new Error('restart of the seeded shell session failed: ' + (await r.text()))
  await page.goto('about:blank') // a fresh load: the open app would keep its own route
  await page.goto(`${minbox.url}/#s=${id}&tab=terminal`)
  await expect(page.getByTestId('terminal-session-name').filter({ hasText: name })).toBeVisible()
  return id
}

/** Desktop: selects a session (the threads list shows only its threads, the terminal follows). */
export async function selectSession(page: Page, name: string) {
  await page.getByTestId('session-filter').click()
  await page.getByTestId('session-option').filter({ hasText: name }).first().click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText(name)
}

/** Phone: the session sheet from the home list; `open` picks what the row does. */
export async function phoneSelectSession(page: Page, name: string, open: 'filter' | 'terminal' = 'filter') {
  await page.getByTestId('session-filter').click()
  const row = page.getByTestId('session-row').filter({ hasText: name })
  if (open === 'terminal') await row.getByTestId('session-terminal').click()
  else await row.getByTestId('session-name').click()
}

/** Desktop: the session header's status text. */
export const sessionEnded = (page: Page) => page.getByTestId('session-ended')

/** Desktop: selects a project in the far-left column ('' or 'All projects' = every project). */
export async function selectProject(page: Page, name: string) {
  if (name === '' || name === 'All projects') {
    await page.getByTestId('project-all').click()
    await expect(page.getByTestId('project-all')).toHaveAttribute('aria-pressed', 'true')
    return
  }
  const item = page.getByTestId('project-item').filter({ has: page.getByTestId('project-name').getByText(name, { exact: true }) })
  await item.getByTestId('project-select').click()
  await expect(item).toHaveAttribute('data-selected', 'true')
}

/** Phone: opens the project sheet from the home header and picks a project ('' = All projects). */
export async function phoneSelectProject(page: Page, name: string) {
  await page.getByTestId('project-switch').click()
  if (name === '' || name === 'All projects') await page.getByTestId('project-all').click()
  else await page.getByTestId('project-item').filter({ hasText: name }).getByTestId('project-select').click()
  await expect(page.getByTestId('project-sheet')).toBeHidden()
}
