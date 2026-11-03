import { useEffect, useMemo, useState } from 'react'
import { api, type Card, type CardColumn } from '../api'
import { useApp } from '../lib/app'
import { useHotkeys } from '../lib/hotkeys'
import { IconBack, IconMoreV } from './icons'
import { Button, IconButton, MenuItem, MenuSep, Modal, Popover, cx } from './ui'

const COLUMNS: { id: CardColumn; title: string; accent?: boolean }[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'designing', title: 'Designing' },
  { id: 'look', title: 'Your look', accent: true },
  { id: 'building', title: 'Building' },
  { id: 'review', title: 'Your review' },
  { id: 'shipped', title: 'Shipped' },
]
const PR_COLOR: Record<string, string> = { draft: 'text-muted', open: 'text-ok', merged: 'text-purple', closed: 'text-danger' }

/** Board: the work in flight, as cards across columns. */
export function BoardPage() {
  const { cardsVersion, error, navigate, sessions } = useApp()
  const [cards, setCards] = useState<Card[] | null>(null)
  const [filter, setFilter] = useState('')
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null)
  const [optsAnchor, setOptsAnchor] = useState<HTMLElement | null>(null)
  const [editing, setEditing] = useState<Partial<Card> | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  useEffect(() => {
    api.cards().then(setCards).catch(error)
  }, [cardsVersion, error])
  useHotkeys({ escape: () => navigate({ view: 'main' }) })

  const visible = useMemo(() => (cards ?? []).filter((c) => !filter || c.session_id === filter), [cards, filter])
  const inFlight = visible.filter((c) => !['shipped', 'icebox', 'dropped'].includes(c.column)).length
  const onYou = visible.filter((c) => c.column === 'look' || c.column === 'review').length
  const icebox = visible.filter((c) => c.column === 'icebox')
  const dropped = visible.filter((c) => c.column === 'dropped')
  const sessionName = (id: string | null) => sessions?.find((s) => s.id === id)?.name ?? '—'

  const move = (id: string, column: CardColumn) => {
    setCards((cs) => cs?.map((c) => (c.id === id ? { ...c, column } : c)) ?? null)
    api.updateCard(id, { column, ...(column === 'dropped' ? { dropped_by: 'user' } : {}) }).catch(error)
  }

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="board">
      <div className="flex h-14 shrink-0 items-center gap-3.5 border-b border-line px-5">
        <IconButton aria-label="Back" onClick={() => navigate({ view: 'main' })}>
          <IconBack />
        </IconButton>
        <h1 className="m-0 text-[18px] font-bold">Board</h1>
        <span className="text-[13px] text-muted">
          {inFlight} in flight · <span className="font-semibold text-wait">{onYou} on you</span>
        </span>
        <span className="flex-1" />
        <Button size="sm" className="h-8" onClick={(e) => setFilterAnchor(e.currentTarget)}>
          Session: {filter ? sessionName(filter) : 'All'} ▾
        </Button>
        <Button size="sm" variant="primary" className="h-8" data-testid="new-card" onClick={() => setEditing({ column: 'backlog', title: '', note: '' })}>
          + New card
        </Button>
        <IconButton aria-label="Board options" onClick={(e) => setOptsAnchor(e.currentTarget)}>
          <IconMoreV />
        </IconButton>
      </div>
      <Popover anchor={filterAnchor} open={!!filterAnchor} onClose={() => setFilterAnchor(null)}>
        <MenuItem active={!filter} onClick={() => (setFilter(''), setFilterAnchor(null))}>
          All
        </MenuItem>
        {(sessions ?? []).map((s) => (
          <MenuItem key={s.id} active={filter === s.id} onClick={() => (setFilter(s.id), setFilterAnchor(null))}>
            {s.name}
          </MenuItem>
        ))}
      </Popover>
      <Popover anchor={optsAnchor} open={!!optsAnchor} onClose={() => setOptsAnchor(null)}>
        <MenuItem onClick={() => (setShowHidden((v) => !v), setOptsAnchor(null))}>{showHidden ? 'Hide Icebox and Dropped' : 'Show Icebox and Dropped'}</MenuItem>
      </Popover>
      <div className="grid min-h-0 flex-1 grid-cols-[repeat(6,minmax(180px,1fr))] gap-3 overflow-x-auto px-5 py-4">
        {[...COLUMNS, ...(showHidden ? ([{ id: 'icebox', title: 'Icebox' }, { id: 'dropped', title: 'Dropped' }] as const) : [])].map((col) => {
          const list = visible.filter((c) => c.column === col.id).sort((a, b) => a.position - b.position)
          return (
            <div
              key={col.id}
              data-testid={`board-col-${col.id}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drag && move(drag, col.id)}
              className="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-xl bg-surface p-2.5"
            >
              <div className="flex items-center gap-1.5 px-1 pb-1.5 pt-0.5">
                <span className={cx('text-[13px] font-[650]', 'accent' in col && col.accent ? 'text-wait' : 'text-fg')}>{col.title}</span>
                <span className="text-[12px] text-subtle">{list.length}</span>
              </div>
              {list.map((c) => {
                const onYouCard = col.id === 'look'
                return (
                  <div
                    key={c.id}
                    draggable
                    onDragStart={() => setDrag(c.id)}
                    onDragEnd={() => setDrag(null)}
                    onClick={() => setEditing(c)}
                    data-testid="board-card"
                    className={cx('flex cursor-pointer flex-col gap-1.5 rounded-[10px] border bg-raised px-3 py-2.5', onYouCard ? 'border-wait/50' : 'border-line2')}
                  >
                    <span className={cx('text-[13.5px] leading-[1.45]', onYouCard ? 'font-[650]' : 'font-medium')}>{c.title}</span>
                    {c.note && <span className="text-[12px] leading-[1.45] text-muted">{c.created_by === 'agent' && !c.note.startsWith('Claude') ? `Claude: ${c.note}` : c.note}</span>}
                    <div className="flex items-center gap-1.5 text-[11.5px] text-subtle">
                      <span className="mono truncate">{sessionName(c.session_id)}</span>
                      <span className="flex-1" />
                      {c.pr_number > 0 && (
                        <a href={c.pr_url || undefined} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={cx('no-underline', PR_COLOR[c.pr_state] ?? 'text-subtle')}>
                          ● #{c.pr_number} {c.pr_state}
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="shrink-0 px-5 pb-3.5 text-[12.5px] text-subtle">
        Icebox {icebox.length} · Dropped {dropped.length}
        {dropped.filter((c) => c.dropped_by === 'agent').length > 0 && (
          <>
            {' '}
            — {dropped.filter((c) => c.dropped_by === 'agent').length} dropped by Claude{' '}
            <button
              type="button"
              className="border-0 bg-transparent p-0 text-wait underline"
              onClick={() => dropped.filter((c) => c.dropped_by === 'agent').forEach((c) => move(c.id, 'backlog'))}
            >
              Restore
            </button>
          </>
        )}
      </div>
      {editing && <CardEditor card={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function CardEditor({ card, onClose }: { card: Partial<Card>; onClose: () => void }) {
  const { sessions, error, navigate } = useApp()
  const [c, setC] = useState<Partial<Card>>(card)
  const save = () => {
    if (!c.title?.trim()) return
    const body = { title: c.title.trim(), note: c.note ?? '', column: c.column, session_id: c.session_id ?? null, pr_url: c.pr_url ?? '', pr_state: c.pr_state ?? '', pr_number: Number(c.pr_number) || 0 }
    ;(card.id ? api.updateCard(card.id, body) : api.createCard(body)).then(onClose).catch(error)
  }
  const field = 'h-9 rounded-md border border-linestrong bg-sunken px-2.5 text-[13px] outline-none focus:border-accent'
  return (
    <Modal label={card.id ? 'Edit card' : 'New card'} onClose={onClose} className="flex w-[min(460px,100%)] flex-col gap-2.5 p-4">
      <b className="text-[15px] font-[650]">{card.id ? 'Card' : 'New card'}</b>
      <input autoFocus aria-label="Title" data-testid="card-title" placeholder="Title" value={c.title ?? ''} onChange={(e) => setC({ ...c, title: e.target.value })} className={field} />
      <textarea aria-label="Note" placeholder="Note" value={c.note ?? ''} onChange={(e) => setC({ ...c, note: e.target.value })} className="h-20 resize-none rounded-md border border-linestrong bg-sunken p-2.5 text-[13px] outline-none focus:border-accent" />
      <div className="flex gap-2">
        <select aria-label="Column" value={c.column} onChange={(e) => setC({ ...c, column: e.target.value as CardColumn })} className={cx(field, 'flex-1')}>
          {[...COLUMNS, { id: 'icebox', title: 'Icebox' }, { id: 'dropped', title: 'Dropped' }].map((col) => (
            <option key={col.id} value={col.id}>
              {col.title}
            </option>
          ))}
        </select>
        <select aria-label="Session" value={c.session_id ?? ''} onChange={(e) => setC({ ...c, session_id: e.target.value || null })} className={cx(field, 'flex-1')}>
          <option value="">No session</option>
          {(sessions ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <input aria-label="PR number" placeholder="PR #" value={c.pr_number || ''} onChange={(e) => setC({ ...c, pr_number: Number(e.target.value.replace(/\D/g, '')) })} className={cx(field, 'w-20')} />
        <select aria-label="PR state" value={c.pr_state ?? ''} onChange={(e) => setC({ ...c, pr_state: e.target.value as Card['pr_state'] })} className={cx(field, 'w-28')}>
          {['', 'draft', 'open', 'merged', 'closed'].map((s) => (
            <option key={s} value={s}>
              {s || 'no PR'}
            </option>
          ))}
        </select>
        <input aria-label="PR URL" placeholder="PR URL" value={c.pr_url ?? ''} onChange={(e) => setC({ ...c, pr_url: e.target.value })} className={cx(field, 'flex-1')} />
      </div>
      <div className="flex items-center gap-2">
        {card.id && (
          <>
            <Button variant="quiet" size="sm" onClick={() => api.deleteCard(card.id!).then(onClose).catch(error)}>
              Delete
            </Button>
            {card.thread_id && card.session_id && (
              <Button variant="quiet" size="sm" onClick={() => navigate({ view: 'main', s: card.session_id!, t: card.thread_id! })}>
                Open thread
              </Button>
            )}
          </>
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} disabled={!c.title?.trim()} data-testid="card-save">
          Save
        </Button>
      </div>
      <MenuSep />
      <span className="text-[12px] text-subtle">{card.created_by === 'agent' ? 'Claude Code made this card.' : 'Drag cards between columns to move them.'}</span>
    </Modal>
  )
}
