import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type Host, type Project, type Session, type SessionKind } from '../api'
import { useApp } from '../lib/app'
import { selectProject, shortDir } from '../lib/projects'
import { homeRelative, isMac } from '../lib/format'
import { Button, HostTag, IconButton, MenuItem, Modal, Popover, cx } from './ui'

type Entry = { name: string; path: string; display: string; git: boolean; branch?: string }
type Listing = { path: string; display: string; parent?: string; home: string; entries: Entry[] }

async function listDirs(path: string, hostId: string): Promise<Listing> {
  const res = await fetch(`/api/fs/dirs?path=${encodeURIComponent(path)}${hostId ? `&host_id=${encodeURIComponent(hostId)}` : ''}`)
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
  return json as Listing
}

async function makeDir(path: string, hostId: string): Promise<{ path: string; display: string }> {
  const res = await fetch('/api/fs/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, host_id: hostId || undefined }) })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
  return json
}

function rememberCwd(path: string, host: string) {
  localStorage.setItem('minbox:last-cwd', path)
  localStorage.setItem('minbox:last-host', host)
}

function hostMeta(h: Host): string {
  if (h.status !== 'online') return h.status === 'connecting' ? 'connecting…' : `offline${h.last_seen ? ` · ${ago(h.last_seen)}` : ''}`
  if (h.builtin) return 'This machine · online'
  return `online${h.latency_ms !== undefined ? ` · ${h.latency_ms} ms` : ''}`
}

function ago(iso: string): string {
  const min = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  return min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`
}

const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

/**
 * New session: choose a project (its host and folder are fixed), or a folder that has no project
 * yet (browse for it; the project is made from it). The same dialog makes a project
 * (mode "project": host, folder, name) and moves an empty one (mode "project-edit").
 */
export function NewSessionDialog({
  onClose,
  onCreated,
  mode = 'session',
  projectId,
  project: editing,
}: {
  onClose: () => void
  onCreated?: (s: Session) => void
  mode?: 'session' | 'project' | 'project-edit'
  /** The project to start in (the selected one). */
  projectId?: string
  /** The project being edited (mode "project-edit"). */
  project?: Project
}) {
  const { setSessions, navigate, error, isPhone, hosts, projects, reloadProjects, reloadSessions } = useApp()
  // The project to start in: the one asked for, else the most recent; none (a folder) when there are none.
  const [pickedProject, setPickedProject] = useState<string>(() => {
    if (mode !== 'session') return ''
    if (projectId && projects?.some((p) => p.id === projectId)) return projectId
    return projects?.[0]?.id ?? ''
  })
  // Projects may load after the dialog opens: until the person chooses, follow the default.
  const [projTouched, setProjTouched] = useState(false)
  useEffect(() => {
    if (mode !== 'session' || projTouched || !projects) return
    setPickedProject(projectId && projects.some((p) => p.id === projectId) ? projectId : projects[0]?.id ?? '')
  }, [mode, projTouched, projects, projectId])
  const proj = mode === 'session' ? projects?.find((p) => p.id === pickedProject) : undefined
  const [projAnchor, setProjAnchor] = useState<HTMLElement | null>(null)
  // A project's first Claude Code session is its main one; later ones are extra unless asked.
  const [makeMain, setMakeMain] = useState(false)
  const [hostId, setHostId] = useState(() => (editing ? editing.host_id : localStorage.getItem('minbox:last-host') ?? ''))
  const [hostAnchor, setHostAnchor] = useState<HTMLElement | null>(null)
  // The last host if it is still there and online, else this machine.
  useEffect(() => {
    if (hosts.length === 0 || editing) return
    const h = hosts.find((x) => x.id === hostId)
    if (!h || h.status !== 'online') setHostId(hosts.find((x) => x.builtin)?.id ?? hosts[0]!.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts.length])
  const host = hosts.find((h) => h.id === hostId)
  const [cwd, setCwd] = useState(() => (editing ? homeRelative(editing.dir) : localStorage.getItem('minbox:last-cwd') ?? '~'))
  const [name, setName] = useState(() => editing?.name ?? '')
  const [listing, setListing] = useState<Listing | null>(null)
  const [missing, setMissing] = useState(false)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [mkdir, setMkdir] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(!isPhone)
  const [claudeCmd, setClaudeCmd] = useState('claude')
  const [kind, setKindState] = useState<SessionKind>(() => (!onCreated && localStorage.getItem('minbox:last-kind') === 'shell' ? 'shell' : 'claude'))
  const setKind = (k: SessionKind) => {
    setKindState(k)
    localStorage.setItem('minbox:last-kind', k)
  }
  const startLabel = mode === 'project' ? 'Create project' : mode === 'project-edit' ? 'Save' : kind === 'shell' ? 'Start shell' : 'Start Claude Code'
  // A project fixes host and folder: the browser is only for a new folder or a project.
  const showFolder = !proj
  const title = mode === 'project' ? 'New project' : mode === 'project-edit' ? 'Edit project' : 'New session'
  const cwdRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api
      .about()
      .then((a) => setClaudeCmd((a as { claude_command?: string }).claude_command || 'claude'))
      .catch(() => {})
  }, [])

  // The browser follows what is typed, once it names a folder.
  useEffect(() => {
    if (!showFolder) return
    const t = setTimeout(() => {
      listDirs(cwd, hostId)
        .then((l) => {
          setMissing(false)
          setListing(l)
        })
        .catch(() => setMissing(cwd.trim() !== ''))
    }, 150)
    return () => clearTimeout(t)
  }, [cwd, hostId, showFolder])

  // Moving through the browser lists the folder at once (typing waits a beat).
  const browse = (path: string) => {
    setFilter('')
    setCwd(homeRelative(path))
    listDirs(path, hostId)
      .then((l) => {
        setMissing(false)
        setListing(l)
      })
      .catch(() => setMissing(true))
  }

  const starting = useRef(false)
  const start = async () => {
    if (starting.current || (showFolder && (missing || !cwd.trim()))) return
    starting.current = true
    setBusy(true)
    try {
      if (mode !== 'session') {
        const p = editing
          ? await api.patchProject(editing.id, { name: name.trim() || undefined, dir: cwd.trim(), host_id: hostId || undefined })
          : await api.createProject({ dir: cwd.trim(), host_id: hostId || undefined, name: name.trim() || undefined })
        rememberCwd(cwd.trim(), hostId)
        reloadProjects()
        reloadSessions()
        selectProject(p.id)
        onClose()
        return
      }
      const s = proj ? await api.createSessionIn(proj.id, name.trim(), kind, makeMain) : await api.createSession(cwd.trim(), name.trim(), hostId || undefined, kind)
      if (!proj) rememberCwd(cwd.trim(), hostId)
      reloadProjects()
      setSessions((p) => (p && !p.some((x) => x.id === s.id) ? [s, ...p] : p))
      if (onCreated) onCreated(s)
      else navigate({ s: s.id, t: null, f: null, view: 'main', tab: 'terminal' })
      onClose()
    } catch (err) {
      error(err)
    } finally {
      starting.current = false
      setBusy(false)
    }
  }

  const createFolder = async () => {
    if (!mkdir?.trim() || !listing) return
    try {
      const r = await makeDir(`${listing.path}/${mkdir.trim()}`, hostId)
      setMkdir(null)
      browse(r.path)
    } catch (err) {
      error(err)
    }
  }

  const entries = (listing?.entries ?? []).filter((e) => e.name === '.' || !filter || e.name.toLowerCase().includes(filter.toLowerCase()))
  const crumbs = (() => {
    if (!listing) return []
    const segs = listing.display.split('/')
    const out: { label: string; path: string }[] = []
    segs.forEach((seg, i) => {
      if (seg === '' && i === 0) out.push({ label: '/', path: '/' })
      else if (seg !== '') out.push({ label: seg, path: segs.slice(0, i + 1).join('/') })
    })
    return out
  })()
  const mod = isMac() ? '⌘' : 'Ctrl+'

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void start()
    }
  }

  const browser = (
    <div data-testid="new-session-browser" className="flex h-full min-h-0 flex-col overflow-hidden rounded-[10px] border border-line2 bg-surface">
      <nav aria-label="Path" className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-2 text-[13px]">
        <IconButton size={30} aria-label="Up one folder" disabled={!listing?.parent} onClick={() => listing?.parent && browse(listing.parent)}>
          ↑
        </IconButton>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex shrink-0 items-center gap-0.5 last:shrink">
              {i > 0 && c.label !== '/' && crumbs[i - 1]!.label !== '/' && <span className="text-[#52525b]">/</span>}
              <button
                type="button"
                onClick={() => browse(c.path)}
                className={cx('h-7 truncate rounded-[6px] border-0 bg-transparent px-1.5 hover:bg-raised', i === crumbs.length - 1 ? 'font-semibold text-fg' : 'text-muted')}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
        <label className="flex h-7 w-[150px] shrink-0 items-center gap-1.5 rounded-[6px] border border-line2 bg-sunken px-2 text-[12.5px] text-subtle">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Filter folders"
            data-testid="new-session-filter"
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-fg outline-none"
          />
        </label>
      </nav>
      <div role="listbox" aria-label="Folders" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1">
        {entries.map((d) => {
          const sel = d.name === '.'
          return (
            <div
              key={d.path + d.name}
              role="option"
              aria-selected={sel}
              data-testid="new-session-dir"
              tabIndex={0}
              onClick={() => (sel ? undefined : browse(d.path))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !sel) browse(d.path)
              }}
              className={cx('flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-[7px] px-2.5 text-[13px]', sel ? 'bg-sel' : 'hover:bg-raised')}
            >
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={sel ? 'var(--mb-wait)' : 'var(--mb-subtle)'} strokeWidth="1.4" strokeLinejoin="round">
                <path d="M1.5 4.5a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
              </svg>
              <span className={cx('mono min-w-0 flex-1 truncate', sel ? 'text-fg' : 'text-fg2')}>{d.name}</span>
              {d.git && <span className="mono shrink-0 rounded border border-linestrong px-[5px] text-[11px] leading-4 text-muted">git{d.branch ? ` · ${d.branch}` : ''}</span>}
              {!sel && <span className="text-[#52525b]">›</span>}
            </div>
          )
        })}
        {listing && entries.length === 1 && <span className="px-2.5 py-2 text-[12.5px] text-subtle">{filter ? 'No folders match.' : 'No folders inside.'}</span>}
      </div>
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-t border-line px-3 text-[12.5px] text-subtle">
        {mkdir !== null ? (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void createFolder()
            }}
          >
            <input
              autoFocus
              aria-label="New folder name"
              data-testid="new-folder-name"
              value={mkdir}
              onChange={(e) => setMkdir(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setMkdir(null)
                }
              }}
              placeholder="folder-name"
              className="mono h-7 min-w-0 flex-1 rounded-[6px] border border-accent bg-sunken px-2 text-[12.5px] text-fg outline-none"
            />
            <Button size="sm" className="h-7" type="submit">
              Create
            </Button>
          </form>
        ) : (
          <>
            <span className="flex-1" />
            <Button size="sm" className="h-7 text-fg" data-testid="new-folder" onClick={() => setMkdir('')} disabled={!listing}>
              + New folder
            </Button>
          </>
        )}
      </div>
    </div>
  )

  const dot = (h: Host) => (
    <span aria-hidden="true" className={cx('box-border h-[7px] w-[7px] shrink-0 rounded-full', h.status === 'online' ? 'bg-ok' : 'border-[1.5px] border-faint')} />
  )
  const hostPicker =
    hosts.length === 0 ? null : isPhone ? (
      <label className="flex flex-col gap-1.5 text-[13px] text-muted">
        Host
        <button
          type="button"
          data-testid="new-session-host"
          onClick={(e) => setHostAnchor(e.currentTarget)}
          className="flex h-12 items-center gap-2.5 rounded-[10px] border border-linestrong bg-sunken px-3 text-left text-[16px] text-fg"
        >
          {host && dot(host)}
          <span className="flex-1">
            {host?.name ?? 'Choose a host'} {host?.builtin && <span className="text-[13px] text-subtle">This machine</span>}
          </span>
          ▾
        </button>
        <Popover anchor={hostAnchor} open={!!hostAnchor} onClose={() => setHostAnchor(null)} align="start" className="w-[300px]">
          {hosts.map((h) => (
            <MenuItem
              key={h.id}
              active={h.id === hostId}
              disabled={h.status !== 'online'}
              hint={hostMeta(h)}
              onClick={() => {
                setHostId(h.id)
                setHostAnchor(null)
              }}
            >
              {dot(h)} {h.name}
            </MenuItem>
          ))}
        </Popover>
      </label>
    ) : (
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-muted">Host</span>
        <div role="radiogroup" aria-label="Host" data-testid="new-session-host" className="grid grid-cols-3 gap-2">
          {hosts.map((h) => {
            const on = h.id === hostId
            const off = h.status !== 'online'
            return (
              <button
                key={h.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={off}
                data-testid="new-session-host-option"
                onClick={() => setHostId(h.id)}
                className={cx('flex h-12 min-w-0 items-center gap-2 rounded-[9px] border px-2.5 text-left', on ? 'border-wait/55 bg-wait/10' : 'border-line2 bg-transparent', off && 'opacity-55')}
              >
                {dot(h)}
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-[13px] font-semibold">{h.name}</span>
                  <span className="truncate text-[11px] text-subtle">{hostMeta(h)}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )

  // Started from the composer, the session must be Claude Code: a message goes to it.
  const kindPicker = onCreated || mode !== 'session' ? null : (
    <div className="flex flex-col gap-1.5">
      <span className={cx('text-muted', isPhone ? 'text-[13px]' : 'text-[12.5px]')}>Run</span>
      <div role="radiogroup" aria-label="Run" data-testid="new-session-kind" className="inline-flex gap-0.5 self-start rounded-[9px] border border-line2 bg-sunken p-[3px]">
        {(
          [
            ['claude', 'Claude Code'],
            ['shell', 'Shell'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            data-testid={`new-session-kind-${k}`}
            onClick={() => setKind(k)}
            className={cx(
              'rounded-[6px] border-0 px-3 font-semibold',
              isPhone ? 'h-10 text-[15px]' : 'h-[30px] text-[12.5px]',
              kind === k ? 'bg-sel text-fg' : 'bg-transparent text-muted hover:text-fg',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )

  const cwdInput = (
    <label className={cx('flex flex-col gap-1.5 text-muted', isPhone ? 'text-[13px]' : 'text-[12.5px]')}>
      Working directory
      <input
        ref={cwdRef}
        data-testid="new-session-cwd"
        aria-invalid={missing}
        autoFocus={!isPhone}
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        onKeyDown={(e) => {
          if (isPhone) onKey(e)
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) void start()
        }}
        className={cx(
          'mono min-w-0 rounded-lg border bg-sunken px-2.5 text-fg outline-none',
          isPhone ? 'h-12 rounded-[10px] text-[16px]' : 'h-[38px] text-[13px]',
          missing ? 'border-danger text-danger' : 'border-linestrong focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--mb-wait)_15%,transparent)]',
        )}
      />
      {missing && (
        <span className="text-[12px] text-dangerfg" data-testid="new-session-missing">
          This folder does not exist
        </span>
      )}
    </label>
  )
  const nameInput = (
    <label className={cx('flex flex-col gap-1.5 text-muted', isPhone ? 'text-[13px]' : 'text-[12.5px]')}>
      <span>
        {mode === 'session' ? 'Session name' : 'Project name'} <span className="text-subtle">(optional)</span>
      </span>
      <input
        data-testid="new-session-name"
        value={name}
        placeholder={mode === 'session' && proj ? base(proj.dir) : listing ? base(listing.display) : base(cwd)}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (isPhone) onKey(e)
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) void start()
        }}
        className={cx('rounded-lg border border-linestrong bg-sunken px-2.5 text-fg outline-none focus:border-accent', isPhone ? 'h-12 rounded-[10px] text-[16px]' : 'h-[38px] text-[13.5px]')}
      />
    </label>
  )

  // Which project the session starts in; a project fixes its host and folder.
  const projectPicker =
    mode !== 'session' || !projects || projects.length === 0 ? null : (
      <div className="flex flex-col gap-1.5">
        <span className={cx('text-muted', isPhone ? 'text-[13px]' : 'text-[12.5px]')}>Project</span>
        <button
          type="button"
          data-testid="new-session-project"
          aria-haspopup="menu"
          data-project-id={proj?.id ?? ''}
          onClick={(e) => setProjAnchor(e.currentTarget)}
          className={cx('flex items-center gap-2.5 rounded-[10px] border border-linestrong bg-sunken px-3 text-left text-fg', isPhone ? 'h-12 text-[16px]' : 'h-[38px] text-[13.5px]')}
        >
          {proj ? (
            <>
              <span data-testid="new-session-project-name" className="font-semibold">{proj.name}</span>
              <span className="mono min-w-0 flex-1 truncate text-[12px] text-muted">{shortDir(proj.dir, 40)}</span>
              {proj.host_id !== 'local' && <HostTag name={proj.host_name ?? proj.host_id} />}
            </>
          ) : (
            <span className="flex-1 text-muted">A folder without a project yet…</span>
          )}
          <span aria-hidden="true" className="text-subtle">▾</span>
        </button>
        <Popover anchor={projAnchor} open={!!projAnchor} onClose={() => setProjAnchor(null)} align="start" className="w-[340px]">
          <div className="max-h-[320px] overflow-y-auto">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                data-testid="new-session-project-option"
                data-project-id={p.id}
                onClick={() => (setProjTouched(true), setPickedProject(p.id), setProjAnchor(null))}
                className={cx('flex min-h-9 w-full items-center gap-2 rounded-[6px] border-0 px-2.5 py-1 text-left hover:bg-sel', p.id === pickedProject ? 'bg-sel' : 'bg-transparent')}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] text-fg">{p.name}</span>
                  <span className="mono truncate text-[11.5px] text-muted">{shortDir(p.dir, 36)}</span>
                </span>
                {p.host_id !== 'local' && <HostTag name={p.host_name ?? p.host_id} />}
              </button>
            ))}
          </div>
          <MenuItem testid="new-session-project-folder" active={!pickedProject} onClick={() => (setProjTouched(true), setPickedProject(''), setProjAnchor(null))}>
            A folder without a project yet…
          </MenuItem>
        </Popover>
        {proj && kind === 'claude' && proj.main_session_id && (
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <input type="checkbox" data-testid="new-session-make-main" checked={makeMain} onChange={(e) => setMakeMain(e.target.checked)} />
            Make main session (new threads go to it)
          </label>
        )}
        {proj && (
          <span data-testid="new-session-project-info" className="text-[12px] text-subtle">
            Starts in {proj.host_name ?? proj.host_id} · <span className="mono">{proj.dir || '~'}</span>
          </span>
        )}
      </div>
    )

  const canStart = !busy && (!showFolder || (!missing && !!cwd.trim()))

  if (isPhone) {
    return <PhoneSheet onClose={onClose} title={title} body={
      <>
        {kindPicker}
        {projectPicker}
        {showFolder && (
          <>
            {hostPicker}
            {browsing ? (
              <div className="flex h-[300px] shrink-0 flex-col">{browser}</div>
            ) : (
              <button
                type="button"
                data-testid="new-session-browse"
                onClick={() => setBrowsing(true)}
                className="flex h-[52px] shrink-0 items-center justify-center gap-2 rounded-xl border border-dashed border-[#52525b] bg-transparent text-[15px]"
              >
                Browse folders…
              </button>
            )}
            {cwdInput}
          </>
        )}
        {nameInput}
      </>
    } footer={
      <button
        type="button"
        data-testid="new-session-start"
        disabled={!canStart}
        onClick={() => void start()}
        className="h-[52px] w-full rounded-xl border-0 bg-accent text-[16px] font-bold text-onaccent disabled:opacity-45"
      >
        {busy ? 'Starting…' : startLabel}
      </button>
    } />
  }

  return (
    <Modal label={title} onClose={onClose} className="flex max-h-[calc(100vh-80px)] w-[min(800px,100%)] flex-col overflow-hidden rounded-2xl bg-raised" top>
      <div className="flex h-14 shrink-0 items-center border-b border-line2 pl-[22px] pr-3">
        <h2 className="m-0 flex-1 text-[16px] font-[650]">{title}</h2>
        <IconButton size={36} aria-label="Close (Esc)" onClick={onClose} className="text-[18px]">
          ×
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1" onKeyDown={onKey}>
        <div className="flex min-w-0 flex-1 flex-col gap-3 px-5 py-4">
          {kindPicker}
          {projectPicker}
          {showFolder && (
            <>
              {hostPicker}
              {cwdInput}
              <div className="flex h-[300px] min-h-0 flex-col">{browser}</div>
            </>
          )}
          {nameInput}
        </div>
      </div>
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-t border-line2 px-5">
        <span className="mono min-w-0 flex-1 truncate text-[12px] text-subtle">
          {proj
            ? `${proj.host_name ?? proj.host_id} · ${kind === 'shell' ? '$SHELL' : claudeCmd} · ${proj.dir || '~'}`
            : `${host ? `${host.name} · ` : ''}${mode !== 'session' ? '' : kind === 'shell' ? '$SHELL · ' : `${claudeCmd} · `}${listing ? listing.display : cwd}`}
        </span>
        <Button variant="quiet" className="h-[38px] text-[13.5px]" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" className="h-[38px] px-4 text-[13.5px]" data-testid="new-session-start" disabled={!canStart} onClick={() => void start()}>
          {busy ? 'Starting…' : startLabel} <span className="mono text-[11.5px] opacity-70">{mod}↵</span>
        </Button>
      </div>
    </Modal>
  )
}

/** A bottom sheet (phone). */
function PhoneSheet({ title, body, footer, onClose }: { title: string; body: React.ReactNode; footer: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-50 bg-[rgba(5,5,7,0.6)]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={title} className="absolute inset-x-0 bottom-0 top-[70px] flex flex-col rounded-t-[18px] border-t border-linestrong bg-raised">
        <div aria-hidden="true" className="mx-auto mt-2 h-[5px] w-9 rounded-[3px] bg-[#52525b]" />
        <div className="flex h-[52px] shrink-0 items-center pl-[18px] pr-1.5">
          <h2 className="m-0 flex-1 text-[17px] font-[650]">{title}</h2>
          <button type="button" onClick={onClose} className="h-11 border-0 bg-transparent px-3 text-[15px] text-muted">
            Cancel
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-1">{body}</div>
        <div className="shrink-0 border-t border-line2 px-4 pb-[max(10px,env(safe-area-inset-bottom))] pt-2.5">{footer}</div>
      </div>
    </div>,
    document.body,
  )
}
