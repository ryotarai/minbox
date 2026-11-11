import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconLinear } from './icons'
import { api, type LinearDraft, type LinearMeta, type Thread } from '../api'
import { useApp } from '../lib/app'
import { Button, Modal, cx } from './ui'

// "Create Linear issue" from a thread. The dialog opens at once. Linear's lists (teams, states,
// labels, projects) load first and the form gets a basic prefill from the thread; then the local
// helper agent's guess arrives and fills in only the fields the person has not touched. Nothing
// is sent to Linear until Create.

const PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low']
const EMPTY: LinearDraft = { team_id: '', title: '', description: '', priority: 0, label_ids: [], project_id: '', assignee_id: '', state_id: '' }
type Field = keyof LinearDraft

const field = 'h-9 w-full rounded-md border border-linestrong bg-sunken px-2.5 text-[13px] text-fg outline-none focus:border-accent'

function newSubmissionId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function LinearCreateDialog({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const { toast, navigate } = useApp()
  const [form, setForm] = useState<LinearDraft>(EMPTY)
  const formRef = useRef(form)
  formRef.current = form
  const touched = useRef(new Set<Field>())
  const [meta, setMeta] = useState<LinearMeta | null>(null)
  const metaRef = useRef<LinearMeta | null>(null)
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
    const t = metaRef.current?.teams.find((x) => x.id === next.team_id)
    if (t && !t.states.some((s) => s.id === next.state_id)) next.state_id = t.default_state_id
    formRef.current = next
    setForm(next)
  }, [])

  const load = useCallback(async () => {
    setLoadErr('')
    try {
      const r = await api.linearDraft(thread.id, 'meta')
      if (closed.current) return
      metaRef.current = r.meta ?? null
      setMeta(r.meta ?? null)
      if (r.fallback) apply(r.fallback)
    } catch (e) {
      if (!closed.current) setLoadErr(e instanceof Error ? e.message : String(e))
      return
    }
    setDrafting(true)
    try {
      const r = await api.linearDraft(thread.id, 'llm')
      if (closed.current) return
      if (r.draft) apply(r.draft)
      else setNote(r.note ?? 'Showing a basic draft.')
    } catch (e) {
      if (!closed.current) setNote('Could not draft with the helper agent (' + (e instanceof Error ? e.message : String(e)) + '): a basic draft is shown.')
    }
    if (!closed.current) setDrafting(false)
  }, [thread.id, apply])
  useEffect(() => {
    void load()
  }, [load])

  const team = useMemo(() => meta?.teams.find((t) => t.id === form.team_id), [meta, form.team_id])
  const projects = useMemo(() => (meta?.projects ?? []).filter((p) => !p.team_ids?.length || !form.team_id || p.team_ids.includes(form.team_id)), [meta, form.team_id])

  const edit = (patch: Partial<LinearDraft>) => {
    for (const k of Object.keys(patch) as Field[]) touched.current.add(k)
    const next = { ...formRef.current, ...patch }
    formRef.current = next
    setForm(next)
  }
  const chooseTeam = (id: string) => {
    const t = meta?.teams.find((x) => x.id === id)
    // The team's own lists replace the old team's. The person's other fields stay.
    const patch: Partial<LinearDraft> = { team_id: id, label_ids: [], state_id: t?.default_state_id ?? '' }
    const p = meta?.projects.find((x) => x.id === formRef.current.project_id)
    if (p?.team_ids?.length && !p.team_ids.includes(id)) patch.project_id = ''
    edit(patch)
  }

  const ready = !!form.team_id && !!form.title.trim() && !busy && !!meta
  const create = async () => {
    if (!ready) return
    setBusy(true)
    setErr('')
    try {
      const link = await api.createLinearIssue(thread.id, { ...form, title: form.title.trim(), submission_id: submission.current })
      toast(`Created ${link.identifier}`)
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
    <Modal label="Create Linear issue" onClose={onClose} className="flex max-h-[90vh] w-[min(620px,100%)] flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <b className="inline-flex items-center gap-1.5 text-[15px] font-[650]">
          <IconLinear size={16} />
          Create Linear issue
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
          {note && (
            <span data-testid="linear-create-note" className="text-[12px] text-subtle">
              {note}
            </span>
          )}
          {meta?.warnings?.length ? (
            <span className="text-[12px] text-subtle" title={meta.warnings.join('\n')}>
              Some of Linear's lists could not be loaded.
            </span>
          ) : null}
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
              <select data-testid="linear-create-state" value={form.state_id} onChange={(e) => edit({ state_id: e.target.value })} className={field} disabled={!team}>
                <option value="">Team default</option>
                {(team?.states ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className={label}>
            Title (required)
            <input data-testid="linear-create-title" value={form.title} onChange={(e) => edit({ title: e.target.value })} className={field} maxLength={256} />
          </label>
          <label className={label}>
            Description (Markdown)
            <textarea
              data-testid="linear-create-desc"
              value={form.description}
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
            Labels
            <div className="flex flex-wrap gap-1.5" data-testid="linear-create-labels">
              {(team?.labels ?? []).length === 0 && <span className="text-[12px]">{team ? 'This team has no labels.' : 'Choose a team first.'}</span>}
              {(team?.labels ?? []).map((l) => {
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
