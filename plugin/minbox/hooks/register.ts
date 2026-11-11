/**
 * The minbox mod. minbox starts Claude Code with `--plugin-dir <this plugin>`
 * and the environment MINBOX_TOKEN (this session's bearer token) and
 * MINBOX_SERVER_FILE (a JSON file holding the server's current URL).
 *
 * - Registers `send_message`, `read_thread`, `set_session_title`, `open_url`, `card` and the
 *   read-only navigation tools of nav.ts (list_projects, get_project, list_sessions, list_threads,
 *   search), served over minbox's HTTP API, and system prompt sections asking Claude to
 *   keep the session's title (shown in the session list) current and to open
 *   pages with `open_url`: in the person's browser, not on the host. Bash
 *   commands that would open a page on the host are refused.
 * - Long-polls the server for the person's messages. Once Claude has been idle
 *   for two ticks, each is claimed (so one mod instance delivers it), submitted
 *   as a plugin turn with `$.prompt.submit`, then acknowledged as delivered.
 *   A failed submit releases the claim; nothing is delivered twice.
 * - Reports whether Claude is working or idle (main-loop turn.start / turn.complete).
 * - Sends a heartbeat every HEARTBEAT_MS (its state, last poll / delivery, and a tail of its own
 *   event log) so the server can tell a live mod from a silent one; see docs/mod-connection.md.
 * - Adds a one-paragraph reminder of the inbox to the first prompt, and the
 *   session's open threads to the first prompt after a compaction.
 *
 * Anywhere else (no MINBOX_TOKEN, a -p run) every hook passes through.
 */
import type { Register } from 'claude-code'
import { NAV_DESCRIPTION, NAV_SCHEMA, NAV_TOOLS, navPath, navText } from './nav'
import {
  CARD_DESCRIPTION,
  CARD_SCHEMA,
  CARD_TOOL,
  cardText,
  READ_DESCRIPTION,
  READ_SCHEMA,
  READ_TOOL,
  readPath,
  SEND_DESCRIPTION,
  SEND_SCHEMA,
  SEND_TOOL,
  openDeny,
  opensBrowser,
  OPEN_DESCRIPTION,
  OPEN_SCHEMA,
  OPEN_TOOL,
  fallbackReminderText,
  instructionsText,
  openThreadsText,
  asksPerson,
  nudgeText,
  replyNudgeText,
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
} from './text'

const TICK_MS = 1000
/** The mod's version, reported in every heartbeat (keep in step with .claude-plugin/plugin.json). */
export const MOD_VERSION = '0.1.0'
/** A heartbeat this often; the server calls the connection stale after 45 s without one. */
const HEARTBEAT_MS = 15_000
/** The mod's own event log keeps this many recent events; the last HEARTBEAT_EVENTS ride each heartbeat. */
const MAX_EVENTS = 60
const HEARTBEAT_EVENTS = 25
/** This many failed calls in a row make the connection "offline" (one toast, one event). */
const OFFLINE_AFTER_FAILURES = 3
/** The server's instructions are repeated on every Nth prompt (models forget the first instruction); the default N is 20. The first prompt after each hello and the first after a compaction carry them too. MINBOX_ORCHESTRATOR_EVERY overrides N. */
const ORCHESTRATOR_EVERY = 20
const POLL_WAIT_S = 20
const IDLE_TICKS = 2
/** Every call gives up after this (the long poll waits POLL_WAIT_S on the server, plus a margin). */
const CALL_TIMEOUT_MS = 8000
const POLL_TIMEOUT_MS = (POLL_WAIT_S + 10) * 1000
/** A poll running longer than this many ticks is abandoned (a backstop to the call timeouts). */
const POLL_STUCK_TICKS = 60
/**
 * Claude counts as idle after this many ticks busy without a hook event (turn start, tool call):
 * a missed turn.complete (Esc, an error) must not hold the person's messages for ever. A submit
 * into a turn that is running after all just waits there: the engine runs it once idle.
 */
