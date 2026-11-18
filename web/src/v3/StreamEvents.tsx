// The agent stream's task lines: between the messages, in time order, the tasks this agent is on
// being created, changing status (or reopened) and renamed. Small and secondary, like the hand-off
// lines of a task's view; the title opens the task. Step and criterion ticks are not shown: the
// checklist has them, and a line for each would bury the conversation.
import { hhmm, short, tagColor, type TaskStatus } from './data'
import { useNav } from './parts'

export type StreamTaskEvent = {
  id: string
  task_id: string
  at: string
  kind: 'created' | 'status' | 'title'
  title: string
  task_kind?: string
  status?: TaskStatus
  reopened?: boolean
  by_you?: boolean
  old_title?: string
  new_title?: string
}

const WORD: Record<TaskStatus, string> = { working: 'working', needs_you: 'needs you', blocked: 'blocked', done: 'done' }
const DOT: Record<TaskStatus, string> = { working: 'var(--mb-work)', needs_you: 'var(--mb-wait)', blocked: 'var(--mb-danger)', done: 'var(--mb-faint)' }

/** The events shown before each message (by id), and the ones after the last. An event in the same
 *  millisecond as a message goes before an agent's message (it changed the task, then said so) and
 *  after the person's (a message about a done task reopens it). */
export function groupTaskEvents(messages: { id: string; created_at: string; author: string }[], events: StreamTaskEvent[]) {
  const before = new Map<string, StreamTaskEvent[]>()
  const tail: StreamTaskEvent[] = []
  for (const ev of events) {
    const t = Date.parse(ev.at)
    const m = messages.find((x) => {
      const mt = Date.parse(x.created_at)
      return mt > t || (mt === t && x.author === 'agent')
    })
    if (m) before.set(m.id, [...(before.get(m.id) ?? []), ev])
    else tail.push(ev)
  }
  return { before, tail }
}

export function StreamTaskEventLine({ ev }: { ev: StreamTaskEvent }) {
  const nav = useNav()
  const goal = ev.task_kind === 'goal'
  const title = (
    <span className="v-task" style={{ ['--c' as string]: tagColor(ev.task_id), maxWidth: 360 }} title={ev.title}>
      <button type="button" className="v-task-t" data-testid="stream-event-task" onClick={() => nav.task(ev.task_id)}>
        {goal ? '◎ ' : ''}
        {short(ev.title, 60)}
      </button>
    </span>
  )
  const who = ev.by_you ? <span style={{ color: 'var(--mb-faint)' }}>· by you</span> : null
  let dot = 'var(--mb-faint)'
  let body
  if (ev.kind === 'created') {
    dot = 'var(--mb-work)'
    body = (
      <>
        <span>＋ New {goal ? 'goal' : 'task'}:</span> {title} {who}
      </>
    )
  } else if (ev.kind === 'title') {
    body = (
      <>
        <span>Renamed{ev.old_title ? <> “{short(ev.old_title, 50)}” →</> : ' to'}</span> {title} {who}
      </>
    )
  } else {
    const st = ev.status ?? 'working'
    dot = DOT[st]
    body = (
      <>
        {title} <span>{ev.reopened ? (st === 'working' ? 'reopened' : `reopened → ${WORD[st]}`) : `→ ${WORD[st]}`}</span> {who}
      </>
    )
  }
  return (
    <div className="v-ev" data-testid="stream-event" data-kind={ev.kind} data-task={ev.task_id} data-status={ev.status} style={{ flexWrap: 'wrap', minWidth: 0 }}>
      <span className="v-tm">{hhmm(ev.at)}</span>
      <span className="v-m" style={{ background: dot }} />
      {body}
    </div>
  )
}
