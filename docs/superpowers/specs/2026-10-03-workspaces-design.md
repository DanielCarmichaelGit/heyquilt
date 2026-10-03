# Workspaces — design

Date: 2026-10-03. Builds on sessions (relay rooms), accounts and spaces (personal or org), agent sign-in,
access types, the hosted MCP and encrypted large files.

## Goal

A **workspace** is a new platform primitive: a durable container, like a Claude project, that owns the things
a group of people and agents work with over time:

- **Sessions.** Every session can be started inside a workspace. The workspace lists them, live and past.
- **Files and folders.** A library for the things that are not code: images, video, PDFs, spreadsheets, CSV,
  zips, documents. Uploaded once, reachable by every member and every workspace agent.
- **Agents.** Agents can be members of a workspace, see its files and sessions, talk in its chat and take
  tasks from its board. Two agents (a marketing agent that makes a video, an editor agent that cuts it) hand
  work to each other through the library and the board.
- **Realtime.** Workspace chat, board, activity and presence, synced the way a session's are.

Sessions stay what they are: synced project folders for code. A workspace sits above them and does not change
how a session syncs.

Orgs, teams, roles and access types are untouched. They decide who may reach a workspace; the workspace is
where the work is.

## Decisions

| Topic | Decision |
|---|---|
| Where a workspace lives | In a space: owned by a person (personal) or an org. A space can have many workspaces. |
| Membership | People and agents, each **editor** or **viewer**. The owner is implicit. Org workspaces can also admit everyone in the org, or in named teams, as a default access. |
| Files | A **cloud library**: bytes in Supabase Storage (the "Quilt Files" project), index in the workspace's realtime document, quota enforced by the relay. Server-readable (private bucket, signed links), not end-to-end encrypted, so previews and hosted agents work. |
| Folders | Paths. A folder is a row of kind `folder`; files have a `path` like `brand/logo.png`. |
| Versions | Uploading to an existing path makes a new version; the last 10 are kept. |
| Realtime | Every workspace has a relay room of its own, `ws-<id>`, that holds the file index, chat, board, activity and agent feed. No synced folder in that room. |
| Sessions in a workspace | A session is started with a workspace id. The API records it, the pass carries it, the relay keeps it in room meta. Workspace editors are session editors and viewers are viewers unless the session owner tightens it. Existing sessions can be moved into a workspace by their owner. |
| Agents | A workspace invites agents the way a space does today; the agent joins as a workspace member. Agents get MCP tools for the library and for the workspace room. A hosted agent may hold one workspace room and one session room at a time. |
| Admission | Workspace rooms admit by pass only (membership), never by secret link. |
| Naming in code | The session view's old name "workspace" (`src/ui/session.js`, `state.ws`, the CSS section) is renamed `session view` / `state.sv` so the word means one thing. |
| Limits (defaults, overridable per plan) | 500 MB per file, 5 GB per workspace, 2,000 files. Free personal spaces get one workspace. |

## Data model

### Accounts API (Postgres)

```sql
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users (id) on delete cascade,
  org_id uuid references orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  room text not null unique,              -- 'ws-' || id, the relay room
  default_access text not null default 'none' check (default_access in ('none', 'org-viewer', 'org-editor')),
  quota_bytes bigint not null,
  used_bytes bigint not null default 0,   -- reported by the relay
  file_count integer not null default 0,
  created_by text not null,               -- 'person:<uuid>' or 'agent:<uuid>'
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check ((owner_user_id is null) <> (org_id is null))
);

create table workspace_members (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  account text not null check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  access text not null check (access in ('editor', 'viewer')),
  added_by text not null,
  added_at timestamptz not null default now(),
  primary key (workspace_id, account)
);

create table workspace_teams (                 -- org workspaces only: whole teams let in
  workspace_id uuid not null references workspaces (id) on delete cascade,
  team_id uuid not null references teams (id) on delete cascade,
  access text not null check (access in ('editor', 'viewer')),
  primary key (workspace_id, team_id)
);

alter table relay_sessions add column workspace_id uuid references workspaces (id) on delete set null;
create index relay_sessions_workspace_id on relay_sessions (workspace_id);

create table workspace_invites (               -- email invites, like session_invites
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  email text not null,
  access text not null check (access in ('editor', 'viewer')),
  token_hash text not null unique,
  invited_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  cancelled_at timestamptz
);
```

