import { useMemo, useRef, useState } from 'react'
import { ATTENTION, SECTION_LABEL, SECTION_ORDER, api, type Section, type Session } from '../api'
import { attentionOf, useApp } from '../lib/app'
import { notificationPermission, requestNotifications } from '../lib/alerts'
import { getComposeDrafts, replyDraftThreads, useDraftsVersion } from '../lib/drafts'
import { homeRelative, hm, initials, plural, shortTime } from '../lib/format'
import { useHotkeys } from '../lib/hotkeys'
import {
  IconBoard,
  IconBolt,
  IconChevronRight,
  IconClaude,
  IconInbox,
  IconMore,
  IconMoreV,
  IconPlus,
  IconSearch,
  IconSettings,
  IconArchive,
} from './icons'
import { Button, HostTag, IconButton, MenuItem, MenuSep, Popover, StatusDot, cx, statusOf } from './ui'
import { ConnectionBanner } from './Banners'
import { PairRequestBanner } from './Devices'

export function sectionOf(s: Session): Section {
  if (s.archived_at) return 'archived'
  return s.section ?? (s.waiting > 0 ? 'waiting' : s.unread > 0 ? 'new' : 'quiet')
}

export function waitsOnPerson(s: Session): boolean {
  return ATTENTION.includes(sectionOf(s)) || attentionOf(s) > 0
}

const COLLAPSED_DEFAULT: Section[] = ['archived', 'snoozed']

function useCollapsed(): [Set<Section>, (s: Section) => void] {
  const [set, setSet] = useState<Set<Section>>(() => {
    try {
      const v = localStorage.getItem('minbox:collapsed')
      if (v) return new Set(JSON.parse(v) as Section[])
    } catch {
      /* ignore */
    }
    return new Set(COLLAPSED_DEFAULT)
  })
  const toggle = (s: Section) =>
    setSet((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      localStorage.setItem('minbox:collapsed', JSON.stringify([...next]))
      return next
    })
  return [set, toggle]
}

export function groupSessions(sessions: Session[]): { section: Section; rows: Session[] }[] {
  const by = new Map<Section, Session[]>()
  for (const s of sessions) {
    const sec = sectionOf(s)
    if (!by.has(sec)) by.set(sec, [])
    by.get(sec)!.push(s)
  }
  const time = (s: Session) => new Date(s.top_thread?.updated_at ?? s.last_activity ?? s.updated_at).getTime()
  return SECTION_ORDER.filter((sec) => by.has(sec)).map((sec) => ({ section: sec, rows: by.get(sec)!.sort((a, b) => time(b) - time(a)) }))
}

