import { useState } from 'react'
import type { Answer, ClosedReason, Question } from '../api'
import { hm } from '../lib/format'
import { renderMarkdown } from '../lib/markdown'
import { cx } from './ui'

export function answerIsEmpty(a?: Answer): boolean {
  if (!a) return true
  return !a.selected?.length && !a.other?.trim() && !a.text?.trim() && !a.skipped && !a.note?.trim()
}

export type CardState = 'Open' | 'Draft' | 'Answered' | 'Skipped' | 'Closed'

const CLOSED_NOTE: Record<ClosedReason, string> = {
  moved_on: 'Closed: a newer message moved the thread on.',
  replaced: 'Closed: Claude Code replaced this question.',
  marked_read: 'Closed unanswered when you marked it read.',
  archived: 'Closed unanswered when you archived the thread.',
}

type Props = {
  index: number
  total: number
  q: Question
  sent?: Answer
  draft?: Answer
  pickedAt?: number
  onDraft: (a: Answer) => void
  /** Why the question no longer takes answers, when it does not. */
  closed?: ClosedReason | null
  compact?: boolean
  phone?: boolean
}

/** Splits context into prose and the Stopped:/Holds up:/Replaces: lines shown on their own. */
function contextParts(ctx: string | undefined): { prose: string; meta: string[] } {
  const prose: string[] = []
  const meta: string[] = []
  for (const l of (ctx ?? '').split('\n')) {
    if (/^\s*(Stopped|Holds up|Replaces)\s*:/i.test(l)) meta.push(l.trim())
    else prose.push(l)
  }
  return { prose: prose.join('\n').trim(), meta }
}

