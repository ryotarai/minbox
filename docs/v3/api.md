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
- **Tags** (`message_tags`): message ↔ task, many to many, `source: agent | auto | person`.
- **Task agents** (`task_agents`): `role: assigned | involved`.
- **Task events** (`task_events`): the timeline (`created, status, step, criterion, tag, untag,
  handoff, report, answer, auto, title, goal`).
- **Message** gains `decision (existing|created|none|moved)`, `decision_task`, `turn_of [message id]`
  (the person's messages the reply answered). `read_at` is per message (as before).

## Web

| Method | Path | |
| --- | --- | --- |
| GET | `/api/v3/board?project=` | `{tasks: [BoardTask], questions: [V3Message], agents: {session_id: {unread, open_questions}}}`. BoardTask = Task + `open_questions, unread, message_count, last_activity, last_agent, needs_you, criteria_done, task_ids` (a goal's tasks). Done tasks of the last 7 days. |
| GET | `/api/v3/tasks/{id}` | `{task: BoardTask, messages: [V3Message + gap], events, tasks: [BoardTask] (a goal's), goal: Task?}`. `gap`: untagged messages of the same stream since its previous tagged one. |
| PATCH | `/api/v3/tasks/{id}` | `{title?, status?, summary?, steps?, criteria?, parent_id?}` by the person (status is marked manual). |
| POST | `/api/v3/tasks` | `{project_id?, title, kind?, session_id?, message_ids?}`: the tag picker's "New task". |
| POST | `/api/v3/tasks/{id}/auto` | `{action: start|pause|stop, session_id?, max_turns?}`: a goal's autonomous run. |
| GET | `/api/v3/sessions/{id}/stream?limit=&before=&after=` | `{messages: [V3Message], has_more, tasks, stream_thread_id}`. V3Message = Message + `session_id, tags, segment?, open`. |
| POST | `/api/v3/sessions/{id}/messages[?thread=<older thread>]` | The reply body (`words, answers_for, answers, uploads, annotations, urgent, resume`) + `task_ids`. Goes to the stream (an answer to an older thread's question: `?thread=`). Answers inherit the question's tags; task_ids reopen a done task and put the session on it (a hand-off event when it is new there). |
| POST | `/api/v3/new` | `{to: session id | "new" | "" (the project's main session), project_id, agent?, name?, ...reply body}`. |
| POST | `/api/v3/messages/{id}/tags` | `{task_id}` (person). |
| DELETE | `/api/v3/messages/{id}/tags/{task}` | |
| POST | `/api/v3/messages/{id}/retag` | `{from?, to? | title}`: "wrong task?" — moves the reply and its `turn_of` messages; a task created in that turn left empty is deleted (`removed_task`). |
| POST | `/api/v3/read` | `{message_ids}` → `{marked}`. |
| GET | `/api/v3/search?q=&project=` | `{tasks, messages: [{id, session_id, thread_id, author, text, created_at, tags}]}`. |

SSE: `tasks` (any task, tag or read change) besides the older `thread`, `threads`, `sessions`.

## Agent

| Call | v3 |
| --- | --- |
| `POST /api/agent/messages` | `{body, task_ids?, attachments?, review?}`; `thread_id` / `thread_title` / `status` optional (legacy). Without `thread_id` the message goes to the stream. `task_ids` tag the reply **and the turn's untagged messages of the person**; tasks created in the turn tag it too; tags of the turn's (task-view) messages are inherited. `status` applies to the named tasks. Answer adds `task_ids` and `decision`. |
| `POST /api/agent/tasks` | `{title, kind?: "goal", goal_id?, summary?, detail?, status?, steps?, criteria?, autonomous?, max_turns?, message_ids?}` → `{task_id, task, tagged_messages}`. The turn's untagged messages of the person, and later replies in the turn, are tagged with it. |
| `PATCH /api/agent/tasks/{id}` | `{title?, summary?, detail?, status?, report?, steps?, check_steps?, uncheck_steps?, criteria?, check_criteria?, goal_id?, links?, message_ids?, autonomous?}`. Any task of the project; the agent becomes involved. All criteria met (or done) ends a goal's run. |
| `GET /api/agent/tasks[?all=1]` | `{tasks}`: the caller's (or the project's open) tasks and goals. |
| `GET /api/agent/pending` | each message also has `tasks: [{task_id, title, status}]` and `stream`. A goal's continuation has `kind: "continue"`. |

The turn: the person's delivered messages after the agent's last message before them (`store.TurnMessages`);
it ends when the agent reports `idle` or new messages of the person are delivered.
