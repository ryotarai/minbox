import { useEffect, useRef, useState } from 'react'
import { AppProvider, useApp } from './lib/app'
import { useHotkeys } from './lib/hotkeys'
import { AttachmentViewer } from './components/AttachmentViewer'
import { BoardPage } from './components/Board'
import { Compose } from './components/Compose'
import { GuidedReview } from './components/GuidedReview'
import { ThreadPane } from './components/ThreadPane'
import { ThreadsPane } from './components/ThreadsPane'
import { DecisionMode, DeleteSession, DraftsList, Shortcuts, Toasts } from './components/Overlays'
import { PhoneApp } from './components/Phone'
import { ProjectRail } from './components/ProjectRail'
import { selectProject, useSelectedProject } from './lib/projects'
import { NewSessionDialog } from './components/NewSession'
import { DeviceGate } from './components/Devices'
import { Palette } from './components/Palette'
import { SettingsPage } from './components/Settings'
import { ShellPane } from './components/ShellPane'
import { Rail, groupSessions } from './components/Sidebar'
import { TerminalPane } from './components/TerminalPane'

export function App() {
  return (
    <DeviceGate>
      <AppProvider>
        <Root />
      </AppProvider>
    </DeviceGate>
  )
}

function Root() {
  const { route, sessions, navigate, isPhone, overlay, setOverlay, undoLast, settings } = useApp()

  // Desktop: keep a session selected (the one that needs you most, in the selected project), and drop a deleted one.
  // A session outside the selected project: when the person switched project, pick one inside it;
  // when the route moved there (palette, link), the project follows the session.
  const { id: projectId } = useSelectedProject()
  const lastProject = useRef(projectId)
  useEffect(() => {
    if (!sessions) return
    const switched = lastProject.current !== projectId
    lastProject.current = projectId
    const cur = sessions.find((s) => s.id === route.s)
    if (isPhone) {
      if (route.s && !cur) navigate({ s: null, t: null }, { push: false })
      return
    }
    if (cur && (!projectId || cur.project_id === projectId)) return
    if (cur && !switched && cur.project_id) {
      selectProject(cur.project_id)
      return
    }
    const live = sessions.filter((s) => !s.archived_at && (!projectId || s.project_id === projectId))
    const first = groupSessions(live)[0]?.rows[0] ?? (projectId ? undefined : sessions[0])
    if (!first && !route.s) return
    navigate({ s: first?.id ?? null, t: null, f: null })
  }, [sessions, route.s, isPhone, navigate, projectId])
  // The old All inbox page is the main screen's list now.
  useEffect(() => {
    if ((route.view as string) === 'inbox') navigate({ view: 'main' }, { push: false })
  }, [route.view, navigate])

  // First run: nothing to show yet, so offer to start a session.
  const offered = useRef(false)
  useEffect(() => {
    if (!sessions || offered.current) return
    offered.current = true
    if (sessions.length === 0 && route.view === 'main') setOverlay({ kind: 'new-session' })
  }, [sessions, route.view, setOverlay])

  useHotkeys({
    'mod+k': () => setOverlay(overlay?.kind === 'palette' ? null : { kind: 'palette' }),
    '/': () => setOverlay({ kind: 'palette' }),
    '?': () => setOverlay({ kind: 'shortcuts' }),
    z: () => undoLast(),
    'shift+d': () => {
      if (!settings.decision_mode) return false
      setOverlay({ kind: 'decide' })
    },
  })

  const close = () => setOverlay(null)
  return (
    <>
      {route.view === 'settings' ? (
        <SettingsPage />
      ) : route.view === 'board' ? (
        <BoardPage />
      ) : isPhone ? (
        <PhoneApp />
      ) : (
        <Desktop />
      )}
      {route.view === 'review' && route.r && <GuidedReview attachmentId={route.r} />}
      {overlay?.kind === 'palette' && <Palette onClose={close} />}
      {overlay?.kind === 'shortcuts' && <Shortcuts onClose={close} />}
      {overlay?.kind === 'decide' && <DecisionMode onClose={close} />}
      {overlay?.kind === 'compose' && <Compose sessionId={overlay.sessionId} draftId={overlay.draftId} onClose={close} />}
      {overlay?.kind === 'delete-session' && <DeleteSession session={overlay.session} onClose={close} />}
      {overlay?.kind === 'drafts' && <DraftsList onClose={close} />}
      {overlay?.kind === 'new-session' && <NewSessionDialog projectId={overlay.projectId} onClose={close} />}
      {overlay?.kind === 'new-project' && <NewSessionDialog mode="project" onClose={close} />}
      {overlay?.kind === 'edit-project' && <NewSessionDialog mode="project-edit" project={overlay.project} onClose={close} />}
      <Toasts />
    </>
  )
}

/**
 * Threads first: [Threads | Thread | Terminal | Shell]. The threads list holds every session's
 * threads; picking one selects its session too, so the thread and the terminal move together.
 * The terminal is the flexible column. Swapped panes put the thread on the far right.
 */
