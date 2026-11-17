import { useCallback, useEffect, useId, useState } from 'react'
import { api, type ReplyQuestion, type SuggestResult } from '../api'
import { useApp } from '../lib/app'
import { getReplyHelpDraft, setReplyHelpDraft, useDraftsVersion, type ReplyHelpAnswer, type ReplyHelpDraft } from '../lib/drafts'
import { IconChevronDown, IconChevronRight, IconClose, IconPencil, IconSparkle, IconTerminal } from './icons'
import { cx } from './ui'

// Reply help: questions for the person (drafted by the helper agent, GET /api/threads/{id}/suggestions)
// that help them decide how to answer the agent's latest message. Picked options and "Other" text are
// put into the reply when it is sent (composeReplyHelp). The same answer carries `command`: a shell
// command the agent tried and was denied, as its integration reported it (never guessed from text),
// offered as "Run yourself".

export type { ReplyHelpAnswer }

type HelpState = {
  data: SuggestResult | null // null: still drafting
  dismissed: boolean
  commandSent: boolean
}

// Per (thread, last message): survives switching threads and remounts. The answers are kept apart,
// per thread (drafts.ts), so the agent's next message does not wipe them.
const store = new Map<string, HelpState>()
const COLLAPSED = 'minbox.replyHelp.collapsed'

const NONE: ReplyHelpAnswer = { picked: [], other: false, text: '' }

function freeOnly(q: ReplyQuestion) {
  return q.options.length === 0
}

/** Has the person done anything with this answer (a pick, Other, or typed text)? */
function touched(a: ReplyHelpAnswer | undefined) {
  return !!a && (a.picked.length > 0 || a.other || !!a.text.trim())
}

/** The parts of one answer, in option order; "Other" text last. */
function answerParts(q: ReplyQuestion, a: ReplyHelpAnswer | undefined): string[] {
  if (!a) return []
  const parts = q.options.map((o) => o.label).filter((l) => a.picked.includes(l))
  if ((a.other || freeOnly(q)) && a.text.trim()) parts.push(a.text.trim().replace(/\s*\n\s*/g, ' '))
  return parts
}

/** The answered questions as reply text: one "Q: … → A: …" line each; unanswered ones are left out. */
export function composeReplyHelp(qs: ReplyQuestion[], answers: Record<string, ReplyHelpAnswer>): string {
  const lines: string[] = []
  for (const q of qs) {
    const parts = answerParts(q, answers[q.question])
    if (parts.length) lines.push(`Q: ${q.question} → A: ${parts.join(', ')}`)
  }
  return lines.join('\n')
}

/** The reply as delivered: the answers block, a blank line, then what the person typed. */
export function withReplyHelp(help: string, words: string): string {
  const w = words.trim()
  if (!help) return w
  return w ? `${help}\n\n${w}` : help
}

/** The questions to show: the ones the person already worked on stay as they were (first, when the
 *  new suggestions no longer ask them); the rest are the latest suggestions. */
function visibleQuestions(fresh: ReplyQuestion[], saved: ReplyHelpDraft): ReplyQuestion[] {
  const freshText = new Set(fresh.map((q) => q.question))
  const kept = Object.values(saved)
    .filter((k) => touched(k.a) && !freshText.has(k.q.question))
    .map((k) => k.q)
  return [...kept, ...fresh.map((q) => (touched(saved[q.question]?.a) ? saved[q.question].q : q))]
}

/** State of the reply help for the thread's last message; fetches when enabled. */
export function useReplyHelp(threadId: string, lastId: string | undefined, enabled: boolean) {
  const key = `${threadId}:${lastId ?? ''}`
  const [, setTick] = useState(0)
  const bump = useCallback(() => setTick((n) => n + 1), [])
  useDraftsVersion()
  const saved = getReplyHelpDraft(threadId)
  const get = (): HelpState => {
    let s = store.get(key)
    if (!s) {
      s = { data: null, dismissed: false, commandSent: false }
      store.set(key, s)
    }
    return s
  }
  const set = (f: (s: HelpState) => HelpState) => {
    store.set(key, f(get()))
    bump()
  }
  useEffect(() => {
    if (!enabled || !lastId) return
    const s = store.get(key)
    if (s?.data) return
    let live = true
    const fill = (data: SuggestResult) => {
      store.set(key, { ...(store.get(key) ?? { dismissed: false, commandSent: false }), data })
      if (live) bump()
    }
    api
      .suggestions(threadId)
      .then(fill)
      .catch(() => fill({ questions: [] }))
    return () => {
      live = false
    }
  }, [enabled, key, threadId, lastId, bump])
  const s = enabled && lastId ? get() : null
  const questions = s && !s.dismissed ? visibleQuestions(s.data?.questions ?? [], saved) : []
  const answers: Record<string, ReplyHelpAnswer> = {}
  for (const [k, v] of Object.entries(saved)) answers[k] = v.a
  const text = s && !s.dismissed ? composeReplyHelp(questions, answers) : ''
  return {
    state: s,
    questions,
    answers,
    /** The answers as reply text ('' when none or dismissed). */
    text,
    setAnswer: (q: ReplyQuestion, a: ReplyHelpAnswer) => {
      const d = { ...getReplyHelpDraft(threadId) }
      if (touched(a)) d[q.question] = { q, a }
      else delete d[q.question]
      setReplyHelpDraft(threadId, d)
    },
    dismiss: () => {
      setReplyHelpDraft(threadId, {})
      // The denied command goes too, also on the server (it is not offered again).
      if (get().data?.command) api.dismissDeniedCommand(threadId).catch(() => {})
      set((st) => ({ ...st, dismissed: true }))
    },
    clear: () => setReplyHelpDraft(threadId, {}),
    commandSent: (v: boolean) => set((st) => ({ ...st, commandSent: v })),
  }
}

