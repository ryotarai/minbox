// Task columns on an agent's page: the tasks checked in its Tasks pane side by side, TweetDeck-like,
// in place of its stream. Each column is a task's conversation (TaskView's column mode: a short header,
// its messages scrolled to the newest, a reply box to the agent last active on it). "All" is every open
// task of the agent (also the ones that start later). The choice is kept per agent in this browser;
// "Stream" shows the agent's stream again without forgetting it. Tablet: one column at a time, with a
// tab per checked task. Phone: no columns (the stream; a task is a tap away in the sheet's Tasks).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Attachment } from '../api'
import { useApp } from '../lib/app'
import type { BoardTask, V3Message } from './data'
import { StatusDot } from './parts'
import { TaskView } from './TaskView'

// ---- the checked tasks of each agent (localStorage) ----

/** all: every open task (the ones that come later too); ids: the tasks checked one by one; stream: the
 *  stream is shown for now (the checks are kept). */
export type ColumnPick = { all: boolean; ids: string[]; stream: boolean }
const PREFIX = 'minbox:v3-columns:'
const NONE: ColumnPick = { all: false, ids: [], stream: false }
const subs = new Set<() => void>()
const cache = new Map<string, ColumnPick>()

function read(sessionId: string): ColumnPick {
  const hit = cache.get(sessionId)
  if (hit) return hit
  let p = NONE
  try {
    const v = JSON.parse(localStorage.getItem(PREFIX + sessionId) ?? 'null') as Partial<ColumnPick> | null
    if (v) p = { all: !!v.all, ids: Array.isArray(v.ids) ? v.ids.filter((x) => typeof x === 'string') : [], stream: !!v.stream }
  } catch {
    /* off or broken: nothing checked */
  }
  cache.set(sessionId, p)
  return p
}

function write(sessionId: string, p: ColumnPick) {
  cache.set(sessionId, p)
  try {
    if (!p.all && !p.ids.length) localStorage.removeItem(PREFIX + sessionId)
    else localStorage.setItem(PREFIX + sessionId, JSON.stringify(p))
  } catch {
    /* storage full or off: kept for this page */
  }
  subs.forEach((f) => f())
}

if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith(PREFIX)) return
    cache.delete(e.key.slice(PREFIX.length))
    subs.forEach((f) => f())
  })

/** A task in the columns' sense: open = not done. */
export const isOpenTask = (t: BoardTask) => t.status !== 'done'

const byStart = (a: BoardTask, b: BoardTask) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)

/**
 * The agent's checked tasks (of `tasks`, its open and done ones; oldest first, so a column keeps its
 * place while its task gets busy) and the checkboxes' actions. "All" is tri-state: on (every open
 * task), some, off. columns: the columns are what the agent's page shows now.
 */
export function useColumnPick(sessionId: string, tasks: BoardTask[]) {
  const pick = useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => read(sessionId),
  )
  const ordered = useMemo(() => [...tasks].sort(byStart), [tasks])
  const open = ordered.filter(isOpenTask)
  const has = (t: BoardTask) => pick.ids.includes(t.id) || (pick.all && isOpenTask(t))
  const selected = ordered.filter(has)
  const openChecked = open.filter(has).length
  const allState: 'on' | 'off' | 'some' = open.length === 0 ? (pick.all ? 'on' : 'off') : openChecked === open.length ? 'on' : openChecked === 0 ? 'off' : 'some'
  const set = (p: Omit<ColumnPick, 'stream'>, stream = false) => write(sessionId, { ...p, stream })
  const toggle = (t: BoardTask) => {
    if (has(t)) {
      // Unchecking one of "All": the others stay checked, one by one.
      const ids = pick.all ? [...new Set([...open.map((x) => x.id), ...pick.ids])] : pick.ids
      set({ all: false, ids: ids.filter((x) => x !== t.id) }, pick.stream)
    } else {
      const ids = [...pick.ids, t.id]
      // Every open task checked: that is "All" again (the next tasks come in too).
      const all = isOpenTask(t) && open.every((x) => x.id === t.id || ids.includes(x.id) || (pick.all && isOpenTask(x)))
      set(all ? { all: true, ids: ids.filter((x) => !open.some((o) => o.id === x)) } : { all: pick.all, ids })
    }
  }
  const toggleAll = () => (allState === 'on' ? set({ all: false, ids: pick.ids.filter((x) => !open.some((o) => o.id === x)) }) : set({ all: true, ids: pick.ids.filter((x) => !open.some((o) => o.id === x)) }))
  const clear = () => set({ all: false, ids: [] })
  const showStream = (stream: boolean) => write(sessionId, { ...pick, stream })
  return { selected, has, toggle, toggleAll, clear, allState, open, stream: pick.stream, showStream, columns: selected.length > 0 && !pick.stream }
}
export type ColumnPickState = ReturnType<typeof useColumnPick>

