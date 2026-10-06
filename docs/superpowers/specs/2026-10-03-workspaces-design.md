# Workspaces — design

Date: 2026-10-03, revised 2026-10-04. Builds on sessions (relay rooms), accounts and spaces (personal or org),
org roles, agent sign-in, access types and the hosted MCP.

Mockups: `2026-10-03-workspaces-mockups.html` next to this file (card layout: home grid, add card, inside a workspace, all files, where agents work).

## Goal

A **workspace** is a new platform primitive, like a Claude project: a durable container that owns

- **Sessions.** A session can be started inside a workspace. The workspace lists them, live and past.
- **Files and folders.** A cloud library for what is not code: images, video, PDFs, spreadsheets, CSV, zips,
  documents. Uploaded once, reachable by every member and every workspace agent.
- **Agents.** Agents are members. An org can place an agent in every workspace and session top down, or in
  chosen ones; a person adds an agent to one workspace the way they invite it to a session today.

Sessions stay what they are: synced project folders for code, on the relay. The workspace sits above them and
changes nothing about how a session syncs. Orgs, teams, roles and access types are untouched: they decide who
may reach a workspace, the workspace is where the work is.

**Scope rule for the first build:** the UI shape, the tables, and the least backend logic that makes them real.
No new gating infrastructure. Iterate from there.

## Decisions

