// Pure text helpers of the minbox mod: the tools' contract and what a reply
// looks like when it reaches Claude. No `$` here, so it is easy to test.

export const SEND_TOOL = 'send_message'
export const READ_TOOL = 'read_thread'

export const SEND_DESCRIPTION = [
  "Send a message to the person in minbox: your conversation with them (your stream) is how they hear from you; they may not be watching the terminal.",
  'Use it EVERY time you need their opinion, a decision, an approval or an action from them, and when you finish work they should look at. Ask each decision as a `:::question` block (see `body`).',
  'It does not block: their reply arrives later as a new message in this conversation. Never wait or poll for it, and do not also ask the same thing in the chat.',
  'Pass `task_ids` when the message is about tasks (from create_task / list_tasks): the reply and the person\'s messages it answers get them, so the person sees it in those tasks. Tasks you created in this turn are added by themselves; a quick answer needs none.',
  'attachments: files to show the person beside your message; link one from the body (`[the mock](mock.html)`) to open it. A guided `review` walks them through your changes.',
].join(' ')

export const QUESTION_GUIDE = [
  'The message, in Markdown. Lead with what you need from the person; they switch in cold, so say what it affects and what you know.',
  'Ask each decision as a block:',
  ':::question',
  'The question, on the first line.',
  'One to three short lines of context.',
  '- [ ] Choice A — why',
  '- [ ] Choice B — why',
  'Recommended: Choice A',
  ':::',
  '`:::question` picks one, `:::question-multi` any number, `:::question-text` asks for free text.',
  'Optional context lines: `Stopped: <what waits>` when your work is stopped on the answer; `Holds up: a; b` for what it blocks; `Replaces: <earlier question>` when you re-ask.',
  'Ask the person to do things by hand with an `:::actions` block of `- [ ] item` lines; they mark each Done or Can\'t do it.',
  'Fenced blocks draw as pictures: ```mermaid and ```dot (Graphviz) as diagrams, ```svg (an inline <svg>) as an image, ```html as a sandboxed live page. Use them instead of ASCII art.',
  'The person can also answer Other, add a note, or skip. Ask only what you cannot decide alone.',
  'Answers come back under "## Answers to your questions".',
].join('\n')

export const ATTACHMENTS_GUIDE =
  'Files to show the person beside your message, e.g. ["docs/plan.md", "/tmp/checkout.png", "src/retry.mjs"]: absolute (anywhere you can read) or relative to the session\'s folder. ' +
  'For something visual, a screenshot or image usually reads fastest; attach the HTML or source too when they should open or click through it. Any regular file, any size. ' +
  "Markdown, plain text, config and data files, Mermaid and Graphviz sources and HTML (its relative images and frames load from its folder) open in minbox's viewers; " +
  'images (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO) show in the message; videos (MP4, MOV, WebM) play beside it, and the person comments at moments (each comment comes back with its time and the paused frame\'s path); ' +
  'source code, scripts and other text open as code with line comments; PDFs and anything else are offered as a download. Folders and .env files are refused. ' +
  'The inbox keeps the version you sent and shows the file as it is now, saying when it changed. ' +
  "The person's annotations, including comments on images and code lines, come back in their reply. " +
  'Each attachment\'s kind in the result is markdown, text, html, mermaid, graphviz, code, image, video, pdf or file; treat any other as file. ' +
  'A markdown link to an attached file in the body, e.g. [the mock](proto/admin.html), opens it beside the thread.'

