# Workspaces Phase 1 (Shape) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace exists as a table that owns sessions and members; the app shows workspaces as a card grid with an Add card and a workspace page (Sessions, People & agents); sessions can start inside a workspace and admit its members; the website lists and manages workspaces. All behind one flag, off by default.

**Architecture:** New Postgres tables (`workspaces`, `workspace_members`, `relay_sessions.workspace_id`) behind the accounts API, with the same method set in the memory store and the Supabase store. `roomAccess` (the answer the relay already asks for on every pass) gains one fallback: workspace membership. The desktop app calls the API through `src/account.js` helpers, renders the grid and workspace page inside the existing home shell (`renderShell`), and passes a `workspace` id when starting a session. The relay is not changed. The website gets Workspaces pages in the personal and org spaces and a Workspaces row in the role grid.

**Tech Stack:** Node 22 ES modules, `node:test`, Postgres/Supabase (SQL migration + supabase-js), the app's plain ES-module UI (no build), Next.js website in `web/`.

**Spec:** `docs/superpowers/specs/2026-10-03-workspaces-design.md` (phase 1 of "Phases"; mockups in `docs/superpowers/specs/2026-10-03-workspaces-mockups.html`, screens 1, 2, 3 without the Files section, and 6 left panel).

## Global Constraints

- Code style: StandardJS (no semicolons, 2-space indent, single quotes, space before function parens), ES modules, matching the files around it.
- User-facing text: plain, active, no em dashes (tests check `src/ui/*.js`, `src/ui/app.css` and `web/`).
- Access values are `'edit'` and `'view'` (the spec); never `'editor'`/`'viewer'` (those are team access).
- Account strings are `'person:<uuid>'` or `'agent:<uuid>'`, matching `ACCOUNT` checks elsewhere.
- Workspace name: 1 to 80 characters (`cleanName(value, 80, …)`); description up to 500; colour is one of the six palette values or empty.
- The relay (`src/server.js`, `src/protocol.js`, `src/connection.js`, `src/session.js`) is not modified in this phase.
- Migrations are additive only: new tables plus one nullable column on `relay_sessions`.
- Flag: `QUILT_WORKSPACES` (API env, `workspaces: true` option to `startApi`). Off: every `/v1/workspaces*` and `/v1/me/workspaces` route answers 404 `{ error: 'not found' }`, and the app renders today's home. The app follows the API: it shows the grid only when `GET /v1/me/workspaces` answers 200.
- Every file the UI imports is listed in `STATIC` in `src/ui-server.js` (the allowlist test).
- `npm test` from the repo root after every task; two tests fail on main today for unrelated reasons, anything else failing is yours. `web/` tests run with `cd web && npm test`.
- Every user-visible change gets a bullet under the top section of `RELEASES.md` (Task 12).
- Commit after every task on the `workspaces` branch.

---

## File Structure

- Create `supabase/migrations/20261004000000_workspaces.sql`: tables, column, RLS, grants to service_role only, helper functions.
- Create `src/api/workspace-access.js`: pure-ish access resolution: `workspaceAccess(store, workspace, account)`, `isWorkspaceAdmin`, `cleanColor`, constants.
- Modify `src/api/access.js`: `roomAccess` falls back to workspace membership.
- Modify `src/api/permissions.js` and `web/lib/permissions.js` (identical copies): the `workspaces` row.
- Modify `src/api/memory-store.js` and `src/api/supabase-store.js`: workspace methods.
- Create `src/api/routes/workspaces.js`: the routes.
- Modify `src/api/server.js`: `workspaces` option, mount routes, `ROOM` reuse.
- Modify `src/account.js`: `listWorkspaces`, `createWorkspace`, `getWorkspace`, `updateWorkspace`, `deleteWorkspace`, `putWorkspaceMember`, `removeWorkspaceMember`, `setSessionWorkspace`.
- Modify `src/runner.js`: `runSession` takes `workspace`, saves it in `.quilt/config.json`, remembers it in `recent.json`.
- Modify `src/ui-server.js`: `/api/workspaces*` local routes, `start()` takes `workspace`, `summary()` carries it, `STATIC` lists `workspaces.js`.
- Create `src/ui/workspaces.js`: the grid, the add card, the workspace page, the people cards.
- Modify `src/ui/home.js`: home shows the grid when loaded; `newSessionDialog(workspace)`; the loose-sessions strip.
- Modify `src/ui/app.js`: `ws:<id>` views, `state.workspaces`, events refresh.
- Modify `src/ui/common.js`: `state.workspaces`, `state.workspacesOn`.
- Modify `src/ui/app.css`: the `.ws-*` block.
- Modify `web/lib/nav.js`, `web/lib/org-view.js`: Workspaces tabs. Create `web/app/dashboard/workspaces/page.js`, `web/app/dashboard/workspaces/actions.js`, `web/app/org/[slug]/workspaces/page.js`, `web/app/org/[slug]/workspaces/actions.js`, `web/components/WorkspaceList.js`.
- Tests: `test/api-migration-workspaces.test.js`, `test/api-workspace-access.test.js`, `test/api-workspaces.test.js`, `test/api-store-workspaces.test.js`, `test/api-supabase-workspaces.test.js`, `test/account-workspaces.test.js`, `test/ui-workspaces.test.js`, `test/ui-workspaces-screens.test.js`, `web/test/nav.test.js` (extend), `web/test/org-view.test.js` (extend). Extend `test/api-permissions.test.js`.

---

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261004000000_workspaces.sql`
- Test: `test/api-migration-workspaces.test.js`

**Interfaces:**
- Produces: tables `public.workspaces`, `public.workspace_members`; column `public.relay_sessions.workspace_id`; functions `public.delete_workspace (uuid)`, `public.workspaces_for_account (text)`.

- [ ] **Step 1: Write the failing test**

```js
// test/api-migration-workspaces.test.js
// The workspaces migration: additive only, RLS on, no client policies, service role only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../supabase/migrations/20261004000000_workspaces.sql', import.meta.url), 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]

test('workspaces and members, with the columns the spec names', () => {
  const s = sql()
  const ws = table(s, 'workspaces')
  for (const col of ['id uuid primary key default gen_random_uuid()', 'owner_user_id uuid references auth.users (id) on delete cascade', 'org_id uuid references public.orgs (id) on delete cascade', 'name text not null check (char_length(name) between 1 and 80)', "description text not null default '' check (char_length(description) <= 500)", "color text not null default ''", 'created_by text not null', 'created_at timestamptz not null default now()', 'archived_at timestamptz', 'check ((owner_user_id is null) <> (org_id is null))']) assert.ok(ws.includes(col), col)
  const m = table(s, 'workspace_members')
  for (const col of ['workspace_id uuid not null references public.workspaces (id) on delete cascade', "account text not null check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$')", "access text not null check (access in ('edit', 'view'))", 'added_by text not null', 'added_at timestamptz not null default now()', 'primary key (workspace_id, account)']) assert.ok(m.includes(col), col)
  assert.match(s, /alter table public\.relay_sessions add column workspace_id uuid references public\.workspaces \(id\) on delete set null;/)
  assert.match(s, /create index relay_sessions_workspace_id on public\.relay_sessions \(workspace_id\);/)
  assert.match(s, /create index workspace_members_account on public\.workspace_members \(account\);/)
})

test('additive only: no drop, no alter of existing columns', () => {
  const s = sql()
  assert.doesNotMatch(s, /\bdrop\b/i)
  assert.doesNotMatch(s, /alter table public\.(?!relay_sessions add column workspace_id)/)
})

test('clients never touch them: RLS on, no policies, no grants, functions for the service role only', () => {
  const s = sql()
  for (const t of ['workspaces', 'workspace_members']) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.workspaces, public\.workspace_members from anon, authenticated;/)
  assert.match(s, /grant all on public\.workspaces, public\.workspace_members to service_role;/)
  for (const f of ['delete_workspace (uuid)', 'workspaces_for_account (text)']) {
    assert.ok(s.includes(`revoke execute on function public.${f} from public, anon, authenticated;`), f)
    assert.ok(s.includes(`grant execute on function public.${f} to service_role;`), f)
  }
  for (const m of s.matchAll(/create function public\.\w+[\s\S]*?\nas \$\$/g)) assert.match(m[0], /set search_path = ''/, m[0].split('\n')[0])
})

