# minbox API contract (UI v2)

> **v3**: the UI is the Board / tasks / agent streams now. Its API (streams, tasks and goals, the task a message is about,
> read state, search, the composer) and the v3 agent contract (`send_message {body, task_id?}`,
> `create_task` / `update_task` with goals) are in [docs/v3/api.md](v3/api.md); the model is in
> [docs/v3/redesign.md](v3/redesign.md). Everything below still works (older threads are segments of
> each session's stream).

The browser UI (web/) and the Go server agree on this. Everything that already
exists keeps working; this lists what is added or changed. Times are RFC3339
strings, `null` when unset. JSON field names are snake_case.

## Sections

Thread sections, in this order (also the order of the session list):

| section    | label (UI)            | rule (first match wins)                                                        |
| ---------- | --------------------- | ------------------------------------------------------------------------------ |
| `archived` | Archived              | archived_at set and not came_back                                               |
| `snoozed`  | Snoozed               | snoozed_until > now                                                             |
| `quiet`    | Quiet                 | Mark read stands (marked_read_at >= the latest agent message)                    |
| `stopped`  | Stopped on you        | an open question (or action) carries `Stopped:`                                 |
| `holding`  | Holding up work       | an open question carries `Holds up:`                                            |
| `waiting`  | Waiting on you        | open questions or open actions                                                  |
| `new`      | New since you looked  | unread agent messages                                                           |
| `sent`     | Sent                  | the person wrote last                                                           |
| `quiet`    | Quiet                 | otherwise                                                                       |

Display order: stopped, holding, waiting, sent, new, quiet, snoozed, archived.
Pinned threads sort first inside their section; otherwise newest first.

`came_back`: archived, but an agent message was written after archived_at. Such a
thread is placed by the rules below `archived` while archived_at stays set.

A session's `section` is its top thread's section (the first thread in display
order that is not archived/snoozed); `archived` when the session is archived;
`quiet` with no threads.

## Question blocks (internal/question)

- Context lines starting `Stopped:` set `stopped` (the rest of the line); `Holds up:`
  sets `holds_up` (the rest split on `;` or `,`); `Replaces:` sets `replaces`
  (an earlier question's prompt). The lines stay in `context` too.
- `:::actions` block: each `- [ ] item` becomes a Question with `kind: "action"`,
  `prompt` = item text, `group` = a key shared by the block, choices
  `Done` and `Can't do it`. A line that is not an item is the block's title,
  copied into every item's `context`.
- Compose: action answers go in a `## Actions` section (`- Done: X`,
  `- Can't do it: X`, with ` — note` when there is a note); they are not counted
  in "Answered N questions".

Question JSON adds: `stopped?: string`, `holds_up?: string[]`, `replaces?: string`,
`group?: string`, kind adds `"action"`.

## JSON shapes

Session adds:

```
archived_at: string|null
section: Section
stopped: number      // threads in stopped
holding: number      // threads in holding
undelivered: number  // the person's messages not delivered yet
last_activity: string
top_thread: { id, subject, section, updated_at, last_author, last_delivery?, open_questions, stopped: bool, holds_up: number } | null
```

Thread adds:

```
name: string                 // short thread name tag, '' if none
archived_at, pinned_at, snoozed_until, marked_read_at: string|null
came_back: bool
stopped: bool
holds_up: number             // Holds up items over open questions
open_actions: number
message_count: number
attachment_count: number
last_agent_at: string|null
section: Section (above)
```

Message adds:

```
kind: "message" | "note"          // note: a person's note (re-ask, 👍); not a reply
attachments: Attachment[]         // meta only
annotations: Annotation[]         // on the person's messages
urgent: bool                      // Send now (kept for old pages; the person's messages are urgent by kind, see below)
closed: { [question_key]: "moved_on"|"replaced"|"marked_read"|"archived" }  // agent messages: open questions closed unanswered (no longer counted as open; "moved_on" and "replaced" ones still take answers, which reach Claude headed with a note naming the earlier message)
```

Attachment:

```
{ id, thread_id, message_id, kind: "file"|"review", name, path, mime, size, created_at }
```

`GET /api/attachments/{id}` adds: `exists: bool`, `changed: bool`, `modified_at`,
`text_sent?: string`, `text_current?: string` (text files up to 2 MB),
`review?: Review`.

`GET /api/attachments/{id}/raw?v=sent|current` serves the bytes.

Review:

```
{ title, summary, additions, deletions,
  sections: [{ title, summary, files: [{ path, additions, deletions, diff }] }] }
```

`diff` is unified diff text (`git diff HEAD -- path` in the session cwd at send
time; an untracked file diffs against /dev/null).

Annotation (sent with a reply, stored on the message):

```
{ kind: "comment"|"region"|"pen", attachment_id?: string, name?: string,
  quote?: string, line?: number, comment: string, image_path?: string }
```

The reply body Claude reads gets a `## Annotations` section:
`- <name> · "quote" (line N): comment` and `Image: <image_path>` when set.

Topic (a task of the Tasks board; see "Topics"):

```
{ id, thread_id, title, summary, status: "in_progress"|"waiting_on_you"|"done", position: number,
  created_at, updated_at, done_at: string|null,
  manual_status: ""|status, manual_at: string|null,   (moved by hand, until the agent sets the status again; see "Topics")
  detail: string,                       (a fuller summary, a few sentences, Markdown; "" when the agent gave none)
  tasks: [{text, done: bool}],          (its steps, ticked by the agent; [] when none)
  message_ids: [string],                (the thread's messages about it, oldest first)
  thread_name, thread_subject, session_id, project_id, project_name }   (the thread's fields: GET /api/topics and /api/topics/{id} only)
```

Settings (one JSON object; PUT merges top-level keys):

```
{ theme: "system"|"light"|"dark", text_size: 12|13|14|15,
  notifications: bool, sound: bool, tab_count: bool, single_key: bool,
  decision_mode: bool, prompt_extra: string,
  reply_suggestions: bool,     (default true; the reply questions, see "Reply suggestions")
  default_agent: ""|"claude"|"pi"|"opencode",  (default ""; the agent of a new session when neither the request nor the project says;
                                "" = Claude Code if installed, else the installed one; see "Coding agents")
  orchestrator_prompt: bool,   (default true; when on, spawn/resume appends the "# minbox: orchestration"
                                block to --append-system-prompt; read per spawn, running sessions keep theirs)
  list: { highlight_subject: bool, compact: bool, hide_icons: bool, small_names: bool, keep_panel: bool } }
```

Defaults: system, 13, true, true, true, true, false, "", {true,false,false,false,false}.
Stored keys that are no longer settings (the Board's `board`, the Tasks extraction's `topics`) are left out of `GET`; `PUT` refuses them (400).

## Thread commands

Design and behaviour: [thread-commands.md](thread-commands.md). `POST /api/threads/{id}/reply` with `words` starting
with `!` (and something after it) stores a person's message of `kind: "command"` and answers `201` with it at once; the
command runs in the background in the session's folder (`sh -c`, stdout and stderr together, 60 s, 64 KB). The message
carries `command: {message_id, command, cwd, state: "running"|"done", exit_code, timed_out, truncated, error?, output,
duration_ms, told}`; when it is done SSE `thread` is published, as for any thread change. The message is stored
delivered: it is not in `GET /api/agent/pending` as a message of its own. The finished result is put in front of the
thread's next delivered message in `/api/agent/pending` as a `<minbox_user_command>` block (once; `told` turns true when
that message is marked delivered). `422` for answers, markups, files or `forward_to` together with a command, a command
over 4000 characters, a session on another host, and `!cmd` as the body of a new thread (`POST /api/sessions/{id}/threads`).
`\!text` (in a reply or a new thread) is the text `!text`; a lone `!` is a normal message. Same auth as any reply.

## Topics

Topics are called **Tasks** in the UI; the API paths and the `topics` table keep the old name.
The Tasks board (global nav entry "Tasks", route `#v=tasks`; the old `#v=topics` and `#v=board` open it and the hash is
rewritten to `#v=tasks`) shows the topics being worked on inside threads, across all threads: one thread can have several, each with its own status, independent of the
thread's status. The Board (cards, the agent `card` tool, `/api/cards`, `/api/agent/cards`, setting `board`) is gone.

- Who fills it: the agent of the thread's session, through its tools `create_task`, `update_task` and `list_tasks`
  (Claude Code: `mcp__minbox__*`, always loaded; Pi and OpenCode: `minbox_*`; text, schemas and the request of a call
  in `internal/server/modtools_text.go`, served to the mod, the Pi extension and the OpenCode plugin by mod protocol 1). The system prompt's
  `# minbox: tasks` section tells it when: a task per distinct piece of work the person asked for, its steps as a
  checklist ticked as it goes, `waiting_on_you` only while blocked on the person, `done` when finished. Nothing is
  read from the messages: the earlier helper-model extraction (Haiku re-reading each thread after its messages, on idle
  and on finished; the `topics` setting) is gone. A stored `topics` setting is ignored and `PUT` refuses it (400).
- Agent API (`internal/server/topics.go`; bearer token of the session, 401 without; the same identification as the
  other `/api/agent/*` endpoints). A task belongs to one thread of the caller's session.
  - `POST /api/agent/tasks {thread_id?, title, summary?, detail?, status?, steps?: [{text, done?}], message_ids?}` ->
    `200` Topic. `title` is required (400). `status` in_progress (default) | waiting_on_you | done (aliases as for the
    board; else 400). `thread_id` must be a thread of the caller's session (else 404); without it, the session's live
    thread with the newest activity (400 when the session has none). The integrations pass the thread of the delivered
    message the running turn answers when the agent leaves it out and there is exactly one. Without `message_ids` the
    thread's newest message is linked. At most 100 tasks per thread (400).
  - `PATCH /api/agent/tasks/{id} {title?, summary?, detail?, status?, steps?, check_steps?: [n], uncheck_steps?: [n],
    message_ids?, thread_id?}` -> `200` Topic. Only the fields given change. `steps` replaces the checklist; then
    `check_steps` / `uncheck_steps` tick or untick steps by number (from 1; a number out of range: 400). `message_ids`
    are added to the related ones. A task of another session's thread, or unknown: 404; a `thread_id` that is not the
    task's: 400. A status set here clears the person's manual move (`manual_status`, `manual_at`): the agent is
    authoritative, the person can move the card again.
  - `GET /api/agent/tasks?thread_id=` -> `{threads: [{id, subject, tasks: Topic[]}]}`: the caller's live threads that
    have tasks (newest activity first), or the one thread asked for (also when it has none; another session's: 404);
    done tasks included, each thread's in their order.
  - Limits: titles 120 characters (one line), summaries 300 (one line), details 4000, 30 steps of 200 characters, 50
    message ids per call. Each change publishes SSE `topics` (`session_id`, `thread_id`) and a mod log line
    (`task-create` / `task-update`: ids and status only).
- Store (`topics` table, cascades with the thread; `internal/store/topics.go`): `CreateTopic` puts a new topic after
  the thread's others (`position`); `UpdateTopic` changes the given fields. `done_at` is set when a topic turns done
  (kept when it already was) and cleared when it leaves done. `updated_at` is bumped by a change of anything but the
  related messages. `message_ids` keep only messages of the topic's thread, in the thread's order, at most the newest 200.
  Columns `manual_status`, `manual_at`, `detail`, `tasks` (JSON), `message_ids` (JSON) were added to older databases on
  open; rows written by the old extraction stay.
- `GET /api/topics/{id}` -> `{topic: Topic, messages: [{id, author: "user"|"agent", kind, created_at, excerpt}]}` (`404`
  unknown topic): the topic with its thread's fields, and its related messages, oldest first; `excerpt` is the agent's
  body or the person's own words, spacing collapsed, cut at 240 characters. The topic pane loads it on selection and
  again on SSE `topics` / `thread`.
- `GET /api/topics?project=<id>&thread=<id>` -> `{topics: Topic[], done_days: 7}`: topics of every live
  thread (not archived, in a live session and project; `thread` narrows it to one thread, for the thread's Tasks pane), open ones by `updated_at` newest first, then done ones done within the last
  7 days, newest first, at most 30. When a thread's topics change, SSE `topics` (`session_id`, `thread_id`) is published.
- Moving a card by hand: `PATCH /api/topics/{id}` `{status}` -> `200` Topic (`400` unknown status, `404` unknown topic).
  Sets the status, sets `done_at` when it turns done (kept when it already was) or clears it, bumps `updated_at`, records
  `manual_status` + `manual_at` (the card shows it was moved; `list_tasks` tells the agent), and publishes SSE `topics`.
  The move lasts until the agent sets the task's status again.
- UI: drag a card to another column (desktop), or its menu (right-click, long press, the "…" button, Shift+F10: Move to);
  `⇧T` opens Tasks; on the board arrows / `H J K L` move the focus between cards, `Enter` opens its thread, `1` `2` `3`
  move it to In progress / Waiting on you / Done. Empty board: "No tasks yet. Agents add a task here when they start a
  piece of work you asked for, and keep it current."
- The topic pane: a click / tap on a card, or `Space` on the focused card, selects it (highlighted) and opens its pane:
  beside the board on a desktop, full screen on a phone (Back returns to the board). It shows the title, status, the
  thread (a link that opens it), `detail` as Markdown (else the summary), the tasks as read-only checkboxes with "n/m
  done" and a progress bar, and the related messages (author, relative time, excerpt; a click opens the thread and
  scrolls to that message, flashing it). While it is open, moving the focus moves the selection; `Esc` closes it (a
  second `Esc` leaves Tasks), `R` focuses its message box. The box sends with `POST /api/threads/{thread}/reply`
  `{words: "[Task: <title>]\n<text>"}` (Send or ⌘/Ctrl+Enter; the same queueing and delivery as the thread's own
  composer); the `[Task: <title>]` prefix is added on send (not shown in the box). Unsent text is kept per topic while
  the board is open. In the pane the steps are headed "Steps".
- A thread's Tasks pane: the checklist button in the thread header (`tasks-toggle`, "Show tasks" / "Hide tasks"; ⌘K
  "Show tasks" / "Hide tasks") shows the open thread's topics (`GET /api/topics?thread=`, reloaded on SSE `topics`). On a
  desktop it is a resizable column (default 320 px, min 240) right of the thread and, with the agent terminal open,
  between them: `[thread | tasks | terminal | shell]`; its × closes
  it, and the open state and width are stored with the layout (`minbox:layout` `tasksPane`, `tasksW`). A narrow window
  hides it after the shell. On a tablet or phone it opens full screen with Back. The list groups the thread's topics by
  status (compact cards, the "…" menu moves them); selecting one shows the topic pane's contents in place (Back to the
  list; no thread link and no message box: the thread's own box is beside it); Done / Reopen move it; a related message
  is revealed in the thread (on a phone the full-screen view closes first). Empty: "No tasks yet — the agent adds them
  when it starts work in this thread."
- e2e: the fake agent (`web/e2e/fake-claude.py`) keeps tasks through the agent API for every
  `TOPIC: <title> | <status> | <summary>` line (and `TOPIC-DETAIL:` / `TOPIC-TASK:` lines) of a message delivered to it,
  and links a delivered message that names a task's title.

## Reply suggestions

"Help me reply": when the agent spoke last, the helper drafts **questions for the person** (with options to pick) that
help them decide how to reply; the person's answers are put into their reply when they press Send.

`GET /api/threads/{id}/suggestions` -> `{questions: ReplyQuestion[0..8], command?: "!<cmd>", reason?: "disabled"|"not_needed"|"no_agent", error?: string}`
with `ReplyQuestion = {question: string, kind: "single"|"multi", options: {label: string, description?: string}[0..5]}`.
Every question also takes a free-text "Other" answer in the UI; `options: []` means free text only (the helper is told to
use that only when no sensible options exist). Always 200 for generation problems (error = short reason, questions empty);
404 for an unknown thread. No questions is a valid (cached) answer: nothing to ask.

- `disabled`: setting `reply_suggestions` is off. `not_needed`: the thread's last message is not from the agent
  (minbox's own messages to the agent, kinds `continue` and `run_result`, and older `place` requests, are left out: the agent's message before them counts).
- v3: a stream's help is `GET /api/threads/{stream_thread_id}/suggestions`; a task's view asks
  `GET /api/v3/tasks/{id}/suggestions` (same answer): the prompt holds the task's messages (every agent's), the
  last one decides `not_needed`, and the cache key is (`task:<id>`, last message id).
  `no_agent`: no coding agent (claude, pi or opencode) is installed to run the helper (feature off, not an error).
