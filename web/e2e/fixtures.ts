import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import { spawn, execSync, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, sign as signWith, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { createServer as createHttpServer, type Server } from 'node:http'
import { FakeLinear } from './fake-linear'
import { FakeSlackUser } from './fake-slack-user'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
export const BIN = join(ROOT, 'bin/minbox')
const FAKE = join(__dirname, 'fake-claude.py')
const FAKE_SUGGEST = join(__dirname, 'fake-suggest.py')
const FAKE_PI = join(__dirname, 'fake-pi.py')
const FAKE_OPENCODE = join(__dirname, 'fake-opencode.py')

/**
 * Every browser must be a paired device, one on loopback too (see internal/server/devices.go). The
 * tests' browser is one: a P-256 key made here, written into each test server's devices.json before
 * it starts (what `minbox pair accept` would do), and put into the browser's IndexedDB as the app
 * keeps its own key (lib/device.ts: the noble form, the secret as bytes), so the app signs in by
 * itself. Node's own calls to a test server carry a cookie signed in with the same key.
 */
const TEST_KEY = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const d = privateKey.export({ format: 'jwk' }).d!
  return {
    privateKey,
    publicKey: spki.toString('base64'),
    fingerprint: 'SHA256:' + createHash('sha256').update(spki).digest('base64').replace(/=+$/, ''),
    secret: [...Buffer.from(d, 'base64url')],
  }
})()
export const TEST_DEVICE_NAME = 'e2e browser'

/** Registers the tests' browser key as a paired device in a data directory. */
export function pairTestDevice(dataDir: string) {
  const file = join(dataDir, 'devices.json')
  const list: { fingerprint: string }[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8') || '[]') : []
  if (list.some((d) => d.fingerprint === TEST_KEY.fingerprint)) return
  const now = new Date().toISOString()
  list.push({ id: 'dev_' + randomBytes(10).toString('hex'), name: TEST_DEVICE_NAME, public_key: TEST_KEY.publicKey, fingerprint: TEST_KEY.fingerprint, created_at: now, last_seen: now } as never)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 })
}

/** Signs in with the tests' key from Node (challenge, signature) and answers the cookie. */
async function signInFromNode(url: string): Promise<string> {
  const post = (path: string, body: unknown) => realFetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const { challenge } = (await (await post('/api/devices/auth/challenge', { fingerprint: TEST_KEY.fingerprint })).json()) as { challenge: string }
  const signature = signWith('sha256', Buffer.from(challenge, 'base64'), { key: TEST_KEY.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')
  const res = await post('/api/devices/auth', { fingerprint: TEST_KEY.fingerprint, challenge, signature })
  const cookie = /minbox_device=[^;]+/.exec(res.headers.get('set-cookie') ?? '')?.[0]
  if (!res.ok || !cookie) throw new Error(`e2e: the test browser could not sign in (${res.status})`)
  return cookie
}

/**
 * Node's fetch to a running test server carries its cookie (the specs call the API directly), unless
 * the call names a Cookie of its own. Other URLs (another IP of this machine, fakes) go out as given.
 */
const realFetch = globalThis.fetch
const cookies = new Map<string, string>() // origin -> cookie
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let origin = ''
  try {
    origin = new URL(u).origin
  } catch {
    /* relative: not ours */
  }
  const cookie = cookies.get(origin)
  if (!cookie) return realFetch(input, init)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  if (!headers.has('cookie')) headers.set('cookie', cookie)
  return realFetch(input, { ...init, headers })
}) as typeof fetch

/** The app's IndexedDB key store gets the tests' key before any page script runs. */
function seedKey(k: { publicKey: string; fingerprint: string; secret: number[] }) {
  const req = indexedDB.open('minbox', 1)
  req.onupgradeneeded = () => req.result.createObjectStore('keys')
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('keys', 'readwrite')
    tx.objectStore('keys').put({ secret: new Uint8Array(k.secret), publicKey: k.publicKey, fingerprint: k.fingerprint }, 'device')
    tx.oncomplete = () => db.close()
  }
}

