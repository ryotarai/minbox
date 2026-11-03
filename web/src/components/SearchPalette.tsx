import { useEffect, useMemo, useRef, useState } from 'react'
import { SECTION_LABEL, api, type SearchHit, type SearchResult } from '../api'
import { useApp } from '../lib/app'
import { fileExt, shortTime } from '../lib/format'
import { IconSearch } from './icons'
import { Kbd, MenuItem, Modal, Popover, cx } from './ui'

const RECENT = 'minbox:recent-searches'

/** Drops block markup (:::question, - [ ]) from a snippet. */
function cleanSnippet(s: string): string {
  return s
    .replace(/:::[a-z-]*/g, ' ')
    .replace(/(^|\s)[-*+]\s+\[[ xX]\]\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '[]') as string[]
  } catch {
    return []
  }
}
function remember(q: string) {
  const list = [q, ...recent().filter((x) => x !== q)].slice(0, 8)
  localStorage.setItem(RECENT, JSON.stringify(list))
}

/** Highlights every query word in the snippet. */
function Snippet({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-[3px] bg-wait/25 px-0.5 text-waitfg">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

/** ⌘K / "/": search threads, messages and files, in one session or all. */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { route, sessions, navigate, error } = useApp()
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<string>(route.s ?? '')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [res, setRes] = useState<SearchResult | null>(null)
  const [sel, setSel] = useState(0)
  const [anchor, setAnchor] = useState<{ el: HTMLElement; which: 'scope' | 'status' | 'from' } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const filtersRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    if (!q.trim()) {
      setRes(null)
      return
    }
    const t = setTimeout(() => {
      api
        .search(q.trim(), { session_id: scope || undefined, status: status || undefined, from: from || undefined, limit: 50 })
        .then((r) => {
          setRes(r)
          setSel(0)
        })
        .catch(error)
    }, 120)
    return () => clearTimeout(t)
  }, [q, scope, status, from, error])

  const words = q.trim().split(/\s+/).filter(Boolean)
  const limit = showAll ? 50 : 6
  const groups = useMemo(
    () =>
      res
        ? ([
            ['Threads', res.threads.slice(0, limit), '≡'],
            ['Messages', res.messages.slice(0, limit), '✉'],
            ['Files', res.files.slice(0, limit), ''],
          ] as [string, SearchHit[], string][]).filter((g) => g[1].length > 0)
        : [],
    [res, limit],
  )
  const flat = groups.flatMap((g) => g[1])
  const total = res ? res.threads.length + res.messages.length + res.files.length : 0
  const scopeName = scope ? (sessions?.find((s) => s.id === scope)?.name ?? 'this session') : 'All sessions'

  const open = (h: SearchHit) => {
    remember(q.trim())
    onClose()
    navigate({ s: h.session_id, t: h.thread_id, f: h.attachment_id ?? null, view: 'main', tab: 'inbox' })
    if (h.message_id) {
      setTimeout(() => document.querySelector(`[data-message-id="${h.message_id}"]`)?.scrollIntoView({ block: 'center' }), 400)
    }
  }

  return (
    <Modal label="Search" onClose={onClose} className="w-[min(640px,100%)] overflow-hidden" top>
      <label className="flex h-14 items-center gap-2.5 border-b border-line2 px-4">
        <IconSearch size={18} className="text-muted" />
        <input
          ref={inputRef}
          data-testid="search-input"
          aria-label="Search"
          value={q}
          placeholder="Search threads, messages and files"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, flat.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter') {
              const h = flat[sel]
              if (h) open(h)
            } else if (e.key === 'Tab') {
              e.preventDefault()
              ;(filtersRef.current?.querySelector('button') as HTMLButtonElement | null)?.focus()
            }
          }}
          className="flex-1 border-0 bg-transparent text-[16px] text-fg outline-none placeholder:text-faint"
        />
        <Kbd>Esc</Kbd>
      </label>
      <div ref={filtersRef} className="flex flex-wrap gap-1.5 border-b border-line2 px-4 py-2.5">
        <FilterChip testid="search-scope" on={!!scope || true} onClick={(el) => setAnchor({ el, which: 'scope' })}>
          Session: {scopeName} ▾
        </FilterChip>
        <FilterChip on={!!status} onClick={(el) => setAnchor({ el, which: 'status' })}>
          Status{status ? `: ${SECTION_LABEL[status as keyof typeof SECTION_LABEL]}` : ''} ▾
        </FilterChip>
        <FilterChip on={!!from} onClick={(el) => setAnchor({ el, which: 'from' })}>
          From{from ? `: ${from === 'agent' ? 'Claude Code' : 'You'}` : ''} ▾
        </FilterChip>
        <span className="flex-1" />
        {res && <span className="self-center text-[12px] text-subtle">{total} results · all words · any case</span>}
      </div>
      <Popover anchor={anchor?.el ?? null} open={!!anchor} onClose={() => setAnchor(null)} align="start" className="w-[240px]">
        {anchor?.which === 'scope' && (
          <>
            <MenuItem active={!scope} onClick={() => (setScope(''), setAnchor(null))}>
              All sessions
            </MenuItem>
            {(sessions ?? []).map((s) => (
              <MenuItem key={s.id} active={scope === s.id} onClick={() => (setScope(s.id), setAnchor(null))}>
                {s.name}
              </MenuItem>
            ))}
          </>
        )}
        {anchor?.which === 'status' && (
          <>
            <MenuItem active={!status} onClick={() => (setStatus(''), setAnchor(null))}>
              Any
            </MenuItem>
            {(['waiting', 'new', 'sent', 'quiet', 'archived'] as const).map((s) => (
              <MenuItem key={s} active={status === s} onClick={() => (setStatus(s), setAnchor(null))}>
                {SECTION_LABEL[s]}
              </MenuItem>
            ))}
          </>
        )}
        {anchor?.which === 'from' && (
          <>
            {[
              ['', 'Anyone'],
              ['agent', 'Claude Code'],
              ['user', 'You'],
            ].map(([v, l]) => (
              <MenuItem key={v} active={from === v} onClick={() => (setFrom(v!), setAnchor(null))}>
                {l}
              </MenuItem>
            ))}
          </>
        )}
      </Popover>

      <div className="max-h-[56vh] overflow-y-auto py-1.5" data-testid="search-results">
        {!q.trim() && (
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-subtle">Recent searches</span>
            {recent().length === 0 && <span className="text-[13px] text-subtle">Words to find in subjects, messages and attached files.</span>}
            {recent().map((r) => (
              <button key={r} type="button" onClick={() => setQ(r)} className="border-0 bg-transparent p-0 text-left text-[13px] text-fg2 hover:text-fg">
                🕘 {r}
              </button>
            ))}
          </div>
        )}
        {res && total === 0 && (
          <div className="flex flex-col items-center gap-2.5 px-4 py-8 text-center" data-testid="search-empty">
            <span className="text-[15px] font-semibold">No threads match "{q.trim()}"</span>
            {scope ? (
              <>
                <span className="text-[13px] text-muted">Searched {scopeName} only.</span>
                <button type="button" onClick={() => setScope('')} className="h-9 rounded-md border border-linestrong bg-transparent px-3.5 text-[13px]">
                  Search all sessions
                </button>
              </>
            ) : (
              <span className="text-[13px] text-muted">Searched every session.</span>
            )}
          </div>
        )}
        {groups.map(([title, hits, icon]) => (
          <div key={title}>
            <div className="px-4 pb-1 pt-2.5 text-[11px] font-bold uppercase tracking-[0.06em] text-subtle">{title}</div>
            {hits.map((h) => {
              const i = flat.indexOf(h)
              return (
                <button
                  key={`${title}-${h.thread_id}-${h.message_id ?? ''}-${h.attachment_id ?? ''}`}
                  type="button"
                  data-testid="search-result"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => open(h)}
                  className={cx('flex w-full items-start gap-3 border-0 px-4 py-2 text-left', i === sel ? 'bg-sel' : 'bg-transparent')}
                >
                  <span aria-hidden="true" className="mono flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-sel text-[11px] text-muted">
                    {icon || fileExt(h.name ?? '')}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-semibold">{title === 'Files' ? (h.name ?? h.subject) : h.subject}</span>
                      <span className="mono shrink-0 rounded bg-sel px-1.5 text-[11px] leading-[18px] text-fg2">{h.session_name}</span>
                      {h.archived && <span className="shrink-0 rounded border border-[#3a3a42] px-1.5 text-[11px] leading-4 text-muted">Archived</span>}
                      <span className="flex-1" />
                      <span className="shrink-0 text-[11.5px] text-subtle">{shortTime(h.created_at)}</span>
                    </span>
                    <span className="line-clamp-2 text-[12.5px] leading-normal text-muted">
                      <Snippet text={cleanSnippet(h.snippet)} words={words} />
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex gap-4 border-t border-line2 px-4 py-2.5 text-[12px] text-subtle">
        <span>
          <kbd className="text-fg2">↑↓</kbd> move
        </span>
        <span>
          <kbd className="text-fg2">↵</kbd> open
        </span>
        <span>
          <kbd className="text-fg2">Tab</kbd> filters
        </span>
        <span className="flex-1" />
        {res && total > 18 && !showAll && (
          <button type="button" onClick={() => setShowAll(true)} className="border-0 bg-transparent p-0 text-subtle hover:text-fg">
            Show all
          </button>
        )}
      </div>
    </Modal>
  )
}

function FilterChip({ children, on, onClick, testid }: { children: React.ReactNode; on: boolean; onClick: (el: HTMLElement) => void; testid?: string }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={(e) => onClick(e.currentTarget)}
      className={cx('h-7 rounded-full border px-2.5 text-[12.5px]', on ? 'border-accent bg-wait/10 font-semibold text-waitfg' : 'border-linestrong bg-transparent text-fg2')}
    >
      {children}
    </button>
  )
}
