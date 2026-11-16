import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Topic, type TopicStatus, type TopicsResult } from '../api'
import { useApp } from '../lib/app'
import { useHotkeys } from '../lib/hotkeys'
import { selectProject, useSelectedProject } from '../lib/projects'
import { IconBack } from './icons'
import { ThreadProjectBadge } from './ThreadList'
import { Button, IconButton, MenuItem, Popover, Segmented, cx } from './ui'

const COLUMNS: { id: TopicStatus; title: string; empty: string }[] = [
  { id: 'in_progress', title: 'In progress', empty: 'Nothing in progress.' },
  { id: 'waiting_on_you', title: 'Waiting on you', empty: 'Nothing waits on you.' },
  { id: 'done', title: 'Done', empty: 'Nothing done lately.' },
]

/** "just now", "5m ago", "3h ago", "2d ago". */
export function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * Topics: what each thread is working on, across threads. The helper model reads every thread's
 * topics from its messages (a few seconds after each new one); a thread can have several, each in
 * its own column. Scoped to the selected project, like the threads list.
 */
export function TopicsPage() {
  const { topicsVersion, threadsVersion, error, navigate, projects, isPhone } = useApp()
  const { id: projectId, project } = useSelectedProject()
  const [res, setRes] = useState<TopicsResult | null>(null)
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null)
  const [tab, setTab] = useState<TopicStatus>('waiting_on_you')
  const [now, setNow] = useState(Date.now())
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    api
      .topics(projectId)
      .then((r) => n === seq.current && setRes(r))
      .catch(error)
    // threadsVersion: an archived or renamed thread changes the board too.
  }, [topicsVersion, threadsVersion, projectId, error])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  useHotkeys({ escape: () => navigate({ view: 'main' }) })

  const byCol = useMemo(() => {
    const out: Record<TopicStatus, Topic[]> = { in_progress: [], waiting_on_you: [], done: [] }
    for (const t of res?.topics ?? []) out[t.status]?.push(t)
    return out
  }, [res])
  const doneDays = res?.done_days ?? 7
  const open = (t: Topic) => t.session_id && navigate({ view: 'main', s: t.session_id, t: t.thread_id, f: null }, { push: true })

  const column = (col: (typeof COLUMNS)[number]) => {
    const list = byCol[col.id]
    return (
      <section
        key={col.id}
        data-testid={`topics-col-${col.id}`}
        aria-label={col.title}
        className={cx('flex min-h-0 flex-col gap-2 overflow-y-auto rounded-xl bg-surface p-2.5', isPhone && 'flex-1 rounded-none bg-transparent px-3')}
      >
        {!isPhone && (
          <div className="flex items-baseline gap-1.5 px-1 pb-1.5 pt-0.5">
            <span className={cx('text-[13px] font-[650]', col.id === 'waiting_on_you' ? 'text-wait' : 'text-fg')}>{col.title}</span>
            <span className="text-[12px] text-subtle">{list.length}</span>
            {col.id === 'done' && <span className="text-[11.5px] text-subtle">· last {doneDays} days</span>}
          </div>
        )}
        {isPhone && col.id === 'done' && <span className="px-1 text-[12px] text-subtle">Done in the last {doneDays} days</span>}
        {res && list.length === 0 && <span className="px-1 py-1 text-[12.5px] text-subtle">{col.empty}</span>}
        {list.map((t) => (
          <TopicCard key={t.id} t={t} now={now} showProject={!projectId} onOpen={() => open(t)} />
        ))}
      </section>
    )
  }

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="topics">
      <div className={cx('flex h-14 shrink-0 items-center gap-3 border-b border-line', isPhone ? 'px-2' : 'px-5')}>
        <IconButton aria-label="Back" onClick={() => navigate({ view: 'main' })}>
          <IconBack />
        </IconButton>
        <h1 className="m-0 text-[18px] font-bold">Topics</h1>
        {!isPhone && res && (
          <span className="text-[13px] text-muted">
            {byCol.in_progress.length} in progress · <span className="font-semibold text-wait">{byCol.waiting_on_you.length} waiting on you</span>
          </span>
        )}
        <span className="flex-1" />
        <Button size="sm" className="h-8 max-w-[50vw]" data-testid="topics-project" onClick={(e) => setFilterAnchor(e.currentTarget)}>
          <span className="truncate">{project ? project.name : 'All projects'}</span> ▾
        </Button>
      </div>
      <Popover anchor={filterAnchor} open={!!filterAnchor} onClose={() => setFilterAnchor(null)}>
        <MenuItem active={!projectId} onClick={() => (selectProject(''), setFilterAnchor(null))}>
          All projects
        </MenuItem>
        {(projects ?? []).map((p) => (
          <MenuItem key={p.id} active={projectId === p.id} onClick={() => (selectProject(p.id), setFilterAnchor(null))}>
            {p.name}
          </MenuItem>
        ))}
      </Popover>
      {res && !res.enabled && (
        <div data-testid="topics-off" className="mx-5 mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] text-muted">
          Topics are turned off, so threads are not read for new topics.{' '}
          <button type="button" className="border-0 bg-transparent p-0 text-accent underline" onClick={() => navigate({ view: 'settings', ss: 'capabilities' })}>
            Turn them on in Settings
          </button>
        </div>
      )}
      {res && res.enabled && res.topics.length === 0 && (
        <div data-testid="topics-empty" className="mx-5 mt-3 text-[12.5px] text-subtle">
          No topics yet. A thread's topics appear here a few seconds after it gets a new message.
        </div>
      )}
      {isPhone ? (
        <>
          <div className="shrink-0 px-3 pt-2.5">
            <Segmented
              size="lg"
              value={tab}
              onChange={setTab}
              testidPrefix="topics-tab"
              options={COLUMNS.map((c) => ({
                value: c.id,
                label: (
                  <span className={cx(c.id === 'waiting_on_you' && byCol.waiting_on_you.length > 0 && tab !== c.id && 'text-wait')}>
                    {c.id === 'waiting_on_you' ? 'Waiting' : c.title} <span className="text-subtle">{byCol[c.id].length}</span>
                  </span>
                ),
              }))}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col pt-2">{column(COLUMNS.find((c) => c.id === tab)!)}</div>
        </>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[repeat(3,minmax(240px,1fr))] gap-3 overflow-x-auto px-5 py-4">{COLUMNS.map(column)}</div>
      )}
    </div>
  )
}

