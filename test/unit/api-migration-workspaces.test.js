// The workspaces migration: additive only, RLS on, no client policies, service role only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../../supabase/migrations/20261004000000_workspaces.sql', import.meta.url), 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]

test('workspaces and members, with the columns the spec names', () => {
  const s = sql()
  const ws = table(s, 'workspaces')
  for (const col of ['id uuid primary key default gen_random_uuid()', 'owner_user_id uuid references auth.users (id) on delete cascade', 'org_id uuid references public.orgs (id) on delete cascade', 'name text not null check (char_length(name) between 1 and 80)', "description text not null default '' check (char_length(description) <= 500)", "color text not null default ''", 'created_by text not null', 'created_at timestamptz not null default now()', 'archived_at timestamptz', 'check ((owner_user_id is null) <> (org_id is null))']) assert.ok(ws.includes(col), col)
  const m = table(s, 'workspace_members')
  for (const col of ['workspace_id uuid not null references public.workspaces (id) on delete cascade', "account text not null check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$')", "access text not null check (access in ('edit', 'view'))", 'added_by text not null', 'added_at timestamptz not null default now()', 'primary key (workspace_id, account)']) assert.ok(m.includes(col), col)
  assert.match(s, /alter table public\.relay_sessions add column workspace_id uuid references public\.workspaces \(id\) on delete set null;/)
  assert.match(s, /create index relay_sessions_workspace_id on public\.relay_sessions \(workspace_id\);/)
  assert.match(s, /alter table public\.relay_sessions add column workspace_linked_by text check \(workspace_linked_by ~ '\^\(person\|agent\):\[A-Za-z0-9_-\]\{1,64\}\$'\);/)
  assert.match(s, /create index workspace_members_account on public\.workspace_members \(account\);/)
})

test('additive only: no drop, no alter of existing columns', () => {
  const s = sql()
  assert.doesNotMatch(s, /\bdrop\b/i)
  assert.doesNotMatch(s, /alter table public\.(?!relay_sessions add column workspace_(id|linked_by))(?!workspaces)(?!workspace_members)/)
})

test('clients never touch them: RLS on, no policies, no grants, functions for the service role only', () => {
  const s = sql()
  for (const t of ['workspaces', 'workspace_members']) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.workspaces, public\.workspace_members from anon, authenticated;/)
  assert.match(s, /grant all on public\.workspaces, public\.workspace_members to service_role;/)
  for (const f of ['delete_workspace (uuid)', 'workspaces_for_account (text)', 'set_session_workspace (text, uuid, text, timestamptz)']) {
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

test('linking a room never sets its owner: the relay alone does, and the linker is kept', () => {
  const s = sql()
  const fn = (s.match(/create function public\.set_session_workspace[\s\S]*?\n\$\$;/) || [''])[0]
  assert.match(fn, /\(p_room text, p_workspace uuid, p_linked_by text, p_at timestamptz\)/)
  assert.match(fn, /insert into public\.relay_sessions as r \(room, created_at, last_active_at, workspace_id, workspace_linked_by\)/)
  assert.doesNotMatch(fn, /owner_account/)
  assert.match(fn, /on conflict \(room\) do update set workspace_id = excluded\.workspace_id, workspace_linked_by = excluded\.workspace_linked_by/)
})

test('existing orgs get the Workspaces permission their built-in Admin and Member roles now carry', () => {
  const s = sql()
  assert.ok(s.includes(`update public.roles set grants = grants || '{"workspaces": {"c": true, "r": true, "u": true, "d": true}}'::jsonb where builtin = 'admin';`))
  assert.ok(s.includes(`update public.roles set grants = grants || '{"workspaces": {"r": true}}'::jsonb where builtin = 'member';`))
  // Only built-in roles: custom roles keep exactly what their org gave them.
  assert.equal([...s.matchAll(/update public\.roles /g)].length, 2)
})
