// The Board (home): "what needs me, and what is moving?" NEEDS YOU first (question cards, then tasks
// set to needs you), then GOALS with their tasks, WORKING (active in the last 3 days), BLOCKED, and,
// folded, QUIET (open but quiet longer) and DONE (the last 2 days).
import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../lib/app'
import { useSelectedProject } from '../lib/projects'
import { ago, currentStep, short, v3, type Board, type BoardTask, type V3Message } from './data'
import { ActionBlock, AnswerBar, Bar, MessageBodyClamp, QuickAnswer, StatusDot, Steps, TaskChip, Timeline, agentName, openQuestions, toggled, useNav, useSessionsById } from './parts'

export type BoardFocus = { key: string | null }

const QUIET_AFTER = 3 * 24 * 3600 * 1000
const DONE_WINDOW = 2 * 24 * 3600 * 1000

export function boardKeys(b: Board | null, showDone: boolean, hidden: Set<string>, showQuiet = false): string[] {
  if (!b) return []
  const g = groups(b, hidden)
  return [
    ...g.questions.map((m) => 'q:' + m.id),
    ...g.explicit.map((t) => 't:' + t.id),
    ...g.goals.flatMap((t) => ['t:' + t.id, ...g.childrenOf(t.id).map((c) => 't:' + c.id)]),
    ...g.working.map((t) => 't:' + t.id),
    ...g.blocked.map((t) => 't:' + t.id),
    ...(showQuiet ? g.quiet.map((t) => 't:' + t.id) : []),
    ...(showDone ? g.done.map((t) => 't:' + t.id) : []),
  ]
}