| Topic | Decision |
|---|---|
| Who owns a workspace | If the signed-in person is in an org and creates it in that org's space, the **org** owns it. Otherwise the **person** owns it. |
| Who manages it | Org: anyone whose role has the **Workspaces** permission (Create / Read / Update / Delete, a new row in the role grid; Admin has all four, Member has Read). Personal: the owner. |
| Membership | People and agents, **edit** or **view**. Personal workspaces: the owner invites, with the same invite dialog sessions use (people you've worked with, anyone by email, an agent link). Org workspaces: whoever holds Workspaces: Update adds org members and org agents. |
| Files | Stored in the cloud: bytes in a private bucket in the Quilt Files Supabase project, index rows in Postgres, signed upload and download links from the accounts API. Server-readable (encrypted at rest by the provider, not end to end), so previews and hosted agents work. |
| Folders | Paths. A folder is a row of kind `folder`; a file's `path` is `cuts/teaser-15s.mp4`. |
| Versions | Uploading to an existing path makes a new version; the last 10 are kept. |
| Realtime | **Not the relay.** The relay is for live co-editing inside a session. Phase 2 ships polling: the app refetches workspace changes (files, members, sessions) every 20 seconds while a workspace page is open, and again after each action; the website shows what it loads. Supabase Realtime on the workspace's rows is a later improvement. |
| Workspace chat and board | Out of scope for now. Agents and people coordinate in session chat and the session board, and hand files over through the library. |
| Sessions in a workspace | A session is started with a workspace id. The API records `relay_sessions.workspace_id` and answers the relay's room-access question with workspace membership when the account has no grant of its own. Loose sessions can be moved into a workspace by their owner. |
| Agents | Three levels, most specific wins. **Account level** (a person's Settings › Agents, or the org's Agents page): the agent's **reach** is all workspaces (global) or chosen ones, and its **sessions default** is "every session" or "when invited". **Workspace level:** an agent added to a workspace is a member there, with its own sessions setting; a workspace may override a global agent's default for itself. **Session level:** as today, invited by hand or kept out of one session by its owner. Agents that join every session are let in as the session starts, show why they are there in the people menu, and in org workspaces show "Added by <org>". |
| App layout | Only a session opens the code window and the file tree. Workspaces use the home shell with today's sidebar. Home is a **grid of workspace cards** with an **Add workspace** card; inside a workspace, one page of card sections (Sessions, Files, People & agents) and an All files view. No tabs, no sidebar list. |
| Limits (defaults, per plan later) | 500 MB per file, 5 GB per workspace, 2,000 files. |
| Naming in code | The session view's internal name "workspace" (`src/ui/session.js` comment, `state.ws`, the CSS section) is renamed so the word means one thing. |

## Reversibility

Nothing here may break what works today, and every step must back out cleanly.

- **The relay is not changed** in phases 1 and 2. Workspaces live in the accounts API and the app's home
  screen. The relay keeps its protocol, document, admission, claims, merges, history and hosted MCP. The one
  relay-adjacent change is in the API's answer to the room-access question the relay already asks. If a later
  phase needs a relay change, it goes through the existing `features=` negotiation on connect and the update
  check, not a new versioning scheme.
- **The session code is not changed** except the breadcrumb and Attach from workspace in phase 2, both behind
  the flag below.
- **Migrations are additive only:** new tables and one nullable column on `relay_sessions`. Rollback is
  dropping the new tables; no existing row changes shape.
- **One flag, off by default:** `QUILT_WORKSPACES` on the API. Off, no workspace route answers and the app,
  seeing the 404, renders today's home. On, the grid appears. The app has no flag of its own: it follows the
  API. Shipping a phase is flipping the flag; backing out is flipping it back.
- **Loose sessions stay first-class forever.** No session ever needs a workspace, so nobody's workflow changes
  until they move a session in themselves.
- **Branch and review:** built on the `workspaces` branch, merged in small pull requests behind the flag, each
  with tests, and the spec and mockups reviewed by everyone working on the app before code lands.

## Data model (accounts API, Postgres)

```sql
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users (id) on delete cascade,
  org_id uuid references orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  color text not null default '',
  quota_bytes bigint not null,
  used_bytes bigint not null default 0,
  created_by text not null,                -- 'person:<uuid>' or 'agent:<uuid>'
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check ((owner_user_id is null) <> (org_id is null))
);

create table workspace_members (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  account text not null check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  access text not null check (access in ('edit', 'view')),
  sessions text not null default 'invited' check (sessions in ('all', 'invited')),  -- agents only: join every session here, or when invited
  added_by text not null,
  added_at timestamptz not null default now(),
  primary key (workspace_id, account)
);

create table workspace_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  path text not null check (char_length(path) between 1 and 500),   -- 'cuts/teaser-15s.mp4'; no '..', no leading '/'
  kind text not null check (kind in ('file', 'folder')),
  size bigint not null default 0,
  mime text not null default '',
  sha256 text not null default '',
  version integer not null default 1,
  object_key text not null default '',     -- '<workspace id>/<file id>/<version>' in the bucket
  note text not null default '' check (char_length(note) <= 300),
  uploaded_by text not null,
  uploaded_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (workspace_id, path) where deleted_at is null   -- as a partial unique index
);

create table workspace_file_versions (     -- the previous versions of a path; the current one is the row above
  file_id uuid not null references workspace_files (id) on delete cascade,
  version integer not null,
  size bigint not null,
  sha256 text not null,
  object_key text not null,
  note text not null default '',
  uploaded_by text not null,
  uploaded_at timestamptz not null,
  primary key (file_id, version)
);

create table workspace_invites (           -- personal workspaces: email invites, shaped like session_invites
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  email text not null,
  access text not null check (access in ('edit', 'view')),
  token_hash text not null unique,
  invited_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  cancelled_at timestamptz
);

create table agent_placements (            -- account level: where an agent reaches and its sessions default
  agent_id uuid primary key references agents (id) on delete cascade,
  reach text not null default 'manual' check (reach in ('all', 'workspaces', 'manual')),
  workspace_ids uuid[] not null default '{}',
  sessions text not null default 'invited' check (sessions in ('all', 'invited')),
  access text not null default 'edit' check (access in ('edit', 'view')),
  scopes text[] not null default '{}' check (cardinality(scopes) <= 20),
  updated_by text not null,
  updated_at timestamptz not null default now()
);
-- The agent's owner (agents.owner_user_id or agents.org_id) sets the row: a person for their own agents, an
-- org admin (Agents: Update and Workspaces: Update) for the org's.

create table workspace_agent_overrides (   -- workspace level: a workspace's say over a global agent
  workspace_id uuid not null references workspaces (id) on delete cascade,
  agent_id uuid not null references agents (id) on delete cascade,
  sessions text check (sessions in ('all', 'invited')),      -- null: use the placement's default
  excluded boolean not null default false,                   -- keep this global agent out of this workspace
  primary key (workspace_id, agent_id)
);

alter table relay_sessions add column workspace_id uuid references workspaces (id) on delete set null;
create index relay_sessions_workspace_id on relay_sessions (workspace_id);
```

Row-level security is on. Reads that the website and the app do live are through the authenticated role with
policies that let a member read their own workspaces' rows (needed for Supabase Realtime, which filters by
RLS). All writes go through the accounts API with the service role, as everywhere else. Agent invites gain
`workspaceId` and `workspaceAccess`: the agent that redeems one is added to `workspace_members`.

