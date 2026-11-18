import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react'
import { api, type Topic, type TopicDetail, type TopicMessage, type TopicStatus, type TopicsResult } from '../api'
import { useApp } from '../lib/app'
import { isMac } from '../lib/format'
import { useHotkeys } from '../lib/hotkeys'
import { renderMarkdown } from '../lib/markdown'
import { selectProject, useSelectedProject } from '../lib/projects'
import { revealMessage } from '../lib/revealMessage'
import { taskMessage } from '../lib/taskContext'
import { ContextMenu, useContextMenu } from './ContextMenu'
import { IconBack, IconCheck, IconChevronDown, IconClose, IconMore, IconSend, IconUndo } from './icons'
import { ThreadProjectBadge } from './ThreadList'
import { Button, IconButton, MenuItem, MenuLabel, MenuSep, Popover, Segmented, cx } from './ui'

const COLUMNS: { id: TopicStatus; title: string; empty: string }[] = [
  { id: 'in_progress', title: 'In progress', empty: 'Nothing in progress.' },
  { id: 'waiting_on_you', title: 'Waiting on you', empty: 'Nothing waits on you.' },
  { id: 'done', title: 'Done', empty: 'Nothing done lately.' },
]

/** "just now", "5m ago", "3h ago", "2d ago". */
export function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** The drag payload's type (a topic id). */
const DRAG_TYPE = 'application/x-minbox-topic'

/** The topic moved to status, as the server will store it (for the optimistic update). */
function movedTopic(t: Topic, status: TopicStatus): Topic {
  const now = new Date().toISOString()
  return { ...t, status, updated_at: now, done_at: status === 'done' ? (t.status === 'done' ? t.done_at : now) : null, manual_status: status, manual_at: now }
}

/**
 * Tasks (topics in the API and the store): what each thread is working on, across threads. The
 * agent of each thread keeps its tasks itself (its create_task / update_task tools); a thread can
 * have several, each in its own column. Scoped to the selected project, like the threads list.
 *
 * The person can move a card to another column: drag it (desktop), its menu (right-click, long
 * press, "…", Shift+F10: Move to), or 1 / 2 / 3 on the focused card. The agent may set the status
 * again later (its list_tasks shows the move). Arrows / HJKL move the focus between
 * cards, Enter opens the focused card's thread.
 *
 * Selecting a card (a click, a tap, or Space on the focused card) opens its pane: on the right of
 * the board on a desktop, full screen on a phone. The pane shows the topic's fuller summary, its
 * steps as a read-only checklist, the thread's messages about it, and a box that sends a message
 * to the thread, headed with the task's name ("[Task: …]", added on send, not shown in the box). While the pane is open the keyboard
 * focus moves the selection along; R writes, Esc closes it.
 */
