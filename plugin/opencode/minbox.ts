/**
 * The minbox plugin for OpenCode 2.x ("V2" server plugins): a thin proxy between OpenCode and the
 * minbox server (mod protocol 1, docs/mod-protocol.md). minbox starts OpenCode as
 * `opencode --standalone --auto --session <id>` with this folder in OPENCODE_CONFIG_CONTENT
 * ({"plugins":[{"package":"<this folder>"}]}) and the environment MINBOX_TOKEN (the session's bearer
 * token), MINBOX_SERVER_FILE (a JSON file holding the server's URL), MINBOX_OPENCODE_SESSION (the
 * OpenCode session minbox created for this minbox session) and MINBOX_OPENCODE_DIR (its folder). The
 * OpenCode counterpart of the Pi extension (plugin/pi/minbox.ts); it shares
 * ../minbox/hooks/proxy.ts with the other integrations.
 *
 * The plugin holds no wording and makes no decisions about what the agent reads: the server does.
 * - Tools: the tool set comes from GET /api/agent/tools and is added as direct tools (codemode: false;
 *   OpenCode puts plugin tools behind its Code Mode `execute` tool otherwise) by a tool.transform
 *   callback that reads the current set; every call goes to POST /api/agent/tool, whose text is the
 *   result (a failure throws). A heartbeat answer naming another tools_version fetches the set again
 *   and calls ctx.tool.reload(), which runs the transform callbacks again.
 * - Adds the server's instructions (from the hello answer) to the system prompt of every model request
 *   of the session (session hook "context"), so they survive compaction.
 * - Reports turns from session.execution.* events (POST /api/agent/event turn.start / turn.complete).
 * - Long-polls GET /api/agent/pending?proto=1 and, once the session has been idle for a moment, claims
 *   the messages, starts a turn with the server's text (ctx.session.prompt) and marks them delivered.
 *   An urgent one (Send now) goes into a running turn too (delivery "steer").
 * - The server's guards deny host tool calls through the permission hook (a shell command that opens a
 *   page on the host; OpenCode's `question` tool in the main session).
 * - Shell outcomes (session.tool.failed / success) go to the server, which offers a rejected command
 *   as "Run yourself" and withdraws it when it later runs.
 * - Creates the session if it is missing and moves it to MINBOX_OPENCODE_DIR when the project's folder
 *   changed (OpenCode sessions can move between folders).
 * - Follows a new top-level session the person starts in the TUI (/new): the hello reports its id.
 *
 * OpenCode loads a plugin once per location (folder) a server touches, so setup can run more than once in
 * one process: tools and hooks are registered per location, the delivery loop and the state are one per
 * process (globalThis). Without MINBOX_TOKEN (OpenCode started by hand) the plugin does nothing.
 *
 * Everything is written against small Deps / Ctx shapes so it can be tested without OpenCode
 * (minbox.test.ts, `node --test`).
 */
import { readFileSync, realpathSync } from 'node:fs'
import { guardDeny, manifestOf, pendingOf, PROTOCOL, serverUrlOf, type Manifest, type PendingItem } from '../minbox/hooks/proxy.ts'

export const EXT_VERSION = '0.2.0'

const POLL_WAIT_S = 20
const CALL_TIMEOUT_MS = 8000
const TOOL_TIMEOUT_MS = 60_000
const POLL_TIMEOUT_MS = (POLL_WAIT_S + 10) * 1000
/** The session counts as quiet (no turn runs, the person did not just submit) after this long idle. */
const QUIET_MS = 2000
/** Busy for this long with no execution or tool event: assume a missed end event. */
const BUSY_STALE_MS = 120_000
const RETRY_MS = 1000
const HEARTBEAT_MS = 15_000

const EXECUTION_EVENTS = ['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']
const ALIVE_EVENTS = ['session.step.started', 'session.step.ended', 'session.tool.input.started', 'session.tool.called', 'session.tool.progress', 'session.tool.success', 'session.tool.failed']
/** The tool events read for shell outcomes. */
const TOOL_EVENTS = ['session.tool.input.started', 'session.tool.called', 'session.tool.success', 'session.tool.failed']

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

/** One process's minbox state: the session, the tool set, the delivery loop, the heartbeat. Shared by every location's setup. */
export type Core = ReturnType<typeof createCore>

