/**
 * The minbox mod: a thin proxy between Claude Code and the minbox server (mod protocol 1,
 * docs/mod-protocol.md). minbox starts Claude Code with `--plugin-dir <this plugin>` and the
 * environment MINBOX_TOKEN (this session's bearer token) and MINBOX_SERVER_FILE (a JSON file holding
 * the server's current URL).
 *
 * The mod holds no wording and makes no decisions about what the agent reads: the server does.
 * - Tools: the tool set (names, descriptions, schemas, deferred or not) comes from GET
 *   /api/agent/tools and is registered as given; every call goes to POST /api/agent/tool, whose text
 *   is the result (or the refusal). A heartbeat answer naming another tools_version re-registers the
 *   set (`$.tool.register` replaces a name registered again).
 * - Guards: the server's guards refuse host tool calls (a Bash command that would open a page on the
 *   host) with the server's text.
 * - Delivery: long-polls GET /api/agent/pending?proto=1. Once Claude has been idle for two ticks each
 *   message is claimed (so one mod instance delivers it), its text (the server's) is submitted as a
 *   plugin turn with `$.prompt.submit`, then acknowledged as delivered. A failed submit releases the
 *   claim; nothing is delivered twice.
 * - Events: turn.start / turn.complete (main loop), session.end, session.compact and each prompt go
 *   to POST /api/agent/event. The answer says what to add to the prompt (context) and what to submit once
 *   idle (a reminder), which the person typing first cancels.
 * - Heartbeat every HEARTBEAT_MS (its state, last poll / delivery, protocol, and a tail of its own
 *   event log) so the server can tell a live mod from a silent one; see docs/mod-connection.md.
 *
 * Anywhere else (no MINBOX_TOKEN, a -p run) every hook passes through.
 */
import type { Register } from 'claude-code'
import { argsOf, guardDeny, manifestOf, pendingOf, PROTOCOL, serverUrlOf, type Manifest, type PendingItem } from './proxy'

const TICK_MS = 1000
/** The mod's version, reported in every heartbeat (keep in step with .claude-plugin/plugin.json). */
export const MOD_VERSION = '0.2.0'
/** A heartbeat this often; the server calls the connection stale after 45 s without one. */
const HEARTBEAT_MS = 15_000
/** The mod's own event log keeps this many recent events; the last HEARTBEAT_EVENTS ride each heartbeat. */
const MAX_EVENTS = 60
const HEARTBEAT_EVENTS = 25
/** This many failed calls in a row make the connection "offline" (one toast, one event). */
const OFFLINE_AFTER_FAILURES = 3
const POLL_WAIT_S = 20
const IDLE_TICKS = 2
/** Every call gives up after this (the long poll waits POLL_WAIT_S on the server, plus a margin). */
const CALL_TIMEOUT_MS = 8000
/** A tool call may take longer (a message with attachments is snapshotted first). */
const TOOL_TIMEOUT_MS = 60_000
/** A prompt waits this long at most for the server's context. */
const PROMPT_TIMEOUT_MS = 3000
const POLL_TIMEOUT_MS = (POLL_WAIT_S + 10) * 1000
/** A poll running longer than this many ticks is abandoned (a backstop to the call timeouts). */
const POLL_STUCK_TICKS = 60
/**
 * Claude counts as idle after this many ticks busy without a hook event (turn start, tool call):
 * a missed turn.complete (Esc, an error) must not hold the person's messages for ever. A submit
 * into a turn that is running after all just waits there: the engine runs it once idle.
 */
const BUSY_STALE_TICKS = 120
/** The keys Claude Code adds to a tool call's input. */
const HOST_KEYS = ['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta']

type Conn = { token: string; serverFile: string; owner: string }

/** One line of the mod's own log: ids, counts and timings only, never a message body. */
type ModEvent = { at: string; kind: string; msg: string }

