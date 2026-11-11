import { useEffect, useState } from 'react'
import { api, type LinearEvent, type Thread } from '../api'
import { useApp } from '../lib/app'
import { shortTime } from '../lib/format'
import { LinearCreateDialog } from './LinearCreate'
import { IconPlus, IconSparkle } from './icons'
import { Button, cx } from './ui'

// The Linear issue linked to a thread: a chip in the thread header (identifier, title, state,
// link, unlink) or an input to link one. Opening a linked thread asks the server to sync the
// issue in the background; the thread reloads by itself when Linear's news has been recorded.

const actionCls =
  'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line2 bg-transparent px-2.5 text-[12.5px] text-fg2 hover:border-linestrong hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-45 sm:h-8'

const inputCls = 'h-8 w-56 rounded-md border border-linestrong bg-sunken px-2.5 text-[13px] text-fg outline-none focus:border-accent'

export function LinearBar({ thread, compact = false }: { thread: Thread; compact?: boolean }) {
  // `compact` is the copy in the sticky bar: same actions, shorter labels, no sync of its own.
  const sx = compact ? '-sticky' : ''
  const { error, toast, navigate } = useApp()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [connected, setConnected] = useState(false)
  const link = thread.linear
  const linked = !!link

  // Open → sync (the server debounces: at most once in ~45 s per thread).
  useEffect(() => {
    if (!linked || compact) return
    api.refreshLinear(thread.id).catch(() => {})
  }, [thread.id, linked, compact])

  // Creating an issue needs a login: the button shows only while Linear is connected.
  useEffect(() => {
    if (linked) return
    let live = true
    const load = () => api.linearStatus().then((st) => live && setConnected(st.connected)).catch(() => {})
    load()
    window.addEventListener('minbox:linear', load)
    return () => {
      live = false
      window.removeEventListener('minbox:linear', load)
    }
  }, [linked])

  const submit = async () => {
    if (!value.trim()) return
    setBusy(true)
    setErr('')
    try {
      await api.linkLinear(thread.id, value.trim())
      setValue('')
      setOpen(false)
    } catch (e) {
      const status = (e as { status?: number }).status
      setErr(e instanceof Error ? e.message : String(e))
      if (status === 409) toast('Connect Linear first: Settings › Integrations', { error: true, action: 'Open', onAction: () => navigate({ view: 'settings', ss: 'integrations' }) })
    }
    setBusy(false)
  }

  if (!link) {
    return (
      <div className={cx('flex items-center gap-2 text-[12px]', compact ? 'min-w-0' : 'flex-wrap')} data-testid={`linear-bar${sx}`}>
        {!open ? (
          <button type="button" data-testid={`linear-link-open${sx}`} onClick={() => setOpen(true)} className={actionCls}>
            <IconPlus size={13} />
            {compact ? 'Link' : 'Link Linear issue'}
          </button>
        ) : (
          <>
            <input
              data-testid={`linear-link-input${sx}`}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') setOpen(false)
              }}
              placeholder="ENG-123 or issue URL"
              className={cx(inputCls, compact && 'min-w-0 flex-1 sm:w-56 sm:flex-none')}
            />
            <Button size="sm" variant="primary" data-testid={`linear-link-submit${sx}`} disabled={busy || !value.trim()} onClick={submit}>
              Link
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </>
        )}
        {!open && connected && (
          <button type="button" data-testid={`linear-create-open${sx}`} onClick={() => setCreating(true)} className={actionCls}>
            <IconSparkle size={13} />
            {compact ? 'Create' : 'Create Linear issue'}
          </button>
        )}
        {creating && <LinearCreateDialog thread={thread} onClose={() => setCreating(false)} />}
        {err && (
          <span data-testid={`linear-link-error${sx}`} className="text-danger">
            {err}
          </span>
        )}
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
        title={link.title}
      >
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
