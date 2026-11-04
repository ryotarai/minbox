import { useCallback, useRef, useState } from 'react'
import { api, type Session } from '../api'
import { useApp } from '../lib/app'
import { homeRelative } from '../lib/format'
import { IconPanelRight, IconTerminal } from './icons'
import { TerminalView, type TerminalHandle } from './Terminal'
import { TerminalKeys, useTouchPrimary } from './TerminalKeys'
import { Button, IconButton, StatusPill, cx } from './ui'
import { waitsOnPerson } from './Sidebar'

/** The center column: the session's terminal with its header and the ended bar. */
export function TerminalPane({ session }: { session: Session | null }) {
  const { layout, setLayout, toast, error } = useApp()
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null)
  const touch = useTouchPrimary()
  const term = useRef<TerminalHandle>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const onNotice = useCallback((text: string, isError?: boolean) => toast(text, { error: isError }), [toast])

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <IconTerminal size={36} className="text-faint" strokeWidth={1.2} />
        <span className="text-[15px] font-semibold">Start a session to run Claude Code.</span>
        <span className="text-[13px] text-muted">Use + New on the left; it starts in the last directory you used.</span>
      </div>
    )
  }
  const ended = session.status === 'ended'
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 pl-5 pr-3">
        <span className="min-w-0 truncate text-[14px] font-semibold" data-testid="terminal-session-name">
          {session.name}
        </span>
        {session.title && (
          <span className="min-w-0 truncate text-[13.5px] text-fg2" data-testid="terminal-session-title" title={session.title}>
            {session.title}
          </span>
        )}
        <span className="mono hidden min-w-0 truncate text-[12px] text-subtle xl:inline">{homeRelative(session.cwd)}</span>
        <StatusPill s={session} waits={waitsOnPerson(session)} />
        <span className="flex-1" />
        {size && (
          <span className="mono text-[11.5px] text-subtle" data-testid="pty-size">
            {size.cols}×{size.rows}
          </span>
        )}
        <IconButton
          aria-label={layout.inboxCollapsed ? 'Show inbox' : 'Collapse inbox'}
          title={layout.inboxCollapsed ? 'Show inbox' : 'Collapse inbox'}
          data-testid="toggle-inbox"
          onClick={() => setLayout({ inboxCollapsed: !layout.inboxCollapsed })}
          className={cx('border border-line2', layout.inboxCollapsed && 'text-wait')}
        >
          <IconPanelRight />
        </IconButton>
      </div>
      <div ref={wrap} className="relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-[10px] border border-line bg-[var(--mb-term-bg)] px-[18px] py-4">
        {/* A resumed session is a new process: the key change reattaches. */}
        <TerminalView
          key={`${session.id}:${ended ? 'ended' : 'running'}`}
          ref={term}
          sessionId={session.id}
          onSize={(cols, rows) => setSize({ cols, rows })}
          onNotice={onNotice}
        />
        {ended && (
          <div className="absolute inset-x-3 bottom-3 flex h-[52px] items-center gap-3 rounded-[10px] border border-line2 bg-raised pl-4 pr-2" data-testid="ended-bar">
            <span aria-hidden="true" className="box-border h-2 w-2 rounded-full border-[1.5px] border-subtle" />
            <span className="flex-1 text-[13.5px] text-fg2">Session ended{session.exit_code !== null ? ` (exit ${session.exit_code})` : ''}.</span>
            {(session.undelivered ?? 0) > 0 && <span className="text-[12px] text-subtle">{session.undelivered} undelivered {session.undelivered === 1 ? 'reply goes' : 'replies go'} in after Resume</span>}
            <Button variant="primary" data-testid="resume" onClick={() => api.restartSession(session.id).catch(error)}>
              Resume
            </Button>
          </div>
        )}
      </div>
      {/* Touch screens (tablets, unfolded foldables) usually have no physical keyboard. */}
      {touch && !ended && <TerminalKeys term={term} wrap={wrap} className="-mt-1 mx-3 mb-3" />}
    </div>
  )
}
