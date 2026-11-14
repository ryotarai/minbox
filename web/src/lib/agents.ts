import { useEffect, useState } from 'react'
import { api, type AgentInfo, type AgentKind, type AgentsInfo } from '../api'

/**
 * The coding agents the server can run (GET /api/agents): which are installed on its machine (or,
 * with a hostId, on that host's machine) and the default for a new session there. `null` until the
 * first answer; the last answer stays while another host's is on its way.
 */
export function useAgents(hostId?: string): AgentsInfo | null {
  const [info, setInfo] = useState<AgentsInfo | null>(null)
  useEffect(() => {
    let live = true
    api
      .agents(hostId || undefined)
      .then((a) => live && setInfo(a))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [hostId])
  return info
}

/** One line on a host's agents for Settings: "Claude Code · Pi (node 22.19.0) · OpenCode 2.1.4". */
export function agentsSummary(agents: AgentInfo[] | null | undefined): string {
  if (!agents) return ''
  const usable = agents.filter((a) => a.installed && a.supported !== false)
  if (usable.length === 0) return 'No coding agent found'
  return usable.map((a) => (a.version ? `${a.label} ${a.kind === 'pi' ? `(${a.version})` : a.version}` : a.label)).join(' · ')
}

/** The agents a session can start with: the installed ones minbox can run (an OpenCode 1.x is installed but not supported). */
export function installedAgents(info: AgentsInfo | null): AgentInfo[] {
  return (info?.agents ?? []).filter((a) => a.installed && a.supported !== false)
}

/** The name of an agent kind when the server's list is not at hand. */
export function agentKindLabel(kind: string | undefined): string {
  return kind === 'pi' ? 'Pi' : kind === 'opencode' ? 'OpenCode' : kind && kind !== 'claude' ? kind : 'Claude Code'
}

export function agentLabel(info: AgentsInfo | null, kind: AgentKind | string | undefined): string {
  return info?.agents.find((a) => a.kind === (kind || 'claude'))?.label ?? agentKindLabel(kind)
}
