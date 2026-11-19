// minbox v3's screens (docs/v3/usecases.md): the project rail, the sidebar (Board, Search, Agents),
// and the Board / an agent's stream (a task: selected in its agent's page) / Search. On a phone: one column with bottom tabs
// Board · Agents · Search. Keys: ⌘K J/K Enter X N Z R ⇧N ⇧F / ? g b g a T Ctrl+` Esc.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, type Attachment, type Session } from '../api'
import { opensBeside } from '../lib/attachments'
import { useMentions } from '../components/Mentions'
import { railWidth, useApp } from '../lib/app'
import { isMac } from '../lib/format'
import { NotificationAsk, SessionMenu } from '../components/Sidebar'
import { PhoneProjectButton } from '../components/PhoneProjects'
import { useContextMenu } from '../components/ContextMenu'
import { projectHueStyle } from '../lib/projectColor'
import { V3Palette, type PaletteCtx } from './Palette'
import { RenameAgentDialog } from './AgentActions'
import { StaleMark } from './StaleAgent'
import { MIN_PANE, MIN_STREAM, Resizer, clamp, fitPanes, useSidePanes, useWindowWidth, useZoom, type PaneKind } from './layout'
import { agentKindLabel } from '../lib/agents'
import { selectProject, useSelectedProject } from '../lib/projects'
import { ProjectRail } from '../components/ProjectRail'
import { AttachmentViewer } from '../components/AttachmentViewer'
import { ConnectionBanner } from '../components/Banners'
import { PairRequestBanner } from '../components/Devices'
import { BoardView, boardKeys, needsCount, useBoard } from './Board'
import { RENAME_TASK_EVENT, RenameTaskDialog } from './RenameTask'
import { StreamView } from './StreamView'
import { AllTasksPane, TasksPane, agentTasks } from './AgentTasks'
import { AllAgentsView } from './AllAgents'
import { SearchView } from './Search'
import { v3, type BoardTask, type V3Message } from './data'
import { BackButton, SendKey, rememberTasks, agentHint, openQuestions, taskOwner, useNav, useSessionsById } from './parts'
import { quoteIntoComposer, selectedInConversation } from './quote'
import { ComposeFileTiles, clearFiles, fileInputHandlers, uploadIds, useComposeFiles } from '../lib/uploads'
import { IconBoard, IconCommand, IconMenu, IconPaperclip, IconSearch, IconTasks } from '../components/icons'
// The phone's bottom tabs: Lucide icons, one module each (not the barrel), so only these three ship.
import IconTabBoard from 'lucide-react/icons/square-kanban'
import IconTabAgents from 'lucide-react/icons/bot'
import IconTabSearch from 'lucide-react/icons/search'
import IconPlus from 'lucide-react/icons/plus'
import './v3.css'
import './shell.css'

