import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { THREAD_STATUS_ORDER, api, type Annotation, type Answer, type Attachment, type Message, type Question, type Session, type Thread } from '../api'
import { ALL_THREADS, threadLink, useApp } from '../lib/app'
import { clearReplyDraft, getReplyDraft, setReplyDraft, updateReplyDraft, useReplyDraft } from '../lib/drafts'
import { hm, minutesSince, plural, shortTime, span } from '../lib/format'
import { useHotkeys } from '../lib/hotkeys'
import { splitQuestions } from '../lib/markdown'
import { opensBeside, steppable, threadArtifacts } from '../lib/attachments'
import { ComposeFileTiles, clearFiles, fileInputHandlers, uploadIds, useComposeFiles } from '../lib/uploads'
import { AttachmentTiles, ArtifactsGrid } from './AttachmentTiles'
import { MessageBody } from './MessageBody'
import {
  IconArchive,
  IconBack,
  IconCheck,
  IconClaude,
  IconExpand,
  IconFold,
  IconGrid,
  IconMore,
  IconSend,
  IconThumb,
  IconUnfold,
  IconTerminal,
  IconPaperclip,
} from './icons'
import { ActionItems, QuestionCard, answerIsEmpty } from './QuestionCard'
import { DELIVERY } from './ThreadList'
import { Button, IconButton, Kbd, MenuItem, MenuLabel, MenuSep, Popover, StatusDot, ThreadStatusBadge, cx } from './ui'
import { waitsOnPerson } from './Sidebar'

type Props = {
  session: Session
  threadId: string
  /** The session's threads in list order, for J/K. */
  siblings: Thread[] | null
  onBack: () => void
  /** Tablet: shows the Terminal button in the header (opens [thread | terminal]). */
  onTerminal?: () => void
  phone?: boolean
}

export function useThread(threadId: string | null): [Thread | null, () => void] {
  const { threadVersion, error } = useApp()
  const [thread, setThread] = useState<Thread | null>(null)
  const v = threadId ? (threadVersion[threadId] ?? 0) + (threadVersion[ALL_THREADS] ?? 0) : 0
  const load = useCallback(() => {
    if (!threadId) return
    api
      .thread(threadId)
      .then(setThread)
      .catch((e) => {
        if ((e as { status?: number }).status === 404) setThread(null)
        else error(e)
      })
  }, [threadId, error])
  useEffect(() => {
    load()
  }, [load, v])
  useEffect(() => setThread(null), [threadId])
  return [thread, load]
}

/** The questions of a message that still take answers (by key). */
function openKeysOf(m: Message | null): Set<string> {
  return m ? openKeys(m) : new Set()
}

function openKeys(m: Message): Set<string> {
  const out = new Set<string>()
  for (const q of m.questions ?? []) {
    if (m.closed?.[q.key]) continue
    const a = m.answer_state?.[q.key]
    if (a && !answerIsEmpty(a)) continue
    out.add(q.key)
  }
  return out
}

