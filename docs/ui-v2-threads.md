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

Narrow windows give way in this order: shell pane (to 280, then hidden), threads list (to 240), thread pane (to 380), terminal minimum 360.
When even that does not fit (viewport below `THREE_COLUMN_FROM` = 1100 px, `lib/app.tsx`; the narrowest the three
columns plus the 56 px project tiles get is 1054 px) the three-column layout is not used: see *Tablet: two panes*
and *Single-column navigation* below. There is no collapsed rail any more.

## 1. Threads pane (far left)

**Top bar** (48 px): logo, search (Cmd+K), `+ New` (new session),
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

**Row** = the existing `ThreadRow` plus: kept unread dot, `?n` question badge,
Stopped / Holds-up badges, time. Waiting rows keep the amber tint. Rows carry no session or project chip
(the session lives in the thread header and the terminal; group-by-session keeps its group headers).

**Width bands** (`lib/app.tsx`; purely width-based, so touch tablets, foldables and small desktop windows alike;
`isPhone` / `isTablet` come from media queries and switch live):

| width | layout |
|---|---|
| `< SINGLE_COLUMN_BELOW` = 700 | phone: single column (below) |
| 700 .. 1099 | tablet: two panes (below) |
| `>= THREE_COLUMN_FROM` = 1100 | three columns (above) |

The route (`s`, `t`, `tab`) and drafts live outside the layout, so resizing across a band keeps the selected
thread, session and draft (scroll position inside a thread is not kept across a layout switch).

**Tablet: two panes** (`Tablet` in `App.tsx`, composing `ThreadsPane`, `ThreadPane`, `TerminalPane`; dialogs, settings
and the composer use the desktop styling). The project column is always the 56 px tiles.

```
 list view (default)                          terminal view (route tab=terminal)
+----+-----------------+------------------+  +----+------------------+------------------+
|    | Threads  + New  | < alpha [Terminal]|  |    | < alpha          | < Threads  alpha |
| P  | [All][Waiting]  |   Mark read  ...  |  | P  |   Mark read  ... |  local  Waiting  |
| r  |-----------------+------------------+  | r  |------------------+  [>_]  [...]     |
| o  | Note            | Pick a database   |  | o  | Pick a database  |                  |
| j  | Pick a database | ? Which database  |  | j  | ? Which database |  terminal        |
| e  |                 |   ( ) SQLite      |  | e  |   ( ) SQLite     |                  |
| c  |                 |   ( ) Postgres    |  | c  |   ( ) Postgres   |                  |
| t  |-----------------+------------------+  | t  |------------------+                  |
| s  | new thread...   | Reply...  [Send]  |  | s  | Reply...  [Send] |                  |
+----+-----------------+------------------+  +----+------------------+------------------+
      list 240+, drag   thread flexible, 320+      thread (drag), 320+   terminal, 300+
```

- List view: the list (width draggable with the touch-capable Resizer, min 240, stored as `sidebarW`) and the thread
  (flexible, min 320). Picking a thread shows it on the right. No third column, no terminal.
- Terminal view: the thread moves to the left pane and the terminal takes the right one (even split to start,
  draggable, in-window only); the list is hidden, so switching thread means going back to the list.
  The terminal is mounted only while shown, so the size lease (only displayed terminals send sizes) still holds.
- Enter: the **Terminal** button in the thread header (also in the empty right pane when a session is selected but no
  thread), the palette's *Go to terminal*, or a new session / shell session opened from the palette. Browser back
  returns to the list view (entering pushes a history entry). Leave: the **Threads** button in the terminal header or
  the thread header's back button (`< alpha`); both only drop `tab=terminal`, the thread stays selected.
  Three-column widths always show the terminal, so `tab=terminal` is cleared there.
- Shell: the shell toggle (terminal header) or Ctrl+` opens the phone's full-screen overlay (`PhoneShell`) over both
  panes; it is mounted only while shown.
Screenshots: `img/v2/tb-01-list-thread.png` (834 px), `tb-02-thread-terminal.png`, `tb-1000-01-list-thread.png`, `tb-1000-02-thread-terminal.png` (1000 px).

- An open attachment (`f`) takes the right pane (over the thread in list view, over the terminal in terminal view).

**Single-column navigation** (viewport below 700 px): the phone layout (`Phone.tsx`). Home = the threads pane full
width; picking a thread opens the thread full width with a back button (badge = other threads with news); the
terminal is behind the session chip in the thread header and a Thread | Terminal tab; the project switcher is the
header sheet. There is no two-column middle mode on a phone. The old 60 px tile rail (Cmd+B, `layout.rail`) is
removed; an old `rail` value in `minbox:layout` is ignored.

## 2. Terminal pane (right) and session header

Header: session name (double-click or menu > Rename), Claude's title, cwd, status pill; right side:
shell toggle (Ctrl+`), `...` session menu (Rename, Stop / Resume, Archive, Delete). The ended bar with
`Resume` stays in the terminal. The `toggle-inbox` button is gone.

