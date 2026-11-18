import { useEffect } from 'react'
import { V3App } from './v3/V3App'
import { V3Palette } from './v3/Palette'
import { AppProvider, useApp } from './lib/app'
import { useHotkeys } from './lib/hotkeys'
import { IssuesScreen } from './components/Issues'
import { SlackScreen } from './components/Slack'
import { GuidedReview } from './components/GuidedReview'
import { DecisionMode, DeleteProject, DeleteSession, DraftsList, Shortcuts, Toasts } from './components/Overlays'
import { ProjectIconDialog } from './components/ProjectRail'
import { NewSessionDialog } from './components/NewSession'
import { DeviceGate } from './components/Devices'
import { SettingsPage } from './components/Settings'

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
  const { route, navigate, overlay, setOverlay, undoLast, settings } = useApp()

  // Older links: the All inbox, Topics, Board and Tasks pages are the v3 Board now.
  useEffect(() => {
    if ((route.view as string) === 'inbox' || route.view === 'tasks') navigate({ view: 'main' }, { push: false })
  }, [route.view, navigate])
  // An older session or thread link (#s=…[&t=…]) opens that agent's stream.
  useEffect(() => {
    if (route.view === 'main' && route.s) navigate({ view: 'agent', t: null }, { push: false })
  }, [route.view, route.s, route.t, navigate])


  // ⌘K everywhere (also inside a terminal or a text box): the quick actions.
  useHotkeys({
    'mod+k': () => setOverlay(overlay?.kind === 'palette' ? null : { kind: 'palette' }),
    z: () => undoLast(),
    'shift+d': () => {
      if (!settings.decision_mode) return false
      setOverlay({ kind: 'decide' })
    },
  })

  const close = () => setOverlay(null)
  // Settings, My issues and Slack are not V3App's screens: the palette there has no agent of its own.
  const outside = route.view === 'settings' || route.view === 'issues' || route.view === 'slack'
  const toMain = (o: Parameters<typeof setOverlay>[0]) => {
    navigate({ view: 'main' }, { push: true })
    setOverlay(o)
  }
  return (
    <>
      {route.view === 'settings' ? (
        <SettingsPage />
      ) : route.view === 'issues' ? (
        <IssuesScreen />
      ) : route.view === 'slack' ? (
        <SlackScreen />
      ) : (
        <V3App />
      )}
      {route.view === 'review' && route.r && <GuidedReview attachmentId={route.r} />}
      {overlay?.kind === 'palette' && outside && (
        <V3Palette
          onClose={close}
          ctx={{
            agent: undefined,
            panes: [],
            togglePane: () => {},
            openNew: (to) => toMain({ kind: 'v3-new', to }),
            openNewAgent: () => setOverlay({ kind: 'new-session' }),
            openHelp: () => toMain({ kind: 'v3-help' }),
            rename: () => {},
          }}
        />
      )}
      {overlay?.kind === 'shortcuts' && <Shortcuts onClose={close} />}
      {overlay?.kind === 'decide' && <DecisionMode onClose={close} />}
      {overlay?.kind === 'delete-session' && <DeleteSession session={overlay.session} onClose={close} />}
      {overlay?.kind === 'drafts' && <DraftsList onClose={close} />}
      {overlay?.kind === 'new-session' && <NewSessionDialog projectId={overlay.projectId} onClose={close} />}
      {overlay?.kind === 'new-project' && <NewSessionDialog mode="project" onClose={close} />}
      {overlay?.kind === 'delete-project' && <DeleteProject project={overlay.project} onClose={close} />}
      {overlay?.kind === 'project-icon' && <ProjectIconDialog project={overlay.project} onClose={close} />}
      {overlay?.kind === 'edit-project' && <NewSessionDialog mode="project-edit" project={overlay.project} onClose={close} />}
      <Toasts />
    </>
  )
}