const BUSY_STALE_TICKS = 120

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
let sendToolName = `mcp__minbox__${SEND_TOOL}`
let readToolName = `mcp__minbox__${READ_TOOL}`
let titleToolName = `mcp__minbox__${TITLE_TOOL}`
let openToolName = `mcp__minbox__${OPEN_TOOL}`
/** The server's instructions from the hello (null: none, e.g. the hello failed or the server is old). */
let instructions: string | null = null
/** Prompts seen in this session. */
let promptCount = 0
/** The hello delivered the instructions and no prompt has carried them since: the next one does. */
let orchestratorFresh = false
let helloing: Promise<void> | null = null
/** The mod's recent events (see ModEvent); a tail goes with each heartbeat. */
let events: ModEvent[] = []
let heartbeatTimer: { cancel(): void } | null = null
let heartbeatSeq = 0
let heartbeatInFlight = false
/** Consecutive failed API calls (status 0 or 5xx), and whether the connection is reported offline. */
let failStreak = 0
let offline = false
let lastPollAt: string | null = null
let lastDeliveryAt: string | null = null
/** Messages whose submit is running (never offered twice), and those submitted whose 'delivered' call failed (retried). */
const inflight = new Set<string>()
const undeliveredAcks = new Set<string>()
let timer: { cancel(): void } | null = null
let busy = false
let idleTicks = 0
let remindNext = true
let threadsNext = false
/** send_message ran in the current main-loop turn. */
let sentThisTurn = false
/** The last turn asked the person in the chat only: remind Claude once idle. */
let nudgeNext = false
/** The running turn is that reminder (its own end never reminds again). */
let nudging = false
/** Threads whose messages were just delivered; they belong to the turn that starts next. */
let deliveredThreads: string[] = []
/** Threads the running turn is answering. */
let turnThreads: string[] = []
/** The next reminder is about these threads (a turn answered them without send_message). */
let replyNudgeThreads: string[] = []

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
        $.ui.toast('minbox: the server does not accept this session (unknown token); replies will not arrive. Restart the session from minbox.')
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
let authWarned = false

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

async function hello($: any): Promise<void> {
  const id = await $.session.id().catch(() => null)
  if (typeof id === 'string' && id !== lastClaudeSessionId) {
    const res = await api($, 'POST', '/api/agent/hello', { claude_session_id: id })
    if (!res.ok) note($, 'hello-failed', `hello failed: ${res.status === 0 ? 'not reachable' : 'HTTP ' + res.status}; retried every tick`)
    if (res.ok) {
      note($, 'hello', lastClaudeSessionId ? 'hello again (the conversation changed)' : 'hello ok')
      lastClaudeSessionId = id
      instructions = typeof res.json?.instructions === 'string' && res.json.instructions.trim() ? res.json.instructions : null
      orchestratorFresh = true
    }
  }
}

function status($: any, value: 'working' | 'idle'): void {
  void api($, 'POST', '/api/agent/status', { status: value }).then((r) => {
    if (!r.ok) note($, 'status-failed', `status ${value} not recorded: ${r.status === 0 ? 'not reachable' : 'HTTP ' + r.status}`)
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
      },
      events: events.slice(-HEARTBEAT_EVENTS),
    })
    if (res.status === 404 || res.status === 405) note($, 'heartbeat-unsupported', 'the server has no heartbeat endpoint (an older minbox)')
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

