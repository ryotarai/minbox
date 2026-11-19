// Edit an agent's environment variables after it started (PATCH /api/sessions/{id}/env). The values
// never come back from the server: each current key shows masked, and a change only names what changes
// (set: replaced or added values; unset: removed keys), so every other variable keeps its stored value.
// The changes take effect when the agent starts again: "Save and restart" uses the usual restart
// (the conversation is resumed); after a plain Save a running agent shows the stale banner ("env").
import { useState } from 'react'
import { api, type Session } from '../api'
import { useApp } from '../lib/app'
import { parseEnvLines, reservedEnvKey } from '../lib/agentEnv'
import { Button, Modal, cx } from '../components/ui'

export function AgentEnvDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const { isPhone, reloadSessions, error } = useApp()
  const keys = session.env_keys ?? []
  // Per current key: a new value being typed (Replace value), or removed.
  const [replace, setReplace] = useState<Record<string, string>>({})
  const [removed, setRemoved] = useState<Record<string, boolean>>({})
  const [addText, setAddText] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const parsed = parseEnvLines(addText)
  const errors = [...parsed.errors]
  const ended = session.status === 'ended'

  const set: Record<string, string> = {}
  for (const k of keys) if (!removed[k] && k in replace) set[k] = replace[k]
  for (const k of parsed.keys) {
    if (k in set) errors.push(`${k} is in Add and has a new value above: keep one`)
    else set[k] = parsed.env[k]
  }
  const unset = keys.filter((k) => removed[k] && !(k in set))
  const changed = Object.keys(set).length > 0 || unset.length > 0
  const canSave = changed && errors.length === 0 && !busy

  const save = async (restart: boolean) => {
    if (!canSave) return
    setBusy(true)
    setSaveErr('')
    try {
      await api.patchSessionEnv(session.id, { set, unset })
    } catch (e) {
      // The server's message names keys, never values.
      setSaveErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
      return
    }
    onClose()
    if (restart) await api.restartSession(session.id).catch(error)
    reloadSessions()
  }

  const field = cx('mono min-w-0 rounded-md border bg-sunken px-2 text-fg outline-none border-linestrong focus:border-accent', isPhone ? 'h-11 text-[16px]' : 'h-8 text-[13px]')
  return (
    <Modal
      label="Environment variables"
      onClose={onClose}
      bottom={isPhone}
      className={cx('flex flex-col', isPhone ? 'max-h-[88vh] w-full rounded-b-none' : 'max-h-[86vh] w-[min(560px,100%)]')}
    >
      <div className="flex shrink-0 items-baseline gap-2 px-4 pb-1 pt-3.5">
        <h2 className="m-0 text-[15px] font-semibold">Environment variables</h2>
        <span className="min-w-0 truncate text-[12.5px] text-subtle" title={session.name}>
          {session.name}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-2 pt-1" data-testid="agent-env-dialog">
        {keys.length === 0 ? (
          <p className="m-0 text-[13px] text-muted" data-testid="agent-env-none">
            This agent has no environment variables of its own.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Current variables">
            {keys.map((k) => {
              const editing = k in replace
              const gone = !!removed[k]
              return (
                <li key={k} data-testid="agent-env-row" data-key={k} className={cx('flex flex-col gap-1.5 rounded-lg border border-line2 px-2.5 py-2', isPhone ? '' : 'sm:flex-row sm:items-center')}>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className={cx('mono min-w-0 break-all text-[13px]', gone && 'text-subtle line-through')}>{k}</span>
                    {!editing && !gone && (
                      <span className="mono text-[13px] text-subtle" aria-label="value hidden">
                        ••••
                      </span>
                    )}
                    {gone && <span className="text-[12px] text-dangerfg">removed on save</span>}
                    {reservedEnvKey(k) && <span className="text-[12px] text-subtle">(set by minbox: dropped on save)</span>}
                  </div>
                  {editing && !gone && (
                    <input
                      aria-label={`New value for ${k}`}
                      data-testid="agent-env-replace-input"
                      autoFocus
                      value={replace[k]}
                      onChange={(e) => setReplace((r) => ({ ...r, [k]: e.target.value }))}
                      placeholder="New value"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      className={cx(field, 'flex-1')}
                    />
                  )}
                  <div className="flex shrink-0 gap-1.5">
                    {!gone && (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="agent-env-replace"
                        onClick={() =>
                          setReplace((r) => {
                            const n = { ...r }
                            if (editing) delete n[k]
                            else n[k] = ''
                            return n
                          })
                        }
                      >
                        {editing ? 'Keep value' : 'Replace value'}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="quiet"
                      data-testid="agent-env-remove"
                      className={gone ? '' : 'text-dangerfg'}
                      onClick={() => setRemoved((r) => ({ ...r, [k]: !gone }))}
                    >
                      {gone ? 'Undo' : 'Remove'}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <label className={cx('flex flex-col gap-1.5 text-muted', isPhone ? 'text-[13px]' : 'text-[12.5px]')}>
          <span>Add</span>
          <textarea
            data-testid="agent-env-add"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            aria-invalid={errors.length > 0}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            rows={3}
            placeholder={'NEW_KEY=value\n# a comment'}
            className={cx(
              'mono min-w-0 resize-y rounded-lg border bg-sunken px-2.5 py-2 leading-[1.45] text-fg outline-none',
              isPhone ? 'rounded-[10px] text-[16px]' : 'text-[13px]',
              errors.length ? 'border-danger' : 'border-linestrong focus:border-accent',
            )}
          />
        </label>
        {errors.length > 0 && (
          <ul data-testid="agent-env-error" className="m-0 flex list-none flex-col gap-0.5 p-0 text-[12px] text-dangerfg">
            {errors.map((er) => (
              <li key={er}>{er}</li>
            ))}
          </ul>
        )}
        <p className="m-0 text-[12px] leading-snug text-subtle" data-testid="agent-env-help">
          One <span className="mono">KEY=value</span> per line; a key that exists already gets the new value. MINBOX_*, TERM, COLORTERM and OPENCODE_CONFIG_CONTENT are set by
          minbox. Values are never shown again. Variables you do not change keep their values.
        </p>
        <p className="m-0 text-[12.5px] leading-snug text-fg2" data-testid="agent-env-when">
          {ended
            ? 'The changes take effect when the agent is resumed.'
            : 'The changes take effect when the agent restarts. Save and restart resumes its conversation; with Save only, it keeps running with its current variables until its next restart.'}
        </p>
        {saveErr && (
          <p className="m-0 text-[12px] text-dangerfg" role="alert" data-testid="agent-env-save-error">
            {saveErr}
          </p>
        )}
      </div>
      <div className={cx('flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line2 px-4 pt-2.5', isPhone ? 'pb-[max(10px,env(safe-area-inset-bottom))]' : 'pb-3')}>
        <Button variant="quiet" onClick={onClose} className={isPhone ? 'h-11' : ''}>
          Cancel
        </Button>
        <Button variant="outline" data-testid="agent-env-save" disabled={!canSave} onClick={() => void save(false)} className={isPhone ? 'h-11' : ''}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="primary" data-testid="agent-env-save-restart" disabled={!canSave} onClick={() => void save(true)} className={isPhone ? 'h-11' : ''}>
          {ended ? 'Save and resume' : 'Save and restart'}
        </Button>
      </div>
    </Modal>
  )
}
