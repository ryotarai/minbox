# The mod protocol

How the integrations inside the coding agents (the Claude Code mod in `plugin/minbox`, the Pi
extension in `plugin/pi`, the OpenCode plugin in `plugin/opencode`) talk to the minbox server, and
why they are thin.

A running session keeps the integration it started with (each version is extracted into its own
content-hash folder, `plugin/embed.go`). When the integration carried wording and decisions (the text
of a delivered message, tool descriptions, "you did not reply with send_message" reminders), every
change to them left running sessions on the old behaviour until they were restarted: old wake text
with `thread_id`, an old tool contract. Since **protocol 1** the integrations are proxies: the server
owns every word the agent reads and every decision about it, so new server behaviour reaches running
sessions at once. Only a change to the protocol itself needs a restart, and the UI says so.

## Versions

| protocol | integrations | what they call |
| --- | --- | --- |
| 0 (absent) | sessions started before this change; `web/e2e/fake-claude.py` | the endpoints below without `?proto`, `/api/agent/messages`, `/title`, `/open`, `/tasks`, `/threads`, `/inbox`, `/projects`, `/sessions`, `/search`, `/status`, `/denied-commands`; they render text themselves |
| 1 | `plugin/minbox/hooks/register.ts`, `plugin/pi/minbox.ts`, `plugin/opencode/minbox.ts` (shared helpers: `plugin/minbox/hooks/proxy.ts`); `fake-pi.py`, `fake-opencode.py` | `GET /api/agent/tools`, `POST /api/agent/tool`, `POST /api/agent/event`, `GET /api/agent/pending?proto=1`, plus hello, heartbeat, claim, release, delivered |

The server keeps serving protocol 0 unchanged (the protocol-1 endpoints call the same handlers
in-process, `agentDo` in `internal/server/modproto.go`, so both see the same behaviour).

An integration reports its protocol in the hello and every heartbeat (`protocol`). The server
answers its own (`protocol`) and the version of the session's tool set (`tools_version`). A session
whose integration reported a protocol below `ModProtocol` is flagged `mod_outdated: true` in
`GET /api/sessions`; the mod-connection badge says "old mod — restart to update" in its title and its
details, which also show `mod_protocol` and
`server_protocol`. Bump `ModProtocol` only when an integration must change to keep working (a new
endpoint it must call, a changed field it reads); new wording, tools or decisions never need a bump.

## Endpoints (protocol 1)

All take the session's bearer token, like every `/api/agent/*` call.

### `GET /api/agent/tools`

```
{ protocol: 1, version: "<12 hex>", tools: [ { name, label?, description, input_schema, deferred } ],
  guards: [ { tools: [hostTool], patterns?: [jsRegExp], deny: text, main_only? } ] }
```

The tool set of the session's agent (`manifestFor` in `modproto.go`): the names the host registers
(Claude Code adds its own `mcp__minbox__` prefix, Pi and OpenCode take `minbox_*` as given), the
descriptions and JSON schemas (`modtext.go`, `modtools_text.go`), Pi's labels, and for Claude Code
which tools wait behind ToolSearch (`deferred`: the navigation tools). `version` is a hash of the whole
answer. `guards` refuse calls of the host's own tools: a shell command matching one of `patterns`
(JavaScript regular expressions: the integration runs them), or any call without patterns
(`main_only`: only in the session minbox started; OpenCode's `question` tool). The deny text is what
the agent reads. Every agent's shell tool has two: a command that opens a page on the host, and
one that runs `minbox pair accept` (anywhere in the command: accepting a pairing is the person's
alone, see "Browser pairing" in api-contract.md).

`plugin/testdata/manifest-<agent>.json` hold the served sets; `TestManifestFixtures` keeps them equal
(`MINBOX_UPDATE_FIXTURES=1 go test ./internal/server -run TestManifestFixtures` rewrites them) and the
node tests of the integrations run against them (the guard patterns included, `plugin/pi/proxy.test.ts`).

### `POST /api/agent/tool {tool, args}`

One tool call: `tool` as registered (a `mcp__minbox__` or `minbox_` prefix is dropped), `args` the
call's input without the host's own keys. Answers `200 {ok: true, text, effects?}` (text is the tool
result) or `200 {ok: false, error}` (error is the refusal the agent reads, e.g. `body is required.` or
`minbox: <the API's error>`). `effects.session_title` asks the host to mirror a new title in its own
list (OpenCode). An HTTP failure means the server could not be reached; the integration then says
`minbox: <error or HTTP status>`.

`send_message` names one task: `task_id` (a message belongs to exactly one task, docs/v3/redesign.md
§13 revision 8). `task_ids`, its older name, is still accepted with one id (a protocol-0 integration
sends it to `/api/agent/messages` as it always did); more than one id is refused with a text that
tells the agent to pick one and send another message for another task. The pending text of the
person's message names its task on one line, `Task: <id> "<title>"`.

`send_message` has no `status` (it used to set the named task's status, which reopened done tasks by
accident): a call that carries a non-empty `status` is refused and nothing is stored or delivered.
Protocol 1 answers `{ok: false, error: "minbox: send_message has no status: a task's status is set with update_task (status working | needs_you | blocked | done). Send the message again without status."}`; protocol 0
(`POST /api/agent/messages`) answers 400 with that text as `error`. An older integration whose schema
still offers `status` gets the text and sends the message again without it. A task's status is set
with `update_task`.

### `POST /api/agent/event {type, ...}`

What happened in the agent; the answer says what to do.

| type | fields | answer |
| --- | --- | --- |
| `turn.start` | | status working |
| `turn.complete` | `reason`, `aborted`, `answer` (Claude Code; Pi and OpenCode send none) | status idle; `submit_when_idle: text` when the turn handled the person's message without `send_message`, or asked the person in the chat only (Claude Code). The integration submits it once the agent is idle; the person typing first drops it. |
| `turn.error` | `error`: the API error's class (`model_not_found`, `authentication_failed`, `rate_limit`, ...; Claude Code's StopFailure) | `ok`; the agent shows as stuck ("error") until a turn completes normally or it posts a message. A `turn.complete` with `reason: "error"` (or an answer that is only "API Error: ...") does the same without the class. |
| `session.end` | | the conversation's state starts over (`/clear`, resume); status idle |
| `session.compact` | | the next prompt carries the open threads |
| `prompt` | `origin` (`composer`: the person typed) | `context: [text]`: the standing instructions on the first prompt of a conversation, after a hello, after a compaction (with the open threads) and every 20th prompt (`MINBOX_ORCHESTRATOR_EVERY` on the server overrides); else `[]` |
| `bash` | (anything) | accepted and ignored: integrations of before the "Run yourself" offer was retired report shell call outcomes; current ones send none (agents ask the person to run commands with `send_message` `commands`, docs/agent-commands.md) |


