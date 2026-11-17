import { Component, useEffect, useState, type ReactNode } from 'react'
import { api, type About, type AgentKind, type Session, type Storage, type Thread } from '../api'
import { agentsSummary, installedAgents, useAgents } from '../lib/agents'
import { hostAgentReasons } from './Hosts'
import { useApp } from '../lib/app'
import { notificationPermission, notify, requestNotifications, dingDong } from '../lib/alerts'
import { bytes, homeRelative, shortTime } from '../lib/format'
import { useHotkeys } from '../lib/hotkeys'
import { IconBack } from './icons'
import { Button, Segmented, Switch, cx } from './ui'
import { HostsSection } from './Hosts'
import { DevicesSection } from './Devices'
import { NotificationsSection } from './Notifications'
import { IntegrationsSection } from './Integrations'

const NAV: { id: string; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'integrations', label: 'Integrations' },
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
  const meta: Record<string, string> = { hosts: hosts.length ? String(hosts.length) : '', capabilities: 'Tasks · Decision mode', archived: archivedCount ? String(archivedCount) : '' }
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
        <SectionBoundary key={section}>
        {section === 'general' && <General />}
        {section === 'notifications' && <NotificationsSection />}
        {section === 'integrations' && <IntegrationsSection />}
        {section === 'hosts' && <HostsSection />}
        {section === 'devices' && <DevicesSection />}
        {section === 'prompts' && <Prompts />}
        {section === 'capabilities' && <Capabilities />}
        {section === 'archived' && <Archived />}
        {section === 'storage' && <StorageSection />}
        {section === 'about' && <AboutSection about={about} />}
        </SectionBoundary>
      </main>
    </div>
  )
}

// A crash inside one settings section shows a message here instead of blanking the whole app.
class SectionBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) {
    return { err }
  }
  componentDidCatch(err: Error) {
    console.error('settings section crashed', err)
  }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div data-testid="settings-crash" role="alert" className="flex max-w-[720px] flex-col gap-2 rounded-xl border border-line bg-surface px-4 py-4 text-[13.5px]">
        <strong className="text-danger">This section failed to render.</strong>
        <span className="mono break-words text-[12px] text-muted">{String(this.state.err.message || this.state.err)}</span>
        <span className="text-muted">Reload the page; if it keeps happening, report the message above.</span>
      </div>
    )
  }
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
        <Row label="Swap terminal and thread" desc="On: the thread is left of the terminal (the default). Off: the terminal is next to the threads list and the thread is on the far right.">
          <Switch label="Swap terminal and thread" on={settings.swap_panes} onChange={(v) => saveSettings({ swap_panes: v })} />
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
      <Row
        label="Orchestrator prompt: ask the main agent to run a subagent per thread and use git worktrees for subagent changes"
        desc="Applies to sessions started or resumed after the change"
      >
        <Switch label="Orchestrator prompt" on={settings.orchestrator_prompt} onChange={(v) => saveSettings({ orchestrator_prompt: v })} />
      </Row>
      <Row
        label="Help me reply: questions with options above the reply box"
        desc="When the agent spoke last, sends the recent messages of the open thread to claude (Haiku) to draft a few questions for you; the answers you pick go into your reply. Runs on this machine; costs a little per thread."
      >
        <Switch label="Help me reply" on={settings.reply_suggestions} onChange={(v) => saveSettings({ reply_suggestions: v })} />
      </Row>
    </Group>
  )
}

function Capabilities() {
  const { settings, saveSettings } = useApp()
  return (
    <>
      <AgentsGroup />
      <Group title="Optional parts of minbox">
      <Row label="Decision mode (Experimental)" desc="Every waiting question across sessions, one at a time. Pick with 1–9; answers are sent per thread.">
        <Switch label="Decision mode" on={settings.decision_mode} onChange={(v) => saveSettings({ decision_mode: v })} />
      </Row>
      </Group>
    </>
  )
}

