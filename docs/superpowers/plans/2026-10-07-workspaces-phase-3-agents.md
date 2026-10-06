# Workspaces Phase 3 (Agents) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents become real workspace members: they are added to a workspace (existing or by invite link), reach workspaces by an account-level placement, are told to join new sessions in a workspace as they start, and read and write the workspace library through MCP tools, local and hosted.

**Architecture:** New additive tables on the accounts API (`agent_placements`, `workspace_agent_overrides`, `session_agent_exclusions`, `agent_webhooks`, plus columns on `workspace_members` and `agent_invites`). Access stays in the API: `workspaceAccess` gains the placement rule, and a new `agentsJoiningSession` decides who joins a session. The relay's admission rules do not change: an agent still joins with the session's link, which only the owner's own app or MCP holds, so the owner's client hands the link to the API at session start and the API sends it straight on to each joining agent's API-level webhook as a `session.started` event, without storing it. The workspace library tools live in one shared module used by the local MCP (calling the API with the agent's `qa_` key) and the hosted MCP on the relay (calling the API with the agent's own pass, which the API accepts on workspace routes only).

**Tech Stack:** Node 22 ES modules, `node:test`, Postgres/Supabase migration, `@modelcontextprotocol/sdk` (existing), the app's plain ES-module UI, Next.js website in `web/`.

**Spec:** `docs/superpowers/specs/2026-10-03-workspaces-design.md` ("Decisions" Agents row; "Data model" `agent_placements`, `workspace_agent_overrides`, `workspace_members.sessions`; "Access" rule 4 and `agentJoinsSession`; "API" placement and override rows; "Agents" section; Phase 3). Mockups: screen 5 ("Where agents work") of `docs/superpowers/specs/2026-10-03-workspaces-mockups.html`.

## Global Constraints

- **Nothing outside the flag changes.** Every new API route is gated by the existing `workspaces` flag (404 `'not found'` when off) except `GET /v1/features`. The local and hosted MCPs register the workspace tools only when the API answers `GET /v1/features` with `{ workspaces: true }`. With the flag off, an agent's tool list, the app, the relay and the website behave exactly as on `main`.
- **The relay's admission rules do not change.** Agents still join with a session link; `src/server.js` admission, `Room.authorize` and the pass checks are untouched. `src/session.js` is untouched. The only relay change is the hosted MCP registering the workspace tools (Task 7).
- **Session links are never stored by the API.** The `session.started` hand-off forwards the link to webhooks in the same request and drops it.
- Migrations are additive (new tables, nullable or defaulted new columns).
- Access values `'edit'`/`'view'`; sessions values `'all'`/`'invited'`; placement reach `'all'`/`'workspaces'`/`'manual'`.
- A personal agent's "all workspaces" means the workspaces its owner owns personally; an org agent's means the org's workspaces. Placement never reaches across owners.
- Hosted writes through MCP: text or base64 up to 2 MB; larger files go through the app.
- StandardJS, ES modules, no em dashes in user-facing text. Every UI module imported is in `STATIC`. Both stores expose identical method names and shapes.
- Commits end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `npm test` from the repo root after every task (baseline 1109 pass / 0 fail / 2 skipped); `cd web && npm test` for website tasks (baseline 94).

---

## File Structure

- Create `supabase/migrations/20261007000000_workspace_agents.sql`.
- Modify `src/api/memory-store.js`, `src/api/supabase-store.js`: placements, overrides, exclusions, agent webhooks, org agent list, member `sessions`, invite workspace fields.
- Create `src/api/agent-placement.js`: `agentReach`, `agentJoinsSession`, `agentsJoiningSession`, `cleanPlacement`.
- Modify `src/api/workspace-access.js` (rule 4), `src/api/access.js` (per-session exclusion).
- Create `src/api/routes/workspace-agents.js`: placements, overrides, exclusions, workspace agent invites, agent webhook, `session.started` hand-off. Modify `src/api/routes/workspaces.js` (members `sessions`, `agents` in GET), `src/api/routes/join.js` (workspace invites), `src/api/server.js` (mount, `GET /v1/features`), `src/api/workspace-reach.js` (pass auth).
- Create `src/workspace-tools.js`: the shared MCP tool definitions and handlers.
- Modify `src/mcp.js` (register local tools; hand-off after `setSessionWorkspace`), `src/relay-mcp.js` (register hosted tools), `src/server.js` only to give the hosted MCP the API URL and a features probe.
- Modify `src/account.js`, `src/ui-server.js` (local routes; hand-off after a session starts in a workspace; exclusion on removing an agent), `src/ui/workspaces.js`, `src/ui/home.js`, `src/ui/app.css`.
- Website: `web/app/dashboard/agents/page.js`, `web/app/org/[slug]/people/page.js`, both workspace `[id]` pages, a shared `web/components/AgentPlacement.js`.
- Tests: `test/api-migration-workspace-agents.test.js`, `test/api-store-workspace-agents.test.js`, `test/api-supabase-workspace-agents.test.js`, `test/api-agent-placement.test.js`, `test/api-workspace-agents.test.js`, `test/workspace-tools.test.js`, `test/mcp-workspace-tools.test.js`, `test/relay-workspace-tools.test.js`, `test/ui-workspace-agents.test.js`, `web/test/agent-placement.test.js`.

---

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261007000000_workspace_agents.sql`
- Test: `test/api-migration-workspace-agents.test.js`

**Interfaces (produces):** tables `agent_placements`, `workspace_agent_overrides`, `session_agent_exclusions`, `agent_webhooks`; columns `workspace_members.sessions`, `agent_invites.workspace_id`, `agent_invites.workspace_access`, `agent_invites.workspace_sessions`.

- [ ] **Step 1: Write the failing test**

```js
// test/api-migration-workspace-agents.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../supabase/migrations/20261007000000_workspace_agents.sql', import.meta.url), 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]

test('the columns and tables the spec names', () => {
  const s = sql()
  assert.match(s, /alter table public\.workspace_members add column sessions text not null default 'invited' check \(sessions in \('all', 'invited'\)\);/)
  const p = table(s, 'agent_placements')
  for (const col of ['agent_id uuid primary key references public.agents (id) on delete cascade', "reach text not null default 'manual' check (reach in ('all', 'workspaces', 'manual'))", "workspace_ids uuid[] not null default '{}'", "sessions text not null default 'invited' check (sessions in ('all', 'invited'))", "access text not null default 'edit' check (access in ('edit', 'view'))", "scopes text[] not null default '{}' check (cardinality(scopes) <= 20)", 'updated_by text not null', 'updated_at timestamptz not null default now()']) assert.ok(p.includes(col), col)
  const o = table(s, 'workspace_agent_overrides')
  for (const col of ['workspace_id uuid not null references public.workspaces (id) on delete cascade', 'agent_id uuid not null references public.agents (id) on delete cascade', "sessions text check (sessions in ('all', 'invited'))", 'excluded boolean not null default false', 'primary key (workspace_id, agent_id)']) assert.ok(o.includes(col), col)
  const x = table(s, 'session_agent_exclusions')
  for (const col of ['room text not null references public.relay_sessions (room) on delete cascade', 'agent_id uuid not null references public.agents (id) on delete cascade', 'excluded_by text not null', 'primary key (room, agent_id)']) assert.ok(x.includes(col), col)
  const w = table(s, 'agent_webhooks')
  for (const col of ['agent_id uuid primary key references public.agents (id) on delete cascade', 'url text not null check (char_length(url) <= 2000)', 'secret text not null', 'created_at timestamptz not null default now()']) assert.ok(w.includes(col), col)
  for (const col of ['alter table public.agent_invites add column workspace_id uuid references public.workspaces (id) on delete cascade;', "alter table public.agent_invites add column workspace_access text check (workspace_access in ('edit', 'view'));", "alter table public.agent_invites add column workspace_sessions text check (workspace_sessions in ('all', 'invited'));"]) assert.ok(s.includes(col), col)
})

test('additive only, RLS on, service role only', () => {
  const s = sql()
  assert.doesNotMatch(s, /\bdrop\b/i)
  for (const t of ['agent_placements', 'workspace_agent_overrides', 'session_agent_exclusions', 'agent_webhooks']) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.agent_placements, public\.workspace_agent_overrides, public\.session_agent_exclusions, public\.agent_webhooks from anon, authenticated;/)
  assert.match(s, /grant all on public\.agent_placements, public\.workspace_agent_overrides, public\.session_agent_exclusions, public\.agent_webhooks to service_role;/)
})
```

- [ ] **Step 2: Run it to verify it fails** — `node --test test/api-migration-workspace-agents.test.js` → ENOENT.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261007000000_workspace_agents.sql
-- Agents in workspaces (phase 3): where an agent works, a workspace's say over a global
-- agent, per-session keep-outs, and an agent's own webhook for "session started". Additive
-- only. The accounts API is the only reader and writer, so row-level security is on with no
-- client policies and no client grants.

-- An agent added to a workspace may also join every session in it as it starts.
alter table public.workspace_members add column sessions text not null default 'invited' check (sessions in ('all', 'invited'));

-- Where an agent works, set by its owner (a person for a personal agent; an org admin for an
-- org's). reach 'all' is every workspace of the agent's owner; 'workspaces' the listed ones;
-- 'manual' only where someone adds it.
create table public.agent_placements (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  reach text not null default 'manual' check (reach in ('all', 'workspaces', 'manual')),
  workspace_ids uuid[] not null default '{}',
  sessions text not null default 'invited' check (sessions in ('all', 'invited')),
  access text not null default 'edit' check (access in ('edit', 'view')),
  scopes text[] not null default '{}' check (cardinality(scopes) <= 20),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

-- A workspace's say over an agent that reaches it by placement.
create table public.workspace_agent_overrides (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  sessions text check (sessions in ('all', 'invited')),
  excluded boolean not null default false,
  primary key (workspace_id, agent_id)
);

-- A session owner keeps an agent out of one session.
create table public.session_agent_exclusions (
  room text not null references public.relay_sessions (room) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  excluded_by text not null,
  created_at timestamptz not null default now(),
  primary key (room, agent_id)
);

-- An agent's own webhook on the accounts API, for workspace events (session.started). The
-- secret signs deliveries, so it is kept as given; only the service role reads this table.
create table public.agent_webhooks (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  url text not null check (char_length(url) <= 2000),
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- An agent invite may put the new agent straight into a workspace.
alter table public.agent_invites add column workspace_id uuid references public.workspaces (id) on delete cascade;
alter table public.agent_invites add column workspace_access text check (workspace_access in ('edit', 'view'));
alter table public.agent_invites add column workspace_sessions text check (workspace_sessions in ('all', 'invited'));

alter table public.agent_placements enable row level security;
alter table public.workspace_agent_overrides enable row level security;
alter table public.session_agent_exclusions enable row level security;
alter table public.agent_webhooks enable row level security;
revoke all on public.agent_placements, public.workspace_agent_overrides, public.session_agent_exclusions, public.agent_webhooks from anon, authenticated;
grant all on public.agent_placements, public.workspace_agent_overrides, public.session_agent_exclusions, public.agent_webhooks to service_role;
```