export function TopicsPage() {
  const { topicsVersion, threadsVersion, error, navigate, projects, isPhone } = useApp()
  const { id: projectId, project } = useSelectedProject()
  const [res, setRes] = useState<TopicsResult | null>(null)
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null)
  const [tab, setTab] = useState<TopicStatus>('waiting_on_you')
  const [now, setNow] = useState(Date.now())
  // Keyboard focus (a topic id), the card being dragged and the column under it.
  const [focusId, setFocusId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<TopicStatus | null>(null)
  const [reload, setReload] = useState(0)
  // The topic whose pane is open, and the unsent text of each topic's message box.
  const [selId, setSelId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const replyRef = useRef<HTMLTextAreaElement | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    api
      .topics(projectId)
      .then((r) => n === seq.current && setRes(r))
      .catch(error)
    // threadsVersion: an archived or renamed thread changes the board too.
  }, [topicsVersion, threadsVersion, projectId, error, reload])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const byCol = useMemo(() => {
    const out: Record<TopicStatus, Topic[]> = { in_progress: [], waiting_on_you: [], done: [] }
    for (const t of res?.topics ?? []) out[t.status]?.push(t)
    return out
  }, [res])
  const doneDays = res?.done_days ?? 7
  const open = (t: Topic) => t.session_id && navigate({ view: 'main', s: t.session_id, t: t.thread_id, f: null }, { push: true })
  const selected = res?.topics.find((x) => x.id === selId) ?? null
  // A topic gone from the board (dropped, or another project chosen) closes its pane.
  useEffect(() => {
    if (res && selId && !res.topics.some((x) => x.id === selId)) setSelId(null)
  }, [res, selId])
  const select = (id: string) => {
    setSelId(id)
    setFocusId(id)
  }
  const closePane = () => {
    const id = selId
    setSelId(null)
    // Back on the card it was about (the keys go on from there).
    if (id && !isPhone) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="topic-card"][data-topic-id="${CSS.escape(id)}"]`)?.focus())
  }

  /** Move a topic to another column: at once on the board, then on the server (a failure reloads). */
  const move = useCallback(
    (id: string, status: TopicStatus) => {
      const t = res?.topics.find((x) => x.id === id)
      if (!t || t.status === status) return
      // A load already under way would bring the old column back: drop it (the move's SSE reloads).
      seq.current++
      // First in its new column: the server orders a column by its last change.
      setRes((r) => r && { ...r, topics: [movedTopic(t, status), ...r.topics.filter((x) => x.id !== id)] })
      // The keyboard focus follows the card (on a phone, to its tab).
      if (isPhone && focusId === id) setTab(status)
      api.setTopicStatus(id, status).catch((e) => {
        error(e)
        setReload((v) => v + 1)
      })
    },
    [res, error, isPhone, focusId],
  )

  // ---- keyboard: arrows / HJKL move the focus, Enter opens, 1 2 3 move the card ----
  const cols = isPhone ? COLUMNS.filter((c) => c.id === tab) : COLUMNS
  const focusCard = (id: string) => {
    setFocusId(id)
    // An open pane follows the focus.
    if (selId) setSelId(id)
    // DOM focus too (Enter and Shift+F10 act on it): now, and again once a moved card is rendered in its new column.
    const el = () => document.querySelector<HTMLElement>(`[data-testid="topic-card"][data-topic-id="${CSS.escape(id)}"]`)
    el()?.focus()
    requestAnimationFrame(() => el()?.focus())
  }
  const where = (): { c: number; i: number } | null => {
    const t = res?.topics.find((x) => x.id === focusId)
    if (!t) return null
    return { c: COLUMNS.findIndex((x) => x.id === t.status), i: byCol[t.status].findIndex((x) => x.id === t.id) }
  }
  const first = () => {
    const c = cols.find((x) => byCol[x.id].length > 0)
    if (c) focusCard(byCol[c.id][0].id)
  }
  const vert = (d: number) => {
    const w = where()
    if (!w || (isPhone && COLUMNS[w.c].id !== tab)) return first()
    const list = byCol[COLUMNS[w.c].id]
    focusCard(list[Math.max(0, Math.min(list.length - 1, w.i + d))].id)
  }
  const horiz = (d: number) => {
    const w = where()
    if (!w && !isPhone) return first()
    // On a phone the columns are tabs: the next tab, with its first card focused.
    const from = w && (!isPhone || COLUMNS[w.c].id === tab) ? w.c : COLUMNS.findIndex((x) => x.id === tab)
    for (let c = from + d; c >= 0 && c < COLUMNS.length; c += d) {
      const list = byCol[COLUMNS[c].id]
      if (isPhone) {
        setTab(COLUMNS[c].id)
        if (list.length) focusCard(list[0].id)
        else setFocusId(null)
        return
      }
      if (list.length) return focusCard(list[Math.min(w?.i ?? 0, list.length - 1)].id)
    }
  }
  const focused = res?.topics.find((x) => x.id === focusId)
  // Enter and Space act on the focused card only while no other control (a button in the pane)
  // has the DOM focus: there they press that control.
  const onControl = () => {
    const a = document.activeElement as HTMLElement | null
    return !!a && a !== document.body && !a.matches('[data-testid="topic-card"]')
  }
  useHotkeys({
    escape: () => (selId ? closePane() : navigate({ view: 'main' })),
    space: () => {
      if (!focused || onControl()) return false
      if (selId === focused.id && !isPhone) closePane()
      else select(focused.id)
    },
    r: () => {
      if (!selected || !replyRef.current) return false
      replyRef.current.focus()
    },
    j: () => vert(1),
    arrowdown: () => vert(1),
    k: () => vert(-1),
    arrowup: () => vert(-1),
    h: () => horiz(-1),
    arrowleft: () => horiz(-1),
    l: () => horiz(1),
    arrowright: () => horiz(1),
    enter: () => {
      if (!focused || onControl()) return false
      open(focused)
    },
    1: () => (focused ? move(focused.id, 'in_progress') : false),
    2: () => (focused ? move(focused.id, 'waiting_on_you') : false),
    3: () => (focused ? move(focused.id, 'done') : false),
  })

  // ---- drag and drop (desktop) ----
  const dragged = res?.topics.find((x) => x.id === dragId)
  const dropProps = (col: TopicStatus) =>
    isPhone
      ? {}
      : {
          onDragOver: (e: DragEvent<HTMLElement>) => {
            if (!dragged || dragged.status === col) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (overCol !== col) setOverCol(col)
          },
          onDragLeave: (e: DragEvent<HTMLElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverCol((c) => (c === col ? null : c))
          },
          onDrop: (e: DragEvent<HTMLElement>) => {
            e.preventDefault()
            const id = e.dataTransfer.getData(DRAG_TYPE) || dragId
            setDragId(null)
            setOverCol(null)
            if (id) move(id, col)
          },
        }

  const column = (col: (typeof COLUMNS)[number]) => {
    const list = byCol[col.id]
    const target = !!dragged && dragged.status !== col.id
    return (
      <section
        key={col.id}
        data-testid={`topics-col-${col.id}`}
        data-drop-over={overCol === col.id ? 'true' : undefined}
        aria-label={col.title}
        {...dropProps(col.id)}
        className={cx(
          'flex min-h-0 flex-col gap-2 overflow-y-auto rounded-xl bg-surface p-2.5 outline-offset-[-2px]',
          isPhone && 'flex-1 rounded-none bg-transparent px-3',
          target && 'outline-2 outline-dashed outline-linestrong',
          overCol === col.id && 'bg-accent/10 outline-solid outline-accent',
        )}
      >
        {!isPhone && (
          <div className="flex items-baseline gap-1.5 px-1 pb-1.5 pt-0.5">
            <span className={cx('text-[13px] font-[650]', col.id === 'waiting_on_you' ? 'text-wait' : 'text-fg')}>{col.title}</span>
            <span className="text-[12px] text-subtle">{list.length}</span>
            {col.id === 'done' && <span className="text-[11.5px] text-subtle">· last {doneDays} days</span>}
          </div>
        )}
        {isPhone && col.id === 'done' && <span className="px-1 text-[12px] text-subtle">Done in the last {doneDays} days</span>}
        {res && list.length === 0 && <span className="px-1 py-1 text-[12.5px] text-subtle">{col.empty}</span>}
        {list.map((t) => (
          <TopicCard
            key={t.id}
            t={t}
            now={now}
            phone={isPhone}
            focused={focusId === t.id}
            selected={selId === t.id}
            dragging={dragId === t.id}
            showProject={!projectId}
            onOpen={() => open(t)}
            onSelect={() => select(t.id)}
            onMove={(s) => move(t.id, s)}
            onFocus={() => setFocusId(t.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, t.id)
              e.dataTransfer.effectAllowed = 'move'
              setDragId(t.id)
            }}
            onDragEnd={() => {
              setDragId(null)
              setOverCol(null)
            }}
          />
        ))}
      </section>
    )
  }

  const pane = selected && (
    <TopicPane
      key={selected.id}
      t={selected}
      now={now}
      phone={isPhone}
      draft={drafts[selected.id] ?? ''}
      onDraft={(v) => setDrafts((d) => ({ ...d, [selected.id]: v }))}
      replyRef={replyRef}
      onClose={closePane}
      onMove={(st) => move(selected.id, st)}
      onOpenThread={(messageId) => {
        open(selected)
        if (messageId) revealMessage(selected.thread_id, messageId)
      }}
    />
  )
  if (isPhone && pane) {
    return (
      <div className="flex h-full flex-col bg-bg" data-testid="topics">
        {pane}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="topics">
      <div className={cx('flex h-14 shrink-0 items-center gap-3 border-b border-line', isPhone ? 'px-2' : 'px-5')}>
        <IconButton aria-label="Back" onClick={() => navigate({ view: 'main' })}>
          <IconBack />
        </IconButton>
        <h1 className="m-0 text-[18px] font-bold">Tasks</h1>
        {!isPhone && res && (
          <span className="text-[13px] text-muted">
            {byCol.in_progress.length} in progress · <span className="font-semibold text-wait">{byCol.waiting_on_you.length} waiting on you</span>
          </span>
        )}
        <span className="flex-1" />
        <Button size="sm" className="h-8 max-w-[50vw]" data-testid="topics-project" onClick={(e) => setFilterAnchor(e.currentTarget)}>
          <span className="truncate">{project ? project.name : 'All projects'}</span> <IconChevronDown size={14} />
        </Button>
      </div>
      <Popover anchor={filterAnchor} open={!!filterAnchor} onClose={() => setFilterAnchor(null)}>
        <MenuItem active={!projectId} onClick={() => (selectProject(''), setFilterAnchor(null))}>
          All projects
        </MenuItem>
        {(projects ?? []).map((p) => (
          <MenuItem key={p.id} active={projectId === p.id} onClick={() => (selectProject(p.id), setFilterAnchor(null))}>
            {p.name}
          </MenuItem>
        ))}
      </Popover>
      {res && res.topics.length === 0 && (
        <div data-testid="topics-empty" className="mx-5 mt-3 text-[12.5px] text-subtle">
          No tasks yet. Agents add a task here when they start a piece of work you asked for, and keep it current.
        </div>
      )}
      {isPhone ? (
        <>
          <div className="shrink-0 px-3 pt-2.5">
            <Segmented
              size="lg"
              value={tab}
              onChange={setTab}
              testidPrefix="topics-tab"
              options={COLUMNS.map((c) => ({
                value: c.id,
                label: (
                  <span className={cx(c.id === 'waiting_on_you' && byCol.waiting_on_you.length > 0 && tab !== c.id && 'text-wait')}>
                    {c.id === 'waiting_on_you' ? 'Waiting' : c.title} <span className="text-subtle">{byCol[c.id].length}</span>
                  </span>
                ),
              }))}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col pt-2">{column(COLUMNS.find((c) => c.id === tab)!)}</div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[repeat(3,minmax(220px,1fr))] gap-3 overflow-x-auto px-5 py-4">{COLUMNS.map(column)}</div>
          {pane}
        </div>
      )}
    </div>
  )
}

function TopicCard({
  t,
  now,
  phone,
  focused,
  selected,
  dragging,
  showProject,
  compact,
  onOpen,
  onSelect,
  onMove,
  onFocus,
  onDragStart,
  onDragEnd,
}: {
  t: Topic
  now: number
  phone: boolean
  focused: boolean
  selected: boolean
  dragging: boolean
  showProject: boolean
  /** In a thread's Tasks pane: no thread name, no drag, Enter shows the task, no "Open thread". */
  compact?: boolean
  onOpen?: () => void
  onSelect: () => void
  onMove: (s: TopicStatus) => void
  onFocus: () => void
  onDragStart?: (e: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
}) {
  const waiting = t.status === 'waiting_on_you'
  const isDone = t.status === 'done'
  const thread = t.thread_name || t.thread_subject || 'Untitled thread'
  const when = t.status === 'done' ? t.done_at ?? t.updated_at : t.updated_at
  // Right-click / Shift+F10 / long press / "…": Move to, Open.
  const menu = useContextMenu()
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        {...menu.props}
        draggable={!phone && !compact}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onFocus={(e) => e.target === e.currentTarget && onFocus()}
        onKeyDown={(e) => {
          menu.props.onKeyDown(e)
          if (e.key === 'Enter' && e.target === e.currentTarget) {
            e.preventDefault()
            if (onOpen) onOpen()
            else onSelect()
          }
        }}
        data-testid="topic-card"
        data-status={t.status}
        data-topic-id={t.id}
        data-focused={focused ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        aria-pressed={selected}
        data-manual={t.manual_status ? 'true' : undefined}
        data-menu-open={menu.at ? 'true' : undefined}
        onClick={onSelect}
        title={phone ? undefined : onOpen ? 'Show the task (↵ opens the thread)' : 'Show the task'}
        className={cx(
          'group relative flex w-full shrink-0 cursor-pointer flex-col rounded-[10px] border bg-raised text-left',
          compact ? 'gap-1 px-2.5 py-2' : 'gap-1.5 px-3 py-2.5',
          'outline-none hover:border-linestrong focus-visible:ring-2 focus-visible:ring-accent',
          waiting ? 'border-wait/50' : 'border-line2',
          t.status === 'done' && 'opacity-80',
          selected && 'border-accent bg-accent/8',
          focused && 'ring-2 ring-accent',
          dragging && 'opacity-40',
          menu.at && 'border-linestrong',
        )}
      >
        <span className="flex items-start gap-1">
          <span data-testid="topic-title" className={cx('min-w-0 flex-1 text-[13.5px] leading-[1.45] text-fg', waiting ? 'font-[650]' : 'font-medium')}>
            {t.title}
          </span>
          {/* Done in one click (Reopen once it is): the same manual move as 3 / 1. Not a select, not a drag. */}
          <IconButton
            aria-label={isDone ? 'Reopen (1)' : 'Mark done (3)'}
            title={isDone ? 'Reopen (1)' : 'Mark done (3)'}
            data-testid={isDone ? 'topic-reopen' : 'topic-done'}
            size={22}
            draggable={false}
            className={cx('-mt-0.5', !phone && !menu.at && 'invisible group-hover:visible group-focus-within:visible focus-visible:visible [@media(hover:none)]:visible')}
            onMouseDown={(e) => {
              // No drag of the card from here (and no focus ring left on the card).
              e.preventDefault()
              e.stopPropagation()
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDragStart={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.stopPropagation()
              onMove(isDone ? 'in_progress' : 'done')
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {isDone ? <IconUndo size={14} /> : <IconCheck size={14} />}
          </IconButton>
          <IconButton
            aria-label="Move to…"
            title="Move to…"
            data-testid="topic-more"
            size={22}
            className={cx('-mr-1 -mt-0.5', !phone && !menu.at && 'invisible group-hover:visible group-focus-within:visible focus-visible:visible [@media(hover:none)]:visible')}
            onClick={(e) => {
              e.stopPropagation()
              menu.open({ el: e.currentTarget })
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <IconMore size={14} />
          </IconButton>
        </span>
        {t.summary && (
          <span data-testid="topic-summary" className="line-clamp-2 text-[12px] leading-[1.45] text-muted">
            {t.summary}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-subtle">
          {showProject && <ThreadProjectBadge projectId={t.project_id} projectName={t.project_name} />}
          {compact ? (
            <span className="min-w-0 flex-1" />
          ) : (
            <span data-testid="topic-thread" className="min-w-0 flex-1 truncate">
              {thread}
              {showProject && t.project_name && <span className="text-subtle"> · {t.project_name}</span>}
            </span>
          )}
          <time dateTime={when} title={new Date(when).toLocaleString()} className="shrink-0">
            {relTime(when, now)}
          </time>
        </span>
      </div>
      <ContextMenu at={menu.at} onClose={menu.close} testid="topic-menu">
        <MenuLabel>Move to</MenuLabel>
        {COLUMNS.map((c, i) => (
          <MenuItem
            key={c.id}
            testid={`topic-move-${c.id}`}
            active={t.status === c.id}
            disabled={t.status === c.id}
            hint={phone ? undefined : String(i + 1)}
            onClick={() => {
              menu.close()
              onMove(c.id)
            }}
          >
            {c.title}
          </MenuItem>
        ))}
        {onOpen && (
          <>
            <MenuSep />
            <MenuItem
              testid="topic-open"
              hint={phone ? undefined : '↵'}
              onClick={() => {
                menu.close()
                onOpen()
              }}
            >
              Open thread
            </MenuItem>
          </>
        )}
      </ContextMenu>
    </>
  )
}

const STATUS_LABEL: Record<TopicStatus, string> = { in_progress: 'In progress', waiting_on_you: 'Waiting on you', done: 'Done' }

/**
 * A topic's pane: the fuller summary (Markdown), its steps as a read-only checklist with the
 * progress, the thread's messages about it (a click opens the thread at that message), and a box
 * that sends a message to the thread headed with the topic's name. Beside the board on a desktop,
 * the whole screen on a phone.
 */
function TopicPane({
  t,
  now,
  phone,
  draft,
  onDraft,
  replyRef,
  onClose,
  onMove,
  onOpenThread,
  inThread,
}: {
  t: Topic
  now: number
  phone: boolean
  /** The message box's unsent text (kept per task by the caller) and its element (R focuses it). */
  draft: string
  onDraft: (v: string) => void
  replyRef?: React.RefObject<HTMLTextAreaElement | null>
  onClose: () => void
  onMove: (s: TopicStatus) => void
  onOpenThread: (messageId?: string) => void
  /** Inside a thread's Tasks pane: fills it, Back goes to the list, no thread link. */
  inThread?: boolean
}) {
  const { topicsVersion, threadVersion } = useApp()
  const [detail, setDetail] = useState<TopicDetail | null>(null)
  const bump = threadVersion[t.thread_id] ?? 0
  useEffect(() => {
    let live = true
    // A topic that is gone closes the pane (the board's list says so): nothing to report here.
    api
      .topic(t.id)
      .then((d) => live && setDetail(d))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [t.id, topicsVersion, bump])
  const thread = t.thread_name || t.thread_subject || 'Untitled thread'
  const tasks = t.tasks ?? []
  const done = tasks.filter((x) => x.done).length
  const body = (t.detail || t.summary || '').trim()
  const html = useMemo(() => (body ? renderMarkdown(body) : ''), [body])
  const msgs = detail?.topic.id === t.id ? detail.messages : null
  // The related messages scroll on their own, oldest at the top, and start at the bottom (the
  // newest). They stay at the bottom as messages arrive, unless the person scrolled up in the list.
  const listRef = useRef<HTMLUListElement>(null)
  const listAtBottom = useRef(true)
  useEffect(() => {
    listAtBottom.current = true
  }, [t.id])
  const lastMsg = msgs && msgs.length ? msgs[msgs.length - 1]!.id : ''
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && listAtBottom.current) el.scrollTop = el.scrollHeight
  }, [t.id, msgs?.length, lastMsg])
  const statusTone = t.status === 'waiting_on_you' ? 'border-wait/60 text-wait' : t.status === 'done' ? 'border-line2 text-subtle' : 'border-accent/50 text-accent'
  return (
    <aside
      data-testid="topic-pane"
      data-topic-id={t.id}
      aria-label={`Task: ${t.title}`}
      className={cx('flex min-h-0 flex-col bg-bg', phone || inThread ? 'h-full min-w-0 flex-1' : 'w-[min(420px,40vw)] shrink-0 border-l border-line')}
    >
      <div className={cx('flex shrink-0 items-start gap-2 border-b border-line py-3', phone || inThread ? 'px-2' : 'px-4')}>
        {(phone || inThread) && (
          <IconButton
            aria-label={inThread ? 'Back to the tasks' : 'Back to the board'}
            title={inThread ? 'Back to the tasks' : undefined}
            data-testid="topic-pane-back"
            size={inThread && !phone ? 28 : undefined}
            onClick={onClose}
          >
            <IconBack size={inThread && !phone ? 15 : undefined} />
          </IconButton>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 data-testid="topic-pane-title" className="m-0 text-[16px] font-[650] leading-[1.35] text-fg">
            {t.title}
          </h2>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <span data-testid="topic-pane-status" data-status={t.status} className={cx('rounded-full border px-2 py-px text-[11.5px] font-semibold', statusTone)}>
              {STATUS_LABEL[t.status]}
            </span>
            {!inThread && (
              <button
                type="button"
                data-testid="topic-pane-thread"
                title="Open the thread"
                onClick={() => onOpenThread()}
                className="min-w-0 max-w-full truncate border-0 bg-transparent p-0 text-left text-accent hover:underline"
              >
                {thread}
                {t.project_name && <span className="text-subtle"> · {t.project_name}</span>}
              </button>
            )}
          </div>
        </div>
        {/* Done, or Reopen once it is: the same move as a drag or the 3 / 1 keys (a manual mark). */}
        {t.status === 'done' ? (
          <Button size="sm" className="shrink-0" data-testid="topic-pane-reopen" title="Move back to In progress (1)" onClick={() => onMove('in_progress')}>
            Reopen
          </Button>
        ) : (
          <Button size="sm" className="shrink-0 gap-1" data-testid="topic-pane-done" title="Move to Done (3)" onClick={() => onMove('done')}>
            <IconCheck size={12} />
            Done
          </Button>
        )}
        {!phone && !inThread && (
          <IconButton aria-label="Close (Esc)" title="Close (Esc)" data-testid="topic-pane-close" size={28} onClick={onClose}>
            <IconClose size={14} />
          </IconButton>
        )}
      </div>

      <div className={cx('flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-4', phone ? 'px-4' : 'px-4')}>
        <section aria-label="Summary">
          {html ? (
            <div data-testid="topic-pane-detail" className="md text-[13.5px] text-body" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <span className="text-[12.5px] text-subtle">No summary yet.</span>
          )}
        </section>

        <section aria-label="Steps" data-testid="topic-pane-tasks" className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] font-bold uppercase tracking-wide text-subtle">Steps</span>
            {tasks.length > 0 && (
              <span data-testid="topic-pane-progress" className="text-[12px] text-muted">
                {done}/{tasks.length} done
              </span>
            )}
          </div>
          {tasks.length > 0 ? (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={tasks.length} aria-valuenow={done} aria-label="Steps done">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(done / tasks.length) * 100}%` }} />
              </div>
              <ul className="m-0 flex list-none flex-col gap-1 p-0" title="As the agent keeps it">
                {tasks.map((k, i) => (
                  <li key={i} data-testid="topic-task" data-done={k.done ? 'true' : 'false'} className="flex items-start gap-2 text-[13px] leading-[1.45]">
                    <span
                      role="checkbox"
                      aria-checked={k.done}
                      aria-readonly="true"
                      aria-label={k.text}
                      className={cx(
                        'mt-[2px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border',
                        k.done ? 'border-accent bg-accent text-onaccent' : 'border-linestrong',
                      )}
                    >
                      {k.done && <IconCheck size={11} />}
                    </span>
                    <span className={cx('min-w-0 flex-1', k.done ? 'text-muted line-through decoration-subtle' : 'text-fg')}>{k.text}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span className="text-[12.5px] text-subtle">No separate steps.</span>
          )}
        </section>

        <section aria-label="Related messages" className="flex flex-col gap-2">
          <span className="text-[12px] font-bold uppercase tracking-wide text-subtle">
            Messages {msgs && msgs.length > 0 && <span className="font-normal normal-case tracking-normal">{msgs.length}</span>}
          </span>
          {msgs === null ? (
            <span className="text-[12.5px] text-subtle">Loading…</span>
          ) : msgs.length === 0 ? (
            <span className="text-[12.5px] text-subtle">No messages linked yet.</span>
          ) : (
            <ul
              ref={listRef}
              data-testid="topic-messages"
              onScroll={(e) => {
                const el = e.currentTarget
                listAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
              }}
              className={cx('m-0 flex shrink-0 list-none flex-col gap-1.5 overflow-y-auto overscroll-contain p-0 pr-1', phone ? 'max-h-[45vh]' : 'max-h-[min(360px,45vh)]')}
            >
              {msgs.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    data-testid="topic-message"
                    data-message-id={m.id}
                    title="Show it in the thread"
                    onClick={() => onOpenThread(m.id)}
                    className="flex w-full flex-col gap-1 rounded-lg border border-line2 bg-raised px-2.5 py-2 text-left hover:border-linestrong"
                  >
                    <span className="flex items-center gap-1.5 text-[11.5px]">
                      <span className={cx('font-semibold', m.author === 'user' ? 'text-fg2' : 'text-wait')}>
                        {m.author === 'user' ? (m.kind === 'command' ? 'You ran' : 'You') : 'Agent'}
                      </span>
                      <time dateTime={m.created_at} title={new Date(m.created_at).toLocaleString()} className="text-subtle">
                        {relTime(m.created_at, now)}
                      </time>
                    </span>
                    <span data-testid="topic-message-excerpt" className="line-clamp-3 text-[12.5px] leading-[1.45] text-body">
                      {m.excerpt || '(no text)'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <TopicCompose t={t} msgs={msgs} thread={thread} phone={phone} inThread={inThread} draft={draft} onDraft={onDraft} replyRef={replyRef} />
    </aside>
  )
}

/**
 * A task's message box: sends the text to the task's thread headed with "[Task: <title>]" and a
 * short quoted context (lib/taskContext), as the thread's own box would (an ended session keeps it until resumed). ⌘↵ sends, Esc leaves the box.
 * In the board's pane and in a thread's Tasks pane alike.
 */
function TopicCompose({
  t,
  msgs,
  thread,
  phone,
  inThread,
  draft,
  onDraft,
  replyRef,
}: {
  t: Topic
  /** The task's related messages (the context names the latest, so the agent can find them). */
  msgs: TopicMessage[] | null
  thread: string
  phone: boolean
  inThread?: boolean
  draft: string
  onDraft: (v: string) => void
  replyRef?: React.RefObject<HTMLTextAreaElement | null>
}) {
  const { sessions, toast, error } = useApp()
  const [sending, setSending] = useState(false)
  const session = sessions?.find((s) => s.id === t.session_id)
  const mod = isMac() ? '⌘' : 'Ctrl+'
  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await api.reply(t.thread_id, { words: taskMessage(t, msgs, text) })
      onDraft('')
      // Beside the thread the message shows up there; elsewhere (the board, full screen) say so.
      if (!inThread || phone) toast(`Sent to “${thread}”`)
    } catch (e) {
      error(e)
    } finally {
      setSending(false)
    }
  }
  return (
    <form
      data-testid="topic-pane-compose"
      className={cx('flex shrink-0 flex-col gap-2 border-t border-line py-3', phone ? 'px-3 pb-[max(12px,env(safe-area-inset-bottom))]' : 'px-4')}
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      {session?.status === 'ended' && <span className="text-[11.5px] text-subtle">Session ended: it waits until resumed</span>}
      <div className="flex items-end gap-2">
        <textarea
          ref={replyRef}
          data-testid="topic-pane-input"
          value={draft ?? ''}
          rows={phone ? 2 : 3}
          placeholder={phone ? 'Message the thread about this task…' : 'Message the thread about this task… (R)'}
          onChange={(e) => onDraft?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (isMac() ? e.metaKey : e.ctrlKey)) {
              e.preventDefault()
              void send()
            } else if (e.key === 'Escape') {
              // Esc leaves the box first; a second one closes the pane.
              e.preventDefault()
              e.stopPropagation()
              e.currentTarget.blur()
            }
          }}
          className="min-h-0 flex-1 resize-none rounded-lg border border-linestrong bg-surface px-2.5 py-2 text-[13.5px] text-fg outline-none placeholder:text-subtle focus:border-accent"
        />
        <Button type="submit" variant="primary" size="sm" data-testid="topic-pane-send" disabled={!draft?.trim() || sending} title={`Send (${mod}↵)`} className="h-9">
          <IconSend size={14} />
          Send
        </Button>
      </div>
    </form>
  )
}