test('deleting a workspace makes its sessions loose and drops its members', () => {
  const s = sql()
  assert.match(s, /update public\.relay_sessions set workspace_id = null where workspace_id = p_id/)
  assert.match(s, /delete from public\.workspaces where id = p_id/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-migration-workspaces.test.js`
Expected: FAIL with `ENOENT` (no such migration file).

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261004000000_workspaces.sql
-- Workspaces: a container owned by a person or an org that holds sessions and members
-- (people and agents). Additive only: two tables and one nullable column. The accounts
-- API is the only reader and writer (service role), so row-level security is on with no
-- client policies and no client grants, like session activity and access types.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users (id) on delete cascade,
  org_id uuid references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  -- One of the app's six pastel covers, or '' for the default.
  color text not null default '' check (char_length(color) <= 16),
  -- 'person:<uuid>' or 'agent:<uuid>'.
  created_by text not null check (created_by ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check ((owner_user_id is null) <> (org_id is null))
);
create index workspaces_owner_user_id on public.workspaces (owner_user_id);
create index workspaces_org_id on public.workspaces (org_id);

-- People and agents in a workspace, each with edit or view. The owner (a person) and an
-- org's managers (role permission) are not rows here: the API knows them.
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  account text not null check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  access text not null check (access in ('edit', 'view')),
  added_by text not null check (added_by ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  added_at timestamptz not null default now(),
  primary key (workspace_id, account)
);
create index workspace_members_account on public.workspace_members (account);

-- A session may belong to one workspace. Deleting the workspace leaves the session loose.
alter table public.relay_sessions add column workspace_id uuid references public.workspaces (id) on delete set null;
create index relay_sessions_workspace_id on public.relay_sessions (workspace_id);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
revoke all on public.workspaces, public.workspace_members from anon, authenticated;
grant all on public.workspaces, public.workspace_members to service_role;

-- Every workspace an account can see as a member, with its access. Owners and org
-- managers are added by the API from workspaces.owner_user_id / org membership.
create function public.workspaces_for_account (p_account text)
returns table (workspace_id uuid, access text)
language sql
stable
set search_path = ''
as $$
  select m.workspace_id, m.access from public.workspace_members m where m.account = p_account;
$$;
revoke execute on function public.workspaces_for_account (text) from public, anon, authenticated;
grant execute on function public.workspaces_for_account (text) to service_role;

-- Deletes a workspace: its sessions become loose first (so the on delete set null never
-- races a concurrent link), then the row goes and members cascade.
create function public.delete_workspace (p_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.relay_sessions set workspace_id = null where workspace_id = p_id;
  delete from public.workspaces where id = p_id;
end;
$$;
revoke execute on function public.delete_workspace (uuid) from public, anon, authenticated;
grant execute on function public.delete_workspace (uuid) to service_role;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/api-migration-workspaces.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261004000000_workspaces.sql test/api-migration-workspaces.test.js
git commit -m "Workspaces: migration (tables, session column, service-role functions)"
```

---

### Task 2: Permission row and the pure access module

**Files:**
- Modify: `src/api/permissions.js` (ALLOWED, LABELS, BUILTIN.member)
- Modify: `web/lib/permissions.js` (identical copy; `test/permissions-sync.test.js` checks it)
- Modify: `test/api-permissions.test.js:9-13,51`
- Create: `src/api/workspace-access.js`
- Test: `test/api-workspace-access.test.js`

**Interfaces:**
- Produces: `ALLOWED.workspaces = ['c','r','u','d']`, `LABELS.workspaces = 'Workspaces'`, `BUILTIN.member = { teams: { r: true }, workspaces: { r: true } }`.
- Produces (`src/api/workspace-access.js`):
  - `export const COLORS = ['lilac', 'mint', 'peach', 'rose', 'periwinkle', 'sky']`
  - `export function cleanColor (value) -> string` (one of COLORS or `''`; throws `HttpError(400, 'Pick one of the workspace colours.')` otherwise)
  - `export function cleanDescription (value) -> string` (trimmed, invisible chars stripped, at most 500; longer throws 400)
  - `export const ACCESS = ['edit', 'view']`, `export function cleanAccess (value) -> 'edit'|'view'` (throws 400 `'Access is edit or view.'`)
  - `export async function workspaceAccess (store, workspace, account, { orgGrants } = {}) -> { access: 'edit'|'view', admin: boolean, via: 'owner'|'org'|'member' } | null`
    - `workspace` is a store row `{ id, ownerUserId, orgId, … }`; `account` is `'person:<id>'`/`'agent:<id>'`.
    - Personal: owner (`account === 'person:' + ownerUserId`) → `{ access: 'edit', admin: true, via: 'owner' }`.
    - Org: `orgGrants` is the caller's resolved `{ can(resource, op) }` from `orgAccess` or null when not a member. `can('workspaces','u')` → `{ access: 'edit', admin: true, via: 'org' }`; else `can('workspaces','r')` with no member row → `{ access: 'view', admin: false, via: 'org' }`.
    - Member row (`store.workspaceMember(workspace.id, account)`) → `{ access: row.access, admin: false, via: 'member' }`. A member row beats org Read-only.
    - Otherwise null.

- [ ] **Step 1: Write the failing tests**

Extend `test/api-permissions.test.js`: change the assertions at lines 9 to 13 and 51 to

```js
  assert.deepEqual(RESOURCES, ['org', 'members', 'agents', 'teams', 'team_members', 'invites', 'roles', 'workspaces', 'billing'])
  assert.deepEqual(ALLOWED.org, ['r', 'u'])
  assert.deepEqual(ALLOWED.members, ['r', 'u', 'd'])
  for (const r of ['agents', 'teams', 'team_members', 'invites', 'roles', 'workspaces']) assert.deepEqual(ALLOWED[r], ['c', 'r', 'u', 'd'], r)
  assert.deepEqual(ALLOWED.billing, [], 'reserved for per-seat plans')
```
and
```js
  assert.deepEqual(BUILTIN.member, { teams: { r: true }, workspaces: { r: true } })
```
Also add, in the same file:
```js
test('the Workspaces row is labelled', () => { assert.equal(LABELS.workspaces, 'Workspaces') })
```

Create `test/api-workspace-access.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'
import { workspaceAccess, cleanColor, cleanDescription, cleanAccess, COLORS } from '../src/api/workspace-access.js'

const can = (...ok) => ({ can: (r, op) => ok.includes(`${r}:${op}`) })

test('a personal workspace: the owner is admin, members have their access, others nothing', async () => {
  const store = createMemoryStore()
  const ws = await store.createWorkspace({ ownerUserId: 'u1', name: 'Launch', createdBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u2', access: 'view', addedBy: 'person:u1' })
  assert.deepEqual(await workspaceAccess(store, ws, 'person:u1'), { access: 'edit', admin: true, via: 'owner' })
  assert.deepEqual(await workspaceAccess(store, ws, 'person:u2'), { access: 'view', admin: false, via: 'member' })
  assert.equal(await workspaceAccess(store, ws, 'person:u3'), null)
  assert.equal(await workspaceAccess(store, ws, 'agent:a1'), null)
})

test('an org workspace: Workspaces: Update is admin, Read alone is view, a member row wins over Read', async () => {
  const store = createMemoryStore()
  const ws = await store.createWorkspace({ orgId: 'o1', name: 'Core', createdBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u3', access: 'edit', addedBy: 'person:u1' })
  assert.deepEqual(await workspaceAccess(store, ws, 'person:u1', { orgGrants: can('workspaces:r', 'workspaces:u') }), { access: 'edit', admin: true, via: 'org' })
  assert.deepEqual(await workspaceAccess(store, ws, 'person:u2', { orgGrants: can('workspaces:r') }), { access: 'view', admin: false, via: 'org' })
  assert.deepEqual(await workspaceAccess(store, ws, 'person:u3', { orgGrants: can('workspaces:r') }), { access: 'edit', admin: false, via: 'member' })
  assert.equal(await workspaceAccess(store, ws, 'person:u4', { orgGrants: can() }), null)
  assert.equal(await workspaceAccess(store, ws, 'person:u4', { orgGrants: null }), null, 'not in the org')
  assert.deepEqual(await workspaceAccess(store, ws, 'agent:a1', { orgGrants: null }), null)
})

test('cleaners', () => {
  assert.equal(cleanColor(undefined), '')
  assert.equal(cleanColor('mint'), 'mint')
  assert.throws(() => cleanColor('red'), /Pick one of the workspace colours\./)
  assert.equal(COLORS.length, 6)
  assert.equal(cleanDescription('  hi ​'), 'hi')
  assert.throws(() => cleanDescription('x'.repeat(501)), /500/)
  assert.equal(cleanAccess('view'), 'view')
  assert.throws(() => cleanAccess('owner'), /Access is edit or view\./)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/api-permissions.test.js test/api-workspace-access.test.js`
Expected: FAIL (RESOURCES mismatch; `workspace-access.js` not found).

- [ ] **Step 3: Implement**

In `src/api/permissions.js`, change `ALLOWED` to

```js
export const ALLOWED = {
  org: ['r', 'u'],
  members: ['r', 'u', 'd'],
  agents: ['c', 'r', 'u', 'd'],
  teams: ['c', 'r', 'u', 'd'],
  team_members: ['c', 'r', 'u', 'd'],
  invites: ['c', 'r', 'u', 'd'],
  roles: ['c', 'r', 'u', 'd'],
  workspaces: ['c', 'r', 'u', 'd'],
  billing: []
}
```
add `workspaces: 'Workspaces',` to `LABELS` after `roles`, and change `BUILTIN.member` to `{ teams: { r: true }, workspaces: { r: true } }`. Copy the whole file over `web/lib/permissions.js` (`cp src/api/permissions.js web/lib/permissions.js`).

Create `src/api/workspace-access.js`:

```js
// Who may do what in a workspace (the spec's "Access" section), and the field cleaners
// the routes share. Pure apart from one store read.
import { HttpError, stripInvisible } from './http.js'

export const COLORS = ['lilac', 'mint', 'peach', 'rose', 'periwinkle', 'sky']
export const ACCESS = ['edit', 'view']
const MAX_DESCRIPTION = 500

export function cleanColor (value) {
  if (value === undefined || value === null || value === '') return ''
  if (!COLORS.includes(value)) throw new HttpError(400, 'Pick one of the workspace colours.')
  return value
}

export function cleanDescription (value) {
  const s = stripInvisible(String(value ?? '')).trim()
  if (s.length > MAX_DESCRIPTION) throw new HttpError(400, `Keep the description under ${MAX_DESCRIPTION} characters.`)
  return s
}

export function cleanAccess (value) {
  if (!ACCESS.includes(value)) throw new HttpError(400, 'Access is edit or view.')
  return value
}

/**
 * `account`'s place in `workspace`: { access, admin, via } or null.
 * Personal: the owner is admin. Org: Workspaces: Update is admin; Workspaces: Read alone
 * is view. A member row gives its access and beats org Read. `orgGrants` is the caller's
 * org access ({ can }) or null when they aren't in the org.
 */
export async function workspaceAccess (store, workspace, account, { orgGrants = null } = {}) {
  if (workspace.ownerUserId && account === `person:${workspace.ownerUserId}`) return { access: 'edit', admin: true, via: 'owner' }
  if (workspace.orgId && orgGrants && orgGrants.can('workspaces', 'u')) return { access: 'edit', admin: true, via: 'org' }
  const member = await store.workspaceMember(workspace.id, account)
  if (member) return { access: member.access, admin: false, via: 'member' }
  if (workspace.orgId && orgGrants && orgGrants.can('workspaces', 'r')) return { access: 'view', admin: false, via: 'org' }
  return null
}
```

Check `stripInvisible` is exported from `src/api/http.js` (it is, line 18). The store methods `createWorkspace`, `putWorkspaceMember`, `workspaceMember` come in Task 3; until then this test's store calls fail, so run only the cleaners test now and the rest after Task 3.

- [ ] **Step 4: Run the tests**

Run: `node --test test/api-permissions.test.js test/permissions-sync.test.js && node --test --test-name-pattern=cleaners test/api-workspace-access.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/permissions.js web/lib/permissions.js src/api/workspace-access.js test/api-permissions.test.js test/api-workspace-access.test.js
git commit -m "Workspaces: permission row and access resolution"
```

---

### Task 3: Store methods (memory and Supabase)

**Files:**
- Modify: `src/api/memory-store.js` (declare maps near line 30; add methods before the final `listEvents` block)
- Modify: `src/api/supabase-store.js` (add `WORKSPACE`, `WORKSPACE_MEMBER` constants near line 26; methods after `renameSession`)
- Test: `test/api-store-workspaces.test.js`, `test/api-supabase-workspaces.test.js`

**Interfaces (both stores, identical):**
- `createWorkspace({ ownerUserId = null, orgId = null, name, description = '', color = '', createdBy }) -> row`
  row: `{ id, ownerUserId, orgId, name, description, color, createdBy, createdAt, archivedAt }`
- `workspaceById(id) -> row | null`
- `listWorkspacesOwnedBy(userId) -> row[]` (not archived first? no: all, sorted by name)
- `listWorkspacesOfOrg(orgId) -> row[]` (sorted by name)
- `listWorkspacesForMember(account) -> [{ ...row, memberAccess }]` (every workspace the account has a member row in)
- `updateWorkspace(id, { name?, description?, color?, archivedAt? }) -> row | null`
- `deleteWorkspace(id) -> void` (sessions in it get `workspaceId: null`; members go)
- `workspaceMember(workspaceId, account) -> { workspaceId, account, access, addedBy, addedAt } | null`
- `listWorkspaceMembers(workspaceId) -> member[]` (sorted by addedAt)
- `putWorkspaceMember({ workspaceId, account, access, addedBy }) -> member` (upsert; keeps addedAt)
- `removeWorkspaceMember(workspaceId, account) -> boolean`
- `setSessionWorkspace(room, workspaceId | null, { ownerAccount, at }) -> session row` (upserts the `relay_sessions` row if the relay hasn't reported it yet: `{ room, name: '', ownerAccount, createdAt: at, lastActiveAt: at, workspaceId }`; on an existing row sets `workspaceId` only)
- `listWorkspaceSessions(workspaceId) -> session row[]` (most recently active first)
- `sessionByRoom(room)` now includes `workspaceId` (null when none).

- [ ] **Step 1: Write the failing memory-store test**

```js
// test/api-store-workspaces.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'

test('create, read, list by owner, org and member; update; archive', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  const a = await store.createWorkspace({ ownerUserId: 'u1', name: 'Launch', description: 'Teaser', color: 'lilac', createdBy: 'person:u1' })
  const b = await store.createWorkspace({ orgId: 'o1', name: 'Core', createdBy: 'person:u2' })
  assert.deepEqual(a, { id: a.id, ownerUserId: 'u1', orgId: null, name: 'Launch', description: 'Teaser', color: 'lilac', createdBy: 'person:u1', createdAt: 1000, archivedAt: null })
  assert.deepEqual(await store.workspaceById(a.id), a)
  assert.equal(await store.workspaceById('nope'), null)
  assert.deepEqual((await store.listWorkspacesOwnedBy('u1')).map((w) => w.id), [a.id])
  assert.deepEqual((await store.listWorkspacesOfOrg('o1')).map((w) => w.id), [b.id])
  await store.putWorkspaceMember({ workspaceId: b.id, account: 'person:u1', access: 'view', addedBy: 'person:u2' })
  assert.deepEqual((await store.listWorkspacesForMember('person:u1')).map((w) => [w.id, w.memberAccess]), [[b.id, 'view']])
  const up = await store.updateWorkspace(a.id, { name: 'Launch 2', color: 'mint' })
  assert.deepEqual([up.name, up.color, up.description], ['Launch 2', 'mint', 'Teaser'])
  assert.equal((await store.updateWorkspace(a.id, { archivedAt: 2000 })).archivedAt, 2000)
  assert.equal(await store.updateWorkspace('nope', { name: 'x' }), null)
})

test('members: put upserts and keeps addedAt, list sorts, remove answers whether it was there', async () => {
  let t = 1000
  const store = createMemoryStore({ now: () => t })
  const ws = await store.createWorkspace({ ownerUserId: 'u1', name: 'W', createdBy: 'person:u1' })
  const m1 = await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u2', access: 'view', addedBy: 'person:u1' })
  t = 2000
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'agent:a1', access: 'edit', addedBy: 'person:u1' })
  const m1b = await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u2', access: 'edit', addedBy: 'person:u1' })
  assert.deepEqual([m1.addedAt, m1b.addedAt, m1b.access], [1000, 1000, 'edit'])
  assert.deepEqual((await store.listWorkspaceMembers(ws.id)).map((m) => m.account), ['person:u2', 'agent:a1'])
  assert.deepEqual(await store.workspaceMember(ws.id, 'agent:a1'), { workspaceId: ws.id, account: 'agent:a1', access: 'edit', addedBy: 'person:u1', addedAt: 2000 })
  assert.equal(await store.removeWorkspaceMember(ws.id, 'agent:a1'), true)
  assert.equal(await store.removeWorkspaceMember(ws.id, 'agent:a1'), false)
  assert.equal(await store.workspaceMember(ws.id, 'agent:a1'), null)
})

test('sessions: link a room before or after the relay reports it; delete makes sessions loose', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  const ws = await store.createWorkspace({ ownerUserId: 'u1', name: 'W', createdBy: 'person:u1' })
  // Before the relay reports the room: the API makes the row.
  const s1 = await store.setSessionWorkspace('room-a', ws.id, { ownerAccount: 'person:u1', at: 1000 })
  assert.deepEqual(s1, { room: 'room-a', name: '', ownerAccount: 'person:u1', createdAt: 1000, lastActiveAt: 1000, renamedAt: null, workspaceId: ws.id })
  // The relay's start event then keeps the row (ingestPresence mirrors on conflict).
  await store.ingestPresence([{ id: 'e1', type: 'start', room: 'room-a', account: 'person:u1', owner: true, name: 'Mo', at: 1500 }], 1500)
  assert.equal((await store.sessionByRoom('room-a')).workspaceId, ws.id)
  // After: an existing row only gets the column.
  await store.ingestPresence([{ id: 'e2', type: 'start', room: 'room-b', account: 'person:u1', owner: true, name: 'Mo', at: 1600 }], 1600)
  const s2 = await store.setSessionWorkspace('room-b', ws.id, { ownerAccount: 'person:u9', at: 1700 })
  assert.deepEqual([s2.ownerAccount, s2.workspaceId, s2.createdAt], ['person:u1', ws.id, 1600])
  assert.deepEqual((await store.listWorkspaceSessions(ws.id)).map((s) => s.room), ['room-b', 'room-a'])
  await store.setSessionWorkspace('room-b', null, { ownerAccount: 'person:u1', at: 1800 })
  assert.equal((await store.sessionByRoom('room-b')).workspaceId, null)
  await store.deleteWorkspace(ws.id)
  assert.equal(await store.workspaceById(ws.id), null)
  assert.equal((await store.sessionByRoom('room-a')).workspaceId, null)
  assert.deepEqual(await store.listWorkspaceMembers(ws.id), [])
})
```

The memory store's presence method is `ingestPresence(events, receivedAt)` (`src/api/memory-store.js:214`).

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-store-workspaces.test.js`
Expected: FAIL `store.createWorkspace is not a function`.

- [ ] **Step 3: Implement the memory store**

Near line 30 of `src/api/memory-store.js` add the maps:

```js
  const workspaces = new Map(); const workspaceMembers = new Map()
  const wmKey = (workspaceId, account) => `${workspaceId}\n${account}`
```

Where `relaySessions` rows are created (the `start` branch of the presence ingestion and anywhere else a session row is built), make sure new rows carry `workspaceId: null` and that an existing row keeps its `workspaceId` (an `on conflict` that only touches `ownerAccount`/`lastActiveAt` already does). Add, before the final `listEvents () {` line:

```js
    // Workspaces (see 20261004000000_workspaces.sql).
    async createWorkspace ({ ownerUserId = null, orgId = null, name, description = '', color = '', createdBy }) {
      if ((ownerUserId == null) === (orgId == null)) throw checkViolation('a workspace belongs to a person or an org')
      const row = { id: uuid(), ownerUserId, orgId, name, description, color, createdBy, createdAt: now(), archivedAt: null }
      workspaces.set(row.id, row); return copy(row)
    },
    async workspaceById (id) { return copy(workspaces.get(id)) },
    async listWorkspacesOwnedBy (userId) { return all(workspaces, (w) => w.ownerUserId === userId).sort((a, b) => a.name.localeCompare(b.name)).map(copy) },
    async listWorkspacesOfOrg (orgId) { return all(workspaces, (w) => w.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name)).map(copy) },
    async listWorkspacesForMember (account) {
      return all(workspaceMembers, (m) => m.account === account)
        .map((m) => ({ ...copy(workspaces.get(m.workspaceId)), memberAccess: m.access }))
        .filter((w) => w.id)
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    async updateWorkspace (id, patch) {
      const w = workspaces.get(id)
      if (!w) return null
      for (const k of ['name', 'description', 'color', 'archivedAt']) if (patch[k] !== undefined) w[k] = patch[k]
      return copy(w)
    },
    async deleteWorkspace (id) {
      for (const s of relaySessions.values()) if (s.workspaceId === id) s.workspaceId = null
      for (const [k, m] of workspaceMembers) if (m.workspaceId === id) workspaceMembers.delete(k)
      workspaces.delete(id)
    },
    async workspaceMember (workspaceId, account) { return copy(workspaceMembers.get(wmKey(workspaceId, account))) },
    async listWorkspaceMembers (workspaceId) { return all(workspaceMembers, (m) => m.workspaceId === workspaceId).sort((a, b) => a.addedAt - b.addedAt).map(copy) },
    async putWorkspaceMember ({ workspaceId, account, access, addedBy }) {
      if (!workspaces.has(workspaceId)) throw fkViolation('workspace', 'does not exist')
      const k = wmKey(workspaceId, account)
      const old = workspaceMembers.get(k)
      const row = { workspaceId, account, access, addedBy, addedAt: old ? old.addedAt : now() }
      workspaceMembers.set(k, row); return copy(row)
    },
    async removeWorkspaceMember (workspaceId, account) { return workspaceMembers.delete(wmKey(workspaceId, account)) },
    // Links a room to a workspace (or none). The relay may not have reported the room yet: then the API makes the row.
    async setSessionWorkspace (room, workspaceId, { ownerAccount, at }) {
      if (workspaceId && !workspaces.has(workspaceId)) throw fkViolation('workspace', 'does not exist')
      let s = relaySessions.get(room)
      if (!s) { s = { room, name: '', ownerAccount, createdAt: at, lastActiveAt: at, renamedAt: null, workspaceId: null }; relaySessions.set(room, s) }
      s.workspaceId = workspaceId || null
      return copy(s)
    },
    async listWorkspaceSessions (workspaceId) { return all(relaySessions, (s) => s.workspaceId === workspaceId).sort((a, b) => b.lastActiveAt - a.lastActiveAt).map(copy) },
```

`checkViolation` and `fkViolation` exist at the top of the file. Also find where the memory store's `deleteUser` drops the sessions a person owns and add: `for (const [k, w] of workspaces) if (w.ownerUserId === userId) { for (const s of relaySessions.values()) if (s.workspaceId === k) s.workspaceId = null; for (const [mk, m] of workspaceMembers) if (m.workspaceId === k) workspaceMembers.delete(mk); workspaces.delete(k) }` (the Postgres cascade). Where the memory store deletes an org, do the same for `w.orgId === orgId`.

- [ ] **Step 4: Run the memory tests and the access test from Task 2**

Run: `node --test test/api-store-workspaces.test.js test/api-workspace-access.test.js test/api-store-activity.test.js`
Expected: PASS.

- [ ] **Step 5: Write the Supabase store test**

Look at how `test/api-supabase-access.test.js` fakes the client (a recording `client` with `from().select().eq()…` chains and `rpc`). Mirror it:

```js
// test/api-supabase-workspaces.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'

// A client that records every call and answers with canned rows (see api-supabase-access.test.js for the shape).
function fakeClient (answers = {}) {
  const calls = []
  const chain = (table) => {
    const c = { table, ops: [] }
    const q = new Proxy({}, {
      get (_, name) {
        if (name === 'then') return (res, rej) => Promise.resolve(answers[table] ?? { data: null, error: null }).then(res, rej)
        return (...args) => { c.ops.push([name, args]); return q }
      }
    })
    calls.push(c)
    return q
  }
  return { calls, from: (t) => chain(t), rpc: (name, args) => { calls.push({ rpc: name, args }); return Promise.resolve(answers[name] ?? { data: null, error: null }) } }
}

test('createWorkspace inserts snake_case columns and maps the row back', async () => {
  const row = { id: 'w1', owner_user_id: 'u1', org_id: null, name: 'Launch', description: '', color: 'mint', created_by: 'person:u1', created_at: '2026-10-04T00:00:00.000Z', archived_at: null }
  const client = fakeClient({ workspaces: { data: row, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.createWorkspace({ ownerUserId: 'u1', name: 'Launch', color: 'mint', createdBy: 'person:u1' })
  const ins = client.calls[0].ops.find(([op]) => op === 'insert')[1][0]
  assert.deepEqual(ins, { owner_user_id: 'u1', org_id: null, name: 'Launch', description: '', color: 'mint', created_by: 'person:u1' })
  assert.deepEqual([out.id, out.ownerUserId, out.createdAt, out.archivedAt], ['w1', 'u1', Date.parse(row.created_at), null])
})

test('setSessionWorkspace upserts the session row without touching the owner of an existing one', async () => {
  const client = fakeClient({ relay_sessions: { data: { room: 'r', name: '', owner_account: 'person:u1', created_at: '2026-10-04T00:00:00.000Z', last_active_at: '2026-10-04T00:00:00.000Z', renamed_at: null, workspace_id: 'w1' }, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.setSessionWorkspace('r', 'w1', { ownerAccount: 'person:u1', at: Date.parse('2026-10-04T00:00:00.000Z') })
  assert.equal(out.workspaceId, 'w1')
  assert.deepEqual(client.calls[0], { rpc: 'set_session_workspace', args: { p_room: 'r', p_workspace: 'w1', p_owner: 'person:u1', p_at: '2026-10-04T00:00:00.000Z' } })
})

test('deleteWorkspace calls the service-role function', async () => {
  const client = fakeClient()
  await createSupabaseStore({ client }).deleteWorkspace('w1')
  assert.deepEqual(client.calls[0], { rpc: 'delete_workspace', args: { p_id: 'w1' } })
})
```

`set_session_workspace` is a new SQL function: add it to the migration from Task 1 (and to that test's `FUNCTIONS` list as `'set_session_workspace (text, uuid, text, timestamptz)'`):

```sql
-- Links a room to a workspace (or none). The app calls this as soon as the relay has made
-- the room, which may be before the relay's first presence report: then the row is made
-- here and the report later keeps it (ingest_presence's on conflict never changes
-- workspace_id). On an existing row only the column changes.
create function public.set_session_workspace (p_room text, p_workspace uuid, p_owner text, p_at timestamptz)
returns public.relay_sessions
language plpgsql
set search_path = ''
as $$
declare
  s public.relay_sessions;
begin
  insert into public.relay_sessions as r (room, owner_account, created_at, last_active_at, workspace_id)
    values (p_room, p_owner, p_at, p_at, p_workspace)
    on conflict (room) do update set workspace_id = excluded.workspace_id
    returning * into s;
  return s;
end;
$$;
revoke execute on function public.set_session_workspace (text, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.set_session_workspace (text, uuid, text, timestamptz) to service_role;
```

- [ ] **Step 6: Implement the Supabase store**

In `src/api/supabase-store.js` add constants after `SESSION_INVITE`:

```js
const WORKSPACE = 'id, owner_user_id, org_id, name, description, color, created_by, created_at, archived_at'
const WORKSPACE_MEMBER = 'workspace_id, account, access, added_by, added_at'
```
Change `RELAY_SESSION` to `'room, name, owner_account, created_at, last_active_at, renamed_at, workspace_id'`. Add methods after `renameSession`:

```js
    // Workspaces (see 20261004000000_workspaces.sql).
    async createWorkspace ({ ownerUserId = null, orgId = null, name, description = '', color = '', createdBy }) {
      return rowFrom(await one(db.from('workspaces').insert({ owner_user_id: ownerUserId, org_id: orgId, name, description, color, created_by: createdBy }).select(WORKSPACE).single()))
    },
    async workspaceById (id) { return rowFrom(await one(db.from('workspaces').select(WORKSPACE).eq('id', id).maybeSingle())) },
    async listWorkspacesOwnedBy (userId) { return (await one(db.from('workspaces').select(WORKSPACE).eq('owner_user_id', userId).order('name'))).map(rowFrom) },
    async listWorkspacesOfOrg (orgId) { return (await one(db.from('workspaces').select(WORKSPACE).eq('org_id', orgId).order('name'))).map(rowFrom) },
    async listWorkspacesForMember (account) {
      const rows = await one(db.from('workspace_members').select(`access, workspaces (${WORKSPACE})`).eq('account', account))
      return rows.filter((r) => r.workspaces).map((r) => ({ ...rowFrom(r.workspaces), memberAccess: r.access })).sort((a, b) => a.name.localeCompare(b.name))
    },
    async updateWorkspace (id, { name, description, color, archivedAt }) {
      return rowFrom(await one(db.from('workspaces').update(toSnake({ name, description, color, archivedAt: ts(archivedAt) })).eq('id', id).select(WORKSPACE).maybeSingle()))
    },
    async deleteWorkspace (id) { await one(db.rpc('delete_workspace', { p_id: id })) },
    async workspaceMember (workspaceId, account) { return rowFrom(await one(db.from('workspace_members').select(WORKSPACE_MEMBER).eq('workspace_id', workspaceId).eq('account', account).maybeSingle())) },
    async listWorkspaceMembers (workspaceId) { return (await one(db.from('workspace_members').select(WORKSPACE_MEMBER).eq('workspace_id', workspaceId).order('added_at'))).map(rowFrom) },
    async putWorkspaceMember ({ workspaceId, account, access, addedBy }) {
      // Keep added_at on a change of access: upsert only touches access and added_by.
      return rowFrom(await one(db.from('workspace_members').upsert({ workspace_id: workspaceId, account, access, added_by: addedBy }, { onConflict: 'workspace_id,account' }).select(WORKSPACE_MEMBER).single()))
    },
    async removeWorkspaceMember (workspaceId, account) {
      const rows = await one(db.from('workspace_members').delete().eq('workspace_id', workspaceId).eq('account', account).select('account'))
      return rows.length > 0
    },
    async setSessionWorkspace (room, workspaceId, { ownerAccount, at }) {
      return rowFrom(await one(db.rpc('set_session_workspace', { p_room: room, p_workspace: workspaceId || null, p_owner: ownerAccount, p_at: ts(at) })))
    },
    async listWorkspaceSessions (workspaceId) { return (await one(db.from('relay_sessions').select(RELAY_SESSION).eq('workspace_id', workspaceId).order('last_active_at', { ascending: false }))).map(rowFrom) },
```

Note on `putWorkspaceMember`: Supabase's upsert with `onConflict` updates every supplied column; `added_at` is not supplied, so it keeps its value. The memory store does the same.

- [ ] **Step 7: Run all store tests**

Run: `node --test test/api-store-workspaces.test.js test/api-supabase-workspaces.test.js test/api-supabase-store.test.js test/api-migration-workspaces.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/api/memory-store.js src/api/supabase-store.js supabase/migrations/20261004000000_workspaces.sql test/api-store-workspaces.test.js test/api-supabase-workspaces.test.js test/api-migration-workspaces.test.js
git commit -m "Workspaces: store methods in the memory and Supabase stores"
```

---

### Task 4: `roomAccess` falls back to workspace membership

**Files:**
- Modify: `src/api/access.js:36-45`
- Test: `test/api-room-passes.test.js` (extend) and `test/access.test.js` or a new `test/api-access-workspace.test.js`

**Interfaces:**
- Consumes: `store.sessionByRoom(room).workspaceId`, `store.workspaceById`, `workspaceAccess` from Task 2, `orgAccess` from `src/api/org-access.js`.
- Produces: `roomAccess(store, room, account, email)` returns, when there is no owner match and no grant, the workspace member's access as an effective access object: `effectiveAccess(builtinType(wa.access === 'edit' ? 'builtin:edit' : 'builtin:view'))`.

- [ ] **Step 1: Write the failing test**

```js
// test/api-access-workspace.test.js
// A session inside a workspace lets the workspace's members in at their workspace access.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'
import { roomAccess, OWNER_ACCESS } from '../src/api/access.js'
import { BUILTIN } from '../src/api/permissions.js'

async function setup () {
  const store = createMemoryStore({ now: () => 1000 })
  store.addUser('u1', { name: 'Dan', email: 'd@x.com', confirmed: true })
  store.addUser('u2', { name: 'Bran', email: 'b@x.com', confirmed: true })
  store.addUser('u3', { name: 'Jules', email: 'j@x.com', confirmed: true })
  const ws = await store.createWorkspace({ ownerUserId: 'u1', name: 'Launch', createdBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u2', access: 'view', addedBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'agent:a1', access: 'edit', addedBy: 'person:u1' })
  await store.setSessionWorkspace('room-1', ws.id, { ownerAccount: 'person:u1', at: 1000 })
  return { store, ws }
}

test('owner, members and outsiders of a personal workspace', async () => {
  const { store } = await setup()
  assert.deepEqual(await roomAccess(store, 'room-1', 'person:u1'), OWNER_ACCESS)
  assert.equal((await roomAccess(store, 'room-1', 'person:u2')).files, 'view')
  assert.equal((await roomAccess(store, 'room-1', 'agent:a1')).files, 'edit')
  assert.equal(await roomAccess(store, 'room-1', 'person:u3'), null)
})

test('a grant on the session itself wins over workspace membership', async () => {
  const { store } = await setup()
  await store.putGrant({ room: 'room-1', account: 'person:u2', typeId: 'builtin:edit', tighten: {}, grantedBy: 'person:u1' })
  assert.equal((await roomAccess(store, 'room-1', 'person:u2')).files, 'edit')
})

test('an org workspace: Workspaces: Update is edit, Read is view, non-members nothing', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  for (const [id, email] of [['u1', 'o@acme.com'], ['u2', 'a@acme.com'], ['u3', 'm@acme.com'], ['u4', 'x@else.com']]) store.addUser(id, { name: id, email, confirmed: true, kind: id === 'u1' ? 'org' : 'personal' })
  const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerId: 'u1', grants: BUILTIN })
  const roles = await store.listRoles(org.id)
  await store.addMember({ orgId: org.id, userId: 'u2', roleId: roles.find((r) => r.builtin === 'admin').id })
  await store.addMember({ orgId: org.id, userId: 'u3', roleId: roles.find((r) => r.builtin === 'member').id })
  const ws = await store.createWorkspace({ orgId: org.id, name: 'Core', createdBy: 'person:u1' })
  await store.setSessionWorkspace('room-2', ws.id, { ownerAccount: 'person:u2', at: 1000 })
  assert.deepEqual(await roomAccess(store, 'room-2', 'person:u2'), OWNER_ACCESS, 'the session owner')
  assert.equal((await roomAccess(store, 'room-2', 'person:u1')).files, 'edit', 'org owner')
  assert.equal((await roomAccess(store, 'room-2', 'person:u3')).files, 'view', 'Member has Workspaces: Read')
  assert.equal(await roomAccess(store, 'room-2', 'person:u4'), null)
})

test('a loose session is unchanged', async () => {
  const { store } = await setup()
  await store.setSessionWorkspace('room-1', null, { ownerAccount: 'person:u1', at: 1000 })
  assert.equal(await roomAccess(store, 'room-1', 'person:u2'), null)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-access-workspace.test.js`
Expected: FAIL (members get `null`).

- [ ] **Step 3: Implement**

In `src/api/access.js`, import and rewrite `roomAccess`:

```js
import { builtinType, effectiveAccess, FALLBACK_TYPE } from '../session-access.js'
import { workspaceAccess } from './workspace-access.js'
import { orgGrantsFor } from './org-access.js'

export async function roomAccess (store, room, account, email = '') {
  const session = await store.sessionByRoom(room)
  if (!session) return null
  if (session.ownerAccount === account) return OWNER_ACCESS
  if (email) await store.claimEmailInvites(room, email.toLowerCase(), account)
  const grant = await store.grantFor(room, account)
  if (grant) {
    await store.useAccountInvites(room, account)
    return effectiveAccess(await typeOfGrant(store, grant), grant.tighten)
  }
  // No grant of its own: a session inside a workspace admits the workspace's members.
  if (!session.workspaceId) return null
  const ws = await store.workspaceById(session.workspaceId)
  if (!ws) return null
  const wa = await workspaceAccess(store, ws, account, { orgGrants: ws.orgId ? await orgGrantsFor(store, ws.orgId, account) : null })
  return wa ? effectiveAccess(builtinType(wa.access === 'edit' ? 'builtin:edit' : 'builtin:view'), {}) : null
}
```

Add to `src/api/org-access.js` a small helper that resolves an account's org grants without throwing (agents are org members too, through `org_members.agent_id`):

```js
/** An account's grants in an org as { can }, or null when it isn't a member. Never throws. */
export async function orgGrantsFor (store, orgId, account) {
  const [kind, id] = account.split(':')
  const org = await store.orgById(orgId)
  if (!org) return null
  if (kind === 'person') {
    if (org.ownerId === id) return { can: () => true }
    const me = await store.memberOf(orgId, id)
    if (!me) return null
    const role = me.roleId ? await store.roleById(orgId, me.roleId) : null
    const grants = normalizeGrants(role?.grants)
    return { can: (resource, op) => can(grants, resource, op) }
  }
  // Agents in an org get team access, never a role (orgs spec), so no workspace permission from the org.
  return (await store.memberByAgent(orgId, id)) ? { can: () => false } : null
}
```

`store.orgById(id)` exists in both stores (`memory-store.js:383`, `supabase-store.js:264`). `store.memberByAgent(orgId, agentId)` exists in the memory store (`:486`); check the Supabase store has it too (`grep -n memberByAgent src/api/supabase-store.js`) and add `async memberByAgent (orgId, agentId) { return rowFrom(await one(db.from('org_members').select(MEMBER).eq('org_id', orgId).eq('agent_id', agentId).maybeSingle())) }` if not. Import `can` and `normalizeGrants` from `./permissions.js` at the top of `org-access.js` (already imported there).

- [ ] **Step 4: Run the tests**

Run: `node --test test/api-access-workspace.test.js test/api-room-passes.test.js test/api-grants.test.js test/access.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/access.js src/api/org-access.js src/api/memory-store.js src/api/supabase-store.js test/api-access-workspace.test.js
git commit -m "Workspaces: sessions in a workspace admit its members"
```

---

### Task 5: API routes behind the flag

**Files:**
- Create: `src/api/routes/workspaces.js`
- Modify: `src/api/server.js` (option `workspaces = false`, read `process.env.QUILT_WORKSPACES` where the CLI builds options in `bin/quilt.js` / wherever `startApi` is called for production; ctx gains `workspaces`; mount routes)
- Test: `test/api-workspaces.test.js`

**Interfaces (all JSON; caller is a person via `person(req)` or an agent via `agentAuth`):**

| Method and path | Body | Answer |
|---|---|---|
| `GET /v1/me/workspaces` | | `{ workspaces: [{ id, name, description, color, space: { kind: 'personal' } \| { kind: 'org', slug, name }, access, admin, via, counts: { sessions, members, open }, createdAt, archivedAt }] }` sorted by name; `open` is sessions active in the last 10 minutes |
| `POST /v1/workspaces` | `{ name, description?, color?, org? }` | `{ workspace }` (personal unless `org` slug; org needs `workspaces: c`) |
| `GET /v1/workspaces/:id` | | `{ workspace, access: { access, admin, via }, members: [{ account, name, kind, access, addedAt }], sessions: [{ room, name, ownerAccount, lastActiveAt, open }], owner: { account, name } }` |
| `PATCH /v1/workspaces/:id` | `{ name?, description?, color?, archived? }` | `{ workspace }` (admin) |
| `DELETE /v1/workspaces/:id` | | `{ ok: true }` (personal: owner; org: `workspaces: d`) |
| `PUT /v1/workspaces/:id/members/:account` | `{ access }` | `{ member }` (admin; account must exist: a profile or an agent; for org workspaces the person must be an org member) |
| `DELETE /v1/workspaces/:id/members/:account` | | `{ ok: true }` (admin; 404 when not a member) |
| `POST /v1/workspaces/:id/sessions` | `{ room }` | `{ session }` (caller has edit in the workspace and is the room's owner, or the room is unknown to the API yet, in which case the caller becomes its recorded owner) |
| `DELETE /v1/workspaces/:id/sessions/:room` | | `{ ok: true }` (room owner or admin; the session becomes loose) |

Flag off: every route above answers `404 { error: 'not found' }` (the generic no-route answer).

- [ ] **Step 1: Write the failing test**

```js
// test/api-workspaces.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from './api-helpers.js'

let t
before(async () => { t = await startTestApi({ workspaces: true }) })
after(() => t.close())

test('flag off: the routes do not exist', async () => {
  const off = await startTestApi()
  try {
    assert.equal((await off.call('GET', '/v1/me/workspaces', null, 'mem')).status, 404)
    assert.equal((await off.call('POST', '/v1/workspaces', { name: 'x' }, 'mem')).status, 404)
  } finally { off.close() }
})

test('a person makes a personal workspace, sees it, edits it, deletes it', async () => {
  const made = await t.call('POST', '/v1/workspaces', { name: '  Launch ', description: 'Teaser video', color: 'lilac' }, 'mem')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const w = made.body.workspace
  assert.deepEqual([w.name, w.description, w.color, w.ownerUserId, w.orgId], ['Launch', 'Teaser video', 'lilac', 'mem', null])
  const list = await t.call('GET', '/v1/me/workspaces', null, 'mem')
  const mine = list.body.workspaces.find((x) => x.id === w.id)
  assert.deepEqual([mine.space, mine.access, mine.admin, mine.via, mine.counts], [{ kind: 'personal' }, 'edit', true, 'owner', { sessions: 0, members: 0, open: 0 }])
  assert.equal((await t.call('GET', '/v1/me/workspaces', null, 'out')).body.workspaces.some((x) => x.id === w.id), false)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'out')).status, 404, 'outsiders get the same as a missing workspace')
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')
  assert.deepEqual([got.body.access, got.body.owner], [{ access: 'edit', admin: true, via: 'owner' }, { account: 'person:mem', name: 'Mo' }])
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}`, { name: 'Launch 2', color: 'red' }, 'mem')).status, 400)
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}`, { name: 'Launch 2', archived: true }, 'mem')).body.workspace.name, 'Launch 2')
  assert.ok((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.workspace.archivedAt)
  assert.equal((await t.call('POST', '/v1/workspaces', { name: '' }, 'mem')).status, 400)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, 'out')).status, 404)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, 'mem')).status, 200)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).status, 404)
})