- [ ] **Step 4: Run** `node --test test/api-migration-*.test.js` → PASS.
- [ ] **Step 5: Commit** `Workspace agents: migration (placements, overrides, exclusions, agent webhooks)`.

---

### Task 2: Store methods (memory and Supabase)

**Files:**
- Modify: `src/api/memory-store.js`, `src/api/supabase-store.js`
- Test: `test/api-store-workspace-agents.test.js`, `test/api-supabase-workspace-agents.test.js`

**Interfaces (both stores, identical):**
- `putWorkspaceMember({ workspaceId, account, access, addedBy, sessions = 'invited' })` now also stores `sessions`; member rows carry `sessions`. The Supabase `WORKSPACE_MEMBER` select gains `sessions`; the upsert writes it.
- `agentPlacement(agentId) -> { agentId, reach, workspaceIds, sessions, access, scopes, updatedBy, updatedAt } | null`
- `putAgentPlacement({ agentId, reach, workspaceIds = [], sessions, access, scopes = [], updatedBy }) -> placement` (upsert)
- `listAgentPlacements(agentIds) -> placement[]` (only rows that exist)
- `workspaceAgentOverride(workspaceId, agentId) -> { workspaceId, agentId, sessions, excluded } | null`
- `putWorkspaceAgentOverride({ workspaceId, agentId, sessions = null, excluded = false }) -> override`; `deleteWorkspaceAgentOverride(workspaceId, agentId) -> boolean`; `listWorkspaceAgentOverrides(workspaceId) -> override[]`
- `addSessionAgentExclusion({ room, agentId, excludedBy }) -> row`; `removeSessionAgentExclusion(room, agentId) -> boolean`; `sessionAgentExcluded(room, agentId) -> boolean`; `listSessionAgentExclusions(room) -> row[]`
- `agentWebhook(agentId) -> { agentId, url, secret, createdAt, updatedAt } | null`; `putAgentWebhook({ agentId, url, secret }) -> row`; `deleteAgentWebhook(agentId) -> boolean`
- `listOrgAgents(orgId) -> agent[]` (the org's agents, not revoked, by name)
- `createAgentInvite({ …existing…, workspaceId = null, workspaceAccess = null, workspaceSessions = null })`; invite rows carry the three fields. Supabase `AGENT_INVITE` select gains `workspace_id, workspace_access, workspace_sessions`.
- Memory deletion cascades: deleting an agent drops its placement, overrides, exclusions and webhook; deleting a workspace drops its overrides; ending/deleting a room drops its exclusions.

- [ ] **Step 1: Write the failing memory test** — cover: member `sessions` round trip and default `'invited'`; placement upsert and `listAgentPlacements`; override put/get/list/delete; exclusion add/has/list/remove; webhook put/get/delete; `listOrgAgents` returns only that org's non-revoked agents; invite workspace fields round trip; cascades on `deleteAgent` and `deleteWorkspace`. Use `createMemoryStore`, `store.createAgent({ name, provider, type, ownerUserId | orgId, invitedBy })`, `store.createOrg`, `store.createWorkspace`, `store.ingestPresence` for a room (see `test/api-store-workspaces.test.js` for these calls).

- [ ] **Step 2: Run it, see it fail; implement the memory store** (maps `agentPlacements`, `workspaceAgentOverrides` keyed `${ws}\n${agent}`, `sessionAgentExclusions` keyed `${room}\n${agent}`, `agentWebhooks`; extend `dropAgent`, `deleteWorkspace` and the room-ending path).

- [ ] **Step 3: Write the Supabase test with the fake client from `test/api-supabase-workspaces.test.js`** — assert the insert/upsert column names (`agent_id, reach, workspace_ids, sessions, access, scopes, updated_by` with `onConflict: 'agent_id'`; overrides `onConflict: 'workspace_id,agent_id'`; exclusions; webhooks `onConflict: 'agent_id'`; `listOrgAgents` filters `org_id` and `revoked_at is null`), then implement.

- [ ] **Step 4: Run** `node --test test/api-store-workspace-agents.test.js test/api-supabase-workspace-agents.test.js test/api-store-workspaces.test.js test/api-store-agents.test.js test/api-supabase-agents.test.js` and the full suite.
- [ ] **Step 5: Commit** `Workspace agents: store methods in both stores`.

---

### Task 3: Placement rules and access

**Files:**
- Create: `src/api/agent-placement.js`
- Modify: `src/api/workspace-access.js`, `src/api/access.js`
- Test: `test/api-agent-placement.test.js`

**Interfaces (produces):**
```js
// src/api/agent-placement.js
export const REACH = ['all', 'workspaces', 'manual']
export const SESSIONS = ['all', 'invited']
export function cleanPlacement (body) // -> { reach, workspaceIds, sessions, access, scopes }; HttpError 400 on bad values; workspaceIds only kept for reach 'workspaces' (uuid strings, at most 100)
export async function agentReach (store, ws, agentId) // -> { access, scopes, via: 'placed' | 'global', sessions } | null
export async function agentJoinsSession (store, room, agentId) // -> boolean
export async function agentsJoiningSession (store, room) // -> [{ agentId, via: 'member' | 'placed' | 'global' }]
```

Rules:
- `agentReach(store, ws, agentId)`: load the agent (`agentById`); revoked → null. The agent must share the workspace's owner: personal workspace → `agent.ownerUserId === ws.ownerUserId`; org workspace → `agent.orgId === ws.orgId`. Load `agentPlacement`; none or `reach: 'manual'` → null; `reach: 'workspaces'` and `ws.id` not in `workspaceIds` → null. If `workspaceAgentOverride(ws.id, agentId)?.excluded` → null. Answer `{ access: placement.access, scopes: placement.scopes, via: reach === 'all' ? 'global' : 'placed', sessions: override?.sessions ?? placement.sessions }`.
- `workspaceAccess(store, ws, account, { orgGrants })` gains, after the member-row step and before the org-Read step, for `agent:` accounts: `const r = await agentReach(store, ws, id); if (r) return { access: r.access, admin: false, via: r.via }`. A member row still wins over placement.
- `agentJoinsSession(store, room, agentId)`, in order: (1) `sessionAgentExcluded(room, agentId)` → false; (2) the room's `workspaceId` (from `sessionByRoom`) missing → false; workspace missing → false; (3) member row for `agent:<id>` → `row.sessions === 'all'` (and the agent's org membership still holds, per `stillInOrg`); (4) `agentReach` → `r.sessions === 'all'`; (5) false.
- `agentsJoiningSession(store, room)`: candidates are the workspace's agent member rows plus the agents of the workspace's owner (personal: `listPersonalAgents(ws.ownerUserId)`; org: `listOrgAgents(ws.orgId)`), deduplicated; keep those for which `agentJoinsSession` is true, with `via` `'member'` when a member row decided it else the reach's `via`.
- `roomAccess` in `src/api/access.js`: right before the workspace fallback (after the grant step), `if (account.startsWith('agent:') && await store.sessionAgentExcluded(room, account.slice(6))) return null`. A grant on the session itself still wins (it is checked before). Placement scopes become folder limits: when `workspaceAccess` answered `via: 'placed' | 'global'`, pass `{ foldersOnly: scopes }` into the effective access (`effectiveAccess(builtinType(...), {})` then set `folders: scopes` when non-empty; read `src/session-access.js` `effectiveAccess` for the field name).

