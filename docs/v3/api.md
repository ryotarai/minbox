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
  max_turns, turns, until, reason, last_at}`.
- **A message's tasks** (`message_tasks`, formerly `message_tags`): a message is *about* zero or more
  tasks (many to many). `source: agent | auto | person` says how the link was made (the agent named
  the task, a rule such as an answer inheriting its question's tasks, or the person).
- **Task agents** (`task_agents`): `role: assigned | involved`.
- **Task events** (`task_events`): the timeline (`created, status, step, criterion, link, unlink,
  handoff, report, answer, auto, title, goal`).
- **Message** gains `decision (existing|created|none|moved)`, `decision_task`, `turn_of [message id]`
  (the person's messages the reply answered). `read_at` is per message (as before). The UI shows the
  decision under an agent reply only when it created a task or the person moved the exchange.

## Web

| Method | Path | |
| --- | --- | --- |
| GET | `/api/v3/board?project=` | `{tasks: [BoardTask], questions: [V3Message], agents: {session_id: {unread, open_questions}}}`. BoardTask = Task + `open_questions, unread, message_count, last_activity, last_agent, needs_you, criteria_done, task_ids` (a goal's tasks). Done tasks of the last 7 days. |
| GET | `/api/v3/tasks/{id}` | `{task: BoardTask, messages: [V3Message + gap], events, tasks: [BoardTask] (a goal's), goal: Task?}`. `gap`: other messages of the same stream (about other tasks or none) since its previous message about this task. |
| PATCH | `/api/v3/tasks/{id}` | `{title?, status?, summary?, steps?, criteria?, parent_id?}` by the person (status is marked manual). |
| POST | `/api/v3/tasks` | `{project_id?, title, kind?, session_id?, message_ids?}`: the task picker's "New task" (the messages become about it). |
| POST | `/api/v3/tasks/{id}/auto` | `{action: start|pause|stop, session_id?, max_turns?}`: a goal's autonomous run. |
| GET | `/api/v3/sessions/{id}/stream?limit=&before=&after=` | `{messages: [V3Message], has_more, tasks, stream_thread_id}`. V3Message = Message + `session_id, tasks [{task_id, title, status, source}], segment?, open`. |
| POST | `/api/v3/sessions/{id}/messages[?thread=<older thread>]` | The reply body (`words, answers_for, answers, uploads, annotations, urgent, resume`) + `task_ids` (the tasks the message is about). Goes to the stream (an answer to an older thread's question: `?thread=`). Answers are about their question's tasks; task_ids reopen a done task and put the session on it (a hand-off event when it is new there). `uploads`: ids from `POST /api/uploads` (the composer's attachments). |
| POST | `/api/v3/new` | `{to: session id | "new" | "" (the project's main session), project_id, agent?, name?, ...reply body}`. |
| POST | `/api/v3/messages/{id}/tasks` | `{task_id}`: the person says the message is (also) about that task. |
| DELETE | `/api/v3/messages/{id}/tasks/{task}` | The message is not about that task. |
| POST | `/api/v3/messages/{id}/move` | `{from?, to? | title}`: "Move to task…" under an agent reply — moves the reply and its `turn_of` messages from task `from` (or from no task) to `to`, or to a new task named `title`; a task created in that turn left with no messages is deleted (`removed_task`). |
| POST | `/api/v3/read` | `{message_ids}` → `{marked}`. |
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
| `POST /api/agent/messages` | `{body, task_ids?, attachments?, review?}`; `thread_id` / `thread_title` / `status` are accepted but not needed (legacy). Every message goes to the stream; a legacy `thread_id` of an older thread makes the message about that thread's task (when the migration made one), `thread_title` is ignored. `task_ids` are the tasks the reply is about, **and the turn's person's messages that are about no task yet** become about them too; tasks created in the turn count too; the tasks of the turn's (task-view) messages are inherited. `status` applies to the named tasks. Answer adds `task_ids` and `decision`. |
| `POST /api/agent/tasks` | `{title, kind?: "goal", goal_id?, summary?, detail?, status?, steps?, criteria?, autonomous?, max_turns?, message_ids?}` → `{task_id, task, tagged_messages, similar_tasks?, note?}`. The turn's person's messages about no task, and later replies in the turn, are about it. `similar_tasks` ([{id, title, status}]) and `note` name open tasks with a similar title: the agent should keep using one of them rather than creating more. |
| `PATCH /api/agent/tasks/{id}` | `{title?, summary?, detail?, status?, report?, steps?, check_steps?, uncheck_steps?, criteria?, check_criteria?, goal_id?, links?, message_ids?, autonomous?}`. Any task of the project; the agent becomes involved. `message_ids`: earlier messages that are about it. All criteria met (or done) ends a goal's run. |
| `GET /api/agent/tasks[?all=1]` | `{tasks}`: the caller's (or the project's open) tasks and goals. |
| `GET /api/agent/pending` | each message also has `tasks: [{task_id, title, status}]` (the tasks it is about) and `stream`. A goal's continuation has `kind: "continue"`. |

The turn: the person's delivered messages after the agent's last message before them (`store.TurnMessages`);
it ends when the agent reports `idle` or new messages of the person are delivered.

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
