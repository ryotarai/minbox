// ⌘K in v3: one list of actions, agents, tasks and projects, narrowed as you type. ">" shows only
// actions, "@" only agents, "#" only tasks, "!" only projects. Enter runs the highlighted row.
// (main's components/Palette.tsx, with tasks and agents instead of threads and sessions.)
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type Session } from '../api'
import { useApp } from '../lib/app'
import { agentKindLabel } from '../lib/agents'
import { homeRelative, isMac, shortTime } from '../lib/format'
import { fuzzyFields } from '../lib/fuzzy'
import { selectProject, shortDir, useProjectStats } from '../lib/projects'
import { useLinearStatus } from '../lib/issues'
import { useSlackStatus } from '../lib/slack'
import { ProjectDot } from '../components/ProjectRail'
import { IconSearch } from '../components/icons'
import { Kbd, Modal, cx } from '../components/ui'
import { v3, STATUS_LABEL, type BoardTask } from './data'
import type { SidePane } from './StreamView'

type Kind = 'action' | 'agent' | 'task' | 'project'
type Item = {
  kind: Kind
  id: string
  title: string
  detail?: string
  keywords?: string
  /** The agents of a task, searched too. */
  agentNames?: string
  projectName?: string
  shortcut?: string
  leading?: ReactNode
  waiting?: boolean
  unread?: boolean
  time?: string
  run: () => void
}

const KIND_LABEL: Record<Kind, string> = { action: 'Action', agent: 'Agent', task: 'Task', project: 'Project' }
const SECTION_LABEL: Record<Kind, string> = { action: 'Actions', agent: 'Agents', task: 'Tasks', project: 'Projects' }
const KIND_BIAS: Record<Kind, number> = { action: 3, project: 2.5, agent: 2, task: 0 }
const PREFIX: Record<string, Kind> = { '>': 'action', '@': 'agent', '#': 'task', '!': 'project' }

// ---- recently opened ----

const RECENT_KEY = 'minbox:v3-recent'
const RECENT_MAX = 8
type RecentRef = { k: 'agent' | 'task'; id: string }

function readRecent(): RecentRef[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as RecentRef[]
    return Array.isArray(v) ? v.filter((r) => r && (r.k === 'agent' || r.k === 'task') && typeof r.id === 'string') : []
  } catch {
    return []
  }
}
function remember(ref: RecentRef) {
  const list = [ref, ...readRecent().filter((r) => !(r.k === ref.k && r.id === ref.id))].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* storage full or off */
  }
}

function Highlight({ text, idx }: { text: string; idx: number[] }) {
  if (!idx.length) return <>{text}</>
  const on = new Set(idx)
  const out: ReactNode[] = []
  let i = 0
  while (i < text.length) {
    const hit = on.has(i)
    let j = i
    while (j < text.length && on.has(j) === hit) j++
    const part = text.slice(i, j)
    out.push(
      hit ? (
        <mark key={i} className="bg-transparent font-bold text-wait">
          {part}
        </mark>
      ) : (
        <span key={i}>{part}</span>
      ),
    )
    i = j
  }
  return <>{out}</>
}

/** The tasks the palette showed last: shown at once the next time, while they load again. */
let lastTasks: BoardTask[] = []

/** What the palette can act on: the open agent and its side pane, and V3App's dialogs. */
export type PaletteCtx = {
  agent: Session | undefined
  pane: SidePane
  setPane: (p: SidePane) => void
  openNew: (to?: string) => void
  openNewAgent: () => void
  openHelp: () => void
  rename: (s: Session) => void
}

