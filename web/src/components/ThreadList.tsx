import { useEffect, useMemo, useRef, useState } from 'react'
import { SECTION_LABEL, SECTION_ORDER, api, type Delivery, type Section, type Session, type Thread } from '../api'
import { useApp } from '../lib/app'
import { ComposeFileTiles, clearFiles, fileInputHandlers, uploadIds, useComposeFiles } from '../lib/uploads'
import { oneLine, shortTime } from '../lib/format'
import { useHotkeys } from '../lib/hotkeys'
import { proseOf } from '../lib/markdown'
import { IconChevronRight, IconExpand, IconInbox, IconPaperclip, IconPin } from './icons'
import { Button, IconButton, Skeleton, cx } from './ui'
import { NextStep } from './NextStep'
import { CompletingTextarea } from './Compose'

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
  const { settings } = useApp()
  const groups = useMemo(() => sortThreads(threads ?? []), [threads])
  const flat = groups.flatMap((g) => g.items)
  const [cursor, setCursor] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<Section>>(new Set(['archived', 'snoozed']))
  const [full, setFull] = useState(false) // the new-thread box takes the pane's whole height

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
        </div>
      )}
      <div className={cx('min-h-0 flex-1 overflow-y-auto px-2 pb-3', full && 'hidden')} data-testid="thread-list">
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
      <QuickCompose session={session} phone={phone} onOpen={(id) => (setFull(false), onOpen(id))} full={full} onToggleFull={() => setFull((v) => !v)} />
    </div>
  )
}

/** A box at the bottom of the list: type, send, and a new thread starts with Claude Code. */
function QuickCompose({ session, phone, onOpen, full, onToggleFull }: { session: Session; phone?: boolean; onOpen: (id: string) => void; full: boolean; onToggleFull: () => void }) {
  const { error } = useApp()
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const filesId = `quick:${session.id}`
  const { files, addFiles, addPastedText, remove: removeFile } = useComposeFiles(filesId)
  const io = fileInputHandlers(addFiles, addPastedText)
  const uploading = files.some((f) => f.state === 'uploading')
  const hasFiles = files.some((f) => f.state === 'done')
  const canSend = (!!body.trim() || hasFiles) && !uploading && !sending
  const send = async () => {
    if (!canSend) return
    setSending(true)
    try {
      const th = await api.createThread(session.id, '', body.trim(), undefined, uploadIds(filesId))
      clearFiles(filesId)
      setBody('')
      onOpen(th.id)
    } catch (err) {
      error(err)
    } finally {
      setSending(false)
    }
  }
  const hint =
    session.status === 'ended' ? 'Session ended: Claude gets this after Resume' : session.status === 'working' ? 'Working: Claude gets this when its turn ends' : 'Claude gets this as its next turn'
  return (
    <div className={cx('border-t border-line p-2.5', full ? 'flex min-h-0 flex-1 flex-col' : 'shrink-0')} data-testid="quick-compose" data-full={full}>
      <ComposeFileTiles
        files={files}
        onRemove={removeFile}
        onPutBack={(f) => {
          if (!f.pasted) return
          const at = Math.min(f.pasted.at, body.length)
          setBody(body.slice(0, at) + f.pasted.text + body.slice(at))
          removeFile(f.key)
        }}
      />
      <CompletingTextarea
        ref={ref}
        testid="quick-body"
        dropUp
        autoGrow={{ min: 72, max: 240 }}
        fill={full}
        sessionId={session.id}
        value={body}
        onChange={setBody}
        onSubmit={() => void send()}
        {...io}
        placeholder="Start a new thread with Claude Code… (@ agents, / skills)"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button type="button" aria-label="Attach files" title="Attach files" data-testid="attach-files" onClick={() => fileRef.current?.click()} className="border-0 bg-transparent p-1 text-muted hover:text-fg">
          <IconPaperclip />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <IconButton
          size={28}
          aria-label={full ? 'Back to the thread list' : 'Full height'}
          aria-pressed={full}
          title={full ? 'Back to the thread list' : 'Full height'}
          data-testid="quick-full"
          onClick={onToggleFull}
          className={cx(full && 'bg-sel text-fg')}
        >
          <IconExpand size={15} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-subtle">{hint}</span>
        <Button variant="primary" size="sm" data-testid="quick-send" disabled={!canSend} onClick={() => void send()}>
          Send{phone ? '' : ' ⌘↵'}
        </Button>
      </div>
    </div>
  )
}

export function ThreadRow({ t, focused, onOpen, phone, sessionName }: { t: Thread; focused: boolean; onOpen: () => void; phone?: boolean; sessionName?: string }) {
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
        {sessionName && (
          <span data-testid="thread-session" className="max-w-[40%] shrink-0 truncate rounded-[5px] bg-chip px-1.5 text-[11px] leading-[18px] text-fg2">
            {sessionName}
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
