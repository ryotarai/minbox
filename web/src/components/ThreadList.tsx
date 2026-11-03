import { useEffect, useMemo, useState } from 'react'
import { SECTION_LABEL, SECTION_ORDER, api, type Delivery, type Section, type Session, type Thread } from '../api'
import { useApp } from '../lib/app'
import { oneLine, shortTime } from '../lib/format'
import { useHotkeys } from '../lib/hotkeys'
import { proseOf } from '../lib/markdown'
import { IconChevronRight, IconInbox, IconPaperclip, IconPin } from './icons'
import { Button, Skeleton, cx } from './ui'
import { NextStep } from './NextStep'

export const DELIVERY: Record<Delivery, { icon: string; label: string; color: string }> = {
  queued: { icon: '◷', label: 'Queued', color: 'text-muted' },
  sending: { icon: '…', label: 'Sending', color: 'text-muted' },
  delivered: { icon: '✓✓', label: 'Delivered', color: 'text-ok' },
  undelivered: { icon: '△', label: 'Undelivered', color: 'text-danger' },
}

export function DeliveryTick({ d }: { d: Delivery }) {
  const v = DELIVERY[d]
  return (
    <span className={cx('shrink-0 text-[11.5px]', v.color)} title={v.label} data-testid="delivery-tick" data-delivery={d}>
      {v.icon}
    </span>
  )
}

export function sortThreads(threads: Thread[]): { section: Section; items: Thread[] }[] {
  const by = new Map<Section, Thread[]>()
  for (const t of threads) {
    if (!by.has(t.section)) by.set(t.section, [])
    by.get(t.section)!.push(t)
  }
  return SECTION_ORDER.filter((s) => by.has(s)).map((section) => ({
    section,
    items: by.get(section)!.sort((a, b) => {
      if (!!a.pinned_at !== !!b.pinned_at) return a.pinned_at ? -1 : 1
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    }),
  }))
}

/** The session's threads, by section; loads itself. */
export function useThreads(sessionId: string | null): Thread[] | null {
  const { threadsVersion, error } = useApp()
  const [threads, setThreads] = useState<Thread[] | null>(null)
  useEffect(() => {
    if (!sessionId) return
    let live = true
    api
      .threads(sessionId)
      .then((t) => live && setThreads(t))
      .catch((e) => live && error(e))
    return () => {
      live = false
    }
  }, [sessionId, threadsVersion, error])
  useEffect(() => setThreads(null), [sessionId])
  return threads
}

