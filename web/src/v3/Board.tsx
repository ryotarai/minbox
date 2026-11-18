// The Board (home): "what needs me, and what is moving?" NEEDS YOU first (compact question rows, then tasks
// set to needs you), then GOALS with their tasks, WORKING (active in the last 3 days), BLOCKED, and,
// folded, QUIET (open but quiet longer) and DONE (the last 2 days).
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useApp } from '../lib/app'
import { useSelectedProject } from '../lib/projects'
import { ago, short, standing, v3, type Board, type BoardTask, type V3Message } from './data'
import { TaskRowMenu } from './RenameTask'
import { IconMore } from '../components/icons'
import type { MenuAt } from '../components/ui'
import type { Question } from '../api'
import { Bar, MessageBodyClamp, StatusDot, Steps, agentName, openQuestions, statusLabel, toggled, useNav, useSessionsById } from './parts'

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

/** What NEEDS YOU counts: its question cards and its rows, the very entries it shows (the Board's header, the sidebar badge, the tab title). */
export function needsCount(b: Board | null, hidden: Set<string>): number {
  if (!b) return 0
  const g = groups(b, hidden)
  return g.questions.length + g.explicit.length
}

/** What a task set to needs you without a question waits on: where it stands (summary, else report, else
 *  the agent's latest line about it; see standing), never its step. */
export function needsWhat(t: BoardTask): string {
  const s = standing(t)
  return s && s.from !== 'step' ? s.text : 'Set to needs you — open it to see what it waits on'
}

/** A NEEDS YOU row's ask in one line: the first question's prompt (+n for the others), or the first thing to do (+n). Never empty. */
export function askText(qs: Question[]): string {
  const line = (q: Question) => q.prompt.trim().split('\n')[0]!.trim()
  const asks = qs.filter((q) => q.kind !== 'action')
  const acts = qs.filter((q) => q.kind === 'action')
  if (asks.length) {
    const more = asks.length - 1 + acts.length
    const p = line(asks[0]!) || (asks[0]!.kind === 'text' ? 'an answer' : 'a choice')
    return more ? `${p} +${more}` : p
  }
  if (!acts.length) return 'a question'
  const p = line(acts[0]!) || (acts.length > 1 ? `${acts.length} things to do` : 'a thing to do')
  return acts.length > 1 ? `${p} +${acts.length - 1}` : p
}

/** Where a question is answered: its task, at the question (else the agent's stream, at it). */
export function openAsk(nav: ReturnType<typeof useNav>, m: V3Message) {
  if (m.tasks[0]) nav.task(m.tasks[0].task_id, m.id)
  else nav.agent(m.session_id, m.id)
}

