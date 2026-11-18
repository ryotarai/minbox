# minbox v3: use cases

The person's real jobs, each as a short scenario: where it starts, what shows first, the fewest
keys/taps, and what must **not** be required. These drive the screens and the e2e specs
(`web/e2e/v3-*.spec.ts`, one per use case where practical, named after it).

Screens and the one question each answers first:

| Screen | Answers first | Way back |
| --- | --- | --- |
| **Board** (home) | What needs me, and what is moving? | — (`Esc`, `g b`, the Board tab / sidebar item) |
| **Task** | Where is this piece of work? | `Esc` → Board; browser back |
| **Agent** (stream) | What is this agent doing / saying? | `Esc` → Board; sidebar |
| **Search** | Where was that said? | `Esc` |

Vocabulary in the UI: *Board, task, agent, message, question*. Never *thread*, never *tag*: a message simply
is *about* one or more tasks (or none).

---

## UC1. Morning triage: what needs me
- **Entry**: open minbox (desktop or phone). Lands on the Board.
- **Shown first**: NEEDS YOU, as question cards (`you: <question>`, the task it is about, agent, age, the choices as buttons; a task's question shows once, on its card, not again as a task row), then tasks set to *needs you* without a question, then GOALS, WORKING (active in the last 3 days, with agent state, PR / links, age), IDLE (collapsed: open but quiet for more than 3 days), BLOCKED (only when there is one), DONE (collapsed, last 48 h).
- **Actions**: `J/K` walk the cards, `1–9` answers a single-choice question in place, `Space` expands a task row (checklist, last report), `Enter` opens it.
- **Must not be required**: opening an agent or task to see what is asked; choosing a project's thread; reading every report.
- Spec: `v3-triage.spec.ts`.

## UC2. Answer a question fast (desktop and phone)
- **Entry**: Board card, or the question inside the task / agent view, or a notification.
- **Shown first**: the question and its choices.
- **Actions**: one click / tap on a choice (or `1–9`); free text in "Other…" + Enter; a free-text question is answered in place on its card. Long choices wrap as a list, not giant buttons. The card leaves NEEDS YOU at once (optimistic) and the answer goes to the agent that asked, about the question's tasks.
- **Must not be required**: navigating to the agent; typing a reply around the answer.
- Spec: `v3-answer.spec.ts` (desktop + phone viewport).

## UC3. Give a new request without thinking where it goes
- **Entry**: `⇧N` anywhere (or "New message" in the sidebar / Board header / Agents tab).
- **Shown first**: a composer: *To* = the project's main agent (changeable to any agent or **New agent**), the text box focused.
- **Actions**: type, `⌘↵`. The view moves to that agent's stream; the agent decides: an open task (the message is about it) or new work (creates a task). Every message is about a task: chit-chat that fits no task gets a small task of its own, done at once (off the Board's open lists). The reply shows the task it is about as a plain link (`in: <task>`); a note appears under it only when the agent created a task (`→ new task <task>`) or the person moved it. A message the agent has not placed yet says "waiting for <agent> to place it in a task"; minbox asks the agent to place it after each turn that leaves it (a small "↻ Asked <agent> to put N messages in tasks" line in the stream) until it does.
- **Must not be required**: picking or naming a task; choosing "send as task"; picking a thread.
- **Attachments**: paste an image (⌘V), drop files, or the attach button (on a phone the photo / camera picker); tiles show progress and can be removed; the sent message shows them (thumbnail → viewer). Same in the stream's and the task view's reply box.
- Spec: `v3-new-request.spec.ts` (main agent, new agent), `v3-place.spec.ts` (the agent ignores the request to place, is asked again after each turn, places them).

## UC4. Follow up on an existing piece of work
- **Entry**: Board row → `Enter` (or click), or a task chip anywhere.
- **Shown first**: the task view: title + status + agents, the messages about it from every agent in time order (header: "32 messages"), events between; the checklist / last report / facts on the side.
- **Actions**: `R` (focus reply), type, `⌘↵`. It goes to the agent most recently active on the task (shown as `to: <agent> ▾`, switchable) and is about the task (shown as `about: <task>`).
- **Must not be required**: finding which agent is on it; linking the message to the task by hand.
- Spec: `v3-follow-up.spec.ts`.

## UC5. Check progress of one task across agents
- **Entry**: Board row, `Space` to expand inline (checklist with the current step, last report) or `Enter` for the full task view.
- **Shown first**: segmented progress bar `n/m`, the step now in progress, who is involved.
- **Actions**: none beyond expand / open. "Show context" between the task's messages shows the other messages around them in that agent's stream.
- **Must not be required**: reading every agent's stream.
- Spec: covered in `v3-triage.spec.ts` (expand) and `v3-follow-up.spec.ts` (context).

