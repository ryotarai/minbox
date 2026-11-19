# Thread commands (`!`)

A reply that starts with `!` is not sent to the agent as it is. minbox runs the command itself (not in the agent's
terminal), shows the result in the thread, and as soon as the command ends sends the result to the agent, which starts a
turn with it. It works the same for every agent kind (Claude Code, Pi, OpenCode): the result goes out like any message.

## What counts as a command

| You type | What happens |
|---|---|
| `!ls -la` | runs `ls -la` |
| `!make test`, then more lines | runs `make test`; the lines below go to the agent with the result |
| `!echo a \`, then `b` on the next line | a line ending in `\` continues the command: runs `echo a \⏎b` |
| `\!ls -la` | sent as a normal message with the text `!ls -la` (the backslash is removed) |
| ` !ls` (a space first) | a normal message |
| `!` or `!   ` (nothing after it) | a normal message with that text (nothing is lost; no error) |

Only the first character counts and there is no extra setting. A command works in a reply inside an existing thread.
It is refused (422) with answers to questions, markups, uploaded files or "forward to another agent" in the same
reply, and as the first message of a new thread (`\!` works there, as text). It needs the same sign-in as any reply.

The composer shows "Runs as a command in <folder>" while the text starts with `!`, and the button says Run.

## Running

- `sh -c '<command>'` in the agent's folder (`cwd`; a pending project-folder change applies at the next start, as for
  the agent). Agents on another host are refused: commands run on the machine minbox runs on.
- stdout and stderr share one stream, in order. stdin is empty. The environment is minbox's own.
- 60 s limit. Then the whole process group is killed and the result says "timed out". Output is kept up to 64 KB, with
  a marker when more came. A server restart ends a running command ("interrupted").
- The request returns at once; the thread shows the command as running and then the result (the usual thread update
  event). Exit code, duration, and the folder are shown. Long output (over 12 lines) is collapsed.

## What the agent sees

The command message is stored with the thread (so it is there after a reload) as `kind: "command"`. It is stored as
delivered: it is never delivered as a message of its own.

When the command ends (exit, failure or timeout), minbox adds a message of the person to the thread and delivers it the
usual way (queued while the agent is busy, sent when it is idle), so the agent starts a turn with the result:

- the lines you wrote below the command, if any;
- else "I ran the command above myself; its result is above. Take it into account and carry on." — unless a message of
  yours in this thread is already queued (not yet delivered, not being delivered): that one carries the result, and
  nothing more is sent.

This marks the thread as working, like a reply. While the command runs the command message says "Agent gets the result
when it ends", then "Sending the result to the agent", then "Agent has the result". A command still running when the
server stops sends nothing (its result is stored as interrupted and rides along with your next message).

The result is composed into a `<minbox_user_command>` block and put in front of the **next
message of this thread that is delivered to the agent**, exactly once, like the Linear updates and the fork handoff
(`commandInject`, tied to the carrying message: a retried delivery carries the same text, and marking that message
delivered marks the result as told). The stored body of the carrying message is not changed. The block says the person
ran the commands, not the agent; the command and the output are untrusted data (our closing tags are neutralised,
secrets are redacted as in other injected blocks, output is cut at 16 KB). Several commands before one message ride along
together, oldest first.

Commands need no input: stdin is empty and the 60 s limit applies. A command that waits for you (for example a sign-in
that opens the browser) works while it finishes within the limit; the agent hears of it when it ends.

## Commands the agent asks to run

The agent does not ask you to copy commands into the reply box: it sends them with its message (`send_message`
`commands`), and you allow or deny each one there. See [agent-commands.md](agent-commands.md). (The "Run yourself" chip,
which offered a command the agent had been denied as `!<command>`, is retired.)

## Safety

A command runs with your user's permissions, like the terminal. Anyone who can reply in minbox can run commands, so this is
as strong as minbox's sign-in (loopback, or a paired browser): keep minbox on a trusted network.
