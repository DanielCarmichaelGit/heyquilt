# Branch documents and git awareness: design

Date: 2026-10-05
Status: decided

## Goal

A session is a shared working tree. Git stays plain git on each person's machine: Quilt
reads it to understand what is happening and never writes to it. Two things follow:

1. **Branches never mix.** The room keeps one live document per branch; a folder syncs
   with the document for the branch it is on. A checkout means what it means in git:
   *this person* is now on that branch. Nobody is asked to branch, follow, pause, or
   manage anything.
2. **Git operations are not edits.** A stash, reset, checkout, pull or rebase on one
   machine is recognised as such and handled, instead of being broadcast to the room as
   thousands of edits. Nobody's uncommitted work is lost by someone else's git command.

Quilt's own "lightweight source control" is only this: the branch documents, the merge
engine, merge records and the chronology. Quilt does not commit, push, pull, create
branches or worktrees, store git objects, or talk to GitHub, GitLab or Bitbucket. The one
exception kept is **New session from a GitHub repo and branch**, which clones once.

## What goes

- The Git button and popover in the session (status, pull, rebase, commit, push, PR):
  `src/ui/git.js`, the `/api/sessions/:id/git*` routes, `gitAction`, `gitDir`.
- Quilt performing git for the host: the `/commit` daemon route, the `quilt_commit` MCP
  tool, `hostsGit`, `gitops.status/pull/commit/pushAndOpenPr`.
- The agent guide text that says the host commits through Quilt.

What stays: **commit requests** (`quilt_request_commit`, `quilt_commit_status`, the
commit chip and requests list): a conversation between members ("I made a lot of changes
that are ready; can someone prepare a commit?"), marked done by a person. And the New
session dialog's GitHub tab (`cloneRepo`, `listRepos`, `listBranches`, `ghStatus`,
`checkBranchName`).

## Decisions

| Question | Decision |
|---|---|
| Unit of sharing | One **branch document** per branch per room, holding that branch's files. A **room document** holds everything room-wide: chat, tasks, agent feed, commit requests, activity (with a `branch` field), members. |
| Branch key | The branch name from `.git/HEAD` (`main`, `feature/x`). Detached HEAD: `@<12-char sha>`. No git: the key `∅`, which maps to the room's **default branch** (see below). Worktrees need nothing special: each is a folder on a branch. |
| Default branch | The room's first branch document. A folder with no git syncs with it. When the first real branch appears in a room that only had `∅` (someone ran `git init`), the `∅` document *is* that branch's document from then on (a key alias in room meta), so nobody diverges. |
| Same name, different history | Same name = same document, always. A member behind on the branch sees the shared tree as local modifications until they pull, exactly like joining today. |
| Two inits, two names | If a member's new branch document would start from a tree identical to the default document (two people ran `git init` and got `main` and `master`), Quilt warns once in both folders' logs and the room chat. It does not merge them: two names are two branches in git. |
| What Quilt reads from git | `.git/HEAD` (branch), the in-progress markers (`index.lock`, `MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`), `git rev-parse HEAD`, `git status --porcelain=v2 -z -- <paths>`, and `git show <sha>:<path>` for three-way bases. Nothing else, and never a write. |
| Classifying a burst | A burst is any change while an in-progress marker exists, or ≥ 20 paths changing within 2 s, or any change within 2 s of `.git/HEAD` changing. It is classified by asking git (see below), never by timing alone. |
| Switch | HEAD now names another branch (or a detached commit): the folder leaves the old branch document and joins the new one. The old branch's local state is kept in `.quilt/branches/<key>/`, so coming back is a rejoin and runs the offline-merge engine against whatever the room did there meanwhile. |
| Advance | HEAD moved but the branch is the same (pull, merge, rebase, cherry-pick, fast-forward): new committed content. It is folded into the branch document by a three-way merge per changed file with base = the file at the old HEAD, ours = the file now, theirs = the document. Clean hunks apply, overlaps go to the AI, real clashes open merge records. Paths unchanged between the two commits are untouched. |
| Discard | HEAD unchanged and the changed paths are now clean in `git status` (stash, `reset --hard`, `checkout -- .`, `restore`): the room's work is **not** discarded. That machine's sync is held until its tree **settles**; then the branch document is written back onto it, and one line tells the person: "Quilt kept the session's work on `<branch>`; your stash still has your copy." |
| Settle | No in-progress marker, no `index.lock`, and no file change for 2 s. If HEAD advanced while settling (stash, pull, pop), the hold ends as an **advance** with base = the HEAD before the discard, so a pull-and-pop lands once, merged, not as a flicker. |
| Busy | While an in-progress marker exists (a merge or rebase mid-way, with git's own conflict markers on disk), the folder's sync is held: nothing out, remote updates queued. It ends as advance or discard when the marker goes. |
| Commit | `git commit` changes no shared file; nothing happens. Members who later pull see content they already have; git's own clean-ness check decides what that means on their machine. |
| Branch rename | A switch to a new name with an identical tree: a new document seeded from the tree; the old one idles out. |
| Branch deleted locally | Nothing: the document belongs to the room. |
| Dirty tree on join | Unchanged: first join backs up to `.quilt/conflicts/` and takes the session's version. |
| Offline rejoin | Unchanged, now per branch: `merging.json`, `state.bin`, `claims.json` live under `.quilt/branches/<key>/`. |
| Claims, merge records, chronology, tallies, large-file keys | Per branch document. Claims are keyed by branch in room meta. |
| Who is where | Presence carries the branch. The people menu shows partners on other branches as "Duncan · feature-x". The top bar shows your branch where the Git button was; it is a label, not a control. |
| Hosted agents | They have no folder, so they work on a branch: `quilt_read_file`/`quilt_write_file`/claims/history take an optional `branch`, defaulting to the room's **active branch** (the branch with the most connected editors; ties go to the host's). `quilt_status` lists the room's branches with who is on each. |
| Storage on the relay | `data/<room>.ydoc` (room document) and `data/<room>/branches/<key>.ydoc`. A branch document with no connected member is unloaded from memory after 10 minutes and reloaded on demand; its file is deleted with the room (room TTL) or after 30 days without a member on it. Size limits apply per room across all its documents. |
| Older clients | The protocol version bumps; a client that speaks the old one is told to update (existing `CLOSE_NEEDS_UPDATE`). Existing rooms migrate on first load: the old document's file maps become the default branch document, everything else stays in the room document. |
| Different repos in one room | Not detected. A room is one project. |