export function ThreadView({ session, threadId, siblings, onBack, onTerminal, phone }: Props) {
  const { navigate, route, toast, error, setOverlay, sessions } = useApp()
  const [thread] = useThread(threadId)
  const draft = useReplyDraft(threadId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [foldAll, setFoldAll] = useState(false)
  const [firstNew, setFirstNew] = useState<string | null | undefined>(undefined)
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null)
  const [showArtifacts, setShowArtifacts] = useState(false)
  const [fullReply, setFullReply] = useState(false) // the reply box takes the pane's whole height

  const messages = thread?.messages ?? []

  // New messages below the fold: a pill to jump down. A view that was at the bottom follows new
  // messages; one scrolled up stays put and the pill says something came in. Whether it was at the
  // bottom is read on every scroll: by the time a message renders, the page is already taller.
  const [unseen, setUnseen] = useState(0)
  const seenCount = useRef<number | null>(null)
  const pinned = useRef(true)
  const nearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 80
  const toBottom = () => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  useEffect(() => {
    if (!thread) return
    const n = messages.length
    const prev = seenCount.current
    seenCount.current = n
    const el = scrollRef.current
    if (!el) return
    if (prev === null) {
      pinned.current = nearBottom(el)
      return
    }
    if (n <= prev) return
    const added = messages.slice(prev)
    if (pinned.current || added.every((m) => m.author === 'user')) {
      pinned.current = true
      requestAnimationFrame(toBottom)
    } else setUnseen((u) => u + added.filter((m) => m.author === 'agent').length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, messages.length])

  // Select text in the messages: a bubble offers Reply, which quotes it into the reply box.
  const [quote, setQuote] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const evaluate = () => {
      const sel = window.getSelection()
      const box = scrollRef.current
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !box) return setQuote(null)
      const range = sel.getRangeAt(0)
      const text = sel.toString().trim()
      // Where it starts decides: a triple-click can run on to the start of the next block.
      const start = range.startContainer
      if (!text || !box.contains(start.nodeType === 1 ? start : start.parentNode)) return setQuote(null)
      const rects = range.getClientRects()
      const r = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect()
      const zoom = parseFloat((document.getElementById('root') as HTMLElement).style.zoom || '1')
      const first = rects.length ? rects[0]! : r
      const vw = window.innerWidth / zoom
      // On touch the OS toolbar (copy / look up / share) sits above the selection, so go under it,
      // clear of the end drag handle; fall back to above (past the toolbar) at the bottom edge.
      const touch = window.matchMedia('(pointer: coarse)').matches
      const vh = window.innerHeight / zoom
      const below = touch ? r.bottom / zoom + 30 + 32 + 8 <= vh : first.top / zoom < 48 // no room above: under the selection instead
      setQuote({
        text,
        x: Math.min(Math.max(r.right / zoom, 100), vw - 8), // the bubble's right edge sits at the selection's end
        y: below ? r.bottom / zoom + (touch ? 30 : 6) : first.top / zoom - (touch ? 44 : 6),
        below,
      })
    }
    const on = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(evaluate, 150)
    }
    document.addEventListener('selectionchange', on)
    return () => {
      document.removeEventListener('selectionchange', on)
      if (timer) clearTimeout(timer)
    }
  }, [])
  const quoteIntoReply = () => {
    if (!quote) return
    const block = quote.text.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n')
    updateReplyDraft(threadId, (d) => ({ ...d, words: d.words.trim() ? `${d.words.replace(/\s+$/, '')}\n\n${block}\n\n` : `${block}\n\n` }))
    window.getSelection()?.removeAllRanges()
    setQuote(null)
    // After the draft re-renders the box: focus it with the caret at the end, for the instruction.
    requestAnimationFrame(() => {
      const el = replyRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
      el.scrollTop = el.scrollHeight
    })
  }

  // Remember where "new since you looked" before marking the thread read.
  useEffect(() => {
    if (!thread || firstNew !== undefined) return
    const m = thread.messages?.find((x) => x.author === 'agent' && !x.read_at)
    setFirstNew(m?.id ?? null)
  }, [thread, firstNew])

  // Opening the thread means the person looked at it.
  useEffect(() => {
    if (!thread || thread.unread === 0) return
    const mark = () => {
      if (document.visibilityState === 'visible') api.markSeen(threadId).catch(() => {})
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [thread, threadId])

  const lastAgentIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.author === 'agent') return i
    return -1
  }, [messages])
  const target = lastAgentIdx >= 0 ? messages[lastAgentIdx]! : null
  const open = target ? openKeys(target) : new Set<string>()
  const openQs = (target?.questions ?? []).filter((q) => open.has(q.key))
  const picks = target ? (draft.picks[target.id] ?? {}) : {}
  const answers: Answer[] = openQs.map((q) => picks[q.key]).filter((a): a is Answer => !!a && !answerIsEmpty(a))
  const stayOpen = openQs.length - answers.length
  const attachments = threadArtifacts(messages)
  const stepFiles = steppable(messages)
  const newestId = stepFiles.length ? stepFiles[stepFiles.length - 1]!.id : null

  const setPick = (m: Message, a: Answer) =>
    updateReplyDraft(threadId, (d) => ({
      ...d,
      picks: { ...d.picks, [m.id]: { ...(d.picks[m.id] ?? {}), [a.key]: a } },
      pickedAt: { ...d.pickedAt, [a.key]: Date.now() },
    }))

  // ---- actions ----
  const markRead = () => {
    api
      .markRead(threadId)
      .then(() => {
        toast('Marked read · Moves to Quiet', { action: 'Move back', undo: true, onAction: () => api.unmarkRead(threadId).catch(error) })
        onBack()
      })
      .catch(error)
  }
  const archive = () => {
    if (!thread) return
    api
      .archiveThread(threadId)
      .then(() => {
        toast(`Archived · "${thread.subject}"`, { action: 'Undo', undo: true, onAction: () => api.unarchiveThread(threadId).catch(error) })
        onBack()
      })
      .catch(error)
  }
  const openAttachment = (a: Attachment) => {
    if (a.kind === 'review') navigate({ view: 'review', r: a.id }, { push: true })
    else if (!opensBeside(a)) window.open(api.attachmentDownloadUrl(a.id), '_blank')
    else navigate({ f: a.id, tab: 'inbox' })
  }
  const step = (d: 1 | -1) => {
    const list = siblings ?? []
    const i = list.findIndex((t) => t.id === threadId)
    const next = list[i + d]
    if (next) navigate({ s: next.session_id, t: next.id, f: null })
  }
  const scrollTo = (sel: string) => scrollRef.current?.querySelector(sel)?.scrollIntoView({ block: 'center', behavior: 'smooth' })

  useHotkeys(
    {
      r: () => replyRef.current?.focus(),
      e: markRead,
      'shift+e': archive,
      j: () => step(1),
      k: () => step(-1),
      n: () => scrollTo('[data-new-divider]'),
      q: () => {
        setExpanded(true)
        setTimeout(() => scrollTo('[data-question-key][data-state="Open"], [data-question-key][data-state="Draft"]'), 30)
      },
      ']': () => {
        const a = stepFiles[0]
        if (a) openAttachment(a)
      },
      '[': () => {
        const a = stepFiles[stepFiles.length - 1]
        if (a) openAttachment(a)
      },
      o: () => {
        const a = stepFiles[stepFiles.length - 1]
        if (a) openAttachment(a)
      },
      f: () => {
        const a = stepFiles[stepFiles.length - 1]
        if (a) openAttachment(a)
      },
      escape: () => {
        if (route.f) navigate({ f: null })
        else onBack()
      },
    },
    !phone,
  )

  if (!thread) {
    return (
      <div className="flex h-full flex-col" data-testid="thread-view">
        {!phone && <ThreadHeaderBar session={session} onBack={onBack} others={unreadElsewhere(siblings, threadId)} />}
        <div className="p-6 text-[13px] text-subtle">Loading…</div>
      </div>
    )
  }

  // Folding: earlier messages collapse into one row; the newest stay open.
  const n = messages.length
  const newIdx = firstNew ? messages.findIndex((m) => m.id === firstNew) : -1
  let anchor = foldAll ? n - 1 : newIdx >= 0 ? newIdx : Math.max(0, n - 2)
  if (expanded) anchor = 0
  const folded = messages.slice(0, Math.max(0, anchor - 1))
  const compactOne = anchor >= 1 ? messages[anchor - 1] : null
  const shown = messages.slice(anchor)
  const lastUser = [...messages].reverse().find((m) => m.author === 'user' && m.kind !== 'note')
  const newCount = newIdx >= 0 ? messages.slice(newIdx).filter((m) => m.author === 'agent').length : 0

  return (
    <div className="flex h-full flex-col" data-testid="thread-view" data-thread-id={thread.id}>
      {!phone && (
        <ThreadHeaderBar session={session} onBack={onBack} others={unreadElsewhere(siblings, threadId)}>
          {onTerminal && (
            <button
              type="button"
              data-testid="tablet-terminal"
              aria-label={`Open ${session.name}'s terminal`}
              title="Show the terminal next to this thread"
              onClick={onTerminal}
              className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line2 bg-transparent px-2 text-[12.5px] text-fg2 hover:bg-raised"
            >
              <IconTerminal size={14} />
              Terminal
            </button>
          )}
          <button
            type="button"
            data-testid="mark-read"
            onClick={markRead}
            className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border-0 bg-transparent px-2 text-[12.5px] text-fg2 hover:bg-raised"
          >
            <IconCheck size={14} />
            Mark read
            <Kbd>E</Kbd>
          </button>
          {attachments.length > 0 && (
            <button
              type="button"
              data-testid="artifacts-button"
              aria-label={`Artifacts, ${attachments.length}`}
              aria-pressed={showArtifacts}
              title={showArtifacts ? 'Back to the thread' : 'Artifacts: every file, image and guided review in this thread'}
              onClick={() => setShowArtifacts((v) => !v)}
              className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border-0 bg-transparent px-2 text-[12.5px] text-fg2 hover:bg-raised"
            >
              <IconGrid size={14} />
              Artifacts {attachments.length}
            </button>
          )}
          <IconButton aria-label={foldAll ? 'Unfold all' : 'Fold all'} title={foldAll ? 'Unfold all' : 'Fold all'} data-testid="fold-all" onClick={() => {
            setFoldAll((v) => !v)
            setExpanded(false)
          }}>
            {foldAll ? <IconUnfold size={15} /> : <IconFold size={15} />}
          </IconButton>
          <IconButton aria-label="More" data-testid="thread-more" onClick={(e) => setMoreAnchor(e.currentTarget)}>
            <IconMore size={15} />
          </IconButton>
        </ThreadHeaderBar>
      )}
      <ThreadMoreMenu thread={thread} anchor={moreAnchor} onClose={() => setMoreAnchor(null)} onArchive={archive} onBack={onBack} openQuestions={openQs.length} />

      <div className={cx('relative flex min-h-0 flex-1 flex-col', fullReply && 'hidden')}>
      {unseen > 0 && (
        <button
          type="button"
          data-testid="new-message-pill"
          onClick={() => {
            toBottom()
            setUnseen(0)
          }}
          className="absolute bottom-3 left-1/2 z-[2] flex h-8 -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border-0 bg-accent px-3.5 text-[12.5px] font-semibold text-onaccent shadow-pop"
        >
          ↓ {unseen === 1 ? 'New message' : `${unseen} new messages`}
        </button>
      )}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          pinned.current = nearBottom(e.currentTarget)
          if (pinned.current && unseen > 0) setUnseen(0)
        }}
        className={cx('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto', phone ? 'px-3.5 pb-4 pt-3.5' : 'px-[18px] py-3.5')}
      >
        {!phone && (
          <div className="flex flex-col gap-1.5">
            <h2 data-testid="thread-subject" className="m-0 text-[19px] font-[650] leading-[1.35]">
              {thread.subject}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-subtle">
              <ThreadStatusBadge status={thread.status} />
              <ThreadName thread={thread} />
              <span>
                {plural(thread.message_count ?? n, 'message')} · {span(thread.created_at, thread.updated_at)}
              </span>
              {newCount > 0 && <span className="font-semibold text-wait">· {newCount} new since you looked</span>}
            </div>
          </div>
        )}
        {phone && <span data-testid="thread-subject" className="sr-only">{thread.subject}</span>}

        <ThreadNotices thread={thread} target={target} />

        {showArtifacts && (
          <ArtifactsGrid
            messages={messages}
            annotations={draft.annotations}
            sessionName={session.name}
            onOpen={(a) => {
              setShowArtifacts(false)
              openAttachment(a)
            }}
          />
        )}
        {!showArtifacts && folded.length > 0 && (
          <button
            type="button"
            data-testid="earlier"
            onClick={() => setExpanded(true)}
            className="flex items-center gap-2.5 rounded-[9px] border border-line bg-carddim px-3 py-[9px] text-left text-[12.5px] text-muted hover:border-line2"
          >
            <span className="font-semibold text-fg2">{plural(folded.length, 'earlier message')}</span>
            <span className="flex-1" />
            <span>{foldedSummary(folded)}</span>
          </button>
        )}
        {!showArtifacts && compactOne && <CompactMessage m={compactOne} onClick={() => setExpanded(true)} />}

        {!showArtifacts && shown.map((m) => (
          <div key={m.id} className="contents">
            {m.id === firstNew && !foldAll && (
              <div data-new-divider className="flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-[0.06em] text-wait">
                <span>New</span>
                <span className="h-px flex-1 bg-wait/35" />
              </div>
            )}
            {m.author === 'agent' ? (
              <AgentMessage
                m={m}
                session={session}
                thread={thread}
                answerable={m === target}
                picks={draft.picks[m.id] ?? {}}
                pickedAt={draft.pickedAt}
                onPick={(a) => setPick(m, a)}
                annotations={draft.annotations}
                onOpen={openAttachment}
                onReply={() => replyRef.current?.focus()}
                phone={phone}
                openId={route.f}
                newestId={newestId}
              />
            ) : (
              <UserMessage
                m={m}
                session={session}
                questionsOf={(id) => messages.find((x) => x.id === id)?.questions ?? []}
                phone={phone}
                onOpen={openAttachment}
                openId={route.f}
                newestId={newestId}
              />
            )}
            {m === lastUser && <DeliveryLine m={m} session={session} />}
          </div>
        ))}
      </div>
      </div>

      {quote && (
        <button
          type="button"
          data-testid="quote-reply"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()} // a tap must not clear the selection before the click
          onClick={quoteIntoReply}
          style={{ left: quote.x, top: quote.y, transform: quote.below ? 'translateX(-100%)' : 'translate(-100%, -100%)' }}
          className="fixed z-[30] flex h-8 items-center gap-1.5 rounded-lg border border-linestrong bg-overlay px-3 text-[12.5px] font-semibold text-fg shadow-pop hover:bg-raised"
        >
          ❝ Reply
        </button>
      )}

      <ReplyBox
        session={session}
        thread={thread}
        target={target}
        answers={answers}
        openCount={openQs.length}
        stayOpen={stayOpen}
        replyRef={replyRef}
        phone={phone}
        full={fullReply}
        onToggleFull={() => setFullReply((v) => !v)}
        sessions={sessions ?? []}
        onCompose={() => setOverlay({ kind: 'compose', sessionId: session.id })}
      />
    </div>
  )
}

