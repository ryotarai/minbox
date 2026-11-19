// A task's (or goal's) conversation inside an agent's page: its tagged messages from every agent's stream
// in time order with the events between them; "show context" opens the untagged messages around them.
// The reply goes to the agent most recently active on it (switchable) and carries the task's tag.
// The one task picked has the page's only reply box: its quieter "Send without task" (⇧⌘↵) sends to
// the agent's stream untagged (the agent whose page it is; in All agents, the task's agent).
// Two shapes: a column among the tasks checked in the agent's Tasks pane (a short header), or the one
// task picked in the agent's page (#v=agent&s=…&k=…): a card with its title, status, agents and checklist.
// (There is no task page of its own any more: every link to a task opens its agent's page with it.)
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Attachment } from '../api'
import { useApp } from '../lib/app'
import { leaves, standing, useLive, useMarkRead, v3, hhmm, STATUS_LABEL, type BoardTask, type TaskDetail, type TaskStatus, type V3Message } from './data'
import { GoalRun } from './Board'
import { Bar, MessageView, StatusDot, Steps, agentName, answersNearQuestions, shownEvent, taskOwner, toggled, useNav, useSessionsById, WorkingLine } from './parts'
import { Composer, type Outgoing } from './Composer'
import { NewPill, markUnreadFrom, useConversationKeys, useFirstNew, useFollow } from './conversation'
import { QuoteBubble } from './quote'
import { TaskTitle } from './RenameTask'
import { StuckAgentBanners } from './StuckAgent'
import { DeliveryLine } from '../components/ThreadView'
import { IconAskStatus, IconCheck, IconChevronDown, IconClose, IconGoal } from '../components/icons'

