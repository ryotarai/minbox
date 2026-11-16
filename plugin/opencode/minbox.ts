/**
 * The minbox plugin for OpenCode 2.x ("V2" server plugins). minbox starts OpenCode as
 * `opencode --standalone --auto --session <id>` with this folder in OPENCODE_CONFIG_CONTENT
 * ({"plugins":[{"package":"<this folder>"}]}) and the environment MINBOX_TOKEN (the session's bearer
 * token), MINBOX_SERVER_FILE (a JSON file holding the server's URL), MINBOX_OPENCODE_SESSION (the
 * OpenCode session minbox created for this minbox session) and MINBOX_OPENCODE_DIR (its folder). It is
 * the OpenCode counterpart of the Pi extension (plugin/pi/minbox.ts) and speaks the same /api/agent/*
 * protocol; the wording of tools and delivered messages is shared (../minbox/hooks/text.ts, nav.ts).
 *
 * - Registers minbox_send_message, minbox_read_thread, minbox_set_session_title, minbox_open_url
 *   and the read-only navigation tools as direct tools (codemode: false; OpenCode puts plugin
 *   tools behind its Code Mode `execute` tool otherwise).
 * - Adds minbox's instructions (from the hello answer) to the system prompt of every model request of
 *   the session (session hook "context"), so they survive compaction.
 * - Reports working / idle from session.execution.* events.
 * - Long-polls the server for the person's messages and, once the session has been idle for a moment,
 *   claims them, starts a turn with ctx.session.prompt and marks them delivered. An urgent one (Send now)
 *   goes into a running turn too (delivery "steer": OpenCode adds it at the next step).
 * - Denies shell commands that open a page on the host, and OpenCode's `question` tool in the main
 *   session (the person answers in minbox, not in the terminal), through the permission hook.
 * - Creates the session if it is missing and moves it to MINBOX_OPENCODE_DIR when the project's folder
 *   changed (OpenCode sessions can move between folders).
 * - Follows a new top-level session the person starts in the TUI (/new) like Pi's extension does: the
 *   hello reports its id, so minbox resumes it later.
 *
 * OpenCode loads a plugin once per location (folder) a server touches, so setup can run more than once in
 * one process: tools and hooks are registered per location, the delivery loop and the state are one per
 * process (globalThis). Without MINBOX_TOKEN (OpenCode started by hand) the plugin does nothing.
 *
 * Everything is written against small Deps / Ctx shapes so it can be tested without OpenCode
 * (minbox.test.ts, `node --test`).
 */
