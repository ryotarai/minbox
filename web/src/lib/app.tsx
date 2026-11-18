import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  ATTENTION,
  DEFAULT_SETTINGS,
  api,
  subscribe,
  type ConnectionState,
  type Host,
  type Project,
  type Session,
  type Settings,
} from '../api'
import { dingDong, notify, setFaviconCount } from './alerts'
import { setSingleKeysEnabled } from './hotkeys'

// ---- route: the URL hash ----

/** v3: main is the Board; task, agent (a stream), agents (the phone's list), search and columns (tasks side by side). */
export type View = 'main' | 'settings' | 'tasks' | 'review' | 'inbox' | 'issues' | 'slack' | 'task' | 'agent' | 'agents' | 'search' | 'columns'
export type Route = {
  /** Selected session. */
  s: string | null
  /** Open thread. */
  t: string | null
  /** Attachment open beside the thread (center column). */
  f: string | null
  view: View
  /** Guided review: the attachment shown full screen. */
  r: string | null
  /** Phone and tablet: the session screen's tab ('terminal' = the terminal view; 'tasks' = v3's phone sheet of the agent's tasks, terminal, shell and files). */
  tab: 'inbox' | 'terminal' | 'tasks'
  /** Settings section. */
  ss: string
  /** My issues: the selected issue's identifier (ENG-123). */
  issue: string | null
  /** Slack (personal): the selected thread, `<channel>:<ts>`. */
  slack: string | null
  /** v3: the open task. */
  k: string | null
  /** v3: a message to scroll to and highlight. */
  m: string | null
}

