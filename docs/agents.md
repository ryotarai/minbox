# Coding agents: Claude Code and Pi

minbox runs a coding agent in each session's terminal and talks to it through a small integration
loaded into the agent (a mod for Claude Code, an extension for Pi). Two agents are supported; **either
one alone is enough**: minbox starts, shows its UI and runs sessions on a machine that has only Pi
(no `claude` binary), or only Claude Code.

| | Claude Code | Pi |
| --- | --- | --- |
| Package | `claude` (Claude Code with mod support) | `pi`: `@earendil-works/pi-coding-agent` 1.x (Node 22.19+). Not the deprecated `@mariozechner/pi-coding-agent` 0.x |
| Integration | `plugin/minbox` (hooks module), `--plugin-dir` | `plugin/pi/minbox.ts`, `-e` |
| Command (flag / env / default) | `--claude` / `MINBOX_CLAUDE` / `claude` | `--pi` / `MINBOX_PI` / `pi` |
| Tool names the agent sees | `mcp__minbox__send_message`, … | `minbox_send_message`, … |
| Subagents / orchestrator prompt | yes | no (the orchestrator prompt is never added) |
| Conversation id | chosen by minbox, `--session-id`, later `--resume` | chosen by minbox, `--session-id` (create-or-continue) |
| Remote hosts | yes | not yet (this machine only) |
| Permission prompts | none in minbox's setup | none: Pi has no permission system. It runs with your user's permissions. Use a container if you want a boundary |

## How agents are modelled

* `internal/agent` holds the `Agent` interface and the two adapters (`claude.go`, `pi.go`). The server asks
  the adapter for everything that depends on the agent: the command line, the tool-name prefix for the
  instructions text, the "this thread moved folder" note, capabilities, and the headless (one-shot) run.
  Termhost, threads, questions, the pending queue, attachments, Slack and the whole `/api/agent/*`
  API do not know the agent kind.
* A session has an agent: `sessions.agent` (`claude` | `pi`; `kind` still says `claude` | `shell`, and a Pi
  session has `kind: "claude"`, i.e. "a session with the inbox"). Existing rows get `claude` by migration.
  The columns `claude_session_id` / `prev_claude_session_id` / `prev_chain` and the API keys with those
  names keep their names; they hold the agent's conversation id whatever the agent is.
* A project has an optional default: `projects.default_agent` (`""` follows the setting).
* The agent of a new session is, in order: the request's `agent`, the project's `default_agent`, the
  `default_agent` setting, then `Commands.Choose`: Claude Code if it is installed, else the installed one
  (so on a Pi-only machine the default is Pi). "Installed" means the first word of the configured
  command is found on `PATH`; minbox never runs the agent to find out.
* `GET /api/agents` lists both with `installed`, `command`, `path`, capabilities and the effective
  `default`. The UI shows an agent picker in New session only when more than one is installed, a
  "Coding agents" block in Settings → Capabilities, and a small "Pi" tag on Pi sessions.
* **One instruction text.** `buildInstructions` in `internal/server/sessions.go` is written once with
  Claude Code's tool names (`mcp__minbox__send_message`); `buildInstructionsFor(agent, …)` swaps the prefix
  for the agent's (`minbox_`) and leaves out the orchestrator block when the agent has no subagents. The
  command line (`--append-system-prompt`) and the hello answer carry the same text. For Claude Code the
  result is byte-identical to before.

## Nothing needs `claude`

* Startup, `GET /api/agents`, `/api/about`, the UI and creating a Pi session never run or require `claude`.
* **Helper runs** (reply suggestions, picking the project of a Slack DM) used to call `claude -p`. They now go
  through `helperPlan` in `internal/server/suggest.go`: `MINBOX_SUGGEST_COMMAND` (a Claude-format helper,
  used by the tests) wins; otherwise the default agent runs the helper; if it is not installed the other one does;
  if neither is, the error is `agent.ErrNoneInstalled`: the suggestions endpoint answers
  `{"suggestions": [], "reason": "no_agent"}` and a Slack DM falls back to the fallback project. Never a crash.
* Claude's helper is unchanged (`claude -p … --json-schema`, Haiku). Pi's is
  `pi --print --offline --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes --system-prompt <system + schema> [--model M] "<answer in JSON>"`
  with the prompt on stdin, run in an empty temp directory. **Pi cannot enforce a JSON Schema**, so the
  schema is repeated in the system prompt and the answer is read leniently (`agent.jsonObjectIn`: the whole
  output, a fenced block, or the first parsable `{…}`). The existing validation stays: the Slack pick
  only accepts an id of an existing project, suggestions are trimmed, deduplicated and capped.
  The model of Pi's helper is Pi's own default unless `MINBOX_PI_HELPER_MODEL` is set (for example
  `anthropic/claude-haiku-5-5`); the Claude-only `MINBOX_PICK_MODEL` does not apply to it.

## Pi specifics

* **Launch**: `pi [your flags] -e <data dir>/pi-extension/<hash>/pi/minbox.ts --session-id <uuid>
  --append-system-prompt <instructions>` in the session's folder, in the PTY, as an interactive TUI (not RPC).
  Put model/provider options in the command: `--pi "pi --model anthropic/sonnet:high"`; otherwise Pi's own
  configuration decides. minbox also does not touch `~/.pi`.