- [ ] **Step 1: Write the failing test** covering: personal agent of `u1` with placement `all` reaches every personal workspace of `u1` and none of `u2`; `workspaces` reaches only the listed one; `manual` reaches none; an override `excluded` hides it; override `sessions` replaces the placement's; an org agent reaches only its org's workspaces; a revoked agent reaches nothing; a member row beats placement (view member with an edit placement → view); `agentJoinsSession` order (exclusion first, member `all`, placement `all`, otherwise false); `agentsJoiningSession` lists members with `all` plus placed agents with `all`, minus excluded, with the right `via`; `roomAccess` returns null for an excluded agent and still honours a session grant; a placement's scopes appear as folders in the room access.
- [ ] **Step 2: Run, fail; Step 3: implement; Step 4:** `node --test test/api-agent-placement.test.js test/api-workspace-access.test.js test/api-access-workspace.test.js` and the full suite.
- [ ] **Step 5: Commit** `Workspace agents: placement reach, who joins a session, per-session keep-out`.

---

### Task 4: API routes

**Files:**
- Create: `src/api/routes/workspace-agents.js`
- Modify: `src/api/routes/workspaces.js`, `src/api/routes/join.js`, `src/api/server.js`
- Test: `test/api-workspace-agents.test.js`

**Interfaces (all gated by the flag, 404 'not found' when off, except `GET /v1/features`):**

