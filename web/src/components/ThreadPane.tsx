import { useMemo } from 'react'
import type { Session } from '../api'
import { useApp } from '../lib/app'
import { IconInbox } from './icons'
import { groupSessions, waitsOnPerson } from './Sidebar'
import { ThreadView } from './ThreadView'
import { useVisibleThreads } from './ThreadsPane'
import { StatusDot, cx, statusOf } from './ui'

/** The middle column: the open thread (of any session), or an empty state with the sessions to jump to. */
export function ThreadPane({ session }: { session: Session | null }) {
  const { route, navigate } = useApp()
  const v = useVisibleThreads()
  const siblings = useMemo(() => v.groups.flatMap((g) => g.items), [v.groups])
  return (
    <section data-testid="thread-pane" aria-label="Thread" className="flex h-full min-w-0 flex-col bg-surface">
      {route.t && session ? (
        <ThreadView key={route.t} session={session} threadId={route.t} siblings={siblings} onBack={() => navigate({ t: null, f: null })} />
      ) : (
        <EmptyThread />
      )}
    </section>
  )
}

function EmptyThread() {
  const { sessions, route, navigate } = useApp()
  const recent = useMemo(() => groupSessions((sessions ?? []).filter((s) => !s.archived_at)).flatMap((g) => g.rows).slice(0, 5), [sessions])
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="thread-empty">
      <IconInbox size={36} className="text-faint" strokeWidth={1.2} />
      <span className="text-[14px] text-muted">Pick a thread to read it here, or write one below.</span>
      {recent.length > 0 && (
        <div className="mt-2 flex w-full max-w-[320px] flex-col gap-1">
          <span className="text-left text-[11px] font-bold uppercase tracking-[0.06em] text-subtle">Recent sessions</span>
          {recent.map((s) => {
            const waits = waitsOnPerson(s)
            return (
              <button
                key={s.id}
                type="button"
                data-testid="recent-session"
                onClick={() => navigate({ s: s.id, t: s.top_thread?.id ?? null, f: null })}
                className={cx('flex h-9 items-center gap-2 rounded-md border px-2.5 text-left text-[13px]', s.id === route.s ? 'border-line2 bg-raised' : 'border-transparent hover:bg-raised/60')}
              >
                <StatusDot s={s} waits={waits} size={7} ring={false} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className={cx('shrink-0 text-[12px]', statusOf(s, waits).text)}>{statusOf(s, waits).label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
