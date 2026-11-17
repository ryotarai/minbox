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

Vocabulary in the UI: *Board, task, agent, message, question, tag*. Never *thread*.

---

## UC1. Morning triage: what needs me
- **Entry**: open minbox (desktop or phone). Lands on the Board.
- **Shown first**: NEEDS YOU, as question cards (`you: <question>`, its task chips, agent, age, the choices as buttons), then tasks set to *needs you* without a question, then WORKING, BLOCKED, DONE TODAY (collapsed).
- **Actions**: `J/K` walk the cards, `1–9` answers a single-choice question in place, `Space` expands a task row (checklist, last report, timeline), `Enter` opens it.
- **Must not be required**: opening an agent or task to see what is asked; choosing a project's thread; reading every report.
- Spec: `v3-triage.spec.ts`.

## UC2. Answer a question fast (desktop and phone)
- **Entry**: Board card, or the question inside the task / agent view, or a notification.
- **Shown first**: the question and its choices.
- **Actions**: one click / tap on a choice (or `1–9`); free text in "Other…" + Enter. The card leaves NEEDS YOU at once (optimistic) and the answer goes to the agent that asked, tagged with the question's tasks.
- **Must not be required**: navigating to the agent; typing a reply around the answer.
- Spec: `v3-answer.spec.ts` (desktop + phone viewport).

## UC3. Give a new request without thinking where it goes
- **Entry**: `⇧N` anywhere (or "New message" in the sidebar / Board header / Agents tab).
- **Shown first**: a composer: *To* = the project's main agent (changeable to any agent or **New agent**), the text box focused.
- **Actions**: type, `⌘↵`. The view moves to that agent's stream; the agent decides: existing task (tags the message), new work (creates a task) or no task. The decision shows under its reply (`→ created #…`, `→ tagged #… (existing task)`, `→ no task`).
- **Must not be required**: picking or naming a task; choosing "send as task"; picking a thread.
- Spec: `v3-new-request.spec.ts` (main agent, new agent).

## UC4. Follow up on an existing piece of work
- **Entry**: Board row → `Enter` (or click), or a task chip anywhere.
- **Shown first**: the task view: title + status + agents, the tagged messages from every agent in time order, events between; the checklist / last report / facts on the side.
- **Actions**: `R` (focus reply), type, `⌘↵`. It goes to the agent most recently active on the task (shown as `to: <agent> ▾`, switchable) and is tagged with the task.
- **Must not be required**: finding which agent is on it; tagging the message by hand.
- Spec: `v3-follow-up.spec.ts`.

## UC5. Check progress of one task across agents
- **Entry**: Board row, `Space` to expand inline (checklist with the current step, last report, timeline) or `Enter` for the full task view.
- **Shown first**: segmented progress bar `n/m`, the step now in progress, who is involved.
- **Actions**: none beyond expand / open. "Show context" between tagged messages shows the untagged messages around them in that agent's stream.
- **Must not be required**: reading every agent's stream.
- Spec: covered in `v3-triage.spec.ts` (expand) and `v3-follow-up.spec.ts` (context).

## UC6. See what one agent is doing / open its terminal
- **Entry**: sidebar Agents list (always visible on desktop; Agents tab on phone), `g a`, or an agent chip.
- **Shown first**: the agent's stream (one conversation, oldest → newest, scrolled to the end), with task chips under messages; its title ("now doing") and turn state in the header; its tasks on the side.
- **Actions**: `T` / the Terminal button opens the terminal beside the stream; ``Ctrl+` `` the shell; Files button the files pane.
- **Must not be required**: picking a thread; a separate terminal page.
- Spec: `v3-agent-stream.spec.ts`.

## UC7. Correct a wrong tag
- **Entry**: under an agent reply, the decision note's "wrong task?" (or "tag it?" when it chose no task); or any message's `+ tag` chip / the ✕ on a chip.
- **Shown first**: the `#` picker: open tasks filtered as you type, "+ New task “…”" last.
- **Actions**: type, `Enter`. Both the person's message and the reply move to the chosen task; a task created by mistake that is left with no messages is removed.
- **Must not be required**: retagging two messages one by one; going to the task to delete it.
- Spec: `v3-retag.spec.ts`.

## UC8. Find something said last week
- **Entry**: `/` anywhere (Search item / tab on phone).
- **Shown first**: results as you type: TASKS (title, steps, summary) and MESSAGES (text with the match marked, agent, time, tags).
- **Actions**: pick a result: a task opens the task view; a message opens its agent stream scrolled to it (highlighted), or its task.
- **Must not be required**: knowing the agent or task first.
- Spec: `v3-search.spec.ts`.

## UC9. An agent hands work to another session
- **Entry**: the task view's *to* selector → another agent or **New agent**.
- **Shown first**: the composer addressed to that agent, still tagged with the task.
- **Actions**: type, `⌘↵`. The new agent joins the task's agents; its replies about it carry the task tag; the task's timeline shows the hand-off.
- **Must not be required**: forking a thread; copying context by hand (the task tag + the task id delivered with the message carry it).
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
- Messages are read when they are shown, in the stream **or** the task view; the Agents list shows unread counts, Board rows show a dot while a tagged message is unread.
- **Must not be required**: a "mark read" step per surface.
- Spec: `v3-read-state.spec.ts`.

## UC13. Set a goal and let an agent run toward it
- **Entry**: any message ("keep fixing until CI is green and the PR is approved"), as UC3. The agent decides it is a goal (`create_task {kind: "goal", criteria, autonomous}`).
- **Shown first**: on the Board, under GOALS: the goal with its *done when* checklist progress, its tasks, its agent, and the run state (`running · turn 3/20`) with **Pause** / **Stop** (or **Start** when not running).
- **Actions**: Start / Pause / Stop with one click (Board row or the goal view). A question from the run lands in NEEDS YOU and the run waits; answering it lets the run continue.
- **Must not be required**: typing "continue" after every turn; watching the terminal; a separate goal editor before sending.
- Spec: `v3-goal.spec.ts`.
