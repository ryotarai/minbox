import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type SlackItem, type SlackListResult, type SlackStatus } from '../api'

// Slack (personal): the connection state for the rail entry and the list of threads that need my
// reply, with stale-while-revalidate (memory, then the server's stored list, then a refresh). Nothing
// polls: the list is refreshed when the screen opens and when the person presses Refresh. While a
// refresh runs, the server's progress events re-read the stored list so partial results appear.

let status: SlackStatus | null = null
let statusLoaded = false
const listeners = new Set<() => void>()
let statusTimer: ReturnType<typeof setTimeout> | null = null

function loadStatus() {
  api
    .slackStatus()
    .then((s) => {
      status = s
      statusLoaded = true
      listeners.forEach((l) => l())
    })
    .catch(() => {})
}

if (typeof window !== 'undefined')
  window.addEventListener('minbox:slack', () => {
    if (statusTimer) clearTimeout(statusTimer)
    statusTimer = setTimeout(loadStatus, 300)
  })

/** The personal Slack token: the entry shows only while it is connected. */
export function useSlackStatus(): { status: SlackStatus | null; known: boolean; available: boolean } {
  const [, tick] = useState(0)
  useEffect(() => {
    const l = () => tick((n) => n + 1)
    listeners.add(l)
    if (!statusLoaded) loadStatus()
    return () => void listeners.delete(l)
  }, [])
  return { status, known: statusLoaded, available: !!status?.connected }
}

let memory: SlackListResult | null = null

export type SlackState = {
  data: SlackListResult | null
  syncing: boolean
  error: { message: string; status?: number } | null
  refresh: () => void
  /** Re-read the stored list (after dismiss / snooze / start thread). */
  reload: () => void
}

export function useSlackThreads(): SlackState {
  const [data, setData] = useState<SlackListResult | null>(memory)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<SlackState['error']>(null)
  const live = useRef(true)
  const seq = useRef(0)
  const running = useRef(false)
  useEffect(() => {
    live.current = true
    return () => void (live.current = false)
  }, [])
  const apply = useCallback((r: SlackListResult) => {
    memory = r
    setData(r)
  }, [])
  const readStored = useCallback(async () => {
    try {
      const c = await api.slackThreads({ cached: true })
      if (live.current) apply(c)
    } catch {
      /* the refresh reports errors */
    }
  }, [apply])

  const run = useCallback(
    async (force: boolean) => {
      const n = ++seq.current
      running.current = true
      setSyncing(true)
      setError(null)
      try {
        if (!memory) await readStored()
        const r = await api.slackThreads({ refresh: force })
        if (!live.current || n !== seq.current) return
        apply(r)
      } catch (e) {
        if (!live.current || n !== seq.current) return
        setError({ message: e instanceof Error ? e.message : String(e), status: (e as { status?: number }).status })
      } finally {
        if (live.current && n === seq.current) {
          running.current = false
          setSyncing(false)
        }
      }
    },
    [apply, readStored],
  )
  useEffect(() => {
    void run(false)
  }, [run])
  // While a refresh runs the server announces progress; re-read what is stored so far.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const on = () => {
      if (!running.current || t) return
      t = setTimeout(() => {
        t = null
        void readStored()
      }, 500)
    }
    window.addEventListener('minbox:slack', on)
    return () => {
      window.removeEventListener('minbox:slack', on)
      if (t) clearTimeout(t)
    }
  }, [readStored])
  const refresh = useCallback(() => void run(true), [run])
  const reload = useCallback(() => void readStored(), [readStored])
  return { data, syncing, error, refresh, reload }
}

export const GROUP_TITLES: Record<string, string> = { needs_reply: 'Needs reply', maybe: 'Maybe', dismissed: 'Dismissed / Snoozed' }

/** Client-side search over what a row shows. */
export function matchesSlack(i: SlackItem, q: string): boolean {
  const t = q.trim().toLowerCase()
  if (!t) return true
  const hay = [i.label, i.people.join(' '), i.snippet, i.last_author, i.judgement?.reason ?? '', i.judgement?.summary ?? ''].join(' ').toLowerCase()
  return t.split(/\s+/).every((w) => hay.includes(w))
}

const LAST_PROJECT_KEY = 'minbox.slack.lastProject'
export const lastSlackProject = () => {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) ?? ''
  } catch {
    return ''
  }
}
export const rememberSlackProject = (id: string) => {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id)
  } catch {
    /* private mode */
  }
}

/** "Tomorrow" for Snooze: 9:00 the next morning, local time. */
export function tomorrowMorning(now = new Date()): Date {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d
}
