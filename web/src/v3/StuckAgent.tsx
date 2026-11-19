// An agent that seems to wait for input in its terminal (the server's stuck / stuck_hint, see
// internal/server/stuck.go): Claude Code asking to trust the folder, to log in, for an API key, an
// update or an error screen at its start; a message it never takes; a turn that died on an API error
// (a model that does not exist, a refused key). A banner under the agent's header (and above a task
// of it picked in All agents) with Open terminal, and a small mark on its sidebar row. Dismiss hides
// both for this occurrence (the kind and since): the next one shows again.
import { useEffect, useState } from 'react'
import type { Session } from '../api'
import { useApp } from '../lib/app'

const KEY = 'minbox.stuckDismissed'
const EVENT = 'minbox-stuck-dismissed'

/** What a dismissal covers: this occurrence. */
function occurrence(s: Session): string {
  return `${s.stuck ?? ''}:${s.stuck_since ?? ''}`
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
  all[s.id] = occurrence(s)
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // no storage: dismissed for this page only (the event below)
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id: s.id, key: all[s.id] } }))
}

/** Whether the agent's stuck notice is up: stuck and not dismissed for this occurrence. */
export function useStuckShown(s: Session | undefined): boolean {
  const [dismissed, setDismissed] = useState<Record<string, string>>(readDismissed)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; key: string }>).detail
      setDismissed((cur) => ({ ...cur, ...readDismissed(), ...(d ? { [d.id]: d.key } : {}) }))
    }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  return !!s && !!s.stuck && s.kind !== 'shell' && s.status !== 'ended' && dismissed[s.id] !== occurrence(s)
}

/** What the banner says. who: "This agent" in its own page, its name elsewhere. */
function text(s: Session, who: string): string {
  if (s.stuck === 'error') return `${who} hit an error and didn't reply. Check its terminal.`
  return `${who} seems to be waiting for input in its terminal.`
}

/**
 * The banner. onOpenTerminal: show the agent's terminal (its page's pane); without it, open the
 * agent's page on its terminal.
 */
export function StuckAgentBanner({ session, onOpenTerminal, named = false }: { session: Session; onOpenTerminal?: () => void; named?: boolean }) {
  const { navigate } = useApp()
  const shown = useStuckShown(session)
  if (!shown) return null
  const open = onOpenTerminal ?? (() => navigate({ view: 'agent', s: session.id, m: null, k: null, tab: 'terminal' }, { push: true }))
  return (
    <div className="v-stale v-stuck" role="alert" data-testid="stuck-agent-banner" data-session={session.id} data-kind={session.stuck}>
      <span className="v-stuck-icon" aria-hidden="true">
        !
      </span>
      <span className="v-stale-txt">
        {text(session, named ? session.name : 'This agent')}
        {session.stuck_hint && (
          <>
            {' '}
            <code className="v-stuck-hint" data-testid="stuck-agent-hint" title="The last matching line of its terminal">
              {session.stuck_hint}
            </code>
          </>
        )}
      </span>
      <span className="v-stale-acts">
        <button type="button" className="v-btn pri" data-testid="stuck-agent-open-terminal" title="Show the agent's terminal to answer it there" onClick={open}>
          Open terminal
        </button>
        <button type="button" className="v-btn" data-testid="stuck-agent-dismiss" title="Hide this until it happens again" onClick={() => dismiss(session)}>
          Dismiss
        </button>
      </span>
    </div>
  )
}

/** The banners of the stuck agents among ids (a task's agents, in All agents). */
export function StuckAgentBanners({ ids }: { ids: string[] }) {
  const { sessions } = useApp()
  const list = (sessions ?? []).filter((s) => ids.includes(s.id) && s.stuck)
  return (
    <>
      {list.map((s) => (
        <StuckAgentBanner key={s.id} session={s} named />
      ))}
    </>
  )
}

/** The small mark on the agent's row in the sidebar. */
export function StuckMark({ session }: { session: Session }) {
  const shown = useStuckShown(session)
  if (!shown) return null
  return (
    <span
      className="v-stuck-mark"
      data-testid="agent-stuck-mark"
      role="img"
      aria-label={session.stuck === 'error' ? 'Hit an error' : 'Waiting for input'}
      title={(session.stuck === 'error' ? "Hit an error and didn't reply: check its terminal" : 'Seems to be waiting for input in its terminal') + (session.stuck_hint ? ` (${session.stuck_hint})` : '')}
    >
      !
    </span>
  )
}