export function groups(b: Board, hidden: Set<string>) {
  // A message counts as a card only while it has a question left to show (a card with none would be empty).
  const questions = b.questions.filter((m) => !hidden.has(m.id) && openQuestions(m).length > 0)
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
    // A goal set to needs you is a row in NEEDS YOU (with its tasks), not again in GOALS.
    goals: goals.filter((t) => !explicit.includes(t)).sort(byActivity),
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
  onRename,
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
  /** Rename a task (its row menu): the dialog is the app's, as for E / F2 on the focused row. */
  onRename?: (t: BoardTask) => void
}) {
  const { setOverlay, error } = useApp()
  const { project } = useSelectedProject()
  const byId = useSessionsById()
  const nav = useNav()
  const [dropping, setDropping] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ t: BoardTask; at: MenuAt } | null>(null)
  if (!board) return <div className="v-col"><div className="v-empty">Loading…</div></div>
  const g = groups(board, hidden)
  const needsN = needsCount(board, hidden)
  const openN = board.tasks.filter((t) => t.status !== 'done').length

  const setStatus = (t: BoardTask, status: BoardTask['status']) => {
    v3.patchTask(t.id, { status }).then(reload).catch(error)
  }
  // A question waiting on the person: one compact row like the others (the ask, its task, progress,
  // links, age). It is answered in the task (or the agent's stream), not here: a click or Space
  // expands it, Enter or its button opens the task at the question.
  const qrow = (m: V3Message) => {
    const k = 'q:' + m.id
    const qs = openQuestions(m)
    if (!qs.length) return null
    const open = expanded[m.id]
    const t = m.tasks.map((x) => board.tasks.find((bt) => bt.id === x.task_id)).find((x): x is BoardTask => !!x)
    const title = t?.title ?? m.tasks[0]?.title
    const live = byId.get(m.session_id)?.status === 'working'
    const pr = t?.links?.find((l) => l.kind === 'pr') ?? t?.links?.[0]
    const ask = askText(qs)
    return (
      <div key={m.id} className={'v-row' + (focus === k ? ' focus' : '') + (open ? ' open' : '')} data-key={k} data-testid="question-card" data-message={m.id}>
        <div
          className="v-line"
          onClick={() => {
            setFocus(k)
            toggleExpanded(m.id)
          }}
          onDoubleClick={() => openAsk(nav, m)}
        >
          <div>
            <div className="v-ti">
              <StatusDot t={{ status: 'needs_you', needs_you: true, kind: '' }} live={live} />
              <span className="v-t" data-testid="ask" title={ask}>
                <b className="v-you">you: </b>
                {ask}
              </span>
            </div>
            <div className="v-sub">
              <span className={live ? 'v-livename' : ''}>
                {agentName(byId, m.session_id)}
                {live ? ' · working now' : ''}
              </span>
              {t && <Bar t={t} />}
              {title && (
                <span className="v-last" data-testid="ask-task" title={title}>
                  {title}
                </span>
              )}
            </div>
          </div>
          <div className="v-ext">
            {pr && (
              <a href={pr.url} target="_blank" rel="noreferrer" className="v-link" onClick={(e) => e.stopPropagation()}>
                {pr.label}
                {pr.state ? ` · ${pr.state}` : ''}
              </a>
            )}
          </div>
          <div className="v-age" title="asked">
            {ago(m.created_at)}
          </div>
        </div>
        {open && (t ? <Expanded t={t} reload={reload} ask={m} /> : <AskExpanded m={m} />)}
      </div>
    )
  }
  const row = (t: BoardTask, child = false, needs = false) => {
    const k = 't:' + t.id
    const open = expanded[t.id]
    const agents = t.agents.map((a) => byId.get(a.session_id)).filter((s): s is NonNullable<typeof s> => !!s)
    const who = agents.map((a) => a.name).join(' + ') || agentName(byId, t.last_agent)
    const st = standing(t)
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
          onContextMenu={(e) => {
            if ((e.target as Element).closest('a[href], input, textarea, select') || e.defaultPrevented) return
            e.preventDefault()
            setFocus(k)
            setMenu({ t, at: { el: e.currentTarget, x: e.clientX, y: e.clientY } })
          }}
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
                {needs ? (
                  <span className="v-last" data-testid="needs-what" title={needsWhat(t)}>
                    needs: {short(needsWhat(t), 120)}
                  </span>
                ) : st ? (
                  <span className="v-last" data-testid="task-standing" data-from={st.from} title={st.text}>
                    {st.from === 'step' ? 'now: ' : ''}
                    {st.text}
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
              <button
                type="button"
                className="v-more"
                data-testid="task-row-more"
                aria-label="Task actions"
                title="Rename, open, done (right-click)"
                onClick={(e) => {
                  e.stopPropagation()
                  setFocus(k)
                  setMenu({ t, at: { el: e.currentTarget } })
                }}
              >
                <IconMore size={14} />
              </button>
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
            J/K move · Space expand · ↵ open · X done
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
            {g.questions.map(qrow)}
            {g.explicit.map((t) => row(t, false, true))}
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
      {menu && (
        <TaskRowMenu
          t={menu.t}
          at={menu.at}
          onClose={() => setMenu(null)}
          onRename={() => onRename?.(menu.t)}
          onOpen={() => nav.task(menu.t.id)}
          onToggleDone={() => setStatus(menu.t, menu.t.status === 'done' ? 'working' : 'done')}
        />
      )}
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

/** The open questions of a message, read-only (the ask in full; they are answered in the task or the stream). */
function AskList({ m }: { m: V3Message }) {
  const qs = openQuestions(m)
  const acts = qs.filter((q) => q.kind === 'action')
  return (
    <>
      <div className="v-sec" style={{ color: 'var(--mb-wait)' }}>
        WAITING ON YOU
      </div>
      <ul className="v-asks" data-testid="ask-list">
        {qs
          .filter((q) => q.kind !== 'action')
          .map((q) => (
            <li key={q.key}>
              {q.prompt.trim() || (q.kind === 'text' ? 'an answer' : 'a choice')}
              {(q.choices?.length ?? 0) > 0 && <span className="v-cnt2"> · {q.choices!.length} choices</span>}
            </li>
          ))}
        {acts.map((q) => (
          <li key={q.key}>☐ {q.prompt.trim() || 'a thing to do'}</li>
        ))}
      </ul>
    </>
  )
}

function AnswerButton({ m }: { m: V3Message }) {
  const nav = useNav()
  return (
    <button type="button" className="v-btn pri sm" data-testid="answer-in-task" onClick={() => openAsk(nav, m)}>
      {m.tasks[0] ? 'Answer in task ↵' : 'Answer ↵'}
    </button>
  )
}

/** A question with no task, expanded in place: the ask, the agent's message, and where to answer it. */
function AskExpanded({ m }: { m: V3Message }) {
  const byId = useSessionsById()
  return (
    <div className="v-detail" data-testid="task-expanded" onClick={(e) => e.stopPropagation()}>
      <div>
        <AskList m={m} />
        <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
          <AnswerButton m={m} />
        </div>
      </div>
      <div>
        <div className="v-sec">FROM {agentName(byId, m.session_id).toUpperCase()}</div>
        {m.body.trim() ? <MessageBodyClamp text={m.body} lines={8} /> : <div className="v-cnt2">No text.</div>}
      </div>
    </div>
  )
}

/** A row expanded in place: checklist (or criteria), last report, facts. With `ask`, the question it waits on first and Answer in task. */
function Expanded({ t, reload, ask }: { t: BoardTask; reload: () => void; ask?: V3Message }) {
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
  const agents = t.agents.map((a) => agentName(byId, a.session_id))
  return (
    <div className="v-detail" data-testid="task-expanded" onClick={(e) => e.stopPropagation()}>
      <div>
        {ask && <AskList m={ask} />}
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
          {ask ? (
            <AnswerButton m={ask} />
          ) : (
            <button type="button" className="v-btn pri sm" data-testid="open-task" onClick={() => nav.task(t.id)}>
              Open {t.kind === 'goal' ? 'goal' : 'task'} ↵
            </button>
          )}
          {t.last_agent && (
            <button type="button" className="v-btn sm" onClick={() => nav.agent(t.last_agent)}>
              Open {agentName(byId, t.last_agent)}
            </button>
          )}
        </div>
      </div>
      <div>
        <div className="v-sec">FACTS</div>
        <dl className="v-facts" data-testid="facts">
          {(t.links ?? []).map((l) => (
            <Fragment key={l.url}>
              <dt>{l.kind === 'pr' ? 'PR' : l.kind || 'Link'}</dt>
              <dd>
                <a href={l.url} target="_blank" rel="noreferrer" className="v-link">
                  {l.label}
                </a>
                {l.state ? ` · ${l.state}` : ''}
              </dd>
            </Fragment>
          ))}
          <dt>Agents</dt>
          <dd>{agents.join(' · ') || '—'}</dd>
          <dt>Status</dt>
          <dd>
            {statusLabel(t)} · {t.status === 'done' ? 'done' : 'last activity'} {agoWords(t.status === 'done' ? t.done_at : t.last_activity)}
          </dd>
        </dl>
      </div>
    </div>
  )
}

function agoWords(iso: string | null | undefined): string {
  const a = ago(iso)
  return a === 'now' ? 'just now' : a ? a + ' ago' : ''
}

export function useBoard(): [Board | null, () => void, (f: (b: Board | null) => Board | null) => void] {
  const { id } = useSelectedProject()
  const [board, setBoard] = useState<Board | null>(null)
  const key = id
  const load = useMemo(() => () => v3.board(key).then(setBoard).catch(() => {}), [key])
  useEffect(() => {
    load()
  }, [load])
  useEffectV3(load)
  return [board, load, setBoard]
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
