import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, type Device, type PairRequest } from '../api'
import { useApp } from '../lib/app'
import { authenticate, cryptoAvailable, deviceKey, deviceName, hasDeviceKey } from '../lib/device'
import { shortTime } from '../lib/format'
import { Button, cx } from './ui'
import { Logo } from './Sidebar'

// Browsers that reach minbox over the network pair first: this browser's
// public key is accepted on a browser already trusted, or with
// `minbox pair accept` on the server's machine.

type GateState = 'checking' | 'trusted' | 'pairing'

/** Shows the app to trusted browsers, the pairing screen to the others. */
export function DeviceGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking')
  const check = useCallback(async () => {
    try {
      const me = await api.deviceMe()
      if (me.trusted) return setState('trusted')
    } catch (e) {
      // An older server without devices: everything is trusted there.
      if ((e as { status?: number }).status === 404) return setState('trusted')
    }
    if ((await hasDeviceKey().catch(() => false)) && (await authenticate().catch(() => false))) return setState('trusted')
    setState('pairing')
  }, [])
  useEffect(() => {
    void check()
    const on = () => setState('pairing')
    window.addEventListener('minbox:unpaired', on)
    return () => window.removeEventListener('minbox:unpaired', on)
  }, [check])
  if (state === 'checking') return <div className="flex h-full items-center justify-center text-[13px] text-subtle">Connecting…</div>
  if (state === 'pairing') return <PairScreen onPaired={() => setState('trusted')} />
  return <>{children}</>
}