| Method and path | Who | Body / answer |
|---|---|---|
| `GET /v1/features` | anyone, no auth | `{ workspaces: boolean }` |
| `GET /v1/me/agents/:id/placement` | the agent's owner (personal agent) | `{ placement }` (a `'manual'` default when none) |
| `PUT /v1/me/agents/:id/placement` | the agent's owner | `{ reach, workspaceIds?, sessions, access, scopes? }` → `{ placement }`; `workspaceIds` must be the owner's personal workspaces (400 otherwise) |
| `GET /v1/orgs/:slug/agents` | Agents: Read | `{ agents: [{ id, name, provider, type, hosted, placement }] }` |
| `PUT /v1/orgs/:slug/agents/:id/placement` | Agents: Update | same body; `workspaceIds` must be the org's workspaces |
| `PUT /v1/workspaces/:id/members/:account` | admin | existing route, now accepts `sessions` (`'all'`/`'invited'`, agents only; 400 for a person) |
| `PUT /v1/workspaces/:id/agents/:agentId` | admin | `{ sessions?: 'all'|'invited'|null, excluded?: boolean }` → `{ override }` (only for agents that reach the workspace by placement; 404 otherwise) |
| `DELETE /v1/workspaces/:id/agents/:agentId` | admin | removes the override |
| `POST /v1/workspaces/:id/agent-invites` | admin | `{ access, sessions }` → `{ invite, link }`: an agent invite of the workspace's owner (personal: the owner's; org: the org's, needing Agents: Create) with `workspaceId`, `workspaceAccess`, `workspaceSessions` |
| `PUT /v1/sessions/:room/agents/:agentId/exclude` | the session's owner | `{ ok: true }` |
| `DELETE /v1/sessions/:room/agents/:agentId/exclude` | the session's owner | `{ ok: true }` |
| `PUT /v1/agents/me/webhook` | an agent (`qa_` or pass) | `{ url }` → `{ url, secret, events: ['session.started'] }` (secret returned on every PUT; a new one each time) |
| `DELETE /v1/agents/me/webhook` | an agent | `{ ok: true }` |
| `GET /v1/workspaces/:id` | reader | now also `agents: [{ account, agentId, name, provider, via: 'member'|'placed'|'global', access, sessions, managedBy: 'workspace'|'owner'|'org' }]` (members with `kind agent` plus agents reaching it by placement, overrides applied; excluded placed agents listed with `excluded: true` for admins only) |

