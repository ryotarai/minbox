// The Board (home): "what needs me, and what is moving?" NEEDS YOU first (question cards, then tasks
// set to needs you), then GOALS with their tasks, WORKING, BLOCKED and DONE (folded).
import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../lib/app'
import { useSelectedProject } from '../lib/projects'
import { ago, currentStep, lineOf, short, v3, type Board, type BoardTask, type V3Message } from './data'
import { Bar, QuickChoices, StatusDot, Steps, TagChip, TagPicker, Timeline, agentName, toggled, useNav, useSessionsById } from './parts'

export type BoardFocus = { key: string | null }

export function boardKeys(b: Board | null, showDone: boolean, hidden: Set<string>): string[] {
  if (!b) return []
  const g = groups(b, hidden)
  return [
    ...g.questions.map((m) => 'q:' + m.id),
    ...g.explicit.map((t) => 't:' + t.id),
    ...g.goals.flatMap((t) => ['t:' + t.id, ...g.childrenOf(t.id).map((c) => 't:' + c.id)]),
    ...g.working.map((t) => 't:' + t.id),
    ...g.blocked.map((t) => 't:' + t.id),
    ...(showDone ? g.done.map((t) => 't:' + t.id) : []),
  ]
}

function groups(b: Board, hidden: Set<string>) {
  const questions = b.questions.filter((m) => !hidden.has(m.id))
  const open = b.tasks.filter((t) => t.status !== 'done')
  const goals = open.filter((t) => t.kind === 'goal')
  const goalIds = new Set(goals.map((g) => g.id))
  const loose = open.filter((t) => t.kind !== 'goal' && !(t.parent_id && goalIds.has(t.parent_id)))
  const hasQ = (t: BoardTask) => questions.some((m) => m.tags.some((tg) => tg.task_id === t.id))
  const byActivity = (a: BoardTask, z: BoardTask) => (a.last_activity < z.last_activity ? 1 : -1)
  // Set to needs you without a question card: a row in NEEDS YOU. A task whose question is on a card
  // stays where its status puts it (the card is the thing to act on).
  const explicit = open.filter((t) => t.status === 'needs_you' && !hasQ(t) && !(t.parent_id && goalIds.has(t.parent_id)))
  return {
    questions,
    explicit,
    goals: goals.sort(byActivity),
    childrenOf: (id: string) => open.filter((t) => t.parent_id === id && t.kind !== 'goal').sort(byActivity),
    working: loose.filter((t) => !explicit.includes(t) && (t.status === 'working' || t.status === 'needs_you')).sort(byActivity),
    blocked: loose.filter((t) => t.status === 'blocked').sort(byActivity),
    done: b.tasks.filter((t) => t.status === 'done').sort((a, z) => ((a.done_at ?? '') < (z.done_at ?? '') ? 1 : -1)),
  }
}

