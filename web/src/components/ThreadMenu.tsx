import { useState, type ReactNode } from 'react'
import { THREAD_STATUS_ORDER, api, type Thread } from '../api'
import { threadLink, useApp } from '../lib/app'
import { hm, plural } from '../lib/format'
import { Button, Kbd, MenuItem, MenuLabel, MenuSep, Popover, type MenuAt } from './ui'
import { IconChevronRight } from './icons'

/**
 * A thread's actions: the open thread's "…" menu, and the thread list's right-click / long-press
 * menu (`at`, with extra items such as Open on top).
 */
export function ThreadMoreMenu({
  thread,
  anchor,
  at,
  onClose,
  onArchive,
  onBack,
  openQuestions,
  onShell,
  onFiles,
  top,
  testid,
}: {
  thread: Thread
  anchor: HTMLElement | null
  /** Open as a context menu at this point instead of under `anchor`. */
  at?: MenuAt | null
  onClose: () => void
  onArchive: () => void
  onBack: () => void
  openQuestions: number
  /** Open the session's companion shell (omitted when the session has none). */
  onShell?: () => void
  /** Show the Files pane (the phone's header has no room for its button). */
  onFiles?: () => void
  /** Items above the thread's own (each closes the menu itself). */
  top?: ReactNode
  testid?: string
}) {
  const { toast, error } = useApp()
  const [snooze, setSnooze] = useState<HTMLElement | null>(null)
  const [pick, setPick] = useState(false)
  const [pickValue, setPickValue] = useState('')
  const [naming, setNaming] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const close = () => {
    setSnooze(null)
    setPick(false)
    setNaming(false)
    onClose()
  }
  const doSnooze = (until: Date) => {
    close()
    api
      .snoozeThread(thread.id, until)
      .then(() => {
        toast(`Snoozed until ${until.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`, {
          action: 'Undo',
          undo: true,
          onAction: () => api.unsnoozeThread(thread.id).catch(error),
        })
        onBack()
      })
      .catch(error)
  }
  const at0 = (days: number, hour: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    d.setHours(hour, 0, 0, 0)
    return d
  }
  const laterToday = () => {
    const d = at0(0, 18)
    return d.getTime() > Date.now() + 30 * 60_000 ? d : new Date(Date.now() + 3 * 3600_000)
  }
  const nextWeek = () => {
    const d = at0(0, 9)
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7))
    return d
  }
  const open = !!anchor || !!at
  return (
    <>
      <Popover anchor={anchor} at={at} open={open} onClose={close} testid={testid}>
        {top}
        {thread.snoozed_until ? (
          <MenuItem testid="thread-unsnooze" onClick={() => (close(), api.unsnoozeThread(thread.id).catch(error))}>
            Unsnooze
          </MenuItem>
        ) : (
          <MenuItem testid="thread-snooze" active={!!snooze} onClick={(e) => setSnooze(at ? e.currentTarget : anchor)}>
            Snooze <IconChevronRight size={14} className="ml-auto" />
          </MenuItem>
        )}
        {onShell && (
          <MenuItem testid="thread-open-shell" onClick={() => (close(), onShell())}>
            Open shell
          </MenuItem>
        )}
        {onFiles && (
          <MenuItem testid="thread-open-files" onClick={() => (close(), onFiles())}>
            Files
          </MenuItem>
        )}
        {naming ? (
          <form
            className="flex gap-1.5 p-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              close()
              if (nameValue !== (thread.name ?? '')) api.updateThread(thread.id, { name: nameValue }).catch(error)
            }}
          >
            <input
              autoFocus
              aria-label="Thread name"
              placeholder="short-name"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value.replace(/\s+/g, '-'))}
              className="mono h-8 min-w-0 flex-1 rounded-md border border-linestrong bg-sunken px-1.5 text-[12px] outline-none focus:border-accent"
            />
            <Button size="sm" variant="primary" type="submit">
              OK
            </Button>
          </form>
        ) : (
          <MenuItem testid="thread-rename" onClick={() => (setNameValue(thread.name ?? ''), setNaming(true))}>
            {thread.name ? 'Edit name…' : 'Set name…'}
          </MenuItem>
        )}
        <MenuItem
          testid="thread-pin"
          onClick={() => {
            close()
            ;(thread.pinned_at ? api.unpinThread(thread.id) : api.pinThread(thread.id)).catch(error)
          }}
        >
          {thread.pinned_at ? 'Unpin thread' : 'Pin thread'}
        </MenuItem>
        {THREAD_STATUS_ORDER.filter((st) => st !== thread.status).map((st) => (
          <MenuItem key={st} testid={`thread-mark-${st}`} onClick={() => (close(), api.setThreadStatus(thread.id, st).catch(error))}>
            {st === 'finished' ? 'Mark as finished' : st === 'working' ? 'Mark as working' : st === 'blocked' ? 'Mark as blocked' : 'Mark as needs action'}
          </MenuItem>
        ))}
        <MenuItem
          testid="thread-unread"
          onClick={() => {
            close()
            api
              .markUnread(thread.id)
              .then(onBack)
              .catch(error)
          }}
        >
          Mark unread
        </MenuItem>
        <MenuItem
          testid="thread-copy-link"
          onClick={() => {
            close()
            void navigator.clipboard?.writeText(threadLink(thread.session_id, thread.id))
            toast('Link copied')
          }}
        >
          Copy link
        </MenuItem>
        {openQuestions > 0 && (
          <MenuItem
            testid="thread-reask"
            onClick={() => {
              close()
              api
                .reask(thread.id)
                .then(() => toast(`Asked Claude Code to ask the ${plural(openQuestions, 'open question')} again`))
                .catch(error)
            }}
          >
            Ask again
          </MenuItem>
        )}
        <MenuSep />
        {thread.archived_at ? (
          <MenuItem testid="thread-unarchive" onClick={() => (close(), api.unarchiveThread(thread.id).catch(error))}>
            Unarchive thread
          </MenuItem>
        ) : (
          <MenuItem
            testid="thread-archive"
            hint={<Kbd>⇧E</Kbd>}
            onClick={() => {
              close()
              onArchive()
            }}
          >
            Archive thread
          </MenuItem>
        )}
      </Popover>
      <Popover anchor={snooze} open={!!snooze} onClose={close} side="right" align="start" className="w-[220px]">
        <MenuLabel>Snooze until</MenuLabel>
        <MenuItem hint={hm(laterToday())} onClick={() => doSnooze(laterToday())}>
          Later today
        </MenuItem>
        <MenuItem hint="9:00" onClick={() => doSnooze(at0(1, 9))}>
          Tomorrow
        </MenuItem>
        <MenuItem onClick={() => doSnooze(at0(3, 9))}>In 3 days</MenuItem>
        <MenuItem onClick={() => doSnooze(nextWeek())}>Next week</MenuItem>
        {pick ? (
          <form
            className="flex gap-1.5 p-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (pickValue) doSnooze(new Date(pickValue))
            }}
          >
            <input
              type="datetime-local"
              autoFocus
              value={pickValue}
              onChange={(e) => setPickValue(e.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border border-linestrong bg-sunken px-1.5 text-[12px]"
            />
            <Button size="sm" variant="primary" type="submit">
              OK
            </Button>
          </form>
        ) : (
          <MenuItem onClick={() => setPick(true)}>Pick a time…</MenuItem>
        )}
      </Popover>
    </>
  )
}