let conn: Conn | null = null
let baseUrl: string | null = null
let polling = false
/** Bumped when a stuck poll is abandoned: the abandoned run's late results are dropped. */
let pollGen = 0
let pollTicks = 0
/** Ticks spent busy since the last hook event. */
let busyTicks = 0
let lastClaudeSessionId: string | null = null
let helloing: Promise<void> | null = null
/** The server's tool set as registered, and the full names Claude Code gave them. */
let manifest: Manifest | null = null
let registering: Promise<void> | null = null
const toolNames = new Map<string, string>()
/** The mod's recent events (see ModEvent); a tail goes with each heartbeat. */
let events: ModEvent[] = []
let heartbeatTimer: { cancel(): void } | null = null
let heartbeatSeq = 0
let heartbeatInFlight = false
/** Consecutive failed API calls (status 0 or 5xx), and whether the connection is reported offline. */
let failStreak = 0
let offline = false
let authWarned = false
let lastPollAt: string | null = null
let lastDeliveryAt: string | null = null
/** Messages whose submit is running (never offered twice), and those submitted whose 'delivered' call failed (retried). */
const inflight = new Set<string>()
const undeliveredAcks = new Set<string>()
let timer: { cancel(): void } | null = null
let busy = false
let idleTicks = 0
/** The server's reminder to submit once Claude is idle (null: none). */
let held: string | null = null

/** Records an event in the mod's ring buffer. Identical consecutive events are folded into a count. */
function note($: any, kind: string, msg: string): void {
  const at = new Date().toISOString()
  const last = events[events.length - 1]
  if (last && last.kind === kind && last.msg.replace(/ \(x\d+\)$/, '') === msg) {
    const n = Number(/ \(x(\d+)\)$/.exec(last.msg)?.[1] ?? 1) + 1
    events[events.length - 1] = { at, kind, msg: `${msg} (x${n})` }
    return
  }
  events.push({ at, kind, msg })
  if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS)
}

/** Counts failures of the connection to the server; says so once when it goes offline and once when it is back. */
function trackConnection($: any, label: string, res: ApiResult): void {
  const failed = res.status === 0 || res.status >= 500
  if (!failed) {
    if (res.status === 401 || res.status === 403) {
      note($, 'auth', `${label}: HTTP ${res.status} (the session token is not accepted)`)
      if (!authWarned) {
        authWarned = true
        $.ui.toast('minbox: the server does not accept this agent (unknown token); replies will not arrive. Restart the agent from minbox.')
      }
    }
    if (failStreak > 0 || offline) {
      if (offline) {
        note($, 'online', `${label}: the server answers again after ${failStreak} failed call(s)`)
        $.ui.toast('minbox: connected to the server again.')
      }
      failStreak = 0
      offline = false
    }
    return
  }
  failStreak++
  note($, 'api-error', `${label}: ${res.status === 0 ? 'not reachable' : 'HTTP ' + res.status}`)
  if (!offline && failStreak >= OFFLINE_AFTER_FAILURES) {
    offline = true
    note($, 'offline', `${failStreak} calls in a row failed; last: ${label}`)
    $.ui.toast('minbox: cannot reach the server; replies are held until it is back.')
  }
}

