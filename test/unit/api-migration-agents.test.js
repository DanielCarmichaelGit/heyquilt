import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const file = new URL('../../supabase/migrations/20260930020000_agent_sign_in.sql', import.meta.url)
const sql = () => fs.readFileSync(file, 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]
const clientGrants = (s) => s.split('\n').filter((l) => /^grant\b/.test(l.trim()) && /\b(authenticated|anon)\b/.test(l))

test('agents lose their secrets and static owner, and gain a home, an inviter and a profile', () => {
  const s = sql()
  for (const col of ['key_prefix', 'key_hash', 'private_key_enc', 'owner_id']) assert.match(s, new RegExp(`drop column ${col},\\n`), col)
  assert.match(s, /add column owner_user_id uuid references public\.profiles \(id\) on delete cascade/)
  assert.match(s, /add column org_id uuid references public\.orgs \(id\) on delete cascade/)
  assert.match(s, /add column invited_by uuid references auth\.users \(id\) on delete set null/)
  assert.match(s, /add column provider text not null/)
  assert.match(s, /add column type text not null/)
  assert.match(s, /add column description text not null default ''/)
  assert.match(s, /alter table public\.agents alter column public_key drop not null;/)
  assert.match(s, /add constraint agents_one_home check \(\(owner_user_id is null\) <> \(org_id is null\)\)/)
  assert.match(s, /add constraint agents_name_length check \(char_length\(name\) between 1 and 40\)/)
  assert.match(s, /add constraint agents_provider_length check \(char_length\(provider\) between 1 and 40\)/)
  assert.match(s, /add constraint agents_type_length check \(char_length\(type\) between 1 and 40\)/)
  assert.match(s, /add constraint agents_description_length check \(char_length\(description\) <= 180\)/)
  assert.match(s, /add constraint agents_id_org_id_key unique \(id, org_id\)/)
  assert.ok(s.indexOf('drop policy "own agents: read"') < s.indexOf('drop column owner_id'), 'the old policies go before the column they read')
})

test("an agent member must be in the agent's own org", () => {
  const s = sql()
  assert.match(s, /alter table public\.org_members drop constraint org_members_agent_id_fkey;/)
  assert.match(s, /add constraint org_members_agent_id_fkey\s+foreign key \(agent_id, org_id\) references public\.agents \(id, org_id\) on delete cascade/)
})

test('agent invites: hashed single-use tokens, a person or an org, a same-org role', () => {
  const t = table(sql(), 'agent_invites')
  assert.match(t, /token_hash text not null unique/)
  assert.match(t, /owner_user_id uuid references public\.profiles \(id\) on delete cascade/)
  assert.match(t, /org_id uuid references public\.orgs \(id\) on delete cascade/)
  assert.match(t, /created_by uuid references auth\.users \(id\) on delete set null/)
  assert.match(t, /teams jsonb not null default '\[\]'::jsonb check \(jsonb_typeof\(teams\) = 'array'\)/)
  for (const col of ['expires_at timestamptz not null', 'used_at timestamptz', 'cancelled_at timestamptz']) assert.ok(t.includes(col), col)
  assert.match(t, /used_by_agent_id uuid references public\.agents \(id\) on delete set null/)
  assert.match(t, /check \(\(owner_user_id is null\) <> \(org_id is null\)\)/)
  assert.match(t, /check \(org_id is not null or role_id is null\)/)
  assert.match(t, /foreign key \(role_id, org_id\) references public\.roles \(id, org_id\) on delete set null \(role_id\)/)
})

test('agent keys hold hashes only, in families', () => {
  const keys = table(sql(), 'agent_keys')
  for (const col of ['access_hash text not null unique', 'refresh_hash text not null unique', 'family_id uuid not null', 'access_expires_at timestamptz not null', 'refresh_expires_at timestamptz not null', 'refreshed_at timestamptz', 'revoked_at timestamptz']) assert.ok(keys.includes(col), col)
  assert.match(keys, /agent_id uuid not null references public\.agents \(id\) on delete cascade/)
})

test('clients never touch invites or keys, and only read agents', () => {
  const s = sql()
  for (const t of ['agent_invites', 'agent_keys']) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy [^\n]*on public\.(agent_invites|agent_keys)/)
  for (const line of clientGrants(s)) {
    assert.doesNotMatch(line, /agent_invites|agent_keys|_hash/, line)
    assert.doesNotMatch(line, /^grant (insert|update|delete|all)/, line)
  }
  assert.match(s, /revoke all on public\.agents from anon, authenticated;/)
  assert.match(s, /revoke all on public\.agent_invites, public\.agent_keys from anon, authenticated;/)
  assert.match(s, /grant select \(id, name, provider, type, description, public_key, owner_user_id, org_id, invited_by, created_at, last_used_at, revoked_at\) on public\.agents to authenticated;/)
  assert.match(s, /grant all on public\.agents, public\.agent_invites, public\.agent_keys to service_role;/)
})

test('people read their personal agents, and org agents with Agents: Read', () => {
  const s = sql()
  const policy = s.match(/create policy "agents: read own and org agents"[\s\S]*?\);/)
  assert.ok(policy, 'one read policy')
  assert.match(policy[0], /\(select auth\.uid\(\)\) = owner_user_id/)
  assert.match(policy[0], /public\.has_org_grant\(org_id, 'agents', 'r'\)/)
  assert.doesNotMatch(s, /create (or replace )?function/, 'no new functions to lock down')
})

test('lookups the API makes are indexed', () => {
  const s = sql()
  for (const idx of [
    'agents_owner_user_id on public.agents (owner_user_id)', 'agents_org_id on public.agents (org_id)', 'agents_invited_by on public.agents (invited_by)',
    'agent_invites_owner_user_id on public.agent_invites (owner_user_id)', 'agent_invites_org_id on public.agent_invites (org_id)',
    'agent_invites_created_by on public.agent_invites (created_by)', 'agent_invites_role_id on public.agent_invites (role_id)',
    'agent_invites_used_by_agent_id on public.agent_invites (used_by_agent_id)',
    'agent_keys_agent_id on public.agent_keys (agent_id)', 'agent_keys_family_id on public.agent_keys (family_id)'
  ]) assert.ok(s.includes(`create index ${idx}`), idx)
})