Supabase Storage: bucket `workspace-files` in the Quilt Files project, private, `file_size_limit` 500 MB,
object key `<workspace id>/<file id>/<version>`. The API signs uploads and downloads with the service key.
Deleted files keep their objects for 30 days (`deleted_at`), then a daily API sweep removes them. Deleting a
workspace removes its rows and objects.

## Access

`workspaceAccess(account, workspace)`:

1. Personal workspace: the owner has edit and admin.
2. Org workspace: an org member whose role has Workspaces: Update has edit and admin; Workspaces: Read alone
   gives view of the list and the workspace page but not of files.
3. A `workspace_members` row gives its access.
4. An agent whose placement reaches this workspace (`reach = 'all'`, or the workspace is in `workspace_ids`)
   gets the placement's access, unless the workspace excluded it.
5. Otherwise none.

`agentJoinsSession(agent, room)`, used when a session in a workspace starts and whenever the relay asks:

1. A session-level decision wins: the session owner invited the agent (yes) or kept it out (no).
2. A `workspace_members` row for the agent: its `sessions` value.
3. A global agent: the workspace override's `sessions` if set, else the placement's `sessions`.
4. Otherwise no.

`roomAccess(account, room)`, which the relay already asks the API on every connection, gains one step after
owner, invites and grants: if the room's `relay_sessions.workspace_id` is set, use `workspaceAccess`. Workspace
`edit` maps to the built-in edit access type, `view` to view only; agent placement `scopes` become folder limits.
Session owners can still tighten someone for one session with the people menu, and still invite outsiders by
link, exactly as today.

## API

Under `/v1`, authenticated as a person (device token) or an agent (`qa_` key):

| Method and path | Who | Does |
|---|---|---|
| `GET /me/workspaces` | anyone | workspaces the caller can reach, with access, counts and the space they belong to |
| `POST /workspaces` `{ name, description?, color?, org? }` | personal: anyone; org: Workspaces: Create | creates it. `org` is the org slug; omitted means personal |
| `GET /workspaces/:id` | reader | the workspace, members, sessions (from `relay_sessions`), usage |
| `PATCH /workspaces/:id` | admin | name, description, color, archive |
| `DELETE /workspaces/:id` | admin (org) or owner (personal) | rows and objects gone; its sessions become loose |
| `PUT/DELETE /workspaces/:id/members/:account` | admin | add, change access, remove |
| `POST /workspaces/:id/invites` | admin, personal only | email invite, claimed on sign-in like a session invite |
| `POST /workspaces/:id/agent-invites` | admin | the existing agent invite with `workspaceId` filled |
| `GET /workspaces/:id/files?folder=` | reader with file access | the index |
| `POST /workspaces/:id/files` `{ path, size, mime, sha256?, note? }` | editor | checks quota and size, inserts or versions the row, returns `{ fileId, version, upload: { method, url, headers } }` |
| `POST /workspaces/:id/files/:fileId/done` | editor | confirms the upload landed (the API checks the object exists and its size), sets `used_bytes` |
| `GET /workspaces/:id/files/:fileId/download?version=` | reader | `{ url, expiresAt }` (10 minutes) |
| `PATCH /workspaces/:id/files/:fileId` `{ path?, note? }` | editor | rename or move |
| `DELETE /workspaces/:id/files/:fileId` | editor | soft delete |
| `POST /workspaces/:id/folders` `{ path }` | editor | an empty folder |
| `POST /workspaces/:id/sessions` `{ room }` | editor who owns the room | moves a loose session in |
| `PUT /me/agents/:id/placement`, `PUT /orgs/:slug/agents/:id/placement` | the agent's owner; org: Agents: Update and Workspaces: Update | reach, sessions default, access, scopes |
| `PUT /workspaces/:id/agents/:agentId` `{ sessions?, excluded? }` | admin | a workspace's override for a global agent |
| `PUT/DELETE /sessions/:room/agents/:agentId/exclude` | session owner | keep an inherited agent out of one session |

