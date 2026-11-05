import { useCallback } from 'react'
import { type Session } from '../api'
import { useApp } from '../lib/app'
import { homeRelative } from '../lib/format'
import { IconClose } from './icons'
import { TerminalView } from './Terminal'
import { IconButton } from './ui'

/** The desktop's far-right pane: a login shell in the session's folder (the session's companion shell). */
export function ShellPane({ session, onClose }: { session: Session; onClose: () => void }) {
  const { toast } = useApp()
  const onNotice = useCallback((text: string, isError?: boolean) => toast(text, { error: isError }), [toast])
  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="shell-pane">
      <div className="flex h-14 shrink-0 items-center gap-2 pl-3 pr-3">
        <span className="text-[14px] font-semibold">Shell</span>
        <span className="mono min-w-0 flex-1 truncate text-[12px] text-subtle" title={session.cwd}>
          {homeRelative(session.cwd)}
        </span>
        <IconButton aria-label="Close shell" title="Close shell (Ctrl+`)" data-testid="shell-close" onClick={onClose}>
          <IconClose />
        </IconButton>
      </div>
      <div className="relative mb-3 mr-3 min-h-0 flex-1 overflow-hidden rounded-[10px] border border-line bg-[var(--mb-term-bg)] px-[14px] py-3">
        <TerminalView key={session.id} sessionId={session.id} shell onNotice={onNotice} />
      </div>
    </div>
  )
}
