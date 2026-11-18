// minbox v3 data: the Board, a task's view, an agent's stream (docs/v3/api.md), and the hooks that
// keep them live (the server's tasks / thread events arrive as window "minbox:v3" events).
import { useCallback, useEffect, useRef, useState } from 'react'
import { call, type Answer, type Message, type ReplyRequest } from '../api'
import type { StreamTaskEvent } from './StreamEvents'

export type TaskStatus = 'working' | 'needs_you' | 'blocked' | 'done'
export const STATUS_LABEL: Record<TaskStatus, string> = { working: 'Working', needs_you: 'Needs you', blocked: 'Blocked', done: 'Done' }

export type Step = { text: string; done: boolean; steps?: Step[] }
/** A task a message is about; source: how that link was made (by the agent, a rule, or the person). */
export type TaskRef = { task_id: string; title: string; status: TaskStatus; source: 'agent' | 'auto' | 'person' }
export type TaskAgent = { session_id: string; role: 'assigned' | 'involved'; since: string }
export type AutoRun = { state: '' | 'running' | 'paused' | 'stopped'; session_id?: string; max_turns?: number; turns?: number; until?: string; reason?: string; last_at?: string }
export type TaskLink = { kind: string; label: string; url: string; state?: string }

export type Task = {
  id: string
  project_id: string
  title: string
  summary: string
  detail: string
  status: TaskStatus
  steps: Step[]
  report: string
  links: TaskLink[]
  created_by: string
  created_at: string
  updated_at: string
  done_at: string | null
  manual_status: string
  agents: TaskAgent[]
  kind: '' | 'goal'
  parent_id: string
  criteria: Step[]
  auto: AutoRun
  /** Who named it last: 'person' (the agent's renames are then not applied), 'agent', or '' (older). */
  title_by?: '' | 'person' | 'agent'
}

export type BoardTask = Task & {
  open_questions: number
  unread: number
  message_count: number
  last_activity: string
  last_agent: string
  needs_you: boolean
  criteria_done: number
  task_ids?: string[]
  /** The start of the newest agent message about it. */
  last_line: string
}

export type V3Message = Message & {
  session_id: string
  /** The tasks this message is about. */
  tasks: TaskRef[]
  segment?: { id: string; subject: string }
  open: number
  decision?: 'existing' | 'created' | 'none' | 'moved'
  decision_task?: string
  turn_of?: string[]
  /** Task view: untagged messages of its stream since the previous tagged one there. */
  gap?: number
  /** Optimistic: shown before the server has it. */
  pending?: boolean
}

export type TaskEvent = { id: string; task_id: string; at: string; kind: string; text: string; session_id?: string; message_id?: string }

export type Board = { tasks: BoardTask[]; questions: V3Message[]; agents: Record<string, { unread: number; open_questions: number }> }
export type TaskDetail = { task: BoardTask; messages: V3Message[]; events: TaskEvent[]; tasks: BoardTask[]; goal: Task | null }
export type Stream = { messages: V3Message[]; has_more: boolean; tasks: Task[]; stream_thread_id: string; task_events?: StreamTaskEvent[] }
export type SearchResult = { tasks: Task[]; messages: { id: string; session_id: string; thread_id: string; author: 'agent' | 'user'; text: string; created_at: string; tasks: TaskRef[] }[] }

/** task_id: the one task the message is about (a message belongs to exactly one task). */
export type SendRequest = ReplyRequest & { task_id?: string }

const q = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? '?' + s : ''
}

export const v3 = {
  board: (project: string) => call<Board>('GET', '/api/v3/board' + q({ project })),
  task: (id: string) => call<TaskDetail>('GET', `/api/v3/tasks/${id}`),
  patchTask: (id: string, body: Partial<Pick<Task, 'title' | 'status' | 'summary' | 'steps' | 'criteria' | 'parent_id'>>) => call<Task>('PATCH', `/api/v3/tasks/${id}`, body),
  createTask: (body: { project_id?: string; title: string; kind?: string; session_id?: string; message_ids?: string[] }) => call<Task>('POST', '/api/v3/tasks', body),
  auto: (id: string, action: 'start' | 'pause' | 'stop', session_id?: string) => call<Task>('POST', `/api/v3/tasks/${id}/auto`, { action, session_id }),
  stream: (session: string, opts: { before?: string; after?: string; limit?: number } = {}) =>
    call<Stream>('GET', `/api/v3/sessions/${session}/stream` + q({ before: opts.before, after: opts.after, limit: opts.limit ? String(opts.limit) : undefined })),
  send: (session: string, req: SendRequest, thread?: string) => call<Message>('POST', `/api/v3/sessions/${session}/messages` + q({ thread }), req),
  newMessage: (req: SendRequest & { to: string; project_id: string; agent?: string; name?: string }) => call<Message>('POST', '/api/v3/new', req),
  /** The message moves to the task (it leaves the one it was in: a message belongs to exactly one task). */
  setTask: (msg: string, task_id: string) => call<{ ok: boolean; from: string }>('PUT', `/api/v3/messages/${msg}/task`, { task_id }),
  /** An agent reply and the person's messages it answered move to another task (or a new one). */
  move: (msg: string, body: { to?: string; title?: string }) => call<{ ok: boolean; task_id: string; removed_task: string }>('POST', `/api/v3/messages/${msg}/move`, body),
  read: (ids: string[]) => call<{ marked: number }>('POST', '/api/v3/read', { message_ids: ids }),
  search: (qs: string, project: string) => call<SearchResult>('GET', '/api/v3/search' + q({ q: qs, project })),
}

