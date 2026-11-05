import { useEffect, useRef, useState } from 'react'
import { api, type Project } from '../api'
import { useApp } from '../lib/app'
import { initials } from '../lib/format'
import { selectProject, shortDir, useProjectStats, useSelectedProject, type ProjectStat } from '../lib/projects'
import { IconArchive, IconChevronRight, IconInbox, IconMore, IconPin, IconPlus } from './icons'
import { Button, HostTag, IconButton, MenuItem, MenuSep, Modal, Popover, cx } from './ui'

/** The dot of a project: its busiest session. */
export function ProjectDot({ stat, size = 8 }: { stat?: ProjectStat; size?: number }) {
  const state = stat?.state ?? 'empty'
  return (
    <span
      aria-hidden="true"
      data-testid="project-dot"
      data-state={state}
      style={{ width: size, height: size }}
      className={cx(
        'inline-block shrink-0 rounded-full box-border',
        state === 'waiting' && 'bg-wait',
        state === 'working' && 'bg-work mb-pulse',
        state === 'idle' && 'bg-ok',
        (state === 'ended' || state === 'empty') && 'border-[1.5px] border-faint',
      )}
    />
  )
}

/** Waiting (amber) and unread (grey) counts of a project. */
export function ProjectBadges({ stat }: { stat?: ProjectStat }) {
  if (!stat) return null
  return (
    <>
      {stat.waiting > 0 && (
        <span data-testid="project-waiting" className="shrink-0 rounded-[6px] bg-accent px-1.5 text-[11px] font-bold leading-[18px] text-onaccent">
          {stat.waiting}
        </span>
      )}
      {stat.unread > 0 && (
        <span data-testid="project-unread" className="shrink-0 rounded-full bg-chip px-1.5 text-[11px] font-bold leading-[18px] text-fg2">
          {stat.unread}
        </span>
      )}
    </>
  )
}

/** Rename / edit folder / pin / archive / delete. The server refuses what would lose a session. */
export function ProjectMenu({ project, anchor, onClose, onRename }: { project: Project; anchor: HTMLElement | null; onClose: () => void; onRename: () => void }) {
  const { error, setOverlay, reloadProjects, reloadSessions, toast } = useApp()
  const { id: selected } = useSelectedProject()
  const run = (fn: () => Promise<unknown>) => () => {
    onClose()
    fn()
      .then(() => (reloadProjects(), reloadSessions()))
      .catch(error)
  }
  const empty = project.session_count === 0
  return (
    <Popover anchor={anchor} open={!!anchor} onClose={onClose} align="start" side="right" className="w-[220px]">
      <MenuItem testid="project-rename" onClick={() => (onClose(), onRename())}>
        Rename
      </MenuItem>
      <MenuItem
        testid="project-edit"
        disabled={!empty}
        hint={empty ? undefined : 'has sessions'}
        onClick={() => {
          onClose()
          setOverlay({ kind: 'edit-project', project })
        }}
      >
        Change folder or host…
      </MenuItem>
      <MenuItem testid="project-pin" onClick={run(() => api.patchProject(project.id, { pinned: !project.pinned_at }))}>
        {project.pinned_at ? 'Unpin' : 'Pin to top'}
      </MenuItem>
      <MenuSep />
      <MenuItem
        testid="project-archive"
        onClick={run(async () => {
          await api.archiveProject(project.id)
          if (selected === project.id) selectProject('')
          toast(`Archived ${project.name}`, { action: 'Undo', undo: true, onAction: () => api.archiveProject(project.id, false).then(() => (reloadProjects(), reloadSessions())).catch(error) })
        })}
      >
        Archive
      </MenuItem>
      <MenuItem
        testid="project-delete"
        danger
        onClick={run(async () => {
          await api.deleteProject(project.id)
          if (selected === project.id) selectProject('')
        })}
      >
        Delete
      </MenuItem>
    </Popover>
  )
}

