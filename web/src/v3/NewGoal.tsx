// New goal: a goal is an outcome an agent keeps working toward until its "done when" criteria are met
// (docs/v3/redesign.md §12). The ⇧N dialog switches between a message and a goal (the Message / Goal
// toggle); the Board's "New goal" and ⌘K › New goal open it on Goal. A goal has a title, criteria typed
// one per line, the agent that pursues it (the same agent list as the message's "To"), and optionally
// its autonomous run started at once (up to N turns).
import { useState } from 'react'
import type { Session } from '../api'
import { useApp } from '../lib/app'
import { agentKindLabel } from '../lib/agents'
import { isMac } from '../lib/format'
import { useSelectedProject } from '../lib/projects'
import { v3, type BoardTask } from './data'
import { SendKey, agentHint, rememberTasks, useNav } from './parts'

export type NewMode = 'message' | 'goal'

/** The ⇧N dialog's Message / Goal switch. */
export function NewModeToggle({ mode, onMode }: { mode: NewMode; onMode: (m: NewMode) => void }) {
  return (
    <div className="v-seg" role="tablist" aria-label="What to make" data-testid="new-mode">
      {(['message', 'goal'] as const).map((m) => (
        <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} data-testid={'new-mode-' + m} onClick={() => onMode(m)}>
          {m === 'message' ? 'Message' : 'Goal'}
        </button>
      ))}
    </div>
  )
}

/** The agents a message or a goal can go to, as the ⇧N dialog lists them. */
export function AgentOptions({ agents }: { agents: Session[] }) {
  return (
    <>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
          {agentHint(agents, a) ? ` (${agentHint(agents, a)})` : ''} · {agentKindLabel(a.agent)}
          {a.title ? ' — ' + a.title.slice(0, 40) : ''}
        </option>
      ))}
    </>
  )
}

/** Criteria typed one per line (a leading "- ", "* ", "1." or "[ ]" is dropped). */
export function parseCriteria(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:\[[ xX]?\]\s*)?/, '').trim())
    .filter(Boolean)
}

export function NewGoalDialog({ agents, initialTo, onMode, onClose }: { agents: Session[]; initialTo?: string; onMode: (m: NewMode) => void; onClose: () => void }) {
  const { error, toast, projects } = useApp()
  const { id: projectId } = useSelectedProject()
  const nav = useNav()
  const [title, setTitle] = useState('')
  const [criteria, setCriteria] = useState('')
  const [to, setTo] = useState(initialTo && agents.some((a) => a.id === initialTo) ? initialTo : agents[0]?.id ?? '')
  const [run, setRun] = useState(false)
  const [turns, setTurns] = useState('20')
  const [busy, setBusy] = useState(false)
  const project = projectId || agents.find((a) => a.id === to)?.project_id || projects?.[0]?.id || ''
  const n = parseCriteria(criteria).length
  const maxTurns = Math.max(1, Math.min(200, parseInt(turns, 10) || 20))
  const canCreate = !!title.trim() && !busy && (!!project || !!to)
  const create = async () => {
    if (!canCreate) return
    setBusy(true)
    try {
      const g = await v3.createTask({
        project_id: project,
        title: title.trim(),
        kind: 'goal',
        criteria: parseCriteria(criteria).map((text) => ({ text, done: false })),
        session_id: to || undefined,
        autonomous: run && !!to ? true : undefined,
        max_turns: run && !!to ? maxTurns : undefined,
      })
      onClose()
      toast(run && to ? 'Goal set · its run started' : 'Goal set')
      rememberTasks([g as BoardTask])
      nav.task(g.id)
    } catch (e) {
      error(e)
      setBusy(false)
    }
  }
  const keys = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void create()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  return (
    <div className="v-overlay" onMouseDown={onClose} data-testid="new-goal-dialog">
      <div className="v-dialog v-newgoal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={keys}>
        <div className="v-dhead">
          <h3>New goal</h3>
          <NewModeToggle mode="goal" onMode={onMode} />
        </div>
        <input
          type="text"
          autoFocus
          className="v-ng-title"
          aria-label="Goal"
          data-testid="new-goal-title"
          placeholder="The outcome, e.g. “CI is green on main”"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              ;(e.currentTarget.form ?? document).querySelector<HTMLTextAreaElement>('[data-testid="new-goal-criteria"]')?.focus()
            }
          }}
        />
        <label className="v-ng-label" htmlFor="new-goal-criteria">
          Done when <span className="v-ng-hint">one criterion per line{n ? ` · ${n}` : ''}</span>
        </label>
        <textarea
          id="new-goal-criteria"
          data-testid="new-goal-criteria"
          className="v-ng-criteria"
          placeholder={'Tests pass\nThe PR is merged\n(optional: add them later on the goal)'}
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
        />
        <div className="v-rowf">
          Agent
          <select aria-label="Agent" data-testid="new-goal-agent" value={to} onChange={(e) => (setTo(e.target.value), e.target.value || setRun(false))}>
            <AgentOptions agents={agents} />
            <option value="">No agent yet</option>
          </select>
        </div>
        <div className="v-rowf v-ng-run">
          <label title={to ? 'minbox continues the agent whenever it is idle, until the criteria are met' : 'Pick an agent to run the goal'}>
            <input type="checkbox" data-testid="new-goal-run" checked={run} disabled={!to} onChange={(e) => setRun(e.target.checked)} /> Start the autonomous run now
          </label>
          {run && (
            <label>
              up to{' '}
              <input type="number" min={1} max={200} aria-label="Max turns" data-testid="new-goal-turns" value={turns} onChange={(e) => setTurns(e.target.value)} onBlur={() => setTurns(String(maxTurns))} /> turns
            </label>
          )}
        </div>
        <div className="v-foot">
          <span className="v-hide-phone">The agent ticks the criteria as it meets them; you can edit them on the goal. Esc closes.</span>
          <span className="v-sp" />
          <button type="button" className="v-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="v-btn pri" data-testid="new-goal-create" disabled={!canCreate} onClick={() => void create()} title={`Create (${isMac() ? '⌘↵' : 'Ctrl+Enter'})`}>
            Create goal
            <SendKey />
          </button>
        </div>
      </div>
    </div>
  )
}