export function BoardView({
  board,
  reload,
  focus,
  setFocus,
  expanded,
  toggleExpanded,
  showDone,
  setShowDone,
  hidden,
  hide,
}: {
  board: Board | null
  reload: () => void
  focus: string | null
  setFocus: (k: string | null) => void
  expanded: Record<string, boolean>
  toggleExpanded: (id: string) => void
  showDone: boolean
  setShowDone: (v: boolean) => void
  hidden: Set<string>
  hide: (id: string) => void
}) {
  const { setOverlay, toast, error } = useApp()
  const { project } = useSelectedProject()
  const byId = useSessionsById()
  const nav = useNav()
  const [tagPop, setTagPop] = useState<string | null>(null)
  const [dropping, setDropping] = useState<string | null>(null)
  if (!board) return <div className="v-col"><div className="v-empty">Loading…</div></div>
  const g = groups(board, hidden)
  const needsN = g.questions.length + g.explicit.length
  const openN = board.tasks.filter((t) => t.status !== 'done').length

  const setStatus = (t: BoardTask, status: BoardTask['status']) => {
    v3.patchTask(t.id, { status }).then(reload).catch(error)
  }
  const qcard = (m: V3Message) => {
    const k = 'q:' + m.id
    const q = (m.questions ?? []).find((x) => !m.answer_state?.[x.key] && !m.closed?.[x.key]) ?? m.questions?.[0]
    if (!q) return null
    return (
      <div key={m.id} className={'v-qc' + (m.tags.length ? '' : ' untag') + (focus === k ? ' focus' : '')} data-key={k} data-testid="question-card" onClick={() => setFocus(k)}>
        <div className="v-q">
          <b>you:</b> {q.prompt}
          {m.open > 1 && <span className="v-cnt2"> · {m.open} questions</span>}
        </div>
        {q.kind === 'single' ? (
          <QuickChoices
            m={m}
            q={q}
            keys={focus === k}
            onAnswered={(text) => {
              hide(m.id)
              toast(`Answered “${short(text, 40)}” · sent to ${agentName(byId, m.session_id)}`)
            }}
          />
        ) : (
          <div className="v-choices">
            <button type="button" className="v-btn sm" onClick={() => (m.tags[0] ? nav.task(m.tags[0].task_id, m.id) : nav.agent(m.session_id, m.id))}>
              Answer…
            </button>
          </div>
        )}
        <div className="v-meta">
          {m.tags.map((t) => (
            <TagChip key={t.task_id} tag={t} />
          ))}
          {!m.tags.length && (
            <span className="v-tag add" role="button" tabIndex={0} data-testid="tag-add" onClick={(e) => (e.stopPropagation(), setTagPop(m.id))}>
              tag to task
            </span>
          )}
          {tagPop === m.id && (
            <TagPicker
              tasks={board.tasks}
              exclude={[]}
              onClose={() => setTagPop(null)}
              onPick={(r) => {
                setTagPop(null)
                ;('task_id' in r ? v3.tag(m.id, r.task_id) : v3.createTask({ title: r.title, session_id: m.session_id, message_ids: [m.id] })).then(reload).catch(error)
              }}
            />
          )}
          <span className="v-sp" />
          <button type="button" className="v-link" style={{ color: 'inherit' }} onClick={() => nav.agent(m.session_id, m.id)}>
            {agentName(byId, m.session_id)}
            {m.tags.length ? '' : ' · untagged'}
          </button>
          · {ago(m.created_at)}
        </div>
      </div>
    )
  }
  const row = (t: BoardTask, child = false) => {
    const k = 't:' + t.id
    const open = expanded[t.id]
    const who = t.agents.map((a) => agentName(byId, a.session_id)).join(' + ')
    const cur = currentStep(t.steps)
    const live = t.agents.some((a) => byId.get(a.session_id)?.status === 'working')
    const kids = t.kind === 'goal' ? g.childrenOf(t.id) : []
    const run = t.auto?.state
    return (
      <div key={t.id}>
        <div
          className={'v-row' + (focus === k ? ' focus' : '') + (open ? ' open' : '') + (child ? ' child' : '')}
          data-key={k}
          data-testid="task-row"
          data-task={t.id}
          data-kind={t.kind || 'task'}
          draggable
          onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
        >
          <div
            className="v-line"
            onClick={() => {
              setFocus(k)
              toggleExpanded(t.id)
            }}
            onDoubleClick={() => nav.task(t.id)}
          >
            <div>
              <div className="v-ti">
                <StatusDot t={t} live={live} />
                <span className="v-t">
                  {t.status === 'needs_you' && !t.open_questions && <b style={{ color: 'var(--mb-wait)' }}>you: </b>}
                  {t.kind === 'goal' && <span style={{ color: 'var(--mb-purple)' }}>◎ </span>}
                  {t.title}
                </span>
                {t.open_questions > 0 && <span className="v-qmark">? {t.open_questions}</span>}
                {t.unread > 0 && <span className="v-unread" data-testid="unread-dot" title={`${t.unread} unread`} />}
              </div>
              <div className="v-sub">
                <span>{who || 'no agent'}</span>
                <Bar t={t} />
                {t.kind !== 'goal' && cur && t.status !== 'done' && <span>now: {short(cur.text, 34)}</span>}
                {t.kind === 'goal' && kids.length > 0 && <span>{kids.length} task{kids.length > 1 ? 's' : ''}</span>}
              </div>
            </div>
            <div className="v-ext">
              {t.kind === 'goal' && <GoalRun t={t} reload={reload} />}
              {t.links?.slice(0, 1).map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="v-link" onClick={(e) => e.stopPropagation()}>
                  {l.label}
                </a>
              ))}
              {t.kind !== 'goal' && !t.links?.length && <span style={{ color: 'var(--mb-faint)' }}>{t.message_count} msg</span>}
              {run === 'running' && t.kind !== 'goal' ? null : null}
            </div>
            <div className="v-age">{ago(t.status === 'done' ? t.done_at : t.last_activity)}</div>
          </div>
          {open && <Expanded t={t} reload={reload} />}
        </div>
        {kids.map((c) => row(c, true))}
      </div>
    )
  }
  const group = (title: string, cls: string, status: BoardTask['status'] | 'goals', n: number, children: React.ReactNode, extra?: React.ReactNode) => (
    <section
      className={'v-group' + (dropping === status ? ' dropping' : '')}
      data-testid={`group-${status}`}
      onDragOver={(e) => {
        if (status === 'goals') return
        e.preventDefault()
        setDropping(status)
      }}
      onDragLeave={() => setDropping(null)}
      onDrop={(e) => {
        setDropping(null)
        if (status === 'goals') return
        const id = e.dataTransfer.getData('text/plain')
        const t = board.tasks.find((x) => x.id === id)
        if (t && t.status !== status) setStatus(t, status)
        if (status === 'done') setShowDone(true)
      }}
    >
      <div className={'v-gh ' + cls}>
        {title} <span className="v-n">{n}</span>
        {extra}
      </div>
      {children}
    </section>
  )
  return (
    <div className="v-col" data-testid="board">
      <div className="v-head">
        <div className="v-r1">
          <h1>Board</h1>
          <button type="button" className="v-btn" data-testid="new-message" onClick={() => setOverlay({ kind: 'v3-new' } as never)}>
            ＋ New message <span className="v-kbd v-hide-phone">⇧N</span>
          </button>
        </div>
        <div className="v-r2 v-sum">
          {project?.name ?? 'All projects'} · {openN} open · <b data-testid="needs-count" style={needsN ? undefined : { color: 'inherit', fontWeight: 400 }}>{needsN} need you</b> · {g.working.length} working · {g.blocked.length} blocked
          <span className="v-hide-phone" style={{ marginLeft: 'auto' }}>
            J/K move · Space expand · ↵ open · 1–9 answer · X done · drag rows
          </span>
        </div>
      </div>
      <div className="v-scroll" data-scroll="board">
        {group(
          'NEEDS YOU',
          'needs',
          'needs_you',
          needsN,
          <>
            {g.questions.map(qcard)}
            {g.explicit.map((t) => row(t))}
            {needsN === 0 && <div className="v-empty">Nothing needs you. New work: ⇧N.</div>}
          </>,
        )}
        {g.goals.length > 0 && group('GOALS', 'goals', 'goals', g.goals.length, <>{g.goals.map((t) => row(t))}</>)}
        {group('WORKING', '', 'working', g.working.length, <>{g.working.map((t) => row(t))}{g.working.length === 0 && <div className="v-empty">Nothing in progress. Ask an agent for something with ⇧N.</div>}</>)}
        {group('BLOCKED', 'blocked', 'blocked', g.blocked.length, <>{g.blocked.map((t) => row(t))}{g.blocked.length === 0 && <div className="v-empty">Nothing blocked.</div>}</>)}
        {group(
          'DONE THIS WEEK',
          '',
          'done',
          g.done.length,
          <>{showDone && g.done.map((t) => row(t))}</>,
          <button type="button" className="v-r" data-testid="toggle-done" onClick={() => setShowDone(!showDone)}>
            {showDone ? 'hide' : 'show'}
          </button>,
        )}
        <div style={{ height: 60 }} />
      </div>
    </div>
  )
}

