import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type IssueListResult, type IssueSummary, type LinearStatus } from '../api'

// My issues: Linear connection state for the rail entry, and the assigned list with
// stale-while-revalidate (the list in memory, then the server's cache, then a revalidation). Nothing
// polls: the list is fetched when the screen opens and when the person presses Refresh.

// ---- Linear status (shared by the rail, the phone sheet and the screen) ----

let status: LinearStatus | null = null
let statusLoaded = false
const listeners = new Set<() => void>()

function loadStatus() {
  api
    .linearStatus()
    .then((s) => {
      status = s
      statusLoaded = true
      listeners.forEach((l) => l())
    })
    .catch(() => {})
}

if (typeof window !== 'undefined') window.addEventListener('minbox:linear', loadStatus)

/** The Linear login: `known` once the first answer is in. The entry shows while connected or while a login is needed. */
export function useLinearStatus(): { status: LinearStatus | null; known: boolean; available: boolean } {
  const [, tick] = useState(0)
  useEffect(() => {
    const l = () => tick((n) => n + 1)
    listeners.add(l)
    if (!statusLoaded) loadStatus()
    return () => void listeners.delete(l)
  }, [])
  return { status, known: statusLoaded, available: !!status && (status.connected || status.needs_login) }
}

// ---- the list ----

let memory: { issues: IssueSummary[]; fetchedAt: string | null; user?: string; warnings: string[] } | null = null

export type IssuesState = {
  issues: IssueSummary[] | null
  /** A fetch is running (the list may already be shown from the cache). */
  syncing: boolean
  error: { message: string; code?: string; status?: number } | null
  warnings: string[]
  fetchedAt: string | null
  refresh: () => void
  /** Put a just-created issue in the list (it is assigned to me) without waiting for Linear. */
  add: (i: IssueSummary) => void
}

export function useMyIssues(): IssuesState {
  const [issues, setIssues] = useState<IssueSummary[] | null>(memory?.issues ?? null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<IssuesState['error']>(null)
  const [warnings, setWarnings] = useState<string[]>(memory?.warnings ?? [])
  const [fetchedAt, setFetchedAt] = useState<string | null>(memory?.fetchedAt ?? null)
  const live = useRef(true)
  const seq = useRef(0)
  useEffect(() => {
    live.current = true
    return () => void (live.current = false)
  }, [])

  const apply = useCallback((r: IssueListResult) => {
    if (!r.issues) return
    memory = { issues: r.issues, fetchedAt: r.fetched_at ?? null, warnings: r.warnings ?? [] }
    setIssues(r.issues)
    setWarnings(r.warnings ?? [])
    setFetchedAt(r.fetched_at ?? null)
  }, [])

  const run = useCallback(
    async (refresh: boolean) => {
      const n = ++seq.current
      setSyncing(true)
      setError(null)
      try {
        // Instant: the server's cache (never calls Linear), unless the memory already has a list.
        if (!memory) {
          try {
            const c = await api.issuesList({ closed: true, cached: true })
            if (live.current && n === seq.current && c.issues && !memory) apply(c)
          } catch {
            /* the revalidation below reports the error */
          }
        }
        const r = await api.issuesList({ closed: true, refresh })
        if (!live.current || n !== seq.current) return
        apply(r)
      } catch (e) {
        if (!live.current || n !== seq.current) return
        const x = e as { status?: number; code?: string }
        setError({ message: e instanceof Error ? e.message : String(e), code: x.code, status: x.status })
      } finally {
        if (live.current && n === seq.current) setSyncing(false)
      }
    },
    [apply],
  )
  // Open: show what is cached, revalidate once (the server debounces and caches too).
  useEffect(() => {
    void run(false)
  }, [run])
  const refresh = useCallback(() => void run(true), [run])
  const add = useCallback((i: IssueSummary) => {
    setIssues((cur) => {
      const next = [i, ...(cur ?? []).filter((x) => x.identifier !== i.identifier)]
      if (memory) memory = { ...memory, issues: next }
      return next
    })
  }, [])
  return { issues, syncing, error, warnings, fetchedAt, refresh, add }
}

// ---- grouping ----

const TYPE_ORDER = ['started', 'unstarted', 'triage', 'backlog', 'completed', 'canceled']
export const isClosed = (t: string) => t === 'completed' || t === 'canceled'

export type IssueGroup = { key: string; state: string; type: string; items: IssueSummary[] }

/** Groups by workflow state (type order first: started, unstarted, backlog…, then by name), keeping the incoming order inside a group. */
export function groupIssues(list: IssueSummary[]): IssueGroup[] {
  const by = new Map<string, IssueGroup>()
  for (const i of list) {
    const key = `${i.state_type}|${i.state}`
    let g = by.get(key)
    if (!g) by.set(key, (g = { key, state: i.state || 'No state', type: i.state_type, items: [] }))
    g.items.push(i)
  }
  const rank = (t: string) => {
    const r = TYPE_ORDER.indexOf(t)
    return r < 0 ? 2.5 : r
  }
  return [...by.values()].sort((a, b) => rank(a.type) - rank(b.type) || a.state.localeCompare(b.state))
}

/** Client-side search over the visible fields. */
export function matchesIssue(i: IssueSummary, q: string): boolean {
  const t = q.trim().toLowerCase()
  if (!t) return true
  const hay = [i.identifier, i.title, i.state, i.team_key, i.project, i.priority_name, ...i.labels].join(' ').toLowerCase()
  return t.split(/\s+/).every((w) => hay.includes(w))
}

const LAST_PROJECT_KEY = 'minbox.issues.lastProject'
export const lastIssueProject = () => {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) ?? ''
  } catch {
    return ''
  }
}
export const rememberIssueProject = (id: string) => {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id)
  } catch {
    /* private mode */
  }
}
