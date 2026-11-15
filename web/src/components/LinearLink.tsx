import { useEffect, useRef, useState } from 'react'
import { api, type IssueSummary, type Thread } from '../api'
import { useApp } from '../lib/app'
import { coarsePointer } from '../lib/popoverPlacement'
import { LinearCreateDialog } from './LinearCreate'
import { IconLinear, IconPlus } from './icons'
import { Modal, cx } from './ui'

// Linking a thread to a Linear issue: a compact "+ Linear" button next to the thread's meta line
// (or, once linked, the issue's identifier) and a dialog that searches Linear as you type. Picking
// a result links it (the same PUT as pasting ENG-123 did); "New issue" at the bottom opens the
// Create dialog with the search text as the title.

const SEARCH_DEBOUNCE = 200

/** Whether Linear is connected (searching and creating need a login). Follows Settings changes. */
export function useLinearConnected(): boolean {
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    let live = true
    const load = () => api.linearStatus().then((st) => live && setConnected(st.connected)).catch(() => {})
    load()
    window.addEventListener('minbox:linear', load)
    return () => {
      live = false
      window.removeEventListener('minbox:linear', load)
    }
  }, [])
  return connected
}

/**
 * The thread's Linear entry point left of the meta line: "+ Linear" when the thread is not linked
 * (only while Linear is connected), else the linked issue's identifier (opens the issue) with a
 * small "+" that opens the dialog to link a different one.
 */
