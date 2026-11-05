import { test as base, expect, type Page } from '@playwright/test'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const BIN = join(ROOT, 'bin/minbox')
const FAKE = join(__dirname, 'fake-claude.py')

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

/** A minbox server with its own data directory, run with the fake claude. */
export class Minbox {
  proc: ChildProcess | null = null
  log = ''
  constructor(
    public dataDir: string,
    public port: number,
  ) {}

  get url() {
    return `http://127.0.0.1:${this.port}`
  }

  async start() {
    this.proc = spawn(BIN, ['start', '--foreground', '--addr', `127.0.0.1:${this.port}`, '--data-dir', this.dataDir, '--no-open', '--claude', `python3 ${FAKE}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
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
    this.killHost()
    // Fake claude processes left behind by a killed host.
    try {
      // Only this checkout's fake (its absolute path is in the command line), so suites in
      // other worktrees can run at the same time.
      execSync(`pkill -f "${FAKE}" || true`)
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
export async function createSession(page: Page, cwd: string, name: string, kind: 'claude' | 'shell' = 'claude') {
  // With no sessions the dialog opens by itself, maybe right after we look:
  // press New only while the dialog is not there, briefly each time.
  const form = page.getByTestId('new-session-cwd').or(page.getByTestId('new-session-project'))
  for (let i = 0; i < 30 && !(await form.isVisible()); i++) {
    await page.getByTestId('new-session').click({ timeout: 500 }).catch(() => {})
  }
  await page.getByTestId(`new-session-kind-${kind}`).click()
  await chooseFolder(page)
  await page.getByTestId('new-session-cwd').fill(cwd)
  await page.getByTestId('new-session-name').fill(name)
  await page.getByTestId('new-session-start').click()
  await expect(page.getByTestId('terminal-session-name').or(page.getByTestId('phone'))).toBeVisible()
  await expect(page.getByTestId('terminal-session-name').filter({ hasText: name })).toBeVisible()
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
export const sessionStatus = (page: Page) => page.getByTestId('session-status')

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