/** One tick: deliver the person's messages once Claude has been idle a while. */
async function tick($: any): Promise<void> {
  if (!conn) return
  if (busy && ++busyTicks >= BUSY_STALE_TICKS) {
    // No hook event for a long while: a turn.complete was missed. Treat Claude as idle again.
    busy = false
    busyTicks = 0
    idleTicks = IDLE_TICKS
    note($, 'busy-stale', `no hook event for ${BUSY_STALE_TICKS} ticks while busy: treating Claude as idle`)
    status($, 'idle')
  }
  idleTicks = busy ? 0 : idleTicks + 1
  if (nudgeNext && !busy && idleTicks >= IDLE_TICKS) {
    nudgeNext = false
    nudging = true
    const threads = replyNudgeThreads
    replyNudgeThreads = []
    try {
      await $.prompt.submit({ text: threads.length > 0 ? replyNudgeText(sendToolName, threads) : nudgeText(sendToolName) })
    } catch (err) {
      nudging = false
      note($, 'nudge-failed', `reminder submit threw: ${String(err).slice(0, 150)}`)
    }
  }
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
    const res = await api($, 'GET', `/api/agent/pending?owner=${encodeURIComponent(conn.owner)}&wait=${wait}`, undefined, POLL_TIMEOUT_MS)
    if (stale()) return
    if (res.ok) lastPollAt = new Date().toISOString()
    if (res.ok && !Array.isArray(res.json)) note($, 'poll-bad-reply', 'the pending poll returned something that is not a list')
    if (!res.ok || !Array.isArray(res.json) || res.json.length === 0) return
    // A message whose submit went through but whose 'delivered' call failed is only acknowledged again, never submitted twice.
    const submittedBefore = new Set((res.json as Pending[]).filter((p) => undeliveredAcks.has(p.id)).map((p) => p.id))
    for (const id of submittedBefore) await acknowledge($, id)
    // Deliver only into a quiet session, so the person's own typing goes first;
    // an urgent message (Send now, or one that waited long) goes in anyway.
    const quiet = !busy && idleTicks >= IDLE_TICKS
    const due = (res.json as Pending[]).filter((p) => (quiet || p.urgent) && !inflight.has(p.id) && !submittedBefore.has(p.id))
    if (due.length === 0) {
      if ((res.json as Pending[]).length > 0) note($, 'held', `${(res.json as Pending[]).length} message(s) waiting; busy=${busy} idle_ticks=${idleTicks}`)
      return
    }
    const claimed: Pending[] = []
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
      await $.prompt.submit({ text: wakeText(claimed, sendToolName, readToolName) })
      deliveredThreads = [...new Set(claimed.map((p) => p.thread_id))]
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
    note($, 'session-start', `mod ${MOD_VERSION} started; owner ${conn.owner.slice(0, 4)}…`)

    const send = await $.tool.register({ name: SEND_TOOL, description: SEND_DESCRIPTION, inputSchema: SEND_SCHEMA, isDeferred: false })
    sendToolName = send?.tool ?? sendToolName
    const read = await $.tool.register({ name: READ_TOOL, description: READ_DESCRIPTION, inputSchema: READ_SCHEMA, isDeferred: false })
    readToolName = read?.tool ?? readToolName
    const title = await $.tool.register({ name: TITLE_TOOL, description: TITLE_DESCRIPTION, inputSchema: TITLE_SCHEMA, isDeferred: false })
    titleToolName = title?.tool ?? titleToolName
    const open = await $.tool.register({ name: OPEN_TOOL, description: OPEN_DESCRIPTION, inputSchema: OPEN_SCHEMA, isDeferred: false })
    openToolName = open?.tool ?? openToolName
    await $.tool.register({ name: CARD_TOOL, description: CARD_DESCRIPTION, inputSchema: CARD_SCHEMA, isDeferred: true })
    // Read-only navigation (projects, sessions, threads, search): deferred, found with ToolSearch.
    for (const name of NAV_TOOLS) {
      await $.tool.register({ name, description: NAV_DESCRIPTION[name], inputSchema: NAV_SCHEMA[name] as any, isDeferred: true })
    }

    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => tick($))
    heartbeatTimer?.cancel()
    heartbeatTimer = $.clock.every(HEARTBEAT_MS, () => heartbeat($))
    helloing = hello($)
    void helloing.then(() => heartbeat($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    note($, 'session-end', 'session.end: the mod stops polling')
    // One last heartbeat says so (best effort); then the ticks stop.
    void heartbeat($)
    timer?.cancel()
    timer = null
    heartbeatTimer?.cancel()
    heartbeatTimer = null
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (conn && !e.agentId) {
      busy = true
      busyTicks = 0
      idleTicks = 0
      sentThisTurn = false
      turnThreads = deliveredThreads
      deliveredThreads = []
      status($, 'working')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (conn && !e.agentId) {
      busy = false
      busyTicks = 0
      idleTicks = 0
      // Asked the person in the chat but not in the inbox: remind Claude once.
      const answered = e.reason === 'answer' && !e.isAborted
      // A turn that handled an inbox message but sent nothing back: remind Claude once to reply there.
      const missingReply = answered && !nudging && !sentThisTurn && turnThreads.length > 0
      replyNudgeThreads = missingReply ? turnThreads : []
      nudgeNext = missingReply || (answered && !nudging && !sentThisTurn && asksPerson(e.answer ?? ''))
      turnThreads = []
      nudging = false
      status($, 'idle')
    }
    return next(e)
  })

  // Any tool call shows the turn is alive (see BUSY_STALE_TICKS).
  on('tool.call', async ($, e: any, next) => {
    busyTicks = 0
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const res = await next(e)
    if (conn && !e.agentId) threadsNext = true
    return res
  })

  on('prompt.submit', async ($, e, next) => {
    if (!conn) return next(e)
    if (e.origin?.kind === 'composer') {
      idleTicks = 0 // the person typed: their turn goes first
      nudgeNext = false // and they answered in the chat
    }
    promptCount++
    if (helloing) await helloing.catch(() => {}) // the instructions come with the hello
    const every = Number(await $.env.get('MINBOX_ORCHESTRATOR_EVERY')) || ORCHESTRATOR_EVERY
    // One injection per prompt: first after a hello, after a compaction, or every Nth prompt.
    const remind = remindNext || threadsNext || orchestratorFresh || promptCount % every === 0
    if (!remind) return next(e)
    const added: string[] = [instructions ? instructionsText(instructions) : fallbackReminderText(sendToolName)]
    if (threadsNext) {
      const res = await api($, 'GET', '/api/agent/threads')
      const list = res.ok && Array.isArray(res.json) ? openThreadsText(res.json as Thread[]) : null
      if (list) added.push(list)
    }
    remindNext = false
    threadsNext = false
    orchestratorFresh = false
    return next({ ...e, context: [...(e.context ?? []), ...added] })
  })

  on('tool.call', { tool: `mcp__minbox__${SEND_TOOL}` }, async ($, e: any) => {
    if (!conn) return { deny: 'minbox is not connected in this session.' }
    const body = typeof e.body === 'string' ? e.body : ''
    if (!body.trim()) return { deny: 'body is required.' }
    if (e.status !== 'working' && e.status !== 'need_action' && e.status !== 'blocked' && e.status !== 'finished') {
      return { deny: 'status is required: working (you carry on), need_action (you need the person), blocked (you wait on something outside them) or finished (the task is done). Send the message again with it.' }
    }
    const title = typeof e.thread_title === 'string' && e.thread_title.trim() ? e.thread_title : typeof e.subject === 'string' ? e.subject : ''
    if (!title.trim()) {
      return { deny: 'thread_title is required: name what the thread is about now, in about 30 characters or fewer. Send the message again with it.' }
    }
    const res = await api($, 'POST', '/api/agent/messages', {
      body,
      thread_title: title,
      thread_id: typeof e.thread_id === 'string' && e.thread_id ? e.thread_id : undefined,
      name: typeof e.name === 'string' && e.name ? e.name : undefined,
      status: typeof e.status === 'string' && e.status ? e.status : undefined,
      attachments: Array.isArray(e.attachments) ? e.attachments.filter((a: unknown) => typeof a === 'string') : undefined,
      review: e.review && typeof e.review === 'object' ? e.review : undefined,
    })
    if (!res.ok) return { deny: `minbox: ${res.json?.error ?? `HTTP ${res.status}`}` }
    sentThisTurn = true
    return { result: sentText(res.json) }
  })

  on('tool.call', { tool: `mcp__minbox__${OPEN_TOOL}` }, async ($, e: any) => {
    if (!conn) return { deny: 'minbox is not connected in this session.' }
    const url = typeof e.url === 'string' ? e.url.trim() : ''
    if (!url) return { deny: 'url is required.' }
    const res = await api($, 'POST', '/api/agent/open', { url })
    if (!res.ok) return { deny: `minbox: ${res.json?.error ?? `HTTP ${res.status}`}` }
    return { result: `Opened ${res.json?.url ?? url} in the person's browser.` }
  })

  // Pages opened from Bash would open on the host, not where the person is.
  on('tool.call', { tool: 'Bash' }, async ($, e: any, next) => {
    if (conn && typeof e.command === 'string' && opensBrowser(e.command)) return { deny: openDeny(openToolName) }
    return next(e)
  })

  on('tool.call', { tool: `mcp__minbox__${TITLE_TOOL}` }, async ($, e: any) => {
    if (!conn) return { deny: 'minbox is not connected in this session.' }
    const t = typeof e.title === 'string' ? e.title.trim() : ''
    if (!t) return { deny: 'title is required.' }
    const res = await api($, 'POST', '/api/agent/title', { title: t })
    if (!res.ok) return { deny: `minbox: ${res.json?.error ?? `HTTP ${res.status}`}` }
    return { result: `Session title set: ${res.json?.title ?? t}` }
  })

  on('tool.call', { tool: `mcp__minbox__${READ_TOOL}` }, async ($, e: any) => {
    if (!conn) return { deny: 'minbox is not connected in this session.' }
    const id = typeof e.thread_id === 'string' && e.thread_id ? e.thread_id : null
    const res = await api($, 'GET', readPath(e))
    if (!res.ok) return { deny: `minbox: ${res.json?.error ?? `HTTP ${res.status}`}` }
    return { result: id ? threadText(res.json as Thread, readToolName) : threadListText(res.json as Thread[]) }
  })

  for (const name of NAV_TOOLS) {
    on('tool.call', { tool: `mcp__minbox__${name}` }, async ($, e: any) => {
      if (!conn) return { deny: 'minbox is not connected in this session.' }
      const req = navPath(name, e)
      if ('error' in req) return { deny: req.error }
      const res = await api($, 'GET', req.path)
      if (!res.ok) return { deny: `minbox: ${res.json?.error ?? `HTTP ${res.status}`}` }
      return { result: navText(name, res.json) }
    })
  }

  on('tool.call', { tool: `mcp__minbox__${CARD_TOOL}` }, async ($, e: any) => {
    if (!conn) return { deny: 'minbox is not connected in this session.' }
    const action = e.action
    const fields: Record<string, unknown> = {}
    for (const k of ['title', 'column', 'note', 'thread_id', 'pr_url', 'pr_state', 'pr_number']) {
      if (e[k] !== undefined) fields[k] = e[k]
    }
    let res
    if (action === 'list') res = await api($, 'GET', '/api/agent/cards')
    else if (action === 'create') res = await api($, 'POST', '/api/agent/cards', fields)
    else if (action === 'update') {
      if (typeof e.id !== 'string' || !e.id) return { deny: 'update needs the card id.' }
      res = await api($, 'PATCH', `/api/agent/cards/${encodeURIComponent(e.id)}`, fields)
    } else return { deny: 'action must be list, create or update.' }
    if (!res.ok) return { deny: `minbox: ${res.json?.error ?? `HTTP ${res.status}`}` }
    return { result: cardText(action, res.json) }
  })
}
