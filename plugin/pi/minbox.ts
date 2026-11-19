/**
 * The minbox extension for Pi (@earendil-works/pi-coding-agent 1.x): a thin proxy between Pi and the
 * minbox server (mod protocol 1, docs/mod-protocol.md). minbox starts Pi with `-e <this file>` and
 * the environment MINBOX_TOKEN (this session's bearer token) and MINBOX_SERVER_FILE (a JSON file
 * holding the server's current URL). The Pi counterpart of the Claude Code mod
 * (plugin/minbox/hooks/register.ts); it shares ../minbox/hooks/proxy.ts with it.
 *
 * The extension holds no wording and makes no decisions about what the agent reads: the server does.
 * - Tools: the tool set (minbox_send_message, … with their descriptions and schemas) comes from GET
 *   /api/agent/tools at session start and is registered as given; every call goes to POST
 *   /api/agent/tool, whose text is the result (a failure throws: Pi turns that into a failed tool
 *   result). A heartbeat answer naming another tools_version registers the set again (Pi replaces a
 *   tool registered again under its name; one the server dropped is re-registered hidden).
 * - Guards: the server's guards block bash commands (one that would open a page on the host).
 * - Status: agent_start / agent_settled go to POST /api/agent/event (turn.start / turn.complete).
 * - Delivery: long-polls GET /api/agent/pending?proto=1. Once Pi has been idle for a moment each
 *   message is claimed (so one instance delivers it), its text (the server's) is started as a user
 *   turn with pi.sendUserMessage, then acknowledged as delivered. An urgent one (Send now, or one that
 *   waited long) goes into a running turn too, as a steering message. A failed delivery releases the
 *   claim.
 * - A long minbox_subagent run (plugin/pi/subagent.ts) keeps the status working: its partial results
 *   are tool_execution_update events, and busy.ts is a marker the two extensions share.
 * - The hello at every session start (also after /new or /resume, which restart the extension)
 *   reports the conversation id and file, so minbox resumes the right conversation later.
 *
 * The instructions text arrives with the command line (--append-system-prompt), as Pi keeps the
 * system prompt across compactions. Without MINBOX_TOKEN (Pi started by hand) the extension does
 * nothing.
 *
 * Everything below `install` is written against a small `Deps` interface so it can be tested
 * without Pi (minbox.test.ts, run with `node --test`); the default export wires the real thing.
 */
import { readFileSync } from 'node:fs'
import { guardDeny, manifestOf, pendingOf, PROTOCOL, serverUrlOf, type Manifest, type PendingItem } from '../minbox/hooks/proxy.ts'
import { busySeq } from './busy.ts'

export const EXT_VERSION = '0.2.0'

