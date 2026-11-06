# UI v2: Projects

A **project** is `(host, dir)` plus a name. Sessions (and through them threads, drafts, attachments) are
resources under a project. The project is the top-level scope of the UI, left of the threads list.

## Decisions

| Question | Decision |
| --- | --- |
| Identity | A project has `id`, `name`, `dir`, `host_id`. `(host_id, dir)` is unique among non-archived projects. |
| Session -> project | `sessions.project_id` (nullable in SQLite, always set by the code). A thread reaches its project through its session; the thread JSON carries `project_id` and `project_name` (joined, no stored column). |
| Who creates projects | The person (`+` in the project column), or implicitly: `POST /api/sessions` without `project_id` finds the project for `(host_id, resolved cwd)` and creates it on first use. Every session in minbox is created by that one path (UI, `minbox` CLI, API). The Claude Code plugin/hooks never create sessions, they attach to one by token, so they need no change. |
| Session sub-directory | `POST /api/sessions` with `project_id` and no `cwd` starts in the project's dir. A `cwd` is still accepted (a sub-folder override, e.g. a git worktree); it is stored on the session as before and the session stays in the project. The UI does not offer the override: the dialog takes dir and host from the project. |
| Edit | Rename always. `dir` and `host_id` only while the project has no sessions (409 otherwise). |
| Archive | Only when no session is live (not ended, not archived). Archiving also archives the project's ended sessions (same timestamp); unarchiving restores exactly those. Unarchiving or restarting a session, or creating a session in it, unarchives its project. |
| Delete | Deletes the project and ALL its sessions and threads (messages, annotations, attachments), stopping running sessions first; the folder on disk is not touched; cannot be undone. `GET /api/projects/{id}/delete-preview` gives the counts. The UI opens a confirm dialog: with sessions it warns `This also deletes N sessions and M threads (all messages and attachments). K are running and will be stopped. The folder on disk is not touched. This cannot be undone.` and the destructive button reads `Delete project and N sessions`; an empty project gets a plain confirm. Same dialog on phone. |
| Order | Pinned first, then most recent activity (latest session/thread update). `PATCH {pinned:true}` pins. No manual drag. |
| Main session | Each project has at most one **main session**: `projects.main_session_id` (nullable; it must be a Claude Code session of the project, never a shell). A new thread goes to it by default. Session JSON has `is_main`, project JSON `main_session_id`. |
| Becoming main | The first Claude Code session created in a project (UI, plugin/CLI by `(host, dir)`, `POST /api/sessions`) becomes main when the project has none. Later ones are extra; `POST /api/sessions {main:true}`, `PATCH /api/projects/{id} {main_session_id}`, the picker's `Set as main`, the session `...` menu and the palette action promote one. The `+ New session…` dialog has a `Make main session` checkbox when the project already has a main one. |
| Main lifecycle | Stopping/ending keeps it main (the composer says `Session ended: Claude gets this after Resume`, as for any ended session). Archiving or deleting the main session is 409 while the project has another live Claude Code session, unless the request promotes one (`?promote=<session id>` on `POST /api/sessions/{id}/archive` and `DELETE /api/sessions/{id}`). If it is the last one the project is left without main; the next Claude session started there becomes main. The UI offers `Set as main` first and shows the 409 text otherwise. |
| Selected project | A browser preference (`minbox:v2-filter.project`), next to the existing session filter. `''` = All projects. Selecting a thread or session of another project (palette, link) switches the project to it. |

## Desktop wireframe (1500 px)

```
+------------+----------------------+--------------------------+-------------------------+
| (=) All 7  | Threads       [+ New]| < Thread subject         | deploy-api   Idle [sh]  |
|------------| [All 7][Waiting 2]   | Claude Code in deploy-api|                         |
| * api  [2] | [Unread 3]           |                          |   $ claude              |
|   ~/work/api| Session: All v Group |   ...messages...         |   (terminal)            |
| o docs  [1]|----------------------|   ...question card...    |                         |
|   ~/docs   | * Which DB?   2m ?1  |                          |                         |
| o gpu-job  | [api] [deploy-api]   |                          |                         |
|   ~/job gpu1| o Release notes  1h  |                          |                         |
|            | [docs] [release]     |                          |                         |
|            |----------------------| Reply to Claude Code...  |                         |
|            | to: * deploy-api  v  |                          |                         |
| [+ New     | [ Start a thread...] |                          |                         |
|  project][<]| clip   Send          |                          |                         |
+------------+----------------------+--------------------------+-------------------------+
  Projects      Threads (340)          Thread (520)               Terminal (flex) [+ Shell]
  (176 / 56)
```

Rail entry = **name**, dir shortened to `~/...` (second line, mono),
host badge for a remote host, and an aggregate badge: amber number = threads waiting on the person, grey
number = unread. `All projects` is the first entry (sum of both). Below the list: `+` (new project).
Right-click or the `...` on hover: Rename, Edit folder/host (only when empty), Pin, Archive, Delete.
Below 1400 px (or by the collapse button) the project column shrinks to 56 px tiles (two letters, count badge only, no status dot,
name and status in the tooltip).

Icon: the project menu's `Set icon…` opens a dialog with an emoji field, a grid of about 60 common emoji, `Upload image…`
(PNG/JPEG/GIF, cropped square by the server, previewed in the dialog), `Remove icon`, Save and Cancel. A tile shows the emoji
(large) or the image (rounded, object-cover, thin border) instead of the two letters; projects without an icon keep the letters.
The wide rail row and the phone project list and header show a 20-24 px icon before the name.