Starting a session: the app's `start()` and the MCPs' `quilt_start_session` take an optional `workspace`. The
app tells the API (`POST /me/sessions/:room/workspace`) as soon as the relay has created the room, so the
room is linked before anyone else connects. When the folder being started is under `~/.quilt/workspaces/<id>/`
(where agent tools save library files) the workspace is implied.

## Desktop app

**Home** is the workspace grid. The sidebar is unchanged (Sessions menu, Home, Settings). Each card: a colour
cover with the workspace's initial, name, a pill for the space (Personal or the org's name), one line of
description, counts (sessions, files, storage), member avatars with online dots, and a green "N open" pill when
sessions are live. The last card is a dashed **Add workspace**; clicking it turns the card into the form in
place (just a name, and where it lives when the person is in an org) and Create opens the new workspace. A
new workspace gets a colour from its name; colour and description are changed later in its settings. A Personal / org
switch at the top right filters the grid. **Sessions not in a workspace** is a small strip of chips under the
grid with Open or Rejoin, and the Join and New session buttons that live on the home page today; a chip's menu
has "Move to…".

**Workspace page** (`state.view = 'ws:<id>'`, rendered by `renderShell`). A back link, then the header:
colour mark, name, space pill, description, usage, Invite and a settings gear. Three card sections on one page:

- **Sessions:** a card per session (name, folder, who is in it, Open or Rejoin), live ones first, and a dashed
  **New session** card that starts one in this workspace.
- **Files:** tiles with a thumbnail or type badge, name, uploader and age, version pill; folders first; an
  upload tile that also takes dropped files; "All files" opens the library.
- **People & agents:** a card per member with avatar, name, what they are doing, and an access dropdown or an
  Owner pill; agents placed by the org show "Added by <org>" and no dropdown; a dashed **Invite** card opens the
  session invite dialog pointed at the workspace.

**All files** (`state.view = 'wsfiles:<id>'`): breadcrumb for the folder, Tiles / List switch, New folder and
Upload, folders first, and a preview panel for the picked file (image, video, audio, PDF, CSV, text and
Markdown; spreadsheets show name, size and Download in phase 2) with Download, Send to <open session> chat, the version
list with Download this version, Rename, Move, Delete.

**Settings** (the gear): name, description, colour, usage, Archive, Delete (type the name).

**Session view.** Unchanged, plus a breadcrumb in the top bar (`Launch › pricing-page`, the workspace name
links back) and an "Attach from workspace" button in the chat composer that sends a library file as a chat
attachment.

**Realtime.** Phase 2 ships polling: the app refetches a workspace's rows (files, members, `relay_sessions`)
every 20 seconds while its page is open, and again right after each action the person takes. Supabase
Realtime subscriptions are a later improvement.

## Website

- Personal: `/dashboard/workspaces` lists workspaces with usage; `/dashboard/workspaces/[id]` shows members,
  sessions, the file list (download only) and settings.
- Org: `/org/[slug]/workspaces` and `/org/[slug]/workspaces/[id]`, gated by the Workspaces permission. The
  **Roles** grid gets the Workspaces row.
- Org agent page gains **Where <agent> works**: Available in (all workspaces or chosen ones) and Joins (every
  session or when invited), plus access and folder limits. The personal dashboard's Agents page gets the same.
- Invite links `/workspace-invite/<token>` sign the person in and add them.

## Agents

MCP tools, in both `quilt mcp` and the hosted MCP:

| Tool | Does |
|---|---|
| `quilt_workspaces` | the agent's workspaces, with access, usage and open sessions |
| `quilt_workspace_files` `{ workspace, folder?, glob? }` | the index |
| `quilt_workspace_read_file` `{ workspace, path, version? }` | text, CSV, Markdown and JSON up to 2 MB inline; otherwise a 10-minute download link, and local agents also get `savedTo` under `~/.quilt/workspaces/<id>/` |
| `quilt_workspace_write_file` `{ workspace, path, text? \| fromPath?, note? }` | a new file or version; hosted agents send text or get an upload link back |
| `quilt_workspace_delete_file`, `quilt_workspace_move_file` | editors |

