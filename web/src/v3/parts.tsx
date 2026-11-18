// The pieces the v3 views share: task links, status dots, progress bars, checklists, the timeline,
// the task picker, a message with the tasks it is about (and the agent's decision when it made one),
// its questions, the composer (with attachments).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Answer, Attachment, Question, Session } from '../api'
import { useApp } from '../lib/app'
import { renderMarkdown, splitQuestions } from '../lib/markdown'
import { MessageBody } from '../components/MessageBody'
import { AttachmentTiles } from '../components/AttachmentTiles'
import { ActionItems, QuestionCard, answerIsEmpty } from '../components/QuestionCard'
import { CommandMessage } from '../components/CommandMessage'
import { IconMoreV, IconPaperclip } from '../components/icons'
import { parseTaskMessage } from '../lib/taskContext'
import { useQuoteTarget } from './quote'
import { ComposeFileTiles, clearFiles, fileInputHandlers, uploadIds, useComposeFiles } from '../lib/uploads'
import {
  STATUS_LABEL,
  answerText,
  currentStep,
  hhmm,
  leaves,
  lineOf,
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
    board: () => navigate({ view: 'main', k: null, s: null, m: null }, { push: true }),
    task: (id: string, m?: string) => navigate({ view: 'task', k: id, m: m ?? null }, { push: true }),
    agent: (id: string, m?: string) => navigate({ view: 'agent', s: id, m: m ?? null }, { push: true }),
    agents: () => navigate({ view: 'agents' }, { push: true }),
    search: () => navigate({ view: 'search' }, { push: true }),
  }
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
        {goal ? '◎ ' : ''}
        {short(task.title, shortN)}
      </button>
      {onRemove && (
        <button type="button" className="v-x" title="Not about this task" aria-label={`Not about ${task.title}`} onClick={onRemove}>
          ✕
        </button>
      )}
    </span>
  )
}

export function StatusDot({ t, live }: { t: Pick<BoardTask, 'status' | 'needs_you' | 'kind'> & { open_questions?: number }; live?: boolean }) {
  const c = t.needs_you || (t.open_questions ?? 0) > 0 || t.status === 'needs_you' ? 'd-wait' : t.status === 'blocked' ? 'd-block' : t.status === 'done' ? 'd-done' : t.kind === 'goal' ? 'd-goal' : 'd-work'
  return <span className={`v-dot ${c}${live ? ' v-live' : ''}`} data-status={t.status} />
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
            <span className="v-ck">{s.done ? '✓' : ''}</span>
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

const EVENT_COLOR: Record<string, string> = { status: 'var(--mb-work)', created: 'var(--mb-work)', step: 'var(--mb-ok)', criterion: 'var(--mb-ok)', handoff: 'var(--mb-purple)', auto: 'var(--mb-purple)', answer: 'var(--mb-purple)' }

/** Events worth a line between messages (adding / moving messages is visible in the messages). */
export function shownEvent(e: TaskEvent): boolean {
  return !['link', 'unlink', 'tag', 'untag', 'answer'].includes(e.kind) && e.text !== 'Task created (from the earlier inbox)'
}

export function Timeline({ events, messages, n, byId }: { events: TaskEvent[]; messages?: V3Message[]; n: number; byId: Map<string, Session> }) {
  const items = [
    ...events.filter(shownEvent).map((e) => ({ t: e.at, color: EVENT_COLOR[e.kind] ?? 'var(--mb-faint)', text: e.text, id: e.id })),
    ...(messages ?? []).map((m) => ({
      t: m.created_at,
      color: m.author === 'user' ? 'var(--mb-purple)' : m.open ? 'var(--mb-wait)' : 'var(--mb-faint)',
      text: (m.author === 'user' ? 'You: ' : agentName(byId, m.session_id) + ': ') + lineOf(m),
      id: m.id,
    })),
  ].sort((a, b) => (a.t < b.t ? 1 : -1))
  return (
    <ul className="v-tl" data-testid="timeline">
      {items.slice(0, n).map((e) => (
        <li key={e.id}>
          <span className="v-m" style={{ background: e.color }} />
          <span className="v-tm">{hhmm(e.t)}</span>
          <span className="v-tx">{e.text}</span>
        </li>
      ))}
    </ul>
  )
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
          {t.kind === 'goal' ? '◎ ' : ''}
          {t.title}
        </button>
      ))}
      {qq && (
        <button type="button" className={'v-opt' + (cur === opts.length ? ' sel' : '')} data-testid="task-new" onClick={() => onPick({ title: name })}>
          ＋ New task “{name}”
        </button>
      )}
      {!opts.length && !qq && <div className="v-hd">No open tasks yet. Type a name to make one.</div>}
    </div>
  )
}

