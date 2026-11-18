// An agent's tasks: its open ones (each with where it stands), the ones just done (muted, a line each),
// and the rest done this week, folded.
// On a desktop or tablet they are a pane of their own between the agents list and the stream (its
// width dragged and kept, folded to a strip with ⇧T); on a phone they are the first tab of the agent's
// sheet ("Tasks N ›"). In the pane each task has a checkbox (and "All" one on top): the checked tasks
// show side by side in place of the stream (see Columns). While the stream is not shown (columns, or one
// task picked by its title), the pane ends with a message box to the agent itself (see PaneComposer).
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../lib/app'
import { ago, standing, STATUS_LABEL, unreadCls, v3, type BoardTask } from './data'
import { Composer, type Outgoing } from './Composer'
import { Bar, StatusDot, useNav } from './parts'
import { IconCheck, IconCheckSquare, IconFoldLeft, IconGoal, IconTasks } from '../components/icons'
import { TriBox, useColumnPick, type ColumnPickState } from './Columns'

/** The tasks an agent works on: open first, then done. */
export function agentTasks(tasks: BoardTask[], sessionId: string) {
  const mine = tasks.filter((t) => t.agents.some((a) => a.session_id === sessionId))
  return { open: mine.filter((t) => t.status !== 'done'), done: mine.filter((t) => t.status === 'done') }
}

/** How long a done task stays in the list as RECENTLY DONE (then it folds into DONE THIS WEEK). */
export const RECENT_DONE_MS = 3 * 3600 * 1000
/** At most this many recently done ones (the newest); older ones fold. */
export const RECENT_DONE_MAX = 5

const doneAt = (t: BoardTask) => new Date(t.done_at ?? t.updated_at).getTime()

/** Splits the done tasks: recent (done in the last RECENT_DONE_MS, newest first, at most RECENT_DONE_MAX)
 *  and the rest (DONE THIS WEEK, folded); each task in one of them only. */
export function splitDone(done: BoardTask[], now: number) {
  const sorted = [...done].sort((a, z) => doneAt(z) - doneAt(a))
  const recent = sorted.filter((t) => now - doneAt(t) < RECENT_DONE_MS).slice(0, RECENT_DONE_MAX)
  const ids = new Set(recent.map((t) => t.id))
  return { recent, older: sorted.filter((t) => !ids.has(t.id)) }
}

/** The time now, again every minute (a recently done task folds once its window has passed). */
function useMinute() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(iv)
  }, [])
  return now
}

/** The list itself (OPEN TASKS, then RECENTLY DONE muted, then DONE THIS WEEK folded). onOpen runs before the task opens. pick: a
 *  checkbox per task (shown as a column on the agent's page). onSelect: a task opens there (in the
 *  agent's page, selected: the one shown; clicking it again closes it) instead of the task view. */
