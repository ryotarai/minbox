// The task tools of the minbox mod, the Pi extension and the OpenCode plugin (all import this file,
// as they do text.ts and nav.ts): create_task, update_task and list_tasks. The agent keeps the
// person's Tasks board with them (/api/agent/tasks); this file holds their descriptions and schemas,
// the request of a call and the text an answer becomes. Self-contained (no imports), so every
// runtime loads it.

export const TASK_TOOLS = ['create_task', 'update_task', 'list_tasks'] as const
export type TaskTool = (typeof TASK_TOOLS)[number]

const STATUSES = ['in_progress', 'waiting_on_you', 'done']

const STATUS_GUIDE =
  'in_progress: you are working on it (the default). waiting_on_you: you are blocked on the person: a decision, an answer or an action only they can take; not for a plain report or an optional "let me know". done: finished, delivered, or dropped.'

const STEPS_SCHEMA = {
  type: 'array',
  description: 'The checklist of the task: short imperative steps, in order, each with done. Replaces the current steps.',
  items: {
    type: 'object',
    properties: { text: { type: 'string' }, done: { type: 'boolean' } },
    required: ['text'],
    additionalProperties: false,
  },
}

export const TASK_DESCRIPTION: Record<TaskTool, string> = {
  create_task: [
    "Add a task to the person's minbox Tasks board (columns In progress · Waiting on you · Done): the board is how they see what each thread is working on, and only you fill it in.",
    'Create one when you start a distinct piece of work the person asked for (a feature, a bug, an investigation, a question to settle); one thread can have several. Not for the small steps inside one piece of work: those are its `steps`.',
    'Give a short title, a one-line summary of where it stands and, for larger work, steps as a checklist. Then keep it current with update_task: tick the steps as you go and set the status when it changes.',
    'It returns the task id. Pass the thread_id of the thread the work belongs to (the one its request came in).',
  ].join(' '),
  update_task: [
    'Update one of your tasks on the minbox Tasks board by its task_id (from create_task or list_tasks). Pass only what changed.',
    'Tick steps as you finish them (check_steps: their numbers, from 1), or replace the whole checklist with steps. Keep the summary saying where it stands.',
    'Set status waiting_on_you only while you are truly blocked on the person (and ask them with send_message), back to in_progress when you continue, done when it is finished or dropped.',
    'The person can also move a card by hand; your next status replaces their move, so set one only when it really changed.',
  ].join(' '),
  list_tasks:
    "List your tasks on the minbox Tasks board with their ids, status and steps: this session's threads that have tasks, or one thread's with thread_id. Use it to find a task's id (e.g. after a compaction) before update_task, and to see what the person moved by hand.",
}

export const TASK_SCHEMA: Record<TaskTool, object> = {
  create_task: {
    type: 'object',
    properties: {
      thread_id: { type: 'string', description: "The thread the work belongs to. Leave out only when you have a single thread: then the session's most recent thread." },
      title: { type: 'string', description: "A short name for the work (2 to 8 words), in the person's language." },
      summary: { type: 'string', description: 'One line on where it stands now.' },
      detail: { type: 'string', description: 'Optional: a few sentences (Markdown) on what it is about, what was decided, what is left. Shown in the task pane.' },
      status: { type: 'string', enum: STATUSES, description: STATUS_GUIDE },
      steps: STEPS_SCHEMA,
      message_ids: { type: 'array', items: { type: 'string' }, description: "Ids of the thread's messages about it. Default: the thread's newest message." },
    },
    required: ['title'],
    additionalProperties: false,
  },
  update_task: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task to update (from create_task or list_tasks).' },
      title: { type: 'string' },
      summary: { type: 'string', description: 'One line on where it stands now.' },
      detail: { type: 'string', description: 'The fuller summary (Markdown); replaces the current one.' },
      status: { type: 'string', enum: STATUSES, description: STATUS_GUIDE },
      steps: STEPS_SCHEMA,
      check_steps: { type: 'array', items: { type: 'number' }, description: 'Numbers (from 1) of steps that are now done.' },
      uncheck_steps: { type: 'array', items: { type: 'number' }, description: 'Numbers (from 1) of steps that are not done after all.' },
      message_ids: { type: 'array', items: { type: 'string' }, description: "Ids of more messages of the thread about it (added to the task's related messages)." },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  list_tasks: {
    type: 'object',
    properties: {
      thread_id: { type: 'string', description: "Only this thread's tasks." },
    },
    additionalProperties: false,
  },
}

