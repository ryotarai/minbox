import { useCallback, useEffect, useState } from 'react'
import { api, type NotifyDestination, type NotifyField, type NotifyType } from '../api'
import { useApp } from '../lib/app'
import { Button, Modal, Switch, cx } from './ui'

// Settings › Notifications: where minbox tells you about each new message from Claude (Slack
// incoming webhook first). A destination's form is built from the field schema its type
// publishes, so another type needs no UI code. Secrets are never shown again in full.

function ago(iso?: string | null): string {
  if (!iso) return ''
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (min < 1) return 'just now'
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`
}

const inputCls = 'h-10 rounded-lg border border-linestrong bg-sunken px-3 text-[14px] text-fg outline-none focus:border-accent'

export function NotificationsSection() {
  const { settings, error, toast, isPhone } = useApp()
  const [data, setData] = useState<{ types: NotifyType[]; destinations: NotifyDestination[] } | null>(null)
  const [form, setForm] = useState<{ edit?: NotifyDestination } | null>(null)
  const [removing, setRemoving] = useState<NotifyDestination | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string } | 'sending'>>({})
  const [url, setUrl] = useState(settings.public_url)
  useEffect(() => setUrl(settings.public_url), [settings.public_url])
  const load = useCallback(() => {
    api.notifications().then(setData).catch(error)
  }, [error])
  useEffect(() => {
    load()
    window.addEventListener('minbox:notifications', load)
    return () => window.removeEventListener('minbox:notifications', load)
  }, [load])

  const test = (d: NotifyDestination) => {
    setResults((r) => ({ ...r, [d.id]: 'sending' }))
    api
      .testNotification(d.id)
      .then((res) => setResults((r) => ({ ...r, [d.id]: { ok: res.ok, text: res.ok ? 'Test sent' : res.error || 'Failed' } })))
      .catch((e) => setResults((r) => ({ ...r, [d.id]: { ok: false, text: String(e?.message ?? e) } })))
      .finally(load)
  }

  return (
    <>
      <div className="-mt-4 flex items-center justify-end">
        <Button variant="primary" data-testid="notif-add" disabled={!data} onClick={() => setForm({})}>
          + Add destination
        </Button>
      </div>
      <p className="m-0 max-w-[680px] text-[13.5px] leading-[1.6] text-muted">
        Every new message from Claude is sent to the destinations below, whether or not a browser is open. Your own replies are not.
      </p>
      <div data-testid="notif-list" className="flex max-w-[860px] flex-col rounded-xl border border-line bg-surface">
        {!data && <span className="px-4 py-5 text-[13px] text-subtle">Loading…</span>}
        {data && data.destinations.length === 0 && (
          <span data-testid="notif-empty" className="px-4 py-5 text-[13px] text-subtle">
            No destinations yet. Add a Slack incoming webhook to get started.
          </span>
        )}
        {data?.destinations.map((d) => {
          const res = results[d.id]
          const failed = !!d.last_error
          const typeLabel = data.types.find((t) => t.id === d.type)?.label ?? d.type
          return (
            <div
              key={d.id}
              data-testid="notif-row"
              data-dest-id={d.id}
              className={cx('box-border flex min-h-16 gap-3.5 border-b border-[#1d1d22] px-4 py-3.5 last:border-b-0 [[data-theme=light]_&]:border-line', isPhone ? 'flex-col' : 'items-center')}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[14.5px] font-[650]" data-testid="notif-name">
                    {d.name}
                  </span>
                  <span className="rounded border border-linestrong px-1.5 text-[11px] leading-[17px] text-muted">{typeLabel}</span>
                </span>
                <span className="mono truncate text-[12px] text-muted" data-testid="notif-target">
                  {String(d.config.webhook_url ?? '')}
                </span>
                <span data-testid="notif-status" data-state={failed ? 'failed' : d.last_ok_at ? 'ok' : 'never'} className={cx('text-[12px]', failed ? 'text-danger' : 'text-subtle')}>
                  {failed ? `Failed ${ago(d.last_error_at)}: ${d.last_error}` : d.last_ok_at ? `Last sent ${ago(d.last_ok_at)}` : 'Nothing sent yet'}
                </span>
                {res && (
                  <span data-testid="notif-test-result" className={cx('text-[12px]', res !== 'sending' && !res.ok ? 'text-danger' : 'text-ok')}>
                    {res === 'sending' ? 'Sending…' : res.text}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" data-testid="notif-test" disabled={res === 'sending'} onClick={() => test(d)}>
                  Send test
                </Button>
                <Button size="sm" variant="quiet" data-testid="notif-edit" onClick={() => setForm({ edit: d })}>
                  Edit
                </Button>
                <Button size="sm" variant="quiet" data-testid="notif-delete" onClick={() => setRemoving(d)}>
                  Delete
                </Button>
                <Switch label={`Enable ${d.name}`} on={d.enabled} onChange={(v) => api.updateNotification(d.id, { enabled: v }).then(load).catch(error)} />
              </div>
            </div>
          )
        })}
      </div>

      <section className="flex max-w-[720px] flex-col gap-3">
        <h2 className="m-0 text-[14px] font-[650] text-muted">Link in notifications</h2>
        <p className="m-0 text-[13px] leading-[1.6] text-muted">
          The address you open minbox at from your phone or another machine, e.g. your Tailscale URL. With it, each notification has an “Open thread” link. Leave it empty for no link.
        </p>
        <div className="flex gap-2">
          <input
            data-testid="notif-public-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://my-mac.tail1234.ts.net"
            spellCheck={false}
            className={cx(inputCls, 'mono min-w-0 flex-1 text-[13.5px]')}
          />
          <Button
            variant="primary"
            size="lg"
            data-testid="notif-public-url-save"
            disabled={url.trim() === settings.public_url}
            onClick={() =>
              api
                .saveSettings({ public_url: url.trim() })
                .then(() => toast('Saved'))
                .catch(error)
            }
          >
            Save
          </Button>
        </div>
      </section>

      {form && data && (
        <DestinationForm
          types={data.types}
          edit={form.edit}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            load()
          }}
        />
      )}
      {removing && (
        <Modal label={`Delete ${removing.name}`} onClose={() => setRemoving(null)} className="flex w-[min(440px,100%)] flex-col gap-3 p-5">
          <h3 className="m-0 text-[16px] font-[650]">Delete {removing.name}?</h3>
          <p className="m-0 text-[13.5px] leading-[1.6] text-muted">Nothing more is sent there. The stored webhook URL is deleted.</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              data-testid="notif-delete-confirm"
              onClick={() => {
                const d = removing
                setRemoving(null)
                api
                  .deleteNotification(d.id)
                  .then(() => {
                    load()
                    toast(`Deleted ${d.name}`)
                  })
                  .catch(error)
              }}
            >
              Delete
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

function initialValues(t: NotifyType, edit?: NotifyDestination): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const f of t.fields) {
    if (f.kind === 'secret') v[f.key] = '' // never filled: empty keeps the stored one
    else v[f.key] = edit && f.key in edit.config ? edit.config[f.key] : (f.default ?? (f.kind === 'bool' ? false : ''))
  }
  return v
}

function DestinationForm({ types, edit, onClose, onSaved }: { types: NotifyType[]; edit?: NotifyDestination; onClose: () => void; onSaved: () => void }) {
  const { isPhone } = useApp()
  const [typeId, setTypeId] = useState(edit?.type ?? types[0].id)
  const type = types.find((t) => t.id === typeId) ?? types[0]
  const [name, setName] = useState(edit?.name ?? '')
  const [values, setValues] = useState(() => initialValues(type, edit))
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: unknown) => setValues((o) => ({ ...o, [k]: v }))
  const missing = type.fields.some((f) => f.required && f.kind !== 'bool' && !String(values[f.key] ?? '').trim() && !(edit && f.kind === 'secret'))

  const save = () => {
    setBusy(true)
    setProblem('')
    const config: Record<string, unknown> = {}
    for (const f of type.fields) {
      if (f.kind === 'secret' && !String(values[f.key]).trim()) continue
      config[f.key] = values[f.key]
    }
    const p = edit ? api.updateNotification(edit.id, { name: name.trim() || undefined, config }) : api.createNotification({ type: type.id, name: name.trim(), config })
    p.then(onSaved).catch((e) => {
      setBusy(false)
      setProblem(String(e?.message ?? e))
    })
  }

  return (
    <Modal label={edit ? 'Edit destination' : 'Add destination'} onClose={onClose} className={cx('flex w-[min(520px,100%)] flex-col gap-3.5 overflow-y-auto p-5', isPhone ? 'max-h-[88vh]' : 'max-h-[85vh]')}>
      <h3 className="m-0 text-[16px] font-[650]">{edit ? `Edit ${edit.name}` : 'Add destination'}</h3>
      <label className="flex flex-col gap-1.5 text-[13px] text-muted">
        Type
        <select
          data-testid="notif-type"
          value={typeId}
          disabled={!!edit}
          onChange={(e) => {
            const t = types.find((x) => x.id === e.target.value)!
            setTypeId(t.id)
            setValues(initialValues(t))
          }}
          className={cx(inputCls, 'disabled:opacity-60')}
        >
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-[13px] text-muted">
        Name
        <input data-testid="notif-form-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={type.label} className={inputCls} />
      </label>
      {type.fields.map((f) => (
        <FieldInput key={f.key} f={f} value={values[f.key]} onChange={(v) => set(f.key, v)} stored={edit ? String(edit.config[f.key] ?? '') : ''} />
      ))}
      {problem && (
        <span data-testid="notif-form-error" className="text-[13px] text-danger">
          {problem}
        </span>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" data-testid="notif-save" disabled={busy || missing} onClick={save}>
          {edit ? 'Save' : 'Add'}
        </Button>
      </div>
    </Modal>
  )
}

function FieldInput({ f, value, onChange, stored }: { f: NotifyField; value: unknown; onChange: (v: unknown) => void; stored: string }) {
  const testid = `notif-field-${f.key}`
  if (f.kind === 'bool') {
    return (
      <div className="flex items-center gap-4">
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="text-[14px]">{f.label}</span>
          {f.hint && <span className="text-[12.5px] text-subtle">{f.hint}</span>}
        </span>
        <span data-testid={testid}>
          <Switch label={f.label} on={!!value} onChange={onChange} />
        </span>
      </div>
    )
  }
  return (
    <label className="flex flex-col gap-1.5 text-[13px] text-muted">
      {f.label}
      {f.kind === 'select' ? (
        <select data-testid={testid} value={String(value)} onChange={(e) => onChange(e.target.value)} className={inputCls}>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          data-testid={testid}
          type={f.kind === 'secret' ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder={f.kind === 'secret' && stored ? `Kept: ${stored}` : f.placeholder}
          className={cx(inputCls, f.kind === 'secret' && 'mono text-[13px]')}
        />
      )}
      {f.hint && <span className="text-[12px] text-subtle">{f.hint}</span>}
    </label>
  )
}