### `GET /api/agent/pending?owner=&wait=&proto=1`

```
{ protocol: 1, items: [ { ...the pending message, text } ], joiner: "\n\n---\n\n" }
```

`text` is what the integration injects for the message, verbatim (`wakeText` in `modtext.go`); several
messages delivered in one turn are joined with `joiner`. Claim, release and delivered are unchanged; a
delivered mark also tells the server which threads the next turn answers.

## What stays in the integrations

Transport and host plumbing only: reading the server file, timeouts and retries, the long poll and
the claim / submit / acknowledge sequence (with its guards against double delivery), when the agent
counts as idle or busy (host events, the stale-busy fallback), the heartbeat and the integration's
own event log, following a new conversation (`/clear`, Pi's `/new`, OpenCode's new session) with a
hello, OpenCode's session create / move, and the few toasts about the connection itself (shown when the
server cannot be reached, so they cannot come from it).

## Changing tools at runtime: what each host allows

When a heartbeat answers a `tools_version` other than the one registered, the integration fetches
`GET /api/agent/tools` again and registers the set again. What the hosts allow:

- **Claude Code** (mod API, checked against the types of Claude Code 2.1.3xx,
  `claude-code.d.ts`): `$.tool.register(spec)` "declares a tool the model can call from the next prompt
  on … a name registered again is replaced. Rejects until the session binds, at `session.start`." So
  new tools and new descriptions or schemas can be registered at any time after `session.start`. Limits:
  there is no way to remove a tool (a tool the server dropped stays listed and the server answers
  `minbox: unknown tool`); a changed description of a tool the conversation already sent may only reach
  the model with a new conversation or a compaction (the `tool.describe` docs: "a changed answer for a
  tool a thread has sent waits for a new thread or a compaction, unless it carries `breakPromptCache:
  true`"). Calls are served by one `tool.call` hook without a matcher, which answers the tools the
  server named (by the full names `register` returned) and passes the rest on, so a new tool needs no
  new hook.
- **Pi** (1.4, `docs/extensions.md` of `@earendil-works/pi-coding-agent`): `pi.registerTool` works after
  startup (the `dynamic-tools.ts` example registers from `session_start` and from a command); registering
  a name again replaces it; "tools cannot be unregistered", but "re-register a tool with `exposure:
  "hidden"` to withdraw it" — the extension does that for tools the server dropped.
- **OpenCode** (2.3.0, read from the plugin runtime embedded in the binary): `ctx.tool.transform(cb)`
  adds a callback to the tool state; the state is rebuilt from scratch by running every callback again
  whenever it is invalidated, which `ctx.tool.reload()` does (OpenCode's own todo and artifact tools use
  the same pattern: a callback that reads live settings, `reload()` when they change). The tool
  definitions are a snapshot of each rebuild, taken when a turn's context is prepared. The plugin's
  callback reads the current set; a changed set calls `reload()` on every location's context.
  `transform` also returns `{dispose}`, and the editor has `remove`.

So all three refresh at runtime; the schemas did not need to be made generic. The remaining limits are
Claude Code's: no removal, and description changes that may wait for the next conversation or
compaction.

## Tests

- Server: `internal/server/modtext_test.go` (the wording: delivered text, tool results, nudges,
  reminders, nav and task text; formerly the integrations' unit tests), `modproto_test.go` (the tool set
  per agent, tool calls through the agent API, turn reminders, prompt context, the orchestration
  block for each agent, shell outcomes, `mod_outdated`, the fixtures).
- Integrations (proxy behaviour only): `plugin/minbox/hooks/register.test.ts` (`claude plugin test`),
  `plugin/pi/minbox.test.ts`, `plugin/pi/proxy.test.ts`, `plugin/opencode/minbox.test.ts`.
- End to end: `web/e2e/fake-claude.py` speaks protocol 0 (every suite that uses it checks that old
  integrations keep working; `mod-connection.spec.ts` checks the "old mod" flag), `fake-pi.py` and
  `fake-opencode.py` speak protocol 1 (`pi.spec.ts`, `opencode.spec.ts`).
