import { useState } from 'react'
import { ATTENTION, SECTION_ORDER, api, type Section, type Session } from '../api'
import { attentionOf, useApp } from '../lib/app'
import { notificationPermission, requestNotifications } from '../lib/alerts'
import { initials } from '../lib/format'
import { IconInbox, IconPlus, IconSearch, IconSettings } from './icons'
import { Button, IconButton, MenuItem, MenuSep, Popover, StatusDot, cx, statusOf } from './ui'

export function sectionOf(s: Session): Section {
  if (s.archived_at) return 'archived'
  return s.section ?? (s.waiting > 0 ? 'waiting' : s.unread > 0 ? 'new' : 'quiet')
}

export function waitsOnPerson(s: Session): boolean {
  return ATTENTION.includes(sectionOf(s)) || attentionOf(s) > 0
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

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-[6px] bg-accent text-onaccent">
      <IconInbox size={Math.round(size * 0.64)} />
    </span>
  )
}

export function NotificationAsk() {
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

export function RenameRow({ s, onDone }: { s: Session; onDone: () => void }) {
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
export function Rail() {
  const { sessions, route, navigate, setLayout, setOverlay } = useApp()
  const onNew = () => setOverlay({ kind: 'new-session' })
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
                onClick={() => navigate({ s: s.id, t: s.top_thread?.id ?? null, f: null, view: 'main' })}
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
      <IconButton size={40} aria-label="Search" onClick={() => setOverlay({ kind: 'palette' })}>
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

