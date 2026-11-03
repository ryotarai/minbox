import { useApp } from '../lib/app'
import { hm } from '../lib/format'
import { reconnectEvents } from '../api'
import { Button } from './ui'

/** Shown while the event stream to the server is down. */
export function ConnectionBanner({ className }: { className?: string }) {
  const { conn } = useApp()
  if (conn.connected) return null
  return (
    <div
      role="alert"
      data-testid="connection-banner"
      className={`mx-2 mb-1 flex items-start gap-2.5 rounded-[10px] border border-danger/40 bg-dangerstrong/12 p-3 ${className ?? ''}`}
    >
      <span aria-hidden="true" className="text-[14px] leading-5 text-danger">
        △
      </span>
      <div className="flex flex-1 flex-col gap-1">
        <span className="text-[13.5px] font-semibold text-dangerfg">Lost the connection to the server</span>
        <span className="text-[12.5px] text-fg2">
          Reconnecting… (attempt {conn.attempts}).{conn.since ? ` What you see is as of ${hm(conn.since)}.` : ''}
        </span>
      </div>
      <Button size="sm" onClick={reconnectEvents}>
        Retry
      </Button>
    </div>
  )
}