export function AgentTaskList({ tasks, sessionId, onOpen, pick, onSelect, selected }: { tasks: BoardTask[]; sessionId: string; onOpen?: () => void; pick?: ColumnPickState; onSelect?: (id: string) => void; selected?: string | null }) {
  const nav = useNav()
  const { open, done: allDone } = agentTasks(tasks, sessionId)
  const now = useMinute()
  const { recent, older: done } = splitDone(allDone, now)
  const go = (id: string) => {
    onOpen?.()
    if (onSelect) onSelect(id)
    else nav.task(id)
  }
  const sel = (t: BoardTask) => (selected === t.id ? { 'aria-current': true as const, className: 'v-mt sel' } : { className: 'v-mt' })
  // With checkboxes: the box beside the row (the row still opens the task).
  const row = (t: BoardTask, el: React.ReactElement) =>
    pick ? (
      <div key={t.id} className="v-mt-row">
        <input type="checkbox" className="v-mt-check" data-testid="agent-task-check" data-task={t.id} aria-label={`Show “${t.title}” as a column`} title="Show it as a column beside the others" checked={pick.has(t)} onChange={() => pick.toggle(t)} />
        {el}
      </div>
    ) : (
      el
    )
  return (
    <div className="v-agtasks" data-testid="agent-tasks">
      <div className="v-sec">
        {pick && open.length > 0 && <TriBox state={pick.allState} onChange={pick.toggleAll} label="All open tasks as columns" testid="agent-tasks-all" />}
        OPEN TASKS <span className="v-x">{open.length}</span>
      </div>
      {open.map((t) => row(t,
        <button type="button" key={t.id} {...sel(t)} data-testid="agent-task" data-task={t.id} onClick={() => go(t.id)}>
          <div className={'v-a' + unreadCls(t)} data-unread={(t.unread ?? 0) > 0 || undefined}>
            <StatusDot t={t} />
            {t.kind === 'goal' && <IconGoal size={14} className="v-goal" />}
            {t.title}
          </div>
          <TaskSubtitle t={t} />
          <div className="v-b">
            <Bar t={t} />
            <span className="v-cnt2">
              {STATUS_LABEL[t.status]}
              {t.open_questions ? ' · ? ' + t.open_questions : ''} · {ago(t.last_activity)}
            </span>
          </div>
        </button>,
      ))}
      {!open.length && <div className="v-cnt2">No open tasks. Ask for something; the agent makes a task when it is new work.</div>}
      {recent.length > 0 && (
        <div className="v-recentdone" data-testid="agent-tasks-recent">
          <div className="v-sec">
            RECENTLY DONE <span className="v-x">{recent.length}</span>
          </div>
          {recent.map((t) => row(t,
            <button type="button" key={t.id} {...sel(t)} data-testid="agent-task" data-task={t.id} data-recent-done="" title={`${t.title} · done ${ago(t.done_at ?? t.updated_at)}`} onClick={() => go(t.id)}>
              <div className="v-a">
                <IconCheck size={12} className="v-rd-check" />
                <span className="v-rd-t">{t.title}</span>
                <span className="v-rd-ago">{ago(t.done_at ?? t.updated_at)}</span>
              </div>
            </button>,
          ))}
        </div>
      )}
      {done.length > 0 && (
        <details className="v-donelist">
          <summary className="v-sec">
            DONE THIS WEEK <span className="v-x">{done.length}</span>
          </summary>
          {done.map((t) => row(t,
            <button type="button" key={t.id} {...sel(t)} data-testid="agent-task" data-task={t.id} onClick={() => go(t.id)}>
              <div className={'v-a' + unreadCls(t)} data-unread={(t.unread ?? 0) > 0 || undefined}>
                <StatusDot t={t} />
                {t.title}
              </div>
              <TaskSubtitle t={t} />
            </button>,
          ))}
        </details>
      )}
    </div>
  )
}

/**
 * The Tasks pane beside the stream (desktop and tablet). Shown, it lists the tasks under a header with
 * a fold button; folded, a narrow strip with the open count unfolds it. overlay: there is no room for
 * it beside the stream (the stream would get narrower than MIN_STREAM: a narrow window or tablet with
 * the terminal open), so unfolded it lies over
 * the stream and folds again when a task opens, on Esc or a click outside.
 */
