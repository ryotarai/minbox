import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SlackItem, type SlackThreadDetail } from '../api'
import { useApp } from '../lib/app'
import { fullTime, shortTime } from '../lib/format'
import { GROUP_TITLES, matchesSlack, tomorrowMorning, useSlackThreads, type SlackState } from '../lib/slack'
import { IconBack, IconRefresh, IconSearch, IconSlack } from './icons'
import { ProjectRail } from './ProjectRail'
import { SlackStartThreadDialog } from './SlackStartThread'
import { Button, IconButton, cx } from './ui'

// Slack (personal): the threads and DMs that need my reply, judged by the helper agent. Left: the
// list (Needs reply / Maybe / Dismissed), searchable and refreshable; right: the thread, the
// judgement, Dismiss / Snooze and "Start minbox thread". The selection lives in the URL
// (#v=slack&thread=C123:1700000000.000100). See docs/slack-personal.md.

export function SlackScreen() {
  const { isPhone, isTablet } = useApp()
  return isPhone ? <PhoneSlack /> : <SlackDesktop tablet={isTablet} />
}

function useSlackScreen() {
  const { route, navigate } = useApp()
  const state = useSlackThreads()
  const select = useCallback((id: string | null) => navigate({ slack: id }, { push: true }), [navigate])
  return { state, selected: route.slack, select }
}

function SlackDesktop({ tablet }: { tablet: boolean }) {
  const { layout, goBack } = useApp()
  const c = useSlackScreen()
  const narrow = tablet || (layout.projectsRail ?? window.innerWidth < 1400)
  return (
    <div className="flex h-full w-full overflow-hidden bg-bg" data-testid="slack-screen">
      <div style={{ width: narrow ? 56 : 176 }} className="shrink-0 border-r border-line">
        <ProjectRail narrow={narrow} />
      </div>
      <div style={{ width: tablet ? 320 : 400 }} className="shrink-0 border-r border-line">
        <SlackList state={c.state} selected={c.selected} onSelect={c.select} onBack={() => goBack(undefined, { leave: true })} />
      </div>
      <div className="min-w-0 flex-1">
        {c.selected ? (
          <SlackDetail key={c.selected} id={c.selected} item={c.state.data?.items.find((i) => i.id === c.selected)} onChanged={c.state.reload} />
        ) : (
          <div data-testid="slack-empty" className="flex h-full items-center justify-center text-[13.5px] text-subtle">
            Pick a thread
          </div>
        )}
      </div>
    </div>
  )
}

function PhoneSlack() {
  const { goBack } = useApp()
  const c = useSlackScreen()
  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-surface pt-[env(safe-area-inset-top)]" data-testid="slack-screen" data-screen={c.selected ? 'detail' : 'list'}>
      {c.selected ? (
        <SlackDetail key={c.selected} id={c.selected} phone item={c.state.data?.items.find((i) => i.id === c.selected)} onBack={() => goBack({ slack: null })} onChanged={c.state.reload} />
      ) : (
        <SlackList state={c.state} selected={null} phone onSelect={c.select} onBack={() => goBack(undefined, { leave: true })} />
      )}
    </div>
  )
}

// ---- the list ----

function UrgencyChip({ item }: { item: SlackItem }) {
  const u = item.judgement?.urgency
  if (!u || u === 'normal') return null
  return (
    <span data-testid="slack-urgency" data-urgency={u} className={cx('shrink-0 rounded-full px-1.5 text-[10.5px] font-bold uppercase leading-[16px]', u === 'high' ? 'bg-wait/20 text-wait' : 'bg-chip text-subtle')}>
      {u}
    </span>
  )
}

