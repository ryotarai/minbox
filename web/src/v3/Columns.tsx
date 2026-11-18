// Columns (#v=columns): several tasks side by side, TweetDeck-like. Each column is a task's
// conversation (TaskView's, with a short header): its messages, scrolled to the newest, and a reply box
// to the agent last active on it. The tasks list on the left has a checkbox per task and an "All" one
// (every task not done, also the ones that start later). The choice is kept in this browser. On a
// phone: one column at a time, with tabs for the checked tasks.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Attachment } from '../api'
import { useApp } from '../lib/app'
import type { BoardTask, V3Message } from './data'
import { BackButton, StatusDot } from './parts'
import { TaskView } from './TaskView'

// ---- the checked tasks (localStorage, shared by every list that shows checkboxes) ----

/** all: every open task (the ones that come later too); ids: the tasks checked one by one. */
export type ColumnPick = { all: boolean; ids: string[] }
const KEY = 'minbox:v3-columns'
const subs = new Set<() => void>()
let cache: ColumnPick | null = null

function read(): ColumnPick {
  if (cache) return cache
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ColumnPick> | null
    cache = { all: !!v?.all, ids: Array.isArray(v?.ids) ? v!.ids.filter((x) => typeof x === 'string') : [] }
  } catch {
    cache = { all: false, ids: [] }
  }
  return cache
}

function write(p: ColumnPick) {
  cache = p
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* storage full or off: kept for this page */
  }
  subs.forEach((f) => f())
}

if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    cache = null
    subs.forEach((f) => f())
  })

/** A task in the columns' sense: open = not done. */
export const isOpenTask = (t: BoardTask) => t.status !== 'done'

/**
 * The checked tasks of `tasks` (in their order) and the checkboxes' actions. "All" is tri-state:
 * on (every open task), partial (some), off.
 */
export function useColumnPick(tasks: BoardTask[]) {
  const pick = useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    read,
  )
  const open = tasks.filter(isOpenTask)
  const has = (t: BoardTask) => pick.ids.includes(t.id) || (pick.all && isOpenTask(t))
  const selected = tasks.filter(has)
  const openChecked = open.filter(has).length
  const allState: 'on' | 'off' | 'some' = open.length === 0 ? (pick.all ? 'on' : 'off') : openChecked === open.length ? 'on' : openChecked === 0 ? 'off' : 'some'
  const toggle = (t: BoardTask) => {
    if (has(t)) {
      // Unchecking one of "All": the others stay checked, one by one.
      const ids = pick.all ? [...new Set([...open.map((x) => x.id), ...pick.ids])] : pick.ids
      write({ all: false, ids: ids.filter((x) => x !== t.id) })
    } else {
      const ids = [...pick.ids, t.id]
      // Every open task checked: that is "All" again (the next tasks come in too).
      const all = open.every((x) => x.id === t.id || ids.includes(x.id) || (pick.all && isOpenTask(x)))
      write(all ? { all: true, ids: ids.filter((x) => !open.some((o) => o.id === x)) } : { all: pick.all, ids })
    }
  }
  const toggleAll = () => write(allState === 'on' ? { all: false, ids: [] } : { all: true, ids: pick.ids.filter((x) => !open.some((o) => o.id === x)) })
  return { selected, has, toggle, toggleAll, allState, open }
}

/** A checkbox that shows "some" as the indeterminate state. */
function TriBox({ state, onChange, label, testid }: { state: 'on' | 'off' | 'some'; onChange: () => void; label: string; testid: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])
  return <input ref={ref} type="checkbox" aria-label={label} data-testid={testid} data-state={state} checked={state === 'on'} onChange={onChange} />
}

/** The tasks list with checkboxes: All, then the open tasks (and any done one still checked). */
export function ColumnPicker({ tasks, pick }: { tasks: BoardTask[]; pick: ReturnType<typeof useColumnPick> }) {
  const shown = tasks.filter((t) => isOpenTask(t) || pick.has(t))
  return (
    <div className="v-colpick" data-testid="columns-picker">
      <label className="v-colpick-row v-colpick-all">
        <TriBox state={pick.allState} onChange={pick.toggleAll} label="All open tasks" testid="columns-all" />
        <span className="v-colpick-t">All</span>
        <span className="v-cnt2">
          {pick.selected.length}/{pick.open.length}
        </span>
      </label>
      {shown.map((t) => (
        <label key={t.id} className="v-colpick-row" data-testid="columns-pick" data-task={t.id} title={t.summary || t.title}>
          <input type="checkbox" aria-label={`Show “${t.title}” as a column`} checked={pick.has(t)} onChange={() => pick.toggle(t)} />
          <StatusDot t={t} />
          <span className="v-colpick-t">
            {t.kind === 'goal' && <span style={{ color: 'var(--mb-purple)' }}>◎ </span>}
            {t.title}
          </span>
          {t.unread > 0 && <span className="v-badge u">{t.unread}</span>}
        </label>
      ))}
      {shown.length === 0 && <div className="v-empty">No open tasks.</div>}
    </div>
  )
}

