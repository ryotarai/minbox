import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, type Completion, type Completions, type Session } from '../api'
import { ComposeFileTiles, clearFiles, fileInputHandlers, uploadIds, useComposeFiles } from '../lib/uploads'
import { useApp } from '../lib/app'
import { deleteComposeDraft, getComposeDrafts, saveComposeDraft } from '../lib/drafts'
import { IconPaperclip } from './icons'
import { Button, MenuItem, Modal, Popover, cx } from './ui'

/** New message: the person starts a thread with one session's Claude Code. */
export function Compose({ sessionId, draftId, onClose }: { sessionId?: string; draftId?: string; onClose: () => void }) {
  const { sessions, navigate, toast, error, route } = useApp()
  const saved = draftId ? getComposeDrafts().find((d) => d.id === draftId) : undefined
  const live = (sessions ?? []).filter((s) => !s.archived_at)
  const [to, setTo] = useState<string>(saved?.session_id ?? sessionId ?? route.s ?? live[0]?.id ?? '')
  const [subject, setSubject] = useState(saved?.subject ?? '')
  const [body, setBody] = useState(saved?.body ?? '')
  const [name, setName] = useState(saved?.name ?? '')
  const [naming, setNaming] = useState(!!saved?.name)
  const filesId = `compose:${draftId ?? 'new'}`
  const { files, addFiles, addPastedText, remove: removeFile } = useComposeFiles(filesId)
  const io = fileInputHandlers(addFiles, addPastedText)
  const uploading = files.some((f) => f.state === 'uploading')
  const hasFiles = files.some((f) => f.state === 'done')
  const [toAnchor, setToAnchor] = useState<HTMLElement | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [sending, setSending] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const session = live.find((s) => s.id === to) ?? null
  const dirty = !!(subject.trim() || body.trim() || files.length)

  const close = () => {
    if (dirty && !confirmClose) setConfirmClose(true)
    else onClose()
  }
  const keep = () => {
    saveComposeDraft({ id: draftId ?? `c${Date.now()}`, session_id: to, subject, body, name, updated: Date.now() })
    toast('Kept as a draft')
    onClose()
  }

  const send = async () => {
    if (!session || (!body.trim() && !hasFiles) || uploading || sending) return
    setSending(true)
    try {
      const th = await api.createThread(session.id, subject.trim(), body.trim(), name.trim() || undefined, uploadIds(filesId))
      clearFiles(filesId)
      if (draftId) deleteComposeDraft(draftId)
      onClose()
      toast(`Sent to Claude Code · in ${session.name}`, { action: 'Open', onAction: () => navigate({ s: session.id, t: th.id, view: 'main' }) })
      if (route.s === session.id) navigate({ t: th.id })
    } catch (err) {
      error(err)
    } finally {
      setSending(false)
    }
  }

  const hint = !session
    ? 'Pick a session'
    : session.status === 'ended'
      ? 'The session has ended; it gets this after Resume'
      : session.status === 'working'
        ? 'Working: it gets this when its turn ends'
        : 'Idle: it gets this as its next turn'

  return (
    <Modal label="New message" onClose={close} className="w-[min(560px,100%)] p-4" top>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="w-12 text-subtle">To</span>
          <button
            type="button"
            data-testid="compose-to"
            onClick={(e) => setToAnchor(e.currentTarget)}
            className="flex h-[34px] flex-1 items-center gap-2 rounded-md border border-linestrong bg-sunken px-2.5 text-left text-[13px]"
          >
            {session ? (
              <>
                Claude Code · {session.name}
                <span className="text-subtle">{session.status === 'idle' ? 'idle' : session.status}</span>
              </>
            ) : (
              <span className="text-subtle">Choose a session</span>
            )}
            <span className="flex-1" />▾
          </button>
        </div>
        <Popover anchor={toAnchor} open={!!toAnchor} onClose={() => setToAnchor(null)} align="start" className="w-[340px]">
          {live.map((s) => (
            <MenuItem
              key={s.id}
              active={s.id === to}
              hint={s.status}
              onClick={() => {
                setTo(s.id)
                setToAnchor(null)
              }}
            >
              {s.name}
            </MenuItem>
          ))}
        </Popover>
        <div className="flex items-center gap-2 text-[13px]">
          <span className="w-12 text-subtle">Thread</span>
          {naming ? (
            <input
              aria-label="Thread name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))}
              placeholder="short-name"
              className="mono h-6 w-48 rounded-[5px] border border-linestrong bg-sunken px-2 text-[11.5px] outline-none focus:border-accent"
            />
          ) : (
            <button type="button" onClick={() => setNaming(true)} className="mono rounded-[5px] border border-dashed border-[#52525b] bg-transparent px-2 text-[11.5px] leading-[22px] text-fg2">
              + name
            </button>
          )}
        </div>
        <input
          data-testid="compose-subject"
          aria-label="Subject"
          placeholder="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="h-9 rounded-md border border-linestrong bg-sunken px-2.5 text-[14px] outline-none focus:border-accent"
        />
        <CompletingTextarea
          ref={bodyRef}
          sessionId={session?.id ?? null}
          value={body}
          onChange={setBody}
          onSubmit={() => void send()}
          {...io}
          placeholder="Message to Claude Code. @ for agents, / for skills."
        />
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
        <div className="flex items-center gap-2">
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
          <span className="flex-1 text-[12px] text-subtle">{hint}</span>
          <Button variant="ghost" size="sm" className="h-[34px]" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" className="h-[34px] px-3.5" data-testid="compose-send" disabled={!session || (!body.trim() && !hasFiles) || uploading || sending} onClick={() => void send()}>
            Send ⌘↵
          </Button>
        </div>
        {confirmClose && (
          <div className="flex items-center gap-2 rounded-[10px] border border-line2 bg-raised px-3 py-2.5 text-[12.5px]" data-testid="keep-draft">
            <b className="flex-1 font-semibold text-fg">Keep this message as a draft?</b>
            <Button size="sm" onClick={keep}>
              Keep draft
            </Button>
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                if (draftId) deleteComposeDraft(draftId)
                onClose()
              }}
            >
              Discard
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

type CompletingProps = {
  sessionId: string | null
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  placeholder: string
  className?: string
  testid?: string
  /** Open the @ / completions above the field (it sits at the bottom of a column). */
  dropUp?: boolean
  /** Grow with the text, from `min` px up to `max` px (then it scrolls). */
  autoGrow?: { min: number; max: number }
  /** Fill the height of the parent (a flex column) instead of a fixed one. */
  fill?: boolean
}

/** A textarea that completes @agents and /skills of the session's project. */
export const CompletingTextarea = ({ ref, sessionId, value, onChange, onSubmit, placeholder, className, testid = 'compose-body', dropUp, autoGrow, fill, onPaste, onDrop, onDragOver }: CompletingProps & { ref: React.RefObject<HTMLTextAreaElement | null> } & Partial<ReturnType<typeof fileInputHandlers>>) => {
  const [comps, setComps] = useState<Completions | null>(null)
  const [token, setToken] = useState<{ ch: '@' | '/'; start: number; q: string } | null>(null)
  const [sel, setSel] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!autoGrow || fill) {
      el.style.height = ''
      el.style.overflowY = ''
      return
    }
    el.style.height = 'auto'
    const h = Math.min(autoGrow.max, Math.max(autoGrow.min, el.scrollHeight + 2)) // +2: the border
    el.style.height = `${h}px`
    el.style.overflowY = el.scrollHeight + 2 > autoGrow.max ? 'auto' : 'hidden'
  }, [value, autoGrow, fill, ref])
  useEffect(() => {
    if (!sessionId) return
    api.completions(sessionId).then(setComps).catch(() => setComps(null))
  }, [sessionId])
  const items: (Completion & { insert: string })[] = useMemo(() => {
    if (!token || !comps) return []
    const pool =
      token.ch === '@'
        ? comps.agents.map((c) => ({ ...c, insert: `@${c.name}` }))
        : [...comps.skills, ...comps.commands].map((c) => ({ ...c, insert: `/${c.name}` }))
    return pool.filter((c) => c.name.toLowerCase().includes(token.q.toLowerCase())).slice(0, 8)
  }, [token, comps])

  const detect = (v: string, caret: number) => {
    const before = v.slice(0, caret)
    const m = /(^|\s)([@/])([\w:.-]*)$/.exec(before)
    if (m) {
      setToken({ ch: m[2] as '@' | '/', start: caret - m[3]!.length - 1, q: m[3]! })
      setSel(0)
    } else setToken(null)
  }
  const apply = (c: { insert: string }) => {
    if (!token) return
    const caret = token.start + 1 + token.q.length
    const next = value.slice(0, token.start) + c.insert + ' ' + value.slice(caret)
    onChange(next)
    setToken(null)
    requestAnimationFrame(() => {
      const p = token.start + c.insert.length + 1
      ref.current?.setSelectionRange(p, p)
      ref.current?.focus()
    })
  }
  return (
    <div className={cx('relative', fill && 'min-h-0 flex-1')}>
      <textarea
        ref={ref}
        data-testid={testid}
        aria-label="Body"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value)
          detect(e.target.value, e.target.selectionStart)
        }}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onKeyDown={(e) => {
          if (items.length > 0 && token) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => (s + 1) % items.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => (s - 1 + items.length) % items.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              apply(items[sel]!)
              return
            }
            if (e.key === 'Escape') {
              e.stopPropagation()
              setToken(null)
              return
            }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onSubmit()
          }
        }}
        className={cx('w-full resize-none rounded-md border border-linestrong bg-sunken p-2.5 text-[13.5px] outline-none focus:border-accent', fill ? 'h-full' : (className ?? 'h-[120px]'))}
      />
      {items.length > 0 && (
        <div role="listbox" data-testid="completions" className={cx('absolute left-2 z-10 w-[320px] rounded-[10px] border border-linestrong bg-overlay p-1 shadow-pop', dropUp ? 'bottom-full mb-1' : 'top-full mt-1')}>
          {items.map((c, i) => (
            <button
              key={c.insert}
              type="button"
              role="option"
              aria-selected={i === sel}
              onMouseDown={(e) => {
                e.preventDefault()
                apply(c)
              }}
              className={cx('flex w-full flex-col rounded-[6px] border-0 px-2.5 py-1.5 text-left', i === sel ? 'bg-sel' : 'bg-transparent')}
            >
              <span className="mono text-[12.5px]">{c.insert}</span>
              {c.description && <span className="truncate text-[11.5px] text-subtle">{c.description}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export type { Session }