import { readFileSync, realpathSync } from 'node:fs'
import { NAV_DESCRIPTION, NAV_SCHEMA, NAV_TOOLS, navPath, navText } from '../minbox/hooks/nav.ts'
import {
  openDeny,
  opensBrowser,
  OPEN_DESCRIPTION,
  OPEN_SCHEMA,
  OPEN_TOOL,
  READ_DESCRIPTION,
  READ_SCHEMA,
  READ_TOOL,
  readPath,
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

export const EXT_VERSION = '0.1.0'
/** OpenCode's names for the minbox tools (the server writes the instructions with the same prefix). */
export const TOOL_PREFIX = 'minbox_'

const POLL_WAIT_S = 20
const CALL_TIMEOUT_MS = 8000
const POLL_TIMEOUT_MS = (POLL_WAIT_S + 10) * 1000
/** The session counts as quiet (no turn runs, the person did not just submit) after this long idle. */
const QUIET_MS = 2000
/** Busy for this long with no execution or tool event: assume a missed end event. */
const BUSY_STALE_MS = 120_000
const RETRY_MS = 1000
const HEARTBEAT_MS = 15_000

const EXECUTION_EVENTS = ['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']
const ALIVE_EVENTS = ['session.step.started', 'session.step.ended', 'session.tool.called', 'session.tool.progress', 'session.tool.success', 'session.tool.failed']

/** What the plugin needs from the outside; replaced in tests. */
export type Deps = {
  env: Record<string, string | undefined>
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  readFile: (path: string) => string | null
  realpath: (path: string) => string
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
    realpath: (p) => {
      try {
        return realpathSync(p)
      } catch {
        return p
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    randomId: () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (x) => x.toString(16).padStart(2, '0')).join(''),
  }
}

type ApiResult = { ok: boolean; status: number; json: any }

/** Tool names in a shared description, as OpenCode sees them. */
const ocNames = (text: string) => text.replace(/\b(read_thread|list_threads)\b/g, TOOL_PREFIX + '$1')

/** The major version of OpenCode from ctx.app.version ("2.1.4"); 0 when unknown. */
export function majorVersion(v: unknown): number {
  const m = /^v?(\d+)\./.exec(String(v ?? ''))
  return m ? Number(m[1]) : 0
}

/** Where a session runs, as OpenCode reports it (session.get). */
function dirOf(info: any): string {
  return String(info?.location?.directory ?? info?.directory ?? '')
}

function errorText(err: unknown): string {
  const e = err as any
  return String(e?._tag ?? e?.name ?? '') + ': ' + String(e?.message ?? e)
}

function notFound(err: unknown): boolean {
  return /NotFound/i.test(errorText(err))
}

/** One process's minbox state: the session, the delivery loop, the heartbeat. Shared by every location's setup. */
export type Core = ReturnType<typeof createCore>

export function createCore(deps: Deps) {
  const token = deps.env.MINBOX_TOKEN
  const serverFile = deps.env.MINBOX_SERVER_FILE
  const owner = deps.randomId()
  const wantDir = deps.env.MINBOX_OPENCODE_DIR || ''
  let sessionID = deps.env.MINBOX_OPENCODE_SESSION || ''
  let baseUrl: string | null = null
  let stopped = false
  let started = false
  let loopRunning = false
  let busy = false
  let busyAt = 0
  let idleSince = deps.now()
  /** The person submitted a prompt in the TUI: their turn goes first. */
  let typedAt = 0
  let instructions = ''
  let version = ''
  const ctxs: any[] = []

  const names = {
    send: TOOL_PREFIX + SEND_TOOL,
    read: TOOL_PREFIX + READ_TOOL,
    title: TOOL_PREFIX + TITLE_TOOL,
    open: TOOL_PREFIX + OPEN_TOOL,
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
        baseUrl = null // the server may have restarted on another address
      } finally {
        clearTimeout(timer)
      }
    }
    return { ok: false, status: 0, json: { error: 'the minbox server is not reachable' } }
  }

  /** A small log of the plugin's own trouble (ids and counts only), sent with each heartbeat. */
  let events: { at: string; kind: string; msg: string }[] = []
  let failStreak = 0
  let lastPollAt = ''
  let lastDeliveryAt = ''
  let heartbeatSeq = 0
  let lastBeat = 0
  const note = (kind: string, msg: string) => {
    const last = events[events.length - 1]
    if (last && last.kind === kind && last.msg.replace(/ \(x\d+\)$/, '') === msg) {
      const n = Number(/\(x(\d+)\)$/.exec(last.msg)?.[1] ?? 1) + 1
      last.msg = `${msg} (x${n})`
      last.at = new Date(deps.now()).toISOString()
      return
    }
    events.push({ at: new Date(deps.now()).toISOString(), kind, msg })
    if (events.length > 60) events = events.slice(-60)
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

  /** Every 15 s (checked once per loop round): the server tells a live plugin from a silent one. See docs/mod-connection.md. */
  async function heartbeat(): Promise<void> {
    if (deps.now() - lastBeat < HEARTBEAT_MS) return
    lastBeat = deps.now()
    await api('POST', '/api/agent/heartbeat', {
      seq: ++heartbeatSeq,
      agent: 'opencode',
      ext_version: EXT_VERSION,
      state: busy ? 'working' : 'idle',
      last_poll_at: lastPollAt,
      last_delivery_at: lastDeliveryAt,
      info: { fail_streak: failStreak, opencode_version: version, locations: ctxs.length, owner_prefix: owner.slice(0, 4) },
      events: events.slice(-25),
    })
  }

  const fail = (res: ApiResult): never => {
    throw new Error(`minbox: ${res.json?.error ?? `HTTP ${res.status}`}`)
  }

  function setBusy(value: boolean): void {
    if (value) {
      busyAt = deps.now()
      if (!busy) void api('POST', '/api/agent/status', { status: 'working' })
      busy = true
    } else {
      if (busy) void api('POST', '/api/agent/status', { status: 'idle' })
      busy = false
      idleSince = deps.now()
    }
  }

  /** A context to call OpenCode with: any live location's (sessions are global to the server). */
  function ctx(): any {
    return ctxs[ctxs.length - 1] ?? null
  }

  async function hello(reason: string): Promise<void> {
    const res = await api('POST', '/api/agent/hello', {
      agent: 'opencode',
      agent_session_id: sessionID || undefined,
      ext_version: EXT_VERSION,
      opencode_version: version,
      reason,
    })
    if (res.ok && typeof res.json?.instructions === 'string') instructions = res.json.instructions
    note('hello', `${reason} session=${sessionID}`)
  }

  /** The session minbox chose exists (minbox creates it before the start; this is the fallback) and is in its folder. */
  async function ensureSession(): Promise<void> {
    const c = ctx()
    if (!c || !sessionID) return
    let info: any = null
    try {
      info = await c.session.get({ sessionID })
    } catch (err) {
      if (!notFound(err)) {
        note('session-get-failed', errorText(err).slice(0, 150))
        return
      }
    }
    if (!info) {
      try {
        await c.session.create({ id: sessionID, location: wantDir ? { directory: wantDir } : undefined })
        note('session-created', `${sessionID} (the TUI shows it after a restart of the session)`)
      } catch (err) {
        note('session-create-failed', errorText(err).slice(0, 150))
      }
      return
    }
    const at = dirOf(info)
    if (wantDir && at && deps.realpath(at) !== deps.realpath(wantDir)) {
      // The project's folder changed: the conversation goes on in the new folder.
      try {
        await c.session.move({ sessionID, directory: wantDir })
        note('session-moved', `to the project's folder (from another folder)`)
      } catch (err) {
        note('session-move-failed', errorText(err).slice(0, 150))
      }
    }
  }

  async function start(): Promise<void> {
    if (started || stopped) return
    started = true
    await hello('startup')
    await ensureSession()
    void api('POST', '/api/agent/status', { status: 'idle' })
    idleSince = deps.now()
    if (!loopRunning) void loop()
  }

  // ---- hooks (registered per location, handled here) ----

  function onEvent(ev: any): void {
    const sid = ev?.data?.sessionID
    if (!sid || sid !== sessionID) return
    const type = String(ev.type ?? '')
    if (type === 'session.execution.started') setBusy(true)
    else if (EXECUTION_EVENTS.includes(type)) setBusy(false)
    else if (busy) busyAt = deps.now()
  }

  /** session hook "context": minbox's instructions in the system prompt of every request of the session. */
  function onContext(event: any): void {
    if (!instructions || event?.sessionID !== sessionID || !Array.isArray(event?.system)) return
    event.system.push({ type: 'text', text: instructions })
  }

  /** session hook "prompt": the person submitted in the TUI (their turn goes first), or switched sessions. */
  async function onPrompt(event: any): Promise<void> {
    if (event?.metadata?.minbox) return // our own delivery
    const sid = event?.sessionID
    if (!sid) return
    if (sid === sessionID) {
      typedAt = deps.now()
      return
    }
    // Another session: a top-level one is the person's new conversation (/new in the TUI). Follow it.
    try {
      const info = await ctx()?.session.get({ sessionID: sid })
      if (!info || info.parentID) return
    } catch {
      return
    }
    sessionID = sid
    typedAt = deps.now()
    busy = false
    note('session-switched', `the TUI now works in ${sid}`)
    await hello('session-switched')
  }

  /** permission hook "evaluate": no pages opened on the host, no TUI-only questions in the main session. */
  function onPermission(event: any): void {
    const action = String(event?.action ?? '')
    const resources: unknown[] = Array.isArray(event?.resources) ? event.resources : []
    if ((action === 'shell' || action === 'bash') && resources.some((r) => typeof r === 'string' && opensBrowser(r))) {
      event.effect = 'deny'
      event.message = openDeny(names.open)
      note('denied-open', 'a shell command that opens a page on the host')
      return
    }
    if (action === 'question' && event?.sessionID === sessionID) {
      event.effect = 'deny'
      event.message = `minbox: the person follows this session in the minbox inbox and does not see questions in the terminal. Ask with ${names.send} (a :::question block) instead.`
    }
  }

  function onToolBefore(): void {
    if (busy) busyAt = deps.now()
  }

  // ---- tools ----

  type ToolDef = { name: string; description: string; input: object; execute: (input: any, context: any) => Promise<{ content: string }> }
  const ok = (content: string) => ({ content })

  const tools: ToolDef[] = [
    {
      name: names.send,
      description: SEND_DESCRIPTION,
      input: SEND_SCHEMA,
      async execute(e: any) {
        const body = typeof e?.body === 'string' ? e.body : ''
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
        return ok(sentText(res.json))
      },
    },
    {
      name: names.read,
      description: ocNames(READ_DESCRIPTION),
      input: READ_SCHEMA,
      async execute(e: any) {
        const id = typeof e?.thread_id === 'string' && e.thread_id ? e.thread_id : null
        const res = await api('GET', readPath(e ?? {}))
        if (!res.ok) fail(res)
        return ok(id ? threadText(res.json as Thread, names.read) : threadListText(res.json as Thread[]))
      },
    },
    ...NAV_TOOLS.map(
      (tool): ToolDef => ({
        name: TOOL_PREFIX + tool,
        description: ocNames(NAV_DESCRIPTION[tool]),
        input: NAV_SCHEMA[tool],
        async execute(e: any) {
          const req = navPath(tool, e ?? {})
          if ('error' in req) throw new Error(req.error)
          const res = await api('GET', req.path)
          if (!res.ok) fail(res)
          return ok(navText(tool, res.json))
        },
      }),
    ),
    {
      name: names.title,
      description: TITLE_DESCRIPTION,
      input: TITLE_SCHEMA,
      async execute(e: any) {
        const t = typeof e?.title === 'string' ? e.title.trim() : ''
        if (!t) throw new Error('title is required.')
        const res = await api('POST', '/api/agent/title', { title: t })
        if (!res.ok) fail(res)
        // OpenCode's own session list shows the same title.
        try {
          await ctx()?.session.update({ sessionID, title: t })
        } catch (err) {
          note('title-update-failed', errorText(err).slice(0, 120))
        }
        return ok(`Session title set: ${res.json?.title ?? t}`)
      },
    },
    {
      name: names.open,
      description: OPEN_DESCRIPTION.replace('the machine Claude runs on', 'the machine you run on'),
      input: OPEN_SCHEMA,
      async execute(e: any) {
        const url = typeof e?.url === 'string' ? e.url.trim() : ''
        if (!url) throw new Error('url is required.')
        const res = await api('POST', '/api/agent/open', { url })
        if (!res.ok) fail(res)
        return ok(`Opened ${res.json?.url ?? url} in the person's browser.`)
      },
    },
  ]

  // ---- delivery of the person's messages ----

  async function deliverOnce(): Promise<boolean> {
    if (!ctx()) return false // no location loaded right now: nothing to deliver with
    if (busy && deps.now() - busyAt > BUSY_STALE_MS) {
      note('busy-stale', 'no execution event for 120 s: treated as idle')
      setBusy(false)
    }
    // Wait on the server only while idle; while busy, just look.
    const wait = busy ? 0 : POLL_WAIT_S
    const res = await api('GET', `/api/agent/pending?owner=${encodeURIComponent(owner)}&wait=${wait}`, undefined, POLL_TIMEOUT_MS)
    if (stopped) return false
    if (!res.ok) return false
    lastPollAt = new Date(deps.now()).toISOString()
    if (!Array.isArray(res.json) || res.json.length === 0) return wait > 0
    const pending = res.json as Pending[]
    // Deliver only into a quiet session, so the person's own prompt goes first; an urgent message
    // (Send now, or one that waited long) goes in anyway, steered into the running turn.
    const now = deps.now()
    const quiet = !busy && now - idleSince >= QUIET_MS && now - typedAt >= QUIET_MS
    const due = pending.filter((p) => quiet || p.urgent)
    if (due.length === 0) return false
    const claimed: Pending[] = []
    for (const p of due) {
      const c = await api('POST', pendingPath(p.id, 'claim'))
      if (c.ok && c.json?.claimed) claimed.push(p)
    }
    if (stopped || claimed.length === 0) return false
    let deliver = claimed
    if (busy) {
      for (const p of claimed.filter((p) => !p.urgent)) await api('POST', pendingPath(p.id, 'release'))
      deliver = claimed.filter((p) => p.urgent)
      if (deliver.length === 0) return false
    }
    const c = ctx()
    try {
      if (!c) throw new Error('OpenCode is not ready')
      // "steer" is OpenCode's default: an idle session starts a turn, a running one takes the message at
      // its next step.
      await c.session.prompt({ sessionID, text: wakeText(deliver, names.send, names.read), delivery: 'steer', metadata: { minbox: true } })
    } catch (err) {
      for (const p of deliver) await api('POST', pendingPath(p.id, 'release'))
      note('submit-failed', errorText(err).slice(0, 150))
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
          note('loop-error', String(err).slice(0, 150))
        }
        if (!stopped && deps.now() - t0 < RETRY_MS) await deps.sleep(RETRY_MS)
      }
    } finally {
      loopRunning = false
    }
  }

  return {
    enabled: !!token && !!serverFile,
    tools,
    names,
    attach(c: any, appVersion: string): void {
      version = appVersion
      ctxs.push(c)
      void start()
    },
    detach(c: any): void {
      // An unloaded location: the loop goes on (it waits for a location while there is none); the
      // process ending ends it.
      const i = ctxs.indexOf(c)
      if (i >= 0) ctxs.splice(i, 1)
    },
    onEvent,
    onContext,
    onPrompt,
    onPermission,
    onToolBefore,
    stop(): void {
      stopped = true
    },
    state: () => ({ sessionID, busy, instructions, stopped, typedAt }),
  }
}

