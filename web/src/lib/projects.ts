import { useMemo } from 'react'
import { ATTENTION, type Project, type Session } from '../api'
import { useApp } from './app'
import { homeRelative } from './format'
import { setThreadFilter, useThreadFilter } from './threadFilter'

/** Folder shown short: `~/work/api`, `…/work/api` when still long. */
export function shortDir(dir: string, max = 26): string {
  if (!dir) return 'no folder'
  const d = homeRelative(dir)
  if (d.length <= max) return d
  const parts = d.split('/').filter(Boolean)
  let out = parts[parts.length - 1] ?? d
  for (let i = parts.length - 2; i >= 0 && (parts[i]! + '/' + out).length < max - 2; i--) out = parts[i] + '/' + out
  return '…/' + out
}

export type ProjectStat = {
  /** Threads waiting on the person (stopped, holding, waiting). */
  waiting: number
  unread: number
  /** Sessions that are not ended or archived. */
  live: number
  working: number
  /** The busiest session state, for the dot. */
  state: 'waiting' | 'working' | 'idle' | 'ended' | 'empty'
}

export function statOf(sessions: Session[]): ProjectStat {
  const live = sessions.filter((s) => !s.archived_at)
  const waiting = live.reduce((n, s) => n + (s.waiting ?? 0), 0)
  const unread = live.reduce((n, s) => n + (s.unread ?? 0), 0)
  const running = live.filter((s) => s.status !== 'ended')
  const working = running.filter((s) => s.status === 'working').length
  const state = waiting > 0 ? 'waiting' : working > 0 ? 'working' : running.length > 0 ? 'idle' : live.length > 0 ? 'ended' : 'empty'
  return { waiting, unread, live: running.length, working, state }
}

/** Stats per project id (and '' = all projects), from the sessions list. */
export function useProjectStats(): Map<string, ProjectStat> {
  const { sessions } = useApp()
  return useMemo(() => {
    const by = new Map<string, Session[]>()
    for (const s of sessions ?? []) {
      const k = s.project_id ?? ''
      by.set(k, [...(by.get(k) ?? []), s])
    }
    const out = new Map<string, ProjectStat>()
    for (const [k, v] of by) out.set(k, statOf(v))
    out.set('', statOf(sessions ?? []))
    return out
  }, [sessions])
}

/** The selected project: '' = All projects (also when the remembered one is gone). */
export function useSelectedProject(): { id: string; project: Project | null } {
  const { projects } = useApp()
  const filter = useThreadFilter()
  const project = projects?.find((p) => p.id === filter.project) ?? null
  return { id: project?.id ?? '', project }
}

/** Selecting a project scopes the list; the session filter goes (it belongs to another scope). */
export function selectProject(id: string) {
  setThreadFilter({ project: id, session: '' })
}

export function projectOf(projects: Project[] | null, s: { project_id?: string }): Project | undefined {
  return projects?.find((p) => p.id === s.project_id)
}

/** Sessions of the selected project, live ones (not archived). */
export function useScopedSessions(): Session[] {
  const { sessions } = useApp()
  const { id } = useSelectedProject()
  return useMemo(() => (sessions ?? []).filter((s) => !s.archived_at && (!id || s.project_id === id)), [sessions, id])
}

export { ATTENTION }