test('members: the owner adds people and agents with edit or view, changes and removes them; members see the workspace', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Team' }, 'mem')).body.workspace
  const { agent } = await makeAgent(t, { name: 'Larry', ownerUserId: 'mem' })
  const put = (who, account, access) => t.call('PUT', `/v1/workspaces/${w.id}/members/${account}`, { access }, who)
  assert.equal((await put('out', 'person:lim', 'edit')).status, 404)
  assert.equal((await put('mem', 'person:nobody', 'edit')).status, 404, 'no such account')
  assert.equal((await put('mem', 'person:lim', 'owner')).status, 400)
  assert.deepEqual((await put('mem', 'person:lim', 'view')).body.member.access, 'view')
  assert.deepEqual((await put('mem', `agent:${agent.id}`, 'edit')).body.member.access, 'edit')
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')
  assert.equal(got.status, 200)
  assert.deepEqual(got.body.access, { access: 'view', admin: false, via: 'member' })
  assert.deepEqual(got.body.members.map((m) => [m.account, m.name, m.kind, m.access]), [['person:lim', 'Lin', 'person', 'view'], [`agent:${agent.id}`, 'Larry', 'agent', 'edit']])
  assert.equal((await put('lim', 'person:out', 'edit')).status, 403, 'members do not manage')
  assert.equal((await put('mem', 'person:lim', 'edit')).body.member.access, 'edit')
  assert.equal((await t.call('GET', '/v1/me/workspaces', null, 'lim')).body.workspaces.find((x) => x.id === w.id).access, 'edit')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/members/person:lim`, null, 'mem')).status, 200)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/members/person:lim`, null, 'mem')).status, 404)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')).status, 404)
})