/** Right-click / long-press menu of a row in the thread list: Open, Open in new tab, then the thread's own actions. */
export function ThreadRowMenu({ t, at, onClose, onOpen }: { t: Thread; at: MenuAt | null; onClose: () => void; onOpen: () => void }) {
  const { route, navigate, toast, error } = useApp()
  if (!at) return null
  // Acting on the thread that is open closes it, as the open thread's own menu does; other rows stay put.
  const back = () => {
    if (route.t === t.id) navigate({ t: null, f: null })
  }
  return (
    <ThreadMoreMenu
      thread={t}
      anchor={null}
      at={at}
      testid="thread-context-menu"
      onClose={onClose}
      onBack={back}
      openQuestions={t.open_questions}
      onArchive={() =>
        api
          .archiveThread(t.id)
          .then(() => {
            toast(`Archived · "${t.subject}"`, { action: 'Undo', undo: true, onAction: () => api.unarchiveThread(t.id).catch(error) })
            back()
          })
          .catch(error)
      }
      top={
        <>
          <MenuItem testid="thread-open" onClick={() => (onClose(), onOpen())}>
            Open
          </MenuItem>
          <MenuItem testid="thread-open-tab" onClick={() => (onClose(), window.open(threadLink(t.session_id, t.id), '_blank', 'noopener'))}>
            Open in new tab
          </MenuItem>
          <MenuSep />
        </>
      }
    />
  )
}
