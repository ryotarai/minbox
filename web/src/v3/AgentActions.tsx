// The agent's actions in its stream header: the mod connection badge, Resume for an ended agent, and
// the session menu (rename, restart / resume, stop, archive, delete) that main had on
// the session rows and the terminal header. Also the agent rows' right-click / long-press menu.
import { useEffect, useRef, useState } from 'react'
import { api, type Session } from '../api'
import { useApp } from '../lib/app'
import { ModConnection } from '../components/ModConnection'
import { SessionMenu } from '../components/Sidebar'
import { IconMore } from '../components/icons'
import { MenuSep, Modal } from '../components/ui'
import { agentKindLabel } from '../lib/agents'

/** One element for StreamView's header row. */
export function AgentActions({ session }: { session: Session }) {
  const { error } = useApp()
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  return (
    <span className="v-agent-actions" data-testid="agent-actions" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flex: 'none' }}>
      <ModConnection session={session} />
      {session.status === 'ended' && (
        <button type="button" className="v-btn pri" data-testid="agent-resume" title="Resume: start the agent again with its conversation" onClick={() => api.restartSession(session.id).catch(error)}>
          Resume
        </button>
      )}
      <button
        type="button"
        className="v-btn"
        data-testid="agent-menu"
        aria-label="Agent actions"
        title={`Agent info and actions (${session.cwd}): rename, restart, stop, archive, delete`}
        style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 6px' }}
        onClick={(e) => setMenu(menu ? null : e.currentTarget)}
      >
        <IconMore size={14} />
      </button>
      <SessionMenu s={session} anchor={menu} onClose={() => setMenu(null)} onRename={() => setRenaming(true)} top={<AgentInfo session={session} />} />
      {renaming && <RenameAgentDialog session={session} onClose={() => setRenaming(false)} />}
    </span>
  )
}

/** The agent's facts at the top of its ⋯ menu: kind, folder and when it started (not in the Tasks pane). */
function AgentInfo({ session }: { session: Session }) {
  return (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-2.5 pb-1.5 pt-1 text-[12px]" data-testid="agent-info" style={{ maxWidth: 320 }}>
        <dt className="text-subtle">Kind</dt>
        <dd className="m-0">{agentKindLabel(session.agent)}</dd>
        <dt className="text-subtle">Folder</dt>
        <dd className="m-0 select-text break-all font-mono" title={session.cwd}>
          {session.cwd}
        </dd>
        <dt className="text-subtle">Started</dt>
        <dd className="m-0">{session.created_at ? new Date(session.created_at).toLocaleDateString() : '—'}</dd>
      </dl>
      <MenuSep />
    </>
  )
}

/** Rename an agent (its session). */
export function RenameAgentDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const { error, reloadSessions } = useApp()
  const [name, setName] = useState(session.name)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const save = () => {
    const v = name.trim()
    onClose()
    if (v && v !== session.name) api.renameSession(session.id, v).then(reloadSessions).catch(error)
  }
  return (
    <Modal label="Rename agent" onClose={onClose} className="w-[min(420px,100%)] p-4">
      <div className="mb-2 text-[14px] font-semibold">Rename agent</div>
      <input
        ref={input}
        aria-label="Session name"
        data-testid="rename-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          }
        }}
        className="h-8 w-full rounded-sm border border-accent bg-sunken px-2 text-[14px] text-fg outline-none"
      />
      <div className="pt-2 text-[11.5px] text-subtle">↵ save · Esc cancel</div>
    </Modal>
  )
}