`join.js`: when the redeemed invite has `workspaceId`, add `putWorkspaceMember({ workspaceId, account: 'agent:'+agent.id, access: invite.workspaceAccess || 'edit', sessions: invite.workspaceSessions || 'invited', addedBy: invite.createdBy })` after the agent is created (inside the existing rollback scope).

Webhook URL validation: reuse `parseWebhookUrl` from `src/webhooks.js` (https only, no private addresses); secret from `newSecret()`.

- [ ] **Step 1: Write the failing test** — features answers both ways; placement GET/PUT by owner, 404 for someone else's agent, 400 for another owner's workspace id; org agent list and placement with Agents: Read/Update (`makeOrg`, `makeAgent(t, { orgId })`); member `sessions` round trip and 400 for a person; override put/delete and 404 for an agent that does not reach the workspace; workspace agent invite then `POST /v1/join/<token>` makes a member with the chosen access and sessions; exclusion by the session owner only; agent webhook put/delete with a `qa_` key, https-only; `GET /v1/workspaces/:id` lists member and placed agents with `via` and `sessions`; every route 404 with the flag off.
- [ ] **Step 2: Run, fail; implement; run** `node --test test/api-workspace-agents.test.js test/api-workspaces.test.js test/api-agent-invites.test.js test/api-join.test.js` and the full suite.
- [ ] **Step 3: Commit** `Workspace agents: API routes for placements, overrides, keep-outs, invites and agent webhooks`.

