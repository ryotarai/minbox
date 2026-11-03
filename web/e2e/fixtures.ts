import { test as base, expect, type Page } from '@playwright/test'
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const BIN = join(ROOT, 'bin/minbox')
const FAKE = join(__dirname, 'fake-claude.py')

let nextPort = 4870

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
      execSync(`pkill -f "fake-claude.py" || true`)
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
    const m = new Minbox(dir, nextPort++)
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
})

export { expect }

/** The terminal's visible text (it is drawn on a canvas). */
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as any).__minboxTerminal
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
  })
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

/** Creates a session in the given directory through the UI. */
export async function createSession(page: Page, cwd: string, name: string, kind: 'claude' | 'shell' = 'claude') {
  // With no sessions the dialog opens by itself, maybe right after we look:
  // press New only while the dialog is not there, briefly each time.
  const form = page.getByTestId('new-session-cwd')
  for (let i = 0; i < 30 && !(await form.isVisible()); i++) {
    await page.getByTestId('new-session').click({ timeout: 500 }).catch(() => {})
  }
  await page.getByTestId(`new-session-kind-${kind}`).click()
  await page.getByTestId('new-session-cwd').fill(cwd)
  await page.getByTestId('new-session-name').fill(name)
  await page.getByTestId('new-session-start').click()
  await expect(page.getByTestId('session-row').filter({ hasText: name })).toBeVisible()
}
