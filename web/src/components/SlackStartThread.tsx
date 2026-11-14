import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type AgentKind, type IssueThreadRequest, type IssueThreadPreview, type ProjectSuggestion, type SlackThreadDetail } from '../api'
import { agentLabel, installedAgents, useAgents } from '../lib/agents'
import { useApp } from '../lib/app'
import { lastSlackProject, rememberSlackProject } from '../lib/slack'
import { Button, IconButton, Modal, cx } from './ui'

/**
 * Start a minbox thread from a Slack thread. The project is picked for you (a minbox thread already
 * started from this Slack thread, a project named like the channel, else the helper agent; "Picking
 * project…" never blocks the dialog and you can change it), the session defaults to that project's
 * main session, and the preview on the right is the text the agent receives first, composed by the
 * server (POST /api/slack/threads/{id}/thread/preview). Nothing is sent to Slack.
 */
export function SlackStartThreadDialog({ thread, onClose, onStarted }: { thread: SlackThreadDetail; onClose: () => void; onStarted: () => void }) {
  const { sessions, projects, navigate, error, isPhone, reloadSessions, reloadProjects } = useApp()
  const live = (projects ?? []).filter((p) => !p.archived_at)
  const [projectId, setProjectId] = useState(() => {
    const last = lastSlackProject()
    return live.find((p) => p.id === last)?.id ?? live[0]?.id ?? ''
  })
  const projectTouched = useRef(false)
  const sessionTouched = useRef(false)
  const [pick, setPick] = useState<'picking' | ProjectSuggestion>('picking')
  const project = live.find((p) => p.id === projectId)
  // The agents of the project's machine (its host).
  const agentsInfo = useAgents(project?.host_id)
  const installed = installedAgents(agentsInfo)

  // Sessions of the project that can take a thread; the main one first.
  const choices = useMemo(() => {
    const ok = (sessions ?? []).filter((s) => s.project_id === projectId && s.kind === 'claude' && !s.archived_at && s.status !== 'ended')
    return [...ok].sort((a, b) => Number(!!b.is_main) - Number(!!a.is_main) || a.name.localeCompare(b.name))
  }, [sessions, projectId])
  const mainOf = (pid: string) => {
    const p = live.find((x) => x.id === pid)
    return (sessions ?? []).find((s) => s.id === p?.main_session_id && s.kind === 'claude' && !s.archived_at && s.status !== 'ended')
  }
  // The default session: the project's main session; without a usable one, a new session.
  const [sessionPick, setSessionPick] = useState(() => mainOf(projectId)?.id ?? 'new')
  const [agentPick, setAgentPick] = useState<AgentKind | ''>('')
  const [sessionName, setSessionName] = useState('')
  const [subject, setSubject] = useState(`Slack: ${thread.label} · ${plainOf(thread)}`.slice(0, 100))
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<IssueThreadPreview | null>(null)
  const [previewErr, setPreviewErr] = useState('')
  const [showPreview, setShowPreview] = useState(!isPhone)

  // Changing the project re-defaults the session to that project's main session.
  const chooseProject = (id: string, byPerson: boolean) => {
    if (byPerson) projectTouched.current = true
    setProjectId(id)
    if (byPerson || !sessionTouched.current) {
      sessionTouched.current = false
      setSessionPick(mainOf(id)?.id ?? 'new')
    }
  }
  // The server's pick, asynchronously; it never overrides a project the person already chose.
  useEffect(() => {
    let alive = true
    api
      .slackProjectSuggestion(thread.id)
      .then((r) => {
        if (!alive) return
        setPick(r)
        if (r.project_id && !projectTouched.current && live.some((p) => p.id === r.project_id)) chooseProject(r.project_id, false)
      })
      .catch(() => alive && setPick({ project_id: '', source: 'none', reason: 'could not decide' }))
    return () => void (alive = false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id])
  // Sessions load after the dialog opens: when the default could not be the main session yet.
  useEffect(() => {
    if (!sessionTouched.current) setSessionPick(mainOf(projectId)?.id ?? 'new')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, projectId])

  const newSession = sessionPick === 'new'
  const req: IssueThreadRequest = useMemo(
    () => ({
      target: newSession ? { kind: 'new_session', project_id: projectId, agent: agentPick || undefined, name: sessionName.trim() || undefined } : { kind: 'session', session_id: sessionPick },
      subject: subject.trim() || undefined,
      instruction: instruction.trim() || undefined,
    }),
    [newSession, projectId, sessionPick, agentPick, sessionName, subject, instruction],
  )

  const seqNo = useRef(0)
  useEffect(() => {
    const n = ++seqNo.current
    if (!projectId && newSession) {
      setPreviewErr('Pick a project for the new session.')
      return
    }
    const t = setTimeout(() => {
      api
        .slackThreadPreview(thread.id, req)
        .then((p) => {
          if (n !== seqNo.current) return
          setPreview(p)
          setPreviewErr('')
        })
        .catch((e) => {
          if (n !== seqNo.current) return
          setPreview(null)
          setPreviewErr(e instanceof Error ? e.message : String(e))
        })
    }, 200)
    return () => clearTimeout(t)
  }, [thread.id, req, projectId, newSession])

  const starting = useRef(false)
  const start = async () => {
    if (starting.current || previewErr) return
    starting.current = true
    setBusy(true)
    try {
      const r = await api.slackStartThread(thread.id, req)
      if (projectId) rememberSlackProject(projectId)
      reloadSessions()
      reloadProjects()
      onStarted()
      onClose()
      navigate({ s: r.session.id, t: r.thread.id, f: null, view: 'main', tab: 'inbox' }, { push: true })
    } catch (e) {
      error(e)
    } finally {
      starting.current = false
      setBusy(false)
    }
  }

  const field = 'rounded-lg border border-linestrong bg-sunken px-2.5 text-fg outline-none focus:border-accent'
  const label = 'flex flex-col gap-1.5 text-[12.5px] text-muted'
  const auto =
    pick === 'picking' ? (
      <span data-testid="slack-pick-picking" className="text-[11.5px] text-subtle">
        Picking project…
      </span>
    ) : pick.project_id && pick.project_id === projectId ? (
      <span data-testid="slack-pick-note" data-source={pick.source} className="text-[11.5px] text-subtle">
        Auto-selected: {pick.reason}
      </span>
    ) : !pick.project_id ? (
      <span data-testid="slack-pick-note" data-source="none" className="text-[11.5px] text-subtle">
        Could not pick a project: showing your last used one.
      </span>
    ) : null

  return (
    <Modal label="Start minbox thread from Slack" onClose={onClose} top={!isPhone} className={cx('flex max-h-[calc(100vh-32px)] flex-col overflow-hidden rounded-2xl bg-raised', isPhone ? 'w-full' : 'w-[min(1020px,100%)]')}>
      <div className="flex h-14 shrink-0 items-center border-b border-line2 pl-[22px] pr-3">
        <h2 className="m-0 flex-1 truncate text-[16px] font-[650]">Start minbox thread from Slack</h2>
        <IconButton size={36} aria-label="Close (Esc)" onClick={onClose} className="text-[18px]">
          ×
        </IconButton>
      </div>
      <div data-testid="slack-thread-dialog" className={cx('flex min-h-0 flex-1 overflow-y-auto', isPhone ? 'flex-col' : 'flex-row')}>
        <div className={cx('flex flex-col gap-3 px-5 py-4', isPhone ? '' : 'w-[400px] shrink-0 border-r border-line2')}>
          <div className="rounded-[9px] border border-line2 bg-surface px-3 py-2 text-[12.5px] text-muted">
            <span className="font-semibold text-fg2">{thread.label}</span>
            <div className="mt-0.5 line-clamp-2 text-fg2">{plainOf(thread)}</div>
          </div>
          <label className={label}>
            <span className="flex items-center gap-2">
              Project {auto}
            </span>
            <select
              data-testid="slack-thread-project"
              value={projectId}
              onChange={(e) => chooseProject(e.target.value, true)}
              className={cx(field, 'h-[38px] text-[13px]')}
            >
              {live.length === 0 && <option value="">No projects yet</option>}
              {live.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.dir || '~'}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            Session
            <select
              data-testid="slack-thread-session"
              value={sessionPick}
              onChange={(e) => {
                sessionTouched.current = true
                setSessionPick(e.target.value)
              }}
              className={cx(field, 'h-[38px] text-[13px]')}
            >
              {choices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.is_main ? 'Main session' : 'Session'} · {s.name} · {agentLabel(agentsInfo, s.agent)}
                </option>
              ))}
              <option value="new">New session{project ? ` in ${project.name}` : ''}</option>
            </select>
            {!newSession && !choices.find((s) => s.id === sessionPick)?.is_main && (
              <span className="text-[11.5px] text-subtle">That session has one conversation across its threads: the new thread queues behind its current work.</span>
            )}
          </label>
          {newSession && installed.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] text-muted">Coding agent</span>
              <div role="radiogroup" aria-label="Coding agent" data-testid="slack-thread-agent" className="flex gap-2">
                {[{ kind: '' as const, label: 'Default' }, ...installed].map((a) => (
                  <button
                    key={a.kind || 'default'}
                    type="button"
                    role="radio"
                    aria-checked={agentPick === a.kind}
                    onClick={() => setAgentPick(a.kind as AgentKind | '')}
                    className={cx('h-9 rounded-[9px] border px-3 text-[13px] font-semibold', agentPick === a.kind ? 'border-wait/55 bg-wait/10' : 'border-line2 bg-transparent')}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {newSession && (
            <label className={label}>
              <span>
                Session name <span className="text-subtle">(optional)</span>
              </span>
              <input data-testid="slack-thread-session-name" value={sessionName} onChange={(e) => setSessionName(e.target.value)} className={cx(field, 'h-[38px] text-[13.5px]')} />
            </label>
          )}
          <label className={label}>
            Title
            <input data-testid="slack-thread-title" value={subject} onChange={(e) => setSubject(e.target.value)} className={cx(field, 'h-[38px] text-[13.5px]')} />
          </label>
          <label className={label}>
            <span>
              Your request <span className="text-subtle">(optional)</span>
            </span>
            <textarea
              data-testid="slack-thread-instruction"
              rows={3}
              value={instruction}
              placeholder="What should the agent do with this Slack thread?"
              onChange={(e) => setInstruction(e.target.value)}
              className={cx(field, 'resize-y py-2 text-[13.5px]')}
            />
          </label>
          {(preview?.warnings ?? []).map((w) => (
            <div key={w} data-testid="slack-thread-warning" className="rounded-[8px] border border-wait/40 bg-wait/10 px-2.5 py-1.5 text-[12px] text-fg2">
              {w}
            </div>
          ))}
        </div>
        <div className={cx('flex min-w-0 flex-1 flex-col gap-2 px-5 py-4', isPhone && 'border-t border-line2')}>
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <span className="font-semibold text-fg2">What the agent receives first</span>
            <span className="flex-1" />
            {preview && <span data-testid="slack-thread-bytes">{preview.bytes.toLocaleString()} B</span>}
            {isPhone && (
              <button type="button" onClick={() => setShowPreview((v) => !v)} className="border-0 bg-transparent text-accent">
                {showPreview ? 'Hide' : 'Show'}
              </button>
            )}
          </div>
          {previewErr && (
            <div role="alert" data-testid="slack-thread-preview-error" className="rounded-[8px] border border-danger/40 bg-dangerstrong/10 px-2.5 py-1.5 text-[12.5px] text-dangerfg">
              {previewErr}
            </div>
          )}
          {showPreview && (
            <pre
              data-testid="slack-thread-preview"
              tabIndex={0}
              className="mono m-0 max-h-[460px] min-h-[160px] flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[9px] border border-line2 bg-sunken p-3 text-[12px] leading-[1.5] text-fg2"
            >
              {preview ? preview.text : 'Composing…'}
            </pre>
          )}
        </div>
      </div>
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-t border-line2 px-5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-subtle">Nothing is sent to Slack. The Slack thread is marked as having a minbox thread.</span>
        <Button variant="quiet" className="h-[38px] text-[13.5px]" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" className="h-[38px] px-4 text-[13.5px]" data-testid="slack-thread-start" disabled={busy || !!previewErr || !preview} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Create and open'}
        </Button>
      </div>
    </Modal>
  )
}

/** The newest message of the thread as one line (the dialog's default title and its header). */
function plainOf(t: SlackThreadDetail): string {
  const last = t.messages[t.messages.length - 1]
  const div = document.createElement('div')
  div.innerHTML = last?.html ?? ''
  return (div.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}
