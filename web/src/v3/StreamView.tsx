// An agent's stream: "what is this agent doing?" One conversation, oldest to newest; each message
// shows its task as a badge in its box (dimmed when the one before is in the same task), with the
// agent's decision beside it; its terminal, shell and files beside it, each shown or hidden on its own
// (side by side on a desktop: stream | terminal | shell | files). Its tasks have a pane of their own
// before it (see TasksPane); on a phone they are the first tab of the agent's sheet.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment } from '../api'
import { useApp } from '../lib/app'
import { agentKindLabel } from '../lib/agents'
import { IconAgentKind, IconBack, IconChevronRight, IconFiles, IconShell } from '../components/icons'
import { TerminalPane } from '../components/TerminalPane'
import { ShellPane } from '../components/ShellPane'
import { FilesPane } from '../components/FilesPane'
import { short, useLive, useMarkRead, v3, type BoardTask, type Stream, type V3Message } from './data'
import { BackButton, MessageView, agentHint, answersNearQuestions, msgTask, useNav, useSessionsById } from './parts'
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
import { AgentTaskList, agentTasks } from './AgentTasks'
import { AgentColumns, useColumnPick } from './Columns'
import { TaskView } from './TaskView'
import { StreamTaskEventLine, groupTaskEvents, type StreamTaskEvent } from './StreamEvents'
import { Resizer, type PaneKind, type SidePane } from './layout'

/** The agent's side panes as V3App fits them: the ones showing (in order) and their widths, and the
 *  actions on them (see useSidePanes). */
export type SideCtl = {
  shown: PaneKind[]
  widths: Partial<Record<PaneKind, number>>
  toggle: (p: PaneKind) => void
  show: (p: PaneKind) => void
  close: (p: PaneKind) => void
  only: (p: SidePane) => void
  drag: (p: PaneKind) => (dx: number, start: number) => void
}

