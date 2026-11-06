import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Session } from '../api'
import { useApp } from '../lib/app'
import { homeRelative } from '../lib/format'
import { IconBack, IconMore, IconTerminal } from './icons'
import { TerminalView, type TerminalHandle } from './Terminal'
import { TerminalKeys, useTouchPrimary } from './TerminalKeys'
import { Button, HostTag, IconButton, EndedTag, cx } from './ui'
import { SessionMenu } from './Sidebar'

/** The center column: the session's terminal with its header and the ended bar. */
export function TerminalPane({ session, onThreads }: { session: Session | null; onThreads?: () => void }) {
  const { layout, setLayout, toast, error, reloadSessions } = useApp()
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null)
  const touch = useTouchPrimary()
  const term = useRef<TerminalHandle>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const onNotice = useCallback((text: string, isError?: boolean) => toast(text, { error: isError }), [toast])

  // Closing the shell pane hands the keyboard back to this terminal.
  const shellOpen = layout.shellPane
  const wasShellOpen = useRef(shellOpen)
  useEffect(() => {
    if (wasShellOpen.current && !shellOpen) term.current?.focus()
    wasShellOpen.current = shellOpen
  }, [shellOpen])

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
      <div className={cx('flex h-14 shrink-0 items-center gap-3 pr-3', onThreads ? 'pl-2' : 'pl-5')}>
        {onThreads && (
          <button
            type="button"
            data-testid="tablet-threads"
            title="Back to the thread list"
            onClick={onThreads}
            className="flex h-8 shrink-0 items-center gap-1 rounded-md border-0 bg-transparent pl-1 pr-2 text-[13px] text-fg2 hover:bg-raised"
          >
            <IconBack size={14} className="text-subtle" />
            Threads
          </button>
        )}
        {renaming !== null ? (
          <input
            autoFocus
            aria-label="Session name"
            data-testid="rename-input"
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.stopPropagation()
                setRenaming(null)
              }
            }}
            onBlur={() => {
              const v = renaming.trim()
              setRenaming(null)
              if (v && v !== session.name) api.renameSession(session.id, v).then(reloadSessions).catch(error)
            }}
            className="h-7 w-44 rounded-sm border border-accent bg-sunken px-2 text-[13.5px] text-fg outline-none"
          />
        ) : (
          <span className="max-w-[45%] shrink-0 truncate text-[14px] font-semibold" data-testid="terminal-session-name" title="Double-click to rename" onDoubleClick={() => setRenaming(session.name)}>
            {session.name}
          </span>
        )}
        {session.title && !onThreads && (
          <span className="min-w-0 truncate text-[13.5px] text-fg2" data-testid="terminal-session-title" title={session.title}>
            {session.title}
          </span>
        )}
        <HostTag name={session.host_name} />
        <span className="mono hidden min-w-0 truncate text-[12px] text-subtle min-[1800px]:inline">{homeRelative(session.cwd)}</span>
        {session.status === 'ended' && <EndedTag />}
        <span className="flex-1" />
        {size && (
          <span className="sr-only" data-testid="pty-size">
            {size.cols}×{size.rows}
          </span>
        )}
        {session.kind !== 'shell' && (
          <IconButton
            aria-label={layout.shellPane ? 'Hide shell' : 'Show shell'}
            title={layout.shellPane ? 'Hide shell (Ctrl+`)' : 'Show shell (Ctrl+`)'}
            data-testid="shell-toggle"
            aria-pressed={layout.shellPane}
            onClick={() => setLayout({ shellPane: !layout.shellPane })}
            className={cx('border border-line2', layout.shellPane && 'text-wait')}
          >
            <IconTerminal />
          </IconButton>
        )}
        <IconButton aria-label="Session actions" title="Session actions" data-testid="session-menu" onClick={(e) => setMenu(e.currentTarget)} className="border border-line2">
          <IconMore />
        </IconButton>
        <SessionMenu s={session} anchor={menu} onClose={() => setMenu(null)} onRename={() => setRenaming(session.name)} />
      </div>
      <div ref={wrap} className="relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-[10px] border border-line focus-within:border-accent bg-[var(--mb-term-bg)] px-[18px] py-4">
        {/* A resumed session is a new process: the key change reattaches. */}
        <TerminalView
          key={`${session.id}:${ended ? 'ended' : 'running'}`}
          ref={term}
          sessionId={session.id}
          newlineOnShiftEnter={session.kind !== 'shell'}
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
