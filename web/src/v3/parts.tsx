// The pieces the v3 views share: task links, status dots, progress bars, checklists, the task picker,
// a message with the tasks it is about (and the agent's decision when it made one),
// its questions and actions (reply, copy, 👍, start a new thread from it, mark unread from it).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, type Answer, type Attachment, type Question, type Session, type Thread } from '../api'
import { backTarget, isPhoneWidth, useApp, type Route } from '../lib/app'
import { ContextMenu, useContextMenu } from '../components/ContextMenu'
import { ForkDialog } from '../components/ForkDialog'
import { Kbd, MenuItem } from '../components/ui'
import { proseOf, renderMarkdown, splitQuestions } from '../lib/markdown'
import { MessageBody } from '../components/MessageBody'
import { AttachmentTiles } from '../components/AttachmentTiles'
import { ActionItems, QuestionCard, answerIsEmpty } from '../components/QuestionCard'
import { CommandMessage } from '../components/CommandMessage'
import { IconBack, IconCheck, IconClose, IconFork, IconGoal, IconMoreV, IconPlus, IconRefresh, IconThumb } from '../components/icons'
import { parseTaskMessage } from '../lib/taskContext'
import {
  STATUS_LABEL,
  answerChoice,
  answerText,
  currentStep,
  hhmm,
  leaves,
  short,
  tagColor,
  textOf,
  v3,
  type BoardTask,
  type Step,
  type Task,
  type TaskEvent,
  type TaskRef,
  type V3Message,
} from './data'

export function useNav() {
  const { navigate } = useApp()
  return {
    board: () => navigate({ view: 'main', k: null, s: null, m: null, tab: 'inbox' }, { push: true }),
    task: (id: string, m?: string) => navigate({ view: 'task', k: id, m: m ?? null, tab: 'inbox' }, { push: true }),
    agent: (id: string, m?: string) => navigate({ view: 'agent', s: id, m: m ?? null, tab: 'inbox' }, { push: true }),
    agents: () => navigate({ view: 'agents', tab: 'inbox' }, { push: true }),
    search: () => navigate({ view: 'search', tab: 'inbox' }, { push: true }),
  }
}

/** Task titles the Board last listed: ‹ names a task also from Search or Settings. */
const taskTitles = new Map<string, string>()
export function rememberTaskTitles(tasks: { id: string; title: string }[]) {
  for (const t of tasks) taskTitles.set(t.id, t.title)
}

/** A route's name, for the ‹ back control ("‹ Board", "‹ Fix the gauge", "‹ api"). */
export function routeLabel(r: Route | null, tasks: { id: string; title: string }[], byId: Map<string, Session>): string {
  if (!r) return 'Board'
  switch (r.view) {
    case 'task':
      return (r.k && (tasks.find((t) => t.id === r.k)?.title ?? taskTitles.get(r.k))) || 'Task'
    case 'agent':
      return (r.s && byId.get(r.s)?.name) || 'Agent'
    case 'agents':
      // The Agents page is the phone's tab; wider, #v=agents shows the Board (the sidebar lists the agents).
      return isPhoneWidth() ? 'Agents' : 'Board'
    case 'search':
      return 'Search'
    case 'settings':
      return 'Settings'
    case 'issues':
      return 'My issues'
    case 'slack':
      return 'Slack'
    default:
      return r.s ? (byId.get(r.s)?.name ?? 'Agent') : 'Board'
  }
}

/**
 * ‹ back, at the start of a view's header: to where the person came from in the app (as the
 * browser's back would), or to the Board when the view was opened directly (a link, a reload).
 * It names where it leads; Esc does the same on a keyboard.
 */
export function BackButton({ tasks = [], fallback }: { tasks?: { id: string; title: string }[]; fallback?: Partial<Route> }) {
  const { goBack, route } = useApp()
  const byId = useSessionsById()
  void route // re-read history.state when the route changes
  const to = backTarget()
  const label = fallback && !to ? 'Back' : routeLabel(to, tasks, byId)
  return (
    <button type="button" className="v-back" data-testid="back" data-to={to ? to.view : 'board'} aria-label={`Back to ${label}`} title={`Back to ${label} (Esc)`} onClick={() => goBack(fallback)}>
      <IconBack size={16} />
      <span className="v-back-l">{label}</span>
    </button>
  )
}

export function useSessionsById(): Map<string, Session> {
  const { sessions } = useApp()
  return useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions])
}

export function agentName(byId: Map<string, Session>, id: string | undefined): string {
  if (!id) return 'agent'
  return byId.get(id)?.name || 'agent'
}

