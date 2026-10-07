# Branch switching in a session: design

Date: 2026-10-07
Status: decided
Builds on: `2026-10-05-branch-documents-design.md` (phase 1 shipped; this is phase 2 with
the changes below).

## What the user asked for

> The git button should show all of the branches in the session and let users switch
> between them. When they do, it should not sync branch on branch but clear the previous
> branch files and load the new ones. Agents should be able to do the same.

A session holds every branch its members work on, each kept apart. Two people on the same
branch see each other's work live. Anyone (person or agent) can move to any branch in the
session from the branch menu or an MCP tool, and their folder then shows that branch's
work, never a mix.

## Changes to the 2026-10-05 design

| 2026-10-05 said | Now |
|---|---|
| The top bar branch label "is a label, not a control". | It is the **branch menu**: every branch in the session, who is on each, and a Switch action. |
| Quilt "never writes" to git. | Quilt runs exactly one kind of git write, and only when a member asks for it: **the switch** (`git switch`, a `git fetch` of that one branch when it is missing, and a safety ref for the work it moves off disk). It still never commits, pulls, pushes, merges or touches GitHub. |
| A switch made in a terminal moves the folder to the new branch's document. | Unchanged, and it is the same code path as a switch from the menu once HEAD has moved. |

Everything else in the 2026-10-05 design stands: one Yjs document per branch on the relay,
the room document for everything room-wide, presence carries the branch, per-branch local
state under `.quilt/branches/<key>/`, hosted agents with a `branch`, migration of old rooms.

## Decisions

| Question | Decision |
|---|---|
| Which branches the menu lists | Every branch document in the room (room meta `branches`: key → `{ by, at, base }`), each with the members on it (from presence), current first, then by most members, then most recent. |
| What a switch does (folder) | 1. Flush: every pending local edit lands in the current branch document, so that branch's uncommitted work is safe in the room. 2. Save local state under `.quilt/branches/<old>/`. 3. Keep a local safety copy of the uncommitted work: `git stash create` → `refs/quilt/parked/<old>` (no stash-list entry; replaced on the next park of the same branch). 4. Clear: shared paths go back to HEAD (`git checkout -- <tracked changed>`), untracked shared files are removed. 5. `git switch <branch>` (see "branch not here" below). 6. Load: subscribe to the new branch document; every shared path is written from it, paths it does not have but HEAD does are left as git has them, files from the old branch that remain only as untracked leftovers were already removed in step 4. 7. Go live. The log says "You're on feature-x now; the session's work there is on disk". |
| The branch is not in this repo | `git fetch origin <branch>` then `git switch --track origin/<branch>`. If the remote doesn't have it either: `git switch -c <branch> <base>` where `base` is the commit the branch document was started from, when this repo has that commit; else from the current HEAD. The session's work on that branch is on disk either way; what git shows as changed differs, and the log line says so ("feature-x isn't pushed yet, so git shows Duncan's work there as changes"). |
| A branch that is in git but not the session yet | The menu's "Other branches" lists local branches (`git for-each-ref refs/heads`) not in the session. Switching to one creates its branch document, seeded from this folder after the switch (first-join path). |
| New branch from the menu | "New branch…" takes a name (checked with `git check-ref-format --branch`), runs `git switch -c <name>` from the current HEAD carrying the current work, and seeds a new branch document from the folder. |
| Switch refused | Git busy (merge, rebase, index.lock): the item is disabled with "Finish the git merge first". The switch itself failing (git error): the folder stays on the old branch and document, nothing cleared; the log shows git's message. Clearing happens only after the old branch's work is confirmed in the room (flushed and acknowledged by the relay) and the safety ref is written. |
| Who moves | Only the folder that asks. A switch never moves anyone else. Agents working in the same folder move with it (it is their folder too); the switch tells them through the activity/agent feed: "Dan switched this folder to feature-x". |
| Agents (local) | `quilt_switch_branch({ branch, create? })` over the control API, same code path as the menu. `quilt_status` lists the session's branches and who is on each. |
| Agents (hosted, no folder) | `quilt_switch_branch` sets the agent's own branch (kept per member in room meta); file tools, claims and history then read and write that branch document. Default: the room's active branch (most connected members; ties go to the host's). |
| Claims | Per branch: a claim on `src/a.js` on `main` does not block `src/a.js` on `feature-x`. Keyed `branch\0path` in relay meta; the default branch keeps bare paths so existing claims carry over. |
| Commit requests, chat, tasks, agent feed, activity | Room-wide, with a `branch` field on new commit requests and activity entries; the commit chip shows the branch on each request. |
| A branch nobody is on | Its document stays in the room (unloaded from relay memory after 10 minutes, reloaded on demand) and is listed in the menu. Removing a branch from the session is a menu action for the session owner ("Remove from session"); it deletes the branch document, never the git branch. |
| No git in the folder | No menu: the label is hidden, as today, and the folder syncs the default branch. |

## Protocol and storage

As in the 2026-10-05 design: `MSG_SYNC`/`MSG_AWARENESS` carry a document id (`0` room,
else branch key); `MSG_BRANCH {branch}` subscribes a connection to one branch document
(one at a time); `data/<room>.ydoc` plus `data/<room>/branches/<key>.ydoc`. Protocol
version bumps; older clients are told to update. Old rooms migrate on first load: the
room document's file maps become the default branch's document.

## Testing

Real relay, two or three sessions, real git (`test/branch-switch.test.js`):

1. Two members on `main` pair; A switches to `feature-x` from `switchBranch`: A's folder
   has `feature-x`'s files and none of `main`'s uncommitted work; B's `main` edits never
   reach A; A's `feature-x` edits never reach B.
2. B switches to `feature-x`: B now sees A's live edits there, and A sees B's.
3. A switches back to `main`: the room's `main` work (including B's edits made while A was
   away) is on A's disk.
4. Switch with uncommitted work: the work is in the old branch's document and in
   `refs/quilt/parked/<old>`; git didn't refuse the switch.
5. Branch not in the second repo and not on the remote: created from `base`, the files
   match the document, and the log line says it isn't pushed.
6. A terminal `git checkout` and a menu switch end in the same state.
7. Git busy: switch refused, nothing changed.
8. Hosted agent: `quilt_switch_branch` then read/write go to that branch's document.
9. Claims on the same path on two branches don't block each other.
10. Relay: branch documents unload and reload; migration of an old room; bad key refused.

UI: by hand with two folders, switching from the menu both ways.
