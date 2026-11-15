import { useEffect } from 'react'
import { api, type LinearEvent, type Thread } from '../api'
import { useApp } from '../lib/app'
import { shortTime } from '../lib/format'
import { LinearLinkButton } from './LinearLink'
import { IconLinear } from './icons'
import { cx } from './ui'

// The Linear issue linked to a thread: a chip in the thread header (identifier, title, state,
// link, unlink); linking one is the "+ Linear" button's dialog (LinearLink.tsx). Opening a linked
// thread asks the server to sync the issue in the background; the thread reloads by itself when
// Linear's news has been recorded.

export function LinearBar({ thread, compact = false, phone = false }: { thread: Thread; compact?: boolean; phone?: boolean }) {
  // `compact` is the copy in the sticky bar: same actions, shorter labels, no sync of its own.
  // An unlinked thread links (or creates) an issue from the "+ Linear" button (LinearLink.tsx):
  // left of the meta line on desktop, here on phones (no meta line) and in the sticky bar.
  const sx = compact ? '-sticky' : ''
  const { error } = useApp()
  const link = thread.linear
  const linked = !!link

  // Open → sync (the server debounces: at most once in ~45 s per thread).
  useEffect(() => {
    if (!linked || compact) return
    api.refreshLinear(thread.id).catch(() => {})
  }, [thread.id, linked, compact])

  if (!link) {
    if (!compact && !phone) return null
    return (
      <div className={cx('flex items-center gap-2 text-[12px] text-subtle empty:hidden', compact ? 'min-w-0' : 'flex-wrap')} data-testid={`linear-bar${sx}`}>
        <LinearLinkButton thread={thread} testSuffix={sx} />
      </div>
    )
  }
  return (
    <div className={cx('flex items-center gap-2 text-[12px]', compact ? 'min-w-0' : 'flex-wrap')} data-testid={`linear-bar${sx}`}>
      <a
        data-testid={`linear-chip${sx}`}
        href={link.url}
        target="_blank"
        rel="noreferrer"
        className="flex max-w-full items-center gap-1.5 rounded-full border border-line2 bg-raised px-2.5 py-0.5 text-fg2 no-underline hover:border-linestrong"
        title={`Linear: ${link.identifier} ${link.title}`}
      >
        <IconLinear size={13} className="shrink-0 text-subtle" />
        <span className="font-semibold">{link.identifier}</span>
        <span className={cx('truncate', compact && 'hidden sm:inline')}>{link.title}</span>
        {link.state && (
          <span data-testid={`linear-state${sx}`} className="rounded bg-sunken px-1.5 text-[11px] text-subtle">
            {link.state}
          </span>
        )}
      </a>
      {link.syncing && (
        <span data-testid={`linear-syncing${sx}`} className="text-subtle">
          syncing…
        </span>
      )}
      {link.last_error && !compact && (
        <span data-testid="linear-error" className="text-danger" title={link.last_error}>
          Linear: {link.last_error.length > 80 ? link.last_error.slice(0, 80) + '…' : link.last_error}
        </span>
      )}
      {!compact && (<>
      <button
        type="button"
        data-testid="linear-sync"
        onClick={() => api.refreshLinear(thread.id, true).catch(error)}
        className="rounded px-1.5 py-1.5 text-subtle hover:bg-raised hover:text-fg border-0 bg-transparent"
        title={link.last_synced_at ? `Last synced ${shortTime(link.last_synced_at)}` : 'Not synced yet'}
      >
        Sync
      </button>
      <button type="button" data-testid="linear-unlink" onClick={() => api.unlinkLinear(thread.id).catch(error)} className="rounded px-1.5 py-1.5 text-subtle hover:bg-raised hover:text-fg border-0 bg-transparent">
        Unlink
      </button>
      </>)}
    </div>
  )
}

/** A Linear update in the thread: a comment (author, time, link) or a compact change of the issue. */
export function LinearEventItem({ ev, identifier }: { ev: LinearEvent; identifier: string }) {
  if (ev.kind !== 'comment') {
    return (
      <div data-testid="linear-event" data-kind={ev.kind} className="flex items-center gap-2 px-1 text-[12px] text-subtle">
        <span className="rounded bg-raised px-1.5 text-[11px] font-semibold uppercase tracking-wide">Linear</span>
        <span>
          {identifier} {ev.kind === 'state' ? 'status' : ev.kind}: {ev.body}
        </span>
        <span className="text-[11px]">{shortTime(ev.created_at)}</span>
      </div>
    )
  }
  return (
    <div data-testid="linear-event" data-kind="comment" className={cx('rounded-[10px] border border-line2 bg-carddim px-3 py-2.5 text-[13px]', ev.filtered && 'opacity-70')}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px] text-subtle">
        <span className="rounded bg-raised px-1.5 text-[11px] font-semibold uppercase tracking-wide">Linear</span>
        <span className="font-semibold text-fg2">{ev.author}</span>
        <span>commented on {identifier}</span>
        <a href={ev.url} target="_blank" rel="noreferrer" className="text-subtle hover:text-fg">
          {shortTime(ev.created_at)}
        </a>
        {ev.filtered && <span title="Not passed to the agent (comment-author filter)">· not sent to the agent</span>}
      </div>
      <div className="whitespace-pre-wrap break-words">{ev.body}</div>
    </div>
  )
}

/** The events grouped by the message they come before (by time); the rest come after the last message. */
export function groupLinearEvents(messageList: { id: string; created_at: string }[], events: LinearEvent[] | undefined) {
  const before = new Map<string, LinearEvent[]>()
  const tail: LinearEvent[] = []
  for (const ev of events ?? []) {
    const t = Date.parse(ev.created_at)
    const m = messageList.find((x) => Date.parse(x.created_at) > t)
    if (m) before.set(m.id, [...(before.get(m.id) ?? []), ev])
    else tail.push(ev)
  }
  return { before, tail }
}