/**
 * How to tell same-named agents apart: "" for a name that is unique among the live agents, else what
 * differs (main, its title, or when it started).
 */
export function agentHint(all: Session[], a: Session): string {
  const same = all.filter((x) => x.name === a.name && !x.archived_at && x.kind !== 'shell')
  if (same.length < 2) return ''
  if (a.is_main) return 'main'
  const d = new Date(a.created_at ?? '')
  return isNaN(d.getTime()) ? a.id.slice(-4) : 'since ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A task as a plain link (its title), to open it. */
export function TaskChip({ task, shortN = 40, goal, onRemove }: { task: { task_id: string; title: string; status?: string }; shortN?: number; goal?: boolean; onRemove?: () => void }) {
  const nav = useNav()
  return (
    <span className="v-task" data-testid="task-link" data-task={task.task_id} title={task.title} style={{ ['--c' as string]: tagColor(task.task_id) }}>
      <button type="button" className="v-task-t" onClick={() => nav.task(task.task_id)}>
        {goal && <IconGoal size={14} className="v-goal" />}
        {short(task.title, shortN)}
      </button>
      {onRemove && (
        <button type="button" className="v-x" title="Not about this task" aria-label={`Not about ${task.title}`} onClick={onRemove}>
          <IconClose size={12} />
        </button>
      )}
    </span>
  )
}

/** The task a message is in (one per message): the one the agent decided on, else its first. */
export function msgTask(m: Pick<V3Message, 'tasks' | 'decision_task'>): TaskRef | undefined {
  return m.tasks.find((t) => t.task_id === m.decision_task) ?? m.tasks[0]
}

/**
 * The task of a message as a small pill at the top of its box: the task's status dot and its title,
 * which opens it.
 */
export function TaskBadge({ task, tasks }: { task: TaskRef; tasks: Task[] }) {
  const t = tasks.find((x) => x.id === task.task_id)
  return (
    <span className="v-tbadge" data-testid="task-badge" data-task={task.task_id}>
      <StatusDot t={{ status: t?.status ?? task.status, kind: t?.kind ?? '', needs_you: (t as BoardTask | undefined)?.needs_you }} />
      <TaskChip task={task} shortN={60} goal={t?.kind === 'goal'} />
    </span>
  )
}

/** "<agent> is working on this…" under a task's conversation while the task is Working (its status, not
 *  whether an agent's turn is running): a pulsing blue dot, a shimmer sweeping across the words and an
 *  ellipsis whose dots bounce in turn (all static with reduced motion). */
export function WorkingLine({ name }: { name: string }) {
  return (
    <div className="v-typing" data-testid="working-line">
      <span className="v-dot d-work v-live" aria-hidden />
      <span>
        <span className="v-typing-t">{name ? `${name} is working on this` : 'Working'}</span>
        <span className="v-ell" aria-hidden><i>.</i><i>.</i><i>.</i></span>
      </span>
    </div>
  )
}

export function StatusDot({ t, live }: { t: Pick<BoardTask, 'status' | 'kind'> & { needs_you?: boolean; open_questions?: number }; live?: boolean }) {
  const c = t.needs_you || (t.open_questions ?? 0) > 0 || t.status === 'needs_you' ? 'd-wait' : t.status === 'blocked' ? 'd-block' : t.status === 'done' ? 'd-done' : t.kind === 'goal' ? 'd-goal' : 'd-work'
  // A working task's blue dot pulses like a working agent's dot (v-live), wherever it is shown.
  return <span className={`v-dot ${c}${live || c === 'd-work' ? ' v-live' : ''}`} data-status={t.status} />
}

export function Bar({ t }: { t: BoardTask | Task }) {
  const isGoal = t.kind === 'goal' && (t.criteria?.length ?? 0) > 0
  const items: Step[] = isGoal ? t.criteria : leaves(t.steps)
  if (!items.length) return null
  const cur = isGoal ? undefined : currentStep(t.steps)
  const q = (t as BoardTask).needs_you
  return (
    <>
      <div className="v-bar" data-testid="progress">
        {items.map((s, i) => (
          <i key={i} className={s.done ? 'ok' : s === cur ? (q ? 'wt' : t.status === 'blocked' ? 'blk' : 'doing') : ''} />
        ))}
      </div>
      <span className="v-cnt2">
        {items.filter((s) => s.done).length}/{items.length}
      </span>
    </>
  )
}

export function Steps({ t, list, onToggle, criteria }: { t: Task; list?: Step[]; onToggle?: (path: number[]) => void; criteria?: boolean }) {
  const steps = list ?? (criteria ? t.criteria : t.steps)
  const cur = criteria ? undefined : currentStep(t.steps)
  const render = (items: Step[], base: number[]) => (
    <ul className="v-steps">
      {items.map((s, i) => (
        <li key={i}>
          <button type="button" className={'v-st' + (s.done ? ' done' : s === cur ? ' doing' : '')} data-testid={criteria ? 'criterion' : 'step'} onClick={() => !s.steps?.length && onToggle?.([...base, i])}>
            <span className="v-ck">{s.done && <IconCheck size={10} strokeWidth={3} />}</span>
            <span>{s.text}</span>
            {s === cur && !s.done && <span className="v-now">now</span>}
          </button>
          {s.steps?.length ? render(s.steps, [...base, i]) : null}
        </li>
      ))}
    </ul>
  )
  if (!steps.length) return <div className="v-cnt2">{criteria ? 'No criteria yet.' : 'No steps yet.'}</div>
  return render(steps, [])
}

/** Toggles a step by its path (one level of nesting); a parent is done when its sub-steps are. */
export function toggled(steps: Step[], path: number[]): Step[] {
  const next = steps.map((s) => ({ ...s, steps: s.steps?.map((c) => ({ ...c })) }))
  if (path.length === 1) next[path[0]!]!.done = !next[path[0]!]!.done
  else {
    const p = next[path[0]!]!
    p.steps![path[1]!]!.done = !p.steps![path[1]!]!.done
    p.done = p.steps!.every((c) => c.done)
  }
  return next
}

/** Events worth a line between a task's messages: a hand-off, an autonomous run starting, pausing or
 *  ending, and a rename (rare, and the old name is otherwise lost), which nothing else shows. Status,
 *  step, criterion and report changes already show in the checklist and on the board, so a line for
 *  each would only be noise in the conversation. */
export function shownEvent(e: TaskEvent): boolean {
  return e.kind === 'handoff' || e.kind === 'auto' || e.kind === 'title'
}

// ---- the task picker ----

export type PickResult = { task_id: string } | { title: string }

export function TaskPicker({ tasks, exclude, head, onPick, onClose }: { tasks: Task[]; exclude: string[]; head?: ReactNode; onPick: (r: PickResult) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const name = q.replace(/^#/, '').trim()
  const qq = name.toLowerCase()
  const opts = tasks.filter((t) => !exclude.includes(t.id) && t.status !== 'done' && t.title.toLowerCase().includes(qq)).slice(0, 7)
  const all: PickResult[] = [...opts.map((t) => ({ task_id: t.id })), ...(qq ? [{ title: name }] : [])]
  const cur = Math.min(sel, all.length - 1)
  useEffect(() => {
    const on = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', on)
    return () => document.removeEventListener('mousedown', on)
  }, [onClose])
  return (
    <div className="v-tagpop" ref={ref} data-testid="task-picker" onClick={(e) => e.stopPropagation()}>
      {head && <div className="v-hd">{head}</div>}
      <input
        autoFocus
        placeholder="Find a task, or name a new one…"
        value={q}
        aria-label="Task"
        onChange={(e) => {
          setQ(e.target.value)
          setSel(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setSel(Math.max(0, Math.min(all.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1))))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const o = all[cur]
            if (o) onPick(o)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      />
      {opts.map((t, i) => (
        <button type="button" key={t.id} className={'v-opt' + (i === cur ? ' sel' : '')} data-testid="task-option" onClick={() => onPick({ task_id: t.id })}>
          <StatusDot t={{ ...t, needs_you: t.status === 'needs_you' }} />
          {t.kind === 'goal' && <IconGoal size={14} className="v-goal" />}
          {t.title}
        </button>
      ))}
      {qq && (
        <button type="button" className={'v-opt' + (cur === opts.length ? ' sel' : '')} data-testid="task-new" onClick={() => onPick({ title: name })}>
          <IconPlus size={14} /> New task “{name}”
        </button>
      )}
      {!opts.length && !qq && <div className="v-hd">No open tasks yet. Type a name to make one.</div>}
    </div>
  )
}

// ---- questions ----
//
// Answering never sends by itself: a pick (a click or a tap) only selects, and the person can
// change it, answer the message's other questions, add a note or free text, then Send once (the
// button or ⌘↵). The picks are drafts kept per message (in this browser) until sent.

const ANS_KEY = 'minbox:v3:answers:'
const ansCache = new Map<string, Record<string, Answer>>()
const ansListeners = new Set<() => void>()
let ansVersion = 0
function loadAnswers(id: string): Record<string, Answer> {
  let v = ansCache.get(id)
  if (!v) {
    try {
      v = JSON.parse(localStorage.getItem(ANS_KEY + id) ?? '{}') as Record<string, Answer>
    } catch {
      v = {}
    }
    ansCache.set(id, v)
  }
  return v
}
function saveAnswers(id: string, v: Record<string, Answer>) {
  ansCache.set(id, v)
  try {
    if (Object.keys(v).length) localStorage.setItem(ANS_KEY + id, JSON.stringify(v))
    else localStorage.removeItem(ANS_KEY + id)
  } catch {
    /* private mode: kept in memory */
  }
  ansVersion++
  for (const l of ansListeners) l()
}

/** The person's not yet sent answers to a message's questions. */
export function useAnswerDrafts(messageId: string) {
  const drafts = useSyncExternalStore(
    (l) => {
      ansListeners.add(l)
      return () => ansListeners.delete(l)
    },
    () => loadAnswers(messageId),
  )
  return {
    drafts,
    set: (a: Answer) => {
      const cur = { ...loadAnswers(messageId) }
      if (answerIsEmpty(a)) delete cur[a.key]
      else cur[a.key] = a
      saveAnswers(messageId, cur)
    },
    clear: () => saveAnswers(messageId, {}),
  }
}

/** Re-renders when any message's drafted answers change. */
export function useAnswersVersion(): number {
  return useSyncExternalStore(
    (l) => {
      ansListeners.add(l)
      return () => ansListeners.delete(l)
    },
    () => ansVersion,
  )
}

/** The drafted (not yet sent) answers to a message's questions that still take one. */
export function draftedAnswers(m: V3Message): Answer[] {
  const d = loadAnswers(m.id)
  return openQuestions(m)
    .map((q) => d[q.key])
    .filter((a): a is Answer => !!a && !answerIsEmpty(a))
}

/** Drops a message's drafted answers (once sent). */
export function clearAnswers(id: string) {
  saveAnswers(id, {})
}

/** The questions of a message still waiting for an answer. */
export function openQuestions(m: V3Message): Question[] {
  return ((m.questions ?? []) as Question[]).filter((q) => !(m.answer_state?.[q.key] && !answerIsEmpty(m.answer_state[q.key])) && !(m.closed?.[q.key] && !['moved_on', 'replaced'].includes(m.closed[q.key]!)))
}

/** Sends the drafted answers of a message (to the agent that asked); clears them once sent. */
export async function sendAnswers(m: V3Message): Promise<Answer[]> {
  const list = Object.values(loadAnswers(m.id)).filter((a) => !answerIsEmpty(a))
  if (!list.length) return []
  await v3.send(m.session_id, { words: '', answers_for: m.id, answers: list }, m.thread_id)
  saveAnswers(m.id, {})
  return list
}

/** "N answered · Send": under a message's questions (stream, task view). */
export function AnswerBar({ m, onSent, testid = 'answers-send' }: { m: V3Message; onSent: (answers: Answer[]) => void; testid?: string }) {
  const { error } = useApp()
  const { drafts, clear } = useAnswerDrafts(m.id)
  const [busy, setBusy] = useState(false)
  const open = openQuestions(m)
  const n = open.filter((q) => drafts[q.key] && !answerIsEmpty(drafts[q.key])).length
  if (n === 0) return null
  const send = () => {
    setBusy(true)
    sendAnswers(m)
      .then(onSent)
      .catch(error)
      .finally(() => setBusy(false))
  }
  return (
    <div className="v-ansbar" data-testid="answer-bar" onClick={(e) => e.stopPropagation()}>
      <span>
        {n} of {open.length} answered
      </span>
      <span className="v-sp" />
      <button type="button" className="v-link" onClick={clear}>
        Clear
      </button>
      <span className="v-kbd v-hide-phone">⌘↵</span>
      <button type="button" className="v-btn pri" data-testid={testid} disabled={busy} onClick={send}>
        Send {n > 1 ? `${n} answers` : 'answer'}
      </button>
    </div>
  )
}

// ---- a message ----

type Menu = null | { mode: 'move' }

export function MessageView({
  m,
  tasks,
  ctx,
  unread,
  highlight,
  showAgent,
  onOpenAttachment,
  onChanged,
  inTask,
  repeat,
  onUnread,
  questionNear,
  latest,
}: {
  m: V3Message
  /** The person's answers: the message with the questions shows just above (its cards show the answers),
   *  so the answers are a short line here. Otherwise they show with their questions' prompts. */
  questionNear?: boolean
  tasks: Task[]
  /** The person's latest message here: once delivered, its header says ✓ delivered (older ones say nothing). */
  latest?: boolean
  /** Shown in this task's view: every message there is about it, so it shows no badge for it. */
  inTask?: string
  /** The message before it is in the same task: its badge is dimmed (a run reads as one). */
  repeat?: boolean
  ctx?: boolean
  unread?: boolean
  highlight?: boolean
  /** Name the agent's stream (the task view mixes streams). */
  showAgent?: boolean
  onOpenAttachment: (a: Attachment, m: V3Message) => void
  onChanged: () => void
  /** Mark unread from here: this message and the agent's later ones count as new again. */
  onUnread?: (m: V3Message) => void
}) {
  const { error, toast } = useApp()
  const ctxMenu = useContextMenu({ longPress: false })
  const [fork, setFork] = useState<{ thread: Thread; seq: number } | null>(null)
  const startFork = () => {
    api
      .thread(m.thread_id)
      .then((th) => setFork({ thread: th, seq: (th.messages ?? []).findIndex((x) => x.id === m.id) + 1 }))
      .catch(error)
  }
  const copy = () => void navigator.clipboard?.writeText(me ? textOf(m) : proseOf(m.body)).then(() => toast('Copied'))
  const reply = () => (document.querySelector<HTMLTextAreaElement>('.v-main textarea[data-composer]') ?? document.querySelector<HTMLTextAreaElement>('textarea[data-composer]'))?.focus()
  const thumbs = () => {
    let cancelled = false
    toast('👍 Looks good · sending in 5 s', { action: 'Undo', undo: true, ms: 5000, onAction: () => (cancelled = true) })
    setTimeout(() => {
      if (!cancelled) v3.send(m.session_id, { words: '👍 Looks good' }).catch(error)
    }, 5000)
  }
  const byId = useSessionsById()
  const nav = useNav()
  const sess = byId.get(m.session_id)
  const name = agentName(byId, m.session_id)
  const [menu, setMenu] = useState(false)
  const [pick, setPick] = useState<Menu>(null)
  // A message belongs to exactly one task (none while the agent has not placed it yet).
  const [about, setAbout] = useState(m.tasks.slice(0, 1))
  useEffect(() => setAbout(m.tasks.slice(0, 1)), [m.tasks])
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center' })
  }, [highlight])
  useEffect(() => {
    if (!menu) return
    const on = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', on)
    return () => document.removeEventListener('mousedown', on)
  }, [menu])
  const me = m.author === 'user'
  const taskOf = (id: string) => tasks.find((t) => t.id === id)
  const choose = async (r: PickResult) => {
    setPick(null)
    try {
      if (!me && ((m.turn_of?.length ?? 0) > 0 || m.decision)) {
        // An agent reply moves together with the person's messages it answered.
        const res = await v3.move(m.id, 'task_id' in r ? { to: r.task_id } : { title: r.title })
        if (res.removed_task) toast(`Removed the mistaken task “${res.removed_task}”`)
      } else if ('task_id' in r) {
        // The message moves: it leaves the task it was in.
        const t = taskOf(r.task_id)
        if (t) setAbout([{ task_id: t.id, title: t.title, status: t.status, source: 'person' }])
        await v3.setTask(m.id, r.task_id)
      } else {
        await v3.createTask({ title: r.title, session_id: m.session_id, message_ids: [m.id] })
      }
      onChanged()
    } catch (e) {
      error(e)
    }
  }
  if (m.kind === 'command') return <CommandMessage m={m} />
  if (m.kind === ('place' as string)) {
    const n = m.turn_of?.length ?? 0
    return (
      <div className="v-msg cont" data-testid="v3-message" data-kind="place" data-message-id={m.id}>
        <div className="v-bd">
          <IconRefresh size={12} /> Asked {name} to put {n} message{n === 1 ? '' : 's'} in tasks ({hhmm(m.created_at)})
        </div>
      </div>
    )
  }
  if (m.kind === ('continue' as string)) {
    return (
      <div className="v-msg cont" data-testid="v3-message" data-kind="continue" data-message-id={m.id}>
        <div className="v-bd">
          <IconRefresh size={12} /> Goal run continued {name} ({hhmm(m.created_at)})</div>
      </div>
    )
  }
  const words = textOf(m)
  const task = me && words ? parseTaskMessage(words) : null
  const text = task ? task.text : words
  const segs = me ? [{ kind: 'md' as const, text }] : splitQuestions(m.body)
  const questions = (m.questions ?? []) as Question[]
  const nonAction = questions.filter((q) => q.kind !== 'action')
  const decision = m.decision
  const decisionTask = m.decision_task ? taskOf(m.decision_task) ?? m.tasks.find((t) => t.task_id === m.decision_task) : undefined
  // The decision is worth a line only when it changed something: a new task, or the person's move.
  const showDecision = !me && (decision === 'created' || decision === 'moved') && !!decisionTask
  // Every message shows its task, except in that task's own view.
  const shown = about.filter((t) => t.task_id !== inTask)
  // The task is a badge at the top of the box (with the ⋮ menu beside it); in a task view, where every
  // message is that task, the box has no badge row and the ⋮ sits in the header.
  const tagRow = !m.pending && (about.length === 0 || shown.length > 0 || showDecision)
  const more = (
    <span className="v-slot">
      <span className="v-more" ref={menuRef}>
        <button type="button" className="v-dots" data-testid="msg-menu" aria-label="Which task this message is about" title="Which task is this about?" onClick={() => setMenu(!menu)}>
          <IconMoreV size={14} />
        </button>
        {menu && (
          <div className="v-menu" role="menu">
            <button type="button" role="menuitem" data-testid="message-reply-item" onClick={() => (setMenu(false), reply())}>
              Reply
            </button>
            <button type="button" role="menuitem" data-testid="message-copy-item" onClick={() => (setMenu(false), copy())}>
              Copy text
            </button>
            <button type="button" role="menuitem" data-testid="message-fork-item" onClick={() => (setMenu(false), startFork())}>
              Start new thread from here
            </button>
            {!me && onUnread && (
              <button type="button" role="menuitem" data-testid="message-unread" onClick={() => (setMenu(false), onUnread(m))}>
                Mark unread from here
              </button>
            )}
            <hr className="v-menusep" />
            <button type="button" role="menuitem" data-testid="menu-move" onClick={() => (setMenu(false), setPick({ mode: 'move' }))}>
              {about.length ? 'Move to another task…' : 'Put in a task…'}
            </button>
          </div>
        )}
      </span>
      {pick && (
        <TaskPicker
          tasks={tasks}
          exclude={about.map((t) => t.task_id)}
          head={me || !(m.turn_of?.length || m.decision) ? 'Move this message to…' : 'Move this reply and your message to…'}
          onPick={(r) => void choose(r)}
          onClose={() => setPick(null)}
        />
      )}
    </span>
  )
  return (
    <div
      ref={ref}
      className={'v-msg' + (me ? ' me' : '') + (ctx ? ' ctx' : '') + (repeat ? ' rep' : '') + (unread ? ' unr' : '') + (highlight ? ' hl' : '') + (m.pending ? ' pending' : '')}
      data-testid="v3-message"
      data-author={me ? 'user' : 'agent'}
      data-message-id={m.id}
      data-thread-id={m.thread_id}
      data-task={msgTask(m)?.task_id}
      {...ctxMenu.props}
    >
      <ContextMenu at={ctxMenu.at} onClose={ctxMenu.close} testid="message-context-menu" className="w-[250px]">
        <MenuItem testid="message-reply" hint={<Kbd>R</Kbd>} onClick={() => (ctxMenu.close(), reply())}>
          Reply
        </MenuItem>
        <MenuItem testid="message-copy" disabled={!(me ? textOf(m) : m.body).trim()} onClick={() => (ctxMenu.close(), copy())}>
          Copy text
        </MenuItem>
        <MenuItem testid="message-fork-ctx" onClick={() => (ctxMenu.close(), startFork())}>
          <IconFork size={14} /> Start new thread from here
        </MenuItem>
        {!me && onUnread && (
          <MenuItem testid="message-unread-ctx" onClick={() => (ctxMenu.close(), onUnread(m))}>
            Mark unread from here
          </MenuItem>
        )}
      </ContextMenu>
      {fork && <ForkDialog thread={fork.thread} message={m} seq={fork.seq} onClose={() => setFork(null)} />}
      <div className="v-w">
        {me ? (
          <>
            You{' '}
            {showAgent !== false && (
              <button type="button" className="v-src" onClick={() => nav.agent(m.session_id)}>
                → {name}
              </button>
            )}
          </>
        ) : (
          <button type="button" className="v-link" style={{ color: 'var(--mb-fg2)', fontWeight: 600 }} onClick={() => nav.agent(m.session_id)}>
            {name}
          </button>
        )}
        <span>{hhmm(m.created_at)}</span>
        {m.pending && <span>sending…</span>}
        {/* Where the message is: sending → ✓ delivered. Longer states (waiting, not delivered) and their actions
            show in the delivery line under the bubble. */}
        {me && m.delivery && !m.pending && (m.delivery !== 'delivered' || latest) && (
          <span
            data-testid="delivery"
            data-delivery={m.delivery}
            className={'v-dlv ' + m.delivery}
            title={m.delivery === 'delivered' ? `Delivered to ${name}, ${hhmm(m.delivered_at ?? m.created_at)}` : undefined}
          >
            {m.delivery === 'delivered' ? (
              <>
                <IconCheck size={12} /> delivered
              </>
            ) : m.delivery === 'undelivered' ? 'not delivered' : 'sending'}
          </span>
        )}
        {!me && !m.pending && (
          <button type="button" className="v-thumb" aria-label="Looks good" title="👍 Looks good" data-testid="thumbs-up" onClick={thumbs}>
            <IconThumb size={14} />
          </button>
        )}
        {!m.pending && !tagRow && more}
      </div>
      <div className="v-bd">
        {tagRow && (
          <div className="v-tags" data-testid="about">
            {about.length === 0 && (
              <span className="v-tbadge wait" data-testid="unplaced">
                waiting for {name} to place it in a task
              </span>
            )}
            {shown.map((t) => (
              <TaskBadge key={t.task_id} task={t} tasks={tasks} />
            ))}
            {showDecision && (
              <span className="v-k" data-testid="decision" data-decision={decision} title={decisionTask!.title}>
                {decision === 'created' ? '→ new task' : '→ moved here by you'}
              </span>
            )}
            {more}
          </div>
        )}
        {segs.map((seg, i) => {
          if (seg.kind === 'md') return seg.text.trim() ? <MessageBody key={i} text={seg.text} message={m} baseDir={sess?.cwd ?? ''} onOpen={(a) => onOpenAttachment(a, m)} author={me ? 'you' : name} className="text-[13.5px]" /> : null
          if (seg.kind === 'actions') {
            const items = questions.slice(seg.start, seg.start + seg.count)
            return <ActionBlock key={i} m={m} items={items} />
          }
          const q = questions[seg.index]
          if (!q) return null
          return <QuestionBlock key={q.key} m={m} q={q} index={nonAction.indexOf(q)} total={nonAction.length} />
        })}
        {(m.answers?.length ?? 0) > 0 && !questionNear && <AnswerContent m={m} name={name} inTask={inTask} baseDir={sess?.cwd ?? ''} onOpen={(a) => onOpenAttachment(a, m)} />}
        {(m.answers?.length ?? 0) > 0 && questionNear && (
          <div className="v-cnt2" data-testid="sent-answers">
            {(m.answers ?? []).map((a) => (
              <div key={a.key}>↳ {answerText(a)}</div>
            ))}
          </div>
        )}
        {(m.attachments?.length ?? 0) > 0 && <AttachmentTiles items={m.attachments!} annotations={[]} onOpen={(a) => onOpenAttachment(a, m)} openId={null} newestId={null} />}
        {!me && questions.length > 0 && <AnswerBar m={m} onSent={onChanged} testid="send-answers" />}
      </div>
    </div>
  )
}

/** The ids of the answer messages in list whose question message shows within the `window` messages
 *  before them: those answers read under its cards, as a short line. */
export function answersNearQuestions(list: V3Message[], window = 4): Set<string> {
  const out = new Set<string>()
  list.forEach((m, i) => {
    if (m.author !== 'user' || !m.answers_for || !m.answers?.length) return
    for (let j = i - 1; j >= Math.max(0, i - window); j--) {
      if (list[j]!.id === m.answers_for) {
        out.add(m.id)
        return
      }
    }
  })
  return out
}

/**
 * The person's answers where the message with the questions is not shown just above (another task, not
 * loaded, far up): each question's prompt (short) with the choice, Other or text, and the note; "↳"
 * names the message and reveals it (in its task, else in the agent's stream).
 */
function AnswerContent({ m, name, inTask, baseDir, onOpen }: { m: V3Message; name: string; inTask?: string; baseDir: string; onOpen: (a: Attachment) => void }) {
  const nav = useNav()
  const to = m.answers_to
  if (!to) {
    // The message answered is unknown here: the answers as the agent read them.
    return <MessageBody text={m.body} message={m} baseDir={baseDir} onOpen={onOpen} author="you" className="text-[13.5px]" />
  }
  const qs = new Map(to.questions.map((q) => [q.key, q]))
  const reveal = () => {
    if (inTask !== undefined && to.task_id) nav.task(to.task_id, to.message_id)
    else nav.agent(m.session_id, to.message_id)
  }
  return (
    <div className="v-ans" data-testid="answer-content">
      <button type="button" className="v-ans-to" data-testid="answer-to" title="Show the question" onClick={reveal}>
        <span aria-hidden>↳</span> <span className="v-ans-lbl">Answer to {name}{to.line ? ': “' + short(to.line, 80) + '”' : ''}</span>
      </button>
      {(m.answers ?? []).map((a) => {
        const q = qs.get(a.key)
        const choice = answerChoice(a)
        const note = a.note?.trim()
        return (
          <div key={a.key} className="v-ans-q" data-testid="answer-item">
            {q && <div className="v-ans-p">{short(q.prompt, 140)}</div>}
            {choice && <div className="v-ans-a">{choice}</div>}
            {note && <div className="v-ans-n">Note: {note}</div>}
          </div>
        )
      })}
    </div>
  )
}

/** Ignores questions of m (keys) as moot, with an "Ignored · Undo" toast. Nothing goes to the agent. */
export function ignoreQuestions(m: V3Message, keys: string[], app: { toast: ReturnType<typeof useApp>['toast']; error: (e: unknown) => void }, done?: () => void): Promise<void> {
  return v3
    .ignore(m.id, keys)
    .then(() => {
      done?.()
      app.toast(keys.length > 1 ? `Ignored ${keys.length} questions` : 'Ignored', { action: 'Undo', undo: true, onAction: () => void v3.unignore(m.id, keys).then(() => done?.()).catch(app.error) })
    })
    .catch(app.error)
}

function QuestionBlock({ m, q, index, total }: { m: V3Message; q: Question; index: number; total: number }) {
  const app = useApp()
  const { drafts, set } = useAnswerDrafts(m.id)
  const sentA = m.answer_state?.[q.key] && !answerIsEmpty(m.answer_state[q.key]) ? m.answer_state[q.key] : undefined
  const closed = m.closed?.[q.key] && !['moved_on', 'replaced'].includes(m.closed[q.key]!) ? m.closed[q.key]! : null
  return (
    <div data-testid="question" data-open={!sentA && !closed ? 'true' : 'false'}>
      <QuestionCard
        index={index}
        total={total}
        q={q}
        sent={sentA}
        draft={drafts[q.key]}
        onDraft={set}
        closed={closed}
        onIgnore={() => void ignoreQuestions(m, [q.key], app)}
        onUnignore={() => void v3.unignore(m.id, [q.key]).catch(app.error)}
      />
    </div>
  )
}

export function ActionBlock({ m, items }: { m: V3Message; items: Question[] }) {
  const app = useApp()
  const { drafts, set } = useAnswerDrafts(m.id)
  const answers = Object.fromEntries(items.map((q) => [q.key, m.answer_state?.[q.key]]))
  const open = items.filter((q) => !m.answer_state?.[q.key] && m.closed?.[q.key] !== 'ignored').map((q) => q.key)
  const ignored = items.filter((q) => !m.answer_state?.[q.key] && m.closed?.[q.key] === 'ignored').map((q) => q.key)
  return (
    <div>
      <ActionItems items={items} answers={answers} drafts={drafts} onDraft={set} readOnly={open.length === 0} />
      {open.length > 0 && (
        <button type="button" className="v-link" data-testid="ignore-actions" title="No longer relevant: stop waiting on them (the agent is not told)" onClick={() => void ignoreQuestions(m, open, app)}>
          Ignore
        </button>
      )}
      {open.length === 0 && ignored.length > 0 && (
        <div className="v-cnt2" data-testid="actions-ignored">
          Ignored ·{' '}
          <button type="button" className="v-link" data-testid="unignore-actions" onClick={() => void v3.unignore(m.id, ignored).catch(app.error)}>
            Reopen
          </button>
        </div>
      )}
    </div>
  )
}

export function statusLabel(t: Task | BoardTask): string {
  return STATUS_LABEL[t.status]
}

/** The tasks a message is about, as small links (search results). */
export function TaskLinks({ tasks }: { tasks: TaskRef[] }) {
  return (
    <>
      {tasks.map((t) => (
        <TaskChip key={t.task_id} task={t} shortN={24} />
      ))}
    </>
  )
}

/**
 * A report (the task's, else the agent's latest message about it) as rendered markdown, folded to a
 * few lines with "more" (question blocks shown as their prompts).
 */
export function MessageBodyClamp({ text, lines = 8, testid }: { text: string; lines?: number; testid?: string }) {
  const [open, setOpen] = useState(false)
  const src = text.replace(/:::(question|question-multi|question-text|actions)[^\n]*\n([^\n]*)[\s\S]*?\n:::/g, (_x, _k, first) => '> ? ' + String(first).trim())
  const html = useMemo(() => renderMarkdown(src), [src])
  const long = src.split('\n').length > lines || src.length > lines * 90
  return (
    <div className="v-report" data-testid={testid}>
      <div className={'md' + (open || !long ? '' : ' v-clamp')} style={{ ['--l' as string]: lines }} dangerouslySetInnerHTML={{ __html: html }} />
      {long && (
        <button type="button" className="v-link" onClick={() => setOpen(!open)}>
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}
