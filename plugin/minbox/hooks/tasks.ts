// The task tools of the minbox mod, the Pi extension and the OpenCode plugin (all import this file,
// as they do text.ts and nav.ts): create_task, update_task and list_tasks. The agent keeps the
// person's Board with them (/api/agent/tasks, v3: docs/v3/api.md); this file holds their
// descriptions and schemas, the request of a call and the text an answer becomes. Self-contained (no
// imports), so every runtime loads it.

export const TASK_TOOLS = ['create_task', 'update_task', 'list_tasks'] as const
export type TaskTool = (typeof TASK_TOOLS)[number]

const STATUSES = ['working', 'needs_you', 'blocked', 'done']

const STATUS_GUIDE =
  'working: you are on it (the default). needs_you: you are blocked on the person (a decision, an answer, an action only they can take); asking a :::question already shows it. blocked: you wait on something outside them (CI, another session). done: finished, delivered, or dropped.'

const STEP_ITEM = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    done: { type: 'boolean' },
    steps: { type: 'array', description: 'Sub-steps (one level).', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] } },
  },
  required: ['text'],
  additionalProperties: false,
}

const STEPS_SCHEMA = {
  type: 'array',
  description: 'The checklist: short imperative steps, in order, each with done (sub-steps nest one level). Replaces the current steps.',
  items: STEP_ITEM,
}

const CRITERIA_SCHEMA = {
  type: 'array',
  description: 'A goal\'s "done when" criteria: checkable outcomes (e.g. "CI is green on the PR"). Replaces the current ones.',
  items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'], additionalProperties: false },
}

export const TASK_DESCRIPTION: Record<TaskTool, string> = {
  create_task: [
    "Add a task to the person's minbox Board: the Board is how they follow your work, and only you fill it in.",
    'A task is one distinct piece of work the person asked for (a feature, a bug, an investigation). Create one only for new work: first check the tasks shown with their message (or list_tasks) and keep using an open one that fits. Not for steps inside one piece of work (put those in its `steps`), not for a sub-question, a status check or a quick answer.',
    "The person's message that asked for it, and your replies in this turn, belong to it by themselves.",
    'If the result lists similar_tasks that are the same work, use that task (send_message task_ids) and do not create more.',
    'kind "goal": an outcome to keep pursuing until its `criteria` are met ("keep going until CI is green"); tasks can serve it (goal_id). Set autonomous: true only when the person asked you to keep going on your own: minbox then continues you until the criteria are met.',
    'It returns the task id; keep the task current with update_task.',
  ].join(' '),
  update_task: [
    'Update a task or goal of your project by its task_id (from create_task or list_tasks). Pass only what changed.',
    'Tick steps as you finish them (check_steps: their numbers from 1, in reading order), or replace the checklist with steps. A goal: tick its criteria with check_criteria; when all are met it is done.',
    'Set status needs_you only while you are truly blocked on the person (and ask them with send_message), done when finished or dropped. report: a short "where it stands" the person reads on the Board.',
    'message_ids: earlier messages that are about this task.',
  ].join(' '),
  list_tasks:
    "List your tasks and goals on the person's minbox Board (open ones and the ones done this week) with their ids, status, steps and criteria; all: true lists every open task of the project. Use it to find a task's id (e.g. after a compaction) before update_task or send_message task_ids.",
}

export const TASK_SCHEMA: Record<TaskTool, object> = {
  create_task: {
    type: 'object',
    properties: {
      title: { type: 'string', description: "A short name for the work (2 to 8 words), in the person's language." },
      kind: { type: 'string', enum: ['task', 'goal'], description: 'task (default) or goal (an outcome pursued until its criteria are met).' },
      goal_id: { type: 'string', description: 'The goal this task serves.' },
      summary: { type: 'string', description: 'One line on where it stands now.' },
      detail: { type: 'string', description: 'Optional: a few sentences (Markdown) on what it is about, what was decided, what is left.' },
      status: { type: 'string', enum: STATUSES, description: STATUS_GUIDE },
      steps: STEPS_SCHEMA,
      criteria: CRITERIA_SCHEMA,
      autonomous: { type: 'boolean', description: 'Goals only: minbox keeps continuing you until the criteria are met. Only when the person asked for it.' },
      message_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of earlier messages about it (the ones of this turn belong to it anyway).' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  update_task: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task or goal to update (from create_task or list_tasks).' },
      title: { type: 'string' },
      summary: { type: 'string', description: 'One line on where it stands now.' },
      detail: { type: 'string', description: 'The fuller summary (Markdown); replaces the current one.' },
      report: { type: 'string', description: 'The latest report the person reads on the Board.' },
      status: { type: 'string', enum: STATUSES, description: STATUS_GUIDE },
      steps: STEPS_SCHEMA,
      check_steps: { type: 'array', items: { type: 'number' }, description: 'Numbers (from 1, in reading order) of steps that are now done.' },
      uncheck_steps: { type: 'array', items: { type: 'number' }, description: 'Numbers (from 1) of steps that are not done after all.' },
      criteria: CRITERIA_SCHEMA,
      check_criteria: { type: 'array', items: { type: 'number' }, description: "Numbers (from 1) of a goal's criteria that are now met." },
      goal_id: { type: 'string', description: 'The goal this task serves.' },
      message_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of more messages that are about this task.' },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  list_tasks: {
    type: 'object',
    properties: {
      all: { type: 'boolean', description: "Every open task of the project, not only yours." },
    },
    additionalProperties: false,
  },
}