/** Rename a project (a small dialog). */
export function RenameProject({ project, onClose }: { project: Project; onClose: () => void }) {
  const { error, reloadProjects, reloadSessions } = useApp()
  const [name, setName] = useState(project.name)
  const save = () => {
    const n = name.trim()
    if (!n || n === project.name) return onClose()
    api
      .patchProject(project.id, { name: n })
      .then(() => (reloadProjects(), reloadSessions(), onClose()))
      .catch(error)
  }
  return (
    <Modal label="Rename project" onClose={onClose} className="w-[min(420px,100%)] p-5">
      <h2 className="m-0 mb-3 text-[16px] font-[650]">Rename project</h2>
      <input
        autoFocus
        aria-label="Project name"
        data-testid="project-name-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        className="h-[38px] w-full rounded-lg border border-linestrong bg-sunken px-2.5 text-[14px] text-fg outline-none focus:border-accent"
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" data-testid="project-rename-save" onClick={save}>
          Rename
        </Button>
      </div>
    </Modal>
  )
}

/** The far-left column: All projects, then the projects. 176 px with names, 56 px as tiles. */
export function ProjectRail({ narrow }: { narrow: boolean }) {
  const { projects, setOverlay, setLayout } = useApp()
  const { id: selected } = useSelectedProject()
  const stats = useProjectStats()
  const [menu, setMenu] = useState<{ project: Project; anchor: HTMLElement } | null>(null)
  const [renaming, setRenaming] = useState<Project | null>(null)
  const tiles = narrow
  const all = stats.get('')

  return (
    <nav data-testid="project-rail" data-mode={tiles ? 'tiles' : 'names'} aria-label="Projects" className="flex h-full min-w-0 flex-col bg-sunken">
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
        <button
          type="button"
          data-testid="project-all"
          aria-pressed={selected === ''}
          title="All projects"
          onClick={() => selectProject('')}
          className={cx(
            'flex shrink-0 items-center gap-2 rounded-lg border-0 text-left',
            tiles ? 'h-11 justify-center px-0' : 'h-11 px-2.5',
            selected === '' ? 'bg-sel text-fg' : 'bg-transparent text-fg2 hover:bg-raised',
          )}
        >
          <IconInbox size={tiles ? 18 : 16} className="shrink-0" />
          {!tiles && <span className="min-w-0 flex-1 truncate text-[13px] font-[650]">All projects</span>}
          {!tiles && <ProjectBadges stat={all} />}
          {tiles && all && (all.waiting > 0 || all.unread > 0) && <span className="sr-only">{all.waiting || all.unread}</span>}
        </button>
        <div aria-hidden="true" className="mx-1.5 my-1 h-px shrink-0 bg-line" />
        {projects === null && <span className="px-2 py-2 text-[12px] text-subtle">Loading…</span>}
        {(projects ?? []).map((p) => {
          const stat = stats.get(p.id)
          const on = selected === p.id
          return (
            <div
              key={p.id}
              data-testid="project-item"
              data-project-id={p.id}
              data-selected={on}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ project: p, anchor: e.currentTarget })
              }}
              className={cx('group relative flex shrink-0 items-stretch rounded-lg', on ? 'bg-sel' : 'hover:bg-raised')}
            >
              <button
                type="button"
                aria-pressed={on}
                title={`${p.name}\n${p.dir || 'no folder'}${p.host_name && p.host_id !== 'local' ? ` · ${p.host_name}` : ''}`}
                data-testid="project-select"
                onClick={() => selectProject(p.id)}
                className={cx(
                  'flex min-w-0 flex-1 gap-2 rounded-lg border-0 bg-transparent text-left',
                  tiles ? 'h-11 items-center justify-center px-0' : 'min-h-[48px] items-start px-2.5 py-1.5',
                )}
              >
                {tiles ? (
                  <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-chip text-[12px] font-bold text-fg2">
                    {initials(p.name)}
                    <span className="absolute -right-1 -top-1">
                      <ProjectDot stat={stat} size={9} />
                    </span>
                    {stat && (stat.waiting > 0 || stat.unread > 0) && (
                      <span className="absolute -bottom-1 -right-1 rounded-full bg-accent px-1 text-[9px] font-bold leading-[13px] text-onaccent">{stat.waiting || stat.unread}</span>
                    )}
                  </span>
                ) : (
                  <>
                    <span className="mt-[5px]">
                      <ProjectDot stat={stat} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {p.pinned_at && <IconPin size={11} className="shrink-0 text-muted" />}
                        <span data-testid="project-name" className={cx('min-w-0 flex-1 truncate text-[13px]', on || (stat && stat.waiting > 0) ? 'font-[650] text-fg' : 'font-medium text-fg2')}>
                          {p.name}
                        </span>
                        <ProjectBadges stat={stat} />
                      </span>
                      <span className="flex min-w-0 items-center gap-1">
                        <span data-testid="project-dir" className="mono min-w-0 truncate text-[11px] text-subtle">
                          {shortDir(p.dir, 20)}
                        </span>
                        {p.host_id !== 'local' && <HostTag name={p.host_name ?? p.host_id} />}
                      </span>
                    </span>
                  </>
                )}
              </button>
              {!tiles && (
                <button
                  type="button"
                  aria-label={`Project menu: ${p.name}`}
                  data-testid="project-menu"
                  onClick={(e) => setMenu({ project: p, anchor: e.currentTarget.parentElement as HTMLElement })}
                  className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-md border-0 bg-sel text-muted opacity-0 hover:text-fg focus:opacity-100 group-hover:opacity-100"
                >
                  <IconMore size={14} />
                </button>
              )}
            </div>
          )
        })}
        <Archived tiles={tiles} />
      </div>
      <div className={cx('flex shrink-0 items-center gap-1 border-t border-line p-1.5', tiles && 'flex-col')}>
        <button
          type="button"
          data-testid="project-new"
          aria-label="New project"
          title="New project"
          onClick={() => setOverlay({ kind: 'new-project' })}
          className={cx('flex h-8 items-center justify-center gap-1.5 rounded-lg border border-dashed border-linestrong bg-transparent text-[12.5px] text-fg2 hover:bg-raised', tiles ? 'w-8' : 'flex-1')}
        >
          <IconPlus size={13} />
          {!tiles && 'New project'}
        </button>
        <IconButton
          size={32}
          aria-label={tiles ? 'Show project names' : 'Narrow the project column'}
          title={tiles ? 'Show project names' : 'Narrow the project column'}
          data-testid="project-rail-toggle"
          onClick={() => setLayout({ projectsRail: !tiles })}
        >
          <IconChevronRight size={14} className={cx(!tiles && 'rotate-180')} />
        </IconButton>
      </div>
      {menu && <ProjectMenu project={menu.project} anchor={menu.anchor} onClose={() => setMenu(null)} onRename={() => setRenaming(menu.project)} />}
      {renaming && <RenameProject project={renaming} onClose={() => setRenaming(null)} />}
    </nav>
  )
}