export function V3Palette({ onClose, ctx }: { onClose: () => void; ctx: PaletteCtx }) {
  const { projects, reloadProjects, reloadSessions, sessions, navigate, setOverlay, settings, saveSettings, isPhone, error, toast } = useApp()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [tasks, setTasks] = useState<BoardTask[]>(lastTasks)
  const stats = useProjectStats()
  const linear = useLinearStatus()
  const slack = useSlackStatus()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mod = isMac() ? '⌘' : 'Ctrl+'

  // Every project's tasks (the Board of all projects).
  useEffect(() => {
    let live = true
    v3.board('')
      .then((b) => {
        lastTasks = b.tasks
        if (live) setTasks(b.tasks)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const cur = ctx.agent
  const go = (o: Parameters<typeof navigate>[0]) => navigate(o, { push: true })

  const actions = useMemo<Item[]>(() => {
    const list: Item[] = []
    const act = (id: string, title: string, run: () => void, o: Partial<Item> = {}) => list.push({ kind: 'action', id, title, run, ...o })
    act('new-message', 'New message', () => ctx.openNew(cur && cur.kind !== 'shell' ? cur.id : undefined), { keywords: 'compose write ask tell start task', shortcut: '⇧N' })
    act('new-agent', 'New agent', () => ctx.openNewAgent(), { keywords: 'new session create start claude pi opencode folder host' })
    act('board', 'Open Board', () => go({ view: 'main', k: null, s: null, m: null }), { keywords: 'home tasks questions needs you', shortcut: 'g b' })
    act('search', 'Search tasks and messages', () => go({ view: 'search' }), { keywords: 'find', shortcut: '/' })
    act('columns', 'Open Columns (tasks side by side)', () => go({ view: 'columns', k: null, s: null, m: null }), { keywords: 'columns side by side tweetdeck multi tasks working all', shortcut: 'g c' })
    if (isPhone) act('agents', 'Open Agents', () => go({ view: 'agents' }), { keywords: 'sessions list' })
    act('all-projects', 'All projects', () => selectProject(''), { keywords: 'project scope everything show' })
    act('new-project', 'New project', () => setOverlay({ kind: 'new-project' }), { keywords: 'add folder create' })
    if (linear.available) act('my-issues', 'Open My issues', () => go({ view: 'issues' }), { keywords: 'linear issues assigned' })
    if (slack.available) act('slack', 'Open Slack', () => go({ view: 'slack' }), { keywords: 'slack threads reply personal' })
    act('settings', 'Open Settings', () => go({ view: 'settings', ss: 'general' }), { keywords: 'preferences options' })
    act('devices', 'Open Devices', () => go({ view: 'settings', ss: 'devices' }), { keywords: 'paired browsers trust' })
    act('hosts', 'Open Hosts', () => go({ view: 'settings', ss: 'hosts' }), { keywords: 'remote machines servers' })
    act('integrations', 'Open Integrations', () => go({ view: 'settings', ss: 'integrations' }), { keywords: 'linear slack connect' })
    if (settings.decision_mode) act('decide', 'Decision mode', () => setOverlay({ kind: 'decide' }), { keywords: 'questions answer', shortcut: '⇧D' })
    act('shortcuts', 'Show keyboard shortcuts', () => ctx.openHelp(), { keywords: 'help keys hotkeys', shortcut: '?' })
    if (cur) {
      const label = agentKindLabel(cur.agent)
      const pane = (p: SidePane, on: string, off: string, kw: string, shortcut?: string) =>
        act(p + '-pane', ctx.pane === p ? off : on, () => ctx.setPane(ctx.pane === p ? 'tasks' : p), { keywords: `${kw} ${cur.name}`, shortcut })
      pane('terminal', `Show ${label} terminal`, `Hide ${label} terminal`, 'go to focus console claude code pane toggle', 'T')
      if (cur.kind !== 'shell' && cur.status !== 'ended') pane('shell', 'Open shell', 'Hide shell', 'companion terminal shell pane toggle folder cwd', 'Ctrl+`')
      pane('files', 'Show files', 'Hide files', 'file explorer tree browse folder git status', '⇧F')
      act('rename', 'Rename current agent', () => ctx.rename(cur), { keywords: `name session ${cur.name}` })
      if (cur.kind !== 'shell' && cur.project_id && !cur.is_main)
        act('set-main', "Set current agent as project's main agent", () => void api.setMainSession(cur.project_id!, cur.id).then(() => (reloadProjects(), reloadSessions())).catch(error), {
          keywords: `main default session target project ${cur.name}`,
        })
      if (cur.status === 'ended') act('resume', 'Resume current agent', () => void api.restartSession(cur.id).catch(error), { keywords: `start restart session ${cur.name}` })
      else {
        act('restart', 'Restart current agent', () => void api.restartSession(cur.id).catch(error), { keywords: `resume reload session ${cur.name}` })
        act('stop', 'Stop current agent', () => void api.stopSession(cur.id).catch(error), { keywords: `end kill quit session ${cur.name}` })
      }
    }
    if (!isPhone) act('swap', 'Swap side pane and stream', () => saveSettings({ swap_panes: !settings.swap_panes }), { keywords: 'panes layout left right terminal' })
    act('theme-dark', 'Theme: Dark', () => saveSettings({ theme: 'dark' }), { keywords: 'appearance color mode night' })
    act('theme-light', 'Theme: Light', () => saveSettings({ theme: 'light' }), { keywords: 'appearance color mode day' })
    act('theme-system', 'Theme: Match system', () => saveSettings({ theme: 'system' }), { keywords: 'appearance color mode auto' })
    const size = settings.text_size || 13
    if (size < 15) act('text-up', 'Larger text', () => saveSettings({ text_size: size + 1 }), { keywords: 'text size font zoom bigger increase' })
    if (size > 12) act('text-down', 'Smaller text', () => saveSettings({ text_size: size - 1 }), { keywords: 'text size font zoom decrease' })
    if (size !== 13) act('text-reset', 'Reset text size', () => saveSettings({ text_size: 13 }), { keywords: 'text font zoom default' })
    return list.map((a) => ({ ...a, shortcut: a.shortcut?.replace(/⌘/g, mod) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, ctx.pane, isPhone, linear.available, slack.available, settings.decision_mode, settings.swap_panes, settings.text_size, mod])

  const projectName = (id?: string) => projects?.find((p) => p.id === id)?.name ?? ''

  const agentItems = useMemo<Item[]>(
    () =>
      (sessions ?? [])
        .filter((s) => !s.archived_at)
        .map((s: Session) => ({
          kind: 'agent' as const,
          id: s.id,
          title: s.name,
          detail: (projectName(s.project_id) ? `${projectName(s.project_id)} · ` : '') + homeRelative(s.cwd) + (s.host_name ? ` · ${s.host_name}` : ''),
          projectName: projectName(s.project_id),
          keywords: [s.title, s.kind === 'shell' ? 'shell' : agentKindLabel(s.agent), s.is_main ? 'main' : ''].filter(Boolean).join(' '),
          unread: s.unread > 0,
          run: () => {
            remember({ k: 'agent', id: s.id })
            navigate({ view: 'agent', s: s.id, m: null, tab: s.kind === 'shell' ? 'terminal' : 'inbox' }, { push: true })
          },
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, projects, navigate],
  )

  const projectItems = useMemo<Item[]>(
    () =>
      (projects ?? []).map((p) => ({
        kind: 'project' as const,
        id: p.id,
        title: p.name,
        detail: shortDir(p.dir, 40) + (p.host_id !== 'local' ? ` · ${p.host_name ?? p.host_id}` : ''),
        keywords: `project ${p.dir} ${p.host_name ?? ''}`,
        leading: <ProjectDot stat={stats.get(p.id)} size={8} />,
        waiting: (stats.get(p.id)?.waiting ?? 0) > 0,
        run: () => selectProject(p.id),
      })),
    [projects, stats],
  )

  const taskItems = useMemo<Item[]>(() => {
    const name = (id: string) => sessions?.find((s) => s.id === id)?.name ?? ''
    return [...tasks]
      .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime())
      .map((t) => {
        const agents = t.agents.map((a) => name(a.session_id)).filter(Boolean)
        const pn = projectName(t.project_id)
        return {
          kind: 'task' as const,
          id: t.id,
          title: t.title || '(untitled)',
          detail: [pn, agents.join(', '), STATUS_LABEL[t.status]].filter(Boolean).join(' · '),
          agentNames: agents.join(' '),
          projectName: pn,
          keywords: [t.kind === 'goal' ? 'goal' : '', t.status === 'done' ? 'done' : ''].filter(Boolean).join(' '),
          waiting: t.status === 'needs_you',
          unread: (t.unread ?? 0) > 0,
          time: shortTime(t.last_activity),
          run: () => {
            remember({ k: 'task', id: t.id })
            navigate({ view: 'task', k: t.id, m: null }, { push: true })
          },
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, sessions, projects])

  const only = PREFIX[q[0] ?? '']
  const text = only ? q.slice(1) : q
  const searching = text.trim() !== ''

  const rows = useMemo<{ item: Item; idx: number[]; head?: string }[]>(() => {
    const pool: Item[] = [...actions, ...projectItems, ...agentItems, ...taskItems].filter((i) => !only || i.kind === only)
    if (searching) {
      return pool
        .map((item, order) => {
          const m = fuzzyFields(text, [
            { text: item.title, weight: 1 },
            { text: item.keywords ?? '', weight: 0.7 },
            { text: item.agentNames ?? '', weight: 0.6 },
            { text: item.projectName ?? '', weight: 0.5 },
            ...(item.kind === 'agent' ? [{ text: item.detail ?? '', weight: 0.4 }] : []),
          ])
          return m ? { item, idx: m.idx, score: m.score + KIND_BIAS[item.kind], order } : null
        })
        .filter((r): r is NonNullable<typeof r> => !!r)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, 100)
        .map(({ item, idx }) => ({ item, idx }))
    }
    const out: { item: Item; idx: number[]; head?: string }[] = []
    if (!only) {
      const used = new Set<Item>()
      const heads: Item[] = []
      for (const r of readRecent()) {
        const it = (r.k === 'agent' ? agentItems : taskItems).find((x) => x.id === r.id)
        if (it) {
          heads.push(it)
          used.add(it)
        }
      }
      heads.forEach((item, i) => out.push({ item, idx: [], head: i === 0 ? 'Recent' : undefined }))
      actions.forEach((item, i) => out.push({ item, idx: [], head: i === 0 ? 'Actions' : undefined }))
      projectItems.forEach((item, i) => out.push({ item, idx: [], head: i === 0 ? 'Projects' : undefined }))
      agentItems.filter((i) => !used.has(i)).forEach((item, i) => out.push({ item, idx: [], head: i === 0 ? 'Agents' : undefined }))
      return out
    }
    pool.slice(0, 200).forEach((item, i) => out.push({ item, idx: [], head: i === 0 ? SECTION_LABEL[item.kind] : undefined }))
    return out
  }, [actions, projectItems, agentItems, taskItems, only, text, searching])

  useEffect(() => setSel(0), [q])
  useEffect(() => setSel((s) => Math.min(s, Math.max(rows.length - 1, 0))), [rows.length])
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [sel, rows])

  const run = (item: Item) => {
    onClose()
    try {
      item.run()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { error: true })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const last = rows.length - 1
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey
    if (e.key === 'ArrowDown' || (ctrl && e.key.toLowerCase() === 'n')) {
      e.preventDefault()
      setSel((s) => (s >= last ? 0 : s + 1))
    } else if (e.key === 'ArrowUp' || (ctrl && e.key.toLowerCase() === 'p')) {
      e.preventDefault()
      setSel((s) => (s <= 0 ? Math.max(last, 0) : s - 1))
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      setSel((s) => Math.min(s + 8, last))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      setSel((s) => Math.max(s - 8, 0))
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault()
      setSel(0)
    } else if (e.key === 'End' && e.ctrlKey) {
      e.preventDefault()
      setSel(Math.max(last, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = rows[sel]
      if (r) run(r.item)
    } else if (e.key === 'Tab') {
      e.preventDefault()
    }
  }

  const placeholder = only ? { action: 'Run an action', agent: 'Go to an agent', task: 'Open a task', project: 'Switch project' }[only] : 'Go to a task or agent, or run an action'
  return (
    <Modal label="Quick actions" onClose={onClose} className="flex max-h-[min(70vh,640px)] w-[min(640px,100%)] flex-col overflow-hidden" top>
      <div data-testid="palette" className="flex min-h-0 flex-1 flex-col">
        <label className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line2 px-4">
          <IconSearch size={18} className="text-muted" />
          <input
            ref={inputRef}
            data-testid="palette-input"
            aria-label="Quick actions"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows[sel] ? `palette-row-${sel}` : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={q}
            placeholder={placeholder}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 border-0 bg-transparent text-[16px] text-fg outline-none placeholder:text-faint"
          />
          <Kbd>Esc</Kbd>
        </label>
        <div ref={listRef} id="palette-list" role="listbox" data-testid="palette-list" className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {rows.length === 0 && (
            <div data-testid="palette-empty" className="px-4 py-8 text-center text-[13px] text-muted">
              Nothing matches "{text.trim()}"
            </div>
          )}
          {rows.map(({ item, idx, head }, i) => (
            <div key={`${item.kind}:${item.id}`}>
              {head && !searching && <div className="px-4 pb-1 pt-2.5 text-[11px] font-bold uppercase tracking-[0.06em] text-subtle">{head}</div>}
              <div
                id={`palette-row-${i}`}
                role="option"
                aria-selected={i === sel}
                data-testid="palette-item"
                data-kind={item.kind}
                data-id={item.id}
                data-selected={i === sel}
                onMouseMove={() => i !== sel && setSel(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(item)}
                className={cx('flex min-h-10 cursor-default items-center gap-2.5 px-4 py-1.5 text-left', i === sel ? 'bg-sel' : 'bg-transparent')}
              >
                <span className="flex w-4 shrink-0 items-center justify-center">
                  {item.leading ?? (
                    <span aria-hidden="true" className="mono text-[12px] text-muted">
                      {item.kind === 'action' ? '›' : item.kind === 'agent' ? '@' : '#'}
                    </span>
                  )}
                </span>
                <span className={cx('min-w-0 truncate text-[14px]', (item.waiting || item.unread) && item.kind !== 'action' ? 'font-semibold' : 'font-medium')}>
                  <Highlight text={item.title} idx={idx} />
                </span>
                {item.unread && item.kind !== 'action' && <span aria-label="Unread" data-testid="palette-unread" className="h-[7px] w-[7px] shrink-0 rounded-full bg-wait" />}
                {item.waiting && (
                  <span data-testid="palette-waiting" className="shrink-0 rounded-full bg-wait/15 px-2 text-[11px] font-semibold leading-[18px] text-waitfg">
                    Needs you
                  </span>
                )}
                {item.detail && <span className={cx('min-w-0 flex-1 truncate text-[12.5px] text-muted', item.kind === 'agent' && 'mono')}>{item.detail}</span>}
                {!item.detail && <span className="flex-1" />}
                {item.time && <span className="shrink-0 text-[11.5px] text-subtle">{item.time}</span>}
                {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                {searching && <span className="shrink-0 rounded bg-chip px-1.5 text-[10.5px] font-semibold uppercase leading-[18px] tracking-[0.04em] text-subtle">{KIND_LABEL[item.kind]}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-t border-line2 px-4 py-2.5 text-[12px] text-subtle">
          <span>
            <kbd className="text-fg2">↑↓</kbd> move
          </span>
          <span>
            <kbd className="text-fg2">↵</kbd> run
          </span>
          <span className="flex-1" />
          <span data-testid="palette-hint">
            <kbd className="text-fg2">&gt;</kbd> actions · <kbd className="text-fg2">@</kbd> agents · <kbd className="text-fg2">#</kbd> tasks · <kbd className="text-fg2">!</kbd> projects
          </span>
        </div>
      </div>
    </Modal>
  )
}
