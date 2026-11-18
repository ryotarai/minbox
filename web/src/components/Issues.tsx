import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type IssueComment, type IssueDetailResult, type IssueSummary } from '../api'
import { railWidth, useApp } from '../lib/app'
import { shortTime } from '../lib/format'
import { groupIssues, isClosed, matchesIssue, useMyIssues, type IssuesState } from '../lib/issues'
import { renderMarkdown } from '../lib/markdown'
import { IconBack, IconLinear, IconPlus, IconRefresh, IconSearch } from './icons'
import { LinearCreateDialog } from './LinearCreate'
import { ProjectRail } from './ProjectRail'
import { StartThreadDialog } from './IssueStartThread'
import { Button, IconButton, cx } from './ui'

// My issues: the Linear issues assigned to me. Left: the list (grouped by workflow state, searchable,
// refreshable); right: the selected issue with its description, comments, linked minbox threads and
// "Start thread". The selection lives in the URL (#v=issues&issue=ENG-123). See docs/linear.md.

export function IssuesScreen() {
  const { isPhone, isTablet } = useApp()
  return isPhone ? <PhoneIssues /> : <IssuesDesktop tablet={isTablet} />
}

function useIssuesScreen() {
  const { route, navigate } = useApp()
  const state = useMyIssues()
  const [creating, setCreating] = useState(false)
  const select = useCallback((ident: string | null) => navigate({ issue: ident }, { push: true }), [navigate])
  const created = (i: IssueSummary) => {
    state.add(i)
    select(i.identifier)
    state.refresh()
  }
  return { state, selected: route.issue, select, creating, setCreating, created }
}

function IssuesDesktop({ tablet }: { tablet: boolean }) {
  const { layout, goBack } = useApp()
  const c = useIssuesScreen()
    return (
    <div className="flex h-full w-full overflow-hidden bg-bg" data-testid="issues-screen">
      <div style={{ width: railWidth(layout) }} className="shrink-0 border-r border-line" data-testid="rail-column">
        <ProjectRail />
      </div>
      <div style={{ width: tablet ? 300 : 380 }} className="shrink-0 border-r border-line">
        <IssueList state={c.state} selected={c.selected} onSelect={c.select} onNew={() => c.setCreating(true)} onBack={() => goBack(undefined, { leave: true })} />
      </div>
      <div className="min-w-0 flex-1">
        {c.selected ? (
          <IssueDetail key={c.selected} ident={c.selected} preview={c.state.issues?.find((i) => i.identifier === c.selected)} onRefreshList={c.state.refresh} />
        ) : (
          <div data-testid="issue-empty" className="flex h-full items-center justify-center text-[13.5px] text-subtle">
            Pick an issue
          </div>
        )}
      </div>
      {c.creating && <LinearCreateDialog onClose={() => c.setCreating(false)} onCreated={c.created} />}
    </div>
  )
}

function PhoneIssues() {
  const { goBack } = useApp()
  const c = useIssuesScreen()
  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-surface pt-[env(safe-area-inset-top)]" data-testid="issues-screen" data-screen={c.selected ? 'detail' : 'list'}>
      {c.selected ? (
        <IssueDetail
          key={c.selected}
          ident={c.selected}
          phone
          preview={c.state.issues?.find((i) => i.identifier === c.selected)}
          onBack={() => goBack({ issue: null })}
          onRefreshList={c.state.refresh}
        />
      ) : (
        <IssueList state={c.state} selected={null} phone onSelect={c.select} onNew={() => c.setCreating(true)} onBack={() => goBack(undefined, { leave: true })} />
      )}
      {c.creating && <LinearCreateDialog onClose={() => c.setCreating(false)} onCreated={c.created} />}
    </div>
  )
}

// ---- small pieces ----

const PRIORITY_TITLE = ['No priority', 'Urgent', 'High', 'Medium', 'Low']

/** Linear-style priority: bars for high..low, a box for urgent, dashes for none. */
export function PriorityIcon({ p, size = 14 }: { p: number; size?: number }) {
  const label = PRIORITY_TITLE[p] ?? 'No priority'
  if (p === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label} data-priority={p} className="shrink-0 text-wait">
        <title>{label}</title>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
        <path d="M8 4.5v4.2M8 10.6v.9" stroke="var(--mb-bg)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  const bars = p === 0 ? 0 : 5 - p // high 3, medium 2, low 1
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label} data-priority={p} className={cx('shrink-0', p === 0 ? 'text-faint' : 'text-fg2')}>
      <title>{label}</title>
      {p === 0 ? (
        <path d="M3 8h2M7 8h2M11 8h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        [0, 1, 2].map((i) => <rect key={i} x={2 + i * 4.5} y={10 - i * 3} width="3" height={4 + i * 3} rx="0.8" fill="currentColor" opacity={i < bars ? 1 : 0.25} />)
      )}
    </svg>
  )
}

