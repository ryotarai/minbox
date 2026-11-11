# Start a new thread from a message (fork)

"Start new thread from here" on any message of a thread opens a new thread that carries that message as
context. An agent's conversation cannot be copied, so a fork is not a clone: the new agent is **handed the
context** (the quoted message, the id of the source thread, how to read the rest) and the person's own request.

## What the person sees

- **Entry points**: the fork icon in a message's header (shows on hover or keyboard focus), and the "…" menu of
  the message (always there; on the phone the only one) with *Start new thread from here*.
- **Dialog** (`ForkDialog`): where (*This session* is the default; *New session* with a project picker, an agent
  picker when both agents are installed and an optional session name; *Another session* picks an existing one),
  the title (prefilled with the message's first line), *Also carry the 3 messages before it* (off by default; the
  default carry-over is the selected message only), and *Your request* (optional). On the right is a **live
  preview** of exactly what the new agent receives first, composed by the server
  (`POST /api/threads/{id}/fork/preview`), with its size and warnings (another project, a shared conversation).
- **The new thread** shows `Forked from <subject> · message #N · <project>` in its header (and under the title in
  the phone header; "(deleted)" without a link when the source is gone) and a collapsed *Handoff context* card with
  the same text the agent received. Its first message is the person's request (or a one-line default naming the source).
- **The source thread** gets a marker under the message: `Started thread "<title>" from here · same session /
  project / session · working|needs you|finished`, with a jump link. It is derived from the link table and is
  **not a message**: `message_count`, unread, ordering and Slack notifications do not change. The thread list marks
  the new thread with a fork icon and the source with `<fork icon> N`.

## What the agents get

The handoff block is composed once (`forkHandoff`, `internal/server/fork.go`) for both Claude Code and Pi, the tool
name per agent kind being `mcp__minbox__read_thread` / `minbox_read_thread`. It is frozen in the link row and put in
front of the new thread's **first message when that message is delivered** (the same place and mechanism as
`<linear_updates>`): it is never part of the stored message body, a retry carries the same text, and the delivery of
the message marks it delivered. The block names the source thread id, subject, project, session and agent, the public
URL when one is set, the source message (number, id, author, time) and how many messages the source has now; then the
quoted message(s) between `<quoted_messages source="untrusted">` tags, then how to read the source with
`read_thread thread_id=… [before=<id of the next message>]`. Everything quoted is untrusted: our delimiters inside it
are neutralised (`<\/minbox_handoff` etc.), credential-looking strings are redacted (as for the Linear draft), a message
is cut at 8,000 bytes (with a note) and the block is bounded at about 20 KB (earlier carried messages drop first). The
only instruction is the person's request that follows the block. The preview is the same text: what the preview shows is
what `GET /api/agent/pending` serves.

The **source thread's agent** is told only when the fork goes to a **different session** (a same-session fork reaches
the same agent already). A short `<minbox_thread_forks>` block (at most 5 forks, about 1 KB each; no instruction, no
quoted text beyond an 80-character excerpt) is put in front of the next message delivered to the source session, marked
delivered with it, and starts no turn by itself. While the source session has ended it stays pending.

## Data

Table `thread_forks` (additive; `thread_links` is the Linear link): `child_thread_id` (unique, cascades),
`parent_thread_id` (set to NULL when the parent is deleted), `from_message_id`, `from_seq`, snapshot of the parent's
subject / project / session, `same_session`, `carry_before`, the frozen `handoff`, `handoff_message_id` /
`handoff_delivered_at`, `notice_state` (`pending | delivered | skipped_same_session`), `notice_message_id`.
A deleted parent leaves the child with its snapshot; a removed message shows "(removed)".

## Out of scope (not built)

LLM summary, multi-select, attachment copy, `notify_parent` / immediate notice, a command-palette entry, an agent-initiated
`fork_thread`, an idempotency key (the dialog disables its button while creating). Attachments of the quoted message are
listed by name only. The agent's `read_thread` answer does not carry `forked_from` yet. Cross-host forks use the normal
new-session path (Pi on another machine is refused there); that a remote agent can reach `read_thread` of the minbox
server is assumed, not tested.