export type ReplyHelpHandle = ReturnType<typeof useReplyHelp>

/** The panel above the reply box: the denied command chip, then the questions with options. */
export function ReplyHelpPanel({
  help,
  threadId,
  phone,
  onEditCommand,
  onSubmit,
}: {
  help: ReplyHelpHandle
  threadId: string
  phone?: boolean
  onEditCommand: (text: string) => void
  /** ⌘↵ in an answer field: send the reply. */
  onSubmit: () => void
}) {
  const { error } = useApp()
  const [collapsed, setCollapsedState] = useState(() => localStorage.getItem(COLLAPSED) === '1')
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v)
    if (v) localStorage.setItem(COLLAPSED, '1')
    else localStorage.removeItem(COLLAPSED)
  }
  const s = help.state
  if (!s || s.dismissed) return null
  const qs = help.questions
  if (!s.data && qs.length === 0)
    return (
      <div data-testid="reply-qa-loading" className="flex items-center gap-2 text-[12px] text-subtle" aria-live="polite">
        <IconSparkle size={13} />
        <span>Drafting questions to help you reply…</span>
        <span aria-hidden className="h-5 w-16 animate-pulse rounded-full bg-chip" />
        <span aria-hidden className="h-5 w-12 animate-pulse rounded-full bg-chip" />
      </div>
    )
  const drafting = !s.data
  const cmd = s.commandSent || !s.data ? '' : (s.data.command ?? '')
  if (!cmd && qs.length === 0) return null

  const runCommand = () => {
    help.commandSent(true)
    api.reply(threadId, { words: cmd }).catch((err) => {
      help.commandSent(false)
      error(err)
    })
  }
  const answered = qs.filter((q) => answerParts(q, help.answers[q.question]).length > 0).length
  const commandChip = cmd ? (
    <span className="inline-flex max-w-full items-center overflow-hidden rounded-full border border-accent/60 bg-wait/8 text-[12.5px] text-fg2">
      <button
        type="button"
        data-testid="reply-command"
        title={`Run ${cmd.slice(1)} yourself (the agent was denied it)`}
        onClick={runCommand}
        className={cx('flex min-w-0 max-w-[60ch] items-center gap-1.5 border-0 bg-transparent pl-3 pr-1.5 text-left hover:bg-raised hover:text-fg', phone ? 'min-h-10' : 'py-1')}
      >
        <IconTerminal size={13} />
        <span className="shrink-0 text-subtle">Run yourself:</span>
        <code className="min-w-0 truncate font-mono">{cmd}</code>
      </button>
      <button
        type="button"
        data-testid="reply-command-edit"
        aria-label={`Edit: ${cmd}`}
        title="Edit before running"
        onClick={() => onEditCommand(cmd)}
        className={cx('shrink-0 border-0 bg-transparent pl-1 pr-2.5 text-subtle hover:bg-raised hover:text-fg', phone ? 'min-h-10' : 'py-1')}
      >
        <IconPencil size={13} />
      </button>
    </span>
  ) : null

  return (
    <section data-testid="reply-qa" aria-label="Questions to help you reply" className="flex flex-col gap-1.5">
      {commandChip && <div className="flex">{commandChip}</div>}
      {qs.length > 0 && (
        <div className={cx('flex flex-col rounded-lg border border-line bg-sunken/60', phone ? 'gap-2 px-2.5 py-2' : 'gap-2 px-3 py-2')}>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="reply-qa-toggle"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
              className={cx('flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent p-0 text-left text-[12px] text-subtle hover:text-fg', phone && 'min-h-8')}
            >
              {collapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
              <IconSparkle size={13} />
              <span className="min-w-0 truncate">
                {qs.length === 1 ? '1 question' : `${qs.length} questions`} to help you reply
                {answered > 0 && ` · ${answered} answered`}
                {drafting && <span data-testid="reply-qa-refreshing"> · drafting new questions…</span>}
              </span>
            </button>
            <button
              type="button"
              data-testid="reply-qa-dismiss"
              aria-label="Dismiss the questions"
              title="Dismiss"
              onClick={help.dismiss}
              className={cx('flex shrink-0 items-center justify-center rounded border-0 bg-transparent p-0 text-subtle hover:bg-raised hover:text-fg', phone ? 'h-8 w-8' : 'h-6 w-6')}
            >
              <IconClose size={13} />
            </button>
          </div>
          {!collapsed && (
            <div className={cx('flex flex-col gap-2.5', phone && 'max-h-[36vh] overflow-y-auto')}>
              {qs.map((q, i) => (
                <HelpQuestion key={q.question} q={q} index={i} a={help.answers[q.question] ?? NONE} phone={phone} onChange={(a) => help.setAnswer(q, a)} onSubmit={onSubmit} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function HelpQuestion({ q, index, a, phone, onChange, onSubmit }: { q: ReplyQuestion; index: number; a: ReplyHelpAnswer; phone?: boolean; onChange: (a: ReplyHelpAnswer) => void; onSubmit: () => void }) {
  const multi = q.kind === 'multi'
  const labelId = useId()
  const toggle = (label: string) => {
    if (multi) onChange({ ...a, picked: a.picked.includes(label) ? a.picked.filter((l) => l !== label) : [...a.picked, label] })
    else onChange({ ...a, picked: a.picked.includes(label) ? [] : [label], other: false })
  }
  const toggleOther = () => (multi ? onChange({ ...a, other: !a.other }) : onChange({ ...a, other: !a.other, picked: [] }))
  const only = freeOnly(q)
  // Roving focus for radios: one tab stop, the arrow keys move and pick.
  const items = [...q.options.map((o) => o.label), '\u0000other']
  const current = multi ? -1 : a.other ? items.length - 1 : Math.max(0, items.findIndex((l) => a.picked.includes(l)))
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    const d = keys[e.key]
    if (!d) return
    const btns = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-reply-chip]'))
    const at = btns.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    const next = btns[(at + d + btns.length) % btns.length]
    next.focus()
    if (!multi) next.click()
  }
  const chip = (on: boolean) =>
    cx(
      'inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent',
      phone ? 'min-h-10' : 'min-h-7 py-0.5',
      on ? 'border-accent bg-wait/12 font-semibold text-fg' : 'border-linestrong bg-surface text-fg2 hover:border-muted hover:text-fg',
    )
  const desc = !multi ? q.options.find((o) => a.picked.includes(o.label))?.description : undefined
  return (
    <div data-testid="reply-q" data-index={index} data-kind={q.kind} className="flex flex-col gap-1.5">
      <div id={labelId} className={cx('font-[600] text-fg', phone ? 'text-[14px]' : 'text-[13px]')}>
        {q.question}
        {multi && <span className="ml-1.5 text-[11px] font-normal text-subtle">pick any</span>}
      </div>
      {!only && (
        <div role={multi ? 'group' : 'radiogroup'} aria-labelledby={labelId} onKeyDown={onKeyDown} className="flex flex-wrap gap-1.5">
          {q.options.map((o, j) => {
            const on = a.picked.includes(o.label)
            return (
              <button
                type="button"
                key={o.label}
                data-reply-chip
                data-testid="reply-q-option"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={on}
                tabIndex={multi || j === current ? 0 : -1}
                title={o.description}
                aria-description={o.description}
                onClick={() => toggle(o.label)}
                className={chip(on)}
              >
                <span aria-hidden className="text-[11px]">{multi ? (on ? '☑' : '☐') : on ? '●' : '○'}</span>
                <span className="min-w-0 truncate">{o.label}</span>
              </button>
            )
          })}
          <button
            type="button"
            data-reply-chip
            data-testid="reply-q-other"
            role={multi ? 'checkbox' : 'radio'}
            aria-checked={a.other}
            tabIndex={multi || current === items.length - 1 ? 0 : -1}
            onClick={toggleOther}
            className={chip(a.other)}
          >
            <span aria-hidden className="text-[11px]">{multi ? (a.other ? '☑' : '☐') : a.other ? '●' : '○'}</span>
            Other…
          </button>
        </div>
      )}
      {desc && <div className="text-[11.5px] text-subtle">{desc}</div>}
      {(only || a.other) && (
        <input
          data-testid="reply-q-other-input"
          aria-label={only ? q.question : `Other answer: ${q.question}`}
          autoFocus={!only}
          value={a.text}
          onChange={(e) => onChange({ ...a, text: e.target.value, other: only ? a.other : true })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onSubmit()
            }
          }}
          placeholder="Your answer…"
          className={cx(
            'w-full rounded-md border border-linestrong bg-surface px-2.5 text-fg outline-none placeholder:text-faint focus:border-accent',
            phone ? 'h-10 text-[16px]' : 'h-8 text-[13px]',
          )}
        />
      )}
    </div>
  )
}
