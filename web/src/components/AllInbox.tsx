import { useEffect, useMemo, useState } from 'react'
import { SECTION_LABEL, api, type Section, type Thread } from '../api'
import { useApp } from '../lib/app'
import { useHotkeys } from '../lib/hotkeys'
import { IconBack, IconInbox } from './icons'
import { IconButton, Skeleton, cx } from './ui'
import { ThreadRow, sortThreads } from './ThreadList'

/** Every session's threads in one list. Picking one opens its session and the thread (the main screen). */
export function AllInboxPage() {
  const { threadsVersion, sessions, navigate, error } = useApp()
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [collapsed, setCollapsed] = useState<Set<Section>>(new Set(['archived', 'snoozed']))
  useEffect(() => {
    let live = true
    api
      .allThreads()
      .then((t) => live && setThreads(t))
      .catch((e) => live && error(e))
    return () => {
      live = false
    }
  }, [threadsVersion, error])
  const groups = useMemo(() => sortThreads(threads ?? []), [threads])
  const flat = groups.flatMap((g) => g.items)
  const [cursor, setCursor] = useState(0)
  const nameOf = (id: string) => sessions?.find((s) => s.id === id)?.name ?? '—'
  const open = (t: Thread) => navigate({ s: t.session_id, t: t.id, f: null, view: 'main', tab: 'inbox' })
  useHotkeys({
    escape: () => navigate({ view: 'main' }),
    j: () => setCursor((c) => Math.min(c + 1, flat.length - 1)),
    k: () => setCursor((c) => Math.max(c - 1, 0)),
    arrowdown: () => setCursor((c) => Math.min(c + 1, flat.length - 1)),
    arrowup: () => setCursor((c) => Math.max(c - 1, 0)),
    enter: () => {
      const t = flat[cursor]
      if (!t) return false
      open(t)
    },
  })
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="all-inbox">
      <div className="flex h-14 shrink-0 items-center gap-3.5 border-b border-line px-5">
        <IconButton aria-label="Back" onClick={() => navigate({ view: 'main' })}>
          <IconBack />
        </IconButton>
        <h1 className="m-0 text-[18px] font-bold">All inbox</h1>
        <span className="text-[13px] text-muted">{threads ? `${flat.length} threads in ${new Set(flat.map((t) => t.session_id)).size} sessions` : ''}</span>
      </div>
      <div className="mx-auto min-h-0 w-full max-w-[760px] flex-1 overflow-y-auto px-3 pb-6" data-testid="all-thread-list">
        {threads === null ? (
          <Skeleton />
        ) : threads.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 px-4 py-16 text-center">
            <IconInbox size={36} className="text-faint" strokeWidth={1.2} />
            <span className="text-[15px] font-semibold">No messages yet.</span>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.section}>
              <button
                type="button"
                onClick={() =>
                  setCollapsed((p) => {
                    const n = new Set(p)
                    if (n.has(g.section)) n.delete(g.section)
                    else n.add(g.section)
                    return n
                  })
                }
                className={cx(
                  'mt-3 flex h-7 w-full items-center gap-2 border-0 bg-transparent px-2 text-left text-[11px] font-bold uppercase tracking-[0.06em]',
                  ['stopped', 'holding', 'waiting'].includes(g.section) ? 'text-wait' : 'text-subtle',
                )}
              >
                {SECTION_LABEL[g.section]}
                <span className="font-normal">{g.items.length}</span>
              </button>
              {!collapsed.has(g.section) &&
                g.items.map((t) => <ThreadRow key={t.id} t={t} focused={flat[cursor]?.id === t.id} onOpen={() => open(t)} sessionName={nameOf(t.session_id)} />)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