Row-level security on, no client policies; every read and write goes through the accounts API with the
service role, like `relay_sessions`.

Agent invites get an optional `workspaceId` and `workspaceAccess`: the agent that redeems the invite is added
to `workspace_members`. The `agents` row still belongs to the person or org (billing and revocation unchanged).

### Workspace room (relay, Yjs)

Room name `ws-<workspace id>`. The same `Room` class as a session, with a `kind: 'workspace'` flag in meta and
no `files`, `blobs` or `fileKeys` maps. Maps and arrays:

- `library`: Map, `path` → `{ id, kind: 'file' | 'folder', size, mime, sha256, version, by, ts, versions: [{ id, size, sha256, by, ts }] }`.
  `id` is the storage object id of the current version (32 hex, `blobId`-shaped but random).
- `chat`, `tasks`, `activity` and `agentFeed`, as in a session. No `commitRequests`, `merges` or `history`: there is no code to commit or merge.
- Awareness carries presence exactly as a session: name, tool, color, kind, agent, work.

Relay meta for the room: `{ kind: 'workspace', workspace: <id>, members: { account: access }, blobs: { id: { size, ts, path } }, usedBytes }`.
Membership is pushed by the API when it changes (`POST /v1/relay/workspaces/<id>/members`, signed with the
relay secret, same channel as presence) and cached in meta so the relay admits without a round trip.

The relay is the quota authority, as it is for session storage: every upload is checked against the
workspace's `quota_bytes` (sent with membership) and it reports `usedBytes` and `fileCount` in presence
events, which `ingest_presence` writes to `workspaces`.

### Storage

Bucket `workspace-files` in the Quilt Files project, private, `file_size_limit` 500 MB. Object path
`<workspace id>/<object id>`. Bytes are stored as uploaded (the bucket is encrypted at rest by the provider,
not by Quilt). Signed upload and download links come from the relay's existing `/blobs` endpoints, generalised
to accept a workspace room and a pass instead of a session secret. Self-hosted relays without Supabase use
`DiskStore` under `blobs/ws-<id>/`.

Deleting a file keeps its versions for 30 days (a `deletedAt` on the library entry, hidden from listings),
then the relay's unload-time sweep removes unreferenced objects, as it does for sessions. Archiving a
workspace keeps everything; deleting a workspace (owner only, confirmed by typing its name) removes the room,
the objects and the rows.

## Access

`workspaceAccess(account, workspace)` in the API, in order:

1. Owner (the personal owner, or an org member with a role that has **Workspaces: Update**) → editor, plus admin rights.
2. Explicit `workspace_members` row.
3. Org workspaces: a `workspace_teams` row for a team the account is in.
4. Org workspaces: `default_access` (`org-editor` / `org-viewer`) for any org member.
5. Otherwise none.

Passes gain a `workspace` claim: `{ room, workspace, workspaceAccess, access, iat }`. A pass for a session
inside a workspace carries both; `roomAccess` falls back to `workspaceAccess` when the account has no grant,
invite or ownership of the room itself. Session owners can still tighten a member's access for one session
with the existing people menu, and can still let outsiders in by invite link.

Org roles get a **Workspaces** row (Create / Read / Update / Delete). Members default to Read of workspaces
they can reach; Admin has every box.

Agents' folder scopes (`scopes`) apply to library paths as they apply to session paths.

## API

Under `/v1`, all JSON, all authenticated as a person (device token) or an agent (`qa_` key):