- Otherwise the request blocks (up to 50 s) for one helper run and returns it. Results are cached in memory per
  (thread id, last message id): LRU of 200 entries, TTL 1 h. Concurrent requests for the same key share one run
  (singleflight, the run is not cancelled when a request goes away); at most 2 runs at a time; a run times out after 45 s.
  Errors are not cached. When a run finishes, SSE `{type:"suggestions", session_id, thread_id}` is published (informational).
- The UI (ThreadView, `ReplyHelp.tsx`) requests it when the agent's message is the last one, no question of the agent is
  open and the session has not ended; the result and the person's answers are kept in memory per (thread, last message).
  Above the reply box (desktop and phone) it shows a collapsible, dismissible panel (`reply-qa`,
  `reply-qa-toggle` with `aria-expanded`, the collapsed state remembered in localStorage `minbox.replyHelp.collapsed`;
  `reply-qa-dismiss` drops it and its answers for this message). Each question (`reply-q`, `data-kind`) has option chips
  (`reply-q-option`; `role=radio` in a `radiogroup` with arrow-key roving for single, `role=checkbox` for multi; a second
  click on a picked radio unpicks it) and an "Other…" chip (`reply-q-other`) that opens a text field (`reply-q-other-input`;
  shown at once for a free-text-only question). Loading: `reply-qa-loading`.
- Send: the answered questions become one line each, `Q: <question> → A: <answers>` (multi: the picked labels in option
  order, then the Other text, joined by ", "; unanswered questions are left out), then a blank line and the text typed in the
  reply box. There is no preview of that block: the picked chips stay marked, and while anything is answered Send is
  enabled even with an empty reply box. Nothing answered: the reply is sent unchanged. A reply that is a `!command` is sent
  alone (the answers are not added). After a successful send the answers are cleared.