export const SEND_SCHEMA = {
  type: 'object',
  properties: {
    body: { type: 'string', description: QUESTION_GUIDE },
    task_ids: {
      type: 'array',
      items: { type: 'string' },
      description: "The tasks this message is about (ids from create_task or list_tasks). The person's messages this reply answers get them too. Leave out for a quick answer that is about no task.",
    },
    status: {
      type: 'string',
      enum: ['working', 'needs_you', 'blocked', 'done'],
      description: 'Optional: the new status of the tasks in task_ids (update_task does the same).',
    },
    thread_id: {
      type: 'string',
      description: 'Legacy, optional: an older thread to answer in. Leave out: the message goes to your conversation with the person.',
    },
    thread_title: { type: 'string', description: 'Legacy, optional; not needed.' },
    attachments: {
      type: 'array',
      items: { type: 'string' },
      description: ATTACHMENTS_GUIDE,
    },
    review: {
      type: 'object',
      description:
        "A guided review of your changes: minbox snapshots each file's diff, in the git repository or worktree that holds the file. Lead with the section the person should look at most. Working in a worktree or on a branch whose changes are committed: set cwd to the worktree and base to the branch you started from (e.g. main), or the review shows only uncommitted changes.",
      properties: {
        title: { type: 'string' },
        cwd: { type: 'string', description: 'Where relative file paths resolve, e.g. the git worktree you work in (absolute, or relative to the session directory). Default: the session directory.' },
        base: { type: 'string', description: 'A branch or commit to diff from (from where your HEAD left it), so committed changes show as well as uncommitted ones, e.g. "main". Default: HEAD (uncommitted changes only).' },
        summary: { type: 'string', description: 'What changed and why, in two or three sentences.' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              summary: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'files'],
          },
        },
      },
      required: ['title', 'sections'],
    },
  },
  required: ['body'],
  additionalProperties: false,
} as const

/** The API body of send_message, or an error for the agent. Only body is required (v3). */
export function sendRequest(e: any): { body: Record<string, unknown> } | { error: string } {
  const body = typeof e?.body === 'string' ? e.body : ''
  if (!body.trim()) return { error: 'body is required.' }
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
  const out: Record<string, unknown> = {
    body,
    task_ids: strs(e.task_ids),
    status: str(e.status),
    thread_id: str(e.thread_id),
    thread_title: str(e.thread_title) ?? str(e.subject),
    attachments: strs(e.attachments),
    review: e.review && typeof e.review === 'object' ? e.review : undefined,
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return { body: out }
}

export const READ_DESCRIPTION = [
  "Read the person's minbox inbox.",
  'With `thread_id` (the id every reply from the person carries, or one from list_threads / search): that thread\'s messages and the answers given. Any thread can be read, also one of another session (read-only).',
  'It returns the newest `limit` messages (default 30, at most 100), oldest first, and says how many exist; pass `before` (the message id the answer names) to page back to older ones. Long messages are cut and the whole answer is bounded, with a marker where text is missing.',
  "Without `thread_id`: the list of this session's threads (use list_threads for other sessions and filters).",
].join(' ')

export const READ_SCHEMA = {
  type: 'object',
  properties: {
    thread_id: { type: 'string', description: "The thread to read. Leave out to list this session's threads." },
    limit: { type: 'number', description: 'Most messages to return: the newest ones (default 30, at most 100).' },
    before: { type: 'string', description: 'A message id from an earlier answer ("older messages: before <id>"): returns the messages before it.' },
  },
  additionalProperties: false,
} as const

/** The API path of read_thread. */
export function readPath(e: { thread_id?: unknown; limit?: unknown; before?: unknown }): string {
  const id = typeof e.thread_id === 'string' && e.thread_id ? e.thread_id : null
  if (!id) return '/api/agent/threads'
  const p = new URLSearchParams()
  if (typeof e.limit === 'number' && e.limit > 0) p.set('limit', String(Math.floor(e.limit)))
  if (typeof e.before === 'string' && e.before) p.set('before', e.before)
  const qs = p.toString()
  return `/api/agent/threads/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`
}

export const TITLE_TOOL = 'set_session_title'

export const TITLE_DESCRIPTION =
  "Set this session's title in the person's minbox session list: a few words saying what you are working on now (e.g. \"Fix login redirect loop\"). Call it when the work becomes clear and again when it changes; it costs nothing and needs no reply."

export const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'One line, about 3-8 words, about 80 characters or fewer (a guide, not a hard limit); plain text, in the language the person writes in.' },
  },
  required: ['title'],
  additionalProperties: false,
} as const

/**
 * The turn's last words ask the person something: a question, or a request
 * for their decision or action. Read from the answer's end.
 */