export function ThreadList({
  session,
  threads,
  onOpen,
  phone,
}: {
  session: Session
  threads: Thread[] | null
  onOpen: (id: string) => void
  phone?: boolean
}) {
  const { setOverlay, settings } = useApp()
  const groups = useMemo(() => sortThreads(threads ?? []), [threads])
  const flat = groups.flatMap((g) => g.items)
  const [cursor, setCursor] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<Section>>(new Set(['archived', 'snoozed']))

  useHotkeys({
    j: () => setCursor((c) => Math.min(c + 1, flat.length - 1)),
    k: () => setCursor((c) => Math.max(c - 1, 0)),
    arrowdown: () => setCursor((c) => Math.min(c + 1, flat.length - 1)),
    arrowup: () => setCursor((c) => Math.max(c - 1, 0)),
    enter: () => {
      const t = flat[cursor]
      if (t) onOpen(t.id)
      else return false
    },
    n: () => {
      const t = flat.find((x) => x.unread > 0) ?? flat[0]
      if (t) onOpen(t.id)
    },
  }, !phone)

  // Keep thread panel open: show the top thread instead of the list.
  useEffect(() => {
    if (settings.list.keep_panel && !phone && flat[0]) onOpen(flat[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.list.keep_panel, threads === null])

  return (
    <div className="flex h-full flex-col">
      {!phone && (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
          <div className="flex-1 truncate text-[15px] font-[650]">Inbox</div>
          <Button size="sm" variant="ghost" data-testid="compose" onClick={() => setOverlay({ kind: 'compose', sessionId: session.id })}>
            ✎ New message
          </Button>
        </div>
      )}
      {phone && (
        <div className="flex shrink-0 justify-end px-3">
          <Button size="sm" variant="ghost" data-testid="compose" onClick={() => setOverlay({ kind: 'compose', sessionId: session.id })}>
            ✎ New message
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-testid="thread-list">
        {threads === null ? (
          <Skeleton />
        ) : threads.length === 0 ? (
          <EmptyInbox session={session} />
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
                {(g.section === 'archived' || g.section === 'snoozed') && (
                  <IconChevronRight size={12} className={cx('transition-transform', !collapsed.has(g.section) && 'rotate-90')} />
                )}
                {g.section === 'snoozed' && g.items.some((t) => t.stopped) && <span className="text-danger" title="A snoozed thread stopped on you">▲</span>}
              </button>
              {!collapsed.has(g.section) &&
                g.items.map((t) => <ThreadRow key={t.id} t={t} focused={!phone && flat[cursor]?.id === t.id} onOpen={() => onOpen(t.id)} phone={phone} />)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function ThreadRow({ t, focused, onOpen, phone }: { t: Thread; focused: boolean; onOpen: () => void; phone?: boolean }) {
  const { settings } = useApp()
  const attention = ['stopped', 'holding', 'waiting'].includes(t.section)
  const strong = (attention || t.unread > 0) && settings.list.highlight_subject
  return (
    <button
      type="button"
      data-testid="thread-row"
      data-thread-id={t.id}
      onClick={onOpen}
      className={cx(
        'flex w-full flex-col gap-1 rounded-[9px] border px-3 text-left',
        phone ? 'min-h-16 py-3' : 'py-2.5',
        focused ? 'border-line2 bg-raised' : 'border-transparent hover:bg-raised/60',
        attention && 'bg-wait/5',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {t.unread > 0 && <span aria-label="Unread" className="h-[7px] w-[7px] shrink-0 rounded-full bg-wait" />}
        {t.pinned_at && <IconPin size={12} className="shrink-0 text-muted" />}
        <span className={cx('min-w-0 flex-1 truncate', phone ? 'text-[15.5px]' : 'text-[14px]', strong ? 'font-[650] text-fg' : 'text-fg2')}>{t.subject}</span>
        {t.stopped ? (
          <span className="shrink-0 rounded-[6px] border border-danger px-1.5 text-[11px] font-semibold text-danger">Stopped</span>
        ) : (t.holds_up ?? 0) > 0 ? (
          <span className="shrink-0 rounded-[6px] border border-wait px-1.5 text-[11px] font-semibold text-wait">Holds up {t.holds_up}</span>
        ) : null}
        {t.open_questions > 0 && (
          <span className="shrink-0 rounded-[6px] bg-accent px-1.5 text-[11px] font-bold text-onaccent" title="Open questions" data-testid="thread-questions">
            ?{t.open_questions}
          </span>
        )}
        <span className="shrink-0 text-[12px] text-subtle">{shortTime(t.updated_at)}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted">
        {t.name && <span className="mono shrink-0 rounded-[5px] border border-linestrong px-1.5 text-[11px] leading-[18px] text-fg2">{t.name}</span>}
        {t.last_author === 'user' && <span className="shrink-0 text-subtle">You:</span>}
        <span className="min-w-0 flex-1 truncate">{oneLine(proseOf(t.last_body)) || '—'}</span>
        {(t.attachment_count ?? 0) > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-subtle">
            <IconPaperclip size={12} />
            {t.attachment_count}
          </span>
        )}
        {t.last_author === 'user' && t.last_delivery && <DeliveryTick d={t.last_delivery} />}
      </div>
    </button>
  )
}

function EmptyInbox({ session }: { session: Session }) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center">
      <IconInbox size={36} className="text-faint" strokeWidth={1.2} />
      <span className="text-[15px] font-semibold">No messages yet.</span>
      <span className="max-w-[280px] text-[13px] leading-[1.55] text-muted">Claude writes here when it needs you or finishes work.</span>
      <NextStep session={session} />
    </div>
  )
}
