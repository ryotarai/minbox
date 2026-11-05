// Pure text helpers of the minbox mod: the tools' contract and what a reply
// looks like when it reaches Claude. No `$` here, so it is easy to test.

export const SEND_TOOL = 'send_message'
export const READ_TOOL = 'read_thread'

export const SEND_DESCRIPTION = [
  "Send a message to the person's minbox inbox, the pane beside this terminal: it is how they hear from you.",
  'Use it EVERY time you need their opinion, a decision, an approval or an action from them (run something, check something, review, choose what is next), and when you finish work they should look at. Ask each decision as a `:::question` block (see `body`).',
  'They may not be watching the terminal: something asked only in the chat goes unseen.',
  'It does not block: it returns at once. Never wait, poll or sleep for the answer, and do not also ask the same thing in the chat.',
  'Their reply arrives later as a new message in this conversation, headed with its thread id (usable with `read_thread` for the earlier messages); meanwhile keep working on what does not depend on it, or end your turn.',
  'Leave `thread_id` out to start a new thread ; pass the thread_id of a reply to answer in its thread.',
  'Pass `thread_title` (short, under 60 characters) when you start a thread and whenever the thread\'s topic has changed, so the title in the inbox list shows what it is about now; leave it out to keep the title as it is.',
  'Pass `status` (working | need_action | finished) to set the thread\'s status: `working` when you start working on it, `need_action` when you need the person to decide or do something, `finished` when its task is done; leave it out to keep the current status.',
  'attachments: files to show the person; link one from the body (`[the mock](mock.html)`) to open it beside the thread. A guided `review` walks them through your changes.',
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
    thread_title: {
      type: 'string',
      description:
        "The thread's title in the inbox list (short, under 60 characters). Pass it when you start a thread and whenever its topic has changed; it replaces the current title, also on a reply with thread_id. Omit to leave the title as it is (a new thread then takes the first line of body).",
    },
    status: {
      type: 'string',
      enum: ['working', 'need_action', 'finished'],
      description:
        "The thread's status, shown as a badge in the inbox. Set `working` when you start working on the thread, `need_action` when you need the person to decide or do something, `finished` when the thread's task is done. Omit to keep the current status (a message with questions sets need_action by itself; the person's reply sets working).",
    },
    subject: {
      type: 'string',
      description: 'Deprecated alias of thread_title; use thread_title.',
    },
    thread_id: {
      type: 'string',
      description: 'The thread to continue (the thread_id a reply came with). Leave out to start a new thread.',
    },
    name: {
      type: 'string',
      description: 'A short tag for a new thread, e.g. "archive-search". Ignored with thread_id.',
    },
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

export const READ_DESCRIPTION =
  "Read the person's minbox inbox for this session: with `thread_id` (the id every reply from the person carries), that thread's messages and the answers given; without, the list of this session's threads."

export const READ_SCHEMA = {
  type: 'object',
  properties: {
    thread_id: { type: 'string', description: 'The thread to read. Leave out to list threads.' },
  },
  additionalProperties: false,
} as const

export const TITLE_TOOL = 'set_session_title'

export const TITLE_DESCRIPTION =
  "Set this session's title in the person's minbox session list: a few words saying what you are working on now (e.g. \"Fix login redirect loop\"). Call it when the work becomes clear and again when it changes; it costs nothing and needs no reply."

export const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'One line, about 3-8 words, at most 80 characters; plain text, in the language the person writes in.' },
  },
  required: ['title'],
  additionalProperties: false,
} as const

/** The system prompt's section on the inbox: the person hears from Claude there. */
export function inboxSection(sendTool: string): string {
  return [
    '# minbox: inbox',
    `The person follows this session through the minbox inbox and may not be watching the terminal. ${sendTool} is how you reach them:`,
    "- Every time you need their opinion, a decision, an approval or an action from them (run or check something, review, choose what comes next), send it with the tool, each decision as a :::question block. Do this every time, also for small questions; a question asked only in your chat reply goes unseen.",
    '- When you finish a task or a long stretch of work, send a short summary of what is done and anything they should look at.',
    '- Then keep working on what does not depend on the answer, or end your turn; their reply arrives here by itself. Do not ask the same thing again in the chat.',
  ].join('\n')
}

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

/** A plugin turn: the last reply asked the person in the chat, not in the inbox. */
export function nudgeText(sendTool: string): string {
  return [
    `minbox: your last reply asks the person for something (an opinion, a decision or an action) in the chat only, and they follow this session through the inbox.`,
    `Send it now with ${sendTool}: what you need, with enough context to answer cold, each decision as a :::question block. Do not repeat the chat reply here; after sending, end your turn.`,
  ].join(' ')
}

