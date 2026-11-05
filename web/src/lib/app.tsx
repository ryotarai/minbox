import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  ATTENTION,
  DEFAULT_SETTINGS,
  api,
  subscribe,
  type ConnectionState,
  type Host,
  type Session,
  type Settings,
} from '../api'
import { dingDong, notify, setFaviconCount } from './alerts'
import { setSingleKeysEnabled } from './hotkeys'

// ---- route: the URL hash ----

export type View = 'main' | 'settings' | 'board' | 'review' | 'inbox'
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
  /** Phone: the session screen's tab. */
  tab: 'inbox' | 'terminal'
  /** Settings section. */
  ss: string
}

function readRoute(): Route {
  const p = new URLSearchParams(location.hash.slice(1))
  const view = (p.get('v') as View) || 'main'
  return {
    s: p.get('s'),
    t: p.get('t'),
    f: p.get('f'),
    view: ['main', 'settings', 'board', 'review', 'inbox'].includes(view) ? view : 'main',
    r: p.get('r'),
    tab: p.get('tab') === 'terminal' ? 'terminal' : 'inbox',
    ss: p.get('ss') || 'general',
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
  const h = p.toString()
  return h ? `#${h}` : location.pathname
}

export function threadLink(sessionId: string, threadId: string): string {
  return `${location.origin}${location.pathname}#s=${sessionId}&t=${threadId}`
}

// ---- phone ----

const phoneQuery = window.matchMedia('(max-width: 767px)')
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    (l) => {
      phoneQuery.addEventListener('change', l)
      return () => phoneQuery.removeEventListener('change', l)
    },
    () => phoneQuery.matches,
  )
}

// ---- layout preferences (this browser) ----

/** In `threadVersion`: bumped when every open thread should load again. */
export const ALL_THREADS = '*'

export type Layout = { sidebarW: number; inboxW: number; threadW: number; rail: boolean; inboxCollapsed: boolean; shellW: number; shellPane: boolean }
function defaultLayout(): Layout {
  const w = window.innerWidth
  if (w >= 1680) return { sidebarW: 380, inboxW: 480, threadW: 620, rail: false, inboxCollapsed: false, shellW: 560, shellPane: false }
  if (w >= 1440) return { sidebarW: 340, inboxW: 480, threadW: 520, rail: false, inboxCollapsed: false, shellW: 520, shellPane: false }
  if (w >= 1200) return { sidebarW: 272, inboxW: 440, threadW: 520, rail: false, inboxCollapsed: false, shellW: 460, shellPane: false }
  return { sidebarW: 250, inboxW: 380, threadW: 480, rail: false, inboxCollapsed: false, shellW: 400, shellPane: false }
}
function readLayout(): Layout {
  try {
    const v = localStorage.getItem('minbox:layout')
    if (v) return { ...defaultLayout(), ...JSON.parse(v) }
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
  | { kind: 'compose'; sessionId?: string; draftId?: string }
  | { kind: 'delete-session'; session: Session }
  | { kind: 'drafts' }
  | { kind: 'new-session' }
  | null

type AppState = {
  route: Route
  navigate: (patch: Partial<Route>, opts?: { push?: boolean }) => void
  back: () => void
  sessions: Session[] | null
  setSessions: React.Dispatch<React.SetStateAction<Session[] | null>>
  reloadSessions: () => void
  hosts: Host[]
  reloadHosts: () => void
  settings: Settings
  saveSettings: (patch: Partial<Settings>) => void
  conn: ConnectionState
  threadsVersion: number
  threadVersion: Record<string, number>
  cardsVersion: number
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
  const [route, setRoute] = useState<Route>(readRoute)
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [hosts, setHosts] = useState<Host[]>([])
  const [conn, setConn] = useState<ConnectionState>({ connected: true, attempts: 0, since: null })
  const [threadsVersion, setThreadsVersion] = useState(0)
  const [threadVersion, setThreadVersion] = useState<Record<string, number>>({})
  const [cardsVersion, setCardsVersion] = useState(0)
  const [devicesVersion, setDevicesVersion] = useState(0)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [layout, setLayoutState] = useState<Layout>(readLayout)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const toastId = useRef(0)

  // Route ↔ hash.
  useEffect(() => {
    const on = () => setRoute(readRoute())
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
      const push = opts?.push ?? isPhone
      if (push) history.pushState(null, '', h)
      else history.replaceState(null, '', h)
      routeRef.current = next
      setRoute(next)
    },
    [isPhone],
  )
  const back = useCallback(() => history.back(), [])

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
    api.sessions().then(setSessions).catch(error)
  }, [error])
  const reloadHosts = useCallback(() => {
    api
      .hosts()
      .then(setHosts)
      .catch(() => {
        /* older server: no hosts */
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
    return subscribe(
      (ev) => {
        if (ev.type === 'sessions') reloadSessions()
        if (ev.type === 'threads') setThreadsVersion((v) => v + 1)
        if (ev.type === 'thread' && ev.thread_id) setThreadVersion((m) => ({ ...m, [ev.thread_id!]: (m[ev.thread_id!] ?? 0) + 1 }))
        if (ev.type === 'cards') setCardsVersion((v) => v + 1)
        if (ev.type === 'settings') loadSettings()
        if (ev.type === 'hosts') reloadHosts()
        if (ev.type === 'devices') setDevicesVersion((v) => v + 1)
        if (ev.type === 'open' && ev.url) openForClaude.current(ev.url, ev.session_id)
      },
      () => {
        reloadSessions()
        loadSettings()
        reloadHosts()
        setThreadsVersion((v) => v + 1)
        setThreadVersion((m) => ({ ...m, [ALL_THREADS]: (m[ALL_THREADS] ?? 0) + 1 })) // events were missed: the open thread too
        setCardsVersion((v) => v + 1)
      },
      setConn,
    )
  }, [reloadSessions, loadSettings, reloadHosts])

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
      localStorage.setItem('minbox:layout', JSON.stringify(next))
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
      back,
      sessions,
      setSessions,
      reloadSessions,
      settings,
      saveSettings,
      hosts,
      reloadHosts,
      conn,
      threadsVersion,
      threadVersion,
      cardsVersion,
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
    }),
    [route, navigate, back, sessions, reloadSessions, settings, saveSettings, hosts, reloadHosts, conn, threadsVersion, threadVersion, cardsVersion, devicesVersion, toasts, toast, dismissToast, error, undoLast, layout, setLayout, overlay, isPhone],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export { ATTENTION }
