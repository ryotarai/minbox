import { useMemo } from 'react'
import type { Session } from '../api'
import { useApp } from '../lib/app'
import { ThreadList, sortThreads, useThreads } from './ThreadList'
import { ThreadView } from './ThreadView'

/** The right column: the session's threads, or the open thread. */
export function InboxPane({ session }: { session: Session }) {
  const { route, navigate } = useApp()
  const threads = useThreads(session.id)
  const ordered = useMemo(() => (threads ? sortThreads(threads).flatMap((g) => g.items) : null), [threads])
  return (
    <section data-testid="inbox-pane" aria-label="Inbox" className="flex h-full min-w-0 flex-col bg-surface">
      {route.t ? (
        <ThreadView key={route.t} session={session} threadId={route.t} siblings={ordered} onBack={() => navigate({ t: null, f: null })} />
      ) : (
        <ThreadList session={session} threads={threads} onOpen={(id) => navigate({ t: id })} />
      )}
    </section>
  )
}