| Method and path | Who | Does |
|---|---|---|
| `GET /me/workspaces` | anyone | workspaces the caller can reach, across spaces, with access and counts |
| `POST /workspaces` `{ name, description?, org? }` | personal: anyone within plan; org: Workspaces: Create | creates the row and asks the relay to create the room |
| `GET /workspaces/:id` | reader | the workspace, members, sessions (from `relay_sessions`), usage |
| `PATCH /workspaces/:id` | admin | name, description, default access, archive |
| `DELETE /workspaces/:id` | owner | everything gone |
| `GET/PUT/DELETE /workspaces/:id/members/:account` | admin | add, change access, remove |
| `PUT/DELETE /workspaces/:id/teams/:teamId` | admin, org only | let a team in |
| `POST /workspaces/:id/invites` | admin | email invite; claimed on sign-in like session invites |
| `POST /workspaces/:id/agent-invites` | admin | the existing agent invite flow with `workspaceId` filled |
| `POST /workspaces/:id/sessions` `{ room }` | editor, session owner | moves an existing session in |
| `POST /passes` `{ workspace }` or `{ room }` | member | a pass that carries the workspace claim |

The relay's `start session` path (`runSession` in the app, `quilt_start_session` in the MCPs) takes an optional
`workspace`. The app asks the API for a pass with the workspace, the relay reads it when the room is created
and stores `meta.workspace`, and the API links the room on the first presence event.

Files have no API routes of their own: listing is the `library` map, bytes go through the relay's signed
links. That keeps one source of truth and reuses the session large-file code. The website reads the index
through the relay's existing read endpoint (`GET /rooms/:room/library`, pass-authenticated, new).

## Desktop app

**Home** gets a **Workspaces** section above "Your sessions" in the sidebar: one entry per workspace, with the
space switcher the website already has (Personal, each org). "New workspace…" is a dialog with name and space.
Loose sessions (not in any workspace) keep showing under "Your sessions".

**Workspace view** (a new top-level `state.view = 'ws:<id>'`), layout: left rail with Sessions, Files,
Board, Chat, People; main area for the chosen one; the chat panel on the right as in a session.

- **Sessions:** running sessions in this workspace with Open, and past ones with Rejoin (from `recent.json`)
  or Start again (a new room in the same folder). "New session" starts one inside the workspace.
- **Files:** a folder tree and a list: name, size, who, when, version. Drag-and-drop and a button to
  upload; Download; Preview for images, video, audio, PDF, CSV, text and Markdown (xlsx shows the sheet names
  and first rows, no editing); Rename, Move, Delete; version history with "Download this version". Uploads
  stream straight from the app to storage with the relay's link; progress shows in the list.
- **Board** and **Chat:** the session components, pointed at the workspace room. @mentions, tasks and
  the QA flow work the same, so agents are woken the same way.
- **People:** members and their access, agents and what they are doing, invite people (email) and agents
  (the invite link flow), let a team in (org workspaces).

The app keeps the workspace room connected while the app runs (it is cheap: no folder watching), so files,
chat and the board stay live and the person counts as present.

A session view inside a workspace shows the workspace's name in its top bar as a link back, and its chat
composer gets **Attach from workspace**, which sends a library file as a chat attachment.

## Website

`/dashboard/workspaces` and `/org/<slug>/workspaces` list workspaces with usage; a workspace page shows
members, sessions, the file list (download only) and settings. Admin actions live here as well as in the app,
so an org admin without the app can manage access. Invite links `/workspace-invite/<token>` sign the person in
and add them.

## Agents

New MCP tools (both local `quilt mcp` and the hosted MCP), all tool-agnostic:

| Tool | Does |
|---|---|
| `quilt_workspaces` | the agent's workspaces, with access, usage, open sessions |
| `quilt_join_workspace` `{ workspace }` | connects the agent to the workspace room (hosted: alongside its session room) so chat, tasks, inbox and feed tools work there |
| `quilt_workspace_files` `{ workspace, folder?, glob? }` | the index: path, size, type, version, who, when |
| `quilt_workspace_read_file` `{ workspace, path, version? }` | text, CSV, Markdown, JSON up to 2 MB inline; anything else returns a 10-minute download link, and local agents get `savedTo` (a path under `~/.quilt/workspaces/<id>/`) |
| `quilt_workspace_write_file` `{ workspace, path, text? \| fromPath?, note? }` | a new file or version; hosted agents send text or upload through the link the tool returns |
| `quilt_workspace_delete_file`, `quilt_workspace_move_file` | editors |

