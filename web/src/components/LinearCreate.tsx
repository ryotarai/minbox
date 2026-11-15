import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconLinear } from './icons'
import { api, type IssueSummary, type LinearDraft, type LinearListInfo, type LinearMeta, type LinearTeam, type LinearTeamLists, type Thread } from '../api'
import { useApp } from '../lib/app'
import { Button, Modal, cx } from './ui'

// "Create Linear issue" from a thread. The dialog opens at once. Linear's global lists (teams,
// projects, who you are) load first and the form gets a basic prefill from the thread; the lists
// that hang on a team (workflow states, labels) are fetched only when that team is selected (by the
// person, or by the draft). Then the local helper agent's guess arrives and fills in only the
// fields the person has not touched. Nothing is sent to Linear until Create.

const PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low']
const EMPTY: LinearDraft = { team_id: '', title: '', description: '', priority: 0, label_ids: [], project_id: '', assignee_id: '', state_id: '' }
type Field = keyof LinearDraft
/** What is known of one team's own lists: loading, loaded (with this fetch's warnings and summaries) or failed. */
type TeamInfo = { status: 'loading' | 'done' | 'error'; team?: LinearTeam; warnings: string[]; lists: LinearListInfo[]; error?: string }

const field = 'h-9 w-full rounded-md border border-linestrong bg-sunken px-2.5 text-[13px] text-fg outline-none focus:border-accent'

function newSubmissionId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Which state a new issue starts in: the team's In Progress state (thread-bound issues) or the team's own default. */
export type DefaultStatePolicy = 'started' | 'team_default'

function preferredState(t: LinearTeam | undefined, policy: DefaultStatePolicy): string {
  if (!t) return ''
  return (policy === 'started' && t.started_state_id) || t.default_state_id || ''
}

/**
 * With a thread: "Create Linear issue" from it (prefill and draft come from the thread, Create links it).
 * Without one (the My issues screen): "New issue", written in plain language: a description box and a
 * Generate button ask the helper agent for the title, description and guesses; Create makes the issue
 * and hands it to onCreated. Both share the lists, the team lazy loading and the never-overwrite-touched rule.
 */
