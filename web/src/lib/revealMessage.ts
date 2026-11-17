import { useSyncExternalStore } from 'react'

/**
 * "Show this message": asks a thread's view to bring one of its messages into sight, whatever hides
 * it there (the "N earlier messages" fold, the compact row above the open messages, Fold all, the
 * Artifacts grid, a collapsed command output). The caller navigates to the thread and asks; the
 * thread view (on a desktop or a phone, mounted before or after the ask) unfolds what it must,
 * scrolls the message to the middle and flashes it, then marks the ask answered. Usable from
 * anywhere that links to a message (the Tasks pane, later search results).
 */
export type RevealAsk = { threadId: string; messageId: string; n: number }

let ask: RevealAsk | null = null
let seq = 0
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

export function revealMessage(threadId: string, messageId: string) {
  ask = { threadId, messageId, n: ++seq }
  notify()
}

/** The pending ask for this thread, or null. */
export function useRevealAsk(threadId: string): RevealAsk | null {
  const a = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => ask,
  )
  return a && a.threadId === threadId ? a : null
}

/** The thread view handled the ask (shown it, or found no such message). */
export function answerRevealAsk(n: number) {
  if (ask?.n !== n) return
  ask = null
  notify()
}

/** A short outline around a message just brought into view; `data-jumped` marks it for tests. */
export function flashMessage(el: HTMLElement) {
  el.dataset.jumped = 'true'
  el.style.outline = '2px solid var(--mb-accent)'
  el.style.outlineOffset = '4px'
  el.style.borderRadius = '12px'
  setTimeout(() => {
    el.style.outline = ''
    el.style.outlineOffset = ''
    el.style.borderRadius = ''
  }, 2000)
}
