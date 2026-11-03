import { useEffect, useRef, useState } from 'react'
import { api, type Host, type HostProbe, type TailnetPeer, type TailscaleInfo } from '../api'
import { useApp } from '../lib/app'
import { IconMore } from './icons'
import { Button, IconButton, MenuItem, MenuSep, Modal, Popover, cx } from './ui'

// Settings › Hosts: the machines this minbox server runs sessions on. A host is
// added by pairing: the server's public key gets accepted on that machine.

function ago(iso?: string | null): string {
  if (!iso) return ''
  const min = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`
}

export function hostStatus(h: Host): string {
  if (h.status === 'pairing') return 'Waiting for accept'
  if (h.status === 'connecting') return 'Connecting…'
  if (h.status === 'offline') return `Offline${h.last_seen ? ` · ${ago(h.last_seen)}` : ''}`
  if (h.builtin) return `Online${h.version ? ` · ${h.version}` : ''}`
  return `Online${h.latency_ms !== undefined ? ` · ${h.latency_ms} ms` : ''}`
}

/** "https://devbox.tail3f2a.ts.net · tailscale ryota@github · paired". */
export function hostAddress(h: Host): string {
  if (h.builtin) return `${h.url.replace(/^unix:\/\//, '')} · built in`
  const parts = [h.url]
  if (h.method === 'tailscale') parts.push(`tailscale${h.tailscale_login ? ` ${h.tailscale_login}` : ''}`)
  parts.push(h.paired ? 'paired' : 'not paired')
  return parts.join(' · ')
}

export function HostsSection() {
  const { hosts, error, reloadHosts, toast } = useApp()
  const [wizard, setWizard] = useState<{ repair?: Host } | null>(null)
  const [editing, setEditing] = useState<{ host: Host; field: 'name' | 'url' } | null>(null)
  const [menu, setMenu] = useState<{ el: HTMLElement; host: Host } | null>(null)
  const [removing, setRemoving] = useState<Host | null>(null)
  return (
    <>
      <div className="-mt-4 flex items-center justify-end">
        <Button variant="primary" data-testid="host-add" onClick={() => setWizard({})}>
          + Add host
        </Button>
      </div>
      <p className="m-0 max-w-[680px] text-[13.5px] leading-[1.6] text-muted">
        Run <code className="mono rounded bg-chip px-[5px] py-px text-[12.5px]">minbox host</code> on each machine, and this minbox server connects to it over HTTP. This machine's host
        starts by itself.
      </p>
      <div data-testid="host-list" className="flex max-w-[860px] flex-col rounded-xl border border-line bg-surface">
        {hosts.length === 0 && <span className="px-4 py-5 text-[13px] text-subtle">Loading hosts…</span>}
        {hosts.map((h) => {
          const on = h.status === 'online'
          return (
            <div key={h.id} data-testid="host-row" data-host-id={h.id} className="box-border flex min-h-16 items-center gap-3.5 border-b border-[#1d1d22] px-4 py-3.5 last:border-b-0 [[data-theme=light]_&]:border-line">
              <span
                aria-hidden="true"
                className={cx('box-border h-[9px] w-[9px] shrink-0 rounded-full', on ? 'bg-ok' : h.status === 'pairing' || h.status === 'connecting' ? 'mb-pulse bg-wait' : 'border-[1.5px] border-danger')}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex items-center gap-2">
                  <span className="text-[14.5px] font-[650]">{h.name}</span>
                  {h.builtin && <span className="rounded border border-linestrong px-1.5 text-[11px] leading-[17px] text-muted">This machine</span>}
                </span>
                <span className="mono truncate text-[12px] text-muted" data-testid="host-address">
                  {hostAddress(h)}
                </span>
                {!on && h.error && <span className="truncate text-[12px] text-danger">{h.error}</span>}
              </div>
              <span className={cx('w-[170px] text-[12.5px]', on ? 'text-fg2' : h.status === 'pairing' ? 'text-wait' : 'text-danger')} data-testid="host-status">
                {hostStatus(h)}
              </span>
              <span className="w-[90px] text-[12.5px] text-muted">{h.sessions === 1 ? '1 session' : `${h.sessions} sessions`}</span>
              {h.status === 'offline' && (
                <Button size="sm" onClick={() => api.retryHost(h.id).then(reloadHosts).catch(error)} data-testid="host-retry">
                  Retry
                </Button>
              )}
              <IconButton aria-label="Host menu" data-testid="host-menu" onClick={(e) => setMenu({ el: e.currentTarget, host: h })}>
                <IconMore />
              </IconButton>
            </div>
          )
        })}
      </div>
      <span className="max-w-[860px] text-[12.5px] leading-[1.6] text-subtle">Removing a host also removes this server from that host. Its sessions stay as Ended; their threads stay readable.</span>

      <Popover anchor={menu?.el ?? null} open={!!menu} onClose={() => setMenu(null)}>
        {menu && (
          <>
            <MenuItem testid="host-rename" onClick={() => (setEditing({ host: menu.host, field: 'name' }), setMenu(null))}>
              Rename
            </MenuItem>
            {!menu.host.builtin && (
              <>
                <MenuItem testid="host-edit" onClick={() => (setEditing({ host: menu.host, field: 'url' }), setMenu(null))}>
                  Edit URL
                </MenuItem>
                <MenuItem testid="host-repair" onClick={() => (setWizard({ repair: menu.host }), setMenu(null))}>
                  Re-pair
                </MenuItem>
                <MenuSep />
                <MenuItem testid="host-remove" danger onClick={() => (setRemoving(menu.host), setMenu(null))}>
                  Remove…
                </MenuItem>
              </>
            )}
          </>
        )}
      </Popover>

      {wizard && <AddHostWizard repair={wizard.repair} onClose={() => setWizard(null)} />}
      {editing && <EditHost host={editing.host} field={editing.field} onClose={() => setEditing(null)} />}
      {removing && (
        <Modal label={`Remove ${removing.name}`} onClose={() => setRemoving(null)} className="flex w-[min(440px,100%)] flex-col gap-3 p-5">
          <h3 className="m-0 text-[16px] font-[650]">Remove {removing.name}?</h3>
          <p className="m-0 text-[13.5px] leading-[1.6] text-muted">
            This server is also removed from {removing.name}, so it has to be paired again to come back.
            {removing.sessions > 0 ? ` Its ${removing.sessions === 1 ? 'session stays' : `${removing.sessions} sessions stay`} as Ended; the threads stay readable.` : ''}
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              data-testid="host-remove-confirm"
              onClick={() => {
                const h = removing
                setRemoving(null)
                api
                  .removeHost(h.id)
                  .then(() => {
                    reloadHosts()
                    toast(`Removed ${h.name}`)
                  })
                  .catch(error)
              }}
            >
              Remove
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

function EditHost({ host, field, onClose }: { host: Host; field: 'name' | 'url'; onClose: () => void }) {
  const { error, reloadHosts } = useApp()
  const [v, setV] = useState(field === 'name' ? host.name : host.url)
  const save = () =>
    api
      .updateHost(host.id, { [field]: v.trim() })
      .then(() => {
        reloadHosts()
        onClose()
      })
      .catch(error)
  return (
    <Modal label={field === 'name' ? 'Rename host' : 'Edit URL'} onClose={onClose} className="flex w-[min(460px,100%)] flex-col gap-3 p-5">
      <h3 className="m-0 text-[16px] font-[650]">{field === 'name' ? `Rename ${host.name}` : `URL of ${host.name}`}</h3>
      <input
        autoFocus
        data-testid={field === 'name' ? 'host-name' : 'host-url'}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && v.trim() && void save()}
        className={cx('h-10 rounded-lg border border-linestrong bg-sunken px-3 text-fg outline-none focus:border-accent', field === 'url' ? 'mono text-[13.5px]' : 'text-[14px]')}
      />
      {field === 'url' && <span className="text-[12px] text-subtle">The same machine at a new address keeps its pairing.</span>}
      <div className="flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" data-testid="host-save" disabled={!v.trim()} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Modal>
  )
}

type Method = 'tailscale' | 'direct'

/** Add host: how to connect → the command → which machine → accept the pairing → done. */
export function AddHostWizard({ repair, onClose }: { repair?: Host; onClose: () => void }) {
  const { hosts, error, navigate, setOverlay, reloadHosts } = useApp()
  const [step, setStep] = useState(repair ? 4 : 1)
  const [method, setMethod] = useState<Method>(repair?.method === 'direct' ? 'direct' : 'tailscale')
  const [ts, setTs] = useState<TailscaleInfo | null>(null)
  const [login, setLogin] = useState(repair?.tailscale_login ?? '')
  const [port, setPort] = useState('4849')
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [probe, setProbe] = useState<HostProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [pairing, setPairing] = useState<{ host: Host; code: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [pickAnchor, setPickAnchor] = useState<HTMLElement | null>(null)
  const [typing, setTyping] = useState(false)

  useEffect(() => {
    api
      .tailscaleInfo()
      .then((t) => {
        setTs(t)
        if (!login && t.login) setLogin(t.login)
        if (!t.available && !repair) setMethod('direct')
      })
      .catch(() => setTs({ available: false }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-pair: a new code for the host at once.
  useEffect(() => {
    if (!repair) return
    api
      .repairHost(repair.id)
      .then((r) => setPairing({ host: repair, code: r.code }))
      .catch((e) => {
        error(e)
        onClose()
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const url = method === 'tailscale' ? address.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : address.trim()

  // Look for a minbox host at the address, a beat after typing stops.
  useEffect(() => {
    if (step !== 3 || !url) {
      setProbe(null)
      return
    }
    setProbing(true)
    const t = setTimeout(() => {
      api
        .probeHost(method === 'tailscale' ? `https://${url}` : url)
        .then((p) => {
          setProbe(p)
          if (p.ok && !nameEdited && p.hostname) setName(p.hostname.split('.')[0]!)
        })
        .catch((e) => setProbe({ ok: false, error: (e as Error).message }))
        .finally(() => setProbing(false))
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, step, method])

  // Waiting for accept: the host turns online when the code is accepted there.
  const live = pairing ? hosts.find((h) => h.id === pairing.host.id) : undefined
  useEffect(() => {
    if (step === 4 && live && live.paired && live.status !== 'pairing') setStep(5)
  }, [step, live])
  useEffect(() => {
    if (step !== 4) return
    const t = setInterval(reloadHosts, 1500)
    return () => clearInterval(t)
  }, [step, reloadHosts])

  const pair = async () => {
    setBusy(true)
    try {
      const r = await api.addHost({ name: name.trim(), url: method === 'tailscale' ? url : url, method, tailscale_login: method === 'tailscale' ? login.trim() : undefined })
      setPairing(r)
      reloadHosts()
      setStep(4)
    } catch (err) {
      error(err)
    } finally {
      setBusy(false)
    }
  }

  const command =
    method === 'tailscale' ? (
      <>
        minbox host --tailscale \<br />
        &nbsp;&nbsp;--tailscale-user-login{' '}
        <input
          aria-label="Tailscale user login"
          data-testid="tailscale-login"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="you@github"
          size={Math.max(login.length, 10)}
          className="mono rounded-[3px] border-0 bg-wait/14 px-[3px] text-[12.5px] text-waitfg outline-none"
        />
      </>
    ) : (
      <>
        minbox host --listen 0.0.0.0:
        <input
          aria-label="Port"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
          size={5}
          className="mono rounded-[3px] border-0 bg-wait/14 px-[3px] text-[12.5px] text-waitfg outline-none"
        />
      </>
    )
  const commandText = method === 'tailscale' ? `minbox host --tailscale --tailscale-user-login ${login}` : `minbox host --listen 0.0.0.0:${port}`

  const peers = ts?.peers ?? []
  const withHost = peers.filter((p) => p.has_host)
  const others = peers.filter((p) => !p.has_host)
  const pickPeer = (p: TailnetPeer) => {
    setAddress(p.dns_name)
    if (!nameEdited) setName(p.name)
    setPickAnchor(null)
    setTyping(false)
  }
  const hostName = pairing?.host.name ?? (name || 'the host')

  const header = (n: number) => (
    <div className="flex flex-col gap-2.5 border-b border-line2 px-[22px] pb-3.5 pt-[18px]">
      <div className="flex items-center">
        <h2 className="m-0 flex-1 text-[16px] font-[650]">{repair ? `Re-pair ${repair.name}` : 'Add host'}</h2>
        <span className="text-[12.5px] text-subtle">Step {n} of 4</span>
      </div>
      <div aria-hidden="true" className="grid grid-cols-4 gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cx('h-1 rounded-sm', i <= n ? 'bg-accent' : 'bg-line2')} />
        ))}
      </div>
    </div>
  )
  const footer = (left: React.ReactNode, right: React.ReactNode) => (
    <div className="flex h-16 shrink-0 items-center gap-2.5 border-t border-line2 px-[22px]">
      {left}
      <span className="flex-1" />
      {right}
    </div>
  )
  const back = (to: number) => (
    <Button onClick={() => setStep(to)} className="h-[38px]">
      Back
    </Button>
  )
  const copyBox = (text: string, children: React.ReactNode, strong?: boolean) => (
    <div className={cx('mono flex items-start gap-2 rounded-lg border bg-sunken px-3 py-2.5 text-[12.5px] leading-[1.6]', strong ? 'border-accent' : 'border-line2')}>
      <span className="min-w-0 flex-1 break-all">{children}</span>
      <Button size="sm" className="h-[26px] font-sans" onClick={() => navigator.clipboard?.writeText(text)}>
        Copy
      </Button>
    </div>
  )

  return (
    <Modal label={repair ? 'Re-pair host' : 'Add host'} onClose={onClose} className="flex h-[min(620px,calc(100vh-40px))] w-[min(520px,100%)] flex-col overflow-hidden rounded-2xl bg-raised" top>
      {step === 1 && (
        <>
          {header(1)}
          <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-[22px]">
            <h3 className="m-0 text-[18px] font-[650]">How does it connect?</h3>
            <div data-testid="host-method" role="radiogroup" aria-label="Connection" className="flex flex-col gap-2.5">
              {(
                [
                  ['tailscale', 'Tailscale', 'Over HTTPS with tailscale serve. The Tailscale user is checked too.'],
                  ['direct', 'Direct', 'Connect to a URL you give. For closed networks.'],
                ] as const
              ).map(([v, label, desc]) => {
                const on = method === v
                const off = v === 'tailscale' && ts !== null && !ts.available
                return (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={off}
                    data-testid={`host-method-${v}`}
                    onClick={() => setMethod(v)}
                    className={cx('flex gap-3 rounded-xl border px-4 py-3.5 text-left disabled:opacity-55', on ? 'border-wait/55 bg-wait/8' : 'border-line2 bg-transparent')}
                  >
                    <span aria-hidden="true" className={cx('mt-px box-border h-[18px] w-[18px] shrink-0 rounded-full', on ? 'border-[5px] border-accent' : 'border-[1.5px] border-faint')} />
                    <span className="flex flex-col gap-1">
                      <span className="text-[15px] font-[650]">
                        {label} {v === 'tailscale' && <span className="text-[10.5px] font-bold text-wait">Recommended</span>}
                      </span>
                      <span className="text-[13px] leading-normal text-muted">{off ? 'Tailscale is not running on this machine.' : desc}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          {footer(
            <Button variant="quiet" className="h-[38px]" onClick={onClose}>
              Cancel
            </Button>,
            <Button variant="primary" className="h-[38px] px-[18px]" data-testid="wizard-next" onClick={() => setStep(2)}>
              Next
            </Button>,
          )}
        </>
      )}

      {step === 2 && (
        <>
          {header(2)}
          <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-[22px]">
            <h3 className="m-0 text-[18px] font-[650]">Run this on the machine to add</h3>
            <div data-testid="host-command">{copyBox(commandText, command)}</div>
            <span className="text-[12.5px] leading-[1.55] text-subtle">
              {method === 'tailscale'
                ? 'With --tailscale the host listens on 127.0.0.1 only and sets up tailscale serve itself.'
                : 'The host listens on that port on every interface. Use it only inside a network you trust.'}
            </span>
          </div>
          {footer(
            back(1),
            <Button variant="primary" className="h-[38px] px-[18px]" data-testid="wizard-next" disabled={method === 'tailscale' && !login.trim()} onClick={() => setStep(3)}>
              Next
            </Button>,
          )}
        </>
      )}

      {step === 3 && (
        <>
          {header(3)}
          <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-[22px]">
            <h3 className="m-0 text-[18px] font-[650]">The machine's name and address</h3>
            {method === 'tailscale' && peers.length > 0 && !typing ? (
              <div className="flex flex-col gap-1.5 text-[13px] text-muted">
                <span>
                  Machine <span className="text-[11.5px] text-subtle">pick one from the tailnet</span>
                </span>
                <button
                  type="button"
                  role="combobox"
                  aria-expanded={!!pickAnchor}
                  data-testid="host-url"
                  onClick={(e) => setPickAnchor(e.currentTarget)}
                  className="flex h-10 items-center gap-2 rounded-lg border border-accent bg-sunken px-3 text-left shadow-[0_0_0_3px_color-mix(in_srgb,var(--mb-wait)_15%,transparent)]"
                >
                  {address && <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-ok" />}
                  <span className={cx('mono flex-1 truncate text-[13.5px]', address ? 'text-fg' : 'text-faint')}>{address || 'Choose a machine'}</span>
                  <span className="text-muted">▾</span>
                </button>
                <Popover anchor={pickAnchor} open={!!pickAnchor} onClose={() => setPickAnchor(null)} align="start" className="w-[476px]">
                  {withHost.length > 0 && <span className="block px-2.5 pb-0.5 pt-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-subtle">With a minbox host</span>}
                  {withHost.map((p) => (
                    <PeerOption key={p.dns_name} p={p} on={address === p.dns_name} onPick={() => pickPeer(p)} />
                  ))}
                  {others.length > 0 && <span className="block px-2.5 pb-0.5 pt-2 text-[11px] font-bold uppercase tracking-[0.06em] text-subtle">Other machines</span>}
                  {others.map((p) => (
                    <PeerOption key={p.dns_name} p={p} on={address === p.dns_name} onPick={() => pickPeer(p)} />
                  ))}
                  <MenuSep />
                  <MenuItem
                    testid="host-type-name"
                    onClick={() => {
                      setTyping(true)
                      setPickAnchor(null)
                    }}
                  >
                    Type a name…
                  </MenuItem>
                </Popover>
              </div>
            ) : (
              <label className="flex flex-col gap-1.5 text-[13px] text-muted">
                {method === 'tailscale' ? 'MagicDNS name' : 'URL'}
                <input
                  data-testid="host-url"
                  autoFocus
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder={method === 'tailscale' ? `devbox${ts?.suffix ? `.${ts.suffix}` : '.example.ts.net'}` : `http://10.0.0.4:${port}`}
                  className="mono h-10 rounded-lg border border-linestrong bg-sunken px-3 text-[13.5px] text-fg outline-none focus:border-accent"
                />
              </label>
            )}
            <label className="flex flex-col gap-1.5 text-[13px] text-muted">
              Name
              <input
                data-testid="host-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameEdited(true)
                }}
                placeholder="devbox"
                className="h-10 rounded-lg border border-linestrong bg-sunken px-3 text-[14px] text-fg outline-none focus:border-accent"
              />
            </label>
            {url && (probing && !probe ? (
              <div className="text-[13px] text-subtle">Looking for a minbox host…</div>
            ) : probe?.ok ? (
              <div role="status" data-testid="host-probe" className="flex items-center gap-2 rounded-[9px] border border-ok/35 bg-ok/8 px-3 py-2.5 text-[13px] text-fg">
                <span aria-hidden="true" className="text-ok">
                  ✓
                </span>
                Found · minbox host {probe.version} · {probe.os}/{probe.arch}
              </div>
            ) : probe ? (
              <div role="status" data-testid="host-probe" className="flex items-center gap-2 rounded-[9px] border border-danger/40 bg-dangerstrong/10 px-3 py-2.5 text-[13px] text-dangerfg">
                <span aria-hidden="true">△</span>
                No minbox host there: {probe.error ?? 'no answer'}. Run the command from step 2 on that machine.
              </div>
            ) : null)}
            {method === 'direct' && /^http:\/\//i.test(url) && (
              <div role="note" className="flex gap-2 rounded-[9px] border border-wait/30 bg-wait/7 px-3 py-2.5 text-[12.5px] leading-[1.55] text-fg2">
                <span aria-hidden="true" className="text-wait">
                  △
                </span>
                <span>Over http:// the traffic is not encrypted (requests are still signed). Use it inside a closed network, or use https://.</span>
              </div>
            )}
          </div>
          {footer(
            back(2),
            <Button variant="primary" className="h-[38px] px-[18px]" data-testid="host-pair" disabled={busy || !probe?.ok || !name.trim()} onClick={() => void pair()}>
              Pair
            </Button>,
          )}
        </>
      )}

      {step === 4 && (
        <>
          {header(4)}
          <div data-testid="host-pairing" className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-[22px]">
            <h3 className="m-0 text-[18px] font-[650]">Accept on {hostName}</h3>
            <span className="text-[13.5px] leading-[1.6] text-fg2">Run this on {hostName}.</span>
            <div role="note" className="flex gap-2 rounded-[9px] border border-line2 bg-[#141417] px-3 py-2.5 text-[12.5px] leading-[1.55] text-fg2 [[data-theme=light]_&]:bg-sunken">
              <span aria-hidden="true">🔑</span>
              <span>
                Public-key authentication: accepting registers this server's public key (ed25519) on the host. Every later request is signed with the server's private key, and the host checks it with
                that public key. The private key never leaves the server.
              </span>
            </div>
            {pairing ? (
              <>
                <div className="flex flex-col items-center gap-1 self-center py-2.5">
                  <span className="text-[12px] uppercase tracking-[0.06em] text-subtle">Code</span>
                  <span className="mono text-[30px] font-bold tracking-[0.12em] text-waitfg" data-testid="pair-code">
                    {pairing.code}
                  </span>
                </div>
                {copyBox(`minbox pair accept ${pairing.code}`, `minbox pair accept ${pairing.code}`, true)}
                <div className="mono rounded-lg border border-line2 bg-sunken px-3 py-2.5 text-[11.5px] leading-[1.65] text-muted">
                  $ minbox pair list
                  <br />
                  {pairing.code}&nbsp;&nbsp;{'<this server>'}&nbsp;&nbsp;ed25519 {live?.fingerprint ?? pairing.host.fingerprint ?? 'SHA256:…'}
                </div>
                <div className="flex items-center gap-2 text-[12.5px] text-muted">
                  <span aria-hidden="true" className="mb-pulse h-2 w-2 rounded-full bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--mb-wait)_22%,transparent)]" />
                  Waiting
                </div>
              </>
            ) : (
              <span className="text-[13px] text-subtle">Asking {hostName} for a code…</span>
            )}
          </div>
          {footer(
            repair ? (
              <Button variant="quiet" className="h-[38px]" onClick={onClose}>
                Close
              </Button>
            ) : (
              back(3)
            ),
            <Button className="h-[38px] px-[18px]" disabled>
              Waiting for accept…
            </Button>,
          )}
        </>
      )}

      {step === 5 && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-3.5 px-8 py-10 text-center" data-testid="host-added">
            <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-full bg-ok/14 text-[26px] text-ok">
              ✓
            </span>
            <h3 className="m-0 text-[20px] font-[650]">{repair ? `Paired ${hostName} again` : `Added ${hostName}`}</h3>
            <span className="mono text-[12.5px] leading-[1.7] text-muted">
              {live?.url ?? pairing?.host.url}
              <br />
              {live?.method === 'tailscale' ? `Tailscale ${live.tailscale_login ?? ''} · ` : ''}paired
            </span>
          </div>
          {footer(
            <Button className="h-[38px]" onClick={onClose}>
              Close
            </Button>,
            <Button
              variant="primary"
              className="h-[38px] px-[18px]"
              data-testid="host-new-session"
              onClick={() => {
                if (pairing) localStorage.setItem('minbox:last-host', pairing.host.id)
                onClose()
                navigate({ view: 'main' })
                setOverlay({ kind: 'new-session' })
              }}
            >
              New session on {hostName}
            </Button>,
          )}
        </>
      )}
    </Modal>
  )
}

function PeerOption({ p, on, onPick }: { p: TailnetPeer; on: boolean; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={on}
      disabled={p.added}
      onClick={onPick}
      data-testid="tailnet-peer"
      className={cx('flex h-9 w-full items-center gap-2 rounded-[7px] border-0 px-2.5 text-left disabled:opacity-55', on ? 'bg-sel' : 'bg-transparent hover:bg-sel')}
    >
      <span aria-hidden="true" className={cx('box-border h-[7px] w-[7px] shrink-0 rounded-full', p.online ? 'bg-ok' : 'border-[1.5px] border-faint')} />
      <span className={cx('mono flex-1 truncate text-[13px]', p.online ? 'text-fg' : 'text-subtle')}>{p.name}</span>
      <span className="text-[11.5px] text-subtle">{!p.online ? 'offline' : `${p.os} · ${p.added ? 'added' : p.has_host ? 'not added' : 'no host'}`}</span>
    </button>
  )
}
