import { lazy, Suspense, useEffect, useRef, useSyncExternalStore } from 'react'
import type { Session } from '../api'
import { updateReplyDraft } from '../lib/drafts'
import { mentionOf } from './Mentions'

// ---- the Files pane: the session's folder as a tree, beside the thread ----
// The pane itself (FilesPane.tsx, with @pierre/trees) loads on first use.

/**
 * Tablet and phone: the Files pane full screen, in front of the thread (the desktop has a pane for
 * it, layout.filesPane). Shared by the header button, the thread menu, ⇧F and ⌘K; never stored.
 */
let filesOverlay = false
const overlayListeners = new Set<() => void>()
export function setFilesOverlay(open: boolean) {
  if (filesOverlay === open) return
  filesOverlay = open
  overlayListeners.forEach((l) => l())
}
export function useFilesOverlay(): boolean {
  return useSyncExternalStore(
    (l) => {
      overlayListeners.add(l)
      return () => overlayListeners.delete(l)
    },
    () => filesOverlay,
  )
}

/** Puts `@path` (as the @ completion writes it) at the end of the thread's message box and focuses it. */
export function insertFileMention(threadId: string, path: string) {
  const mention = mentionOf(path)
  updateReplyDraft(threadId, (d) => ({ ...d, words: d.words && !/\s$/.test(d.words) ? `${d.words} ${mention} ` : `${d.words}${mention} ` }))
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLTextAreaElement>(`[data-testid="thread-view"][data-thread-id="${CSS.escape(threadId)}"] [data-testid="reply-box"]`) ?? document.querySelector<HTMLTextAreaElement>('[data-testid="reply-box"], textarea[data-composer]')
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  })
}

const LazyFilesPane = lazy(() => import('./FilesPane').then((m) => ({ default: m.FilesPane })))

/** The Files pane, loaded on first use. */
export function FilesPane(props: { session: Session; threadId: string; draftKey?: string; phone?: boolean; onClose: () => void }) {
  return (
    <Suspense fallback={<div className="px-3.5 py-3 text-[12.5px] text-subtle">Loading…</div>}>
      <LazyFilesPane {...props} />
    </Suspense>
  )
}

/**
 * Tablet and phone: the Files pane full screen, in front of the thread (opened by the header's
 * Files button, the thread menu, ⇧F or ⌘K). Another thread, or none, closes it.
 */
export function FilesOverlay({ session, threadId }: { session: Session | null; threadId: string | null }) {
  const open = useFilesOverlay()
  const last = useRef(threadId)
  useEffect(() => {
    if (last.current !== threadId) setFilesOverlay(false)
    last.current = threadId
  }, [threadId])
  useEffect(() => () => setFilesOverlay(false), [])
  if (!open || !threadId || !session) return null
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" data-testid="phone-files">
      <FilesPane key={session.id} session={session} threadId={threadId} phone onClose={() => setFilesOverlay(false)} />
    </div>
  )
}
