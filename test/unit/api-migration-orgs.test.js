import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const file = new URL('../../supabase/migrations/20260930000000_orgs.sql', import.meta.url)
const sql = () => fs.readFileSync(file, 'utf8')
const TABLES = ['orgs', 'roles', 'org_members', 'teams', 'team_members', 'org_invites', 'join_requests']

// Pulls one `create table public.<name> ( ... );` block out of the migration.
const table = (s, name) => {
  const m = s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`))
  return m ? m[0] : ''
}

// Pulls one `create function public.<name>(...) ... $$;` block out of the migration.
const fn = (s, name) => {
  const m = s.match(new RegExp(`create function public\\.${name} ?\\([\\s\\S]*?\\$\\$;`))
  return m ? m[0] : ''
}

test('every org table exists with row-level security and a service-role grant', () => {
  const s = sql()
  for (const t of TABLES) {
    assert.match(s, new RegExp(`create table public\\.${t} \\(`), t)
    assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  }
  assert.match(s, /grant all on public\.orgs, public\.roles, public\.org_members, public\.teams, public\.team_members, public\.org_invites, public\.join_requests to service_role/)
})

test('clients never read invites (token hashes live there) and write nothing', () => {
  const s = sql()
  assert.match(s, /token_hash text not null unique/)
  assert.doesNotMatch(s, /grant [^;]*on public\.org_invites to authenticated/)
  assert.doesNotMatch(s, /grant (insert|update|delete)[^;]* to authenticated/)
  // No grant of any kind (not just the single-table form above) hands a client role org_invites or token_hash.
  const clientGrants = s.split('\n').filter(l => /^grant\b/.test(l.trim()) && /\b(authenticated|anon)\b/.test(l))
  for (const line of clientGrants) {
    assert.doesNotMatch(line, /org_invites/, `client grant touches org_invites: ${line}`)
    assert.doesNotMatch(line, /token_hash/, `client grant touches token_hash: ${line}`)
  }
})

test('org_invites has no row-level-security policy of its own', () => {
  const s = sql()
  assert.doesNotMatch(s, /create policy [^\n]*on public\.org_invites/)
})

test('the org functions run only as the API; the RLS helpers only for signed-in people', () => {
  const s = sql()
  assert.match(s, /revoke execute on function public\.create_org\(text, text, uuid, jsonb, jsonb, jsonb, boolean\), public\.transfer_org\(uuid, uuid, uuid\) from public, anon, authenticated;/)
  assert.match(s, /grant execute on function public\.create_org\(text, text, uuid, jsonb, jsonb, jsonb, boolean\), public\.transfer_org\(uuid, uuid, uuid\) to service_role;/)
  assert.match(s, /revoke execute on function public\.my_org_ids\(\) from public, anon;/)
  assert.match(s, /revoke execute on function public\.my_team_ids\(\) from public, anon;/)
  assert.match(s, /revoke execute on function public\.has_org_grant\(uuid, text, text\) from public, anon;/)
  assert.match(s, /grant execute on function public\.has_org_grant\(uuid, text, text\) to authenticated;/)
})

test('my_org_ids and my_team_ids are security-definer helpers (no RLS recursion)', () => {
  const s = sql()
  assert.match(fn(s, 'my_org_ids'), /security definer/)
  assert.match(fn(s, 'my_team_ids'), /security definer/)
})

test('has_org_grant checks the caller\'s own role against the permission grid', () => {
  const s = sql()
  const f = fn(s, 'has_org_grant')
  assert.ok(f, 'has_org_grant exists')
  assert.match(f, /returns boolean/)
  assert.match(f, /language sql stable security definer set search_path = ''/)
  assert.match(f, /r\.builtin = 'owner'/)
  assert.match(f, /r\.grants -> p_resource ->> p_op/)
})

test('grid-gated reads use has_org_grant instead of bare org membership', () => {
  const s = sql()
  assert.match(s, /public\.has_org_grant\(org_id, 'roles', 'r'\)/)
  assert.match(s, /public\.has_org_grant\(org_id, 'members', 'u'\)/)
  assert.match(s, /public\.has_org_grant\(org_id, 'invites', 'c'\)/)
  assert.match(s, /public\.has_org_grant\(org_id, 'members', 'r'\)/)
  assert.match(s, /public\.has_org_grant\(org_id, 'teams', 'r'\)/)
  assert.match(s, /public\.has_org_grant\(org_id, 'team_members', 'r'\)/)
})

test('member rows are a person or an agent; team access and folders are constrained', () => {
  const s = sql()
  assert.match(s, /check \(\(user_id is null\) <> \(agent_id is null\)\)/)
  assert.match(s, /access text not null check \(access in \('editor', 'viewer'\)\)/)
  assert.match(s, /check \(cardinality\(scopes\) <= 20\)/)
  assert.match(s, /create unique index join_requests_one_pending on public\.join_requests \(org_id, user_id\) where status = 'pending'/)
  assert.ok(s.includes("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'"), 'slug format matches src/api/slugs.js')
})

test('roles, teams and org_members are keyed for same-org composite foreign keys', () => {
  const s = sql()
  assert.match(table(s, 'roles'), /unique \(id, org_id\)/)
  assert.match(table(s, 'teams'), /unique \(id, org_id\)/)
  assert.match(table(s, 'org_members'), /unique \(id, org_id\)/)
  assert.match(table(s, 'org_members'), /foreign key \(role_id, org_id\) references public\.roles \(id, org_id\)/)
  assert.match(table(s, 'org_invites'), /foreign key \(role_id, org_id\) references public\.roles \(id, org_id\)/)
})

test('org_invites keeps a role in use rather than cascading its deletion', () => {
  const s = sql()
  const t = table(s, 'org_invites')
  const m = t.match(/foreign key \(role_id, org_id\) references public\.roles \(id, org_id\)[^,\n]*/)
  assert.ok(m, 'composite fk present')
  assert.doesNotMatch(m[0], /on delete cascade/)
})

test('team_members carries org_id and same-org composite foreign keys', () => {
  const s = sql()
  const t = table(s, 'team_members')
  assert.match(t, /org_id uuid not null/)
  assert.match(t, /foreign key \(team_id, org_id\) references public\.teams \(id, org_id\) on delete cascade/)
  assert.match(t, /foreign key \(member_id, org_id\) references public\.org_members \(id, org_id\) on delete cascade/)
})

test('join_requests stores a lowercase, confirmed email like org_invites', () => {
  const s = sql()
  assert.match(table(s, 'join_requests'), /email text not null check \(email = lower\(email\)\)/)
})

test('helpful indexes exist for lookups the API needs', () => {
  const s = sql()
  assert.match(s, /create index org_members_agent_id on public\.org_members \(agent_id\)/)
  assert.match(s, /create index orgs_owner_id on public\.orgs \(owner_id\)/)
  assert.match(s, /create index org_invites_invited_by on public\.org_invites \(invited_by\)/)
  assert.match(s, /create index join_requests_decided_by on public\.join_requests \(decided_by\)/)
  assert.match(s, /create index join_requests_org_id on public\.join_requests \(org_id\)/)
})

test('transfer_org locks the target membership and raises distinct errcodes', () => {
  const s = sql()
  const f = fn(s, 'transfer_org')
  assert.ok(f, 'transfer_org exists')
  assert.match(f, /p_from uuid/)
  assert.match(f, /for update/)
  assert.match(f, /errcode = 'QO001'/)
  assert.match(f, /errcode = 'QO002'/)
  assert.match(f, /errcode = 'QO003'/)
  assert.match(f, /old_owner is distinct from p_from/)
})

test('create_org p_first locks on the owner and returns an existing org instead of a second one', () => {
  const s = sql()
  const f = fn(s, 'create_org')
  assert.ok(f, 'create_org exists')
  assert.match(f, /p_first boolean default false/)
  assert.match(f, /pg_advisory_xact_lock\(hashtextextended\(p_owner::text, 0\)\)/)
  assert.match(f, /if p_first then/)
})
