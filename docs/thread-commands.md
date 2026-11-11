# Thread commands (`!`)

A reply that starts with `!` is not sent to the agent as a message. minbox runs the rest as a shell command, shows the
result in the thread, and tells the agent about it with your next message. It is like `!` bash mode in Claude Code.

## What counts as a command

| You type | What happens |
|---|---|
| `!ls -la` | runs `ls -la` |
| `\!ls -la` | sent as a normal message with the text `!ls -la` (the backslash is removed) |
| ` !ls` (a space first) | a normal message |
| `!` or `!   ` (nothing after it) | a normal message with that text (nothing is lost; no error) |

Only the first character counts and there is no extra setting. A command works in a reply inside an existing thread.
It is refused (422) with answers to questions, markups, uploaded files or "forward to another session" in the same
reply, and as the first message of a new thread (`\!` works there, as text). It needs the same sign-in as any reply.

The composer shows "Runs as a command in <folder>" while the text starts with `!`, and the button says Run.

## Running

- `sh -c '<command>'` in the session's folder (`cwd`; a pending project-folder change applies at the next start, as for
  the agent). Sessions on another host are refused: commands run on the machine minbox runs on.
- stdout and stderr share one stream, in order. stdin is empty. The environment is minbox's own.
- 60 s limit. Then the whole process group is killed and the result says "timed out". Output is kept up to 64 KB, with
  a marker when more came. A server restart ends a running command ("interrupted").
- The request returns at once; the thread shows the command as running and then the result (the usual thread update
  event). Exit code, duration, and the folder are shown. Long output (over 12 lines) is collapsed.

## What the agent sees

The command message is stored with the thread (so it is there after a reload) as `kind: "command"`. It is stored as
delivered: it is never delivered as a message of its own and does not start a turn, does not change the thread's status
and does not mark the thread as waiting on the agent.

When the command is done, its result is composed into a `<minbox_user_command>` block and put in front of the **next
message of this thread that is delivered to the agent**, exactly once, like the Linear updates and the fork handoff
(`commandInject`, tied to the carrying message: a retried delivery carries the same text, and marking that message
delivered marks the result as told). The stored body of the carrying message is not changed. The block says it is
information from minbox, not a request; the command and the output are untrusted data (our closing tags are neutralised,
secrets are redacted as in other injected blocks, output is cut at 16 KB). Several commands before one message ride along
together, oldest first.

If the agent is idle and you run a command, nothing is typed to it: it hears of the result with the next message you send in
the thread (the command message says "Agent gets it with your next message", then "Agent has the result"). This was chosen
over a note message of its own, which would start a turn (and cost tokens) for something you only wanted in its context.
If you want it to react at once, add a message after the command.

## Denied commands

When the agent wanted to run a command and you denied it, its message in the thread says so and quotes the command.
The reply suggestions then offer `!<command>` first, so one click (the pencil edits it first) runs it yourself. The server
finds it deterministically (a denial word plus one single-line quoted command, at most 199 characters) and also asks the
helper to do the same; see "Reply suggestions" in [api-contract.md](api-contract.md). minbox has no hook for the agent's permission prompts,
so this relies on the agent saying it in its message.

## Safety

A command runs with your user's permissions, like the terminal. Anyone who can reply in minbox can run commands, so this is
as strong as minbox's sign-in (loopback, or a paired browser): keep minbox on a trusted network.