`quilt_start_session` gains `workspace`. `quilt_status` and `quilt_session_info` name the session's workspace.
The shared agent guide text says: files that are not code live in the workspace library; put outputs there, not
in chat; leave a version note.

Where agents work, in the app and on the website:

- **Settings › Agents** (personal) and the org's Agents page list each agent with **Available in** (all
  workspaces, or chosen ones) and **Joins** (every session, or when invited), plus access and folder limits.
  This writes `agent_placements` (`PUT /me/agents/:id/placement`, `PUT /orgs/:slug/agents/:id/placement`).
- **Add an agent to a workspace** picks one of the account's agents or invites a new one by link, with access and
  an "Also join every session in this workspace as it starts" switch. This writes `workspace_members` with
  `sessions`. A global agent's card in the workspace shows its scope pill and a Joins dropdown that writes
  `workspace_agent_overrides`.
- **A session's people menu** shows why each agent is there ("global", "in Launch", "invited by Daniel") with
  **Not in this session** for inherited agents and **Remove** for invited ones; these are the existing per-session
  grant and a new per-session exclusion kept with the room's grants.

When a session starts in a workspace the API's room-access answer includes every agent for which
`agentJoinsSession` is yes, so the relay lets them in at once and the existing webhook path wakes them (a new
"session started" event; mentions, DMs and tasks are unchanged). Hosted agents keep their one-room-at-a-time
model: the library tools go through the API, not a room. (Phase 3 built this differently: see below.)

### Phase 3 as built

What phase 3 changed from the design above, and why:

- **Session links are forwarded, never stored.** The relay's admission is unchanged: a placed agent is not let
  in by the room-access answer, because the relay needs the room secret and the API never holds it. Instead the
  session's owner, right after starting a session in a workspace, hands its join link to the API
  (`POST /v1/workspaces/:id/sessions/:room/started`), which sends a `session.started` event, carrying the link,
  to every agent that joins every session there and has a webhook, in the same request, and keeps nothing.
  Agents without a webhook still need an invite.
- **The hand-off waits for the relay.** It answers 409 until the relay has reported who owns the session; the
  app and the local MCP try again in the background for about 90 seconds (bounded, no duplicates).
- **Only Quilt's links.** The hand-off accepts a link only for Quilt's hosted relay or the API's own
  `relayUrl`, and sends it as Quilt writes it.
- **An API-level agent webhook.** `session.started` goes to a webhook the agent sets on its account
  (`PUT`/`DELETE /v1/agents/me/webhook`, the `quilt_workspace_webhook` and `quilt_workspace_webhook_off`
  tools), not to the session webhooks of `quilt_webhook_subscribe`, since no session exists yet. Deliveries are
  signed the same way. A receiver whose host resolves to a private address at send time is skipped.
- **A limit per session:** a few announces per room (5 in 10 minutes).
- **Hosted writes are capped at 2 MB** of text or base64 per call; hosted agents don't get an upload link back.
  Local agents can also send a project file (`fromPath`) of up to 500 MB.
- **Hosted agents reach the API with their pass.** The relay's hosted MCP calls the API with the agent's own
  pass (`authorization: QuiltPass …`), accepted only on the workspace, workspace-file and workspace-agent
  routes. The relay needs `QUILT_API_URL` and offers the library tools only while `GET /v1/features` says
  workspaces are on; so does the local MCP. With the flag off, every tool list is as before.
- **Guide text.** The hosted MCP adds the library guide to its instructions only when the tools are offered.
  The local MCP adds its tools after connecting (its instructions are already sent), so the guide comes with
  `quilt_workspaces`: in its description and at the top of its answer.
- **Placement scopes limit session folders only;** the library follows the placement's access (edit or view).
  Neither the app nor the website edits a placement's access or folder limits yet: a save keeps them.
- **A placed agent isn't added as a member as well.** An agent already in a workspace by placement (or kept out
  of it) is not offered in the workspace's Add list, in the app or on the website; its Joins and keep-out are
  managed from its card instead.
