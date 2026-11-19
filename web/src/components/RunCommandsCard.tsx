import { useState } from 'react'
import type { Message, RunCommand } from '../api'
import { useApp } from '../lib/app'
import { v3 } from '../v3/data'
import { IconCheck, IconChevronDown, IconChevronRight, IconClose, IconTerminal } from './icons'
import { cx } from './ui'

// Commands an agent asks the person to run (send_message `commands`): each with Allow and Deny, plus
// Allow all and Deny all. Only what the server stored runs (the request names the commands by id);
// after a run the card shows the exit code and the output (collapsed), and says when the agent has
// the results.

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

type CardState = 'Waiting' | 'Running' | 'Done' | 'Denied'

function cardState(cs: RunCommand[]): CardState {
  if (cs.some((c) => c.state === 'pending')) return 'Waiting'
  if (cs.some((c) => c.state === 'allowed' || c.state === 'running')) return 'Running'
  if (cs.every((c) => c.state === 'denied')) return 'Denied'
  return 'Done'
}

function statusOf(c: RunCommand): { text: string; bad: boolean } {
  switch (c.state) {
    case 'pending':
      return { text: 'Waiting for you', bad: false }
    case 'allowed':
      return { text: 'Allowed · queued', bad: false }
    case 'running':
      return { text: 'Running…', bad: false }
    case 'denied':
      return { text: 'Denied · not run', bad: false }
  }
  if (c.error) return { text: c.error, bad: true }
  if (c.timed_out) return { text: 'Timed out and was killed', bad: true }
  return { text: `Exit ${c.exit_code} · ${duration(c.duration_ms)}`, bad: c.exit_code !== 0 }
}

export function RunCommandsCard({ m, phone }: { m: Message; phone?: boolean }) {
  const app = useApp()
  const [local, setLocal] = useState<{ from: RunCommand[]; cmds: RunCommand[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const server = m.run_commands ?? []
  // The answer of our own request until the stream brings a newer copy of the message.
  const cmds = local && local.from === server ? local.cmds : server
  if (cmds.length === 0) return null
  const pending = cmds.filter((c) => c.state === 'pending').map((c) => c.id)
  const state = cardState(cmds)
  const reported = cmds.every((c) => c.state === 'pending' || c.reported) && cmds.some((c) => c.reported)

  const decide = async (body: { allow?: string[]; deny?: string[] }) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await v3.decideCommands(m.id, body)
      setLocal({ from: server, cmds: r.run_commands })
    } catch (e) {
      app.error(e)
    } finally {
      setBusy(false)
    }
  }

  const frame = state === 'Waiting' ? 'border-wait/45 bg-card' : state === 'Denied' ? 'border-line bg-surface' : 'border-sel bg-carddim'
  const chip = {
    Waiting: 'border border-wait text-wait',
    Running: 'bg-work/14 text-work',
    Done: 'bg-ok/14 text-ok',
    Denied: 'bg-sel text-muted',
  }[state]
  const btn = phone ? 'min-h-11 px-4 text-[14px]' : 'h-[30px] px-2.5 text-[12.5px]'

  return (
    <div
      className={cx('mt-2 flex flex-col gap-2.5 rounded-xl border p-3.5', frame, phone && 'rounded-[14px]')}
      data-testid="run-commands"
      data-state={state}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <IconTerminal size={14} />
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
          {cmds.length === 1 ? 'Command to run' : `${cmds.length} commands to run`}
        </span>
        <span className="flex-1" />
        <span data-testid="run-commands-state" className={cx('box-border flex h-5 items-center rounded-full px-2 text-[11px] font-semibold', chip)}>
          {state}
        </span>
      </div>
      {state === 'Waiting' && <div className="text-[12.5px] text-muted">Runs on the agent’s host with sh -c, only what you allow, one after another. The output goes back to the agent.</div>}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {cmds.map((c) => (
          <CommandRow key={c.id} c={c} phone={phone} busy={busy} onAllow={() => void decide({ allow: [c.id] })} onDeny={() => void decide({ deny: [c.id] })} />
        ))}
      </ol>
      {pending.length > 0 && (
        <div className={cx('flex flex-wrap items-center gap-2', !phone && 'border-t border-sel pt-2')}>
          {pending.length > 1 && (
            <button
              type="button"
              className={cx('v-btn pri inline-flex items-center gap-1.5', phone && 'min-h-11 flex-1 justify-center text-[14px]')}
              data-testid="run-commands-allow-all"
              disabled={busy}
              onClick={() => void decide({ allow: pending })}
            >
              <IconCheck size={14} /> Allow all
            </button>
          )}
          {pending.length > 1 && (
            <button
              type="button"
              className={cx('rounded-[6px] border border-linestrong bg-transparent text-fg2 hover:bg-raised', btn, phone && 'flex-1')}
              data-testid="run-commands-deny-all"
              disabled={busy}
              onClick={() => void decide({ deny: pending })}
            >
              Deny all
            </button>
          )}
          <span className="flex-1" />
          <span className="text-[11.5px] text-subtle">{pending.length === 1 ? '1 waits for you' : `${pending.length} wait for you`}</span>
        </div>
      )}
      {reported && (
        <div className="text-[12px] text-subtle" data-testid="run-commands-reported">
          Results sent to the agent
        </div>
      )}
    </div>
  )
}

