// An agent's tasks: its open ones (each with where it stands) and the ones done this week, folded.
// On a desktop or tablet they are a pane of their own between the agents list and the stream (its
// width dragged and kept, folded to a strip with ⇧T); on a phone they are the first tab of the agent's
// sheet ("Tasks N ›").
import { useEffect, useRef } from 'react'
import { ago, standing, STATUS_LABEL, type BoardTask } from './data'
import { Bar, StatusDot, useNav } from './parts'
import { IconTasks } from '../components/icons'

/** The tasks an agent works on: open first, then done. */
export function agentTasks(tasks: BoardTask[], sessionId: string) {
  const mine = tasks.filter((t) => t.agents.some((a) => a.session_id === sessionId))
  return { open: mine.filter((t) => t.status !== 'done'), done: mine.filter((t) => t.status === 'done') }
}

/** The list itself (OPEN TASKS, then DONE THIS WEEK folded). onOpen runs before the task opens. */
export function AgentTaskList({ tasks, sessionId, onOpen }: { tasks: BoardTask[]; sessionId: string; onOpen?: () => void }) {
  const nav = useNav()
  const { open, done } = agentTasks(tasks, sessionId)
  const go = (id: string) => {
    onOpen?.()
    nav.task(id)
  }
  return (
    <div className="v-agtasks" data-testid="agent-tasks">
      <div className="v-sec">
        OPEN TASKS <span className="v-x">{open.length}</span>
      </div>
      {open.map((t) => (
        <button type="button" key={t.id} className="v-mt" data-testid="agent-task" data-task={t.id} onClick={() => go(t.id)}>
          <div className="v-a">
            <StatusDot t={t} />
            {t.kind === 'goal' ? '◎ ' : ''}
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
        </button>
      ))}
      {!open.length && <div className="v-cnt2">No open tasks. Ask for something; the agent makes a task when it is new work.</div>}
      {done.length > 0 && (
        <details className="v-donelist">
          <summary className="v-sec">
            DONE THIS WEEK <span className="v-x">{done.length}</span>
          </summary>
          {done.map((t) => (
            <button type="button" key={t.id} className="v-mt" data-testid="agent-task" data-task={t.id} onClick={() => go(t.id)}>
              <div className="v-a">
                <StatusDot t={t} />
                {t.title}
              </div>
              <TaskSubtitle t={t} />
            </button>
          ))}
        </details>
      )}
    </div>
  )
}

/**
 * The Tasks pane beside the stream (desktop and tablet). Shown, it lists the tasks under a header with
 * a fold button; folded, a narrow strip with the open count unfolds it. overlay: there is no room for
 * it beside the stream (a tablet, or a narrow window with the terminal open), so unfolded it lies over
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
  const { open } = agentTasks(tasks, sessionId)
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
      aria-label={`${shown ? 'Hide' : 'Show'} tasks (${open.length} open)`}
      title={`${shown ? 'Hide' : 'Show'} the agent's tasks (⇧T)`}
      onClick={() => onToggle(!shown)}
    >
      <IconTasks size={14} />
      <span className="v-tasks-strip-l">Tasks</span>
      <b>{open.length}</b>
    </button>
  )
  return (
    <div ref={ref} className={'v-tasks-wrap' + (overlay ? ' overlay' : '')} data-testid="tasks-pane" data-shown={shown} data-overlay={overlay || undefined}>
      {(!shown || overlay) && strip}
      {shown && (
        <aside className="v-tasks" aria-label="Tasks of the agent">
          <div className="v-tasks-h">
            TASKS
            <button
              type="button"
              className="v-iconbtn"
              data-testid={overlay ? 'tasks-pane-close' : 'tasks-pane-toggle'}
              aria-expanded={true}
              aria-label="Hide tasks"
              title="Hide the tasks (⇧T)"
              onClick={() => onToggle(false)}
            >
              «
            </button>
          </div>
          <div className="v-tasks-body">
            <AgentTaskList tasks={tasks} sessionId={sessionId} onOpen={overlay ? () => onToggle(false) : undefined} />
          </div>
        </aside>
      )}
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