Selecting a project scopes the threads list, the session filter, the composer targets and the session
chips to it. List rows carry no project or session chip, also in `All projects`.

## Composer target

With a project selected the target defaults to the project's **main session** (marked `main` in the list; other rows have `Set as main` on hover). In All projects it is the open session's, as before. A session picked by hand holds while the open session does not change.

```
 to: * deploy-api  v              <- scoped to the selected project
 +---------------------------+
 | Find a session            |    All projects: sessions grouped under project headers
 | api                       |
 |  * deploy-api    Idle     |
 |  o migrate       Working  |
 | docs                      |
 |  o release       Idle     |
 |---------------------------|
 | + New session...          |    inside a project: starts there, no folder question
 +---------------------------+
```

`+ New session...` in a project opens the dialog with the folder and host fixed to the project (shown as
a read-only line; only the name is asked). In `All projects` the dialog first asks which project
(select; or `+ New project` there). The plain `+ New` in the threads bar behaves the same.
New sessions are always Claude Code; plain shell sessions can no longer be created (the companion shell
replaces them), and ones from older builds keep working.

## New project dialog

```
 New project
 Host     [ local ] [ gpu1 ]
 Folder   [ ~/work/api               ]   (same folder browser as New session)
 Name     [ api                      ]   (default: last folder name)
                         [Cancel] [Create project]
```

## Phone

Home header: `[logo] [ api  v ]  [search] [+] [...]`. The project button opens a bottom sheet
(`All projects` first, then projects with dot, name, dir, badges, `+ New project`). The selection scopes
the home list and the composer target. The existing session sheet is unchanged but lists the selected
project's sessions only.

## Palette (⌘K)

New **Projects** group (prefix `!`): Enter selects the project (switches the list scope), `All projects` is
an action. Thread and session rows show the project name in their detail.

## Migration notes

The migration runs in `store.Open` after the schema step, in one transaction, and is idempotent: it only
touches sessions whose `project_id` is NULL or empty, so running it again (or after the previous build
created more sessions) changes nothing for already assigned sessions.

1. Sessions with `project_id IS NULL`, oldest first, are grouped by `(host_id, cleaned cwd)`
   (`path.Clean`; a trailing slash does not make a new project). `/a/b` and `/a/b/sub` are separate projects.
2. A group whose `(host_id, dir)` already has a project joins it (that is how a second run, or sessions
   created by the old build after a rollback, are absorbed).
3. A session with an empty or non-absolute cwd goes to the catch-all project of its host named
   `No project` (dir `''`).
4. Name = last path component of dir (`/` for the root). A name already used (case-insensitive) becomes
   `name (host name)` for a remote host, and `name 2`, `name 3`... if still taken.
5. Each project without a valid main session gets one: its most recently active Claude Code session, a live one
   before an ended one before an archived one; none when it only has shell sessions. (This runs on every start, so a
   main session deleted by the old build is replaced.)
6. A project whose sessions are all archived is archived (`archived_at` = latest session archive time).
7. `created_at` = oldest session of the group. Threads, messages, attachments, drafts (browser local)
   are untouched: they hang off sessions.

Ended and shell sessions are grouped like any other. Sessions on a host that was deleted keep their
`host_id` and group with it (name falls back to the host id).

## Rollback notes

Everything is additive: a new table `projects` and a new nullable column `sessions.project_id`. The
previous build's schema step is `CREATE TABLE IF NOT EXISTS` plus `ADD COLUMN` for columns it knows; it
selects explicit column lists, so it ignores the new table and column and **a database migrated by this
build can still be opened by the previous build**. Sessions created by the previous build have NULL
`project_id`; the next start of this build assigns them. Projects created or renamed meanwhile are not
visible to the previous build, and project names changed in this build are not undone.

## As built

- Files: `internal/store/projects.go` (table, migration, rules), `internal/server/projects.go` (endpoints),
  web `ProjectRail.tsx`, `PhoneProjects.tsx`, `lib/projects.ts`; `NewSession.tsx` also makes and edits projects.
- The project column costs width: it is 176 px (names) at >= 1400 px and 56 px (tiles) below, or as toggled. The thread
  pane (down to 440 px) and then the threads list (down to 280 px) pay for it, so the terminal keeps about the width it had.
- `+ New session...` always offers a project chooser; its last entry, `A folder without a project yet...`, is the old
  folder browser (the project is then made from the folder). With no project at all the dialog opens in that mode.
- Sessions show no status of their own (waiting/working lives on threads; only `Ended` is shown). Aggregate badges: amber = waiting threads, grey = unread.
- Archived projects fold at the bottom of the rail (`Archived n`, `Restore`); there is no manual drag order, only `Pin to top`.
- Not done: promoting a successor from the archive/delete UI (the API takes `?promote=`; the UI shows the 409 text and
  offers `Set as main`), drag-to-reorder, a host badge screenshot (needs a paired remote host).
- Screenshots: `docs/img/v2/p-*.png` (made by `web/e2e/screenshot-projects.spec.ts`, `SCREENSHOTS=1 SCREENSHOT_DIR=../docs/img/v2`).
- This branch was built on `main` plus the v2 threads-first branch (`worktree-agent-a474c92bff92ec878`), because `v2-pre1`
  was identical to `main` and had no threads-first UI.
