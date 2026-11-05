import { useState } from 'react'
import { ATTENTION, SECTION_ORDER, api, type Section, type Session } from '../api'
import { attentionOf, useApp } from '../lib/app'
import { notificationPermission, requestNotifications } from '../lib/alerts'
import { IconInbox } from './icons'
import { Button, MenuItem, MenuSep, Popover, StatusDot } from './ui'

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
  const { error, toast, setOverlay, reloadSessions, reloadProjects } = useApp()
  const act = (fn: () => Promise<unknown>) => () => {
    onClose()
    fn()
      .then(() => (reloadSessions(), reloadProjects()))
      .catch(error)
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
      {s.kind !== 'shell' && s.project_id && (
        <MenuItem
          testid="menu-set-main"
          disabled={!!s.is_main}
          hint={s.is_main ? 'is main' : undefined}
          onClick={act(async () => {
            await api.setMainSession(s.project_id!, s.id)
            toast(`${s.name} is now the project's main session`)
          })}
        >
          Set as main session
        </MenuItem>
      )}
      {s.status === 'ended' ? (
        <MenuItem testid="menu-restart" onClick={act(() => api.restartSession(s.id))}>
          Resume
        </MenuItem>
      ) : (
        <>
          {s.kind !== 'shell' && (
            <MenuItem
              testid="menu-restart"
              onClick={() => {
                if (!window.confirm(`Restart ${s.name}? A running turn is interrupted; the conversation is resumed.`)) return
                act(() => api.restartSession(s.id))()
              }}
            >
              Restart
            </MenuItem>
          )}
          <MenuItem testid="menu-stop" onClick={act(() => api.stopSession(s.id))}>
            Stop
          </MenuItem>
        </>
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

