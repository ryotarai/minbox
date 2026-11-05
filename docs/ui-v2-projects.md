# UI v2: Projects

A **project** is `(host, dir)` plus a name. Sessions (and through them threads, drafts, attachments) are
resources under a project. The project is the top-level scope of the UI, left of the threads list.

## Decisions

| Question | Decision |
| --- | --- |
| Identity | A project has `id`, `name`, `dir`, `host_id`. `(host_id, dir)` is unique among non-archived projects. |
| Session -> project | `sessions.project_id` (nullable in SQLite, always set by the code). A thread reaches its project through its session; the thread JSON carries `project_id` and `project_name` (joined, no stored column). |
| Who creates projects | The person (`+` in the rail), or implicitly: `POST /api/sessions` without `project_id` finds the project for `(host_id, resolved cwd)` and creates it on first use. Every session in minbox is created by that one path (UI, `minbox` CLI, API). The Claude Code plugin/hooks never create sessions, they attach to one by token, so they need no change. |
| Session sub-directory | `POST /api/sessions` with `project_id` and no `cwd` starts in the project's dir. A `cwd` is still accepted (a sub-folder override, e.g. a git worktree); it is stored on the session as before and the session stays in the project. The UI does not offer the override: the dialog takes dir and host from the project. |
| Edit | Rename always. `dir` and `host_id` only while the project has no sessions (409 otherwise). |
| Archive | Only when no session is live (not ended, not archived). Archiving also archives the project's ended sessions (same timestamp); unarchiving restores exactly those. Unarchiving or restarting a session, or creating a session in it, unarchives its project. |
| Delete | Only a project with no sessions at all (409 otherwise: archive instead). A delete never loses a session, thread or draft. |
| Order | Pinned first, then most recent activity (latest session/thread update). `PATCH {pinned:true}` pins. No manual drag. |
| Selected project | A browser preference (`minbox:v2-filter.project`), next to the existing session filter. `''` = All projects. Selecting a thread or session of another project (palette, link) switches the project to it. |

## Desktop wireframe (1500 px)

```
+----------+--------------------+--------------------------+----------------------------+
| [All]    | Threads        [+ New]| Thread subject        |  deploy-api  Idle  [shell] |
|  all  7  | [All 7][Waiting 2]    | Claude Code in api    |                            |
| -------- | Session: All  v  Group| ...messages...        |   $ claude                 |
| * api    |----------------------|                        |   (terminal)               |
|   ~/work/api    [2]  | * Which DB?  [api]  |                          |                            |
| o docs   | o Release notes [docs]|                         |                            |
|   ~/docs        [1]  |                      |                          |                            |
|   web    |----------------------|                        |                            |
|   ~/web  @gpu1       | to: * deploy-api  v  | Reply...               |                            |
| [+]      | [ Start a thread...  ]|                         |                            |
+----------+----------+----------------------+--------------------------+----------------------------+
  Projects (176)   Threads (340)      Thread (520)               Terminal (flex)
```

Rail entry = status dot of its busiest session, **name**, dir shortened to `~/...` (second line, mono),
host badge for a remote host, and an aggregate badge: amber number = threads waiting on the person, grey
number = unread. `All projects` is the first entry (sum of both). Below the list: `+` (new project).
Right-click or the `...` on hover: Rename, Edit folder/host (only when empty), Pin, Archive, Delete.
Below 1400 px (or by the collapse button) the rail shrinks to 56 px tiles (two letters, badge on the tile,
name in the tooltip).

Selecting a project scopes the threads list, the session filter, the composer targets and the session
chips to it. In `All projects` every row shows a project chip (`api`) before the session chip.

## Composer target

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
(select; or `+ New project` there). The plain `+ New` in the threads bar (which can start a shell too)
behaves the same.

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
5. A project whose sessions are all archived is archived (`archived_at` = latest session archive time).
6. `created_at` = oldest session of the group. Threads, messages, attachments, drafts (browser local)
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

See the section at the end of this file once the work is done.