/** A goal's autonomous run: its state and Start / Pause / Stop. */
export function GoalRun({ t, reload }: { t: BoardTask; reload: () => void }) {
  const { error } = useApp()
  const run = t.auto?.state ?? ''
  const act = (a: 'start' | 'pause' | 'stop') => (e: React.MouseEvent) => {
    e.stopPropagation()
    v3.auto(t.id, a).then(reload).catch(error)
  }
  if (t.status === 'done') return <span className="v-pill">met</span>
  return (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }} data-testid="goal-run" data-state={run || 'off'}>
      {run === 'running' && (
        <span className="v-pill run">
          running · {t.auto.turns ?? 0}/{t.auto.max_turns ?? 20}
        </span>
      )}
      {run === 'paused' && <span className="v-pill pause">paused</span>}
      {run === 'running' ? (
        <>
          <button type="button" className="v-btn sm" data-testid="goal-pause" onClick={act('pause')}>
            Pause
          </button>
          <button type="button" className="v-btn sm" data-testid="goal-stop" onClick={act('stop')}>
            Stop
          </button>
        </>
      ) : (
        <button type="button" className="v-btn sm" data-testid="goal-start" onClick={act('start')}>
          {run === 'paused' ? 'Resume' : 'Start run'}
        </button>
      )}
    </span>
  )
}