Existing tools gain an optional `workspace` argument where a room was implied: `quilt_message`,
`quilt_read_messages`, `quilt_tasks`, `quilt_add_task`, `quilt_move_task`, `quilt_assign_task`, `quilt_inbox`,
`quilt_partner_feed`, `quilt_share`. With it, they act in the workspace room. `quilt_start_session` gains
`workspace`.

Webhooks: mentions, direct messages and tasks in a workspace room post to the agent's webhook with a
`workspace` field, the same payload shape as session events.

The relay's hosted-agent map becomes `account → { room?, workspace? }`: one session room and one workspace
room at a time.

The agent guide text (shared MCP instructions and `quilt setup`'s AGENTS.md section) explains: files that
are not code live in the workspace library; put outputs there, not in chat; name the version note.

### Example: marketing agent and editor agent

Both are members of the "Launch" workspace. A person posts a task "Cut a 30 s teaser from
`raw/keynote.mp4`" and assigns the editor. The editor's webhook fires, it reads the task with
`quilt_inbox` and the file with `quilt_workspace_read_file` (a download link), renders, uploads
`cuts/teaser-v1.mp4` with `quilt_workspace_write_file`, moves the task to QA with notes, and @mentions the
marketing agent in workspace chat. The marketing agent wakes, reads the cut, writes `copy/teaser.md`, and
reports. The person sees both files, versions and the thread in the Files and Chat panes, and the board.

## Pricing hooks

Plan limits are per space: number of workspaces, quota per workspace, per-file size. Defaults above; the API
fills `quota_bytes` on create from the plan and the relay enforces it. Nothing else in `plans/pricing.md`
changes.

## Error handling

- Upload too big, quota full, not a member, viewer trying to write: the relay answers with the same codes and
  messages the session `/blobs` endpoints use; the app shows them inline in the Files list; the MCP tools
  return them as text.
- Relay unreachable: the Files pane shows the last index it saw (the Y.Doc is persisted locally under
  `~/.quilt/workspaces/<id>/state.bin`) and disables upload.
- Membership changes while connected: the relay re-reads meta on the API push and disconnects anyone removed
  with close code `4403` ("You are no longer a member of this workspace").
- A session whose workspace is deleted becomes loose; nothing in it is lost.

## Testing

- `test/workspaces-api.test.js`: create, members, teams, default access, pass claims, `workspaceAccess`
  order, plan limits, delete cascade (memory store and Supabase store).
- `test/workspace-room.test.js`: relay admits by pass only, membership push, quota, upload and download links
  with both stores, version keep count, deleted-file sweep, close code on removal.
- `test/workspace-sessions.test.js`: a session started with a workspace, access fallback, moving a loose
  session in, deletion makes it loose.
- `test/workspace-mcp.test.js`: each new tool from a local agent and a hosted agent; the `workspace`
  argument on existing tools; hosted agent holding both rooms; webhook payloads.
- `test/ui-workspaces.test.js`: the Files view renders the index, previews pick the right component by type,
  the sidebar lists workspaces by space, the allowlist in `src/ui-server.js` covers every new module.
- Smoke script `scripts/workspace-storage-smoke.mjs` against the real bucket.

## Phases

1. **Primitive.** Tables, API routes, passes, workspace room on the relay, storage bucket, app Workspaces
   sidebar and view with Sessions and Files, website lists. Sessions start inside workspaces.
2. **Realtime.** Board, chat, people and presence in the workspace view (mostly reuse).
3. **Agents.** Membership through invites, the MCP tools, hosted dual room, webhooks, guide text.
4. **Bridges.** Attach from workspace in session chat; "Save to workspace" on a session chat attachment;
   later, mounting a library folder into a session on demand.

Each phase ships with a `RELEASES.md` section and its own tests; phase 1 is usable alone.

## Out of scope

- Editing office files in place, comments on files, sharing a file outside Quilt by link.
- End-to-end encryption of the library (sessions keep theirs).
- Full-text search across files.
- Syncing the whole library to disk.