function randomId(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

async function readBaseUrl($: any, force: boolean): Promise<string | null> {
  if (!conn) return null
  if (baseUrl && !force) return baseUrl
  const text = await $.fs.read(conn.serverFile).catch(() => null)
  baseUrl = serverUrlOf(typeof text === 'string' ? text : null)
  return baseUrl
}

type ApiResult = { ok: boolean; status: number; json: any }

/** Calls the minbox API; re-reads the server file once when the server moved. */
async function api($: any, method: string, path: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<ApiResult> {
  if (!conn) return { ok: false, status: 0, json: { error: 'minbox is not connected' } }
  // A server that restarted or a dropped connection can leave a fetch hanging for ever.
  const failed: ApiResult = { ok: false, status: 0, json: { error: 'the minbox server is not reachable' } }
  const res = await new Promise<ApiResult>((resolve) => {
    const t = $.clock.after(timeoutMs, () => {
      baseUrl = null // the server may have moved: read its file again next time
      resolve(failed)
    })
    apiOnce($, method, path, body).then(
      (r) => {
        t.cancel()
        resolve(r)
      },
      () => {
        t.cancel()
        resolve(failed)
      },
    )
  })
  // The label has no query string: owners and ids stay out of the log.
  trackConnection($, `${method} ${path.split('?')[0]!.replace(/\/pending\/[^/]+\//, '/pending/{id}/')}`, res)
  return res
}

async function apiOnce($: any, method: string, path: string, body?: unknown): Promise<ApiResult> {
  if (!conn) return { ok: false, status: 0, json: { error: 'minbox is not connected' } }
  for (const force of [false, true]) {
    const url = await readBaseUrl($, force)
    if (!url) continue
    try {
      const res = await $.http.fetch(url + path, {
        method,
        headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let json: any = null
      try {
        json = res.text ? JSON.parse(res.text) : null
      } catch {
        json = null
      }
      return { ok: res.ok, status: res.status, json }
    } catch {
      // connection refused: the server may have restarted on another address
      baseUrl = null
    }
  }
  return { ok: false, status: 0, json: { error: 'the minbox server is not reachable' } }
}

const failText = (res: ApiResult) => `minbox: ${res.json?.error ?? `HTTP ${res.status}`}`

/** Fetches the server's tool set and registers it (again, when it changed). */
function refreshTools($: any): Promise<void> {
  if (registering) return registering
  registering = (async () => {
    const res = await api($, 'GET', '/api/agent/tools')
    const m = res.ok ? manifestOf(res.json) : null
    if (!m) {
      note($, 'tools-failed', `the tool set could not be fetched (${res.status === 0 ? 'not reachable' : 'HTTP ' + res.status}); retried`)
      return
    }
    for (const t of m.tools) {
      try {
        const r = await $.tool.register({ name: t.name, description: t.description, inputSchema: t.input_schema, isDeferred: t.deferred === true })
        toolNames.set(r?.tool ?? `mcp__minbox__${t.name}`, t.name)
      } catch (err) {
        note($, 'tool-register-failed', `${t.name}: ${String(err).slice(0, 120)}`)
      }
    }
    if (manifest && manifest.version !== m.version) note($, 'tools-updated', `tool set ${manifest.version} -> ${m.version}`)
    manifest = m
  })().finally(() => {
    registering = null
  })
  return registering
}

async function hello($: any): Promise<void> {
  const id = await $.session.id().catch(() => null)
  if (typeof id === 'string' && id !== lastClaudeSessionId) {
    const res = await api($, 'POST', '/api/agent/hello', { claude_session_id: id, agent: 'claude', ext_version: MOD_VERSION, protocol: PROTOCOL })
    if (!res.ok) note($, 'hello-failed', `hello failed: ${res.status === 0 ? 'not reachable' : 'HTTP ' + res.status}; retried every tick`)
    if (res.ok) {
      note($, 'hello', lastClaudeSessionId ? 'hello again (the conversation changed)' : 'hello ok')
      lastClaudeSessionId = id
    }
  }
}

/** Forwards a hook's event; the server's answer says what to do. */
function event($: any, body: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<ApiResult> {
  return api($, 'POST', '/api/agent/event', body, timeoutMs).then((r) => {
    if (!r.ok) note($, 'event-failed', `${String(body.type)} not recorded: ${r.status === 0 ? 'not reachable' : 'HTTP ' + r.status}`)
    return r
  })
}

/** The heartbeat: who the mod is, what it thinks it is doing, and the tail of its own log. */
async function heartbeat($: any): Promise<void> {
  if (!conn || heartbeatInFlight) return
  heartbeatInFlight = true
  try {
    const res = await api($, 'POST', '/api/agent/heartbeat', {
      seq: ++heartbeatSeq,
      agent: 'claude',
      ext_version: MOD_VERSION,
      protocol: PROTOCOL,
      state: busy ? 'working' : 'idle',
      last_poll_at: lastPollAt ?? '',
      last_delivery_at: lastDeliveryAt ?? '',
      info: {
        busy_ticks: busyTicks,
        idle_ticks: idleTicks,
        polling: polling,
        poll_ticks: pollTicks,
        inflight: inflight.size,
        unacked: undeliveredAcks.size,
        offline,
        fail_streak: failStreak,
        owner_prefix: conn.owner.slice(0, 4),
        tools_version: manifest?.version ?? '',
      },
      events: events.slice(-HEARTBEAT_EVENTS),
    })
    if (res.status === 404 || res.status === 405) note($, 'heartbeat-unsupported', 'the server has no heartbeat endpoint (an older minbox)')
    const want = res.ok ? res.json?.tools_version : undefined
    if (typeof want === 'string' && want !== manifest?.version) void refreshTools($)
  } finally {
    heartbeatInFlight = false
  }
}

/** A pending message's route, with this instance as the owner. */
function pendingPath(id: string, action: 'claim' | 'release' | 'delivered'): string {
  return `/api/agent/pending/${encodeURIComponent(id)}/${action}?owner=${encodeURIComponent(conn?.owner ?? '')}`
}

/** Tells the server a submitted message is delivered; a failed call is retried on the next polls. */
async function acknowledge($: any, id: string): Promise<void> {
  const r = await api($, 'POST', pendingPath(id, 'delivered'))
  if (r.ok) undeliveredAcks.delete(id)
  else note($, 'ack-failed', `'delivered' for ${id} not recorded (${r.status === 0 ? 'not reachable' : 'HTTP ' + r.status}); retried`)
}

/** One tick: deliver the person's messages (and the server's reminder) once Claude has been idle a while. */
async function tick($: any): Promise<void> {
  if (!conn) return
  if (busy && ++busyTicks >= BUSY_STALE_TICKS) {
    // No hook event for a long while: a turn.complete was missed. Treat Claude as idle again.
    busy = false
    busyTicks = 0
    idleTicks = IDLE_TICKS
    note($, 'busy-stale', `no hook event for ${BUSY_STALE_TICKS} ticks while busy: treating Claude as idle`)
    void event($, { type: 'turn.complete', reason: 'stale' })
  }
  idleTicks = busy ? 0 : idleTicks + 1
  if (held !== null && !busy && idleTicks >= IDLE_TICKS) {
    const text = held
    held = null
    try {
      await $.prompt.submit({ text })
    } catch (err) {
      note($, 'nudge-failed', `reminder submit threw: ${String(err).slice(0, 150)}`)
    }
  }
  if (!manifest && !registering) void refreshTools($)
  if (polling) {
    if (++pollTicks < POLL_STUCK_TICKS) return
    pollGen++ // abandon the stuck poll; its late results are dropped
    note($, 'poll-stuck', `a poll step ran for ${POLL_STUCK_TICKS} ticks and was abandoned`)
    baseUrl = null
  }
  polling = true
  pollTicks = 0
  const gen = pollGen
  const stale = () => gen !== pollGen
  try {
    await hello($) // also follows /clear, which changes the conversation id
    if (stale()) return
    // Wait on the server only while idle; while busy, just look.
    const wait = busy ? 0 : POLL_WAIT_S
    const res = await api($, 'GET', `/api/agent/pending?owner=${encodeURIComponent(conn.owner)}&wait=${wait}&proto=${PROTOCOL}`, undefined, POLL_TIMEOUT_MS)
    if (stale()) return
    if (res.ok) lastPollAt = new Date().toISOString()
    const answer = res.ok ? pendingOf(res.json) : null
    if (res.ok && !answer) note($, 'poll-bad-reply', 'the pending poll returned something that is not a list of items')
    if (!answer || answer.items.length === 0) return
    const items = answer.items
    // A message whose submit went through but whose 'delivered' call failed is only acknowledged again, never submitted twice.
    const submittedBefore = new Set(items.filter((p) => undeliveredAcks.has(p.id)).map((p) => p.id))
    for (const id of submittedBefore) await acknowledge($, id)
    // Deliver only into a quiet session, so the person's own typing goes first;
    // an urgent message (Send now, or one that waited long) goes in anyway.
    const quiet = !busy && idleTicks >= IDLE_TICKS
    const due = items.filter((p) => (quiet || p.urgent) && !inflight.has(p.id) && !submittedBefore.has(p.id))
    if (due.length === 0) {
      note($, 'held', `${items.length} message(s) waiting; busy=${busy} idle_ticks=${idleTicks}`)
      return
    }
    const claimed: PendingItem[] = []
    for (const p of due) {
      const c = await api($, 'POST', pendingPath(p.id, 'claim'))
      if (c.ok && c.json?.claimed) claimed.push(p)
      else note($, 'claim-failed', `claim of ${p.id} not granted: ${c.ok ? 'claimed elsewhere' : c.status === 0 ? 'not reachable' : 'HTTP ' + c.status}`)
    }
    if (stale() || claimed.length === 0) return
    // Re-check as late as possible: the submit cannot be taken back.
    if (busy) {
      const wait = claimed.filter((p) => !p.urgent)
      for (const p of wait) await api($, 'POST', pendingPath(p.id, 'release'))
      claimed.splice(0, claimed.length, ...claimed.filter((p) => p.urgent))
      if (claimed.length === 0) return
    }
    for (const p of claimed) inflight.add(p.id)
    try {
      await $.prompt.submit({ text: claimed.map((p) => p.text).join(answer.joiner) })
      lastDeliveryAt = new Date().toISOString()
      note($, 'delivered', `submitted ${claimed.length} message(s): ${claimed.map((p) => p.id).join(',')}`)
    } catch (err) {
      for (const p of claimed) inflight.delete(p.id)
      note($, 'submit-failed', `prompt.submit threw: ${String(err).slice(0, 150)}`)
      for (const p of claimed) await api($, 'POST', pendingPath(p.id, 'release'))
      $.ui.toast(`minbox: a reply could not be delivered (${String(err)}); it stays in the inbox.`)
      return
    }
    for (const p of claimed) {
      inflight.delete(p.id)
      undeliveredAcks.add(p.id)
      await acknowledge($, p.id)
    }
  } finally {
    if (!stale()) polling = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const token = await $.env.get('MINBOX_TOKEN')
    const serverFile = await $.env.get('MINBOX_SERVER_FILE')
    if (!token || !serverFile || !e.isInteractive) return next(e)
    conn = { token, serverFile, owner: randomId() }
    note($, 'session-start', `mod ${MOD_VERSION} (protocol ${PROTOCOL}) started; owner ${conn.owner.slice(0, 4)}…`)
    await refreshTools($)

    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => tick($))
    heartbeatTimer?.cancel()
    heartbeatTimer = $.clock.every(HEARTBEAT_MS, () => heartbeat($))
    helloing = hello($)
    void helloing.then(() => heartbeat($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // session.end is a conversation lifecycle event, not the process's: /clear (and a resume) fire it
    // with no session.start after, and the process carries on under a new Claude session id. The tick
    // and heartbeat timers therefore keep running (they die with the process); the tick's hello
    // follows the new id. The server starts the conversation's state over.
    note($, 'session-end', `session.end (${(e as any).reason ?? '?'}): the mod keeps polling; the next hello follows the new conversation id`)
    if (conn) {
      busy = false
      busyTicks = 0
      idleTicks = 0
      held = null
      void event($, { type: 'session.end' })
      void heartbeat($)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (conn && !e.agentId) {
      busy = true
      busyTicks = 0
      idleTicks = 0
      void event($, { type: 'turn.start' })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (conn && !e.agentId) {
      busy = false
      busyTicks = 0
      idleTicks = 0
      void event($, { type: 'turn.complete', reason: e.reason, aborted: e.isAborted === true, answer: e.answer ?? '' }).then((r) => {
        const text = r.ok ? r.json?.submit_when_idle : undefined
        if (typeof text === 'string' && text) held = text
      })
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const res = await next(e)
    if (conn && !e.agentId) void event($, { type: 'session.compact' })
    return res
  })

  on('prompt.submit', async ($, e, next) => {
    if (!conn) return next(e)
    const typed = e.origin?.kind === 'composer'
    if (typed) {
      idleTicks = 0 // the person typed: their turn goes first
      held = null // and they answered in the chat
    }
    if (helloing) await helloing.catch(() => {}) // the conversation is known first
    const r = await event($, { type: 'prompt', origin: typed ? 'composer' : (e.origin?.kind ?? '') }, PROMPT_TIMEOUT_MS)
    const added: string[] = r.ok && Array.isArray(r.json?.context) ? r.json.context.filter((c: unknown) => typeof c === 'string' && c) : []
    if (added.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...added] })
  })

  // Every tool call: the server's tools are answered by the server; the host's own pass its guards.
  // Any call also shows the turn is alive (BUSY_STALE_TICKS).
  on('tool.call', async ($, e: any, next) => {
    busyTicks = 0
    if (!conn) return next(e)
    const name = toolNames.get(e.tool)
    if (name !== undefined) {
      const res = await api($, 'POST', '/api/agent/tool', { tool: name, args: argsOf(e, HOST_KEYS) }, TOOL_TIMEOUT_MS)
      if (!res.ok) return { deny: failText(res) }
      if (res.json?.ok !== true) return { deny: String(res.json?.error ?? failText(res)) }
      return { result: String(res.json.text ?? '') }
    }
    const command = typeof e.command === 'string' ? e.command : ''
    const refused = guardDeny(manifest?.guards, e.tool, command)
    if (refused !== null) return { deny: refused }
    return next(e)
  })
}
