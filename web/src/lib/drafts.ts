import { useSyncExternalStore } from 'react'
import type { Annotation, Answer, ReplyQuestion } from '../api'

// Drafts live in localStorage: the reply being written in a thread (words,
// question picks and annotations).

export type ReplyDraft = {
  words: string
  /** By agent message id, then question key. */
  picks: Record<string, Record<string, Answer>>
  /** When each question was picked (key → ms). */
  pickedAt: Record<string, number>
  annotations: Annotation[]
  updated: number
}

const REPLY = 'minbox:reply:'

// The New message screen is gone, and with it its drafts: drop what it left behind (its draft
// list and the files attached to its drafts).
try {
  localStorage.removeItem('minbox:compose-drafts')
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i)
    if (k?.startsWith('minbox:files:compose:')) localStorage.removeItem(k)
  }
} catch {
  /* storage off */
}

const listeners = new Set<() => void>()
let version = 0
function changed() {
  version++
  for (const l of listeners) l()
}
window.addEventListener('storage', (e) => {
  if (e.key?.startsWith('minbox:')) changed()
})

export function emptyReplyDraft(): ReplyDraft {
  return { words: '', picks: {}, pickedAt: {}, annotations: [], updated: 0 }
}

export function getReplyDraft(threadId: string): ReplyDraft {
  try {
    const v = localStorage.getItem(REPLY + threadId)
    if (v) return { ...emptyReplyDraft(), ...JSON.parse(v) }
  } catch {
    /* ignore */
  }
  return emptyReplyDraft()
}

export function replyDraftIsEmpty(d: ReplyDraft): boolean {
  return !d.words.trim() && d.annotations.length === 0 && Object.values(d.picks).every((m) => Object.keys(m).length === 0)
}

export function setReplyDraft(threadId: string, d: ReplyDraft) {
  if (replyDraftIsEmpty(d)) localStorage.removeItem(REPLY + threadId)
  else localStorage.setItem(REPLY + threadId, JSON.stringify({ ...d, updated: Date.now() }))
  changed()
}

export function updateReplyDraft(threadId: string, fn: (d: ReplyDraft) => ReplyDraft) {
  setReplyDraft(threadId, fn(getReplyDraft(threadId)))
}

export function clearReplyDraft(threadId: string) {
  localStorage.removeItem(REPLY + threadId)
  changed()
}

/** Thread ids with a reply draft. */
export function replyDraftThreads(): string[] {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(REPLY)) out.push(k.slice(REPLY.length))
  }
  return out
}

/** Re-renders when any draft changes. */
export function useDraftsVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
  )
}

// The reply help's answers in a thread (picks and typed text, by question text), with the questions
// they answer: kept across the agent's new messages until the reply is sent or the help dismissed.

const REPLY_HELP = 'minbox:replyhelp:'

export type ReplyHelpAnswer = { picked: string[]; other: boolean; text: string }
export type ReplyHelpDraft = Record<string, { q: ReplyQuestion; a: ReplyHelpAnswer }>

export function getReplyHelpDraft(threadId: string): ReplyHelpDraft {
  try {
    const v = localStorage.getItem(REPLY_HELP + threadId)
    if (v) return JSON.parse(v) as ReplyHelpDraft
  } catch {
    /* ignore */
  }
  return {}
}

export function setReplyHelpDraft(threadId: string, d: ReplyHelpDraft) {
  try {
    if (Object.keys(d).length === 0) localStorage.removeItem(REPLY_HELP + threadId)
    else localStorage.setItem(REPLY_HELP + threadId, JSON.stringify(d))
  } catch {
    /* storage off */
  }
  changed()
}

export function useReplyDraft(threadId: string): ReplyDraft {
  useDraftsVersion()
  return getReplyDraft(threadId)
}