/** A tool as OpenCode's tool editor takes it. */
export type OcTool = { name: string; description: string; input: object; execute: (input: any, context: any) => Promise<{ content: string }> }

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
  let manifest: Manifest | null = null
  let registering: Promise<void> | null = null
  const ctxs: any[] = []

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
  const event = (body: Record<string, unknown>) => api('POST', '/api/agent/event', body)

  /** Every 15 s (checked once per loop round): the server tells a live plugin from a silent one. See docs/mod-connection.md. */
  async function heartbeat(): Promise<void> {
    if (deps.now() - lastBeat < HEARTBEAT_MS) return
    lastBeat = deps.now()
    const res = await api('POST', '/api/agent/heartbeat', {
      seq: ++heartbeatSeq,
      agent: 'opencode',
      ext_version: EXT_VERSION,
      protocol: PROTOCOL,
      state: busy ? 'working' : 'idle',
      last_poll_at: lastPollAt,
      last_delivery_at: lastDeliveryAt,
      info: { fail_streak: failStreak, opencode_version: version, locations: ctxs.length, owner_prefix: owner.slice(0, 4), tools_version: manifest?.version ?? '' },
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
      if (busy) void event({ type: 'turn.complete' })
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
      protocol: PROTOCOL,
      reason,
    })
    if (res.ok && typeof res.json?.instructions === 'string') instructions = res.json.instructions
    note('hello', `${reason} session=${sessionID}`)
  }

  // ---- tools (the server's) ----

  /** Fetches the server's tool set; a changed one makes every location run its transform again. */
  function refreshTools(): Promise<void> {
    if (registering) return registering
    registering = (async () => {
      const res = await api('GET', '/api/agent/tools')
      const m = res.ok ? manifestOf(res.json) : null
      if (!m) {
        note('tools-failed', `the tool set could not be fetched (${res.status === 0 ? 'not reachable' : 'HTTP ' + res.status})`)
        return
      }
      const changed = manifest?.version !== m.version
      if (manifest && changed) note('tools-updated', `tool set ${manifest.version} -> ${m.version}`)
      manifest = m
      if (!changed) return
      for (const c of ctxs) {
        try {
          await c.tool?.reload?.()
        } catch (err) {
          note('tools-reload-failed', errorText(err).slice(0, 120))
        }
      }
    })().finally(() => {
      registering = null
    })
    return registering
  }

  /** The tools to add now (the transform callback's view of the server's set). */
  function tools(): OcTool[] {
    return (manifest?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input: t.input_schema,
      execute: async (input: any) => {
        const res = await api('POST', '/api/agent/tool', { tool: t.name, args: input ?? {} }, TOOL_TIMEOUT_MS)
        if (!res.ok) throw new Error(`minbox: ${res.json?.error ?? `HTTP ${res.status}`}`)
        if (res.json?.ok !== true) throw new Error(String(res.json?.error ?? 'minbox: the tool failed'))
        // The server's effects for the host: OpenCode's own session list shows the same title.
        const title = res.json.effects?.session_title
        if (typeof title === 'string' && title) {
          try {
            await ctx()?.session.update({ sessionID, title })
          } catch (err) {
            note('title-update-failed', errorText(err).slice(0, 120))
          }
        }
        return { content: String(res.json.text ?? '') }
      },
    }))
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
    void event({ type: 'turn.complete' }) // the session is idle
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
    if (TOOL_EVENTS.includes(type)) onToolEvent(type, ev.data)
  }

  // ---- shell outcomes ----
  // A shell call refused by a permission rule or a plugin's permission hook ends as
  // session.tool.failed with error.type "permission.rejected". Its tool name comes with
  // session.tool.input.started, its command with session.tool.called. Only the main session is
  // followed (not subagent sessions). The server decides what counts as a refusal.

  /** Tool calls of the session: name and shell command, by call id. */
  const toolCalls = new Map<string, { name?: string; command?: string }>()

  function onToolEvent(type: string, d: any): void {
    const id = typeof d?.id === 'string' ? d.id : ''
    if (!id) return
    const call = toolCalls.get(id) ?? {}
    if (type === 'session.tool.input.started') {
      if (typeof d.name === 'string') call.name = d.name
      toolCalls.set(id, call)
      return
    }
    if (type === 'session.tool.called') {
      if (typeof d.input?.command === 'string' && d.input.command.trim()) call.command = d.input.command
      toolCalls.set(id, call)
      return
    }
    toolCalls.delete(id)
    if (toolCalls.size > 500) toolCalls.clear() // calls whose end never came
    const shell = call.name === undefined || call.name === 'bash' || call.name === 'shell'
    if (!shell || !call.command) return
    if (type === 'session.tool.failed') {
      void event({ type: 'bash', phase: 'failed', id, command: call.command, error_type: d.error?.type, message: typeof d.error?.message === 'string' ? d.error.message : undefined })
    } else if (type === 'session.tool.success') {
      void event({ type: 'bash', phase: 'success', id, command: call.command })
    }
  }

  /** session hook "context": the server's instructions in the system prompt of every request of the session. */
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

  /** permission hook "evaluate": the server's guards. */
  function onPermission(event: any): void {
    const action = String(event?.action ?? '')
    const resources: string[] = Array.isArray(event?.resources) ? event.resources.filter((r: unknown) => typeof r === 'string') : []
    const deny = guardDeny(manifest?.guards, action, resources, event?.sessionID === sessionID)
    if (deny === null) return
    event.effect = 'deny'
    event.message = deny
    note('denied-guard', `a ${action} call refused by the server's guard`)
  }

  function onToolBefore(): void {
    if (busy) busyAt = deps.now()
  }

  // ---- delivery of the person's messages ----

  async function deliverOnce(): Promise<boolean> {
    if (!ctx()) return false // no location loaded right now: nothing to deliver with
    if (busy && deps.now() - busyAt > BUSY_STALE_MS) {
      note('busy-stale', 'no execution event for 120 s: treated as idle')
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
    // Deliver only into a quiet session, so the person's own prompt goes first; an urgent message
    // (Send now, or one that waited long) goes in anyway, steered into the running turn.
    const now = deps.now()
    const quiet = !busy && now - idleSince >= QUIET_MS && now - typedAt >= QUIET_MS
    const due = answer.items.filter((p) => quiet || p.urgent)
    if (due.length === 0) return false
    const claimed: PendingItem[] = []
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
      await c.session.prompt({ sessionID, text: deliver.map((p) => p.text).join(answer.joiner), delivery: 'steer', metadata: { minbox: true } })
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
    refreshTools,
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
    state: () => ({ sessionID, busy, instructions, stopped, typedAt, toolsVersion: manifest?.version ?? '' }),
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
  // The tool set is the server's: fetched before the first transform, and the callback reads the
  // current set each time OpenCode runs it (again after ctx.tool.reload(), see refreshTools).
  await core.refreshTools()
  await tryHook('tools', () =>
    ctx.tool.transform((editor: any) => {
      for (const t of core.tools()) {
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