export function StateDot({ type, size = 12 }: { type: string; size?: number }) {
  const color = type === 'started' ? 'text-wait' : type === 'completed' ? 'text-ok' : type === 'canceled' ? 'text-faint' : 'text-subtle'
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" data-state-type={type} className={cx('shrink-0', color)}>
      {type === 'completed' ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M5 8.2 7.2 10.4 11 6" stroke="var(--mb-bg)" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : type === 'canceled' ? (
        <>
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : type === 'started' ? (
        <>
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 4.2a3.8 3.8 0 0 1 0 7.6z" fill="currentColor" />
        </>
      ) : (
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={type === 'backlog' ? '2.2 2.2' : undefined} />
      )}
    </svg>
  )
}

/** Sanitised Markdown, as in messages; remote images are not fetched (they would leak the viewer's address to whoever wrote the issue). */
function renderIssueMarkdown(src: string): string {
  const html = renderMarkdown(src)
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const s = img.getAttribute('src') ?? ''
    img.replaceWith(Object.assign(doc.createElement('span'), { className: 'text-[12px] text-subtle', textContent: `[image not shown: ${s}]` }))
  }
  for (const a of Array.from(doc.querySelectorAll('a'))) {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  }
  return doc.body.firstElementChild?.innerHTML ?? ''
}

function Markdown({ text, testid }: { text: string; testid?: string }) {
  const html = useMemo(() => renderIssueMarkdown(text), [text])
  return <div data-testid={testid} className="md text-[13.5px] text-body" dangerouslySetInnerHTML={{ __html: html }} />
}

// ---- the list ----

/** What Linear answered, as a structure summary (key names and types, no values): open by itself, with a button to copy it for a bug report. */
function Diagnostics({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <details data-testid="issues-diagnostics" open className={cx('rounded-md border border-line2 px-2.5 py-1.5 text-[12px] text-subtle', className)}>
      <summary className="cursor-pointer">Details</summary>
      <pre data-testid="issues-diagnostics-text" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap select-text font-mono text-[11px]">
        {text}
      </pre>
      <Button
        size="sm"
        data-testid="issues-diagnostics-copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
      >
        {copied ? 'Copied' : 'Copy diagnostics'}
      </Button>
    </details>
  )
}

