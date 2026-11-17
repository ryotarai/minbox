import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Completions, type FileEntry } from '../api'
import { cx } from './ui'

/**
 * @-mentions in a message box: "@" at the start of a word completes a file or folder of the
 * session's folder (as @path, or @"a path" when it has spaces: what Claude Code reads); in the
 * boxes that start threads it also completes the project's @agents and /skills.
 */

type Token = { ch: '@' | '/'; start: number; q: string; quoted: boolean }
type Item = { key: string; insert: string; kind: 'file' | 'dir' | 'agent' | 'skill'; description?: string }

/** The text to insert for a path: quoted when it has white space. */
export const mentionOf = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`)

/** The mention being typed just before the caret, if any ("@" must start a word: not a@b). */
function tokenAt(v: string, caret: number, agents: boolean): Token | null {
  if (/^\s*!/.test(v)) return null // a "!" command, not a message
  const before = v.slice(0, caret)
  const m = /(^|\s)@(?:"([^"\n]*)|([^\s"]*))$/.exec(before)
  if (m) {
    const quoted = m[2] !== undefined
    const q = (quoted ? m[2] : m[3]) ?? ''
    return { ch: '@', start: caret - q.length - (quoted ? 2 : 1), q, quoted }
  }
  if (agents) {
    const s = /(^|\s)\/([\w:.-]*)$/.exec(before)
    if (s) return { ch: '/', start: caret - s[2]!.length - 1, q: s[2]!, quoted: false }
  }
  return null
}

export function useMentions({
  sessionId,
  value,
  onChange,
  inputRef,
  agents,
}: {
  sessionId: string | null
  value: string
  onChange: (v: string) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  /** Also complete @agents and /skills (needs the project's list). */
  agents: boolean
}) {
  const [comps, setComps] = useState<Completions | null>(null)
  const [token, setToken] = useState<Token | null>(null)
  const [found, setFound] = useState<{ q: string; entries: FileEntry[] } | null>(null)
  const [sel, setSel] = useState(0)
  const composing = useRef(false)

  useEffect(() => {
    if (!agents || !sessionId) return
    api.completions(sessionId).then(setComps).catch(() => setComps(null))
  }, [agents, sessionId])

  // The files the typed path leads to (a moment after the last key).
  const fileQ = token?.ch === '@' ? token.q : null
  useEffect(() => {
    if (fileQ === null || !sessionId) return
    let live = true
    const t = setTimeout(() => {
      api
        .files(sessionId, fileQ)
        .then((r) => live && setFound({ q: fileQ, entries: r.entries }))
        .catch(() => live && setFound({ q: fileQ, entries: [] }))
    }, 60)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [fileQ, sessionId])

  const items: Item[] = useMemo(() => {
    if (!token) return []
    const out: Item[] = []
    if (token.ch === '@') {
      for (const f of found?.entries ?? []) out.push({ key: `f:${f.path}`, insert: f.path, kind: f.dir ? 'dir' : 'file' })
      if (agents && !token.quoted && /^[\w:.-]*$/.test(token.q) && comps) {
        for (const c of comps.agents.filter((c) => c.name.toLowerCase().includes(token.q.toLowerCase())).slice(0, 8)) {
          out.push({ key: `a:${c.name}`, insert: `@${c.name}`, kind: 'agent', description: c.description })
        }
      }
    } else if (comps) {
      for (const c of [...comps.skills, ...comps.commands].filter((c) => c.name.toLowerCase().includes(token.q.toLowerCase())).slice(0, 8)) {
        out.push({ key: `s:${c.name}`, insert: `/${c.name}`, kind: 'skill', description: c.description })
      }
    }
    return out
  }, [token, found, comps, agents])
  const stale = token?.ch === '@' && found?.q !== token.q
  const open = !!token && items.length > 0
  const at = Math.min(sel, Math.max(0, items.length - 1))

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [at, items])

  const detect = (v: string, caret: number) => {
    const t = composing.current ? null : tokenAt(v, caret, agents)
    setToken((prev) => {
      if (!t || !prev || prev.start !== t.start || prev.ch !== t.ch || prev.q !== t.q) setSel(0)
      return t
    })
    if (!t) setFound(null)
  }

  const apply = (it: Item) => {
    if (!token) return
    const el = inputRef.current
    let end = token.start + 1 + (token.quoted ? 1 : 0) + token.q.length
    let text = it.insert
    let caret: number
    let more = false
    if (it.kind === 'file' || it.kind === 'dir') {
      text = mentionOf(it.insert)
      if (token.quoted && value[end] === '"') end++ // the closing quote is replaced with the new one
      if (it.kind === 'dir') {
        more = true // keep completing inside it
        caret = token.start + text.length - (text.endsWith('"') ? 1 : 0)
      } else caret = token.start + text.length + 1
    } else caret = token.start + text.length + 1
    const next = value.slice(0, token.start) + text + (more ? '' : ' ') + value.slice(end)
    onChange(next)
    setToken(null)
    setFound(null)
    requestAnimationFrame(() => {
      if (!el || el.value !== next) return // typed on meanwhile: leave the caret alone
      el.setSelectionRange(caret, caret)
      el.focus()
      if (more) {
        setToken(tokenAt(next, caret, agents)) // keep completing inside the folder
        setSel(0)
      }
    })
  }

  return {
    open,
    /** Wire to the textarea. */
    handlers: {
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onChange(e.target.value)
        detect(e.target.value, e.target.selectionStart)
      },
      onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => detect(e.currentTarget.value, e.currentTarget.selectionStart),
      onCompositionStart: () => {
        composing.current = true
        setToken(null)
      },
      onCompositionEnd: (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        composing.current = false
        detect(e.currentTarget.value, e.currentTarget.selectionStart)
      },
    },
    /** Call first in onKeyDown; true: the key was the popup's (the caller does nothing else). */
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return false
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setToken(null)
        return true
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return false // ⌘↵ still sends
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (e.key === 'ArrowDown' ? at + 1 : at - 1 + items.length) % items.length)
        return true
      }
      if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault()
        if (!stale) apply(items[at]!)
        return true
      }
      return false
    },
    /** The completion list, to render inside a positioned parent. */
    popup: (dropUp?: boolean) =>
      open ? (
        <div
          ref={listRef}
          role="listbox"
          data-testid="completions"
          className={cx('absolute left-2 z-10 max-h-[min(320px,40vh)] w-[360px] max-w-[calc(100vw-32px)] overflow-y-auto overscroll-contain rounded-[10px] border border-linestrong bg-overlay p-1 shadow-pop', dropUp ? 'bottom-full mb-1' : 'top-full mt-1')}
        >
          {items.map((c, i) => {
            const slash = c.kind === 'file' || c.kind === 'dir' ? c.insert.replace(/\/$/, '').lastIndexOf('/') + 1 : 0
            return (
              <button
                key={c.key}
                type="button"
                role="option"
                aria-selected={i === at}
                data-testid="completion-item"
                data-kind={c.kind}
                data-insert={c.insert}
                onMouseDown={(e) => {
                  e.preventDefault()
                  apply(c)
                }}
                className={cx('flex min-h-10 w-full flex-col justify-center rounded-[6px] border-0 px-2.5 py-1.5 text-left', i === at ? 'bg-sel' : 'bg-transparent')}
              >
                {c.kind === 'file' || c.kind === 'dir' ? (
                  <span className="mono truncate text-[12.5px]">
                    <span className="text-subtle">{c.insert.slice(0, slash)}</span>
                    {c.insert.slice(slash)}
                  </span>
                ) : (
                  <>
                    <span className="mono text-[12.5px]">{c.insert}</span>
                    {c.description && <span className="truncate text-[11.5px] text-subtle">{c.description}</span>}
                  </>
                )}
              </button>
            )
          })}
        </div>
      ) : null,
  }
}
