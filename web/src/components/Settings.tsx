import { useEffect, useState } from 'react'
import { api, type About, type Session, type Storage, type Thread } from '../api'
import { useApp } from '../lib/app'
import { notificationPermission, notify, requestNotifications, dingDong } from '../lib/alerts'
import { bytes, homeRelative, shortTime } from '../lib/format'
import { useHotkeys } from '../lib/hotkeys'
import { IconBack } from './icons'
import { Button, Segmented, Switch, cx } from './ui'
import { HostsSection } from './Hosts'
import { DevicesSection } from './Devices'

const NAV: { id: string; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'hosts', label: 'Hosts' },
  { id: 'devices', label: 'Devices' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'archived', label: 'Archived' },
  { id: 'storage', label: 'Storage' },
  { id: 'about', label: 'About' },
]

export function SettingsPage() {
  const { route, navigate, sessions, isPhone, hosts } = useApp()
  const [about, setAbout] = useState<About | null>(null)
  useEffect(() => {
    api.about().then(setAbout).catch(() => {})
  }, [])
  useHotkeys({ escape: () => navigate({ view: 'main' }) })
  const archivedCount = (sessions ?? []).filter((s) => s.archived_at).length
  const section = route.ss
  const meta: Record<string, string> = { hosts: hosts.length ? String(hosts.length) : '', capabilities: 'Board · Decision mode', archived: archivedCount ? String(archivedCount) : '' }
  return (
    <div className={cx('flex h-full bg-bg', isPhone && 'flex-col')} data-testid="settings">
      <nav aria-label="Settings" className={cx('flex shrink-0 gap-0.5 bg-surface', isPhone ? 'overflow-x-auto border-b border-line px-2 pb-2 pt-[max(8px,env(safe-area-inset-top))]' : 'w-60 flex-col border-r border-line px-2 py-3.5')}>
        <button
          type="button"
          data-testid="settings-back"
          onClick={() => navigate({ view: 'main' })}
          className={cx('flex h-[34px] shrink-0 items-center gap-1.5 border-0 bg-transparent px-2.5 text-left text-[13px] text-fg2 hover:text-fg', !isPhone && 'mb-2.5')}
        >
          <IconBack size={14} /> Inbox
        </button>
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            data-testid={`settings-nav-${n.id}`}
            onClick={() => navigate({ ss: n.id })}
            className={cx(
              'flex h-9 shrink-0 items-center justify-between gap-3 rounded-md border-0 px-3 text-left text-[13.5px]',
              section === n.id ? 'bg-sel font-[650]' : 'bg-transparent font-medium hover:bg-raised',
            )}
          >
            {n.label}
            {!isPhone && <span className="truncate whitespace-nowrap text-[11.5px] font-normal text-subtle">{meta[n.id]}</span>}
          </button>
        ))}
      </nav>
      <main className={cx('flex min-w-0 flex-1 flex-col gap-7 overflow-y-auto', isPhone ? 'px-4 py-5' : 'px-12 py-8')}>
        <div className="flex items-baseline gap-3">
          <h1 className="m-0 text-[22px] font-bold">{NAV.find((n) => n.id === section)?.label ?? 'General'}</h1>
          {section === 'general' && about && <span className="mono text-[12px] text-subtle">minbox {about.version}</span>}
        </div>
        {section === 'general' && <General />}
        {section === 'hosts' && <HostsSection />}
        {section === 'devices' && <DevicesSection />}
        {section === 'prompts' && <Prompts />}
        {section === 'capabilities' && <Capabilities />}
        {section === 'archived' && <Archived />}
        {section === 'storage' && <StorageSection />}
        {section === 'about' && <AboutSection about={about} />}
      </main>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex max-w-[720px] flex-col gap-3">
      <h2 className="m-0 text-[14px] font-[650] text-muted">{title}</h2>
      {children}
    </section>
  )
}

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

