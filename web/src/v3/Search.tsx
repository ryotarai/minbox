// Search: "where was that said?" Tasks and messages across every agent, as you type.
import { useEffect, useRef, useState } from 'react'
import { useSelectedProject } from '../lib/projects'
import { hhmm, short, v3, STATUS_LABEL, type SearchResult } from './data'
import { useApp } from '../lib/app'
import { BackButton, StatusDot, TaskLinks, agentName, useNav, useSessionsById } from './parts'
import { IconGoal } from '../components/icons'

function Hl({ s, q }: { s: string; q: string }) {
  const i = q ? s.toLowerCase().indexOf(q.toLowerCase()) : -1
  if (i < 0) return <>{short(s, 140)}</>
  const st = Math.max(0, i - 50)
  return (
    <>
      {st ? '…' : ''}
      {s.slice(st, i)}
      <mark>{s.slice(i, i + q.length)}</mark>
      {short(s.slice(i + q.length), 90)}
    </>
  )
}

export function SearchView() {
  const { id: project } = useSelectedProject()
  const byId = useSessionsById()
  const nav = useNav()
  const { goBack } = useApp()
  const [q, setQ] = useState('')
  const [res, setRes] = useState<SearchResult | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    const qq = q.trim()
    if (!qq) {
      setRes(null)
      return
    }
    const t = setTimeout(() => void v3.search(qq, project).then(setRes).catch(() => {}), 150)
    return () => clearTimeout(t)
  }, [q, project])
  const qq = q.trim()
  return (
    <div className="v-col" data-testid="search-view">
      <div className="v-head">
        <div className="v-r1">
          <BackButton />
          <h1>Search</h1>
        </div>
      </div>
      <div className="v-search">
        <input
          ref={input}
          data-testid="search-input"
          placeholder="Search tasks and messages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              goBack()
            }
          }}
        />
      </div>
      <div className="v-scroll" style={{ background: 'var(--mb-surface)' }}>
        {!res && <div className="v-empty">Type to search tasks and messages across all agents{project ? ' of this project' : ''}.</div>}
        {res && (
          <>
            <div className="v-sec" style={{ padding: '0 18px' }}>
              TASKS <span className="v-x">{res.tasks.length}</span>
            </div>
            {res.tasks.map((t) => (
              <button type="button" key={t.id} className="v-res" data-testid="search-task" onClick={() => nav.task(t.id)}>
                <div>
                  <StatusDot t={{ ...t, needs_you: t.status === 'needs_you' }} /> {t.kind === 'goal' && <IconGoal size={14} className="v-goal" />}
                  <Hl s={t.title} q={qq} />
                </div>
                <div className="v-k">
                  {STATUS_LABEL[t.status]} · {t.agents.map((a) => agentName(byId, a.session_id)).join(', ')}
                </div>
              </button>
            ))}
            <div className="v-sec" style={{ padding: '0 18px' }}>
              MESSAGES <span className="v-x">{res.messages.length}</span>
            </div>
            {res.messages.map((m) => (
              <button type="button" key={m.id} className="v-res" data-testid="search-message" onClick={() => nav.agent(m.session_id, m.id)}>
                <div>
                  <Hl s={m.text.replace(/\s+/g, ' ')} q={qq} />
                </div>
                <div className="v-k">
                  {m.author === 'user' ? 'You → ' : ''}
                  {agentName(byId, m.session_id)} · {new Date(m.created_at).toLocaleDateString()} {hhmm(m.created_at)} <TaskLinks tasks={m.tasks} />
                </div>
              </button>
            ))}
            {!res.tasks.length && !res.messages.length && <div className="v-empty">Nothing matches “{qq}”.</div>}
          </>
        )}
      </div>
    </div>
  )
}
