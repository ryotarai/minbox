import { useEffect, useState } from 'react'
import type { Message } from '../api'
import { cx } from './ui'

const COLLAPSE_LINES = 12

/** Is this reply text a "!" command? (A bare "!" and "\!" are plain messages; see docs/thread-commands.md.) */
export function commandOf(words: string): string | null {
  if (!words.startsWith('!')) return null
  const cmd = words.slice(1).trim()
  return cmd ? cmd : null
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** A person's "!" message: the command, its output (long output collapsed) and how it ended. */
export function CommandMessage({ m, phone, revealed }: { m: Message; phone?: boolean; revealed?: number }) {
  const c = m.command
  const [open, setOpen] = useState(false)
  // Asked to show this message (revealMessage): the whole output, not its first lines.
  useEffect(() => {
    if (revealed) setOpen(true)
  }, [revealed])
  if (!c) return null
  const running = c.state === 'running'
  const lines = c.output.replace(/\n$/, '').split('\n')
  const long = lines.length > COLLAPSE_LINES
  const shown = long && !open ? lines.slice(0, COLLAPSE_LINES).join('\n') : lines.join('\n')
  const status = running
    ? 'Running…'
    : c.error
      ? `Failed: ${c.error}`
      : c.timed_out
        ? 'Timed out after 60 s and was killed'
        : `Exit ${c.exit_code} · ${duration(c.duration_ms)}`
  const bad = !running && (c.error || c.timed_out || c.exit_code !== 0)
  return (
    <article data-testid="message" data-author="human" data-kind="command" data-message-id={m.id} className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-line2 bg-sunken px-3 py-2.5">
      <div className="flex items-center gap-2 text-[12px] text-subtle">
        <span className="font-semibold text-fg2">Command</span>
        <span className="min-w-0 flex-1 truncate" title={c.cwd}>
          in {c.cwd}
        </span>
        <span>{c.told ? 'Agent has the result' : running ? 'Agent gets the result when it ends' : 'Sending the result to the agent'}</span>
      </div>
      <pre data-testid="command-line" className={cx('m-0 whitespace-pre-wrap break-all font-mono text-fg', phone ? 'text-[13px]' : 'text-[12.5px]')}>
        <span className="text-subtle">$ </span>
        {c.command}
      </pre>
      {!running && c.output && (
        <pre data-testid="command-output" className={cx('m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-raised p-2 font-mono text-fg2', phone ? 'text-[12px]' : 'text-[12px]')}>
          {shown}
        </pre>
      )}
      {!running && long && (
        <button type="button" data-testid="command-toggle" onClick={() => setOpen(!open)} className="self-start border-0 bg-transparent p-0 text-[12px] text-accent">
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
      {!running && c.truncated && <span className="text-[12px] text-subtle">Output cut at 64 KB</span>}
      <span data-testid="command-status" className={cx('text-[12px]', bad ? 'text-danger' : 'text-subtle')}>
        {status}
      </span>
    </article>
  )
}