## UC6. See what one agent is doing / open its terminal
- **Entry**: sidebar Agents list (always visible on desktop; Agents tab on phone), `g a`, or an agent chip.
- **Shown first**: the agent's stream (one conversation, oldest → newest, scrolled to the end), with the task each message is about as a plain link (`in: <task>`); its title ("now doing"), turn state and the task it is on now in the header (one, not every task); older threads as dividers named after them; its open tasks (few, recently active first) on the side. Two agents with the same name are told apart (main / folder / host).
- **Actions**: `T` / the Terminal button opens the terminal beside the stream; ``Ctrl+` `` the shell; Files button the files pane.
- **Must not be required**: picking a thread; a separate terminal page.
- Spec: `v3-agent-stream.spec.ts`.

## UC7. Move a message to the right task
- **Entry**: a message's `⋯` menu: **Move to another task…** (**Put in a task…** on one the agent has not placed yet), **Also about another task…**. There is no "Not about a task": every message is about at least one task, so a message's last task can only be replaced, not removed.
- **Shown first**: the task picker: open tasks filtered as you type, "+ New task “…”" last.
- **Actions**: type, `Enter`. On an agent reply, the person's message it answered moves with it; a task created by mistake that is left with no messages is removed.
- **Must not be required**: moving two messages one by one; going to the task to delete it; knowing any word for the link ("tag").
- Spec: `v3-move.spec.ts`.

## UC8. Find something said last week
- **Entry**: `/` anywhere (Search item / tab on phone).
- **Shown first**: results as you type: TASKS (title, steps, summary) and MESSAGES (text with the match marked, agent, time, its tasks).
- **Actions**: pick a result: a task opens the task view; a message opens its agent stream scrolled to it (highlighted), or its task.
- **Must not be required**: knowing the agent or task first.
- Spec: `v3-search.spec.ts`.

## UC9. An agent hands work to another session
- **Entry**: the task view's *to* selector → another agent or **New agent**.
- **Shown first**: the composer addressed to that agent, still about the task.
- **Actions**: type, `⌘↵`. The new agent joins the task's agents; its replies about it are about the task; the task's conversation shows the hand-off as a line between messages.
- **Must not be required**: forking a thread; copying context by hand (the task id delivered with the message carries it).
- Spec: `v3-follow-up.spec.ts` (switch recipient).

## UC10. Review and close done work
- **Entry**: Board, DONE TODAY (show), or a WORKING row the agent reported done.
- **Actions**: `X` on a focused row marks done / reopens; the status menu in the task header; drag a row to another group. A message sent in a done task reopens it.
- **Must not be required**: archiving threads; marking read separately (reading a task's messages marks them read).
- Spec: `v3-triage.spec.ts` (X).

## UC11. Get notified and act from the phone
- **Entry**: a notification / the tab badge (count = NEEDS YOU). Phone opens on the Board with bottom tabs Board · Agents · Search.
- **Shown first**: the question cards, each answerable with one tap.
- **Actions**: tap a choice; tap a row to open the task (status + checklist folded on top, messages, reply at the bottom); Agents tab → an agent → its stream.
- **Must not be required**: horizontal scrolling; a desktop-only gesture (drag, hover) to do any of the above.
- Spec: `v3-phone.spec.ts`.

## UC12. Read state that just works
- Messages are read when they are shown, in the stream **or** the task view; the Agents list shows unread counts, Board rows show a dot while one of the task's messages is unread.
- **Must not be required**: a "mark read" step per surface.
- Spec: `v3-read-state.spec.ts`.

## UC13. Set a goal and let an agent run toward it
- **Entry**: any message ("keep fixing until CI is green and the PR is approved"), as UC3. The agent decides it is a goal (`create_task {kind: "goal", criteria, autonomous}`).
- **Shown first**: on the Board, under GOALS: the goal with its *done when* checklist progress, its tasks, its agent, and the run state (`running · turn 3/20`) with **Pause** / **Stop** (or **Start** when not running).
- **Actions**: Start / Pause / Stop with one click (Board row or the goal view). A question from the run lands in NEEDS YOU and the run waits; answering it lets the run continue.
- **Must not be required**: typing "continue" after every turn; watching the terminal; a separate goal editor before sending.
- Spec: `v3-goal.spec.ts`.