export function groups(b: Board, hidden: Set<string>) {
  const questions = b.questions.filter((m) => !hidden.has(m.id))
  const open = b.tasks.filter((t) => t.status !== 'done')
  const goals = open.filter((t) => t.kind === 'goal')
  const goalIds = new Set(goals.map((g) => g.id))
  const loose = open.filter((t) => t.kind !== 'goal' && !(t.parent_id && goalIds.has(t.parent_id)))
  const hasQ = (t: BoardTask) => questions.some((m) => m.tasks.some((tg) => tg.task_id === t.id))
  const byActivity = (a: BoardTask, z: BoardTask) => (a.last_activity < z.last_activity ? 1 : -1)
  const quietNow = (t: BoardTask) => Date.now() - new Date(t.last_activity).getTime() > QUIET_AFTER
  // Set to needs you without a question card: a row in NEEDS YOU. A task whose question is on a card
  // is not repeated as a row (the card is the thing to act on, and names the task).
  const explicit = open.filter((t) => t.status === 'needs_you' && !hasQ(t) && !(t.parent_id && goalIds.has(t.parent_id))).sort(byActivity)
  // A task whose question is on a card still shows in its group below (its progress, with "? n").
  const rest = loose.filter((t) => !explicit.includes(t))
  return {
    questions: questions.sort((a, z) => (a.created_at < z.created_at ? 1 : -1)),
    explicit,
    goals: goals.sort(byActivity),
    childrenOf: (id: string) => open.filter((t) => t.parent_id === id && t.kind !== 'goal').sort(byActivity),
    working: rest.filter((t) => (t.status === 'working' || t.status === 'needs_you') && !quietNow(t)).sort(byActivity),
    blocked: rest.filter((t) => t.status === 'blocked' && !quietNow(t)).sort(byActivity),
    quiet: rest.filter((t) => quietNow(t)).sort(byActivity),
    done: b.tasks.filter((t) => t.status === 'done' && Date.now() - new Date(t.done_at ?? t.updated_at).getTime() < DONE_WINDOW).sort((a, z) => ((a.done_at ?? '') < (z.done_at ?? '') ? 1 : -1)),
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
  showQuiet,
  setShowQuiet,
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
  showQuiet: boolean
  setShowQuiet: (v: boolean) => void
  hidden: Set<string>
  hide: (id: string) => void
}) {
  const { setOverlay, toast, error } = useApp()
  const { project } = useSelectedProject()
  const byId = useSessionsById()
  const nav = useNav()
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
    const qs = openQuestions(m)
    if (!qs.length) return null
    const sess = byId.get(m.session_id)
    return (
      <div key={m.id} className={'v-qc' + (focus === k ? ' focus' : '')} data-key={k} data-testid="question-card" onClick={() => setFocus(k)}>
        {qs
          .filter((q) => q.kind !== 'action')
          .map((q, i) => (
            <div key={q.key} className="v-qq" data-testid="card-question">
              <div className="v-q">
                {i === 0 && <b>you: </b>}
                {q.prompt}
              </div>
              <QuickAnswer m={m} q={q} keys={focus === k && i === 0} />
            </div>
          ))}
        {qs.some((q) => q.kind === 'action') && (
          <div className="v-qq" data-testid="card-actions">
            {qs.every((q) => q.kind === 'action') && (
              <div className="v-q">
                <b>you: </b>
                {qs.length > 1 ? `${qs.length} things to do` : 'a thing to do'}
              </div>
            )}
            <ActionBlock m={m} items={qs.filter((q) => q.kind === 'action')} />
          </div>
        )}
        <AnswerBar
          m={m}
          onSent={(as) => {
            hide(m.id)
            toast(`Sent ${as.length > 1 ? `${as.length} answers` : 'your answer'} to ${agentName(byId, m.session_id)}`)
          }}
        />
        <div className="v-meta">
          {m.tasks.length > 0 && <span className="v-k">in</span>}
          {m.tasks.map((t) => (
            <TaskChip key={t.task_id} task={t} shortN={48} />
          ))}
          <span className="v-sp" />
          <button type="button" className="v-link" style={{ color: 'inherit' }} onClick={() => nav.agent(m.session_id, m.id)}>
            {agentName(byId, m.session_id)}
            {sess?.status === 'working' ? ' · working' : ''}
          </button>
          · {ago(m.created_at)}
        </div>
      </div>
    )
  }
  const row = (t: BoardTask, child = false) => {
    const k = 't:' + t.id
    const open = expanded[t.id]
    const agents = t.agents.map((a) => byId.get(a.session_id)).filter((s): s is NonNullable<typeof s> => !!s)
    const who = agents.map((a) => a.name).join(' + ') || agentName(byId, t.last_agent)
    const cur = currentStep(t.steps)
    const live = agents.some((a) => a.status === 'working')
    const kids = t.kind === 'goal' ? g.childrenOf(t.id) : []
    const pr = t.links?.find((l) => l.kind === 'pr') ?? t.links?.[0]
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
                  {t.kind === 'goal' && <span style={{ color: 'var(--mb-purple)' }}>◎ </span>}
                  {t.title}
                </span>
                {t.open_questions > 0 && <span className="v-qmark">? {t.open_questions}</span>}
                {t.unread > 0 && <span className="v-unread" data-testid="unread-dot" title={`${t.unread} unread`} />}
              </div>
              <div className="v-sub">
                <span className={live ? 'v-livename' : ''}>
                  {who}
                  {live ? ' · working now' : ''}
                </span>
                <Bar t={t} />
                {t.kind !== 'goal' && cur && t.status !== 'done' ? (
                  <span className="v-last">now: {short(cur.text, 60)}</span>
                ) : t.kind !== 'goal' && t.last_line ? (
                  <span className="v-last" data-testid="last-line">
                    {t.last_line}
                  </span>
                ) : null}
                {t.kind === 'goal' && kids.length > 0 && <span>{kids.length} task{kids.length > 1 ? 's' : ''}</span>}
              </div>
            </div>
            <div className="v-ext">
              {t.kind === 'goal' && <GoalRun t={t} reload={reload} />}
              {pr && (
                <a href={pr.url} target="_blank" rel="noreferrer" className="v-link" onClick={(e) => e.stopPropagation()}>
                  {pr.label}
                  {pr.state ? ` · ${pr.state}` : ''}
                </a>
              )}
            </div>
            <div className="v-age" title={t.status === 'done' ? 'done' : 'last activity'}>
              {ago(t.status === 'done' ? t.done_at : t.last_activity)}
            </div>
          </div>
          {open && <Expanded t={t} reload={reload} />}
        </div>
        {kids.map((c) => row(c, true))}
      </div>
    )
  }
  const group = (title: string, cls: string, status: BoardTask['status'] | 'goals' | 'quiet', n: number, children: React.ReactNode, extra?: React.ReactNode) => (
    <section
      className={'v-group' + (dropping === status ? ' dropping' : '')}
      data-testid={`group-${status}`}
      onDragOver={(e) => {
        if (status === 'goals' || status === 'quiet') return
        e.preventDefault()
        setDropping(status)
      }}
      onDragLeave={() => setDropping(null)}
      onDrop={(e) => {
        setDropping(null)
        if (status === 'goals' || status === 'quiet') return
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
          {project?.name ?? 'All projects'} · <b data-testid="needs-count" style={needsN ? undefined : { color: 'inherit', fontWeight: 400 }}>{needsN} need you</b> · {g.working.length} working{g.blocked.length ? ` · ${g.blocked.length} blocked` : ''} · {openN} open
          <span className="v-hide-phone" style={{ marginLeft: 'auto' }}>
            J/K move · 1–9 pick · ⌘↵ send · Space expand · ↵ open · X done
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
        {g.blocked.length > 0 && group('BLOCKED', 'blocked', 'blocked', g.blocked.length, <>{g.blocked.map((t) => row(t))}</>)}
        {g.quiet.length > 0 &&
          group(
            'QUIET FOR 3+ DAYS',
            'quiet',
            'quiet',
            g.quiet.length,
            <>{showQuiet && g.quiet.map((t) => row(t))}</>,
            <button type="button" className="v-r" data-testid="toggle-quiet" onClick={() => setShowQuiet(!showQuiet)}>
              {showQuiet ? 'hide' : 'show'}
            </button>,
          )}
        {group(
          'DONE · LAST 2 DAYS',
          '',
          'done',
          g.done.length,
          <>{showDone && g.done.map((t) => row(t))}</>,
          g.done.length > 0 ? (
            <button type="button" className="v-r" data-testid="toggle-done" onClick={() => setShowDone(!showDone)}>
              {showDone ? 'hide' : 'show'}
            </button>
          ) : undefined,
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
    return ms.length ? ms[ms.length - 1]!.body : ''
  }, [t.report, detail])
  const ls = t.kind === 'goal' ? t.criteria : t.steps
  const done = ls.filter((s) => s.done).length
  return (
    <div className="v-detail" data-testid="task-expanded" onClick={(e) => e.stopPropagation()}>
      <div>
        {ls.length > 0 && (
          <>
            <div className="v-sec">
              {t.kind === 'goal' ? 'DONE WHEN' : 'CHECKLIST'}
              <span className="v-x">{Math.round((100 * done) / ls.length)}%</span>
            </div>
            <Steps
              t={t}
              criteria={t.kind === 'goal'}
              onToggle={(path) => v3.patchTask(t.id, t.kind === 'goal' ? { criteria: toggled(t.criteria, path) } : { steps: toggled(t.steps, path) }).then(reload).catch(error)}
            />
          </>
        )}
        <div className="v-sec">{t.report ? 'LAST REPORT' : 'LATEST FROM THE AGENT'}</div>
        {lastReport ? <MessageBodyClamp text={lastReport} lines={6} /> : <div className="v-cnt2">Nothing yet.</div>}
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