/** Calls f when anything the v3 views show may have changed (debounced). */
export function useV3Events(f: () => void) {
  const ref = useRef(f)
  ref.current = f
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const on = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => ref.current(), 120)
    }
    window.addEventListener('minbox:v3', on)
    return () => {
      window.removeEventListener('minbox:v3', on)
      if (t) clearTimeout(t)
    }
  }, [])
}

/** Loads with fetcher, again on v3 events and when key changes. */
export function useLive<T>(key: string | null, fetcher: () => Promise<T>): [T | null, () => void, (f: (v: T | null) => T | null) => void] {
  const [data, setData] = useState<T | null>(null)
  const seq = useRef(0)
  const keyRef = useRef(key)
  const load = useCallback(() => {
    if (keyRef.current === null) return
    const n = ++seq.current
    fetcher()
      .then((v) => {
        if (n === seq.current) setData(v)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    keyRef.current = key
    setData(null)
    load()
  }, [key, load])
  useV3Events(load)
  return [data, load, setData]
}

/** Marks the agent messages shown read (once each). */
export function useMarkRead(messages: V3Message[] | undefined, active = true) {
  const sent = useRef(new Set<string>())
  useEffect(() => {
    if (!active || !messages || document.visibilityState === 'hidden') return
    const ids = messages.filter((m) => m.author === 'agent' && !m.read_at && !m.pending && !sent.current.has(m.id)).map((m) => m.id)
    if (ids.length === 0) return
    // Remembered once sent (a re-render that cancels the timer must not lose them).
    const t = setTimeout(() => {
      ids.forEach((id) => sent.current.add(id))
      void v3.read(ids).catch(() => ids.forEach((id) => sent.current.delete(id)))
    }, 400)
    return () => clearTimeout(t)
  }, [messages, active])
}

export function answerText(a: Answer): string {
  if (a.skipped) return 'Skipped'
  return [...(a.selected ?? []), a.other, a.text].filter((x) => x && String(x).trim()).join(', ')
}

/** Leaf steps (a parent with sub-steps counts by them). */
export function leaves(steps: Step[]): Step[] {
  const out: Step[] = []
  for (const s of steps) {
    if (s.steps?.length) out.push(...s.steps)
    else out.push(s)
  }
  return out
}

export function currentStep(steps: Step[]): Step | undefined {
  return leaves(steps).find((s) => !s.done)
}

/** Markdown as plain text on one line (for a subtitle): question/action blocks, code fences and tables
 *  out; heading, list and quote markers, emphasis and link targets stripped. */
export function plainText(md: string): string {
  const out: string[] = []
  let block = false
  let fence = false
  for (const raw of md.split('\n')) {
    const l = raw.trim()
    if (l.startsWith('```')) {
      fence = !fence
      continue
    }
    if (fence) continue
    if (l.startsWith(':::')) {
      block = l !== ':::' && !block
      continue
    }
    if (block || !l || l.startsWith('|') || /^(-{3,}|\*{3,}|_{3,})$/.test(l)) continue
    const t = l
      .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .trim()
    if (t) out.push(t)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

export type Standing = { text: string; from: 'summary' | 'report' | 'message' | 'step' }

/** Where a task stands, as its subtitle (the agent's Tasks list and the Board say the same): the
 *  summary the agent keeps, else its latest report, else the agent's latest line about it, else the
 *  step it is on (open tasks only). Null when there is nothing to say. */
export function standing(t: Pick<Task, 'summary' | 'report' | 'steps' | 'status' | 'kind'> & { last_line?: string }): Standing | null {
  const cap = (s: string) => (s.length > 280 ? s.slice(0, 279) + '…' : s)
  const summary = plainText(t.summary ?? '')
  if (summary) return { text: cap(summary), from: 'summary' }
  const report = plainText(t.report ?? '')
  if (report) return { text: cap(report), from: 'report' }
  const line = plainText(t.last_line ?? '')
  if (line) return { text: cap(line), from: 'message' }
  const cur = t.kind === 'goal' || t.status === 'done' ? undefined : currentStep(t.steps ?? [])
  if (cur) return { text: cap(cur.text), from: 'step' }
  return null
}

/** Colors of task chips: stable per task id. */
export function tagColor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `var(--t${h % 6})`
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function hhmm(iso: string): string {
  const d = new Date(iso)
  return d.toTimeString().slice(0, 5)
}

export const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** The text of a message as shown: the person's own words, else the body. */
export function textOf(m: Message): string {
  if (m.author === 'user') return m.words || (m.answers?.length ? '' : m.body)
  return m.body
}

/** One line for lists and timelines: question blocks become their prompts, answers their choices. */
export function lineOf(m: Message): string {
  if (m.author === 'user') {
    const w = (m.words ?? '').trim()
    if (w) return w.replace(/\s+/g, ' ')
    if (m.answers?.length) return 'answered ' + m.answers.map(answerText).join('; ')
    return m.body.replace(/\s+/g, ' ')
  }
  const prose = m.body.replace(/:::(question|question-multi|question-text|actions)[^\n]*\n([^\n]*)[\s\S]*?\n:::/g, (_x, _k, first) => '[? ' + first.trim() + ']')
  return prose.replace(/\s+/g, ' ').trim()
}
