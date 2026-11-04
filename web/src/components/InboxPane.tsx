import { useMemo } from 'react'
import type { Session } from '../api'
import { useApp } from '../lib/app'
import { IconInbox } from './icons'
import { ThreadList, sortThreads, useThreads } from './ThreadList'
import { ThreadView } from './ThreadView'

/**
 * The inbox column: the session's threads, or the open thread. On a wide screen (`wide`) it is the
 * thread list only, and the open thread shows in its own ThreadPane beside it.
 */
export function InboxPane({ session, wide }: { session: Session; wide?: boolean }) {
  const { route, navigate } = useApp()
  const threads = useThreads(session.id)
  const ordered = useMemo(() => (threads ? sortThreads(threads).flatMap((g) => g.items) : null), [threads])
  return (
    <section data-testid="inbox-pane" aria-label="Inbox" className="flex h-full min-w-0 flex-col bg-surface">
      {route.t && !wide ? (
        <ThreadView key={route.t} session={session} threadId={route.t} siblings={ordered} onBack={() => navigate({ t: null, f: null })} />
      ) : (
        <ThreadList session={session} threads={threads} onOpen={(id) => navigate({ t: id })} selectedId={wide ? route.t : null} keys={!wide || !route.t} />
      )}
    </section>
  )
}

/** Wide screens: the thread picked in the inbox column. */
export function ThreadPane({ session }: { session: Session }) {
  const { route, navigate } = useApp()
  const threads = useThreads(session.id)
  const ordered = useMemo(() => (threads ? sortThreads(threads).flatMap((g) => g.items) : null), [threads])
  return (
    <section data-testid="thread-pane" aria-label="Thread" className="flex h-full min-w-0 flex-col bg-surface">
      {route.t ? (
        <ThreadView key={route.t} session={session} threadId={route.t} siblings={ordered} onBack={() => navigate({ t: null, f: null })} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2.5 p-6 text-center">
          <IconInbox size={36} className="text-faint" strokeWidth={1.2} />
          <span className="text-[14px] text-muted">Pick a thread to read it here.</span>
        </div>
      )}
    </section>
  )
}