function foldedSummary(ms: Message[]): string {
  const answered = ms.filter((m) => m.author === 'user' && (m.answers?.length ?? 0) > 0).length
  const lastUser = [...ms].reverse().find((m) => m.author === 'user')
  const parts: string[] = []
  if (answered) parts.push(`${answered} answered`)
  if (lastUser?.delivery) parts.push(DELIVERY[lastUser.delivery].label)
  return parts.join(' · ')
}

/** How many other threads of the session hold messages the person has not seen. */
export function unreadElsewhere(threads: Thread[] | null, openId: string | null): number {
  return (threads ?? []).filter((t) => t.id !== openId && t.unread > 0 && !t.archived_at).length
}

function ThreadHeaderBar({ session, onBack, others = 0, children }: { session: Session; onBack: () => void; others?: number; children?: React.ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line px-2">
      <button
        type="button"
        data-testid="thread-back"
        onClick={onBack}
        title="Back to the list (Esc)"
        className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent pl-1 pr-2 text-[13px] text-fg2 hover:bg-raised"
      >
        <IconBack size={14} className="shrink-0 text-subtle" />
        {others > 0 && (
          <span data-testid="back-badge" title="Other threads have new messages" className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-onaccent">
            {others}
          </span>
        )}
        <StatusDot s={session} waits={waitsOnPerson(session)} size={7} ring={false} />
        <span className="truncate">{session.name}</span>
      </button>
      <span className="flex-1" />
      {children}
    </div>
  )
}