// Which coding agents this machine has, and which one new sessions start with. Any one is enough.
function AgentsGroup() {
  const { settings, saveSettings, hosts } = useApp()
  const info = useAgents()
  const installed = installedAgents(info)
  const remotes = hosts.filter((h) => !h.builtin)
  return (
    <Group title="Coding agents">
      {!info && <span className="text-[13px] text-subtle">Loading…</span>}
      {info?.agents.map((a) => (
        <Row
          key={a.kind}
          label={a.label}
          desc={
            !a.installed
              ? `Not installed: no “${a.command.split(' ')[0] || a.kind}” on the server's PATH`
              : a.supported === false
                ? `Found at ${a.path}, but not supported: ${a.reason ?? 'unknown reason'}`
                : `Found at ${a.path}${a.version ? ` (version ${a.version})` : ''}`
          }
        >
          <span
            data-testid={`agent-status-${a.kind}`}
            className={cx('mono text-[12.5px]', a.installed && a.supported !== false ? 'text-ok' : a.installed ? 'text-waitfg' : 'text-subtle')}
          >
            {!a.installed ? 'not installed' : a.supported === false ? 'unsupported' : a.version ? `installed · ${a.version}` : 'installed'}
          </span>
        </Row>
      ))}
      {info && installed.length === 0 && (
        <p className="m-0 text-[13px] leading-[1.6] text-muted">No coding agent is installed, so sessions cannot start. Install Claude Code, Pi or OpenCode 2; any one alone is enough.</p>
      )}
      {installed.length > 1 && (
        <Row label="Default agent" desc="For a new session when neither the dialog nor the project says. Projects can set their own.">
          <select
            data-testid="default-agent"
            value={settings.default_agent}
            onChange={(e) => saveSettings({ default_agent: e.target.value as '' | AgentKind })}
            className="h-8 rounded-md border border-linestrong bg-sunken px-2 text-[13px]"
          >
            <option value="">Claude Code, unless it is missing</option>
            {installed.map((a) => (
              <option key={a.kind} value={a.kind}>
                {a.label}
              </option>
            ))}
          </select>
        </Row>
      )}
      <Row
        label="Trust folders Claude starts in"
        desc="Before a Claude Code session starts, marks its folder trusted in Claude Code's config on the machine it runs on (~/.claude.json, or $CLAUDE_CONFIG_DIR), so it does not stop at the “Do you trust this folder?” dialog. Off: Claude Code asks as usual."
      >
        <Switch label="Trust folders Claude starts in" on={settings.claude_trust_folders} onChange={(v) => saveSettings({ claude_trust_folders: v })} />
      </Row>
      {remotes.map((h) => (
        <Row key={h.id} label={`On ${h.name}`} desc={h.status === 'online' ? 'Another host: what its machine has (Settings › Hosts).' : `Another host, ${h.status}: as last seen.`}>
          <span data-testid="host-agents-summary" title={hostAgentReasons(h)} className="mono text-[12.5px] text-muted">
            {h.agents ? agentsSummary(h.agents) : 'not checked yet'}
          </span>
        </Row>
      ))}
      {info?.agents.some((a) => a.kind === 'pi' && a.installed) && (
        <p className="m-0 text-[12.5px] leading-[1.6] text-subtle">
          Pi runs with your user's full permissions and has no permission prompts, like Claude Code with every permission granted. Its own subagent tool replaces the orchestrator prompt. On another host it needs Pi and Node 22.19+ on that machine.
        </p>
      )}
      {info?.agents.some((a) => a.kind === 'opencode' && a.installed && a.supported !== false) && (
        <p data-testid="opencode-note" className="m-0 text-[12.5px] leading-[1.6] text-subtle">
          OpenCode 2 runs with --auto: everything is approved unless your OpenCode configuration denies it, and it uses your OpenCode login, models and sessions. Each session gets a private OpenCode server (--standalone). On another host it needs OpenCode 2 on that machine. It runs the reply questions only when neither Claude Code nor Pi is installed.
        </p>
      )}
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