export function V3App() {
  const app = useApp()
  const { route, isPhone, isTablet, overlay, setOverlay, sessions, settings, layout, setLayout } = app
  const { id: projectId, project } = useSelectedProject()
  const [board, reloadBoard, setBoard] = useBoard()
  const [renamingTask, setRenamingTask] = useState<BoardTask | null>(null)
  const nav = useNav()
  const [focus, setFocus] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [showQuiet, setShowQuiet] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  // The file open over the conversation (route f: ] / [ in the viewer step through the files).
  const [viewerSession, setViewerSession] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<Session | null>(null)
  // Tablet: the sidebar folds away on a task or an agent (two panes); the rail's ☰ brings it back.
  const [sbOpen, setSbOpen] = useState(false)
  // The agent's Tasks pane where there is no room for it beside the stream: unfolded over the stream.
  const [tasksOver, setTasksOver] = useState(false)
  useEffect(() => setHidden(new Set()), [board])
  const agents = useMemo(() => {
    const live = (sessions ?? []).filter((s) => !s.archived_at && s.kind !== 'shell' && (!projectId || s.project_id === projectId))
    return live.sort((a, b) => ((a.last_activity ?? '') < (b.last_activity ?? '') ? 1 : -1))
  }, [sessions, projectId])
  // Plain login shells an older build left (they can no longer be made): listed apart, they open on their terminal.
  const shells = useMemo(() => (sessions ?? []).filter((s) => !s.archived_at && s.kind === 'shell' && (!projectId || s.project_id === projectId)), [sessions, projectId])
  // The Agents page is the phone's bottom tab. Wider, the sidebar lists the agents (☰ on a tablet), so
  // #v=agents (a link, a back entry, a phone unfolded to a tablet) shows the Board; narrowed back to a
  // phone it is the Agents page again.
  // #v=task&k=… (the task page is gone: old links, bookmarks, notifications) is on its way to the task's
  // agent (see the redirect below).
  const view = route.view === 'task' && route.k ? 'task' : route.view === 'agent' && route.s ? 'agent' : route.view === 'agents' && isPhone ? 'agents' : route.view === 'alltasks' ? 'alltasks' : route.view === 'search' ? 'search' : 'board'
  const current = view === 'agent' ? sessions?.find((s) => s.id === route.s) : undefined
  const side = useSidePanes(current)
  useEffect(() => setSbOpen(false), [view, route.s, route.k])
  useEffect(() => setTasksOver(false), [view, route.s])
  // The Columns page is gone (the agent's Tasks pane checks tasks into columns now): an old #v=columns
  // link lands on the Board.
  useEffect(() => {
    if (/(^#|&)v=columns(&|$)/.test(location.hash)) app.navigate({ view: 'main', k: null, s: null, m: null }, { push: false })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // The agent's Tasks pane (desktop and tablet; a plain shell has none). Beside the stream, shown or
  // folded to a strip as the person left it (kept in the layout); with no room for it (the stream would
  // get narrower than MIN_STREAM: a portrait tablet with a side pane or the sidebar open, a narrow window
  // with side panes open) a strip that unfolds over the stream.
  const zoom = useZoom()
  const winW = useWindowWidth() / zoom
  // All agents has the same pane (every agent's tasks).
  const hasTasks = !isPhone && ((view === 'agent' && !!current && current.kind !== 'shell') || view === 'alltasks')
  // A tablet's default is narrower, so the stream keeps its room beside it.
  const tasksW = clamp(layout.v3TasksW ?? (isTablet ? 232 : 260), 200, 480)
  // The sidebar beside them (a tablet's only when the rail's ☰ brought it back).
  const sbShownW = !isPhone && (!isTablet || sbOpen) ? clamp(layout.v3SidebarW ?? 236, 200, 480) : 0
  // The agent's side panes (terminal | shell | files after the stream), each its own width. When the stream
  // would get narrower than MIN_STREAM beside them, the Tasks pane folds to its strip first; still too
  // narrow, the panes squeeze toward MIN_PANE and the ones opened longest ago stop showing (fitPanes).
  const wantW = (p: PaneKind) => clamp(layout.v3PaneW?.[p] ?? (p === 'files' ? 400 : layout.v3WideW ?? Math.min(winW * 0.46, 760)), MIN_PANE, 4000)
  const openW = view === 'agent' ? side.open.reduce((n, p) => n + wantW(p), 0) : 0
  const tasksCompact = winW - railWidth(layout) - sbShownW - tasksW - openW < MIN_STREAM
  const tasksShown = tasksCompact ? tasksOver : !layout.v3TasksHidden
  const showTasks = useCallback((show: boolean) => (tasksCompact ? setTasksOver(show) : setLayout({ v3TasksHidden: !show })), [tasksCompact, setLayout])
  const tasksSpace = !hasTasks ? 0 : tasksShown && !tasksCompact ? tasksW : 34
  const fitted = isPhone ? { shown: side.open, widths: {} } : fitPanes(side.open, wantW, winW - railWidth(layout) - sbShownW - tasksSpace - MIN_STREAM - 2 * side.open.length)
  const shownPanes = view === 'agent' ? fitted.shown : []
  // The stream beside them (each pane's edge and border take a pixel or two): narrow, its header keeps to icons.
  const streamNarrow = !isPhone && shownPanes.length > 0 && winW - railWidth(layout) - sbShownW - tasksSpace - shownPanes.reduce((n, p) => n + (fitted.widths[p] ?? 0), 0) < 480
  const { show: showPane, close: closePane } = side
  const togglePane = useCallback((p: PaneKind) => (shownPanes.includes(p) ? closePane(p) : showPane(p)), [shownPanes.join(' '), showPane, closePane]) // eslint-disable-line react-hooks/exhaustive-deps
  // The Board's own count of NEEDS YOU, so the badge never counts an entry the Board does not show.
  const needs = needsCount(board, hidden)
  const unread = board ? Object.values(board.agents).reduce((n, a) => n + a.unread, 0) : 0
  useEffect(() => {
    document.title = needs > 0 ? `(${needs}) minbox` : 'minbox'
  }, [needs])
  // The task page is gone: #v=task&k=<task> becomes its agent's page with the task selected
  // (#s=<agent>&v=agent&k=<task>, replacing the entry). With no agent for it (see taskOwner): the Board,
  // its row focused.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const boardRef = useRef(board)
  boardRef.current = board
  useEffect(() => {
    if (route.view !== 'task' || !route.k || sessions === null) return
    const k = route.k
    const m = route.m
    let gone = false
    const go = (t: BoardTask | undefined) => {
      if (gone) return
      const s = t ? taskOwner(t, sessionsRef.current ?? []) : null
      if (s) return app.navigate({ view: 'agent', s, k, m, tab: 'inbox' }, { push: false })
      app.navigate({ view: 'main', s: null, k: null, m: null, tab: 'inbox' }, { push: false })
      if (!t) return app.toast('That task is gone')
      if (t.status === 'done') setShowDone(true)
      setFocus('t:' + k)
      requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(`[data-key="t:${k}"]`)?.scrollIntoView({ block: 'nearest' })))
    }
    const known = boardRef.current?.tasks.find((x) => x.id === k)
    if (known) go(known)
    else
      v3.task(k)
        .then((d) => go(d.task))
        .catch(() => go(undefined))
    return () => {
      gone = true
    }
  }, [route.view, route.k, sessions === null]) // eslint-disable-line react-hooks/exhaustive-deps
  // The agent of a route in another project: follow it, once when the route opens it. Not again when
  // the person picks another project (the rail, the palette) with the agent still open: that would
  // snap the selection back to the agent's project.
  const followed = useRef<string | null>(null)
  useEffect(() => {
    if (view !== 'agent' || !route.s) return void (followed.current = null)
    if (followed.current === route.s) return
    const s = sessions?.find((x) => x.id === route.s)
    if (!s || app.projects === null) return
    followed.current = route.s
    if (projectId && s.project_id && s.project_id !== projectId) selectProject(s.project_id)
  }, [view, route.s, sessions, app.projects, projectId])
  // Another project picked (the rail, the palette, the phone's projects, a project archived): nothing
  // of the previous one stays open. All agents unpicks a task of another project (#…&k= dropped, so the
  // pane and the main pane show no task); an open agent of another project is left for the Board. All
  // projects holds every agent and task, so picking it leaves things as they are. A layout effect, so
  // the old project's task or agent is never painted under the new project.
  const lastProject = useRef(projectId)
  useLayoutEffect(() => {
    if (lastProject.current === projectId) return
    lastProject.current = projectId
    if (!projectId) return
    if (view === 'alltasks' && route.k) {
      if (boardRef.current?.tasks.find((t) => t.id === route.k)?.project_id !== projectId) app.navigate({ k: null, m: null }, { push: false })
    } else if (view === 'agent' && current?.project_id && current.project_id !== projectId) {
      app.navigate({ view: 'main', s: null, k: null, m: null, tab: 'inbox' }, { push: true })
    }
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  const openNew = useCallback((to?: string) => setOverlay({ kind: 'v3-new', to } as never), [setOverlay])
  const openNewAgent = useCallback(() => setOverlay({ kind: 'new-session', projectId: projectId || undefined }), [setOverlay, projectId])
  // The ＋ on a project's header in the agent list: the New agent dialog in that project.
  const newAgentIn = useCallback((pid?: string) => setOverlay({ kind: 'new-session', projectId: pid || undefined }), [setOverlay])
  const paletteCtx: PaletteCtx = { agent: current, panes: shownPanes, togglePane, tasksPane: hasTasks ? { shown: tasksShown, show: showTasks } : undefined, openNew, openNewAgent, openHelp: () => setOverlay({ kind: 'v3-help' } as never), rename: setRenaming }

  // A Board question row's open questions ignored (moot): gone at once, back on failure or Undo.
  const ignoreAsk = (m: V3Message) => {
    const keys = openQuestions(m).map((q) => q.key)
    if (!keys.length) return
    const show = () => setHidden((h) => { const n = new Set(h); n.delete(m.id); return n })
    setHidden((h) => new Set(h).add(m.id))
    v3.ignore(m.id, keys)
      .then(() => {
        reloadBoard()
        app.toast('Ignored', { action: 'Undo', undo: true, onAction: () => v3.unignore(m.id, keys).then(reloadBoard).catch(app.error) })
      })
      .catch((e) => {
        show()
        app.error(e)
      })
  }

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
      // Back to where the person came from (as the header's ‹ does), else the Board.
      if (view !== 'board') {
        e.preventDefault()
        app.goBack((view === 'agent' || view === 'alltasks') && route.k ? { k: null } : undefined)
      }
      return
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return
    // E / F2: rename the open task (in place) or the focused Board row (a dialog).
    if (e.key === 'F2' || ((e.key === 'e' || e.key === 'E') && settings.single_key)) {
      if ((view === 'agent' || view === 'alltasks') && route.k) {
        e.preventDefault()
        window.dispatchEvent(new Event(RENAME_TASK_EVENT))
        return
      }
      const t = view === 'board' && focus?.startsWith('t:') ? board?.tasks.find((x) => x.id === focus.slice(2)) : undefined
      if (t) {
        e.preventDefault()
        setRenamingTask(t)
        return
      }
    }
    // Settings › single-key shortcuts off: only the arrows and Enter move on the Board.
    if (!settings.single_key && !['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) return
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
      const ta = document.querySelector<HTMLTextAreaElement>('.v-main textarea[data-composer]') ?? document.querySelector<HTMLTextAreaElement>('textarea[data-composer]')
      if (ta) {
        e.preventDefault()
        ta.focus()
      }
      return
    }
    if (view === 'agent' && e.key === 'F' && e.shiftKey) {
      e.preventDefault()
      return togglePane('files')
    }
    // ⇧T: show or fold the agent's Tasks pane; T: its terminal.
    if ((view === 'agent' || view === 'alltasks') && e.key === 'T' && e.shiftKey) {
      e.preventDefault()
      if (hasTasks) showTasks(!tasksShown)
      return
    }
    if (view === 'agent' && (e.key === 't' || e.key === 'T')) return togglePane('terminal')
    if (e.key === 'n' && !e.shiftKey) {
      // N: the first agent with unread messages (the selected project's first, then any).
      const counts = board?.agents ?? {}
      const next = [...agents, ...(sessions ?? []).filter((s) => !s.archived_at && s.kind !== 'shell')].find((a) => (counts[a.id]?.unread ?? 0) > 0 && a.id !== route.s)
      if (next) nav.agent(next.id)
      else app.toast('Nothing unread')
      return
    }
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
    else if (e.key === 'Enter') {
      const [k, id] = focus.split(':') as [string, string]
      if (k === 't') nav.task(id)
      else {
        const m = board?.questions.find((x) => x.id === id)
        if (m) m.tasks[0] ? nav.task(m.tasks[0].task_id, m.id) : nav.agent(m.session_id, m.id)
      }
    } else if ((e.key === 'i' || e.key === 'I') && !e.shiftKey && focus.startsWith('q:')) {
      const m = board?.questions.find((x) => x.id === focus.slice(2))
      if (m) {
        e.preventDefault()
        move(keys[i + 1] ?? keys[i - 1])
        ignoreAsk(m)
      }
    } else if ((e.key === 'x' || e.key === 'X') && focus.startsWith('t:')) {
      const t = board?.tasks.find((x) => x.id === focus.slice(2))
      if (t) {
        const was = t.status
        v3.patchTask(t.id, { status: was === 'done' ? 'working' : 'done' })
          .then(() => {
            reloadBoard()
            // Z (or the toast's Undo) puts the status back.
            app.toast(was === 'done' ? `Reopened “${t.title}”` : `Done: “${t.title}”`, { action: 'Undo', undo: true, onAction: () => v3.patchTask(t.id, { status: was }).then(reloadBoard).catch(app.error) })
          })
          .catch(app.error)
      }
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
    if (view === 'agent') togglePane('shell')
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
  rememberTasks(tasks)
  const onOpenAttachment = (a: Attachment, m: V3Message) => {
    setViewerSession(m.session_id)
    if (a.kind === 'review') app.navigate({ view: 'review', r: a.id }, { push: true })
    else if (!opensBeside(a)) window.open(api.attachmentDownloadUrl(a.id), '_blank')
    else app.navigate({ f: a.id }, { push: true })
  }
  const byId = useSessionsById()
  let main: React.ReactNode
  if (view === 'task') main = <div className="v-empty" data-testid="task-redirect">Opening the task…</div>
  else if (view === 'agent') main = <StreamView id={route.s!} highlight={route.m} tasks={tasks} narrow={streamNarrow} side={{ shown: shownPanes, widths: fitted.widths, toggle: togglePane, show: showPane, close: closePane, only: side.only, drag: dragPane }} sheet={isPhone && route.tab === 'tasks'} onOpenAttachment={onOpenAttachment} />
  else if (view === 'search') main = <SearchView />
  else if (view === 'agents') main = <AgentsList agents={agents} shells={shells} counts={board?.agents ?? {}} tasks={tasks} onNewAgent={newAgentIn} onRename={setRenaming} />
  else if (view === 'alltasks') main = <AllAgentsView agents={agents} tasks={tasks} projectName={project?.name} highlight={route.m} sheet={isPhone && route.tab === 'tasks'} onOpenAttachment={onOpenAttachment} />
  else
    main = (
      <BoardView
        board={board}
        reload={reloadBoard}
        focus={focus}
        setFocus={setFocus}
        showDone={showDone}
        setShowDone={setShowDone}
        showQuiet={showQuiet}
        setShowQuiet={setShowQuiet}
        hidden={hidden}
        onRename={setRenamingTask}
        onIgnore={ignoreAsk}
      />
    )
  const viewerSess = byId.get(viewerSession ?? route.s ?? '')
  // A viewer pushed on top of the view goes back (no duplicate entry of the view stays behind).
  const closeViewer = () => (history.state?.viewer ? history.back() : app.navigate({ f: null }, { push: false }))
  // Tablet: two panes. On a task or an agent the sidebar folds away (the rail's ☰ shows it again).
  const showSidebar = !isPhone && (!isTablet || view === 'board' || view === 'search' || view === 'agents' || sbOpen)
  // Phone: the agent's sheet (its tasks, terminal, shell, files) is a history entry (#…&tab=tasks): back closes it.
  const sheet = isPhone && (view === 'agent' || view === 'alltasks') && route.tab === 'tasks'
  const wide = (view === 'agent' || view === 'alltasks') && (shownPanes.length > 0 || sheet)
  const sbW = clamp(layout.v3SidebarW ?? 236, 200, 480)
  const style = {
    '--v-sb-w': sbW + 'px',
    '--v-tasks-w': tasksW + 'px',
    ...(layout.v3SideW ? { '--v-side-w': layout.v3SideW + 'px' } : {}),
    ...(layout.v3WideW ? { '--v-wide-w': layout.v3WideW + 'px' } : {}),
  } as React.CSSProperties
  // The side panes' edges: on their left.
  // An agent's side pane's edge (on the stream's side of it): up to as wide as leaves the stream MIN_STREAM.
  // (A declaration: StreamView above gets it.)
  function dragPane(p: PaneKind) {
    return (dx: number, start: number) => {
      const now = document.querySelector<HTMLElement>(`.v-main > [data-side-pane="${p}"]`)?.offsetWidth ?? start
      const col = document.querySelector<HTMLElement>('.v-main > .v-col')?.offsetWidth ?? MIN_STREAM
      const w = clamp(start + -dx / zoom, MIN_PANE, Math.max(MIN_PANE, now + col - MIN_STREAM))
      // The others keep the widths they show now (squeezed ones too), so only this one moves.
      const others = Object.fromEntries(shownPanes.filter((q) => q !== p).map((q) => [q, fitted.widths[q]]))
      setLayout({ v3PaneW: { ...layout.v3PaneW, ...others, [p]: Math.round(w) } })
    }
  }
  const dragTasks = (dx: number, start: number) => setLayout({ v3TasksW: Math.round(clamp(start + dx / zoom, 200, 480)) })
  const dragSidebar = (dx: number, start: number) => setLayout({ v3SidebarW: Math.round(clamp(start + dx / zoom, 200, Math.max(200, Math.min(480, winW - railWidth(layout) - 360)))) })
  const layoutKind = isPhone ? 'phone' : isTablet ? 'tablet' : 'desktop'
  return (
    <div className="v-app" data-testid="v3-app" data-view={view} data-layout={layoutKind} data-panes={view === 'agent' ? shownPanes.join(' ') : undefined} style={style}>
      {!isPhone && (
        <div className="v-rail" data-testid="rail-column" style={{ width: railWidth(layout), flex: 'none', borderRight: '1px solid var(--mb-line)', display: 'flex', flexDirection: 'column' }}>
          {isTablet && !showSidebar && (
            <button type="button" className="v-railbtn" data-testid="sidebar-toggle" aria-label="Show the sidebar" title="Board, Search and the agents" onClick={() => setSbOpen(true)}>
              <IconMenu size={18} />
            </button>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            <ProjectRail />
          </div>
        </div>
      )}
      {showSidebar && (
        <nav className="v-sidebar" data-testid="sidebar">
          <ConnectionBanner />
          <PairRequestBanner />
          <NotificationAsk />
          <div style={{ height: 8 }} />
          <button type="button" className={'v-sb-item' + (view === 'board' ? ' sel' : '')} data-testid="nav-board" onClick={nav.board}>
            <IconBoard /> Board <span className="v-cnt">{needs > 0 && <span className="v-badge w" data-testid="board-badge">{needs}</span>}</span>
          </button>
          <button type="button" className={'v-sb-item' + (view === 'search' ? ' sel' : '')} data-testid="nav-search" onClick={nav.search}>
            <IconSearch /> Search{' '}
            <span className="v-cnt">
              <span className="v-kbd">/</span>
            </span>
          </button>
          <button type="button" className="v-sb-item" data-testid="open-palette" onClick={() => setOverlay({ kind: 'palette' })}>
            <IconCommand /> Quick actions{' '}
            <span className="v-cnt">
              <span className="v-kbd">{isMac() ? '⌘K' : 'Ctrl+K'}</span>
            </span>
          </button>
          <div className="v-sb-h">
            AGENTS <span title={project?.dir}>{project?.name ?? 'all projects'}</span>
            {project && <NewAgentButton project={project} onNewAgent={newAgentIn} />}
          </div>
          <div className="v-agents" data-testid="agents">
            {agents.length > 0 && <AllAgentsRow agents={agents} tasks={tasks} sel={view === 'alltasks'} counts={board?.agents ?? {}} />}
            <AgentGroups agents={agents} shells={shells} sel={view === 'agent' ? route.s : null} counts={board?.agents ?? {}} grouped={!projectId} onRename={setRenaming} onNewAgent={newAgentIn} />
            {agents.length === 0 && shells.length === 0 && <NoAgents noProjects={!project && !app.projects?.length} onNewAgent={newAgentIn} />}
          </div>
        </nav>
      )}
      {showSidebar && <Resizer testid="sidebar-resizer" className="v-rz-sb" measure={() => document.querySelector<HTMLElement>('.v-sidebar')?.offsetWidth ?? sbW} onDrag={dragSidebar} />}
      {hasTasks && view === 'agent' && <TasksPane tasks={board?.tasks ?? []} sessionId={route.s!} shown={tasksShown} overlay={tasksCompact} onToggle={showTasks} />}
      {hasTasks && view === 'alltasks' && <AllTasksPane tasks={board?.tasks ?? []} agents={agents} shown={tasksShown} overlay={tasksCompact} onToggle={showTasks} />}
      {hasTasks && tasksShown && !tasksCompact && <Resizer testid="tasks-resizer" className="v-rz-tasks" measure={() => document.querySelector<HTMLElement>('.v-tasks')?.offsetWidth ?? tasksW} onDrag={dragTasks} />}
      {isPhone && (
        <>
          <ConnectionBanner />
          <PairRequestBanner />
          <NotificationAsk />
        </>
      )}
      <main className={'v-main' + (wide ? ' wide' : '') + ((view === 'agent' || view === 'alltasks') && !wide ? ' conv' : '')}>
        {main}
      </main>
      {isPhone && (
        <div className="v-tabs" data-testid="phone-tabs">
          {(
            [
              ['board', IconTabBoard, 'Board', needs, 'w'],
              ['agents', IconTabAgents, 'Agents', unread, 'u'],
              ['search', IconTabSearch, 'Search', 0, ''],
            ] as const
          ).map(([v, I, l, c, k]) => (
            <button
              type="button"
              key={v}
              data-testid={'tab-' + v}
              className={view === v || (v === 'agents' && (view === 'agent' || view === 'alltasks')) || (v === 'board' && view === 'task') ? 'on' : ''}
              onClick={() => (v === 'board' ? nav.board() : v === 'agents' ? nav.agents() : nav.search())}
            >
              <I size={22} strokeWidth={1.75} aria-hidden />
              {l}
              {c > 0 && <span className={'v-badge ' + k}>{c}</span>}
            </button>
          ))}
        </div>
      )}
      {overlay?.kind === 'palette' && <V3Palette ctx={paletteCtx} onClose={() => setOverlay(null)} />}
      {renaming && <RenameAgentDialog session={renaming} onClose={() => setRenaming(null)} />}
      {renamingTask && (
        <RenameTaskDialog
          task={renamingTask}
          onClose={() => setRenamingTask(null)}
          onShow={(title) => setBoard((b) => (b ? { ...b, tasks: b.tasks.map((x) => (x.id === renamingTask.id ? { ...x, title } : x)) } : b))}
          onSaved={reloadBoard}
        />
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

type Counts = Record<string, { unread: number; open_questions: number }>

/** The agents (grouped by project when all projects are shown, as main's session list was), then the plain shells. */
/** The ＋ on a project's header in the agent list: a new agent in that project (its folder, host and default agent). */
function NewAgentButton({ project, onNewAgent }: { project: { id: string; name: string }; onNewAgent: (projectId?: string) => void }) {
  return (
    <button
      type="button"
      className="v-proj-new"
      data-testid="project-new-agent"
      data-project={project.id}
      aria-label={'New agent in ' + project.name}
      title={'New agent in ' + project.name}
      onClick={(e) => {
        e.stopPropagation()
        onNewAgent(project.id)
      }}
    >
      <IconPlus size={14} strokeWidth={2} aria-hidden />
    </button>
  )
}

/** The agents, under their project's header (all projects; on the phone, one project's too). Each project's
 *  header has a ＋ for a new agent in it; with no agents at all, every project is listed with its ＋. */
function AgentGroups({ agents, shells, sel, counts, grouped, head, onRename, onNewAgent }: { agents: Session[]; shells: Session[]; sel: string | null; counts: Counts; grouped: boolean; head?: { id: string; name: string }; onRename: (s: Session) => void; onNewAgent: (projectId?: string) => void }) {
  const { projects } = useApp()
  const groups = useMemo(() => {
    if (!grouped) return [{ id: head?.id ?? '', name: head?.name ?? '', rows: agents }]
    // No agents yet: each project, empty, so its ＋ starts the first one.
    if (agents.length === 0) return (projects ?? []).map((p) => ({ id: p.id, name: p.name, rows: [] as Session[] }))
    const by = new Map<string, Session[]>()
    for (const a of agents) {
      const k = a.project_id ?? ''
      if (!by.has(k)) by.set(k, [])
      by.get(k)!.push(a)
    }
    // A project with an agent that waits or has news first, then as the rail orders them.
    const order = (projects ?? []).map((p) => p.id)
    return [...by.entries()]
      .sort(([a], [b]) => (order.indexOf(a) < 0 ? 1e9 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 1e9 : order.indexOf(b)))
      .map(([id, rows]) => ({ id, name: projects?.find((p) => p.id === id)?.name ?? 'No project', rows }))
  }, [agents, grouped, projects, head?.id, head?.name]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {groups.map((g) => (
        <div key={g.id} data-testid="agent-group" data-project={g.id}>
          {(grouped || head) && (
            <div className="v-ag-proj" data-testid="agent-group-head">
              <span className="v-proj-dot" style={projectHueStyle(g.id)} />
              <span className="v-ag-proj-nm" data-testid="agent-group-name">
                {g.name}
              </span>
              {g.id && <NewAgentButton project={g} onNewAgent={onNewAgent} />}
            </div>
          )}
          {g.rows.map((a) => (
            <AgentRow key={a.id} a={a} sel={sel === a.id} counts={counts[a.id]} onRename={onRename} />
          ))}
        </div>
      ))}
      {shells.length > 0 && (
        <div data-testid="shell-group">
          <div className="v-ag-proj">SHELLS</div>
          {shells.map((a) => (
            <AgentRow key={a.id} a={a} sel={sel === a.id} onRename={onRename} />
          ))}
        </div>
      )}
    </>
  )
}

/** All agents, at the top of the agents list: the tasks of every agent listed, in one list (#v=alltasks). */
function AllAgentsRow({ agents, tasks, sel, counts }: { agents: Session[]; tasks: BoardTask[]; sel: boolean; counts: Counts }) {
  const { navigate } = useApp()
  const ids = agents.map((a) => a.id)
  const open = agentTasks(tasks, ids).open.length
  const u = ids.reduce((n, id) => n + (counts[id]?.unread ?? 0), 0)
  return (
    <button
      type="button"
      className={'v-ag v-ag-all' + (sel ? ' sel' : '')}
      data-testid="all-agents-row"
      aria-current={sel || undefined}
      title="The tasks of every agent in one list"
      onClick={() => navigate({ view: 'alltasks', s: null, k: null, m: null, tab: 'inbox' }, { push: !sel })}
    >
      <IconTasks size={12} className="v-ag-all-i" />
      <span className="v-nm v-tline">
        <span>All agents</span>
      </span>
      {u > 0 ? <span className="v-badge u">{u}</span> : <span />}
      <span className="v-doing">
        {open} open {open === 1 ? 'task' : 'tasks'} · {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
      </span>
    </button>
  )
}

function AgentRow({ a, sel, counts, onRename }: { a: Session; sel: boolean; counts?: { unread: number; open_questions: number }; onRename: (s: Session) => void }) {
  const { sessions, navigate } = useApp()
  const hint = agentHint(sessions ?? [], a)
  const u = counts?.unread ?? 0
  const waits = (counts?.open_questions ?? 0) > 0
  // Right-click / long press / Shift+F10: the session menu (rename, restart, stop, archive, delete).
  const menu = useContextMenu()
  const shell = a.kind === 'shell'
  return (
    <>
      <button
        type="button"
        className={'v-ag' + (sel ? ' sel' : '')}
        data-testid="agent-row"
        data-session={a.id}
        data-kind={a.kind}
        title={shell ? 'A plain shell: opens on its terminal' : 'Double-click to rename · right-click for actions'}
        {...menu.props}
        onClick={() => navigate({ view: 'agent', s: a.id, m: null, tab: shell ? 'terminal' : 'inbox' }, { push: true })}
        onDoubleClick={() => onRename(a)}
      >
        <span className={'v-dot ' + (a.status === 'working' ? 'd-work v-live' : waits ? 'd-wait' : a.status === 'ended' ? 'd-done' : 'd-idle')} />
        <span className="v-nm v-tline">
          <span>{a.name}</span>
          <StaleMark session={a} />
          <small>
            {hint ? hint + ' · ' : ''}
            {shell ? 'shell' : agentKindLabel(a.agent)}
            {a.host_name && a.host_id !== 'local' ? ' · ' + a.host_name : ''}
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
      <SessionMenu s={a} anchor={null} at={menu.at} onClose={menu.close} onRename={() => onRename(a)} />
    </>
  )
}

function AgentsList({ agents, shells, counts, tasks, onNewAgent, onRename }: { agents: Session[]; shells: Session[]; counts: Counts; tasks: BoardTask[]; onNewAgent: (projectId?: string) => void; onRename: (s: Session) => void }) {
  const { navigate, setOverlay, projects } = useApp()
  const { id, project } = useSelectedProject()
  return (
    <div className="v-col" data-testid="agents-view">
      <div className="v-head">
        <div className="v-r1">
          <BackButton />
          <h1>Agents</h1>
          <button type="button" className="v-btn" data-testid="open-palette" aria-label="Quick actions" onClick={() => setOverlay({ kind: 'palette' })}>
            <IconCommand size={14} />
          </button>
          <button type="button" className="v-btn" data-testid="open-settings-phone" onClick={() => navigate({ view: 'settings' }, { push: true })}>
            Settings
          </button>
        </div>
        <div className="v-r2">
          <PhoneProjectButton />
        </div>
      </div>
      <div className="v-scroll" style={{ background: 'var(--mb-surface)' }}>
        {agents.length > 0 && <AllAgentsRow agents={agents} tasks={tasks} sel={false} counts={counts} />}
        <AgentGroups agents={agents} shells={shells} sel={null} counts={counts} grouped={!id} head={project ? { id: project.id, name: project.name } : undefined} onRename={onRename} onNewAgent={onNewAgent} />
        {agents.length === 0 && shells.length === 0 && <NoAgents noProjects={!project && !projects?.length} onNewAgent={onNewAgent} />}
      </div>
    </div>
  )
}

/** No agents: a project's ＋ starts one; with no project at all yet, the New agent dialog (a folder) from here. */
function NoAgents({ noProjects, onNewAgent }: { noProjects: boolean; onNewAgent: (projectId?: string) => void }) {
  if (!noProjects) return <div className="v-empty">No agents yet. Start one with the ＋ beside its project.</div>
  return (
    <div className="v-empty">
      No agents yet.{' '}
      <button type="button" className="v-link" data-testid="first-agent" onClick={() => onNewAgent()}>
        Start one in a folder…
      </button>
    </div>
  )
}

/**
 * ⇧N: a message to an agent or to a new agent. The agent decides what it is. With a project selected the
 * default is "Let minbox choose": the server's helper picks one of the project's running agents whose work
 * fits, else a new agent starts (POST /api/v3/new without to). Otherwise the most recently active agent.
 */
function NewMessageDialog({ agents, initialTo, onClose }: { agents: Session[]; initialTo?: string; onClose: () => void }) {
  const { error, projects, toast, setOverlay } = useApp()
  const { id: projectId } = useSelectedProject()
  const nav = useNav()
  const canAuto = !!projectId && agents.length > 0
  const [to, setTo] = useState(initialTo ?? (canAuto ? 'auto' : agents[0]?.id ?? 'new'))
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const compose = useComposeFiles('v3:new')
  const { files, addFiles, addPastedText, remove } = compose
  const io = fileInputHandlers(addFiles, addPastedText)
  const fileInput = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const mention = useMentions({ sessionId: to !== 'new' && to !== 'auto' ? to : null, value: body, onChange: setBody, inputRef: bodyRef, agents: false })
  const uploading = files.some((f) => f.state === 'uploading')
  const canSend = (!!body.trim() || files.some((f) => f.state === 'done')) && !uploading && !busy
  const project = projectId || (to !== 'new' && to !== 'auto' ? agents.find((a) => a.id === to)?.project_id : '') || projects?.[0]?.id || ''
  const send = async () => {
    if (!canSend) return
    setBusy(true)
    try {
      const ups = uploadIds('v3:new')
      const m = await v3.newMessage({ to: to === 'auto' ? '' : to, project_id: project, words: body.trim(), name: to === 'new' ? name.trim() : undefined, uploads: ups.length ? ups : undefined })
      clearFiles('v3:new')
      onClose()
      const sid = to === 'new' || to === 'auto' ? undefined : to
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
            {canAuto && <option value="auto">Let minbox choose (an agent whose work fits, else a new one)</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {agentHint(agents, a) ? ` (${agentHint(agents, a)})` : ''} · {agentKindLabel(a.agent)}
                {a.title ? ' — ' + a.title.slice(0, 40) : ''}
              </option>
            ))}
            <option value="new">New agent…</option>
          </select>
          {to === 'new' && <input type="text" aria-label="Agent name" placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />}
          {to === 'new' && (
            <button type="button" className="v-link" data-testid="new-agent-options" title="Choose the agent's kind (Claude Code, Pi, OpenCode), folder and host" onClick={() => setOverlay({ kind: 'new-session', projectId: projectId || undefined })}>
              Kind, folder, host…
            </button>
          )}
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
          <span className="v-hide-phone">The agent files it under a task when it is work. Esc closes.</span>
          <span className="v-sp" />
          <button type="button" className="v-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="v-btn pri" data-testid="new-send" disabled={!canSend} onClick={() => void send()} title={`Send (${isMac() ? '⌘↵' : 'Ctrl+Enter'})`}>
            Send
            <SendKey />
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
  const mod = isMac() ? '⌘' : 'Ctrl+'
  const rows: [string, string][] = [
    ['?', 'This help'],
    [mod + 'K', 'Quick actions: go to a task, an agent or a project, or run an action (> actions · @ agents · # tasks · ! projects)'],
    ['⇧N', 'New message (minbox picks the agent by default)'],
    ['/', 'Search'],
    ['g b · g a', 'Board · first agent'],
    ['J / K', 'Move on the Board'],
    ['Enter', 'Open the task (a question: its task, at the question, to answer it)'],
    ['⌘↵', 'Send the message (with any answers picked in the task or stream)'],
    ['X', 'Done / reopen the focused task'],
    ['I', 'Ignore the focused question (no longer relevant; the agent is not told)'],
    ['E · F2', 'Rename the task (the open one, or the focused Board row)'],
    ['Z', 'Undo the last action (done, archive)'],
    ['N', 'Next agent with unread messages'],
    ['R', 'Reply: quote the selected text, or focus the reply box'],
    ['T', 'Terminal of the agent (show / hide; it stands beside the shell and the files)'],
    ['⇧T', 'Tasks pane of the agent (show / fold); check tasks there to see them side by side'],
    ['Ctrl+`', 'Shell of the agent (show / hide)'],
    ['⇧F', 'Files of the agent (show / hide)'],
    ['⇧D', 'Decision mode (when on in Settings)'],
    ['Esc', 'Close / back (where you came from, else the Board)'],
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
        <p className="v-help-note">New agent: the ＋ beside a project&apos;s name in the agent list (or {mod}K › New agent).</p>
      </div>
    </div>
  )
}
