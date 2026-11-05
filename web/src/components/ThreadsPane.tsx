import { useEffect, useMemo, useRef, useState } from 'react'
import { ATTENTION, THREAD_STATUS_LABEL, THREAD_STATUS_ORDER, api, type Project, type Session, type Thread } from '../api'
import { useApp } from '../lib/app'
import { useSelectedProject } from '../lib/projects'
import { getComposeDrafts, replyDraftThreads, useDraftsVersion } from '../lib/drafts'
import { useHotkeys } from '../lib/hotkeys'
import { setComposeTarget, setThreadFilter, useComposeTargetPick, useThreadFilter, type ThreadFilter } from '../lib/threadFilter'
import { ComposeFileTiles, clearFiles, fileInputHandlers, uploadIds, useComposeFiles } from '../lib/uploads'
import { IconBoard, IconBolt, IconChevronRight, IconExpand, IconInbox, IconMoreV, IconPaperclip, IconPlus, IconSearch, IconSettings } from './icons'
import { CompletingTextarea } from './Compose'
import { ConnectionBanner } from './Banners'
import { PairRequestBanner } from './Devices'
import { NewSessionDialog } from './NewSession'
import { NextStep } from './NextStep'
import { NotificationAsk, Logo, groupSessions, waitsOnPerson } from './Sidebar'
import { ThreadRow, useAllThreads } from './ThreadList'
import { Button, HostTag, IconButton, MenuItem, MenuSep, Popover, Skeleton, StatusDot, cx, statusOf } from './ui'
import { PhoneSessionSheet } from './PhoneSessions'
import { PhoneProjectButton } from './PhoneProjects'

/** Threads that sit outside the main list: snoozed and archived ones fold away. */
const folded = (t: Thread) => t.section === 'archived' || t.section === 'snoozed'

/** The threads the filter lets through, in the order they are listed (the open thread's J/K order too). */
export function useVisibleThreads(): { all: Thread[] | null; groups: { key: string; label: string; session?: Session; items: Thread[] }[]; fold: Thread[]; counts: { all: number; waiting: number; unread: number }; filter: ThreadFilter } {
  const all = useAllThreads()
  const { sessions } = useApp()
  const filter = useThreadFilter()
  const { id: projectId } = useSelectedProject()
  return useMemo(() => {
    const scoped = (all ?? []).filter((t) => (!projectId || t.project_id === projectId) && (!filter.session || t.session_id === filter.session))
    const live = scoped.filter((t) => !folded(t))
    const counts = { all: live.length, waiting: live.filter((t) => ATTENTION.includes(t.section)).length, unread: live.filter((t) => t.unread > 0).length }
    const shown = live.filter((t) => (filter.show === 'waiting' ? ATTENTION.includes(t.section) : filter.show === 'unread' ? t.unread > 0 : true))
    const byActivity = (a: Thread, b: Thread) => {
      if (!!a.pinned_at !== !!b.pinned_at) return a.pinned_at ? -1 : 1
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    }
    let groups: { key: string; label: string; session?: Session; items: Thread[] }[]
    if (filter.group === 'status') {
      groups = THREAD_STATUS_ORDER.map((st) => ({ key: st, label: THREAD_STATUS_LABEL[st], items: shown.filter((t) => t.status === st).sort(byActivity) })).filter((g) => g.items.length > 0)
    } else if (filter.group === 'session') {
      const by = new Map<string, Thread[]>()
      for (const t of [...shown].sort(byActivity)) by.set(t.session_id, [...(by.get(t.session_id) ?? []), t])
      groups = [...by.entries()].map(([id, items]) => {
        const s = sessions?.find((x) => x.id === id)
        return { key: id, label: s?.name ?? '—', session: s, items }
      })
    } else {
      groups = shown.length ? [{ key: 'flat', label: '', items: [...shown].sort(byActivity) }] : []
    }
    return { all, groups, fold: scoped.filter(folded).sort(byActivity), counts, filter }
  }, [all, sessions, filter, projectId])
}