export function TasksPane({
  tasks,
  sessionId,
  shown,
  overlay,
  onToggle,
}: {
  tasks: BoardTask[]
  sessionId: string
  shown: boolean
  overlay: boolean
  onToggle: (show: boolean) => void
}) {
  const { open, done } = agentTasks(tasks, sessionId)
  const own = useColumnPick(sessionId, [...open, ...done])
  const checked = own.selected.length
  const unread = [...open, ...done].filter((t) => (t.unread ?? 0) > 0).length
  // A title shows that one task in the agent's page (#…&k=: a first one pushes, another replaces, so ‹
  // goes back to the stream; the shown one again closes it, back to the stream); a checkbox shows the
  // checked ones as columns (leaving the one task).
  const { route, navigate } = useApp()
  const detail = route.view === 'agent' ? route.k : null
  const select = (id: string) =>
    id === detail ? navigate({ k: null }, { push: false }) : navigate({ view: 'agent', s: sessionId, k: id, m: null, tab: 'inbox' }, { push: !detail })
  const leave = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
    f(...a)
    if (detail) navigate({ k: null }, { push: false })
  }
  const pick = { ...own, toggle: leave(own.toggle), toggleAll: leave(own.toggleAll), clear: leave(own.clear) }
  const ref = useRef<HTMLDivElement>(null)
  const floating = overlay && shown
  useEffect(() => {
    if (!floating) return
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onToggle(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopImmediatePropagation()
      onToggle(false)
    }
    document.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [floating, onToggle])
  const strip = (
    <button
      type="button"
      className="v-tasks-strip"
      data-testid="tasks-pane-toggle"
      aria-expanded={shown}
      aria-label={`${shown ? 'Hide' : 'Show'} tasks (${open.length} open${checked ? `, ${checked} checked` : ''})`}
      title={`${shown ? 'Hide' : 'Show'} the agent's tasks (⇧T)`}
      onClick={() => onToggle(!shown)}
    >
      <IconTasks size={14} />
      <span className="v-tasks-strip-l">Tasks</span>
      <b>{open.length}</b>
      {unread > 0 && <span className="v-unread" data-testid="tasks-strip-unread" title={`${unread} with unread messages`} />}
      {checked > 0 && (
        <span className="v-tasks-strip-checked" data-testid="tasks-strip-checked" title={`${checked} checked: shown as columns`}>
          <IconCheckSquare size={12} />
          {checked}
        </span>
      )}
    </button>
  )
  return (
    <div ref={ref} className={'v-tasks-wrap' + (overlay ? ' overlay' : '')} data-testid="tasks-pane" data-shown={shown} data-overlay={overlay || undefined}>
      {(!shown || overlay) && strip}
      {shown && (
        <aside className="v-tasks" aria-label="Tasks of the agent">
          <div className="v-tasks-h">
            TASKS
            {checked > 0 && (
              <button type="button" className="v-link v-tasks-clear" data-testid="tasks-clear" title="Uncheck every task: back to the stream" onClick={pick.clear}>
                {checked} checked · Clear
              </button>
            )}
            <button
              type="button"
              className="v-iconbtn"
              data-testid={overlay ? 'tasks-pane-close' : 'tasks-pane-toggle'}
              aria-expanded={true}
              aria-label="Hide tasks"
              title="Hide the tasks (⇧T)"
              onClick={() => onToggle(false)}
            >
              <IconFoldLeft size={14} />
            </button>
          </div>
          <div className="v-tasks-body">
            <AgentTaskList tasks={tasks} sessionId={sessionId} pick={pick} onSelect={select} selected={detail} onOpen={overlay ? () => onToggle(false) : undefined} />
          </div>
          {/* The stream has its own box (the same draft): this one only while the stream is not shown. */}
          {(detail || own.columns) && <PaneComposer sessionId={sessionId} tasks={tasks} />}
        </aside>
      )}
    </div>
  )
}

/**
 * The Tasks pane's message box: to the agent itself (it decides the task, as from its stream), with the
 * stream composer's draft (the same words and files, whichever box shows), so a message can go to the
 * agent while its columns or one task fill the page. The stream is hidden then, so a brief "Sent to
 * <agent> ✓" says it went (it shows in the stream as usual).
 */
function PaneComposer({ sessionId, tasks }: { sessionId: string; tasks: BoardTask[] }) {
  const { sessions, error } = useApp()
  const [sent, setSent] = useState(0)
  useEffect(() => {
    if (!sent) return
    const t = setTimeout(() => setSent(0), 2600)
    return () => clearTimeout(t)
  }, [sent])
  useEffect(() => setSent(0), [sessionId])
  const sess = (sessions ?? []).find((s) => s.id === sessionId)
  if (!sess) return null
  const send = async (o: Outgoing) => {
    try {
      const { to: _to, tasks: tids, ...rest } = o
      void _to
      await v3.send(sessionId, { ...rest, task_id: tids[0], uploads: o.uploads.length ? o.uploads : undefined })
      setSent(Date.now())
    } catch (e) {
      error(e)
      throw e
    }
  }
  return (
    <div className="v-tasks-compose">
      {sent > 0 && (
        <div key={sent} className="v-tasks-sent" role="status" data-testid="tasks-composer-sent">
          Sent to {sess.name} <IconCheck size={12} />
        </div>
      )}
      <Composer compact testid="tasks-composer" toId={sessionId} toOptions={[sess]} about={[]} tasks={tasks} draftKey={'v3:agent:' + sessionId} placeholder={`Message ${sess.name}…`} onSend={send} />
    </div>
  )
}

/** A task's subtitle in the agent's Tasks list: where it stands, in a line or two (see standing). */
function TaskSubtitle({ t }: { t: BoardTask }) {
  const st = standing(t)
  if (!st) return null
  return (
    <div className="v-mt-sub" data-testid="task-standing" data-from={st.from} title={st.text}>
      {st.from === 'step' ? 'now: ' : ''}
      {st.text}
    </div>
  )
}
