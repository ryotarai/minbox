// An agent's stream: "what is this agent doing?" One conversation, oldest to newest, with task chips
// under the messages and the agent's decision under its replies; its tasks, terminal, shell and files
// beside it.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment } from '../api'
import { useApp } from '../lib/app'
import { agentKindLabel } from '../lib/agents'
import { IconAgentKind, IconBack, IconShell } from '../components/icons'
import { TerminalPane } from '../components/TerminalPane'
import { ShellPane } from '../components/ShellPane'
import { FilesPane } from '../components/FilesPane'
import { ago, short, standing, useLive, useMarkRead, v3, STATUS_LABEL, type BoardTask, type Stream, type V3Message } from './data'
import { BackButton, Bar, MessageView, StatusDot, TaskChip, agentHint, useNav, useSessionsById } from './parts'
import { Composer, type Outgoing } from './Composer'
import { CompactRow, NewPill, markUnreadFrom, useConversationKeys, useFirstNew, useFollow, useKeepPosition } from './conversation'
import { QuoteBubble } from './quote'
import { api } from '../api'
import { getReplyDraft } from '../lib/drafts'
import { threadArtifacts } from '../lib/attachments'
import { DeliveryLine, ForkMarker, ThreadNotices, useThread } from '../components/ThreadView'
import { ThreadMoreMenu } from '../components/ThreadMenu'
import { LinearBar, LinearEventItem, groupLinearEvents } from '../components/LinearBar'
import { useHotkeys } from '../lib/hotkeys'
import { LinearLinkButton } from '../components/LinearLink'
import { ArtifactsGrid } from '../components/AttachmentTiles'
import { IconFold, IconGrid, IconMore, IconUnfold } from '../components/icons'
import { AgentActions } from './AgentActions'

export type SidePane = 'tasks' | 'terminal' | 'shell' | 'files'