const CORE_KEY = Symbol.for('minbox.opencode.core')

/** The process's core (one per OpenCode server process, shared by every location's setup). */
export function sharedCore(deps: Deps): Core {
  const g = globalThis as any
  if (!g[CORE_KEY]) g[CORE_KEY] = createCore(deps)
  return g[CORE_KEY]
}

/**
 * The plugin's setup for one location: registers the tools and hooks with this location's ctx and
 * attaches it to the core. Returns the cleanup OpenCode calls on unload.
 */
export async function setupLocation(ctx: any, core: Core, log: (msg: string) => void = () => {}): Promise<(() => void) | undefined> {
  if (!core.enabled) return undefined // not started by minbox
  const version = String(ctx?.app?.version ?? '')
  if (majorVersion(version) !== 2) {
    log(`minbox: OpenCode ${version || '(unknown version)'} is not supported (the minbox plugin is written for OpenCode 2.x); minbox features are off.`)
    return undefined
  }
  const disposers: (() => unknown)[] = []
  const keep = (r: any) => {
    if (r && typeof r.dispose === 'function') disposers.push(() => r.dispose())
    else if (typeof r === 'function') disposers.push(r)
  }
  const tryHook = async (what: string, f: () => Promise<unknown>) => {
    try {
      keep(await f())
    } catch (err) {
      log(`minbox: could not register ${what}: ${errorText(err)}`)
    }
  }
  await tryHook('tools', () =>
    ctx.tool.transform((editor: any) => {
      for (const t of core.tools) {
        editor.add({
          name: t.name,
          description: t.description,
          input: t.input,
          // A direct tool: OpenCode would put it behind Code Mode's `execute` otherwise.
          options: { codemode: false },
          execute: (input: unknown, context: unknown) => t.execute(input, context),
        })
      }
    }),
  )
  await tryHook('the context hook', () => ctx.session.hook('context', (e: any) => core.onContext(e)))
  await tryHook('the prompt hook', () => ctx.session.hook('prompt', (e: any) => core.onPrompt(e)))
  await tryHook('the permission hook', () => ctx.permission.hook('evaluate', (e: any) => core.onPermission(e)))
  await tryHook('the tool hook', () => ctx.tool.hook('execute.before', () => core.onToolBefore()))
  const ac = new AbortController()
  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ types: [...EXECUTION_EVENTS, ...ALIVE_EVENTS], signal: ac.signal })) core.onEvent(ev)
    } catch (err) {
      if (!ac.signal.aborted) log(`minbox: the event subscription ended: ${errorText(err)}`)
    }
  })()
  core.attach(ctx, version)
  return () => {
    ac.abort()
    core.detach(ctx)
    for (const d of disposers.reverse()) {
      try {
        d()
      } catch {
        /* unloading anyway */
      }
    }
  }
}
