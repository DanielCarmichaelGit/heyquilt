// The access types migration: tables, row-level security with no client policies, and
// the SQL functions the Supabase store calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../../supabase/migrations/20261002010000_access_types_and_invites.sql', import.meta.url), 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]
const TABLES = ['access_types', 'session_grants', 'session_invites']
const FUNCTIONS = ['delete_access_type (uuid, text)', 'claim_email_invites (text, text, text, timestamptz)', 'delete_account_access (text[])', 'delete_unused_grant (text, text, timestamptz)']

test('access types, grants and invites, with the columns the spec names', () => {
  const s = sql()
  const types = table(s, 'access_types')
  for (const col of ['id uuid primary key', 'owner_account text not null', 'name text not null check (char_length(name) between 1 and 40)', "files text not null check (files in ('edit', 'view'))", "folders text[] not null default '{}' check (cardinality(folders) <= 20)", 'talk boolean not null default true', 'created_at timestamptz not null', 'updated_at timestamptz not null']) assert.ok(types.includes(col), col)
  const grants = table(s, 'session_grants')
  for (const col of ['room text not null references public.relay_sessions (room) on delete cascade', 'account text not null', 'type_id text not null', "tighten jsonb not null default '{}'::jsonb", 'granted_by text not null', 'primary key (room, account)']) assert.ok(grants.includes(col), col)
  const invites = table(s, 'session_invites')
  for (const col of ['room text not null references public.relay_sessions (room) on delete cascade', 'email text check (email = lower(email)', 'account text check', 'type_id text not null', 'invited_by text not null', 'expires_at timestamptz not null', 'used_at timestamptz', 'cancelled_at timestamptz', 'check ((email is null) <> (account is null))']) assert.ok(invites.includes(col), col)
  assert.doesNotMatch(invites, /link|secret/, 'the invite link (it holds the room secret) is never stored')
})

test('clients never touch them: RLS on, no policies, no grants, functions for the service role only', () => {
  const s = sql()
  for (const t of TABLES) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.access_types, public\.session_grants, public\.session_invites from anon, authenticated;/)
  for (const line of s.split('\n').filter((l) => /^grant\b/.test(l))) assert.doesNotMatch(line, /\b(anon|authenticated)\b/, line)
  for (const f of FUNCTIONS) {
    assert.ok(s.includes(`revoke execute on function public.${f} from public, anon, authenticated;`), f)
    assert.ok(s.includes(`grant execute on function public.${f} to service_role;`), f)
  }
  for (const m of s.matchAll(/create function public\.\w+[\s\S]*?\nas \$\$/g)) assert.match(m[0], /set search_path = ''/, m[0].split('\n')[0])
})

test('deleting a type falls back to View only, and an email invite moves its grant to the account', () => {
  const s = sql()
  assert.match(s, /update public\.session_grants set type_id = 'builtin:view'/)
  assert.match(s, /update public\.session_invites set type_id = 'builtin:view'/)
  assert.match(s, /expires_at > p_now/)
  assert.match(s, /delete from public\.session_grants where room = p_room and account = 'email:' \|\| p_email;/)
})

test('one open invite per address or account, kept by the database; invites are indexed by account', () => {
  const s = sql()
  assert.ok(s.includes('create unique index session_invites_open_email on public.session_invites (room, email) where used_at is null and cancelled_at is null;'))
  assert.ok(s.includes('create unique index session_invites_open_account on public.session_invites (room, account) where used_at is null and cancelled_at is null;'))
  assert.ok(s.includes('create index session_invites_account on public.session_invites (account);'))
})

test('a cancelled invite takes its grant only if no open invite needs it, in one statement', () => {
  const s = sql()
  assert.match(s, /delete from public\.session_grants g where g\.room = p_room and g\.account = p_account\n\s+and not exists \(/)
  assert.ok(s.includes('then i.email = substr(p_account, 7) else i.account = p_account end'))
})