export function asksPerson(answer: string): boolean {
  // Code and URLs are not asking anything (`a ? b : c`, `?q=`).
  const prose = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
  const tail = prose.trim().slice(-400)
  if (!tail) return false
  if (/[?？]\s*[*_`)）」]*\s*$/.test(tail)) return true
  const lastLines = tail.split('\n').slice(-4).join('\n')
  if (/[?？]/.test(lastLines)) return true
  return /(どうしますか|いかがですか|よろしいですか|しますか|ますか。|ご確認|確認してください|教えてください|選んでください|決めてください|お知らせください|お願いします|指示をください|ご判断|\bshould I\b|\bwould you like\b|\bdo you want\b|\blet me know\b|\bplease (?:confirm|review|check|choose|decide|run|approve|test|try)\b|\bwhich (?:one|option|approach)\b|\byour call\b)/i.test(lastLines)
}

/** A plugin turn: the turn answered a message from the person but never replied with send_message. */
export function replyNudgeText(sendTool: string, threadIds: string[]): string {
  void threadIds
  return [
    `minbox: the last turn handled a message from the person, but nothing was sent back with ${sendTool}, and they cannot see the terminal.`,
    `Reply now with ${sendTool}: the answer, or a short summary of what you did. Do not repeat the long text here; after sending, end your turn.`,
  ].join(' ')
}

/** A plugin turn: the last reply asked the person in the chat, not in the inbox. */
export function nudgeText(sendTool: string): string {
  return [
    `minbox: your last reply asks the person for something (an opinion, a decision or an action) in the chat only, and they follow this session through the inbox.`,
    `Send it now with ${sendTool}: what you need, with enough context to answer cold, each decision as a :::question block. Do not repeat the chat reply here; after sending, end your turn.`,
  ].join(' ')
}

export const OPEN_TOOL = 'open_url'

export const OPEN_DESCRIPTION =
  "Open a web page (a PR, an issue, a CI run, docs) in the person's browser, wherever they have minbox open. Use it instead of `open URL`, `xdg-open`, `gh … --web` or `gh browse`: those open the page on the machine Claude runs on, which may not be the person's computer."

export const OPEN_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'An absolute http(s) URL, e.g. https://github.com/owner/repo/pull/12.' },
  },
  required: ['url'],
  additionalProperties: false,
} as const

/**
 * The Bash command opens a web page on the host: `open URL` (and its Linux
 * kin) or gh's `--web` / `browse`. Those go to the minbox tool instead.
 */
export function opensBrowser(command: string): boolean {
  // At the start of a command (not an argument, as in `echo open …`).
  const start = String.raw`(?:^|[;&|(\x60]|\$\()\s*`
  const opener = new RegExp(start + String.raw`(?:open|xdg-open|gio\s+open|sensible-browser|x-www-browser|wslview)\s+(?:[^;&|\n]*?[\s'"])?['"]?https?:\/\/`)
  const gh = new RegExp(start + String.raw`gh\s+(?:browse\b|[^;&|\n]*\s(?:--web|-w)(?=[\s;&|)]|$))`)
  return opener.test(command) || gh.test(command)
}

export function openDeny(openTool: string): string {
  return `minbox: this would open the page on the host machine, not in the person's browser. Call ${openTool} with the page's URL instead (with gh, get it with e.g. \`gh pr view --json url -q .url\`).`
}

export type AttachmentRecord = { id: string; name: string; type?: string; kind?: string; path: string; author?: string; ref?: string }

export type Message = {
  id: string
  thread_id: string
  author: 'agent' | 'user'
  body: string
  words?: string
  questions?: { key: string; kind: string; prompt: string }[] | null
  created_at: string
  attachments?: AttachmentRecord[] | null
  inline_images?: AttachmentRecord[] | null
}

export type Pending = Message & {
  subject: string
  urgent?: boolean
  new_thread: boolean
  in_reply_to?: Message | null
  /** v3: the message's tasks, whether it is in the stream, and its kind ("continue": a goal's run). */
  tasks?: { task_id: string; title: string; status?: string }[] | null
  stream?: boolean
  kind?: string
}

export type Thread = {
  id: string
  subject: string
  updated_at: string
  unread: number
  open_questions: number
  section: string
  last_body: string
  last_author: string
  messages?: Message[]
  // read_thread (paged) only
  status?: string
  project_name?: string
  session_name?: string
  own?: boolean
  message_count?: number
  has_more?: boolean
  older?: number
  next_before?: string
}

const REPLY_LINE =
  'The person replied to you in the minbox inbox. Their reply follows as they wrote it: it is their answer to you.'
const NEW_THREAD_LINE =
  'The person started a new thread with you in the minbox inbox: a request of their own, not an answer to something you asked. It may be unrelated to what you were doing; say how you will handle it before you start.'

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** The last line of every delivered message: the thread's id and where the earlier messages are. */
export function readHint(threadId: string, readTool: string): string {
  return `(Thread ${threadId}. Earlier messages in this thread: call ${readTool} with this thread_id.)`
}

/** The line naming a message's tasks, or ''. */
export function tasksLine(p: Pending): string {
  const ts = p.tasks ?? []
  if (ts.length === 0) return ''
  return `Tasks: ${ts.map((t) => `${t.task_id} "${oneLine(t.title)}"${t.status && t.status !== 'working' ? ` (${t.status})` : ''}`).join('; ')}`
}

const STREAM_LINE =
  'Decide what it is about: an existing task (reply with send_message and its task_ids), new work (create_task, then reply), or nothing that needs a task (just reply).'

/** The turn text for the person's messages from the inbox (one or more). */
export function wakeText(pending: Pending[], sendTool: string, readTool: string): string {
  const parts = pending.map((p) => {
    if (p.stream) {
      if (p.kind === 'continue') return p.body.trim()
      const tl = tasksLine(p)
      return [
        `minbox: a message from the person (message ${p.id})${tl ? '' : '.'}`,
        ...(tl ? [tl + ' (they wrote it about these tasks).'] : [STREAM_LINE]),
        `Answer it with ${sendTool}, even briefly: text only in the terminal is not shown to them.`,
        '',
        p.body.trim(),
      ].join('\n')
    }
    const lines = [
      `minbox inbox: ${oneLine(p.subject) || 'a reply'} (thread_id: ${p.thread_id})`,
      p.new_thread ? NEW_THREAD_LINE : REPLY_LINE,
      `IMPORTANT: answer this message in the inbox, in this thread: call ${sendTool} with thread_id ${p.thread_id}, even for a short answer. Text you only write in the terminal is not shown to the person.`,
      '',
      p.body.trim(),
      '',
      readHint(p.thread_id, readTool),
    ]
    return lines.join('\n')
  })
  return parts.join('\n\n---\n\n')
}

export type SendResult = {
  thread_id: string
  new_thread: boolean
  task_ids?: string[] | null
  decision?: string
  questions?: { key: string; prompt: string }[]
  attachments?: { id: string; name: string; kind: string; path: string }[]
  images_not_shown?: { ref: string; reason: string; not_yet?: boolean }[]
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** What send_message returns to Claude. */
export function sentText(r: SendResult): string {
  const asking = r.questions?.length ? ` asking ${plural(r.questions.length, 'question')}` : ''
  const files = r.attachments?.length ? ` with ${plural(r.attachments.length, 'attachment')}` : ''
  const tagged = r.task_ids?.length ? ` Tagged with task${r.task_ids.length > 1 ? 's' : ''} ${r.task_ids.join(', ')}.` : ''
  const lines = [
    `Sent to the person in minbox${asking}${files}.${tagged}`,
    "The person's reply will arrive by itself as a new message in this conversation. Do not wait or poll for it.",
  ]
  if (r.questions?.length) {
    lines.push(`Questions the inbox shows: ${r.questions.map((q) => `"${q.prompt}"`).join(', ')}.`)
  }
  if (r.attachments?.length) {
    lines.push(`Attached: ${r.attachments.map((a) => `${a.name} (${a.kind})`).join(', ')}.`)
  }
  for (const n of (r.images_not_shown ?? []).slice(0, 10)) {
    lines.push(
      n.not_yet
        ? `This image does not exist yet: ${n.ref}; it shows once written there.`
        : `The message was sent, but this image will not show: ${n.ref} (${n.reason}). Copy the image to a plain folder and link that path, or attach it with attachments.`,
    )
  }
  return lines.join(' ')
}

/** read_thread's answer for one thread. */
export function threadText(t: Thread, readTool = 'read_thread'): string {
  const lines = [`Thread ${t.id}: ${t.subject}`]
  const meta = [t.status, t.project_name ? `project ${t.project_name}` : '', t.session_name ? `session ${t.session_name}${t.own === false ? ' (not yours)' : ''}` : '']
    .filter(Boolean)
    .join(' · ')
  if (meta) lines.push(meta)
  const shown = (t.messages ?? []).length
  if (t.message_count !== undefined && t.has_more) {
    lines.push(`Showing the newest ${shown} of ${t.message_count} messages; ${t.older ?? t.message_count - shown} older ones are not shown. For them call ${readTool} with this thread_id and before "${t.next_before}".`)
  }
  for (const m of t.messages ?? []) {
    lines.push('', `[${m.author === 'agent' ? (t.own === false ? 'agent' : 'you') : 'person'} · ${m.created_at} · ${m.id}]`, m.body.trim())
    for (const a of m.attachments ?? []) {
      lines.push(a.kind === 'review' ? `Guided review: ${a.name}` : `Attached: ${a.name} (${a.path})${a.type ? ` [${a.type}]` : ''}`)
    }
    for (const a of m.inline_images ?? []) lines.push(`Image shown: ${a.ref ?? a.name} (${a.path})`)
  }
  if (t.open_questions > 0) lines.push('', `(${t.open_questions} question${t.open_questions > 1 ? 's are' : ' is'} still open; the person will answer in the inbox.)`)
  return lines.join('\n')
}

/** read_thread's answer without a thread: the list. */
export function threadListText(threads: Thread[]): string {
  if (threads.length === 0) return 'No threads in the minbox inbox for this session yet.'
  return threads.map((t) => `- ${t.id} "${t.subject}" · ${threadState(t)}: ${oneLine(t.last_body).slice(0, 80)}`).join('\n')
}

function threadState(t: Thread): string {
  if (t.open_questions > 0) return `${t.open_questions} open question${t.open_questions > 1 ? 's' : ''}`
  if (t.last_author === 'user') return 'the person wrote last'
  return 'you wrote last'
}

/**
 * The server's instructions text (hello's `instructions`: the same text as
 * minbox's --append-system-prompt), wrapped for a prompt: models forget the
 * first instruction, so it rides the first prompt, the one after a compaction
 * and every Nth prompt.
 */
export function instructionsText(instructions: string): string {
  return `minbox: standing instructions (still in force):\n\n${instructions}`
}

/** The short fallback when the hello gave no instructions (server unreachable or old). */
export function fallbackReminderText(sendTool: string): string {
  return [
    `minbox: the person follows this session through the minbox inbox and may not be watching the terminal.`,
    `Whenever you need their opinion, a decision, an approval or an action from them, and when you finish work they should look at, send it with ${sendTool} (each decision as a :::question block) and keep going; their reply comes back here by itself.`,
    `Messages that arrive as "minbox: a message from the person" come from minbox: always answer them with ${sendTool}, never only in the terminal.`,
  ].join(' ')
}

/** After a compaction: the threads this session has open, so their ids stay right. */
export function openThreadsText(threads: Thread[]): string | null {
  const open = threads.filter((t) => !['quiet', 'archived', 'snoozed'].includes(t.section)).slice(0, 5)
  if (open.length === 0) return null
  return [
    `Your open minbox threads (${open.length}); answer in one with its thread_id:`,
    ...open.map((t) => `- ${t.id} "${oneLine(t.subject)}" · ${threadState(t)}`),
  ].join('\n')
}

/** Parses the server file's JSON ({ url }). */
export function serverUrlOf(text: string | null | undefined): string | null {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    return typeof v?.url === 'string' && /^https?:\/\//.test(v.url) ? v.url.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}