// ---- questions ----
//
// Answering never sends by itself: a pick (a click, a tap, 1–9) only selects, and the person can
// change it, answer the message's other questions, add a note or free text, then Send once (the
// button or ⌘↵). The picks are drafts kept per message (in this browser) until sent.

const ANS_KEY = 'minbox:v3:answers:'
const ansCache = new Map<string, Record<string, Answer>>()
const ansListeners = new Set<() => void>()
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

/** Picks a choice of a question as a draft (1–9 on the Board): single replaces, multi toggles. */
export function pickChoice(m: V3Message, q: Question, label: string) {
  const cur = loadAnswers(m.id)[q.key]
  const sel = cur?.selected ?? []
  const next: Answer = q.kind === 'multi' ? { ...cur, key: q.key, selected: sel.includes(label) ? sel.filter((x) => x !== label) : [...sel, label] } : { key: q.key, selected: sel[0] === label ? [] : [label] }
  const all = { ...loadAnswers(m.id) }
  if (answerIsEmpty(next)) delete all[q.key]
  else all[q.key] = next
  saveAnswers(m.id, all)
}

/**
 * A question answered in place (the Board's cards): choices to pick (long ones stack, so none grows
 * into a giant button), Other… / a line of text. Picks are drafts; the card's Send sends them.
 */
export function QuickAnswer({ m, q, keys }: { m: V3Message; q: Question; keys?: boolean }) {
  const { drafts, set } = useAnswerDrafts(m.id)
  const d = drafts[q.key]
  const choices = q.choices ?? []
  if (q.kind === 'action') return null
  const long = choices.some((c) => c.label.length > 22) || choices.length > 4
  const free = (
    <input
      className="v-free"
      placeholder={q.kind === 'text' ? 'Your answer…' : 'Other…'}
      aria-label={q.kind === 'text' ? 'Answer' : 'Other answer'}
      data-testid="free-answer"
      value={(q.kind === 'text' ? d?.text : d?.other) ?? ''}
      onChange={(e) => set(q.kind === 'text' ? { key: q.key, text: e.target.value } : { ...d, key: q.key, other: e.target.value, selected: q.kind === 'single' && e.target.value ? [] : d?.selected })}
    />
  )
  if (q.kind === 'text') return <div className="v-choices">{free}</div>
  return (
    <div className={'v-choices' + (long ? ' col' : '')}>
      {choices.map((c, i) => {
        const on = !!d?.selected?.includes(c.label)
        return (
          <button
            type="button"
            key={c.label}
            className={'v-choice' + (c.recommended ? ' rec' : '') + (on ? ' on' : '')}
            data-testid="choice"
            aria-pressed={on}
            title={c.label}
            onClick={(e) => {
              e.stopPropagation()
              pickChoice(m, q, c.label)
            }}
          >
            <span className="v-mark">{on ? (q.kind === 'multi' ? '☑' : '●') : q.kind === 'multi' ? '☐' : '○'}</span>
            {keys && i < 9 && <span className="v-kbd">{i + 1}</span>}
            <span className="v-cl">{c.label}</span>
            {c.recommended ? <span className="v-rec">recommended</span> : null}
          </button>
        )
      })}
      {free}
    </div>
  )
}

/** "N answered · Send": under a message's questions (Board card, stream, task view). */
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

