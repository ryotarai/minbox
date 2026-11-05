# minbox API contract (UI v2)

The browser UI (web/) and the Go server agree on this. Everything that already
exists keeps working; this lists what is added or changed. Times are RFC3339
strings, `null` when unset. JSON field names are snake_case.

## Sections

Thread sections, in this order (also the order of the session list):

| section    | label (UI)            | rule (first match wins)                                                        |
| ---------- | --------------------- | ------------------------------------------------------------------------------ |
| `archived` | Archived              | archived_at set and not came_back                                               |
| `snoozed`  | Snoozed               | snoozed_until > now                                                             |
| `quiet`    | Quiet                 | Mark read stands (marked_read_at >= the latest agent message)                    |
| `stopped`  | Stopped on you        | an open question (or action) carries `Stopped:`                                 |
| `holding`  | Holding up work       | an open question carries `Holds up:`                                            |
| `waiting`  | Waiting on you        | open questions or open actions                                                  |
| `new`      | New since you looked  | unread agent messages                                                           |
| `sent`     | Sent                  | the person wrote last                                                           |
| `quiet`    | Quiet                 | otherwise                                                                       |

Display order: stopped, holding, waiting, sent, new, quiet, snoozed, archived.
Pinned threads sort first inside their section; otherwise newest first.

`came_back`: archived, but an agent message was written after archived_at. Such a
thread is placed by the rules below `archived` while archived_at stays set.

A session's `section` is its top thread's section (the first thread in display
order that is not archived/snoozed); `archived` when the session is archived;
`quiet` with no threads.

## Question blocks (internal/question)

