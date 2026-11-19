// The Board (home): "what needs me, and what is moving?" NEEDS YOU first (the tasks and goals set to
// needs you: their status decides, an open question alone never puts anything there), then GOALS with
// their tasks, WORKING (active in the last 3 days), BLOCKED, and, folded, QUIET (open but quiet longer)
// and DONE (the last 2 days). Questions are answered where they were asked (the task, the agent's stream).
import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../lib/app'
import { useSelectedProject } from '../lib/projects'
import { ago, short, standing, unreadCls, v3, type Board, type BoardTask } from './data'
import { TaskRowMenu } from './RenameTask'
import { IconGoal, IconMore, IconPlus } from '../components/icons'
import { type MenuAt } from '../components/ui'
import { Bar, StatusDot, agentName, useNav, useSessionsById } from './parts'

export type BoardFocus = { key: string | null }

const QUIET_AFTER = 3 * 24 * 3600 * 1000
const DONE_WINDOW = 2 * 24 * 3600 * 1000

export function boardKeys(b: Board | null, showDone: boolean, showQuiet = false): string[] {
  if (!b) return []
  const g = groups(b)
  return [
    ...g.explicit.map((t) => 't:' + t.id),
    ...g.goals.flatMap((t) => ['t:' + t.id, ...g.childrenOf(t.id).map((c) => 't:' + c.id)]),
    ...g.working.map((t) => 't:' + t.id),
    ...g.blocked.map((t) => 't:' + t.id),
    ...(showQuiet ? g.quiet.map((t) => 't:' + t.id) : []),
    ...(showDone ? g.done.map((t) => 't:' + t.id) : []),
  ]
}

/** What NEEDS YOU counts: its rows (tasks and goals set to needs you), the very entries it shows (the Board's header, the sidebar badge, the tab title). */
export function needsCount(b: Board | null): number {
  if (!b) return 0
  return groups(b).explicit.length
}

/** What a task set to needs you waits on: where it stands (summary, else report, else
 *  the agent's latest line about it; see standing), never its step. */
export function needsWhat(t: BoardTask): string {
  const s = standing(t)
  return s && s.from !== 'step' ? s.text : 'Set to needs you — open it to see what it waits on'
}