const POLL_WAIT_S = 20
const CALL_TIMEOUT_MS = 8000
const TOOL_TIMEOUT_MS = 60_000
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
  /** The server's tool set as registered. */
  let manifest: Manifest | null = null
  let registering: Promise<void> | null = null

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

  /** A small log of this extension's own trouble (ids and counts only), sent with each heartbeat. */
  let events: { at: string; kind: string; msg: string }[] = []
  let failStreak = 0
  let lastPollAt = ''
  let lastDeliveryAt = ''
  let heartbeatSeq = 0
  let lastBeat = 0
  const note = (kind: string, msg: string) => {
    events.push({ at: new Date(deps.now()).toISOString(), kind, msg })
    if (events.length > 40) events = events.slice(-40)
  }
  const api = async (method: string, path: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS) => {
    const res = await apiOnce(method, path, body, timeoutMs)
    if (res.status === 0 || res.status >= 500) {
      if (failStreak++ < 10) note('api-error', `${method} ${path.split('?')[0]}: ${res.status === 0 ? 'not reachable' : 'HTTP ' + res.status}`)
    } else {
      if (failStreak >= 3) note('online', `the server answers again after ${failStreak} failed call(s)`)
      failStreak = 0
    }
    return res
  }
  const event = (body: Record<string, unknown>) => api('POST', '/api/agent/event', body)

  /** Every 15 s (checked once per loop round): the server tells a live extension from a silent one. See docs/mod-connection.md. */
  async function heartbeat(): Promise<void> {
    if (deps.now() - lastBeat < 15_000) return
    lastBeat = deps.now()
    const res = await api('POST', '/api/agent/heartbeat', {
      seq: ++heartbeatSeq,
      agent: 'pi',
      ext_version: EXT_VERSION,
      protocol: PROTOCOL,
      state: busy ? 'working' : 'idle',
      last_poll_at: lastPollAt,
      last_delivery_at: lastDeliveryAt,
      info: { fail_streak: failStreak, tools_version: manifest?.version ?? '' },
      events: events.slice(-25),
    })
    const want = res.ok ? res.json?.tools_version : undefined
    if (typeof want === 'string' && want !== manifest?.version) await refreshTools()
  }

  function setBusy(value: boolean): void {
    if (value) {
      busyAt = deps.now()
      if (!busy) void event({ type: 'turn.start' })
      busy = true
    } else {
      void event({ type: 'turn.complete' }) // idempotent on the server
      busy = false
      idleSince = deps.now()
    }
  }

  // ---- tools (the server's) ----

  /** Fetches the server's tool set and registers it; tools it no longer has are withdrawn (hidden). */
  function refreshTools(): Promise<void> {
    if (registering) return registering
    registering = (async () => {
      const res = await api('GET', '/api/agent/tools')
      const m = res.ok ? manifestOf(res.json) : null
      if (!m) {
        note('tools-failed', `the tool set could not be fetched (${res.status === 0 ? 'not reachable' : 'HTTP ' + res.status})`)
        return
      }
      const names = new Set(m.tools.map((t) => t.name))
      for (const t of m.tools) {
        pi.registerTool({
          name: t.name,
          label: t.label ?? t.name,
          description: t.description,
          parameters: t.input_schema,
          execute: (_id: string, args: any) => callTool(t.name, args),
        })
      }
      for (const old of manifest?.tools ?? []) {
        if (!names.has(old.name)) pi.registerTool({ name: old.name, label: old.label ?? old.name, description: old.description, parameters: old.input_schema, exposure: 'hidden', execute: (_id: string, args: any) => callTool(old.name, args) })
      }
      if (manifest && manifest.version !== m.version) note('tools-updated', `tool set ${manifest.version} -> ${m.version}`)
      manifest = m
    })().finally(() => {
      registering = null
    })
    return registering
  }

  async function callTool(name: string, args: unknown) {
    const res = await api('POST', '/api/agent/tool', { tool: name, args: args ?? {} }, TOOL_TIMEOUT_MS)
    if (!res.ok) throw new Error(`minbox: ${res.json?.error ?? `HTTP ${res.status}`}`)
    if (res.json?.ok !== true) throw new Error(String(res.json?.error ?? 'minbox: the tool failed'))
    return textResult(String(res.json.text ?? ''))
  }

  // The server's guards (a page opened on the host).
  pi.on('tool_call', async (e: any) => {
    if (busy) busyAt = deps.now()
    const command = typeof e?.input?.command === 'string' ? e.input.command : ''
    const reason = guardDeny(manifest?.guards, String(e?.toolName ?? ''), command)
    if (reason !== null) return { block: true, reason }
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
      protocol: PROTOCOL,
      reason: e?.reason,
    })
    await refreshTools()
    // The server moves a starting session to idle on hello; tell it where Pi stands anyway.
    void event({ type: 'turn.complete' })
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
    if (!manifest) await refreshTools() // the server was not reachable at the start
    // Wait on the server only while idle; while busy, just look.
    const wait = busy ? 0 : POLL_WAIT_S
    const res = await api('GET', `/api/agent/pending?owner=${encodeURIComponent(owner)}&wait=${wait}&proto=${PROTOCOL}`, undefined, POLL_TIMEOUT_MS)
    if (stopped) return false
    if (!res.ok) return false
    lastPollAt = new Date(deps.now()).toISOString()
    const answer = pendingOf(res.json)
    if (!answer || answer.items.length === 0) return wait > 0
    // Deliver only into a quiet session, so the person's own typing goes first; an urgent
    // message (Send now, or one that waited long) goes in anyway.
    const now = deps.now()
    const quiet = !busy && piIdle() && now - idleSince >= QUIET_MS && now - typedAt >= QUIET_MS
    const due = answer.items.filter((p) => quiet || p.urgent)
    if (due.length === 0) return false
    const claimed: PendingItem[] = []
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
      const text = deliver.map((p) => p.text).join(answer.joiner)
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
    lastDeliveryAt = new Date(deps.now()).toISOString()
    note('delivered', `submitted ${deliver.length} message(s): ${deliver.map((p) => p.id).join(',')}`)
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
          await heartbeat()
          await deliverOnce()
        } catch (err) {
          note('loop-error', String(err).slice(0, 150)) // the next round tries again
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