- **Keep-out can be undone.** A session owner who keeps an agent out of one session can let it back in from the
  session's people list, and inviting the agent again clears the keep-out.
- **Placing an org agent takes Workspaces: Update too,** since it puts the agent in the org's workspaces:
  `PUT /v1/orgs/:slug/agents/:id/placement` needs Agents: Update and Workspaces: Update.
- **Only an agent's owner makes it join every session.** Anyone may still add someone else's agent to a
  workspace for access, but a member row joins its agent to every session only when the agent is the workspace
  owner's own (a personal workspace: the owner's agent; an org's: the org's agent). The members `PUT` refuses
  `sessions: 'all'` for anyone else's agent (400), and the join decision ignores such a row written earlier.
  The workspace page marks it `foreign: true` with `sessions: 'invited'`; the app shows Joins as text and the
  website disables it, each with the reason. A workspace agent invite always makes the owner's own agent.
- **The starting agent isn't told about its own session.** When an agent starts a session, the hand-off skips it.
- **Where the website shows it.** Available in and Joins are on the Agents page (personal) and on each agent row
  of the org's People page (for members with Agents: Update and Workspaces: Update), only while workspaces are on. A workspace's page
  lists its agents with why each is there (This workspace, Placed, Global, Added by <org>) and, for admins, Joins.
- **Deferred to phase 4:** the session people menu's "why here" for each agent.

### Example: marketing agent and editor agent

Both are members of "Launch". In the `teaser-site` session, a person posts the task "Cut a 30 s teaser from
`raw/keynote.mp4`" and assigns the editor agent. It wakes, reads the task, fetches the file with
`quilt_workspace_read_file` (a download link), renders, uploads `cuts/teaser-30s.mp4` with
`quilt_workspace_write_file` and a note, moves the task to QA and @mentions the marketing agent in the session
chat. The marketing agent wakes, reads the cut, writes `copy/teaser.md` to the library and reports. The person
sees both files and versions in the Files tab and the thread in the session.

## Error handling

- Too big, quota full, not a member, viewer writing: the API answers 413 / 403 with a plain message; the Files
  tab shows it on the row; the tools return it as text.
- Upload interrupted: the row stays `version n, size 0` until `done`; rows never confirmed are removed after
  an hour and don't count against quota.
- Accounts API unreachable: the Files section keeps what it last showed, the 20-second refetch keeps trying, and uploads report the error.
- Workspace deleted: its sessions become loose; nothing in them is lost. Agents placed through it lose that
  placement's access to those sessions on their next connection.

## Testing

- `test/workspaces-api.test.js`: create in personal and org spaces, permission row, members, invites, access
  order, `roomAccess` fallback, placements, delete cascade (memory store and Supabase store).
- `test/workspace-files.test.js`: upload handshake, quota and size checks, versions kept at 10, soft delete and
  sweep, rename and move, download links; a smoke script against the real bucket.
- `test/workspace-mcp.test.js`: each tool from a local and a hosted agent; `quilt_start_session` with
  `workspace`; placed agent admitted when a session starts; webhook payload.
- `test/ui-workspaces.test.js`: the grid and its filter, the add card becoming the form, the workspace page
  sections, file tiles and the preview picked by type, the `STATIC` allowlist in `src/ui-server.js` covers every
  new module.
- Website tests for the new pages and the Roles grid row.

## Phases

1. **Shape.** Tables, API routes for workspaces, members and sessions, the home grid with the add card, the
   workspace page with the Sessions and People & agents sections, the website lists, starting a session inside
   a workspace, access fallback.
2. **Files.** The file routes, bucket, the Files section and All files view with upload, preview and versions,
   Attach from workspace, a 20-second refetch while a workspace page is open (Supabase Realtime later).
3. **Agents.** Add an agent to a workspace (existing or by invite link), the library tools, placements with reach
   and sessions default in Settings › Agents and on the org agent page, workspace overrides, per-session keep-out,
   guide text.

Each phase ships with a `RELEASES.md` section and tests. Phase 1 is usable on its own.

## Out of scope for now

- Workspace-level chat, board or feed.
- Editing office files in place, comments on files, sharing a file outside Quilt by link.
- End-to-end encryption of the library.
- Full-text search across files; syncing the whole library to disk; mounting it into a session.