test('org workspaces: Workspaces: Create makes, Update manages, Read sees; the org owns it', async () => {
  const o = await makeOrg(t, 'Ws Co')
  assert.equal((await t.call('POST', '/v1/workspaces', { name: 'Core', org: o.slug }, 'mem')).status, 403, 'Member has only Read')
  assert.equal((await t.call('POST', '/v1/workspaces', { name: 'Core', org: o.slug }, 'out')).status, 404, 'not in the org')
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Core', org: o.slug }, 'admin')).body.workspace
  assert.deepEqual([w.orgId, w.ownerUserId], [o.org.id, null])
  const seen = (await t.call('GET', '/v1/me/workspaces', null, 'mem')).body.workspaces.find((x) => x.id === w.id)
  assert.deepEqual([seen.space, seen.access, seen.admin, seen.via], [{ kind: 'org', slug: o.slug, name: 'Ws Co' }, 'view', false, 'org'])
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}`, { name: 'Core 2' }, 'mem')).status, 403)
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}`, { name: 'Core 2' }, 'admin')).status, 200)
  assert.equal((await t.call('PUT', `/v1/workspaces/${w.id}/members/person:out`, { access: 'edit' }, 'admin')).status, 404, 'people must be in the org')
  assert.equal((await t.call('PUT', `/v1/workspaces/${w.id}/members/person:mem`, { access: 'edit' }, 'admin')).status, 200)
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.access, { access: 'edit', admin: false, via: 'member' })
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, 'mem')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, 'owner')).status, 200)
})

test('sessions: link a room (before the relay reports it), list it, make it loose again', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'S' }, 'mem')).body.workspace
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'view' }, 'mem')
  const linked = await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'room-new1' }, 'mem')
  assert.equal(linked.status, 200, JSON.stringify(linked.body))
  assert.deepEqual([linked.body.session.room, linked.body.session.workspaceId, linked.body.session.ownerAccount], ['room-new1', w.id, 'person:mem'])
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'room-new1' }, 'lim')).status, 403, 'not the owner, and only view')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'bad room!' }, 'mem')).status, 400)
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')
  assert.deepEqual(got.body.sessions.map((s) => s.room), ['room-new1'])
  assert.equal((await t.call('GET', '/v1/me/workspaces', null, 'mem')).body.workspaces.find((x) => x.id === w.id).counts.sessions, 1)
  // The room's pass now lets the viewer in.
  const { roomAccess } = await import('../src/api/access.js')
  assert.equal((await roomAccess(t.store, 'room-new1', 'person:lim')).files, 'view')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/sessions/room-new1`, null, 'lim')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/sessions/room-new1`, null, 'mem')).status, 200)
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.sessions, [])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-workspaces.test.js`
Expected: FAIL (404 on every route; the flag-off test passes).

- [ ] **Step 3: Implement the routes**

```js
// src/api/routes/workspaces.js
// Workspaces: a container owned by a person or an org, holding sessions and members.
// Behind the QUILT_WORKSPACES flag (startApi({ workspaces })): off, none of these routes exist.
import { HttpError, needId, cleanName } from '../http.js'
import { orgAccess, orgGrantsFor } from '../org-access.js'
import { workspaceAccess, cleanColor, cleanDescription, cleanAccess } from '../workspace-access.js'

const ROOM = /^[A-Za-z0-9_-]{1,64}$/
const ACCOUNT = /^(person|agent):[A-Za-z0-9_-]{1,64}$/
const OPEN_MS = 10 * 60 * 1000
const NOT_FOUND = 'no such workspace'

export function workspaceRoutes ({ store, person, now, agentAuth, bearer }) {
  /** The caller as an account string: a person (website or linked computer) or an agent (qa_ key). */
  async function caller (req) {
    if (bearer(req).startsWith('qa_')) { const { agent } = await agentAuth.agentFromRequest(req); return { account: `agent:${agent.id}`, userId: null, agent } }
    const p = await person(req)
    return { account: `person:${p.userId}`, userId: p.userId }
  }

  /** The caller's org access for a workspace's org, or null (a person outside it, or an agent). Never throws. */
  const grantsIn = (ws, me) => (ws.orgId ? orgGrantsFor(store, ws.orgId, me.account) : null)

  /** A workspace the caller may at least see, with their access; 404 otherwise (outsiders can't probe ids). */
  async function reach (req, id) {
    const me = await caller(req)
    const ws = await store.workspaceById(needId(id, 'workspace'))
    const access = ws && await workspaceAccess(store, ws, me.account, { orgGrants: await grantsIn(ws, me) })
    if (!access) throw new HttpError(404, NOT_FOUND)
    return { me, ws, access, needAdmin () { if (!access.admin) throw new HttpError(403, "you don't manage this workspace") } }
  }

  const nameOf = async (account) => {
    const [kind, id] = account.split(':')
    if (kind === 'agent') return (await store.agentById(id))?.name
    return (await store.profile(id))?.name
  }
  const kindOf = (account) => account.split(':')[0]
  const isOpen = (s, t) => t - s.lastActiveAt < OPEN_MS
  const sessionView = (s, t) => ({ room: s.room, name: s.name, ownerAccount: s.ownerAccount, lastActiveAt: s.lastActiveAt, open: isOpen(s, t) })

  async function spaceOf (ws) {
    if (!ws.orgId) return { kind: 'personal' }
    const org = await store.orgById(ws.orgId)
    return { kind: 'org', slug: org?.slug || '', name: org?.name || '' }
  }

  async function listView (ws, access, t) {
    const sessions = await store.listWorkspaceSessions(ws.id)
    const members = await store.listWorkspaceMembers(ws.id)
    return {
      id: ws.id, name: ws.name, description: ws.description, color: ws.color, createdAt: ws.createdAt, archivedAt: ws.archivedAt,
      space: await spaceOf(ws), access: access.access, admin: access.admin, via: access.via,
      counts: { sessions: sessions.length, members: members.length, open: sessions.filter((s) => isOpen(s, t)).length }
    }
  }

  return [
    // Every workspace the caller can reach: their own, their orgs' (per their role), and the ones they're a member of.
    ['GET', /^\/v1\/me\/workspaces$/, async (req) => {
      const me = await caller(req)
      const t = now()
      const seen = new Map()
      const add = async (ws) => {
        if (seen.has(ws.id)) return
        const access = await workspaceAccess(store, ws, me.account, { orgGrants: await grantsIn(ws, me) })
        if (access) seen.set(ws.id, await listView(ws, access, t))
      }
      if (me.userId) {
        for (const ws of await store.listWorkspacesOwnedBy(me.userId)) await add(ws)
        for (const org of await store.orgsForUser(me.userId)) for (const ws of await store.listWorkspacesOfOrg(org.id)) await add(ws)
      }
      for (const ws of await store.listWorkspacesForMember(me.account)) await add(ws)
      return { workspaces: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) }
    }],

    ['POST', /^\/v1\/workspaces$/, async (req, body) => {
      const me = await caller(req)
      if (!me.userId) throw new HttpError(403, 'agents do not make workspaces')
      const name = cleanName(body.name, 80, 'give the workspace a name')
      const fields = { name, description: cleanDescription(body.description), color: cleanColor(body.color), createdBy: me.account }
      if (body.org) {
        const a = await orgAccess(store, me.userId, body.org)
        a.need('workspaces', 'c')
        return { workspace: await store.createWorkspace({ ...fields, orgId: a.org.id }) }
      }
      return { workspace: await store.createWorkspace({ ...fields, ownerUserId: me.userId }) }
    }],

    ['GET', /^\/v1\/workspaces\/([^/]+)$/, async (req, body, [id]) => {
      const { ws, access } = await reach(req, id)
      const t = now()
      const members = await Promise.all((await store.listWorkspaceMembers(ws.id)).map(async (m) => ({ account: m.account, name: (await nameOf(m.account)) || '', kind: kindOf(m.account), access: m.access, addedAt: m.addedAt })))
      const ownerAccount = ws.ownerUserId ? `person:${ws.ownerUserId}` : null
      const owner = ownerAccount ? { account: ownerAccount, name: (await nameOf(ownerAccount)) || '' } : { account: null, name: (await store.orgById(ws.orgId))?.name || '' }
      return { workspace: ws, access, owner, members, sessions: (await store.listWorkspaceSessions(ws.id)).map((s) => sessionView(s, t)) }
    }],

    ['PATCH', /^\/v1\/workspaces\/([^/]+)$/, async (req, body, [id]) => {
      const r = await reach(req, id)
      r.needAdmin()
      const patch = {}
      if (body.name !== undefined) patch.name = cleanName(body.name, 80, 'give the workspace a name')
      if (body.description !== undefined) patch.description = cleanDescription(body.description)
      if (body.color !== undefined) patch.color = cleanColor(body.color)
      if (body.archived !== undefined) patch.archivedAt = body.archived ? now() : null
      return { workspace: await store.updateWorkspace(r.ws.id, patch) }
    }],

    ['DELETE', /^\/v1\/workspaces\/([^/]+)$/, async (req, body, [id]) => {
      const r = await reach(req, id)
      if (r.ws.orgId) { const a = await orgAccess(store, r.me.userId, (await store.orgById(r.ws.orgId)).slug); a.need('workspaces', 'd') } else if (r.access.via !== 'owner') throw new HttpError(403, 'only the owner can delete a workspace')
      await store.deleteWorkspace(r.ws.id)
      return { ok: true }
    }],

    ['PUT', /^\/v1\/workspaces\/([^/]+)\/members\/([^/]+)$/, async (req, body, [id, account]) => {
      const r = await reach(req, id)
      r.needAdmin()
      if (!ACCOUNT.test(account)) throw new HttpError(400, 'that is not an account')
      const access = cleanAccess(body.access)
      const [kind, who] = account.split(':')
      if (kind === 'agent' ? !(await store.agentById(who)) : !(await store.profile(who))) throw new HttpError(404, 'no such account')
      if (r.ws.orgId && kind === 'person' && !(await store.memberOf(r.ws.orgId, who))) throw new HttpError(404, 'that person is not in the org')
      return { member: await store.putWorkspaceMember({ workspaceId: r.ws.id, account, access, addedBy: r.me.account }) }
    }],

    ['DELETE', /^\/v1\/workspaces\/([^/]+)\/members\/([^/]+)$/, async (req, body, [id, account]) => {
      const r = await reach(req, id)
      r.needAdmin()
      if (!(await store.removeWorkspaceMember(r.ws.id, account))) throw new HttpError(404, 'not a member')
      return { ok: true }
    }],

    // Puts a session in the workspace. The app calls this as soon as it has made the room,
    // usually before the relay's first presence report; then the API records the caller as owner.
    ['POST', /^\/v1\/workspaces\/([^/]+)\/sessions$/, async (req, body, [id]) => {
      const r = await reach(req, id)
      if (r.access.access !== 'edit') throw new HttpError(403, 'you can only view this workspace')
      const room = String(body.room || '')
      if (!ROOM.test(room)) throw new HttpError(400, 'room must be a session name')
      const existing = await store.sessionByRoom(room)
      if (existing && existing.ownerAccount && existing.ownerAccount !== r.me.account) throw new HttpError(403, 'only the session owner can move it')
      return { session: await store.setSessionWorkspace(room, r.ws.id, { ownerAccount: existing?.ownerAccount || r.me.account, at: now() }) }
    }],

    ['DELETE', /^\/v1\/workspaces\/([^/]+)\/sessions\/([^/]+)$/, async (req, body, [id, room]) => {
      const r = await reach(req, id)
      const s = await store.sessionByRoom(room)
      if (!s || s.workspaceId !== r.ws.id) throw new HttpError(404, 'that session is not in this workspace')
      if (s.ownerAccount !== r.me.account && !r.access.admin) throw new HttpError(403, 'only the session owner or a workspace admin can do that')
      await store.setSessionWorkspace(room, null, { ownerAccount: s.ownerAccount, at: now() })
      return { ok: true }
    }]
  ]
}
```

In `src/api/server.js`: add `workspaces = false` to `startApi`'s options; import `workspaceRoutes`; after the existing `routes.push(...)` line add `if (workspaces) routes.push(...workspaceRoutes(ctx))`. In `apiCmd` in `bin/quilt.js` (the `startApi({` call at line 146) add `workspaces: process.env.QUILT_WORKSPACES === '1' || process.env.QUILT_WORKSPACES === 'true'`. Document the variable in `docs/hosting.md` next to the other API settings, one line: "`QUILT_WORKSPACES=1` turns on the workspaces routes (off by default)."

- [ ] **Step 4: Run the tests**

Run: `node --test test/api-workspaces.test.js test/api-teams.test.js test/api-sessions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/workspaces.js src/api/server.js bin docs/hosting.md test/api-workspaces.test.js
git commit -m "Workspaces: API routes behind QUILT_WORKSPACES"
```

---

### Task 6: Account helpers and the runner

**Files:**
- Modify: `src/account.js` (after `listCollaborators`)
- Modify: `src/runner.js:100-160` (`runSession` takes `workspace`; config and recent carry it)
- Test: `test/account-workspaces.test.js`; extend `test/runner-busy.test.js` or add a case to `test/sync.test.js`? No: a focused `test/runner-workspace.test.js`.

**Interfaces:**
- `src/account.js`:
  - `listWorkspaces({ token }) -> workspaces[]` (as the API lists them); throws `{ status: 404 }` when the flag is off (callers treat that as "workspaces off").
  - `createWorkspace({ token, name, description, color, org }) -> workspace`
  - `getWorkspace({ token, id }) -> { workspace, access, owner, members, sessions }`
  - `updateWorkspace({ token, id, patch }) -> workspace`
  - `deleteWorkspace({ token, id }) -> void`
  - `putWorkspaceMember({ token, id, account, access }) -> member`
  - `removeWorkspaceMember({ token, id, account }) -> void`
  - `setSessionWorkspace({ token, id, room }) -> session`
  - `unsetSessionWorkspace({ token, id, room }) -> void`
- `src/runner.js`: `runSession({ …, workspace = '' })` writes `workspace` into `.quilt/config.json` and into the `recent.json` entry; `readConfig(dir).workspace` is the saved id.

- [ ] **Step 1: Write the failing tests**

Look at how `test/account.test.js` fakes `fetch` for `listAgents` (a `fetch` stub that records the URL and answers JSON) and copy that pattern:

```js
// test/account-workspaces.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listWorkspaces, createWorkspace, getWorkspace, putWorkspaceMember, setSessionWorkspace } from '../src/account.js'

const fakeFetch = (status, body) => {
  const calls = []
  const f = async (url, init = {}) => { calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization }); return { ok: status < 400, status, json: async () => body } }
  f.calls = calls
  return f
}

test('listWorkspaces reads the list and passes the token', async () => {
  const fetch = fakeFetch(200, { workspaces: [{ id: 'w1', name: 'Launch' }] })
  assert.deepEqual(await listWorkspaces({ token: 'qd_x', api: 'https://api.test', fetch }), [{ id: 'w1', name: 'Launch' }])
  assert.deepEqual(fetch.calls[0], { url: 'https://api.test/v1/me/workspaces', method: 'GET', body: null, auth: 'Bearer qd_x' })
})