---

### Task 5: The session-started hand-off

**Files:**
- Modify: `src/api/routes/workspace-agents.js`, `src/account.js`, `src/ui-server.js`, `src/mcp.js`
- Test: in `test/api-workspace-agents.test.js` and `test/ui-workspaces.test.js`

**Interfaces:**
- `POST /v1/workspaces/:id/sessions/:room/started { link }` — caller must be the room's `ownerAccount` and its `workspaceLinkedBy` (the same rule as the access fallback), and the room must be linked to this workspace; `link` must be a Quilt join link for that room (parse with `parseInvite` from `src/ui/invite.js` or `decodeInvite` from `src/runner.js`; reject links for another room, 400). Computes `agentsJoiningSession(store, room)`; for each agent with an `agentWebhook`, sends (without awaiting delivery in the request; record the promises so tests can await `api.flushWebhooks()`):
  ```json
  { "event": "session.started", "id": "<uuid>", "ts": 1791..., "workspace": { "id": "...", "name": "..." }, "room": "<room>", "name": "<session name>", "link": "<join link>", "by": "<owner name>", "via": "member|placed|global" }
  ```
  signed with `signWebhook(secret, ts, body)` and the same headers as room webhooks (`x-quilt-event: session.started`), via `deliverWebhook` with its retries. Answers `{ notified: [agentId…], withoutWebhook: [agentId…] }`. The link is not stored anywhere.
- `src/account.js`: `announceSessionStarted({ token, id, room, link })`.
- `src/ui-server.js` `start()`: right after a successful `setSessionWorkspace`, call `announceSessionStarted` with `entry.run.invite` (the edit link); log failures, never fail the start.
- `src/mcp.js` `startAs`: same after its `setSessionWorkspace` succeeds, with the run's invite.
- `startApi` returns `flushWebhooks()` (awaits pending deliveries) for tests.