export function LinearCreateDialog({
  thread,
  onClose,
  onCreated,
  defaultState: defaultStateProp,
  title: initialTitle,
}: {
  thread?: Thread
  onClose: () => void
  onCreated?: (issue: IssueSummary) => void
  defaultState?: DefaultStatePolicy
  /** A title typed elsewhere (the link dialog's search text): kept as if the person had typed it, so no draft replaces it. */
  title?: string
}) {
  // Thread-bound issues start In Progress; a plain-language new issue (My issues) starts in the team's own default.
  const defaultState: DefaultStatePolicy = defaultStateProp ?? (thread ? 'started' : 'team_default')
  const { toast, navigate } = useApp()
  const nl = !thread
  const threadId = thread?.id ?? ''
  const [plain, setPlain] = useState('')
  const plainRef = useRef(plain)
  plainRef.current = plain
  const [llmAvailable, setLlmAvailable] = useState<boolean | null>(null)
  const [form, setForm] = useState<LinearDraft>(() => (initialTitle?.trim() ? { ...EMPTY, title: initialTitle.trim() } : EMPTY))
  const formRef = useRef(form)
  formRef.current = form
  const touched = useRef(new Set<Field>(initialTitle?.trim() ? ['title'] : []))
  const [meta, setMeta] = useState<LinearMeta | null>(null)
  const metaRef = useRef<LinearMeta | null>(null)
  const [teamInfo, setTeamInfoState] = useState<Record<string, TeamInfo>>({})
  const teamInfoRef = useRef<Record<string, TeamInfo>>({})
  const setTeamInfo = useCallback((id: string | null, info?: TeamInfo) => {
    const next = { ...teamInfoRef.current }
    if (id && info) next[id] = info
    else if (id) delete next[id]
    teamInfoRef.current = next
    setTeamInfoState(next)
  }, [])
  const [loadErr, setLoadErr] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submission = useRef(newSubmissionId())
  const closed = useRef(false)
  useEffect(() => () => void (closed.current = true), [])

  // Apply a prefill to the fields the person has not touched. A guess made for one team says
  // nothing about another: when the person chose the team themselves, the guess's team-bound
  // fields (labels, state, project) are skipped if it named a different team.
  const apply = useCallback((d: Partial<LinearDraft>) => {
    const cur = formRef.current
    const teamTouched = touched.current.has('team_id')
    const sameTeam = !teamTouched || !d.team_id || d.team_id === cur.team_id
    const next = { ...cur }
    const set = <K extends Field>(k: K, v: LinearDraft[K] | undefined, teamBound = false) => {
      if (v === undefined || touched.current.has(k) || (teamBound && !sameTeam)) return
      if (typeof v === 'string' && v === '' && k !== 'description' && k !== 'title') return // an empty guess does not erase a default
      next[k] = v
    }
    set('team_id', d.team_id)
    set('title', d.title)
    set('description', d.description)
    set('priority', d.priority)
    set('assignee_id', d.assignee_id)
    set('state_id', d.state_id, true)
    set('project_id', d.project_id, true)
    set('label_ids', d.label_ids, true)
    // A team the person never chose and a state that is not that team's: use the team's default.
    const t = teamInfoRef.current[next.team_id]?.team
    if (t && !(t.states ?? []).some((s) => s.id === next.state_id)) next.state_id = preferredState(t, defaultState)
    // The lists are not here yet (they load for the team): the state is set when they arrive.
    else if (!t && next.team_id !== cur.team_id) next.state_id = ''

    formRef.current = next
    setForm(next)
  }, [defaultState])

  // Fetch the lists that hang on a team (states, labels): once per team while the dialog is open
  // (the server caches them too); refresh bypasses both.
  const loadTeam = useCallback(
    async (id: string, refresh = false) => {
      const cur = teamInfoRef.current[id]
      if (!refresh && (cur?.status === 'loading' || cur?.status === 'done')) return
      setTeamInfo(id, { status: 'loading', warnings: [], lists: [], team: cur?.team })
      try {
        const r = await (nl ? api.issueTeamLists(id, refresh) : api.linearTeamLists(threadId, id, refresh))
        if (closed.current) return
        setTeamInfo(id, { status: 'done', team: r.team, warnings: r.warnings ?? [], lists: r.lists ?? [] })
        // The team's In Progress state (per defaultState), unless the person (or the draft) already chose one.
        const f = formRef.current
        if (f.team_id === id && !f.state_id && preferredState(r.team, defaultState)) {
          const next = { ...f, state_id: preferredState(r.team, defaultState) }
          formRef.current = next
          setForm(next)
        }
      } catch (e) {
        if (closed.current) return
        setTeamInfo(id, { status: 'error', warnings: [], lists: [], error: e instanceof Error ? e.message : String(e) })
      }
    },
    [threadId, nl, setTeamInfo, defaultState],
  )
  const gotTeamLists = (r: LinearTeamLists) => setTeamInfo(r.team.id, { status: 'done', team: r.team, warnings: r.warnings ?? [], lists: r.lists ?? [] })

  const load = useCallback(async () => {
    setLoadErr('')
    let fallback: LinearDraft | undefined
    let helper = false
    try {
      const r = await (nl ? api.issueDraft({ stage: 'meta' }) : api.linearDraft(threadId, 'meta'))
      if (closed.current) return
      metaRef.current = r.meta ?? null
      setMeta(r.meta ?? null)
      fallback = r.fallback
      if (nl) {
        // Plain-language mode: only the certain defaults (me, a lone team); the draft comes when asked for.
        setLlmAvailable(r.llm_available === true)
        if (fallback) apply({ team_id: fallback.team_id, assignee_id: fallback.assignee_id, state_id: fallback.state_id })
        return
      }
      // With a helper agent the helper-derived fields stay empty ("Drafting…") until its draft
      // arrives, so nothing flashes; only the certain defaults (team, assignee, state) go in now.
      helper = r.llm_available === true
      if (helper) {
        if (fallback) apply({ team_id: fallback.team_id, assignee_id: fallback.assignee_id, state_id: fallback.state_id })
        setDrafting(true)
      } else if (fallback) apply(fallback)
    } catch (e) {
      if (!closed.current) setLoadErr(e instanceof Error ? e.message : String(e))
      return
    }
    if (closed.current) return
    // No helper: the fallback is already applied and there is nothing to wait for.
    if (!helper) return
    try {
      // A team already selected (by the person, or the project-named guess): the draft is made for it, in one step.
      const chosen = formRef.current.team_id
      const r = await api.linearDraft(threadId, 'llm', false, chosen)
      if (closed.current) return
      if (r.team_lists) gotTeamLists(r.team_lists) // the drafted team's lists came with the draft
      if (r.draft) apply(r.draft)
      else {
        if (fallback) apply(fallback)
        setNote(r.note ?? 'Showing a basic draft.')
      }
    } catch (e) {
      if (closed.current) return
      if (fallback) apply(fallback)
      setNote('Could not draft with the helper agent (' + (e instanceof Error ? e.message : String(e)) + '): a basic draft is shown.')
    }
    if (!closed.current) setDrafting(false)
  }, [threadId, nl, apply])
  useEffect(() => {
    void load()
  }, [load])

  // Plain-language mode: Generate asks the helper for a draft of what was written. It fills only the
  // fields the person has not touched, so regenerating never overwrites their edits.
  // Asked for before Linear's lists have loaded (typed fast, ⌘/Ctrl+Enter at once): the request is kept
  // and sent as soon as they arrive, instead of being dropped.
  const [queued, setQueued] = useState(false)
  const generate = async () => {
    const text = plainRef.current.trim()
    if (!text || drafting) return
    if (!metaRef.current) {
      setQueued(true)
      return
    }
    setQueued(false)
    setDrafting(true)
    setNote('')
    try {
      const chosen = touched.current.has('team_id') ? formRef.current.team_id : ''
      const r = await api.issueDraft({ stage: 'llm', text, team_id: chosen || undefined, regenerate: true })
      if (closed.current) return
      if (r.team_lists) gotTeamLists(r.team_lists)
      if (r.draft) apply(r.draft)
      else setNote(r.note ?? 'Could not draft this: fill in the fields yourself.')
    } catch (e) {
      if (!closed.current) setNote('Could not draft with the helper agent (' + (e instanceof Error ? e.message : String(e)) + ').')
    } finally {
      if (!closed.current) setDrafting(false)
    }
  }
  useEffect(() => {
    if (meta && queued) void generate()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- generate reads the latest text and form through refs
  }, [meta, queued])
  // Whatever team is selected (by the person, the basic prefill or the draft) gets its lists. A
  // team only guessed while the draft is pending waits for the draft (which usually decides it).
  useEffect(() => {
    const id = form.team_id
    if (!id || !meta) return
    if (drafting && !touched.current.has('team_id')) return
    void loadTeam(id)
  }, [form.team_id, meta, drafting, loadTeam])

  // Reload lists: refetch Linear's lists bypassing the server's cache; the form keeps what it holds.
  const [reloading, setReloading] = useState(false)
  const reloadLists = async () => {
    setReloading(true)
    try {
      const r = await (nl ? api.issueDraft({ stage: 'meta', refresh: true }) : api.linearDraft(threadId, 'meta', true))
      if (closed.current) return
      metaRef.current = r.meta ?? null
      setMeta(r.meta ?? null)
      // The selected team's lists again (bypassing the cache); other teams load again when selected.
      const sel = formRef.current.team_id
      for (const id of Object.keys(teamInfoRef.current)) if (id !== sel) setTeamInfo(id)
      if (sel) await loadTeam(sel, true)
    } catch (e) {
      if (!closed.current) toast('Could not reload the lists: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      if (!closed.current) setReloading(false)
    }
  }

  const team = useMemo(() => meta?.teams.find((t) => t.id === form.team_id), [meta, form.team_id])
  const info: TeamInfo | undefined = teamInfo[form.team_id]
  const states = info?.team?.states ?? []
  const labels = info?.team?.labels ?? []
  // Lists of the selected team are on their way (or waiting for the draft to decide the team).
  const listsLoading = !!team && (info?.status === 'loading' || (!info && drafting))
  const allWarnings = useMemo(() => [...(meta?.warnings ?? []), ...Object.values(teamInfo).flatMap((i) => i.warnings)], [meta, teamInfo])
  const allLists = useMemo(() => [...(meta?.lists ?? []), ...Object.values(teamInfo).flatMap((i) => i.lists)], [meta, teamInfo])
  const projects = useMemo(() => (meta?.projects ?? []).filter((p) => !p.team_ids?.length || !form.team_id || p.team_ids.includes(form.team_id)), [meta, form.team_id])

  const edit = (patch: Partial<LinearDraft>) => {
    for (const k of Object.keys(patch) as Field[]) touched.current.add(k)
    const next = { ...formRef.current, ...patch }
    formRef.current = next
    setForm(next)
  }
  const chooseTeam = (id: string) => {
    // The old team's labels and state do not belong to the new team: cleared (the new team's lists
    // load, and its default state is set when they arrive). The person's other fields stay.
    const patch: Partial<LinearDraft> = { team_id: id }
    const p = meta?.projects.find((x) => x.id === formRef.current.project_id)
    if (p?.team_ids?.length && !p.team_ids.includes(id)) patch.project_id = ''
    edit(patch)
    touched.current.delete('state_id')
    touched.current.delete('label_ids')
    const next = { ...formRef.current, label_ids: [], state_id: preferredState(teamInfoRef.current[id]?.team, defaultState) }
    formRef.current = next
    setForm(next)
  }

  const ready = !!form.team_id && !!form.title.trim() && !busy && !!meta
  const create = async () => {
    if (!ready) return
    setBusy(true)
    setErr('')
    try {
      const body = { ...form, title: form.title.trim(), submission_id: submission.current }
      if (nl) {
        const r = await api.createIssue(body)
        toast(`Created ${r.issue.identifier}`)
        onCreated?.(r.issue)
      } else {
        const link = await api.createLinearIssue(threadId, body)
        toast(`Created ${link.identifier}`)
      }
      onClose()
    } catch (e) {
      const status = (e as { status?: number }).status
      setErr(e instanceof Error ? e.message : String(e))
      if (status === 409 && !/already linked/.test(String(e))) toast('Connect Linear first: Settings › Integrations', { error: true, action: 'Open', onAction: () => navigate({ view: 'settings', ss: 'integrations' }) })
      setBusy(false)
    }
  }

  const label = 'flex flex-col gap-1 text-[12px] text-subtle'
  return (
    <Modal label={nl ? 'New Linear issue' : 'Create Linear issue'} onClose={onClose} className="flex max-h-[90vh] w-[min(620px,100%)] flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <b className="inline-flex items-center gap-1.5 text-[15px] font-[650]">
          <IconLinear size={16} />
          {nl ? 'New Linear issue' : 'Create Linear issue'}
        </b>
        {drafting && (
          <span data-testid="linear-create-drafting" className="text-[12px] text-subtle">
            Drafting…
          </span>
        )}
      </div>
      {loadErr ? (
        <div className="flex flex-col gap-2">
          <span data-testid="linear-create-loaderror" className="text-[13px] text-danger">
            {loadErr}
          </span>
          <div>
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <>
          {!meta && (
            <span data-testid="linear-create-loading" className="text-[12px] text-subtle">
              Loading Linear's teams and labels…
            </span>
          )}
          {nl && (
            <div className="flex flex-col gap-1.5">
              <label className={label}>
                Describe the issue in plain language
                <textarea
                  data-testid="linear-create-plain"
                  autoFocus
                  value={plain}
                  rows={5}
                  placeholder="e.g. Safariでログインすると500エラーになる。再現手順と原因調査をしたい / Login returns a 500 on Safari; find out why"
                  onChange={(e) => setPlain(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      void generate()
                    }
                  }}
                  className="rounded-md border border-linestrong bg-sunken p-2.5 text-[13px] text-fg outline-none focus:border-accent"
                />
              </label>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" data-testid="linear-create-generate" disabled={!plain.trim() || drafting || queued || llmAvailable === false} onClick={() => void generate()}>
                  {drafting || queued ? 'Drafting…' : 'Generate'}
                </Button>
                <span className="text-[11.5px] text-subtle">
                  {llmAvailable === false ? 'No coding agent is installed to draft this: fill in the fields yourself.' : '⌘/Ctrl+Enter generates a title, description and guesses; you can edit everything.'}
                </span>
              </div>
            </div>
          )}
          {note && (
            <span data-testid="linear-create-note" className="text-[12px] text-subtle">
              {note}
            </span>
          )}
          {meta && (
            <div data-testid="linear-create-lists" className="flex flex-col gap-1 text-[12px] text-subtle">
              <div className="flex flex-wrap items-center gap-2">
                <span data-testid="linear-create-counts">
                  {meta.teams.length} {meta.teams.length === 1 ? 'team' : 'teams'} loaded, {meta.projects.length} {meta.projects.length === 1 ? 'project' : 'projects'}
                </span>
                {allWarnings.length ? <span>Some of Linear's lists could not be loaded.</span> : null}
                <Button size="sm" data-testid="linear-create-reload" disabled={reloading} onClick={() => void reloadLists()}>
                  {reloading ? 'Reloading…' : 'Reload lists'}
                </Button>
              </div>
              {allWarnings.length || allLists.length ? (
                <details data-testid="linear-create-details" open={!!allWarnings.length}>
                  <summary className="cursor-pointer">Details</summary>
                  {allWarnings.length ? (
                    <ul data-testid="linear-create-warnings" className="list-disc pl-4 select-text">
                      {allWarnings.map((w, i) => (
                        <li key={i}>{w || 'unknown problem (no detail)'}</li>
                      ))}
                    </ul>
                  ) : null}
                  {allLists.length ? (
                    <pre data-testid="linear-create-lists-summary" className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap select-text font-mono text-[11px]">
                      {allLists
                        .map((l) => `${l.list} [${l.tool ?? '?'}]: ${l.pages} page(s), ${l.items} items, ${l.parsed} parsed, ${l.skipped} skipped${l.error ? ', error: ' + l.error : ''}`)
                        .join('\n')}
                    </pre>
                  ) : null}
                </details>
              ) : null}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className={label}>
              Team (required)
              <select data-testid="linear-create-team" value={form.team_id} onChange={(e) => chooseTeam(e.target.value)} className={field}>
                <option value="">Choose a team…</option>
                {(meta?.teams ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.key})
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              State
              <select data-testid="linear-create-state" value={form.state_id} onChange={(e) => edit({ state_id: e.target.value })} className={field} disabled={!team || listsLoading}>
                <option value="">{listsLoading ? 'Loading…' : 'Team default'}</option>
                {states.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className={label}>
            Title (required)
            <input data-testid="linear-create-title" value={form.title} placeholder={drafting ? 'Drafting…' : undefined} onChange={(e) => edit({ title: e.target.value })} className={field} maxLength={256} />
          </label>
          <label className={label}>
            Description (Markdown)
            <textarea
              data-testid="linear-create-desc"
              value={form.description}
              placeholder={drafting ? 'Drafting…' : undefined}
              onChange={(e) => edit({ description: e.target.value })}
              rows={9}
              className="rounded-md border border-linestrong bg-sunken p-2.5 text-[13px] text-fg outline-none focus:border-accent"
            />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className={label}>
              Priority
              <select data-testid="linear-create-priority" value={form.priority} onChange={(e) => edit({ priority: Number(e.target.value) })} className={field}>
                {PRIORITIES.map((p, i) => (
                  <option key={p} value={i}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              Project
              <select data-testid="linear-create-project" value={form.project_id} onChange={(e) => edit({ project_id: e.target.value })} className={field}>
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              Assignee
              <select data-testid="linear-create-assignee" value={form.assignee_id} onChange={(e) => edit({ assignee_id: e.target.value })} className={field}>
                <option value="">Unassigned</option>
                {meta?.user && <option value={meta.user.id}>Me ({meta.user.name || meta.user.email})</option>}
              </select>
            </label>
          </div>
          <div className={label}>
            <span className="flex items-center gap-2">
              Labels
              {listsLoading && (
                <span data-testid="linear-create-team-loading" className="text-[12px]">
                  Loading states and labels…
                </span>
              )}
            </span>
            <div className="flex flex-wrap gap-1.5" data-testid="linear-create-labels">
              {info?.status === 'error' ? (
                <span className="text-[12px] text-danger" data-testid="linear-create-team-error">
                  Could not load this team's states and labels ({info.error}){' '}
                  <button type="button" className="underline" data-testid="linear-create-team-retry" onClick={() => void loadTeam(form.team_id, true)}>
                    Retry
                  </button>
                </span>
              ) : (
                labels.length === 0 && !listsLoading && <span className="text-[12px]">{team ? 'This team has no labels.' : 'Choose a team first.'}</span>
              )}
              {labels.map((l) => {
                const on = form.label_ids.includes(l.id)
                return (
                  <button
                    key={l.id}
                    type="button"
                    aria-pressed={on}
                    data-testid={`linear-create-label-${l.name}`}
                    onClick={() => edit({ label_ids: on ? form.label_ids.filter((x) => x !== l.id) : [...form.label_ids, l.id] })}
                    className={cx('rounded-full border px-2.5 py-0.5 text-[12px]', on ? 'border-accent bg-raised text-fg' : 'border-line2 bg-transparent text-subtle hover:border-linestrong')}
                  >
                    {l.name}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
      {err && (
        <span data-testid="linear-create-error" className="text-[13px] text-danger">
          {err}
        </span>
      )}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11.5px] text-subtle">Nothing is sent to Linear until you press Create.</span>
        <Button variant="ghost" data-testid="linear-create-cancel" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" data-testid="linear-create-submit" disabled={!ready} onClick={create}>
          {busy ? 'Creating…' : 'Create issue'}
        </Button>
      </div>
    </Modal>
  )
}