export function Sidebar({ forceRail }: { forceRail?: boolean }) {
  const { sessions, layout, setLayout, setOverlay, navigate, route } = useApp()
  const [collapsed, toggleCollapsed] = useCollapsed()
  const [optsAnchor, setOptsAnchor] = useState<HTMLElement | null>(null)
  const groups = useMemo(() => groupSessions(sessions ?? []), [sessions])

  useHotkeys({
    'mod+b': () => setLayout({ rail: !layout.rail }),
  })

  if (layout.rail || forceRail)
    return (
      <Rail
        onNew={() => setOverlay({ kind: 'new-session' })}
      />
    )

  return (
    <nav data-testid="session-list" aria-label="Sessions" className="flex h-full min-w-0 flex-col bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 pl-4 pr-2.5">
        <Logo />
        <h1 className="sr-only">minbox</h1>
        <span className="flex-1" />
        <IconButton size={34} aria-label="Search (⌘K)" title="Search (⌘K)" onClick={() => setOverlay({ kind: 'search' })}>
          <IconSearch />
        </IconButton>
        <IconButton size={34} aria-label="List options" data-testid="list-options" onClick={(e) => setOptsAnchor(e.currentTarget)}>
          <IconMoreV />
        </IconButton>
        <Button size="sm" data-testid="new-session" className="h-8 bg-raised" onClick={() => setOverlay({ kind: 'new-session' })}>
          <IconPlus size={13} />
          New
        </Button>
      </div>
      <ListOptions anchor={optsAnchor} onClose={() => setOptsAnchor(null)} />
      <ConnectionBanner />
      <NotificationAsk />
      <PairRequestBanner />
      {sessions?.length === 0 && (
        <div className="mx-2 flex flex-col gap-2 rounded-lg px-2 py-6 text-center text-[13px] text-muted">
          No sessions yet.
          <Button variant="primary" onClick={() => setOverlay({ kind: 'new-session' })}>
            New session
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {sessions === null && <SkeletonRows />}
        {groups.map((g) => (
          <div key={g.section} className="flex flex-col gap-0.5" data-section={g.section}>
            <button
              type="button"
              onClick={() => toggleCollapsed(g.section)}
              data-testid={g.section === 'archived' ? 'archived-section' : `section-${g.section}`}
              aria-expanded={!collapsed.has(g.section)}
              className="mt-2 flex h-[34px] shrink-0 items-center gap-2 rounded-md border-0 bg-raised px-3 text-left"
            >
              <span className={cx('text-[13px] font-[650]', ['quiet', 'archived', 'snoozed'].includes(g.section) ? 'text-fg2' : 'text-fg')}>
                {SECTION_LABEL[g.section]}
              </span>
              <span className="text-[12.5px] text-subtle">{g.rows.length}</span>
              <span className="flex-1" />
              {collapsed.has(g.section) && <IconChevronRight size={13} className="text-muted" />}
            </button>
            {g.rows
              .filter((s) => !collapsed.has(g.section) || s.id === route.s)
              .map((s) => <SessionRow key={s.id} s={s} selected={s.id === route.s} onSelect={() => navigate({ s: s.id, t: null, f: null, view: 'main' })} />)}
          </div>
        ))}
      </div>

      <Footer />
    </nav>
  )
}

function Logo({ size = 22 }: { size?: number }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-[6px] bg-accent text-onaccent">
      <IconInbox size={Math.round(size * 0.64)} />
    </span>
  )
}

function SkeletonRows() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 px-3 py-4">
      {['70%', '55%', '64%'].map((w, i) => (
        <div key={i} className="mb-skeleton flex flex-col gap-1.5">
          <div className="h-3 rounded bg-sel" style={{ width: w }} />
          <div className="h-2.5 w-[85%] rounded bg-raised" />
        </div>
      ))}
    </div>
  )
}

function Footer() {
  const { settings, setOverlay, navigate, route } = useApp()
  useDraftsVersion()
  const drafts = replyDraftThreads().length + getComposeDrafts().length
  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-line px-2 py-1.5">
      <button
        type="button"
        data-testid="open-settings"
        onClick={() => navigate({ view: route.view === 'settings' ? 'main' : 'settings' })}
        className="flex h-9 flex-1 items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-[13px] text-muted hover:text-fg"
      >
        <IconSettings size={15} />
        Settings
      </button>
      {settings.board && (
        <IconButton size={34} aria-label="Board" title="Board" data-testid="open-board" onClick={() => navigate({ view: route.view === 'board' ? 'main' : 'board' })}>
          <IconBoard />
        </IconButton>
      )}
      {settings.decision_mode && (
        <IconButton size={34} aria-label="Decide" title="Decision mode" data-testid="open-decide" onClick={() => setOverlay({ kind: 'decide' })}>
          <IconBolt />
        </IconButton>
      )}
      <button
        type="button"
        data-testid="drafts"
        onClick={() => setOverlay({ kind: 'drafts' })}
        className="h-9 rounded-md border-0 bg-transparent px-2 text-[12px] text-subtle hover:text-fg"
      >
        Drafts {drafts}
      </button>
    </div>
  )
}

