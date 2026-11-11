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
  `minbox_read_thread`, `minbox_set_session_title`, `minbox_open_url`, `minbox_card` and the read-only navigation tools
  `minbox_list_projects`, `minbox_get_project`, `minbox_list_sessions`, `minbox_list_threads`, `minbox_search` (same descriptions
  and schemas as the mod; shared `plugin/minbox/hooks/text.ts` and `nav.ts`); `tool_call` blocks Bash commands that open a page on the host;
  `agent_start` / `agent_settled` set the session working / idle; a long poll on `/api/agent/pending`
  claims the person's messages once Pi has been idle for 2 s and the person is not typing, delivers them with
  `pi.sendUserMessage` and marks them delivered (a failed delivery releases the claim); an urgent message
  (Send now) is delivered into a running turn with `deliverAs: "steer"`.
  Not in the Pi extension yet (planned Phase 2): the reminder when a turn asks the person only in the chat,
  the open-threads reminder after a compaction, mod-silent parity, remote hosts, completions.
* **Instructions** reach Pi once, on the command line, because Pi keeps its system prompt through
  compactions. The Claude mod's periodic re-injection is not used.
* **Subagents**: see "Pi subagents" below (`plugin/pi/subagent.ts`, second `-e`).
* **Tests**: `node --test plugin/pi/*.test.ts` (mock ExtensionAPI and a scripted server; `make test-pi`),
  `internal/agent` and `internal/server/agents_test.go` (argv, env, resume, relocation, helpers, no-`claude` PATH),
  `web/e2e/pi.spec.ts` with `web/e2e/fake-pi.py`.

## Pi subagents (`minbox_subagent`)

