import type { Topic, TopicMessage, TopicStatus } from '../api'

// A message sent from a task's pane (the Tasks board or a thread's Tasks pane) starts with the
// task's name and a short quoted context, so the agent can tell which task it is about:
//
//   [Task: Search box UI]
//   > Task context (from minbox): Building the search field and results list
//   > Status: In progress · Steps: 1/2 done; open: Show the results
//   > Related messages: Agent, 2026-11-17 10:02 UTC: "Add search to the inbox."
//
//   <the person's text>
//
// The thread view folds the quoted lines into a small "Task" chip; the agent gets all of it.

const STATUS: Record<TopicStatus, string> = { in_progress: 'In progress', waiting_on_you: 'Waiting on you', done: 'Done' }
const CONTEXT_HEAD = '> Task context (from minbox): '

/** One line, at most n characters (an ellipsis when cut). */
function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one
}

/** "2026-11-17 10:02 UTC": what the agent can match against the thread. */
function utc(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** The header line alone (also what the topic helper reads to link the message to the task). */
export function topicPrefix(title: string): string {
  return `[Task: ${title}]`
}

/** The task's header and quoted context: only the parts that exist, each capped. */
export function taskContext(t: Topic, msgs?: TopicMessage[] | null): string {
  const lines: string[] = [topicPrefix(clip(t.title, 120))]
  const summary = clip(t.summary || (t.detail ?? '').split('\n').find((l) => l.trim()) || '', 200)
  lines.push(`${CONTEXT_HEAD}${summary || clip(t.title, 120)}`)
  const tasks = t.tasks ?? []
  let state = `Status: ${STATUS[t.status] ?? t.status}`
  if (tasks.length) {
    const open = tasks.filter((k) => !k.done)
    state += ` · Steps: ${tasks.length - open.length}/${tasks.length} done`
    if (open.length) state += `; open: ${open.slice(0, 3).map((k) => clip(k.text, 80)).join('; ')}${open.length > 3 ? ` (+${open.length - 3} more)` : ''}`
  }
  lines.push(`> ${state}`)
  const recent = (msgs ?? []).slice(-2)
  if (recent.length) {
    const refs = recent.map((m) => {
      const who = m.author === 'user' ? 'You' : 'Agent'
      const when = utc(m.created_at)
      const ex = clip(stripTaskContext(m.excerpt ?? ''), 70)
      return `${who}${when ? `, ${when}` : ''}${ex ? `: "${ex}"` : ''}`
    })
    lines.push(`> Related messages: ${refs.join('; ')}`)
  }
  return lines.join('\n')
}

/** The whole message a task's pane sends. */
export function taskMessage(t: Topic, msgs: TopicMessage[] | null | undefined, text: string): string {
  return `${taskContext(t, msgs)}\n\n${text}`
}

export type ParsedTaskMessage = { title: string; context: string[]; text: string }

/** A message that starts with a task's header and quoted context, split up; null for any other. */
export function parseTaskMessage(words: string): ParsedTaskMessage | null {
  const lines = words.split('\n')
  const head = /^\[Task: (.+)\]\s*$/.exec(lines[0] ?? '')
  if (!head || !(lines[1] ?? '').startsWith(CONTEXT_HEAD)) return null
  let i = 1
  const context: string[] = []
  while (i < lines.length && lines[i]!.startsWith('> ')) {
    context.push(i === 1 ? lines[i]!.slice(CONTEXT_HEAD.length) : lines[i]!.slice(2))
    i++
  }
  while (i < lines.length && !lines[i]!.trim()) i++
  return { title: head[1]!, context, text: lines.slice(i).join('\n') }
}

/** The message with its task context left out ("[Task: …]" and the person's text): for previews. */
export function stripTaskContext(words: string): string {
  const p = parseTaskMessage(words)
  return p ? `${topicPrefix(p.title)} ${p.text}` : words
}