test('listWorkspaces: a 404 (flag off) throws with status 404', async () => {
  await assert.rejects(listWorkspaces({ token: 'qd_x', api: 'https://api.test', fetch: fakeFetch(404, { error: 'not found' }) }), (e) => e.status === 404)
})

test('createWorkspace, getWorkspace, putWorkspaceMember, setSessionWorkspace hit the right routes', async () => {
  const fetch = fakeFetch(200, { workspace: { id: 'w1' }, access: {}, members: [], sessions: [], member: { account: 'person:u2' }, session: { room: 'r' } })
  await createWorkspace({ token: 't', api: 'https://api.test', fetch, name: 'Launch', color: 'mint', org: 'acme' })
  await getWorkspace({ token: 't', api: 'https://api.test', fetch, id: 'w1' })
  await putWorkspaceMember({ token: 't', api: 'https://api.test', fetch, id: 'w1', account: 'person:u2', access: 'view' })
  await setSessionWorkspace({ token: 't', api: 'https://api.test', fetch, id: 'w1', room: 'r' })
  assert.deepEqual(fetch.calls.map((c) => [c.method, c.url, c.body]), [
    ['POST', 'https://api.test/v1/workspaces', { name: 'Launch', description: '', color: 'mint', org: 'acme' }],
    ['GET', 'https://api.test/v1/workspaces/w1', null],
    ['PUT', 'https://api.test/v1/workspaces/w1/members/person%3Au2', { access: 'view' }],
    ['POST', 'https://api.test/v1/workspaces/w1/sessions', { room: 'r' }]
  ])
})
```

```js
// test/runner-workspace.test.js
// runSession remembers which workspace a session was started in, in .quilt/config.json and recent.json.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-runner-ws-'))
process.env.HOME = process.env.USERPROFILE = home
const { startServer } = await import('../src/server.js')
const { runSession, newConn, readConfig, recentSessions } = await import('../src/runner.js')

let relay
before(async () => { relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {} }) })
after(() => relay.close())

test('the workspace id is saved with the session and on the recent list', async () => {
  const dir = path.join(home, 'proj')
  const conn = { ...newConn(), server: `ws://127.0.0.1:${relay.port}` }
  const run = await runSession({ dir, conn, name: 'Mo', tool: 'Other', workspace: 'ws-123', onLog: () => {} })
  try {
    assert.equal(readConfig(dir).workspace, 'ws-123')
    assert.equal(recentSessions().find((r) => r.dir === dir)?.workspace, 'ws-123')
  } finally { await run.stop() }
})
```

Check how other relay-backed runner tests start a relay (`test/runner-busy.test.js`) and whether `startServer` needs a relay key or pass key in tests; copy their options.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/account-workspaces.test.js test/runner-workspace.test.js`
Expected: FAIL (`listWorkspaces` not exported; `workspace` undefined in config).

- [ ] **Step 3: Implement**

`src/account.js`, after `listCollaborators` (reuse the module's `call(fetchImpl, api, method, path, body, token)` and `BAD_REPLY`):

```js
// Workspaces (see docs/superpowers/specs/2026-10-03-workspaces-design.md). Each throws with
// .status when the API says no: 404 when the workspaces flag is off on the API.
const ws$ = (id) => `/v1/workspaces/${encodeURIComponent(id)}`

export async function listWorkspaces ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', '/v1/me/workspaces', null, token)
  if (!Array.isArray(r.workspaces)) throw new Error(BAD_REPLY)
  return r.workspaces
}
export async function createWorkspace ({ token, name, description = '', color = '', org, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', '/v1/workspaces', { name, description, color, ...(org ? { org } : {}) }, token)
  if (!r.workspace) throw new Error(BAD_REPLY)
  return r.workspace
}
export async function getWorkspace ({ token, id, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'GET', ws$(id), null, token)
  if (!r.workspace) throw new Error(BAD_REPLY)
  return r
}
export async function updateWorkspace ({ token, id, patch, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'PATCH', ws$(id), patch, token)
  if (!r.workspace) throw new Error(BAD_REPLY)
  return r.workspace
}
export async function deleteWorkspace ({ token, id, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  await call(fetchImpl, api, 'DELETE', ws$(id), null, token)
}
export async function putWorkspaceMember ({ token, id, account, access, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'PUT', `${ws$(id)}/members/${encodeURIComponent(account)}`, { access }, token)
  if (!r.member) throw new Error(BAD_REPLY)
  return r.member
}
export async function removeWorkspaceMember ({ token, id, account, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  await call(fetchImpl, api, 'DELETE', `${ws$(id)}/members/${encodeURIComponent(account)}`, null, token)
}
export async function setSessionWorkspace ({ token, id, room, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  const r = await call(fetchImpl, api, 'POST', `${ws$(id)}/sessions`, { room }, token)
  if (!r.session) throw new Error(BAD_REPLY)
  return r.session
}
export async function unsetSessionWorkspace ({ token, id, room, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  await call(fetchImpl, api, 'DELETE', `${ws$(id)}/sessions/${encodeURIComponent(room)}`, null, token)
}
```

`call(fetchImpl, api, method, route, body, token)` in `src/account.js` sends any method, attaches a JSON body when given, throws with `.status` on a non-2xx, and throws `BAD_REPLY` on a 2xx whose body is not an object. Every route above answers an object (`{ ok: true }` on deletes), so nothing more is needed.

`src/runner.js`: add `workspace = ''` to `runSession`'s parameters. In the `writePrivateJson(configFile, { ...conn, name, tool, kind, inviteServer: …, shareAgent, summarize })` call add `workspace: workspace || previous?.workspace || undefined` (a rejoin without the id keeps the saved one). In `remember({ dir, room: conn.room, server: conn.server, name: session.name, tool, kind })` add `workspace: workspace || previous?.workspace || ''`. `previous` is already `readConfig(dir)` above.

- [ ] **Step 4: Run the tests**

Run: `node --test test/account-workspaces.test.js test/runner-workspace.test.js test/account.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/account.js src/runner.js test/account-workspaces.test.js test/runner-workspace.test.js
git commit -m "Workspaces: account API helpers; sessions remember their workspace"
```

---

### Task 7: The app's local API (`src/ui-server.js`)

**Files:**
- Modify: `src/ui-server.js` (`api` map near line 506; `start()` at 252; `summary()` at 241; `STATIC` at 89; `GET /api/state`)
- Test: `test/ui-workspaces.test.js`

**Interfaces (local routes, token-protected like the rest):**
- `GET /api/workspaces` → `{ on: boolean, workspaces: [...] }`. `on` is false when the accounts API answers 404 (flag off) or is unreachable (then `workspaces: []` and the app shows today's home).
- `POST /api/workspaces` `{ name, description, color, org }` → `{ workspace }`
- `GET /api/workspaces/:id` → the API's `{ workspace, access, owner, members, sessions }` plus `running: [summary ids of running sessions whose config.workspace === id]` and `recent: [recent entries with workspace === id and not running]`
- `POST /api/workspaces/:id/update` `{ name?, description?, color?, archived? }` → `{ workspace }`
- `POST /api/workspaces/:id/delete` → `{ ok: true }`
- `POST /api/workspaces/:id/members` `{ account, access }` → `{ member }`
- `POST /api/workspaces/:id/members/remove` `{ account }` → `{ ok: true }`
- `POST /api/workspaces/:id/sessions/move` `{ dir }` → `{ ok: true }` (moves a loose session folder's room in; updates its `.quilt/config.json` and recent entry)
- `POST /api/sessions` body gains `workspace` (an id or ''): after `runSession` returns, the app calls `setSessionWorkspace` on the accounts API for `mode === 'create'` (and for `mode === 'github'`); a failure is logged into the session log and does not stop the session.
- `summary(id)` gains `workspace: readConfig(dir)?.workspace || ''`.
- `GET /api/state` gains `workspacesOn` (cached result of the last `GET /api/workspaces` probe, default false).
- `STATIC['/workspaces.js'] = ['workspaces.js', 'text/javascript; charset=utf-8']`.

- [ ] **Step 1: Write the failing test**

Model on `test/ui-access.test.js` (a signed-in app against a test accounts API and relay). Start the accounts API with `workspaces: true`.

```js
// test/ui-workspaces.test.js
// The app's local workspace routes: list, create, members, a session started inside a
// workspace is linked on the accounts API and remembered on this computer.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-ws-'))
process.env.HOME = process.env.USERPROFILE = home

const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { startTestApi, linkDevice } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')
const { loadIdentity } = await import('../src/identity.js')
const { saveAccount } = await import('../src/account.js')

let ui, accounts, relay
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey, workspaces: true })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  const { token } = await linkDevice(accounts, 'mem', loadIdentity())
  saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() })
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const api = (method, p, body) => fetch(`http://127.0.0.1:${ui.port}${p}`, {
  method, headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))

test('list, create, members', async () => {
  const first = await api('GET', '/api/workspaces')
  assert.deepEqual(first.body, { on: true, workspaces: [] })
  const made = await api('POST', '/api/workspaces', { name: 'Launch', color: 'lilac' })
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const id = made.body.workspace.id
  assert.equal((await api('GET', '/api/workspaces')).body.workspaces[0].name, 'Launch')
  assert.equal((await api('POST', `/api/workspaces/${id}/members`, { account: 'person:lim', access: 'view' })).body.member.access, 'view')
  const got = await api('GET', `/api/workspaces/${id}`)
  assert.deepEqual(got.body.members.map((m) => [m.account, m.access]), [['person:lim', 'view']])
  assert.deepEqual([got.body.running, got.body.recent], [[], []])
  assert.equal((await api('POST', `/api/workspaces/${id}/members/remove`, { account: 'person:lim' })).status, 200)
  assert.equal((await api('GET', '/api/state')).body.workspacesOn, true)
})

test('a session started inside a workspace is linked on the API and shows under the workspace', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Site' })).body.workspace.id
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'site'), workspace: id })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.workspace, id)
  const room = s.body.status.room
  const linked = await accounts.store.sessionByRoom(room)
  assert.equal(linked.workspaceId, id)
  const got = await api('GET', `/api/workspaces/${id}`)
  assert.deepEqual(got.body.running, [s.body.id])
  assert.deepEqual(got.body.sessions.map((x) => x.room), [room])
  await api('POST', `/api/sessions/${s.body.id}/stop`)
  assert.deepEqual((await api('GET', `/api/workspaces/${id}`)).body.recent.map((r) => r.dir), [path.join(home, 'site')])
})

test('with the flag off on the API, the app says workspaces are off', async () => {
  const off = await startTestApi({ passKey: newPassKeys().privateKey })
  const was = process.env.QUILT_API_URL
  process.env.QUILT_API_URL = off.api.url
  try {
    const { token } = await linkDevice(off, 'mem', loadIdentity())
    saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() })
    const ui2 = await startUi({ port: 0 })
    try {
      const r = await fetch(`http://127.0.0.1:${ui2.port}/api/workspaces`, { headers: { 'x-quilt-token': ui2.token } }).then((x) => x.json())
      assert.deepEqual(r, { on: false, workspaces: [] })
    } finally { await ui2.close() }
  } finally { process.env.QUILT_API_URL = was; off.close() }
})
```

`session.status()` already carries `room` (`src/session.js:2389`), so `s.body.status.room` in the test above is right.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/ui-workspaces.test.js`
Expected: FAIL (404 on `/api/workspaces`).

- [ ] **Step 3: Implement**

In `src/ui-server.js`:

1. Import the helpers from `./account.js`: `listWorkspaces, createWorkspace, getWorkspace, updateWorkspace, deleteWorkspace, putWorkspaceMember, removeWorkspaceMember, setSessionWorkspace`.
2. Add `let workspacesOn = false` next to the other module state, and a probe:

```js
  // Workspaces live on the accounts API behind a flag: a 404 means off, and the app shows today's home.
  const workspaceList = () => asAccount(async (token) => {
    try {
      const workspaces = await listWorkspaces({ token })
      workspacesOn = true
      return { on: true, workspaces }
    } catch (err) {
      if (err.status === 404) { workspacesOn = false; return { on: false, workspaces: [] } }
      throw err
    }
  })
  const needWorkspaceId = (id) => { if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw httpError(400, 'Which workspace?'); return id }
  const ofWorkspace = (id) => ({
    running: [...runs.keys()].filter((k) => (readConfig(runs.get(k).run.dir) || {}).workspace === id),
    recent: recentList().filter((r) => r.workspace === id)
  })
```

3. Routes, added to the `api` map:

```js
    'GET /api/workspaces': () => workspaceList(),
    'POST /api/workspaces': (b) => asAccount(async (token) => ({ workspace: await createWorkspace({ token, name: String(b.name || ''), description: String(b.description || ''), color: String(b.color || ''), org: b.org ? String(b.org) : undefined }) })),
    'GET /api/workspaces/:id': (b, id) => asAccount(async (token) => ({ ...(await getWorkspace({ token, id: needWorkspaceId(id) })), ...ofWorkspace(id) })),
    'POST /api/workspaces/:id/update': (b, id) => asAccount(async (token) => ({ workspace: await updateWorkspace({ token, id: needWorkspaceId(id), patch: { name: b.name, description: b.description, color: b.color, archived: b.archived } }) })),
    'POST /api/workspaces/:id/delete': (b, id) => asAccount(async (token) => { await deleteWorkspace({ token, id: needWorkspaceId(id) }); return { ok: true } }),
    'POST /api/workspaces/:id/members': (b, id) => asAccount(async (token) => ({ member: await putWorkspaceMember({ token, id: needWorkspaceId(id), account: String(b.account || ''), access: String(b.access || '') }) })),
    'POST /api/workspaces/:id/members/remove': (b, id) => asAccount(async (token) => { await removeWorkspaceMember({ token, id: needWorkspaceId(id), account: String(b.account || '') }); return { ok: true } }),
    'POST /api/workspaces/:id/sessions/move': (b, id) => asAccount(async (token) => {
      const dir = path.resolve(expandHome(String(b.dir || '')))
      const saved = readConfig(dir)
      if (!saved) throw httpError(404, 'No session in that folder.')
      await setSessionWorkspace({ token, id: needWorkspaceId(id), room: saved.room })
      writePrivateJson(path.join(dir, '.quilt', 'config.json'), { ...saved, workspace: id })
      rememberWorkspace(dir, id)
      return { ok: true }
    }),
```

Check how the `api` map dispatches `:id` routes with extra segments (`/api/sessions/:id/members/remove` already works, so `/api/workspaces/:id/members/remove` will match the same way). `writePrivateJson` is in `src/private-file.js`; import it. `rememberWorkspace(dir, id)` is a new export of `src/runner.js`:

```js
/** Records which workspace a remembered folder's session is in. */
export function rememberWorkspace (dir, workspace) {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile(), 'utf8')).map((r) => (r.dir === dir ? { ...r, workspace } : r))
    fs.writeFileSync(recentFile(), JSON.stringify(list, null, 2))
  } catch {}
}
```

4. `start()`: add `workspace` to its parameters (`async function start ({ mode, dir, tool, invite, prefer, repo, branch, newBranch, base, workspace })`), pass `workspace: workspace || ''` into `runSession(...)`, and after `runs.set(id, entry)` link the room when it is a new one:

```js
    if (workspace && (mode === 'create' || mode === 'github')) {
      // Put the new room in its workspace before anyone else connects. A failure is logged, never fatal.
      asAccount((token) => setSessionWorkspace({ token, id: workspace, room: conn.room })).catch((err) => log(`could not add this session to its workspace: ${err.message}`))
    }
```
Note `mode` was reassigned to `'create'` for github clones above, so `mode === 'create'` covers both. Await it in tests? The test polls `accounts.store.sessionByRoom` right after; to keep it deterministic, `await` the call (it is one HTTP request to the accounts API and the session has already started).