- [ ] **Step 1: Write the failing tests** — API: a local https stand-in is hard; instead give `startApi` a `webhookFetch` option (default `globalThis.fetch`) and `allowLocalWebhooks` (tests only) and record calls; assert the payload, signature verifies with `verifyWebhook`, an excluded agent is not notified, an agent without a webhook is in `withoutWebhook`, a non-owner gets 403, a link for another room gets 400, nothing about the link is in the store afterwards (scan the memory store's maps for the secret string). App: `test/ui-workspaces.test.js` — starting a session in a workspace with a placed agent that has a webhook records one delivery whose `link` decodes to the new room.
- [ ] **Step 2: Implement; run** `node --test test/api-workspace-agents.test.js test/ui-workspaces.test.js test/mcp.test.js` and the full suite.
- [ ] **Step 3: Commit** `Workspace agents: tell joining agents when a session starts, with its link`.

---

### Task 6: Shared workspace tools and the local MCP

**Files:**
- Create: `src/workspace-tools.js`
- Modify: `src/mcp.js`, `src/api/workspace-reach.js` (nothing yet; pass auth is Task 7)
- Test: `test/workspace-tools.test.js`, `test/mcp-workspace-tools.test.js`

**Interfaces:**
```js
// src/workspace-tools.js
// call(method, path, body) -> parsed JSON or throws Error with .status; fetchBytes(url) -> Buffer; put(url, bytes, headers) -> status
export const WORKSPACE_GUIDE // one paragraph for the MCP instructions (Task 9 wires it in)
export function registerWorkspaceTools (server, { call, fetchBytes, put, saveDir = null, maxInline = 2 * 1024 * 1024, readLocal = null })
```
Tools (zod schemas like the existing ones in `src/mcp.js`):
- `quilt_workspaces {}` → text list: each workspace's name, id, access, open sessions count, file count, usage.
- `quilt_workspace_files { workspace, folder?, glob? }` → path, kind, size, version, uploader, age (glob with a tiny `*`/`**` matcher).
- `quilt_workspace_read_file { workspace, path, version? }` → finds the file id by path from `GET …/files`; textual mime and size ≤ `maxInline` → fetches the download link and returns the text; otherwise returns the link and expiry, and when `saveDir` is set also saves to `<saveDir>/<workspace>/<path>` and reports `savedTo`.
- `quilt_workspace_write_file { workspace, path, text?, base64?, fromPath?, note? }` → exactly one of the three; `fromPath` only when `readLocal` is given (local MCP); size ≤ 500 MB for `fromPath`, ≤ `maxInline` for text/base64; `POST …/files`, `put` to the upload link, `POST …/done`; answers the path and version.
- `quilt_workspace_move_file { workspace, path, to }`, `quilt_workspace_delete_file { workspace, path }`.
- `quilt_workspace_webhook { url }` and `quilt_workspace_webhook_off {}` → the agent webhook (answers the secret once).
Errors come back as text with the API's message (`isError: true`).

Local MCP (`src/mcp.js`): at startup, `GET <api>/v1/features` with a 2-second timeout; when `workspaces` is true and an agent identity exists (`pickAgent()` succeeds without throwing), call `registerWorkspaceTools(server, { call: (m, p, b) => apiCall with the agent's fresh access key from agentAccess(), fetchBytes, put, saveDir: path.join(quiltHome(), 'workspaces'), readLocal: (p) => fs.promises.readFile(path.resolve(p)) })`. Otherwise register nothing (tool list unchanged).

- [ ] **Step 1: Write the failing tests** — `test/workspace-tools.test.js` drives `registerWorkspaceTools` with a fake `server.registerTool` collector and a fake `call` backed by a real `startTestApi({ workspaces: true })` (agent key from `makeAgent`), checking each tool end to end (write text → read text → list → move → delete; a binary read returns a link; viewer write answers the API's 403 text). `test/mcp-workspace-tools.test.js` checks the local MCP registers the tools only when features is on (start the MCP server in-process the way `test/mcp.test.js` does, with `QUILT_API_URL` pointed at a test API with and without the flag; compare `tools/list`).
- [ ] **Step 2: Implement; run** both tests, `node --test test/mcp.test.js` and the full suite.
- [ ] **Step 3: Commit** `Workspace agents: library tools for agents, in the local MCP`.

---

### Task 7: Hosted MCP tools

**Files:**
- Modify: `src/api/workspace-reach.js` (pass auth), `src/relay-mcp.js`, `src/server.js` (hand the hosted MCP the API URL and a features probe)
- Test: `test/relay-workspace-tools.test.js`, a case in `test/api-workspace-agents.test.js`

**Interfaces:**
- `workspaceReach(ctx).caller(req)` also accepts `authorization: QuiltPass <pass>`: `verifyPass(pass, passPublicKey(passKey))`; only `kind: 'agent'` and not expired; answers `{ account: 'agent:'+sub, userId: null, agent: await store.agentById(sub) }` (revoked → 401). Only the workspace and workspace-file routes use `workspaceReach`, so no other route accepts passes. `ctx` needs `passKey`.
- Relay: when `cfg.apiUrl` is set, probe `GET <apiUrl>/v1/features` at start and every 10 minutes; while on, the hosted MCP's per-request server (`handleHostedMcp`) calls `registerWorkspaceTools(server, { call: (m, p, b) => fetch(apiUrl + p, { method: m, headers: { authorization: 'QuiltPass ' + pass, 'content-type': 'application/json' }, body }) …, fetchBytes, put, saveDir: null, readLocal: null })`, where `pass` is the request's `x-quilt-pass`. Off: nothing registered.
- The hosted agent's workspace tools work whether or not it is in a session (they do not touch `relay.hosted`).

- [ ] **Step 1: Write the failing tests** — API: a valid agent pass reaches `GET /v1/me/workspaces`; a person's pass, an expired pass and a revoked agent get 401; a pass on a non-workspace route (e.g. `GET /v1/agents`) is not accepted. Relay: start a test API (with `passKey`, `workspaces: true`) and a relay with `apiUrl` and `passPublicKey`; drive the hosted MCP through the API's `/mcp` with the agent's `qa_` key (see `test/relay-hosted-mcp.test.js`) and call `quilt_workspaces` and `quilt_workspace_write_file` + `quilt_workspace_read_file`; with the flag off the tools are not listed.
- [ ] **Step 2: Implement; run** `node --test test/relay-workspace-tools.test.js test/relay-hosted-mcp.test.js test/api-workspace-agents.test.js` and the full suite.
- [ ] **Step 3: Commit** `Workspace agents: library tools for hosted agents`.

---

### Task 8: The app

**Files:**
- Modify: `src/account.js`, `src/ui-server.js`, `src/ui/workspaces.js`, `src/ui/home.js`, `src/ui/app.css`
- Test: `test/ui-workspace-agents.test.js` (local routes, with the real chain) and screen assertions in `test/ui-workspaces-screens.test.js`

**Interfaces:**
- Local routes: `GET /api/agents/:id/placement`, `POST /api/agents/:id/placement`; `GET /api/orgs/:slug/agents`; `POST /api/workspaces/:id/members` accepts `sessions`; `POST /api/workspaces/:id/agents/:agentId` (override) and `.../remove`; `POST /api/workspaces/:id/agent-invites` → `{ link }`; `removeMember` in `ui-server.js`: when the session is in a workspace and the key is `agent:<id>`, also `PUT /v1/sessions/:room/agents/:id/exclude`.
- Workspace page People & agents: agent cards show a pill for `via` (`This workspace`, `Global`, `Placed`, `Added by <org>`), and for admins a **Joins** select (`Every session` / `When invited`) that writes the member's `sessions` (member agents) or the override (placed agents); placed agents get **Not in this workspace** (override `excluded`).
- Add dialog (`workspaceInviteDialog` in `home.js`): lists the account's agents (personal workspace) or the org's agents (org workspace, from `/api/orgs/:slug/agents`), an access select, a switch **Also join every session in this workspace as it starts**, and **Invite a new agent** which shows the link to copy (from `/agent-invites`).
- Settings › Agents (`agentRow`/`bindAgents` in `home.js`), only when `state.workspacesOn`: each agent row gets **Available in** (`Only where I add it` / `All my workspaces` / `Chosen workspaces` with checkboxes of the personal workspaces) and **Joins** (`When invited` / `Every session`), saved on change.

- [ ] **Step 1: Write the failing tests** (local routes end to end against `startTestApi({ workspaces: true })`; screen strings: `data-agent-joins`, `data-agent-exclude`, `Also join every session in this workspace as it starts`, `Invite a new agent`, `data-placement-reach`, `data-placement-sessions`).
- [ ] **Step 2: Implement; run** the UI tests and the full suite; **check in the browser preview** (the signed-in preview script): add an agent with the switch on, change Joins, set a placement in Settings, remove an agent from a session; no console errors; with the flag off Settings › Agents looks as on `main`.
- [ ] **Step 3: Commit** `Workspace agents: add, place and manage agents in the app`.

---

### Task 9: Website, guide text, docs and release notes

**Files:**
- Create: `web/components/AgentPlacement.js`, `web/test/agent-placement.test.js`
- Modify: `web/app/dashboard/agents/page.js` (+ actions), `web/app/org/[slug]/people/page.js` (+ actions), both workspace `[id]` pages (agents with `via` and Joins), `src/mcp.js` and `src/relay-mcp.js` (append `WORKSPACE_GUIDE` to the instructions only when the tools are registered), `RELEASES.md`, `docs/hosting.md`, `README.md`, the spec
- Test: web tests; `node --test test/mcp-workspace-tools.test.js` asserts the guide appears only with the tools

**Interfaces:**
- `AgentPlacement({ agent, workspaces, action })`: a small form with Available in (radio + checkboxes) and Joins (select), posting to a server action that PUTs the placement. Shown on the personal Agents page and on org People agent rows (Agents: Update), only when `GET /v1/features` says workspaces are on (`web/lib/workspaces.js` `workspacesOn` exists).
- Workspace `[id]` pages list agents with their `via` pill and, for admins, a Joins select.
- `WORKSPACE_GUIDE`: "Files that are not code (images, video, documents, data) live in the workspace library: read them with quilt_workspace_read_file and put what you make there with quilt_workspace_write_file and a short note, not in chat. Subscribe with quilt_workspace_webhook to be told when a session starts in your workspace; join it with the link the event carries."
- RELEASES.md top section bullets: agents in workspaces (add, invite by link, Joins), Available in / Joins at account level, the library tools, `session.started`, and "For servers: the relay needs `QUILT_API_URL` for hosted agents' workspace tools".
- Spec deltas: session links are forwarded, never stored; the API-level agent webhook; hosted writes ≤ 2 MB; the session people menu's "why here" is phase 4.

- [ ] **Step 1: Write the failing web test and the guide assertion; Step 2: implement; Step 3:** `cd web && npm test`, the root suite, the release test; **Step 4: Commit** `Workspace agents: website, guide text, release notes and docs`.

---

## Self-review notes

- Spec coverage: data model (1, 2), access rule 4 and `agentJoinsSession` (3), placement/override/invite routes (4), session-start wake-up (5), library tools local (6) and hosted (7), app (8), website, guide, docs (9). Deviations by ruling: no API-stored session links (a forwarded `session.started` event instead of the relay letting placed agents in without a link); an API-level agent webhook for workspace events; hosted writes capped at 2 MB; the session people menu's "why here" deferred.
- Names used consistently: store `agentPlacement / putAgentPlacement / listAgentPlacements / workspaceAgentOverride / putWorkspaceAgentOverride / deleteWorkspaceAgentOverride / listWorkspaceAgentOverrides / addSessionAgentExclusion / removeSessionAgentExclusion / sessionAgentExcluded / listSessionAgentExclusions / agentWebhook / putAgentWebhook / deleteAgentWebhook / listOrgAgents`; rules `agentReach / agentJoinsSession / agentsJoiningSession / cleanPlacement`; tools `quilt_workspaces / quilt_workspace_files / quilt_workspace_read_file / quilt_workspace_write_file / quilt_workspace_move_file / quilt_workspace_delete_file / quilt_workspace_webhook / quilt_workspace_webhook_off`; `registerWorkspaceTools`, `WORKSPACE_GUIDE`, `announceSessionStarted`.