- Generator (always on the minbox server machine, also for remote hosts): the agent is chosen as in "Coding agents" >
  "Helper runs" (Pi: `pi --print …`, see docs/agents.md; the rest of this bullet describes Claude's). The executable is `MINBOX_SUGGEST_COMMAND`
  (a Claude-format helper; split on spaces; tests) or else the first word of `--claude` only, so the person's own flags (--model...) are not
  used. Run in a fresh empty temp directory, prompt on stdin:
  `claude -p --model haiku --effort low --system-prompt "<one line>" --tools "" --no-session-persistence
  --setting-sources "" --strict-mcp-config --disable-slash-commands --output-format json --json-schema '<schema>'`.
  `--system-prompt` replaces the default prompt; `--tools ""` disables all tools; `--setting-sources ""` loads no
  settings/CLAUDE.md; `--bare` is not used (it needs an ANTHROPIC_API_KEY, not the person's login). Verified with
  claude 2.1.318. Schema (`suggestSchema`): `{questions: [{question (<=200), kind: "single"|"multi", options: [{label (<=80),
  description? (<=160)}] (0..5)}] (0..8)}`.
- Envelope (`--output-format json`): one object `{"type":"result","subtype":"success","is_error":false,"result":"<the JSON as text>",
  "structured_output":{"questions":[...]}, ...}`; we read `structured_output`, else parse `result`.
- Prompt: last 12 messages (each cut at 1,500 chars, PERSON/AGENT), the open questions and options of a final agent
  message, then the instruction: the questions the person should answer to decide their reply, as many as needed (usually
  1–4, more only when warranted, none when nothing is to be decided), single or multi, 2–5 short options with an optional
  one-line description, options strongly preferred over free text, no "Other" option (the UI adds it), in the language the
  person writes in (else the agent's), nothing about thanks or greetings.
  Result parsing is lenient: questions and options are trimmed and deduped (case-insensitive), empty or malformed entries
  dropped, an unknown kind read as single, a bare string option read as its label; caps 8 questions, 5 options, 200/80/160 chars.
- Privacy/cost: the thread's recent text goes to Anthropic through claude (Haiku, low effort), once per agent message
  opened. Turn it off with the setting.

## Browser routes (added)

```
POST  /api/sessions/{id}/archive            409 unless ended
POST  /api/sessions/{id}/unarchive          (restart also unarchives)
POST  /api/sessions/{id}/restart            ended: resume (claude --resume). Running: kills the terminal (the exit is
                                              not a close), waits up to 10 s for it to exit, then resumes; the plugin dir,
                                              prompt and settings are read again, a shell starts fresh; the companion shell
                                              keeps running. Status: running -> starting (sessions events). A restart already
                                              in flight for the session: 409. Terminal does not exit in time: 400.
POST  /api/sessions/{id}/threads            body adds name
POST  /api/sessions/{id}/files              any file; header X-Filename; → {path}
GET   /api/sessions/{id}/completions        → {agents:[{name,description}], skills:[...], commands:[...]}
                                              from ~/.claude and <cwd>/.claude (agents/*.md, skills/*/SKILL.md, commands/*.md)
GET   /api/sessions/{id}/files?prefix=      → {entries:[{path, dir}]}  for @-mentions: names only, never contents
                                              prefix is the path being typed, relative to the session's cwd ("", "src/ma"),
                                              or "../x", "/abs/x", "~/x"; entries keep the typed folder part, folders end in "/".
                                              Folders first, then prefix > substring > in-order-letters matches, at most 50.
                                              Hidden names only when the typed name starts with "."; .git and node_modules only
                                              when typed ("node…"); gitignored entries only once a name is typed.
                                              Runs on the session's host (remote hosts: GET /fs/files on the host).
                                              Like the folder picker (GET /api/fs/dirs) it is not confined to the cwd.
GET   /api/sessions/{id}/tree               → {root, git, paths:[...], truncated}  the Files pane: every file under the
                                              session's cwd, relative to it, "/"-separated. In a git work tree:
                                              `git ls-files --cached --others --exclude-standard` (tracked, deleted-but-staged
                                              and untracked-not-ignored files). Elsewhere a walk (5 s) that skips .git,
                                              node_modules, .venv, venv, __pycache__, .cache, .next and the like and never
                                              follows symbolic links; empty folders are listed with a trailing "/". At most
                                              20000 paths (truncated: true past that). Folder missing: 404.
GET   /api/sessions/{id}/tree/status        → {entries:[{path, status}]}  git's status of the changed files under the cwd
                                              (`git status --porcelain=v1 -z --untracked-files=all -- .`, paths made relative
                                              to the cwd); status is added | modified | deleted | renamed | untracked
                                              (conflicts and type changes are modified). Outside git: entries [].
GET   /api/sessions/{id}/tree/file?path=    → {path, size, kind, text?}  one file for the viewer. path is relative to the
                                              cwd and must stay inside it: absolute paths, "..", NUL and symbolic links whose
                                              target is outside the cwd (resolved on the session's host) are 400; missing 404;
                                              a folder 400. kind: text (UTF-8, no NUL, at most 1 MiB; text holds it) |
                                              image (sniffed from the bytes, at most 10 MiB; bytes at /tree/raw) | binary |
                                              too_large | hidden (the .env family, as attachments: never shown).
GET   /api/sessions/{id}/tree/raw?path=     an image's bytes (same path rules), Content-Type sniffed, CSP sandbox,
                                              nosniff, no-store; not an image or a .env file: 415; over 10 MiB: 413.
                                              All four run on the session's host (remote hosts: GET /fs/tree,
                                              /fs/tree/gitstatus and /fs/tree/resolve on the host, then /fs/read); a host
                                              whose minbox predates them answers 404.

PATCH /api/threads/{id}                     {name?, subject?}
POST  /api/threads/{id}/read                (exists) the person looked: agent messages read
POST  /api/threads/{id}/unread              (exists) also clears marked_read_at
POST  /api/threads/{id}/mark-read           set aside: marked_read_at=now, read all, unsnooze
POST  /api/threads/{id}/unmark-read
POST  /api/threads/{id}/archive | /unarchive   (archive also unsnoozes)
POST  /api/threads/{id}/pin | /unpin
POST  /api/threads/{id}/snooze {until} | /unsnooze
POST  /api/threads/{id}/reask               a note asking Claude to ask the open questions again
POST  /api/threads/{id}/reply               body adds annotations, urgent, forward_to (session id: the reply
                                              starts a new thread there instead; → {thread_id, ...}), resume (bool:
                                              restart the ended session after storing). A reply unsnoozes.
                                              A `words` that starts with `!` (no leading space) runs as a command, see
                                              "Thread commands"; `\!` sends the text without the backslash.
POST  /api/messages/{id}/send-now           urgent=true (no button calls it any more: the person's messages are urgent anyway)
POST  /api/messages/{id}/cancel             deletes the person's message while it is still queued (not delivered, not
                                              being delivered) so it is never delivered → {ok, thread_id, thread_deleted}
                                              (a thread left empty is deleted too). 409 when delivered already / not
                                              the person's; 404 unknown. Publishes `thread` and `threads` events.

GET   /api/search?q=&session_id=&status=&from=agent|user&limit=
      → {threads: Hit[], messages: Hit[], files: Hit[]}
      Hit: {thread_id, session_id, session_name, subject, message_id?, attachment_id?, name?, author?,
            snippet, archived: bool, section, created_at}
      Case-insensitive; every space-separated word must match (AND); LIKE. threads: subject or name;
      messages: body; files: attachment name or text content. Newest first.

GET   /api/topics?project=                  {topics, done_days} (see "Topics")
GET   /api/topics/{id}                      {topic, messages: [{id, author, kind, created_at, excerpt}]} (see "Topics")
PATCH /api/topics/{id}                      {status} -> Topic (see "Topics")
GET/PUT  /api/settings
GET   /api/storage                          {data_dir, db_path, db_bytes, scratch_dir, scratch_bytes, scratch_files}
POST  /api/storage/clear-scratch            {removed}
GET   /api/about                            {version, server_protocol, required_host, host: {protocol, required_server, pid}|null, data_dir}
```

SSE event types: `sessions`, `threads`, `thread`, `topics`, `settings`.

## Mod / agent API (added)

- `send_message` adds `attachments: string[]` (file paths, relative to the session cwd
  allowed; at most 10, 5 MB each), `review: {title, summary, sections:[{title, summary, files: string[]}]}`
  and `name` (thread name for a new thread). The server snapshots files and diffs at send time.
- Pending items add `urgent: bool`: every message of the person (kind `message` or `note`), Send now, or one queued longer than 5 minutes; minbox's own requests (a goal's `continue`) are not. The mod
  delivers an urgent item even while the agent is busy (into its running turn).
- Delivery format (the mod's turn text, `wakeText`): per delivered message a header
  `minbox inbox: <subject> (thread_id: <id>)`, a line saying reply or new thread, the answer-in-thread
  hint, the body, and a last line `(Thread <id>. Earlier messages in this thread: call <read_thread tool> with this thread_id.)`.
  The same for replies, answers to questions, quick-compose threads, queued and urgent messages.
  The answer-in-thread hint is worded as IMPORTANT (reply with the send tool and that thread id, even for a
  short answer; terminal text is not shown). The system prompt (`AgentSystemPrompt`) says the same. If a turn started by a delivered message ends (reason `answer`) without a
  `send_message` call, the server answers the mod's `turn.complete` event with one reminder (`replyNudgeText`), which
  the mod submits once idle; the reminder's own turn never reminds again.
- `hello` answers `instructions`: the one instructions text, built by the same server function as `--append-system-prompt` (`AgentSystemPrompt`, plus the orchestration prompt while `orchestrator_prompt` is on, plus `The person adds: <prompt_extra>` when set). The server adds it to a prompt (wrapped as "minbox: standing instructions (still in force)", the answer to the mod's `prompt` event; docs/mod-protocol.md) on the first prompt after each hello, on the first prompt after a compaction (with the open-threads list) and on every 20th prompt (`MINBOX_ORCHESTRATOR_EVERY` overrides), never twice in one prompt; without instructions it falls back to a short reminder. `prompt_extra` and `orchestrator` are still answered, for older mods only; the current mod ignores them.

## Task tools (the agent keeps the Tasks board)

Tools `create_task`, `update_task`, `list_tasks` (Claude: `mcp__minbox__*`, loaded up front; Pi and OpenCode:
`minbox_*`) call `POST /api/agent/tasks`, `PATCH /api/agent/tasks/{id}` and `GET /api/agent/tasks`; see "Topics".
Schemas: `create_task {thread_id?, title, summary?, detail?, status?, steps?: [{text, done?}], message_ids?}`,
`update_task {task_id, title?, summary?, detail?, status?, steps?, check_steps?: [n], uncheck_steps?: [n], message_ids?}`,
`list_tasks {thread_id?}`. Each answers a short text with the task id, status, title, summary and numbered steps.

## Navigation tools (read-only agent API)

Tools `list_projects`, `get_project`, `list_sessions`, `list_threads`, `search` (Claude: `mcp__minbox__*`, deferred, found with ToolSearch; Pi: `minbox_*`)
and the extended `read_thread` are GETs on `/api/agent/*` with the session's bearer token (401 without; `internal/server/agentread.go`).
They answer projections of the stored rows, never tokens, notification destinations, Slack or device data, project icons or the agent's
conversation ids. Text and schemas: `internal/server/modtools_text.go` (served to every integration, docs/mod-protocol.md). Lists are bounded (`limit`, default 50, at most 200) and say `total` and `has_more`.

- `GET /api/agent/projects?archived=1` -> `[{id, name, dir, host_id, host_name, default_agent, pinned, archived, session_count, live_sessions, thread_count, need_action, unread, last_activity}]` (thread counts: live threads, archived ones excluded).
  `GET /api/agent/projects/{id}` -> the same plus `sessions: [agentSession]` (Claude-kind sessions, newest first, at most 50); 404 `no such project`.
- `GET /api/agent/sessions?project_id=&status=&agent=&archived=1&limit=` -> `{sessions: [{id, name, title, cwd, status, agent, kind, project_id, host_id, host_name, archived, unread, waiting, last_activity, self?}], total, has_more}`. Shell terminals are not listed; `archived=1` lists archived sessions instead of live ones.
- `GET /api/agent/inbox?project_id=&session_id=(id|self)&status=&awaiting=person|agent&unread=1&q=&archived=1&limit=` -> `{threads: [{id, subject, name?, session_id, session_name, project_id, project_name, status, section, updated_at, unread, open_questions, message_count, last_author, last_body (at most 300 bytes), archived, self?}], total, has_more}`, newest first, across all live sessions (with `session_id`, also an archived session's).
  `status` is working | need_action | blocked | finished (aliases accepted); `awaiting=person`: status need_action or open questions; `awaiting=agent`: the person wrote last; `q`: all words in subject, name or last message (case-insensitive). Bad `status` / `awaiting`: 400. `archived=1` lists archived threads instead of live ones.
  (`GET /api/agent/threads` stays: this session's threads, an array, used for the open-threads reminder.)
- `GET /api/agent/search?q=&project_id=&session_id=(id|self)&from=agent|user&limit=` (limit default 20, at most 50 per kind) -> `{threads, messages, files}` as `GET /api/search` (hits with `thread_id`, `session_id`, `session_name`, `subject`, `snippet` cut at 400 bytes, `author`, `archived`, `section`, `created_at`). Empty `q`: 400. `project_id` filters after the search, so it may return fewer than `limit`.
- `GET /api/agent/threads/{id}?limit=&before=` reads ANY thread by id, also another session's (writing stays limited to the own session: `POST /api/agent/messages` with a foreign `thread_id` is 404). Answer:
  `{id, subject, session_id, session_name, project_id, project_name, status, section, updated_at, unread, open_questions, own, message_count, messages: [{id, author, body, truncated?, body_bytes?, created_at, questions?: [prompt], attachments?: [{id, name, kind, type, path, ref?}], inline_images?}], has_more, older, next_before?}`.
  Messages are the newest `limit` (default 30, at most 100), oldest first. `before` is a message id of the thread (an id not in it: 400): the page ends just before it. A body over 8,000 bytes is cut on a rune boundary and ends with `… [message cut: N more bytes]` (`truncated`, `body_bytes` = full size); the bodies of a page together are bounded at 60,000 bytes: the oldest messages of the page drop first (always at least the newest one stays). `has_more` / `older` count the messages before the page; `next_before` (the page's first message id) is the next `before`. Annotations, answers and delivery state are not part of the answer; the text of the tool says how many messages exist and how to page.

## Thread fork (start a thread from a message)

Design and behaviour: [thread-fork.md](thread-fork.md). Browser API (not the mod's):

- `POST /api/threads/{id}/fork/preview` `{message_id, target, before_n?, subject?, instruction?}` -> `{handoff, message, text, bytes, subject, seq, agent, same_session, warnings[]}`.
  `target` is `{kind: "session", session_id?}` (an existing session; omitted id or the source's own = same session) or `{kind: "new_session", project_id, agent?, name?}`.
  `before_n` (0-10) also carries that many earlier messages. `text` is what the new agent receives first (`handoff` + blank line + `message`, the visible first message).
  Nothing is created. 404 no such thread / message not in it; 400 note message, bad target, archived or ended target session, unknown project, agent not installed.
- `POST /api/threads/{id}/fork` (same body) -> 201 `{thread, session}`: creates the thread (and the session for `new_session`, as `POST /api/sessions`) with the link, in one transaction. The first message is `instruction` (or a default line); the handoff is not stored in it but served in front of it by `GET /api/agent/pending`.
- Thread JSON (`GET /api/threads/{id}`) adds `forked_from: {thread_id ('' when gone), subject, project_name, session_name, session_id, message_id, seq, gone, message_gone, same_session, carry_before, handoff, created_at}` on a fork and `forks: [{thread_id, subject, project_id, project_name, session_id, session_name, agent, status, from_message_id, seq, same_session, archived_at, created_at}]` on its source. Thread lists carry `is_fork` and `fork_count` only.
- Mod: `GET /api/agent/pending` bodies carry the handoff block of a fork's first message, and a `<minbox_thread_forks>` block in front of the first pending message of the source's session (forks into other sessions only); delivered with the message. SSE: `thread` for both threads.

## Terminal attach

After the replay, and after every resize, the host sends every attached client a
text frame `{"type":"size","cols":N,"rows":M}`. Clients still send `resize` frames.
The PTY takes the smallest of the attached clients' sizes (the `resize` frames) and
returns to its start size when no client is left that sent one.
A `resize` with `"lease":true` is a lease: the host counts it for 15 s and drops it
unless the client sends it again (the web view repeats it every 5 s while the page is
visible and sends it at once when shown again). A `resize` without `lease` never expires
(older clients). A closing connection drops its size at once. When no size is left the
PTY returns to the size it was started with.
A phone view does not send `resize` unless the person asks ("Fit to this screen").

The replay is the last 2 MiB of output. An agent's TUI (OpenCode, Claude Code, Pi) draws its
screen once and then only what changes, so after a while the replay holds only changes and a
new view would draw a nearly empty screen. Two things fix that:
- Repaint: the server attaches to an agent's terminal (`/terminal`, not `/shell/terminal`) with
  `GET /terminals/{id}/attach?repaint=1`. Once that view has sent its first `resize` (or after
  1 s), unless the PTY was resized since it attached, the host makes the PTY one row shorter
  for 300 ms and then gives it its size back: the app repaints its whole screen, which every
  view draws. No `size` frame is sent for it, so the views keep their size. One nudge at a time.
  A host older than this ignores the query.
- Modes: once the start of the output is cut off the replay, the host puts back what the app
  set there: the alternate screen (`?1049h`/`?1047h`/`?47h`) before the replay if the sequence
  that entered it was cut off, and after it the cursor keys, cursor visibility, mouse reporting,
  focus events, bracketed paste and the kitty keyboard flags as the app left them. The cut is
  made at an escape, not inside a sequence.

### Companion shell

`GET /api/sessions/{id}/shell/terminal` (WebSocket, same frames as `/terminal`) attaches to a
login shell that belongs to a Claude Code session: same host, started in the session's `cwd`
(the host's `$SHELL -l`, like a `shell` session). It is a second host terminal with id
`<session id>:shell`, started on the first attach and kept running while no client is attached
(a reattach replays its scrollback). If the person exits it, the next attach starts a new one.
It is not a session: it is in no list, status, rail or inbox logic, and its exit changes nothing
on the session. It ends when the session is stopped, ends, is deleted, or its host is removed.
Errors: 400 for a `shell` session, 409 when the session has ended, 503 when the host is away.
No host protocol change (the id is opaque to the host; `RemoteProtocol` is not bumped).

## Attachments v2 (match Plannotator Inbox)

No size or count limits on agent attachments. Refused: folders, non-regular files, the
dotenv family (`/(^|\.)env$/i`, `/^\.envrc$/i`, `/^\.env\./i` except `.env.example`),
checked on the named path and the realpath. One refusal refuses the whole send.
Bytes live in `<data dir>/blobs/<sha256>` (done: internal/server/blobs.go).

Attachment JSON (in `message.attachments`, `message.inline_images`, and the detail route):

```
{ id, thread_id, message_id, author: "agent"|"user",
  kind: "file"|"review",                       // unchanged
  type: "markdown"|"text"|"html"|"mermaid"|"graphviz"|"code"|"image"|"video"|"pdf"|"file",
  name, path /* realpath */, named_path: string|null, mime, size,
  width?, height?, duration_ms?, sent_mtime, created_at,
  inline: bool, ref?: string /* inline image: the src as written in the body */ }
```

Type detection = Plannotator's `decideInboxAttachmentKind` (spec §2): by name first, then
bytes (image magic incl. SVG first element, `%PDF-` in 1024 B, ftyp/EBML video), whole-file
UTF-8-without-NUL test, view bound 16 MiB. Image width/height, video duration/size when parseable.

`GET /api/attachments/{id}` adds: `exists, changed, modified_at, current_size,
unavailable: {code: "attachment_missing"|"attachment_changed_type", message}|null`,
and for text-read types (all but image/video/pdf/file) `text_sent`, `text_current` (≤ 16 MiB).

Routes (all by id; `v=sent|current`, default current):

```
GET  /api/attachments/{id}/raw            text types: text/plain; image: type re-sniffed; video: Range. CSP sandbox, nosniff
GET  /api/attachments/{id}/download       Content-Disposition: attachment (filename*), octet-stream (pdf: application/pdf), Range
GET  /api/attachments/{id}/view           {text, html|null}; html type: html = text with <base href="/api/html-assets/{token}/"> (token per folder)
GET  /api/html-assets/{token}/{path...}   files of that folder; refuses segments starting "." and dotenv names; html docs ≤ 2 MB;
                                           CSP "sandbox allow-scripts allow-modals; connect-src 'none'"
GET  /api/attachments/{id}/markdown-image?path=   image the markdown references, relative to its folder (image rules §5.2)
GET  /api/attachments/{id}/linked?path=   sibling .md/.mdx/.html in the same folder, read-only → {name, path, text, html|null}
POST /api/embeds {html}                   → {id, url}; id = first 32 hex of sha256(html); ≤ 512 KiB; memory, 500 entries / 64 MiB
GET  /api/embeds/{id}                     the built document: BASE_CSS + BOOTSTRAP (+ agent html), CSP verbatim from spec §5.1
GET  /api/messages/{id}/image?path=<ref>  an inline image of that message (captured at send)
POST /api/uploads?name=                   raw body ≤ 100 MB, plain file name, no dotenv → {upload:{upload_id,name,size,type,sha256,created_at,mime,width?,height?}}
GET  /api/uploads/{id}/text               a pending pasted-text upload's words {text}
DELETE /api/uploads/{id}
POST /api/markups                         raw image ≤ 128 MiB → {path (absolute), name, url}; GET /api/markups/{name}
```

Person files: `POST /api/threads/{id}/reply` and `POST /api/sessions/{id}/threads` accept
`uploads: [upload_id]` → copied to `<data dir>/uploads/<att_id>/<name>` (mode 0400) and recorded
as attachments (author user) of the person's message. A reply may be files only. At delivery
the body the agent reads gets `Attached: <name> (<path>)` lines appended (not stored).

Inline images: at agent send, `![](src)` and `<img src>` in the body (not in code; not remote,
data:, blob:) are captured (spec §5.2 rules; relative to the session cwd; ≤ 10 MB / 50 MP;
max 64) as `inline_images` records (inline: true, ref). Failures do not refuse the send;
the result lists `images_not_shown: [{ref, reason}]`.

Agent send result adds `attachments: [{id, name, kind: <type>, path}]` and `images_not_shown`.
The mod's text: `Sent to the minbox inbox with N attachment(s) …` plus the images-not-shown
sentences (spec §5.2). The `attachments` field description follows Plannotator's (spec §1).

Annotations in a reply (`annotations: Annotation[]`):

```
{ kind: "comment"|"region"|"pen"|"video"|"element"|"diagram",
  attachment_id, version: "current"|"sent", name?, quote /* originalText */,
  line_start?, line_end?, time? /* seconds */, comment,
  images?: [{path, name}], region?: {x, y, w, h, natural_w, natural_h} }
```

Composed after answers/actions exactly as spec §4.1 ("# Feedback on the attached files",
one "## <label>" per file and version; label = path relative to the session cwd if inside,
else absolute; " (the version you sent)" for v=sent; entries "### n. (line N|lines A–B)
Feedback on: \"…\"" / "> text" / "**Attached images:**"; video "At m:ss (s.s s of m:ss)";
region "Region: x= y= w= h= (of W×H)"; ends "---").

## Hosts (several machines)

Every machine runs `minbox host`; the server connects to each. The machine the server
runs on has the built-in host "local" (started by the server, Unix socket, as today).
Other hosts: `minbox host --listen 0.0.0.0:4849 [--data-dir]` prints its token (kept in its
data dir) and serves the host protocol over HTTP/WebSocket with `Authorization: Bearer <token>`.

Host JSON:

```
{ id, name, url, builtin: bool, status: "online"|"offline"|"connecting",
  version, os, arch, latency_ms, last_seen, error, sessions: number }
```

```
GET    /api/hosts
POST   /api/hosts {name, url, token}            → host (tests the connection first; 400 with the reason)
PATCH  /api/hosts/{id} {name?, url?, token?}
DELETE /api/hosts/{id}                           its sessions stay, as Ended; their threads stay readable
POST   /api/hosts/test {url, token}              → {ok, version, os, arch, latency_ms, error}
POST   /api/hosts/{id}/retry
POST   /api/hosts/{id}/rotate-token              → {token} (the host takes the new one at once)
```

SSE event `hosts`. Session JSON adds `host_id`, `host_name`. `POST /api/sessions` takes
`host_id` (default: local). `GET /api/fs/dirs` and `POST /api/fs/mkdir` take `host_id`.

Everything that touches a session's files happens on its host: folder browsing, attachments
(snapshot, current version, html assets, markdown images, linked pages), review diffs, inline
images, the transcript check for --resume, completions, and files the agent must read
(pasted images, the person's uploads, markups) are written to that host.

The mod on another machine talks to its host (MINBOX_SERVER_FILE written by the host,
pointing at the host's loopback agent endpoint); the host relays agent API calls to the
server over the server's connection to it. Long polls work across the relay.

### Attachments v2: as built (server notes)

- `GET /api/attachments/{id}` also answers `current_size`, `too_large` (text file now over 16 MiB),
  `author`, `type`, `named_path`, `sent_mtime`, `width/height/duration_ms`, `ref`, `inline`.
  `exists` is false only when the file is gone (`attachment_missing`); a changed type keeps
  `exists: true` with `unavailable` set.
- `GET .../view` answers `{version: "current"|<sent sha256>, text, html, unavailable}`; when the
  current file is unavailable it falls back to the sent version.
- `named_path` is set only when the attached name is itself a link (not a path through a linked
  folder such as macOS /var).
- HTML-asset folder tokens live in memory: after a server restart the page re-fetches `view`.
  The guard lets GET/HEAD of `/api/html-assets/` and `/api/embeds/` through from opaque
  origins (Origin absent or `null`, any Sec-Fetch-Site).
- `POST /api/uploads` and `POST /api/markups` answer 201. Refusals carry `code`
  (`upload_refused`, `upload_too_large`, `upload_not_found`).
- Pending items (mod API) carry `attachments` and a `body` with the `Attached:` lines.
- Search's Files group covers the person's files too; `from` filters files by author.
- `thread.attachment_count` counts attachments, not inline images.
- Annotations accept the older `line` and `image_path` fields (mapped to `line_start` / `images`).
- Mod result: `Sent to the minbox inbox[ asking N question(s)][ with N attachment(s)] (Started|Added to thread <id>).`
  then the reply line, `Attached: name (kind), …`, and the images-not-shown sentences (first 10).

### Hosts: as built

- Host JSON: `{id, name, url, builtin, status, version?, os?, arch?, latency_ms? (online only), last_seen, error?, sessions}`.
  The built-in host's `url` is `unix://<socket>`; its `version` is the server's.
- `POST /api/hosts` tests first (400 `wrong token`, `could not connect: …`, `its minbox is too old …`).
  `POST /api/hosts/test` answers 200 `{ok:false, error}` on failure.
- `PATCH` of url/token reconnects; the built-in host only takes `name`. `rotate-token` needs the host online (409 otherwise).
- `DELETE` kills the host's running sessions (if reachable), marks them ended, keeps them.
- `minbox host --listen ADDR [--data-dir]` (also `minbox host start --listen`): token in `<data-dir>/host-token`,
  mod in `<data-dir>/plugin`, relay server file `<data-dir>/host-server.json`, files under `<data-dir>/{scratch,uploads,markups}`.
- Host protocol: same as the socket host plus `Authorization: Bearer` on every request, `/fs/*` (file access),
  `POST /token`, `GET /relay` (WebSocket the server opens; mods' `/api/agent/*` calls ride it). `/version` adds
  `version, os, arch, remote`. Spawn requests may carry `{{MINBOX_PLUGIN_DIR}}` / `{{MINBOX_SERVER_FILE}}` and `inherit_env`.

## Hosts v2: pairing with public keys, Tailscale or Direct (replaces the token)

Supersedes the token parts of "Hosts". Everything else (server→host connection, relay,
host-side files, placeholders) stays.

Auth: the server has an ed25519 key pair in its data dir (`server-key`, 0600) and a name
(the machine's hostname). Every request to a remote host is signed:
`Authorization: Minbox-Sig key=<SHA256 fingerprint>, ts=<unix>, nonce=<hex>, sig=<base64>`,
sig = ed25519 over `METHOD\nPATH?QUERY\nts\nnonce` (WebSocket upgrades too). The host accepts
keys listed in `<host data dir>/authorized-servers.json` ([{name, public_key, fingerprint,
added_at}]), ts within ±120 s, nonce not reused within that window. No more host token.

Unauthenticated host routes: `GET /version` → {protocol, required_server, version, os, arch,
hostname, tailscale: bool}; `POST /pair {server_name, public_key}` → {code: "482-913"} (6 digits,
expires in 10 min; kept in `<data dir>/pairing/<code>.json`); `GET /pair/{code}` →
{status: "pending"|"accepted"|"rejected"|"expired"}. Authenticated: `DELETE /pair/self`
(forget the calling server's key).

Host CLI (same machine as the host, reads/writes its data dir; the running host reloads the
files): `minbox pair list` (lines `CODE  SERVER-NAME  ed25519 SHA256:…`), `minbox pair accept
CODE`, `minbox pair reject CODE`. `minbox host --listen ADDR` (Direct) and
`minbox host --tailscale [--tailscale-user-login LOGIN] [--port 4849] [--tailscale-port 14849]`: listen on
127.0.0.1:port only, run `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (or the
current CLI's equivalent), and require the header `Tailscale-User-Login` == LOGIN on every
request (tailscale serve sets it).

Host JSON (replaces the token fields):

```
{ id, name, url, builtin, method: "builtin"|"tailscale"|"direct", tailscale_login?: string,
  paired: bool, pairing_code?: string /* while waiting for accept */, fingerprint?: string,
  status: "online"|"offline"|"connecting"|"pairing", version?, os?, arch?, latency_ms?,
  last_seen, error?, sessions }
```

Browser routes:

```
GET    /api/hosts/tailscale            → {available: bool, login?: string, suffix?: string /* tailnet MagicDNS suffix */}
POST   /api/hosts/probe {url}          → {ok, version?, os?, arch?, hostname?, tailscale?, error?}   (unauthenticated /version)
POST   /api/hosts {name, url, method, tailscale_login?} → {host, code}   starts pairing; host.status "pairing"
POST   /api/hosts/{id}/repair          → {code}   pair again (new code)
PATCH  /api/hosts/{id} {name?, url?}
DELETE /api/hosts/{id}                 also DELETE /pair/self on the host when reachable; sessions → Ended
POST   /api/hosts/{id}/retry
POST   /api/hosts/{id}/restart {resume?: bool} → {old_pid, new_pid, started_at?, sessions: [{id, name, kind, agent?}], resumed}
```

For method "tailscale" the url given may be a bare MagicDNS name; the server uses
`https://<name>`. When the host accepts, the server's pairing poll (every 1 s) moves the host
to connecting → online and publishes SSE `hosts`. Removed: `/api/hosts/test`,
`/rotate-token`, the `token` field.

Implementation notes (Hosts v2):
- `GET /api/hosts/tailscale` → `{available, login?, suffix?, peers: [{name, dns_name, os, online, has_host, added}]}`.
  From `tailscale status --json` (the `tailscale` CLI, or the macOS app's binary); without it: `{available:false, peers:[]}`.
  `has_host`: an unauthenticated `GET https://<dns_name>/version` answered as a minbox host (online peers, probed
  concurrently, 1.5 s each). `added`: a host row already uses that name. Sorted: has_host, then online, then name.
- `POST /api/hosts` → 201 `{host, code}`; it probes `/version` first (400 with the reason: not reachable, not a remote
  host, too old/new). `name` may be empty: the first label of the host name is used. `method` defaults to "direct".
- `POST /api/hosts/probe {url, method?}` → 200 `{ok:false, error}` on failure. A url without a scheme is treated as Tailscale.
- Host JSON: `fingerprint` is this server's key fingerprint (what `minbox pair list` shows on the host); the built-in
  host has `method:"builtin"`, `paired:true`. `status:"pairing"` while `pairing_code` is set. A rejected or expired
  pairing leaves the host offline with `error` "the pairing was rejected on the host" / "the pairing code expired; pair again".
- Hosts added with a token before v2 become unpaired: offline, `error: "pair this host again"` (use repair).
- Host protocol 3 (remote hosts need ≥ 3); a remote host's `/version` adds `hostname` and `tailscale`, and reports pid 0.
  Pairing codes are accepted as `482-913` or `482913`. `minbox pair list` prints "no pairing requests are waiting" when empty.
- The server's key: `<data dir>/server-key` (PEM "MINBOX ED25519 SEED", 0600); its name is the machine's hostname.
- `minbox host --tailscale` runs `tailscale serve --bg --https=14849 http://127.0.0.1:<port>` (`--tailscale-port`; 3125 is left to `minbox start`) once listening;
  `MINBOX_SKIP_TAILSCALE_SERVE=1` skips that. The Tailscale-User-Login check applies to every route, `/version` included.

## Browser pairing and `minbox start --tailscale`

`minbox start --tailscale [--tailscale-port 3125] [--tailscale-user-login LOGIN]`: listen on 127.0.0.1 only and
run `tailscale serve` to it (as the host does). Requests that come through tailscale serve
(they carry `Tailscale-User-Login`; their Host is the MagicDNS name) are "remote"; with
`--tailscale-user-login` any other login is refused (403). The guard accepts the server's own
MagicDNS name as Host in this mode.

Trust: every request needs a paired browser's cookie `minbox_device` (HttpOnly, Secure over
https, SameSite=Strict, 12 h, re-issued by signing again), a request straight to loopback
too: any local process (a coding agent with a shell among them) can reach 127.0.0.1, so the
address proves nothing (finding H1; before, loopback was trusted without a device). Without the
cookie only these answer: `GET /` (the app, which shows the pairing screen), static assets, and
`/api/devices/pair*`, `/api/devices/auth*`, `GET /api/devices/me`. `/api/agent/*` stays as it is
(the session's bearer token). "Remote" (below) now only decides the Tailscale-user check.

One pairing model for everything that gets to act on this machine's minbox: the one asking
(a browser here or elsewhere; another machine's server, for the host) shows a 6-digit code and
its key's fingerprint, `minbox pair list` lists it, and the person accepts the code on a paired
browser (Settings › Devices, browsers only) or with `minbox pair accept <code>` in a terminal on
this machine. `minbox pair accept` prints who asks (code, name, key, from where, when) and asks
`Accept it? [y/N]`; it refuses (exit 2) when stdin is not an interactive terminal and there is
no flag to skip that, so a coding agent's shell tool cannot pair a key of its own. A browser's
request may also be named by its fingerprint (`minbox pair accept SHA256:…`).

Cross-site: a request with `Sec-Fetch-Site: cross-site` is refused (403) except a safe top-level
launch: GET/HEAD with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document` to a path outside
`/api/` (the app shell and static files). Android Chrome opens a home-screen app that way. Never
allowed: frames, fetch/XHR, state-changing methods, any `/api/` path. The cookie stays Strict: the
launch request lacks it (the shell is open anyway); the app's own requests are same-origin and carry it.

Browser key: ECDSA P-256 made with WebCrypto, private key non-extractable, kept in IndexedDB.

```
POST /api/devices/pair {public_key /* base64 SPKI */, name /* "Chrome on iPhone" */}
     → {request_id, code: "482-913", fingerprint /* SHA256:… of the SPKI */}
       (the same key asking again while its request waits gets that request back)
GET  /api/devices/pair/{request_id}         → {status: "pending"|"accepted"|"rejected"|"expired"}   (10 min)
POST /api/devices/auth/challenge {fingerprint}  → {challenge /* base64 32 bytes, 60 s */}
POST /api/devices/auth {fingerprint, challenge, signature /* base64 ECDSA P-256 SHA-256, IEEE P1363 */}
     → 200 + Set-Cookie minbox_device; 401 when unknown/revoked/bad
GET  /api/devices/me                        → {trusted: bool, via: "device"|null, device?: Device}
GET  /api/devices                            (trusted) → {devices: Device[], requests: PairRequest[]}
POST /api/devices/requests/{request_id}/accept | /reject   (trusted)
DELETE /api/devices/{id}                    (trusted) revoke: its cookies stop working at once
Device: {id, name, fingerprint, created_at, last_seen, current: bool}
PairRequest: {id, code, name, fingerprint, created_at, ip?, tailscale_login?}
```

SSE `devices` when requests or devices change (trusted clients only). CLI on the server
machine: `minbox pair list` also lists browser requests (`482-913  browser  Chrome on iPhone
ecdsa-p256 SHA256:…`), `minbox pair accept|reject CODE` works for them (server data dir).

### Notes from the implementation (browser pairing)

- Files in the server's data dir: `devices.json` (accepted browsers) and
  `device-pairing/<code>.json` (requests). Package `internal/devices`; server side in
  `internal/server/devices.go` (the guard moved there).
- "Remote" = the request carries `Tailscale-User-Login`, `X-Forwarded-For` or `Forwarded`, or its
  Host is not a loopback address. Nothing is trusted without a device (loopback neither).
  The Origin check compares with `X-Forwarded-Host` when present.
- Open routes for an unpaired browser: every non-`/api/` GET/HEAD (the app and its
  assets), `POST /api/devices/pair`, `GET /api/devices/pair/{id}`, `POST /api/devices/auth/challenge`,
  `POST /api/devices/auth`, `GET /api/devices/me`; `/api/agent/*` keeps its bearer token; the
  sandboxed-frame GETs of `/api/html-assets/` and `/api/embeds/` stay open (no cookie is sent
  from an opaque origin). Anything else: 401 `{"error": "this browser is not paired with this
  minbox", "code": "unpaired"}`.
- Cookie sessions live in memory: after a server restart a paired browser signs a new challenge.
  Revoking (API or CLI) ends the device's cookies and cancels its open SSE/WebSocket requests.
- Limits: 3 waiting requests per client IP, 10 in all (429). Challenges: 60 s, single use.
- Residual risk (same-user processes): the guard keeps a local process without a paired key out
  of the person's API, and minbox never hands agents a credential for it (their env and prompt
  carry only the session's bearer token for `/api/agent/*`). `minbox pair accept` needs an
  interactive terminal (no bypass flag), and every agent's shell tool refuses a command that runs
  it (a mod guard: `pairAcceptPatterns`, internal/server/modtext.go). But a process running as the
  person can read and write the 0700 data dir (devices.json) and could fake a terminal (`script`),
  so this stops accidental or prompt-injected use, not a determined same-user attacker. Loopback
  requests share one client IP: up to 3 waiting requests from 127.0.0.1 (`minbox pair reject` clears them).
- `POST /api/devices/pair` answers 201. `POST /api/devices/auth` answers
  `{ok: true, device: Device}` with the cookie; `Secure` when X-Forwarded-Proto is https (or TLS).
- `GET /api/devices/me` → `{trusted, via: "device"|null, device?}`.
- Accept/reject answer 409 when the request is no longer pending; accept answers
  `{ok: true, device}`. Revoke answers `{ok: true}` (404 for an unknown id).
- SSE `devices` also fires when the CLI changes the files (polled every 2 s).
- `start --tailscale` runs `tailscale serve --bg --https=3125 http://127.0.0.1:<port>` (skip:
  `MINBOX_SKIP_TAILSCALE_SERVE=1`) and takes its MagicDNS name from `tailscale status --json`
  (override: `MINBOX_TAILSCALE_NAME`). A host with `--tailscale` on the same machine serves on
  :14849, so the two do not meet.
- `start --tailscale-service NAME` serves as the Tailscale Service `svc:NAME` instead
  (`tailscale serve --bg --service=svc:NAME --https=3125 ...`), answering to `NAME.<tailnet>.ts.net`;
  the service must be defined (and this machine approved) in the Tailscale admin console.
- With `--tailscale`/`--tailscale-service` and no `--tailscale-user-login`, the login is this
  machine's Tailscale user (`tailscale status --json`; `MINBOX_TAILSCALE_LOGIN` overrides).

## `minbox start` / `stop` / `status`

- `minbox start [flags]` runs the server as a daemon: it starts `minbox start --foreground <flags>
  --no-open --data-dir <abs>` in a session of its own (setsid), output appended to
  `<data-dir>/minbox.log`, waits (20 s) until `server.json` names that pid and the server answers,
  prints the URL and opens the browser (unless `--no-open`). Already running: says so, exit 0.
  A child that exits early: the log's new lines are printed, exit 1.
- `minbox start --foreground [flags]` is the server in the foreground (`minbox serve` is kept as
  its old name).
- `minbox stop` sends SIGTERM to the pid in `server.json` (if it is a live minbox process), waits
  10 s, then SIGKILL. The terminal host and its sessions keep running (`minbox host stop`).
- `minbox restart [flags]` stops the server and starts it again (never opening the browser): with
  the flags given, or, given none but `--data-dir`, with those of the last successful `minbox start`
  (kept in `<data-dir>/start-args.json`).
- `minbox restart --host [--yes|-y]` also stops the local terminal host (as `minbox host stop`)
  between the stop and the start; the new server starts a fresh host and `Reconcile` resumes the
  open sessions. If a host runs it first asks `[y/N]` (default No) with the number of running
  terminals; `--yes`/`-y` skips that, and with stdin not a terminal and no `--yes` it refuses
  (exit 2). Remote hosts are untouched. `--host` and `--yes` are not saved in `start-args.json`.
- `minbox status` prints pid, uptime, URL, data dir, log and whether the terminal host answers;
  exit 3 when the server is not running.
- `minbox` with no command prints the usage.

## Opening pages: `open_url`

- Tool `open_url {url}` → `POST /api/agent/open {url}` (absolute http(s) URL, else 400). With no
  browser on `/api/events`: 409 (Claude gives the URL in its reply instead). Otherwise it publishes
  the event `{"type":"open","session_id","url"}` and answers `{ok, url, browsers}`.
- Each browser: when it is visible and focused it opens the page in a new tab; where that is
  blocked (no click), or in any other browser, a toast "<session>: Claude wants to open <url>"
  with Open (60 s).
- The mod refuses Bash commands that would open a page on the host — `open|xdg-open|gio open|
  sensible-browser|x-www-browser|wslview … http(s)://…` at a command start, `gh browse`, and gh
  with `--web`/`-w` — pointing Claude to `open_url`.

## minbox's system prompt

The inbox (`send_message` every time the person's opinion, decision, approval or action is
needed, and a summary when work is done), session title and `open_url` guidance is one text,
`server.AgentSystemPrompt` (headings `# minbox: inbox`, `# minbox: replying to inbox messages`,
`# minbox: session title`, `# minbox: tasks` and `# minbox: opening pages`), extended by `buildInstructions` with the
orchestration prompt (setting `orchestrator_prompt`) and `prompt_extra`. It reaches Claude two ways:
- in the system prompt: on the server's machine the mod fetches it (`GET /api/agent/instructions`) and
  appends it to the environment section (`prompt.section`), sending a changed text to the running
  conversation (docs/mod-protocol.md); on another machine the server starts Claude with
  `--append-system-prompt` set to it;
- `hello` returns it as `instructions`, and the mod injects it into prompts (first, after a
  compaction, every 20th). The mod has no `prompt.compose` hook and no copy of the text.

The text names the tools `mcp__minbox__send_message`, `mcp__minbox__set_session_title`,
`mcp__minbox__create_task`, `mcp__minbox__update_task`, `mcp__minbox__list_tasks` and
`mcp__minbox__open_url`, which is what the mod's tools are called when registered through
`$.tool.register` (the mod's wake and nudge texts use the registered name, which could differ).

A main-loop turn that ends asking the person something (a question mark, or phrases such as
"Should I", "Let me know", "どうしますか", "確認してください" in its last lines, code and URLs
aside) without calling `send_message` is followed, once Claude is idle, by one plugin turn asking
it to send that to the inbox. That turn never triggers another; the person typing in the terminal
cancels it.

## Guided review: worktrees and committed changes

- `send_message.review` adds `cwd` (where relative file paths resolve, e.g. a git worktree;
  absolute or relative to the session directory; default the session directory) and `base`
  (a branch or commit; default none).
- Each file is diffed in the repository or worktree that holds it (git runs in the file's
  directory, not the session's), so files in a worktree diff against that worktree's HEAD.
- With `base`, the diff starts at `git merge-base <base> HEAD`, so the branch's committed changes
  show as well as uncommitted ones. A base with no common commit: 400 `review file …: base …`.
- The stored review JSON carries `base` when given. Host `/fs/gitdiff` takes `base`.

## Thread title from the agent (`thread_title`)

- `POST /api/agent/messages` takes `thread_title?` (the `send_message` tool's `thread_title`). Given and non-empty, it sets the thread's title (the stored `subject`): the initial title of a new thread, and the new title of an existing one when the call carries `thread_id`. The `send_message` tool requires it on every message (the mod refuses a missing or blank title; about 30 characters is only guidance to the agent), but the server does not, so older mods keep working. Omitted or empty: nothing changes (a new thread still derives its title from the first line of `body`, in full).
- The title is one line (whitespace runs collapse to a space) and is never cut for length (the same goes for the session title from `set_session_title`).
- `subject` is kept as an alias of `thread_title` (when both are sent, `thread_title` wins); the tool documents only `thread_title`. Before, `subject` was ignored with `thread_id`; it now applies there too.
- A changed title is published like any thread change: `thread` and `threads` SSE events. `name` (the tag the person edits in the UI) is a separate field and is never touched; the UI has no manual rename of the title.

## Projects

A project is `(host, dir)` plus a name; sessions (so threads, messages, attachments) are resources under it.
Design: `docs/ui-v2-projects.md`.

```
Project: { id, name, dir, host_id, host_name, created_at, archived_at: string|null, pinned_at: string|null,
           session_count,   // every session of it, archived and ended too
           live_sessions,   // not ended, not archived
           last_activity }  // newest session or thread update
GET    /api/projects                  → Project[]  live ones, pinned first, then last_activity desc
                                        ?archived=1 includes archived projects
POST   /api/projects                  {dir, host_id?, name?} → 201 Project
                                        dir is resolved on the host (~ ok) and must be a folder there (400);
                                        name defaults to the last folder; names are unique, case-insensitive (400);
                                        a live project for (host, dir) exists → 409; an archived one is brought back
PATCH  /api/projects/{id}             {name?, pinned?, dir?, host_id?, default_agent?} → Project
                                        dir is resolved/checked as in POST (400; another live project has it -> 409) and may change at any
                                        time. New sessions (POST /api/sessions with project_id) start in the new dir. Existing Claude Code
                                        sessions whose cwd is the old dir get `relocate_to` = new dir (Session field, omitted when empty);
                                        their cwd is NOT changed yet and a running session is not touched. At its next start (restart,
                                        resume of an ended session, server-restart reconcile) the session runs in the new dir: because
                                        `claude --resume` finds a conversation by its folder, a session whose old conversation has a
                                        transcript starts a FRESH conversation (new claude_session_id, `--session-id`, no `--resume`) and
                                        records `prev_dir` + `prev_claude_session_id`; the instructions text (argv --append-system-prompt and
                                        the hello `instructions`) then ends with a section naming the old dir, the old id and the transcript
                                        path ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<id>.jsonl. Without an old transcript only
                                        the cwd moves. It happens once (relocate_to is cleared; later resumes are normal in the new dir). If
                                        the new dir is gone at that time the session starts in its old dir, the move still pending. Sessions
                                        with a cwd of their own (not the old dir) and the threads/messages are untouched. The old folder is
                                        not touched on disk.
                                        host_id changes only while the project has no sessions (else 409)
PUT    /api/projects/{id}/icon        sets the icon → Project (SSE projects). Body: JSON {emoji} (1-3 grapheme-ish characters,
                                        at most 16 bytes, no control chars, no letters/URLs; 400 otherwise), or an image: raw body
                                        (Content-Type image/*) or multipart field `file`; PNG, JPEG or GIF, at most 2 MB. The server
                                        center-crops to a square, scales to 128x128 and stores a PNG. Garbage/oversize → 400, unknown project 404.
DELETE /api/projects/{id}/icon        clears the icon → Project
GET    /api/projects/{id}/icon        the image icon as image/png, `Cache-Control: private, max-age=31536000, immutable`
                                        (the URL carries ?v=); 404 when the icon is not an image
                                        Project.icon: null | {kind:"emoji", emoji} | {kind:"image", url:"/api/projects/{id}/icon?v=<unix s>"}
                                        (image bytes are never in the project list; stored in additive columns icon_kind,
                                        icon_emoji, icon_png, icon_updated_at of `projects`, so a project delete removes them)
GET    /api/projects/{id}/delete-preview → {sessions, running_sessions, threads, messages}: what a delete takes with it (404 unknown)
DELETE /api/projects/{id}             deletes the project with ALL its sessions (running ones are stopped first: claude process,
                                      terminal pane, companion shell), threads, messages, annotations, attachments and notification
                                      thread mappings in one store transaction (their topics go with the threads).
                                      The main-session 409 does not apply. Nothing on the host disk (the folder) is touched.
                                      SSE projects + sessions + threads.
POST   /api/projects/{id}/archive     409 while it has a live session; archives its ended sessions with it
POST   /api/projects/{id}/unarchive   restores the sessions that were archived with it
```

- `Session.project_id` and `Thread.project_id` / `Thread.project_name` (thread rows join through the session). `project_id` is
  `''` only for a row the migration has not seen, which cannot happen after startup.
- `POST /api/sessions` no longer creates shell sessions: `kind: "shell"` is answered with 400 (`shell sessions can no longer be
  created; use the companion shell`), and the UI offers no Shell choice. Shell-kind sessions already in a database keep
  working (list, terminal, restart, archive, delete). `kind` is `claude` (default) only.
- `POST /api/sessions` takes `project_id?`. With it the session belongs to that project, starts on its host
  (`host_id`, if sent, must match, else 400) and in its `dir`; a `cwd` is still accepted and is kept on the session as a
  sub-folder override. Without it (old clients, the `minbox` CLI) the project is the one for `(host_id, resolved cwd)`,
  created on first use and named after the last folder (a name in use gets the host's name, then a number).
  Unknown project: 400. A session created in an archived project unarchives it; so does unarchiving or restarting a session.
- SSE `projects` fires when a project is created, renamed, moved, pinned, archived or deleted, and when a session
  creation made a project. Archive/unarchive also fire `sessions` and `threads`.
- Migration of existing data (startup, in `store.Open`): see "Migration notes" in `docs/ui-v2-projects.md`. The change is
  additive (table `projects`, nullable column `sessions.project_id`).

### Choosing the agent for new work (no main session)

Projects have no main session (removed 2026-11-19: `Session.is_main`, `Project.main_session_id`, `POST /api/sessions
{main}`, `PATCH /api/projects/{id} {main_session_id}` and `?promote=` are gone; the `projects.main_session_id` column
stays in the database, unread and unwritten). Any session archives (once ended) and deletes without conditions.

New work in a project with no agent named goes to an agent chosen by `pickAgent` (`internal/server/agentpick.go`):
a Slack DM (`slack_app` receiving), `POST /api/v3/new` with `project_id` and no `to`, and a thread started from a Linear
issue or a Slack thread with `target: {kind: "auto", project_id}`.

- Candidates: the project's **live agents** (Claude-kind sessions, not archived, not ended), most recently active
  first, at most 12. None: a new agent starts, no model call.
- The helper (the project pick's: `Config.PickModel`, Claude Haiku by default, or Pi / OpenCode as for reply
  suggestions; empty temp dir, prompt on stdin, 20 s timeout) gets each agent's id, name, title, status, last activity
  and up to 4 recent tasks (title — summary, "(done)"), and the work (the DM, the composer's words, or the subject,
  request and handoff of the issue / Slack thread; cut to 2000 characters) between `<agents>` / `<work>` delimiters as
  untrusted data. Schema: `{"agent": "<id>" | "new" | null}`.
- `"new"`: a new agent starts in the project (as `POST /api/v3/new {to: "new"}`: the project's default agent kind).
  A listed id: that agent. `null`, an id that is not a candidate, an error, no helper installed or a timeout: the
  **fallback**, the most recently active live agent.
- The issue / Slack thread preview with `auto` warns "minbox picks the agent when you start: …"; a chosen existing
  session that is working warns that its one conversation takes the new thread after its current work.

## Thread status

Every thread has a stored `status` (thread JSON `status`; also `top_thread.status` on sessions): `working`, `need_action`, `blocked` (waiting on something outside the person: CI, another session, a server; alias `stuck`, `on_hold`) or `finished`. Column `threads.status TEXT`.

Set by:

1. The person's message (reply, answers, new thread, forwarded reply) -> `working`. A note (`kind: note`: re-ask, thumbs up) does not count.
2. An agent message (`POST /api/agent/messages`): `finished`, except that a message with questions (`:::question` blocks) sets `need_action`. `send_message` carries `task_status` (required, `working | needs_you | blocked | done`; `status` is its older name): it is set on the message's task as `update_task`'s status sets it; a call without it is refused with 400 and nothing is stored (`send_message needs task_status: ...`). A message in no task is stored and its `task_status` is not applied (the `note` says so).
3. By hand: `POST /api/threads/{id}/status {status}` (aliases accepted; 400 on unknown). The thread view's More menu has "Mark as ...".

Migration (idempotent, only rows with a NULL status): a thread with an open question or action -> `need_action`, otherwise `finished`. Archived/snoozed state is independent.

`need_action` is the single source of the "Waiting" notion: the sections `stopped`, `holding` and `waiting` apply only to a thread whose status is `need_action` (stopped/holding when it also has open questions with `Stopped:` / `Holds up:`), so the session `waiting` count, the Waiting filter, the amber badges, the project rail aggregates and the palette pill all follow the status. `open_questions` stays about questions (the `?n` chip, decision mode). Follow-up agent messages do not clear `need_action`; the person's message (or the person, by hand) does that.

Changes are published like other thread changes (`thread`, `threads`, `sessions` SSE events). The threads pane groups by status in the order `need_action`, `working`, `blocked`, `finished`.


## Notifications (Slack incoming webhook, Slack app)

Every message the AGENT stores in a thread (`POST /api/agent/messages`, new thread or not) is sent to the enabled
notification destinations. The person's own replies and system changes are never sent. Code: `internal/notify`
(types, Slack format, dispatcher with retries), `internal/server/notifications.go` (API), `internal/store/notifications.go`.

### Store

Table `notification_destinations(id, type, name, enabled, config JSON, created_at, last_ok_at, last_error, last_error_at)`
(additive; `CREATE TABLE IF NOT EXISTS`). `config` holds the type's fields including secrets. Global setting
`public_url` (in `/api/settings`, default `""`; must be empty or an http(s) URL, else 400) is the address minbox is reached
at from outside, e.g. the Tailscale URL.

### API

- `GET /api/notifications` -> `{types, destinations}`. `types`: `[{id, label, fields:[{key, label, kind: text|secret|bool|select,
  required?, default?, placeholder?, hint?, options?:[{value,label}]}]}]` (the UI builds its form from it; adding a type adds no UI
  code). `destinations`: `[{id, type, name, enabled, config, created_at, last_ok_at, last_error, last_error_at}]`.
- `POST /api/notifications` `{type, name?, enabled?=true, config}` -> 201 destination. Unknown type or invalid config: 400.
- `PATCH /api/notifications/{id}` `{name?, enabled?, config?}` -> destination. `config` is merged onto the stored one.
- `DELETE /api/notifications/{id}`; 404 for an unknown id (also for PATCH and test).
- `POST /api/notifications/{id}/test` sends a sample once (no retries; works while disabled) and answers 200
  `{ok: true}` or `{ok: false, error}`; the result is recorded like any send.
- `POST /api/notifications/{id}/check` ("Check receiving now") makes the destination's receive worker run ONE poll cycle now
  (the normal cycle: allowlist, 20 calls/min budget, de-duplication; the cursor and seen set are shared) and answers 200
  `{ran, busy, summary, status}`: `ran` false with the pause text in `summary` and NO Slack call while Slack's `Retry-After`
  pause is on; `busy` true when a cycle is already running or queued (nothing started); `summary` one line, e.g. `fetched 200
  messages, 0 new`, `fetched 3 messages, delivered 1 reply`, `Error: The app lacks the im:history scope…`, `Nothing to poll
  yet: the DM with the bot is not known. Press Send test first`. `status` is the `receive_status` below. 404 unknown id, 400
  when the destination does not receive (not a Slack app / `receive` off), 409 when it has no running worker (destination off,
  or the worker has not started yet: workers are reconciled every 10 s). Same guard as every `/api` route (Host, cross-site
  Origin, Tailscale login, paired device).
- SSE `notifications` fires when a destination changes or a send's result was recorded.

`receive_status` (in each destination of `GET`/`POST`/`PATCH`, only for a `slack_app` whose `receive` is on): `{receiving
(a worker runs), last_poll_at|null, last_poll_ok|null, last_poll_error (same text as last_error), summary (latest cycle),
next_poll_at|null, paused_until|null (Retry-After), interval_seconds (effective wait; longer than configured_seconds when
`slowed`: idle x3 up to 5 min, or backing off), configured_seconds, slowed, dm_known (the D… channel is learned from the first
notification or Send test), delivered (since receive was switched on; persisted), last_delivered_at|null, watched_threads
(notified parents in the last history page), problems[] (config: Channel not a user ID, allowed users empty/invalid, no
project route; scopes: missing im:history / reactions:write), missing_scopes[]}`. The poll state is in the worker's memory:
it restarts with the server or when the destination is re-created or its config changes; `delivered`, `last_delivered_at`
and `dm_known` come from the store.

### Slack config

`{webhook_url (secret, required, http(s)), include_body (default true: the full message; false: title only), events}` with
`events` = `all` (every agent message, default) or `action` (only messages with open questions, i.e. `:::question` blocks).
Another type declares its own fields; `events` is read for every type.

### Slack app config (`slack_app`)

`{bot_token (secret, required, no spaces), channel (required: ID like C0123ABCD, name like #alerts, or a user ID U…/W… for a DM with the bot, no spaces), include_body
(default true), thread_replies (default true), mention_me (bool, default true), send_artifacts (bool, default true), events}`. The type also publishes `help` (setup steps, one per line: create the
app at api.slack.com/apps, Bot Token Scopes `chat:write`, `im:history`, `files:write`, `files:read`, optional `reactions:write` (not needed:
`chat:write.public`, `im:write`, `channels:*`), App Home Messages tab on, install/reinstall, copy the Bot User OAuth Token,
Channel = your member ID and Send test first; `/invite @app` for a channel), which the form shows under the type picker. Delivery: HTTPS `POST <base>/chat.postMessage`
with `Authorization: Bearer <token>` and JSON `{channel, text, blocks, unfurl_links:false, unfurl_media:false[, thread_ts,
reply_broadcast:false]}`; `blocks` are those of the webhook type. `<base>` is `https://slack.com/api`; the env
`MINBOX_SLACK_API_BASE` overrides it for tests only (an `http://` URL on a loopback host; anything else is ignored so the token
cannot be redirected).

**Artifacts** (`send_artifacts`, default on; `Notification.Files`). `POST /api/agent/send` collects the message's file attachments
(`kind` file, so not reviews) and the inline images of its body as `notify.File{Name, Path (the server's blob), Mime, Size}`. After
the message is posted, `internal/notify/slackfiles.go` uploads them with Slack's external flow, with the bot token: form
`files.getUploadURLExternal(filename, length)` -> `{upload_url, file_id}`; a raw `POST` of the bytes to `upload_url` (no
`Authorization`, no redirects, host must be slack.com or the API base); one JSON `files.completeUploadExternal({files:[{id,title}],
channel_id, thread_ts})` with the Slack thread of the minbox thread (parent post created by this very message when it is the first;
top level when `thread_replies` is off). At most 10 files per message, files above 20 MB (and empty ones) skipped with a log line.
Scope `files:write`; `missing_scope` is reported as "Message sent, but its files were not: the app lacks the files:write scope ...".
An upload failure is not retried (that would repeat the message). `events: action` applies to the files too (they follow their
message). Test notifications carry no files.

**DM.** A user ID as `channel` makes Slack deliver to the bot's DM with that user (scope `chat:write` only, no invite; the app's
App Home Messages tab must be enabled). Slack answers with the real `D…` channel; that is what is stored, so thread replies go
to the `D…` channel. Extra error codes: `user_not_found`, `cannot_dm_bot`, `messages_tab_disabled` (final, actionable text).

**Mention.** With `mention_me` on and a known ID, the PARENT post of a Slack thread (a task's parent, the first notification
of a minbox thread about no task, and the "Send test" sample) starts with `<@U…>`: the `channel` when it is a user ID, else the first valid ID of `allowed_users`,
else no mention. It is put at the start of both `text` (the push-notification fallback) and the first block's text. Replies in
the thread (`thread_ts` set) never mention. With `thread_replies` off there are no threads, so nothing is mentioned (except the
test sample).

**Grouping.** Table `notification_slack_threads(destination_id, minbox_thread_id, task_id DEFAULT '', channel_id, ts,
created_at, last_notified_at, reply_cursor, PRIMARY KEY(destination_id, minbox_thread_id, task_id))`, plus a unique index on
`(destination_id, task_id) WHERE task_id != ''` (one Slack thread per task and destination; the table was rebuilt once to add
`task_id`, older rows have `task_id ''`).

- *A message about a task* (v3: the task it is tagged with when the agent sends it) goes to the task's Slack thread. The first
  one posts a top-level parent that names the task, not the message: `:clipboard: *<task title>*`, a context line
  `<project> / <agent> · <status>`, and an "Open task" button (`<public_url>/#v=task&k=<task id>`) when a public URL is set
  (the mention goes on the parent). The `ts` and channel ID Slack returns are stored with the task id and the agent's stream
  thread id; the message itself is then posted as the first reply (its files are uploaded to the thread). Later messages about
  the task, from any agent, are replies in that thread; each one moves `minbox_thread_id` to the stream of the agent that wrote
  it, so the person's replies go to the agent that wrote last. The message's own "Open thread" button opens the task at the
  message (`#v=task&k=<task>&m=<message>`).
- *A task renamed or its status changed* (any `UpdateTask`): the parent is edited with `chat.update` (same layout;
  `:white_check_mark:` and "done" once done). Nothing happens for a task this destination never started a thread for;
  `message_not_found` / `cant_update_message` are ignored.
- *A message about no task* (and threads started from a DM to the bot) keeps the thread of its minbox thread, as before: the
  first notification of a minbox thread is the parent, later ones are replies.

`thread_not_found` / `message_not_found` on a reply (parent deleted in Slack): a new parent is posted and the stored `ts`
replaced. With `thread_replies` off everything is top-level. Sends of one (destination, minbox thread) and of one (destination,
task) are serialized, so two simultaneous notifications never both become parents. Rows go when the destination, the minbox
thread or the task is deleted, and when a PATCH changes the channel or token.

**Errors** (Slack answers 200 `{ok:false, error}`): shown in `last_error` as actionable text, e.g. `not_in_channel` -> "The bot is
not in that channel: invite it with /invite @<app name>…", `invalid_auth`/`token_revoked` -> "The token is invalid…",
`missing_scope` -> "The app lacks the chat:write scope…", `channel_not_found`, `is_archived`, `account_inactive`, `msg_too_long`
(unknown codes: `Slack error: <code>`). Retried (as in Delivery): network errors, HTTP 5xx, HTTP 429 (with `Retry-After`) and the
codes `ratelimited`, `internal_error`, `service_unavailable`, `fatal_error`, `request_timeout`; all other codes are final.

**Test** (`POST .../test`): `auth.test` first (a bad token fails here), then the sample is posted at the top level (never stored
as a thread parent); the answer is `{ok: true, message: "Connected to <team> as <bot>"}`.

The token is shown masked as `xoxb-…` + last 4 characters, never in full, never logged, and never in an error text.

### Receiving messages from Slack (`slack_app`, opt-in, polling)

Extra config fields: `receive` (bool, default **false**; nothing is polled unless true; requires `channel` to be a user ID, i.e. a
DM, else 400), `allowed_users` (comma separated member IDs `U…`/`W…`; empty defaults to the `channel` user; only these members'
messages are taken), `default_project` (a project NAME; a DM starts a new thread with the agent the helper picks there, see "Choosing the agent for new work"; empty: DMs are ignored, one
log line; relabelled "Fallback project (when Claude cannot tell)"), `pick_project` (bool, default **true**; only matters when
`receive` is on), `poll_interval` (select `30|60|120|300` seconds, default 60). Transport is polling of the Web API with the bot token
(no Socket Mode, no public URL). Code: `internal/notify/slackinbound.go` (poller), `internal/server/slackinbound.go` (turns a
message into the person's message: `AddMessage` as `POST /api/threads/{id}/reply` does; `CreateThread` as `POST
/api/sessions/{id}/threads` does; messages are stored as the person's own words, no source marker; a reply in a task's Slack
thread goes to the stream of the agent that wrote there last and is tagged with the task, as a reply sent from the task's view
with `task_id` is), started by `main.go`
(`RunSlackInbound`), stopped with the server.

- **Watching**: each cycle makes ONE `conversations.history(<D… channel>, limit=200)` call: the latest 200 top-level messages
  of the DM (no time horizon, no paging; replies in threads older than those 200 messages are not seen). Every notification
  parent in it carries `latest_reply`; `conversations.replies(channel, ts=<parent>, oldest=<cursor>)` is called only for a parent
  whose `latest_reply` is newer than the stored reply cursor (at most 8 per cycle), so the steady state is one call per cycle
  however many threads exist. Replies older than the moment receiving was enabled are never delivered. A top-level message newer
  than the DM cursor starts a new thread. **Project of a new thread**, in order: (1) an explicit `#<project> text` prefix naming
  a project (no model call; if no project has that name the whole text is the message and goes on to 2); (2) when `pick_project`
  is on: Claude Haiku (`Inbound.PickProject`, `internal/server/slackpick.go`); (3) Haiku unsure (`null`) and at least one project
  to offer (`Inbound.ProjectNames`): **no thread is created and `default_project` is not used**; minbox posts in the Slack thread
  of the DM "Which project is this for? ... Projects: `a`, `b`" and stores a pending state; (4) `default_project` (pick off, rate
  cap, model error, no project to ask about, or the question cap below); (5) none: the DM is ignored with one log line.
  **Pending state** (additive table `notification_slack_pending(destination_id, channel_id, thread_ts, rounds, reply_cursor,
  payload, updated_at)`, payload = JSON `{orig, answers[], files[]}` with the held message and its downloaded images; dropped after 24 h
  without answer or when the destination is deleted). Pending parents are found in the same `conversations.history` call
  (via `latest_reply`) and their replies read with `conversations.replies` under the same budget (the question's own ts is the
  initial cursor). An answer from an allowed member (same dedupe/allowlist/👀 as any message; its files are added) goes to Haiku
  with "Message: <orig>" and each answer; identified -> `NewThread` with the ORIGINAL text and all held files, `notification_slack_threads`
  is set to this Slack thread (so later replies in it are delivered to the minbox thread and the agent's notifications reply
  there), a short "Started a thread" post, pending removed. Unsure again -> ask again ("I still could not tell ..."), at most 3
  questions; after the third unanswered-by-Haiku answer: `default_project` if set (with a note in Slack), else a post saying the
  message was dropped. A model error during a pending round uses the `default_project` rule too. Calls count against the 10/min pick cap. The allowed-member check happens before any of this, so a non-allowed sender never reaches the model and
  no project name is exposed. The model call: the same mechanism as reply suggestions (`claude -p --output-format json
  --json-schema`, no tools, no settings, empty temp dir, prompt on stdin; `Config.SuggestCommand`/first word of the Claude
  command), with `--model` = `Config.PickModel` (env `MINBOX_PICK_MODEL`, default `claude-haiku-5-5`). One call per new DM, 20 s
  timeout, the text cut to 2000 characters, at most 10 calls per minute per destination (over the cap: fallback). The prompt holds
  the text in `<message>` tags and up to 40 projects (archived projects and the catch-all "No project" left out) as `id`,
  name and the titles of their 3 most recently changed tasks, with the instruction that both are untrusted data. The answer must be
  `{"project_id": "<id>"|null}`; it is only ever compared with the listed project ids (anything else, `null`, an error or a
  timeout means "unsure" and falls back); it is never executed or shown. Logs name the outcome (prefix, Claude, fallback and why),
  never the message text. `NewThread` accepts a project id as well as a name. The D… channel is learned from
  the first notification/test sent. Skipped: `bot_id`, any `subtype` (edits, deletes, joins), non-allowed members (log line
  without the text), empty text. **Files**: a message may carry `files[]` (subtype `file_share` is accepted; other subtypes
  still are not). From allowed members only, each file (at most 5 per message, 20 MB, mimetype `image/*` except SVG, `text/*`,
  `application/json`, `application/pdf`) is downloaded with `GET <url_private_download>` and `Authorization: Bearer <token>`: the URL
  host must be slack.com (or the API base), redirects are not followed to another host (so the token never leaves), a 200 HTML page
  (Slack's answer without `files:read`) or 401/403/404 is "not taken (add files:read)", 5xx/429/network errors are retried next cycle
  (the message is unmarked). Taken files are stored like a web UI upload (`Inbound.DeliverReply/NewThread(..., files []InFile)`:
  blob + `store.Upload`, then `attachUploads`: a read-only copy on the session's host and an attachment with `author: user`), so the
  agent reads them from the same paths as web uploads. Skipped files add a bracketed note to the message text; a message of only
  skipped files and no text is ignored. A file-only message gets the first file name as its thread subject. Text: Slack `<url|label>` becomes `label`, `&lt;&gt;&amp;` decoded, capped at 4000 characters
  (a note is appended). Delivered messages get a 👀 (`reactions.add eyes`); `missing_scope` /
  `already_reacted` never fail the delivery (one log line).
- **State** (additive): columns `notification_slack_threads.last_notified_at`, `.reply_cursor`; tables
  `notification_slack_state(destination_id, key, value)` (`since`, `dm_channel`, `dm_cursor`, `last_inbound`) and
  `notification_slack_seen(destination_id, channel_id, ts, at)` (PK; a message is taken with INSERT OR IGNORE before delivery and
  released if delivery fails, so it is delivered at most once; pruned after 7 days). On first enable `since` = now: no history is
  imported. A PATCH that changes `receive`, `channel` or `bot_token` resets this state.
- **Rate limits**: at most 20 API calls/minute per destination (all methods, the 👀 included; sliding window), a 429 pauses the
  whole poller for exactly `Retry-After`, other errors back off exponentially with jitter (cap 5 minutes), success resets. With
  nothing notified and nothing received in 24h the interval is multiplied by 3 (cap 5 minutes). Slack gives apps distributed in
  the Marketplace (and non-Marketplace apps created after 2025-05-29 that are commercially distributed) only 1 request/minute on
  `conversations.history` / `.replies`; an internal customer-built app has Tier 3 (about 50/minute). minbox backs off by
  Retry-After either way, which is slow but safe.
- **Errors**: a polling failure is shown in `last_error` prefixed "Receiving from Slack:", e.g. `missing_scope` -> "The app lacks the
  im:history scope: add it under OAuth & Permissions … and reinstall the app"; the next successful poll clears it.
- **Scopes**: `im:history` (DM history and replies), `reactions:write` (optional 👀), plus `chat:write`. v1 is DM only; private
  channels (`groups:history`) and public channels (`channels:history`) are not supported.

### Secrecy

The webhook URL is never returned in full, by the API or the UI: a `secret` field comes back as scheme + host + `/…` + its last
4 characters (`https://hooks.slack.com/…aB3d`). In `PATCH`, a secret that is missing, empty or equal to its masked form keeps
the stored value; anything else replaces it. It is never logged, and error texts (stored in `last_error`, returned by test)
have the request URL stripped.

### Delivery

Asynchronous: the request that stored the message does not wait. Per destination: 1 attempt, then up to 3 retries after
1 s, 5 s, 20 s (so 4 attempts) for network errors, 5xx and 429; a `Retry-After` (seconds, capped at 60) replaces the wait.
Other 4xx: no retry. One notification per message (no merging or debounce). The result is stored per destination:
success sets `last_ok_at` and clears `last_error`; failure sets `last_error` and `last_error_at`. Not persistent: a restart
drops sends still waiting for a retry.

### Slack format

JSON `{text, blocks}`. `text` (what push notifications show): `<project> / <session>: <title>` and the first 280 characters of the
body, plain. `blocks`: a section `*<project> / <session>*: <title>`; the body converted to mrkdwn (below) in consecutive
section blocks of at most 2,900 characters, split at line ends (a code fence cut by a split is closed and reopened), at most 50
blocks in all, a longer body ends with `…` (and "open the thread" when there is a link); a context line `Claude · needs your answer`
(+ the thread status when it has one); an actions block with an `Open thread` button to `<public_url>/#s=<session>&t=<thread>`
when `public_url` is set. `&`, `<`, `>` are escaped (`&amp;` `&lt;` `&gt;`). Conversion: `**x**`/`__x__` -> `*x*`, `*x*` -> `_x_`,
`~~x~~` -> `~x~`, `[t](u)` -> `<u|t>`, headings -> bold lines, `-`/`*` lists -> `•`, rules -> a line, tables -> a code block, code
and fences kept. With `include_body` off only the header, context and button are sent.


## Coding agents (Claude Code, Pi and OpenCode)

See docs/agents.md for the model. API surface:

- `GET /api/agents` -> `{agents: [{kind: "claude"|"pi"|"opencode", label, installed, command, path, caps: {subagents, preassigned_id, remote_hosts, completions, movable_conversation?}, version?, supported, reason?}], default: "claude"|"pi"|"opencode"}`.
  `installed` is whether the first word of the configured command (`--claude`, `--pi`, `--opencode`) is on the server's `PATH`; Claude Code and
  Pi are not run. For OpenCode `opencode --version` is read (cached per executable): `version`, and `supported: false` with a `reason` for 1.x.
  `default` is the effective agent of a new session with nothing else said (setting `default_agent` if usable, else Claude Code, Pi, OpenCode,
  the first usable, else `claude`). `GET /api/about` adds `pi_command`, `opencode_command` and the same `agents` list.
- `GET /api/agents?host_id=<remote host>[&fresh=1]` -> the same shape for that host's machine, plus `host_id` (and `error` with
  `agents: []` when the host cannot be asked): the host looks up the commands on its own `PATH` (`POST /lookpath`); Pi is
  `supported` when `node --version` there is 22.19+ (`version: "node 22.19.0"`; Pi itself is not run), OpenCode when
  `opencode --version` there is 2.x. Cached per host for a minute and probed again when the host (re)connects; `fresh=1`
  probes now. A host before protocol 5 lists Claude Code as installed (its PATH decides at the start, as before) and Pi and
  OpenCode as not installed with `reason` "the minbox on this host is too old to run …: update minbox there".
  `default` is the `default_agent` setting if that host can run it, else the first agent it can run.
- Host JSON (`GET /api/hosts`) adds `agents`: that list as last found (`null` before the first look; the built-in host's is
  this machine's).
- `Session.agent` (`"claude"` | `"pi"` | `"opencode"`; existing rows `claude`). `Session.kind` stays `claude` (has the inbox) | `shell`. `claude_session_id`,
  `prev_claude_session_id` and `prev_chain[].claude_session_id` hold the agent's conversation id for either agent.
- `POST /api/sessions` takes `agent?: "claude"|"pi"|"opencode"`. Omitted: the project's `default_agent`, else the `default_agent` setting, else the
  installed agent (on a remote host: one that host can run). 400: unknown agent; Pi not installed (`Pi is not installed (looked for "pi" on PATH)`);
  the same for OpenCode, plus an unsupported OpenCode (`OpenCode cannot be used: OpenCode 1.0.150 is OpenCode 1.x; …`). On a remote host the
  message names the host: `Pi is not installed on host devbox (looked for "pi" on its PATH)`, `Pi cannot be used on host devbox: Node.js
  20.11.1 is too old: Pi needs Node 22.19 or later`, `OpenCode cannot be used on host devbox: …`, or (a host older than protocol 5)
  `… the minbox on this host is too old to run Pi …`. Claude Code that is not installed fails when the terminal host starts it, as before.
  The fork, Slack and Linear starts check the same way (`resolveAgent`).
- `Project.default_agent` (`""` | `"claude"` | `"pi"` | `"opencode"`); `PATCH /api/projects/{id}` takes `default_agent` (400 for another value).
- `POST /api/agent/hello` (the integration's first call) takes, besides the old `claude_session_id`, `agent_session_id` (the agent's current
  conversation id; either key moves the session's stored id, which is how `/clear` in Claude Code and `/new` in Pi are followed), `agent`
  (`"claude"|"pi"|"opencode"`, informational), `session_file` and `ext_version` (logged). It answers with an `agent` field (the session's agent) next to
  `session_id`, `name`, `instructions`, `prompt_extra`, `orchestrator`. `instructions` uses the agent's tool names (`mcp__minbox__*` for
  Claude Code, `minbox_*` for Pi) and `orchestrator` is `""` for an agent without subagents (Pi). For Pi, `instructions` ends with a short `# minbox: subagents` section about `minbox_subagent` (docs/agents.md, "Pi subagents").
- The text "Asked <agent label> to ask the N open questions again." uses the session's agent.
- Pi's folder-change note (the `instructions` of a session that moved) names the old Pi session file under
  `<agent dir>/sessions/--<path>--/<timestamp>_<id>.jsonl`; Claude's names `~/.claude/projects/…`.
- Environment of both agents' processes: `MINBOX_SESSION_ID`, `MINBOX_TOKEN`, `MINBOX_SERVER_FILE`. Settings: `MINBOX_PI` (command),
  `MINBOX_PI_HELPER_MODEL` (Pi's model for helper runs; default Pi's own).

## Linear integration

Design, limits and privacy: [linear.md](linear.md).

- Setting `linear` (in `GET/PUT /api/settings`): `{author_filter: "everyone"|"allow_list", allowed_authors: string, include_body: bool, thread_link: bool, draft_extra_prompt: string}`
  (defaults `everyone`, `""`, `false`, `false`, `""`; `draft_extra_prompt` is the user's extra instructions for the Create-issue auto-fill, at most 4000 characters, control characters stripped, not a secret; 400 on an unknown key or value). There is no workspace setting.
- `GET /api/integrations/linear` -> `{mcp_url, connected, needs_login, user?: {id,name,email}, connected_at?, last_error?, redirect_uri, rate_limited_for?}`.
  Never any token.
- `POST /api/integrations/linear/login` -> `{url, redirect_uri}`: discovers the authorization server, registers a client for the redirect URI
  (`<scheme>://<request host>/api/integrations/linear/callback`) once, stores a single-use state (10 min) and returns Linear's authorize URL.
  502 with the reason when discovery or registration fails.
- `GET /api/integrations/linear/callback?code&state` (Linear's redirect; the one cross-site `/api/` navigation the guard allows, without the device
  cookie; authorised by the state, which must have been made for the same Host). Answers an HTML page and, on success, sends the browser to Settings.
- `POST /api/integrations/linear/disconnect` -> status. `POST /api/integrations/linear/test` -> `{ok, user?, tools?: [name]}` or `{ok: false, error}`.
- `GET /api/threads/{id}/linear` -> `{link: ThreadLink|null}`; `PUT` `{issue: "ENG-123"|URL, include_body?: bool}` resolves the issue with `get_issue` and links
  (400 not an issue reference; 409 `code: "linear_login"` not connected / login expired; 429 `linear_rate_limited`; 502 Linear's error);
  `DELETE` unlinks (and deletes the recorded events). `POST /api/threads/{id}/linear/refresh[?force=1]` -> 202 `{started: true}` when a background sync
  started, 200 `{started: false, skipped}` when one is running or ran within 45 s. SSE: `thread` events while it runs and when it ends, `linear` when the login changes.
- `ThreadLink`: `{thread_id, issue_id, identifier, url, title, state, state_type, assignee, last_synced_at, last_error, last_error_at, include_body, has_progress_comment, syncing, created_at}`.
- Create from a thread. `POST /api/threads/{id}/linear/draft` body `{stage?: "meta"|"llm"}` (default both). Stage `meta` ->
  `{meta: {user?, teams: [{id,name,key,states:[{id,name,type}],labels:[{id,name,color?}],default_state_id,started_state_id}], projects: [{id,name,team_ids?}], warnings?},
  fallback: Draft, link_in_description: bool}` (Linear's lists and the basic prefill; reads Linear only). Stage `llm` -> `{draft: Draft, source: "llm"}` (every id checked
  against the lists, unknown ones dropped; helper run via the agent-aware helper, limited and cached per thread and last message) or
  `{reason: "no_agent"|"error", note}` with no draft (still 200). `Draft` = `{team_id, title, description, priority 0-4 (0 none, 1 urgent, 2 high, 3 medium, 4 low), label_ids, project_id, assignee_id, state_id}`.
  Errors as the link endpoint (409 `linear_login`, 429 `linear_rate_limited`, 502 with Linear's message). Thread content goes only to the helper agent; the prompt is delimited,
  size-capped and stripped of credential-shaped strings.
- `POST /api/threads/{id}/linear/create` body `Draft` + `{submission_id?}` -> the `ThreadLink` (the thread is linked as by `PUT`). Requires `team_id` and `title` (400); ids must be in Linear's lists
  (400 `unknown_team|state|label|project|assignee`); title <= 256, description <= 50000; 409 `already_linked`; 422 `linear_refused` (Linear's tool error, text in `error`); 502 `unreadable_result`
  (Linear answered, the issue could not be read: it may exist). Idempotent per `submission_id` (kept 10 min; a failure is not kept): repeats get the first answer. Setting `linear.thread_link`
  (default false) appends a link to the minbox thread to drafted descriptions (needs `public_url`).
- `GET /api/threads/{id}` adds `linear?: ThreadLink` and `linear_events?: [{id, kind: "comment"|"state"|"title"|"assignee", author, body, url, filtered, delivered, created_at}]`.
- Delivery: `GET /api/agent/pending` prepends a `<linear_updates source="untrusted" ...>` block to the `body` of the first pending message of a linked thread
  (updates not yet delivered; tied to that message; marked delivered by `.../delivered`). `MINBOX_LINEAR_MCP_URL` (loopback http only) points the server at a fake.

My issues (design: [linear.md](linear.md#my-issues)). All need the Linear login: 409 `code: "linear_login"` when not connected / expired, 429 `linear_rate_limited`, 502 with
Linear's message. `IssueView` = `{id, identifier, title, url, state, state_type: backlog|unstarted|started|completed|canceled|triage, priority: 0..4, priority_name, team_id,
team_key, team_name, project, labels: [name], assignee, estimate?, due_date?, created_at, updated_at, description? (detail only), threads: [{thread_id, session_id, subject, status,
project_id, updated_at}]}`.
- `GET /api/linear/issues?assignee=me[&closed=1][&refresh=1][&cached=1]` -> `{issues: IssueView[]|null, user, fetched_at, cached, stale, closed_count, warnings: [string]}`. Only
  `assignee=me` is accepted (400 otherwise); the server passes `assignee: "me"` to the MCP `list_issues` tool and refuses (502) when the tool has no assignee argument. Closed
  (completed / canceled) issues are omitted unless `closed=1`; `closed_count` counts them either way. Sorted urgent first, then most recently updated. The result is cached per user for 45 s
  (a plain GET inside that time makes no Linear call); `refresh=1` fetches again but is answered from the cache within 5 s of the last fetch; `cached=1` never calls Linear
  (`{issues: null, cached: true}` when there is nothing cached; `stale: true` when older than 45 s). Pages (up to 6 x 100) are followed. `threads` lists the minbox threads linked to each issue.
- `GET /api/linear/search?q=…` -> `{issues: IssueView[], query}`: the thread link dialog's search. An identifier or issue URL in `q` is read exactly (`get_issue`) and
  comes first; text goes to `list_issues` with the tool's query argument (one page, at most 20, no assignee filter); no duplicates. Cached per lower-cased query for 30 s.
  Empty `q` -> no issues (Linear is not asked); `q` over 200 characters -> 400; not connected -> 409 `linear_login`; Linear's errors as for the list.
- `GET /api/linear/issues/{identifier}[?refresh=1]` -> `{issue: IssueView (with description), comments: [{id, author, body, url, created_at}] (oldest first, the latest 50, minbox's own progress
  comment left out), comments_total, comments_error?, fetched_at}` (cached 30 s). 400 not an identifier.
- `POST /api/linear/issues/{identifier}/thread` body `{target: {kind: "session", session_id} | {kind: "new_session", project_id, agent?, name?} | {kind: "auto", project_id}, subject?, instruction?}` -> 201
  (`auto`: the helper picks one of the project's live agents for the issue, else a new agent starts; see "Choosing the agent for new work")
  `{thread, session, link_error?}`. Creates a thread whose first message is `instruction` (default "Work on Linear issue ENG-123: ..."), links it to the issue as `PUT /api/threads/{id}/linear` does
  (baseline of the existing comments; the In Progress rule applies when it starts working), and stores a **handoff** (table `thread_handoffs`) that `GET /api/agent/pending` puts in front of that
  first message exactly once (like a fork's): `<linear_issue_handoff source="untrusted-external" issue="ENG-123">` with identifier, title, url, state, priority, team, project, labels, assignee, a
  note that the thread is linked and Linear updates arrive as `<linear_updates>`, then `<issue_description>` and `<issue_comments>` (the latest 10). Text is redacted for credentials, our tags
  inside it are neutralised, the description is cut at 6000 bytes, a comment at 1500, the block at about 16 KB. Same errors as forks (400 for a bad/archived/ended target).
- `POST /api/linear/issues/{identifier}/thread/preview` same body -> `{handoff, message, text, bytes, subject, agent, project, warnings}`: the text the agent gets first.
- `POST /api/linear/issues/{identifier}/project-suggestion` -> `{project_id, source: "linked"|"name"|"only"|"llm"|"none", reason}`: which minbox project to start in. Hints first (a thread already
  linked to the issue; a project named like the issue's Linear project, team name or key; the only project), else the Slack project-pick helper with the issue as untrusted data and only
  existing project ids accepted; `none` = undecided (the UI falls back to the last used project).
- `POST /api/linear/issues/draft` body `{stage: "meta"|"llm", text?, team_id?, refresh?, regenerate?}` = the thread draft without a thread. `meta` -> `{meta, fallback, llm_available}`; `llm` -> `{draft,
  team_lists, source: "llm"}` or `{reason: "no_agent"|"error", note}` from the plain-language `text` (required, 400 when empty), ids validated against Linear's lists, the extra-prompt setting honoured,
  the assignee defaulting to you; `regenerate` skips the kept answer. `POST /api/linear/issues/team/{teamId}/lists` = the team lists endpoint of the thread flow.
- `POST /api/linear/issues` body `Draft` + `{submission_id?}` -> `{issue: IssueView}`; the create path of `POST /api/threads/{id}/linear/create` without a thread (same validation and errors except
  `already_linked`), idempotent per `submission_id`.

## Slack (personal)

The person's own Slack **user token** and the screen of threads that need their reply (design: [slack-personal.md](slack-personal.md)). The token is stored server-side and
never returned (only `token_masked`); every error text is scrubbed of it. `MINBOX_SLACK_API_URL` (loopback http only) points the server at a fake Slack. All `/api/slack/*` calls answer 409
`code: "not_connected"` without a token, and 502 with Slack's (scrubbed) message when nothing could be read.

- `GET /api/integrations/slack-user` -> `SlackStatus`: `{connected, token_masked?, user_id?, user?, team_id?, team?, team_url?, connected_at?, search_backend: "auto"|"rts"|"legacy",
  search_backend_used?, search_backend_note?, scopes, scopes_known, missing_scopes, optional_scopes, optional_missing, last_test?, last_test_ok, last_test_at?, diagnostics: {calls, by_method,
  errors, rate_limited, last_error, last_error_method?, last_error_at, last_call_at, rate_limited_until, blocked?: {method: seconds}}, days, max_candidates, unverified: [string],
  refresh: {running, stage?, done, total, started_at?, finished_at?, calls, partial, wait_until?, error?}}`.
- `PUT /api/integrations/slack-user` body `{token?: "xoxp-…", search_backend?: "auto"|"rts"|"legacy"}` -> `{result?: {ok, message, error?, code?, missing_scopes?, search?}, status}`. A token is checked
  with `auth.test` first (and one search call); one that fails is **not** stored (`result.ok` false, `result.error` says what to do). 400: not a user token (a bot `xoxb-`, app `xapp-` or rotation
  `xoxe.` token is refused with its own message, before any call).
- `POST /api/integrations/slack-user/test` -> `{result, status}` (re-checks the token, scopes and the search; Auto reports a fallback to the legacy search). `POST .../disconnect` -> `SlackStatus`
  (deletes the token and every stored judgement, snippet, dismissal, link, fetched thread copy and user name). `POST .../clear-cache` -> `SlackStatus` (deletes judgements, snippets, fetched thread copies and user names). Fetched copies (`slack_threads`, `slack_users`) are written through and survive a restart.
- `GET /api/slack/threads[?refresh=1][&cached=1]` -> `{items: SlackItem[], counts: {needs_reply, maybe, dismissed}, hidden, notes: [string], fetched_at, refresh, user: {id, name}, team,
  backend: "rts"|"legacy", backend_note}`. A plain GET refreshes unless one ran in the last 15 s; `refresh=1` forces one; `cached=1` never calls Slack. A refresh blocks until the pipeline ends
  (search → read threads → names → helper judgement) and publishes SSE `{type: "slack"}` at each stage so a client can re-read `cached=1` for partial results; a rate limit ends it early with
  `refresh.partial` and `refresh.wait_until`. `SlackItem` = `{id: "<channel>:<thread_ts>" ("D…:dm" for a DM conversation), channel, thread_ts, group: "needs_reply"|"maybe"|"dismissed",
  state: "active"|"dismissed"|"snoozed"|"muted", snooze_until?, reappeared?, kind: "channel"|"dm"|"group", label, people, last_ts, last_at, last_author, last_is_me, snippet, messages, unread (DMs
  only), permalink, judgement: {needs_reply: "yes"|"maybe"|"no", reason, urgency: "high"|"normal"|"low", summary, suggested_next_step?, source: "llm"|"rule", latest_ts}|null, unjudged, stale?,
  minbox_thread: {thread_id, session_id, subject, status, project_id, updated_at}|null}`. Threads judged "no" are counted in `hidden`, not listed. A dismissed item returns (`reappeared`) when
  a message from someone else newer than the one it was dismissed at arrives, unless muted; a snooze ends at its time.
- `GET /api/slack/threads/{id}[?refresh=1]` -> `{id, channel, thread_ts, kind, label, permalink, messages: [{ts, at, user_id, name, is_me, is_bot, html, files: [{name, url?}], attachments: [{name, url?}]}],
  earlier, note, fetched_at, team, me, judgement?, judgement_stale?, state?, snooze_until?, minbox_thread?}`. `html` is Slack mrkdwn rendered to safe HTML (everything escaped; only b, i, s, code, pre,
  blockquote, a (http/https/mailto), br and span.mention are produced; mentions resolved; emoji codes left as text). Messages are cached 2 min in memory.
- `POST /api/slack/threads/{id}/state` body `{action: "dismiss"|"mute"|"snooze"|"restore", until?}` (snooze: a future time, at most 90 days) -> `{ok: true}`.
- `POST /api/slack/threads/{id}/project-suggestion` -> `{project_id, source: "linked"|"name"|"only"|"llm"|"none", reason}` (a minbox thread already started from it; a project named like the channel; the
  only project; else the helper, with only existing project ids accepted).
- `POST /api/slack/threads/{id}/thread/preview` and `POST /api/slack/threads/{id}/thread` take the body of the My issues equivalents (`{target, subject?, instruction?}`) and answer like them
  (`{handoff, message, text, bytes, subject, agent, project, warnings}` / 201 `{thread, session, link_error?}`). The handoff `<slack_thread_handoff source="untrusted-external" thread="…">` is composed
  by the server once, stored in `thread_handoffs` (kind `slack_thread`) and prepended to the first message by `GET /api/agent/pending` exactly once; the item records `minbox_thread_id`.


## Mod connection (heartbeat)

See `docs/mod-connection.md` for the delivery path, failure modes and log lines.

- `POST /api/agent/heartbeat` (the agent API, bearer = the session token) body `{seq, agent: "claude"|"pi"|"opencode", ext_version, state: "idle"|"working",
  last_poll_at, last_delivery_at, info: {string|number|bool values, at most 30}, events: [{at, kind, msg}]}` (the last 50 events are kept, texts cut) -> `{ok: true, server_time}`.
  The mod sends it every 15 s. The server records it per session, judges the connection by it, logs `modconn:` lines (hello, heartbeat-first, pending, claimed, delivered,
  released, claim-refused, stale, reconnected, undelivered, seq-reset, spawn, relocated, exit; ids, lengths and timings only) and publishes a `sessions` event when the state flips.
- Session JSON adds `mod_conn` (`connected` | `stale` | `connecting` | `none`) and `mod_beat_at` (the last heartbeat, null before the first). `connected` means a heartbeat within 45 s
  (`MINBOX_MOD_SILENT_S` overrides; a mod that never sends heartbeats is judged by its calls). `none`: a shell or an ended session. `mod_seen_at` / `mod_silent` stay (any call).
- `GET /api/sessions/{id}/connection` -> `{session_id, state, stale_after_s, server_time, server_started_at, session_status, heartbeat, last_contact_at, last_beat_at, age_s,
  first_seen_at?, beats?, seq?, agent?, mod_version?, mod_state?, last_poll_at?, last_delivery_at?, mod_info?, reconnects?, last_gap_s?, stale_since?,
  queue: {count, oldest_wait_s}, mod_events: [{at, kind, msg}] (the mod's own tail), events: [{at, kind, msg}] (the server's log of this session)}`. No message text, token or owner key.
- `GET /api/agent/pending` offers a message whose claim is older than 60 s again, also to the instance that made the claim (before, its own stale claim hid the message for ever).


## Pi and OpenCode on remote hosts (host protocol 5)

See docs/agents.md ("Remote hosts"). Host protocol 5 (`termhost.AgentsProtocol`) adds, on remote hosts (signed requests like
every other route; the local socket host serves them too but the server does not use them there):

- Spawn placeholders `{{MINBOX_PI_EXTENSION}}`, `{{MINBOX_PI_SUBAGENT}}`, `{{MINBOX_OPENCODE_PLUGIN}}` (next to `{{MINBOX_PLUGIN_DIR}}` and
  `{{MINBOX_SERVER_FILE}}`): the host fills in its own copies, extracted from its binary at `minbox host` start into
  `<host data dir>/pi-extension/<hash>/pi/{minbox,subagent}.ts` and `<host data dir>/opencode-plugin/<hash>/opencode`
  (content-hash folders, idempotent, like the Claude mod's `plugin/<hash>`). In `OPENCODE_CONFIG_CONTENT` the path is filled in
  JSON-escaped, and the server's entry is merged into an `OPENCODE_CONFIG_CONTENT` of the host's own environment (its `plugins`
  are kept, ours appended; other keys of ours win; a value that is not plain JSON is replaced).
- `POST /exec {argv, dir?, env?, stdin?, timeout_ms?}` -> `{exit_code, stdout (base64), stderr, error?, not_found?, timed_out?}`:
  a short command with the host's cleaned environment plus `env` (placeholders filled in); `argv[0]` is looked up on the host's
  `PATH` (`not_found`); 30 s by default, at most 10 min; 4 MB of output per stream. Used for `opencode api --standalone
  session.get|session.create` and the version probes.
- `POST /lookpath {names}` -> `{paths: {name: path|""}}` on the host's `PATH`.
- `GET /fs/piconversation?cwd=&id=` -> `{path}`: Pi's session file of conversation `id` on that machine (`""` if none; Pi's
  sessions folder of the host's environment).

A Pi or OpenCode session on a host older than protocol 5 is refused at create and at (re)start ("update minbox on that machine").

## Restarting the local terminal host (Settings › Hosts)

`POST /api/hosts/{id}/restart {resume?: bool}` (same guard as every browser route: a paired device, same
origin). Only the built-in host (`id` "local"): 400 for a remote host, 404 for an unknown id, 409 while a restart is under
way (one at a time). It does what `minbox restart --host` does, with the server kept running:

1. the sessions not ended on the local host are listed (the answer's `sessions`);
2. the server's connection loop is held back (it neither connects nor starts a host), and exits on the current
   connection stop counting as session ends;
3. the host is stopped with `termhost.Stop` (as `minbox host stop`: `POST /shutdown`, else SIGTERM; waits for the socket);
4. `resume:false`: those sessions are marked ended (exit code -1);
5. the loop goes on: `termhost.Ensure` starts a new host from the server's binary (`minbox host start --socket …`),
   connects, and `Reconcile` resumes the open sessions (`resume:true`, the default) as after a reboot;
6. it answers once that reconcile is done (at most 30 s; else 500 with the reason).

SSE `hosts` is published when it starts and ends (host JSON `restarting: true` meanwhile), `sessions` as they change.

Host JSON adds `pid` (the local host's), `started_at` (when the host process started), `version_status`
(`current` | `outdated` | `unknown`) and `restartable` (the built-in host). The host's `GET /version` adds `started_at` and
`binary` (`termhost.BinaryID`: the first 16 hex of the SHA-256 of its executable, read at start), both omitted by older hosts.
The local host is `outdated` when its `binary` differs from the server's own, `unknown` when it does not say; a remote host
compares its `version` with the server's (`unknown` when either is empty or both are "dev"). The local host's `version` is
now its own (`minbox host start` reports the build's version), no longer the server's when the host does not say.

## Agent environment variables

`POST /api/sessions` and `POST /api/v3/new` (`to: "new"`) take `env`: `{"KEY": "value"}`, or a list of
pairs `[{"key": "KEY", "value": "v"}]` / `[["KEY", "v"]]`. Keys match `^[A-Za-z_][A-Za-z0-9_]*$`; `MINBOX_*`,
`TERM`, `COLORTERM` and `OPENCODE_CONFIG_CONTENT` are minbox's own and refused (400, naming the keys only).
An empty value sets the variable to empty. They are stored with the session (`sessions.env`, JSON) and added at
every start (create, restart, resume, the companion shell), on this machine and on a remote host, on top of the
inherited (cleaned) environment and under minbox's own variables (`internal/server/agentenv.go`). Values are
never logged nor returned: session JSON carries `env_keys` (sorted names) only, and the agents' API
(`/api/agent/*`, the mod's tools) carries neither. The New agent dialog's Advanced section edits them as
`KEY=value` lines.

`PATCH /api/sessions/{id}/env` (the browser only: a paired device; an agent's token gets 401, and nothing under
`/api/agent/*` changes them) edits an agent's variables without the browser ever holding the stored values:
`{"set": {"KEY": "value"}, "unset": ["KEY"]}`. `set` adds or replaces, `unset` removes (an unknown key is
ignored), every other stored variable keeps its value; a key in both is 400. `set` is checked with the same rules
as at creation (400 naming keys only). The answer is `{"ok": true, "env_keys": [...]}`. The change takes effect at
the agent's next start (restart, resume, the companion shell's next start); meanwhile a running agent is stale with
reason `env`: each start records a hash of its variables salted with the agent's token (`sessions.run_env`), and a
different current set adds `env` to `stale_reasons` (an agent started before the record is not counted). The agent's
⋯ menu has "Environment variables…": the keys with masked values, Replace value / Remove per row, Add as
`KEY=value` lines, and Save or Save and restart.