5. `summary(id)`: add `workspace: (readConfig(r.run.dir) || {}).workspace || ''`.
6. `GET /api/state`: add `workspacesOn`.
7. `STATIC`: add `'/workspaces.js': ['workspaces.js', 'text/javascript; charset=utf-8']`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/ui-workspaces.test.js test/ui.test.js test/ui-static-allowlist.test.js`
Expected: `ui-workspaces` and `ui` PASS; the allowlist test fails until `src/ui/workspaces.js` exists (Task 8). If it fails only with "`workspaces.js` is listed but missing", that is expected here.

- [ ] **Step 5: Commit**

```bash
git add src/ui-server.js src/runner.js test/ui-workspaces.test.js
git commit -m "Workspaces: the app's local routes, and sessions start inside a workspace"
```

---

### Task 8: The grid, the add card and the workspace page (`src/ui/workspaces.js`)

**Files:**
- Create: `src/ui/workspaces.js`
- Modify: `src/ui/common.js:58-78` (state)
- Modify: `src/ui/app.js` (boot loads workspaces; `isWorkspace(view)`; `go()`; events)
- Modify: `src/ui/home.js` (`homeHtml` shows the grid when on; `newSessionDialog(workspace)`; export it; sidebar unchanged)
- Modify: `src/ui/app.css` (append the `.ws-*` block)
- Test: `test/ui-workspaces-screens.test.js`

**Interfaces:**
- `state.workspaces = null | []` (null until loaded), `state.workspacesOn = false`, `state.workspace = null` (the open workspace's `{ workspace, access, owner, members, sessions, running, recent }`), `state.spaceFilter = 'all' | 'personal' | '<org slug>'`.
- `src/ui/workspaces.js` exports:
  - `loadWorkspaces() -> Promise<void>`: `GET /api/workspaces`, sets `state.workspacesOn`, `state.workspaces`.
  - `workspacesHtml() -> string`: the grid (cards + add card) and the loose-sessions strip; used by `homeHtml` when `state.workspacesOn`.
  - `bindWorkspaces(root)`: card click → `go('ws:<id>')`; add card → inline form; filter switch.
  - `workspacePageHtml() -> string`, `bindWorkspacePage(root)`: back link, header, Sessions cards (running first, then recent, dashed New session), People & agents cards (access dropdown, Remove, dashed Add card), the settings gear (rename, description, colour, archive, delete).
  - `openWorkspace(id) -> Promise<void>`: `GET /api/workspaces/:id` into `state.workspace`.
- `src/ui/home.js` exports `newSessionDialog(workspace = '')` (today it is module-private); with a workspace it adds `workspace` to the start body and says "New session in <name>".
- `src/ui/app.js`: `const isWorkspace = (v) => typeof v === 'string' && v.startsWith('ws:')`; `render()` calls `renderShell(state.view)` for workspace views too; `renderShell` in home.js renders `workspacePageHtml()` when `view.startsWith('ws:')`.

- [ ] **Step 1: Write the failing screen test**

Like `test/ui-access-screens.test.js`, these check the served code (no browser):

```js
// test/ui-workspaces-screens.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ui = (f) => fs.readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')
const EM_DASH = String.fromCharCode(0x2014)

test('home shows the workspace grid when the API has workspaces on, and today\'s list otherwise', () => {
  const h = ui('home.js')
  assert.ok(h.includes("from './workspaces.js'"))
  assert.ok(h.includes('state.workspacesOn ? workspacesHtml()'), 'the grid replaces the session list only when on')
  assert.ok(h.includes('Sessions not in a workspace'))
})

test('the grid: a card per workspace with cover, name, space pill, counts, avatars, and an Add workspace card that becomes the form', () => {
  const w = ui('workspaces.js')
  for (const bit of ['class="ws-card"', 'data-open-ws=', 'class="ws-cover', 'ws-space', 'sessions</span>', 'files', 'class="ws-card add"', 'Add workspace', 'data-add-ws', 'name="name"', 'name="org"', 'name="color"', 'name="description"', 'Create', "api('POST', '/api/workspaces'"]) assert.ok(w.includes(bit), bit)
  assert.ok(w.includes('data-space-filter'), 'a Personal / org switch')
  assert.ok(w.includes('open</span>') || w.includes('open<'), 'an N open pill')
})

test('the workspace page: back link, header, session cards with New session, people cards with access and Add, settings', () => {
  const w = ui('workspaces.js')
  for (const bit of ['All workspaces', 'data-ws-back', 'class="ws-head"', 'class="sc-grid"', 'data-rejoin=', 'data-go=', 'data-new-session-in=', 'New session', 'People &amp; agents', 'class="pc"', 'data-member-access=', 'data-member-remove=', 'Add a person or an agent', 'data-ws-settings', 'Delete workspace', "'/update'", "'/delete'", "'/members/remove'"]) assert.ok(w.includes(bit), bit)
})

test('starting a session from a workspace passes the workspace id', () => {
  const h = ui('home.js')
  assert.ok(h.includes('export function newSessionDialog (workspace = \'\')'))
  assert.ok(h.includes("{ mode: 'create', dir, workspace }"))
  assert.ok(h.includes("{ mode: 'github', ...body, workspace }"))
})

test('app routes ws: views through the shell and loads workspaces at boot', () => {
  const a = ui('app.js')
  for (const bit of ["startsWith('ws:')", 'loadWorkspaces()', 'openWorkspace(']) assert.ok(a.includes(bit), bit)
  assert.ok(ui('common.js').includes('workspacesOn: false'))
})

test('no em dashes', () => { for (const f of ['workspaces.js', 'home.js', 'app.js', 'app.css']) assert.ok(!ui(f).includes(EM_DASH), f) })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/ui-workspaces-screens.test.js`
Expected: FAIL (`workspaces.js` missing).

- [ ] **Step 3: Implement**

`src/ui/common.js`: add to `state`: `workspaces: null, // [] once /api/workspaces answered; null before`, `workspacesOn: false, // the accounts API has workspaces on`, `workspace: null, // the open workspace page's data`, `spaceFilter: 'all'`.

`src/ui/workspaces.js` (complete file):

```js
// Workspaces: the home grid of cards, the Add workspace card, and a workspace's page
// (Sessions, People & agents, Settings). Files come in phase 2. Sessions stay in session.js.
import { I, state, $, esc, basename, toast, api, ask, avatar, colorFor, ago } from './common.js'

export const COLORS = { lilac: '#d9c6ea', mint: '#cfe6d4', peach: '#f6dcc0', rose: '#f3d3d0', periwinkle: '#e0dcf0', sky: '#cfe0ee' }
const coverOf = (w) => COLORS[w.color] || COLORS.lilac
const initial = (name) => [...String(name || '?')][0].toUpperCase()
const spaceLabel = (w) => (w.space?.kind === 'org' ? w.space.name : 'Personal')
const spaceKey = (w) => (w.space?.kind === 'org' ? w.space.slug : 'personal')
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const tildify = (p) => (state.defaults.home && String(p).startsWith(state.defaults.home) ? `~${String(p).slice(state.defaults.home.length)}` : p)

export async function loadWorkspaces () {
  try {
    const r = await api('GET', '/api/workspaces')
    state.workspacesOn = !!r.on
    state.workspaces = r.workspaces || []
  } catch (err) {
    if (err.signedOut) throw err
    state.workspacesOn = false
    state.workspaces = []
  }
}

export async function openWorkspace (id) {
  state.workspace = await api('GET', `/api/workspaces/${encodeURIComponent(id)}`)
}

// ------------------------------------------------------------------ grid --
function spaces () {
  const keys = new Map([['all', 'All'], ['personal', 'Personal']])
  for (const w of state.workspaces || []) if (w.space?.kind === 'org') keys.set(w.space.slug, w.space.name)
  return keys
}

function cardHtml (w) {
  const live = w.counts?.open || 0
  return `
  <div class="ws-card" data-open-ws="${esc(w.id)}" role="button" tabindex="0" aria-label="Open ${esc(w.name)}">
    <div class="ws-cover" style="--c:${coverOf(w)}"><span class="ws-mark">${esc(initial(w.name))}</span>${live ? `<span class="pill ok ws-live"><span class="dot"></span>${esc(plural(live, 'open', 'open'))}</span>` : ''}</div>
    <div class="ws-body">
      <h3>${esc(w.name)} <span class="pill ws-space${w.space?.kind === 'org' ? ' coral' : ''}">${esc(spaceLabel(w))}</span></h3>
      <p class="ws-desc">${esc(w.description || '')}</p>
      <div class="ws-stats"><span><b>${w.counts?.sessions ?? 0}</b> sessions</span><span><b>0</b> files</span></div>
    </div>
    <div class="ws-foot"><span>${esc(plural(w.counts?.members ?? 0, 'member', 'members'))}</span><span class="spacer"></span><span>${w.archivedAt ? 'archived' : esc(ago(w.createdAt))}</span></div>
  </div>`
}

function addCardHtml () {
  return `
  <div class="ws-card add" data-add-ws role="button" tabindex="0">
    <span class="ws-plus">${I.plus}</span><b>Add workspace</b><span>Sessions, files and agents in one place</span>
  </div>`
}

function addFormHtml () {
  const orgs = [...spaces()].filter(([k]) => k !== 'all' && k !== 'personal')
  return `
  <form class="ws-card form" data-add-ws-form>
    <div class="ws-cover" style="--c:${COLORS.lilac};height:36px"></div>
    <div class="ws-body">
      <label class="label" for="ws-name">Name</label><input class="input" id="ws-name" name="name" maxlength="80" required placeholder="Launch">
      <label class="label" for="ws-org">Where</label>
      <select class="input" id="ws-org" name="org"><option value="">Personal</option>${orgs.map(([slug, name]) => `<option value="${esc(slug)}">${esc(name)}</option>`).join('')}</select>
      <span class="label">Colour</span>
      <div class="swatches">${Object.entries(COLORS).map(([k, c], i) => `<label class="swatch"><input type="radio" name="color" value="${k}" ${i === 0 ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>
      <label class="label" for="ws-desc">About (optional)</label><input class="input" id="ws-desc" name="description" maxlength="500" placeholder="What this workspace is for">
      <p class="error" data-add-ws-error></p>
      <div class="actions"><button type="button" class="btn sm ghost" data-add-ws-cancel>Cancel</button><button class="btn sm primary" type="submit">Create</button></div>
    </div>
  </form>`
}

function looseRows () {
  const running = [...state.sessions.values()].filter((s) => !s.workspace).map((s) => ({ live: true, id: s.id, dir: s.dir, peers: s.status.peers.length }))
  const recent = state.recent.filter((r) => !r.workspace && !r.unsupported).map((r) => ({ live: false, dir: r.dir, lastUsed: r.lastUsed }))
  return [...running, ...recent]
}

export function workspacesHtml () {
  const filter = state.spaceFilter || 'all'
  const list = (state.workspaces || []).filter((w) => filter === 'all' || spaceKey(w) === filter)
  const loose = looseRows()
  return `
  <section class="workspaces">
    <div class="sec-head"><h2>Your workspaces</h2><span class="count">${list.length}</span><span class="spacer"></span>
      <div class="segmented ws-filter" role="tablist">${[...spaces()].map(([k, label]) => `<button type="button" role="tab" data-space-filter="${esc(k)}" class="${filter === k ? 'on' : ''}" aria-selected="${filter === k}">${esc(label)}</button>`).join('')}</div>
    </div>
    <div class="ws-grid">${list.map(cardHtml).join('')}${state.addingWorkspace ? addFormHtml() : addCardHtml()}</div>
  </section>
  <section class="ws-loose">
    <div class="sec-head"><h2 class="ws-loose-h">Sessions not in a workspace</h2><span class="count">${loose.length}</span><span class="spacer"></span>
      <button class="btn sm ghost" data-join-session>${I.link}<span>Join with an invite</span></button>
      <button class="btn sm" data-new-session>${I.plus}<span>New session</span></button>
    </div>
    ${loose.length ? `<div class="ws-chips">${loose.map((r) => `
      <div class="ws-chip"><span class="folder-ico${r.live ? ' live' : ''}">${I.folder}</span>
        <span class="t"><b>${esc(basename(r.dir))}</b><span>${r.live ? (r.peers ? `${r.peers} other${r.peers === 1 ? '' : 's'} here` : 'just you') : esc(ago(r.lastUsed))}</span></span>
        ${r.live ? `<button class="btn sm primary" data-go="${esc(r.id)}">Open</button>` : `<button class="btn sm" data-rejoin="${esc(r.dir)}">Rejoin</button>`}
        ${state.workspaces?.length ? `<button class="btn sm ghost" data-move-session="${esc(r.dir)}" title="Move to a workspace">${I.folder}</button>` : ''}
      </div>`).join('')}</div>` : '<p class="hint">Every session is in a workspace.</p>'}
  </section>`
}

export function bindWorkspaces (root, { go, rerender, startSession }) {
  root.querySelectorAll('[data-open-ws]').forEach((el) => {
    const open = () => go(`ws:${el.dataset.openWs}`)
    el.onclick = open
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
  })
  root.querySelectorAll('[data-space-filter]').forEach((b) => { b.onclick = () => { state.spaceFilter = b.dataset.spaceFilter; rerender() } })
  const add = root.querySelector('[data-add-ws]')
  if (add) {
    const open = () => { state.addingWorkspace = true; rerender(); root.querySelector('#ws-name')?.focus() }
    add.onclick = open
    add.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }
  }
  const form = root.querySelector('[data-add-ws-form]')
  if (form) {
    form.querySelector('[data-add-ws-cancel]').onclick = () => { state.addingWorkspace = false; rerender() }
    form.onsubmit = async (e) => {
      e.preventDefault()
      const f = new FormData(form)
      const body = { name: f.get('name'), description: f.get('description'), color: f.get('color'), org: f.get('org') || undefined }
      form.querySelector('button[type=submit]').disabled = true
      try {
        const { workspace } = await api('POST', '/api/workspaces', body)
        state.addingWorkspace = false
        await loadWorkspaces()
        go(`ws:${workspace.id}`)
      } catch (err) {
        form.querySelector('[data-add-ws-error]').textContent = err.message
        form.querySelector('button[type=submit]').disabled = false
      }
    }
  }
  root.querySelectorAll('[data-move-session]').forEach((b) => {
    b.onclick = async () => {
      const options = (state.workspaces || []).filter((w) => w.access === 'edit')
      if (!options.length) return toast('No workspace you can edit.')
      const choice = await ask({ title: `Move ${basename(b.dataset.moveSession)} to`, input: { select: options.map((w) => ({ value: w.id, label: w.name })) }, ok: 'Move' })
      if (!choice) return
      try { await api('POST', `/api/workspaces/${encodeURIComponent(choice)}/sessions/move`, { dir: b.dataset.moveSession }); await loadWorkspaces(); rerender(); toast('Moved') } catch (err) { toast(err.message) }
    }
  })
}

// ------------------------------------------------------------------ page --
function sessionCardHtml (s, { live, dir, id, peers, lastUsed, mine }) {
  return `
  <div class="sc">
    <div class="top"><span class="folder-ico${live ? ' live' : ''}">${I.folder}</span><b>${esc(s?.name || basename(dir || '') || s?.room || '')}</b>${live ? '<span class="pill ok"><span class="dot"></span></span>' : ''}</div>
    <div class="mono">${esc(dir ? tildify(dir) : (s?.room || ''))}</div>
    <div class="who"><span>${live ? (peers ? `${peers} other${peers === 1 ? '' : 's'} here` : 'Just you') : (dir ? esc(ago(lastUsed)) : (mine ? 'Yours, on another computer' : 'Someone else\'s'))}</span><span class="spacer"></span>
      ${live ? `<button class="btn sm primary" data-go="${esc(id)}">Open</button>` : dir ? `<button class="btn sm" data-rejoin="${esc(dir)}">Rejoin</button>` : ''}</div>
  </div>`
}

function peopleCardHtml (m, { admin, isOwner }) {
  const bot = m.kind === 'agent'
  return `
  <div class="pc">${avatar(m.name || m.account, colorFor(m.name || m.account), false)}
    <div class="t"><b>${esc(m.name || m.account)}</b><span>${bot ? 'agent' : 'person'}${isOwner ? ' · owner' : ''}</span></div>
    ${isOwner ? '<span class="pill">Owner</span>' : admin
      ? `<select class="input sm" data-member-access="${esc(m.account)}" aria-label="Access for ${esc(m.name || m.account)}"><option value="edit" ${m.access === 'edit' ? 'selected' : ''}>Can edit</option><option value="view" ${m.access === 'view' ? 'selected' : ''}>View only</option></select>
         <button class="btn sm ghost icon" data-member-remove="${esc(m.account)}" title="Remove" aria-label="Remove ${esc(m.name || m.account)}">${I.x}</button>`
      : `<span class="pill">${m.access === 'edit' ? 'Can edit' : 'View only'}</span>`}
  </div>`
}

