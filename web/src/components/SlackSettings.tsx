import { useCallback, useEffect, useState } from 'react'
import { api, type SlackBackend, type SlackStatus, type SlackTestResult } from '../api'
import { useApp } from '../lib/app'
import { IconSlack } from './icons'
import { Button } from './ui'

// Settings › Integrations › Slack (personal): the person's own Slack USER token (xoxp-…) lets the
// Slack screen list the threads and DMs that need their reply. Read-only; the token stays on the
// server. Separate from the bot-token notification destination. See docs/slack-personal.md.

function manifest(backend: 'rts' | 'legacy'): string {
  const search = backend === 'rts' ? ['search:read.public', 'search:read.private', 'search:read.im'] : ['search:read']
  return `display_information:
  name: minbox (personal, read-only)
  description: Lets minbox list the Slack threads that need my reply. Reads only; never posts.
oauth_config:
  scopes:
    user:
${search.map((s) => `      - ${s}`).join('\n')}
      - channels:history
      - groups:history
      - im:history
      - users:read
      - im:read   # optional: unread dots for DMs
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
  interactivity:
    is_enabled: false
`
}

function CopyButton({ text, testid }: { text: string; testid: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size="sm"
      data-testid={testid}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </Button>
  )
}

function Setup() {
  const [flavor, setFlavor] = useState<'rts' | 'legacy'>('rts')
  const text = manifest(flavor)
  return (
    <details data-testid="slack-setup" className="rounded-[10px] border border-line2 bg-surface px-3 py-2 text-[12.5px] text-muted">
      <summary className="cursor-pointer font-semibold text-fg2">Setup: create your own Slack app (about 5 minutes)</summary>
      <ol className="mb-2 mt-2 list-decimal pl-5">
        <li>
          Open <span className="mono">api.slack.com/apps</span> → Create New App → From an app manifest → pick your workspace.
        </li>
        <li>Paste the manifest below (it asks for read-only user scopes: nothing is posted, nothing is marked read).</li>
        <li>Install App → Install to Workspace (a workspace admin may need to approve it first).</li>
        <li>
          Open OAuth &amp; Permissions and copy the <b>User OAuth Token</b> (starts with <span className="mono">xoxp-</span>), not the Bot token. Paste it above and press Connect.
        </li>
        <li>Press Test: it names any scope that is missing and says whether the search works.</li>
      </ol>
      <div className="mb-1.5 flex items-center gap-2">
        <span>Search flavour:</span>
        <select data-testid="slack-manifest-flavor" value={flavor} onChange={(e) => setFlavor(e.target.value as 'rts' | 'legacy')} className="h-8 rounded-md border border-linestrong bg-sunken px-2 text-[12.5px] text-fg">
          <option value="rts">Real-time Search (recommended)</option>
          <option value="legacy">Legacy search.messages</option>
        </select>
        <span className="flex-1" />
        <CopyButton text={text} testid="slack-manifest-copy" />
      </div>
      <pre data-testid="slack-manifest" tabIndex={0} className="mono m-0 overflow-auto rounded-md border border-line2 bg-sunken p-2.5 text-[12px] leading-[1.5] text-fg2">
        {text}
      </pre>
      <p className="mb-0 mt-2 text-subtle">
        Do not turn on token rotation (rotating tokens expire after 12 hours). The Real-time Search scopes and whether an internal app may call it without Slack's AI features are{' '}
        <b>unverified</b> against a live workspace: in Auto mode minbox falls back to the legacy search (scope <span className="mono">search:read</span>) when Slack refuses it.
      </p>
    </details>
  )
}

