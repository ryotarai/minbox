/**
 * The minbox extension for Pi (@earendil-works/pi-coding-agent 1.x). minbox starts Pi with
 * `-e <this file>` and the environment MINBOX_TOKEN (this session's bearer token) and
 * MINBOX_SERVER_FILE (a JSON file holding the server's current URL). It is the Pi counterpart of
 * the Claude Code mod (plugin/minbox/hooks/register.ts) and talks to the same /api/agent/* API;
 * the text of the tools and of the delivered replies is shared (../minbox/hooks/text.ts).
 *
 * - Registers minbox_send_message, minbox_read_thread, minbox_set_session_title, minbox_open_url
 *   and minbox_card. A failing call throws (Pi turns that into a failed tool result).
 * - Reports whether Pi is working or idle (agent_start -> working, agent_settled -> idle).
 * - Long-polls the server for the person's messages. Once Pi has been idle for a moment each is
 *   claimed (so one instance delivers it), started as a user turn with pi.sendUserMessage, then
 *   acknowledged as delivered. An urgent one (Send now, or one that waited long) is delivered into
 *   a running turn too, as a steering message. A failed delivery releases the claim.
 * - A long minbox_subagent run (plugin/pi/subagent.ts) keeps the status working: its partial results
 *   are tool_execution_update events, and busy.ts is a marker the two extensions share.
 * - Refuses Bash commands that would open a page on the host machine.
 * - Reports the conversation id and file in a hello at every session start (also after /new or
 *   /resume, which restart the extension), so minbox resumes the right conversation later.
 *
 * The instructions text arrives with the command line (--append-system-prompt), as Pi keeps the
 * system prompt across compactions; there is no re-injection here (unlike the Claude Code mod).
 * Not done yet (Phase 2 of docs/agents.md): the nudges for questions asked only in the chat, the
 * open-threads reminder after a compaction.
 *
 * Without MINBOX_TOKEN (Pi started by hand) the extension does nothing.
 *
 * Everything below `install` is written against a small `Deps` interface so it can be tested
 * without Pi (minbox.test.ts, run with `node --test`); the default export wires the real thing.
 */
import { readFileSync } from 'node:fs'
import {
  CARD_DESCRIPTION,
  CARD_SCHEMA,
  CARD_TOOL,
  cardText,
  openDeny,
  opensBrowser,
  OPEN_DESCRIPTION,
  OPEN_SCHEMA,
  OPEN_TOOL,
  READ_DESCRIPTION,
  READ_SCHEMA,
  READ_TOOL,
  SEND_DESCRIPTION,
  SEND_SCHEMA,
  SEND_TOOL,
  sentText,
  serverUrlOf,
  threadListText,
  threadText,
  TITLE_DESCRIPTION,
  TITLE_SCHEMA,
  TITLE_TOOL,
  wakeText,
  type Pending,
  type Thread,
} from '../minbox/hooks/text.ts'
import { busySeq } from './busy.ts'

export const EXT_VERSION = '0.1.0'
/** Pi's names for the minbox tools (the server writes the instructions with the same prefix). */
export const TOOL_PREFIX = 'minbox_'

const POLL_WAIT_S = 20
const CALL_TIMEOUT_MS = 8000
const POLL_TIMEOUT_MS = (POLL_WAIT_S + 10) * 1000
/** Pi counts as quiet (the person is not typing, no turn runs) after this long idle. */
const QUIET_MS = 2000
/** Busy for this long with no tool or turn event: assume an agent_settled was missed. */
const BUSY_STALE_MS = 120_000
const RETRY_MS = 1000

/** What the extension needs from the outside; replaced in tests. */
export type Deps = {
  env: Record<string, string | undefined>
  /** fetch with a timeout is done here; this is the plain fetch. */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  readFile: (path: string) => string | null
  now: () => number
  sleep: (ms: number) => Promise<void>
  randomId: () => string
}

export function realDeps(): Deps {
  return {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    randomId: () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (x) => x.toString(16).padStart(2, '0')).join(''),
  }
}