function General() {
  const { settings, saveSettings, toast } = useApp()
  const [perm, setPerm] = useState(notificationPermission())
  return (
    <>
      <Group title="Appearance">
        <Row label="Theme">
          <Segmented
            value={settings.theme}
            onChange={(v) => saveSettings({ theme: v })}
            testidPrefix="theme"
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'Match system' },
            ]}
          />
        </Row>
        <Row label="Text size">
          <div className="flex gap-1">
            {[12, 13, 14, 15].map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={settings.text_size === v}
                onClick={() => saveSettings({ text_size: v })}
                className={cx('h-[30px] w-10 rounded-[6px] border bg-transparent text-[12.5px]', settings.text_size === v ? 'border-accent' : 'border-linestrong')}
              >
                {v}
              </button>
            ))}
          </div>
        </Row>
      </Group>
      <Group title="When Claude asks you">
        <Row label="Browser notifications" desc="When the tab is in the background and something new waits on you">
          <Button
            size="sm"
            onClick={async () => {
              let p = perm
              if (p === 'default') p = await requestNotifications()
              setPerm(p)
              if (p === 'granted') notify('minbox: test notification', 'This is how minbox tells you Claude Code is waiting.')
              else toast('Notifications are blocked in this browser', { error: true })
            }}
          >
            Send a test notification
          </Button>
          <Switch label="Browser notifications" on={settings.notifications} onChange={(v) => saveSettings({ notifications: v })} />
        </Row>
        <Row label="Play a sound" desc="Ding-dong · only when the tab is not in front">
          <Button size="sm" variant="quiet" onClick={dingDong}>
            Play
          </Button>
          <Switch label="Play a sound" on={settings.sound} onChange={(v) => saveSettings({ sound: v })} />
        </Row>
        <Row label="Count in tab title" desc="(N) minbox and a badge on the favicon">
          <Switch label="Count in tab title" on={settings.tab_count} onChange={(v) => saveSettings({ tab_count: v })} />
        </Row>
      </Group>
      <Group title="Keyboard">
        <Row label="Single-key shortcuts" desc="J K R E Z / and so on. Always off inside the terminal.">
          <Switch label="Single-key shortcuts" on={settings.single_key} onChange={(v) => saveSettings({ single_key: v })} />
        </Row>
      </Group>
    </>
  )
}

function Prompts() {
  const { settings, saveSettings, toast } = useApp()
  const [v, setV] = useState(settings.prompt_extra)
  useEffect(() => setV(settings.prompt_extra), [settings.prompt_extra])
  return (
    <Group title="Extra instructions for Claude Code">
      <p className="m-0 text-[13px] leading-[1.6] text-muted">
        Every session's first prompt carries a short note about the inbox. What you write here is added to it, e.g. “Ask your questions in Japanese”, “Attach a guided review before opening a PR”.
        It reaches sessions started (or resumed) after you save.
      </p>
      <textarea
        data-testid="prompt-extra"
        value={v}
        onChange={(e) => setV(e.target.value)}
        rows={6}
        placeholder="Nothing extra."
        className="w-full resize-y rounded-[10px] border border-linestrong bg-sunken p-3 text-[13.5px] outline-none focus:border-accent"
      />
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={v === settings.prompt_extra}
          onClick={() => {
            saveSettings({ prompt_extra: v })
            toast('Saved')
          }}
        >
          Save
        </Button>
        <Button variant="quiet" disabled={v === settings.prompt_extra} onClick={() => setV(settings.prompt_extra)}>
          Revert
        </Button>
      </div>
    </Group>
  )
}

function Capabilities() {
  const { settings, saveSettings } = useApp()
  return (
    <Group title="Optional parts of minbox">
      <Row label="Board" desc="Lay work out as cards (Backlog → Shipped). Claude Code can add cards with its card tool.">
        <Switch label="Board" on={settings.board} onChange={(v) => saveSettings({ board: v })} />
      </Row>
      <Row label="Decision mode (Experimental)" desc="Every waiting question across sessions, one at a time. Pick with 1–9; answers are sent per thread.">
        <Switch label="Decision mode" on={settings.decision_mode} onChange={(v) => saveSettings({ decision_mode: v })} />
      </Row>
    </Group>
  )
}

