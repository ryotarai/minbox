import { useState } from 'react'
import type { Project } from '../api'
import { useApp } from '../lib/app'
import { selectProject, shortDir, useProjectStats, useSelectedProject } from '../lib/projects'
import { IconChevronDown, IconClose, IconLinear, IconMore, IconPlus, IconSlack } from './icons'
import { useLinearStatus } from '../lib/issues'
import { useSlackStatus } from '../lib/slack'
import { projectHueStyle } from '../lib/projectColor'
import { ProjectBadges, ProjectDot, ProjectIcon, ProjectMenu, RenameProject, useGlobalEntries } from './ProjectRail'
import { HostTag, cx } from './ui'
import { useContextMenu } from './ContextMenu'

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
        {project?.icon && (
          <span style={projectHueStyle(project.id)} className="proj-tint flex shrink-0 rounded-[6px]">
            <ProjectIcon icon={project.icon} size={22} />
          </span>
        )}
        <span data-testid="project-switch-name" className="min-w-0 truncate text-[15px] font-[650]">
          {project ? project.name : 'All projects'}
        </span>
        <IconChevronDown size={14} className="text-subtle" />
        {!project && <ProjectBadges stat={stat} />}
      </button>
      {open && <PhoneProjectSheet onClose={() => setOpen(false)} />}
    </>
  )
}

/** Phone: the project list as a full-height sheet; All projects first. */
export function PhoneProjectSheet({ onClose }: { onClose: () => void }) {
  const { projects, setOverlay, navigate } = useApp()
  const { id: selected } = useSelectedProject()
  const stats = useProjectStats()
  const linear = useLinearStatus()
  const slack = useSlackStatus()
  const [menu, setMenu] = useState<{ project: Project; anchor: HTMLElement } | null>(null)
  // Long press / right-click on a project: the same menu as its "…" button, at the finger.
  const ctx = useContextMenu()
  const ctxProject = ctx.at ? projects?.find((p) => p.id === ctx.at!.el.dataset.projectId) : undefined
  const [renaming, setRenaming] = useState<Project | null>(null)
  const globals = useGlobalEntries()
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {slack.available && (
          <button
            type="button"
            data-testid="slack-entry"
            aria-label="Slack"
            onClick={() => (onClose(), navigate({ view: 'slack' }, { push: true }))}
            className="mx-3 mb-1 mt-1 flex min-h-12 items-center gap-2 rounded-lg border-0 bg-raised px-3 text-left text-[15px] font-[650] text-fg"
          >
            <IconSlack size={17} className="shrink-0" />
            <span className="flex-1">Slack</span>
          </button>
        )}
        {linear.available && (
          <button
            type="button"
            data-testid="my-issues"
            aria-label="My issues"
            onClick={() => (onClose(), navigate({ view: 'issues' }, { push: true }))}
            className="mx-3 mb-1 mt-1 flex min-h-12 items-center gap-2 rounded-lg border-0 bg-raised px-3 text-left text-[15px] font-[650] text-fg"
          >
            <IconLinear size={17} className="shrink-0" />
            <span className="flex-1">My issues</span>
          </button>
        )}
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
              {...ctx.props}
              className={cx('mx-2.5 flex min-h-16 items-center border-b border-[#1f1f24] [[data-theme=light]_&]:border-line', selected === p.id && 'bg-sel')}
            >
              <button type="button" data-testid="project-select" onClick={() => pick(p.id)} className="flex min-w-0 flex-1 items-start gap-2.5 border-0 bg-transparent py-2.5 pl-3 pr-1 text-left">
                <span className="mt-[7px]">
                  <ProjectDot stat={stat} size={9} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    {p.icon && (
                      <span style={projectHueStyle(p.id)} className="proj-tint flex shrink-0 rounded-[6px]">
                        <ProjectIcon icon={p.icon} size={24} />
                      </span>
                    )}
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
        {projects && projects.length === 0 && <span className="px-4 py-6 text-[13px] text-muted">No projects yet. Start an agent or add a project with +.</span>}
      </div>
      {/* Not about a project: Settings, Tasks, Decide, Drafts. Pinned under the list, two taps from home. */}
      <div data-testid="sheet-global" className="flex shrink-0 gap-1 overflow-x-auto border-t border-line px-2 pb-[max(env(safe-area-inset-bottom),6px)] pt-1.5">
        {globals.map((e) => (
          <button
            key={e.id}
            type="button"
            data-testid={e.testid}
            aria-label={e.label}
            onClick={() => (onClose(), e.run())}
            className="flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] border-0 bg-transparent text-fg2 active:bg-raised"
          >
            <span className="relative">
              <e.icon size={20} />
              {!!e.count && <span className="absolute -right-2.5 -top-1.5 rounded-full bg-chip px-1 text-[9.5px] font-bold leading-[14px] text-fg2">{e.count}</span>}
            </span>
            <span className="text-[11.5px]">{e.label}</span>
          </button>
        ))}
      </div>
      {menu && <ProjectMenu project={menu.project} anchor={menu.anchor} onClose={() => setMenu(null)} onRename={() => setRenaming(menu.project)} />}
      {ctxProject && <ProjectMenu project={ctxProject} anchor={null} at={ctx.at} onClose={ctx.close} onRename={() => setRenaming(ctxProject)} />}
      {renaming && <RenameProject project={renaming} onClose={() => setRenaming(null)} />}
    </div>
  )
}
