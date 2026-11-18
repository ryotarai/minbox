// An agent's stream: "what is this agent doing?" One conversation, oldest to newest, with task chips
// under the messages and the agent's decision under its replies; its tasks, terminal, shell and files
// beside it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment } from '../api'
import { useApp } from '../lib/app'
import { agentKindLabel } from '../lib/agents'
import { IconAgentKind, IconShell } from '../components/icons'
import { TerminalPane } from '../components/TerminalPane'
import { ShellPane } from '../components/ShellPane'
import { FilesPane } from '../components/FilesPane'
import { ago, short, useLive, useMarkRead, v3, STATUS_LABEL, type BoardTask, type Stream, type V3Message } from './data'
import { Bar, Composer, MessageView, StatusDot, TaskChip, agentHint, useNav, useSessionsById, type Outgoing } from './parts'
import { QuoteBubble } from './quote'
import { AgentActions } from './AgentActions'

export type SidePane = 'tasks' | 'terminal' | 'shell' | 'files'

export function StreamView({
  id,
  highlight,
  tasks,
  pane,
  setPane,
  onOpenAttachment,
}: {
  id: string
  highlight: string | null
  tasks: BoardTask[]
  pane: SidePane
  setPane: (p: SidePane) => void
  onOpenAttachment: (a: Attachment, m: V3Message) => void
}) {
  const { error, isPhone, sessions } = useApp()
  const byId = useSessionsById()
  const nav = useNav()
  const sess = byId.get(id)
  const [s, reload] = useLive<Stream>(id, () => v3.stream(id))
  const [older, setOlder] = useState<V3Message[]>([])
  const [pending, setPending] = useState<V3Message[]>([])
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  useEffect(() => {
    setOlder([])
    setPending([])
    atBottom.current = true
  }, [id])
  const msgs = [...older, ...(s?.messages ?? [])]
  const arrived = (p: V3Message) => msgs.some((m) => m.author === 'user' && (m.words ?? m.body) === p.words && new Date(m.created_at).getTime() >= new Date(p.created_at).getTime() - 60_000)
  const shown = [...msgs, ...pending.filter((p) => !arrived(p))]
  useMarkRead(s?.messages)
  // Keep the end in view while new messages arrive (unless the person scrolled up); a highlighted message wins.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || highlight) return
    if (atBottom.current) el.scrollTop = el.scrollHeight
  }, [shown.length, highlight])
  if (!sess) return <div className="v-col"><div className="v-empty">This agent is gone. Pick another one on the left.</div></div>
  const mine = tasks.filter((t) => t.agents.some((a) => a.session_id === id))
  const openTasks = mine.filter((t) => t.status !== 'done')
  const doneTasks = mine.filter((t) => t.status === 'done')
  // What it is on now: the open task of its newest message that is about one.
  const nowOn = [...msgs].reverse().flatMap((m) => m.tasks).map((r) => openTasks.find((t) => t.id === r.task_id)).find((t) => !!t)
  const hint = agentHint(sessions ?? [], sess)
  const send = async (o: Outgoing) => {
    const tmp: V3Message = { id: 'tmp-' + Date.now(), thread_id: '', author: 'user', body: o.words, words: o.words, created_at: new Date().toISOString(), read_at: null, claimed_at: null, delivered_at: null, session_id: id, tasks: [], open: 0, pending: true }
    setPending((p) => [...p, tmp])
    atBottom.current = true
    try {
      await v3.send(id, { words: o.words, task_ids: o.tasks.length ? o.tasks : undefined, uploads: o.uploads.length ? o.uploads : undefined })
      reload()
    } catch (e) {
      setPending((p) => p.filter((x) => x !== tmp))
      error(e)
      throw e
    }
  }
  const loadOlder = () => {
    const first = msgs[0]
    if (!first) return
    v3.stream(id, { before: first.id })
      .then((r) => setOlder((o) => [...r.messages, ...o]))
      .catch(error)
  }
  let day = ''
  let seg = ''
  const terminalish = pane !== 'tasks'
  return (
    <>
      <div className="v-col" data-testid="stream-view" data-session={id}>
        <div className="v-head">
          <div className="v-r1">
            <span className={'v-dot ' + (sess.status === 'working' ? 'd-work v-live' : sess.status === 'ended' ? 'd-done' : 'd-idle')} />
            <h2 data-testid="agent-name">
              {sess.name}
              {hint && <small className="v-hint"> · {hint}</small>}
            </h2>
            <span className="v-hide-phone" style={{ color: 'var(--mb-subtle)', fontSize: 12 }}>
              {agentKindLabel(sess.agent)}
              {sess.is_main ? ' · main' : ''}
              {sess.host_name ? ' · ' + sess.host_name : ''}
            </span>
            <AgentActions session={sess} />
            <button
              type="button"
              className={'v-btn' + (pane === 'terminal' ? ' pri' : '')}
              data-testid="terminal-toggle"
              data-agent={sess.agent || 'claude'}
              aria-pressed={pane === 'terminal'}
              aria-label={`${pane === 'terminal' ? 'Hide' : 'Show'} ${agentKindLabel(sess.agent)} terminal`}
              title={`${pane === 'terminal' ? 'Hide' : 'Show'} the ${agentKindLabel(sess.agent)} terminal`}
              style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}
              onClick={() => setPane(pane === 'terminal' ? 'tasks' : 'terminal')}
            >
              <IconAgentKind kind={sess.agent} size={13} /> Terminal <span className="v-kbd v-hide-phone">T</span>
            </button>
            {sess.kind !== 'shell' && sess.status !== 'ended' && (
              <button
                type="button"
                className={'v-btn' + (pane === 'shell' ? ' pri' : '')}
                data-testid="shell-toggle"
                aria-pressed={pane === 'shell'}
                aria-label={pane === 'shell' ? 'Hide shell' : 'Open shell'}
                title={pane === 'shell' ? 'Hide the shell (Ctrl+`)' : "Open shell: a shell in this agent's folder (Ctrl+`)"}
                style={{ display: 'inline-flex', alignItems: 'center' }}
                onClick={() => setPane(pane === 'shell' ? 'tasks' : 'shell')}
              >
                <IconShell size={13} />
              </button>
            )}
          </div>
          <div className="v-r2">
            <span data-testid="agent-state">{sess.status === 'working' ? 'in a turn' : sess.status === 'ended' ? 'ended' : sess.status === 'starting' ? 'starting' : 'idle'}</span>
            {sess.title && <span className="v-doingnow">· {sess.title}</span>}
            {nowOn && (
              <span className="v-nowon" data-testid="now-on">
                · on <TaskChip task={{ task_id: nowOn.id, title: nowOn.title }} goal={nowOn.kind === 'goal'} />
              </span>
            )}
            {openTasks.length > 1 && <span className="v-hide-phone">· {openTasks.length} open tasks</span>}
          </div>
        </div>
        <div
          className="v-scroll"
          ref={scroller}
          data-quote-box
          data-scroll={'agent-' + id}
          onScroll={(e) => {
            const el = e.currentTarget
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
          }}
        >
          <div className="v-conv">
            {s?.has_more && older.length === 0 && (
              <button type="button" className="v-gap" onClick={loadOlder}>
                <span>
                  <b>show earlier messages</b>
                </span>
              </button>
            )}
            {s && msgs.length === 0 && <div className="v-empty">No messages yet. Say something below: the agent decides whether it is a task.</div>}
            {shown.map((m) => {
              const d = new Date(m.created_at).toDateString()
              const out = []
              if (d !== day) {
                day = d
                out.push(
                  <div key={'d' + m.id} className="v-divider">
                    {d === new Date().toDateString() ? 'Today' : new Date(m.created_at).toLocaleDateString()}
                  </div>,
                )
              }
              const sg = m.segment?.id ?? ''
              if (sg !== seg) {
                seg = sg
                if (m.segment) {
                  out.push(
                    <div key={'s' + m.id} className="v-divider" data-testid="segment-divider">
                      — {short((m.segment.subject || 'earlier conversation').split('\n')[0]!, 70)} —
                    </div>,
                  )
                }
              }
              out.push(<MessageView key={m.id} m={m} tasks={tasks} showAgent={false} unread={m.author === 'agent' && !m.read_at} highlight={highlight === m.id} onOpenAttachment={onOpenAttachment} onChanged={reload} />)
              return out
            })}
            {sess.status === 'working' && <div className="v-typing">{sess.name} is working…</div>}
          </div>
        </div>
        <Composer toId={id} toOptions={[sess]} about={[]} tasks={tasks} draftKey={'v3:agent:' + id} placeholder={`Message ${sess.name}…`} onSend={send} />
        <QuoteBubble box={scroller} />
      </div>
      {(!isPhone || terminalish) && (
        <aside className={'v-side' + (terminalish ? ' wide' : '')} data-testid="agent-side">
          <div className="v-tabs2">
            {(['tasks', 'terminal', 'shell', 'files'] as const).map((p) => (
              <button type="button" key={p} className={pane === p ? 'on' : ''} data-testid={'pane-' + p} onClick={() => setPane(p)} disabled={(p === 'shell' || p === 'terminal') && sess.kind === 'shell' && p === 'shell'}>
                {p === 'tasks' ? 'Tasks' : p === 'terminal' ? 'Terminal' : p === 'shell' ? 'Shell' : 'Files'}
              </button>
            ))}
          </div>
          {pane === 'tasks' && (
            <div style={{ padding: '0 16px 16px', overflow: 'auto' }}>
              <div className="v-sec">
                OPEN TASKS <span className="v-x">{openTasks.length}</span>
              </div>
              {openTasks.map((t) => (
                <button type="button" key={t.id} className="v-mt" onClick={() => nav.task(t.id)}>
                  <div className="v-a">
                    <StatusDot t={t} />
                    {t.kind === 'goal' ? '◎ ' : ''}
                    {t.title}
                  </div>
                  <div className="v-b">
                    <Bar t={t} />
                    <span className="v-cnt2">
                      {STATUS_LABEL[t.status]}
                      {t.open_questions ? ' · ? ' + t.open_questions : ''} · {ago(t.last_activity)}
                    </span>
                  </div>
                </button>
              ))}
              {!openTasks.length && <div className="v-cnt2">No open tasks. Ask for something; the agent makes a task when it is new work.</div>}
              {doneTasks.length > 0 && (
                <details className="v-donelist">
                  <summary className="v-sec">DONE THIS WEEK <span className="v-x">{doneTasks.length}</span></summary>
                  {doneTasks.map((t) => (
                    <button type="button" key={t.id} className="v-mt" onClick={() => nav.task(t.id)}>
                      <div className="v-a">
                        <StatusDot t={t} />
                        {t.title}
                      </div>
                    </button>
                  ))}
                </details>
              )}
              <div className="v-sec">AGENT</div>
              <dl className="v-facts">
                <dt>Kind</dt>
                <dd>{agentKindLabel(sess.agent)}</dd>
                <dt>Folder</dt>
                <dd className="font-mono" title={sess.cwd}>
                  {sess.cwd}
                </dd>
                <dt>Started</dt>
                <dd>{sess.created_at ? new Date(sess.created_at).toLocaleDateString() : '—'}</dd>
              </dl>
            </div>
          )}
          {pane === 'terminal' && (
            <div style={{ flex: 1, minHeight: isPhone ? 420 : 0 }}>
              <TerminalPane session={sess} onClose={() => setPane('tasks')} />
            </div>
          )}
          {pane === 'shell' && (
            <div style={{ flex: 1, minHeight: isPhone ? 420 : 0 }}>
              <ShellPane session={sess} onClose={() => setPane('tasks')} />
            </div>
          )}
          {pane === 'files' && s?.stream_thread_id && (
            <div style={{ flex: 1, minHeight: isPhone ? 420 : 0, overflow: 'hidden' }}>
              <FilesPane session={sess} threadId={s.stream_thread_id} onClose={() => setPane('tasks')} />
            </div>
          )}
        </aside>
      )}
    </>
  )
}