/** A row expanded in place: checklist (or criteria), last report, timeline. */
function Expanded({ t, reload }: { t: BoardTask; reload: () => void }) {
  const { error } = useApp()
  const byId = useSessionsById()
  const nav = useNav()
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof v3.task>> | null>(null)
  useEffect(() => {
    v3.task(t.id).then(setDetail).catch(() => {})
  }, [t.id, t.updated_at, t.message_count])
  const lastReport = useMemo(() => {
    if (t.report) return t.report
    const ms = (detail?.messages ?? []).filter((m) => m.author === 'agent')
    return ms.length ? lineOf(ms[ms.length - 1]!) : ''
  }, [t.report, detail])
  const ls = t.kind === 'goal' ? t.criteria : t.steps
  const done = ls.filter((s) => s.done).length
  return (
    <div className="v-detail" data-testid="task-expanded" onClick={(e) => e.stopPropagation()}>
      <div>
        <div className="v-sec">
          {t.kind === 'goal' ? 'DONE WHEN' : 'CHECKLIST'}
          <span className="v-x">
            {ls.length ? `${Math.round((100 * done) / ls.length)}% · ` : ''}
            {ago(t.created_at)}
          </span>
        </div>
        <Steps
          t={t}
          criteria={t.kind === 'goal'}
          onToggle={(path) => v3.patchTask(t.id, t.kind === 'goal' ? { criteria: toggled(t.criteria, path) } : { steps: toggled(t.steps, path) }).then(reload).catch(error)}
        />
        <div className="v-sec">LAST REPORT</div>
        <div className="v-report">{lastReport ? short(lastReport, 600) : '—'}</div>
        <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
          <button type="button" className="v-btn pri sm" data-testid="open-task" onClick={() => nav.task(t.id)}>
            Open {t.kind === 'goal' ? 'goal' : 'task'} ↵
          </button>
          {t.last_agent && (
            <button type="button" className="v-btn sm" onClick={() => nav.agent(t.last_agent)}>
              Open {agentName(byId, t.last_agent)}
            </button>
          )}
        </div>
      </div>
      <div>
        <div className="v-sec">TIMELINE</div>
        {detail ? <Timeline events={detail.events} messages={detail.messages} n={8} byId={byId} /> : <div className="v-cnt2">…</div>}
      </div>
    </div>
  )
}

export function useBoard(): [Board | null, () => void] {
  const { id } = useSelectedProject()
  const [board, setBoard] = useState<Board | null>(null)
  const key = id
  const load = useMemo(() => () => v3.board(key).then(setBoard).catch(() => {}), [key])
  useEffect(() => {
    load()
  }, [load])
  useEffectV3(load)
  return [board, load]
}

function useEffectV3(f: () => void) {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const on = () => {
      if (t) clearTimeout(t)
      t = setTimeout(f, 120)
    }
    window.addEventListener('minbox:v3', on)
    const iv = setInterval(() => document.visibilityState === 'visible' && f(), 30000)
    return () => {
      window.removeEventListener('minbox:v3', on)
      clearInterval(iv)
      if (t) clearTimeout(t)
    }
  }, [f])
}
