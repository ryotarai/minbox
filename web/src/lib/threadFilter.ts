import { useSyncExternalStore } from 'react'

/** How the threads pane filters and groups the all-sessions list. Kept in this browser. */
export type ThreadFilter = {
  show: 'all' | 'waiting' | 'unread'
  /** Only this session's threads; '' = every session. */
  session: string
  group: 'activity' | 'status' | 'session'
}

const KEY = 'minbox:v2-filter'
const DEFAULT: ThreadFilter = { show: 'all', session: '', group: 'activity' }

function read(): ThreadFilter {
  try {
    const v = localStorage.getItem(KEY)
    if (v) return { ...DEFAULT, ...JSON.parse(v) }
  } catch {
    /* ignore */
  }
  return DEFAULT
}

let cur = read()
const listeners = new Set<() => void>()

export function setThreadFilter(patch: Partial<ThreadFilter>) {
  cur = { ...cur, ...patch }
  localStorage.setItem(KEY, JSON.stringify(cur))
  listeners.forEach((l) => l())
}

export function useThreadFilter(): ThreadFilter {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => cur,
  )
}

/**
 * The session a new message is composed to. `id` is the last one picked (also the fallback, kept
 * across reloads); `at` is the selected session when it was picked: the pick holds only while the
 * person stays on that session, then the target follows the selection again.
 */
const TARGET_KEY = 'minbox:v2-target'
let target: { id: string; at: string | null } = (() => {
  try {
    return { id: localStorage.getItem(TARGET_KEY) ?? '', at: null }
  } catch {
    return { id: '', at: null }
  }
})()
const tListeners = new Set<() => void>()

export function setComposeTarget(id: string, at: string | null) {
  target = { id, at }
  localStorage.setItem(TARGET_KEY, id)
  tListeners.forEach((l) => l())
}

export function useComposeTargetPick(): { id: string; at: string | null } {
  return useSyncExternalStore(
    (l) => {
      tListeners.add(l)
      return () => tListeners.delete(l)
    },
    () => target,
  )
}