export function QuestionCard({ index, total, q, sent, draft, pickedAt, onDraft, closed, phone }: Props) {
  const [noteOpen, setNoteOpen] = useState(!!draft?.note)
  const readOnly = !!sent || !!closed
  const a: Answer = sent ?? draft ?? { key: q.key }
  const choices = q.choices ?? []
  const recommended = choices.filter((c) => c.recommended).map((c) => c.label)
  const update = (patch: Partial<Answer>) => onDraft({ ...a, skipped: false, ...patch, key: q.key })
  const state: CardState = sent ? (sent.skipped ? 'Skipped' : 'Answered') : closed ? 'Closed' : answerIsEmpty(draft) ? 'Open' : 'Draft'
  const { prose, meta } = contextParts(q.context)

  const toggle = (label: string) => {
    if (readOnly) return
    const sel = new Set(a.selected ?? [])
    if (q.kind === 'multi') {
      if (sel.has(label)) sel.delete(label)
      else sel.add(label)
      update({ selected: [...sel] })
    } else {
      update({ selected: sel.has(label) ? [] : [label], other: '' })
    }
  }

  const frame = {
    Open: 'border-wait/45 bg-card',
    Draft: 'border-wait/45 bg-card',
    Answered: 'border-sel bg-carddim',
    Skipped: 'border-sel bg-carddim',
    Closed: 'border-line bg-surface',
  }[state]
  const chip = {
    Open: 'border border-wait text-wait',
    Draft: 'bg-wait/14 text-wait',
    Answered: 'bg-ok/14 text-ok',
    Skipped: 'border border-[#3f3f46] text-muted',
    Closed: 'bg-sel text-muted',
  }[state]
  const dim = state === 'Skipped' || state === 'Closed'
  const kindLabel = q.kind === 'multi' ? 'pick any' : q.kind === 'text' ? 'free text' : 'pick one'
  const answeredView = readOnly && !!sent && !sent.skipped

  return (
    <div className={cx('flex flex-col gap-2.5 rounded-xl border p-3.5', frame, phone && 'rounded-[14px]')} data-testid="question-card" data-question-key={q.key} data-state={state}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
          {total > 1 ? `Question ${index + 1} of ${total}` : `Q${index + 1}`}
          {q.kind !== 'single' || total <= 1 ? ` · ${kindLabel}` : ''}
        </span>
        <span className="flex-1" />
        <span data-testid="question-state" className={cx('box-border flex h-5 items-center rounded-full px-2 text-[11px] font-semibold', chip)}>
          {state}
        </span>
      </div>
      <div data-testid="question-text" className={cx('font-[650] leading-normal', phone ? 'text-[16px]' : 'text-[14.5px]', dim ? 'text-subtle' : 'text-fg')}>
        {q.prompt}
      </div>
      {prose && <div className="md text-[13px] text-muted" dangerouslySetInnerHTML={{ __html: renderMarkdown(prose) }} />}
      {meta.map((m) => (
        <div key={m} className="text-[13px] text-muted">
          {m}
        </div>
      ))}

      {q.kind === 'single' && (
        <div role="radiogroup" className={cx('flex flex-col', phone ? 'gap-2' : 'gap-1')}>
          {choices
            .filter((c) => !answeredView || (a.selected ?? []).includes(c.label))
            .map((c) => {
              const on = (a.selected ?? []).includes(c.label)
              return (
                <button
                  type="button"
                  key={c.label}
                  role="radio"
                  aria-checked={on}
                  aria-label={c.label}
                  disabled={readOnly}
                  onClick={() => toggle(c.label)}
                  data-testid="choice"
                  className={cx(
                    'flex items-center gap-2.5 text-left',
                    phone ? 'min-h-14 rounded-[11px] border px-3.5 py-3' : 'min-h-11 rounded-[9px] border border-transparent px-3 py-1.5',
                    on && state === 'Answered' && 'border-ok/45 bg-ok/6',
                    on && state !== 'Answered' && (phone ? 'border-wait/55 bg-wait/8' : 'bg-wait/10'),
                    !on && phone && 'border-linestrong',
                    !readOnly && !on && 'hover:bg-raised',
                    readOnly && 'cursor-default',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cx(
                      'box-border shrink-0 rounded-full',
                      phone ? 'h-5 w-5' : 'h-4 w-4',
                      on ? (state === 'Answered' ? 'border-[5px] border-ok' : 'border-[5px] border-wait') : state === 'Closed' ? 'border-[1.5px] border-dashed border-faint' : 'border-[1.5px] border-faint',
                    )}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={cx(phone ? 'text-[15px]' : 'text-[13.5px]', on ? 'font-semibold' : '', dim ? 'text-subtle' : 'text-fg')}>{c.label}</span>
                      {c.recommended && <RecommendedTag />}
                      {c.settled && <span className="text-[10.5px] text-subtle">decided</span>}
                    </span>
                    {c.description && <span className="text-[12px] text-subtle">{c.description}</span>}
                  </span>
                </button>
              )
            })}
          {(!readOnly || a.other) && <OtherInput value={a.other ?? ''} readOnly={readOnly} phone={phone} onChange={(v) => update({ other: v, selected: v ? [] : a.selected })} />}
        </div>
      )}

      {q.kind === 'multi' && (
        <div role="group" className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-1.5">
            {choices
              .filter((c) => !answeredView || (a.selected ?? []).includes(c.label))
              .map((c) => {
                const on = (a.selected ?? []).includes(c.label)
                return (
                  <button
                    type="button"
                    key={c.label}
                    role="checkbox"
                    aria-checked={on}
                    aria-label={c.label}
                    disabled={readOnly}
                    title={c.description}
                    onClick={() => toggle(c.label)}
                    data-testid="choice"
                    className={cx(
                      'flex items-center gap-1.5 rounded-md border px-3 text-[13px]',
                      phone ? 'min-h-11' : 'h-9',
                      on ? (state === 'Answered' ? 'border-ok/45 bg-ok/6' : 'border-linestrong bg-chip') : 'border-linestrong bg-transparent',
                      !readOnly && 'hover:border-muted',
                    )}
                  >
                    <span aria-hidden="true">{on ? '☑' : '☐'}</span>
                    {c.label}
                    {c.recommended && <span className="text-[10.5px] font-bold text-wait">Recommended</span>}
                    {c.settled && <span className="text-[10.5px] text-subtle">decided</span>}
                  </button>
                )
              })}
          </div>
          {(!readOnly || a.other) && <OtherInput value={a.other ?? ''} readOnly={readOnly} phone={phone} onChange={(v) => update({ other: v })} />}
        </div>
      )}

      {q.kind === 'text' && (
        <textarea
          value={a.text ?? ''}
          disabled={readOnly}
          onChange={(e) => update({ text: e.target.value })}
          placeholder={q.recommended_text ? `Suggested: ${q.recommended_text}` : 'Your answer…'}
          rows={3}
          data-testid="question-text-input"
          className="w-full resize-y rounded-[9px] border border-linestrong bg-sunken px-3 py-2 text-[13.5px] text-fg outline-none placeholder:text-faint focus:border-accent disabled:opacity-75"
        />
      )}
      {q.kind !== 'text' && q.recommended_text && <div className="text-[12px] text-work">Suggested: {q.recommended_text}</div>}

      {(noteOpen || a.note) && (
        <input
          value={a.note ?? ''}
          disabled={readOnly}
          onChange={(e) => update({ note: e.target.value })}
          placeholder="Note for Claude Code…"
          data-testid="question-note"
          className="h-9 w-full rounded-md border border-line2 bg-sunken px-2.5 text-[12.5px] text-fg2 outline-none placeholder:text-faint focus:border-accent disabled:opacity-75"
        />
      )}

      {!readOnly && (
        <div className={cx('flex items-center gap-1', phone ? 'gap-2' : 'border-t border-sel pt-2')}>
          {phone && recommended.length > 0 ? (
            <button
              type="button"
              data-testid="accept-recommended"
              onClick={() => update({ selected: q.kind === 'multi' ? recommended : recommended.slice(0, 1), other: '' })}
              className="h-11 flex-1 rounded-[10px] border-0 bg-sel text-[14px] font-semibold"
            >
              Accept recommended
            </button>
          ) : null}
          {!phone && !noteOpen && (
            <CardLink onClick={() => setNoteOpen(true)} testid="add-note">
              Add note
            </CardLink>
          )}
          {!phone && recommended.length > 0 && (
            <CardLink testid="accept-recommended" onClick={() => update({ selected: q.kind === 'multi' ? recommended : recommended.slice(0, 1), other: '' })}>
              Accept recommended
            </CardLink>
          )}
          <CardLink testid="skip-question" big={phone} onClick={() => onDraft({ key: q.key, skipped: !a.skipped, note: a.note })}>
            {a.skipped ? 'Unskip' : 'Skip'}
          </CardLink>
          {!phone && <span className="flex-1" />}
          {!phone && state === 'Draft' && pickedAt && <span className="text-[12px] text-subtle">Picked {hm(new Date(pickedAt))}, not sent</span>}
        </div>
      )}
      {a.skipped && !sent && <div className="text-[12px] text-subtle">Will be sent as skipped.</div>}
      {state === 'Closed' && closed && <div className="text-[12px] leading-normal text-subtle">{CLOSED_NOTE[closed]}</div>}
    </div>
  )
}

function CardLink({ children, onClick, testid, big }: { children: React.ReactNode; onClick: () => void; testid?: string; big?: boolean }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className={cx('rounded-[6px] border-0 bg-transparent px-2 text-muted hover:bg-raised hover:text-fg', big ? 'h-11 px-4 text-[14px]' : 'h-[30px] text-[12.5px]')}
    >
      {children}
    </button>
  )
}