/** The pane: top bar, filters, every thread of every session, and the composer. */
export function ThreadsPane({ phone }: { phone?: boolean }) {
  const { route, navigate, settings } = useApp()
  const v = useVisibleThreads()
  const { filter } = v
  const flat = useMemo(() => v.groups.flatMap((g) => g.items), [v.groups])
  const [cursor, setCursor] = useState(0)
  const [full, setFull] = useState(false)
  const [foldOpen, setFoldOpen] = useState(false)
  const [sheet, setSheet] = useState(false)
  const { id: projectId } = useSelectedProject()

  const open = (t: Thread) => navigate({ s: t.session_id, t: t.id, f: null, view: 'main', tab: 'inbox' })

  // The list's own keys work while no thread is open; an open thread takes J/K for itself.
  useHotkeys(
    {
      j: () => setCursor((c) => Math.min(c + 1, flat.length - 1)),
      k: () => setCursor((c) => Math.max(c - 1, 0)),
      arrowdown: () => setCursor((c) => Math.min(c + 1, flat.length - 1)),
      arrowup: () => setCursor((c) => Math.max(c - 1, 0)),
      enter: () => {
        const t = flat[cursor]
        if (t) open(t)
        else return false
      },
      n: () => {
        const t = flat.find((x) => x.unread > 0) ?? flat[0]
        if (t) open(t)
      },
    },
    !phone && !route.t,
  )

  // Keep thread panel open: show the top thread when the page opens.
  const kept = useRef(false)
  useEffect(() => {
    if (kept.current || !v.all) return
    kept.current = true
    if (settings.list.keep_panel && !phone && !route.t && flat[0]) open(flat[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.all])

  const allCount = v.counts.all
  return (
    <div data-testid="threads-pane" aria-label="Threads" className="flex h-full min-w-0 flex-col bg-surface">
      <TopBar phone={phone} />
      <ConnectionBanner />
      <NotificationAsk />
      <PairRequestBanner />
      <FilterRow v={v} phone={phone} onSheet={() => setSheet(true)} />
      <div className={cx('min-h-0 flex-1 overflow-y-auto px-2 pb-3', full && 'hidden')} data-testid="thread-list">
        {v.all === null ? (
          <Skeleton />
        ) : v.all.length === 0 ? (
          <EmptyThreads />
        ) : flat.length === 0 && v.fold.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center" data-testid="list-empty">
            <IconInbox size={32} className="text-faint" strokeWidth={1.2} />
            <span className="text-[14px] font-semibold">{filter.show === 'waiting' ? 'Nothing is waiting on you.' : filter.show === 'unread' ? 'Nothing unread.' : 'No threads here yet.'}</span>
            {(filter.show !== 'all' || filter.session || projectId) && (
              <Button size="sm" onClick={() => setThreadFilter({ show: 'all', session: '', project: '' })}>
                Show all threads
              </Button>
            )}
          </div>
        ) : (
          <>
            {v.groups.map((g) => (
              <div key={g.key}>
                {g.label && (
                  <div
                    data-testid="group-header"
                    className={cx(
                      'mt-3 flex h-7 items-center gap-2 px-2 text-[11px] font-bold uppercase tracking-[0.06em]',
                      g.key === 'need_action' ? 'text-wait' : 'text-subtle',
                    )}
                  >
                    {g.session && <StatusDot s={g.session} waits={waitsOnPerson(g.session)} size={6} ring={false} />}
                    <span className="truncate">{g.label}</span>
                    <span className="font-normal">{g.items.length}</span>
                  </div>
                )}
                {g.items.map((t) => (
                  <ThreadRow
                    key={t.id}
                    t={t}
                    phone={phone}
                    focused={route.t ? route.t === t.id : flat[cursor]?.id === t.id}
                    onOpen={() => open(t)}
                  />
                ))}
              </div>
            ))}
            {v.fold.length > 0 && (
              <>
                <button
                  type="button"
                  data-testid="fold-toggle"
                  aria-expanded={foldOpen}
                  onClick={() => setFoldOpen((o) => !o)}
                  className="mt-3 flex h-7 w-full items-center gap-2 border-0 bg-transparent px-2 text-left text-[11px] font-bold uppercase tracking-[0.06em] text-subtle"
                >
                  Snoozed / Archived <span className="font-normal">{v.fold.length}</span>
                  <IconChevronRight size={12} className={cx('transition-transform', foldOpen && 'rotate-90')} />
                </button>
                {foldOpen &&
                  v.fold.map((t) => (
                    <ThreadRow key={t.id} t={t} phone={phone} focused={route.t === t.id} onOpen={() => open(t)} />
                  ))}
              </>
            )}
            <span className="sr-only" data-testid="thread-count">{allCount}</span>
          </>
        )}
      </div>
      <QuickCompose phone={phone} full={full} onToggleFull={() => setFull((f) => !f)} onSent={(t) => (setFull(false), open(t))} />
      {sheet && <PhoneSessionSheet onClose={() => setSheet(false)} />}
    </div>
  )
}

// ---- top bar ----

function TopBar({ phone }: { phone?: boolean }) {
  const { setOverlay } = useApp()
  const { id: projectId } = useSelectedProject()
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const size = phone ? 44 : 34
  return (
    <div className={cx('flex shrink-0 items-center gap-1', phone ? 'h-14 pl-4 pr-2' : 'h-12 pl-3 pr-2.5')}>
      <Logo size={phone ? 24 : undefined} />
      {phone ? (
        <>
          <h1 className="sr-only">minbox</h1>
          <PhoneProjectButton />
        </>
      ) : (
        <h1 className="ml-1.5 flex-1 text-[15px] font-[650]">Threads</h1>
      )}
      <IconButton size={size} aria-label="Search (⌘K)" title="Search (⌘K)" data-testid="open-palette" onClick={() => setOverlay({ kind: 'palette' })}>
        <IconSearch size={phone ? 20 : 16} />
      </IconButton>
      {phone ? (
        <IconButton size={size} aria-label="New session" data-testid="new-session" onClick={() => setOverlay({ kind: 'new-session', projectId })}>
          <IconPlus size={20} />
        </IconButton>
      ) : (
        <Button size="sm" data-testid="new-session" className="h-8 bg-raised" onClick={() => setOverlay({ kind: 'new-session', projectId })}>
          <IconPlus size={13} />
          New
        </Button>
      )}
      <IconButton size={size} aria-label="Menu" data-testid="list-options" onClick={(e) => setMenu(e.currentTarget)}>
        <IconMoreV size={phone ? 20 : 16} />
      </IconButton>
      <HeaderMenu anchor={menu} onClose={() => setMenu(null)} />
    </div>
  )
}

function HeaderMenu({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const { settings, saveSettings, setOverlay, navigate, route } = useApp()
  useDraftsVersion()
  const drafts = replyDraftThreads().length + getComposeDrafts().length
  const go = (fn: () => void) => () => {
    onClose()
    fn()
  }
  const opts: [keyof typeof settings.list, string][] = [
    ['highlight_subject', 'Highlight thread subject'],
    ['compact', 'Compact rows'],
    ['keep_panel', 'Open the top thread at start'],
  ]
  return (
    <Popover anchor={anchor} open={!!anchor} onClose={onClose} className="w-[260px]">
      <MenuItem testid="open-settings" onClick={go(() => navigate({ view: route.view === 'settings' ? 'main' : 'settings' }))}>
        <IconSettings size={15} /> Settings
      </MenuItem>
      {settings.board && (
        <MenuItem testid="open-board" onClick={go(() => navigate({ view: 'board' }))}>
          <IconBoard size={15} /> Board
        </MenuItem>
      )}
      {settings.decision_mode && (
        <MenuItem testid="open-decide" onClick={go(() => setOverlay({ kind: 'decide' }))}>
          <IconBolt size={15} /> Decide
        </MenuItem>
      )}
      <MenuItem testid="drafts" hint={drafts} onClick={go(() => setOverlay({ kind: 'drafts' }))}>
        Drafts
      </MenuItem>
      <MenuSep />
      {opts.map(([k, label]) => (
        <button
          key={k}
          type="button"
          role="menuitemcheckbox"
          aria-checked={settings.list[k]}
          onClick={() => saveSettings({ list: { ...settings.list, [k]: !settings.list[k] } })}
          className="flex h-8 w-full items-center gap-2.5 rounded-[6px] border-0 bg-transparent px-2.5 text-left hover:bg-sel"
        >
          <span aria-hidden="true" className={cx('h-3.5 w-3.5 shrink-0 rounded-[4px] border-[1.5px] border-faint', settings.list[k] && 'border-muted bg-muted')} />
          {label}
        </button>
      ))}
    </Popover>
  )
}

// ---- filters ----

function FilterRow({ v, phone, onSheet }: { v: ReturnType<typeof useVisibleThreads>; phone?: boolean; onSheet: () => void }) {
  const { sessions, navigate } = useApp()
  const { filter, counts } = v
  const [sAnchor, setSAnchor] = useState<HTMLElement | null>(null)
  const [gAnchor, setGAnchor] = useState<HTMLElement | null>(null)
  const sel = sessions?.find((s) => s.id === filter.session)
  const chip = (id: ThreadFilter['show'], label: string, n: number) => (
    <button
      key={id}
      type="button"
      data-testid={`filter-${id}`}
      aria-pressed={filter.show === id}
      onClick={() => setThreadFilter({ show: id })}
      className={cx(
        'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px]',
        phone ? 'h-9' : 'h-7',
        filter.show === id ? 'border-accent bg-wait/10 font-semibold text-waitfg' : 'border-linestrong bg-transparent text-fg2',
      )}
    >
      {label}
      <span className={cx('text-[11.5px]', id === 'waiting' && n > 0 ? 'font-bold text-wait' : 'text-subtle')} data-testid={`filter-${id}-count`}>
        {n}
      </span>
    </button>
  )
  return (
    <div className="shrink-0 border-b border-line pb-2">
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
        {chip('all', 'All', counts.all)}
        {chip('waiting', 'Waiting', counts.waiting)}
        {chip('unread', 'Unread', counts.unread)}
      </div>
      <div className="flex items-center gap-1.5 px-3">
        <button
          type="button"
          data-testid="session-filter"
          onClick={(e) => (phone ? onSheet() : setSAnchor(e.currentTarget))}
          className={cx('flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-transparent px-2.5 text-left text-[12.5px]', phone ? 'h-9' : 'h-7', sel ? 'border-accent text-waitfg' : 'border-linestrong text-fg2')}
        >
          {sel && <StatusDot s={sel} waits={waitsOnPerson(sel)} size={6} ring={false} />}
          <span className="truncate">Session: {sel ? sel.name : 'All'}</span>
          <span className="flex-1" />
          <span aria-hidden="true" className="text-subtle">▾</span>
        </button>
        <button
          type="button"
          data-testid="group-by"
          onClick={(e) => setGAnchor(e.currentTarget)}
          className={cx('flex shrink-0 items-center gap-1.5 rounded-md border border-linestrong bg-transparent px-2.5 text-[12.5px] text-fg2', phone ? 'h-9' : 'h-7')}
        >
          {filter.group === 'activity' ? 'Activity' : filter.group === 'status' ? 'Status' : 'Session'} <span aria-hidden="true" className="text-subtle">▾</span>
        </button>
      </div>
      <Popover anchor={sAnchor} open={!!sAnchor} onClose={() => setSAnchor(null)} align="start" className="w-[300px]">
        <SessionPicker
          filter
          activeId={filter.session}
          onPick={(s) => {
            setSAnchor(null)
            setThreadFilter({ session: s?.id ?? '' })
            // Choosing a session also selects it: the terminal follows.
            if (s) navigate({ s: s.id, t: null, f: null, view: 'main' })
          }}
        />
      </Popover>
      <Popover anchor={gAnchor} open={!!gAnchor} onClose={() => setGAnchor(null)} align="end" className="w-[200px]">
        {(
          [
            ['activity', 'Recent activity'],
            ['status', 'Status'],
            ['session', 'Session'],
          ] as const
        ).map(([g, label]) => (
          <MenuItem key={g} testid={`group-${g}`} active={filter.group === g} onClick={() => (setGAnchor(null), setThreadFilter({ group: g }))}>
            {label}
          </MenuItem>
        ))}
      </Popover>
    </div>
  )
}

/** A searchable list of sessions with status dots; `filter` adds "All sessions", otherwise "+ New session…". */
export function SessionPicker({ filter, activeId, onPick, onNew }: { filter?: boolean; activeId: string; onPick: (s: Session | null) => void; onNew?: () => void }) {
  const { sessions, projects, reloadProjects, reloadSessions, toast, error } = useApp()
  const { id: projectId } = useSelectedProject()
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const rows = groupSessions((sessions ?? []).filter((s) => !s.archived_at && (!projectId || s.project_id === projectId) && (filter || s.kind !== 'shell'))).flatMap((g) => g.rows)
    const w = q.trim().toLowerCase()
    return w ? rows.filter((s) => `${s.name} ${s.title ?? ''} ${s.cwd}`.toLowerCase().includes(w)) : rows
  }, [sessions, q, filter, projectId])
  // In All projects the sessions sit under their project's name.
  const groups = useMemo(() => {
    if (projectId) return [{ project: undefined as Project | undefined, rows: list }]
    const out: { project: Project | undefined; rows: Session[] }[] = []
    for (const p of projects ?? []) {
      const rows = list.filter((s) => s.project_id === p.id)
      if (rows.length) out.push({ project: p, rows })
    }
    const rest = list.filter((s) => !projects?.some((p) => p.id === s.project_id))
    if (rest.length) out.push({ project: undefined, rows: rest })
    return out
  }, [list, projects, projectId])
  return (
    <div data-testid="session-picker">
      <input
        autoFocus
        aria-label="Find a session"
        data-testid="session-picker-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && list[0]) onPick(list[0])
        }}
        placeholder="Find a session"
        className="mb-1 h-8 w-full rounded-md border border-line2 bg-sunken px-2.5 text-[13px] text-fg outline-none focus:border-accent"
      />
      <div className="max-h-[320px] overflow-y-auto">
        {filter && (
          <MenuItem testid="session-all" active={!activeId} onClick={() => onPick(null)}>
            All sessions
          </MenuItem>
        )}
        {groups.map((g, gi) => (
          <div key={g.project?.id ?? `none${gi}`}>
            {g.project && (
              <div data-testid="session-picker-group" className="px-2.5 pb-0.5 pt-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-subtle">
                {g.project.name}
              </div>
            )}
            {g.rows.map((s) => {
          const waits = waitsOnPerson(s)
          return (
            <div key={s.id} className="group flex items-center gap-0.5">
            <button
              type="button"
              role="menuitem"
              data-testid="session-option"
              data-session-id={s.id}
              data-main={s.is_main || undefined}
              onClick={() => onPick(s)}
              className={cx('flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-[6px] border-0 px-2.5 py-1 text-left hover:bg-sel', s.id === activeId ? 'bg-sel' : 'bg-transparent')}
            >
              <StatusDot s={s} waits={waits} size={7} ring={false} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px] text-fg">{s.name}</span>
                  {s.is_main && (
                    <span data-testid="session-main-badge" className="shrink-0 rounded-[5px] border border-linestrong px-1 text-[10px] font-semibold uppercase leading-[15px] tracking-[0.04em] text-muted">
                      main
                    </span>
                  )}
                </span>
                <span className={cx('truncate text-[11.5px]', statusOf(s, waits).text)}>
                  {statusOf(s, waits).label}
                  {s.title ? ` · ${s.title}` : ''}
                </span>
              </span>
              <HostTag name={s.host_name} />
              {s.waiting > 0 ? (
                <span className="rounded-[6px] bg-accent px-1.5 text-[11px] font-bold text-onaccent">{s.waiting}</span>
              ) : s.unread > 0 ? (
                <span className="rounded-full bg-chip px-1.5 text-[11px] font-bold text-fg2">{s.unread}</span>
              ) : null}
            </button>
            {!filter && !s.is_main && s.project_id && (
              <button
                type="button"
                data-testid="session-set-main"
                title="Make this the project's main session"
                onClick={() =>
                  api
                    .setMainSession(s.project_id!, s.id)
                    .then(() => (reloadProjects(), reloadSessions(), toast(`${s.name} is now the main session`)))
                    .catch(error)
                }
                className="hidden h-7 shrink-0 rounded-md border-0 bg-transparent px-1.5 text-[11px] text-muted hover:bg-sel hover:text-fg focus:block group-hover:block"
              >
                Set as main
              </button>
            )}
            </div>
          )
        })}
          </div>
        ))}
        {list.length === 0 && <div className="px-2.5 py-2 text-[12.5px] text-subtle">No session matches.</div>}
      </div>
      {onNew && (
        <>
          <MenuSep />
          <MenuItem testid="composer-new-session" onClick={onNew}>
            <IconPlus size={13} /> New session…
          </MenuItem>
        </>
      )}
    </div>
  )
}