function SlackRow({ item: i, on, phone, onSelect }: { item: SlackItem; on: boolean; phone?: boolean; onSelect: (id: string) => void }) {
  const j = i.judgement
  return (
    <button
      type="button"
      data-testid="slack-row"
      data-id={i.id}
      data-group={i.group}
      aria-current={on || undefined}
      onClick={() => onSelect(i.id)}
      className={cx('flex w-full flex-col gap-0.5 border-0 border-b border-line px-3 text-left', phone ? 'min-h-[68px] py-2' : 'py-1.5', on ? 'bg-rowsel' : 'bg-transparent hover:bg-raised')}
    >
      <span className="flex min-w-0 items-center gap-2">
        {i.unread && <span data-testid="slack-unread" aria-label="Unread" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
        <span data-testid="slack-row-label" className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">
          {i.label}
          {i.kind !== 'dm' && i.people.length > 0 && <span className="font-normal text-subtle"> · {i.people.slice(0, 3).join(', ')}</span>}
        </span>
        <UrgencyChip item={i} />
        {i.minbox_thread && (
          <span data-testid="slack-row-thread" title="A minbox thread exists for this Slack thread" className="shrink-0 rounded-full bg-chip px-1.5 text-[11px] font-bold leading-[18px] text-fg2">
            ⛓
          </span>
        )}
        <span className="shrink-0 text-[11.5px] text-subtle">{i.last_at ? shortTime(i.last_at) : ''}</span>
      </span>
      <span data-testid="slack-row-snippet" className="truncate text-[12.5px] text-muted">
        <b className="font-semibold text-fg2">{i.last_is_me ? 'You' : i.last_author || 'Someone'}:</b> {i.snippet}
      </span>
      <span data-testid="slack-row-reason" className="truncate text-[11.5px] italic text-subtle">
        {j ? (
          j.reason || j.summary
        ) : (
          <>Not judged yet: the helper could not read it (listed as Maybe)</>
        )}
        {i.reappeared && <span className="not-italic text-wait"> · new message</span>}
        {i.snooze_until && <span className="not-italic"> · until {shortTime(i.snooze_until)}</span>}
        {i.state === 'muted' && <span className="not-italic"> · muted</span>}
      </span>
    </button>
  )
}

function SlackList({ state, selected, onSelect, phone, onBack }: { state: SlackState; selected: string | null; onSelect: (id: string) => void; phone?: boolean; onBack?: () => void }) {
  const { navigate } = useApp()
  const [q, setQ] = useState('')
  const [showDismissed, setShowDismissed] = useState(false)
  const { data, syncing, error, refresh } = state
  const items = useMemo(() => (data?.items ?? []).filter((i) => matchesSlack(i, q)), [data, q])
  const by = (g: string) => items.filter((i) => i.group === g)
  const notConnected = error?.status === 409
  const prog = data?.refresh
  const total = (data?.items ?? []).length
  const dismissedAll = (data?.counts.dismissed ?? 0) > 0
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Slack" data-testid="slack-list">
      <header className={cx('flex shrink-0 items-center gap-1.5 border-b border-line px-3', phone ? 'h-14' : 'h-12')}>
        {onBack && (
          <IconButton size={phone ? 44 : 32} aria-label="Back" title="Back (Esc)" data-testid="slack-back" onClick={onBack} className="-ml-2 text-fg2">
            <IconBack size={phone ? 20 : 16} />
          </IconButton>
        )}
        <IconSlack size={15} className="shrink-0 text-fg2" />
        <h1 className="m-0 min-w-0 flex-1 truncate text-[15px] font-[650]">Slack</h1>
        {syncing && (
          <span data-testid="slack-syncing" className="shrink-0 text-[11.5px] text-subtle">
            {prog?.running && prog.stage ? `${prog.stage}${prog.total ? ` ${prog.done}/${prog.total}` : ''}…` : 'Syncing…'}
          </span>
        )}
        <IconButton size={phone ? 44 : 30} aria-label="Refresh" title="Refresh from Slack" data-testid="slack-refresh" disabled={syncing} onClick={refresh}>
          <IconRefresh size={15} />
        </IconButton>
      </header>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-3 py-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-linestrong bg-sunken px-2 text-subtle focus-within:border-accent">
          <IconSearch size={13} />
          <input
            data-testid="slack-search"
            aria-label="Search threads"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search threads"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-fg outline-none"
          />
        </label>
        <div className="flex items-center gap-2 text-[12px] text-muted" data-testid="slack-counts">
          <span data-testid="slack-count-needs">{data?.counts.needs_reply ?? 0} need a reply</span>
          <span>·</span>
          <span data-testid="slack-count-maybe">{data?.counts.maybe ?? 0} maybe</span>
          <span className="flex-1" />
          {data?.fetched_at && !syncing && <span data-testid="slack-updated">Updated {shortTime(data.fetched_at)}</span>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div role="alert" data-testid="slack-error" className="m-3 flex flex-col gap-2 rounded-lg border border-danger/40 bg-dangerstrong/10 px-3 py-2 text-[12.5px] text-dangerfg">
            <span>{notConnected ? 'Connect Slack first: ' : ''}{error.message}</span>
            <span className="flex gap-2">
              <Button size="sm" data-testid="slack-open-settings" onClick={() => navigate({ view: 'settings', ss: 'integrations' }, { push: true })}>
                Open Settings
              </Button>
              <Button size="sm" onClick={refresh}>
                Retry
              </Button>
            </span>
          </div>
        )}
        {data?.backend_note && (
          <div data-testid="slack-backend-note" className="mx-3 mt-2 rounded-md border border-line2 px-2.5 py-1.5 text-[12px] text-subtle">
            {data.backend_note}
          </div>
        )}
        {prog?.partial && (
          <div data-testid="slack-partial" className="mx-3 mt-2 rounded-md border border-wait/40 bg-wait/10 px-2.5 py-1.5 text-[12px] text-fg2">
            Partial results: Slack asked minbox to slow down{prog.wait_until ? ` until ${new Date(prog.wait_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}. Refresh again after that to read the rest.
          </div>
        )}
        {(data?.notes ?? []).map((n) => (
          <div key={n} data-testid="slack-note" className="mx-3 mt-2 rounded-md border border-line2 px-2.5 py-1.5 text-[12px] text-subtle">
            {n}
          </div>
        ))}
        {!data && !error && (
          <div data-testid="slack-loading" className="px-4 py-6 text-[13px] text-subtle">
            Loading your Slack threads…
          </div>
        )}
        {data && items.length === 0 && !error && (
          <div data-testid="slack-none" className="px-4 py-6 text-[13px] text-subtle">
            {total === 0 ? (syncing ? 'Reading Slack…' : 'Nothing needs your reply right now.') : 'No thread matches the search.'}
            {data.hidden > 0 && !syncing && total === 0 ? ` (${data.hidden} judged as needing nothing)` : ''}
          </div>
        )}
        {(['needs_reply', 'maybe'] as const).map((g) => {
          const rows = by(g)
          if (rows.length === 0) return null
          return (
            <div key={g} data-testid="slack-group" data-group={g}>
              <div className="sticky top-0 z-[1] flex items-center gap-2 bg-bg px-3 py-1.5 text-[12px] font-semibold text-muted">
                <span>{GROUP_TITLES[g]}</span>
                <span data-testid="slack-group-count" className="font-normal text-subtle">
                  {rows.length}
                </span>
              </div>
              {rows.map((i) => (
                <SlackRow key={i.id} item={i} on={selected === i.id} phone={phone} onSelect={onSelect} />
              ))}
            </div>
          )
        })}
        {dismissedAll && (
          <div data-testid="slack-group" data-group="dismissed">
            <button
              type="button"
              data-testid="slack-dismissed-toggle"
              aria-expanded={showDismissed}
              onClick={() => setShowDismissed((v) => !v)}
              className="flex w-full items-center gap-2 border-0 bg-bg px-3 py-1.5 text-left text-[12px] font-semibold text-muted"
            >
              <span>{showDismissed ? '▾' : '▸'}</span>
              <span>{GROUP_TITLES.dismissed}</span>
              <span data-testid="slack-group-count" className="font-normal text-subtle">
                {by('dismissed').length}
              </span>
            </button>
            {showDismissed && by('dismissed').map((i) => <SlackRow key={i.id} item={i} on={selected === i.id} phone={phone} onSelect={onSelect} />)}
          </div>
        )}
        {data && data.hidden > 0 && total > 0 && (
          <div data-testid="slack-hidden" className="px-4 py-3 text-[11.5px] text-subtle">
            {data.hidden} more thread{data.hidden === 1 ? '' : 's'} judged as needing nothing.
          </div>
        )}
      </div>
    </section>
  )
}

// ---- the detail ----

function useSlackDetail(id: string) {
  const [data, setData] = useState<SlackThreadDetail | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => void (live.current = false)
  }, [])
  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true)
      setErr('')
      api
        .slackThread(id, refresh)
        .then((r) => live.current && setData(r))
        .catch((e) => live.current && setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => live.current && setLoading(false))
    },
    [id],
  )
  useEffect(() => load(false), [load])
  return { data, err, loading, reload: () => load(true), refetch: () => load(false) }
}

function initials(n: string): string {
  return (n.replace(/^@/, '').trim()[0] ?? '?').toUpperCase()
}

function SnoozeMenu({ onSnooze, phone }: { onSnooze: (d: Date) => void; phone?: boolean }) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const pick = (d: Date) => {
    setOpen(false)
    onSnooze(d)
  }
  const item = 'flex h-9 w-full items-center border-0 bg-transparent px-3 text-left text-[13px] text-fg hover:bg-raised'
  return (
    <div ref={ref} className="relative">
      <Button size={phone ? 'lg' : 'sm'} data-testid="slack-snooze" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Snooze ▾
      </Button>
      {open && (
        <div role="menu" data-testid="slack-snooze-menu" className={cx('absolute z-20 w-[220px] overflow-hidden rounded-lg border border-linestrong bg-raised py-1 shadow-lg', phone ? 'bottom-full mb-1 right-0' : 'right-0 mt-1')}>
          <button type="button" role="menuitem" data-testid="slack-snooze-1h" className={item} onClick={() => pick(new Date(Date.now() + 3_600_000))}>
            For 1 hour
          </button>
          <button type="button" role="menuitem" data-testid="slack-snooze-tomorrow" className={item} onClick={() => pick(tomorrowMorning())}>
            Until tomorrow 9:00
          </button>
          <div className="flex items-center gap-1.5 px-3 py-1.5">
            <input type="datetime-local" data-testid="slack-snooze-custom" aria-label="Custom time" value={custom} onChange={(e) => setCustom(e.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-linestrong bg-sunken px-1.5 text-[12px] text-fg" />
            <Button size="sm" data-testid="slack-snooze-custom-set" disabled={!custom || new Date(custom).getTime() <= Date.now()} onClick={() => pick(new Date(custom))}>
              Set
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SlackDetail({ id, item, phone, onBack, onChanged }: { id: string; item?: SlackItem; phone?: boolean; onBack?: () => void; onChanged: () => void }) {
  const { navigate, error, toast } = useApp()
  const { data, err, loading, reload, refetch } = useSlackDetail(id)
  const [starting, setStarting] = useState(false)
  const act = async (action: 'dismiss' | 'mute' | 'snooze' | 'restore', until?: Date) => {
    try {
      await api.slackState(id, action, until)
      toast(action === 'dismiss' ? 'Dismissed. It comes back if a new message arrives.' : action === 'mute' ? 'Muted: it will not come back.' : action === 'snooze' ? 'Snoozed.' : 'Restored.')
      onChanged()
      refetch()
    } catch (e) {
      error(e)
    }
  }
  const label = data?.label ?? item?.label ?? id
  const j = data?.judgement ?? item?.judgement ?? undefined
  const linked = data?.minbox_thread ?? item?.minbox_thread ?? undefined
  const state = data?.state ?? item?.state ?? 'active'
  const dismissed = state === 'dismissed' || state === 'snoozed' || state === 'muted'
  const permalink = data?.permalink ?? item?.permalink
  const openThread = (t: { session_id: string; thread_id: string }) => navigate({ view: 'main', s: t.session_id, t: t.thread_id, f: null, tab: 'inbox' }, { push: true })
  const actions = (
    <>
      {dismissed ? (
        <Button size={phone ? 'lg' : 'sm'} data-testid="slack-restore" onClick={() => void act('restore')}>
          Restore
        </Button>
      ) : (
        <Button size={phone ? 'lg' : 'sm'} data-testid="slack-dismiss" onClick={() => void act('dismiss')}>
          Dismiss
        </Button>
      )}
      <SnoozeMenu phone={phone} onSnooze={(d) => void act('snooze', d)} />
    </>
  )
  return (
    <section className="relative flex h-full min-h-0 flex-col bg-surface" aria-label="Slack thread" data-testid="slack-detail" data-id={id}>
      <header className={cx('flex shrink-0 items-center gap-2 border-b border-line px-3', phone ? 'h-14' : 'h-12')}>
        {phone && (
          <IconButton size={44} aria-label="Back to Slack threads" data-testid="slack-detail-back" onClick={onBack} className="-ml-2 text-fg2">
            <IconBack size={20} />
          </IconButton>
        )}
        <span data-testid="slack-detail-label" className="min-w-0 truncate text-[14px] font-semibold text-fg">
          {label}
        </span>
        {permalink && (
          <a href={permalink} target="_blank" rel="noopener noreferrer" data-testid="slack-open" aria-label="Open in Slack" className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-accent no-underline hover:underline">
            Open in Slack ↗
          </a>
        )}
        <span className="flex-1" />
        {loading && (
          <span data-testid="slack-detail-loading" className="text-[11.5px] text-subtle">
            Loading…
          </span>
        )}
        <IconButton size={phone ? 44 : 30} aria-label="Reload thread" title="Reload thread" data-testid="slack-reload" onClick={reload}>
          <IconRefresh size={15} />
        </IconButton>
        {!phone && (
          <>
            {actions}
            <Button variant="primary" size="sm" data-testid="slack-start-thread" disabled={!data} onClick={() => setStarting(true)}>
              Start minbox thread
            </Button>
          </>
        )}
      </header>
      <div className={cx('min-h-0 flex-1 overflow-y-auto px-5 py-4', phone && 'pb-28')}>
        {err && (
          <div role="alert" data-testid="slack-detail-error" className="mb-3 rounded-lg border border-danger/40 bg-dangerstrong/10 px-3 py-2 text-[12.5px] text-dangerfg">
            {err}
          </div>
        )}
        {data?.note && (
          <div data-testid="slack-detail-note" className="mb-3 rounded-md border border-line2 px-2.5 py-1.5 text-[12px] text-subtle">
            {data.note}
          </div>
        )}
        {j && (
          <div data-testid="slack-judgement" data-needs={j.needs_reply} className="mb-4 rounded-lg border border-line2 bg-card px-3 py-2.5">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px]">
              <span className="font-semibold uppercase tracking-wide text-subtle">Helper's judgement</span>
              <span data-testid="slack-judgement-needs" className={cx('rounded-full px-2 py-px text-[11px] font-bold', j.needs_reply === 'yes' ? 'bg-wait/20 text-wait' : 'bg-chip text-fg2')}>
                {j.needs_reply === 'yes' ? 'Needs reply' : j.needs_reply === 'maybe' ? 'Maybe' : 'Nothing needed'}
              </span>
              <span data-testid="slack-judgement-urgency" className="text-subtle">
                urgency {j.urgency}
              </span>
              <span className="text-faint">machine-generated, can be wrong{data?.judgement_stale ? ' · older than the latest message' : ''}</span>
            </div>
            <div data-testid="slack-judgement-reason" className="text-[13.5px] text-fg">
              {j.reason}
            </div>
            {j.summary && (
              <div data-testid="slack-judgement-summary" className="mt-1 text-[13px] text-muted">
                {j.summary}
              </div>
            )}
            {j.suggested_next_step && <div className="mt-1 text-[12.5px] text-subtle">Next step: {j.suggested_next_step}</div>}
          </div>
        )}
        {!j && data && (
          <div data-testid="slack-unjudged" className="mb-4 rounded-md border border-line2 px-2.5 py-1.5 text-[12px] text-subtle">
            Not judged yet: the helper could not read this thread (it is tried again on the next refresh).
          </div>
        )}
        <div data-testid="slack-threads" className="mb-4">
          <h3 className="m-0 mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle">minbox thread</h3>
          {!linked ? (
            <span className="text-[12.5px] text-subtle">No minbox thread has been started from this Slack thread yet.</span>
          ) : (
            <button
              type="button"
              data-testid="slack-linked-thread"
              onClick={() => openThread(linked)}
              className="flex min-h-9 w-full items-center gap-2 rounded-md border border-line2 bg-transparent px-2.5 text-left hover:bg-raised"
            >
              <span className="min-w-0 flex-1 truncate text-[13px]">{linked.subject}</span>
              <span className="shrink-0 text-[11.5px] text-subtle">{linked.status}</span>
            </button>
          )}
        </div>
        {data && data.earlier > 0 && <div className="mb-2 text-[12px] text-subtle">{data.earlier} earlier messages are not shown.</div>}
        <div className="flex flex-col gap-3" data-testid="slack-messages">
          {(data?.messages ?? []).map((m) => (
            <article key={m.ts} data-testid="slack-message" data-me={m.is_me || undefined} className="flex gap-2.5">
              <span aria-hidden="true" className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[12px] font-bold', m.is_me ? 'bg-accent/20 text-accent' : 'bg-chip text-fg2')}>
                {initials(m.name)}
              </span>
              <div className="min-w-0 flex-1">
                <header className="mb-0.5 flex items-baseline gap-2 text-[12px] text-subtle">
                  <b data-testid="slack-message-author" className="font-semibold text-fg2">
                    {m.name}
                    {m.is_me ? ' (you)' : ''}
                  </b>
                  {m.is_bot && <span className="rounded bg-chip px-1 text-[10.5px]">APP</span>}
                  {m.at && (
                    <time dateTime={m.at} title={fullTime(m.at)}>
                      {shortTime(m.at)}
                    </time>
                  )}
                </header>
                <div
                  data-testid="slack-message-body"
                  className="break-words text-[13.5px] leading-[1.5] text-body [&_.mention]:rounded [&_.mention]:bg-accent/15 [&_.mention]:px-1 [&_.mention]:text-accent [&_a]:text-accent [&_blockquote]:my-1 [&_blockquote]:border-l-[3px] [&_blockquote]:border-linestrong [&_blockquote]:pl-2.5 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-sunken [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px] [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-sunken [&_pre]:p-2"
                  dangerouslySetInnerHTML={{ __html: m.html }}
                />
                {(m.files.length > 0 || m.attachments.length > 0) && (
                  <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-[12.5px]" data-testid="slack-message-files">
                    {[...m.files, ...m.attachments].map((f, n) => (
                      <li key={n} className="truncate text-subtle">
                        📎{' '}
                        {f.url ? (
                          <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-accent">
                            {f.name}
                          </a>
                        ) : (
                          f.name
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>
          ))}
        </div>
        {!data && !err && <span className="text-[13px] text-subtle">Loading the thread…</span>}
      </div>
      {phone && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 border-t border-line bg-surface px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-2" data-testid="slack-sticky-actions">
          {actions}
          <Button variant="primary" size="lg" className="flex-1" data-testid="slack-start-thread" disabled={!data} onClick={() => setStarting(true)}>
            Start minbox thread
          </Button>
        </div>
      )}
      {starting && data && <SlackStartThreadDialog thread={data} onClose={() => setStarting(false)} onStarted={onChanged} />}
    </section>
  )
}
