// minbox v3's screens (docs/v3/usecases.md): the project rail, the sidebar (Board, Search, Agents),
// and the Board / a task / an agent's stream / Search. On a phone: one column with bottom tabs
// Board · Agents · Search. Keys: J/K Space Enter 1–9 X R ⇧N / ? g b g a T Esc.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type Attachment, type Session } from '../api'
import { opensBeside } from '../lib/attachments'
import { useMentions } from '../components/Mentions'
import { useApp } from '../lib/app'
import { agentKindLabel } from '../lib/agents'
import { selectProject, useSelectedProject } from '../lib/projects'
import { ProjectRail } from '../components/ProjectRail'
import { AttachmentViewer } from '../components/AttachmentViewer'
import { ConnectionBanner } from '../components/Banners'
import { PairRequestBanner } from '../components/Devices'
import { BoardView, boardKeys, useBoard } from './Board'
import { TaskView } from './TaskView'
import { StreamView, type SidePane } from './StreamView'
import { SearchView } from './Search'
import { v3, type V3Message } from './data'
import { agentHint, openQuestions, pickChoice, sendAnswers, useNav, useSessionsById } from './parts'
import { quoteIntoComposer, selectedInConversation } from './quote'
import { ComposeFileTiles, clearFiles, fileInputHandlers, uploadIds, useComposeFiles } from '../lib/uploads'
import { IconPaperclip } from '../components/icons'
import './v3.css'

