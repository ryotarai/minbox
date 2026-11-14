import { useEffect, useState } from 'react'
import { api, type AgentInfo, type AgentKind, type AgentsInfo } from '../api'

/**
 * The coding agents the server can run (GET /api/agents): which are installed on its machine and
 * the default for a new session. `null` until the first answer.
 */
export function useAgents(): AgentsInfo | null {
  const [info, setInfo] = useState<AgentsInfo | null>(null)
  useEffect(() => {
    let live = true
    api
      .agents()
      .then((a) => live && setInfo(a))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return info
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