function EmptyThreads() {
  const { sessions, route } = useApp()
  const s = sessions?.find((x) => x.id === route.s && x.kind !== 'shell')
  return (
    <div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center" data-testid="empty-threads">
      <IconInbox size={36} className="text-faint" strokeWidth={1.2} />
      <span className="text-[15px] font-semibold">No threads yet.</span>
      <span className="max-w-[280px] text-[13px] leading-[1.55] text-muted">Write below to start one. Claude writes here too when it needs you or finishes work.</span>
      {s && <NextStep session={s} />}
    </div>
  )
}

// ---- composer ----

/** The session a new thread starts in. */
export function useComposeTarget(): Session | null {
  const { sessions, route } = useApp()
  const pick = useComposeTargetPick()
  const { id: projectId, project } = useSelectedProject()
  return useMemo(() => {
    const ok = (s?: Session | null) => (s && s.kind !== 'shell' && !s.archived_at && (!projectId || s.project_id === projectId) ? s : null)
    const byId = (id: string | null) => ok(sessions?.find((s) => s.id === id))
    if (pick.at === route.s) {
      const p = byId(pick.id)
      if (p) return p
    }
    // Inside a project a new thread goes to its main session; in All projects, to the open session.
    if (project) {
      const main = byId(project.main_session_id)
      if (main) return main
    }
    return byId(route.s) ?? byId(pick.id) ?? groupSessions((sessions ?? []).filter((s) => ok(s))).flatMap((g) => g.rows)[0] ?? null
  }, [sessions, route.s, pick, projectId, project])
}

