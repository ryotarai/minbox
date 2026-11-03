import type { Session } from '../api'
import { useApp } from '../lib/app'
import { ThreadList, useThreads } from './ThreadList'
import { ThreadView } from './ThreadView'

/** The phone's Inbox tab: the thread list, or the open thread. */
export function InboxPhone({ session }: { session: Session }) {
  const { route, navigate } = useApp()
  const threads = useThreads(session.id)
  return (
    <section data-testid="inbox-pane" className="flex min-h-0 flex-1 flex-col">
      {route.t ? (
        <ThreadView key={route.t} session={session} threadId={route.t} siblings={threads} onBack={() => navigate({ t: null }, { push: false })} phone />
      ) : (
        <ThreadList session={session} threads={threads} onOpen={(id) => navigate({ t: id }, { push: true })} phone />
      )}
    </section>
  )
}
