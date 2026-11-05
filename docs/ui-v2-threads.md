# UI v2 (experiment): threads first

Branch `v2-pre1`. Not for `main`. Data structures, API and route state (`{s, t, f, view, tab}`) are unchanged;
only the screen is reorganised.

Today: session > threads, and session - terminal. The sidebar lists sessions, the inbox column lists the
threads of the *selected session*, the terminal is the centre. The person's real unit of work is the
**thread** ("Claude asked me X"), so v2 makes the thread the first-class object and the session a *property*
of a thread (where it runs), shown as a chip and as the terminal on the right.

## Principles

1. One list, all threads, newest activity first. No need to pick a session before you can read.
2. Selecting a thread selects its session: thread view and terminal follow together (`navigate({s, t})`).
3. Starting work is also thread-first: type, choose *where* (a session, or a new one), send.
4. Session-level controls live next to the terminal they act on (session header), not in a list.

## Desktop wireframe (1500 px)

```
+--------------------+----------------------------+-------------------------------+
| [m] [search] [+New]| < Esc   Mark read  Artifacts| deploy-api  Fixing the CI   Idle|
|          [...]     |  Thread subject            | ~/work/api     [shell] [...]  |
| [All 7][Waiting 2] |  Claude Code in deploy-api |                               |
| [Unread 3]         |  ...messages...            |   $ claude                    |
| Session: All  v  G |  ...question card...       |   (terminal, ghostty-web)     |
|--------------------|                            |                               |
| * Which DB?   2m ?1|                            |                               |
|   [deploy-api]  .. |                            |                               |
| o Release notes 1h |                            |                               |
|   [docs]  ...      |                            |                               |
| ...                |  Reply to Claude Code... R |                               |
|--------------------|                            |                               |
| to: * deploy-api v |                            |                               |
| [ Start a thread...|                            |                               |
| [ ]                |                            |                               |
| clip [] hint  Send |                            |                               |
+--------------------+----------------------------+-------------------------------+
   Threads (340)            Thread (520)                Terminal (flex)  [+ Shell]
```

At >= 1680 px the same three columns just get wider defaults (list 380, thread 600) and the shell pane fits
beside the terminal without squeezing. Column order is `Threads | Thread | Terminal | Shell`. The
*swap panes* setting flips the thread and terminal: `Threads | Terminal(+Shell) | Thread`. (Implemented
with CSS `order`, so toggling it does not remount the terminal.) Every column edge has a Resizer (mouse and
touch) as before; the terminal is the flexible column.

Narrow windows give way in this order: shell pane (to 280, then hidden), threads list (to 280, then it folds
into the rail), thread pane (to 380), terminal minimum 360.

## 1. Threads pane (far left)

**Top bar** (48 px): logo (click toggles rail, also Cmd+B), search (Cmd+K), `+ New` (new session),
`...` menu. The menu holds everything the old sidebar footer/options had: Settings, Board (if enabled),
Decide (if enabled), Drafts n, list options, Devices/Hosts are reached through Settings as before.

**Filter row**: chips `All n`, `Waiting n` (stopped + holding + waiting sections: threads needing the person),
`Unread n`, then `Session: All v` and a `Group v` button.

- *Session filter* popover: searchable list of all sessions (status dot, name, host tag, waiting/unread count),
  `All sessions` on top, `+ New session` at the bottom. Choosing a session filters the list **and** selects it
  (terminal switches, so shell sessions with no threads are reachable here). Choosing `All sessions` only clears
  the filter. The filter persists in this browser (`minbox:v2-filter`).
- *Group*: `Activity` (default, flat, pinned first then `updated_at` desc), `Status` (the old sections: Stopped,
  Holding, Waiting, Sent, New, Quiet), `Session` (one header per session). Archived and snoozed threads are
  hidden from the flat list behind a `Snoozed / Archived n` fold at the bottom.

