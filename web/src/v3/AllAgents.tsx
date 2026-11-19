// All agents (#v=alltasks, the top of the agents list): laid out as an agent's page. The Tasks pane
// lists every agent's tasks, each naming its agent (see AllTasksPane); beside it, where an agent's
// stream would be, the task picked there (#v=alltasks&k=…): its card, checklist and messages, as in an
// agent's page, its reply going to the task's agent. With no task picked: "Select a task" (there is no
// one agent to write to, so no message box). On a phone: "Tasks N ›" opens the tasks as a sheet (back
// closes it), as an agent's page does.
import type { Attachment, Session } from '../api'
import { useApp } from '../lib/app'
import { IconBack, IconChevronRight } from '../components/icons'
import type { BoardTask, V3Message } from './data'
import { BackButton } from './parts'
import { AgentTaskList, agentTasks, useAllTasksSelect, useOwnerName } from './AgentTasks'
import { TaskView } from './TaskView'

export function AllAgentsView({
  agents,
  tasks,
  projectName,
  highlight,
  sheet = false,
  onOpenAttachment,
}: {
  /** The agents listed (the project's live agents): whose tasks show. */
  agents: Session[]
  tasks: BoardTask[]
  projectName?: string
  highlight: string | null
  /** Phone: the tasks as a full-screen sheet (#…&tab=tasks). */
  sheet?: boolean
  onOpenAttachment: (a: Attachment, m: V3Message) => void
}) {
  const { isPhone, navigate, goBack } = useApp()
  const { detail } = useAllTasksSelect(tasks)
  const owner = useOwnerName()
  const ids = agents.map((a) => a.id)
  const openTasks = agentTasks(tasks, ids).open
  return (
    <>
      <div className="v-col" data-testid="all-agents-view" data-detail={detail ?? undefined}>
        <div className="v-head">
          <div className="v-r1">
            <BackButton tasks={tasks} fallback={detail ? { k: null } : undefined} />
            <h2 data-testid="all-agents-title" className="v-tline">
              <span>All agents</span>
            </h2>
            <span className="v-hide-phone v-kind" style={{ color: 'var(--mb-subtle)', fontSize: 12 }}>
              {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
              {projectName ? ' · ' + projectName : ''}
            </span>
            {isPhone && (
              <button type="button" className="v-chip v-sheetbtn" data-testid="agent-sheet-open" aria-label={`Tasks (${openTasks.length} open)`} onClick={() => navigate({ tab: 'tasks' }, { push: true })}>
                Tasks <b>{openTasks.length}</b> <IconChevronRight size={12} />
              </button>
            )}
          </div>
        </div>
        {detail ? (
          <div className="v-colsone" data-testid="agent-task-detail">
            <div className="v-colcell">
              <TaskView key={detail} id={detail} highlight={highlight} tasks={tasks} onOpenAttachment={onOpenAttachment} column={{ detail: true }} />
            </div>
          </div>
        ) : (
          <div className="v-empty" data-testid="all-agents-empty">
            Select a task
            {isPhone && (
              <>
                {' · '}
                <button type="button" className="v-link" data-testid="all-agents-show-tasks" onClick={() => navigate({ tab: 'tasks' }, { push: true })}>
                  Show the tasks
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {isPhone && sheet && (
        <aside className="v-side wide" data-testid="agent-side" data-sheet>
          <div className="v-tabs2">
            <button type="button" className="v-sheetx" data-testid="agent-sheet-close" aria-label="Back to All agents" title="Back" onClick={() => goBack({ tab: 'inbox' })}>
              <IconBack size={18} />
            </button>
            <button type="button" className="on" data-testid="pane-tasks">
              Tasks
            </button>
          </div>
          <div style={{ padding: '0 16px 16px', overflow: 'auto' }}>
            <AgentTaskList tasks={tasks} sessionId={ids} owner={owner} selected={detail} onSelect={(k) => navigate({ view: 'alltasks', k: k === detail ? null : k, m: null, tab: 'inbox' }, { push: true })} />
          </div>
        </aside>
      )}
    </>
  )
}