function ListOptions({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const { settings, saveSettings } = useApp()
  const opts: [keyof typeof settings.list, string][] = [
    ['highlight_subject', 'Highlight thread subject'],
    ['compact', 'Compact rows'],
    ['hide_icons', 'Hide session icons'],
    ['small_names', 'Smaller thread names'],
  ]
  const toggle = (k: keyof typeof settings.list) => saveSettings({ list: { ...settings.list, [k]: !settings.list[k] } })
  const Row = ({ k, label }: { k: keyof typeof settings.list; label: string }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={settings.list[k]}
      onClick={() => toggle(k)}
      className="flex h-[34px] w-full items-center gap-2.5 rounded-[6px] border-0 bg-transparent px-2.5 text-left hover:bg-sel"
    >
      <span
        aria-hidden="true"
        className={cx('h-3.5 w-3.5 shrink-0 rounded-[4px] border-[1.5px] border-faint', settings.list[k] && 'border-muted bg-muted')}
      />
      {label}
    </button>
  )
  return (
    <Popover anchor={anchor} open={!!anchor} onClose={onClose} align="start" className="w-[280px]">
      {opts.map(([k, label]) => (
        <Row key={k} k={k} label={label} />
      ))}
      <MenuSep />
      <Row k="keep_panel" label="Keep thread panel open" />
    </Popover>
  )
}

function NotificationAsk() {
  const { settings } = useApp()
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('minbox:notify-asked') === '1')
  const [perm, setPerm] = useState(notificationPermission())
  if (!settings.notifications || dismissed || perm !== 'default') return null
  return (
    <div className="mx-2 mb-1 flex items-center gap-2.5 rounded-[10px] border border-line2 bg-raised px-3 py-2 text-[13px]">
      <span className="flex-1">Notify you when Claude asks something?</span>
      <Button
        variant="primary"
        size="sm"
        className="h-[30px]"
        onClick={async () => {
          setPerm(await requestNotifications())
          localStorage.setItem('minbox:notify-asked', '1')
        }}
      >
        Allow
      </Button>
      <button
        type="button"
        aria-label="Dismiss"
        className="border-0 bg-transparent text-subtle hover:text-fg"
        onClick={() => {
          localStorage.setItem('minbox:notify-asked', '1')
          setDismissed(true)
        }}
      >
        ×
      </button>
    </div>
  )
}

/** The second line's text: the top thread's subject, or how a sent reply is doing. */
export function rowSubject(s: Session): string {
  const t = s.top_thread
  if (!t) return s.status === 'ended' ? 'Session ended' : 'No messages yet'
  if (t.section === 'sent' && t.last_author === 'user') {
    if (t.last_delivery === 'delivered') return `Delivered to Claude Code, ${hm(t.updated_at)}`
    if (t.last_delivery === 'undelivered') return 'Not delivered · session stopped'
    if (t.last_delivery === 'sending') return 'Sending to Claude Code…'
    return 'Queued · Claude Code gets it when its turn ends'
  }
  return t.subject
}

function SessionRow({ s, selected, onSelect }: { s: Session; selected: boolean; onSelect: () => void }) {
  const { settings } = useApp()
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const waits = waitsOnPerson(s)
  const st = statusOf(s, waits)
  const t = s.top_thread
  const strong = (waits || s.unread > 0) && settings.list.highlight_subject
  const count = s.open_questions > 0 ? plural(s.open_questions, 'question') : ''
  const time = shortTime(t?.updated_at ?? s.last_activity ?? s.updated_at)

  if (renaming) return <RenameRow s={s} onDone={() => setRenaming(false)} />

  return (
    <div className="group relative" ref={rowRef}>
      <div
        role="button"
        tabIndex={0}
        data-testid="session-row"
        data-session-id={s.id}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSelect()
          if (e.key === 'F10' && e.shiftKey) {
            e.preventDefault()
            setMenuAnchor(rowRef.current)
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuAnchor(rowRef.current)
        }}
        className={cx(
          'flex cursor-pointer flex-col rounded-[9px] border px-3 outline-offset-[-2px]',
          settings.list.compact ? 'gap-0.5 py-1.5' : 'gap-[5px] py-[9px]',
          selected ? 'border-linestrong bg-rowsel' : 'border-transparent hover:bg-raised/60',
        )}
      >
        <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
          <StatusDot s={s} waits={waits} size={7} ring={false} />
          <span className="min-w-[3.5rem] max-w-[60%] shrink-0 truncate text-fg2" data-testid="session-name">
            {s.name}
          </span>
          <HostTag name={s.host_name} />
          <span className={cx('min-w-0 truncate whitespace-nowrap', st.text)} data-testid="session-status">
            {st.label}
          </span>
          <span className="flex-1" />
          {count && <span className="shrink-0 whitespace-nowrap text-subtle">{count}</span>}
          <span className="shrink-0 whitespace-nowrap text-subtle group-hover:invisible">{time}</span>
        </div>
        {s.title && (
          <div
            data-testid="session-title"
            title={s.title}
            className={cx('min-w-0 truncate pl-[15px] font-semibold text-fg', settings.list.small_names ? 'text-[13px]' : 'text-[14px]', s.status === 'ended' && 'text-muted')}
          >
            {s.title}
          </div>
        )}
        {!settings.list.compact && (
          <div className="flex min-w-0 items-center gap-2">
            <RowBadge s={s} />
            {!settings.list.hide_icons && t && (
              <span aria-hidden="true" className="shrink-0 text-wait">
                <IconClaude size={12} />
              </span>
            )}
            <span
              className={cx(
                'min-w-0 flex-1 truncate',
                settings.list.small_names ? 'text-[13px]' : 'text-[14px]',
                strong ? 'font-[650] text-fg' : 'font-medium text-muted',
                !t && 'mono text-[12px] font-normal text-subtle',
              )}
            >
              {t ? rowSubject(s) : homeRelative(s.cwd)}
            </span>
            {s.unread > 0 && (
              <span
                data-testid="badge-unread"
                className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[#3a3a42] px-[5px] text-[11px] font-bold text-white"
              >
                {s.unread}
              </span>
            )}
          </div>
        )}
      </div>
      <span className="absolute right-1.5 top-1.5 hidden group-focus-within:block group-hover:block">
        <IconButton
          size={26}
          aria-label="Session actions"
          data-testid="session-menu"
          onClick={(e) => {
            e.stopPropagation()
            setMenuAnchor(rowRef.current)
          }}
          className="bg-raised"
        >
          <IconMore />
        </IconButton>
      </span>
      <SessionMenu s={s} anchor={menuAnchor} onClose={() => setMenuAnchor(null)} onRename={() => setRenaming(true)} />
    </div>
  )
}