// ---- a thread's Tasks pane ----

/**
 * Tablet and phone: the open thread's tasks full screen, in front of the thread (the desktop has a
 * pane for them, layout.tasksPane). Shared by the header buttons and ⌘K; never stored.
 */
let tasksOverlay = false
const overlayListeners = new Set<() => void>()
export function setThreadTasksOverlay(open: boolean) {
  if (tasksOverlay === open) return
  tasksOverlay = open
  overlayListeners.forEach((l) => l())
}
export function useThreadTasksOverlay(): boolean {
  return useSyncExternalStore(
    (l) => {
      overlayListeners.add(l)
      return () => overlayListeners.delete(l)
    },
    () => tasksOverlay,
  )
}

/**
 * The open thread's tasks (its topics): beside the thread on a desktop (between the thread and the
 * agent terminal), full screen on a tablet or phone. The list groups them by status (In progress,
 * Waiting on you, Done); selecting one shows its summary, steps and related messages (a click shows
 * the message in the thread), with Done / Reopen and the card menu's Move to, and the same message
 * box as the board's pane (a draft per task; the message shows up in the thread beside it).
 */
export function ThreadTasks({ threadId, phone, onClose }: { threadId: string; phone?: boolean; onClose: () => void }) {
  const { topicsVersion, error } = useApp()
  const [res, setRes] = useState<TopicsResult | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [reload, setReload] = useState(0)
  const [now, setNow] = useState(Date.now())
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    api
      .threadTopics(threadId)
      .then((r) => n === seq.current && setRes(r))
      .catch(error)
  }, [threadId, topicsVersion, reload, error])
  // (Callers key it by thread: another thread starts afresh.)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const topics = useMemo(() => (res?.topics ?? []).filter((t) => t.thread_id === threadId), [res, threadId])
  const selected = topics.find((t) => t.id === selId) ?? null
  useEffect(() => {
    if (res && selId && !res.topics.some((t) => t.id === selId)) setSelId(null)
  }, [res, selId])

  const move = (id: string, status: TopicStatus) => {
    const t = topics.find((x) => x.id === id)
    if (!t || t.status === status) return
    seq.current++
    setRes((r) => r && { ...r, topics: [movedTopic(t, status), ...r.topics.filter((x) => x.id !== id)] })
    api.setTopicStatus(id, status).catch((e) => {
      error(e)
      setReload((v) => v + 1)
    })
  }
  const asideRef = useRef<HTMLElement>(null)
  const select = (id: string) => {
    setSelId(id)
    // The card goes away with the list: keep the keyboard in the pane.
    requestAnimationFrame(() => {
      const a = document.activeElement
      if (!a || a === document.body) asideRef.current?.focus()
    })
  }
  const back = () => {
    const id = selId
    setSelId(null)
    if (id) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="thread-tasks"] [data-testid="topic-card"][data-topic-id="${CSS.escape(id)}"]`)?.focus())
  }
  const reveal = (messageId?: string) => {
    if (!messageId) return
    // Full screen, the thread is behind: close first, then show the message there.
    if (phone) onClose()
    revealMessage(threadId, messageId)
  }

  const counts = { in_progress: 0, waiting_on_you: 0, done: 0 } as Record<TopicStatus, number>
  for (const t of topics) counts[t.status]++
  const header = (
    <div className={cx('flex shrink-0 items-center gap-1.5 border-b border-line', phone ? 'h-14 px-1.5' : 'h-11 pl-3.5 pr-1.5')}>
      {phone && (
        <IconButton aria-label="Back to the thread" data-testid="tasks-back" onClick={onClose}>
          <IconBack />
        </IconButton>
      )}
      <h2 className={cx('m-0 font-[650] text-fg', phone ? 'text-[16px]' : 'text-[13.5px]')}>Tasks</h2>
      {topics.length > 0 && (
        <span data-testid="thread-tasks-count" className="text-[12px] text-subtle">
          {topics.length}
        </span>
      )}
      <span className="flex-1" />
      {!phone && (
        <IconButton aria-label="Hide tasks" title="Hide tasks" data-testid="tasks-close" size={28} onClick={onClose}>
          <IconClose size={14} />
        </IconButton>
      )}
    </div>
  )

  return (
    // tabIndex -1: a click anywhere in it puts the keyboard here (R is then the task's box).
    <aside ref={asideRef} tabIndex={-1} data-testid="thread-tasks" data-thread-id={threadId} aria-label="Tasks" className="flex h-full min-h-0 min-w-0 flex-col bg-bg outline-none">
      {!(phone && selected) && header}
      {selected ? (
        <TopicPane
          key={selected.id}
          t={selected}
          now={now}
          phone={!!phone}
          inThread
          draft={drafts[selected.id] ?? ''}
          onDraft={(v) => setDrafts((d) => ({ ...d, [selected.id]: v }))}
          onClose={back}
          onMove={(st) => move(selected.id, st)}
          onOpenThread={reveal}
        />
      ) : (
        <div className={cx('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto', phone ? 'px-3 py-3' : 'px-2.5 py-3')}>
          {res && topics.length === 0 && (
            <div data-testid="thread-tasks-empty" className="px-1 text-[12.5px] leading-[1.5] text-subtle">
              No tasks yet — the agent adds them when it starts work in this thread.
            </div>
          )}
          {!res && <span className="px-1 text-[12.5px] text-subtle">Loading…</span>}
          {COLUMNS.filter((c) => counts[c.id] > 0).map((c) => (
            <section key={c.id} data-testid={`thread-tasks-${c.id}`} aria-label={c.title} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-1.5 px-1">
                <span className={cx('text-[12px] font-[650]', c.id === 'waiting_on_you' ? 'text-wait' : 'text-fg2')}>{c.title}</span>
                <span className="text-[11.5px] text-subtle">{counts[c.id]}</span>
              </div>
              {topics
                .filter((t) => t.status === c.id)
                .map((t) => (
                  <TopicCard
                    key={t.id}
                    t={t}
                    now={now}
                    phone={!!phone}
                    focused={false}
                    selected={selId === t.id}
                    dragging={false}
                    showProject={false}
                    compact
                    onSelect={() => select(t.id)}
                    onMove={(s) => move(t.id, s)}
                    onFocus={() => {}}
                  />
                ))}
            </section>
          ))}
        </div>
      )}
    </aside>
  )
}

/**
 * R beside a thread: while the keyboard is in the thread's Tasks pane (or its full-screen view is
 * open), R goes to the open task's message box instead of the thread's. True when it took the key
 * (the thread view's R then does nothing); false leaves R to the thread.
 */
export function focusTasksReply(): boolean {
  const a = document.activeElement
  const inPane = !!a?.closest?.('[data-testid="thread-tasks"]')
  if (!inPane && !tasksOverlay) return false
  const box = document.querySelector<HTMLTextAreaElement>('[data-testid="thread-tasks"] [data-testid="topic-pane-input"]')
  if (box) {
    box.focus()
    return true
  }
  // No task open: in the pane, the thread's box as usual; full screen, it is hidden behind, so nothing.
  return tasksOverlay
}

/**
 * Tablet and phone: the open thread's Tasks full screen, in front of the thread (opened by the
 * header's Tasks button or ⌘K). Another thread, or none, closes it.
 */
export function TasksOverlay({ threadId }: { threadId: string | null }) {
  const open = useThreadTasksOverlay()
  const last = useRef(threadId)
  useEffect(() => {
    if (last.current !== threadId) setThreadTasksOverlay(false)
    last.current = threadId
  }, [threadId])
  useEffect(() => () => setThreadTasksOverlay(false), [])
  if (!open || !threadId) return null
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" data-testid="phone-tasks">
      <ThreadTasks key={threadId} threadId={threadId} phone onClose={() => setThreadTasksOverlay(false)} />
    </div>
  )
}