/** The system prompt's section on keeping the session's title current. */
export function titleSection(titleTool: string): string {
  return [
    '# minbox: session title',
    `The person sees this session in minbox's session list under a title you set with ${titleTool}. Keep it current:`,
    '- Set it once the task is clear, early in the first turn: a few words naming the work (e.g. "Fix login redirect loop"), not a status or a sentence.',
    '- Set it again whenever the main task changes (a new request, a different bug, the next phase); leave it alone for small steps within the same task.',
    "- Plain text, at most 80 characters, in the person's language. Do not mention the title in your replies.",
  ].join('\n')
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

/** The system prompt's section on opening pages for the person. */
export function openSection(openTool: string): string {
  return [
    '# minbox: opening pages',
    `When the person asks you to open, show or view a web page (a PR, an issue, a CI run, a URL), call ${openTool} with its URL. It opens the page in the browser they are using minbox from.`,
    '- Never open pages with Bash (`open URL`, `xdg-open`, `gh pr view --web`, `gh browse`, …): those open on the machine you run on, which may be a remote host the person is not sitting at.',
    '- With gh, get the URL first (e.g. `gh pr view --json url -q .url`), then pass it to the tool.',
  ].join('\n')
}

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

export const CARD_TOOL = 'card'

export const CARD_DESCRIPTION = [
  "Keep the person's minbox Board up to date: one card per piece of work, across sessions.",
  'action "list" shows the cards; "create" adds one (title, column, note); "update" changes one by id (move it with column, link a PR with pr_url / pr_state / pr_number).',
  'Columns: backlog, designing, look (waits on the person), building, review (the person reviews), shipped, icebox, dropped.',
  'Only works when the person turned the Board on in minbox settings.',
].join(' ')

export const CARD_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'create', 'update'] },
    id: { type: 'string', description: 'The card to update.' },
    title: { type: 'string' },
    column: { type: 'string', enum: ['backlog', 'designing', 'look', 'building', 'review', 'shipped', 'icebox', 'dropped'] },
    note: { type: 'string', description: 'One line: where it stands.' },
    thread_id: { type: 'string', description: 'The minbox thread about this card.' },
    pr_url: { type: 'string' },
    pr_state: { type: 'string', enum: ['draft', 'open', 'merged', 'closed'] },
    pr_number: { type: 'number' },
  },
  required: ['action'],
  additionalProperties: false,
} as const

export type Card = {
  id: string
  title: string
  column: string
  note: string
  pr_number?: number
  pr_state?: string
}

/** The card tool's answer. */
export function cardText(action: string, v: Card | Card[]): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return 'The Board has no cards yet.'
    return v.map((c) => `- ${c.id} [${c.column}] ${c.title}${c.note ? ` · ${c.note}` : ''}${c.pr_number ? ` · PR #${c.pr_number} ${c.pr_state ?? ''}`.trimEnd() : ''}`).join('\n')
  }
  return `${action === 'create' ? 'Created' : 'Updated'} card ${v.id} [${v.column}] ${v.title}.`
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

/** The turn text for the person's messages from the inbox (one or more). */
export function wakeText(pending: Pending[], sendTool: string, readTool: string): string {
  const parts = pending.map((p) => {
    const lines = [
      `minbox inbox: ${oneLine(p.subject) || 'a reply'} (thread_id: ${p.thread_id})`,
      p.new_thread ? NEW_THREAD_LINE : REPLY_LINE,
      `When they need to hear back, answer in the same thread: ${sendTool} with thread_id ${p.thread_id}.`,
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
  const lines = [
    `Sent to the minbox inbox${asking}${files} (${r.new_thread ? 'Started thread' : 'Added to thread'} ${r.thread_id}).`,
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
export function threadText(t: Thread): string {
  const lines = [`Thread ${t.id}: ${t.subject}`]
  for (const m of t.messages ?? []) {
    lines.push('', `[${m.author === 'agent' ? 'you' : 'person'} · ${m.created_at}]`, m.body.trim())
    for (const a of m.attachments ?? []) {
      lines.push(a.kind === 'review' ? `Guided review: ${a.name}` : `Attached: ${a.name} (${a.path})${a.type ? ` [${a.type}]` : ''}`)
    }
    for (const a of m.inline_images ?? []) lines.push(`Image shown: ${a.ref ?? a.name} (${a.path})`)
  }
  if (t.open_questions > 0) lines.push('', `(${t.open_questions} of your questions are still open; the person will answer in the inbox.)`)
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

/** The reminder that rides the conversation's first prompt. */
export function reminderText(sendTool: string, extra?: string | null, tools: { title?: string; open?: string } = {}): string {
  const lines = [
    `minbox inbox is on for this session: the person follows this session through it and may not be watching the terminal.`,
    `Whenever you need their opinion, a decision, an approval or an action from them, and when you finish work they should look at, send it with ${sendTool} (each decision as a :::question block) — every time, not only for big things — and keep going; their reply comes back here by itself.`,
    'A decision in the inbox stays there: never also ask it in the chat with a blocking question tool (AskUserQuestion or similar).',
  ]
  // Also in the system prompt (prompt.compose, and minbox's --append-system-prompt);
  // repeated here for environments that skip both.
  if (tools.title) lines.push(`Keep this session's title in minbox current with ${tools.title}: a few words naming the work, set early and again when the task changes.`)
  if (tools.open) lines.push(`To open a web page for the person (a PR, an issue, a URL), call ${tools.open}; never \`open URL\`, \`xdg-open\` or \`gh … --web\` in Bash, which open on the host machine.`)
  const more = extra?.trim()
  if (more) lines.push(`The person adds: ${more}`)
  return lines.join(' ')
}

/** After a compaction: the threads this session has open, so their ids stay right. */
export function openThreadsText(threads: Thread[], sendTool: string, extra?: string | null, tools: { title?: string; open?: string } = {}): string | null {
  const open = threads.filter((t) => !['quiet', 'archived', 'snoozed'].includes(t.section)).slice(0, 5)
  if (open.length === 0) return null
  return [
    `${reminderText(sendTool, extra, tools)}`,
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