/** Archived projects: a fold at the bottom of the list, only when there are some. */
function Archived({ tiles }: { tiles: boolean }) {
  const { projects, reloadProjects, reloadSessions, error } = useApp()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Project[]>([])
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    api
      .projects(true)
      .then((all) => n === seq.current && setList(all.filter((p) => p.archived_at)))
      .catch(() => {})
  }, [projects])
  if (list.length === 0 || tiles) return null
  return (
    <>
      <button
        type="button"
        data-testid="projects-archived-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="mt-2 flex h-7 shrink-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-2.5 text-left text-[11px] font-bold uppercase tracking-[0.06em] text-subtle"
      >
        <IconArchive size={12} /> Archived {list.length}
      </button>
      {open &&
        list.map((p) => (
          <div key={p.id} data-testid="project-archived-item" className="flex shrink-0 items-center gap-1 px-2.5 py-1 text-[12.5px] text-muted">
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <button
              type="button"
              data-testid="project-restore"
              onClick={() =>
                api
                  .archiveProject(p.id, false)
                  .then(() => (reloadProjects(), reloadSessions()))
                  .catch(error)
              }
              className="rounded border border-linestrong bg-transparent px-1.5 text-[11px] text-fg2 hover:bg-raised"
            >
              Restore
            </button>
          </div>
        ))}
    </>
  )
}