/** Makes a browser context this machine's paired browser (the default `context` already is). */
export async function trustBrowser(context: BrowserContext) {
  await context.addInitScript(seedKey, { publicKey: TEST_KEY.publicKey, fingerprint: TEST_KEY.fingerprint, secret: TEST_KEY.secret })
}

/**
 * Runs `minbox <args>` on a pseudo-terminal, answering `answer` (what the person types): the way to
 * drive `minbox pair accept`, which asks only on an interactive terminal.
 */
export function runOnTerminal(args: string[], answer: string): string {
  // script(1) wants a pipe on its stdin (macOS refuses Node's socket), so a shell pipes the answer in.
  const quoted = [BIN, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  const run = process.platform === 'darwin' ? `script -q /dev/null ${quoted}` : `script -qec "${quoted.replace(/"/g, '\\"')}" /dev/null`
  // The answer comes once the command is up, and the pipe stays open while it reads (at EOF script sends ^D).
  return execFileSync('sh', ['-c', `(sleep 0.3; printf '%s' "$0"; sleep 1) | ${run}`, answer]).toString()
}

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
  /** A fake Linear (OAuth + MCP) on loopback; the server is pointed at it with MINBOX_LINEAR_MCP_URL. */
  linear = new FakeLinear()
  /** A fake Slack for the personal (user token) integration; the server is pointed at it with MINBOX_SLACK_API_URL. */
  slackUser = new FakeSlackUser()
  log = ''
  /** Pair the tests' browser before the server starts (off: a first run, nothing paired). */
  pairBrowser = true
  /**
   * The first-run introduction counts as done (Settings `onboarded`), so a spec on a fresh server sees
   * the app, not the introduction over it. Off (onboarding.spec.ts): a first run as a person sees it.
   */
  onboarded = true
  private markedOnboarded = false
  /**
   * The test's browser: it gets the cookie each start signs in, so its first page load is already
   * signed in (as a returning browser's is). Without it the app signs in by itself with the key.
   */
  browserContext: BrowserContext | null = null
  constructor(
    public dataDir: string,
    public port: number,
    /** The Pi command; by default Pi is not installed (so tests do not depend on a real `pi` on PATH). */
    public pi = 'minbox-e2e-no-such-pi',
    /** The Claude Code command; the fake claude by default. */
    public claude = `python3 ${FAKE}`,
    /** More environment for the server (and so the fake claude it starts). */
    public extraEnv: Record<string, string> = {},
    /** The OpenCode command; by default OpenCode is not installed (a real `opencode` on PATH is never used). */
    public opencode = 'minbox-e2e-no-such-opencode',
  ) {}

  get url() {
    return `http://127.0.0.1:${this.port}`
  }

  /** While this file exists the fake helper holds back its Linear-issue draft (see fake-suggest.py). */
  get draftHold() {
    return join(this.dataDir, 'linear-draft.hold')
  }

  /** This minbox's own Claude Code config folder (CLAUDE_CONFIG_DIR): where it marks folders trusted. */
  get claudeConfigDir() {
    return join(this.dataDir, 'claude-config')
  }

  async start() {
    if (!this.slackApi.url) await this.slackApi.start()
    if (!this.linear.url) await this.linear.start()
    if (!this.slackUser.url) await this.slackUser.start()
    mkdirSync(this.claudeConfigDir, { recursive: true })
    const env = { ...process.env, CLAUDE_CONFIG_DIR: this.claudeConfigDir, MINBOX_SUGGEST_COMMAND: `python3 ${FAKE_SUGGEST}`, MINBOX_SLACK_API_BASE: this.slackApi.url, MINBOX_LINEAR_MCP_URL: this.linear.url + '/mcp', MINBOX_SLACK_API_URL: this.slackUser.url, FAKE_JUDGE_FAIL: join(this.dataDir, 'judge.fail'), FAKE_SUGGEST_AGENTS: join(this.dataDir, 'suggest.agents'), FAKE_LINEAR_DRAFT_HOLD: this.draftHold, FAKE_OPENCODE_DIR: this.dataDir, ...this.extraEnv }
    // The person's own Claude Code config must never be written by a test (see playwright.config.ts).
    const cfg = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : ''
    if (!cfg || cfg === resolve(homedir(), '.claude') || cfg === resolve(homedir())) throw new Error(`e2e: CLAUDE_CONFIG_DIR must be a temporary folder, not ${cfg || 'unset'}`)
    if (this.pairBrowser) pairTestDevice(this.dataDir)
    this.proc = spawn(BIN, ['start', '--foreground', '--addr', `127.0.0.1:${this.port}`, '--data-dir', this.dataDir, '--no-open', '--claude', this.claude, '--pi', this.pi, '--opencode', this.opencode], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    this.proc.stdout!.on('data', (d) => (this.log += d))
    this.proc.stderr!.on('data', (d) => (this.log += d))
    for (let i = 0; i < 500; i++) {
      try {
        const r = await realFetch(this.url + '/api/devices/me')
        if (r.ok) {
          if (this.pairBrowser) {
            const cookie = await signInFromNode(this.url)
            cookies.set(new URL(this.url).origin, cookie)
            const [name, value] = cookie.split('=')
            await this.browserContext?.addCookies([{ name, value, url: this.url, httpOnly: true, sameSite: 'Strict' }])
            if (this.onboarded && !this.markedOnboarded) {
              this.markedOnboarded = true
              const r = await fetch(this.url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onboarded: true }) })
              if (!r.ok) throw new Error('e2e: could not mark the introduction done: ' + r.status)
            }
          }
          return
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error('minbox did not start:\n' + this.log)
  }

  /** Stops the server only; the terminal host keeps running. */
  async stop() {
    if (!this.proc) return
    const p = this.proc
    this.proc = null
    cookies.delete(new URL(this.url).origin)
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
    await this.linear.close()
    await this.slackUser.close()
    this.killHost()
    // Fake claude processes left behind by a killed host.
    try {
      // Only this server's fakes: the command line carries `--plugin-dir <dataDir>/plugin/...`, so
      // suites in other worktrees and tests of other workers keep their own.
      execSync(`pkill -f "${FAKE}.*${this.dataDir}" || true`)
      execSync(`pkill -f "${FAKE_PI}.*${this.dataDir}" || true`)
      // The fake OpenCode's command line has no data dir: its sessions' ids are in its state folder.
      for (const f of (() => {
        try {
          return readdirSync(join(this.dataDir, 'fake-opencode')).filter((n) => n.startsWith('ses_'))
        } catch {
          return []
        }
      })())
        execSync(`pkill -f "${FAKE_OPENCODE}.*${f}" || true`)
    } catch {
      /* none */
    }
    rmSync(this.dataDir, { recursive: true, force: true })
  }

}

export const test = base.extend<{ minbox: Minbox; connMinbox: Minbox; piMinbox: Minbox; piOnlyMinbox: Minbox; ocMinbox: Minbox; ocOnlyMinbox: Minbox; ocV1Minbox: Minbox; allAgentsMinbox: Minbox; freshMinbox: Minbox; stuckMinbox: Minbox }>({
  // The test's own browser is this machine's paired browser (contexts made with browser.newContext() are not).
  context: async ({ context }, use) => {
    await trustBrowser(context)
    await use(context)
  },
  // All three agents configured: the fake claude, the fake pi and the fake opencode (2.x).
  allAgentsMinbox: async ({ context }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort(), `python3 ${FAKE_PI}`, undefined, {}, `python3 ${FAKE_OPENCODE}`)
    m.browserContext = context
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
  // A minbox where OpenCode is installed too (the fake opencode, 2.x), next to the fake claude.
  ocMinbox: async ({ context }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort(), undefined, undefined, {}, `python3 ${FAKE_OPENCODE}`)
    m.browserContext = context
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
  // Only OpenCode: no claude (a command that does not exist), no pi.
  ocOnlyMinbox: async ({ context }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort(), undefined, 'minbox-e2e-no-such-claude', {}, `python3 ${FAKE_OPENCODE}`)
    m.browserContext = context
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
  // OpenCode 1.x installed (the fake says 1.0.150): listed as unsupported, never offered.
  ocV1Minbox: async ({ context }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort(), undefined, undefined, { FAKE_OPENCODE_VERSION: '1.0.150' }, `python3 ${FAKE_OPENCODE}`)
    m.browserContext = context
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
  // A minbox that calls a mod stale after 4 s without a heartbeat (45 s by default), and a fake claude that beats every second.
  connMinbox: async ({ context }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort(), undefined, undefined, { MINBOX_MOD_SILENT_S: '4', FAKE_HEARTBEAT_S: '1' })
    m.browserContext = context
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
  // A minbox that calls an agent stuck after 3 s without a hello, or with a message not taken (20 s and
  // 30 s by default; internal/server/stuck.go).
  stuckMinbox: async ({ context }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort(), undefined, undefined, { MINBOX_STUCK_STARTUP_S: '3', MINBOX_STUCK_MESSAGE_S: '3' })
    m.browserContext = context
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
  // A minbox on a machine with only Pi: there is no `claude` at all.
  piOnlyMinbox: async ({ context }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort(), `python3 ${FAKE_PI}`, 'minbox-e2e-no-such-claude')
    m.browserContext = context
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
  // A minbox where Pi is installed too (the fake pi), so both agents are offered.
  piMinbox: async ({ context }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort(), `python3 ${FAKE_PI}`)
    m.browserContext = context
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
  // A first run as a person sees it: the introduction not done yet (see Minbox.onboarded).
  freshMinbox: async ({ context }, use, testInfo) => {
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort())
    m.onboarded = false
    m.browserContext = context
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
  minbox: async ({ context }, use, testInfo) => {
    // A short path: the host's Unix socket lives in the data directory.
    const dir = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'mbx-'))
    const m = new Minbox(dir, await freePort())
    m.browserContext = context
    await m.start()
    await use(m)
    if (testInfo.status !== testInfo.expectedStatus) console.log(`--- minbox log (${testInfo.title}) ---\n${m.log.slice(-4000)}`)
    await m.cleanup()
  },
})

