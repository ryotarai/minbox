import { useMemo } from 'react'
import type { Project, Session } from '../api'
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
  /** Tasks and goals of the project whose status is needs_you (from the server; an open question alone never counts). */
  needsYou: number
  unread: number
  /** Sessions that are not ended or archived. */
  live: number
  working: number
  /** The busiest state, for the dot: 'waiting' when a task needs you. */
  state: 'waiting' | 'working' | 'idle' | 'ended' | 'empty'
}

export function statOf(sessions: Session[], needsYou: number): ProjectStat {
  const live = sessions.filter((s) => !s.archived_at)
  const unread = live.reduce((n, s) => n + (s.unread ?? 0), 0)
  const running = live.filter((s) => s.status !== 'ended')
  const working = running.filter((s) => s.status === 'working').length
  const state = needsYou > 0 ? 'waiting' : working > 0 ? 'working' : running.length > 0 ? 'idle' : live.length > 0 ? 'ended' : 'empty'
  return { needsYou, unread, live: running.length, working, state }
}

/** Stats per project id (and '' = all projects), from the sessions list and the projects' needs_you counts. */
export function useProjectStats(): Map<string, ProjectStat> {
  const { sessions, projects } = useApp()
  return useMemo(() => {
    const by = new Map<string, Session[]>()
    for (const s of sessions ?? []) {
      const k = s.project_id ?? ''
      by.set(k, [...(by.get(k) ?? []), s])
    }
    const needs = new Map<string, number>()
    let all = 0
    for (const p of projects ?? []) {
      needs.set(p.id, p.needs_you ?? 0)
      all += p.needs_you ?? 0
      if (!by.has(p.id)) by.set(p.id, [])
    }
    const out = new Map<string, ProjectStat>()
    for (const [k, v] of by) {
      if (k) out.set(k, statOf(v, needs.get(k) ?? 0))
    }
    out.set('', statOf(sessions ?? [], all))
    return out
  }, [sessions, projects])
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

