// The read-only navigation tools of the minbox mod and of the Pi extension (both import this file,
// as they do text.ts): list_projects, get_project, list_sessions, list_threads and search. Each tool
// is a GET on /api/agent/*; this file holds their descriptions and schemas, the request path of a
// call and the text an answer becomes. Self-contained (no imports), so both runtimes load it.

export const NAV_TOOLS = ['list_projects', 'get_project', 'list_sessions', 'list_threads', 'search'] as const
export type NavTool = (typeof NAV_TOOLS)[number]

const THREAD_STATUSES = ['working', 'need_action', 'blocked', 'finished']

export const NAV_DESCRIPTION: Record<NavTool, string> = {
  list_projects:
    "List the person's minbox projects (a project is a folder on a host): id, name, folder, host, default agent, session and thread counts, how many threads wait on the person, last activity. Read-only. Archived projects only with `archived`.",
  get_project:
    'One minbox project by id (from list_projects): its folder, host, default agent, counts and its sessions (id, name, title, agent, status). Read-only.',
  list_sessions:
    'List minbox sessions (one coding-agent session each, Claude Code or Pi): id, name, title, folder, agent, status, project, unread and waiting counts. Newest activity first. Filter by `project_id`, `status` or `agent`. Read-only; returns at most `limit` rows and says how many exist.',
  list_threads:
    'List minbox threads across ALL sessions and projects (read_thread without an id lists only this session\'s), newest first: id, subject, project, session, status, unread and open-question counts, who wrote last, the start of the last message. Filters: `project_id`, `session_id` ("self" = this session), `status`, `awaiting` (person = waits on the person, agent = the person wrote last), `unread`, `query` (words in the subject or last message), `archived`. Read a thread with read_thread. Read-only; returns at most `limit` rows and says how many exist.',
  search:
    'Full-text search of minbox: thread titles, message bodies of the agent and of the person, and attachment names/text. Returns hits with thread id, session, a snippet and the date; open one with read_thread. Narrow it with `project_id`, `session_id` ("self" = this session) or `from` (agent | person). Read-only.',
}