export function V3App() {
  const app = useApp()
  const { route, isPhone, overlay, setOverlay, sessions } = app
  const { id: projectId, project } = useSelectedProject()
  const [board, reloadBoard] = useBoard()
  const nav = useNav()
  const [focus, setFocus] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showDone, setShowDone] = useState(false)
  const [showQuiet, setShowQuiet] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [pane, setPane] = useState<SidePane>('tasks')
  // The file open over the conversation (route f: ] / [ in the viewer step through the files).
  const [viewerSession, setViewerSession] = useState<string | null>(null)
  useEffect(() => setHidden(new Set()), [board])
  const agents = useMemo(() => {
    const live = (sessions ?? []).filter((s) => !s.archived_at && s.kind !== 'shell' && (!projectId || s.project_id === projectId))
    return live.sort((a, b) => Number(b.is_main) - Number(a.is_main) || ((a.last_activity ?? '') < (b.last_activity ?? '') ? 1 : -1))
  }, [sessions, projectId])
  const view = route.view === 'task' && route.k ? 'task' : route.view === 'agent' && route.s ? 'agent' : route.view === 'agents' ? 'agents' : route.view === 'search' ? 'search' : 'board'
  const needs = board ? board.questions.filter((m) => !hidden.has(m.id)).length + board.tasks.filter((t) => t.status === 'needs_you' && !board.questions.some((m) => !hidden.has(m.id) && m.tasks.some((tg) => tg.task_id === t.id))).length : 0
  const unread = board ? Object.values(board.agents).reduce((n, a) => n + a.unread, 0) : 0
  useEffect(() => {
    document.title = needs > 0 ? `(${needs}) minbox` : 'minbox'
  }, [needs])
  // The agent of a route in another project: follow it.
  useEffect(() => {
    if (view !== 'agent' || !route.s) return
    const s = sessions?.find((x) => x.id === route.s)
    if (s && projectId && s.project_id && s.project_id !== projectId) selectProject(s.project_id)
  }, [view, route.s, sessions, projectId])
  // A link with tab=terminal (older links, the phone's terminal) opens the agent with its terminal.
  useEffect(() => setPane(route.tab === 'terminal' ? 'terminal' : 'tasks'), [route.s, route.tab])
  const openNew = useCallback((to?: string) => setOverlay({ kind: 'v3-new', to } as never), [setOverlay])

  // ---- keys ----
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {})
  const gPending = useRef(false)
  keysRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement
    const typing = t.matches?.('input, textarea, select, [contenteditable=true]') || !!t.closest?.('.xterm')
    if (overlay) return
    if (e.key === 'Escape') {
      if (typing) return
      // A file open (its viewer's Esc leaves full screen, then closes it), or a menu that took the key.
      if (route.f || e.defaultPrevented || document.querySelector('[data-testid="attachment-viewer"]')) return
      if (view !== 'board') {
        e.preventDefault()
        nav.board()
      }
      return
    }
    // ⌘↵ on a focused question card sends its picked answers.
    if (view === 'board' && (e.metaKey || e.ctrlKey) && e.key === 'Enter' && focus?.startsWith('q:') && !(typing && t.matches?.('textarea'))) {
      const m = board?.questions.find((x) => x.id === focus.slice(2))
      if (m) {
        e.preventDefault()
        const idx = boardKeys(board, showDone, hidden, showQuiet).indexOf(focus)
        sendAnswers(m)
          .then((as) => {
            if (!as.length) return
            setHidden((h) => new Set(h).add(m.id))
            app.toast(`Sent ${as.length > 1 ? `${as.length} answers` : 'your answer'}`)
            setFocus(boardKeys(board, showDone, hidden, showQuiet)[idx + 1] ?? null)
          })
          .catch(app.error)
      }
      return
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return
    if (gPending.current) {
      gPending.current = false
      if (e.key === 'b') nav.board()
      if (e.key === 'a' && agents[0]) nav.agent(agents[0].id)
      return
    }
    if (e.key === 'g') {
      gPending.current = true
      setTimeout(() => (gPending.current = false), 800)
      return
    }
    if (e.key === '?') return setOverlay({ kind: 'v3-help' } as never)
    if (e.key === 'N' && e.shiftKey) {
      e.preventDefault()
      return openNew(view === 'agent' ? route.s ?? undefined : undefined)
    }
    if (e.key === '/') {
      e.preventDefault()
      return nav.search()
    }
    if (e.key === 'r' || e.key === 'R') {
      // With text selected in the messages: quote it into the reply box (as the Reply bubble does).
      const sel = selectedInConversation()
      if (sel) {
        e.preventDefault()
        return quoteIntoComposer(sel)
      }
      const ta = document.querySelector<HTMLTextAreaElement>('textarea[data-composer]')
      if (ta) {
        e.preventDefault()
        ta.focus()
      }
      return
    }
    if (view === 'agent' && (e.key === 't' || e.key === 'T')) return setPane(pane === 'terminal' ? 'tasks' : 'terminal')
    if (view !== 'board') return
    const keys = boardKeys(board, showDone, hidden, showQuiet)
    const i = focus ? keys.indexOf(focus) : -1
    const move = (k: string | undefined) => {
      if (!k) return
      setFocus(k)
      requestAnimationFrame(() => document.querySelector(`[data-key="${k}"]`)?.scrollIntoView({ block: 'nearest' }))
    }
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault()
      move(keys[Math.min(keys.length - 1, i + 1)])
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(keys[Math.max(0, i - 1)])
    } else if (!focus) return
    else if (e.key === ' ') {
      e.preventDefault()
      if (focus.startsWith('t:')) {
        const id = focus.slice(2)
        setExpanded((x) => ({ ...x, [id]: !x[id] }))
      }
    } else if (e.key === 'Enter') {
      const [k, id] = focus.split(':') as [string, string]
      if (k === 't') nav.task(id)
      else {
        const m = board?.questions.find((x) => x.id === id)
        if (m) m.tasks[0] ? nav.task(m.tasks[0].task_id, m.id) : nav.agent(m.session_id, m.id)
      }
    } else if (/^[1-9]$/.test(e.key) && focus.startsWith('q:')) {
      // 1–9 picks a choice of the card's first question (nothing is sent: ⌘↵ or Send does).
      const m = board?.questions.find((x) => x.id === focus.slice(2))
      const q = m ? openQuestions(m).find((x) => x.kind === 'single' || x.kind === 'multi') : undefined
      const c = q?.choices?.[Number(e.key) - 1]
      if (m && q && c) pickChoice(m, q, c.label)
    } else if ((e.key === 'x' || e.key === 'X') && focus.startsWith('t:')) {
      const t = board?.tasks.find((x) => x.id === focus.slice(2))
      if (t) v3.patchTask(t.id, { status: t.status === 'done' ? 'working' : 'done' }).then(reloadBoard).catch(app.error)
    }
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => keysRef.current(e)
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  // Ctrl+` shows and hides the agent's shell, also from inside a terminal (caught before it sees the key).
  const shellRef = useRef(() => {})
  shellRef.current = () => {
    if (view === 'agent') setPane(pane === 'shell' ? 'tasks' : 'shell')
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== '`' || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      shellRef.current()
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [])

  const tasks = board?.tasks ?? []
  const onOpenAttachment = (a: Attachment, m: V3Message) => {
    setViewerSession(m.session_id)
    if (a.kind === 'review') app.navigate({ view: 'review', r: a.id }, { push: true })
    else if (!opensBeside(a)) window.open(api.attachmentDownloadUrl(a.id), '_blank')
    else app.navigate({ f: a.id }, { push: true })
  }
  const byId = useSessionsById()
  let main: React.ReactNode
  if (view === 'task') main = <TaskView id={route.k!} highlight={route.m} tasks={tasks} onOpenAttachment={onOpenAttachment} />
  else if (view === 'agent') main = <StreamView id={route.s!} highlight={route.m} tasks={tasks} pane={pane} setPane={setPane} onOpenAttachment={onOpenAttachment} />
  else if (view === 'search') main = <SearchView />
  else if (view === 'agents') main = <AgentsList agents={agents} counts={board?.agents ?? {}} onNew={() => openNew()} />
  else
    main = (
      <BoardView
        board={board}
        reload={reloadBoard}
        focus={focus}
        setFocus={setFocus}
        expanded={expanded}
        toggleExpanded={(id) => setExpanded((x) => ({ ...x, [id]: !x[id] }))}
        showDone={showDone}
        setShowDone={setShowDone}
        showQuiet={showQuiet}
        setShowQuiet={setShowQuiet}
        hidden={hidden}
        hide={(id) => setHidden((h) => new Set(h).add(id))}
      />
    )
  const viewerSess = byId.get(viewerSession ?? route.s ?? '')
  const closeViewer = () => app.navigate({ f: null }, { push: false })
  return (
    <div className="v-app" data-testid="v3-app" data-view={view}>
      {!isPhone && (
        <div className="v-rail" style={{ width: 56, flex: 'none', borderRight: '1px solid var(--mb-line)' }}>
          <ProjectRail narrow />
        </div>
      )}
      {!isPhone && (
        <nav className="v-sidebar" data-testid="sidebar">
          <ConnectionBanner />
          <PairRequestBanner />
          <div style={{ height: 8 }} />
          <button type="button" className={'v-sb-item' + (view === 'board' ? ' sel' : '')} data-testid="nav-board" onClick={nav.board}>
            ▤ Board <span className="v-cnt">{needs > 0 && <span className="v-badge w" data-testid="board-badge">{needs}</span>}</span>
          </button>
          <button type="button" className={'v-sb-item' + (view === 'search' ? ' sel' : '')} data-testid="nav-search" onClick={nav.search}>
            ⌕ Search{' '}
            <span className="v-cnt">
              <span className="v-kbd">/</span>
            </span>
          </button>
          <div className="v-sb-h">
            AGENTS <span title={project?.dir}>{project?.name ?? 'all projects'}</span>
          </div>
          <div className="v-agents" data-testid="agents">
            {agents.map((a) => (
              <AgentRow key={a.id} a={a} sel={view === 'agent' && route.s === a.id} counts={board?.agents[a.id]} />
            ))}
            {agents.length === 0 && <div className="v-empty">No agents yet. Start one with “New message”.</div>}
          </div>
          <button type="button" className="v-sb-new" data-testid="sidebar-new" onClick={() => openNew()}>
            New message… <span className="v-kbd">⇧N</span>
          </button>
        </nav>
      )}
      {isPhone && (
        <>
          <ConnectionBanner />
          <PairRequestBanner />
        </>
      )}
      <main className="v-main">{main}</main>
      {isPhone && (
        <div className="v-tabs" data-testid="phone-tabs">
          {(
            [
              ['board', '▤', 'Board', needs, 'w'],
              ['agents', '☺', 'Agents', unread, 'u'],
              ['search', '⌕', 'Search', 0, ''],
            ] as const
          ).map(([v, i, l, c, k]) => (
            <button
              type="button"
              key={v}
              data-testid={'tab-' + v}
              className={view === v || (v === 'agents' && view === 'agent') || (v === 'board' && view === 'task') ? 'on' : ''}
              onClick={() => (v === 'board' ? nav.board() : v === 'agents' ? nav.agents() : nav.search())}
            >
              <b>{i}</b>
              {l}
              {c > 0 && <span className={'v-badge ' + k}>{c}</span>}
            </button>
          ))}
        </div>
      )}
      {overlay && (overlay as { kind: string }).kind === 'v3-new' && <NewMessageDialog agents={agents} initialTo={(overlay as { to?: string }).to} onClose={() => setOverlay(null)} />}
      {overlay && (overlay as { kind: string }).kind === 'v3-help' && <HelpDialog onClose={() => setOverlay(null)} />}
      {route.f && (
        <div className="v-overlay" style={{ padding: 0, alignItems: 'stretch' }} data-testid="attachment-overlay" onClick={closeViewer}>
          <div style={{ flex: 1, background: 'var(--mb-bg)', display: 'flex', flexDirection: 'column', minWidth: 0 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 6 }}>
              <button type="button" className="v-btn" data-testid="close-viewer" onClick={closeViewer}>
                Close · Esc
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <AttachmentViewer attachmentId={route.f} sessionName={viewerSess?.name ?? ''} sessionCwd={viewerSess?.cwd ?? ''} phone={isPhone} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AgentRow({ a, sel, counts }: { a: Session; sel: boolean; counts?: { unread: number; open_questions: number } }) {
  const nav = useNav()
  const { sessions } = useApp()
  const hint = agentHint(sessions ?? [], a)
  const u = counts?.unread ?? 0
  const waits = (counts?.open_questions ?? 0) > 0
  return (
    <button type="button" className={'v-ag' + (sel ? ' sel' : '')} data-testid="agent-row" data-session={a.id} onClick={() => nav.agent(a.id)}>
      <span className={'v-dot ' + (a.status === 'working' ? 'd-work v-live' : waits ? 'd-wait' : a.status === 'ended' ? 'd-done' : 'd-idle')} />
      <span className="v-nm">
        {a.name}{' '}
        <small>
          {hint && !a.is_main ? hint + ' · ' : ''}
          {a.is_main ? 'main · ' : ''}
          {agentKindLabel(a.agent)}
        </small>
      </span>
      {u > 0 ? (
        <span className="v-badge u" data-testid="agent-unread">
          {u}
        </span>
      ) : (
        <span />
      )}
      <span className="v-doing">
        {a.status === 'working' ? 'working…' + (a.title ? ' · ' : '') : ''}
        {a.title || (a.status === 'working' ? '' : a.status === 'ended' ? 'ended' : a.status === 'starting' ? 'starting' : 'idle')}
      </span>
    </button>
  )
}

function AgentsList({ agents, counts, onNew }: { agents: Session[]; counts: Record<string, { unread: number; open_questions: number }>; onNew: () => void }) {
  const { projects, navigate } = useApp()
  const { id } = useSelectedProject()
  return (
    <div className="v-col" data-testid="agents-view">
      <div className="v-head">
        <div className="v-r1">
          <h1>Agents</h1>
          <button type="button" className="v-btn" data-testid="open-settings-phone" onClick={() => navigate({ view: 'settings' }, { push: true })}>
            Settings
          </button>
          <button type="button" className="v-btn" onClick={onNew}>
            ＋ New
          </button>
        </div>
        <div className="v-r2">
          <select className="v-chip" aria-label="Project" value={id} onChange={(e) => selectProject(e.target.value)}>
            <option value="">All projects</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="v-scroll" style={{ background: 'var(--mb-surface)' }}>
        {agents.map((a) => (
          <AgentRow key={a.id} a={a} sel={false} counts={counts[a.id]} />
        ))}
        {agents.length === 0 && <div className="v-empty">No agents yet. Tap ＋ New to start one.</div>}
      </div>
    </div>
  )
}

/** ⇧N: a message to an agent (the project's main one by default) or to a new agent. The agent decides what it is. */
function NewMessageDialog({ agents, initialTo, onClose }: { agents: Session[]; initialTo?: string; onClose: () => void }) {
  const { error, projects, toast, setOverlay } = useApp()
  const { id: projectId } = useSelectedProject()
  const nav = useNav()
  const main = agents.find((a) => a.is_main) ?? agents[0]
  const [to, setTo] = useState(initialTo ?? main?.id ?? 'new')
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const compose = useComposeFiles('v3:new')
  const { files, addFiles, addPastedText, remove } = compose
  const io = fileInputHandlers(addFiles, addPastedText)
  const fileInput = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const mention = useMentions({ sessionId: to !== 'new' ? to : null, value: body, onChange: setBody, inputRef: bodyRef, agents: false })
  const uploading = files.some((f) => f.state === 'uploading')
  const canSend = (!!body.trim() || files.some((f) => f.state === 'done')) && !uploading && !busy
  const project = projectId || (to !== 'new' ? agents.find((a) => a.id === to)?.project_id : '') || projects?.[0]?.id || ''
  const send = async () => {
    if (!canSend) return
    setBusy(true)
    try {
      const ups = uploadIds('v3:new')
      const m = await v3.newMessage({ to, project_id: project, words: body.trim(), name: to === 'new' ? name.trim() : undefined, uploads: ups.length ? ups : undefined })
      clearFiles('v3:new')
      onClose()
      const sid = to === 'new' ? undefined : to
      if (to === 'new') toast('Started a new agent')
      // The message lands in that agent's stream.
      const target = sid ?? (await waitSession(m.thread_id))
      if (target) nav.agent(target)
    } catch (e) {
      error(e)
      setBusy(false)
    }
  }
  return (
    <div className="v-overlay" onMouseDown={onClose} data-testid="new-message-dialog">
      <div className="v-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h3>New message</h3>
        {!project && (
          <div className="v-rowf" data-testid="no-project">
            There is no project yet: add one (its folder) first, then write to its agent.
            <button type="button" className="v-btn pri" onClick={() => setOverlay({ kind: 'new-project' })}>
              Add a project
            </button>
          </div>
        )}
        <div className="v-rowf">
          To
          <select aria-label="To" data-testid="new-to" value={to} onChange={(e) => setTo(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.is_main ? ' (main)' : agentHint(agents, a) ? ` (${agentHint(agents, a)})` : ''} · {agentKindLabel(a.agent)}
                {a.title ? ' — ' + a.title.slice(0, 40) : ''}
              </option>
            ))}
            <option value="new">New agent…</option>
          </select>
          {to === 'new' && <input type="text" aria-label="Agent name" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />}
        </div>
        <ComposeFileTiles files={files} onRemove={remove} onPutBack={(f) => (f.pasted ? (setBody((b) => b + f.pasted!.text), remove(f.key)) : undefined)} />
        <div style={{ position: 'relative' }}>
        <textarea
          autoFocus
          ref={bodyRef}
          {...mention.handlers}
          onPaste={io.onPaste}
          onDragOver={io.onDragOver}
          onDrop={io.onDrop}
          data-testid="new-body"
          placeholder="Ask or tell the agent something…"
          value={body}
          onKeyDown={(e) => {
            if (mention.onKeyDown(e)) return
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void send()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        {mention.popup()}
        </div>
        <div className="v-foot">
          <button type="button" className="v-attach" data-testid="attach-files" aria-label="Attach files" title="Attach files (or paste / drop them)" onClick={() => fileInput.current?.click()}>
            <IconPaperclip size={16} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="attach-input"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <span className="v-hide-phone">The agent files it under a task when it is work. ⌘↵ send · Esc close</span>
          <span className="v-sp" />
          <button type="button" className="v-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="v-btn pri" data-testid="new-send" disabled={!canSend} onClick={() => void send()}>
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

/** The session a thread belongs to (a new agent's stream), from the sessions list. */
async function waitSession(threadId: string): Promise<string | undefined> {
  try {
    const r = await fetch('/api/threads/' + threadId)
    const th = await r.json()
    return th.session_id
  } catch {
    return undefined
  }
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onClose])
  const rows: [string, string][] = [
    ['?', 'This help'],
    ['⇧N', 'New message (to the main agent by default)'],
    ['/', 'Search'],
    ['g b · g a', 'Board · first agent'],
    ['J / K', 'Move on the Board'],
    ['Space', 'Expand / collapse a task row'],
    ['Enter', 'Open the task (a question: its task or agent)'],
    ['1–9', 'Pick a choice of the focused question'],
    ['⌘↵', 'Send the picked answers (Board) · send the message'],
    ['X', 'Done / reopen the focused task'],
    ['R', 'Reply: quote the selected text, or focus the reply box'],
    ['T', 'Terminal of the agent'],
    ['Ctrl+`', 'Shell of the agent'],
    ['Esc', 'Close / back to the Board'],
  ]
  return (
    <div className="v-overlay" onMouseDown={onClose} data-testid="help-dialog">
      <div className="v-dialog v-help" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Keyboard</h3>
        <table>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <span className="v-kbd">{k}</span>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