## Pieces

### `src/gitstate.js` — reading git, never writing

Pure functions over a folder, each shelling out to `git` with a 5 s timeout and treating
any failure as "not git":

- `gitDir(root)` resolves `.git` whether it is a folder or a worktree's `.git` file.
- `headKey(root) → { key, branch | null, sha | null } | null` from `HEAD` (no git → null).
- `busy(root) → string | null`: the name of the in-progress marker present, or null.
- `classify(root, { changed, before }) → { kind: 'switch' | 'advance' | 'discard' | 'edit' | 'busy', head, prevHead }`
  where `before` is the `headKey` and sha seen before the burst and `changed` the paths
  in it. `discard` means HEAD is unchanged and every changed path is clean in
  `git status --porcelain=v2 -z -- <paths>`; `advance` means the sha moved on the same
  branch; `switch` means the key changed; otherwise `edit`.
- `fileAt(root, sha, rel) → string | null` (`git show sha:rel`), used for merge bases.
- `watchGit(root, onEvent)` watches `HEAD`, the marker files and `index.lock` with the
  same chokidar instance style the folder uses, emitting `head`, `busy`, `idle`.

### `src/session.js` — holds, settle, switch

- `this.branch` (current key) and `this.hold` (`null | 'busy' | 'settling' | 'switching'`).
  While held: `ingest` returns false for every path, `writeOut` is skipped, remote
  updates are queued per path and applied when the hold ends (the existing `merging`
  guard, generalised).
- A burst detector in front of `flushPending`: when the burst condition is met, the
  pending paths are not ingested; `classify` runs and the outcome is dispatched:
  - `edit` → ingest as today.
  - `busy` → hold until `idle`, then classify again.
  - `discard` → hold `settling`; on settle, if HEAD is unchanged write the branch
    document back (`writeOut` for the held paths) and log the one line; if HEAD advanced,
    fall through to `advance` with `prevHead` from before the discard.
  - `advance` → for each path changed between `prevHead` and `head` (`git diff --name-only`),
    `mergeOne` with base = `fileAt(prevHead)`, ours = disk, theirs = document; same
    outcomes as the offline merge (push, merged, AI, record). Paths unchanged between the
    commits keep the document's version on disk.
  - `switch` → `switchBranch(head.key)`.
- `switchBranch(key)`: flush, hold `switching`, save the old branch's state under
  `.quilt/branches/<old>/`, detach the document, ask the relay for the new branch
  document, load `.quilt/branches/<key>/` if present (rejoin path: `captureOffline` →
  sync → `mergeOffline`) or run the first-join path on an empty state, then `goLive` on
  the new document and release the hold. Claims and merge records re-read for the branch.
- `status()` gains `branch`, `branches` (room list with members) and `hold`.

### Protocol (`src/protocol.js`, `src/connection.js`, `src/server.js`)

- `MSG_SYNC` and `MSG_AWARENESS` payloads are prefixed with a document id: `0` for the
  room document, else the branch key string. `MSG_BRANCH` (client → relay, JSON
  `{ branch }`) subscribes the connection to a branch document; the relay answers with
  sync step 1 for it and unsubscribes the previous one.
