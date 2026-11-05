import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ATTENTION, api, type Session, type Thread } from '../api'
import { useApp } from '../lib/app'
import { homeRelative, isMac, shortTime } from '../lib/format'
import { fuzzyFields } from '../lib/fuzzy'
import { selectProject, shortDir, useProjectStats } from '../lib/projects'
import { ProjectDot } from './ProjectRail'
import { IconSearch } from './icons'
import { Kbd, Modal, StatusDot, cx } from './ui'
import { sectionOf, waitsOnPerson } from './Sidebar'

// ⌘K: one list of actions, sessions and threads, narrowed as you type. ">" shows only actions,
// "@" only sessions, "#" only threads, "!" only projects. Enter runs the highlighted row.

type Kind = 'action' | 'session' | 'thread' | 'project'
type Item = {
  kind: Kind
  /** Unique within its kind. */
  id: string
  title: string
  /** Muted text after the title (the cwd, the session of a thread). */
  detail?: string
  /** Searched but not shown. */
  keywords?: string
  /** The session a thread belongs to, searched too. */
  sessionName?: string
  /** The project of a session or thread, searched too. */
  projectName?: string
  shortcut?: string
  leading?: ReactNode
  /** A thread waiting on the person / an unread thread. */
  waiting?: boolean
  unread?: boolean
  time?: string
  run: () => void
}

const KIND_LABEL: Record<Kind, string> = { action: 'Action', session: 'Session', thread: 'Thread', project: 'Project' }
const SECTION_LABEL: Record<Kind, string> = { action: 'Actions', session: 'Sessions', thread: 'Threads', project: 'Projects' }
const KIND_BIAS: Record<Kind, number> = { action: 3, project: 2.5, session: 2, thread: 0 }
const PREFIX: Record<string, Kind> = { '>': 'action', '@': 'session', '#': 'thread', '!': 'project' }

// ---- recently opened ----

const RECENT_KEY = 'minbox:recent'
const RECENT_MAX = 8
type RecentRef = { k: 'session' | 'thread'; id: string }

