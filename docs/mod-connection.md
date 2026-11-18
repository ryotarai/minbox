# The mod connection

How a message you send reaches the agent, how to tell that the connection between the agent's
integration (the Claude Code mod in `plugin/minbox`, the Pi extension in `plugin/pi`, or the OpenCode plugin in `plugin/opencode`) and the
minbox server is alive, and what can go wrong. Written after reports of replies that an idle agent
did not pick up.

Mod changes (heartbeat, event log, delivery retries) take effect only in a Claude Code session
that starts after the new minbox binary is installed: a running session keeps the mod it loaded.
Restart the session (session menu -> Restart) to load the new one. Until then its connection shows
as "no heartbeat" even though it still works (an old mod makes calls, which keep it `connected`
by the call-based fallback described below).

## The delivery path

1. The web UI posts the reply (`POST /api/threads/{id}/reply`, or a new thread, a Slack/Linear
   hand-off, a fork). The server stores it as an undelivered user message and wakes any long poll of
   that session (`wakePending`).
2. The mod polls `GET /api/agent/pending?owner=<instance>&wait=20`. The server answers at once if a
   message waits, else after up to 20 s (a long poll). The mod's loop runs once a second
   (`TICK_MS`); while Claude is busy it asks with `wait=0` (just looks).
3. The mod delivers only into a quiet session: not busy and idle for two ticks
   (`IDLE_TICKS`), so the person's own typing goes first. An `urgent` message (Send now pressed, or
   queued over 5 minutes) goes in anyway.
4. `POST /api/agent/pending/{id}/claim` reserves the message for this mod instance (an `owner` key,
   random per mod start). A claim older than 60 s (`ClaimTimeout`) is stale.
5. If Claude became busy in the meantime, non-urgent claims are released.
6. `$.prompt.submit` puts the text into Claude Code as a plugin turn.
7. `POST /api/agent/pending/{id}/delivered` marks it delivered; the UI line turns from "Queued" to
   "Delivered".

Busy and idle: the mod sets `busy` on the main loop's `turn.start`, clears it on `turn.complete`
and tells the server (`POST /api/agent/status`). A missed `turn.complete` (Esc, an error) is
covered by `BUSY_STALE_TICKS` (120 s without any hook event or tool call: treated as idle again).

The UI already warns about a queued reply nobody picks up (`ThreadView.tsx`, delivery line):
after about 30 s while the session is idle, or when the connection is silent/stale, it says so
and offers **Send now**.

## Failure modes, ranked

What I found reading the code, most plausible first. I could not reproduce the report; items 1 and
3 are real bugs or gaps I fixed, the rest are hypotheses the new diagnostics can confirm or rule
out.

1. **A claim that is never released hides the message from its own claimant (fixed).**
   `PendingForSession` left out every message whose `claim_owner` equalled the asking owner, with
   no time limit; only claims by *other* owners went stale after 60 s. If the claim succeeded on the server but the mod never got
   the reply (the call timed out at 8 s, the server restarted, the network blipped), or the later
   `release` call failed (its result was ignored), the message stayed claimed by the mod's own
   owner and was never offered to it again, while the UI showed "Queued". Only restarting the
   session (new owner) and waiting 60 s freed it. Now a stale claim (older than 60 s) is offered
   again to anyone, its owner included (`internal/store`, `TestOwnStaleClaimIsOfferedAgain`).
   This matches "sometimes, even when idle, nothing happens, and later it does not recover".
2. **`delivered` lost after a successful submit (hardened).** The mod ignored a failed
   `delivered` call, so the message stayed "sending" and, with fix 1, would have been offered and
   submitted a second time after 60 s. The mod now keeps the ids it submitted, retries the
   `delivered` call on the next polls, and never submits an id twice (also not while a submit is
   still running).
3. **The mod stopped polling after `/clear` (confirmed, fixed).** The Claude Code mod API fires
   `session.end` with `reason: 'clear'` on `/clear` and fires no `session.start` after it (the
   process goes on under a new Claude session id; the same holds for a resume). The mod's
   `session.end` hook cancelled both the tick timer (polling, delivery) and the heartbeat timer,
   and only `session.start` re-created them, so after `/clear` the heartbeat stopped (the UI shows
   "no heartbeat") and replies were no longer picked up. Verified from the type documentation and
   by a mod test that reproduces the sequence; not observed live in a session. The mod now keeps
   both timers running across `session.end` (they die with the process), resets its
   per-conversation state (busy, nudges, pending reminders) and re-sends the instructions with the
   next prompt; the tick's `hello` sends the new `claude_session_id` within a second, and the
   server's hello handler stores it (`SetClaudeSessionID`), so a later restart resumes the
   conversation after the `/clear`. Other causes of silence remain possible: a `session.start`
   that is not interactive (the mod stays disabled), or a hook that threw.
   **The fix takes effect only in a Claude Code session started after the new mod is installed**;
   a running session keeps the old mod and still goes silent on `/clear` (restart it).
4. **Stuck busy.** If Claude never sent `turn.complete`, non-urgent messages wait up to 120 s,
   then 5 minutes as `urgent`. A long turn without tool calls (long thinking) over 120 s makes the
   mod believe Claude is idle and deliver into a running turn (queued by Claude Code; not lost).
   The heartbeat reports `state` and `busy_ticks`; the server log says `undelivered ... mod_state=working`
   when it happens.
