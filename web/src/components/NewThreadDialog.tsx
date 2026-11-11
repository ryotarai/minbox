import { useMemo, useRef, useState } from 'react'
import { api, type Session, type Thread } from '../api'
import { useApp } from '../lib/app'
import { CompletingTextarea } from './Compose'
import { commandOf } from './CommandMessage'
import { Button, Modal, cx } from './ui'

/**
 * "Start a new thread" from the reply box's send button (long press). The text is prefilled with
 * the box's draft; the thread goes to the same session unless another one of the project is picked.
 */
export function NewThreadDialog({
  session,
  initialText,
  onClose,
  onCreated,
}: {
  session: Session
  initialText: string
  onClose: () => void
  onCreated: (th: Thread, text: string) => void
}) {
  const { sessions, isPhone, reloadSessions, reloadProjects } = useApp()
  const [text, setText] = useState(initialText)
  const [to, setTo] = useState(session.id)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const targets = useMemo(
    () => (sessions ?? []).filter((s) => s.id === session.id || (s.project_id === session.project_id && s.kind !== 'shell' && !s.archived_at)),
    [sessions, session.id, session.project_id],
  )
  const isCmd = commandOf(text) !== null
  const create = async () => {
    if (busy || !text.trim() || isCmd) return
    setBusy(true)
    setErr('')
    try {
      const th = await api.createThread(to, '', text.trim())
      void reloadSessions()
      void reloadProjects()
      onCreated(th, text)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal label="New thread" onClose={onClose} bottom={isPhone} className={cx('flex max-h-[90vh] flex-col gap-3 overflow-y-auto p-4', isPhone ? 'w-full rounded-b-none' : 'w-[min(520px,100%)]')}>
      <div data-testid="new-thread-dialog" className="flex flex-col gap-3">
        <h2 className="m-0 text-[16px] font-[650]">New thread</h2>
        <CompletingTextarea
          ref={ref}
          testid="new-thread-body"
          dropUp={false}
          autoGrow={{ min: 96, max: 240 }}
          sessionId={to}
          value={text}
          onChange={setText}
          onSubmit={() => void create()}
          placeholder="What should Claude do in the new thread? (@ files)"
        />
        {isCmd && (
          <div role="alert" data-testid="new-thread-cmd" className="rounded-[8px] border border-wait/40 bg-wait/10 px-2.5 py-1.5 text-[12px] text-fg2">
            A new thread cannot start with a ! command. Start with \! to send the text instead.
          </div>
        )}
        <label className="flex flex-col gap-1.5 text-[12.5px] text-muted">
          Session
          <select
            data-testid="new-thread-session"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-[38px] rounded-lg border border-linestrong bg-sunken px-2.5 text-[13px] text-fg outline-none focus:border-accent"
          >
            {targets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.id === session.id ? ' (this session)' : ''}
              </option>
            ))}
          </select>
        </label>
        {err && (
          <div role="alert" data-testid="new-thread-error" className="rounded-[8px] border border-danger/40 bg-dangerstrong/10 px-2.5 py-1.5 text-[12.5px] text-dangerfg">
            {err}
          </div>
        )}
        <div className="flex justify-end gap-2.5">
          <Button variant="quiet" className="h-[38px] text-[13.5px]" data-testid="new-thread-cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="h-[38px] px-4 text-[13.5px]" data-testid="new-thread-create" disabled={busy || !text.trim() || isCmd} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