export function TaskView({
  id,
  highlight,
  tasks,
  onOpenAttachment,
  column,
  home,
}: {
  id: string
  highlight: string | null
  tasks: BoardTask[]
  onOpenAttachment: (a: Attachment, m: V3Message) => void
  /** onRemove: a column among the checked ones (✕ unchecks it). detail: the one task picked in the
   *  agent's page (its card; the Tasks pane's row, clicked again, closes it). */
  column: { onRemove?: () => void; detail?: boolean }
  /** The agent whose page shows the task: where "Send without task" goes (else the task's agent). */
  home?: string
}) {
  const { error, sessions, toast } = useApp()
  const byId = useSessionsById()
  const nav = useNav()
  const detail = !!column.detail
  const [d, reload, setD] = useLive<TaskDetail>(id, () => v3.task(id))
  const [ctx, setCtx] = useState<Record<string, V3Message[] | 'loading'>>({})
  const [to, setTo] = useState<string | null>(null)
  const [pending, setPending] = useState<V3Message[]>([])
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setTo(null)
    setCtx({})
    setPending([])
  }, [id])
  useMarkRead(d?.messages)
  const msgs = d?.messages ?? []
  const firstNew = useFirstNew(id, d?.messages)
  const follow = useFollow(scroller, id, d ? msgs : [], !!highlight && detail)
  const landed = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!d || landed.current === id || highlight) return
    landed.current = id
    const box = scroller.current
    const el = box?.querySelector('[data-new-divider]')
    if (el && box) {
      // It scrolls only itself (scrollIntoView would also move the row of columns sideways).
      box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top
      follow.atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60
    }
  })
  useConversationKeys(scroller, msgs, onOpenAttachment, detail)
  const live = useMemo(() => (sessions ?? []).filter((s) => !s.archived_at && s.kind !== 'shell'), [sessions])
  if (!d)
    return (
      <div className="v-col v-column" data-testid="task-column" data-task={id} data-detail={detail || undefined}>
        <div className="v-empty">Loading…</div>
      </div>
    )
  const t = d.task
  const toId = to ?? t.last_agent ?? live.find((s) => s.project_id === t.project_id)?.id ?? live[0]?.id ?? ''
  const opts = [...t.agents.map((a) => byId.get(a.session_id)).filter((s): s is NonNullable<typeof s> => !!s && !s.archived_at), ...live.filter((s) => !t.agents.some((a) => a.session_id === s.id) && (!t.project_id || s.project_id === t.project_id))]
  if (toId && !opts.some((s) => s.id === toId) && byId.get(toId)) opts.unshift(byId.get(toId)!)
  const showCtx = (m: V3Message, prev: V3Message | undefined) => {
    const k = m.id
    if (ctx[k]) {
      setCtx((c) => {
        const n = { ...c }
        delete n[k]
        return n
      })
      return
    }
    setCtx((c) => ({ ...c, [k]: 'loading' }))
    v3.stream(m.session_id, { after: prev?.id, before: m.id, limit: 1000 })
      .then((s) => setCtx((c) => ({ ...c, [k]: s.messages })))
      .catch(error)
  }
  const items: ({ at: string; m: V3Message } | { at: string; e: TaskDetail['events'][number] })[] = [
    ...d.messages.map((m) => ({ at: m.created_at, m })),
    ...pending.filter((p) => !d.messages.some((m) => m.author === 'user' && (m.words ?? m.body) === p.words && new Date(m.created_at).getTime() >= new Date(p.created_at).getTime() - 60_000)).map((m) => ({ at: m.created_at, m })),
    ...d.events.filter(shownEvent).map((e) => ({ at: e.at, e })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1))
  const nearQ = answersNearQuestions(items.flatMap((it) => ('m' in it ? [it.m] : [])))
  const lastBy: Record<string, V3Message> = {}
  const typing = t.agents.map((a) => byId.get(a.session_id)).filter((s) => s?.status === 'working')
  const assigned = t.agents.find((a) => a.role === 'assigned') ?? t.agents[0]
  const markUnread = (m: V3Message) =>
    markUnreadFrom(d.messages, m)
      .then(() => {
        toast('Marked unread')
        nav.board()
      })
      .catch(error)
  const lastUser = [...d.messages].reverse().find((m) => m.author === 'user' && m.kind !== 'note' && m.kind !== 'command' && m.kind !== 'run_result')
  const send = async (o: Outgoing) => {
    const words = o.words
    const toSel = o.to
    const tmp: V3Message = { id: 'tmp-' + Date.now(), thread_id: '', author: 'user', body: words, words, created_at: new Date().toISOString(), read_at: null, claimed_at: null, delivered_at: null, session_id: toSel, tasks: [{ task_id: t.id, title: t.title, status: t.status, source: 'person' }], open: 0, pending: true }
    setPending((p) => [...p, tmp])
    try {
      const uploads = o.uploads.length ? o.uploads : undefined
      const { to: _to, tasks: _tasks, ...rest } = o
      void _to
      void _tasks
      follow.atBottom.current = true
      if (toSel === 'new') await v3.newMessage({ ...rest, to: 'new', project_id: t.project_id, words, task_id: t.id, uploads })
      else await v3.send(toSel, { ...rest, words, task_id: t.id, uploads })
      reload()
      // The server has it now: the stand-in goes once the reload shows it (or the message was cancelled).
      setTimeout(() => setPending((p) => p.filter((x) => x !== tmp)), 1500)
    } catch (e) {
      setPending((p) => p.filter((x) => x !== tmp))
      error(e)
      throw e
    }
  }
  // "Send without task" (the one task picked): to the agent's stream, untagged, as its stream's box sends.
  const plainTo = detail ? (home ?? taskOwner(t, sessions ?? []) ?? '') : ''
  const sendPlain = async (o: Outgoing) => {
    try {
      const { to: _to, tasks: _tasks, ...rest } = o
      void _to
      void _tasks
      await v3.send(plainTo, { ...rest, uploads: o.uploads.length ? o.uploads : undefined })
      if (!o.forward_to) toast(`Sent to ${agentName(byId, plainTo)} without the task`)
    } catch (e) {
      error(e)
      throw e
    }
  }
  // "Ask for status" goes to the task's assigned agent (still live), else to whom the composer would send.
  const assignedLive = assigned && byId.get(assigned.session_id) && !byId.get(assigned.session_id)!.archived_at ? assigned.session_id : ''
  const askTo = assignedLive || (toId !== 'new' ? toId : '')
  const st = standing(t)
  const working = typing.length > 0
  const agentChips = t.agents.map((a) => (
    <button type="button" key={a.session_id} className="v-chip" data-testid="task-agent" onClick={() => nav.agent(a.session_id)}>
      <span className={'v-dot ' + (byId.get(a.session_id)?.status === 'working' ? 'd-work v-live' : 'd-idle')} />
      {agentName(byId, a.session_id)}
    </button>
  ))
  const sub = st && (
    <div className="v-colsub" data-testid="column-subtitle" data-from={st.from} title={st.text}>
      {st.from === 'step' ? 'now: ' : ''}
      {st.text}
    </div>
  )
  // A column: a short header (its title shows the task in the agent's page; ✕ unchecks it). The one
  // task picked in the agent's page: a card with its title (renamed in place), where it stands, its
  // status (set here), its agents, and its checklist beside them (below them when narrow).
  const head = detail ? (
    <div className="v-head v-colhead v-taskcard" data-testid="task-card">
      <div className="v-taskcard-main">
        <div className="v-r1">
          <StatusDot t={t} live={working} />
          <TaskTitle t={t} goal={t.kind === 'goal'} onShow={(title) => setD((x) => (x ? { ...x, task: { ...x.task, title } } : x))} onSaved={reload} />
        </div>
        {sub}
        <div className="v-r2">
          <select className="v-chip" aria-label="Status" data-testid="task-status" value={t.status} onChange={(e) => v3.patchTask(t.id, { status: e.target.value as TaskStatus }).then(reload).catch(error)}>
            {(['working', 'needs_you', 'blocked', 'done'] as const).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          {agentChips}
          {t.kind === 'goal' && <GoalRun t={t} reload={reload} />}
        </div>
      </div>
      <TaskChecklist t={t} reload={reload} />
    </div>
  ) : (
    <div className="v-head v-colhead">
      <div className="v-r1">
        <StatusDot t={t} live={working} />
        <h2 data-testid="column-title" title={t.title}>
          <button type="button" className="v-coltitle" title="Show this task in the agent's page" onClick={() => nav.task(t.id)}>
            {t.kind === 'goal' && <IconGoal size={14} className="v-goal" style={{ color: 'var(--mb-purple)' }} />}
            {t.title}
          </button>
        </h2>
        {column.onRemove && (
          <button type="button" className="v-btn v-colx" data-testid="column-remove" aria-label={`Remove “${t.title}” from the columns`} title="Remove from the columns" onClick={column.onRemove}>
            <IconClose size={14} />
          </button>
        )}
      </div>
      {sub}
      <div className="v-r2">
        <span className="v-cnt2">{STATUS_LABEL[t.status]}</span>
        {agentChips}
      </div>
    </div>
  )
  return (
    <>
      <div className="v-col v-column" data-testid="task-column" data-task={t.id} data-detail={detail || undefined} data-quote-scope="">
        {head}
        {/* All agents: the task's agents that wait in their terminals (an agent's own page shows its own above). */}
        {detail && !home && <StuckAgentBanners ids={t.agents.map((a) => a.session_id)} />}
        <div className="v-convwrap">
          <NewPill n={follow.unseen} onClick={follow.toBottom} />
          <div className="v-scroll" data-scroll={'task-' + id} ref={scroller} data-quote-box onScroll={follow.onScroll}>
            <div className="v-conv">
              {items.length === 0 && <div className="v-empty">No messages about this task yet. Write to an agent below: your message is about this task.</div>}
              {items.map((it) => {
                if ('e' in it) {
                  return (
                    <div key={it.e.id} className="v-ev" data-testid="event">
                      <span className="v-tm">{hhmm(it.e.at)}</span>
                      <span className="v-m" />
                      <span>{it.e.text}</span>
                    </div>
                  )
                }
                const m = it.m
                const prev = lastBy[m.session_id]
                lastBy[m.session_id] = m
                const c = ctx[m.id]
                return (
                  <div key={m.id} style={{ display: 'contents' }}>
                    {!!m.gap && prev && (
                      <button type="button" className="v-gap" data-testid="show-context" onClick={() => showCtx(m, prev)}>
                        <span>
                          {agentName(byId, m.session_id)} · {m.gap} other message{m.gap > 1 ? 's' : ''} · <b>{c ? 'hide' : 'show'} context</b>
                        </span>
                      </button>
                    )}
                    {Array.isArray(c) && c.map((x) => <MessageView key={x.id} m={x} tasks={tasks} ctx onOpenAttachment={onOpenAttachment} onChanged={reload} />)}
                    {m.id === firstNew && (
                      <div className="v-new" data-new-divider data-testid="new-divider">
                        New
                      </div>
                    )}
                    <MessageView m={m} tasks={tasks} inTask={t.id} latest={m === lastUser} questionNear={nearQ.has(m.id)} unread={m.author === 'agent' && !m.read_at} highlight={highlight === m.id} onOpenAttachment={onOpenAttachment} onChanged={reload} onUnread={markUnread} />
                    {m === lastUser && byId.get(m.session_id) && (
                      <div className="v-delivery">
                        <DeliveryLine m={m} session={byId.get(m.session_id)!} draftKey={'v3:task:' + t.id} compact />
                      </div>
                    )}
                  </div>
                )
              })}
              {t.status === 'working' && <WorkingLine name={assigned ? agentName(byId, assigned.session_id) : ''} after={askTo && <AskStatus key={t.id} onAsk={() => send({ words: ASK_STATUS, to: askTo, tasks: [t.id], uploads: [] })} />} />}
            </div>
          </div>
        </div>
        <Composer
          testid="task-composer"
          toId={toId}
          toOptions={opts}
          onTo={setTo}
          about={[{ task_id: t.id, title: t.title }]}
          draftKey={'v3:task:' + t.id}
          placeholder={toId === 'new' ? 'A new agent starts with this task…' : `Message ${agentName(byId, toId)} about this ${t.kind === 'goal' ? 'goal' : 'task'}…`}
          onSend={send}
          tasks={tasks}
          messages={d.messages}
          annotationKeys={[...new Set(d.messages.map((m) => m.thread_id))]}
          helpTask={t.id}
          untagged={plainTo ? { to: plainTo, onSend: sendPlain } : undefined}
        />
      </div>
      <QuoteBubble box={scroller} />
    </>
  )
}