- Context lines starting `Stopped:` set `stopped` (the rest of the line); `Holds up:`
  sets `holds_up` (the rest split on `;` or `,`); `Replaces:` sets `replaces`
  (an earlier question's prompt). The lines stay in `context` too.
- `:::actions` block: each `- [ ] item` becomes a Question with `kind: "action"`,
  `prompt` = item text, `group` = a key shared by the block, choices
  `Done` and `Can't do it`. A line that is not an item is the block's title,
  copied into every item's `context`.
- Compose: action answers go in a `## Actions` section (`- Done: X`,
  `- Can't do it: X`, with ` — note` when there is a note); they are not counted
  in "Answered N questions".

Question JSON adds: `stopped?: string`, `holds_up?: string[]`, `replaces?: string`,
`group?: string`, kind adds `"action"`.

## JSON shapes

Session adds:

```
archived_at: string|null
section: Section
stopped: number      // threads in stopped
holding: number      // threads in holding
undelivered: number  // the person's messages not delivered yet
last_activity: string
top_thread: { id, subject, section, updated_at, last_author, last_delivery?, open_questions, stopped: bool, holds_up: number } | null
```

Thread adds:

```
name: string                 // short thread name tag, '' if none
archived_at, pinned_at, snoozed_until, marked_read_at: string|null
came_back: bool
stopped: bool
holds_up: number             // Holds up items over open questions
open_actions: number
message_count: number
attachment_count: number
last_agent_at: string|null
section: Section (above)
```

Message adds:

```
kind: "message" | "note"          // note: a person's note (re-ask, 👍); not a reply
attachments: Attachment[]         // meta only
annotations: Annotation[]         // on the person's messages
urgent: bool                      // Send now
closed: { [question_key]: "moved_on"|"replaced"|"marked_read"|"archived" }  // agent messages: open questions closed unanswered
```

Attachment:

```
{ id, thread_id, message_id, kind: "file"|"review", name, path, mime, size, created_at }
```

`GET /api/attachments/{id}` adds: `exists: bool`, `changed: bool`, `modified_at`,
`text_sent?: string`, `text_current?: string` (text files up to 2 MB),
`review?: Review`.

`GET /api/attachments/{id}/raw?v=sent|current` serves the bytes.

Review:

```
{ title, summary, additions, deletions,
  sections: [{ title, summary, files: [{ path, additions, deletions, diff }] }] }
```

`diff` is unified diff text (`git diff HEAD -- path` in the session cwd at send
time; an untracked file diffs against /dev/null).

Annotation (sent with a reply, stored on the message):

```
{ kind: "comment"|"region"|"pen", attachment_id?: string, name?: string,
  quote?: string, line?: number, comment: string, image_path?: string }
```

The reply body Claude reads gets a `## Annotations` section:
`- <name> · "quote" (line N): comment` and `Image: <image_path>` when set.

Card (Board):

```
{ id, title, column: "backlog"|"designing"|"look"|"building"|"review"|"shipped"|"icebox"|"dropped",
  note, session_id: string|null, thread_id: string|null,
  pr_url, pr_state: ""|"draft"|"open"|"merged"|"closed", pr_number: number,
  created_by: "agent"|"user", dropped_by: ""|"agent"|"user", position: number,
  created_at, updated_at }
```

Settings (one JSON object; PUT merges top-level keys):

```
{ theme: "system"|"light"|"dark", text_size: 12|13|14|15,
  notifications: bool, sound: bool, tab_count: bool, single_key: bool,
  board: bool, decision_mode: bool, prompt_extra: string,
  list: { highlight_subject: bool, compact: bool, hide_icons: bool, small_names: bool, keep_panel: bool } }
```

Defaults: system, 13, true, true, true, true, false, false, "", {true,false,false,false,false}.

## Browser routes (added)

```
POST  /api/sessions/{id}/archive            409 unless ended
POST  /api/sessions/{id}/unarchive          (restart also unarchives)
POST  /api/sessions/{id}/threads            body adds name
POST  /api/sessions/{id}/files              any file; header X-Filename; → {path}
GET   /api/sessions/{id}/completions        → {agents:[{name,description}], skills:[...], commands:[...]}
                                              from ~/.claude and <cwd>/.claude (agents/*.md, skills/*/SKILL.md, commands/*.md)

PATCH /api/threads/{id}                     {name?, subject?}
POST  /api/threads/{id}/read                (exists) the person looked: agent messages read
POST  /api/threads/{id}/unread              (exists) also clears marked_read_at
POST  /api/threads/{id}/mark-read           set aside: marked_read_at=now, read all, unsnooze
POST  /api/threads/{id}/unmark-read
POST  /api/threads/{id}/archive | /unarchive   (archive also unsnoozes)
POST  /api/threads/{id}/pin | /unpin
POST  /api/threads/{id}/snooze {until} | /unsnooze
POST  /api/threads/{id}/reask               a note asking Claude to ask the open questions again
POST  /api/threads/{id}/reply               body adds annotations, urgent, forward_to (session id: the reply
                                              starts a new thread there instead; → {thread_id, ...}), resume (bool:
                                              restart the ended session after storing). A reply unsnoozes.
POST  /api/messages/{id}/send-now           urgent=true
POST  /api/messages/{id}/cancel             deletes the person's message while it is still queued (not delivered, not
                                              being delivered) so it is never delivered → {ok, thread_id, thread_deleted}
                                              (a thread left empty is deleted too). 409 when delivered already / not
                                              the person's; 404 unknown. Publishes `thread` and `threads` events.

GET   /api/search?q=&session_id=&status=&from=agent|user&limit=
      → {threads: Hit[], messages: Hit[], files: Hit[]}
      Hit: {thread_id, session_id, session_name, subject, message_id?, attachment_id?, name?, author?,
            snippet, archived: bool, section, created_at}
      Case-insensitive; every space-separated word must match (AND); LIKE. threads: subject or name;
      messages: body; files: attachment name or text content. Newest first.

GET/POST /api/cards, PATCH/DELETE /api/cards/{id}
GET/PUT  /api/settings
GET   /api/storage                          {data_dir, db_path, db_bytes, scratch_dir, scratch_bytes, scratch_files}
POST  /api/storage/clear-scratch            {removed}
GET   /api/about                            {version, server_protocol, required_host, host: {protocol, required_server, pid}|null, data_dir}
```

SSE event types: `sessions`, `threads`, `thread`, `cards`, `settings`.

## Mod / agent API (added)

- `send_message` adds `attachments: string[]` (file paths, relative to the session cwd
  allowed; at most 10, 5 MB each), `review: {title, summary, sections:[{title, summary, files: string[]}]}`
  and `name` (thread name for a new thread). The server snapshots files and diffs at send time.
- Pending items add `urgent: bool` (Send now, or queued longer than 5 minutes). The mod
  delivers an urgent item even while Claude is busy.
- `hello` answers `prompt_extra` (settings); the mod appends it to the first-prompt reminder.
- New tool `card` → `GET/POST /api/agent/cards`, `PATCH /api/agent/cards/{id}`;
  403 `the Board is off in minbox settings` unless settings.board.

## Terminal attach

After the replay, and after every resize, the host sends every attached client a
text frame `{"type":"size","cols":N,"rows":M}`. Clients still send `resize` frames.
The PTY takes the smallest of the attached clients' sizes (the `resize` frames) and
returns to its start size when no client is left that sent one.
A `resize` with `"lease":true` is a lease: the host counts it for 15 s and drops it
unless the client sends it again (the web view repeats it every 5 s while the page is
visible and sends it at once when shown again). A `resize` without `lease` never expires
(older clients). A closing connection drops its size at once. When no size is left the
PTY returns to the size it was started with.
A phone view does not send `resize` unless the person asks ("Fit to this screen").

### Companion shell

`GET /api/sessions/{id}/shell/terminal` (WebSocket, same frames as `/terminal`) attaches to a
login shell that belongs to a Claude Code session: same host, started in the session's `cwd`
(the host's `$SHELL -l`, like a `shell` session). It is a second host terminal with id
`<session id>:shell`, started on the first attach and kept running while no client is attached
(a reattach replays its scrollback). If the person exits it, the next attach starts a new one.
It is not a session: it is in no list, status, rail or inbox logic, and its exit changes nothing
on the session. It ends when the session is stopped, ends, is deleted, or its host is removed.
Errors: 400 for a `shell` session, 409 when the session has ended, 503 when the host is away.
No host protocol change (the id is opaque to the host; `RemoteProtocol` is not bumped).

## Attachments v2 (match Plannotator Inbox)

No size or count limits on agent attachments. Refused: folders, non-regular files, the
dotenv family (`/(^|\.)env$/i`, `/^\.envrc$/i`, `/^\.env\./i` except `.env.example`),
checked on the named path and the realpath. One refusal refuses the whole send.
Bytes live in `<data dir>/blobs/<sha256>` (done: internal/server/blobs.go).

Attachment JSON (in `message.attachments`, `message.inline_images`, and the detail route):

```
{ id, thread_id, message_id, author: "agent"|"user",
  kind: "file"|"review",                       // unchanged
  type: "markdown"|"text"|"html"|"mermaid"|"graphviz"|"code"|"image"|"video"|"pdf"|"file",
  name, path /* realpath */, named_path: string|null, mime, size,
  width?, height?, duration_ms?, sent_mtime, created_at,
  inline: bool, ref?: string /* inline image: the src as written in the body */ }
```

Type detection = Plannotator's `decideInboxAttachmentKind` (spec §2): by name first, then
bytes (image magic incl. SVG first element, `%PDF-` in 1024 B, ftyp/EBML video), whole-file
UTF-8-without-NUL test, view bound 16 MiB. Image width/height, video duration/size when parseable.

`GET /api/attachments/{id}` adds: `exists, changed, modified_at, current_size,
unavailable: {code: "attachment_missing"|"attachment_changed_type", message}|null`,
and for text-read types (all but image/video/pdf/file) `text_sent`, `text_current` (≤ 16 MiB).

Routes (all by id; `v=sent|current`, default current):

```
GET  /api/attachments/{id}/raw            text types: text/plain; image: type re-sniffed; video: Range. CSP sandbox, nosniff
GET  /api/attachments/{id}/download       Content-Disposition: attachment (filename*), octet-stream (pdf: application/pdf), Range
GET  /api/attachments/{id}/view           {text, html|null}; html type: html = text with <base href="/api/html-assets/{token}/"> (token per folder)
GET  /api/html-assets/{token}/{path...}   files of that folder; refuses segments starting "." and dotenv names; html docs ≤ 2 MB;
                                           CSP "sandbox allow-scripts allow-modals; connect-src 'none'"
GET  /api/attachments/{id}/markdown-image?path=   image the markdown references, relative to its folder (image rules §5.2)
GET  /api/attachments/{id}/linked?path=   sibling .md/.mdx/.html in the same folder, read-only → {name, path, text, html|null}
POST /api/embeds {html}                   → {id, url}; id = first 32 hex of sha256(html); ≤ 512 KiB; memory, 500 entries / 64 MiB
GET  /api/embeds/{id}                     the built document: BASE_CSS + BOOTSTRAP (+ agent html), CSP verbatim from spec §5.1
GET  /api/messages/{id}/image?path=<ref>  an inline image of that message (captured at send)
POST /api/uploads?name=                   raw body ≤ 100 MB, plain file name, no dotenv → {upload:{upload_id,name,size,type,sha256,created_at,mime,width?,height?}}
GET  /api/uploads/{id}/text               a pending pasted-text upload's words {text}
DELETE /api/uploads/{id}
POST /api/markups                         raw image ≤ 128 MiB → {path (absolute), name, url}; GET /api/markups/{name}
```

Person files: `POST /api/threads/{id}/reply` and `POST /api/sessions/{id}/threads` accept
`uploads: [upload_id]` → copied to `<data dir>/uploads/<att_id>/<name>` (mode 0400) and recorded
as attachments (author user) of the person's message. A reply may be files only. At delivery
the body the agent reads gets `Attached: <name> (<path>)` lines appended (not stored).

Inline images: at agent send, `![](src)` and `<img src>` in the body (not in code; not remote,
data:, blob:) are captured (spec §5.2 rules; relative to the session cwd; ≤ 10 MB / 50 MP;
max 64) as `inline_images` records (inline: true, ref). Failures do not refuse the send;
the result lists `images_not_shown: [{ref, reason}]`.

Agent send result adds `attachments: [{id, name, kind: <type>, path}]` and `images_not_shown`.
The mod's text: `Sent to the minbox inbox with N attachment(s) …` plus the images-not-shown
sentences (spec §5.2). The `attachments` field description follows Plannotator's (spec §1).

Annotations in a reply (`annotations: Annotation[]`):

```
{ kind: "comment"|"region"|"pen"|"video"|"element"|"diagram",
  attachment_id, version: "current"|"sent", name?, quote /* originalText */,
  line_start?, line_end?, time? /* seconds */, comment,
  images?: [{path, name}], region?: {x, y, w, h, natural_w, natural_h} }
```

Composed after answers/actions exactly as spec §4.1 ("# Feedback on the attached files",
one "## <label>" per file and version; label = path relative to the session cwd if inside,
else absolute; " (the version you sent)" for v=sent; entries "### n. (line N|lines A–B)
Feedback on: \"…\"" / "> text" / "**Attached images:**"; video "At m:ss (s.s s of m:ss)";
region "Region: x= y= w= h= (of W×H)"; ends "---").

## Hosts (several machines)

Every machine runs `minbox host`; the server connects to each. The machine the server
runs on has the built-in host "local" (started by the server, Unix socket, as today).
Other hosts: `minbox host --listen 0.0.0.0:4849 [--data-dir]` prints its token (kept in its
data dir) and serves the host protocol over HTTP/WebSocket with `Authorization: Bearer <token>`.

Host JSON:

```
{ id, name, url, builtin: bool, status: "online"|"offline"|"connecting",
  version, os, arch, latency_ms, last_seen, error, sessions: number }
```

```
GET    /api/hosts
POST   /api/hosts {name, url, token}            → host (tests the connection first; 400 with the reason)
PATCH  /api/hosts/{id} {name?, url?, token?}
DELETE /api/hosts/{id}                           its sessions stay, as Ended; their threads stay readable
POST   /api/hosts/test {url, token}              → {ok, version, os, arch, latency_ms, error}
POST   /api/hosts/{id}/retry
POST   /api/hosts/{id}/rotate-token              → {token} (the host takes the new one at once)
```

SSE event `hosts`. Session JSON adds `host_id`, `host_name`. `POST /api/sessions` takes
`host_id` (default: local). `GET /api/fs/dirs` and `POST /api/fs/mkdir` take `host_id`.

Everything that touches a session's files happens on its host: folder browsing, attachments
(snapshot, current version, html assets, markdown images, linked pages), review diffs, inline
images, the transcript check for --resume, completions, and files the agent must read
(pasted images, the person's uploads, markups) are written to that host.

The mod on another machine talks to its host (MINBOX_SERVER_FILE written by the host,
pointing at the host's loopback agent endpoint); the host relays agent API calls to the
server over the server's connection to it. Long polls work across the relay.

### Attachments v2: as built (server notes)

- `GET /api/attachments/{id}` also answers `current_size`, `too_large` (text file now over 16 MiB),
  `author`, `type`, `named_path`, `sent_mtime`, `width/height/duration_ms`, `ref`, `inline`.
  `exists` is false only when the file is gone (`attachment_missing`); a changed type keeps
  `exists: true` with `unavailable` set.
- `GET .../view` answers `{version: "current"|<sent sha256>, text, html, unavailable}`; when the
  current file is unavailable it falls back to the sent version.
- `named_path` is set only when the attached name is itself a link (not a path through a linked
  folder such as macOS /var).
- HTML-asset folder tokens live in memory: after a server restart the page re-fetches `view`.
  The guard lets GET/HEAD of `/api/html-assets/` and `/api/embeds/` through from opaque
  origins (Origin absent or `null`, any Sec-Fetch-Site).
- `POST /api/uploads` and `POST /api/markups` answer 201. Refusals carry `code`
  (`upload_refused`, `upload_too_large`, `upload_not_found`).
- Pending items (mod API) carry `attachments` and a `body` with the `Attached:` lines.
- Search's Files group covers the person's files too; `from` filters files by author.
- `thread.attachment_count` counts attachments, not inline images.
- Annotations accept the older `line` and `image_path` fields (mapped to `line_start` / `images`).
- Mod result: `Sent to the minbox inbox[ asking N question(s)][ with N attachment(s)] (Started|Added to thread <id>).`
  then the reply line, `Attached: name (kind), …`, and the images-not-shown sentences (first 10).

### Hosts: as built

- Host JSON: `{id, name, url, builtin, status, version?, os?, arch?, latency_ms? (online only), last_seen, error?, sessions}`.
  The built-in host's `url` is `unix://<socket>`; its `version` is the server's.
- `POST /api/hosts` tests first (400 `wrong token`, `could not connect: …`, `its minbox is too old …`).
  `POST /api/hosts/test` answers 200 `{ok:false, error}` on failure.
- `PATCH` of url/token reconnects; the built-in host only takes `name`. `rotate-token` needs the host online (409 otherwise).
- `DELETE` kills the host's running sessions (if reachable), marks them ended, keeps them.
- `minbox host --listen ADDR [--data-dir]` (also `minbox host start --listen`): token in `<data-dir>/host-token`,
  mod in `<data-dir>/plugin`, relay server file `<data-dir>/host-server.json`, files under `<data-dir>/{scratch,uploads,markups}`.
- Host protocol: same as the socket host plus `Authorization: Bearer` on every request, `/fs/*` (file access),
  `POST /token`, `GET /relay` (WebSocket the server opens; mods' `/api/agent/*` calls ride it). `/version` adds
  `version, os, arch, remote`. Spawn requests may carry `{{MINBOX_PLUGIN_DIR}}` / `{{MINBOX_SERVER_FILE}}` and `inherit_env`.

## Hosts v2: pairing with public keys, Tailscale or Direct (replaces the token)

Supersedes the token parts of "Hosts". Everything else (server→host connection, relay,
host-side files, placeholders) stays.

Auth: the server has an ed25519 key pair in its data dir (`server-key`, 0600) and a name
(the machine's hostname). Every request to a remote host is signed:
`Authorization: Minbox-Sig key=<SHA256 fingerprint>, ts=<unix>, nonce=<hex>, sig=<base64>`,
sig = ed25519 over `METHOD\nPATH?QUERY\nts\nnonce` (WebSocket upgrades too). The host accepts
keys listed in `<host data dir>/authorized-servers.json` ([{name, public_key, fingerprint,
added_at}]), ts within ±120 s, nonce not reused within that window. No more host token.

Unauthenticated host routes: `GET /version` → {protocol, required_server, version, os, arch,
hostname, tailscale: bool}; `POST /pair {server_name, public_key}` → {code: "482-913"} (6 digits,
expires in 10 min; kept in `<data dir>/pairing/<code>.json`); `GET /pair/{code}` →
{status: "pending"|"accepted"|"rejected"|"expired"}. Authenticated: `DELETE /pair/self`
(forget the calling server's key).

Host CLI (same machine as the host, reads/writes its data dir; the running host reloads the
files): `minbox pair list` (lines `CODE  SERVER-NAME  ed25519 SHA256:…`), `minbox pair accept
CODE`, `minbox pair reject CODE`. `minbox host --listen ADDR` (Direct) and
`minbox host --tailscale [--tailscale-user-login LOGIN] [--port 4849] [--tailscale-port 14849]`: listen on
127.0.0.1:port only, run `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (or the
current CLI's equivalent), and require the header `Tailscale-User-Login` == LOGIN on every
request (tailscale serve sets it).

Host JSON (replaces the token fields):

```
{ id, name, url, builtin, method: "builtin"|"tailscale"|"direct", tailscale_login?: string,
  paired: bool, pairing_code?: string /* while waiting for accept */, fingerprint?: string,
  status: "online"|"offline"|"connecting"|"pairing", version?, os?, arch?, latency_ms?,
  last_seen, error?, sessions }
```

Browser routes:

```
GET    /api/hosts/tailscale            → {available: bool, login?: string, suffix?: string /* tailnet MagicDNS suffix */}
POST   /api/hosts/probe {url}          → {ok, version?, os?, arch?, hostname?, tailscale?, error?}   (unauthenticated /version)
POST   /api/hosts {name, url, method, tailscale_login?} → {host, code}   starts pairing; host.status "pairing"
POST   /api/hosts/{id}/repair          → {code}   pair again (new code)
PATCH  /api/hosts/{id} {name?, url?}
DELETE /api/hosts/{id}                 also DELETE /pair/self on the host when reachable; sessions → Ended
POST   /api/hosts/{id}/retry
```

For method "tailscale" the url given may be a bare MagicDNS name; the server uses
`https://<name>`. When the host accepts, the server's pairing poll (every 1 s) moves the host
to connecting → online and publishes SSE `hosts`. Removed: `/api/hosts/test`,
`/rotate-token`, the `token` field.

Implementation notes (Hosts v2):
- `GET /api/hosts/tailscale` → `{available, login?, suffix?, peers: [{name, dns_name, os, online, has_host, added}]}`.
  From `tailscale status --json` (the `tailscale` CLI, or the macOS app's binary); without it: `{available:false, peers:[]}`.
  `has_host`: an unauthenticated `GET https://<dns_name>/version` answered as a minbox host (online peers, probed
  concurrently, 1.5 s each). `added`: a host row already uses that name. Sorted: has_host, then online, then name.
- `POST /api/hosts` → 201 `{host, code}`; it probes `/version` first (400 with the reason: not reachable, not a remote
  host, too old/new). `name` may be empty: the first label of the host name is used. `method` defaults to "direct".
- `POST /api/hosts/probe {url, method?}` → 200 `{ok:false, error}` on failure. A url without a scheme is treated as Tailscale.
- Host JSON: `fingerprint` is this server's key fingerprint (what `minbox pair list` shows on the host); the built-in
  host has `method:"builtin"`, `paired:true`. `status:"pairing"` while `pairing_code` is set. A rejected or expired
  pairing leaves the host offline with `error` "the pairing was rejected on the host" / "the pairing code expired; pair again".
- Hosts added with a token before v2 become unpaired: offline, `error: "pair this host again"` (use repair).
- Host protocol 3 (remote hosts need ≥ 3); a remote host's `/version` adds `hostname` and `tailscale`, and reports pid 0.
  Pairing codes are accepted as `482-913` or `482913`. `minbox pair list` prints "no pairing requests are waiting" when empty.
- The server's key: `<data dir>/server-key` (PEM "MINBOX ED25519 SEED", 0600); its name is the machine's hostname.
- `minbox host --tailscale` runs `tailscale serve --bg --https=14849 http://127.0.0.1:<port>` (`--tailscale-port`; 3125 is left to `minbox start`) once listening;
  `MINBOX_SKIP_TAILSCALE_SERVE=1` skips that. The Tailscale-User-Login check applies to every route, `/version` included.

## Browser pairing and `minbox start --tailscale`

`minbox start --tailscale [--tailscale-port 3125] [--tailscale-user-login LOGIN]`: listen on 127.0.0.1 only and
run `tailscale serve` to it (as the host does). Requests that come through tailscale serve
(they carry `Tailscale-User-Login`; their Host is the MagicDNS name) are "remote"; with
`--tailscale-user-login` any other login is refused (403). The guard accepts the server's own
MagicDNS name as Host in this mode.

Trust: a request straight to a loopback address with a loopback Host and no Tailscale headers is
trusted as today. Any other request needs a paired browser's cookie `minbox_device` (HttpOnly,
Secure, SameSite=Strict, 12 h, re-issued by signing again); without it only these answer:
`GET /` (the app, which shows the pairing screen), static assets, and `/api/devices/pair*`,
`/api/devices/auth*`. `/api/agent/*` stays as it is (bearer).

Browser key: ECDSA P-256 made with WebCrypto, private key non-extractable, kept in IndexedDB.

```
POST /api/devices/pair {public_key /* base64 SPKI */, name /* "Chrome on iPhone" */}
     → {request_id, code: "482-913", fingerprint /* SHA256:… of the SPKI */}
GET  /api/devices/pair/{request_id}         → {status: "pending"|"accepted"|"rejected"|"expired"}   (10 min)
POST /api/devices/auth/challenge {fingerprint}  → {challenge /* base64 32 bytes, 60 s */}
POST /api/devices/auth {fingerprint, challenge, signature /* base64 ECDSA P-256 SHA-256, IEEE P1363 */}
     → 200 + Set-Cookie minbox_device; 401 when unknown/revoked/bad
GET  /api/devices/me                        → {trusted: bool, via: "loopback"|"device"|null, device?: Device}
GET  /api/devices                            (trusted) → {devices: Device[], requests: PairRequest[]}
POST /api/devices/requests/{request_id}/accept | /reject   (trusted)
DELETE /api/devices/{id}                    (trusted) revoke: its cookies stop working at once
Device: {id, name, fingerprint, created_at, last_seen, current: bool}
PairRequest: {id, code, name, fingerprint, created_at, ip?, tailscale_login?}
```

SSE `devices` when requests or devices change (trusted clients only). CLI on the server
machine: `minbox pair list` also lists browser requests (`482-913  browser  Chrome on iPhone
ecdsa-p256 SHA256:…`), `minbox pair accept|reject CODE` works for them (server data dir).

### Notes from the implementation (browser pairing)

- Files in the server's data dir: `devices.json` (accepted browsers) and
  `device-pairing/<code>.json` (requests). Package `internal/devices`; server side in
  `internal/server/devices.go` (the guard moved there).
- "Remote" = the request carries `Tailscale-User-Login`, `X-Forwarded-For` or `Forwarded`, or its
  Host is not a loopback address. Only non-remote requests are trusted without a device.
  The Origin check compares with `X-Forwarded-Host` when present.
- Open routes for an unpaired remote browser: every non-`/api/` GET/HEAD (the app and its
  assets), `POST /api/devices/pair`, `GET /api/devices/pair/{id}`, `POST /api/devices/auth/challenge`,
  `POST /api/devices/auth`, `GET /api/devices/me`; `/api/agent/*` keeps its bearer token; the
  sandboxed-frame GETs of `/api/html-assets/` and `/api/embeds/` stay open (no cookie is sent
  from an opaque origin). Anything else: 401 `{"error": "this browser is not paired with this
  minbox", "code": "unpaired"}`.
- Cookie sessions live in memory: after a server restart a paired browser signs a new challenge.
  Revoking (API or CLI) ends the device's cookies and cancels its open SSE/WebSocket requests.
- Limits: 3 waiting requests per client IP, 10 in all (429). Challenges: 60 s, single use.
- `POST /api/devices/pair` answers 201. `POST /api/devices/auth` answers
  `{ok: true, device: Device}` with the cookie; `Secure` when X-Forwarded-Proto is https (or TLS).
- `GET /api/devices/me` → `{trusted, via: "loopback"|"device"|null, device?}`.
- Accept/reject answer 409 when the request is no longer pending; accept answers
  `{ok: true, device}`. Revoke answers `{ok: true}` (404 for an unknown id).
- SSE `devices` also fires when the CLI changes the files (polled every 2 s).
- `start --tailscale` runs `tailscale serve --bg --https=3125 http://127.0.0.1:<port>` (skip:
  `MINBOX_SKIP_TAILSCALE_SERVE=1`) and takes its MagicDNS name from `tailscale status --json`
  (override: `MINBOX_TAILSCALE_NAME`). A host with `--tailscale` on the same machine serves on
  :14849, so the two do not meet.
- `start --tailscale-service NAME` serves as the Tailscale Service `svc:NAME` instead
  (`tailscale serve --bg --service=svc:NAME --https=3125 ...`), answering to `NAME.<tailnet>.ts.net`;
  the service must be defined (and this machine approved) in the Tailscale admin console.
- With `--tailscale`/`--tailscale-service` and no `--tailscale-user-login`, the login is this
  machine's Tailscale user (`tailscale status --json`; `MINBOX_TAILSCALE_LOGIN` overrides).

## `minbox start` / `stop` / `status`

- `minbox start [flags]` runs the server as a daemon: it starts `minbox start --foreground <flags>
  --no-open --data-dir <abs>` in a session of its own (setsid), output appended to
  `<data-dir>/minbox.log`, waits (20 s) until `server.json` names that pid and the server answers,
  prints the URL and opens the browser (unless `--no-open`). Already running: says so, exit 0.
  A child that exits early: the log's new lines are printed, exit 1.
- `minbox start --foreground [flags]` is the server in the foreground (`minbox serve` is kept as
  its old name).
- `minbox stop` sends SIGTERM to the pid in `server.json` (if it is a live minbox process), waits
  10 s, then SIGKILL. The terminal host and its sessions keep running (`minbox host stop`).
- `minbox restart [flags]` stops the server and starts it again (never opening the browser): with
  the flags given, or, given none but `--data-dir`, with those of the last successful `minbox start`
  (kept in `<data-dir>/start-args.json`).
- `minbox status` prints pid, uptime, URL, data dir, log and whether the terminal host answers;
  exit 3 when the server is not running.
- `minbox` with no command prints the usage.

## Opening pages: `open_url`

- Tool `open_url {url}` → `POST /api/agent/open {url}` (absolute http(s) URL, else 400). With no
  browser on `/api/events`: 409 (Claude gives the URL in its reply instead). Otherwise it publishes
  the event `{"type":"open","session_id","url"}` and answers `{ok, url, browsers}`.
- Each browser: when it is visible and focused it opens the page in a new tab; where that is
  blocked (no click), or in any other browser, a toast "<session>: Claude wants to open <url>"
  with Open (60 s).
- The mod refuses Bash commands that would open a page on the host — `open|xdg-open|gio open|
  sensible-browser|x-www-browser|wslview … http(s)://…` at a command start, `gh browse`, and gh
  with `--web`/`-w` — pointing Claude to `open_url`.

## minbox's system prompt

The inbox (`send_message` every time the person's opinion, decision, approval or action is
needed, and a summary when work is done), session title and `open_url` guidance reaches Claude
three ways, as some environments skip
the mod's `prompt.compose` hook:
- the server starts Claude with `--append-system-prompt` (`server.AgentSystemPrompt`, headings
  `# minbox: inbox`, `# minbox: session title` and `# minbox: opening pages`);
- the mod's `prompt.compose` adds the same sections unless those headings are there already;
- the mod's first-prompt (and after-compaction) reminder repeats them in a sentence each.

A main-loop turn that ends asking the person something (a question mark, or phrases such as
"Should I", "Let me know", "どうしますか", "確認してください" in its last lines, code and URLs
aside) without calling `send_message` is followed, once Claude is idle, by one plugin turn asking
it to send that to the inbox. That turn never triggers another; the person typing in the terminal
cancels it.

## Guided review: worktrees and committed changes

- `send_message.review` adds `cwd` (where relative file paths resolve, e.g. a git worktree;
  absolute or relative to the session directory; default the session directory) and `base`
  (a branch or commit; default none).
- Each file is diffed in the repository or worktree that holds it (git runs in the file's
  directory, not the session's), so files in a worktree diff against that worktree's HEAD.
- With `base`, the diff starts at `git merge-base <base> HEAD`, so the branch's committed changes
  show as well as uncommitted ones. A base with no common commit: 400 `review file …: base …`.
- The stored review JSON carries `base` when given. Host `/fs/gitdiff` takes `base`.

## Thread title from the agent (`thread_title`)

- `POST /api/agent/messages` takes `thread_title?` (the `send_message` tool's `thread_title`). Given and non-empty, it sets the thread's title (the stored `subject`): the initial title of a new thread, and the new title of an existing one when the call carries `thread_id`. Omitted or empty: nothing changes (a new thread still derives its title from the first line of `body`, 60 characters).
- The title is one line (whitespace runs collapse to a space) and at most 120 characters (longer is cut, ending in `…`).
- `subject` is kept as an alias of `thread_title` (when both are sent, `thread_title` wins); the tool documents only `thread_title`. Before, `subject` was ignored with `thread_id`; it now applies there too.
- A changed title is published like any thread change: `thread` and `threads` SSE events. `name` (the tag the person edits in the UI) is a separate field and is never touched; the UI has no manual rename of the title.