/** A checkbox that shows "some" as the indeterminate state. */
export function TriBox({ state, onChange, label, testid }: { state: 'on' | 'off' | 'some'; onChange: () => void; label: string; testid: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])
  return <input ref={ref} type="checkbox" aria-label={label} data-testid={testid} data-state={state} checked={state === 'on'} onChange={onChange} />
}

/** The bar over the agent's page while tasks are checked: Stream | Columns, and Clear. */
export function ColumnsBar({ pick }: { pick: ColumnPickState }) {
  const n = pick.selected.length
  return (
    <div className="v-colsbar" data-testid="columns-bar">
      <div className="v-seg" role="group" aria-label="Show">
        <button type="button" className={pick.stream ? 'on' : ''} aria-pressed={pick.stream} data-testid="show-stream" title="The agent's whole stream (the checked tasks stay checked)" onClick={() => pick.showStream(true)}>
          Stream
        </button>
        <button type="button" className={pick.stream ? '' : 'on'} aria-pressed={!pick.stream} data-testid="show-columns" title="The checked tasks side by side" onClick={() => pick.showStream(false)}>
          ▥ Columns <b>{n}</b>
        </button>
      </div>
      <span className="v-cnt2 v-hide-phone">
        {n} task{n === 1 ? '' : 's'} checked in Tasks
      </span>
      <button type="button" className="v-link" data-testid="columns-clear" style={{ marginLeft: 'auto' }} title="Uncheck every task: back to the stream" onClick={pick.clear}>
        Clear
      </button>
    </div>
  )
}

/** The checked tasks as columns: side by side (equal widths, scrolling sideways), or on a tablet one
 *  at a time with a tab each. */
export function AgentColumns({ pick, tasks, onOpenAttachment }: { pick: ColumnPickState; tasks: BoardTask[]; onOpenAttachment: (a: Attachment, m: V3Message) => void }) {
  const { isTablet } = useApp()
  const sel = pick.selected
  const [cur, setCur] = useState<string | null>(null)
  const column = (t: BoardTask) => (
    <div key={t.id} className="v-colcell">
      <TaskView id={t.id} highlight={null} tasks={tasks} onOpenAttachment={onOpenAttachment} column={{ onRemove: () => pick.toggle(t) }} />
    </div>
  )
  if (isTablet) {
    const active = sel.find((t) => t.id === cur) ?? sel[0]
    return (
      <div className="v-colsone" data-testid="columns" data-tabs="true">
        <div className="v-coltabs" role="tablist" data-testid="columns-tabs">
          {sel.map((t) => (
            <button type="button" role="tab" key={t.id} aria-selected={t === active} className={'v-coltab' + (t === active ? ' on' : '')} data-testid="columns-tab" data-task={t.id} onClick={() => setCur(t.id)}>
              <StatusDot t={t} />
              {t.title}
            </button>
          ))}
        </div>
        {active && column(active)}
      </div>
    )
  }
  return (
    <div className="v-colstrip" data-testid="columns">
      {sel.map(column)}
    </div>
  )
}