type Menu = null | { mode: 'move' | 'also' }

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
}: {
  m: V3Message
  tasks: Task[]
  /** Shown in this task's view: it is not named under each message (every message there is about it). */
  inTask?: string
  ctx?: boolean
  unread?: boolean
  highlight?: boolean
  /** Name the agent's stream (the task view mixes streams). */
  showAgent?: boolean
  onOpenAttachment: (a: Attachment, m: V3Message) => void
  onChanged: () => void
}) {
  const { error, toast } = useApp()
  const byId = useSessionsById()
  const nav = useNav()
  const sess = byId.get(m.session_id)
  const name = agentName(byId, m.session_id)
  const [menu, setMenu] = useState(false)
  const [pick, setPick] = useState<Menu>(null)
  const [about, setAbout] = useState(m.tasks)
  useEffect(() => setAbout(m.tasks), [m.tasks])
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
  const unlink = (tid: string) => {
    setAbout((ts) => ts.filter((t) => t.task_id !== tid))
    v3.unlink(m.id, tid).then(onChanged).catch(error)
  }
  const notAbout = async () => {
    setMenu(false)
    setAbout([])
    try {
      for (const t of m.tasks) await v3.unlink(m.id, t.task_id)
      onChanged()
    } catch (e) {
      error(e)
    }
  }
  const choose = async (r: PickResult) => {
    const mode = pick?.mode
    setPick(null)
    try {
      if (mode === 'move' && !me && ((m.turn_of?.length ?? 0) > 0 || m.decision)) {
        // An agent reply moves together with the person's messages it answered.
        const from = m.decision_task && m.tasks.some((t) => t.task_id === m.decision_task) ? m.decision_task : m.tasks[0]?.task_id
        const res = await v3.move(m.id, { from, ...('task_id' in r ? { to: r.task_id } : { title: r.title }) })
        if (res.removed_task) toast(`Removed the mistaken task “${res.removed_task}”`)
      } else {
        if (mode === 'move') for (const t of m.tasks) await v3.unlink(m.id, t.task_id)
        if ('task_id' in r) {
          const t = taskOf(r.task_id)
          if (t) setAbout((ts) => [...(mode === 'move' ? [] : ts), { task_id: t.id, title: t.title, status: t.status, source: 'person' }])
          await v3.link(m.id, r.task_id)
        } else {
          await v3.createTask({ title: r.title, session_id: m.session_id, message_ids: [m.id] })
        }
      }
      onChanged()
    } catch (e) {
      error(e)
    }
  }
  if (m.kind === 'command') return <CommandMessage m={m} />
  if (m.kind === ('continue' as string)) {
    return (
      <div className="v-msg cont" data-testid="v3-message" data-kind="continue" data-message-id={m.id}>
        <div className="v-bd">↻ Goal run continued {name} ({hhmm(m.created_at)})</div>
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
  const shown = about.filter((t) => t.task_id !== inTask && !(showDecision && t.task_id === m.decision_task))
  return (
    <div
      ref={ref}
      className={'v-msg' + (me ? ' me' : '') + (ctx ? ' ctx' : '') + (unread ? ' unr' : '') + (highlight ? ' hl' : '') + (m.pending ? ' pending' : '')}
      data-testid="v3-message"
      data-author={me ? 'user' : 'agent'}
      data-message-id={m.id}
    >
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
        {me && m.delivery && m.delivery !== 'delivered' && !m.pending && <span data-testid="delivery">{m.delivery === 'queued' ? 'queued' : m.delivery}</span>}
      </div>
      <div className="v-bd">
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
        {(m.answers?.length ?? 0) > 0 && (
          <div className="v-cnt2" data-testid="sent-answers">
            {(m.answers ?? []).map((a) => (
              <div key={a.key}>↳ {answerText(a)}</div>
            ))}
          </div>
        )}
        {(m.attachments?.length ?? 0) > 0 && <AttachmentTiles items={m.attachments!} annotations={[]} onOpen={(a) => onOpenAttachment(a, m)} openId={null} newestId={null} />}
        {!me && questions.length > 0 && <AnswerBar m={m} onSent={onChanged} testid="send-answers" />}
      </div>
      {!m.pending && (
        <div className="v-about" data-testid="about">
          {shown.length > 0 && <span className="v-k">in</span>}
          {shown.map((t) => (
            <TaskChip key={t.task_id} task={t} goal={taskOf(t.task_id)?.kind === 'goal'} />
          ))}
          {showDecision && (
            <span className="v-note" data-testid="decision" data-decision={decision}>
              <span className="v-k">{decision === 'created' ? '→ new task' : '→ moved by you to'}</span>
              <TaskChip task={{ task_id: m.decision_task!, title: decisionTask!.title }} />
            </span>
          )}
          <span className="v-more" ref={menuRef}>
            <button type="button" className="v-dots" data-testid="msg-menu" aria-label="Which task this message is about" title="Which task is this about?" onClick={() => setMenu(!menu)}>
              <IconMoreV size={14} />
            </button>
            {menu && (
              <div className="v-menu" role="menu">
                <button type="button" role="menuitem" data-testid="menu-move" onClick={() => (setMenu(false), setPick({ mode: 'move' }))}>
                  {about.length ? 'Move to another task…' : 'Put in a task…'}
                </button>
                {about.length > 0 && (
                  <button type="button" role="menuitem" data-testid="menu-also" onClick={() => (setMenu(false), setPick({ mode: 'also' }))}>
                    Also about another task…
                  </button>
                )}
                {about.length > 0 && (
                  <button type="button" role="menuitem" data-testid="menu-none" onClick={() => void notAbout()}>
                    Not about a task
                  </button>
                )}
                {about.length > 0 && inTask && about.some((t) => t.task_id === inTask) && (
                  <button type="button" role="menuitem" data-testid="menu-out" onClick={() => (setMenu(false), unlink(inTask))}>
                    Take out of this task
                  </button>
                )}
              </div>
            )}
          </span>
          {pick && (
            <TaskPicker
              tasks={tasks}
              exclude={pick.mode === 'also' ? about.map((t) => t.task_id) : []}
              head={pick.mode === 'move' ? (me || !(m.turn_of?.length || m.decision) ? 'Move this message to…' : 'Move this reply and your message to…') : 'Also about…'}
              onPick={(r) => void choose(r)}
              onClose={() => setPick(null)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function QuestionBlock({ m, q, index, total }: { m: V3Message; q: Question; index: number; total: number }) {
  const { drafts, set } = useAnswerDrafts(m.id)
  const sentA = m.answer_state?.[q.key] && !answerIsEmpty(m.answer_state[q.key]) ? m.answer_state[q.key] : undefined
  const closed = m.closed?.[q.key] && !['moved_on', 'replaced'].includes(m.closed[q.key]!) ? m.closed[q.key]! : null
  return (
    <div data-testid="question" data-open={!sentA && !closed ? 'true' : 'false'}>
      <QuestionCard index={index} total={total} q={q} sent={sentA} draft={drafts[q.key]} onDraft={set} closed={closed} />
    </div>
  )
}

export function ActionBlock({ m, items }: { m: V3Message; items: Question[] }) {
  const { drafts, set } = useAnswerDrafts(m.id)
  const answers = Object.fromEntries(items.map((q) => [q.key, m.answer_state?.[q.key]]))
  return <ActionItems items={items} answers={answers} drafts={drafts} onDraft={set} readOnly={items.every((q) => !!m.answer_state?.[q.key])} />
}

// ---- composer ----

/** What the composer sends: the words, the recipient, more tasks it is about, the uploaded files. */
export type Outgoing = { words: string; to: string; tasks: string[]; uploads: string[] }

export function Composer({
  toId,
  toOptions,
  onTo,
  about,
  placeholder,
  onSend,
  draftKey,
  testid = 'composer',
  tasks,
}: {
  toId: string
  toOptions: Session[]
  onTo?: (id: string) => void
  /** The tasks the message is about from where it is written (a task's view): always. */
  about: { task_id: string; title: string }[]
  placeholder: string
  onSend: (o: Outgoing) => Promise<void>
  /** Where the attached files are kept until sent (per stream / task). */
  draftKey: string
  testid?: string
  /** The tasks the person can say the message is about (# at the start, or the task button). */
  tasks?: Task[]
}) {
  const { isPhone } = useApp()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [extra, setExtra] = useState<{ task_id: string; title: string }[]>([])
  const [picking, setPicking] = useState(false)
  const compose = useComposeFiles(draftKey)
  const { files, addFiles, addPastedText, remove } = compose
  const fileInput = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  useQuoteTarget(setText, box)
  const io = fileInputHandlers(addFiles, addPastedText)
  const uploading = files.some((f) => f.state === 'uploading')
  const ready = files.some((f) => f.state === 'done')
  const canSend = (!!text.trim() || ready) && !uploading && !busy
  const send = async () => {
    const w = text.trim()
    if (!canSend) return
    setBusy(true)
    setText('')
    const ex = extra
    setExtra([])
    const ups = uploadIds(draftKey)
    try {
      await onSend({ words: w, to: toId, tasks: ex.map((t) => t.task_id), uploads: ups })
      clearFiles(draftKey)
    } catch {
      setText(w)
      setExtra(ex)
    } finally {
      setBusy(false)
    }
  }
  const all = [...about, ...extra]
  const putBack = (f: (typeof files)[number]) => {
    if (!f.pasted) return
    const at = Math.min(f.pasted.at, text.length)
    setText((t) => t.slice(0, at) + f.pasted!.text + t.slice(at))
    remove(f.key)
  }
  return (
    <div className="v-composer" data-testid={testid} onDragOver={io.onDragOver} onDrop={io.onDrop}>
      <div className="v-to">
        to{' '}
        {onTo ? (
          <select className="v-chip" aria-label="To" data-testid="composer-to" value={toId} onChange={(e) => onTo(e.target.value)}>
            {toOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {agentHint(toOptions, a) ? ` (${agentHint(toOptions, a)})` : ''}
                {a.status === 'working' ? ' · working' : ''}
              </option>
            ))}
            <option value="new">New agent…</option>
          </select>
        ) : (
          <span className="v-chip">{toOptions.find((a) => a.id === toId)?.name ?? 'agent'}</span>
        )}
        {all.length > 0 && (
          <>
            <span>about</span>
            {about.map((t) => (
              <TaskChip key={t.task_id} task={t} />
            ))}
            {extra.map((t) => (
              <TaskChip key={t.task_id} task={t} onRemove={() => setExtra((x) => x.filter((y) => y.task_id !== t.task_id))} />
            ))}
          </>
        )}
        {tasks && (
          <span style={{ position: 'relative' }}>
            <button type="button" className="v-addtask" data-testid="composer-task" title="Say which task this is about (#)" onClick={() => setPicking(true)}>
              {all.length ? '＋' : '＋ about a task'}
            </button>
            {picking && (
              <TaskPicker
                tasks={tasks}
                exclude={all.map((t) => t.task_id)}
                onClose={() => setPicking(false)}
                onPick={(r) => {
                  setPicking(false)
                  if ('task_id' in r) {
                    const t = tasks.find((x) => x.id === r.task_id)
                    if (t) setExtra((x) => [...x, { task_id: t.id, title: t.title }])
                  }
                }}
              />
            )}
          </span>
        )}
      </div>
      <ComposeFileTiles files={files} onRemove={remove} onPutBack={putBack} />
      <textarea
        ref={box}
        data-testid="composer-text"
        data-composer
        rows={2}
        value={text}
        placeholder={placeholder}
        onPaste={io.onPaste}
        onChange={(e) => {
          // # in an empty box picks a task the message is about.
          if (tasks && text === '' && e.target.value === '#') {
            setPicking(true)
            return
          }
          setText(e.target.value)
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void send()
          }
          if (e.key === 'Escape') (e.target as HTMLElement).blur()
        }}
      />
      <div className="v-tb">
        <button type="button" className="v-attach" data-testid="attach-files" aria-label={isPhone ? 'Add a photo or file' : 'Attach files'} title="Attach files (or paste / drop them)" onClick={() => fileInput.current?.click()}>
          <IconPaperclip size={16} />
          {isPhone ? <span>Photo / file</span> : null}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="attach-input"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <span className="v-sp" />
        {uploading && <span>uploading…</span>}
        <span className="v-kbd v-hide-phone">⌘↵</span>
        <button type="button" className="v-btn pri" data-testid="composer-send" disabled={!canSend} onClick={() => void send()}>
          Send
        </button>
      </div>
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