const LIST_KEY = 'minbox:v3-columns-list'

export function ColumnsView({ tasks, onOpenAttachment }: { tasks: BoardTask[]; onOpenAttachment: (a: Attachment, m: V3Message) => void }) {
  const { isPhone } = useApp()
  // Oldest first, as they started: a column keeps its place while its task gets busy.
  const ordered = useMemo(() => [...tasks].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)), [tasks])
  const pick = useColumnPick(ordered)
  const sel = pick.selected
  const [listOpen, setListOpen] = useState(() => {
    try {
      return localStorage.getItem(LIST_KEY) !== '0'
    } catch {
      return true
    }
  })
  const showList = (v: boolean) => {
    setListOpen(v)
    try {
      localStorage.setItem(LIST_KEY, v ? '1' : '0')
    } catch {
      /* off */
    }
  }
  // Phone: the column shown (a tab per checked task); the list instead while none is checked.
  const [cur, setCur] = useState<string | null>(null)
  const [phoneList, setPhoneList] = useState(false)
  const active = sel.find((t) => t.id === cur) ?? sel[0]
  const empty = (
    <div className="v-empty" data-testid="columns-empty">
      Check tasks {isPhone ? 'in the list' : 'on the left'} to show them side by side, or check All for every open task.
    </div>
  )
  const column = (t: BoardTask) => (
    <div key={t.id} className="v-colcell">
      <TaskView id={t.id} highlight={null} tasks={tasks} onOpenAttachment={onOpenAttachment} column={{ onRemove: () => pick.toggle(t) }} />
    </div>
  )
  if (isPhone) {
    const list = phoneList || sel.length === 0
    return (
      <div className="v-col v-columns" data-testid="columns-view">
        <div className="v-head">
          <div className="v-r1">
            <BackButton tasks={tasks} />
            <h1>Columns</h1>
            <button type="button" className={'v-btn' + (list ? ' pri' : '')} data-testid="columns-list-toggle" aria-pressed={list} onClick={() => setPhoneList(!phoneList)} disabled={sel.length === 0}>
              Tasks
            </button>
          </div>
          {!list && (
            <div className="v-coltabs" role="tablist" data-testid="columns-tabs">
              {sel.map((t) => (
                <button type="button" role="tab" key={t.id} aria-selected={t === active} className={'v-coltab' + (t === active ? ' on' : '')} data-testid="columns-tab" data-task={t.id} onClick={() => setCur(t.id)}>
                  <StatusDot t={t} />
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </div>
        {list ? (
          <div className="v-scroll">
            <ColumnPicker tasks={ordered} pick={pick} />
            {sel.length === 0 && empty}
          </div>
        ) : (
          active && column(active)
        )}
      </div>
    )
  }
  return (
    <div className="v-col v-columns" data-testid="columns-view">
      <div className="v-head">
        <div className="v-r1">
          <BackButton tasks={tasks} />
          <h1>Columns</h1>
          <button type="button" className="v-btn" data-testid="columns-list-toggle" aria-pressed={listOpen} onClick={() => showList(!listOpen)}>
            {listOpen ? 'Hide tasks' : 'Tasks…'}
          </button>
        </div>
        <div className="v-r2">
          {sel.length} of {pick.open.length} open task{pick.open.length === 1 ? '' : 's'} side by side
          {sel.some((t) => !isOpenTask(t)) ? ` · ${sel.filter((t) => !isOpenTask(t)).length} done` : ''}
        </div>
      </div>
      <div className="v-colsbody">
        {listOpen && <ColumnPicker tasks={ordered} pick={pick} />}
        <div className="v-colstrip" data-testid="columns">
          {sel.map(column)}
          {sel.length === 0 && empty}
        </div>
      </div>
    </div>
  )
}