export function workspacePageHtml () {
  const d = state.workspace
  if (!d) return '<p class="hint">Loading…</p>'
  const w = d.workspace
  const admin = d.access.admin
  const running = d.running.map((id) => state.sessions.get(id)).filter(Boolean)
  const runningRooms = new Set(running.map((s) => s.status.room))
  const recent = d.recent
  const recentRooms = new Set(recent.map((r) => r.room))
  const others = d.sessions.filter((s) => !runningRooms.has(s.room) && !recentRooms.has(s.room))
  const me = `person:${state.account?.id}`
  const members = [...(d.owner.account ? [{ account: d.owner.account, name: d.owner.name, kind: 'person', access: 'edit', owner: true }] : []), ...d.members]
  return `
  <a class="ws-back" href="#" data-ws-back>${I.caret} All workspaces</a>
  <header class="ws-head">
    <span class="ws-mark big" style="background:${coverOf(w)}">${esc(initial(w.name))}</span>
    <div><h1>${esc(w.name)} <span class="pill ws-space${w.orgId ? ' coral' : ''}">${esc(w.orgId ? d.owner.name : 'Personal')}</span>${w.archivedAt ? ' <span class="pill">Archived</span>' : ''}</h1><p>${esc(w.description || '')}</p></div>
    <div class="acts">${admin ? `<button class="btn sm" data-invite-ws>${I.link}<span>Invite</span></button><button class="btn sm ghost icon" data-ws-settings title="Workspace settings" aria-label="Workspace settings">${I.gear}</button>` : ''}</div>
  </header>

  <section class="sec">
    <div class="sec-head"><h2>Sessions</h2><span class="count">${running.length + recent.length + others.length}</span></div>
    <div class="sc-grid">
      ${running.map((s) => sessionCardHtml(d.sessions.find((x) => x.room === s.status.room), { live: true, dir: s.dir, id: s.id, peers: s.status.peers.length })).join('')}
      ${recent.map((r) => sessionCardHtml(d.sessions.find((x) => x.room === r.room), { live: false, dir: r.dir, lastUsed: r.lastUsed })).join('')}
      ${others.map((s) => sessionCardHtml(s, { live: false, mine: s.ownerAccount === me })).join('')}
      ${d.access.access === 'edit' ? `<button class="sc add" data-new-session-in="${esc(w.id)}">${I.plus}<span>New session</span></button>` : ''}
    </div>
  </section>

  <section class="sec">
    <div class="sec-head"><h2>People &amp; agents</h2><span class="count">${members.length}</span></div>
    <div class="pc-grid">
      ${members.map((m) => peopleCardHtml(m, { admin, isOwner: !!m.owner })).join('')}
      ${admin ? `<button class="pc add" data-add-member>${I.plus}<span>Add a person or an agent</span></button>` : ''}
    </div>
  </section>`
}

export function bindWorkspacePage (root, { go, rerender, newSessionDialog, inviteDialog }) {
  const d = state.workspace
  if (!d) return
  const id = d.workspace.id
  const reload = async () => { await openWorkspace(id); await loadWorkspaces(); rerender() }
  root.querySelector('[data-ws-back]').onclick = (e) => { e.preventDefault(); go('home') }
  root.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go) })
  root.querySelector('[data-new-session-in]')?.addEventListener('click', () => newSessionDialog(id))
  root.querySelector('[data-invite-ws]')?.addEventListener('click', () => inviteDialog(id))
  root.querySelector('[data-add-member]')?.addEventListener('click', () => inviteDialog(id))
  root.querySelectorAll('[data-member-access]').forEach((sel) => {
    sel.onchange = async () => { try { await api('POST', `/api/workspaces/${encodeURIComponent(id)}/members`, { account: sel.dataset.memberAccess, access: sel.value }); toast('Saved'); await reload() } catch (err) { toast(err.message) } }
  })
  root.querySelectorAll('[data-member-remove]').forEach((b) => {
    b.onclick = async () => {
      if (!await ask({ title: 'Remove from this workspace?', message: 'They lose access to its sessions unless a session owner lets them in directly.', ok: 'Remove', danger: true })) return
      try { await api('POST', `/api/workspaces/${encodeURIComponent(id)}/members/remove`, { account: b.dataset.memberRemove }); await reload() } catch (err) { toast(err.message) }
    }
  })
  root.querySelector('[data-ws-settings]')?.addEventListener('click', () => settingsDialog(reload, go))
}

