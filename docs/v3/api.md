# minbox v3 API

v3 keeps the older endpoints (`docs/api-contract.md`) and adds these. See `redesign.md` for the model
and `usecases.md` for what the screens do with them.

## Model

- **Stream**: each session has one stream thread (`threads.kind = 'stream'`, made on first use). Its
  older threads (`kind = ''`) stay and read as *segments* of the same stream.
- **Task** (`tasks`): `id, project_id, title, summary, detail, status (working|needs_you|blocked|done),
  steps [{text, done, steps?}] (one level of nesting), report, links [{kind, label, url, state}],
  created_by, manual_status/manual_at, kind ('' | 'goal'), parent_id (the goal it serves),
  criteria [{text, done}] (a goal's "done when"), auto {state: ''|running|paused|stopped, session_id,
  max_turns, turns, until, reason, last_at}`, title_by (`person` | `agent` | '' for older tasks: who
  named it last; see the PATCH rows).
- **A message's task** (`message_tasks`, formerly `message_tags`): a message is *about* exactly one
  task (none only while the agent has not placed it yet); a unique index on `message_id` holds it to
  one row (since the `v3_one_task` migration, which logged the links it dropped in
  `message_tasks_dropped`). `source: agent | auto | person` says how the link was made (the agent named
  the task, a rule such as an answer inheriting its question's task, or the person). V3Message keeps
  `tasks` as a list of at most one.
- **Task agents** (`task_agents`): `role: assigned | involved`.
- **Task events** (`task_events`): the event log (`created, status, step, criterion, link, unlink,
  handoff, report, answer, auto, title, goal`).
- **Message** gains `decision (existing|created|none|moved)`, `decision_task`, `turn_of [message id]`
  (the person's messages the reply answered). `read_at` is per message (as before). The UI shows the
  decision under an agent reply only when it created a task or the person moved the exchange.

## Web

| Method | Path | |
| --- | --- | --- |
| GET | `/api/v3/board?project=` | `{tasks: [BoardTask], questions: [V3Message], agents: {session_id: {unread, open_questions}}}`. BoardTask = Task + `open_questions, unread, message_count, last_activity, last_agent, needs_you, criteria_done, task_ids` (a goal's tasks). Done tasks of the last 7 days. |
| GET | `/api/v3/tasks/{id}` | `{task: BoardTask, messages: [V3Message + gap], events, tasks: [BoardTask] (a goal's), goal: Task?}`. `gap`: other messages of the same stream (about other tasks or none) since its previous message about this task. |
| GET | `/api/v3/tasks/{id}/suggestions` | The reply help of a task's view (docs/api-contract.md "Reply suggestions"): questions for the task's latest agent message, and the denied `command` of that message's stream. A stream's help is `GET /api/threads/{stream_thread_id}/suggestions`. |
| PATCH | `/api/v3/tasks/{id}` | `{title?, status?, summary?, steps?, criteria?, parent_id?}` by the person (status is marked manual). A new title is a timeline event `title` ("Renamed: old → new (you)") and makes `title_by` `person`. |
| POST | `/api/v3/tasks` | `{project_id?, title, kind?, session_id?, message_ids?}`: the task picker's "New task" (the messages become about it). |
| POST | `/api/v3/tasks/{id}/auto` | `{action: start|pause|stop, session_id?, max_turns?}`: a goal's autonomous run. |
| GET | `/api/v3/sessions/{id}/stream?limit=&before=&after=` | `{messages: [V3Message], has_more, tasks, stream_thread_id}`. V3Message = Message + `session_id, tasks [{task_id, title, status, source}], segment?, open`. |
| POST | `/api/v3/sessions/{id}/messages[?thread=<older thread>]` | The reply body (`words, answers_for, answers, uploads, annotations, urgent, resume`) + `task_id` (the task the message is about; `task_ids`, the older name, counts its first id). Goes to the stream (an answer to an older thread's question: `?thread=`). Answers are about their question's task; task_id reopens a done task and put the session on it (a hand-off event when it is new there). `uploads`: ids from `POST /api/uploads` (the composer's attachments). |
| POST | `/api/v3/new` | `{to: session id | "new" | "" (the helper picks one of the project's live agents for the words, else a new agent; see api-contract.md "Choosing the agent for new work"), project_id, agent?, name?, ...reply body}`. |
| PUT | `/api/v3/messages/{id}/task` | `{task_id}`: the person moves the message to that task (it leaves the one it was in; both timelines say so) → `{ok, added, task_id, from}`. `POST /api/v3/messages/{id}/tasks` is the older name of the same call. |
| DELETE | `/api/v3/messages/{id}/tasks/{task}` | Kept for older clients: **409** when it is the message's task (a message is always in exactly one task: move it instead); otherwise a no-op. |
| POST | `/api/v3/messages/{id}/move` | `{to? | title}` (`from` is accepted and ignored): "Move to another task…" under an agent reply — moves the reply, and its `turn_of` messages that were in the reply's task or in none, to `to` or to a new task named `title`; a task created in that turn left with no messages is deleted (`removed_task`). |
| POST | `/api/v3/read` | `{message_ids}` → `{marked}`. |
| POST | `/api/v3/unread` | `{message_ids}` → `{marked}`: "Mark unread from here" (agent messages count as new again). |
| GET | `/api/v3/search?q=&project=` | `{tasks, messages: [{id, session_id, thread_id, author, text, created_at, tasks}]}`. |

SSE: `tasks` (any task, message–task link or read change) besides the older `thread`, `threads`, `sessions`.

### What the Board shows

- **NEEDS YOU**: question cards. A question in a task's messages shows on that task's card (once, not
  also as a task row); a task set to needs you without an open question is a row. Long choices wrap
  as a list, free-text questions answer in place.
- **GOALS**: goals with their tasks and run state.
- **WORKING**: open tasks with activity in the last 3 days, newest first; each row shows its agents
  (live state), progress, PR / links and age.
- **IDLE** (collapsed): open tasks quiet for more than 3 days.
- **BLOCKED**: only when there is one.
- **DONE** (collapsed): done in the last 48 hours.

### Composer

The stream's reply box, the task view's reply box and New message (⇧N) take attachments like the
older reply box: paste (⌘V), drop, the attach button (on a phone the photo / camera picker), preview
tiles with remove and upload progress; they go as `uploads`.

## Agent

| Call | v3 |
| --- | --- |
| `POST /api/agent/messages` | `{body, task_id?, attachments?, review?}`; `task_ids` is the older name of `task_id` (one id; **400** with a "pick one task" text for more); `thread_id` / `thread_title` are accepted but not needed (legacy). A non-empty `status` is **refused** (400, nothing stored): `send_message has no status: a task's status is set with update_task (status working | needs_you | blocked | done). Send the message again without status.` (a task's status is set with update_task). Every message goes to the stream and belongs to one task: the named one; else, only when the turn points at one task, the single task created in the turn, else the task of the turn's person's messages (when they are all in one); else none (minbox asks the agent to place it after the turn). A legacy `thread_id` of an older thread names that thread's task only when no task is named; `thread_title` is ignored. **The turn's person's messages that are in no task yet** go in the reply's task; those the turn's first `create_task` put in its task move to the reply's task when the reply names another. Answer adds `task_id`, `task_ids` (at most one), `decision` and `note`: when the message went in no task, `note` says so and how to place it and the turn's person's messages (update_task / create_task `message_ids`, which move messages). |
| `POST /api/agent/tasks` | `{title, kind?: "goal", goal_id?, summary?, detail?, status?, steps?, criteria?, autonomous?, max_turns?, message_ids?}` → `{task_id, task, tagged_messages, similar_tasks?, note?}`. The turn's person's messages about no task, and later replies in the turn, are about it; so are `message_ids` (an agent reply brings its turn's messages in no task). `status: "done"` makes a quick exchange's small task, closed at once. `similar_tasks` ([{id, title, status}]) and `note` name open tasks with a similar title: the agent should keep using one of them rather than creating more. |
| `PATCH /api/agent/tasks/{id}` | `{title?, summary?, detail?, status?, report?, steps?, check_steps?, uncheck_steps?, criteria?, check_criteria?, goal_id?, links?, message_ids?, autonomous?}`. Any task of the project; the agent becomes involved. `message_ids`: earlier messages that are about it (an agent reply brings the person's messages it answered that are in no task). All criteria met (or done) ends a goal's run. A `title` renames it (event "Renamed: old → new", `title_by` `agent`), except a task the person named (`title_by` `person`): that title is kept, the rest is applied, and the answer's `note` (shown in the tool result) tells the agent to suggest a name to the person instead. |
| `GET /api/agent/tasks[?all=1]` | `{tasks}`: the caller's (or the project's open) tasks and goals. |
| `GET /api/agent/pending` | each message also has `tasks: [{task_id, title, status}]` (the tasks it is about) and `stream`. A goal's continuation has `kind: "continue"`; minbox's request to place messages in tasks has `kind: "place"` (its body, written by the server, is the whole turn text: the integrations pass it on as it is). |

The turn: the person's delivered messages after the agent's last message before them (`store.TurnMessages`);
it ends when the agent reports `idle` or new messages of the person are delivered.

Every message is about a task (redesign.md §13 revision 7). When a turn ends (`working` → `idle`) and
messages of the session are in no task (not counting the person's messages not delivered yet),
minbox adds a `kind: "place"` message to the stream after `placeSettle` (1.5 s): the unplaced messages
(id, author, time, excerpt), the agent's open tasks, and how to place them. Its `turn_of` lists the
messages it asks about; once they are all in tasks, it is about those tasks too (it is not counted in
a task's `message_count`). Asked again after every turn that leaves messages in no task, with no
limit; asking again about the same messages waits 30 s, doubling to at most 10 min
(`MINBOX_PLACE_WAIT_S` sets the first wait). Not while the agent is in a turn, has messages on their
way, or one of its questions waits on the person. minbox never puts a message in a task by itself.

## Migration

- `v3_migrated` (first): topics → tasks, unfinished threads without topics → tasks, Linear links,
  read state. Nothing is dropped.
- `v3_migrated_2` (corrective, idempotent): the first one turned every unfinished thread and every
  topic into a task, which filled the Board with stale work. It removes the tasks the first migration
  made that nobody touched since — from threads with no activity for more than 7 days, and from done
  or finished topics — (the `threads` and `topics` tables keep their data, the messages stay in the
  streams and in search), retitles the kept thread tasks from the thread's name / subject (first line,
  at most 80 characters), makes all messages of a thread with exactly one kept task about it, and
  drops the "Task created (from the earlier inbox)" events. Tasks the person or agents created, and
  migrated tasks that were changed after the first migration (the person's links, events, later
  messages), are never touched.
- `v3_migrated_3` (idempotent, one transaction, nothing removed): every message in no task is put in
  one. A message of an older thread goes to that thread's task (made from it or its topics, else the
  task most of its messages are about); a thread with none gets a **done** task of its own, titled
  from its name / subject (first line, at most 80 characters), done at the thread's last activity (so
  the Board's DONE shows only recent ones). A stream message goes by its turn (a reply to the tasks of
  the messages it answered, a person's message to the tasks of the reply that answered it, an answer
  to its question's), else to the tasks of the session's message nearest in time that has some; a
  session with no task at all gets one done task for its stream, titled from its first message.
