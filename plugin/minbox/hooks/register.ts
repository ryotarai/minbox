/**
 * The minbox mod. minbox starts Claude Code with `--plugin-dir <this plugin>`
 * and the environment MINBOX_TOKEN (this session's bearer token) and
 * MINBOX_SERVER_FILE (a JSON file holding the server's current URL).
 *
 * - Registers `send_message`, `read_thread`, `set_session_title` and `open_url`,
 *   served over minbox's HTTP API, and system prompt sections asking Claude to
 *   keep the session's title (shown in the session list) current and to open
 *   pages with `open_url`: in the person's browser, not on the host. Bash
 *   commands that would open a page on the host are refused.
 * - Long-polls the server for the person's messages. Once Claude has been idle
 *   for two ticks, each is claimed (so one mod instance delivers it), submitted
 *   as a plugin turn with `$.prompt.submit`, then acknowledged as delivered.
 *   A failed submit releases the claim; nothing is delivered twice.
 * - Reports whether Claude is working or idle (main-loop turn.start / turn.complete).
 * - Adds a one-paragraph reminder of the inbox to the first prompt, and the
 *   session's open threads to the first prompt after a compaction.
 *
 * Anywhere else (no MINBOX_TOKEN, a -p run) every hook passes through.
 */
import type { Register } from 'claude-code'
import {
  CARD_DESCRIPTION,
  CARD_SCHEMA,
  CARD_TOOL,
  cardText,
  READ_DESCRIPTION,
  READ_SCHEMA,
  READ_TOOL,
  SEND_DESCRIPTION,
  SEND_SCHEMA,
  SEND_TOOL,
  openDeny,
  openSection,
  opensBrowser,
  OPEN_DESCRIPTION,
  OPEN_SCHEMA,
  OPEN_TOOL,
  openThreadsText,
  asksPerson,
  inboxSection,
  nudgeText,
  reminderText,
  sentText,
  serverUrlOf,
  threadListText,
  threadText,
  TITLE_DESCRIPTION,
  TITLE_SCHEMA,
  TITLE_TOOL,
  titleSection,
  wakeText,
  type Pending,
  type Thread,
} from './text'

const TICK_MS = 1000
const POLL_WAIT_S = 20
const IDLE_TICKS = 2

type Conn = { token: string; serverFile: string; owner: string }

let conn: Conn | null = null
let baseUrl: string | null = null
let polling = false
let lastClaudeSessionId: string | null = null
let sendToolName = `mcp__minbox__${SEND_TOOL}`
let readToolName = `mcp__minbox__${READ_TOOL}`
let titleToolName = `mcp__minbox__${TITLE_TOOL}`
let openToolName = `mcp__minbox__${OPEN_TOOL}`
/** The tools whose use the reminder repeats from the system prompt. */
const guided = () => ({ title: titleToolName, open: openToolName })
let promptExtra: string | null = null
let helloing: Promise<void> | null = null
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
async function api($: any, method: string, path: string, body?: unknown): Promise<ApiResult> {
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
    }
  }
  return { ok: false, status: 0, json: { error: 'the minbox server is not reachable' } }
}

async function hello($: any): Promise<void> {
  const id = await $.session.id().catch(() => null)
  if (typeof id === 'string' && id !== lastClaudeSessionId) {
    const res = await api($, 'POST', '/api/agent/hello', { claude_session_id: id })
    if (res.ok) {
      lastClaudeSessionId = id
      promptExtra = typeof res.json?.prompt_extra === 'string' ? res.json.prompt_extra : null
    }
  }
}

function status($: any, value: 'working' | 'idle'): void {
  void api($, 'POST', '/api/agent/status', { status: value })
}

/** A pending message's route, with this instance as the owner. */
function pendingPath(id: string, action: 'claim' | 'release' | 'delivered'): string {
  return `/api/agent/pending/${encodeURIComponent(id)}/${action}?owner=${encodeURIComponent(conn?.owner ?? '')}`
}

