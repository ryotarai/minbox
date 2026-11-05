import { useMemo } from 'react'
import type { Session } from '../api'
import { useApp } from '../lib/app'
import { IconInbox, IconTerminal } from './icons'
import { ThreadView } from './ThreadView'
import { useVisibleThreads } from './ThreadsPane'

/** The middle column: the open thread (of any session), or a quiet empty hint. */
export function ThreadPane({ session, onBack, onTerminal }: { session: Session | null; onBack?: () => void; onTerminal?: () => void }) {
  const { route, navigate } = useApp()
  const v = useVisibleThreads()
  const siblings = useMemo(() => v.groups.flatMap((g) => g.items), [v.groups])
  return (
    <section data-testid="thread-pane" aria-label="Thread" className="flex h-full min-w-0 flex-col bg-surface">
      {route.t && session ? (
        <ThreadView key={route.t} session={session} threadId={route.t} siblings={siblings} onBack={onBack ?? (() => navigate({ t: null, f: null }))} onTerminal={onTerminal} />
      ) : (
        <EmptyThread onTerminal={session ? onTerminal : undefined} />
      )}
    </section>
  )
}

function EmptyThread({ onTerminal }: { onTerminal?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="thread-empty">
      <IconInbox size={36} className="text-faint" strokeWidth={1.2} />
      <span className="text-[14px] text-muted">Pick a thread to read it here.</span>
      {onTerminal && (
        <button type="button" data-testid="tablet-terminal" onClick={onTerminal} className="flex h-8 items-center gap-1.5 rounded-md border border-line2 bg-transparent px-3 text-[12.5px] text-fg2 hover:bg-raised">
          <IconTerminal size={14} />
          Terminal
        </button>
      )}
    </div>
  )
}