**Row** = the existing `ThreadRow` plus: session chip (status dot + name; clicking the chip opens that
session's terminal without a thread: `navigate({s, t:null})`), kept unread dot, `?n` question badge,
Stopped / Holds-up badges, time. Waiting rows keep the amber tint.

**Rail (collapsed)**: 60 px column of session tiles (the old rail: initials, status ring, amber badge when
waiting) plus search / new / settings. Clicking a tile opens that session's top thread (or just its terminal).
Forced while an attachment is open in the centre, as before.

## 2. Terminal pane (right) and session header

Header: session name (double-click or menu > Rename), Claude's title, cwd, status pill; right side:
shell toggle (Ctrl+`), `...` session menu (Rename, Stop / Resume, Archive, Delete). The ended bar with
`Resume` stays in the terminal. The `toggle-inbox` button is gone (the rail replaces it).

The terminal element sits at a fixed position in the tree and is keyed by session id, so moving between
threads of one session never remounts it. A thread of another session reattaches the terminal.

**No thread selected** (`t` null): the thread pane shows an empty state (`Pick a thread, or start one below`)
and the sessions that need attention/recent ones as buttons; the terminal still shows `route.s`. With no
session selected on load we pick the most urgent session. Opening a terminal without a thread: session chip
in a row, the session filter popover, Cmd+K > a session, rail tile.

## 3. Composer (bottom of the threads pane)

```
 to: * deploy-api  v          <- target selector (testid composer-target)
 +-----------------------------+
 | Start a thread...           |    auto-grow, @ agents, / skills, paste/drop files
 +-----------------------------+
 [clip] [full]  Claude gets this as its next turn      [Send Cmd+Enter]
```

- Target default: the session of the open/selected thread (`route.s`); if the person picks another one it
  sticks until they select a different session; if `route.s` is a shell, the last used Claude session.
- Popover: search box, sessions sorted by activity with status dot (shell sessions excluded, ended ones
  marked and still allowed: the message waits for Resume), and `+ New session...` at the bottom.
- `+ New session...` opens the existing NewSession dialog. On creation the composer targets the new session
  and, if text was already typed, **sends it there right away** as the first thread (selecting it). Otherwise
  the terminal shows the new session and the box waits.
- Sending creates a NEW thread in the target and opens it. Draft text and files are kept **per target**
  (switching the target swaps the draft). Replies to an open thread stay in the thread view's own box.

## 4. Phone

Home = the thread list (same `ThreadsPane`, phone variant): header (logo, search, `+`, `...`), filter chips,
session filter opens a **session sheet** (the old session list: rows with status, rename/stop/archive menu,
`Terminal` shortcut), list, composer with the target selector pinned at the bottom. All inbox is gone: the
home list is it.

Tap a thread: thread screen. Header: back (with badge = other threads with unread), subject, **session chip**
(name + status dot; tap = flip to that session's terminal), mark unread, archive. Terminal screen (`tab=terminal`):
header back (to the thread if one is open, else home), session name + status, shell button (the existing
full-screen overlay); a `Thread | Terminal` segmented control shows when a thread is open.

## 5. Cmd+K

Unchanged search (threads, messages, files). Threads group comes first as before; a **Sessions** group (client
side, name match) is appended and opens the session's terminal. Default scope is "All sessions" (no longer
the selected session) since the list is global.

## Migration notes (what moved or went away)

| Old | v2 |
| --- | --- |
| Sidebar session list with sections | Gone from the main screen. Session filter popover / phone session sheet; rail keeps session tiles |
| Per-session inbox column (`InboxPane`) and its thread list | Replaced by the global Threads pane; `InboxPane`, `PhoneInbox` removed |
| All inbox page (`open-all-inbox`, `v=inbox`) | Merged into the home list; `v=inbox` links open the main screen |
| `New` button on the session list | `+ New` in the threads top bar, `+ New session...` in the target selector |
| Sidebar footer (Settings, Board, Decide, Drafts) and list options | `...` menu in the threads top bar |
| Session `...` menu on a row (Rename, Stop, Archive, Delete) | Session header `...` over the terminal; phone session sheet rows |
| `toggle-inbox` button | Removed (Cmd+B rail instead) |
| `layout.inboxW` | Unused; `sidebarW` = threads width, `threadW` = thread width |
| Search default scope = selected session | All sessions |
| Phone session list as home | Phone thread list as home; session list is a sheet |
| Wide (>=1680) four-pane mode | Always three panes; wide just widens them |
| Thread header back button `< session-name` | Kept; it clears the selected thread (empty state) |