function TopicCard({ t, now, showProject, onOpen }: { t: Topic; now: number; showProject: boolean; onOpen: () => void }) {
  const waiting = t.status === 'waiting_on_you'
  const thread = t.thread_name || t.thread_subject || 'Untitled thread'
  const when = t.status === 'done' ? t.done_at ?? t.updated_at : t.updated_at
  return (
    <button
      type="button"
      data-testid="topic-card"
      data-status={t.status}
      data-topic-id={t.id}
      onClick={onOpen}
      title={`Open the thread “${thread}”`}
      className={cx(
        'flex w-full shrink-0 flex-col gap-1.5 rounded-[10px] border bg-raised px-3 py-2.5 text-left hover:border-linestrong',
        waiting ? 'border-wait/50' : 'border-line2',
        t.status === 'done' && 'opacity-80',
      )}
    >
      <span data-testid="topic-title" className={cx('text-[13.5px] leading-[1.45] text-fg', waiting ? 'font-[650]' : 'font-medium')}>
        {t.title}
      </span>
      {t.summary && (
        <span data-testid="topic-summary" className="line-clamp-2 text-[12px] leading-[1.45] text-muted">
          {t.summary}
        </span>
      )}
      <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-subtle">
        {showProject && <ThreadProjectBadge projectId={t.project_id} projectName={t.project_name} />}
        <span data-testid="topic-thread" className="min-w-0 flex-1 truncate">
          {thread}
          {showProject && t.project_name && <span className="text-subtle"> · {t.project_name}</span>}
        </span>
        <time dateTime={when} title={new Date(when).toLocaleString()} className="shrink-0">
          {relTime(when, now)}
        </time>
      </span>
    </button>
  )
}