type ApiResult = { ok: boolean; status: number; json: any }

const textResult = (text: string) => ({ content: [{ type: 'text', text }], details: undefined })

export default function (pi: any): void {
  install(pi, realDeps())
}

export function install(pi: any, deps: Deps): { stop(): void } | null {
  const token = deps.env.MINBOX_TOKEN
  const serverFile = deps.env.MINBOX_SERVER_FILE
  if (!token || !serverFile) return null // not started by minbox: do nothing
  const owner = deps.randomId()

  let baseUrl: string | null = null
  let stopped = false
  let loopRunning = false
  let ctx: any = null
  let busy = false
  let busyAt = 0
  /** busySeq() as last seen: a change means another extension (subagent.ts) saw something alive. */
  let seenBusySeq = busySeq()
  let idleSince = deps.now()
  /** The person typed: their turn goes first. */
  let typedAt = 0

  const names = {
    send: TOOL_PREFIX + SEND_TOOL,
    read: TOOL_PREFIX + READ_TOOL,
    title: TOOL_PREFIX + TITLE_TOOL,
    open: TOOL_PREFIX + OPEN_TOOL,
    card: TOOL_PREFIX + CARD_TOOL,
  }

  function readBaseUrl(force: boolean): string | null {
    if (baseUrl && !force) return baseUrl
    baseUrl = serverUrlOf(deps.readFile(serverFile!))
    return baseUrl
  }

  async function apiOnce(method: string, path: string, body: unknown, timeoutMs: number): Promise<ApiResult> {
    for (const force of [false, true]) {
      const url = readBaseUrl(force)
      if (!url) continue
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const res = await deps.fetch(url + path, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ac.signal,
        })
        const text = await res.text()
        let json: any = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = null
        }
        return { ok: res.ok, status: res.status, json }
      } catch {
        // connection refused or timed out: the server may have restarted on another address
        baseUrl = null
      } finally {
        clearTimeout(timer)
      }
    }
    return { ok: false, status: 0, json: { error: 'the minbox server is not reachable' } }
  }

  const api = (method: string, path: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS) => apiOnce(method, path, body, timeoutMs)

  const fail = (res: ApiResult): never => {
    throw new Error(`minbox: ${res.json?.error ?? `HTTP ${res.status}`}`)
  }

  function setBusy(value: boolean): void {
    if (value) {
      busyAt = deps.now()
      if (!busy) void api('POST', '/api/agent/status', { status: 'working' })
      busy = true
    } else {
      void api('POST', '/api/agent/status', { status: 'idle' }) // idempotent on the server
      busy = false
      idleSince = deps.now()
    }
  }

  // ---- tools ----

  pi.registerTool({
    name: names.send,
    label: 'minbox: send message',
    description: SEND_DESCRIPTION,
    parameters: SEND_SCHEMA,
    async execute(_id: string, e: any) {
      const body = typeof e.body === 'string' ? e.body : ''
      if (!body.trim()) throw new Error('body is required.')
      if (e.status !== 'working' && e.status !== 'need_action' && e.status !== 'blocked' && e.status !== 'finished') {
        throw new Error('status is required: working (you carry on), need_action (you need the person), blocked (you wait on something outside them) or finished (the task is done). Send the message again with it.')
      }
      const title = typeof e.thread_title === 'string' && e.thread_title.trim() ? e.thread_title : typeof e.subject === 'string' ? e.subject : ''
      if (!title.trim()) {
        throw new Error('thread_title is required: name what the thread is about now, in about 30 characters or fewer. Send the message again with it.')
      }
      const res = await api('POST', '/api/agent/messages', {
        body,
        thread_title: title,
        thread_id: typeof e.thread_id === 'string' && e.thread_id ? e.thread_id : undefined,
        name: typeof e.name === 'string' && e.name ? e.name : undefined,
        status: e.status,
        attachments: Array.isArray(e.attachments) ? e.attachments.filter((a: unknown) => typeof a === 'string') : undefined,
        review: e.review && typeof e.review === 'object' ? e.review : undefined,
      })
      if (!res.ok) fail(res)
      return textResult(sentText(res.json))
    },
  })

  pi.registerTool({
    name: names.read,
    label: 'minbox: read thread',
    description: READ_DESCRIPTION,
    parameters: READ_SCHEMA,
    async execute(_id: string, e: any) {
      const id = typeof e.thread_id === 'string' && e.thread_id ? e.thread_id : null
      const res = await api('GET', id ? `/api/agent/threads/${encodeURIComponent(id)}` : '/api/agent/threads')
      if (!res.ok) fail(res)
      return textResult(id ? threadText(res.json as Thread) : threadListText(res.json as Thread[]))
    },
  })

  pi.registerTool({
    name: names.title,
    label: 'minbox: set session title',
    description: TITLE_DESCRIPTION,
    parameters: TITLE_SCHEMA,
    async execute(_id: string, e: any) {
      const t = typeof e.title === 'string' ? e.title.trim() : ''
      if (!t) throw new Error('title is required.')
      const res = await api('POST', '/api/agent/title', { title: t })
      if (!res.ok) fail(res)
      return textResult(`Session title set: ${res.json?.title ?? t}`)
    },
  })

  pi.registerTool({
    name: names.open,
    label: 'minbox: open url',
    description: OPEN_DESCRIPTION.replace('the machine Claude runs on', 'the machine you run on'),
    parameters: OPEN_SCHEMA,
    async execute(_id: string, e: any) {
      const url = typeof e.url === 'string' ? e.url.trim() : ''
      if (!url) throw new Error('url is required.')
      const res = await api('POST', '/api/agent/open', { url })
      if (!res.ok) fail(res)
      return textResult(`Opened ${res.json?.url ?? url} in the person's browser.`)
    },
  })

  pi.registerTool({
    name: names.card,
    label: 'minbox: board card',
    description: CARD_DESCRIPTION,
    parameters: CARD_SCHEMA,
    async execute(_id: string, e: any) {
      const fields: Record<string, unknown> = {}
      for (const k of ['title', 'column', 'note', 'thread_id', 'pr_url', 'pr_state', 'pr_number']) {
        if (e[k] !== undefined) fields[k] = e[k]
      }
      let res: ApiResult
      if (e.action === 'list') res = await api('GET', '/api/agent/cards')
      else if (e.action === 'create') res = await api('POST', '/api/agent/cards', fields)
      else if (e.action === 'update') {
        if (typeof e.id !== 'string' || !e.id) throw new Error('update needs the card id.')
        res = await api('PATCH', `/api/agent/cards/${encodeURIComponent(e.id)}`, fields)
      } else throw new Error('action must be list, create or update.')
      if (!res.ok) fail(res)
      return textResult(cardText(e.action, res.json))
    },
  })

  // Pages opened from bash would open on the host, not where the person is.
  pi.on('tool_call', async (e: any) => {
    if (busy) busyAt = deps.now()
    if (e?.toolName === 'bash' && typeof e.input?.command === 'string' && opensBrowser(e.input.command)) {
      return { block: true, reason: openDeny(names.open) }
    }
    return undefined
  })

  // ---- status ----

  pi.on('agent_start', async () => setBusy(true))
  pi.on('agent_settled', async () => setBusy(false))
  const alive = async () => {
    if (busy) busyAt = deps.now()
  }
  pi.on('turn_start', alive)
  pi.on('tool_execution_start', alive)
  // A long tool (minbox_subagent) streams partial results as tool_execution_update.
  pi.on('tool_execution_update', alive)
  pi.on('input', async (e: any) => {
    if (e?.source === 'interactive') typedAt = deps.now()
    return { action: 'continue' }
  })

  // ---- lifecycle ----

  pi.on('session_start', async (e: any, c: any) => {
    ctx = c
    let id: string | undefined
    let file: string | undefined
    try {
      id = c.sessionManager.getSessionId()
      file = c.sessionManager.getSessionFile()
    } catch {
      /* an old or different Pi: the hello goes without them */
    }
    await api('POST', '/api/agent/hello', {
      agent: 'pi',
      agent_session_id: id,
      session_file: file,
      ext_version: EXT_VERSION,
      reason: e?.reason,
    })
    // The server moves a starting session to idle on hello; tell it where Pi stands anyway.
    void api('POST', '/api/agent/status', { status: 'idle' })
    idleSince = deps.now()
    if (!loopRunning && !stopped) void loop()
  })

  pi.on('session_shutdown', async () => {
    stopped = true
  })

  // ---- delivery of the person's messages ----

  function piIdle(): boolean {
    try {
      return typeof ctx?.isIdle === 'function' ? !!ctx.isIdle() : !busy
    } catch {
      return !busy
    }
  }

  async function deliverOnce(): Promise<boolean> {
    const seq = busySeq()
    if (seq !== seenBusySeq) {
      seenBusySeq = seq
      if (busy) busyAt = deps.now()
    }
    if (busy && deps.now() - busyAt > BUSY_STALE_MS) {
      // No event for a long while: an agent_settled was missed. Treat Pi as idle again.
      setBusy(false)
    }
    // Wait on the server only while idle; while busy, just look.
    const wait = busy ? 0 : POLL_WAIT_S
    const res = await api('GET', `/api/agent/pending?owner=${encodeURIComponent(owner)}&wait=${wait}`, undefined, POLL_TIMEOUT_MS)
    if (stopped) return false
    if (!res.ok) return false
    if (!Array.isArray(res.json) || res.json.length === 0) return wait > 0
    const pending = res.json as Pending[]
    // Deliver only into a quiet session, so the person's own typing goes first; an urgent
    // message (Send now, or one that waited long) goes in anyway.
    const now = deps.now()
    const quiet = !busy && piIdle() && now - idleSince >= QUIET_MS && now - typedAt >= QUIET_MS
    const due = pending.filter((p) => quiet || p.urgent)
    if (due.length === 0) return false
    const claimed: Pending[] = []
    for (const p of due) {
      const c = await api('POST', pendingPath(p.id, 'claim'))
      if (c.ok && c.json?.claimed) claimed.push(p)
    }
    if (stopped || claimed.length === 0) return false
    // Re-check as late as possible: the delivery cannot be taken back.
    let deliver = claimed
    let steer = false
    if (busy || !piIdle()) {
      for (const p of claimed.filter((p) => !p.urgent)) await api('POST', pendingPath(p.id, 'release'))
      deliver = claimed.filter((p) => p.urgent)
      steer = true
      if (deliver.length === 0) return false
    }
    try {
      const text = wakeText(deliver, names.send, names.read)
      if (steer) pi.sendUserMessage(text, { deliverAs: 'steer' })
      else pi.sendUserMessage(text)
    } catch (err) {
      for (const p of deliver) await api('POST', pendingPath(p.id, 'release'))
      try {
        ctx?.ui?.notify?.(`minbox: a reply could not be delivered (${String(err)}); it stays in the inbox.`, 'warning')
      } catch {
        /* no UI */
      }
      return false
    }
    for (const p of deliver) await api('POST', pendingPath(p.id, 'delivered'))
    return true
  }

  function pendingPath(id: string, action: 'claim' | 'release' | 'delivered'): string {
    return `/api/agent/pending/${encodeURIComponent(id)}/${action}?owner=${encodeURIComponent(owner)}`
  }

  async function loop(): Promise<void> {
    loopRunning = true
    try {
      while (!stopped) {
        const t0 = deps.now()
        try {
          await deliverOnce()
        } catch {
          /* the next round tries again */
        }
        // A long poll takes seconds; anything quicker (busy, an error, an old server that does not
        // wait) must not turn into a tight loop.
        if (!stopped && deps.now() - t0 < RETRY_MS) await deps.sleep(RETRY_MS)
      }
    } finally {
      loopRunning = false
    }
  }

  return { stop: () => void (stopped = true) }
}
