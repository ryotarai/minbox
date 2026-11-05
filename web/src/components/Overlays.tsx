import { useEffect, useState } from 'react'
import { api, type Answer, type Message, type Question, type Session, type Thread } from '../api'
import { useApp } from '../lib/app'
import { getComposeDrafts, getReplyDraft, deleteComposeDraft, replyDraftThreads, updateReplyDraft, useDraftsVersion } from '../lib/drafts'
import { isMac, plural, shortTime } from '../lib/format'
import { useHotkeys } from '../lib/hotkeys'
import { answerIsEmpty, RecommendedTag } from './QuestionCard'
import { Button, Modal, cx } from './ui'

// ---- toasts ----

export function Toasts() {
  const { toasts, dismissToast, isPhone } = useApp()
  return (
    <div className={cx('pointer-events-none fixed inset-x-0 z-[70] flex flex-col items-center gap-2 px-3', isPhone ? 'bottom-[max(84px,env(safe-area-inset-bottom))]' : 'bottom-4')}>
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="notice"
          role={t.error ? 'alert' : 'status'}
          className={cx(
            'pointer-events-auto flex min-h-11 max-w-[min(640px,100%)] items-center gap-3 rounded-[10px] border py-1 pl-3.5 pr-2 text-[13px] shadow-pop',
            t.error ? 'border-danger/50 bg-[#3a1d16] text-dangerfg [[data-theme=light]_&]:bg-[#fde8e2]' : 'border-[#3a3a42] bg-sel text-fg',
          )}
        >
          {t.error && <span aria-hidden="true">△</span>}
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          {t.action && (
            <button
              type="button"
              data-testid="undo"
              onClick={() => {
                t.onAction?.()
                dismissToast(t.id)
              }}
              className="h-[30px] shrink-0 rounded-md border-0 bg-transparent px-2.5 text-[13px] font-[650] text-wait hover:bg-raised"
            >
              {t.action}
              {t.undo && <span className="ml-1.5 text-[11px] font-normal text-subtle">Z</span>}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// ---- keyboard shortcuts (?) ----

const KEYS: [string, string, boolean?][] = [
  ['Everywhere', '', true],
  ['', '', true],
  ['Quick actions', '⌘K  /'],
  ['Shortcuts', '?'],
  ['Sidebar', '⌘B'],
  ['Shell pane', 'Ctrl+`'],
  ['Close layer', 'Esc'],
  ['List', '', true],
  ['Thread', '', true],
  ['Move', '↑ ↓'],
  ['Next / prev thread', 'J  K'],
  ['Open', '↵'],
  ['Reply', 'R'],
  ['Mark read', 'E'],
  ['Send', '⌘↵'],
  ['Undo', 'Z'],
  ['First new', 'N'],
  ['Row menu', '⇧F10'],
  ['Open questions', 'Q'],
  ['Archive thread', '⇧E'],
  ['', ''],
  ['File', '', true],
  ['', '', true],
  ['Next / prev file', ']  ['],
  ['Full screen', 'F'],
  ['Latest file', 'O'],
  ['Paste image (term)', '⌘V'],
]

export function Shortcuts({ onClose }: { onClose: () => void }) {
  const mod = isMac() ? '⌘' : 'Ctrl+'
  return (
    <Modal label="Keyboard shortcuts" onClose={onClose} className="w-[min(560px,100%)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <b className="text-[15px] font-[650]">Keyboard</b>
        <span className="text-[12px] text-subtle">In the terminal, only ⌘K works.</span>
      </div>
      <div className="grid grid-cols-2 gap-x-[18px] gap-y-1.5" data-testid="shortcuts">
        {KEYS.map(([label, key, head], i) => (
          <div key={i} className="flex min-h-6 items-center gap-2 text-[12.5px]">
            <span className={cx('flex-1', head ? 'font-bold text-subtle' : 'text-fg')}>{label}</span>
            <kbd className="text-[11px] text-fg2">{key.replace(/⌘/g, mod)}</kbd>
          </div>
        ))}
      </div>
    </Modal>
  )
}

// ---- delete a session ----

export function DeleteSession({ session, onClose }: { session: Session; onClose: () => void }) {
  const { error, reloadSessions, navigate, route, toast } = useApp()
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    api
      .threads(session.id)
      .then((t) => setCount(t.length))
      .catch(() => setCount(null))
  }, [session.id])
  const del = () => {
    onClose()
    api
      .deleteSession(session.id)
      .then(() => {
        if (route.s === session.id) navigate({ s: null })
        reloadSessions()
      })
      .catch(error)
  }
  const archive = () => {
    onClose()
    const run = async () => {
      if (session.status !== 'ended') await api.stopSession(session.id)
      await api.archiveSession(session.id)
      reloadSessions()
      toast(`Archived ${session.name} (session)`, { action: 'Undo', undo: true, onAction: () => api.unarchiveSession(session.id).then(reloadSessions).catch(error) })
    }
    run().catch(error)
  }
  return (
    <Modal label={`Delete ${session.name}`} onClose={onClose} className="flex w-[min(440px,100%)] flex-col gap-3 bg-[#1c1c21] p-5 [[data-theme=light]_&]:bg-overlay">
      <h3 className="m-0 text-[16px] font-[650]">Delete {session.name}?</h3>
      <p className="m-0 text-[13.5px] leading-[1.6] text-muted">
        {count !== null ? `Its ${count === 1 ? 'thread goes' : `${count} threads go`} too. ` : 'Its threads go too. '}This cannot be undone. To keep it out of the way, archive it instead.
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={archive} data-testid="delete-archive-instead">
          Archive instead
        </Button>
        <Button variant="danger" onClick={del} data-testid="delete-confirm" autoFocus>
          Delete
        </Button>
      </div>
    </Modal>
  )
}

// ---- drafts ----

export function DraftsList({ onClose }: { onClose: () => void }) {
  const { navigate, setOverlay, sessions } = useApp()
  useDraftsVersion()
  const replies = replyDraftThreads()
  const composes = getComposeDrafts()
  const [threads, setThreads] = useState<Record<string, Thread>>({})
  useEffect(() => {
    for (const id of replies) api.thread(id).then((t) => setThreads((m) => ({ ...m, [id]: t }))).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replies.join(',')])
  return (
    <Modal label="Drafts" onClose={onClose} className="flex w-[min(520px,100%)] flex-col gap-2 p-4" top>
      <b className="text-[15px] font-[650]">Drafts</b>
      {replies.length + composes.length === 0 && <span className="py-4 text-[13px] text-subtle">No drafts.</span>}
      {replies.map((id) => {
        const t = threads[id]
        const d = getReplyDraft(id)
        const s = sessions?.find((x) => x.id === t?.session_id)
        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              onClose()
              if (t) navigate({ s: t.session_id, t: id, view: 'main', tab: 'inbox' })
            }}
            className="flex flex-col gap-0.5 rounded-lg border border-line2 bg-raised px-3 py-2 text-left hover:border-linestrong"
          >
            <span className="text-[13px] font-semibold">Reply · {t?.subject ?? id}</span>
            <span className="truncate text-[12px] text-muted">
              {s?.name ?? ''} · {d.words || `${Object.values(d.picks).reduce((n, m) => n + Object.keys(m).length, 0)} picks`} · {shortTime(new Date(d.updated).toISOString())}
            </span>
          </button>
        )
      })}
      {composes.map((c) => (
        <div key={c.id} className="flex items-center gap-2 rounded-lg border border-line2 bg-raised px-3 py-2">
          <button
            type="button"
            onClick={() => setOverlay({ kind: 'compose', draftId: c.id, sessionId: c.session_id })}
            className="flex min-w-0 flex-1 flex-col gap-0.5 border-0 bg-transparent p-0 text-left"
          >
            <span className="text-[13px] font-semibold">New message · {c.subject || '(no subject)'}</span>
            <span className="truncate text-[12px] text-muted">
              {sessions?.find((s) => s.id === c.session_id)?.name ?? ''} · {c.body.slice(0, 80)}
            </span>
          </button>
          <button type="button" aria-label="Delete draft" onClick={() => deleteComposeDraft(c.id)} className="border-0 bg-transparent text-subtle hover:text-fg">
            ×
          </button>
        </div>
      ))}
    </Modal>
  )
}