/** Up to this many steps show before "Show all" (the rest scroll in the box until then). */
const FOLDED_STEPS = 5

/** Phone: a checklist longer than this starts folded to its progress bar (until the person chooses). */
const PHONE_OPEN_STEPS = 3
const FOLD_KEY = 'minbox:v3-checklist-folded'

/** The person's last choice on a phone (every task): true folded, false open, null none yet. */
function readFold(): boolean | null {
  try {
    const v = localStorage.getItem(FOLD_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}
function writeFold(folded: boolean) {
  try {
    localStorage.setItem(FOLD_KEY, folded ? '1' : '0')
  } catch {
    /* off: kept for this page only */
  }
}

/**
 * The task card's checklist: just its steps (a goal: its "done when" criteria), each ticked by a click;
 * no progress bar or count, the list says it. A long list stays a short box (scrolled to the current
 * step) until "Show all". On a phone (the checklist under the summary) it folds to one row, the progress
 * bar (segments, no count) with a chevron, that a tap unfolds; unfolded, a small chevron at the list's
 * top right folds it again. The choice is kept for every task; with no choice yet a short list (up to
 * PHONE_OPEN_STEPS) shows open, a longer one folded, so the conversation keeps the screen.
 */
function TaskChecklist({ t, reload }: { t: BoardTask; reload: () => void }) {
  const { error, isPhone } = useApp()
  const goal = t.kind === 'goal'
  const n = goal ? t.criteria.length : leaves(t.steps).length
  const [all, setAll] = useState(false)
  const [choice, setChoice] = useState(readFold)
  const folded = isPhone && (choice ?? n > PHONE_OPEN_STEPS)
  const fold = (v: boolean) => {
    writeFold(v)
    setChoice(v)
  }
  const box = useRef<HTMLDivElement>(null)
  const long = n > FOLDED_STEPS
  useLayoutEffect(() => {
    const el = box.current
    if (!el || all || !long) return
    const cur = el.querySelector<HTMLElement>('.v-st.doing')
    if (cur) el.scrollTop = Math.max(0, cur.offsetTop - el.offsetTop - 24)
  }, [t.id, all, long, folded])
  if (!n) return null
  return (
    <div className="v-taskcheck" data-testid="task-checklist" role="group" aria-label={goal ? 'Done when' : 'Checklist'}>
      {/* No heading, bar or count: the first step is the first row, level with the task's title. On a
          phone one toggle folds the list: folded, it is the row (the progress bar); open, a chevron at
          the list's top right. */}
      {isPhone && (
        <button
          type="button"
          className={'v-taskcheck-toggle' + (folded ? ' row' : '')}
          data-testid="task-checklist-toggle"
          aria-expanded={!folded}
          aria-label={`${folded ? 'Show' : 'Hide'} the ${goal ? 'criteria' : 'steps'}`}
          onClick={() => fold(!folded)}
        >
          {folded && <Bar t={t} count={false} />}
          <IconChevronDown size={14} className="v-taskcheck-chev" aria-hidden />
        </button>
      )}
      {!folded && (
      <div ref={box} className={'v-taskcheck-list' + (long && !all ? ' folded' : '')} data-testid="task-checklist-list">
        <Steps
          t={t}
          criteria={goal}
          onToggle={(path) => v3.patchTask(t.id, goal ? { criteria: toggled(t.criteria, path) } : { steps: toggled(t.steps, path) }).then(reload).catch(error)}
        />
      </div>
      )}
      {long && !folded && (
        <button type="button" className="v-link v-taskcheck-more" data-testid="task-checklist-more" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${n}`}
        </button>
      )}
    </div>
  )
}

/** The words sent: asks for a short report in a fixed Markdown shape, so answers read the same every time. */
const ASK_STATUS = `What's the status of this task? Reply with a short Markdown report:
- **Status**: one line on where it stands
- **Done**: what's finished
- **Now**: what you're doing right now
- **Next**: what comes after
- **Blocked on**: anything you need from me (or "nothing")`

/** Beside the working line: asks the agent where the task stands (a person message about the task, sent as
 *  the composer sends one, its draft untouched). "Sent" for a few seconds after, disabled meanwhile. */
function AskStatus({ onAsk }: { onAsk: () => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const ask = () => {
    if (state !== 'idle') return
    setState('sending')
    onAsk()
      .then(() => {
        setState('sent')
        timer.current = setTimeout(() => setState('idle'), 4000)
      })
      .catch(() => setState('idle'))
  }
  return (
    <button type="button" className="v-btn sm v-askstatus" data-testid="ask-status" data-state={state} disabled={state !== 'idle'} title="Ask the agent for a short status report on this task" onClick={ask}>
      {state === 'sent' ? <IconCheck size={12} /> : <IconAskStatus size={12} />}
      {state === 'sent' ? 'Sent' : 'Ask for status'}
    </button>
  )
}
