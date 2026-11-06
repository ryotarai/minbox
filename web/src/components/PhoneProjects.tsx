import { useState } from 'react'
import type { Project } from '../api'
import { useApp } from '../lib/app'
import { selectProject, shortDir, useProjectStats, useSelectedProject } from '../lib/projects'
import { IconClose, IconMore, IconPlus } from './icons'
import { ProjectBadges, ProjectDot, ProjectIcon, ProjectMenu, RenameProject } from './ProjectRail'
import { HostTag, cx } from './ui'

/** Phone home header: the selected project; tap opens the project sheet. */
export function PhoneProjectButton() {
  const { project } = useSelectedProject()
  const stats = useProjectStats()
  const [open, setOpen] = useState(false)
  const stat = stats.get(project?.id ?? '')
  return (
    <>
      <button
        type="button"
        data-testid="project-switch"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="ml-1 flex h-11 min-w-0 flex-1 items-center gap-2 rounded-[10px] border-0 bg-transparent px-2 text-left"
      >
        {project && <ProjectDot stat={stat} size={8} />}
        {project?.icon && <ProjectIcon icon={project.icon} size={22} />}
        <span data-testid="project-switch-name" className="min-w-0 truncate text-[15px] font-[650]">
          {project ? project.name : 'All projects'}
        </span>
        <span aria-hidden="true" className="text-subtle">▾</span>
        {!project && <ProjectBadges stat={stat} />}
      </button>
      {open && <PhoneProjectSheet onClose={() => setOpen(false)} />}
    </>
  )
}

/** Phone: the project list as a full-height sheet; All projects first. */
export function PhoneProjectSheet({ onClose }: { onClose: () => void }) {
  const { projects, setOverlay } = useApp()
  const { id: selected } = useSelectedProject()
  const stats = useProjectStats()
  const [menu, setMenu] = useState<{ project: Project; anchor: HTMLElement } | null>(null)
  const [renaming, setRenaming] = useState<Project | null>(null)
  const pick = (id: string) => {
    selectProject(id)
    onClose()
  }
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface pt-[env(safe-area-inset-top)]" data-testid="project-sheet" role="dialog" aria-label="Projects">
      <header className="flex h-14 shrink-0 items-center gap-1 pl-4 pr-2">
        <h2 className="m-0 flex-1 text-[17px] font-[650]">Projects</h2>
        <button
          type="button"
          aria-label="New project"
          data-testid="sheet-new-project"
          onClick={() => (onClose(), setOverlay({ kind: 'new-project' }))}
          className="flex h-11 w-11 items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2"
        >
          <IconPlus size={20} />
        </button>
        <button type="button" aria-label="Close" data-testid="project-sheet-close" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2">
          <IconClose size={20} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <button
          type="button"
          data-testid="project-all"
          aria-pressed={selected === ''}
          onClick={() => pick('')}
          className={cx('mx-3 mb-1 mt-1 flex min-h-12 items-center gap-2 rounded-lg border-0 px-3 text-left text-[15px] font-[650] text-fg', selected === '' ? 'bg-sel' : 'bg-raised')}
        >
          <span className="flex-1">All projects</span>
          <ProjectBadges stat={stats.get('')} />
        </button>
        {(projects ?? []).map((p) => {
          const stat = stats.get(p.id)
          return (
            <div
              key={p.id}
              data-testid="project-item"
              data-project-id={p.id}
              className={cx('mx-2.5 flex min-h-16 items-center border-b border-[#1f1f24] [[data-theme=light]_&]:border-line', selected === p.id && 'bg-sel')}
            >
              <button type="button" data-testid="project-select" onClick={() => pick(p.id)} className="flex min-w-0 flex-1 items-start gap-2.5 border-0 bg-transparent py-2.5 pl-3 pr-1 text-left">
                <span className="mt-[7px]">
                  <ProjectDot stat={stat} size={9} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    {p.icon && <ProjectIcon icon={p.icon} size={24} />}
                    <span data-testid="project-name" className="min-w-0 flex-1 truncate text-[15.5px] font-medium">
                      {p.name}
                    </span>
                    {p.host_id !== 'local' && <HostTag name={p.host_name ?? p.host_id} phone />}
                    <ProjectBadges stat={stat} />
                  </span>
                  <span className="mono truncate text-[12px] text-subtle">{shortDir(p.dir, 34)}</span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`Project menu: ${p.name}`}
                data-testid="project-menu"
                onClick={(e) => setMenu({ project: p, anchor: e.currentTarget })}
                className="mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent text-muted"
              >
                <IconMore size={18} />
              </button>
            </div>
          )
        })}
        {projects && projects.length === 0 && <span className="px-4 py-6 text-[13px] text-muted">No projects yet. Start a session or add a project with +.</span>}
      </div>
      {menu && <ProjectMenu project={menu.project} anchor={menu.anchor} onClose={() => setMenu(null)} onRename={() => setRenaming(menu.project)} />}
      {renaming && <RenameProject project={renaming} onClose={() => setRenaming(null)} />}
    </div>
  )
}