function readRoute(hash = location.hash): Route {
  const p = new URLSearchParams(hash.replace(/^[^#]*#?/, ''))
  // The Board became Topics, then Tasks: an old link opens Tasks (Root rewrites the hash).
  const v = p.get('v')
  const view = ((v === 'board' || v === 'topics' ? 'tasks' : v) as View) || 'main'
  return {
    s: p.get('s'),
    t: p.get('t'),
    f: p.get('f'),
    view: ['main', 'settings', 'tasks', 'review', 'inbox', 'issues', 'slack', 'task', 'agent', 'agents', 'search', 'columns'].includes(view) ? view : 'main',
    r: p.get('r'),
    tab: p.get('tab') === 'terminal' ? 'terminal' : p.get('tab') === 'tasks' ? 'tasks' : 'inbox',
    ss: p.get('ss') || 'general',
    issue: p.get('issue'),
    slack: p.get('thread'),
    k: p.get('k'),
    m: p.get('m'),
  }
}

function routeHash(r: Route): string {
  const p = new URLSearchParams()
  if (r.s) p.set('s', r.s)
  if (r.t) p.set('t', r.t)
  if (r.f) p.set('f', r.f)
  if (r.view !== 'main') p.set('v', r.view)
  if (r.r) p.set('r', r.r)
  if (r.tab !== 'inbox') p.set('tab', r.tab)
  if (r.view === 'settings' && r.ss !== 'general') p.set('ss', r.ss)
  if (r.view === 'issues' && r.issue) p.set('issue', r.issue)
  if (r.view === 'slack' && r.slack) p.set('thread', r.slack)
  if (r.view === 'task' && r.k) p.set('k', r.k)
  if (r.m && (r.view === 'task' || r.view === 'agent')) p.set('m', r.m)
  const h = p.toString()
  return h ? `#${h}` : location.pathname
}

// ---- in-app history ----
//
// Every history entry the app makes carries its depth in the app (mb: 0 for the entry the app was
// opened on, +1 per push) and the hash it was pushed from (from). The ‹ back control (and Esc) goes
// back through the browser's history while the previous entry is the app's own (mb > 0), so the
// button and the browser's back / swipe-back walk the same entries; on the first entry (a deep link,
// a reload of one, a hash typed in) it replaces the entry with the fallback (the Board): no new
// entry, and a browser back from there leaves the app instead of bouncing back.

// base: the depth of the first entry of the current screen's run (an issue picked after another stays
// on My issues), so ‹ on a screen with its own selection can leave the whole screen in one step.
type HistState = { mb?: number; from?: string; base?: number; baseFrom?: string; viewer?: boolean }

function histState(): HistState {
  const st = history.state as unknown
  return st && typeof st === 'object' ? (st as HistState) : {}
}

/** Marks an entry the app did not make (the first one, a typed hash) as the app's first. */
function stampEntry() {
  const st = histState()
  if (typeof st.mb !== 'number') history.replaceState({ ...st, mb: 0, base: 0 }, '')
}

/** Where ‹ back leads from here: the previous in-app entry's route, or null (the fallback: the Board). */
export function backTarget(): Route | null {
  const st = histState()
  return (st.mb ?? 0) > 0 && st.from != null ? readRoute(st.from) : null
}

/** Where leaving the current screen (all its entries) leads: the entry it was opened from, or null. */
export function leaveTarget(): Route | null {
  const st = histState()
  const base = Math.min(st.mb ?? 0, st.base ?? 0)
  return base > 0 && st.baseFrom != null ? readRoute(st.baseFrom) : null
}

/** The Board, with nothing selected. */
export const HOME: Partial<Route> = { view: 'main', s: null, t: null, f: null, k: null, m: null, r: null, issue: null, slack: null }

export function threadLink(sessionId: string, threadId: string): string {
  return `${location.origin}${location.pathname}#s=${sessionId}&t=${threadId}`
}

// ---- phone ----

/**
 * Width bands (CSS px), purely width-based so touch tablets, foldables and small desktop windows
 * behave alike:
 *   < SINGLE_COLUMN_BELOW                      phone: one column at a time (list, thread, terminal)
 *   SINGLE_COLUMN_BELOW .. THREE_COLUMN_FROM-1 tablet: two panes [list | thread], or [thread | terminal]
 *   >= THREE_COLUMN_FROM                       desktop: [Threads | Thread | Terminal (| Shell)]
 * The narrowest three columns get is project tiles 56 + list 240 + thread 380 + terminal 360 + gaps
 * 18 = 1054, and 1100 leaves some room.
 */
export const SINGLE_COLUMN_BELOW = 700
export const THREE_COLUMN_FROM = 1100
const phoneQuery = window.matchMedia(`(max-width: ${SINGLE_COLUMN_BELOW - 1}px)`)
const tabletQuery = window.matchMedia(`(min-width: ${SINGLE_COLUMN_BELOW}px) and (max-width: ${THREE_COLUMN_FROM - 1}px)`)
function useQuery(q: MediaQueryList): boolean {
  return useSyncExternalStore(
    (l) => {
      q.addEventListener('change', l)
      return () => q.removeEventListener('change', l)
    },
    () => q.matches,
  )
}
export const useIsPhone = () => useQuery(phoneQuery)
export const useIsTablet = () => useQuery(tabletQuery)

// ---- layout preferences (this browser) ----

/** In `threadVersion`: bumped when every open thread should load again. */
export const ALL_THREADS = '*'

/** projectsRail: the project column shows 56 px tiles instead of names (the rail is "closed"). */
export type Layout = { sidebarW: number; inboxW: number; threadW: number; projectsRail?: boolean; inboxCollapsed: boolean; shellW: number; shellPane: boolean
  /** Desktop: the Claude Code terminal pane is shown (hidden by default: the threads are the way in). */
  terminalPane: boolean
  /** Desktop: the open thread's Tasks pane is shown (beside the thread, before the terminal), and its width. */
  tasksPane: boolean
  tasksW: number
  /** Desktop: the Files pane (the session's folder as a tree) is shown (after the Tasks pane), and its width. */
  filesPane: boolean
  filesW: number
  /** v3: the agent's side pane last shown (tasks, terminal, shell, files), kept across agents and reloads. */
  v3Pane?: 'tasks' | 'terminal' | 'shell' | 'files'
  /** v3: widths dragged by the person: the sidebar, the narrow side pane (tasks), the wide one (terminal, shell, files). */
  v3SidebarW?: number
  v3SideW?: number
  v3WideW?: number
}
/** The project rail is closed (56 px tiles, no names): one preference for every screen (v3, My issues, Slack) and width
 *  but the phone, kept in minbox:layout across reloads. Closed unless the person opened it. */
export const railClosed = (l: Layout) => l.projectsRail ?? true
/** The project rail's width: closed (tiles) or open (names). */
export const railWidth = (l: Layout) => (railClosed(l) ? 56 : 176)
function defaultLayout(): Layout {
  const w = window.innerWidth
  if (w >= 1680) return { sidebarW: 380, inboxW: 480, threadW: 620, inboxCollapsed: false, shellW: 560, shellPane: false, terminalPane: false, tasksPane: false, tasksW: 320, filesPane: false, filesW: 360 }
  if (w >= 1440) return { sidebarW: 340, inboxW: 480, threadW: 520, inboxCollapsed: false, shellW: 520, shellPane: false, terminalPane: false, tasksPane: false, tasksW: 320, filesPane: false, filesW: 360 }
  if (w >= 1200) return { sidebarW: 272, inboxW: 440, threadW: 520, inboxCollapsed: false, shellW: 460, shellPane: false, terminalPane: false, tasksPane: false, tasksW: 320, filesPane: false, filesW: 360 }
  return { sidebarW: 250, inboxW: 380, threadW: 480, inboxCollapsed: false, shellW: 400, shellPane: false, terminalPane: false, tasksPane: false, tasksW: 320, filesPane: false, filesW: 360 }
}
function readLayout(): Layout {
  try {
    const v = localStorage.getItem('minbox:layout')
    if (v) {
      const { rail: _old, ...saved } = JSON.parse(v) // `rail` (the collapsed list) is gone: ignore a saved one
      return { ...defaultLayout(), ...saved }
    }
  } catch {
    /* ignore */
  }
  return defaultLayout()
}

// ---- toasts ----

export type Toast = {
  id: number
  text: string
  error?: boolean
  action?: string
  onAction?: () => void
  /** Undo-able with Z while shown. */
  undo?: boolean
  ms: number
}

// ---- overlays ----

export type Overlay =
  | { kind: 'palette' }
  | { kind: 'shortcuts' }
  | { kind: 'decide' }
  | { kind: 'delete-session'; session: Session }
  | { kind: 'drafts' }
  | { kind: 'new-session'; projectId?: string }
  | { kind: 'new-project' }
  | { kind: 'edit-project'; project: Project }
  | { kind: 'delete-project'; project: Project }
  | { kind: 'project-icon'; project: Project }
  | { kind: 'v3-new'; to?: string }
  | { kind: 'v3-help' }
  | null

type AppState = {
  route: Route
  navigate: (patch: Partial<Route>, opts?: { push?: boolean }) => void
  back: () => void
  /** ‹ back (and Esc): the previous in-app entry (history.back()), else replace with fallback (the Board). */
  goBack: (fallback?: Partial<Route>, opts?: { leave?: boolean }) => void
  sessions: Session[] | null
  setSessions: React.Dispatch<React.SetStateAction<Session[] | null>>
  reloadSessions: () => Promise<void>
  hosts: Host[]
  reloadHosts: () => void
  /** Live projects (pinned first, then recent activity); null while loading. */
  projects: Project[] | null
  reloadProjects: () => Promise<void>
  settings: Settings
  saveSettings: (patch: Partial<Settings>) => void
  conn: ConnectionState
  threadsVersion: number
  threadVersion: Record<string, number>
  /** Bumped when some thread's topics changed (the Tasks board and a thread's Tasks pane reload). */
  topicsVersion: number
  devicesVersion: number
  toasts: Toast[]
  toast: (text: string, opts?: Partial<Omit<Toast, 'id' | 'text'>>) => void
  dismissToast: (id: number) => void
  error: (err: unknown) => void
  undoLast: () => boolean
  layout: Layout
  setLayout: (patch: Partial<Layout>) => void
  overlay: Overlay
  setOverlay: (o: Overlay) => void
  isPhone: boolean
  isTablet: boolean
}

const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside AppProvider')
  return v
}

export function attentionOf(s: Session): number {
  // waiting already counts the stopped and holding threads.
  return s.waiting
}

export function AppProvider({ children }: { children: ReactNode }) {
  const isPhone = useIsPhone()
  const isTablet = useIsTablet()
  const [route, setRoute] = useState<Route>(readRoute)
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [hosts, setHosts] = useState<Host[]>([])
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [conn, setConn] = useState<ConnectionState>({ connected: true, attempts: 0, since: null })
  const [threadsVersion, setThreadsVersion] = useState(0)
  const [threadVersion, setThreadVersion] = useState<Record<string, number>>({})
  const [topicsVersion, setTopicsVersion] = useState(0)
  const [devicesVersion, setDevicesVersion] = useState(0)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [layout, setLayoutState] = useState<Layout>(readLayout)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const toastId = useRef(0)

  // Route ↔ hash.
  useEffect(() => {
    stampEntry()
    const on = () => {
      stampEntry()
      setRoute(readRoute())
    }
    window.addEventListener('hashchange', on)
    window.addEventListener('popstate', on)
    return () => {
      window.removeEventListener('hashchange', on)
      window.removeEventListener('popstate', on)
    }
  }, [])
  const routeRef = useRef(route)
  routeRef.current = route
  const navigate = useCallback(
    (patch: Partial<Route>, opts?: { push?: boolean }) => {
      const next = { ...routeRef.current, ...patch }
      if (patch.s !== undefined && patch.s !== routeRef.current.s && patch.t === undefined) next.t = null
      if (patch.s !== undefined && patch.s !== routeRef.current.s && patch.f === undefined) next.f = null
      const h = routeHash(next)
      // Where we are now: a push to the same place makes no second entry.
      const here = location.hash || location.pathname
      const push = (opts?.push ?? isPhone) && h !== here
      const st = histState()
      const depth = st.mb ?? 0
      const same = next.view === routeRef.current.view
      // An attachment viewer opened by a push is marked, so closing it can go back instead of stacking entries.
      const from = routeHash(routeRef.current)
      if (push) history.pushState({ mb: depth + 1, from, base: same ? (st.base ?? 0) : depth + 1, baseFrom: same ? st.baseFrom : from, viewer: next.f && !routeRef.current.f ? true : undefined }, '', h)
      else history.replaceState({ mb: depth, from: st.from, base: same ? st.base : depth, baseFrom: same ? st.baseFrom : st.from, viewer: next.f ? st.viewer : undefined }, '', h)
      routeRef.current = next
      setRoute(next)
    },
    [isPhone],
  )
  const back = useCallback(() => history.back(), [])
  const goBack = useCallback(
    (fallback?: Partial<Route>, opts?: { leave?: boolean }) => {
      const st = histState()
      const depth = st.mb ?? 0
      // leave: back past every entry of this screen (to the one it was opened from).
      const base = opts?.leave ? Math.min(depth, st.base ?? 0) : depth
      if (base > 0) history.go(base - depth - 1)
      else navigate(fallback ?? HOME, { push: false })
    },
    [navigate],
  )

  // Toasts.
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback(
    (text: string, opts?: Partial<Omit<Toast, 'id' | 'text'>>) => {
      const id = ++toastId.current
      const ms = opts?.ms ?? (opts?.error ? 6000 : opts?.undo ? 7000 : 3500)
      setToasts((t) => [...t.slice(-3), { id, text, ms, ...opts }])
      setTimeout(() => dismissToast(id), ms)
    },
    [dismissToast],
  )
  const error = useCallback((err: unknown) => toast(err instanceof Error ? err.message : String(err), { error: true }), [toast])
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const undoLast = useCallback(() => {
    const t = [...toastsRef.current].reverse().find((x) => x.undo && x.onAction)
    if (!t) return false
    t.onAction?.()
    dismissToast(t.id)
    return true
  }, [dismissToast])

  // Sessions and server events.
  const reloadSessions = useCallback(() => {
    return api.sessions().then(setSessions).catch(error)
  }, [error])
  const reloadHosts = useCallback(() => {
    api
      .hosts()
      .then(setHosts)
      .catch(() => {
        /* older server: no hosts */
      })
  }, [])
  const reloadProjects = useCallback(() => {
    return api
      .projects()
      .then(setProjects)
      .catch(() => {
        /* older server: no projects */
        setProjects([])
      })
  }, [])
  const loadSettings = useCallback(() => {
    api
      .settings()
      .then((s) => setSettings({ ...DEFAULT_SETTINGS, ...s, list: { ...DEFAULT_SETTINGS.list, ...(s?.list ?? {}) } }))
      .catch(() => {
        /* older server: defaults */
      })
  }, [])
  // Claude opened a page (mcp__minbox__open_url): open it here, in the
  // person's browser, not on the host. A page opened without a click is
  // usually blocked, so the browser being looked at tries, and every browser
  // offers it in a toast.
  const openForClaude = useRef((_url: string, _sessionId?: string) => {})
  openForClaude.current = (url: string, sessionId?: string) => {
    // Not 'noopener': with it window.open answers null even when it opened.
    const open = () => {
      const w = window.open(url, '_blank')
      if (w) w.opener = null
      return !!w
    }
    if (document.visibilityState === 'visible' && document.hasFocus() && open()) return
    const name = sessions?.find((s) => s.id === sessionId)?.name
    toast(`${name ? `${name}: ` : ''}Claude wants to open ${url}`, {
      action: 'Open',
      onAction: () => void open(),
      ms: 60_000,
    })
  }
  useEffect(() => {
    reloadSessions()
    loadSettings()
    reloadHosts()
    reloadProjects()
    return subscribe(
      (ev) => {
        if (ev.type === 'sessions') reloadSessions()
        if (ev.type === 'projects') reloadProjects()
        if (ev.type === 'threads') setThreadsVersion((v) => v + 1)
        if (ev.type === 'thread' && ev.thread_id) setThreadVersion((m) => ({ ...m, [ev.thread_id!]: (m[ev.thread_id!] ?? 0) + 1 }))
        if (ev.type === 'topics') setTopicsVersion((v) => v + 1)
        if (ev.type === 'tasks' || ev.type === 'thread' || ev.type === 'threads') window.dispatchEvent(new Event('minbox:v3'))
        if (ev.type === 'settings') loadSettings()
        if (ev.type === 'hosts') reloadHosts()
        if (ev.type === 'notifications') window.dispatchEvent(new Event('minbox:notifications'))
        if (ev.type === 'linear') window.dispatchEvent(new Event('minbox:linear'))
        if (ev.type === 'slack') window.dispatchEvent(new Event('minbox:slack'))
        if (ev.type === 'devices') setDevicesVersion((v) => v + 1)
        if (ev.type === 'open' && ev.url) openForClaude.current(ev.url, ev.session_id)
      },
      () => {
        reloadSessions()
        loadSettings()
        reloadHosts()
        reloadProjects()
        setThreadsVersion((v) => v + 1)
        setThreadVersion((m) => ({ ...m, [ALL_THREADS]: (m[ALL_THREADS] ?? 0) + 1 })) // events were missed: the open thread too
        setTopicsVersion((v) => v + 1)
        window.dispatchEvent(new Event('minbox:v3'))
      },
      setConn,
    )
  }, [reloadSessions, loadSettings, reloadHosts, reloadProjects])

  // The page comes back after a while hidden (a phone unlocked, a tab switched back to): what
  // arrived meanwhile may not have been delivered, so load it again.
  useEffect(() => {
    let hiddenAt: number | null = null
    const on = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      if (hiddenAt !== null && Date.now() - hiddenAt > 5000) {
        reloadSessions()
        setThreadsVersion((v) => v + 1)
        setThreadVersion((m) => ({ ...m, [ALL_THREADS]: (m[ALL_THREADS] ?? 0) + 1 }))
      }
      hiddenAt = null
    }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [reloadSessions])

  const saveSettings = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((s) => ({ ...s, ...patch }))
      api.saveSettings(patch).catch(error)
    },
    [error],
  )

  // Theme and text size.
  useEffect(() => {
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && !window.matchMedia('(prefers-color-scheme: light)').matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme])
  useEffect(() => {
    const z = (settings.text_size || 13) / 13
    ;(document.getElementById('root') as HTMLElement).style.zoom = z === 1 ? '' : String(z)
  }, [settings.text_size])
  useEffect(() => setSingleKeysEnabled(settings.single_key), [settings.single_key])

  // Layout.
  const setLayout = useCallback((patch: Partial<Layout>) => {
    setLayoutState((l) => {
      const next = { ...l, ...patch }
      try {
        localStorage.setItem('minbox:layout', JSON.stringify(next))
      } catch {
        /* storage blocked: the layout holds for this page only */
      }
      return next
    })
  }, [])

  // Attention: tab title, favicon, notifications and the chime.
  const prev = useRef<Map<string, { attention: number; stopped: number }>>(new Map())
  useEffect(() => {
    if (!sessions) return
    const live = sessions.filter((s) => !s.archived_at)
    const waiting = live.reduce((n, s) => n + attentionOf(s), 0)
    const unread = live.reduce((n, s) => n + s.unread, 0)
    const count = waiting > 0 ? waiting : unread
    document.title = settings.tab_count && count > 0 ? `(${count}) minbox` : 'minbox'
    setFaviconCount(settings.tab_count ? waiting : 0)
    const grew: Session[] = []
    let stoppedGrew = false
    for (const s of live) {
      const before = prev.current.get(s.id)
      const now = { attention: attentionOf(s), stopped: s.stopped ?? 0 }
      if (before && now.attention > before.attention) {
        grew.push(s)
        if (now.stopped > before.stopped) stoppedGrew = true
      }
      prev.current.set(s.id, now)
    }
    if (grew.length > 0 && document.visibilityState !== 'visible') {
      if (settings.notifications) {
        if (grew.length === 1) {
          const s = grew[0]!
          notify(
            `${s.name}: Claude Code ${stoppedGrew ? 'stopped on you' : 'is waiting on you'}`,
            s.top_thread?.subject ?? `${s.open_questions} open question${s.open_questions === 1 ? '' : 's'}`,
            () => navigate({ s: s.id, t: s.top_thread?.id ?? null }),
          )
        } else {
          notify(`${waiting} waiting in ${live.filter((s) => attentionOf(s) > 0).length} sessions`, grew.map((s) => s.name).join(', '))
        }
      }
      if (settings.sound) dingDong()
    }
  }, [sessions, settings.tab_count, settings.notifications, settings.sound, navigate])

  const value = useMemo<AppState>(
    () => ({
      route,
      navigate,
      goBack,
      back,
      sessions,
      setSessions,
      reloadSessions,
      settings,
      saveSettings,
      hosts,
      reloadHosts,
      projects,
      reloadProjects,
      conn,
      threadsVersion,
      threadVersion,
      topicsVersion,
      devicesVersion,
      toasts,
      toast,
      dismissToast,
      error,
      undoLast,
      layout,
      setLayout,
      overlay,
      setOverlay,
      isPhone,
      isTablet,
    }),
    [route, navigate, back, goBack, sessions, reloadSessions, settings, saveSettings, hosts, reloadHosts, projects, reloadProjects, conn, threadsVersion, threadVersion, topicsVersion, devicesVersion, toasts, toast, dismissToast, error, undoLast, layout, setLayout, overlay, isPhone, isTablet],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export { ATTENTION }
