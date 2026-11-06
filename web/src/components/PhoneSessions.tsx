import { useMemo, useRef, useState } from 'react'
import { ATTENTION, SECTION_LABEL, api, type Session } from '../api'
import { useApp } from '../lib/app'
import { homeRelative } from '../lib/format'
import { setThreadFilter, useThreadFilter } from '../lib/threadFilter'
import { useSelectedProject } from '../lib/projects'
import { IconArchive, IconChevronRight, IconClose, IconMore, IconPlus, IconTerminal } from './icons'
import { SessionMenu, groupSessions } from './Sidebar'
import { EndedTag, HostTag, cx } from './ui'

/**
 * Phone: the session picker. It is a sheet over the thread list: choosing a session filters the
 * list to it; the terminal button opens its terminal; the menu renames, stops, archives.
 */
export function PhoneSessionSheet({ onClose }: { onClose: () => void }) {
  const { sessions, navigate, setOverlay } = useApp()
  const filter = useThreadFilter()
  const [showArchived, setShowArchived] = useState(false)
  const { id: projectId } = useSelectedProject()
  const groups = useMemo(() => groupSessions((sessions ?? []).filter((s) => !projectId || s.project_id === projectId)), [sessions, projectId])
  const need = groups.filter((g) => ATTENTION.includes(g.section))
  const others = groups.filter((g) => !ATTENTION.includes(g.section) && g.section !== 'archived')
  const archived = groups.find((g) => g.section === 'archived')?.rows ?? []
  const pick = (s: Session | null) => {
    setThreadFilter({ session: s?.id ?? '' })
    onClose()
  }
  const terminal = (s: Session) => {
    onClose()
    navigate({ s: s.id, t: null, f: null, tab: 'terminal' }, { push: true })
  }
  const row = (s: Session, strong?: boolean) => <PhoneSessionRow key={s.id} s={s} strong={strong} active={filter.session === s.id} onOpen={() => pick(s)} onTerminal={() => terminal(s)} />
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface pt-[env(safe-area-inset-top)]" data-testid="session-sheet">
      <header className="flex h-14 shrink-0 items-center gap-1 pl-4 pr-2">
        <h2 className="m-0 flex-1 text-[17px] font-[650]">Sessions</h2>
        <button
          type="button"
          aria-label="New session"
          data-testid="sheet-new-session"
          onClick={() => (onClose(), setOverlay({ kind: 'new-session' }))}
          className="flex h-11 w-11 items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2"
        >
          <IconPlus size={20} />
        </button>
        <button type="button" aria-label="Close" data-testid="sheet-close" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2">
          <IconClose size={20} />
        </button>
      </header>
      <div data-testid="session-list" className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <button
          type="button"
          data-testid="session-all"
          onClick={() => pick(null)}
          className={cx('mx-3 mb-1 mt-1 flex min-h-12 items-center rounded-lg border-0 px-3 text-left text-[14px] font-[650] text-fg', !filter.session ? 'bg-sel' : 'bg-raised')}
        >
          All sessions
        </button>
        {need.length > 0 && (
          <>
            <div className="px-4 pb-1.5 pt-2.5 text-[12px] font-bold uppercase tracking-[0.06em] text-wait">{need.map((g) => SECTION_LABEL[g.section]).join(' · ')}</div>
            {need.flatMap((g) => g.rows).map((s) => row(s, true))}
          </>
        )}
        {others.length > 0 && (
          <>
            <div className="px-4 pb-1.5 pt-4 text-[12px] font-bold uppercase tracking-[0.06em] text-subtle">{others.map((g) => SECTION_LABEL[g.section]).join(' · ')}</div>
            {others.flatMap((g) => g.rows).map((s) => row(s))}
          </>
        )}
        {archived.length > 0 && (
          <>
            <button
              type="button"
              data-testid="archived-section"
              aria-expanded={showArchived}
              onClick={() => setShowArchived((v) => !v)}
              className="mx-2.5 mt-3.5 flex h-12 shrink-0 items-center gap-2.5 rounded-[10px] border-0 bg-raised px-3.5 text-left text-[14px] text-muted"
            >
              <IconArchive size={16} />
              <span className="flex-1">Archived</span>
              <span className="text-subtle">{archived.length}</span>
              <IconChevronRight size={14} className={cx('transition-transform', showArchived && 'rotate-90')} />
            </button>
            {showArchived && archived.map((s) => row(s))}
          </>
        )}
      </div>
    </div>
  )
}

function PhoneSessionRow({ s, strong, active, onOpen, onTerminal }: { s: Session; strong?: boolean; active: boolean; onOpen: () => void; onTerminal: () => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const { error, reloadSessions } = useApp()
  const [name, setName] = useState(s.name)
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={ref}
      data-testid="session-row"
      data-session-id={s.id}
      className={cx('mx-2.5 flex items-center', strong ? 'mb-1.5 min-h-[68px] rounded-xl border border-wait/28 bg-wait/8' : 'min-h-16 border-b border-[#1f1f24] [[data-theme=light]_&]:border-line', active && 'bg-sel')}
    >
      {renaming ? (
        <input
          autoFocus
          aria-label="Session name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            setRenaming(false)
            if (name.trim() && name.trim() !== s.name) api.renameSession(s.id, name.trim()).then(reloadSessions).catch(error)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="mx-3 h-11 flex-1 rounded-md border border-accent bg-sunken px-3 outline-none"
        />
      ) : (
        <button type="button" onClick={onOpen} className={cx('flex min-w-0 flex-1 flex-col gap-1 border-0 bg-transparent pl-3.5 pr-1 text-left', strong ? 'py-3' : 'py-2.5')}>
          <div className="flex items-center gap-2">
            <span data-testid="session-name" className={cx('min-w-0 flex-1 truncate', strong ? 'text-[16px] font-[650]' : 'text-[15.5px] font-medium', s.status === 'ended' && 'text-muted')}>
              {s.name}
            </span>
            <HostTag name={s.host_name} phone />
            {s.open_questions > 0 && (
              <span data-testid="badge-questions" className="flex h-[22px] items-center rounded-full bg-accent px-2 text-[12.5px] font-extrabold text-onaccent">
                ?{s.open_questions}
              </span>
            )}
            {s.unread > 0 && (
              <span data-testid="badge-unread" className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-[#3a3a42] px-1.5 text-[12.5px] font-bold text-white">
                {s.unread}
              </span>
            )}
          </div>
          {s.title && (
            <span data-testid="session-title" className={cx('truncate text-[14.5px] font-semibold', s.status === 'ended' ? 'text-muted' : 'text-fg')}>
              {s.title}
            </span>
          )}
          <div className="flex gap-2 text-[13px]">
            {s.status === 'ended' && <EndedTag className="text-[13px]" />}
            <span className="mono truncate text-[12px] text-subtle">{homeRelative(s.cwd)}</span>
          </div>
        </button>
      )}
      <button
        type="button"
        aria-label="Open terminal"
        data-testid="session-terminal"
        onClick={onTerminal}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent text-muted"
      >
        <IconTerminal size={18} />
      </button>
      <button
        type="button"
        aria-label="Session menu"
        data-testid="session-menu"
        onClick={() => setAnchor(ref.current)}
        className="mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent text-muted"
      >
        <IconMore size={18} />
      </button>
      <SessionMenu s={s} anchor={anchor} onClose={() => setAnchor(null)} onRename={() => setRenaming(true)} />
    </div>
  )
}