- `Room` keeps `this.doc` (room) and `this.branches: Map<key, { doc, file, guard, conns, lastUsed }>`,
  loading a branch document from disk on first subscription and unloading it 10 minutes
  after the last unsubscription. `checkChange` and the claims guard run per branch
  document. `saveMeta` records `defaultBranch`, `aliases` (`∅` → key) and per-branch
  claims. Awareness carries `branch`.
- Migration: on loading a room whose `.ydoc` has `files`, the relay creates
  `branches/<defaultBranch or ∅>.ydoc` with copies of `files`, `blobs`, `fileKeys`,
  `merges`, `history`, `changes` and deletes them from the room document, once, before
  any client connects.

### Relay MCP (`src/relay-mcp.js`)

File tools, claims and history take `branch?`; `quilt_status` lists branches. The room's
active branch is computed from connections' awareness.

### UI (`src/ui/`)

- `src/ui/git.js` removed; a branch label in the top bar (`#branch-chip`) shows the
  current key (nothing for `∅`), with a tooltip listing who is on which branch.
- People menu rows show a partner's branch when it differs from yours.
- The file tree, merge bar and compare view read from the current branch; switching
  redraws them. A hold shows a small "syncing paused: git is busy" note under the top bar.
- Log lines (plain English): "You're on feature-x now; the session's work there is
  loading", "Quilt kept the session's work on main; your stash still has your copy",
  "Merged the commits you pulled into the session's work (2 files)".

### Removal

`src/ui/git.js`, the UI routes and `gitAction`/`gitDir`, `POST /commit`, `quilt_commit`,
`hostsGit`, and `gitops.status/pull/commit/pushAndOpenPr`, with their tests. Commit
requests keep working; the chip's "mark done" stays a person's action.

## Error handling

- `git` missing or failing: the folder is treated as no-git (`∅`), with one log line.
- A classify that cannot run (timeout) treats the burst as `busy` and retries on settle;
  it never falls through to broadcasting.
- A switch to a branch document the relay cannot load (disk error) keeps the hold and
  tells the person; the folder is not synced into the wrong document.
- The relay refuses a `MSG_BRANCH` key that is not a valid branch name (`git check-ref-format`
  rules) or longer than 200 characters.

## Testing

Each case below is a named test; the engine tests run against a real relay with two
sessions and real `git` in the folders (`test/branch-docs.test.js`, `test/gitstate.test.js`):

1. classifier: edit vs discard vs advance vs switch vs busy on real sequences (`checkout`
   clean and dirty, `stash`/`pop`, `reset --hard`, `restore`, `pull --ff`, `merge` with and
   without conflicts, `rebase` with a conflict then `--continue`, `cherry-pick`, `commit`,
   `checkout -b`, branch rename, detached HEAD, a worktree's `.git` file, no git).
2. two members on `main` pair live; one checks out `feature-x`: their edits never reach
   `main`, `main`'s edits never reach them; checking out `main` again restores the room's
   `main` work and merges anything done meanwhile.
3. stash on one machine while the partner edits: the partner's file is untouched, the
   stasher's file comes back, the log line appears once; stash then pull then pop lands
   once with the pulled commit merged.
4. `reset --hard` by an agent mid-edit: same as 3.
5. a rebase with a conflict: no conflict markers reach the partner; after `--continue`
   the new commits merge into the document.
6. a pull that changes a file the partner is editing: three-way merge; overlap → merge
   record; clean → both folders agree.
7. `git init` in a no-git room: the `∅` document becomes `main`; the no-git partner keeps
   pairing.
8. two inits, `main` and `master`: the warning is logged; the two documents stay apart.
9. detached HEAD and `checkout -b` carry uncommitted work as git does.
10. two worktrees of one repo in one room, different branches, different documents.
11. offline rejoin per branch: leave on `main`, edit `main` offline, switch to `feature-x`,
    rejoin: `feature-x` syncs; switching back merges the offline `main` edits.
12. relay: branch documents unload after idle and reload with content; migration of an
    old room file; `MSG_BRANCH` with a bad key refused; older protocol told to update.
13. hosted agent reads and writes the active branch by default and a named one on request.
14. commit requests still round-trip; the removed routes and tools are gone (404s, tool
    list).

UI: checked by hand with two folders on different branches.

## Phases

1. **Git awareness without new documents**: `gitstate.js`, the burst detector, holds,
   settle, discard write-back, advance merges, the removal of the git surface. Ships value
   alone: no more stash wipes, no git conflict markers broadcast, pulls merge through the
   engine. A switch to another branch pauses that folder's sync (held, with the line
   "You're on feature-x; this session syncs main. Sync resumes when you're back on main")
   and resumes through the offline-merge path on return, so branches cannot mix even
   before branch documents exist.
2. **Branch documents**: protocol, relay storage and offload, session switching, per-branch
   local state, presence, UI label, hosted agents, migration.
3. **Polish**: the two-inits warning, start-from-branch dialog polish, log copy.
