// The pieces the v3 views share: task chips, status dots, progress bars, checklists, the timeline,
// the # tag picker, a message with its tags and the agent's decision, its questions, the composer.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Answer, Attachment, Question, Session } from '../api'
import { useApp } from '../lib/app'
import { splitQuestions } from '../lib/markdown'
import { MessageBody } from '../components/MessageBody'
import { AttachmentTiles } from '../components/AttachmentTiles'
import { ActionItems, QuestionCard, answerIsEmpty } from '../components/QuestionCard'
import { CommandMessage } from '../components/CommandMessage'
import { parseTaskMessage } from '../lib/taskContext'
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
  type Tag,
  type Task,
  type TaskEvent,
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

export function TagChip({ tag, onRemove, shortN = 26, goal }: { tag: { task_id: string; title: string }; onRemove?: () => void; shortN?: number; goal?: boolean }) {
  const nav = useNav()
  return (
    <span
      className={'v-tag' + (goal ? ' goal' : '')}
      data-testid="tag"
      data-task={tag.task_id}
      role="link"
      tabIndex={0}
      style={{ ['--c' as string]: tagColor(tag.task_id) }}
      title={tag.title}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.v-x')) return
        nav.task(tag.task_id)
      }}
      onKeyDown={(e) => e.key === 'Enter' && nav.task(tag.task_id)}
    >
      {short(tag.title, shortN)}
      {onRemove && (
        <button type="button" className="v-x" title="Remove tag" aria-label={`Remove tag ${tag.title}`} onClick={onRemove}>
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
          <i key={i} className={s.done ? 'ok' : s === cur ? (q ? 'wt' : t.status === 'blocked' ? 'blk' : 'doing') : isGoal ? '' : ''} />
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

export function Timeline({ events, messages, n, byId }: { events: TaskEvent[]; messages?: V3Message[]; n: number; byId: Map<string, Session> }) {
  const items = [
    ...events.filter((e) => !messages || (e.kind !== 'answer' && e.kind !== 'tag')).map((e) => ({ t: e.at, color: EVENT_COLOR[e.kind] ?? 'var(--mb-faint)', text: e.text, id: e.id })),
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

// ---- the # tag picker ----

export type PickResult = { task_id: string } | { title: string }

export function TagPicker({ tasks, exclude, head, onPick, onClose }: { tasks: Task[]; exclude: string[]; head?: ReactNode; onPick: (r: PickResult) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const qq = q.replace(/^#/, '').trim().toLowerCase()
  const opts = tasks.filter((t) => !exclude.includes(t.id) && t.status !== 'done' && t.title.toLowerCase().includes(qq)).slice(0, 7)
  const all: PickResult[] = [...opts.map((t) => ({ task_id: t.id })), ...(qq ? [{ title: q.replace(/^#/, '').trim() }] : [])]
  const cur = Math.min(sel, all.length - 1)
  useEffect(() => {
    const on = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', on)
    return () => document.removeEventListener('mousedown', on)
  }, [onClose])
  return (
    <div className="v-tagpop" ref={ref} data-testid="tag-picker" onClick={(e) => e.stopPropagation()}>
      {head && <div className="v-hd">{head}</div>}
      <input
        autoFocus
        placeholder="# task…"
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
        <button type="button" key={t.id} className={'v-opt' + (i === cur ? ' sel' : '')} data-testid="tag-option" onClick={() => onPick({ task_id: t.id })}>
          <StatusDot t={{ ...t, needs_you: t.status === 'needs_you' }} />
          {t.kind === 'goal' ? '◎ ' : ''}
          {t.title}
        </button>
      ))}
      {qq && (
        <button type="button" className={'v-opt' + (cur === opts.length ? ' sel' : '')} data-testid="tag-new" onClick={() => onPick({ title: q.replace(/^#/, '').trim() })}>
          ＋ New task “{q.replace(/^#/, '').trim()}”
        </button>
      )}
      {!opts.length && !qq && <div className="v-hd">Type to find a task, or to name a new one.</div>}
    </div>
  )
}

// ---- questions ----

/** One-click choices of a single-choice question (the Board's cards). */
export function QuickChoices({ m, q, keys, onAnswered }: { m: V3Message; q: Question; keys?: boolean; onAnswered: (text: string) => void }) {
  const { error } = useApp()
  const [other, setOther] = useState('')
  const send = (a: Answer) => {
    onAnswered(answerText(a))
    v3.send(m.session_id, { words: '', answers_for: m.id, answers: [a] }, m.thread_id).catch(error)
  }
  const choices = q.choices ?? []
  if (q.kind === 'text' || q.kind === 'action' || q.kind === 'multi') return null
  return (
    <div className="v-choices">
      {choices.map((c, i) => (
        <button type="button" key={c.label} className={'v-choice' + (c.recommended ? ' rec' : '')} data-testid="choice" onClick={() => send({ key: q.key, selected: [c.label] })}>
          {keys && i < 9 && <span className="v-kbd">{i + 1}</span>}
          {c.label}
          {c.recommended ? ' · rec.' : ''}
        </button>
      ))}
      <input
        className="v-free"
        placeholder="Other…"
        aria-label="Other answer"
        value={other}
        onChange={(e) => setOther(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && other.trim()) send({ key: q.key, other: other.trim() })
        }}
      />
    </div>
  )
}

// ---- a message ----

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
  /** Shown in this task's view: its own chip is left out (every message there has it). */
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
  const [pop, setPop] = useState<null | { move?: { from: string | null } }>(null)
  const [tags, setTags] = useState(m.tags)
  useEffect(() => setTags(m.tags), [m.tags])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center' })
  }, [highlight])
  const me = m.author === 'user'
  const taskOf = (id: string) => tasks.find((t) => t.id === id)
  const untag = (tid: string) => {
    setTags((ts) => ts.filter((t) => t.task_id !== tid))
    v3.untag(m.id, tid).then(onChanged).catch(error)
  }
  const pick = async (r: PickResult) => {
    const move = pop?.move
    setPop(null)
    try {
      if (move) {
        const res = await v3.retag(m.id, { from: move.from ?? undefined, ...('task_id' in r ? { to: r.task_id } : { title: r.title }) })
        if (res.removed_task) toast(`Removed the mistaken task “${res.removed_task}”`)
      } else if ('task_id' in r) {
        const t = taskOf(r.task_id)
        if (t) setTags((ts) => [...ts, { task_id: t.id, title: t.title, status: t.status, source: 'person' }])
        await v3.tag(m.id, r.task_id)
      } else {
        await v3.createTask({ title: r.title, session_id: m.session_id, message_ids: [m.id] })
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
  const decisionTask = m.decision_task ? taskOf(m.decision_task) ?? m.tags.find((t) => t.task_id === m.decision_task) : undefined
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
            return <ActionBlock key={i} m={m} items={items} onAnswered={onChanged} />
          }
          const q = questions[seg.index]
          if (!q) return null
          return <QuestionBlock key={q.key} m={m} q={q} index={nonAction.indexOf(q)} total={nonAction.length} onAnswered={onChanged} />
        })}
        {(m.answers?.length ?? 0) > 0 && (
          <div className="v-cnt2" data-testid="sent-answers">
            {(m.answers ?? []).map((a) => (
              <div key={a.key}>↳ {answerText(a)}</div>
            ))}
          </div>
        )}
        {(m.attachments?.length ?? 0) > 0 && <AttachmentTiles items={m.attachments!} annotations={[]} onOpen={(a) => onOpenAttachment(a, m)} openId={null} newestId={null} />}
      </div>
      <div className="v-tags">
        {tags
          // The decision note below names its task: the chip is not repeated here.
          .filter((t) => t.task_id !== inTask && !(decision && decision !== 'none' && t.task_id === m.decision_task))
          .map((t) => (
            <TagChip key={t.task_id} tag={t} goal={taskOf(t.task_id)?.kind === 'goal'} onRemove={() => untag(t.task_id)} />
          ))}
        {!m.pending && (
          <span className="v-tag add" role="button" tabIndex={0} data-testid="tag-add" onClick={() => setPop({})} onKeyDown={(e) => e.key === 'Enter' && setPop({})}>
            tag
          </span>
        )}
        {pop && !pop.move && <TagPicker tasks={tasks} exclude={tags.map((t) => t.task_id)} onPick={pick} onClose={() => setPop(null)} />}
      </div>
      {decision && !me && (
        <div className="v-note" data-testid="decision" data-decision={decision}>
          {decision === 'none' ? (
            <>
              <span className="v-k">→ no task (just a reply)</span>
              <button type="button" className="v-link" data-testid="wrong-task" onClick={() => setPop({ move: { from: null } })}>
                tag it?
              </button>
            </>
          ) : (
            <>
              <span className="v-k">→ {decision === 'created' ? 'created' : decision === 'moved' ? 'moved to' : 'tagged'}</span>
              {decisionTask && m.decision_task !== inTask && <TagChip tag={{ task_id: m.decision_task!, title: decisionTask.title }} shortN={34} />}
              {m.decision_task === inTask && <span className="v-k">this task</span>}
              <span className="v-k">({decision === 'created' ? 'new task' : decision === 'moved' ? 'by you' : 'existing task'})</span>
              {decision !== 'moved' && (
                <button type="button" className="v-link" data-testid="wrong-task" onClick={() => setPop({ move: { from: m.decision_task ?? null } })}>
                  wrong task?
                </button>
              )}
            </>
          )}
          {pop?.move && (
            <TagPicker
              tasks={tasks}
              exclude={pop.move.from ? [pop.move.from] : []}
              head={pop.move.from ? `Move the tag from “${short(decisionTask?.title ?? '', 30)}” to…` : 'Tag your message and the reply with…'}
              onPick={pick}
              onClose={() => setPop(null)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function QuestionBlock({ m, q, index, total, onAnswered }: { m: V3Message; q: Question; index: number; total: number; onAnswered: () => void }) {
  const { error } = useApp()
  const [draft, setDraft] = useState<Answer | undefined>()
  const [sending, setSending] = useState(false)
  const sentA = m.answer_state?.[q.key] && !answerIsEmpty(m.answer_state[q.key]) ? m.answer_state[q.key] : undefined
  const closed = m.closed?.[q.key] && !['moved_on', 'replaced'].includes(m.closed[q.key]!) ? m.closed[q.key]! : null
  const send = (a: Answer) => {
    setSending(true)
    v3.send(m.session_id, { words: '', answers_for: m.id, answers: [a] }, m.thread_id)
      .then(onAnswered)
      .catch((e) => {
        setSending(false)
        error(e)
      })
  }
  return (
    <div data-testid="question" data-open={!sentA && !closed ? 'true' : 'false'}>
      <QuestionCard
        index={index}
        total={total}
        q={q}
        sent={sentA}
        draft={draft}
        onDraft={(a) => {
          setDraft(a)
          // One click answers a single-choice question.
          if (q.kind === 'single' && a.selected?.length && !sending) send(a)
        }}
        closed={closed}
      />
      {!sentA && !closed && q.kind !== 'single' && draft && !answerIsEmpty(draft) && (
        <div style={{ marginTop: 6 }}>
          <button type="button" className="v-btn pri sm" data-testid="send-answer" disabled={sending} onClick={() => send(draft)}>
            Send answer
          </button>
        </div>
      )}
    </div>
  )
}

function ActionBlock({ m, items, onAnswered }: { m: V3Message; items: Question[]; onAnswered: () => void }) {
  const { error } = useApp()
  const [drafts, setDrafts] = useState<Record<string, Answer>>({})
  const answers = Object.fromEntries(items.map((q) => [q.key, m.answer_state?.[q.key]]))
  const list = Object.values(drafts).filter((a) => !answerIsEmpty(a))
  return (
    <div>
      <ActionItems items={items} answers={answers} drafts={drafts} onDraft={(a) => setDrafts((d) => ({ ...d, [a.key]: a }))} readOnly={items.every((q) => !!m.answer_state?.[q.key])} />
      {list.length > 0 && (
        <button
          type="button"
          className="v-btn pri sm"
          style={{ marginTop: 6 }}
          onClick={() =>
            v3
              .send(m.session_id, { words: '', answers_for: m.id, answers: list }, m.thread_id)
              .then(() => {
                setDrafts({})
                onAnswered()
              })
              .catch(error)
          }
        >
          Send
        </button>
      )}
    </div>
  )
}

// ---- composer ----

export function Composer({
  toId,
  toOptions,
  onTo,
  tags,
  placeholder,
  onSend,
  testid = 'composer',
  tasks,
}: {
  toId: string
  toOptions: Session[]
  onTo?: (id: string) => void
  tags: { task_id: string; title: string }[]
  placeholder: string
  onSend: (words: string, to: string, extraTasks: string[]) => Promise<void>
  testid?: string
  /** The tasks the person can tag the message with (# at the start, or the tag button). */
  tasks?: Task[]
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [extra, setExtra] = useState<{ task_id: string; title: string }[]>([])
  const [picking, setPicking] = useState(false)
  const send = async () => {
    const w = text.trim()
    if (!w || busy) return
    setBusy(true)
    setText('')
    const ex = extra
    setExtra([])
    try {
      await onSend(w, toId, ex.map((t) => t.task_id))
    } catch {
      setText(w)
      setExtra(ex)
    } finally {
      setBusy(false)
    }
  }
  const all = [...tags, ...extra]
  return (
    <div className="v-composer" data-testid={testid}>
      <div className="v-to">
        to{' '}
        {onTo ? (
          <select className="v-chip" aria-label="To" data-testid="composer-to" value={toId} onChange={(e) => onTo(e.target.value)}>
            {toOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.status === 'working' ? ' · in a turn' : ''}
              </option>
            ))}
            <option value="new">New agent…</option>
          </select>
        ) : (
          <span className="v-chip">{toOptions.find((a) => a.id === toId)?.name ?? 'agent'}</span>
        )}
        {all.length ? (
          <>
            tagged{' '}
            {tags.map((t) => (
              <TagChip key={t.task_id} tag={t} />
            ))}
            {extra.map((t) => (
              <TagChip key={t.task_id} tag={t} onRemove={() => setExtra((x) => x.filter((y) => y.task_id !== t.task_id))} />
            ))}
          </>
        ) : (
          '· the agent decides the task'
        )}
        {tasks && (
          <span style={{ position: 'relative' }}>
            <span className="v-tag add" role="button" tabIndex={0} data-testid="composer-tag" title="Tag the message (#)" onClick={() => setPicking(true)}>
              tag
            </span>
            {picking && (
              <TagPicker
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
      <textarea
        data-testid="composer-text"
        data-composer
        rows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          // # in an empty box picks a task to tag the message with.
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
        <span className="v-sp" />
        <span className="v-kbd v-hide-phone">⌘↵</span>
        <button type="button" className="v-btn pri" data-testid="composer-send" disabled={!text.trim() || busy} onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  )
}

export function statusLabel(t: Task | BoardTask): string {
  return STATUS_LABEL[t.status]
}

export function Tags({ tags }: { tags: Tag[] }) {
  return (
    <>
      {tags.map((t) => (
        <TagChip key={t.task_id} tag={t} shortN={18} />
      ))}
    </>
  )
}