export type TaskRequest = { method: 'GET' | 'POST' | 'PATCH'; path: string; body?: Record<string, unknown> }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined)
const nums = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).map((x) => Math.floor(x)) : undefined)
const steps = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter((s) => s && typeof s === 'object' && typeof (s as any).text === 'string')
        .map((s: any) => ({ text: String(s.text), done: s.done === true }))
    : undefined

/** The fields of a call that the server takes, unset ones left out. */
function fields(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: str(e.title),
    summary: typeof e.summary === 'string' ? e.summary : undefined,
    detail: typeof e.detail === 'string' ? e.detail : undefined,
    status: str(e.status),
    steps: steps(e.steps),
    message_ids: strs(e.message_ids),
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}

/**
 * The API request of a task tool's call, or an error for the agent. defaultThread is the thread the
 * integration knows the agent is answering (create_task and list_tasks use it when thread_id is left out).
 */
export function taskRequest(tool: TaskTool, e: Record<string, unknown>, defaultThread?: string): TaskRequest | { error: string } {
  switch (tool) {
    case 'create_task': {
      if (!str(e.title)) return { error: 'title is required: a short name for the work.' }
      const thread = str(e.thread_id) ?? defaultThread
      return { method: 'POST', path: '/api/agent/tasks', body: { ...fields(e), ...(thread ? { thread_id: thread } : {}) } }
    }
    case 'update_task': {
      const id = str(e.task_id)
      if (!id) return { error: 'task_id is required (from create_task or list_tasks).' }
      const body = fields(e)
      const check = nums(e.check_steps)
      const uncheck = nums(e.uncheck_steps)
      if (check?.length) body.check_steps = check
      if (uncheck?.length) body.uncheck_steps = uncheck
      if (Object.keys(body).length === 0) return { error: 'nothing to update: pass status, summary, steps, check_steps, … ' }
      return { method: 'PATCH', path: `/api/agent/tasks/${encodeURIComponent(id)}`, body }
    }
    case 'list_tasks': {
      const thread = str(e.thread_id)
      return { method: 'GET', path: `/api/agent/tasks${thread ? `?thread_id=${encodeURIComponent(thread)}` : ''}` }
    }
  }
}

const oneLine = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')

/** A task as the agent reads it back: id, status, title, summary, steps. */
export function taskLines(t: any): string[] {
  const manual = t?.manual_status ? ` (the person moved it to ${t.manual_status} by hand)` : ''
  const lines = [`- ${t?.id} [${t?.status}]${manual} ${oneLine(t?.title)}${t?.summary ? ` — ${oneLine(t.summary)}` : ''}`]
  const ks: any[] = Array.isArray(t?.tasks) ? t.tasks : []
  ks.forEach((k, i) => lines.push(`  ${i + 1}. [${k?.done ? 'x' : ' '}] ${oneLine(k?.text)}`))
  return lines
}

/** What a task tool returns to the agent. */
export function taskText(tool: TaskTool, v: any): string {
  switch (tool) {
    case 'create_task':
      return [`Task created in thread ${v?.thread_id} (task_id ${v?.id}). Keep it current with update_task.`, ...taskLines(v)].join('\n')
    case 'update_task':
      return ['Task updated.', ...taskLines(v)].join('\n')
    case 'list_tasks': {
      const ths: any[] = Array.isArray(v?.threads) ? v.threads : []
      if (ths.length === 0) return 'No tasks yet.'
      const out: string[] = []
      for (const th of ths) {
        out.push(`Thread ${th.id} "${oneLine(th.subject)}":`)
        const ts: any[] = Array.isArray(th.tasks) ? th.tasks : []
        if (ts.length === 0) out.push('  (no tasks)')
        for (const t of ts) out.push(...taskLines(t))
      }
      return out.join('\n')
    }
  }
}
