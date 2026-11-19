// A running agent that loaded an older minbox mod or older instructions than a restart would give it
// (the server's stale / stale_reasons, see internal/server/stale.go): a banner under the agent's
// header with Restart, and a small mark on its row in the sidebar. Dismissing hides both for the
// version the agent runs (run_version); a restart, or another change, brings them back if needed.
import { useEffect, useState } from 'react'
import { api, type Session } from '../api'
import { useApp } from '../lib/app'

const KEY = 'minbox.staleDismissed'
const EVENT = 'minbox-stale-dismissed'

/** What a dismissal covers: the version the agent runs and the reasons shown for it. */
function dismissKey(s: Session): string {
  return `${s.run_version ?? ''}:${(s.stale_reasons ?? []).join(',')}`
}

function readDismissed(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function dismiss(s: Session) {
  const all = readDismissed()
  all[s.id] = dismissKey(s)
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // no storage: dismissed for this page only (the event below)
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id: s.id, key: all[s.id] } }))
}

/** Whether the agent's stale notice is up: stale and not dismissed for this version. */
export function useStaleShown(s: Session): boolean {
  const [dismissed, setDismissed] = useState<Record<string, string>>(readDismissed)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; key: string }>).detail
      setDismissed((cur) => ({ ...cur, ...readDismissed(), ...(d ? { [d.id]: d.key } : {}) }))
    }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  return !!s.stale && s.kind !== 'shell' && s.status !== 'ended' && dismissed[s.id] !== dismissKey(s)
}

/** What is older, in words. */
function what(s: Session): string {
  const r = s.stale_reasons ?? []
  if (r.includes('plugin')) return r.includes('prompt') ? 'an older minbox mod and instructions' : 'an older minbox mod'
  return 'older minbox instructions'
}

/** The banner under the agent's header. */
export function StaleAgentBanner({ session }: { session: Session }) {
  const { error } = useApp()
  const shown = useStaleShown(session)
  const [busy, setBusy] = useState(false)
  if (!shown) return null
  const restart = () => {
    setBusy(true)
    api
      .restartSession(session.id)
      .catch(error)
      .finally(() => setBusy(false))
  }
  return (
    <div className="v-stale" role="status" data-testid="stale-agent-banner" data-reasons={(session.stale_reasons ?? []).join(' ')}>
      <span className="v-stale-dot" aria-hidden="true" />
      <span className="v-stale-txt">This agent is running {what(session)}. Restart it to pick up the changes.</span>
      <span className="v-stale-acts">
        <button type="button" className="v-btn pri" data-testid="stale-agent-restart" disabled={busy} title="Restart the agent: it resumes its conversation with the current minbox" onClick={restart}>
          {busy ? 'Restarting…' : 'Restart'}
        </button>
        <button type="button" className="v-btn" data-testid="stale-agent-dismiss" title="Hide this until the agent's version changes" onClick={() => dismiss(session)}>
          Dismiss
        </button>
      </span>
    </div>
  )
}

/** The small mark on the agent's row in the sidebar. */
export function StaleMark({ session }: { session: Session }) {
  const shown = useStaleShown(session)
  if (!shown) return null
  return <span className="v-stale-mark" data-testid="agent-stale-mark" role="img" aria-label="Restart needed" title={`Running ${what(session)}: restart the agent to pick up the changes`} />
}
