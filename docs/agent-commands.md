# Commands the agent asks to run

An agent that needs a shell command run (one it was denied, or one that needs the person's say-so) sends it with its
message: `send_message` takes `commands`, a list of `{command, cwd?, description?}`. The person sees a card under the
message with each command and Allow / Deny, plus Allow all / Deny all. Nothing runs until they allow it.

## Sending (`POST /api/agent/messages`, tool `send_message`)

- `commands: [{command, cwd?, description?}]`, at most 20; a command is at most 4000 characters and not empty (else 400,
  nothing stored). `cwd` defaults to the agent's folder; a relative one is taken from there, `~` is the host's home.
- They are stored with the message (`message_commands`, one row each, state `pending`); the answer lists them
  (`commands: [{id, command, cwd, state}]`) and the tool's text tells the agent the results arrive as a new message (do
  not wait or poll).
- The message counts as waiting on the person (v3 `open`, the thread's `need_action`) while a command is pending.
- Notifications (Slack) carry the commands as plain text and say to approve or deny them in minbox: there is no approval
  from Slack.

## Deciding (`POST /api/v3/messages/{id}/commands {allow?: [id], deny?: [id]}`)

- Only the person: the request must come from a paired browser (the guard refuses anything else, and the handler checks
  the device again). The agent's token reaches only `/api/agent/…`, which has no way to decide or run a command.
- The ids must be the message's commands, each named once (400). Each command is decided once: `pending → allowed` or
  `pending → denied`, a guarded change, so a repeated or concurrent request changes nothing. Who decided (the device's
  name) and when are stored.
- What runs is the stored text, never anything from the request.
- An archived agent's commands cannot be allowed (409); a command allowed before the agent was archived does not start.

## Running

- The allowed commands of a message run one after another, in order, one at a time per agent; a failure does not stop
  the rest.
- On the agent's host: `sh -c '<command>'` in its folder. The built-in host runs it in the server's process with minbox's
  cleaned environment (`termhost.CleanEnv`), stdout and stderr together, its process group killed on timeout. Another host
  runs it through its `POST /exec` (cleaned environment there too; stdout, then stderr). A command containing `{{` goes
  base64-encoded to a remote host, which otherwise fills in its own `{{…}}` placeholders.
- 10 minutes at most; the output is kept up to 64 KB (head and tail, with a marker where the middle was cut).
- States: `pending → allowed → running → done` (exit code, timed out, error, output, duration) or `pending → denied`. A
  server restart ends allowed and running ones as interrupted and reports them at the next start.

## The result

When the decided commands are final, minbox adds one message (author the person's side, kind `run_result`) to the agent's
stream, in the task of the commands' message, and it is delivered like the person's replies (not into a running turn:
after it ends). Its Markdown lists each command: its state (exit code and duration, failed, timed out, or denied by the
person), its description and folder, the command in a fenced block and its output (cut to 16 KB, head and tail) in
another. Commands decided later are reported in a later message. The UI shows the exit code and the output (collapsed)
on the card, "Results sent to the agent", and the result message as a small note.
