// A task's (or goal's) conversation inside an agent's page: its tagged messages from every agent's stream
// in time order with the events between them; "show context" opens the untagged messages around them.
// The reply goes to the agent most recently active on it (switchable) and carries the task's tag.
// Two shapes: a column among the tasks checked in the agent's Tasks pane (a short header), or the one
// task picked in the agent's page (#v=agent&s=…&k=…): a card with its title, status, agents and checklist.
// (There is no task page of its own any more: every link to a task opens its agent's page with it.)
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Attachment } from '../api'
import { useApp } from '../lib/app'
import { leaves, standing, useLive, useMarkRead, v3, hhmm, STATUS_LABEL, type BoardTask, type TaskDetail, type TaskStatus, type V3Message } from './data'
import { GoalRun } from './Board'
import { Bar, MessageView, StatusDot, Steps, agentName, answersNearQuestions, shownEvent, toggled, useNav, useSessionsById, WorkingLine } from './parts'
import { Composer, type Outgoing } from './Composer'
import { NewPill, markUnreadFrom, useConversationKeys, useFirstNew, useFollow } from './conversation'
import { QuoteBubble } from './quote'
import { TaskTitle } from './RenameTask'
import { DeliveryLine } from '../components/ThreadView'
import { IconClose, IconGoal } from '../components/icons'

export function TaskView({
  id,
  highlight,
  tasks,
  onOpenAttachment,
  column,
}: {
  id: string
  highlight: string | null
  tasks: BoardTask[]
  onOpenAttachment: (a: Attachment, m: V3Message) => void
  /** onRemove: a column among the checked ones (✕ unchecks it). detail: the one task picked in the
   *  agent's page (its card; the Tasks pane's row, clicked again, closes it). */
  column: { onRemove?: () => void; detail?: boolean }
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
  const toId = to ?? t.last_agent ?? live.find((s) => s.is_main && s.project_id === t.project_id)?.id ?? live[0]?.id ?? ''
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
  const lastUser = [...d.messages].reverse().find((m) => m.author === 'user' && m.kind !== 'note' && m.kind !== 'command')
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
              {t.status === 'working' && <WorkingLine name={assigned ? agentName(byId, assigned.session_id) : ''} />}
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
        />
      </div>
      <QuoteBubble box={scroller} />
    </>
  )
}

/** Up to this many steps show before "Show all" (the rest scroll in the box until then). */
const FOLDED_STEPS = 5

/**
 * The task card's checklist: its progress (a bar of segments and "n/m") and its steps (a goal: its
 * "done when" criteria), each ticked by a click. A long list stays a short box (scrolled to the current
 * step) until "Show all".
 */
function TaskChecklist({ t, reload }: { t: BoardTask; reload: () => void }) {
  const { error } = useApp()
  const goal = t.kind === 'goal'
  const n = goal ? t.criteria.length : leaves(t.steps).length
  const [all, setAll] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const long = n > FOLDED_STEPS
  useLayoutEffect(() => {
    const el = box.current
    if (!el || all || !long) return
    const cur = el.querySelector<HTMLElement>('.v-st.doing')
    if (cur) el.scrollTop = Math.max(0, cur.offsetTop - el.offsetTop - 24)
  }, [t.id, all, long])
  if (!n) return null
  return (
    <div className="v-taskcheck" data-testid="task-checklist">
      <div className="v-sec">
        {goal ? 'DONE WHEN' : 'CHECKLIST'}
        <span className="v-taskcheck-bar">
          <Bar t={t} />
        </span>
      </div>
      <div ref={box} className={'v-taskcheck-list' + (long && !all ? ' folded' : '')} data-testid="task-checklist-list">
        <Steps
          t={t}
          criteria={goal}
          onToggle={(path) => v3.patchTask(t.id, goal ? { criteria: toggled(t.criteria, path) } : { steps: toggled(t.steps, path) }).then(reload).catch(error)}
        />
      </div>
      {long && (
        <button type="button" className="v-link v-taskcheck-more" data-testid="task-checklist-more" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${n}`}
        </button>
      )}
    </div>
  )
}