* **Project notes**: Pi reads `AGENTS.md` and `CLAUDE.md` from the folder upwards (minbox does not pass
  `-nc`). They are the project's own notes; the Claude-specific parts of a `CLAUDE.md` (mod names, subagent rules)
  can confuse Pi, so keep such parts in a form Pi can ignore. The helper runs use `--no-context-files`.
* **Resume**: `--session-id <uuid>` opens the conversation of that id in the folder's session directory
  and creates it if missing (`Warning: No project session found with id …; creating a new session with that id`).
  So a new and a resumed session have the same command line. minbox logs whether the session file exists.
  The extension reports the id and file in its hello at every session start; `/new` or `/resume` inside Pi restart the
  extension, so minbox follows to the new id.
* **Folder change**: like Claude Code, Pi keeps conversations per folder
  (`<agent dir>/sessions/--<path with / \ : as ->--/<timestamp>_<id>.jsonl`). When a project's folder changes and
  the old conversation has a file, the session starts a fresh conversation in the new folder and the instructions say
  where the old session file is (`agent.pi.RelocationNote`). Resuming the old file across folders with
  `--session <path>` might work in Pi but is **not verified**; it would be better than a new conversation.
* **Extension** (`plugin/pi/minbox.ts`, loaded by Pi's jiti, no build): tools `minbox_send_message`,
  `minbox_read_thread`, `minbox_set_session_title`, `minbox_open_url`, `minbox_card` (same descriptions and schemas as
  the mod; shared `plugin/minbox/hooks/text.ts`); `tool_call` blocks Bash commands that open a page on the host;
  `agent_start` / `agent_settled` set the session working / idle; a long poll on `/api/agent/pending`
  claims the person's messages once Pi has been idle for 2 s and the person is not typing, delivers them with
  `pi.sendUserMessage` and marks them delivered (a failed delivery releases the claim); an urgent message
  (Send now) is delivered into a running turn with `deliverAs: "steer"`.
  Not in the Pi extension yet (planned Phase 2): the reminder when a turn asks the person only in the chat,
  the open-threads reminder after a compaction, mod-silent parity, remote hosts, completions.
* **Instructions** reach Pi once, on the command line, because Pi keeps its system prompt through
  compactions. The Claude mod's periodic re-injection is not used.
* **Tests**: `node --test plugin/pi/minbox.test.ts` (mock ExtensionAPI and a scripted server; `make test-pi`),
  `internal/agent` and `internal/server/agents_test.go` (argv, env, resume, relocation, helpers, no-`claude` PATH),
  `web/e2e/pi.spec.ts` with `web/e2e/fake-pi.py`.

## Verified against a real Pi 1.4.0 (offline, no model)

* `pi --help` has `-e`, `--session-id` ("creating it if missing"), `--append-system-prompt`, `--print`, `--offline`,
  `--no-tools`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-context-files`, `--no-themes`, `--system-prompt`.
* The extension loads in the interactive TUI (listed under `[Extensions]`), its plain-JSON-Schema tool definitions are
  accepted, `session_start` fires with `ctx.sessionManager.getSessionId()` equal to the `--session-id` we passed and a
  session file path of the documented layout, and the extension's HTTP calls (hello, status, claim, delivered) reach the server.
* `pi.sendUserMessage` from the polling loop into the idle TUI starts a turn: with no API key Pi answered
  `error: No API key found for the selected model`, after the extension had marked the message delivered.
* The session directory name rule and `findById` behaviour were read from Pi's code.

## NOT verified (needs a real Pi with a model and credentials)

1. A full turn after a delivered inbox message, and that Pi then calls `minbox_send_message` with the reply
   (depends on the model following the instructions).
2. The tools' behaviour when the model calls them (schema coercion with the real validator, error display when `execute` throws).
   The schemas are plain JSON Schema (Pi's validator accepts non-TypeBox schemas) but a model call was never made.
3. `deliverAs: "steer"` into a running turn, `agent_settled` timing after retries and compaction, and that
   `ctx.isIdle()` is accurate during `before_agent_start`.
4. `pi -p` with the prompt on stdin plus a positional message for the helper runs, `--offline` not disabling inference,
   and the quality of Pi's JSON answers (a model that wraps JSON in prose is handled; one that answers without JSON makes the
   helper fail, which turns the feature off for that call).
5. `--session <path>` across folders (see above), and Pi 1.5+ (tested with 1.4.0; the proposal's notes were for 1.5.1).
6. Pi on a remote host: refused with a clear message. Not designed yet (needs Pi, Node 22.19+ and the extension path on that host).

## How to add an agent

1. Implement `agent.Agent` in `internal/agent/<name>.go`: `Kind`, `Label`, `Tools` (the prefix), `Caps`, `Argv`,
   `RelocationNote`, `Headless`; register the kind in `For` and `Kinds` (the order is the preference order).
2. Write the integration (the thing loaded into the agent) against `/api/agent/*`: hello (`agent`, `agent_session_id`),
   status, pending → claim → delivered/release, messages, title, open, threads, cards. Reuse
   `plugin/minbox/hooks/text.ts` for the wording; embed the files in `plugin/embed.go` like `ExtractPi`.
3. Add its command to `Config`, `agent.Commands`, `cmd/minbox/main.go` (flag + env) and `sessionManager.argv`.
4. If its conversations are stored per folder, teach `conversationExists` where they are.
5. Add the kind to `web/src/api.ts` (`AgentKind`) and `AgentTag`; the pickers read `GET /api/agents`.
6. Tests: an adapter table test, a server test with a fake executable on `PATH`, a fake agent for Playwright.