export function groups(b: Board) {
  const open = b.tasks.filter((t) => t.status !== 'done')
  const goals = open.filter((t) => t.kind === 'goal')
  const goalIds = new Set(goals.map((g) => g.id))
  const loose = open.filter((t) => t.kind !== 'goal' && !(t.parent_id && goalIds.has(t.parent_id)))
  const byActivity = (a: BoardTask, z: BoardTask) => (a.last_activity < z.last_activity ? 1 : -1)
  const quietNow = (t: BoardTask) => Date.now() - new Date(t.last_activity).getTime() > QUIET_AFTER
  // Set to needs you (by the agent or the person): a row in NEEDS YOU. Open questions do not count: a
  // task with one stays in its group below, with "? n" on its row.
  const explicit = open.filter((t) => t.status === 'needs_you' && !(t.parent_id && goalIds.has(t.parent_id))).sort(byActivity)
  const rest = loose.filter((t) => !explicit.includes(t))
  return {
    explicit,
    // A goal set to needs you is a row in NEEDS YOU (with its tasks), not again in GOALS.
    goals: goals.filter((t) => !explicit.includes(t)).sort(byActivity),
    childrenOf: (id: string) => open.filter((t) => t.parent_id === id && t.kind !== 'goal').sort(byActivity),
    working: rest.filter((t) => t.status === 'working' && !quietNow(t)).sort(byActivity),
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
  showDone,
  setShowDone,
  showQuiet,
  setShowQuiet,
  onRename,
}: {
  board: Board | null
  reload: () => void
  focus: string | null
  setFocus: (k: string | null) => void
  showDone: boolean
  setShowDone: (v: boolean) => void
  showQuiet: boolean
  setShowQuiet: (v: boolean) => void
  /** Rename a task (its row menu): the dialog is the app's, as for E / F2 on the focused row. */
  onRename?: (t: BoardTask) => void
}) {
  const { setOverlay, error, toast } = useApp()
  const { project } = useSelectedProject()
  const byId = useSessionsById()
  const nav = useNav()
  const [dropping, setDropping] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ t: BoardTask; at: MenuAt } | null>(null)
  if (!board) return <div className="v-col"><div className="v-empty">Loading…</div></div>
  const g = groups(board)
  const needsN = needsCount(board)
  const openN = board.tasks.filter((t) => t.status !== 'done').length

  const setStatus = (t: BoardTask, status: BoardTask['status']) => {
    v3.patchTask(t.id, { status }).then(reload).catch(error)
  }
  const row = (t: BoardTask, child = false, needs = false) => {
    const k = 't:' + t.id
    const agents = t.agents.map((a) => byId.get(a.session_id)).filter((s): s is NonNullable<typeof s> => !!s)
    const who = agents.map((a) => a.name).join(' + ') || agentName(byId, t.last_agent)
    const st = standing(t)
    const live = agents.some((a) => a.status === 'working')
    const kids = t.kind === 'goal' ? g.childrenOf(t.id) : []
    const pr = t.links?.find((l) => l.kind === 'pr') ?? t.links?.[0]
    return (
      <div key={t.id}>
        <div
          className={'v-row' + (focus === k ? ' focus' : '') + (child ? ' child' : '')}
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
              nav.task(t.id)
            }}
          >
            <div>
              <div className="v-ti">
                <StatusDot t={t} live={live} />
                <span className={'v-t' + unreadCls(t)} data-unread={(t.unread ?? 0) > 0 || undefined}>
                  {t.kind === 'goal' && <IconGoal size={14} className="v-goal" style={{ color: 'var(--mb-purple)' }} />}
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
            <IconPlus size={14} /> New message <span className="v-kbd v-hide-phone">⇧N</span>
          </button>
          <button type="button" className="v-btn" data-testid="new-goal" title="A goal: an outcome an agent keeps working toward until its criteria are met" onClick={() => setOverlay({ kind: 'v3-new', mode: 'goal' } as never)}>
            <IconGoal size={14} /> New goal
          </button>
        </div>
        <div className="v-r2 v-sum">
          {project?.name ?? 'All projects'} · <b data-testid="needs-count" style={needsN ? undefined : { color: 'inherit', fontWeight: 400 }}>{needsN} need you</b> · {g.working.length} working{g.blocked.length ? ` · ${g.blocked.length} blocked` : ''} · {openN} open
          <span className="v-hide-phone" style={{ marginLeft: 'auto' }}>
            J/K move · ↵ open · X done
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
          onMakeGoal={() =>
            v3
              .patchTask(menu.t.id, { kind: 'goal' })
              .then(() => {
                toast('Made it a goal · add its criteria on the goal')
                reload()
              })
              .catch(error)
          }
        />
      )}
    </div>
  )
}

/** A goal's autonomous run: its state and Start / Pause / Stop. */
export function GoalRun({ t, reload }: { t: BoardTask; reload: () => void }) {
  const { error } = useApp()
  const run = t.auto?.state ?? ''
  // Why it paused or stopped, as the server says it ("continued 5 times in 2 minutes").
  const why = t.auto?.reason_text || t.auto?.reason || ''
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
      {run === 'paused' && !why && <span className="v-pill pause">paused</span>}
      {(run === 'paused' || run === 'stopped') && why && (
        <span className={run === 'paused' ? 'v-pill pause v-run-reason' : 'v-run-reason'} data-testid="goal-reason" data-reason={t.auto.reason ?? ''} title={why}>
          {run === 'paused' ? 'Paused' : 'Stopped'}: {why}
        </span>
      )}
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