function CommandRow({ c, phone, busy, onAllow, onDeny }: { c: RunCommand; phone?: boolean; busy: boolean; onAllow: () => void; onDeny: () => void }) {
  const [open, setOpen] = useState(false)
  const st = statusOf(c)
  const done = c.state === 'done'
  const lines = c.output ? c.output.replace(/\n$/, '').split('\n').length : 0
  const btn = phone ? 'min-h-11 px-4 text-[14px] flex-1' : 'h-[28px] px-2.5 text-[12.5px]'
  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line2 bg-sunken px-3 py-2" data-testid="run-command" data-state={c.state} data-command-id={c.id}>
      {c.description && <div className={cx('font-[600] text-fg', phone ? 'text-[15px]' : 'text-[13.5px]')}>{c.description}</div>}
      <pre data-testid="run-command-line" className={cx('m-0 whitespace-pre-wrap break-all font-mono text-fg', phone ? 'text-[13px]' : 'text-[12.5px]', c.state === 'denied' && 'text-subtle line-through')}>
        <span className="text-subtle">$ </span>
        {c.command}
      </pre>
      <div className="min-w-0 break-all text-[11.5px] text-subtle" data-testid="run-command-cwd">
        in {c.cwd}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="run-command-status" className={cx('text-[12px]', st.bad ? 'text-danger' : c.state === 'done' ? 'text-ok' : 'text-subtle')}>
          {st.text}
        </span>
        {c.decided_by && c.state !== 'pending' && <span className="text-[11px] text-faint">by {c.decided_by}</span>}
        <span className="flex-1" />
        {done && c.output && (
          <button
            type="button"
            data-testid="run-command-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={cx('inline-flex items-center gap-1 border-0 bg-transparent p-0 text-[12px] text-accent', phone && 'min-h-10')}
          >
            {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
            {open ? 'Hide output' : `Output (${lines} line${lines === 1 ? '' : 's'})`}
          </button>
        )}
        {c.state === 'pending' && (
          <span className={cx('flex items-center gap-1.5', phone && 'w-full')}>
            <button
              type="button"
              data-testid="run-command-allow"
              disabled={busy}
              onClick={onAllow}
              className={cx('inline-flex items-center justify-center gap-1 rounded-[6px] border border-ok/50 bg-ok/10 font-semibold text-ok hover:bg-ok/20', btn)}
            >
              <IconCheck size={13} /> Allow
            </button>
            <button
              type="button"
              data-testid="run-command-deny"
              disabled={busy}
              onClick={onDeny}
              className={cx('inline-flex items-center justify-center gap-1 rounded-[6px] border border-linestrong bg-transparent text-fg2 hover:bg-raised', btn)}
            >
              <IconClose size={13} /> Deny
            </button>
          </span>
        )}
      </div>
      {done && !c.output && <span className="text-[12px] text-subtle">No output</span>}
      {done && c.output && open && (
        <pre data-testid="run-command-output" className="m-0 max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-raised p-2 font-mono text-[12px] text-fg2">
          {c.output}
        </pre>
      )}
      {done && c.truncated && open && <span className="text-[11.5px] text-subtle">The middle of the output was cut (64 KB kept)</span>}
    </li>
  )
}