function IssueList({
  state,
  selected,
  onSelect,
  onNew,
  phone,
  onBack,
}: {
  state: IssuesState
  selected: string | null
  onSelect: (ident: string) => void
  onNew: () => void
  phone?: boolean
  onBack?: () => void
}) {
  const { navigate } = useApp()
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState(false)
  const { issues, syncing, error, warnings, diagnostics, fetchedAt, refresh } = state
  // An error may carry a structure summary of Linear's raw answer after its first line(s).
  const errCut = error ? error.message.indexOf('\ntool: ') : -1
  const errText = error ? (errCut >= 0 ? error.message.slice(0, errCut) : error.message) : ''
  const errDiag = error && errCut >= 0 ? error.message.slice(errCut + 1) : ''
  const visible = useMemo(() => (issues ?? []).filter((i) => (closed || !isClosed(i.state_type)) && matchesIssue(i, q)), [issues, closed, q])
  const groups = useMemo(() => groupIssues(visible), [visible])
  const closedCount = useMemo(() => (issues ?? []).filter((i) => isClosed(i.state_type)).length, [issues])
  const loginNeeded = error?.status === 409
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="My issues" data-testid="issues-list">
      <header className={cx('flex shrink-0 items-center gap-1.5 border-b border-line px-3', phone ? 'h-14' : 'h-12')}>
        {onBack && (
          <IconButton size={phone ? 44 : 32} aria-label="Back" title="Back (Esc)" data-testid="issues-back" onClick={onBack} className="-ml-2 text-fg2">
            <IconBack size={phone ? 20 : 16} />
          </IconButton>
        )}
        <IconLinear size={15} className="shrink-0 text-fg2" />
        <h1 className="m-0 min-w-0 flex-1 truncate text-[15px] font-[650]">My issues</h1>
        {syncing && (
          <span data-testid="issues-syncing" className="shrink-0 text-[11.5px] text-subtle">
            Syncing…
          </span>
        )}
        <IconButton size={phone ? 44 : 30} aria-label="Refresh" title="Refresh from Linear" data-testid="issues-refresh" disabled={syncing} onClick={refresh}>
          <IconRefresh size={15} />
        </IconButton>
        <Button size="sm" variant="primary" data-testid="issues-new" onClick={onNew} className={phone ? 'h-9' : undefined}>
          <IconPlus size={13} />
          New issue
        </Button>
      </header>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-3 py-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-linestrong bg-sunken px-2 text-subtle focus-within:border-accent">
          <IconSearch size={13} />
          <input
            data-testid="issues-search"
            aria-label="Search issues"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search assigned issues"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-fg outline-none"
          />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-muted">
          <input type="checkbox" data-testid="issues-closed" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
          Show closed{closedCount > 0 ? ` (${closedCount})` : ''}
          <span className="flex-1" />
          {fetchedAt && !syncing && <span data-testid="issues-updated">Updated {shortTime(fetchedAt)}</span>}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div role="alert" data-testid="issues-error" className="m-3 flex flex-col gap-2 rounded-lg border border-danger/40 bg-dangerstrong/10 px-3 py-2 text-[12.5px] text-dangerfg">
            <span>{loginNeeded ? 'Connect Linear first (or log in again): ' : ''}{errText}</span>
            {errDiag && <Diagnostics text={errDiag} />}
            <span className="flex gap-2">
              {loginNeeded && (
                <Button size="sm" data-testid="issues-connect" onClick={() => navigate({ view: 'settings', ss: 'integrations' }, { push: true })}>
                  Open Settings
                </Button>
              )}
              <Button size="sm" onClick={refresh}>
                Retry
              </Button>
            </span>
          </div>
        )}
        {warnings.map((w) => (
          <div key={w} data-testid="issues-warning" className="mx-3 mt-2 rounded-md border border-line2 px-2.5 py-1.5 text-[12px] text-subtle">
            {w}
          </div>
        ))}
        {diagnostics && <Diagnostics text={diagnostics} className="mx-3 mt-2" />}
        {issues === null && !error && (
          <div data-testid="issues-loading" className="px-4 py-6 text-[13px] text-subtle">
            Loading your issues…
          </div>
        )}
        {issues !== null && visible.length === 0 && !error && (
          <div data-testid="issues-none" className="px-4 py-6 text-[13px] text-subtle">
            {issues.length === 0 ? 'No issues are assigned to you.' : q ? 'No issue matches the search.' : 'No open issues are assigned to you. Show closed to see the rest.'}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key} data-testid="issue-group" data-state={g.state}>
            <div className="sticky top-0 z-[1] flex items-center gap-2 bg-bg px-3 py-1.5 text-[12px] font-semibold text-muted">
              <StateDot type={g.type} />
              <span>{g.state}</span>
              <span data-testid="issue-group-count" className="font-normal text-subtle">
                {g.items.length}
              </span>
            </div>
            {g.items.map((i) => (
              <IssueRow key={i.identifier} issue={i} on={selected === i.identifier} phone={phone} onSelect={onSelect} />
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}

function IssueRow({ issue: i, on, phone, onSelect }: { issue: IssueSummary; on: boolean; phone?: boolean; onSelect: (ident: string) => void }) {
  const shown = i.labels.slice(0, 2)
  return (
    <button
      type="button"
      data-testid="issue-row"
      data-ident={i.identifier}
      aria-current={on || undefined}
      onClick={() => onSelect(i.identifier)}
      className={cx(
        'flex w-full flex-col gap-0.5 border-0 border-b border-line px-3 text-left',
        phone ? 'min-h-[60px] py-2' : 'py-1.5',
        on ? 'bg-rowsel' : 'bg-transparent hover:bg-raised',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <PriorityIcon p={i.priority} />
        <span className="mono shrink-0 text-[11.5px] text-subtle">{i.identifier}</span>
        <span data-testid="issue-row-title" className="min-w-0 flex-1 truncate text-[13.5px] text-fg">
          {i.title}
        </span>
        {i.threads.length > 0 && (
          <span data-testid="issue-row-threads" title={`${i.threads.length} linked minbox thread${i.threads.length === 1 ? '' : 's'}`} className="shrink-0 rounded-full bg-chip px-1.5 text-[11px] font-bold leading-[18px] text-fg2">
            ⛓ {i.threads.length}
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-[22px] text-[11.5px] text-subtle">
        <StateDot type={i.state_type} size={10} />
        <span className="shrink-0">{i.state}</span>
        {i.team_key && <span className="mono shrink-0">· {i.team_key}</span>}
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {shown.map((l) => (
            <span key={l} className="max-w-[90px] shrink-0 truncate rounded-full border border-line2 px-1.5 text-[10.5px] leading-4">
              {l}
            </span>
          ))}
          {i.labels.length > shown.length && <span className="shrink-0">+{i.labels.length - shown.length}</span>}
        </span>
        <span className="shrink-0">{shortTime(i.updated_at)}</span>
      </span>
    </button>
  )
}

// ---- the detail ----

function useIssueDetail(ident: string) {
  const [data, setData] = useState<IssueDetailResult | null>(null)
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
        .issueGet(ident, refresh)
        .then((r) => live.current && setData(r))
        .catch((e) => live.current && setErr(e instanceof Error ? e.message : String(e)))
        .finally(() => live.current && setLoading(false))
    },
    [ident],
  )
  useEffect(() => load(false), [load])
  return { data, err, loading, reload: () => load(true) }
}

function Prop({ label, children, testid }: { label: string; children: React.ReactNode; testid?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-subtle">{label}</span>
      <span data-testid={testid} className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-fg">
        {children}
      </span>
    </div>
  )
}

function IssueDetail({ ident, preview, phone, onBack, onRefreshList }: { ident: string; preview?: IssueSummary; phone?: boolean; onBack?: () => void; onRefreshList: () => void }) {
  const { navigate } = useApp()
  const { data, err, loading, reload } = useIssueDetail(ident)
  const [starting, setStarting] = useState(false)
  const issue = data?.issue ?? preview
  const openThread = (t: { session_id: string; thread_id: string }) => navigate({ view: 'main', s: t.session_id, t: t.thread_id, f: null, tab: 'inbox' }, { push: true })
  return (
    <section className="relative flex h-full min-h-0 flex-col bg-surface" aria-label="Issue" data-testid="issue-detail" data-ident={ident}>
      <header className={cx('flex shrink-0 items-center gap-2 border-b border-line px-3', phone ? 'h-14' : 'h-12')}>
        {phone && (
          <IconButton size={44} aria-label="Back to issues" data-testid="issue-back" onClick={onBack} className="-ml-2 text-fg2">
            <IconBack size={20} />
          </IconButton>
        )}
        <span data-testid="issue-identifier" className="mono text-[13px] font-semibold text-fg2">
          {ident}
        </span>
        {issue?.url && (
          <a href={issue.url} target="_blank" rel="noopener noreferrer" data-testid="issue-open-linear" aria-label="Open in Linear" title="Open in Linear" className="inline-flex items-center gap-1 text-[12.5px] text-accent no-underline hover:underline">
            <IconLinear size={13} />
            Open in Linear ↗
          </a>
        )}
        <span className="flex-1" />
        {loading && (
          <span data-testid="issue-loading" className="text-[11.5px] text-subtle">
            Loading…
          </span>
        )}
        <IconButton size={phone ? 44 : 30} aria-label="Reload issue" title="Reload issue" data-testid="issue-reload" onClick={() => (reload(), onRefreshList())}>
          <IconRefresh size={15} />
        </IconButton>
        {!phone && (
          <Button variant="primary" size="sm" data-testid="issue-start-thread" disabled={!issue} onClick={() => setStarting(true)}>
            Start thread
          </Button>
        )}
      </header>
      <div className={cx('min-h-0 flex-1 overflow-y-auto px-5 py-4', phone && 'pb-24')}>
        {err && (
          <div role="alert" data-testid="issue-error" className="mb-3 rounded-lg border border-danger/40 bg-dangerstrong/10 px-3 py-2 text-[12.5px] text-dangerfg">
            {err}
          </div>
        )}
        {issue && (
          <>
            <h2 data-testid="issue-title" className="m-0 mb-3 text-[19px] font-[650] leading-snug">
              {issue.title}
            </h2>
            <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3" data-testid="issue-props">
              <Prop label="State" testid="issue-state">
                <StateDot type={issue.state_type} />
                {issue.state}
              </Prop>
              <Prop label="Priority" testid="issue-priority">
                <PriorityIcon p={issue.priority} />
                {issue.priority_name || PRIORITY_TITLE[issue.priority]}
              </Prop>
              <Prop label="Team" testid="issue-team">
                {issue.team_name || issue.team_key}
                {issue.team_key && issue.team_name ? ` (${issue.team_key})` : ''}
              </Prop>
              {issue.project && <Prop label="Project">{issue.project}</Prop>}
              {issue.assignee && <Prop label="Assignee">{issue.assignee}</Prop>}
              {issue.estimate && <Prop label="Estimate">{issue.estimate}</Prop>}
              {issue.due_date && <Prop label="Due">{issue.due_date}</Prop>}
              <Prop label="Updated">{issue.updated_at ? shortTime(issue.updated_at) : '—'}</Prop>
            </div>
            {issue.labels.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1.5" data-testid="issue-labels">
                {issue.labels.map((l) => (
                  <span key={l} className="rounded-full border border-line2 px-2.5 py-0.5 text-[12px] text-fg2">
                    {l}
                  </span>
                ))}
              </div>
            )}
            <div data-testid="issue-threads" className="mb-5">
              <h3 className="m-0 mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle">minbox threads</h3>
              {issue.threads.length === 0 ? (
                <span className="text-[12.5px] text-subtle">No thread is linked to this issue yet.</span>
              ) : (
                <div className="flex flex-col gap-1">
                  {issue.threads.map((t) => (
                    <button
                      key={t.thread_id}
                      type="button"
                      data-testid="issue-thread"
                      onClick={() => openThread(t)}
                      className="flex min-h-9 items-center gap-2 rounded-md border border-line2 bg-transparent px-2.5 text-left hover:bg-raised"
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px]">{t.subject}</span>
                      <span className="shrink-0 text-[11.5px] text-subtle">{t.status}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mb-5">
              <h3 className="m-0 mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle">Description</h3>
              {data ? (
                issue.description ? (
                  <Markdown text={issue.description} testid="issue-description" />
                ) : (
                  <span className="text-[12.5px] text-subtle">No description.</span>
                )
              ) : (
                <span className="text-[12.5px] text-subtle">Loading…</span>
              )}
            </div>
            <Comments data={data} />
          </>
        )}
        {!issue && !err && <span className="text-[13px] text-subtle">Loading {ident}…</span>}
      </div>
      {phone && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 border-t border-line bg-surface px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-2" data-testid="issue-sticky-actions">
          <Button variant="primary" size="lg" className="flex-1" data-testid="issue-start-thread" disabled={!issue} onClick={() => setStarting(true)}>
            Start thread
          </Button>
        </div>
      )}
      {starting && issue && <StartThreadDialog issue={issue} onClose={() => setStarting(false)} />}
    </section>
  )
}

function Comments({ data }: { data: IssueDetailResult | null }) {
  if (!data) return null
  const cs: IssueComment[] = data.comments
  return (
    <div data-testid="issue-comments">
      <h3 className="m-0 mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle">Comments{data.comments_total ? ` (${data.comments_total})` : ''}</h3>
      {data.comments_error && (
        <div data-testid="issue-comments-error" className="mb-2 rounded-md border border-line2 px-2.5 py-1.5 text-[12px] text-subtle">
          Comments could not be loaded: {data.comments_error}
        </div>
      )}
      {cs.length === 0 && !data.comments_error && <span className="text-[12.5px] text-subtle">No comments.</span>}
      {data.comments_total > cs.length && <div className="mb-2 text-[12px] text-subtle">{data.comments_total - cs.length} earlier comments are not shown.</div>}
      <div className="flex flex-col gap-3">
        {cs.map((c) => (
          <article key={c.id} data-testid="issue-comment" className="rounded-lg border border-line2 bg-card px-3 py-2">
            <header className="mb-1 flex items-center gap-2 text-[12px] text-subtle">
              <b className="font-semibold text-fg2">{c.author || 'Someone'}</b>
              {c.created_at && <time dateTime={c.created_at}>{shortTime(c.created_at)}</time>}
            </header>
            <Markdown text={c.body} />
          </article>
        ))}
      </div>
    </div>
  )
}
