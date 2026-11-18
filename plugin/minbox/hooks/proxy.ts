// The pieces the three thin integrations share (the Claude Code mod, the Pi extension, the OpenCode
// plugin): what they need to talk mod protocol 1 with the server (docs/mod-protocol.md). No wording
// and no decisions here: the server sends the text the agent reads. Self-contained (no imports), so
// every runtime loads it.

/** The mod protocol this integration speaks; the server keeps serving older ones. */
export const PROTOCOL = 1

/** One tool as the server defines it (GET /api/agent/tools). */
export type ToolDef = { name: string; label?: string; description: string; input_schema: Record<string, unknown>; deferred?: boolean }

/** A refusal of a host tool's call: a shell command matching one of the patterns, or any call without patterns. */
export type Guard = { tools: string[]; patterns?: string[]; deny: string; main_only?: boolean }

/** The server's tool set for this session. */
export type Manifest = { protocol: number; version: string; tools: ToolDef[]; guards: Guard[] }

/** A pending message of the poll (?proto=1): its id, whether it is urgent, and the text to inject. */
export type PendingItem = { id: string; urgent?: boolean; text: string; thread_id?: string; [k: string]: unknown }

/** Parses the server file's JSON ({ url }). */
export function serverUrlOf(text: string | null | undefined): string | null {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    return typeof v?.url === 'string' && /^https?:\/\//.test(v.url) ? v.url.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

/** A manifest as the server answered it, or null when it is not one. */
export function manifestOf(v: any): Manifest | null {
  if (!v || typeof v !== 'object' || !Array.isArray(v.tools) || typeof v.version !== 'string') return null
  const tools = v.tools.filter((t: any) => t && typeof t.name === 'string' && typeof t.description === 'string')
  const guards = Array.isArray(v.guards) ? v.guards.filter((g: any) => g && Array.isArray(g.tools) && typeof g.deny === 'string') : []
  return { protocol: Number(v.protocol) || 0, version: v.version, tools, guards }
}

/** The pending poll's answer (?proto=1): its items and how several are joined; null when it is not one. */
export function pendingOf(v: any): { items: PendingItem[]; joiner: string } | null {
  if (!v || typeof v !== 'object' || !Array.isArray(v.items)) return null
  const items = v.items.filter((p: any) => p && typeof p.id === 'string' && typeof p.text === 'string')
  return { items, joiner: typeof v.joiner === 'string' ? v.joiner : '\n\n' }
}

const compiled = new Map<string, RegExp | null>()

function regex(source: string): RegExp | null {
  if (!compiled.has(source)) {
    let re: RegExp | null = null
    try {
      re = new RegExp(source)
    } catch {
      re = null // a pattern this runtime cannot read refuses nothing
    }
    compiled.set(source, re)
  }
  return compiled.get(source)!
}

/**
 * The refusal of a call of the host's own tool `tool`, by the server's guards, or null. `subject` is
 * what the patterns are matched against (a shell command; several for OpenCode's permission
 * resources); `main` says the call is in the session minbox started.
 */
export function guardDeny(guards: Guard[] | undefined, tool: string, subject: string | string[], main = true): string | null {
  const subjects = (Array.isArray(subject) ? subject : [subject]).filter((s) => typeof s === 'string')
  for (const g of guards ?? []) {
    if (!g.tools.includes(tool) || (g.main_only && !main)) continue
    if (!g.patterns || g.patterns.length === 0) return g.deny
    if (g.patterns.some((p) => subjects.some((s) => regex(p)?.test(s)))) return g.deny
  }
  return null
}

/** The tool call's arguments: the call's input without the keys the host adds. */
export function argsOf(e: Record<string, unknown> | null | undefined, hostKeys: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e ?? {})) if (!hostKeys.includes(k)) out[k] = v
  return out
}
