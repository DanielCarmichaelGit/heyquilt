import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../../supabase/migrations/20261002000000_session_activity.sql', import.meta.url), 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]
const TABLES = ['relay_sessions', 'session_visits', 'relay_events_seen']
const FUNCTIONS = ['ingest_presence (jsonb, timestamptz)', 'account_sessions (text, timestamptz, integer)', 'visits_in_rooms (text[])', 'prune_activity (timestamptz, timestamptz)', 'delete_account_activity (text[])']

test('sessions, visits and seen event ids, with the columns the spec names', () => {
  const s = sql()
  const sessions = table(s, 'relay_sessions')
  for (const col of ['room text primary key', 'name text not null', 'owner_account text', 'created_at timestamptz not null', 'last_active_at timestamptz not null', 'renamed_at timestamptz']) assert.ok(sessions.includes(col), col)
  const visits = table(s, 'session_visits')
  for (const col of ['event_start_id uuid not null unique', 'room text not null references public.relay_sessions (room) on delete cascade', 'account text not null', 'account_name text not null', "kind text not null check (kind in ('person', 'agent'))", 'started_at timestamptz not null', 'ended_at timestamptz']) assert.ok(visits.includes(col), col)
  const seen = table(s, 'relay_events_seen')
  for (const col of ['id uuid primary key', 'received_at timestamptz not null']) assert.ok(seen.includes(col), col)
})

test('clients never touch activity: RLS on, no policies, no grants, functions for the service role only', () => {
  const s = sql()
  for (const t of TABLES) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.relay_sessions, public\.session_visits, public\.relay_events_seen from anon, authenticated;/)
  for (const line of s.split('\n').filter((l) => /^grant\b/.test(l))) assert.doesNotMatch(line, /\b(anon|authenticated)\b/, line)
  for (const f of FUNCTIONS) {
    assert.ok(s.includes(`revoke execute on function public.${f} from public, anon, authenticated;`), f)
    assert.ok(s.includes(`grant execute on function public.${f} to service_role;`), f)
  }
  for (const m of s.matchAll(/create function public\.\w+[\s\S]*?\nas \$\$/g)) assert.match(m[0], /set search_path = ''/, m[0].split('\n')[0])
})

test("a relay name never replaces the owner's rename, and the first owner wins", () => {
  const s = sql()
  assert.match(s, /on conflict \(room\) do update set name = excluded\.name\s+where s\.renamed_at is null;/)
  assert.match(s, /owner_account = coalesce\(s\.owner_account, excluded\.owner_account\)/)
  assert.match(s, /on conflict \(event_start_id\) do nothing;/)
})
