import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type AgentKind, type ForkPreview, type ForkRequest, type Message, type Thread } from '../api'
import { agentLabel, installedAgents, useAgents } from '../lib/agents'
import { useApp } from '../lib/app'
import { Button, IconButton, Modal, cx } from './ui'
import { IconClose } from './icons'

type Dest = 'same' | 'new' | 'other'

/** The first line of a message, for the new thread's title. */
function firstLineOf(text: string): string {
  const line = text
    .trim()
    .split('\n')[0]!
    .replace(/^[#>*\-\s]+/, '')
  return line.replace(/\s+/g, ' ').slice(0, 100)
}

export function messageText(m: Message): string {
  return m.author === 'user' ? m.words || m.body : m.body
}

/**
 * Start a new thread from one message ("Start new thread from here"). The agent cannot copy its
 * conversation, so it is handed the context: the preview on the right is the real text the new
 * agent receives first (composed by the server, POST /api/threads/{id}/fork/preview).
 */
export function ForkDialog({ thread, message, seq, onClose }: { thread: Thread; message: Message; seq: number; onClose: () => void }) {
  const { sessions, projects, navigate, error, isPhone, reloadSessions, reloadProjects } = useApp()
  const parent = sessions?.find((s) => s.id === thread.session_id)
  const sameOk = !!parent && !parent.archived_at && parent.status !== 'ended'
  const [dest, setDest] = useState<Dest>(sameOk ? 'same' : 'new')
  const [projectId, setProjectId] = useState(thread.project_id ?? projects?.[0]?.id ?? '')
  // The agents of the chosen project's machine (its host).
  const agentsInfo = useAgents(projects?.find((p) => p.id === projectId)?.host_id)
  const installed = installedAgents(agentsInfo)
  const [agentPick, setAgentPick] = useState<AgentKind | ''>('')
  const others = useMemo(() => (sessions ?? []).filter((s) => s.kind === 'claude' && !s.archived_at && s.status !== 'ended' && s.id !== thread.session_id), [sessions, thread.session_id])
  const [otherId, setOtherId] = useState('')
  useEffect(() => {
    if (!otherId && others[0]) setOtherId(others[0].id)
  }, [others, otherId])
  const [sessionName, setSessionName] = useState('')
  const [subject, setSubject] = useState(() => firstLineOf(messageText(message)) || `Fork of ${thread.subject}`)
  const [withBefore, setWithBefore] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<ForkPreview | null>(null)
  const [previewErr, setPreviewErr] = useState('')
  const [showPreview, setShowPreview] = useState(true)

  const req: ForkRequest = useMemo(
    () => ({
      message_id: message.id,
      target:
        dest === 'same'
          ? { kind: 'session', session_id: thread.session_id }
          : dest === 'other'
            ? { kind: 'session', session_id: otherId }
            : { kind: 'new_session', project_id: projectId, agent: agentPick || undefined, name: sessionName.trim() || undefined },
      before_n: withBefore ? 3 : 0,
      subject: subject.trim() || undefined,
      instruction: instruction.trim() || undefined,
    }),
    [dest, thread.session_id, otherId, projectId, agentPick, sessionName, withBefore, subject, instruction, message.id],
  )

  // The preview follows the form, a beat after the last change.
  const seqNo = useRef(0)
  useEffect(() => {
    const n = ++seqNo.current
    const t = setTimeout(() => {
      api
        .forkPreview(thread.id, req)
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
  }, [thread.id, req])

  const starting = useRef(false)
  const start = async () => {
    if (starting.current || previewErr) return
    starting.current = true
    setBusy(true)
    try {
      const r = await api.fork(thread.id, req)
      reloadSessions()
      reloadProjects()
      onClose()
      navigate({ s: r.session.id, t: r.thread.id, f: null, view: 'main', tab: 'inbox' })
    } catch (e) {
      error(e)
    } finally {
      starting.current = false
      setBusy(false)
    }
  }

  const radio = (id: Dest, label: string, hint: string, disabled?: boolean) => (
    <button
      type="button"
      role="radio"
      aria-checked={dest === id}
      disabled={disabled}
      data-testid={`fork-dest-${id}`}
      onClick={() => setDest(id)}
      className={cx('flex min-h-11 flex-1 flex-col items-start justify-center rounded-[9px] border px-3 py-1.5 text-left disabled:opacity-45', dest === id ? 'border-wait/55 bg-wait/10' : 'border-line2 bg-transparent')}
    >
      <span className="text-[13px] font-semibold">{label}</span>
      <span className="text-[11.5px] text-subtle">{hint}</span>
    </button>
  )
  const field = 'rounded-lg border border-linestrong bg-sunken px-2.5 text-fg outline-none focus:border-accent'
  const label = 'flex flex-col gap-1.5 text-[12.5px] text-muted'

  return (
    <Modal label="Start new thread from here" onClose={onClose} top={!isPhone} className={cx('flex max-h-[calc(100vh-32px)] flex-col overflow-hidden rounded-2xl bg-raised', isPhone ? 'w-full' : 'w-[min(1020px,100%)]')}>
      <div className="flex h-14 shrink-0 items-center border-b border-line2 pl-[22px] pr-3">
        <h2 className="m-0 flex-1 text-[16px] font-[650]">Start new thread from here</h2>
        <IconButton size={36} aria-label="Close (Esc)" onClick={onClose}>
          <IconClose size={18} />
        </IconButton>
      </div>
      <div data-testid="fork-dialog" className={cx('flex min-h-0 flex-1 overflow-y-auto', isPhone ? 'flex-col' : 'flex-row')}>
        <div className={cx('flex flex-col gap-3 px-5 py-4', isPhone ? '' : 'w-[400px] shrink-0 border-r border-line2')}>
          <div className="rounded-[9px] border border-line2 bg-surface px-3 py-2 text-[12.5px] text-muted" data-testid="fork-source">
            <span className="font-semibold text-fg2">#{seq}</span> · {message.author === 'agent' ? 'Claude' : 'You'} · {thread.subject}
            <div className="mt-0.5 line-clamp-2 text-fg2">{messageText(message).replace(/:::[a-z-]*/g, '').slice(0, 240)}</div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] text-muted">Where</span>
            <div role="radiogroup" aria-label="Where" className="flex gap-2">
              {radio('same', 'This session', sameOk ? 'shares its conversation' : 'not available (ended)', !sameOk)}
              {radio('new', 'New session', 'clean start')}
              {radio('other', 'Another session', 'an existing one', others.length === 0)}
            </div>
          </div>
          {dest === 'new' && (
            <>
              <label className={label}>
                Project
                <select data-testid="fork-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={cx(field, 'h-[38px] text-[13px]')}>
                  {(projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.dir || '~'}
                    </option>
                  ))}
                </select>
              </label>
              {installed.length > 1 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] text-muted">Coding agent</span>
                  <div role="radiogroup" aria-label="Coding agent" data-testid="fork-agent" className="flex gap-2">
                    {[{ kind: '' as const, label: 'Default' }, ...installed].map((a) => (
                      <button
                        key={a.kind || 'default'}
                        type="button"
                        role="radio"
                        aria-checked={agentPick === a.kind}
                        data-testid="fork-agent-option"
                        data-agent={a.kind}
                        onClick={() => setAgentPick(a.kind as AgentKind | '')}
                        className={cx('h-9 rounded-[9px] border px-3 text-[13px] font-semibold', agentPick === a.kind ? 'border-wait/55 bg-wait/10' : 'border-line2 bg-transparent')}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <label className={label}>
                <span>
                  Session name <span className="text-subtle">(optional)</span>
                </span>
                <input data-testid="fork-session-name" value={sessionName} onChange={(e) => setSessionName(e.target.value)} className={cx(field, 'h-[38px] text-[13.5px]')} />
              </label>
            </>
          )}
          {dest === 'other' && (
            <label className={label}>
              Session
              <select data-testid="fork-session" value={otherId} onChange={(e) => setOtherId(e.target.value)} className={cx(field, 'h-[38px] text-[13px]')}>
                {others.map((s) => (
                  <option key={s.id} value={s.id}>
                    {projects?.find((p) => p.id === s.project_id)?.name ?? ''} / {s.name} · {agentLabel(agentsInfo, s.agent)}
                  </option>
                ))}
              </select>
              <span className="text-[11.5px] text-subtle">That session has one conversation across its threads: the new thread queues behind its current work.</span>
            </label>
          )}
          <label className={label}>
            Title
            <input data-testid="fork-title" value={subject} onChange={(e) => setSubject(e.target.value)} className={cx(field, 'h-[38px] text-[13.5px]')} />
          </label>
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <input type="checkbox" data-testid="fork-before" checked={withBefore} onChange={(e) => setWithBefore(e.target.checked)} />
            Also carry the 3 messages before it
          </label>
          <label className={label}>
            <span>
              Your request <span className="text-subtle">(optional)</span>
            </span>
            <textarea
              data-testid="fork-instruction"
              rows={3}
              value={instruction}
              placeholder="What should the new thread do with this?"
              onChange={(e) => setInstruction(e.target.value)}
              className={cx(field, 'resize-y py-2 text-[13.5px]')}
            />
          </label>
          {(preview?.warnings ?? []).map((w) => (
            <div key={w} data-testid="fork-warning" className="rounded-[8px] border border-wait/40 bg-wait/10 px-2.5 py-1.5 text-[12px] text-fg2">
              {w}
            </div>
          ))}
        </div>
        <div className={cx('flex min-w-0 flex-1 flex-col gap-2 px-5 py-4', isPhone && 'border-t border-line2')}>
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <span className="font-semibold text-fg2">What the new agent receives first</span>
            <span className="flex-1" />
            {preview && <span data-testid="fork-bytes">{preview.bytes.toLocaleString()} B</span>}
            {isPhone && (
              <button type="button" onClick={() => setShowPreview((v) => !v)} className="border-0 bg-transparent text-accent">
                {showPreview ? 'Hide' : 'Show'}
              </button>
            )}
          </div>
          {previewErr && (
            <div role="alert" data-testid="fork-preview-error" className="rounded-[8px] border border-danger/40 bg-dangerstrong/10 px-2.5 py-1.5 text-[12.5px] text-dangerfg">
              {previewErr}
            </div>
          )}
          {showPreview && (
            <pre
              data-testid="fork-preview"
              tabIndex={0}
              className="mono m-0 max-h-[460px] min-h-[160px] flex-1 overflow-auto whitespace-pre-wrap break-words rounded-[9px] border border-line2 bg-sunken p-3 text-[12px] leading-[1.5] text-fg2"
            >
              {preview ? preview.text : 'Composing…'}
            </pre>
          )}
        </div>
      </div>
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-t border-line2 px-5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-subtle">The source thread is not changed; it gets a marker under this message.</span>
        <Button variant="quiet" className="h-[38px] text-[13.5px]" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" className="h-[38px] px-4 text-[13.5px]" data-testid="fork-start" disabled={busy || !!previewErr || !preview} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Create and open'}
        </Button>
      </div>
    </Modal>
  )
}