export const NAV_SCHEMA: Record<NavTool, object> = {
  list_projects: {
    type: 'object',
    properties: { archived: { type: 'boolean', description: 'List archived projects instead of live ones.' } },
    additionalProperties: false,
  },
  get_project: {
    type: 'object',
    properties: { project_id: { type: 'string', description: 'A project id from list_projects.' } },
    required: ['project_id'],
    additionalProperties: false,
  },
  list_sessions: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      status: { type: 'string', enum: ['starting', 'working', 'idle', 'ended'], description: "The session's state." },
      agent: { type: 'string', enum: ['claude', 'pi'] },
      archived: { type: 'boolean', description: 'List archived sessions instead of live ones.' },
      limit: { type: 'number', description: 'Most rows (default 50, at most 200).' },
    },
    additionalProperties: false,
  },
  list_threads: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      session_id: { type: 'string', description: 'A session id, or "self" for this session.' },
      status: { type: 'string', enum: THREAD_STATUSES, description: "The thread's status." },
      awaiting: { type: 'string', enum: ['person', 'agent'], description: 'person: waits on the person (need_action or open questions); agent: the person wrote last and waits on the agent.' },
      unread: { type: 'boolean', description: 'Only threads with unread agent messages.' },
      query: { type: 'string', description: 'Words that must all appear in the subject, name or last message (case-insensitive). For full text use search.' },
      archived: { type: 'boolean', description: 'List archived threads instead of live ones.' },
      limit: { type: 'number', description: 'Most rows (default 50, at most 200).' },
    },
    additionalProperties: false,
  },
  search: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words that must all appear (case-insensitive).' },
      project_id: { type: 'string' },
      session_id: { type: 'string', description: 'A session id, or "self" for this session.' },
      from: { type: 'string', enum: ['agent', 'person'], description: 'Only messages written by the agent or by the person.' },
      limit: { type: 'number', description: 'Most hits per kind (default 20, at most 50).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

/** The API path of a navigation tool's call, or an error for the agent. */
export function navPath(tool: NavTool, e: Record<string, unknown>): { path: string } | { error: string } {
  const p = new URLSearchParams()
  const str = (k: string, as = k) => {
    const v = e[k]
    if (typeof v === 'string' && v.trim()) p.set(as, v.trim())
  }
  const flag = (k: string) => {
    if (e[k] === true) p.set(k, '1')
  }
  const limit = () => {
    if (typeof e.limit === 'number' && e.limit > 0) p.set('limit', String(Math.floor(e.limit)))
  }
  const qs = () => (p.toString() ? `?${p.toString()}` : '')
  switch (tool) {
    case 'list_projects':
      flag('archived')
      return { path: `/api/agent/projects${qs()}` }
    case 'get_project': {
      const id = typeof e.project_id === 'string' ? e.project_id.trim() : ''
      return id ? { path: `/api/agent/projects/${encodeURIComponent(id)}` } : { error: 'project_id is required.' }
    }
    case 'list_sessions':
      str('project_id')
      str('status')
      str('agent')
      flag('archived')
      limit()
      return { path: `/api/agent/sessions${qs()}` }
    case 'list_threads':
      str('project_id')
      str('session_id')
      str('status')
      str('awaiting')
      flag('unread')
      str('query', 'q')
      flag('archived')
      limit()
      return { path: `/api/agent/inbox${qs()}` }
    case 'search': {
      if (typeof e.query !== 'string' || !e.query.trim()) return { error: 'query is required.' }
      str('query', 'q')
      str('project_id')
      str('session_id')
      if (e.from === 'agent') p.set('from', 'agent')
      else if (e.from === 'person' || e.from === 'user') p.set('from', 'user')
      limit()
      return { path: `/api/agent/search${qs()}` }
    }
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const day = (t: unknown) => (typeof t === 'string' ? t.slice(0, 16).replace('T', ' ') : '')

function more(shown: number, total: number | undefined, what: string): string[] {
  return total !== undefined && total > shown ? ['', `(${shown} of ${total} ${what} shown; narrow the filters or raise limit.)`] : []
}

/** What a navigation tool returns to the agent. */
export function navText(tool: NavTool, v: any): string {
  switch (tool) {
    case 'list_projects': {
      const ps: any[] = Array.isArray(v) ? v : []
      return ps.length === 0 ? 'No projects.' : ps.map(projectLine).join('\n')
    }
    case 'get_project': {
      const lines = [projectLine(v)]
      const ses: any[] = v?.sessions ?? []
      if (ses.length > 0) lines.push('Sessions:', ...ses.map(sessionLine))
      return lines.join('\n')
    }
    case 'list_sessions': {
      const ss: any[] = v?.sessions ?? []
      return ss.length === 0 ? 'No sessions match.' : [...ss.map(sessionLine), ...more(ss.length, v?.total, 'sessions')].join('\n')
    }
    case 'list_threads': {
      const ts: any[] = v?.threads ?? []
      return ts.length === 0 ? 'No threads match.' : [...ts.map(threadLine), ...more(ts.length, v?.total, 'threads')].join('\n')
    }
    case 'search': {
      const kinds: [string, any[]][] = [
        ['Threads', v?.threads ?? []],
        ['Messages', v?.messages ?? []],
        ['Files', v?.files ?? []],
      ]
      if (kinds.every(([, hs]) => hs.length === 0)) return 'No matches.'
      const out: string[] = []
      for (const [label, hits] of kinds) {
        if (hits.length === 0) continue
        out.push(`${label}:`)
        for (const h of hits) {
          const who = h.author ? ` ${h.author === 'user' ? 'person' : 'agent'}` : ''
          const file = label === 'Files' ? ` file ${h.name ?? ''}` : ''
          out.push(`- thread ${h.thread_id} "${oneLine(h.subject ?? '')}" (session ${h.session_name ?? h.session_id}${h.archived ? ', archived' : ''})${file} ·${who} ${day(h.created_at)}: ${oneLine(h.snippet ?? '').slice(0, 200)}`)
        }
      }
      return out.join('\n')
    }
  }
}

function projectLine(p: any): string {
  return [
    `- ${p.id} "${p.name}"`,
    `${p.dir || '(no folder)'}${p.host_name ? ` on ${p.host_name}` : ''}`,
    p.default_agent ? `default agent ${p.default_agent}` : '',
    `${plural(p.session_count ?? 0, 'session')} (${p.live_sessions ?? 0} live)`,
    `${plural(p.thread_count ?? 0, 'thread')}, ${p.need_action ?? 0} waiting on the person, ${p.unread ?? 0} unread`,
    p.archived ? 'archived' : '',
    p.last_activity ? `last ${day(p.last_activity)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function sessionLine(s: any): string {
  return [
    `- ${s.id} "${s.name}"${s.title ? ` (${oneLine(s.title)})` : ''}`,
    `${s.agent} ${s.status}${s.is_main ? ' main' : ''}${s.archived ? ' archived' : ''}${s.self ? ' (this session)' : ''}`,
    s.cwd,
    s.project_id ? `project ${s.project_id}` : '',
    s.waiting ? `${s.waiting} waiting` : '',
    s.unread ? `${s.unread} unread` : '',
    s.last_activity ? `last ${day(s.last_activity)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function threadLine(t: any): string {
  const head = [
    `- ${t.id} "${oneLine(t.subject ?? '')}"`,
    t.status,
    `${t.project_name || t.project_id} / ${t.session_name || t.session_id}${t.self ? ' (this session)' : ''}`,
    t.open_questions ? `${t.open_questions} open question${t.open_questions > 1 ? 's' : ''}` : '',
    t.unread ? `${t.unread} unread` : '',
    `${plural(t.message_count ?? 0, 'message')}, ${t.last_author === 'user' ? 'the person' : 'the agent'} wrote last ${day(t.updated_at)}`,
  ]
    .filter(Boolean)
    .join(' · ')
  return `${head}: ${oneLine(t.last_body ?? '').slice(0, 100)}`
}