function ThreadName({ thread }: { thread: Thread }) {
  const { error } = useApp()
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(thread.name ?? '')
  if (editing)
    return (
      <input
        autoFocus
        aria-label="Thread name"
        value={v}
        onChange={(e) => setV(e.target.value.replace(/\s+/g, '-'))}
        onBlur={() => {
          setEditing(false)
          if (v !== (thread.name ?? '')) api.updateThread(thread.id, { name: v }).catch(error)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            e.stopPropagation()
            setV(thread.name ?? '')
            setEditing(false)
          }
        }}
        className="mono h-5 w-36 rounded-[5px] border border-accent bg-sunken px-1.5 text-[11px] text-fg outline-none"
      />
    )
  return thread.name ? (
    <button type="button" onClick={() => setEditing(true)} className="mono rounded-[5px] border border-linestrong bg-transparent px-1.5 text-[11px] leading-[18px] text-fg2">
      {thread.name}
    </button>
  ) : (
    <button type="button" onClick={() => setEditing(true)} className="mono rounded-[5px] border border-dashed border-[#52525b] bg-transparent px-2 text-[11px] leading-[18px] text-subtle">
      + name
    </button>
  )
}

function ThreadMoreMenu({
  thread,
  anchor,
  onClose,
  onArchive,
  onBack,
  openQuestions,
}: {
  thread: Thread
  anchor: HTMLElement | null
  onClose: () => void
  onArchive: () => void
  onBack: () => void
  openQuestions: number
}) {
  const { toast, error } = useApp()
  const [snooze, setSnooze] = useState<HTMLElement | null>(null)
  const [pick, setPick] = useState(false)
  const [pickValue, setPickValue] = useState('')
  const close = () => {
    setSnooze(null)
    setPick(false)
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
  const at = (days: number, hour: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    d.setHours(hour, 0, 0, 0)
    return d
  }
  const laterToday = () => {
    const d = at(0, 18)
    return d.getTime() > Date.now() + 30 * 60_000 ? d : new Date(Date.now() + 3 * 3600_000)
  }
  const nextWeek = () => {
    const d = at(0, 9)
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7))
    return d
  }
  return (
    <>
      <Popover anchor={anchor} open={!!anchor} onClose={close}>
        {thread.snoozed_until ? (
          <MenuItem testid="thread-unsnooze" onClick={() => (close(), api.unsnoozeThread(thread.id).catch(error))}>
            Unsnooze
          </MenuItem>
        ) : (
          <MenuItem testid="thread-snooze" active={!!snooze} onClick={() => setSnooze(anchor)}>
            Snooze ›
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
            {st === 'finished' ? 'Mark as finished' : st === 'working' ? 'Mark as working' : 'Mark as needs action'}
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
        <MenuItem hint="9:00" onClick={() => doSnooze(at(1, 9))}>
          Tomorrow
        </MenuItem>
        <MenuItem onClick={() => doSnooze(at(3, 9))}>In 3 days</MenuItem>
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

function ThreadNotices({ thread, target }: { thread: Thread; target: Message | null }) {
  const { error } = useApp()
  const notices: React.ReactNode[] = []
  if (thread.archived_at) {
    notices.push(
      <div key="arch" data-testid="archived-notice" className="flex items-center gap-2.5 rounded-[10px] border border-line2 bg-raised px-3 py-2.5 text-[12.5px] text-fg2">
        <span className="flex-1">
          {thread.came_back ? 'Archived · Claude Code wrote after you archived it. Your reply goes to it; the thread stays archived.' : `Archived ${shortTime(thread.archived_at)}.`}
        </span>
        <Button size="sm" data-testid="thread-unarchive" onClick={() => api.unarchiveThread(thread.id).catch(error)}>
          Unarchive
        </Button>
      </div>,
    )
  }
  if (thread.snoozed_until && new Date(thread.snoozed_until).getTime() > Date.now()) {
    notices.push(
      <div key="snz" className="flex items-center gap-2.5 rounded-[10px] border border-line2 bg-raised px-3 py-2.5 text-[12.5px] text-fg2">
        <span className="flex-1">Snoozed until {new Date(thread.snoozed_until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.</span>
        <Button size="sm" onClick={() => api.unsnoozeThread(thread.id).catch(error)}>
          Unsnooze
        </Button>
      </div>,
    )
  }
  const replaced = (target?.questions ?? []).filter((q) => q.replaces)
  if (replaced.length > 0) {
    notices.push(
      <div key="rep" role="alert" className="rounded-[10px] border border-danger/35 bg-dangerstrong/10 px-3 py-2.5 text-[12.5px] text-dangerfg">
        Claude Code replaced {replaced.length === 1 ? 'a question' : `${replaced.length} questions`} at {hm(target!.created_at)}. Your picks on the old one won't be sent.
      </div>,
    )
  }
  const holds = (target?.questions ?? []).reduce((n, q) => n + (q.holds_up?.length ?? 0), 0)
  if (holds > 0 && (thread.open_questions ?? 0) > 0) {
    notices.push(
      <div key="hold" className="rounded-[10px] border border-line2 bg-raised px-3 py-2.5 text-[12.5px] text-fg2">
        Waiting on this answer · <span className="text-wait">Holds up {holds}</span>
      </div>,
    )
  }
  return <>{notices}</>
}

function CompactMessage({ m, onClick }: { m: Message; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="message"
      data-author={m.author === 'agent' ? 'claude' : 'human'}
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-[9px] border border-line bg-carddim px-3 py-[9px] text-left text-[12.5px]"
    >
      <span className="font-semibold">{m.author === 'agent' ? 'Claude Code' : 'You'}</span>
      <span className="min-w-0 flex-1 truncate text-muted">{(m.author === 'user' ? m.words || m.body : m.body).replace(/:::[a-z-]*/g, '').replace(/\s+/g, ' ')}</span>
      <span className="text-subtle">{hm(m.created_at)}</span>
      {m.author === 'user' && m.delivery && (
        <span className={DELIVERY[m.delivery].color} data-testid="delivery-tick" data-delivery={m.delivery}>
          {DELIVERY[m.delivery].icon}
        </span>
      )}
    </button>
  )
}

function AgentMessage({
  m,
  session,
  thread,
  answerable,
  picks,
  pickedAt,
  onPick,
  annotations,
  onOpen,
  onReply,
  phone,
  openId,
  newestId,
}: {
  m: Message
  session: Session
  thread: Thread
  openId: string | null
  newestId: string | null
  answerable: boolean
  picks: Record<string, Answer>
  pickedAt: Record<string, number>
  onPick: (a: Answer) => void
  annotations: Annotation[]
  onOpen: (a: Attachment) => void
  onReply: () => void
  phone?: boolean
}) {
  const { toast, error } = useApp()
  const segments = useMemo(() => splitQuestions(m.body), [m.body])
  const questions = m.questions ?? []
  const nonAction = questions.filter((q) => q.kind !== 'action')
  const thumbs = () => {
    let cancelled = false
    toast('👍 Looks good · sending in 5 s', { action: 'Undo', undo: true, ms: 5000, onAction: () => (cancelled = true) })
    setTimeout(() => {
      if (!cancelled) api.reply(thread.id, { words: '👍 Looks good' }).catch(error)
    }, 5000)
  }
  const closedOf = (q: Question) => {
    if (m.closed?.[q.key]) return m.closed[q.key]!
    if (!answerable && !(m.answer_state?.[q.key] && !answerIsEmpty(m.answer_state[q.key]))) return 'moved_on' as const
    return null
  }
  return (
    <article data-testid="message" data-author="claude" data-message-id={m.id} className="group flex flex-col gap-2.5">
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className={cx('flex shrink-0 items-center justify-center bg-[#2a2116] text-wait', phone ? 'h-6 w-6 rounded-full' : 'h-7 w-7 rounded-lg')}>
          <IconClaude size={phone ? 13 : 15} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="text-[13.5px]">
            <span className="font-[650]">{phone ? 'Claude' : 'Claude Code'}</span> {!phone && <span className="text-muted">in {session.name}</span>}
          </span>
          {!phone && <span className="text-[12px] text-subtle">to you</span>}
        </div>
        <button
          type="button"
          aria-label="Looks good"
          title="👍 Looks good"
          data-testid="thumbs-up"
          onClick={thumbs}
          className="invisible h-6 rounded-md border-0 bg-transparent px-1 text-subtle hover:text-fg group-hover:visible"
        >
          <IconThumb size={14} />
        </button>
        <button type="button" onClick={onReply} title="Reply (R)" className="border-0 bg-transparent text-[12px] text-subtle hover:text-fg">
          {hm(m.created_at)} ↩
        </button>
      </div>
      {segments.map((seg, i) => {
        if (seg.kind === 'md')
          return <MessageBody key={i} text={seg.text} message={m} baseDir={session.cwd} onOpen={onOpen} author={`Claude Code in ${session.name}`} className={phone ? 'text-[15px]' : 'text-[13.5px]'} />
        if (seg.kind === 'actions') {
          const items = questions.slice(seg.start, seg.start + seg.count)
          return (
            <ActionItems
              key={i}
              items={items}
              answers={Object.fromEntries(items.map((q) => [q.key, m.answer_state?.[q.key]]))}
              drafts={picks}
              onDraft={onPick}
              readOnly={!answerable}
            />
          )
        }
        const q = questions[seg.index]
        if (!q) return null
        const idx = nonAction.indexOf(q)
        return (
          <QuestionCard
            key={q.key}
            index={idx}
            total={nonAction.length}
            q={q}
            sent={m.answer_state?.[q.key] && !answerIsEmpty(m.answer_state[q.key]) ? m.answer_state[q.key] : undefined}
            draft={picks[q.key]}
            pickedAt={pickedAt[q.key]}
            onDraft={onPick}
            closed={closedOf(q)}
            phone={phone}
          />
        )
      })}
      {(m.attachments?.length ?? 0) > 0 && <AttachmentTiles items={m.attachments!} annotations={annotations} onOpen={onOpen} openId={openId} newestId={newestId} />}
    </article>
  )
}

function UserMessage({
  m,
  session,
  questionsOf,
  phone,
  onOpen,
  openId,
  newestId,
}: {
  m: Message
  session: Session
  questionsOf: (id: string) => Question[]
  phone?: boolean
  onOpen: (a: Attachment) => void
  openId: string | null
  newestId: string | null
}) {
  if (m.kind === 'note') {
    return (
      <div data-testid="message" data-author="human" data-kind="note" className="rounded-[10px] border border-line2 bg-raised px-3 py-2.5 text-[12.5px] text-fg2">
        {m.words || m.body} <span className="text-subtle">· {m.delivery === 'delivered' ? 'Delivered' : 'Waiting'}</span>
      </div>
    )
  }
  const qs = m.answers_for ? questionsOf(m.answers_for) : []
  const words = m.words ?? (m.answers?.length ? '' : m.body)
  return (
    <article data-testid="message" data-author="human" data-message-id={m.id} className="flex flex-col gap-2 rounded-xl bg-[#1a1a1f] px-3.5 py-3 [[data-theme=light]_&]:bg-raised">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-semibold">You</span>
        <span className="text-[12.5px] text-subtle">{hm(m.created_at)}</span>
        {m.urgent && <span className="text-[11px] font-semibold text-danger">Send now</span>}
      </div>
      {words && <MessageBody text={words} message={m} baseDir={session.cwd} onOpen={onOpen} author="you" className={phone ? 'text-[15px]' : 'text-[13.5px]'} />}
      {(m.attachments?.length ?? 0) > 0 && <AttachmentTiles items={m.attachments!} annotations={[]} onOpen={onOpen} openId={openId} newestId={newestId} />}
      {(m.answers?.length ?? 0) > 0 && (
        <div data-testid="sent-answers" className="flex flex-col gap-[3px] border-t border-[#2a2a30] pt-2 text-[13px] text-muted">
          {(m.answers ?? []).map((a) => {
            const i = qs.findIndex((q) => q.key === a.key)
            const q = qs[i]
            return (
              <span key={a.key}>
                <span className="text-subtle">{q?.kind === 'action' ? '✓' : `Q${i + 1}`}</span> {q?.prompt ?? a.key} → <span className="text-fg">{summarize(a)}</span>
              </span>
            )
          })}
        </div>
      )}
      {(m.annotations?.length ?? 0) > 0 && <div className="text-[12.5px] text-muted">💬 {plural(m.annotations!.length, 'annotation')}</div>}
    </article>
  )
}

function summarize(a: Answer): string {
  if (a.skipped) return 'Skipped'
  const parts = [...(a.selected ?? [])]
  if (a.other?.trim()) parts.push(`Other: ${a.other.trim()}`)
  if (a.text?.trim()) parts.push(a.text.trim())
  return parts.join(', ') || (a.note ? `Note: ${a.note}` : '')
}

const AUTO_SEND_MIN = 5
/** A queued message waiting this long (idle session, or a silent mod) shows a warning and Send now. */
const QUEUED_WARN_MS = 20_000

function queuedWarnMs(): number {
  return (window as unknown as { __minboxTimings?: { queuedWarnMs?: number } }).__minboxTimings?.queuedWarnMs ?? QUEUED_WARN_MS
}

export function DeliveryLine({ m, session }: { m: Message; session: Session }) {
  const { error } = useApp()
  const d = m.delivery ?? 'queued'
  const v = DELIVERY[d]
  // Re-render while queued, so the waiting text and the warning appear on time.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (d !== 'queued') return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [d])
  let text: string
  let restart = false
  let now = false
  let resume = false
  let cancel = false
  if (d === 'delivered') text = `Delivered to Claude Code, ${hm(m.delivered_at ?? m.created_at)}`
  else if (d === 'sending') text = 'Sending to Claude Code…'
  else if (d === 'undelivered') {
    text = 'Not delivered. That session stopped. Resume to deliver.'
    resume = true
  } else {
    const waited = minutesSince(m.created_at)
    const waitedMs = Date.now() - new Date(m.created_at).getTime()
    const stuck = waitedMs >= queuedWarnMs() && (session.status !== 'working' || !!session.mod_silent)
    if (stuck && session.mod_silent) {
      text = m.urgent ? 'Send now pressed · Claude Code is not answering; it goes in when it does.' : 'Claude Code is not picking this up. Its connection to minbox is silent.'
      now = !m.urgent
      restart = true
    } else if (stuck && session.status !== 'working') {
      text = m.urgent ? 'Send now pressed · goes in on the next check.' : 'Claude Code is not picking this up yet.'
      now = !m.urgent
    } else if (session.status === 'working' && m.urgent) text = 'Send now pressed · goes into the running turn.'
    else if (session.status === 'working' && waited >= 2) {
      text = `Undelivered ${waited} min · goes in by itself in ${Math.max(1, AUTO_SEND_MIN - waited)} min`
      now = true
    } else if (session.status === 'working') {
      text = 'Queued · Claude Code is working; it gets this when its turn ends.'
      now = true
    }
    else text = waitedMs >= 5000 ? 'Waiting for Claude Code…' : 'Queued · goes in when Claude Code is idle.'
    cancel = true
  }
  // Cancelling deletes the message; its words go back into the reply draft so nothing typed is lost.
  const cancelIt = () =>
    api
      .cancelMessage(m.id)
      .then(() => {
        const words = (m.words ?? '').trim()
        if (words) updateReplyDraft(m.thread_id, (d) => ({ ...d, words: d.words.trim() ? `${words}\n\n${d.words}` : words }))
      })
      .catch(error)
  return (
    <div data-testid="delivery-line" data-delivery={d} className="-mt-1 flex min-h-[30px] items-center justify-end gap-2.5 text-[12.5px] text-fg2">
      <span className={cx('w-[18px] text-center', v.color)}>{v.icon}</span>
      <span className="text-right">{text}</span>
      {now && (
        <button type="button" data-testid="send-now" onClick={() => api.sendNow(m.id).catch(error)} className="h-7 rounded-[6px] border border-danger bg-transparent px-2.5 text-[12px] text-danger">
          Send now
        </button>
      )}
      {restart && (
        <button
          type="button"
          data-testid="restart-session"
          onClick={() => {
            if (window.confirm(`Restart ${session.name}? A running turn is interrupted; the conversation is resumed.`)) api.restartSession(session.id).catch(error)
          }}
          className="h-7 rounded-[6px] border border-line bg-transparent px-2.5 text-[12px] text-fg2"
        >
          Restart session
        </button>
      )}
      {cancel && (
        <button type="button" data-testid="cancel-message" onClick={cancelIt} className="h-7 rounded-[6px] border border-line bg-transparent px-2.5 text-[12px] text-fg2">
          Cancel
        </button>
      )}
      {resume && (
        <button
          type="button"
          data-testid="resume-deliver"
          onClick={() => api.restartSession(session.id).catch(error)}
          className="h-7 rounded-[6px] border border-danger bg-transparent px-2.5 text-[12px] font-semibold text-danger"
        >
          Resume session to deliver
        </button>
      )}
    </div>
  )
}

/** Up to three drafted replies above the reply box: click sends, the pencil puts the text in the box. */
function SuggestionChips({ threadId, lastId, onEdit }: { threadId: string; lastId: string; onEdit: (text: string) => void }) {
  const { error } = useApp()
  const [items, setItems] = useState<string[] | null>(null) // null: still drafting
  const [sent, setSent] = useState(false)
  useEffect(() => {
    let live = true
    api
      .suggestions(threadId)
      .then((r) => live && setItems(r.suggestions ?? []))
      .catch(() => live && setItems([]))
    return () => {
      live = false
    }
  }, [threadId, lastId])
  if (sent || (items && items.length === 0)) return null
  if (!items)
    return (
      <div data-testid="reply-suggestions-loading" aria-hidden className="flex gap-1.5">
        <span className="h-7 w-28 animate-pulse rounded-full bg-chip" />
        <span className="h-7 w-20 animate-pulse rounded-full bg-chip" />
      </div>
    )
  const send = (text: string) => {
    setSent(true)
    api.reply(threadId, { words: text }).catch((err) => {
      setSent(false)
      error(err)
    })
  }
  return (
    <div data-testid="reply-suggestions" role="group" aria-label="Suggested replies" className="flex flex-wrap gap-1.5">
      {items.slice(0, 3).map((t, i) => (
        <span key={i} className="inline-flex max-w-full items-center overflow-hidden rounded-full border border-linestrong bg-sunken text-[12.5px] text-fg2">
          <button
            type="button"
            data-testid="reply-suggestion"
            title={t}
            onClick={() => send(t)}
            className="min-w-0 max-w-[60ch] truncate border-0 bg-transparent py-1 pl-3 pr-1.5 text-left hover:bg-raised hover:text-fg"
          >
            {t}
          </button>
          <button
            type="button"
            data-testid="reply-suggestion-edit"
            aria-label={`Edit: ${t}`}
            title="Edit before sending"
            onClick={() => onEdit(t)}
            className="shrink-0 border-0 bg-transparent py-1 pl-1 pr-2.5 text-subtle hover:bg-raised hover:text-fg"
          >
            ✎
          </button>
        </span>
      ))}
    </div>
  )
}

function ReplyBox({
  session,
  thread,
  target,
  answers,
  openCount,
  stayOpen,
  replyRef,
  phone,
  full,
  onToggleFull,
  sessions,
  onCompose,
}: {
  session: Session
  thread: Thread
  target: Message | null
  answers: Answer[]
  openCount: number
  stayOpen: number
  replyRef: React.RefObject<HTMLTextAreaElement | null>
  phone?: boolean
  full: boolean
  onToggleFull: () => void
  sessions: Session[]
  onCompose: () => void
}) {
  const { error, toast, settings } = useApp()
  const draft = useReplyDraft(thread.id)
  const [sending, setSending] = useState(false)
  const [whereAnchor, setWhereAnchor] = useState<HTMLElement | null>(null)
  const sendRef = useRef<HTMLButtonElement>(null)
  const words = draft.words
  const picksCount = answers.length
  const annos = draft.annotations
  const { files, addFiles, addPastedText, remove: removeFile } = useComposeFiles(thread.id)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploading = files.some((f) => f.state === 'uploading')
  const canSend = (!!words.trim() || picksCount > 0 || annos.length > 0 || files.some((f) => f.state === 'done')) && !uploading
  const io = fileInputHandlers(addFiles, addPastedText)
  const putBack = (f: (typeof files)[number]) => {
    if (!f.pasted) return
    const at = Math.min(f.pasted.at, words.length)
    updateReplyDraft(thread.id, (d) => ({ ...d, words: d.words.slice(0, at) + f.pasted!.text + d.words.slice(at) }))
    removeFile(f.key)
  }
  const fullButton = (
    <button
      type="button"
      aria-label={full ? 'Back to the thread' : 'Full height'}
      aria-pressed={full}
      title={full ? 'Back to the thread' : 'Full height'}
      data-testid="reply-full"
      onClick={onToggleFull}
      className={cx('border-0 bg-transparent p-1 text-muted hover:text-fg', full && 'text-fg')}
    >
      <IconExpand size={16} />
    </button>
  )
  const fileTiles = <ComposeFileTiles files={files} onRemove={removeFile} onPutBack={putBack} />
  const clip = (
    <>
      <button type="button" aria-label="Attach files" title="Attach files" data-testid="attach-files" onClick={() => fileInput.current?.click()} className="border-0 bg-transparent p-1 text-muted hover:text-fg">
        <IconPaperclip size={16} />
      </button>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        data-testid="attach-input"
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
    </>
  )
  const lastMsg = thread.messages?.[thread.messages.length - 1]
  const wantChips = settings.reply_suggestions && lastMsg?.author === 'agent' && openCount === 0 && session.status !== 'ended' && !words.trim()
  const chips = wantChips && lastMsg ? (
    <SuggestionChips
      key={lastMsg.id}
      threadId={thread.id}
      lastId={lastMsg.id}
      onEdit={(text) => {
        updateReplyDraft(thread.id, (d) => ({ ...d, words: text }))
        replyRef.current?.focus()
      }}
    />
  ) : null
  const actionsDone = (target?.questions ?? []).filter((q) => q.kind === 'action' && answers.some((a) => a.key === q.key)).length

  const send = async (opts: { resume?: boolean; forward_to?: string; keep?: boolean } = {}) => {
    if (!canSend || sending) return
    if (session.status === 'ended' && !opts.resume && !opts.forward_to && !opts.keep) {
      setWhereAnchor(sendRef.current)
      return
    }
    setSending(true)
    try {
      const res = await api.reply(thread.id, {
        words: words.trim(),
        answers_for: answers.length ? target?.id : undefined,
        answers,
        annotations: annos,
        uploads: uploadIds(thread.id),
        resume: opts.resume,
        forward_to: opts.forward_to,
      })
      clearReplyDraft(thread.id)
      clearFiles(thread.id)
      if (full) onToggleFull()
      if (opts.forward_to) {
        const to = sessions.find((s) => s.id === opts.forward_to)
        toast(`Sent to Claude Code · in ${to?.name ?? 'the other session'}`)
        void res
      }
    } catch (err) {
      error(err)
    } finally {
      setSending(false)
    }
  }

  const discard = () => {
    const saved = getReplyDraft(thread.id)
    clearReplyDraft(thread.id)
    toast('Draft discarded', { action: 'Undo', undo: true, onAction: () => setReplyDraft(thread.id, saved) })
  }

  const idleOthers = sessions.filter((s) => s.id !== session.id && s.status !== 'ended' && !s.archived_at)
  const placeholder = session.status === 'ended' ? 'Session ended — resume it to deliver your reply' : phone ? 'Reply to Claude…' : `Reply to Claude Code… (R)`

  const actionKeys = new Set((target?.questions ?? []).filter((q) => q.kind === 'action').map((q) => q.key))
  const qTotal = openCount - [...actionKeys].filter((k) => openKeysOf(target).has(k)).length
  const qAnswered = picksCount - actionsDone
  const aTotal = openCount - qTotal
  const counter =
    openCount > 0 ? (
      <span data-testid="answer-summary" className="text-[12px] text-subtle">
        {qTotal > 0 && `${qAnswered} of ${qTotal} answered`}
        {qTotal > 0 && qTotal - qAnswered > 0 && ` · ${qTotal - qAnswered} stay${qTotal - qAnswered === 1 ? 's' : ''} open`}
        {qTotal > 0 && aTotal > 0 && ' · '}
        {aTotal > 0 && `${actionsDone} of ${aTotal} actions done`}
      </span>
    ) : null

  // The box grows with the text (up to a limit); full height fills the pane instead.
  useLayoutEffect(() => {
    const el = replyRef.current
    if (!el) return
    if (full) {
      el.style.height = ''
      el.style.overflowY = ''
      return
    }
    const max = phone ? 160 : 240
    el.style.height = 'auto'
    el.style.height = `${Math.min(max, el.scrollHeight)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [words, full, phone, replyRef])

  const textarea = (
    <textarea
      ref={replyRef}
      data-testid="reply-box"
      aria-label="Reply"
      value={words}
      onChange={(e) => updateReplyDraft(thread.id, (d) => ({ ...d, words: e.target.value }))}
      onPaste={io.onPaste}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void send()
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          ;(e.target as HTMLTextAreaElement).blur()
        }
      }}
      placeholder={placeholder}
      rows={phone ? 1 : 2}
      className={cx(
        'w-full resize-none border-0 bg-transparent p-0 text-fg outline-none placeholder:text-faint',
        phone ? 'min-h-[24px] text-[16px]' : 'min-h-10 text-[13.5px]',
        full && 'min-h-0 flex-1',
      )}
    />
  )

  const where = (
    <Popover anchor={whereAnchor} open={!!whereAnchor} onClose={() => setWhereAnchor(null)} side="top" align="start" className="w-[320px] p-3">
      <div className="flex flex-col gap-2" data-testid="where-reply">
        <b className="text-[13.5px] font-[650]">Where should this reply go?</b>
        <span className="text-[12.5px] text-muted">{session.name} has ended.</span>
        <button
          type="button"
          data-testid="where-resume"
          onClick={() => {
            setWhereAnchor(null)
            void send({ resume: true })
          }}
          className="h-9 rounded-md border border-accent bg-wait/8 px-2.5 text-left text-[13px]"
        >
          Resume {session.name} and deliver it
        </button>
        {idleOthers.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid="where-forward"
            onClick={() => {
              setWhereAnchor(null)
              void send({ forward_to: s.id })
            }}
            className="h-9 rounded-md border border-linestrong bg-transparent px-2.5 text-left text-[13px]"
          >
            Send to {s.name} ({s.status})
          </button>
        ))}
        <button
          type="button"
          data-testid="where-keep"
          onClick={() => {
            setWhereAnchor(null)
            void send({ keep: true })
          }}
          className="h-8 rounded-md border-0 bg-transparent px-2.5 text-left text-[12.5px] text-subtle hover:text-fg"
        >
          Keep it here; it goes in after Resume
        </button>
      </div>
    </Popover>
  )

  if (phone) {
    return (
      <div className={cx('flex flex-col gap-2 border-t border-line bg-surface px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-2.5', full ? 'min-h-0 flex-1' : 'shrink-0')} onDragOver={io.onDragOver} onDrop={io.onDrop}>
        {chips}
        {counter}
        {fileTiles}
        <div className={cx('flex gap-2', full ? 'min-h-0 flex-1 items-stretch' : 'items-end')}>
          <div className={cx('flex flex-1 gap-1 rounded-xl border border-linestrong bg-sunken px-3 py-3 focus-within:border-accent', full ? 'items-stretch' : 'items-end')}>
            <div className={cx('flex min-w-0 flex-1 flex-col', full && 'min-h-0')}>{textarea}</div>
            <div className="flex flex-col items-center justify-end gap-1">
              {fullButton}
              {clip}
            </div>
          </div>
          <button
            ref={sendRef}
            type="button"
            aria-label="Send"
            data-testid="reply-send"
            disabled={!canSend || sending}
            onClick={() => void send()}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-0 bg-accent p-0 text-onaccent disabled:opacity-45"
          >
            <IconSend size={20} />
          </button>
        </div>
        {where}
      </div>
    )
  }

  return (
    <div className={cx('flex flex-col gap-2 border-t border-line px-3.5 pb-3 pt-2.5', full ? 'min-h-0 flex-1' : 'shrink-0')} onDragOver={io.onDragOver} onDrop={io.onDrop}>
      {chips}
      <span className="text-[12px] text-muted">Reply to Claude Code in {session.name}</span>
      <div className={cx('flex flex-col gap-2 rounded-[10px] border border-linestrong bg-sunken px-3 py-2.5 focus-within:border-accent', full && 'min-h-0 flex-1')}>
        {textarea}
        {fileTiles}
        {(picksCount > 0 || annos.length > 0 || counter || true) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {clip}
            {fullButton}
            {picksCount > 0 && <span data-testid="picks-chip" className="flex h-6 items-center rounded-[6px] bg-chip px-2 text-[12px]">✓ {plural(picksCount, 'pick')}</span>}
            {annos.length > 0 && (
              <span data-testid="annotations-chip" className="flex h-6 items-center gap-1 rounded-[6px] bg-chip px-2 text-[12px]">
                💬 {plural(annos.length, 'annotation')}
                <button
                  type="button"
                  aria-label="Remove annotations"
                  title="Remove annotations"
                  onClick={() => updateReplyDraft(thread.id, (d) => ({ ...d, annotations: [] }))}
                  className="border-0 bg-transparent px-0.5 text-subtle hover:text-fg"
                >
                  ×
                </button>
              </span>
            )}
            <span className="flex-1" />
            {counter}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button ref={sendRef} variant="primary" data-testid="reply-send" disabled={!canSend || sending} onClick={() => void send()}>
          {sending ? 'Sending…' : 'Send'} <span className="mono text-[11.5px] opacity-70">⌘↵</span>
        </Button>
        {canSend && (
          <Button variant="quiet" onClick={discard} data-testid="reply-cancel">
            Cancel
          </Button>
        )}
        <span className="flex-1" />
        {canSend && <span className="truncate whitespace-nowrap text-[12px] text-subtle">Draft saved</span>}
        <Button variant="outline" data-testid="compose" onClick={onCompose}>
          ✎ New message
        </Button>
      </div>
      {where}
    </div>
  )
}

export { IconArchive }