function Archived() {
  const { sessions, error, reloadSessions, navigate, threadsVersion } = useApp()
  const archived = (sessions ?? []).filter((s) => s.archived_at)
  const [threads, setThreads] = useState<(Thread & { sessionName: string })[] | null>(null)
  useEffect(() => {
    const load = async () => {
      const out: (Thread & { sessionName: string })[] = []
      for (const s of sessions ?? []) {
        const ts = await api.threads(s.id)
        for (const t of ts) if (t.archived_at) out.push({ ...t, sessionName: s.name })
      }
      setThreads(out.sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? '')))
    }
    load().catch(error)
  }, [sessions, threadsVersion, error])
  return (
    <>
      <Group title={`Sessions (${archived.length})`}>
        {archived.length === 0 && <span className="text-[13px] text-subtle">No archived sessions.</span>}
        {archived.map((s: Session) => (
          <Row key={s.id} label={s.name} desc={`${homeRelative(s.cwd)} · archived ${shortTime(s.archived_at!)}`}>
            <Button size="sm" onClick={() => api.unarchiveSession(s.id).then(reloadSessions).catch(error)}>
              Unarchive
            </Button>
          </Row>
        ))}
      </Group>
      <Group title={`Threads (${threads?.length ?? '…'})`}>
        {threads?.length === 0 && <span className="text-[13px] text-subtle">No archived threads.</span>}
        {threads?.map((t) => (
          <Row key={t.id} label={t.subject} desc={`${t.sessionName} · archived ${shortTime(t.archived_at!)}`}>
            <Button size="sm" variant="quiet" onClick={() => navigate({ view: 'main', s: t.session_id, t: t.id })}>
              Open
            </Button>
            <Button size="sm" onClick={() => api.unarchiveThread(t.id).catch(error)}>
              Unarchive
            </Button>
          </Row>
        ))}
      </Group>
    </>
  )
}

function StorageSection() {
  const { error, toast } = useApp()
  const [st, setSt] = useState<Storage | null>(null)
  const [confirm, setConfirm] = useState(false)
  const load = () => api.storage().then(setSt).catch(error)
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!st) return <span className="text-[13px] text-subtle">Loading…</span>
  return (
    <>
      <Group title="Data">
        <Row label="Data directory" desc={st.data_dir}>
          <Button size="sm" variant="quiet" onClick={() => navigator.clipboard?.writeText(st.data_dir)}>
            Copy
          </Button>
        </Row>
        <Row label="Database" desc={st.db_path}>
          <span className="mono text-[13px]">{bytes(st.db_bytes)}</span>
        </Row>
      </Group>
      <Group title="Scratch">
        <Row label="Pasted and attached files" desc={`${st.scratch_dir} · ${st.scratch_files} files`}>
          <span className="mono text-[13px]">{bytes(st.scratch_bytes)}</span>
          {confirm ? (
            <>
              <Button
                size="sm"
                variant="danger"
                data-testid="clear-scratch-confirm"
                onClick={() =>
                  api
                    .clearScratch()
                    .then((r) => {
                      toast(`Removed ${r.removed} files`)
                      setConfirm(false)
                      void load()
                    })
                    .catch(error)
                }
              >
                Delete all
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setConfirm(true)} disabled={st.scratch_files === 0}>
              Clear…
            </Button>
          )}
        </Row>
        {confirm && <span className="text-[12.5px] text-danger">Paths pasted into terminals will stop working. This cannot be undone.</span>}
      </Group>
    </>
  )
}

function AboutSection({ about }: { about: About | null }) {
  const { setOverlay } = useApp()
  if (!about) return <span className="text-[13px] text-subtle">Loading…</span>
  return (
    <Group title="minbox">
      <Row label="Version">
        <span className="mono text-[13px]">{about.version}</span>
      </Row>
      <Row label="Server protocol" desc={`Needs terminal host protocol ${about.required_host} or newer`}>
        <span className="mono text-[13px]">{about.server_protocol}</span>
      </Row>
      <Row label="Terminal host" desc={about.host ? `pid ${about.host.pid} · needs server protocol ${about.host.required_server}` : 'Not connected'}>
        <span className="mono text-[13px]">{about.host ? `protocol ${about.host.protocol}` : '—'}</span>
      </Row>
      <Row label="Data directory">
        <span className="mono text-[12.5px] text-muted">{about.data_dir}</span>
      </Row>
      <Row label="Keyboard shortcuts">
        <Button size="sm" onClick={() => setOverlay({ kind: 'shortcuts' })}>
          Show (?)
        </Button>
      </Row>
    </Group>
  )
}
