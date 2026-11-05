import { useEffect, useState } from 'react'
import { SECTION_ORDER, api, type Delivery, type Project, type Section, type Session, type Thread } from '../api'
import { useApp } from '../lib/app'
import { oneLine, shortTime } from '../lib/format'
import { proseOf } from '../lib/markdown'
import { IconPaperclip, IconPin } from './icons'
import { StatusDot, ThreadStatusBadge, cx } from './ui'
import { waitsOnPerson } from './Sidebar'

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

/** Every session's threads in one list; loads itself and again when threads change. */
export function useAllThreads(): Thread[] | null {
  const { threadsVersion, error } = useApp()
  const [threads, setThreads] = useState<Thread[] | null>(null)
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
  return threads
}

export function ThreadRow({ t, focused, onOpen, phone, session, project, onOpenSession }: { t: Thread; focused: boolean; onOpen: () => void; phone?: boolean; session?: Session; project?: Project; onOpenSession?: () => void }) {
  const { settings } = useApp()
  const attention = ['stopped', 'holding', 'waiting'].includes(t.section)
  const strong = (attention || t.unread > 0) && settings.list.highlight_subject
  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onOpen()}
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
        {t.status && <ThreadStatusBadge status={t.status} />}
        <span className="shrink-0 text-[12px] text-subtle">{shortTime(t.updated_at)}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted">
        {project && (
          <span
            data-testid="thread-project"
            data-project-id={project.id}
            title={`Project ${project.name}`}
            className="max-w-[30%] shrink-0 truncate rounded-[5px] border border-linestrong px-1.5 text-[11px] leading-[18px] text-muted"
          >
            {project.name}
          </span>
        )}
        {session && (
          <span
            role="button"
            tabIndex={-1}
            data-testid="thread-session"
            data-session-id={session.id}
            title={`Open ${session.name}'s terminal`}
            onClick={(e) => {
              e.stopPropagation()
              onOpenSession?.()
            }}
            className="flex max-w-[45%] shrink-0 items-center gap-1.5 rounded-[5px] bg-chip px-1.5 text-[11px] leading-[18px] text-fg2 hover:bg-sel"
          >
            <StatusDot s={session} waits={waitsOnPerson(session)} size={6} ring={false} />
            <span className="truncate">{session.name}</span>
          </span>
        )}
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
    </div>
  )
}