function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [name, setName] = useState(deviceName)
  const [req, setReq] = useState<{ request_id: string; code: string; fingerprint: string } | null>(null)
  const [status, setStatus] = useState<'idle' | 'pending' | 'rejected' | 'expired' | 'error'>('idle')
  const [err, setErr] = useState('')
  const start = async () => {
    setErr('')
    try {
      const k = await deviceKey()
      const r = await api.pairDevice(k.publicKey, name.trim() || deviceName())
      setReq(r)
      setStatus('pending')
    } catch (e) {
      setErr((e as Error).message)
      setStatus('error')
    }
  }
  useEffect(() => {
    if (status !== 'pending' || !req) return
    const t = setInterval(async () => {
      try {
        const s = await api.pairStatus(req.request_id)
        if (s.status === 'accepted') {
          clearInterval(t)
          if (await authenticate()) onPaired()
          else {
            setErr('Accepted, but signing in failed. Try again.')
            setStatus('error')
          }
        } else if (s.status !== 'pending') {
          clearInterval(t)
          setStatus(s.status)
        }
      } catch {
        /* keep waiting */
      }
    }, 1500)
    return () => clearInterval(t)
  }, [status, req, onPaired])

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg p-5" data-testid="pair-screen">
      <div className="flex w-full max-w-[440px] flex-col gap-4 rounded-2xl border border-linestrong bg-raised p-6">
        <div className="flex items-center gap-2.5">
          <Logo size={26} />
          <h1 className="m-0 text-[18px] font-bold">Pair this browser</h1>
        </div>
        {!cryptoAvailable() ? (
          <p className="m-0 text-[13.5px] leading-[1.6] text-dangerfg">This browser cannot make a key here. Open minbox over https:// (tailscale serve does that).</p>
        ) : status === 'idle' || status === 'error' ? (
          <>
            <p className="m-0 text-[13.5px] leading-[1.6] text-muted">
              You reached minbox over the network. This browser makes a key pair and sends its public key; once it is accepted, this browser signs in with it. The private key never leaves this
              browser.
            </p>
            <label className="flex flex-col gap-1.5 text-[12.5px] text-muted">
              Name of this browser
              <input data-testid="device-name" value={name} onChange={(e) => setName(e.target.value)} className="h-11 rounded-lg border border-linestrong bg-sunken px-3 text-[15px] text-fg outline-none focus:border-accent" />
            </label>
            {err && <span className="text-[12.5px] text-danger">{err}</span>}
            <Button variant="primary" size="lg" data-testid="device-pair" onClick={() => void start()}>
              Pair this browser
            </Button>
          </>
        ) : status === 'pending' && req ? (
          <>
            <p className="m-0 text-[13.5px] leading-[1.6] text-fg2">Accept it in Settings › Devices on a browser already paired, or run this on the server's machine:</p>
            <div className="flex flex-col items-center gap-1 py-1">
              <span className="text-[12px] uppercase tracking-[0.06em] text-subtle">Code</span>
              <span className="mono text-[32px] font-bold tracking-[0.12em] text-waitfg" data-testid="device-code">
                {req.code}
              </span>
            </div>
            <div className="mono rounded-lg border border-accent bg-sunken px-3 py-2.5 text-[13px]">minbox pair accept {req.code}</div>
            <span className="mono break-all text-[11.5px] text-subtle">ecdsa-p256 {req.fingerprint}</span>
            <div className="flex items-center gap-2 text-[12.5px] text-muted">
              <span aria-hidden="true" className="mb-pulse h-2 w-2 rounded-full bg-accent" />
              Waiting for accept
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-[13.5px] leading-[1.6] text-dangerfg">{status === 'rejected' ? 'The request was turned down.' : 'The code ran out (10 minutes).'}</p>
            <Button variant="primary" onClick={() => void start()}>
              Ask again
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/** Settings › Devices: paired browsers and the requests waiting. */
export function DevicesSection() {
  const { error, toast, devicesVersion } = useApp()
  const [data, setData] = useState<{ devices: Device[]; requests: PairRequest[] } | null>(null)
  const [me, setMe] = useState<'loopback' | 'device' | null>(null)
  const load = useCallback(() => {
    api.devices().then(setData).catch(error)
    api
      .deviceMe()
      .then((m) => setMe(m.via))
      .catch(() => {})
  }, [error])
  useEffect(load, [load, devicesVersion])
  const act = (p: Promise<unknown>, msg: string) =>
    p
      .then(() => {
        toast(msg)
        load()
      })
      .catch(error)
  return (
    <>
      <p className="m-0 max-w-[680px] text-[13.5px] leading-[1.6] text-muted">
        Browsers that open minbox over the network (for example through <code className="mono rounded bg-chip px-[5px] text-[12.5px]">minbox start --tailscale</code>) pair first: their public
        key is accepted here, or with <code className="mono rounded bg-chip px-[5px] text-[12.5px]">minbox pair accept</code> on this machine. A browser on this machine itself needs no pairing
        {me === 'loopback' ? ' (like this one)' : ''}.
      </p>
      <section className="flex max-w-[860px] flex-col gap-2.5">
        <h2 className="m-0 text-[14px] font-[650] text-muted">Waiting for accept ({data?.requests.length ?? 0})</h2>
        {data?.requests.length === 0 && <span className="text-[13px] text-subtle">No browser is asking.</span>}
        {data?.requests.map((r) => (
          <div key={r.id} data-testid="device-request" className="flex items-center gap-3.5 rounded-xl border border-wait/40 bg-wait/6 px-4 py-3">
            <span className="mono text-[20px] font-bold tracking-[0.1em] text-waitfg">{r.code}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[14px] font-semibold">{r.name}</span>
              <span className="mono truncate text-[11.5px] text-muted">
                ecdsa-p256 {r.fingerprint}
                {r.tailscale_login ? ` · tailscale ${r.tailscale_login}` : ''}
                {r.ip ? ` · ${r.ip}` : ''} · {shortTime(r.created_at)}
              </span>
            </div>
            <Button size="sm" onClick={() => act(api.rejectDevice(r.id), `Turned down ${r.name}`)}>
              Reject
            </Button>
            <Button size="sm" variant="primary" data-testid="device-accept" onClick={() => act(api.acceptDevice(r.id), `Paired ${r.name}`)}>
              Accept
            </Button>
          </div>
        ))}
      </section>
      <section className="flex max-w-[860px] flex-col gap-2.5">
        <h2 className="m-0 text-[14px] font-[650] text-muted">Paired browsers ({data?.devices.length ?? 0})</h2>
        <div className="flex flex-col rounded-xl border border-line bg-surface">
          {data?.devices.length === 0 && <span className="px-4 py-5 text-[13px] text-subtle">None yet.</span>}
          {data?.devices.map((d) => (
            <div key={d.id} data-testid="device-row" className="flex min-h-14 items-center gap-3.5 border-b border-[#1d1d22] px-4 py-3 last:border-b-0 [[data-theme=light]_&]:border-line">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[14px] font-semibold">
                  {d.name}
                  {d.current && <span className="rounded border border-linestrong px-1.5 text-[11px] font-normal leading-[17px] text-muted">This browser</span>}
                </span>
                <span className="mono truncate text-[11.5px] text-muted">
                  ecdsa-p256 {d.fingerprint} · paired {shortTime(d.created_at)}
                  {d.last_seen ? ` · last seen ${shortTime(d.last_seen)}` : ''}
                </span>
              </div>
              <Button size="sm" variant="quiet" className={cx('text-danger')} data-testid="device-revoke" onClick={() => act(api.revokeDevice(d.id), `Revoked ${d.name}`)}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

/** A trusted browser hears when another one asks to pair. */
export function PairRequestBanner() {
  const { devicesVersion, navigate, route } = useApp()
  const [n, setN] = useState(0)
  useEffect(() => {
    api
      .devices()
      .then((d) => setN(d.requests.length))
      .catch(() => setN(0))
  }, [devicesVersion])
  if (n === 0 || (route.view === 'settings' && route.ss === 'devices')) return null
  return (
    <div className="mx-2 mb-1 flex items-center gap-2.5 rounded-[10px] border border-wait/40 bg-wait/8 px-3 py-2 text-[13px]" data-testid="pair-request-banner">
      <span className="flex-1">{n === 1 ? 'A browser asks to pair' : `${n} browsers ask to pair`}</span>
      <Button size="sm" variant="primary" onClick={() => navigate({ view: 'settings', ss: 'devices' })}>
        Review
      </Button>
    </div>
  )
}