function readRecent(): RecentRef[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as RecentRef[]
    return Array.isArray(v) ? v.filter((r) => r && (r.k === 'session' || r.k === 'thread') && typeof r.id === 'string') : []
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

// ---- focus helpers ----

function focusTerminal() {
  setTimeout(() => (window as unknown as { __minboxTerminal?: { focus: () => void } }).__minboxTerminal?.focus(), 120)
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

/** ⌘K / "/": jump to a session or thread, or run an action. */
export function Palette({ onClose }: { onClose: () => void }) {
  const { projects, reloadProjects, reloadSessions, route, sessions, navigate, setOverlay, layout, setLayout, settings, saveSettings, isPhone, threadsVersion, error, toast } = useApp()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [threads, setThreads] = useState<Thread[]>([])
  const stats = useProjectStats()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mod = isMac() ? '⌘' : 'Ctrl+'

  useEffect(() => {
    let live = true
    api
      .allThreads()
      .then((t) => live && setThreads(t))
      .catch((e) => live && error(e))
    return () => {
      live = false
    }
  }, [threadsVersion, error])

  const current = sessions?.find((s) => s.id === route.s) ?? null
  const isClaude = !!current && current.kind !== 'shell'

  const actions = useMemo<Item[]>(() => {
    const list: Item[] = []
    const act = (id: string, title: string, run: () => void, o: Partial<Item> = {}) => list.push({ kind: 'action', id, title, run, ...o })
    act('new-session', 'New session', () => setOverlay({ kind: 'new-session' }), { keywords: 'create start claude shell terminal' })
    if (isClaude) {
      act(
        'new-message',
        'New message to current session',
        () => {
          const box = document.querySelector<HTMLElement>('[data-testid="quick-body"]')
          if (box) box.focus()
          else setOverlay({ kind: 'compose', sessionId: current!.id })
        },
        { keywords: `compose write reply send ${current!.name}`, shortcut: 'R' },
      )
    }
    act('all-projects', 'All projects', () => selectProject(''), { keywords: 'project scope everything show' })
    if (isClaude && current!.project_id && !current!.is_main)
      act('set-main', "Set current session as project's main session", () => void api.setMainSession(current!.project_id!, current!.id).then(() => (reloadProjects(), reloadSessions())).catch(error), { keywords: `main default thread target project ${current!.name}` })
    act('inbox', 'Open All inbox', () => navigate({ view: 'inbox' }), { keywords: 'threads messages everything' })
    if (settings.board) act('board', 'Open Board', () => navigate({ view: 'board' }), { keywords: 'cards kanban' })
    act('settings', 'Open Settings', () => navigate({ view: 'settings', ss: 'general' }), { keywords: 'preferences options' })
    act('devices', 'Open Devices', () => navigate({ view: 'settings', ss: 'devices' }), { keywords: 'paired browsers trust' })
    act('hosts', 'Open Hosts', () => navigate({ view: 'settings', ss: 'hosts' }), { keywords: 'remote machines servers' })
    act('drafts', 'Show drafts', () => setOverlay({ kind: 'drafts' }), { keywords: 'unsent' })
    if (settings.decision_mode) act('decide', 'Decision mode', () => setOverlay({ kind: 'decide' }), { keywords: 'questions answer', shortcut: '⇧D' })
    act('shortcuts', 'Show keyboard shortcuts', () => setOverlay({ kind: 'shortcuts' }), { keywords: 'help keys hotkeys', shortcut: '?' })
    if (current) {
      act(
        'go-terminal',
        'Go to terminal',
        () => {
          if (isPhone) navigate({ view: 'main', tab: 'terminal', t: null, f: null })
          else {
            navigate({ view: 'main', f: null })
            focusTerminal()
          }
        },
        { keywords: `focus console ${current.name}` },
      )
      if (isClaude)
        act('go-inbox', 'Go to inbox', () => navigate({ view: 'main', tab: 'inbox', t: null, f: null }), {
          keywords: `threads list close thread ${current.name}`,
        })
      if (current.status === 'ended') {
        act('resume', 'Resume current session', () => void api.restartSession(current.id).catch(error), { keywords: `start restart ${current.name}` })
      } else {
        act('restart', 'Restart current session', () => void api.restartSession(current.id).catch(error), { keywords: `resume reload ${current.name}` })
        act('stop', 'Stop current session', () => void api.stopSession(current.id).catch(error), { keywords: `end kill quit ${current.name}` })
      }
    }
    if (!isPhone) {
      if (isClaude) act('shell-pane', layout.shellPane ? 'Hide shell pane' : 'Show shell pane', () => setLayout({ shellPane: !layout.shellPane }), { keywords: 'companion terminal toggle', shortcut: 'Ctrl+`' })
      act('swap', 'Swap terminal and inbox', () => saveSettings({ swap_panes: !settings.swap_panes }), { keywords: 'panes layout left right' })
    }
    act('theme-dark', 'Theme: Dark', () => saveSettings({ theme: 'dark' }), { keywords: 'appearance color mode night' })
    act('theme-light', 'Theme: Light', () => saveSettings({ theme: 'light' }), { keywords: 'appearance color mode day' })
    act('theme-system', 'Theme: Match system', () => saveSettings({ theme: 'system' }), { keywords: 'appearance color mode auto' })
    const size = settings.text_size || 13
    if (size < 15) act('text-up', 'Larger text', () => saveSettings({ text_size: size + 1 }), { keywords: 'text size font zoom bigger increase' })
    if (size > 12) act('text-down', 'Smaller text', () => saveSettings({ text_size: size - 1 }), { keywords: 'text size font zoom decrease' })
    if (size !== 13) act('text-reset', 'Reset text size', () => saveSettings({ text_size: 13 }), { keywords: 'text font zoom default' })
    return list.map((a) => ({ ...a, shortcut: a.shortcut?.replace(/⌘/g, mod) }))
  }, [current, isClaude, isPhone, layout.shellPane, settings.board, settings.decision_mode, settings.swap_panes, settings.text_size, navigate, setOverlay, setLayout, saveSettings, error, mod])

  const projectName = (id?: string) => projects?.find((p) => p.id === id)?.name ?? ''

  const sessionItems = useMemo<Item[]>(
    () =>
      (sessions ?? []).map((s: Session) => {
        const waits = waitsOnPerson(s)
        return {
          kind: 'session' as const,
          id: s.id,
          title: s.name,
          detail: (projectName(s.project_id) ? `${projectName(s.project_id)} · ` : '') + homeRelative(s.cwd) + (s.host_name ? ` · ${s.host_name}` : ''),
          projectName: projectName(s.project_id),
          keywords: [s.title, s.kind === 'shell' ? 'shell' : 'claude', s.archived_at ? 'archived' : ''].filter(Boolean).join(' '),
          leading: <StatusDot s={s} waits={waits} size={8} ring={false} />,
          unread: s.unread > 0,
          waiting: ATTENTION.includes(sectionOf(s)),
          run: () => {
            remember({ k: 'session', id: s.id })
            navigate({ s: s.id, t: null, f: null, view: 'main', tab: 'inbox' })
            if (!isPhone) focusTerminal()
          },
        }
      }),
    [sessions, projects, navigate, isPhone],
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

  const threadItems = useMemo<Item[]>(() => {
    const name = (id: string) => sessions?.find((s) => s.id === id)?.name ?? ''
    return [...threads]
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .map((t) => ({
        kind: 'thread' as const,
        id: t.id,
        title: t.subject || '(no subject)',
        detail: (t.project_name ? `${t.project_name} · ` : '') + name(t.session_id),
        sessionName: name(t.session_id),
        projectName: t.project_name,
        keywords: t.archived_at ? 'archived' : '',
        waiting: ATTENTION.includes(t.section) || !!t.stopped,
        unread: t.unread > 0,
        time: shortTime(t.updated_at),
        run: () => {
          remember({ k: 'thread', id: t.id })
          navigate({ s: t.session_id, t: t.id, f: null, view: 'main', tab: 'inbox' })
        },
      }))
  }, [threads, sessions])

  // The prefix picks a kind; the rest is the search.
  const only = PREFIX[q[0] ?? '']
  const text = only ? q.slice(1) : q
  const searching = text.trim() !== ''

  const rows = useMemo<{ item: Item; idx: number[]; head?: string }[]>(() => {
    const pool: Item[] = [...actions, ...projectItems, ...sessionItems, ...threadItems].filter((i) => !only || i.kind === only)
    if (searching) {
      return pool
        .map((item, order) => {
          const m = fuzzyFields(text, [
            { text: item.title, weight: 1 },
            { text: item.keywords ?? '', weight: 0.7 },
            { text: item.sessionName ?? '', weight: 0.6 },
            { text: item.projectName ?? '', weight: 0.5 },
            ...(item.kind === 'session' ? [{ text: item.detail ?? '', weight: 0.4 }] : []),
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
        const it = (r.k === 'session' ? sessionItems : threadItems).find((x) => x.id === r.id)
        if (it) {
          heads.push(it)
          used.add(it)
        }
      }
      heads.forEach((item, i) => out.push({ item, idx: [], head: i === 0 ? 'Recent' : undefined }))
      actions.forEach((item, i) => out.push({ item, idx: [], head: i === 0 ? 'Actions' : undefined }))
      projectItems.forEach((item, i) => out.push({ item, idx: [], head: i === 0 ? 'Projects' : undefined }))
      sessionItems.filter((i) => !used.has(i)).forEach((item, i) => out.push({ item, idx: [], head: i === 0 ? 'Sessions' : undefined }))
      return out
    }
    pool.slice(0, 200).forEach((item, i) => out.push({ item, idx: [], head: i === 0 ? SECTION_LABEL[item.kind] : undefined }))
    return out
  }, [actions, projectItems, sessionItems, threadItems, only, text, searching])

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
      e.preventDefault() // the input keeps focus
    }
  }

  const placeholder = only ? { action: 'Run an action', session: 'Go to a session', thread: 'Open a thread', project: 'Switch project' }[only] : 'Go to a session or thread, or run an action'
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
                className={cx('flex min-h-10 cursor-pointer items-center gap-2.5 px-4 py-1.5 text-left', i === sel ? 'bg-sel' : 'bg-transparent')}
              >
                <span className="flex w-4 shrink-0 items-center justify-center">
                  {item.leading ?? <span aria-hidden="true" className="mono text-[12px] text-muted">{item.kind === 'action' ? '›' : '≡'}</span>}
                </span>
                <span className={cx('min-w-0 truncate text-[14px]', (item.waiting || item.unread) && item.kind !== 'action' ? 'font-semibold' : 'font-medium')}>
                  <Highlight text={item.title} idx={idx} />
                </span>
                {item.unread && item.kind === 'thread' && <span aria-label="Unread" data-testid="palette-unread" className="h-[7px] w-[7px] shrink-0 rounded-full bg-wait" />}
                {item.waiting && (
                  <span data-testid="palette-waiting" className="shrink-0 rounded-full bg-wait/15 px-2 text-[11px] font-semibold leading-[18px] text-waitfg">
                    Waiting for you
                  </span>
                )}
                {item.detail && <span className={cx('min-w-0 flex-1 truncate text-[12.5px] text-muted', item.kind !== 'action' && 'mono')}>{item.detail}</span>}
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
            <kbd className="text-fg2">&gt;</kbd> actions · <kbd className="text-fg2">@</kbd> sessions · <kbd className="text-fg2">#</kbd> threads · <kbd className="text-fg2">!</kbd> projects
          </span>
        </div>
      </div>
    </Modal>
  )
}