/** One tick: deliver the person's messages once Claude has been idle a while. */
async function tick($: any): Promise<void> {
  if (!conn) return
  idleTicks = busy ? 0 : idleTicks + 1
  if (nudgeNext && !busy && idleTicks >= IDLE_TICKS) {
    nudgeNext = false
    nudging = true
    try {
      await $.prompt.submit({ text: nudgeText(sendToolName) })
    } catch {
      nudging = false
    }
  }
  if (polling) return
  polling = true
  try {
    await hello($) // also follows /clear, which changes the conversation id
    // Wait on the server only while idle; while busy, just look.
    const wait = busy ? 0 : POLL_WAIT_S
    const res = await api($, 'GET', `/api/agent/pending?owner=${encodeURIComponent(conn.owner)}&wait=${wait}`)
    if (!res.ok || !Array.isArray(res.json) || res.json.length === 0) return
    // Deliver only into a quiet session, so the person's own typing goes first;
    // an urgent message (Send now, or one that waited long) goes in anyway.
    const quiet = !busy && idleTicks >= IDLE_TICKS
    const due = (res.json as Pending[]).filter((p) => quiet || p.urgent)
    if (due.length === 0) return
    const claimed: Pending[] = []
    for (const p of due) {
      const c = await api($, 'POST', pendingPath(p.id, 'claim'))
      if (c.ok && c.json?.claimed) claimed.push(p)
    }
    if (claimed.length === 0) return
    // Re-check as late as possible: the submit cannot be taken back.
    if (busy) {
      const wait = claimed.filter((p) => !p.urgent)
      for (const p of wait) await api($, 'POST', pendingPath(p.id, 'release'))
      claimed.splice(0, claimed.length, ...claimed.filter((p) => p.urgent))
      if (claimed.length === 0) return
    }
    try {
      await $.prompt.submit({ text: wakeText(claimed, sendToolName, readToolName) })
    } catch (err) {
      for (const p of claimed) await api($, 'POST', pendingPath(p.id, 'release'))
      $.ui.toast(`minbox: a reply could not be delivered (${String(err)}); it stays in the inbox.`)
      return
    }
    for (const p of claimed) await api($, 'POST', pendingPath(p.id, 'delivered'))
  } finally {
    polling = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const token = await $.env.get('MINBOX_TOKEN')
    const serverFile = await $.env.get('MINBOX_SERVER_FILE')
    if (!token || !serverFile || !e.isInteractive) return next(e)
    conn = { token, serverFile, owner: randomId() }

    const send = await $.tool.register({ name: SEND_TOOL, description: SEND_DESCRIPTION, inputSchema: SEND_SCHEMA, isDeferred: false })
    sendToolName = send?.tool ?? sendToolName
    const read = await $.tool.register({ name: READ_TOOL, description: READ_DESCRIPTION, inputSchema: READ_SCHEMA, isDeferred: false })
    readToolName = read?.tool ?? readToolName
    const title = await $.tool.register({ name: TITLE_TOOL, description: TITLE_DESCRIPTION, inputSchema: TITLE_SCHEMA, isDeferred: false })
    titleToolName = title?.tool ?? titleToolName
    const open = await $.tool.register({ name: OPEN_TOOL, description: OPEN_DESCRIPTION, inputSchema: OPEN_SCHEMA, isDeferred: false })
    openToolName = open?.tool ?? openToolName
    await $.tool.register({ name: CARD_TOOL, description: CARD_DESCRIPTION, inputSchema: CARD_SCHEMA, isDeferred: true })

    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => tick($))
    helloing = hello($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = null
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (conn && !e.agentId) {
      busy = true
      idleTicks = 0
      sentThisTurn = false
      status($, 'working')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (conn && !e.agentId) {
      busy = false
      idleTicks = 0
      // Asked the person in the chat but not in the inbox: remind Claude once.
      const answered = e.reason === 'answer' && !e.isAborted
      nudgeNext = answered && !nudging && !sentThisTurn && asksPerson(e.answer ?? '')
      nudging = false
      status($, 'idle')
    }
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
    if (!remindNext && !threadsNext) return next(e)
    if (helloing) await helloing.catch(() => {}) // prompt_extra comes with the hello
    let extra: string | null = null
    if (threadsNext) {
      const res = await api($, 'GET', '/api/agent/threads')
      extra = res.ok && Array.isArray(res.json) ? openThreadsText(res.json as Thread[], sendToolName, promptExtra, guided()) : null
    }
    extra ??= remindNext || threadsNext ? reminderText(sendToolName, promptExtra, guided()) : null
    remindNext = false
    threadsNext = false
    return extra ? next({ ...e, context: [...(e.context ?? []), extra] }) : next(e)
  })

  on('tool.call', { tool: `mcp__minbox__${SEND_TOOL}` }, async ($, e: any) => {
    if (!conn) return { deny: 'minbox is not connected in this session.' }
    const body = typeof e.body === 'string' ? e.body : ''
    if (!body.trim()) return { deny: 'body is required.' }
    const res = await api($, 'POST', '/api/agent/messages', {
      body,
      subject: typeof e.subject === 'string' ? e.subject : undefined,
      thread_id: typeof e.thread_id === 'string' && e.thread_id ? e.thread_id : undefined,
      name: typeof e.name === 'string' && e.name ? e.name : undefined,
      attachments: Array.isArray(e.attachments) ? e.attachments.filter((a: unknown) => typeof a === 'string') : undefined,
      review: e.review && typeof e.review === 'object' ? e.review : undefined,
    })
    if (!res.ok) return { deny: `minbox: ${res.json?.error ?? `HTTP ${res.status}`}` }
    sentThisTurn = true
    return { result: sentText(res.json) }
  })

  // The system prompt asks Claude to keep the session's title current.
  on('prompt.compose', async ($, e, next) => {
    const res = await next(e)
    if (!conn) return res
    // minbox's --append-system-prompt may carry the same already.
    const has = (heading: string) => res.sections.some((s) => s.text.includes(heading))
    const add = [
      has('# minbox: inbox') ? null : { id: 'minbox:inbox', text: inboxSection(sendToolName), scope: 'session' as const },
      has('# minbox: session title') ? null : { id: 'minbox:session-title', text: titleSection(titleToolName), scope: 'session' as const },
      has('# minbox: opening pages') ? null : { id: 'minbox:open-url', text: openSection(openToolName), scope: 'session' as const },
    ].filter((s) => s !== null)
    return add.length ? { ...res, sections: [...res.sections, ...add] } : res
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
    const res = await api($, 'GET', id ? `/api/agent/threads/${encodeURIComponent(id)}` : '/api/agent/threads')
    if (!res.ok) return { deny: `minbox: ${res.json?.error ?? `HTTP ${res.status}`}` }
    return { result: id ? threadText(res.json as Thread) : threadListText(res.json as Thread[]) }
  })

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
