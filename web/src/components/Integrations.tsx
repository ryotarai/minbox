import { useCallback, useEffect, useState } from 'react'
import { api, type LinearStatus } from '../api'
import { IconLinear } from './icons'
import { useApp } from '../lib/app'
import { LinearExtraPrompt } from './LinearExtraPrompt'
import { SlackSection } from './SlackSettings'
import { Button, Segmented, Switch } from './ui'

// Settings › Integrations › Linear. minbox is an MCP client of Linear's remote MCP server; the
// login (OAuth) is done by the minbox server and its tokens never reach the browser or the agent.

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center gap-4 border-b border-[#1f1f24] py-1.5 [[data-theme=light]_&]:border-line">
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[14px]">{label}</span>
        {desc && <span className="text-[12.5px] text-subtle">{desc}</span>}
      </span>
      {children}
    </div>
  )
}

export function IntegrationsSection() {
  return (
    <div className="flex max-w-[720px] flex-col gap-7" data-testid="integrations">
      <LinearSection />
      <SlackSection />
    </div>
  )
}

function LinearSection() {
  const { settings, saveSettings, toast, error } = useApp()
  const [st, setSt] = useState<LinearStatus | null>(null)
  const [busy, setBusy] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const lin = settings.linear
  const [allowed, setAllowed] = useState(lin.allowed_authors)
  useEffect(() => setAllowed(lin.allowed_authors), [lin.allowed_authors])

  const load = useCallback(() => {
    api.linearStatus().then(setSt).catch(error)
  }, [error])
  useEffect(() => {
    load()
    window.addEventListener('minbox:linear', load)
    return () => window.removeEventListener('minbox:linear', load)
  }, [load])

  const connect = async () => {
    setBusy('connect')
    try {
      const { url } = await api.linearLogin()
      window.location.href = url // Linear's page; it sends the browser back to this minbox
    } catch (e) {
      setBusy('')
      toast(e instanceof Error ? e.message : String(e), { error: true })
    }
  }
  const disconnect = async () => {
    setBusy('disconnect')
    try {
      setSt(await api.linearDisconnect())
      setTestResult(null)
    } catch (e) {
      error(e)
    }
    setBusy('')
  }
  const test = async () => {
    setBusy('test')
    try {
      const r = await api.linearTest()
      setTestResult(r.ok ? { ok: true, text: r.user ? `Works: ${r.user.name || r.user.email}` : 'Works' } : { ok: false, text: r.error ?? 'failed' })
      load()
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
    setBusy('')
  }
  const save = (patch: Partial<typeof lin>) => saveSettings({ linear: { ...lin, ...patch } })

  const who = st?.user ? st.user.name || st.user.email : ''
  return (
    <section className="flex flex-col gap-3" data-testid="linear-section">
      <h2 className="m-0 flex items-center gap-1.5 text-[14px] font-[650] text-muted">
        <IconLinear size={15} />
        Linear
      </h2>
      <p className="m-0 text-[12.5px] text-subtle">
        Link a thread to a Linear issue (type ENG-123 or paste its URL in the thread header). minbox moves the issue to In Progress when work starts, keeps one progress comment up to date, and
        passes new comments on the issue to the agent with your next message. Issues of the workspace you log in to can be linked.
      </p>
      <Row
        label="Status"
        desc={
          st?.needs_login
            ? 'The login expired or was revoked. Connect again.'
            : st?.connected
              ? `Connected${who ? ` as ${who}` : ''}`
              : 'Not connected'
        }
      >
        <span data-testid="linear-status" className="text-[13px] text-fg2">
          {st == null ? '…' : st.connected ? 'Connected' : st.needs_login ? 'Login needed' : 'Not connected'}
        </span>
        {st?.connected ? (
          <>
            <Button data-testid="linear-test" onClick={test} disabled={busy !== ''}>
              Test
            </Button>
            <Button data-testid="linear-disconnect" variant="danger" onClick={disconnect} disabled={busy !== ''}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button data-testid="linear-connect" variant="primary" onClick={connect} disabled={busy !== '' || st == null}>
            Connect
          </Button>
        )}
      </Row>
      {testResult && (
        <div data-testid="linear-test-result" className={testResult.ok ? 'text-[13px] text-fg2' : 'text-[13px] text-danger'}>
          {testResult.text}
        </div>
      )}
      {st?.last_login_error && !st.connected && (
        <div data-testid="linear-login-error" className="text-[12.5px] text-danger">
          Last login attempt failed: {st.last_login_error}
        </div>
      )}
      {st?.last_error && !st.connected && <div className="text-[12.5px] text-danger">{st.last_error}</div>}
      {st?.rate_limited_for ? <div className="text-[12.5px] text-subtle">Linear asked minbox to slow down; it waits about {st.rate_limited_for} s.</div> : null}
      <Row label="Comments that reach the agent" desc="Comments by others are always shown in the thread; this decides which ones are passed to the agent. Default: everyone.">
        <Segmented
          value={lin.author_filter}
          onChange={(v) => save({ author_filter: v })}
          testidPrefix="linear-filter"
          options={[
            { value: 'everyone', label: 'Everyone' },
            { value: 'allow_list', label: 'Only these' },
          ]}
        />
      </Row>
      {lin.author_filter === 'allow_list' && (
        <label className="flex flex-col gap-1.5 text-[12.5px] text-subtle">
          Linear names, emails or ids (comma or line separated)
          <textarea
            data-testid="linear-allowed"
            value={allowed}
            onChange={(e) => setAllowed(e.target.value)}
            onBlur={() => allowed !== lin.allowed_authors && save({ allowed_authors: allowed })}
            rows={3}
            className="rounded-lg border border-linestrong bg-sunken px-3 py-2 text-[14px] text-fg outline-none focus:border-accent"
          />
        </label>
      )}
      <Row label="Show the agent's latest message in the progress comment" desc="Off: the comment has only the subject, the status and the time. The message may be private.">
        <Switch on={lin.include_body} onChange={(v) => save({ include_body: v })} label="Include message" />
      </Row>
      <Row label="Link to the thread in drafted issues" desc="Create Linear issue from a thread: end the description with a link to the minbox thread. Needs the public URL (Settings); off by default.">
        <Switch on={lin.thread_link} onChange={(v) => save({ thread_link: v })} label="Link to the thread" />
      </Row>
      <LinearExtraPrompt value={lin.draft_extra_prompt ?? ''} onSave={(v) => save({ draft_extra_prompt: v })} />
      <p className="m-0 text-[12px] text-subtle">
        minbox registers itself with Linear for this address: <span className="mono">{st?.redirect_uri ?? '…'}</span>. A different address (another hostname) needs its own login.
      </p>
    </section>
  )
}
