import { useEffect } from 'react'
import { V3App } from './v3/V3App'
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


  useHotkeys({
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
      ) : route.view === 'issues' ? (
        <IssuesScreen />
      ) : route.view === 'slack' ? (
        <SlackScreen />
      ) : (
        <V3App />
      )}
      {route.view === 'review' && route.r && <GuidedReview attachmentId={route.r} />}
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
