import { useEffect, useRef, useState } from 'react'
import { AppProvider, useApp } from './lib/app'
import { useHotkeys } from './lib/hotkeys'
import { AttachmentViewer } from './components/AttachmentViewer'
import { AllInboxPage } from './components/AllInbox'
import { BoardPage } from './components/Board'
import { Compose } from './components/Compose'
import { GuidedReview } from './components/GuidedReview'
import { InboxPane } from './components/InboxPane'
import { DecisionMode, DeleteSession, DraftsList, Shortcuts, Toasts } from './components/Overlays'
import { PhoneApp } from './components/Phone'
import { NewSessionDialog } from './components/NewSession'
import { DeviceGate } from './components/Devices'
import { SearchPalette } from './components/SearchPalette'
import { SettingsPage } from './components/Settings'
import { Sidebar } from './components/Sidebar'
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

  // Desktop: keep a session selected (the first live one), and drop a deleted one.
  useEffect(() => {
    if (!sessions) return
    if (route.s && sessions.some((s) => s.id === route.s)) return
    if (isPhone) {
      if (route.s) navigate({ s: null }, { push: false })
      return
    }
    const first = sessions.find((s) => !s.archived_at) ?? sessions[0]
    navigate({ s: first?.id ?? null, t: null, f: null })
  }, [sessions, route.s, isPhone, navigate])

  // First run: nothing to show yet, so offer to start a session.
  const offered = useRef(false)
  useEffect(() => {
    if (!sessions || offered.current) return
    offered.current = true
    if (sessions.length === 0 && route.view === 'main') setOverlay({ kind: 'new-session' })
  }, [sessions, route.view, setOverlay])

  useHotkeys({
    'mod+k': () => setOverlay({ kind: 'search' }),
    '/': () => setOverlay({ kind: 'search' }),
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
      ) : route.view === 'inbox' ? (
        <AllInboxPage />
      ) : isPhone ? (
        <PhoneApp />
      ) : (
        <Desktop />
      )}
      {route.view === 'review' && route.r && <GuidedReview attachmentId={route.r} />}
      {overlay?.kind === 'search' && <SearchPalette onClose={close} />}
      {overlay?.kind === 'shortcuts' && <Shortcuts onClose={close} />}
      {overlay?.kind === 'decide' && <DecisionMode onClose={close} />}
      {overlay?.kind === 'compose' && <Compose sessionId={overlay.sessionId} draftId={overlay.draftId} onClose={close} />}
      {overlay?.kind === 'delete-session' && <DeleteSession session={overlay.session} onClose={close} />}
      {overlay?.kind === 'drafts' && <DraftsList onClose={close} />}
      {overlay?.kind === 'new-session' && <NewSessionDialog onClose={close} />}
      <Toasts />
    </>
  )
}

function Desktop() {
  const { route, sessions, layout, setLayout, settings } = useApp()
  const session = sessions?.find((s) => s.id === route.s) ?? null
  // Text size zooms the page: columns are measured in zoomed pixels.
  const width = useWindowWidth() / ((settings.text_size || 13) / 13)
  const showInbox = !!session && session.kind !== 'shell' && !layout.inboxCollapsed
  // An open file takes the center: the session list folds into its rail.
  // A narrow window gives way in this order: the session list narrows, then folds into its rail,
  // then the inbox narrows. The inbox keeps the width it was dragged to as long as it fits, so a
  // drag moves the edge 1:1 (shrinking both columns at once made it follow at half the distance).
  const MIN_CENTER = 420
  let sidebarW = layout.sidebarW
  let inboxW = showInbox ? (route.f ? Math.min(layout.inboxW, 400) : layout.inboxW) : 0
  let rail = layout.rail || !!route.f
  const over = () => (rail ? 60 : sidebarW) + inboxW + MIN_CENTER - width
  if (!rail && over() > 0) sidebarW = Math.max(216, sidebarW - over())
  if (!rail && over() > 0) rail = true
  if (showInbox && over() > 0) inboxW = Math.max(320, inboxW - over())
  // The browser reports a drag in screen pixels; the columns are in zoomed ones.
  const zoom = (settings.text_size || 13) / 13
  // Several pointer moves can arrive before a re-render: each one adds to the width the last one set.
  const cur = useRef({ sidebarW, inboxW })
  cur.current = { sidebarW, inboxW }
  const dragSidebar = (dx: number) => {
    cur.current.sidebarW = clamp(cur.current.sidebarW + dx / zoom, 216, 480)
    setLayout({ sidebarW: cur.current.sidebarW })
  }
  const dragInbox = (dx: number) => {
    cur.current.inboxW = clamp(cur.current.inboxW - dx / zoom, 320, 760)
    setLayout({ inboxW: cur.current.inboxW })
  }
  return (
    <div className="flex h-full w-full overflow-hidden bg-bg" data-testid="desktop">
      <div style={{ width: rail ? 60 : sidebarW }} className="shrink-0 border-r border-line">
        <Sidebar forceRail={rail} />
      </div>
      {!rail && <Resizer onDrag={dragSidebar} />}
      <main className="min-w-0 flex-1">
        {route.f && session ? <AttachmentViewer attachmentId={route.f} sessionName={session.name} sessionCwd={session.cwd} /> : <TerminalPane session={session} />}
      </main>
      {showInbox && (
        <>
          <Resizer grip onDrag={dragInbox} />
          <div style={{ width: inboxW }} className="shrink-0">
            <InboxPane session={session} />
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
function Resizer({ onDrag, grip }: { onDrag: (dx: number) => void; grip?: boolean }) {
  const last = useRef<number | null>(null)
  return (
    <div
      aria-hidden="true"
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