function RowBadge({ s }: { s: Session }) {
  const t = s.top_thread
  if (t?.stopped || (s.stopped ?? 0) > 0)
    return (
      <span data-testid="badge-stopped" className="flex h-[22px] shrink-0 items-center rounded-[6px] border border-danger px-[7px] text-[12px] font-semibold text-danger">
        Stopped
      </span>
    )
  if ((t?.holds_up ?? 0) > 0)
    return (
      <span data-testid="badge-holds" className="flex h-[22px] shrink-0 items-center rounded-[6px] border border-wait px-[7px] text-[12px] font-semibold text-wait">
        Holds up {t!.holds_up}
      </span>
    )
  if (s.open_questions > 0)
    return (
      <span data-testid="badge-questions" className="flex h-[22px] shrink-0 items-center rounded-[6px] border border-wait px-[7px] text-[12px] font-semibold text-wait">
        ?{s.open_questions}
      </span>
    )
  return null
}

export function SessionMenu({
  s,
  anchor,
  onClose,
  onRename,
}: {
  s: Session
  anchor: HTMLElement | null
  onClose: () => void
  onRename: () => void
}) {
  const { error, toast, setOverlay, reloadSessions } = useApp()
  const act = (fn: () => Promise<unknown>) => () => {
    onClose()
    fn().then(reloadSessions).catch(error)
  }
  return (
    <Popover anchor={anchor} open={!!anchor} onClose={onClose}>
      <MenuItem
        testid="menu-rename"
        onClick={() => {
          onClose()
          onRename()
        }}
      >
        Rename
      </MenuItem>
      {s.status === 'ended' ? (
        <MenuItem testid="menu-restart" onClick={act(() => api.restartSession(s.id))}>
          Resume
        </MenuItem>
      ) : (
        <MenuItem testid="menu-stop" onClick={act(() => api.stopSession(s.id))}>
          Stop
        </MenuItem>
      )}
      {s.archived_at ? (
        <MenuItem testid="menu-unarchive" onClick={act(() => api.unarchiveSession(s.id))}>
          Unarchive
        </MenuItem>
      ) : (
        <MenuItem
          testid="menu-archive"
          disabled={s.status !== 'ended'}
          hint={s.status !== 'ended' ? 'stop first' : undefined}
          onClick={act(async () => {
            await api.archiveSession(s.id)
            toast(`Archived ${s.name} (session)`, { action: 'Undo', undo: true, onAction: () => api.unarchiveSession(s.id).then(reloadSessions).catch(error) })
          })}
        >
          Archive
        </MenuItem>
      )}
      <MenuSep />
      <MenuItem
        testid="menu-delete"
        danger
        onClick={() => {
          onClose()
          setOverlay({ kind: 'delete-session', session: s })
        }}
      >
        Delete…
      </MenuItem>
    </Popover>
  )
}