The terminal element sits at a fixed position in the tree and is keyed by session id, so moving between
threads of one session never remounts it. A thread of another session reattaches the terminal.

**No thread selected** (`t` null): the thread pane shows a quiet empty hint (icon and `Pick a thread to read it
here.`, no session list); the terminal still shows `route.s`. With no
session selected on load we pick the most urgent session. Opening a terminal without a thread: the session chip in the phone thread header,
the session filter popover, Cmd+K > a session, the project's main session.

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

**Attachments on the phone.** Tapping an attachment that opens beside the thread (image thumbnail, file tile, the
Artifacts grid, a link in a message body) sets `route.f`; the phone layout then renders `AttachmentViewer` (`phone`
prop) as a full-screen overlay (`data-testid=phone-attachment`) in front of the phone UI, inside the phone container
so the visual-viewport height and safe-area insets apply. Header: file name, `i/n` file stepper, `Open in`, and a 44 px
close button (`close-file`). The annotation panel is always the bottom sheet behind the `Comments n` button; the comment
box spans the screen width; the body scrolls and allows pinch-zoom (`touch-action: pan-x pan-y pinch-zoom`), with the
image toolbar's Fit / Actual size as the zoom toggle. The open pushes a history entry (marked `state.viewer`), so the
back gesture, Escape and the close button all return to the thread: close does `history.back()` when the viewer was
pushed (no stacked entries), else replaces `f` away; stepping between files replaces. The thread stays mounted under the
overlay, so its scroll and draft survive. Files that download (PDF, other) still go through `window.open`.
Covered by `e2e/phone-attachments.spec.ts` (touch taps). Screenshots: `img/v2/ph-viewer-image.png`, `ph-viewer-markdown.png`.

## 5. Cmd+K

Unchanged search (threads, messages, files). Threads group comes first as before; a **Sessions** group (client
side, name match) is appended and opens the session's terminal. Default scope is "All sessions" (no longer
the selected session) since the list is global.

## Migration notes (what moved or went away)

| Old | v2 |
| --- | --- |
| Sidebar session list with sections | Gone from the main screen. Session filter popover / phone session sheet; the 60 px session-tile rail was removed later |
| Per-session inbox column (`InboxPane`) and its thread list | Replaced by the global Threads pane; `InboxPane`, `PhoneInbox` removed |
| All inbox page (`open-all-inbox`, `v=inbox`) | Merged into the home list; `v=inbox` links open the main screen |
| `New` button on the session list | `+ New` in the threads top bar, `+ New session...` in the target selector |
| Sidebar footer (Settings, Board, Decide, Drafts) and list options | `...` menu in the threads top bar |
| Session `...` menu on a row (Rename, Stop, Archive, Delete) | Session header `...` over the terminal; phone session sheet rows |
| `toggle-inbox` button | Removed |
| `layout.inboxW` | Unused; `sidebarW` = threads width, `threadW` = thread width |
| Search default scope = selected session | All sessions |
| Phone session list as home | Phone thread list as home; session list is a sheet |
| Wide (>=1680) four-pane mode | Always three panes; wide just widens them |
| Thread header back button `< session-name` | Kept; it clears the selected thread (empty state) |

## As built (differences and rough edges)

- Column widths reuse the layout keys `sidebarW` (threads list) and `threadW` (thread pane); the terminal is the
  flexible column. At 1500 px the terminal is about 650 px wide (it was about 680 px with the old two-column
  inbox); with the shell pane open the list and thread pane narrow first.
- The session filter and the composer target are separate: picking a session in the filter also selects it, which
  moves the target (target follows the selected session until the person picks another one in the selector).
- `+ New session...` from the composer offers Claude Code sessions only (a message must go to Claude).
- Snoozed and archived threads sit behind the `Snoozed / Archived n` fold in every grouping.
- Session `Rename / Stop / Resume / Archive / Delete` live in the terminal header menu (and the phone session sheet);
  an archived session is no longer listed anywhere (resume it from its header while it is still selected).
- Screenshots: `docs/img/v2/` (made by `web/e2e/screenshot-v2.spec.ts`, `SCREENSHOTS=1 SCREENSHOT_DIR=...`).
- Thread status (`working` / `need_action` / `finished`, see api-contract "Thread status"): a compact badge on every
  thread row and in the thread header (pulsing blue dot, amber dot, muted check). "Waiting" (chip, badges, rails,
  palette) is `need_action`. Grouping "Status" lists Needs action, Working, Finished. The thread's More menu has
  "Mark as ...". There is no Working filter chip (keeps the chip row short on phones).