export type TaskRequest = { method: 'GET' | 'POST' | 'PATCH'; path: string; body?: Record<string, unknown> }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined)
const nums = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).map((x) => Math.floor(x)) : undefined)
const step = (s: any): any => ({ text: String(s.text), done: s.done === true, ...(Array.isArray(s.steps) && s.steps.length ? { steps: s.steps.filter((c: any) => c && typeof c.text === 'string').map((c: any) => ({ text: String(c.text), done: c.done === true })) } : {}) })
const steps = (v: unknown) => (Array.isArray(v) ? v.filter((s) => s && typeof s === 'object' && typeof (s as any).text === 'string').map(step) : undefined)

/** The fields of a call that the server takes, unset ones left out. */
function fields(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: str(e.title),
    kind: str(e.kind),
    goal_id: str(e.goal_id),
    summary: typeof e.summary === 'string' ? e.summary : undefined,
    detail: typeof e.detail === 'string' ? e.detail : undefined,
    report: typeof e.report === 'string' ? e.report : undefined,
    status: str(e.status),
    steps: steps(e.steps),
    criteria: steps(e.criteria),
    autonomous: typeof e.autonomous === 'boolean' ? e.autonomous : undefined,
    message_ids: strs(e.message_ids),
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}

/** The API request of a task tool's call, or an error for the agent. */
export function taskRequest(tool: TaskTool, e: Record<string, unknown>, _defaultThread?: string): TaskRequest | { error: string } {
  switch (tool) {
    case 'create_task': {
      if (!str(e.title)) return { error: 'title is required: a short name for the work.' }
      return { method: 'POST', path: '/api/agent/tasks', body: fields(e) }
    }
    case 'update_task': {
      const id = str(e.task_id)
      if (!id) return { error: 'task_id is required (from create_task or list_tasks).' }
      const body = fields(e)
      for (const k of ['check_steps', 'uncheck_steps', 'check_criteria'] as const) {
        const v = nums(e[k])
        if (v?.length) body[k] = v
      }
      if (Object.keys(body).length === 0) return { error: 'nothing to update: pass status, report, steps, check_steps, check_criteria, … ' }
      return { method: 'PATCH', path: `/api/agent/tasks/${encodeURIComponent(id)}`, body }
    }
    case 'list_tasks':
      return { method: 'GET', path: `/api/agent/tasks${e.all === true ? '?all=1' : ''}` }
  }
}

const oneLine = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')

/** A task as the agent reads it back: id, kind, status, title, summary, steps, criteria. */
export function taskLines(t: any): string[] {
  const manual = t?.manual_status ? ` (the person set it to ${t.manual_status} by hand)` : ''
  const goal = t?.kind === 'goal' ? 'goal ' : ''
  const auto = t?.auto?.state === 'running' ? ' [autonomous run on]' : ''
  const parent = t?.parent_id ? ` (serves goal ${t.parent_id})` : ''
  const lines = [`- ${goal}${t?.id} [${t?.status}]${manual}${auto} ${oneLine(t?.title)}${parent}${t?.summary ? ` — ${oneLine(t.summary)}` : ''}`]
  const ks: any[] = Array.isArray(t?.steps) ? t.steps : Array.isArray(t?.tasks) ? t.tasks : []
  let n = 0
  for (const k of ks) {
    lines.push(`  ${++n}. [${k?.done ? 'x' : ' '}] ${oneLine(k?.text)}`)
    for (const c of Array.isArray(k?.steps) ? k.steps : []) lines.push(`    ${++n}. [${c?.done ? 'x' : ' '}] ${oneLine(c?.text)}`)
  }
  const cs: any[] = Array.isArray(t?.criteria) ? t.criteria : []
  if (cs.length) {
    lines.push('  Done when:')
    cs.forEach((c, i) => lines.push(`  c${i + 1}. [${c?.done ? 'x' : ' '}] ${oneLine(c?.text)}`))
  }
  return lines
}

/** What a task tool returns to the agent. */
export function taskText(tool: TaskTool, v: any): string {
  const t = v?.task ?? v
  switch (tool) {
    case 'create_task': {
      const linked = Array.isArray(v?.tagged_messages) && v.tagged_messages.length ? ` The person's message${v.tagged_messages.length > 1 ? 's' : ''} of this turn and your replies in it belong to it.` : ''
      const similar = Array.isArray(v?.similar_tasks) && v.similar_tasks.length
        ? [
            `${typeof v?.note === 'string' && v.note ? oneLine(v.note) + ' ' : ''}Similar open tasks: ${v.similar_tasks.map((x: any) => `${x?.id} "${oneLine(x?.title)}"${x?.status ? ` (${x.status})` : ''}`).join('; ')}. If one is the same work, keep using it (send_message task_ids) and do not create more.`,
          ]
        : []
      return [`${t?.kind === 'goal' ? 'Goal' : 'Task'} created (task_id ${t?.id}).${linked} Keep it current with update_task.`, ...similar, ...taskLines(t)].join('\n')
    }
    case 'update_task':
      return [`${t?.kind === 'goal' ? 'Goal' : 'Task'} updated.`, ...taskLines(t)].join('\n')
    case 'list_tasks': {
      let ts: any[] = Array.isArray(v?.tasks) ? v.tasks : []
      if (ts.length === 0 && Array.isArray(v?.threads)) ts = v.threads.flatMap((th: any) => (Array.isArray(th?.tasks) ? th.tasks : []))
      if (ts.length === 0) return 'No tasks yet.'
      return ts.flatMap((x) => taskLines(x)).join('\n')
    }
  }
}