function settingsDialog (reload, go) {
  const w = state.workspace.workspace
  const back = document.createElement('div')
  back.className = 'modal-back'
  back.innerHTML = `<form class="card modal" role="dialog" aria-modal="true" autocomplete="off">
    <h3>Workspace settings</h3>
    <div class="field"><label for="wss-name">Name</label><input class="input" id="wss-name" name="name" maxlength="80" required value="${esc(w.name)}"></div>
    <div class="field"><label for="wss-desc">About</label><input class="input" id="wss-desc" name="description" maxlength="500" value="${esc(w.description || '')}"></div>
    <div class="field"><span class="label">Colour</span><div class="swatches">${Object.entries(COLORS).map(([k, c]) => `<label class="swatch"><input type="radio" name="color" value="${k}" ${(w.color || 'lilac') === k ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div></div>
    <label class="toggle"><input type="checkbox" name="archived" ${w.archivedAt ? 'checked' : ''}><span class="track"><span class="knob"></span></span><span class="tg-text"><b>Archived</b><span class="hint">Kept, but out of the way.</span></span></label>
    <p class="error" data-error></p>
    <div class="actions"><button type="button" class="btn ghost danger" data-delete>Delete workspace</button><span class="spacer"></span><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn primary" type="submit">Save</button></div>
  </form>`
  document.body.appendChild(back)
  const form = back.querySelector('form')
  const close = () => back.remove()
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
  form.querySelector('[data-cancel]').onclick = close
  form.onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(form)
    try {
      await api('POST', `/api/workspaces/${encodeURIComponent(w.id)}/update`, { name: f.get('name'), description: f.get('description'), color: f.get('color'), archived: f.get('archived') === 'on' })
      close(); await reload()
    } catch (err) { form.querySelector('[data-error]').textContent = err.message }
  }
  form.querySelector('[data-delete]').onclick = async () => {
    const typed = await ask({ title: `Delete ${w.name}?`, message: 'Its sessions stay, outside any workspace. Type the workspace name to confirm.', ok: 'Delete', danger: true, input: { placeholder: w.name } })
    if (typed !== w.name) { if (typed) toast('That is not the name.'); return }
    try { await api('POST', `/api/workspaces/${encodeURIComponent(w.id)}/delete`); close(); await loadWorkspaces(); go('home') } catch (err) { toast(err.message) }
  }
}
```

`ask()` in `src/ui/common.js:110` renders only a text input. Extend it: when `input.select` is an array of `{ value, label }`, render `<select class="input" id="ask-input">` with those options instead of the text input, and resolve with the chosen `value` (the existing `done(field.value)` path already does that once the element is a select). Keep the text input for every other caller. Check that `I.gear`, `I.caret`, `I.x`, `I.plus`, `I.link`, `I.folder` exist in `I` (`src/ui/common.js:20-54`); `avatar(name, color, online)` and `colorFor` are exported.

`src/ui/home.js`:
- Import `{ workspacesHtml, bindWorkspaces, workspacePageHtml, bindWorkspacePage, loadWorkspaces } from './workspaces.js'` and `{ go } from './app.js'` is already imported (check; home.js calls `go`).
- `renderShell(view)`: the main becomes `view === 'settings' ? settingsHtml() : view.startsWith('ws:') ? workspacePageHtml() : homeHtml()`; after `bindSidebar()`, `if (view === 'settings') … else if (view.startsWith('ws:')) { bindWorkspacePage($('#page'), { go, rerender: () => renderShell(view), newSessionDialog, inviteDialog: workspaceInviteDialog }); bindSessionActions($('#page')) } else bindHome()`.
- `homeHtml()`: keep the `page-head`; then `${state.workspacesOn ? workspacesHtml() : (rows.length ? <today's sessions section> : <today's welcome card>)}`. The text in the head: when on, "Your workspaces. Open one, or add a new one."
- `bindHome()`: add `if (state.workspacesOn) bindWorkspaces(page, { go, rerender: () => renderShell('home') })`.
- `newSessionDialog (workspace = '')`: export it; the `<h3>` becomes `New session${workspace ? ` in ${esc(state.workspaces?.find((w) => w.id === workspace)?.name || 'this workspace')}` : ''}`; both submit bodies gain `workspace` exactly as the test strings say: `{ mode: 'create', dir, workspace }` and `{ mode: 'github', ...body, workspace }`.
- `workspaceInviteDialog(id)`: phase 1 keeps it small: a dialog with "People you've worked with" (from `GET /api/collaborators`, each row an Add button posting `{ account, access }` to `/api/workspaces/:id/members`) and an access select (Can edit / View only). Agents the account owns come from `GET /api/agents` as `agent:<id>` rows in the same list. Email invites to a workspace are phase 3.
- `bindSessionActions(root)` already binds `[data-new-session]`, `[data-join-session]`, `[data-rejoin]`; make `[data-new-session]` call `newSessionDialog()` with no workspace, and bind `[data-new-session-in]` in `bindWorkspacePage` (done above).

`src/ui/app.js`:
- `const isWorkspace = (v) => typeof v === 'string' && v.startsWith('ws:')`.
- In `boot()`, after `state.loaded = true`: `await loadWorkspaces()`. Allow `state.view` to be a remembered `ws:` view: `state.view = state.sessions.has(last) || last === 'settings' || isWorkspace(last) ? last : …`; if `isWorkspace(state.view)` then `await openWorkspace(state.view.slice(3)).catch(() => { state.view = 'home' })`.
- `go(view)`: `if (isWorkspace(view)) { await refreshRecent(); await openWorkspace(view.slice(3)).catch((err) => { toast(err.message); view = 'home' }) }`; `if (view === 'home') { await refreshRecent(); if (state.workspacesOn) await loadWorkspaces() }`.
- `render()`: `if (!isSession(state.view)) renderShell(state.view)` already covers `ws:` views.
- Events: in the `session` event handler, after updating the summary, `if (isWorkspace(state.view)) renderShell(state.view)` so a session's status changes the Sessions cards; on a session stop (wherever `state.sessions.delete` happens), if the view is a workspace, `openWorkspace` again and re-render.

`src/ui/app.css`, appended:

```css
/* ---------- workspaces ---------- */
.ws-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.ws-card { display: flex; flex-direction: column; min-height: 230px; overflow: hidden; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); cursor: pointer; text-align: left; }
.ws-card:hover { border-color: var(--border-strong); }
.ws-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ws-cover { position: relative; height: 64px; background: var(--c, var(--panel-2)); }
.ws-cover::after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at 18% 120%, rgba(255, 255, 255, .55), transparent 40%), radial-gradient(circle at 88% -20%, rgba(255, 255, 255, .35), transparent 45%); }
.ws-mark { position: absolute; left: 14px; top: 14px; z-index: 1; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: rgba(255, 255, 255, .85); color: #2b2a38; font-weight: 700; font-size: 15px; }
.ws-mark.big { position: static; width: 44px; height: 44px; border-radius: 11px; font-size: 18px; }
.ws-live { position: absolute; top: 10px; right: 10px; z-index: 1; background: rgba(255, 255, 255, .9); }
.ws-body { flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 18px 16px 12px; }
.ws-body h3 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
.ws-space { height: 18px; font-size: 10.5px; }
.ws-space.coral { color: var(--coral); background: color-mix(in srgb, var(--coral) 12%, var(--panel)); }
.ws-desc { margin: 0; flex: 1; color: var(--muted); font-size: 12.5px; }
.ws-stats { display: flex; gap: 14px; font-size: 12px; color: var(--muted); }
.ws-stats b { color: var(--text); font-weight: 600; }
.ws-foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.ws-card.add { align-items: center; justify-content: center; gap: 8px; border: 1.5px dashed var(--border-strong); box-shadow: none; background: transparent; color: var(--muted); }
.ws-card.add b { color: var(--text); font-weight: 600; }
.ws-card.add span { font-size: 12.5px; }
.ws-card.add:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 4%, transparent); }
.ws-plus { width: 46px; height: 46px; border-radius: 50%; border: 1.5px dashed var(--border-strong); display: grid; place-items: center; color: var(--accent); }
.ws-plus svg { width: 20px; height: 20px; }
.ws-card.form { cursor: default; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), var(--shadow); }
.ws-card.form .ws-body { gap: 4px; padding: 14px 16px; }
.ws-card.form .label { margin-top: 6px; }
.ws-card.form .input { height: 34px; }
.ws-card.form .actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; }
.ws-filter button { height: 30px; padding: 0 12px; font-size: 12.5px; }
.ws-loose { margin-top: 30px; }
.ws-loose-h { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.ws-chips { display: flex; flex-wrap: wrap; gap: 10px; }
.ws-chip { display: flex; align-items: center; gap: 10px; padding: 8px 12px 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); font-size: 13px; }
.ws-chip .folder-ico { width: 28px; height: 28px; }
.ws-chip .t { display: flex; flex-direction: column; line-height: 1.3; }
.ws-chip .t span { color: var(--muted); font-size: 12px; }
.ws-back { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 10px; color: var(--accent); font-weight: 600; font-size: 12.5px; text-decoration: none; }
.ws-back svg { width: 12px; height: 12px; transform: rotate(180deg); }
.ws-head { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
.ws-head h1 { margin: 0; font-size: 24px; letter-spacing: -0.02em; display: flex; align-items: center; gap: 10px; }
.ws-head p { margin: 0; color: var(--muted); }
.ws-head .acts { margin-left: auto; display: flex; gap: 6px; }
.sec { margin-top: 26px; }
.sc-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.pc-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.sc { display: flex; flex-direction: column; gap: 6px; min-height: 120px; padding: 14px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); }
.sc .top { display: flex; align-items: center; gap: 8px; }
.sc .top b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.sc .top .folder-ico { width: 28px; height: 28px; }
.sc .mono { color: var(--muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc .who { display: flex; align-items: center; gap: 6px; margin-top: auto; font-size: 12px; color: var(--muted); }
.sc.add, .pc.add { align-items: center; justify-content: center; gap: 6px; border-style: dashed; box-shadow: none; background: transparent; color: var(--muted); font: inherit; font-weight: 500; cursor: pointer; }
.sc.add svg, .pc.add svg { width: 18px; height: 18px; color: var(--accent); }
.pc { display: flex; align-items: center; gap: 12px; padding: 14px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); }
.pc .avatar { width: 40px; height: 40px; font-size: 15px; }
.pc .t { flex: 1; min-width: 0; line-height: 1.35; }
.pc .t b { display: block; font-weight: 600; }
.pc .t span { display: block; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc .input.sm { height: 28px; width: auto; padding: 0 8px; font-size: 12.5px; }
@media (max-width: 900px) {
  .ws-grid, .pc-grid { grid-template-columns: 1fr 1fr; }
  .sc-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 560px) { .ws-grid, .pc-grid, .sc-grid { grid-template-columns: 1fr; } }
```

No clash: `app.css` has `.sec-head`, `.sec-intro`, `.sec-body` and `.sec-actions` but no bare `.sec`, `.sc` or `.pc`.

- [ ] **Step 4: Run the tests, then the app**

Run: `node --test test/ui-workspaces-screens.test.js test/ui-static-allowlist.test.js test/ui-workspaces.test.js test/ui.test.js test/ui-access-screens.test.js`
Expected: PASS.

Then run the app against a local API with the flag on, and check the screens by eye (AGENTS.md "Verifying a change"):

```bash
QUILT_WORKSPACES=1 node bin/quilt.js api --memory --port 4400 &
QUILT_API_URL=http://127.0.0.1:4400 npm run app
```
(`quilt api [--port] [--memory]` exists; `apiCmd` in `bin/quilt.js:146` builds the `startApi` options, which is where Task 5 added `workspaces`). Confirm: the home grid renders with the Add card; creating a workspace opens its page; New session from the page starts a session that shows as a live card; the breadcrumbless session view still works; signing in with the flag off shows today's home. A blank cream window means a module failed to load: check `STATIC` and the CSP.

- [ ] **Step 5: Commit**

```bash
git add src/ui/workspaces.js src/ui/home.js src/ui/app.js src/ui/common.js src/ui/app.css test/ui-workspaces-screens.test.js
git commit -m "Workspaces: the home grid, Add workspace card and workspace page"
```

---

### Task 9: Website: nav, lists and management

**Files:**
- Modify: `web/lib/nav.js` (PERSONAL_NAV gains `{ href: '/dashboard/workspaces', label: 'Workspaces' }` after Dashboard)
- Modify: `web/lib/org-view.js` (`orgTabs` gains `allowed(me, 'workspaces', 'r') && { href: \`${base}/workspaces\`, label: 'Workspaces' }` after Teams)
- Create: `web/components/WorkspaceList.js`, `web/components/WorkspaceCard.js`
- Create: `web/app/dashboard/workspaces/page.js`, `web/app/dashboard/workspaces/actions.js`, `web/app/dashboard/workspaces/[id]/page.js`
- Create: `web/app/org/[slug]/workspaces/page.js`, `web/app/org/[slug]/workspaces/actions.js`, `web/app/org/[slug]/workspaces/[id]/page.js`
- Test: extend `web/test/nav.test.js`, `web/test/org-view.test.js`; `web/test/routes.test.js` gets the new routes if it lists routes explicitly (read it).

**Interfaces:**
- Pages call the API through `apiCall(user, …)` (`web/lib/api.js`). With the flag off, `GET /v1/me/workspaces` answers 404 and the page shows "Workspaces are not turned on yet." with no error report (`apiCall` reports 404s as failures: pass through a small wrapper `const r = await apiCall(...); const off = r.status === 404`; acceptable noise in phase 1, or add an `expect404` option to `apiCall` that skips the report when `status === 404`).
- Server actions (`actions.js`) follow `web/app/org/[slug]/teams/actions.js`: read `formData`, call the API, `revalidatePath`, `redirect` with `?message=` / `?error=`.

- [ ] **Step 1: Write the failing tests**

In `web/test/nav.test.js`, change the first test to include `assert.deepEqual(active('/dashboard/workspaces'), ['Workspaces'])` and `assert.deepEqual(active('/dashboard/workspaces/abc'), ['Workspaces'])`, and keep `assert.deepEqual(active('/dashboard'), ['Dashboard'])`.

In `web/test/org-view.test.js`, find the `orgTabs` test and add: a viewer with `grants: { workspaces: { r: true } }` sees a `Workspaces` tab at `/org/acme/workspaces` after Teams; one without does not.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && node --test test/nav.test.js test/org-view.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`web/lib/nav.js`:
```js
export const PERSONAL_NAV = [
  { href: '/dashboard', label: 'Dashboard', exact: true },
  { href: '/dashboard/workspaces', label: 'Workspaces' },
  { href: '/dashboard/computers', label: 'Computers' },
  { href: '/dashboard/agents', label: 'Agents' },
  { href: '/dashboard/access', label: 'Access types' }
]
```
`web/lib/org-view.js` `orgTabs`: insert `allowed(me, 'workspaces', 'r') && { href: \`${base}/workspaces\`, label: 'Workspaces' },` after the Teams entry.

`web/components/WorkspaceCard.js`:
```jsx
import Link from 'next/link'

const COVERS = { lilac: '#d9c6ea', mint: '#cfe6d4', peach: '#f6dcc0', rose: '#f3d3d0', periwinkle: '#e0dcf0', sky: '#cfe0ee' }

/** One workspace as a card, like the app's grid. `href` is the workspace's page. */
export default function WorkspaceCard ({ w, href }) {
  const initial = [...(w.name || '?')][0].toUpperCase()
  return (
    <Link href={href} className='card ws-card' style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ height: 56, background: COVERS[w.color] || COVERS.lilac, position: 'relative' }}>
        <span style={{ position: 'absolute', left: 12, top: 12, width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,.85)', display: 'grid', placeItems: 'center', fontWeight: 700 }}>{initial}</span>
        {w.counts?.open > 0 && <span className='pill' style={{ position: 'absolute', right: 10, top: 10 }}>{w.counts.open} open</span>}
      </div>
      <div className='stack' style={{ padding: '14px 16px', gap: 6, flex: 1 }}>
        <b style={{ fontSize: 16 }}>{w.name} <span className='pill'>{w.space?.kind === 'org' ? w.space.name : 'Personal'}</span></b>
        <span className='muted'>{w.description || ''}</span>
        <span className='muted' style={{ fontSize: 12 }}>{w.counts?.sessions ?? 0} sessions · {w.counts?.members ?? 0} members{w.archivedAt ? ' · archived' : ''}</span>
      </div>
    </Link>
  )
}
```

`web/components/WorkspaceList.js`:
```jsx
import WorkspaceCard from './WorkspaceCard.js'

/** A grid of workspace cards and, when `create` is given, a New workspace form card. */
export default function WorkspaceList ({ workspaces, hrefFor, create, orgSlug = '' }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
      {workspaces.map((w) => <WorkspaceCard key={w.id} w={w} href={hrefFor(w)} />)}
      {create && (
        <form action={create} className='card stack' style={{ padding: 16, borderStyle: 'dashed', boxShadow: 'none' }}>
          {orgSlug && <input type='hidden' name='slug' value={orgSlug} />}
          <b>New workspace</b>
          <input className='input' name='name' placeholder='Name' maxLength={80} required aria-label='Workspace name' />
          <input className='input' name='description' placeholder='What it is for (optional)' maxLength={500} aria-label='Description' />
          <select className='input' name='color' defaultValue='lilac' aria-label='Colour'>
            {['lilac', 'mint', 'peach', 'rose', 'periwinkle', 'sky'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className='btn primary'>Create</button>
        </form>)}
    </div>
  )
}
```

`web/app/dashboard/workspaces/actions.js` (follow `web/app/dashboard/actions.js` for the `requireUser`/`apiCall`/`redirect` pattern):
```js
'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'

const back = (path, q) => redirect(`${path}?${new URLSearchParams(q)}`)

export async function createWorkspace (formData) {
  const user = await requireUser('/dashboard/workspaces')
  const r = await apiCall(user, 'POST', '/v1/workspaces', { name: formData.get('name'), description: formData.get('description') || '', color: formData.get('color') || '' })
  if (!r.ok) back('/dashboard/workspaces', { error: r.data?.error || 'Could not create the workspace.' })
  revalidatePath('/dashboard/workspaces')
  redirect(`/dashboard/workspaces/${r.data.workspace.id}`)
}

export async function updateWorkspace (formData) {
  const user = await requireUser('/dashboard/workspaces')
  const id = String(formData.get('id'))
  const r = await apiCall(user, 'PATCH', `/v1/workspaces/${id}`, { name: formData.get('name'), description: formData.get('description') || '', color: formData.get('color') || '', archived: formData.get('archived') === 'on' })
  revalidatePath(`/dashboard/workspaces/${id}`)
  back(`/dashboard/workspaces/${id}`, r.ok ? { message: 'Saved.' } : { error: r.data?.error || 'Could not save.' })
}

export async function deleteWorkspace (formData) {
  const user = await requireUser('/dashboard/workspaces')
  const id = String(formData.get('id'))
  const r = await apiCall(user, 'DELETE', `/v1/workspaces/${id}`)
  revalidatePath('/dashboard/workspaces')
  if (!r.ok) back(`/dashboard/workspaces/${id}`, { error: r.data?.error || 'Could not delete.' })
  back('/dashboard/workspaces', { message: 'Deleted. Its sessions are still yours.' })
}

export async function setMember (formData) {
  const user = await requireUser('/dashboard/workspaces')
  const id = String(formData.get('id')); const account = String(formData.get('account'))
  const r = await apiCall(user, 'PUT', `/v1/workspaces/${id}/members/${encodeURIComponent(account)}`, { access: formData.get('access') })
  revalidatePath(`/dashboard/workspaces/${id}`)
  back(`/dashboard/workspaces/${id}`, r.ok ? { message: 'Saved.' } : { error: r.data?.error || 'Could not save.' })
}

export async function removeMember (formData) {
  const user = await requireUser('/dashboard/workspaces')
  const id = String(formData.get('id')); const account = String(formData.get('account'))
  const r = await apiCall(user, 'DELETE', `/v1/workspaces/${id}/members/${encodeURIComponent(account)}`)
  revalidatePath(`/dashboard/workspaces/${id}`)
  back(`/dashboard/workspaces/${id}`, r.ok ? { message: 'Removed.' } : { error: r.data?.error || 'Could not remove.' })
}
```

`web/app/dashboard/workspaces/page.js`:
```jsx
import AppHeader from '@/components/AppHeader.js'
import Notice from '@/components/Notice.js'
import WorkspaceList from '@/components/WorkspaceList.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { createWorkspace } from './actions.js'

export const metadata = { title: 'Workspaces' }

export default async function Workspaces ({ searchParams }) {
  const q = await searchParams
  const user = await requireUser('/dashboard/workspaces')
  const r = await apiCall(user, 'GET', '/v1/me/workspaces')
  const off = r.status === 404
  const workspaces = r.data?.workspaces || []
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>Workspaces</h1>
        <Notice q={q} />
        {off && <p className='muted'>Workspaces are not turned on yet.</p>}
        {!off && !r.ok && <p className='notice bad'>Could not load your workspaces right now.</p>}
        {r.ok && <WorkspaceList workspaces={workspaces} hrefFor={(w) => (w.space?.kind === 'org' ? `/org/${w.space.slug}/workspaces/${w.id}` : `/dashboard/workspaces/${w.id}`)} create={createWorkspace} />}
      </main>
    </>
  )
}
```

`web/app/dashboard/workspaces/[id]/page.js`: header, Notice, a settings form (name, description, colour select, archived checkbox, Save; Delete with a confirm component, see `web/test/confirm-delete.test.js` for the existing `ConfirmDelete` component), a Members list (`list-row` per member: name, kind pill, access select posting `setMember`, Remove posting `removeMember`; an "Add a person" form with an `account` text input is not needed: list the person's collaborators from `GET /v1/me/collaborators` and their agents from `GET /v1/agents` as Add buttons posting `setMember` with `access=view`), and a Sessions list (`list-row` per session: name or room, `Active <timeAgo>`). 404 from the API → `notFound()`. Only render the settings and member controls when `access.admin`.

Org pages mirror the personal ones with `/org/[slug]/workspaces` paths, `orgMe` for the permission check (`allowed(me, 'workspaces', 'c')` shows the create form; the create action posts `{ …, org: slug }`), and the org's members from `GET /v1/orgs/:slug/members` as the Add list. The org page lives inside the org layout (no `AppHeader`, no `<h1>` of the org name; follow `web/app/org/[slug]/teams/page.js`).

Also add the `Workspaces` label to anything that enumerates nav for the header skeleton if it hardcodes tab counts (`grep -n "Computers" web/components/*.js`).

- [ ] **Step 4: Run the website tests and load the pages**

Run: `cd web && npm test`
Expected: PASS (the routes test builds the site; a missing import fails it).

Then `cd web && QUILT_API_URL=http://127.0.0.1:4400 npm run dev` against the local API with the flag on, sign in, and open `/dashboard/workspaces`, create one, open it, add a member, archive, delete. Check the org pages with an org account.

- [ ] **Step 5: Commit**

```bash
git add web/lib/nav.js web/lib/org-view.js web/components/WorkspaceCard.js web/components/WorkspaceList.js web/app/dashboard/workspaces web/app/org/\[slug\]/workspaces web/test/nav.test.js web/test/org-view.test.js
git commit -m "Workspaces: website pages in the personal and org spaces"
```

---

### Task 10: Session-start briefing and status name the workspace (tool-agnostic)

**Files:**
- Modify: `src/status.js` (the `quilt status` / STATUS.md text gets a "Workspace: <name>" line when the session's `.quilt/config.json` has `workspace`)
- Modify: `src/mcp.js` and `src/relay-mcp.js`: `quilt_session_info` includes `workspace: { id }` when known (the id from config for the local MCP; the hosted MCP has none in phase 1 and omits it). `quilt_start_session` (local) gains an optional `workspace` argument passed into `runSession`, and after the room exists calls `setSessionWorkspace` with the agent's key (the account helper takes any bearer).
- Test: extend `test/mcp.test.js` (one case) and `test/status.test.js` (one case)

**Interfaces:**
- `quilt_start_session({ dir, workspace? })` → the existing answer plus `workspace: '<id>'` when given.
- `quilt_session_info()` → adds `workspace: { id }` when the folder's config has one.

- [ ] **Step 1: Write the failing tests**

In `test/status.test.js` add:
```js
test('a session in a workspace says so in STATUS.md', () => {
  const text = renderStatus({ ...baseStatus(), workspace: 'ws-1', workspaceName: 'Launch' })
  assert.match(text, /Workspace: Launch/)
})
```
(use the file's existing fixture helper for a status object; if none, build the minimal object the other tests use). In `test/mcp.test.js` find the `quilt_start_session` case and add an assertion that passing `workspace: 'ws-1'` writes `workspace: 'ws-1'` into `<dir>/.quilt/config.json` and echoes it in the result.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/status.test.js test/mcp.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `src/session.js` is not modified. Instead `src/runner.js` already saves `workspace`; `src/status.js`'s `renderStatus(status)` reads `status.workspaceName || status.workspace` and prints `Workspace: <name>` under the session name line when present. In `src/ui-server.js` and the MCP, where `status()` objects are produced for STATUS.md (`runSession` writes it from `session.status()`), merge `{ workspace: cfg.workspace }` from `readConfig(dir)` before rendering: in `runSession`, `renderStatus({ ...session.status(), workspace })`.
- `src/mcp.js`: in the `quilt_start_session` tool schema add `workspace: { type: 'string', description: 'The workspace id this session belongs to (from quilt_workspaces, phase 3; or given by the person).' }`; pass it to `runSession`; after start, if given, call `setSessionWorkspace({ token: <the agent's access key or the device token the MCP already uses for passes>, id: workspace, room })` and ignore failures with a log line. Add `workspace` to the result.
- `quilt_session_info` (both MCPs): include `workspace: { id }` when `readConfig(dir)?.workspace` exists (local only).

- [ ] **Step 4: Run the tests**

Run: `node --test test/status.test.js test/mcp.test.js test/relay-mcp.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status.js src/runner.js src/mcp.js src/relay-mcp.js test/status.test.js test/mcp.test.js
git commit -m "Workspaces: quilt_start_session takes a workspace; status names it"
```

---

### Task 11: Rename the session view's old "workspace" name in code

**Files:**
- Modify: `src/ui/session.js:1` (comment), `src/ui/common.js:75` (`ws` → `sv`), `src/ui/app.css:271` (the section comment), every `state.ws` use (`grep -rn "state\.ws\b" src/ui`), `.ws-tab` CSS classes if they clash with the new `.ws-*` block (`grep -n "\.ws-tab" src/ui/app.css src/ui/session.js`).
- Test: `test/ui-workspaces-screens.test.js` gains `assert.ok(!ui('session.js').includes('state.ws.'), 'the session view no longer calls itself a workspace')`.

- [ ] **Step 1: Add the assertion and run it**

Run: `node --test test/ui-workspaces-screens.test.js`
Expected: FAIL on the new assertion.

- [ ] **Step 2: Rename**

`sed -i '' 's/state\.ws\b/state.sv/g' src/ui/session.js src/ui/common.js src/ui/chat.js src/ui/feed.js src/ui/tree.js src/ui/fileview.js src/ui/board.js src/ui/merges.js` (only the files that use it; check with grep first), change the `common.js` comment to `sv: new Map(), // session id -> session view layout (mode, tabs, expanded folders)`, update the comment at the top of `session.js` ("The session view lives here"), and rename `.ws-tab` to `.sv-tab` in CSS and JS if present. Run every UI test.

- [ ] **Step 3: Run the tests**

Run: `node --test test/ui*.test.js test/board-*.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui
git commit -m "Session view: stop calling it a workspace in code"
```

---

### Task 12: Release notes, docs, full suite

**Files:**
- Modify: `RELEASES.md` (a new top section `## 0.3.6 — <date>` if the top section is already released, else add bullets to the current unreleased section; bump `package.json` version to match, the releases test checks they agree)
- Modify: `docs/hosting.md` (already touched in Task 5; make sure `QUILT_WORKSPACES` is documented)
- Modify: `README.md`: one short paragraph under "How it works": "Workspaces (behind a flag while they settle) gather sessions, people and agents in one place."

- [ ] **Step 1: Write the bullets**

Under the top section of `RELEASES.md`:

```
- **Workspaces (turned on per server while they settle).** A workspace gathers your sessions, the people and agents in them, and soon files, in one place. Home becomes a grid of workspace cards with an **Add workspace** card; a workspace's page shows its sessions and its people and agents, and **New session** starts one inside it. Members of a workspace are let into every session in it at their workspace access (edit or view), and a session owner can still tighten someone or invite an outsider by link. Sessions outside any workspace keep working as before and show under the grid.
- **Org workspaces.** In an org, workspaces belong to the org: the new **Workspaces** row in each role decides who creates, sees, edits and deletes them. heyquilt.com lists workspaces in the personal and org spaces and lets admins manage members without the app.
- **Agents can start a session inside a workspace** with the `workspace` argument of `quilt_start_session`; `quilt status` and `.quilt/STATUS.md` name the workspace.
```

- [ ] **Step 2: Run the whole suite**

Run: `npm test 2>&1 | tail -30` and `cd web && npm test 2>&1 | tail -10`
Expected: everything passes except the two tests that fail on main (note which).

- [ ] **Step 3: Start the app once more**

`npm run app` with the flag on and off (Task 8's commands), and confirm both homes render.

- [ ] **Step 4: Commit**

```bash
git add RELEASES.md package.json README.md docs/hosting.md
git commit -m "Workspaces phase 1: release notes and docs"
```

Then follow `superpowers:finishing-a-development-branch` for the merge (the branch stays behind the flag; merging does not turn anything on).

---

## Self-review notes

- Spec coverage for phase 1: tables (1, 3), permission row (2), access fallback (4), routes (5), app helpers (6), app routes and start (7), grid, add card, page, People & agents, settings, loose strip (8), website (9), agents starting sessions in a workspace (10), the code rename (11), release notes (12). Files, Realtime, agent invites into workspaces, placements and `quilt_workspaces` are phases 2 and 3 by the spec.
- The spec's "matching app setting" for the flag is replaced by the app following the API's 404; noted in Global Constraints. Update the spec's Reversibility bullet to say so when this plan is accepted.
- Names used consistently: store `createWorkspace/workspaceById/listWorkspacesOwnedBy/listWorkspacesOfOrg/listWorkspacesForMember/updateWorkspace/deleteWorkspace/workspaceMember/listWorkspaceMembers/putWorkspaceMember/removeWorkspaceMember/setSessionWorkspace/listWorkspaceSessions`; access values `edit`/`view`; `workspaceAccess(store, ws, account, { orgGrants })`; local routes `/api/workspaces…`; UI exports `loadWorkspaces/openWorkspace/workspacesHtml/bindWorkspaces/workspacePageHtml/bindWorkspacePage`.
