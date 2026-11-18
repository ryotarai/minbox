// What the stream and the task view share around their messages (as in the thread view before v3):
// "new since you looked" (a divider, N jumps to it), a pill for messages that arrive below the
// fold, fold all, the conversation's files (artifacts, O / ] / [ open them), Q to the next open
// question, and mark unread from a message.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Attachment } from '../api'
import { useApp } from '../lib/app'
import { useHotkeys } from '../lib/hotkeys'
import { steppable } from '../lib/attachments'
import { call } from '../api'
import { hhmm, lineOf, type V3Message } from './data'

/** The first agent message not yet read when the conversation opened (fixed while it stays open). */
export function useFirstNew(key: string, messages: V3Message[] | null | undefined): string | null {
  const [first, setFirst] = useState<{ key: string; id: string | null } | null>(null)
  useEffect(() => {
    if (!messages || (first && first.key === key)) return
    setFirst({ key, id: messages.find((m) => m.author === 'agent' && !m.read_at && !m.pending)?.id ?? null })
  }, [key, messages, first])
  return first?.key === key ? first.id : null
}

/**
 * Follows new messages while the view is at the bottom; scrolled up, it counts the agent's new
 * messages for a pill that scrolls down. Returns [unseen, onScroll, toBottom, atBottom ref].
 */
export function useFollow(box: RefObject<HTMLElement | null>, key: string, messages: V3Message[], hold: boolean) {
  const atBottom = useRef(true)
  // The newest message seen (by time: a stream's window slides, so its length says nothing).
  const seen = useRef<{ key: string; at: number; n: number } | null>(null)
  const [unseen, setUnseen] = useState(0)
  useEffect(() => {
    atBottom.current = true
    setUnseen(0)
  }, [key])
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const at = (m: V3Message) => new Date(m.created_at).getTime()
    const newest = messages.reduce((t, m) => Math.max(t, at(m)), 0)
    const prev = seen.current?.key === key ? seen.current : null
    seen.current = { key, at: Math.max(newest, prev?.at ?? 0), n: messages.length }
    if (hold) return
    if (!prev || prev.n === 0) {
      el.scrollTop = el.scrollHeight
      return
    }
    const added = messages.filter((m) => at(m) > prev.at)
    if (!added.length) return
    if (atBottom.current || added.every((m) => m.author === 'user')) {
      atBottom.current = true
      el.scrollTop = el.scrollHeight
    } else setUnseen((u) => u + added.filter((m) => m.author === 'agent').length)
  }, [box, key, messages, hold])
  // The view shrinking (the reply box growing, the reply help appearing) or the messages growing late
  // (code, diagrams, images): a view at the bottom stays at the bottom.
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // Judged by the sizes before the change too: a scroll event of the same frame may already have
    // read the shorter view (or the taller content) as "scrolled up".
    let h = el.clientHeight
    let sh = el.scrollHeight
    const ro = new ResizeObserver(() => {
      const was = atBottom.current || sh - el.scrollTop - h < 80
      h = el.clientHeight
      sh = el.scrollHeight
      if (was && !hold) {
        atBottom.current = true
        el.scrollTop = el.scrollHeight
      }
    })
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
    // box.current: the element may appear after the first render (the view waits for its agent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, box.current, key, hold])
  const onScroll = () => {
    const el = box.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (atBottom.current && unseen) setUnseen(0)
  }
  const toBottom = () => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' })
    setUnseen(0)
  }
  return { unseen, onScroll, toBottom, atBottom }
}

/** The pill over the bottom of the messages. */
export function NewPill({ n, onClick }: { n: number; onClick: () => void }) {
  if (n <= 0) return null
  return (
    <button type="button" className="v-convpill" data-testid="new-message-pill" onClick={onClick}>
      ↓ {n === 1 ? 'New message' : `${n} new messages`}
    </button>
  )
}

/** A folded message: one line, a click unfolds. */
export function CompactRow({ m, name, onClick }: { m: V3Message; name: string; onClick: () => void }) {
  return (
    <button type="button" className="v-compact" data-testid="v3-message-folded" data-message-id={m.id} onClick={onClick}>
      <b>{m.author === 'agent' ? name : 'You'}</b>
      <span className="v-cm">{lineOf(m)}</span>
      <span>{hhmm(m.created_at)}</span>
    </button>
  )
}

/** Keeps what the person reads in place when older messages are put above it. */
export function useKeepPosition(box: RefObject<HTMLElement | null>) {
  const keep = useRef<{ node: Element; top: number } | null>(null)
  const before = () => {
    const el = box.current
    const node = el?.querySelector('[data-testid="v3-message"]')
    if (el && node) {
      keep.current = { node, top: node.getBoundingClientRect().top }
      el.style.overflowAnchor = 'none'
    }
  }
  const after = () => {
    const el = box.current
    const k = keep.current
    if (!el || !k) return
    keep.current = null
    if (k.node.isConnected) el.scrollTop += k.node.getBoundingClientRect().top - k.top
    requestAnimationFrame(() => (el.style.overflowAnchor = ''))
  }
  return { before, after, pending: () => !!keep.current }
}

/**
 * The conversation's keys: N to "new", Q to the next open question, O (and F) the newest file, ]
 * the first, [ the newest. Off while a file is open (its viewer has its own keys).
 */
export function useConversationKeys(box: RefObject<HTMLElement | null>, messages: V3Message[], open: (a: Attachment, m: V3Message) => void) {
  const { route } = useApp()
  const files = steppable(messages)
  const ownerOf = (a: Attachment) => messages.find((m) => (m.attachments ?? []).some((x) => x.id === a.id)) ?? messages[messages.length - 1]!
  const openFile = (a: Attachment | undefined) => {
    if (a) open(a, ownerOf(a))
  }
  const scrollTo = (sel: string) => {
    const el = box.current?.querySelector(sel)
    if (!el) return false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return true
  }
  const nextQuestion = useRef(0)
  useHotkeys(
    {
      n: () => void scrollTo('[data-new-divider]'),
      q: () => {
        const all = Array.from(box.current?.querySelectorAll('[data-testid="question"][data-open="true"]') ?? [])
        if (!all.length) return
        const el = all[nextQuestion.current++ % all.length]!
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      },
      o: () => openFile(files[files.length - 1]),
      f: () => openFile(files[files.length - 1]),
      ']': () => openFile(files[0]),
      '[': () => openFile(files[files.length - 1]),
    },
    !route.f,
  )
}

/** Mark unread from a message: it and the agent's later messages here count as new again. */
export function markUnreadFrom(messages: V3Message[], m: V3Message): Promise<{ marked: number }> {
  const i = messages.findIndex((x) => x.id === m.id)
  const ids = messages.slice(Math.max(0, i)).filter((x) => x.author === 'agent' && !x.pending).map((x) => x.id)
  return call<{ marked: number }>('POST', '/api/v3/unread', { message_ids: ids })
}