export function StreamView({
  id,
  highlight,
  tasks,
  pane,
  setPane,
  sheet = false,
  onOpenAttachment,
}: {
  id: string
  highlight: string | null
  tasks: BoardTask[]
  pane: SidePane
  setPane: (p: SidePane) => void
  /** Phone: the side pane as a full-screen sheet (its Tasks tab first). */
  sheet?: boolean
  onOpenAttachment: (a: Attachment, m: V3Message) => void
}) {
  const { error, isPhone, sessions, toast, route, navigate, goBack } = useApp()
  const byId = useSessionsById()
  const nav = useNav()
  const sess = byId.get(id)
  const [s, reload] = useLive<Stream>(id, () => v3.stream(id))
  const [thread] = useThread(s?.stream_thread_id || null)
  const [older, setOlder] = useState<V3Message[]>([])
  const [olderMore, setOlderMore] = useState(true)
  const [pending, setPending] = useState<V3Message[]>([])
  const [foldAll, setFoldAll] = useState(false)
  const [showArtifacts, setShowArtifacts] = useState(false)
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const loadingOlder = useRef(false)
  useEffect(() => {
    setOlder([])
    setOlderMore(true)
    setPending([])
    setFoldAll(false)
    setShowArtifacts(false)
  }, [id])
  const msgs = [...older, ...(s?.messages ?? [])]
  const arrived = (p: V3Message) => msgs.some((m) => m.author === 'user' && (m.words ?? m.body) === p.words && new Date(m.created_at).getTime() >= new Date(p.created_at).getTime() - 60_000)
  const shown = [...msgs, ...pending.filter((p) => !arrived(p))]
  useMarkRead(s?.messages)
  const firstNew = useFirstNew(id, s?.messages)
  const keep = useKeepPosition(scroller)
  const follow = useFollow(scroller, id, s ? shown : [], !!highlight || keep.pending())
  // Opening at the first message not yet read ("New"), else at the end.
  const landed = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!s || landed.current === id || highlight) return
    landed.current = id
    const box = scroller.current
    const el = box?.querySelector('[data-new-divider]')
    if (el && box) {
      el.scrollIntoView({ block: 'start' })
      follow.atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60
    }
  })
  // Older messages arrive above: what the person reads stays where it is.
  useLayoutEffect(() => keep.after(), [older.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const files = threadArtifacts(msgs)
  useConversationKeys(scroller, msgs, onOpenAttachment)
  // E: mark the conversation read (it moves to Quiet; its questions close), back to the Board.
  useHotkeys(
    {
      e: () => {
        const th = s?.stream_thread_id
        if (!th) return false
        api
          .markRead(th)
          .then(() => {
            toast('Marked read', { action: 'Move back', undo: true, onAction: () => api.unmarkRead(th).catch(error) })
            nav.board()
          })
          .catch(error)
      },
    },
    !route.f,
  )
  if (!sess)
    return (
      <div className="v-col">
        <div className="v-head">
          <div className="v-r1">
            <BackButton tasks={tasks} />
          </div>
        </div>
        <div className="v-empty">This agent is gone. Pick another one on the left.</div>
      </div>
    )
  const mine = tasks.filter((t) => t.agents.some((a) => a.session_id === id))
  const openTasks = mine.filter((t) => t.status !== 'done')
  const doneTasks = mine.filter((t) => t.status === 'done')
  // What it is on now: the open task of its newest message that is about one.
  const nowOn = [...msgs].reverse().flatMap((m) => m.tasks).map((r) => openTasks.find((t) => t.id === r.task_id)).find((t) => !!t)
  const hint = agentHint(sessions ?? [], sess)
  const draftKey = 'v3:agent:' + id
  const send = async (o: Outgoing) => {
    const tmp: V3Message = { id: 'tmp-' + Date.now(), thread_id: '', author: 'user', body: o.words, words: o.words, created_at: new Date().toISOString(), read_at: null, claimed_at: null, delivered_at: null, session_id: id, tasks: [], open: 0, pending: true }
    if (!o.forward_to && o.words) setPending((p) => [...p, tmp])
    follow.atBottom.current = true
    try {
      const { to: _to, tasks: tids, ...rest } = o
      void _to
      await v3.send(id, { ...rest, task_ids: tids.length ? tids : undefined, uploads: o.uploads.length ? o.uploads : undefined })
      reload()
      // The server has it now: the stand-in goes once the reload shows it (or the message was cancelled).
      setTimeout(() => setPending((p) => p.filter((x) => x !== tmp)), 1500)
    } catch (e) {
      setPending((p) => p.filter((x) => x !== tmp))
      error(e)
      throw e
    }
  }
  const hasMore = older.length ? olderMore : !!s?.has_more
  const loadOlder = () => {
    const first = msgs[0]
    if (!first || loadingOlder.current) return
    loadingOlder.current = true
    v3.stream(id, { before: first.id })
      .then((r) => {
        keep.before()
        setOlderMore(r.has_more)
        setOlder((o) => [...r.messages, ...o])
      })
      .catch(error)
      .finally(() => (loadingOlder.current = false))
  }
  const markUnread = (m: V3Message) =>
    markUnreadFrom(msgs, m)
      .then(() => {
        toast('Marked unread')
        nav.board()
      })
      .catch(error)
  const archive = () => {
    if (!thread) return
    api
      .archiveThread(thread.id)
      .then(() => toast('Archived this conversation', { action: 'Undo', undo: true, onAction: () => api.unarchiveThread(thread.id).catch(error) }))
      .catch(error)
  }
  const lastUser = [...msgs].reverse().find((m) => m.author === 'user' && m.kind !== 'note' && m.kind !== 'command')
  const openQs = (s?.messages ?? []).reduce((n, m) => n + m.open, 0)
  // The Linear issue's comments and changes between the messages (by time).
  const linearEv = groupLinearEvents(shown, thread?.linear_events)
  let day = ''
  let seg = ''
  const terminalish = pane !== 'tasks'
  return (
    <>
      <div className="v-col" data-testid="stream-view" data-session={id}>
        <div className="v-head">
          <div className="v-r1">
            <BackButton tasks={tasks} />
            <span className={'v-dot ' + (sess.status === 'working' ? 'd-work v-live' : sess.status === 'ended' ? 'd-done' : 'd-idle')} />
            <h2 data-testid="agent-name">
              {sess.name}
              {hint && <small className="v-hint"> · {hint}</small>}
            </h2>
            <span className="v-hide-phone v-kind" style={{ color: 'var(--mb-subtle)', fontSize: 12 }} title={[agentKindLabel(sess.agent), sess.is_main ? 'main' : '', sess.host_name].filter(Boolean).join(' · ')}>
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
            {isPhone && (
              <button type="button" className="v-chip v-sheetbtn" data-testid="agent-sheet-open" aria-label={`Tasks (${openTasks.length} open), terminal, shell and files`} onClick={() => navigate({ tab: 'tasks' }, { push: true })}>
                Tasks <b>{openTasks.length}</b> ›
              </button>
            )}
          </div>
        </div>
        <div className="v-convwrap">
          <NewPill n={follow.unseen} onClick={follow.toBottom} />
          <div
            className="v-scroll"
            ref={scroller}
            data-quote-box
            data-scroll={'agent-' + id}
            onScroll={(e) => {
              follow.onScroll()
              if (e.currentTarget.scrollTop < 80 && hasMore && s) loadOlder()
            }}
          >
            <div className="v-conv">
              <div className="v-convbar" data-testid="conv-bar">
                {thread && <LinearLinkButton thread={thread} />}
                <span className="v-sp" />
                {files.length > 0 && (
                  <button type="button" className="v-iconbtn" data-testid="artifacts-button" aria-pressed={showArtifacts} aria-label={`Artifacts, ${files.length}`} title={showArtifacts ? 'Back to the conversation' : `Artifacts (${files.length}): every file of this conversation`} onClick={() => setShowArtifacts(!showArtifacts)}>
                    <IconGrid size={14} /> {files.length}
                  </button>
                )}
                <button type="button" className="v-iconbtn" data-testid="fold-all" aria-pressed={foldAll} aria-label={foldAll ? 'Unfold all' : 'Fold all'} title={foldAll ? 'Unfold all' : 'Fold all'} onClick={() => setFoldAll(!foldAll)}>
                  {foldAll ? <IconUnfold size={14} /> : <IconFold size={14} />}
                </button>
                {thread && (
                  <button type="button" className="v-iconbtn" data-testid="thread-more" aria-label="Conversation actions" title="Snooze, pin, mark, archive…" onClick={(e) => setMoreAnchor(e.currentTarget)}>
                    <IconMore size={14} />
                  </button>
                )}
              </div>
              {thread && <LinearBar thread={thread} phone={isPhone} />}
              {thread && <ThreadNotices thread={thread} target={null} />}
              {thread && <ThreadMoreMenu thread={thread} anchor={moreAnchor} onClose={() => setMoreAnchor(null)} onArchive={archive} onBack={nav.board} openQuestions={openQs} onShell={sess.kind !== 'shell' && sess.status !== 'ended' ? () => setPane('shell') : undefined} />}
              {showArtifacts && (
                <ArtifactsGrid
                  messages={msgs}
                  annotations={getReplyDraft(draftKey).annotations}
                  sessionName={sess.name}
                  onOpen={(a) => {
                    setShowArtifacts(false)
                    const m = msgs.find((x) => (x.attachments ?? []).some((y) => y.id === a.id))
                    if (m) onOpenAttachment(a, m)
                  }}
                />
              )}
              {!showArtifacts && hasMore && (
                <button type="button" className="v-gap" data-testid="earlier" onClick={loadOlder}>
                  <span>
                    <b>show earlier messages</b>
                  </span>
                </button>
              )}
              {s && msgs.length === 0 && <div className="v-empty">No messages yet. Say something below: the agent decides whether it is a task.</div>}
              {!showArtifacts &&
                shown.map((m, i) => {
                  const d = new Date(m.created_at).toDateString()
                  const out = []
                  for (const ev of linearEv.before.get(m.id) ?? []) out.push(<LinearEventItem key={'l' + ev.id} ev={ev} identifier={thread?.linear?.identifier ?? ''} />)
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
                  if (m.id === firstNew && !foldAll) {
                    out.push(
                      <div key={'n' + m.id} className="v-new" data-new-divider data-testid="new-divider">
                        New
                      </div>,
                    )
                  }
                  if (foldAll && i < shown.length - 1) out.push(<CompactRow key={m.id} m={m} name={sess.name} onClick={() => setFoldAll(false)} />)
                  else out.push(<MessageView key={m.id} m={m} tasks={tasks} showAgent={false} unread={m.author === 'agent' && !m.read_at} highlight={highlight === m.id} onOpenAttachment={onOpenAttachment} onChanged={reload} onUnread={markUnread} />)
                  if (m === lastUser && !m.pending)
                    out.push(
                      <div key={'dl' + m.id} className="v-delivery">
                        <DeliveryLine m={m} session={sess} draftKey={draftKey} />
                      </div>,
                    )
                  for (const f of (thread?.forks ?? []).filter((f) => f.from_message_id === m.id)) out.push(<ForkMarker key={'f' + f.thread_id} f={f} />)
                  return <Fragment key={m.id}>{out}</Fragment>
                })}
              {!showArtifacts && linearEv.tail.map((ev) => <LinearEventItem key={'l' + ev.id} ev={ev} identifier={thread?.linear?.identifier ?? ''} />)}
              {sess.status === 'working' && <div className="v-typing">{sess.name} is working…</div>}
            </div>
          </div>
        </div>
        <Composer
          toId={id}
          toOptions={[sess]}
          about={[]}
          tasks={tasks}
          draftKey={draftKey}
          placeholder={`Message ${sess.name}… (R)`}
          onSend={send}
          messages={msgs}
          annotationKeys={[...new Set(msgs.map((m) => m.thread_id))]}
          helpThread={s?.stream_thread_id || undefined}
        />
        <QuoteBubble box={scroller} />
      </div>
      {(!isPhone || terminalish || sheet) && (
        <aside className={'v-side' + (terminalish || sheet ? ' wide' : '')} data-testid="agent-side" data-sheet={sheet || undefined}>
          <div className="v-tabs2">
            {sheet && (
              <button type="button" className="v-sheetx" data-testid="agent-sheet-close" aria-label={`Back to ${sess.name}`} title="Back to the stream" onClick={() => (setPane('tasks'), goBack({ tab: 'inbox' }))}>
                <IconBack size={18} />
              </button>
            )}
            {(['tasks', 'terminal', 'shell', 'files'] as const).map((p) => (
              <button type="button" key={p} className={pane === p ? 'on' : ''} data-testid={'pane-' + p} onClick={() => (setPane(p), isPhone && p === 'tasks' && !sheet ? navigate({ tab: 'tasks' }, { push: true }) : undefined)} disabled={(p === 'shell' || p === 'terminal') && sess.kind === 'shell' && p === 'shell'}>
                {p === 'tasks' ? 'Tasks' : p === 'terminal' ? 'Terminal' : p === 'shell' ? 'Shell' : 'Files'}
              </button>
            ))}
          </div>
          {pane === 'tasks' && (
            <div style={{ padding: '0 16px 16px', overflow: 'auto' }} data-testid="agent-tasks">
              <div className="v-sec">
                OPEN TASKS <span className="v-x">{openTasks.length}</span>
              </div>
              {openTasks.map((t) => (
                <button type="button" key={t.id} className="v-mt" data-testid="agent-task" data-task={t.id} onClick={() => nav.task(t.id)}>
                  <div className="v-a">
                    <StatusDot t={t} />
                    {t.kind === 'goal' ? '◎ ' : ''}
                    {t.title}
                  </div>
                  <TaskSubtitle t={t} />
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
                    <button type="button" key={t.id} className="v-mt" data-testid="agent-task" data-task={t.id} onClick={() => nav.task(t.id)}>
                      <div className="v-a">
                        <StatusDot t={t} />
                        {t.title}
                      </div>
                      <TaskSubtitle t={t} />
                    </button>
                  ))}
                </details>
              )}
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
          {pane === 'files' && s && (
            <div style={{ flex: 1, minHeight: isPhone ? 420 : 0, overflow: 'hidden' }}>
              <FilesPane session={sess} threadId={s.stream_thread_id} draftKey={draftKey} onClose={() => setPane('tasks')} />
            </div>
          )}
        </aside>
      )}
    </>
  )
}

/** A task's subtitle in the agent's Tasks list: where it stands, in a line or two (see standing). */
function TaskSubtitle({ t }: { t: BoardTask }) {
  const st = standing(t)
  if (!st) return null
  return (
    <div className="v-mt-sub" data-testid="task-standing" data-from={st.from} title={st.text}>
      {st.from === 'step' ? 'now: ' : ''}
      {st.text}
    </div>
  )
}