function Details({ st }: { st: SlackStatus }) {
  const d = st.diagnostics
  const when = (t: string | null) => (t ? new Date(t).toLocaleString() : '—')
  return (
    <details data-testid="slack-details" className="rounded-[10px] border border-line2 bg-surface px-3 py-2 text-[12.5px] text-muted">
      <summary className="cursor-pointer font-semibold text-fg2">Details</summary>
      <dl className="m-0 mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt>Search used</dt>
        <dd data-testid="slack-details-backend" className="m-0">
          {st.search_backend_used === 'legacy' ? 'legacy search.messages' : 'Real-time Search (assistant.search.context)'} (setting: {st.search_backend})
          {st.search_backend_note ? ` · ${st.search_backend_note}` : ''}
        </dd>
        <dt>Calls since start</dt>
        <dd data-testid="slack-details-calls" className="m-0">
          {d.calls}
          {Object.keys(d.by_method).length > 0 ? ` (${Object.entries(d.by_method).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}
        </dd>
        <dt>Errors</dt>
        <dd className="m-0">
          {d.errors} · rate limited {d.rate_limited}×
        </dd>
        <dt>Last call</dt>
        <dd className="m-0">{when(d.last_call_at)}</dd>
        <dt>Last error</dt>
        <dd data-testid="slack-details-error" className="m-0">
          {d.last_error ? `${d.last_error_method ?? ''} ${d.last_error} (${when(d.last_error_at)})` : '—'}
        </dd>
        <dt>Rate limit</dt>
        <dd data-testid="slack-details-ratelimit" className="m-0">
          {d.rate_limited_until ? `waiting until ${when(d.rate_limited_until)}${d.blocked ? ` (${Object.entries(d.blocked).map(([k, v]) => `${k} ${v}s`).join(', ')})` : ''}` : 'not limited'}
        </dd>
        <dt>Per refresh</dt>
        <dd className="m-0">
          searches the last {st.days} days · at most {st.max_candidates} threads read · the helper judges only threads that changed
        </dd>
        <dt>Scopes granted</dt>
        <dd className="m-0 break-words">{st.scopes_known ? st.scopes.join(', ') || '—' : 'Slack did not list them'}</dd>
      </dl>
      <div className="mt-2 font-semibold text-fg2">Unverified in Slack's documentation</div>
      <ul data-testid="slack-unverified" className="mb-0 mt-1 list-disc pl-5 text-subtle">
        {st.unverified.map((u) => (
          <li key={u}>{u}</li>
        ))}
      </ul>
    </details>
  )
}

export function SlackSection() {
  const { toast, error } = useApp()
  const [st, setSt] = useState<SlackStatus | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState<SlackTestResult | null>(null)
  const load = useCallback(() => {
    api.slackStatus().then(setSt).catch(error)
  }, [error])
  useEffect(() => {
    load()
    window.addEventListener('minbox:slack', load)
    return () => window.removeEventListener('minbox:slack', load)
  }, [load])

  const connect = async () => {
    setBusy('connect')
    try {
      const r = await api.slackConnect(token.trim())
      setSt(r.status)
      setResult(r.result)
      if (r.result.ok) setToken('')
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e), error: e instanceof Error ? e.message : String(e) })
    }
    setBusy('')
  }
  const test = async () => {
    setBusy('test')
    try {
      const r = await api.slackTest()
      setSt(r.status)
      setResult(r.result)
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e), error: e instanceof Error ? e.message : String(e) })
    }
    setBusy('')
  }
  const disconnect = async () => {
    setBusy('disconnect')
    try {
      setSt(await api.slackDisconnect())
      setResult(null)
    } catch (e) {
      error(e)
    }
    setBusy('')
  }
  const clear = async () => {
    setBusy('clear')
    try {
      setSt(await api.slackClearCache())
      toast('Slack cache cleared')
    } catch (e) {
      error(e)
    }
    setBusy('')
  }
  const setBackend = async (b: SlackBackend) => {
    try {
      setSt((await api.slackSetBackend(b)).status)
    } catch (e) {
      error(e)
    }
  }
  return (
    <section className="flex flex-col gap-3" data-testid="slack-section">
      <h2 className="m-0 flex items-center gap-1.5 text-[14px] font-[650] text-muted">
        <IconSlack size={15} />
        Slack (personal)
      </h2>
      <p className="m-0 text-[12.5px] text-subtle">
        Lists the Slack threads and DMs that need your reply, on the Slack screen above My issues. You create your own Slack app and paste its user token; a helper agent on this machine reads each candidate thread to judge whether it needs you.
        This is separate from the Slack app used for notifications.
      </p>
      <p data-testid="slack-privacy" className="m-0 rounded-md border border-line2 px-2.5 py-1.5 text-[12px] text-subtle">
        Privacy: a user token can read your private messages. minbox asks for read-only scopes, keeps the token on the server (never sent to the browser or to coding agents), and never posts or marks anything read. Message text goes only to the local helper agent
        that judges threads; the list keeps a one-line snippet per thread. Disconnect deletes the token and everything stored; Clear cache keeps the token.
      </p>
      <div className="flex min-h-[52px] items-center gap-4 border-b border-[#1f1f24] py-1.5 [[data-theme=light]_&]:border-line">
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="text-[14px]">Status</span>
          <span data-testid="slack-conn" className="text-[12.5px] text-subtle">
            {st == null ? '…' : st.connected ? `Connected as ${st.user || st.user_id} in ${st.team || st.team_id} · token ${st.token_masked}` : 'Not connected'}
          </span>
        </span>
        <span data-testid="slack-status" className="text-[13px] text-fg2">
          {st == null ? '…' : st.connected ? 'Connected' : 'Not connected'}
        </span>
        {st?.connected && (
          <>
            <Button data-testid="slack-test" onClick={test} disabled={busy !== ''}>
              Test
            </Button>
            <Button data-testid="slack-disconnect" variant="danger" onClick={disconnect} disabled={busy !== ''}>
              Disconnect
            </Button>
          </>
        )}
      </div>
      <label className="flex flex-col gap-1.5 text-[12.5px] text-subtle">
        {st?.connected ? 'Replace the user token' : 'User OAuth Token'}
        <span className="flex gap-2">
          <input
            data-testid="slack-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="xoxp-…"
            className="h-[38px] min-w-0 flex-1 rounded-lg border border-linestrong bg-sunken px-3 text-[14px] text-fg outline-none focus:border-accent"
          />
          <Button data-testid="slack-connect" variant="primary" onClick={connect} disabled={busy !== '' || token.trim() === ''}>
            {st?.connected ? 'Replace' : 'Connect'}
          </Button>
        </span>
      </label>
      {result && (
        <div data-testid="slack-test-result" data-ok={result.ok} className={result.ok ? 'flex flex-col gap-1 text-[13px] text-fg2' : 'flex flex-col gap-1 text-[13px] text-danger'}>
          <span data-testid="slack-test-message">{result.ok ? result.message : result.error || result.message}</span>
          {result.search && (
            <span data-testid="slack-test-search" className="text-[12.5px] text-subtle">
              {result.search}
            </span>
          )}
        </div>
      )}
      {st?.connected && st.missing_scopes.length > 0 && (
        <div data-testid="slack-missing" className="rounded-md border border-wait/40 bg-wait/10 px-2.5 py-1.5 text-[12.5px] text-fg2">
          Missing scopes: <span className="mono">{st.missing_scopes.join(', ')}</span>. Add them under OAuth &amp; Permissions → User Token Scopes, reinstall the app and paste the new token.
        </div>
      )}
      {st?.connected && st.optional_missing.length > 0 && (
        <div data-testid="slack-optional" className="text-[12px] text-subtle">
          Optional scope not granted: <span className="mono">{st.optional_missing.join(', ')}</span> (unread dots for DMs).
        </div>
      )}
      {st?.connected && (
        <div className="flex min-h-[52px] items-center gap-4 border-b border-[#1f1f24] py-1.5 [[data-theme=light]_&]:border-line">
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="text-[14px]">Search</span>
            <span className="text-[12.5px] text-subtle">Auto tries the Real-time Search API and falls back to the legacy search.messages when Slack refuses it (the screen says so).</span>
          </span>
          <select
            data-testid="slack-backend"
            value={st.search_backend}
            onChange={(e) => void setBackend(e.target.value as SlackBackend)}
            className="h-9 rounded-lg border border-linestrong bg-sunken px-2.5 text-[13px] text-fg"
          >
            <option value="auto">Auto</option>
            <option value="rts">Real-time Search only</option>
            <option value="legacy">Legacy search.messages only</option>
          </select>
        </div>
      )}
      {st?.connected && (
        <div className="flex items-center gap-3 text-[12.5px] text-subtle">
          <Button data-testid="slack-clear-cache" onClick={clear} disabled={busy !== ''}>
            Clear Slack cache
          </Button>
          Deletes the stored judgements and list snippets (your dismissals and links stay).
        </div>
      )}
      <Setup />
      {st && <Details st={st} />}
    </section>
  )
}
