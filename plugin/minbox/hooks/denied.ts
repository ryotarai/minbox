/**
 * Denied shell commands: a shell command the agent tried to run and could not, because it was denied
 * (a permission rule, the person rejecting the prompt, the mode, a hook or plugin blocking it). Each
 * integration reports one as it happens (POST /api/agent/denied-commands), and the reply area offers
 * it as "Run yourself: !command". Shared by the Claude Code mod, Pi's extension and OpenCode's plugin.
 * See docs/thread-commands.md ("Run yourself").
 */

/** The longest command reported (the server offers at most 500 characters). */
export const DENIED_MAX = 4000

/** A denial as the integrations post it. */
export type DeniedReport = { command: string; reason: string; thread_id?: string; at: string }

/** The command as compared: trimmed. */
export function normCommand(command: unknown): string {
  return typeof command === 'string' ? command.trim() : ''
}

/**
 * How Claude Code words a tool call that never ran because it was refused (the model reads this as the
 * tool's error): the person rejecting the permission prompt, a deny rule, a mode that cannot ask, the
 * auto mode's classifier. Anchored at the start, so a command's own output (`Permission denied` from a
 * file) does not count.
 */
const CLAUDE_REFUSALS: RegExp[] = [
  /^The user doesn't want to proceed with this tool use\b/,
  /^The user doesn't want to take this action right now\b/,
  /^Permission to use \S+(?: with command [\s\S]*?)? has been denied\b/,
  /^Permission for this action has been denied\b/,
  /^Permission to use \S+ has been denied\b/,
]

/** The reason a Claude Code tool result shows a refused call (a deny, or an error worded as one), or null. */
export function claudeRefusal(res: unknown): string | null {
  const r = res as { deny?: unknown; isError?: unknown; text?: unknown } | null
  if (!r || typeof r !== 'object') return null
  if (typeof r.deny === 'string') return r.deny || 'denied'
  if (r.isError !== true || typeof r.text !== 'string') return null
  const text = r.text.trim()
  return CLAUDE_REFUSALS.some((re) => re.test(text)) ? text : null
}

/** A Claude Code tool result of a command that ran without error. */
export function claudeRanOk(res: unknown): boolean {
  const r = res as { deny?: unknown; isError?: unknown; result?: unknown } | null
  return !!r && typeof r === 'object' && r.deny === undefined && r.isError !== true
}

/** A short reason for the record: its first line, at most 300 characters. */
export function shortReason(reason: string): string {
  const line = reason.trim().split('\n')[0] ?? ''
  return line.length > 300 ? line.slice(0, 300) + '…' : line
}

/**
 * Pi: a `bash` call that ended in error without running (`tool_execution_end` with no `durationMs`),
 * for a reason other than an abort, an unknown tool or bad arguments, was blocked by a `tool_call`
 * handler (an extension). Returns the reason, or null.
 */
export function piBlocked(e: { isError?: unknown; durationMs?: unknown; result?: any }): string | null {
  if (e.isError !== true || typeof e.durationMs === 'number') return null
  const content = Array.isArray(e.result?.content) ? e.result.content : []
  const text = content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n')
    .trim()
  if (/^(Operation aborted|Tool \S+ not found|Invalid arguments for tool|Validation failed)/.test(text)) return null
  return text || 'Tool execution was blocked'
}