export function StreamView({
  id,
  highlight,
  tasks,
  side,
  narrow = false,
  sheet = false,
  onOpenAttachment,
}: {
  id: string
  highlight: string | null
  tasks: BoardTask[]
  side: SideCtl
  /** The stream is narrow beside its side panes: its header keeps to the buttons' icons. */
  narrow?: boolean
  /** Phone: the side pane as a full-screen sheet (its Tasks tab first). */
  sheet?: boolean
  onOpenAttachment: (a: Attachment, m: V3Message) => void
}) {
  const { error, isPhone, sessions, toast, route, navigate, goBack } = useApp()
  // The tasks checked in the Tasks pane: shown side by side in place of the stream (not on a phone).
  const mine = agentTasks(tasks, id)
  const pick = useColumnPick(id, [...mine.open, ...mine.done])
  // A task picked by its title in the Tasks pane, or opened from anywhere else (#v=agent&s=…&k=…): that
  // one task in place of the stream, before the checked columns (on a phone too).
  const detail = route.view === 'agent' && route.k ? route.k : null
  const cols = !isPhone && pick.columns && !detail
  const byId = useSessionsById()
  const nav = useNav()
  const sess = byId.get(id)
  const [s, reload] = useLive<Stream>(id, () => v3.stream(id))
  const [thread] = useThread(s?.stream_thread_id || null)
  const [older, setOlder] = useState<V3Message[]>([])
  const [olderMore, setOlderMore] = useState(true)
  const [olderEv, setOlderEv] = useState<StreamTaskEvent[]>([])
  const [pending, setPending] = useState<V3Message[]>([])
  const [foldAll, setFoldAll] = useState(false)
  const [showArtifacts, setShowArtifacts] = useState(false)
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const loadingOlder = useRef(false)
  useEffect(() => {
    setOlder([])
    setOlderEv([])
    setOlderMore(true)
    setPending([])
    setFoldAll(false)
    setShowArtifacts(false)
  }, [id])
  const msgs = [...older, ...(s?.messages ?? [])]
  const arrived = (p: V3Message) => msgs.some((m) => m.author === 'user' && (m.words ?? m.body) === p.words && new Date(m.created_at).getTime() >= new Date(p.created_at).getTime() - 60_000)
  const shown = [...msgs, ...pending.filter((p) => !arrived(p))]
  const nearQ = answersNearQuestions(foldAll ? [] : shown)
  useMarkRead(s?.messages, !cols && !detail)
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
  const streamShown = !cols && !detail
  useConversationKeys(scroller, msgs, onOpenAttachment, streamShown)
  // Back from the columns or a task: the stream at its newest message.
  const wasShown = useRef(streamShown)
  useLayoutEffect(() => {
    if (!wasShown.current && streamShown && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight
      follow.atBottom.current = true
    }
    wasShown.current = streamShown
  })
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
  const openTasks = agentTasks(tasks, id).open
  const state = sess.status === 'working' ? 'in a turn' : sess.status === 'ended' ? 'ended' : sess.status === 'starting' ? 'starting' : 'idle'
  const hint = agentHint(sessions ?? [], sess)
  const draftKey = 'v3:agent:' + id
  const send = async (o: Outgoing) => {
    const tmp: V3Message = { id: 'tmp-' + Date.now(), thread_id: '', author: 'user', body: o.words, words: o.words, created_at: new Date().toISOString(), read_at: null, claimed_at: null, delivered_at: null, session_id: id, tasks: [], open: 0, pending: true }
    if (!o.forward_to && o.words) setPending((p) => [...p, tmp])
    follow.atBottom.current = true
    try {
      const { to: _to, tasks: tids, ...rest } = o
      void _to
      await v3.send(id, { ...rest, task_id: tids[0], uploads: o.uploads.length ? o.uploads : undefined })
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
        setOlderEv((e) => [...(r.task_events ?? []), ...e])
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
  const lastUser = [...msgs].reverse().find((m) => m.author === 'user' && m.kind !== 'note' && m.kind !== 'command' && m.kind !== 'run_result')
  const openQs = (s?.messages ?? []).reduce((n, m) => n + m.open, 0)
  // The Linear issue's comments and changes between the messages (by time).
  const linearEv = groupLinearEvents(shown, thread?.linear_events)
  // The tasks' status changes (and creations, renames) between the messages (by time).
  const taskEv = groupTaskEvents(shown, [...olderEv, ...(s?.task_events ?? [])])
  let day = ''
  let seg = ''
  let run = '' // the task of the run of messages so far: a badge repeating it is dimmed
  const on = (p: PaneKind) => side.shown.includes(p)
  // Phone: one pane at a time, full screen (the sheet's tab): 'tasks' when none.
  const pane = (side.shown[0] ?? 'tasks') as SidePane
  return (
    <>
      <div className={'v-col' + (narrow ? ' v-narrow' : '')} data-testid="stream-view" data-session={id} data-columns={cols || undefined} data-detail={detail ?? undefined}>
        <div className="v-head">
          <div className="v-r1">
            <BackButton tasks={tasks} fallback={detail ? { k: null } : undefined} />
            <span className={'v-dot ' + (sess.status === 'working' ? 'd-work v-live' : sess.status === 'ended' ? 'd-done' : 'd-idle')} data-testid="agent-state" data-state={state} title={state} aria-label={state} role="img" />
            <h2 data-testid="agent-name" className="v-tline" title={sess.title || undefined}>
              <span>{sess.name}</span>
              {hint && <small className="v-hint">· {hint}</small>}
            </h2>
            <span className="v-hide-phone v-kind" style={{ color: 'var(--mb-subtle)', fontSize: 12 }} title={[agentKindLabel(sess.agent), sess.host_name].filter(Boolean).join(' · ')}>
              {agentKindLabel(sess.agent)}
              {sess.host_name ? ' · ' + sess.host_name : ''}
            </span>
            <AgentActions session={sess} />
            {isPhone && (
              <button type="button" className="v-chip v-sheetbtn" data-testid="agent-sheet-open" aria-label={`Tasks (${openTasks.length} open), terminal, shell and files`} onClick={() => navigate({ tab: 'tasks' }, { push: true })}>
                Tasks <b>{openTasks.length}</b> <IconChevronRight size={12} />
              </button>
            )}
            <button
              type="button"
              className={'v-btn' + (on('terminal') ? ' pri' : '')}
              data-testid="terminal-toggle"
              data-agent={sess.agent || 'claude'}
              aria-pressed={on('terminal')}
              aria-label={`${on('terminal') ? 'Hide' : 'Show'} ${agentKindLabel(sess.agent)} terminal`}
              title={`${on('terminal') ? 'Hide' : 'Show'} the ${agentKindLabel(sess.agent)} terminal (T)`}
              style={{ display: 'inline-flex', alignItems: 'center' }}
              onClick={() => side.toggle('terminal')}
            >
              <IconAgentKind kind={sess.agent} size={14} />
            </button>
            {sess.kind !== 'shell' && sess.status !== 'ended' && (
              <button
                type="button"
                className={'v-btn' + (on('shell') ? ' pri' : '')}
                data-testid="shell-toggle"
                aria-pressed={on('shell')}
                aria-label={on('shell') ? 'Hide shell' : 'Open shell'}
                title={on('shell') ? 'Hide the shell (Ctrl+`)' : "Open shell: a shell in this agent's folder (Ctrl+`)"}
                style={{ display: 'inline-flex', alignItems: 'center' }}
                onClick={() => side.toggle('shell')}
              >
                <IconShell size={14} />
              </button>
            )}
            <button
              type="button"
              className={'v-btn v-hide-phone' + (on('files') ? ' pri' : '')}
              data-testid="files-toggle"
              aria-pressed={on('files')}
              aria-label={on('files') ? 'Hide files' : 'Show files'}
              title={on('files') ? 'Hide the files (⇧F)' : "Files: the agent's folder as a tree (⇧F)"}
              style={{ display: 'inline-flex', alignItems: 'center' }}
              onClick={() => side.toggle('files')}
            >
              <IconFiles size={14} />
            </button>
          </div>
        </div>
        {detail ? (
          <div className="v-colsone" data-testid="agent-task-detail">
            <div className="v-colcell">
              <TaskView key={detail} id={detail} highlight={highlight} tasks={tasks} onOpenAttachment={onOpenAttachment} column={{ detail: true }} />
            </div>
          </div>
        ) : cols ? (
          <AgentColumns pick={pick} tasks={tasks} onOpenAttachment={onOpenAttachment} />
        ) : (
        <>
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
              {thread && <ThreadMoreMenu thread={thread} anchor={moreAnchor} onClose={() => setMoreAnchor(null)} onArchive={archive} onBack={nav.board} openQuestions={openQs} onShell={sess.kind !== 'shell' && sess.status !== 'ended' ? () => side.show('shell') : undefined} />}
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
                  for (const ev of taskEv.before.get(m.id) ?? []) out.push(<StreamTaskEventLine key={'te' + ev.id} ev={ev} />)
                  if (d !== day) {
                    day = d
                    run = ''
                    out.push(
                      <div key={'d' + m.id} className="v-divider">
                        {d === new Date().toDateString() ? 'Today' : new Date(m.created_at).toLocaleDateString()}
                      </div>,
                    )
                  }
                  const sg = m.segment?.id ?? ''
                  if (sg !== seg) {
                    seg = sg
                    run = ''
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
                  // A message in the same task as the one before dims its badge; a message in no task ends the
                  // run (commands and minbox's own notes, such as asking the agent to place messages, do not).
                  const note = m.kind === 'command' || m.kind === 'run_result' || m.kind === ('place' as string) || m.kind === ('continue' as string)
                  const mt = note ? undefined : msgTask(m)
                  const repeat = !!mt && mt.task_id === run
                  if (!note) run = mt?.task_id ?? ''
                  if (foldAll && i < shown.length - 1) out.push(<CompactRow key={m.id} m={m} name={sess.name} onClick={() => setFoldAll(false)} />)
                  else out.push(<MessageView key={m.id} m={m} tasks={tasks} repeat={repeat} latest={m === lastUser} showAgent={false} questionNear={nearQ.has(m.id)} unread={m.author === 'agent' && !m.read_at} highlight={highlight === m.id} onOpenAttachment={onOpenAttachment} onChanged={reload} onUnread={markUnread} />)
                  if (m === lastUser && !m.pending)
                    out.push(
                      <div key={'dl' + m.id} className="v-delivery">
                        <DeliveryLine m={m} session={sess} draftKey={draftKey} compact />
                      </div>,
                    )
                  for (const f of (thread?.forks ?? []).filter((f) => f.from_message_id === m.id)) out.push(<ForkMarker key={'f' + f.thread_id} f={f} />)
                  return <Fragment key={m.id}>{out}</Fragment>
                })}
              {!showArtifacts && linearEv.tail.map((ev) => <LinearEventItem key={'l' + ev.id} ev={ev} identifier={thread?.linear?.identifier ?? ''} />)}
              {!showArtifacts && taskEv.tail.map((ev) => <StreamTaskEventLine key={'te' + ev.id} ev={ev} />)}
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
        </>
        )}
      </div>
      {isPhone && (pane !== 'tasks' || sheet) && (
        <aside className="v-side wide" data-testid="agent-side" data-sheet={sheet || undefined}>
          <div className="v-tabs2">
            {sheet && (
              <button type="button" className="v-sheetx" data-testid="agent-sheet-close" aria-label={`Back to ${sess.name}`} title="Back to the stream" onClick={() => (side.only('tasks'), goBack({ tab: 'inbox' }))}>
                <IconBack size={18} />
              </button>
            )}
            {(['tasks', 'terminal', 'shell', 'files'] as const).map((p) => (
              <button type="button" key={p} className={pane === p ? 'on' : ''} data-testid={'pane-' + p} onClick={() => (side.only(p), p === 'tasks' && !sheet ? navigate({ tab: 'tasks' }, { push: true }) : undefined)} disabled={p === 'shell' && sess.kind === 'shell'}>
                {p === 'tasks' ? 'Tasks' : p === 'terminal' ? 'Terminal' : p === 'shell' ? 'Shell' : 'Files'}
              </button>
            ))}
          </div>
          {pane === 'tasks' && sheet && (
            <div style={{ padding: '0 16px 16px', overflow: 'auto' }}>
              <AgentTaskList tasks={tasks} sessionId={id} selected={detail} onSelect={(k) => (side.only('tasks'), navigate({ k, m: null, tab: 'inbox' }, { push: true }))} />
            </div>
          )}
          {pane === 'terminal' && (
            <div style={{ flex: 1, minHeight: 420 }}>
              <TerminalPane session={sess} onClose={() => side.only('tasks')} />
            </div>
          )}
          {pane === 'shell' && (
            <div style={{ flex: 1, minHeight: 420 }}>
              <ShellPane session={sess} onClose={() => side.only('tasks')} />
            </div>
          )}
          {pane === 'files' && s && (
            <div style={{ flex: 1, minHeight: 420, overflow: 'hidden' }}>
              <FilesPane session={sess} threadId={s.stream_thread_id} draftKey={draftKey} onClose={() => side.only('tasks')} />
            </div>
          )}
        </aside>
      )}
      {/* Desktop and tablet: each pane on its own, after the stream (terminal | shell | files), with its
          edge on the stream's side and its own × in its header. */}
      {!isPhone &&
        side.shown.map((p) => (
          <Fragment key={p}>
            <Resizer testid={'side-resizer-' + p} className="v-rz-side" measure={() => document.querySelector<HTMLElement>(`[data-side-pane="${p}"]`)?.offsetWidth ?? 300} onDrag={side.drag(p)} />
            <aside className="v-side wide v-agside" data-testid={'side-' + p} data-side-pane={p} style={{ width: side.widths[p] }}>
              <div style={{ flex: 1, minHeight: 0, overflow: p === 'files' ? 'hidden' : undefined }}>
                {p === 'terminal' && <TerminalPane session={sess} onClose={() => side.close('terminal')} />}
                {p === 'shell' && <ShellPane session={sess} onClose={() => side.close('shell')} />}
                {p === 'files' && s && <FilesPane session={sess} threadId={s.stream_thread_id} draftKey={draftKey} onClose={() => side.close('files')} />}
              </div>
            </aside>
          </Fragment>
        ))}
    </>
  )
}
