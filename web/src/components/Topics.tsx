import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { api, type Topic, type TopicStatus, type TopicsResult } from '../api'
import { useApp } from '../lib/app'
import { useHotkeys } from '../lib/hotkeys'
import { selectProject, useSelectedProject } from '../lib/projects'
import { ContextMenu, useContextMenu } from './ContextMenu'
import { IconBack, IconMore } from './icons'
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
 * Topics: what each thread is working on, across threads. The helper model reads every thread's
 * topics from its messages (a few seconds after each new one); a thread can have several, each in
 * its own column. Scoped to the selected project, like the threads list.
 *
 * The person can move a card to another column: drag it (desktop), its menu (right-click, long
 * press, "…", Shift+F10: Move to), or 1 / 2 / 3 on the focused card. The move holds until the
 * thread's next message, whose extraction is told about it. Arrows / HJKL move the focus between
 * cards, Enter opens the focused card's thread.
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
  useHotkeys({
    escape: () => navigate({ view: 'main' }),
    j: () => vert(1),
    arrowdown: () => vert(1),
    k: () => vert(-1),
    arrowup: () => vert(-1),
    h: () => horiz(-1),
    arrowleft: () => horiz(-1),
    l: () => horiz(1),
    arrowright: () => horiz(1),
    enter: () => {
      if (!focused) return false
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
            dragging={dragId === t.id}
            showProject={!projectId}
            onOpen={() => open(t)}
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

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="topics">
      <div className={cx('flex h-14 shrink-0 items-center gap-3 border-b border-line', isPhone ? 'px-2' : 'px-5')}>
        <IconButton aria-label="Back" onClick={() => navigate({ view: 'main' })}>
          <IconBack />
        </IconButton>
        <h1 className="m-0 text-[18px] font-bold">Topics</h1>
        {!isPhone && res && (
          <span className="text-[13px] text-muted">
            {byCol.in_progress.length} in progress · <span className="font-semibold text-wait">{byCol.waiting_on_you.length} waiting on you</span>
          </span>
        )}
        <span className="flex-1" />
        <Button size="sm" className="h-8 max-w-[50vw]" data-testid="topics-project" onClick={(e) => setFilterAnchor(e.currentTarget)}>
          <span className="truncate">{project ? project.name : 'All projects'}</span> ▾
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
      {res && !res.enabled && (
        <div data-testid="topics-off" className="mx-5 mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] text-muted">
          Topics are turned off, so threads are not read for new topics.{' '}
          <button type="button" className="border-0 bg-transparent p-0 text-accent underline" onClick={() => navigate({ view: 'settings', ss: 'capabilities' })}>
            Turn them on in Settings
          </button>
        </div>
      )}
      {res && res.enabled && res.topics.length === 0 && (
        <div data-testid="topics-empty" className="mx-5 mt-3 text-[12.5px] text-subtle">
          No topics yet. A thread's topics appear here a few seconds after it gets a new message.
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
        <div className="grid min-h-0 flex-1 grid-cols-[repeat(3,minmax(240px,1fr))] gap-3 overflow-x-auto px-5 py-4">{COLUMNS.map(column)}</div>
      )}
    </div>
  )
}

function TopicCard({
  t,
  now,
  phone,
  focused,
  dragging,
  showProject,
  onOpen,
  onMove,
  onFocus,
  onDragStart,
  onDragEnd,
}: {
  t: Topic
  now: number
  phone: boolean
  focused: boolean
  dragging: boolean
  showProject: boolean
  onOpen: () => void
  onMove: (s: TopicStatus) => void
  onFocus: () => void
  onDragStart: (e: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}) {
  const waiting = t.status === 'waiting_on_you'
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
        draggable={!phone}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onFocus={(e) => e.target === e.currentTarget && onFocus()}
        onKeyDown={(e) => {
          menu.props.onKeyDown(e)
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault()
            onOpen()
          }
        }}
        data-testid="topic-card"
        data-status={t.status}
        data-topic-id={t.id}
        data-focused={focused ? 'true' : undefined}
        data-manual={t.manual_status ? 'true' : undefined}
        data-menu-open={menu.at ? 'true' : undefined}
        onClick={onOpen}
        title={`Open the thread “${thread}”`}
        className={cx(
          'group relative flex w-full shrink-0 cursor-pointer flex-col gap-1.5 rounded-[10px] border bg-raised px-3 py-2.5 text-left outline-none hover:border-linestrong focus-visible:ring-2 focus-visible:ring-accent',
          waiting ? 'border-wait/50' : 'border-line2',
          t.status === 'done' && 'opacity-80',
          focused && 'ring-2 ring-accent',
          dragging && 'opacity-40',
          menu.at && 'border-linestrong',
        )}
      >
        <span className="flex items-start gap-1">
          <span data-testid="topic-title" className={cx('min-w-0 flex-1 text-[13.5px] leading-[1.45] text-fg', waiting ? 'font-[650]' : 'font-medium')}>
            {t.title}
          </span>
          <IconButton
            aria-label="Move to…"
            title="Move to…"
            data-testid="topic-more"
            size={22}
            className={cx('-mr-1 -mt-0.5', !phone && !menu.at && 'invisible group-hover:visible group-focus-within:visible focus-visible:visible')}
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
          <span data-testid="topic-thread" className="min-w-0 flex-1 truncate">
            {thread}
            {showProject && t.project_name && <span className="text-subtle"> · {t.project_name}</span>}
          </span>
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
      </ContextMenu>
    </>
  )
}
