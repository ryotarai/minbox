# OpenCode (2.x) as a coding agent

minbox runs [OpenCode](https://opencode.ai) 2.x ("V2") as its third coding agent next to Claude Code and Pi
(docs/agents.md). Only V2 is supported: OpenCode 1.x uses the same `opencode` command but a different plugin API, so
minbox lists it as **unsupported** (Settings → Capabilities says why) and never starts it.

## Using it on this Mac

1. Install OpenCode 2 if `opencode --version` does not print `v2.x`: `curl -fsSL https://opencode.ai/v2/install | bash`
   (or `npm i -g @opencode/cli`, or `brew install anomalyco/tap/opencode-v2`). It lands in `~/.opencode/bin`.
2. Log in / pick a model the usual way (`opencode` once, or `opencode auth`). minbox uses your OpenCode login, models,
   configuration and session list as they are; it never edits `~/.config/opencode` or the database.
3. Make sure the minbox server finds it: `opencode` on the server's `PATH`, or `minbox start --opencode ~/.opencode/bin/opencode`
   (`MINBOX_OPENCODE`). Extra TUI flags go in the command: `--opencode "opencode --model anthropic/claude-sonnet-4-5"`.
4. `make build && ./bin/minbox restart`. Settings → Capabilities shows `installed · 2.x.y`; New session offers
   **Start OpenCode** (with more than one agent installed, pick OpenCode in the dialog, or make it the default there or per project).

## How it runs

| | |
| --- | --- |
| Command line | `opencode [your flags] --standalone --auto --session <ses_…>` in the session's folder, in the PTY |
| Integration | `plugin/opencode` (a V2 server plugin, `index.ts` + `minbox.ts`), extracted to `<data dir>/opencode-plugin/<hash>/opencode/` and loaded through `OPENCODE_CONFIG_CONTENT={"plugins":[{"package":"<that folder>"}]}` (merged into an `OPENCODE_CONFIG_CONTENT` you set yourself if it is plain JSON) |
| Environment | `MINBOX_TOKEN`, `MINBOX_SERVER_FILE`, `MINBOX_SESSION_ID` as for every agent, plus `MINBOX_OPENCODE_SESSION` (the session id) and `MINBOX_OPENCODE_DIR` (its folder) |
| Tool names | `minbox_send_message`, `minbox_read_thread`, … (the server's tool set, `GET /api/agent/tools`, mod protocol 1: docs/mod-protocol.md), added as direct tools (`options.codemode: false`) by a `tool.transform` callback that reads the current set; a changed set calls `ctx.tool.reload()` |
| Instructions | from the plugin's hello answer, added by the `context` session hook to the system prompt of every model request of the minbox session (not of subagent children); this survives compaction. OpenCode reads `AGENTS.md` (not `CLAUDE.md`) on its own |
| Conversation id | chosen by minbox in OpenCode's format (`ses_` + 12 hex + 14 base62, newest first like OpenCode's own); minbox **creates the session before the TUI starts** (`opencode api --standalone session.create` with that id), because the TUI shows a session given with `--session` only if it exists at startup |
| Busy / idle | `session.execution.started` → working; `…succeeded/failed/interrupted` → idle (event subscription), plus the 120 s stale rule |
| Delivery | long poll on `/api/agent/pending?proto=1` (each message with the server's text to inject), claim, `ctx.session.prompt({sessionID, text, delivery: "steer", metadata: {minbox: true}})`, delivered / release: the same protocol as the Pi extension. While a turn runs only urgent messages (Send now, or queued over 5 minutes) go in; OpenCode adds a steered message at the next step |
| Heartbeat | every 15 s, `agent: "opencode"`, `info.opencode_version`, the plugin's event log: `/api/sessions/{id}/connection` and `modconn:` lines work as for the others |
| Title | `minbox_set_session_title` sets minbox's title and renames the OpenCode session (`ctx.session.update`) |
| Permissions | `--auto` (approve what is not explicitly denied, like Pi's "no prompts"). The plugin's `permission` hook denies shell commands that open a page on the host (`open URL`, `gh … --web`; the agent is told to use `minbox_open_url`) and OpenCode's `question` tool in the minbox session (the person answers in minbox) |
| Subagents | OpenCode's own `subagent` tool (`general`, `explore`, `background: true`); the orchestrator prompt applies, plus a short OpenCode section (`OpenCodeSubagentPrompt`) with the per-thread guidance and worktrees via `tools.opencode.worktree_create` |
| Folder change | OpenCode sessions can move: the conversation id stays and the plugin moves the session to `MINBOX_OPENCODE_DIR` at startup (`ctx.session.move`); no "moved" note |
| Remote hosts | yes: OpenCode 2 on that machine; the host has its own copy of the plugin and runs the CLI calls (see below) |

The plugin runs in OpenCode's private server process (`--standalone`; the shared background service on
127.0.0.1:49374 would not see the session's environment). OpenCode loads a plugin once per location (folder) the
server touches, so its setup can run more than once in one process: tools and hooks are registered per location, the
delivery loop is one per process (`globalThis`).

`/new` in the TUI: the plugin follows the next top-level session the person prompts in (not subagent children, not its own
deliveries) and reports it in a hello, so minbox opens that one after a restart, as with Pi.

## Helper runs

Reply suggestions and the Slack project pick use OpenCode **only when neither Claude Code nor Pi is installed** (even
when OpenCode is the default agent). The run is
`opencode run --standalone --format json --agent minbox-helper --title "minbox helper" [--model M]` with the prompt
on stdin in an empty temp folder; `OPENCODE_CONFIG_CONTENT` defines the hidden `minbox-helper` agent (its `system` is the
helper's prompt plus the JSON schema, its permissions deny every tool, so the model gets no tools). `--title` skips the
title model call. The answer is the `text` parts of the JSON lines, read leniently (`jsonObjectIn`, as for Pi). The run leaves a
session in your list, so minbox deletes it afterwards (`opencode session delete --standalone <id>`, best effort).
`MINBOX_OPENCODE_HELPER_MODEL` (provider/model) picks the model; otherwise OpenCode's default.

## Verified (OpenCode 2.1.4, isolated environment, mock model)

Every check ran with `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` in a temp folder,
`OPENCODE_DB` there, `--standalone`, and a local OpenAI-compatible mock (`plugin/opencode/test/mock-openai.mjs`)
configured as an OpenCode provider (`providers.mock`, `@opencode/ai/providers/openai-compatible`). No real provider.

* A `plugins` entry of `OPENCODE_CONFIG_CONTENT` with an absolute folder loads `<folder>/index.ts` next to the global
  configuration (the global provider still worked). A plain `{id, setup}` export works; `@opencode/plugin` is not needed.
* The CLI's environment reaches plugins in the `--standalone` server (it is a child, `serve --stdio`).
* `ctx.app.version` is `2.1.4`; `ctx.session` has `create/get/prompt/interrupt/update/move/wait/…`.
* Plugin tools are Code Mode tools by default (only reachable through the `execute` tool); with
  `options: {codemode: false}` they are direct tools named as given (`minbox_send_message`), and the model's call reached
  `execute(input, context)` with `context.sessionID`.
* `session.hook("context")` + `event.system.push({type: "text", text})` reaches the system prompt of the request.
* `ctx.session.prompt` into an idle session starts a turn; a second `prompt` while the first runs is taken into the same
  execution (steer). `interrupt` ends it (`session.execution.interrupted`).
* Events: `session.execution.started/succeeded/interrupted`, `session.step.*`, `session.inbox.*`, `session.moved`,
  `session.renamed` (there was no `session.status` event).
* `--session <id>` with a new id: `opencode run` creates it with that id; the **TUI does not** (it shows its home screen and
  turns started by the plugin do not appear, even when the plugin creates the session in `setup`). With an existing
  session the TUI shows the plugin's turns live. Hence the creation by minbox before the start.
  `opencode api --standalone session.get|session.create` work (`create` takes `id` and `location`); a missing session is
  exit 1 with `SessionNotFoundError`.
* `ctx.session.move` moves a session (new project id, `session.moved`); the TUI started in the new folder with that
  session runs it there. `session.move` through `opencode api --standalone` returned 204 but did **not** move it (the move
  happens at a delivery boundary, after the short-lived server is gone), so the plugin does it.
* The permission hook gets `{action: "shell", resources: [command]}`; `effect = "deny"` with a `message` reaches the model as
  `permission.rejected` with that message, also under `--auto`.
* Plugin `setup` runs once per location: a session in another folder loaded the plugin a second time in the same process.
* `run --format json` prints JSON lines (`step_start`, `tool_use`, `step_finish`, `text` with `part.text`); it reads stdin
  (appended to a positional message, or alone); an agent from `OPENCODE_CONFIG_CONTENT` with `system` and deny-all
  `permissions` gets no tools; `--title` skips the title request. `session delete --standalone <id>` deletes.
  `run` waits on stdin when it is an open pipe: minbox always gives it the prompt and closes it.
* `session import` refuses an existing id ("Session already exists") — not used in the end.
* End to end with the real minbox binary (own data dir and port) and the real OpenCode TUI in its PTY: the session was
  created before the start, the plugin's hello and heartbeat arrived (`connected`, `agent=opencode`), a new thread was
  delivered as a turn, the mock model called `minbox_send_message` and the reply appeared in the thread; the title tool
  renamed both; Send now during a long turn went in as a steer and the status went working → idle; a shell
  `open https://…` was denied with minbox's message; after changing the project's folder a restart moved the session and the
  next turn ran in the new folder.

## Not verified

1. A real model (does it follow the instructions, use `minbox_send_message` for every inbox answer, use subagents per
   thread with `background: true`, create worktrees through Code Mode).
2. OpenCode 1.x: the version check is from `--version` output formats (V2 prints `opencode v2.1.4`; a bare `1.x.y` or any
   major below 2 is unsupported); no V1 was installed. Versions after 2.1.4: the plugin API is young and may change; the
   plugin checks the major version only and logs what it cannot register.
3. Whether the person is typing in the TUI: OpenCode has no event for it. The plugin treats a prompt the person submits as
   "their turn first" (2 s) and otherwise delivers into an idle session; text half-typed in the TUI's box stays there.
4. `ctx.session.create` fallback (when minbox's creation failed) creates the session, but the TUI then shows its home screen
   until the session is restarted (see above).
5. Browser-open blocking covers the shell tool only (the permission hook); a tool that opens pages some other way is not seen.
6. Performance: every start runs `opencode api --standalone session.get` (and `session.create` for a new session), each
   starting a private server (~0.3–1 s).
7. Compaction and long sessions; `/new` following was tested with the fake context only.

## Remote hosts

OpenCode sessions run on remote hosts (docs/agents.md, "Remote hosts", has the common design):

* `sessionManager.openCodeRunner(hostID)` is `runnerOn(hostID)`: on another host `opencode api --standalone session.get|create`
  run there through the host's `POST /exec` (in the session's folder, with the host's environment), so the session is created
  in that machine's OpenCode database before the TUI starts. `conversationExists` asks the same way.
* The plugin folder is the host's own (`<host data dir>/opencode-plugin/<hash>/opencode`): the server's environment carries
  `OPENCODE_CONFIG_CONTENT={"plugins":[{"package":"{{MINBOX_OPENCODE_PLUGIN}}"}]}`; the host fills in the path and merges the
  entry into an `OPENCODE_CONFIG_CONTENT` of its own environment (the person's configuration there is kept).
* The version check is per host (`opencode --version` there, through the host); a 1.x there is listed as unsupported for that
  host and refused with its reason. Settings → Hosts and New session show each host's.
* Helper runs stay on the server's machine.
* The plugin needed nothing new: it reads `MINBOX_SERVER_FILE`, which is the host's relay file.

Verified with the fake opencode and a second `minbox host --listen` on the same machine (Go test and e2e). Not verified: a real
OpenCode on a real second machine.

## Tests

* `node --test plugin/opencode/*.test.ts` (`make test-opencode`): the plugin against a fake plugin context and a scripted
  minbox server (tools, hello and instructions, create/move, busy/idle events, delivery and steer, release on failure, `/new`
  following, permission hook, heartbeat, V1 refusal).
* `internal/agent/opencode_test.go` (argv, env and config merge, ids, helper argv/env/normalize/cleanup, version support,
  session ensure with a fake runner) and `internal/server/opencode_test.go` (spawn with a fake `opencode` executable,
  restart, hello instructions, V1 refusal, relocation keeps the conversation, helpers only as the last resort).
* `web/e2e/opencode.spec.ts` with `web/e2e/fake-opencode.py`.
* Manual check against a real OpenCode, isolated: start `node plugin/opencode/test/mock-openai.mjs` (PORT, MOCK_LOG; a user
  text `CALL <tool> <json>` makes it call a tool, `$THREAD` becomes the delivered thread id, `SLEEP<ms>` makes a slow turn),
  point an isolated OpenCode config at it, and start minbox with `--data-dir <temp> --addr 127.0.0.1:<port> --opencode <wrapper>`
  where the wrapper sets `HOME`, `XDG_*` and `OPENCODE_DB` to a temp folder before `exec opencode "$@"`.