export function RecommendedTag() {
  return <span className="rounded bg-wait/14 px-1.5 text-[10.5px] font-bold leading-[18px] text-wait">Recommended</span>
}

function OtherInput({ value, onChange, readOnly, phone }: { value: string; onChange: (v: string) => void; readOnly: boolean; phone?: boolean }) {
  return (
    <label
      data-testid="choice-other"
      className={cx('flex items-center gap-2.5 px-3 text-subtle', phone ? 'min-h-[52px] rounded-[11px] border border-dashed border-[#3f3f46]' : 'min-h-10')}
    >
      <span aria-hidden="true" className={cx('box-border shrink-0 rounded-full border-[1.5px] border-dashed border-faint', phone ? 'h-5 w-5' : 'h-4 w-4')} />
      <input
        aria-label="Other answer"
        placeholder="Other…"
        value={value}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-subtle"
      />
    </label>
  )
}

/** An `:::actions` block: things the person does, each Done or Can't do it. */
export function ActionItems({
  items,
  answers,
  drafts,
  onDraft,
  readOnly,
}: {
  items: Question[]
  answers: Record<string, Answer | undefined>
  drafts: Record<string, Answer | undefined>
  onDraft: (a: Answer) => void
  readOnly: boolean
}) {
  const title = items[0]?.context?.trim()
  const open = items.filter((q) => !answers[q.key]).length
  const [note, setNote] = useState('')
  return (
    <div data-testid="action-items" className="flex flex-col gap-2 rounded-xl border border-line2 bg-card p-3.5">
      <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
        {title ? `${title} · ` : ''}
        {open} action{open === 1 ? '' : 's'} to do
      </span>
      {items.map((q) => {
        const a = answers[q.key] ?? drafts[q.key]
        const sent = !!answers[q.key]
        const v = a?.selected?.[0]
        const done = v === 'Done'
        const cant = v === "Can't do it"
        return (
          <div key={q.key} data-testid="action-item" data-state={v ?? 'open'} className="flex min-h-10 items-center gap-2.5 text-[13.5px]">
            <span aria-hidden="true" className={cx('box-border h-4 w-4 shrink-0 rounded', done ? 'bg-ok' : cant ? 'bg-danger/60' : 'border-[1.5px] border-faint')} />
            <span className={cx('flex-1', (done || cant) && 'text-muted', done && 'line-through')}>{q.prompt}</span>
            {v && (
              <span className={cx('text-[12px]', done ? 'text-ok' : 'text-danger')}>
                {v}
                {!sent && ' · draft'}
              </span>
            )}
            {!readOnly && !sent && (
              <>
                <button
                  type="button"
                  data-testid="action-done"
                  onClick={() => onDraft({ key: q.key, selected: done ? [] : ['Done'], note: a?.note })}
                  className={cx('h-7 rounded-[6px] border px-2 text-[12px]', done ? 'border-ok text-ok' : 'border-linestrong bg-transparent')}
                >
                  Done
                </button>
                <button
                  type="button"
                  data-testid="action-cant"
                  onClick={() => onDraft({ key: q.key, selected: cant ? [] : ["Can't do it"], note: a?.note })}
                  className={cx('h-7 rounded-[6px] border px-2 text-[12px]', cant ? 'border-danger text-danger' : 'border-linestrong bg-transparent')}
                >
                  Can't do it
                </button>
              </>
            )}
          </div>
        )
      })}
      {!readOnly && (
        <input
          aria-label="Note"
          placeholder="Add a note for Claude Code"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            const last = items[items.length - 1]
            if (!last || !note.trim()) return
            const a = drafts[last.key]
            onDraft({ key: last.key, selected: a?.selected ?? [], note: note.trim() })
          }}
          className="h-[34px] rounded-md border border-line2 bg-sunken px-2.5 text-[13px] text-fg outline-none focus:border-accent"
        />
      )}
    </div>
  )
}