Pi has no Task tool, so minbox ships one as a second extension, `plugin/pi/subagent.ts`, loaded next to `minbox.ts`
(`pi -e …/pi/minbox.ts -e …/pi/subagent.ts`; `agent.ArgvReq.ExtraExtensions`). It is based on Pi's bundled example
(`examples/extensions/subagent`). The Pi instructions get a short `# minbox: subagents` section
(`server.PiSubagentPrompt`, built in `buildInstructionsFor`; Claude's text is unchanged).
It also tells Pi that a session may receive messages from several minbox threads: independent work of different
threads goes to one `minbox_subagent` task per thread, run in parallel, each task naming its thread id. The main agent stays
the coordinator and reports each result with `minbox_send_message` in the matching thread; `write: true` only for a thread
that needs edits.

**How it works.** `minbox_subagent({tasks: [{task, role?, model?, thinking?, tools?, cwd?, write?, context?}], max_concurrency?})`
starts one child process per task: `pi --mode json -p --no-session -ne -nc --offline --tools <list> [--model] [--thinking]
[--append-system-prompt <role file>] "Task: …"` (same Pi binary as the parent: `process.execPath` + `process.argv[1]`).
The parent reads the child's JSON lines (`message_end`, `tool_result_end`) for the answer and the usage; the result
text has one section per task, `details` has per-child status, output, usage, model, tools, cwd and worktree, and the
summed usage. Children inherit the parent's model and thinking level unless the role or task sets them.

* **Roles** are markdown files with `name`, `description`, `tools`, `model` frontmatter: `scout`, `planner`,
  `reviewer` (read-only) and `worker` ship in `plugin/pi/agents/`; `~/.pi/agent/agents/*.md` and the nearest
  `.pi/agents/*.md` of the folder add or replace roles (project over user over shipped). A project role is a prompt from the
  repository: it changes what the child is told, never what it is allowed to do (the tool filter below applies to it too).
* **Isolation of the child**: `-ne` (no extension, so no `minbox_*` tools and no recursion), `-nc` (no `AGENTS.md` /
  `CLAUDE.md`; `context: true` loads them), `--offline` (startup network operations only; the helper runs already use it
  with inference working), and an environment without `MINBOX_*` (token, server file, …) and `PI_SESSION_*`.
* **Limits**: 8 tasks per call, 4 at a time (`max_concurrency` lowers it), 10 minutes per child
  (`MINBOX_SUBAGENT_TIMEOUT_MS`), 40 KB of output per child (cut on a character boundary, with a note). Abort (the tool's
  signal), timeout, and Pi shutting down send SIGTERM, then SIGKILL after 5 s; the parent's exit kills any child left.
* **Working / idle**: a long run must not look like an idle Pi to `minbox.ts` (it gives up on a busy turn after 120 s
  with no event). `subagent.ts` sends a partial result on every child event and every 15 s (Pi emits
  `tool_execution_update`, which `minbox.ts` counts as life) and bumps a shared counter (`plugin/pi/busy.ts`, on `globalThis`
  under `Symbol.for('minbox.pi.busy')`) that `minbox.ts` also checks.

**Writing children and worktrees.** Without `write: true` a child gets `read,grep,find,ls`; `edit`, `write` and `bash` are
dropped from any list (the task's or the role's) and the result says so. With `write: true` it gets `read,grep,find,ls,edit,write,bash`
(or the role's/task's list) **only inside a git worktree**:

1. `git rev-parse --show-toplevel` in the task's folder; outside a repository (or in one with no commit) the task fails with a
   clear error and nothing runs. The user's checkout is only read, never written, and the child never runs in it.
2. `git worktree add -b minbox-sub/<id> <root>/<repo>-<id> <HEAD of the task folder>`; `<root>` is `$MINBOX_SUBAGENT_DIR`, else
   `<tmp>/minbox-subagents`. Uncommitted changes of the main checkout are therefore NOT in the child's copy. The child's cwd is the
   same sub-folder inside the worktree.
3. When the child ends (done, failed, timeout, abort): if it changed anything, **the changes are committed on the branch**
   (`git add -A`; `git commit --no-verify`, author `minbox-subagent`; commits the child made itself count too) and the worktree is
   kept. The result gives branch, path, commit, base and diffstat. If nothing changed, the worktree and the branch are removed.
4. The main agent reviews and merges: `git diff <base>..minbox-sub/<id>`, `git merge minbox-sub/<id>` (or cherry-pick), then
   `git worktree remove <path> && git branch -d minbox-sub/<id>`. Kept worktrees are never removed by minbox; list leftovers with
   `git worktree list` / `git branch --list 'minbox-sub/*'`, and `git worktree prune` after deleting a folder by hand. If Pi itself is
   killed hard (SIGKILL) a running child is not tracked any more and its worktree stays uncommitted: look in `<root>`.

**Safety, honestly.** Pi has no permission prompts. A child with `write: true` has `bash` and runs as the user: the worktree keeps its
file edits away from your checkout, but nothing stops a command that deliberately goes elsewhere (`cd /`, `git -C <main> …`, network,
`~`). Read-only children cannot change anything through tools, but can read any file the user can. Treat `write: true` like giving a
colleague a shell; there is no sandbox. Risks to know: cost (8 children at once, each with its own context, billed separately; the
result shows summed tokens and cost), merge conflicts between parallel writers (the main agent resolves them when merging), and
prompt injection through what a child reads, which the main agent passes on.

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

## Subagents: verified and not

Verified with Pi 1.4.0, offline, without a model: both extensions load together (`[Extensions]` lists `minbox.ts` and
`subagent.ts`, no load error); `minbox_subagent` is in `pi.getAllTools()` and active, with the JSON schema accepted;
`import.meta.url` (shipped roles folder) and `process.argv[1]` (`piInvocation`) resolve inside Pi's jiti; the child command line is accepted
by the real `pi` (it starts, prints the "No API key" error on stderr and exits 1, which the tool reports as an error); `node --test
plugin/pi/subagent.test.ts` drives the real tool code against a fake `pi` and a temp repository (argv, scrubbed env, truncation, worktree
create/commit/remove, refusal outside a repository, 8 tasks at 4 at a time, abort and timeout with SIGTERM then SIGKILL, busy marker).

**Not verified** (needs a real Pi with credentials): a real model run of a child and of the parent calling the tool (does the model
write good briefs and follow the instructions section, and does Pi's schema coercion/rendering of `details` look fine); parallel
and abort behaviour with real children (the fake only simulates SIGTERM handling; whether Pi's own `bash` grandchildren die with a
killed child); the whole worktree merge flow with a real worker; that a long real run keeps minbox's status "working" in the UI
(the 120 s rule is unit-tested with a fake clock only); `--offline` for a child that needs a model catalog refresh.

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