// ---- decision mode ----

type Item = { session: Session; thread: Thread; message: Message; q: Question }

/** Decide: every open question across sessions, one at a time, picked by number. */
export function DecisionMode({ onClose }: { onClose: () => void }) {
  const { sessions, error, toast } = useApp()
  const [items, setItems] = useState<Item[] | null>(null)
  const [i, setI] = useState(0)
  const [history, setHistory] = useState<number[]>([])
  const [all, setAll] = useState(false)
  const [multi, setMulti] = useState<string[]>([])

  useEffect(() => {
    const load = async () => {
      const out: Item[] = []
      for (const s of (sessions ?? []).filter((x) => !x.archived_at && x.open_questions > 0)) {
        const threads = await api.threads(s.id)
        for (const t of threads.filter((x) => x.open_questions > 0 && x.section !== 'archived' && x.section !== 'snoozed')) {
          const full = await api.thread(t.id)
          const msgs = full.messages ?? []
          const m = [...msgs].reverse().find((x) => x.author === 'agent')
          if (!m) continue
          for (const q of m.questions ?? []) {
            if (q.kind === 'action' || m.closed?.[q.key]) continue
            const a = m.answer_state?.[q.key]
            if (a && !answerIsEmpty(a)) continue
            out.push({ session: s, thread: full, message: m, q })
          }
        }
      }
      setItems(out)
    }
    load().catch(error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cur = items?.[i]
  const pick = (a: Answer) => {
    if (!cur) return
    updateReplyDraft(cur.thread.id, (d) => ({
      ...d,
      picks: { ...d.picks, [cur.message.id]: { ...(d.picks[cur.message.id] ?? {}), [a.key]: a } },
      pickedAt: { ...d.pickedAt, [a.key]: Date.now() },
    }))
    advance()
  }
  const advance = () => {
    if (!items || !cur) return
    setHistory((h) => [...h, i])
    setMulti([])
    const next = i + 1
    // When the thread's last open question is decided, send its answers.
    const nextItem = items[next]
    if (!nextItem || nextItem.message.id !== cur.message.id) void sendThread(cur)
    setI(next)
  }
  const sendThread = async (it: Item) => {
    const d = getReplyDraft(it.thread.id)
    const picks = d.picks[it.message.id] ?? {}
    const answers = Object.values(picks).filter((a) => !answerIsEmpty(a))
    if (!answers.length) return
    try {
      await api.reply(it.thread.id, { words: d.words, answers_for: it.message.id, answers })
      updateReplyDraft(it.thread.id, (x) => ({ ...x, words: '', picks: { ...x.picks, [it.message.id]: {} } }))
      toast(`Sent ${plural(answers.length, 'answer')} to ${it.session.name}`)
    } catch (err) {
      error(err)
    }
  }
  const undo = () => {
    const prev = history[history.length - 1]
    if (prev === undefined || !items) return
    const it = items[prev]!
    updateReplyDraft(it.thread.id, (d) => {
      const m = { ...(d.picks[it.message.id] ?? {}) }
      delete m[it.q.key]
      return { ...d, picks: { ...d.picks, [it.message.id]: m } }
    })
    setHistory((h) => h.slice(0, -1))
    setI(prev)
  }

  const choices = cur?.q.choices ?? []
  const keys: Record<string, () => void> = { s: () => cur && pick({ key: cur.q.key, skipped: true }), z: undo, enter: () => cur?.q.kind === 'multi' && multi.length && pick({ key: cur.q.key, selected: multi }) }
  choices.slice(0, 9).forEach((c, n) => {
    keys[String(n + 1)] = () => {
      if (!cur) return
      if (cur.q.kind === 'multi') setMulti((m) => (m.includes(c.label) ? m.filter((x) => x !== c.label) : [...m, c.label]))
      else pick({ key: cur.q.key, selected: [c.label] })
    }
  })
  useHotkeys(keys)

  const waitingSessions = new Set(items?.map((x) => x.session.id)).size
  return (
    <Modal label="Decide" onClose={onClose} className="flex w-[min(560px,100%)] flex-col gap-3 p-4" top>
      <div className="flex items-center gap-2 text-[12.5px] text-muted" data-testid="decide">
        <b className="font-[650] text-fg">Decide</b>
        {items && cur && (
          <span className="truncate">
            · {cur.thread.subject} · {i + 1} of {items.length} · {plural(waitingSessions, 'session')} waiting
          </span>
        )}
        <span className="flex-1" />
        <button type="button" onClick={undo} disabled={!history.length} className="border-0 bg-transparent text-muted hover:text-fg disabled:opacity-40">
          Undo
        </button>
        ·
        <button type="button" onClick={() => setAll((v) => !v)} className="border-0 bg-transparent text-muted hover:text-fg">
          All
        </button>
        ·
        <button type="button" aria-label="Close" onClick={onClose} className="border-0 bg-transparent text-muted hover:text-fg">
          ×
        </button>
      </div>
      {items && items.length > 0 && (
        <div className="h-1 rounded-sm bg-line2">
          <div className="h-1 rounded-sm bg-accent" style={{ width: `${(Math.min(i, items.length) / items.length) * 100}%` }} />
        </div>
      )}
      {!items && <span className="text-[13px] text-subtle">Loading open questions…</span>}
      {items && items.length === 0 && <span className="py-4 text-[14px]">Nothing waits on you. 🎉</span>}
      {items && items.length > 0 && !cur && (
        <div className="flex flex-col gap-2 py-2">
          <span className="text-[15px] font-[650]">All decided.</span>
          <span className="text-[13px] text-muted">Answers were sent to each thread as you finished it.</span>
          <Button variant="primary" className="self-start" onClick={onClose}>
            Done
          </Button>
        </div>
      )}
      {all && items && (
        <div className="flex max-h-[30vh] flex-col gap-1 overflow-y-auto rounded-lg border border-line2 p-1.5">
          {items.map((it, n) => (
            <button key={n} type="button" onClick={() => setI(n)} className={cx('flex gap-2 rounded-md border-0 px-2 py-1 text-left text-[12.5px]', n === i ? 'bg-sel' : 'bg-transparent')}>
              <span className="mono text-subtle">{it.session.name}</span>
              <span className="truncate">{it.q.prompt}</span>
            </button>
          ))}
        </div>
      )}
      {cur && (
        <>
          <div className="text-[16px] font-[650]">{cur.q.prompt}</div>
          <span className="mono text-[11.5px] text-subtle">{cur.session.name}</span>
          {cur.q.kind === 'text' ? (
            <TextDecision onSubmit={(text) => pick({ key: cur.q.key, text })} placeholder={cur.q.recommended_text} />
          ) : (
            choices.map((c, n) => {
              const on = multi.includes(c.label)
              return (
                <button
                  key={c.label}
                  type="button"
                  data-testid="decide-choice"
                  onClick={() => keys[String(n + 1)]?.()}
                  className={cx(
                    'flex min-h-11 items-center gap-2 rounded-[9px] border px-3 text-left text-[13.5px]',
                    c.recommended || on ? 'border-wait/50 bg-wait/8' : 'border-linestrong bg-transparent',
                  )}
                >
                  <b className="font-[650]">{n + 1}</b> {cur.q.kind === 'multi' && <span>{on ? '☑' : '☐'}</span>} {c.label} {c.recommended && <RecommendedTag />}
                </button>
              )
            })
          )}
          <div className="flex justify-between text-[12px] text-subtle">
            <span>{cur.q.kind === 'multi' ? '1–9 to pick, ↵ to go on · S to skip' : '1–9 to pick · S to skip'}</span>
            <span>Sent per thread</span>
          </div>
        </>
      )}
    </Modal>
  )
}

function TextDecision({ onSubmit, placeholder }: { onSubmit: (t: string) => void; placeholder?: string }) {
  const [v, setV] = useState('')
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (v.trim()) onSubmit(v.trim())
      }}
    >
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder ?? 'Your answer…'} className="h-10 flex-1 rounded-md border border-linestrong bg-sunken px-3 text-[13.5px] outline-none focus:border-accent" />
      <Button variant="primary" type="submit">
        Next
      </Button>
    </form>
  )
}
