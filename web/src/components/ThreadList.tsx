import { useEffect, useState, type ReactNode } from 'react'
import { SECTION_ORDER, api, type Delivery, type Section, type Thread } from '../api'
import { useApp } from '../lib/app'
import { initials, oneLine, shortTime } from '../lib/format'
import { proseOf } from '../lib/markdown'
import { projectHueStyle } from '../lib/projectColor'
import { IconCheckCheck, IconClock, IconFork, IconPin, IconWarning } from './icons'
import { ThreadStatusBadge, cx } from './ui'
import { useSelectedProject } from '../lib/projects'
import { useContextMenu } from './ContextMenu'
import { ThreadRowMenu } from './ThreadMenu'

export const DELIVERY: Record<Delivery, { icon: ReactNode; label: string; color: string }> = {
  queued: { icon: <IconClock size={12} className="inline" />, label: 'Queued', color: 'text-muted' },
  sending: { icon: '…', label: 'Sending', color: 'text-muted' },
  delivered: { icon: <IconCheckCheck size={14} className="inline" />, label: 'Delivered', color: 'text-ok' },
  undelivered: { icon: <IconWarning size={12} className="inline" />, label: 'Undelivered', color: 'text-danger' },
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


/** Which project a thread belongs to: its icon, or a 2-character box with a per-project colour. Shown only while the list spans all projects. */
export function ThreadProjectBadge({ projectId, projectName }: { projectId?: string; projectName?: string }) {
  const { projects } = useApp()
  const project = projects?.find((p) => p.id === projectId)
  const name = project?.name ?? projectName ?? ''
  const icon = project?.icon
  const label = name ? `Project: ${name}` : 'No project'
  const base = 'flex h-[22px] w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-[6px]'
  const common = { 'data-testid': 'thread-project-badge', 'data-project-id': projectId ?? '', title: label, role: 'img', 'aria-label': label } as const
  if (icon?.kind === 'image') {
    return (
      <div {...common} data-kind="image" style={projectHueStyle(projectId ?? name)} className={cx(base, 'proj-tint border border-line')}>
        <img src={icon.url} alt="" draggable={false} className="h-full w-full object-cover" />
      </div>
    )
  }
  if (icon?.kind === 'emoji') {
    return (
      <div {...common} data-kind="emoji" style={projectHueStyle(projectId ?? name)} className={cx(base, 'proj-tint text-[14px] leading-none')}>
        {icon.emoji}
      </div>
    )
  }
  if (!name) {
    return (
      <div {...common} data-kind="none" className={cx(base, 'bg-chip text-[12px] text-subtle')}>
        –
      </div>
    )
  }
  return (
    <div {...common} data-kind="initials" style={projectHueStyle(projectId ?? name)} className={cx(base, 'proj-badge text-[10.5px] font-bold leading-none tracking-[0.02em]')}>
      {initials(name)}
    </div>
  )
}

export function ThreadRow({ t, focused, onOpen, phone }: { t: Thread; focused: boolean; onOpen: () => void; phone?: boolean }) {
  const { settings } = useApp()
  const { id: scopedProject } = useSelectedProject()
  // Unread is shown by a bold subject only; no row background or border tint.
  const strong = t.unread > 0 && settings.list.highlight_subject
  // Right-click / Shift+F10 / long press: the thread's actions (ThreadRowMenu).
  const menu = useContextMenu()
  return (
    <>
    <div
      role="button"
      tabIndex={0}
      {...menu.props}
      onKeyDown={(e) => {
        menu.props.onKeyDown(e)
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen()
      }}
      data-testid="thread-row"
      data-thread-id={t.id}
      data-focused={focused ? 'true' : 'false'}
      data-menu-open={menu.at ? 'true' : undefined}
      onClick={onOpen}
      className={cx(
        'flex w-full flex-col gap-1 rounded-[9px] border px-3 text-left',
        phone ? 'min-h-16 py-3' : 'py-2.5',
        focused ? 'border-line2 bg-raised' : menu.at ? 'border-line2 bg-raised/60' : 'border-transparent hover:bg-raised/60',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {!scopedProject && <ThreadProjectBadge projectId={t.project_id} projectName={t.project_name} />}
        {t.unread > 0 && <span aria-label="Unread" className="h-[7px] w-[7px] shrink-0 rounded-full bg-wait" />}
        {t.pinned_at && <IconPin size={12} className="shrink-0 text-muted" />}
        {t.is_fork && <IconFork size={12} className="shrink-0 text-accent" aria-label="Forked from another thread" data-testid="fork-icon" />}
        <span title={t.subject} className={cx('min-w-0 flex-1 truncate', phone ? 'text-[15.5px]' : 'text-[14px]', strong ? 'font-[650] text-fg' : 'font-normal text-fg2')}>{t.subject}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted">
        {t.name && <span className="mono shrink-0 rounded-[5px] border border-linestrong px-1.5 text-[11px] leading-[18px] text-fg2">{t.name}</span>}
        {t.last_author === 'user' && <span className="shrink-0 text-subtle">You:</span>}
        <span className="min-w-0 flex-1 truncate">{oneLine(proseOf(t.last_body)) || '—'}</span>
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
        {(t.fork_count ?? 0) > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-[11.5px] text-subtle" title={`${t.fork_count} thread(s) started from here`} data-testid="fork-count">
            <IconFork size={11} />
            {t.fork_count}
          </span>
        )}
        {t.status && <ThreadStatusBadge status={t.status} />}
        <span className="shrink-0 text-[12px] text-subtle">{shortTime(t.updated_at)}</span>
        {t.last_author === 'user' && t.last_delivery && <DeliveryTick d={t.last_delivery} />}
      </div>
    </div>
    <ThreadRowMenu t={t} at={menu.at} onClose={menu.close} onOpen={onOpen} />
    </>
  )
}