function Desktop() {
  const { route, sessions, layout, setLayout, settings } = useApp()
  const session = sessions?.find((s) => s.id === route.s) ?? null
  // Text size zooms the page: columns are measured in zoomed pixels.
  const width = useWindowWidth() / ((settings.text_size || 13) / 13)
  // A narrow window gives way in this order: the shell pane narrows and goes, the threads list
  // narrows then folds into its rail, the thread pane narrows. The terminal keeps MIN_CENTER.
  // A column keeps the width it was dragged to as long as it fits, so a drag moves the edge 1:1.
  const MIN_CENTER = 360
  const showShell = !!session && session.kind !== 'shell' && session.status !== 'ended' && layout.shellPane
  let shellW = showShell ? layout.shellW : 0
  let listW = layout.sidebarW
  let threadW = layout.threadW
  // An open file takes the center: the threads list folds into its rail.
  let rail = layout.rail || !!route.f
  // The project column (far left): names, or 56 px tiles when the window is narrow or the person asks.
  const projNarrow = layout.projectsRail ?? width < 1400
  const projW = projNarrow ? 56 : 176
  // The project column is paid for by the thread pane first (down to 440), then the threads list
  // (down to 280), so the terminal keeps about the width it had before projects.
  {
    let rest = projW
    const fromThread = Math.min(rest, Math.max(0, threadW - 440))
    threadW -= fromThread
    rest -= fromThread
    listW -= Math.min(rest, Math.max(0, listW - 280))
  }
  const over = () => projW + (rail ? 60 : listW) + threadW + (shellW ? shellW + 9 : 0) + MIN_CENTER + 18 - width
  const shrink = (w: number, min: number) => Math.max(Math.min(w, min), w - over())
  if (shellW && over() > 0) shellW = shrink(shellW, 280)
  if (!rail && over() > 0) listW = shrink(listW, 240)
  if (over() > 0) threadW = shrink(threadW, 380)
  if (shellW && over() > 0) shellW = 0
  if (!rail && over() > 0) rail = true
  if (over() > 0) threadW = shrink(threadW, 320)
  // The browser reports a drag in screen pixels; the columns are in zoomed ones.
  const zoom = (settings.text_size || 13) / 13
  // Several pointer moves can arrive before a re-render: each one adds to the width the last one set.
  const cur = useRef({ listW, threadW, shellW })
  cur.current = { listW, threadW, shellW }
  const dragList = (dx: number) => {
    cur.current.listW = clamp(cur.current.listW + dx / zoom, 240, 560)
    setLayout({ sidebarW: cur.current.listW })
  }
  // dx is positive when the edge moves right and widens the column on its left.
  const dragThread = (dx: number) => {
    cur.current.threadW = clamp(cur.current.threadW + dx / zoom, 320, 900)
    setLayout({ threadW: cur.current.threadW })
  }
  const dragShell = (dx: number) => {
    cur.current.shellW = clamp(cur.current.shellW + dx / zoom, 280, 900)
    setLayout({ shellW: cur.current.shellW })
  }
  // Ctrl+` shows and hides the shell pane; it works inside the terminals too, so it is caught
  // before they see it.
  const canShell = !!session && session.kind !== 'shell'
  const toggleShell = useRef<() => void>(() => {})
  toggleShell.current = () => {
    if (canShell) setLayout({ shellPane: !layout.shellPane })
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== '`' || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      toggleShell.current()
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [])
  useHotkeys({ 'mod+b': () => setLayout({ rail: !layout.rail }) })
  // CSS order, not element order: swapping the panes does not remount the terminal.
  const swap = !settings.swap_panes
  const o = swap ? { thread: 6, rzThread: 5, main: 2, rzShell: 3, shell: 4 } : { thread: 2, rzThread: 3, main: 4, rzShell: 5, shell: 6 }
  return (
    <div className="flex h-full w-full overflow-hidden bg-bg" data-testid="desktop">
      <div style={{ width: projW, order: -1 }} className="shrink-0 border-r border-line">
        <ProjectRail narrow={projNarrow} />
      </div>
      <div style={{ width: rail ? 60 : listW, order: 0 }} className="shrink-0 border-r border-line">
        {rail ? <Rail /> : <ThreadsPane />}
      </div>
      {!rail && <Resizer order={1} onDrag={dragList} />}
      <div style={{ width: threadW, order: o.thread }} className="shrink-0">
        <ThreadPane session={session} />
      </div>
      <Resizer grip order={o.rzThread} onDrag={(dx) => dragThread(swap ? -dx : dx)} />
      <main style={{ order: o.main }} className="min-w-0 flex-1">
        {route.f && session ? <AttachmentViewer attachmentId={route.f} sessionName={session.name} sessionCwd={session.cwd} /> : <TerminalPane session={session} />}
      </main>
      {shellW > 0 && session && (
        <>
          <Resizer grip order={o.rzShell} onDrag={(dx) => dragShell(-dx)} />
          <div style={{ width: shellW, order: o.shell }} className="shrink-0">
            <ShellPane session={session} onClose={() => setLayout({ shellPane: false })} />
          </div>
        </>
      )}
    </div>
  )
}

function useWindowWidth(): number {
  const [w, setW] = useState(window.innerWidth)
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

/** A column edge: drag to resize. */
function Resizer({ onDrag, grip, order }: { onDrag: (dx: number) => void; grip?: boolean; order?: number }) {
  const last = useRef<number | null>(null)
  return (
    <div
      aria-hidden="true"
      style={{ order }}
      data-testid="resizer"
      onPointerDown={(e) => {
        last.current = e.clientX
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (last.current === null) return
        const dx = e.clientX - last.current
        last.current = e.clientX
        if (dx) onDrag(dx)
      }}
      onPointerUp={() => (last.current = null)}
      onPointerCancel={() => (last.current = null)}
      // touch-none: a finger drag moves the edge instead of scrolling or swiping the page.
      className="group relative z-[1] -mx-1 flex w-[9px] shrink-0 touch-none cursor-col-resize items-center justify-center"
    >
      {/* A wider grab area for a finger (tablets, unfolded foldables); it overlaps the panes but draws nothing. */}
      <div className="absolute inset-0 pointer-coarse:-inset-x-3" />
      <div className="absolute inset-y-0 left-1 w-px bg-line group-hover:bg-linestrong" />
      {grip && <div className="relative h-8 w-1 rounded-sm bg-[#52525b] pointer-coarse:h-12 pointer-coarse:w-1.5" />}
    </div>
  )
}
