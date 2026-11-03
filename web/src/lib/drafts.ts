import { useSyncExternalStore } from 'react'
import type { Annotation, Answer } from '../api'

// Drafts live in localStorage: the reply being written in a thread (words,
// question picks and annotations), and compose messages kept as drafts.

export type ReplyDraft = {
  words: string
  /** By agent message id, then question key. */
  picks: Record<string, Record<string, Answer>>
  /** When each question was picked (key → ms). */
  pickedAt: Record<string, number>
  annotations: Annotation[]
  updated: number
}

export type ComposeDraft = { id: string; session_id: string; subject: string; body: string; name: string; updated: number }

const REPLY = 'minbox:reply:'
const COMPOSE = 'minbox:compose-drafts'

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

export function getComposeDrafts(): ComposeDraft[] {
  try {
    return JSON.parse(localStorage.getItem(COMPOSE) ?? '[]') as ComposeDraft[]
  } catch {
    return []
  }
}

export function saveComposeDraft(d: ComposeDraft) {
  const all = getComposeDrafts().filter((x) => x.id !== d.id)
  all.unshift({ ...d, updated: Date.now() })
  localStorage.setItem(COMPOSE, JSON.stringify(all.slice(0, 50)))
  changed()
}

export function deleteComposeDraft(id: string) {
  localStorage.setItem(COMPOSE, JSON.stringify(getComposeDrafts().filter((x) => x.id !== id)))
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

export function useReplyDraft(threadId: string): ReplyDraft {
  useDraftsVersion()
  return getReplyDraft(threadId)
}