export { expect }

/**
 * Desktop: the Claude Code terminal pane is hidden by default; clicks the header toggle to show it.
 * A no-op when it is already shown and on phone/tablet widths (their terminal is a view, not a pane).
 */
export async function showTerminal(page: Page) {
  if ((page.viewportSize()?.width ?? 1500) < 700) return
  const toggle = page.getByTestId('terminal-toggle')
  await toggle.waitFor({ timeout: 5_000 })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(page.getByTestId('terminal')).toBeVisible()
}

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
  await showTerminal(page)
  await expect
    .poll(() => terminalText(page), { timeout: 15_000 })
    .toMatch(typeof re === 'string' ? new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : re)
}

/** Types a line into the terminal. */
export async function typeInTerminal(page: Page, text: string) {
  await showTerminal(page)
  // Keystrokes are sent only over an open socket and dropped otherwise. The terminal is mounted
  // (and its socket created) only when shown, so right after showTerminal, and again while it
  // reconnects, the socket may not be open yet: wait for the "connecting…"/"disconnected" badge to go.
  await expect(page.getByTestId('terminal').locator('xpath=..').getByText(/^(connecting…|disconnected)$/)).toHaveCount(0)
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

/**
 * Creates a session in the given directory (v3: through the API, as the composer's "New agent" does)
 * and opens its stream with the terminal beside it. The page must be on the minbox already.
 */
export async function createSession(page: Page, cwd: string, name: string, agent?: 'claude' | 'pi' | 'opencode') {
  if (!/^https?:/.test(page.url())) throw new Error('createSession: open the minbox first')
  const s = await page.evaluate(
    async (body) => {
      const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error('create session: ' + r.status + ' ' + (await r.text()))
      return r.json()
    },
    { cwd, name, agent },
  )
  await page.evaluate((id) => (location.hash = `v=agent&s=${id}`), s.id)
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', s.id)
  await showTerminal(page)
  await expect(page.getByTestId('terminal-session-name').filter({ hasText: name })).toBeVisible()
  return s.id as string
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
  await showTerminal(page)
  await expect(page.getByTestId('terminal-session-name').filter({ hasText: name })).toBeVisible()
  return id
}

/** Desktop: opens a session's (agent's) stream from the sidebar, with its terminal. */
export async function selectSession(page: Page, name: string) {
  await page.getByTestId('agent-row').filter({ has: page.locator('.v-nm', { hasText: name }) }).first().click()
  await showTerminal(page)
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
