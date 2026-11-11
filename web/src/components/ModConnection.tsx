import { useEffect, useState } from 'react'
import { api, type ModConnectionInfo, type Session } from '../api'
import { useApp } from '../lib/app'
import { Button, Popover, cx } from './ui'

/** "3 s", "2 m", "1 h 5 m": how long ago, coarse. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} m`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} m`
}

/** What the badge says, from the session list's fields (no extra request). */
export function modConnLabel(s: Session, now: number): { state: 'connected' | 'stale' | 'connecting'; label: string; detail: string } | null {
  if (s.kind === 'shell' || s.status === 'ended') return null
  const beat = s.mod_beat_at ? now - new Date(s.mod_beat_at).getTime() : null
  switch (s.mod_conn) {
    case 'connected':
      return { state: 'connected', label: 'mod connected', detail: beat === null ? 'mod connected' : `mod connected · last heartbeat ${ago(beat)} ago` }
    case 'stale': {
      const label = beat === null ? 'no heartbeat since the server started' : `no heartbeat for ${ago(beat)}`
      return { state: 'stale', label, detail: `${label}: messages may not be picked up` }
    }
    case 'connecting':
      return { state: 'connecting', label: 'connecting…', detail: 'waiting for the mod to report in' }
    default:
      return null
  }
}

/**
 * A small dot (and, when something is wrong, a few words) for the mod connection of a session:
 * whether the integration inside the agent is reporting in. Click for the diagnostics.
 */
export function ModConnection({ session, phone }: { session: Session; phone?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // The label counts up only while it matters (stale, or the details are open).
  const ticking = session.mod_conn === 'stale' || !!anchor
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])
  const c = modConnLabel(session, now)
  if (!c) return null
  const color = c.state === 'connected' ? 'bg-ok' : c.state === 'stale' ? 'bg-danger' : 'bg-subtle'
  return (
    <>
      <button
        type="button"
        data-testid="mod-conn"
        data-state={c.state}
        aria-label={c.detail}
        title={c.detail}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className={cx('flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border-0 bg-transparent px-1.5 py-0.5 hover:bg-raised', phone ? 'text-[11.5px]' : 'text-[11.5px]', c.state === 'stale' ? 'text-dangerfg' : 'text-subtle')}
      >
        <span aria-hidden="true" className={cx('h-[7px] w-[7px] rounded-full', color)} />
        {c.state !== 'connected' && <span data-testid="mod-conn-label">{c.label}</span>}
      </button>
      <Popover anchor={anchor} open={!!anchor} onClose={() => setAnchor(null)} align="start" className="w-[min(520px,92vw)]">
        <ModConnectionDetails session={session} />
      </Popover>
    </>
  )
}

/** The diagnostics of one session's mod connection, with a copy button for a bug report. */
function ModConnectionDetails({ session }: { session: Session }) {
  const { error, toast } = useApp()
  const [info, setInfo] = useState<ModConnectionInfo | null>(null)
  useEffect(() => {
    let live = true
    const load = () => api.sessionConnection(session.id).then((i) => live && setInfo(i)).catch(error)
    void load()
    const t = setInterval(load, 3000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [session.id, error])
  if (!info) return <div className="p-3 text-[12.5px] text-subtle">Loading…</div>
  const row = (k: string, v: string | number | null | undefined) => (
    <div className="flex gap-2 text-[12px]">
      <span className="w-[132px] shrink-0 text-subtle">{k}</span>
      <span className="mono min-w-0 break-all text-fg2">{v === null || v === undefined || v === '' ? '–' : String(v)}</span>
    </div>
  )
  const text = diagnosticsText(info)
  return (
    <div data-testid="mod-conn-details" className="flex max-h-[70vh] flex-col gap-2 overflow-auto p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">Mod connection</span>
        <span data-testid="mod-conn-state" className={cx('rounded border px-1.5 text-[11px]', info.state === 'stale' ? 'border-danger text-dangerfg' : 'border-line2 text-fg2')}>
          {info.state}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="quiet"
          data-testid="mod-conn-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => toast('Diagnostics copied'))
          }}
        >
          Copy diagnostics
        </Button>
      </div>
      {row('Heartbeat', info.heartbeat ? `yes (${info.beats} so far, seq ${info.seq})` : 'none yet (an old mod only makes calls)')}
      {row('Last heartbeat', info.last_beat_at ? `${info.last_beat_at} (${info.age_s !== null ? ago(info.age_s * 1000) + ' ago' : ''})` : null)}
      {row('Last call', info.last_contact_at)}
      {row('Mod', info.agent ? `${info.agent} ${info.mod_version ?? ''}` : null)}
      {row('Mod thinks it is', info.mod_state)}
      {row('Last poll (mod)', info.last_poll_at)}
      {row('Last delivery (mod)', info.last_delivery_at)}
      {row('Queued messages', info.queue.count > 0 ? `${info.queue.count}, oldest ${ago((info.queue.oldest_wait_s ?? 0) * 1000)}` : 0)}
      {row('Reconnects', info.reconnects)}
      <EventList title="The mod's own log" events={info.mod_events} />
      <EventList title="The server's log" events={info.events} />
    </div>
  )
}

function EventList({ title, events }: { title: string; events: { at: string; kind: string; msg: string }[] }) {
  return (
    <div>
      <div className="mt-1 text-[11.5px] font-semibold text-subtle">{title}</div>
      {events.length === 0 ? (
        <div className="text-[12px] text-faint">nothing yet</div>
      ) : (
        <ul className="m-0 max-h-[160px] list-none overflow-auto p-0" data-testid="mod-conn-events">
          {[...events].reverse().map((e, i) => (
            <li key={i} className="mono text-[11px] leading-[16px] text-fg2">
              <span className="text-faint">{e.at ? new Date(e.at).toLocaleTimeString() : '?'}</span> <span className="text-subtle">{e.kind}</span> {e.msg}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Plain text of the diagnostics, for a bug report. It holds ids, counts and timings only. */
export function diagnosticsText(i: ModConnectionInfo): string {
  const lines = [
    `minbox mod connection, session ${i.session_id}`,
    `state: ${i.state} (session status ${i.session_status}), stale after ${i.stale_after_s} s`,
    `server time: ${i.server_time}; server started: ${i.server_started_at}`,
    `heartbeat: ${i.heartbeat ? 'yes' : 'no'}, beats ${i.beats ?? 0}, seq ${i.seq ?? 0}, last ${i.last_beat_at ?? 'never'}, last call ${i.last_contact_at ?? 'never'}`,
    `mod: ${i.agent ?? '?'} ${i.mod_version ?? ''}, thinks it is ${i.mod_state ?? '?'}, last poll ${i.last_poll_at || '-'}, last delivery ${i.last_delivery_at || '-'}`,
    `queue: ${i.queue.count} message(s), oldest ${i.queue.oldest_wait_s ?? '-'} s; reconnects ${i.reconnects ?? 0}`,
    i.mod_info ? `mod info: ${JSON.stringify(i.mod_info)}` : '',
    '--- the mod log (oldest first)',
    ...i.mod_events.map((e) => `${e.at} ${e.kind} ${e.msg}`),
    '--- the server log (oldest first)',
    ...i.events.map((e) => `${e.at} ${e.kind} ${e.msg}`),
  ]
  return lines.filter(Boolean).join('\n')
}
