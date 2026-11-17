// A task (or goal): "where is this work?" Its tagged messages from every agent's stream in time order
// with the events between them; "show context" opens the untagged messages around them. The reply
// goes to the agent most recently active on it (switchable) and carries the task's tag.
import { useEffect, useMemo, useState } from 'react'
import type { Attachment } from '../api'
import { useApp } from '../lib/app'
import { ago, hhmm, lineOf, short, useLive, useMarkRead, v3, STATUS_LABEL, type BoardTask, type TaskDetail, type TaskStatus, type V3Message } from './data'
import { GoalRun } from './Board'
import { Bar, Composer, MessageView, StatusDot, Steps, TagChip, agentName, toggled, useNav, useSessionsById } from './parts'

export function TaskView({ id, highlight, tasks, onOpenAttachment }: { id: string; highlight: string | null; tasks: BoardTask[]; onOpenAttachment: (a: Attachment, m: V3Message) => void }) {
  const { error, sessions, isPhone } = useApp()
  const byId = useSessionsById()
  const nav = useNav()
  const [d, reload] = useLive<TaskDetail>(id, () => v3.task(id))
  const [ctx, setCtx] = useState<Record<string, V3Message[] | 'loading'>>({})
  const [to, setTo] = useState<string | null>(null)
  const [pending, setPending] = useState<V3Message[]>([])
  const [sideOpen, setSideOpen] = useState(!isPhone)
  useEffect(() => {
    setTo(null)
    setCtx({})
    setPending([])
  }, [id])
  useMarkRead(d?.messages)
  const live = useMemo(() => (sessions ?? []).filter((s) => !s.archived_at && s.kind !== 'shell'), [sessions])
  if (!d) return <div className="v-col"><div className="v-empty">Loading…</div></div>
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
    ...d.events.filter((e) => e.kind !== 'tag' && e.kind !== 'answer').map((e) => ({ at: e.at, e })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1))
  const lastBy: Record<string, V3Message> = {}
  const typing = t.agents.map((a) => byId.get(a.session_id)).filter((s) => s?.status === 'working')
  const lastAgentMsg = [...d.messages].reverse().find((m) => m.author === 'agent')
  const lastReport = t.report || (lastAgentMsg ? lineOf(lastAgentMsg) : '')
  const send = async (words: string, toSel: string, extraTasks: string[]) => {
    const tmp: V3Message = { id: 'tmp-' + Date.now(), thread_id: '', author: 'user', body: words, words, created_at: new Date().toISOString(), read_at: null, claimed_at: null, delivered_at: null, session_id: toSel, tags: [{ task_id: t.id, title: t.title, status: t.status, source: 'person' }], open: 0, pending: true }
    setPending((p) => [...p, tmp])
    try {
      const ids = [t.id, ...extraTasks]
      if (toSel === 'new') await v3.newMessage({ to: 'new', project_id: t.project_id, words, task_ids: ids })
      else await v3.send(toSel, { words, task_ids: ids })
      reload()
    } catch (e) {
      setPending((p) => p.filter((x) => x !== tmp))
      error(e)
      throw e
    }
  }
  const side = (
    <aside className="v-side" data-testid="task-side">
      {t.kind === 'goal' && (
        <>
          <div className="v-sec">
            DONE WHEN <span className="v-x">{t.criteria_done}/{t.criteria.length}</span>
          </div>
          <Steps t={t} criteria onToggle={(path) => v3.patchTask(t.id, { criteria: toggled(t.criteria, path) }).then(reload).catch(error)} />
          <div className="v-sec">AUTONOMOUS RUN</div>
          <GoalRun t={t} reload={reload} />
          {t.auto?.reason && <div className="v-cnt2" style={{ marginTop: 4 }}>{t.auto.state === 'stopped' ? 'Ended' : 'Paused'}: {t.auto.reason}</div>}
          <div className="v-sec">
            TASKS <span className="v-x">{d.tasks.length}</span>
          </div>
          {d.tasks.map((c) => (
            <button type="button" key={c.id} className="v-mt" onClick={() => nav.task(c.id)}>
              <div className="v-a">
                <StatusDot t={c} />
                {c.title}
              </div>
              <div className="v-b">
                <Bar t={c} />
                <span className="v-cnt2">{STATUS_LABEL[c.status]}</span>
              </div>
            </button>
          ))}
          {!d.tasks.length && <div className="v-cnt2">No tasks serve it yet.</div>}
        </>
      )}
      {t.kind !== 'goal' && (
        <>
          <div className="v-sec">
            CHECKLIST <span className="v-x">{ago(t.created_at)}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <Bar t={t} />
          </div>
          <Steps t={t} onToggle={(path) => v3.patchTask(t.id, { steps: toggled(t.steps, path) }).then(reload).catch(error)} />
        </>
      )}
      <div className="v-sec">LAST REPORT</div>
      <div className="v-report" data-testid="last-report">{lastReport ? short(lastReport, 800) : '—'}</div>
      <div className="v-sec">FACTS</div>
      <dl className="v-facts">
        <dt>Agents</dt>
        <dd>{t.agents.map((a) => agentName(byId, a.session_id) + (a.role === 'assigned' ? '' : ' (involved)')).join(' · ') || '—'}</dd>
        {d.goal && (
          <>
            <dt>Goal</dt>
            <dd>
              <TagChip tag={{ task_id: d.goal.id, title: d.goal.title }} goal />
            </dd>
          </>
        )}
        <dt>Links</dt>
        <dd>
          {t.links.length
            ? t.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="v-link" style={{ marginRight: 6 }}>
                  {l.label}
                </a>
              ))
            : '—'}
        </dd>
        <dt>Started</dt>
        <dd>
          {hhmm(t.created_at)} · {ago(t.created_at)} ago
        </dd>
        <dt>Fresh</dt>
        <dd>last activity {ago(t.last_activity)} ago</dd>
      </dl>
      {t.summary && (
        <>
          <div className="v-sec">SUMMARY</div>
          <div style={{ fontSize: 12.5 }}>{t.summary}</div>
        </>
      )}
    </aside>
  )
  return (
    <>
      <div className="v-col" data-testid="task-view" data-task={t.id}>
        <div className="v-head">
          <div className="v-r1">
            <StatusDot t={t} live={typing.length > 0} />
            <h2 data-testid="task-title">
              {t.kind === 'goal' && <span style={{ color: 'var(--mb-purple)' }}>◎ </span>}
              {t.title}
            </h2>
            <select
              className="v-chip"
              aria-label="Status"
              data-testid="task-status"
              value={t.status}
              onChange={(e) => v3.patchTask(t.id, { status: e.target.value as TaskStatus }).then(reload).catch(error)}
            >
              {(['working', 'needs_you', 'blocked', 'done'] as const).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <button type="button" className="v-btn v-ph-only" onClick={() => setSideOpen(!sideOpen)}>
              {sideOpen ? 'Hide details' : 'Details'}
            </button>
            <button type="button" className="v-btn v-hide-phone" onClick={nav.board}>
              Esc · Board
            </button>
          </div>
          <div className="v-r2">
            {t.agents.map((a) => (
              <button type="button" key={a.session_id} className="v-chip" onClick={() => nav.agent(a.session_id)}>
                <span className={'v-dot ' + (byId.get(a.session_id)?.status === 'working' ? 'd-work v-live' : 'd-idle')} />
                {agentName(byId, a.session_id)}
              </button>
            ))}
            {t.kind === 'goal' && <GoalRun t={t} reload={reload} />}
            <span style={{ marginLeft: 'auto' }}>
              {d.messages.length} tagged message{d.messages.length === 1 ? '' : 's'} · {d.events.length} events
            </span>
          </div>
        </div>
        {isPhone && sideOpen && side}
        <div className="v-scroll" data-scroll={'task-' + id}>
          <div className="v-conv">
            {items.length === 0 && <div className="v-empty">No messages tagged yet. Write to an agent below; your message is tagged with this task.</div>}
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
                  <MessageView m={m} tasks={tasks} inTask={t.id} unread={m.author === 'agent' && !m.read_at} highlight={highlight === m.id} onOpenAttachment={onOpenAttachment} onChanged={reload} />
                </div>
              )
            })}
            {typing.map((s) => (
              <div key={s!.id} className="v-typing">
                {s!.name} is working…
              </div>
            ))}
          </div>
        </div>
        <Composer
          testid="task-composer"
          toId={toId}
          toOptions={opts}
          onTo={setTo}
          tags={[{ task_id: t.id, title: t.title }]}
          placeholder={toId === 'new' ? 'A new agent starts with this task…' : `Message ${agentName(byId, toId)} about this ${t.kind === 'goal' ? 'goal' : 'task'}…`}
          onSend={send}
          tasks={tasks}
        />
      </div>
      {!isPhone && side}
    </>
  )
}