function RenameRow({ s, onDone }: { s: Session; onDone: () => void }) {
  const { error, reloadSessions } = useApp()
  const [name, setName] = useState(s.name)
  const save = () => {
    const v = name.trim()
    if (v && v !== s.name) api.renameSession(s.id, v).then(reloadSessions).catch(error)
    onDone()
  }
  return (
    <div className="rounded-lg bg-sel px-2.5 py-2">
      <div className="flex items-center gap-2">
        <StatusDot s={s} waits={false} ring={false} />
        <input
          aria-label="Session name"
          data-testid="rename-input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              e.stopPropagation()
              onDone()
            }
          }}
          onBlur={save}
          className="h-7 flex-1 rounded-sm border border-accent bg-sunken px-2 text-[13.5px] text-fg outline-none"
        />
      </div>
      <div className="px-1 pt-1.5 text-[11.5px] text-subtle">↵ save · Esc cancel</div>
    </div>
  )
}

/** The collapsed session rail (⌘B): initials, amber when a session waits on the person. */
function Rail({ onNew }: { onNew: () => void }) {
  const { sessions, route, navigate, setLayout, setOverlay } = useApp()
  const live = groupSessions(sessions ?? []).filter((g) => g.section !== 'archived')
  return (
    <nav aria-label="Sessions" data-testid="session-rail" className="flex h-full w-[60px] flex-col items-center gap-1.5 bg-surface pt-2.5">
      <button type="button" aria-label="Expand sidebar (⌘B)" title="Expand sidebar (⌘B)" onClick={() => setLayout({ rail: false })} className="mb-0.5 border-0 bg-transparent p-0">
        <Logo size={26} />
      </button>
      {/* Full width + top padding: overflow-y-auto clips both axes, and the corner badge,
          its outline and the working ring sit up to 6px outside each tile. */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto pt-1.5">
        {live.flatMap((g) =>
          g.rows.map((s) => {
            const sel = s.id === route.s
            const waits = waitsOnPerson(s)
            const stopped = !!s.top_thread?.stopped || (s.stopped ?? 0) > 0
            // Status shows without reading the title: border colour / weight / style, a
            // pulsing ring while working, and a corner dot (red + "!" when stopped).
            const border = stopped
              ? 'border-2 border-danger'
              : s.status === 'ended'
                ? 'border border-dashed border-faint'
                : s.status === 'starting'
                  ? 'border-2 border-dashed border-muted'
                  : s.status === 'working'
                    ? 'border-2 border-work'
                    : waits
                      ? 'border-2 border-wait'
                      : 'border border-line2'
            return (
              <button
                key={s.id}
                type="button"
                title={`${s.name}${s.title ? ` — ${s.title}` : ''} · ${stopped ? 'Stopped' : statusOf(s, waits).label}`}
                data-testid="rail-session"
                data-status={stopped ? 'stopped' : s.status === 'idle' && waits ? 'waiting' : s.status}
                onClick={() => navigate({ s: s.id, view: 'main' })}
                className={cx(
                  'relative box-border flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-[13px]',
                  border,
                  sel ? 'bg-sel font-[650]' : waits ? 'bg-wait/10 font-[650]' : 'bg-raised',
                  s.status === 'ended' ? 'text-subtle' : waits || sel ? 'text-waitfg' : 'text-fg2',
                  s.status === 'working' && 'shadow-[0_0_0_3px_color-mix(in_srgb,var(--mb-work)_18%,transparent)]',
                )}
              >
                {initials(s.name)}
                {s.status === 'working' && <span aria-hidden="true" className="mb-pulse pointer-events-none absolute -inset-[3px] rounded-[12px] border-2 border-work" />}
                {stopped ? (
                  <span aria-hidden="true" className="absolute -right-1 -top-1 flex h-[14px] w-[14px] items-center justify-center rounded-full bg-danger text-[10px] font-bold leading-none text-onaccent outline outline-2 outline-surface">
                    !
                  </span>
                ) : (
                  (waits || s.status === 'working' || s.status === 'starting') && (
                    <span className="absolute -right-1 -top-1 rounded-full outline outline-2 outline-surface">
                      <StatusDot s={s} waits={waits} size={10} />
                    </span>
                  )
                )}
              </button>
            )
          }),
        )}
      </div>
      <IconButton size={40} aria-label="Search" onClick={() => setOverlay({ kind: 'search' })}>
        <IconSearch />
      </IconButton>
      <IconButton size={40} aria-label="New session" onClick={onNew}>
        <IconPlus />
      </IconButton>
      <IconButton size={40} aria-label="Settings" className="mb-2" onClick={() => navigate({ view: 'settings' })}>
        <IconSettings />
      </IconButton>
    </nav>
  )
}

export { Logo, IconArchive }