5. **Server unreachable or restarted.** The mod re-reads `MINBOX_SERVER_FILE` after a failed call
   and retries every tick, so a restart should heal within seconds; an unreachable server used
   to be silent. Now: events in the mod log, one toast after 3 failed calls in a row, one when it is
   back, and the server logs `stale` then `reconnected` with the gap.
6. **Token not accepted (401).** The server forgot the session (deleted, or the DB was reset):
   every call fails with `unknown session token` and the mod ignored it. Now recorded in the mod
   log and toasted once.
7. **A poll step hung.** `$.session.id()` or `$.prompt.submit` that never returns holds the
   `polling` flag; the mod abandons it after 60 ticks (`POLL_STUCK_TICKS`). Now logged as `poll-stuck`.
8. **Two mod instances** (a reloaded plugin that keeps the old timer): they use different owner
   keys and compete for claims; the heartbeat `seq` going backwards (`seq-reset` in the server log)
   is the sign.
9. **Claude Code is waiting for the person** (a permission prompt, a dialog): `$.prompt.submit`
   may queue behind it. Nothing the mod can see; the message shows as delivered but the agent does
   not answer. Not a connection problem.

## The heartbeat

Every 15 s (`HEARTBEAT_MS`; Pi and OpenCode: once per loop round, at most every 15 s) the mod sends
`POST /api/agent/heartbeat`, authenticated like every agent call (the session's bearer token):

```
{ seq, agent: "claude"|"pi"|"opencode", ext_version, state: "idle"|"working",
  last_poll_at, last_delivery_at,            // the mod's own timestamps, "" before the first
  protocol,                                  // the mod protocol (docs/mod-protocol.md); absent before protocol 1
  info: { busy_ticks, idle_ticks, polling, poll_ticks, inflight, unacked, offline, fail_streak, owner_prefix, tools_version },
  events: [ { at, kind, msg } ... up to 25 ] } // the tail of the mod's own event log
```

The server (`internal/server/modconn.go`) records it per session and judges the connection by it:

| state | meaning |
| --- | --- |
| `connected` | a heartbeat within 45 s (an old mod without heartbeats: any call within 45 s) |
| `stale` | none for longer than 45 s (also: nothing at all long after the server started) |
| `connecting` | nothing yet, and the server or the session just started |
| `none` | a shell, or an ended session |

`MINBOX_MOD_SILENT_S` shortens the 45 s (tests).

Transitions are logged once, with the gap, and published as a `sessions` event so the UI updates
at once: `connected -> stale` when the timer finds no heartbeat for 45 s, `stale -> reconnected` on
the next heartbeat.

## The log (`~/.minbox/minbox.log`)

Every line starts with `modconn:` and holds ids, lengths and timings only; never a message body,
a token or an owner key. `grep modconn: ~/.minbox/minbox.log`.

```
modconn: hello session=ses_x name="api" agent="claude" ext_version="" status=starting conversation_changed=true
modconn: heartbeat-first session=ses_x agent="claude" version="0.1.0" state=idle seq=1
modconn: pending session=ses_x poll returned 1 message(s) oldest_wait=1s ids=msg_y          (at most once per 30 s)
modconn: claimed session=ses_x msg=msg_y thread=thr_z waited=1.2s via=claude/pending-poll mod_state="idle"
modconn: delivered session=ses_x msg=msg_y thread=thr_z waited=1.4s via=claude/pending-poll mod_state="idle"
modconn: released session=ses_x msg=msg_y (the mod could not submit it, or went busy)
modconn: claim-refused session=ses_x msg=msg_y (delivered, or claimed by another instance within the last 1m0s)
modconn: stale session=ses_x no heartbeat for 46s (threshold 45s) mod_state=idle last_seq=212
modconn: reconnected session=ses_x after 2m3s without heartbeat (stale for 1m17s) reconnects=1
modconn: undelivered session=ses_x msg=msg_y thread=thr_z waited=31s conn=connected mod_state="idle" last_heartbeat_age=4s last_poll="2026-..." urgent=false
modconn: seq-reset session=ses_x heartbeat seq 1 after 212: the mod restarted or a second instance reports
modconn: spawn session=ses_x resume=true agent=claude host="" cwd="/work/api"
modconn: relocated session=ses_x from="/old" to="/new" new_conversation="..."
modconn: exit session=ses_x terminal exited code=0
```

`undelivered` is logged once per message when it has waited over 30 s while the mod says it is
idle or the connection is stale (not while the mod says it is working). Read it as: connected +
idle + `last_poll` recent means the mod is alive and polling but did not take the message
(look at its log for `held`, `claim-failed`, `submit-failed`); stale means the mod is gone.

The mod keeps its own ring buffer (60 events: hello, api errors, offline/online, held, claim and
submit failures, deliveries, stuck polls, session start/end) and sends the last 25 with every
heartbeat. Identical consecutive events are folded (`(x7)`).

## Where to look in the UI

A small dot beside the session name (the thread header, the terminal header, and the phone
headers): green dot = mod connected; grey = connecting; red with "no heartbeat for 2 m" = stale.
Click it for the diagnostics: last heartbeat, the mod's idea of its state, last poll and delivery,
queue length and age, the mod's own log and the server's log, with **Copy diagnostics** (plain
text for a bug report). The same data: `GET /api/sessions/{id}/connection`. A queued reply that
waits while the connection is stale shows the existing "not picking this up" line with **Send now**.