/** Quick-compose text per session, kept while the box is unmounted. */
const quickDrafts = new Map<string, string>()

function QuickCompose({ phone, full, onToggleFull, onSent }: { phone?: boolean; full: boolean; onToggleFull: () => void; onSent: (t: Thread) => void }) {
  const { error, route, navigate } = useApp()
  const { id: projectId } = useSelectedProject()
  const target = useComposeTarget()
  const key = target?.id ?? ''
  const [body, setBodyState] = useState(() => quickDrafts.get(key) ?? '')
  // The draft follows the target.
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    setBodyState(quickDrafts.get(key) ?? '')
  }, [key])
  const setBody = (v: string) => {
    if (v) quickDrafts.set(key, v)
    else quickDrafts.delete(key)
    setBodyState(v)
  }
  const [sending, setSending] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [creating, setCreating] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const filesId = `quick:${key}`
  const { files, addFiles, addPastedText, remove: removeFile } = useComposeFiles(filesId)
  const io = fileInputHandlers(addFiles, addPastedText)
  const uploading = files.some((f) => f.state === 'uploading')
  const hasFiles = files.some((f) => f.state === 'done')
  const canSend = !!target && (!!body.trim() || hasFiles) && !uploading && !sending
  const send = async (to: Session | null = target) => {
    if (!to || sending || uploading || (!body.trim() && !hasFiles)) return
    setSending(true)
    try {
      const th = await api.createThread(to.id, '', body.trim(), undefined, uploadIds(filesId))
      clearFiles(filesId)
      quickDrafts.delete(key)
      setBodyState('')
      onSent(th)
    } catch (err) {
      error(err)
    } finally {
      setSending(false)
    }
  }
  const hint = !target
    ? 'Start a session to write to Claude Code'
    : target.status === 'ended'
      ? 'Session ended: Claude gets this after Resume'
      : target.status === 'working'
        ? 'Working: Claude gets this when its turn ends'
        : 'Claude gets this as its next turn'
  return (
    <div className={cx('border-t border-line p-2.5', full ? 'flex min-h-0 flex-1 flex-col' : 'shrink-0')} data-testid="quick-compose" data-full={full} data-target={target?.id}>
      <button
        type="button"
        data-testid="composer-target"
        aria-haspopup="menu"
        onClick={(e) => setAnchor(e.currentTarget)}
        className={cx('mb-1.5 flex max-w-full items-center gap-2 rounded-md border border-linestrong bg-transparent px-2.5 text-[12.5px] text-fg2 hover:bg-raised', phone ? 'h-9' : 'h-7')}
      >
        <span className="text-subtle">to</span>
        {target ? (
          <>
            <StatusDot s={target} waits={waitsOnPerson(target)} size={7} ring={false} />
            <span className="truncate font-semibold text-fg" data-testid="composer-target-name">{target.name}</span>
          </>
        ) : (
          <span className="text-fg">a new session</span>
        )}
        <span aria-hidden="true" className="text-subtle">▾</span>
      </button>
      <Popover anchor={anchor} open={!!anchor} onClose={() => setAnchor(null)} align="start" side="top" className="w-[300px]">
        <SessionPicker
          activeId={target?.id ?? ''}
          onPick={(s) => {
            setAnchor(null)
            if (s) setComposeTarget(s.id, route.s)
          }}
          onNew={() => {
            setAnchor(null)
            setCreating(true)
          }}
        />
      </Popover>
      {creating && (
        <NewSessionDialog
          projectId={projectId || target?.project_id}
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setComposeTarget(s.id, s.id)
            navigate({ s: s.id, t: null, f: null, view: 'main', tab: phone ? 'inbox' : 'terminal' })
            void send(s)
          }}
        />
      )}
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
      <CompletingTextarea
        ref={ref}
        testid="quick-body"
        dropUp
        autoGrow={{ min: phone ? 56 : 64, max: 240 }}
        fill={full}
        sessionId={target?.id ?? ''}
        value={body}
        onChange={setBody}
        onSubmit={() => void send()}
        {...io}
        placeholder={target ? 'Start a new thread with Claude Code… (@ agents, / skills)' : 'Pick or start a session above to write to Claude Code'}
      />
      <div className="mt-1.5 flex items-center gap-2">
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
        <IconButton
          size={28}
          aria-label={full ? 'Back to the thread list' : 'Full height'}
          aria-pressed={full}
          title={full ? 'Back to the thread list' : 'Full height'}
          data-testid="quick-full"
          onClick={onToggleFull}
          className={cx(full && 'bg-sel text-fg')}
        >
          <IconExpand size={15} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-subtle">{hint}</span>
        <Button variant="primary" size="sm" data-testid="quick-send" disabled={!canSend} onClick={() => void send()}>
          Send{phone ? '' : ' ⌘↵'}
        </Button>
      </div>
    </div>
  )
}