export function LinearLinkButton({ thread, testSuffix = '' }: { thread: Thread; testSuffix?: string }) {
  const connected = useLinearConnected()
  const [open, setOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState<string | null>(null)
  const link = thread.linear
  if (!link && !connected) return null
  const plusCls =
    'inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md border-0 bg-transparent px-2 text-subtle sm:h-6 sm:px-1 hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent'
  return (
    <>
      {link ? (
        <span className="inline-flex items-center gap-0.5">
          <a
            data-testid={`linear-meta-issue${testSuffix}`}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            title={`Linear: ${link.identifier} ${link.title}`}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1 font-semibold text-fg2 no-underline hover:bg-raised hover:text-fg"
          >
            <IconLinear size={12} className="shrink-0" />
            {link.identifier}
          </a>
          {connected && (
            <button type="button" data-testid={`linear-link-open${testSuffix}`} aria-label="Link a different Linear issue" title="Link a different Linear issue" onClick={() => setOpen(true)} className={plusCls}>
              <IconPlus size={11} />
            </button>
          )}
        </span>
      ) : (
        <button type="button" data-testid={`linear-link-open${testSuffix}`} aria-label="Link Linear issue" title="Link Linear issue" onClick={() => setOpen(true)} className={plusCls}>
          <IconPlus size={11} />
          <IconLinear size={12} />
        </button>
      )}
      {open && (
        <LinearLinkDialog
          thread={thread}
          onClose={() => setOpen(false)}
          onNew={(q) => {
            setOpen(false)
            setCreateTitle(q)
          }}
        />
      )}
      {createTitle !== null && <LinearCreateDialog thread={thread} title={createTitle} onClose={() => setCreateTitle(null)} />}
    </>
  )
}

type SearchState = { status: 'idle' | 'loading' | 'done' | 'error'; issues: IssueSummary[]; error?: string; query: string }

/** Search Linear issues as you type; pick one to link it to the thread, or start a new issue. */
export function LinearLinkDialog({ thread, onClose, onNew }: { thread: Thread; onClose: () => void; onNew: (query: string) => void }) {
  const { toast, navigate, isPhone } = useApp()
  const [q, setQ] = useState('')
  const [res, setRes] = useState<SearchState>({ status: 'idle', issues: [], query: '' })
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const query = q.trim()

  // Debounced search; a newer query aborts the request in flight (and its answer is ignored).
  useEffect(() => {
    if (!query) {
      setRes({ status: 'idle', issues: [], query: '' })
      return
    }
    const ac = new AbortController()
    setRes((r) => ({ ...r, status: 'loading' }))
    const t = window.setTimeout(() => {
      api
        .issueSearch(query, ac.signal)
        .then((r) => {
          if (ac.signal.aborted) return
          setRes({ status: 'done', issues: r.issues ?? [], query })
          setActive(0)
        })
        .catch((e) => {
          if (ac.signal.aborted) return
          setRes({ status: 'error', issues: [], query, error: e instanceof Error ? e.message : String(e) })
          setActive(0)
        })
    }, SEARCH_DEBOUNCE)
    return () => {
      window.clearTimeout(t)
      ac.abort()
    }
  }, [query])

  // Shown results stay while the next query loads (less flicker); "New issue" is always last.
  const issues = res.issues
  const count = issues.length + 1
  const at = Math.min(active, count - 1)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const pick = async (is: IssueSummary) => {
    if (busy) return
    setBusy(is.identifier)
    setErr('')
    try {
      await api.linkLinear(thread.id, is.identifier)
      toast(`Linked ${is.identifier}`)
      onClose()
    } catch (e) {
      setBusy('')
      const status = (e as { status?: number }).status
      setErr(e instanceof Error ? e.message : String(e))
      if (status === 409) toast('Connect Linear first: Settings › Integrations', { error: true, action: 'Open', onAction: () => navigate({ view: 'settings', ss: 'integrations' }) })
    }
  }
  const choose = (i: number) => {
    if (i < issues.length) void pick(issues[i])
    else onNew(query)
  }

  const optionId = (i: number) => `linear-link-opt-${i}`
  return (
    <Modal
      label="Link Linear issue"
      onClose={onClose}
      bottom={isPhone}
      top={!isPhone}
      className={cx('flex flex-col overflow-hidden', isPhone ? 'max-h-[85vh] w-full rounded-b-none' : 'max-h-[70vh] w-[min(560px,100%)]')}
    >
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <IconLinear size={15} className="shrink-0 text-subtle" />
        <input
          data-testid="linear-link-search"
          role="combobox"
          aria-expanded="true"
          aria-controls="linear-link-results"
          aria-activedescendant={optionId(at)}
          aria-label="Search Linear issues"
          autoFocus={!coarsePointer()}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((at + 1) % count)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((at - 1 + count) % count)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(at)
            }
          }}
          placeholder="Search issues, or paste ENG-123 / an issue URL"
          className="h-9 min-w-0 flex-1 border-0 bg-transparent text-[14px] text-fg outline-none placeholder:text-subtle"
        />
        {res.status === 'loading' && (
          <span data-testid="linear-link-loading" className="shrink-0 text-[12px] text-subtle">
            Searching…
          </span>
        )}
      </div>
      <div ref={listRef} id="linear-link-results" role="listbox" aria-label="Linear issues" data-testid="linear-link-results" className="min-h-0 flex-1 overflow-y-auto py-1">
        {!query && (
          <div data-testid="linear-link-hint" className="px-3.5 py-3 text-[12.5px] text-subtle">
            Type to search Linear issues by title, or paste an identifier (ENG-123) or an issue URL.
          </div>
        )}
        {query && res.status === 'done' && issues.length === 0 && (
          <div data-testid="linear-link-empty" className="px-3.5 py-3 text-[12.5px] text-subtle">
            No issues match “{res.query}”.
          </div>
        )}
        {query && res.status === 'error' && (
          <div data-testid="linear-link-search-error" className="px-3.5 py-3 text-[12.5px] text-danger">
            {res.error}
          </div>
        )}
        {issues.map((is, i) => {
          const current = thread.linear?.identifier === is.identifier
          return (
            <div
              key={is.identifier}
              id={optionId(i)}
              role="option"
              aria-selected={i === at}
              data-index={i}
              data-testid="linear-link-result"
              data-identifier={is.identifier}
              onMouseMove={() => i !== at && setActive(i)}
              onClick={() => choose(i)}
              className={cx('mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px]', i === at && 'bg-raised', busy === is.identifier && 'opacity-60')}
            >
              <span className="w-[72px] shrink-0 truncate font-mono text-[12px] font-semibold text-fg2">{is.identifier}</span>
              <span className="min-w-0 flex-1 truncate text-fg">{is.title}</span>
              {current && <span className="shrink-0 text-[11px] text-accent">linked</span>}
              {!isPhone && (is.assignee || is.team_name) && <span className="max-w-[120px] shrink-0 truncate text-[11.5px] text-subtle">{is.assignee || is.team_name}</span>}
              {is.state && <span className="shrink-0 rounded bg-sunken px-1.5 text-[11px] text-subtle">{is.state}</span>}
            </div>
          )
        })}
      </div>
      {err && (
        <div data-testid="linear-link-error" className="border-t border-line px-3.5 py-2 text-[12.5px] text-danger">
          {err}
        </div>
      )}
      <div className="border-t border-line py-1">
        <div
          id={optionId(issues.length)}
          role="option"
          aria-selected={at === issues.length}
          data-index={issues.length}
          data-testid="linear-link-new"
          onMouseMove={() => at !== issues.length && setActive(issues.length)}
          onClick={() => choose(issues.length)}
          className={cx('mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-fg2', at === issues.length && 'bg-raised')}
        >
          <IconPlus size={13} />
          <span className="min-w-0 flex-1 truncate">{query ? <>New issue “{query}”</> : 'New issue'}</span>
        </div>
      </div>
    </Modal>
  )
}
