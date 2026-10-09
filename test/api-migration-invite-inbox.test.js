// The invite inbox migration: additive only, RLS on, no client policies, service role only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../supabase/migrations/20261009000000_invite_inbox.sql', import.meta.url), 'utf8')

test('session invites keep their link; workspace invites are their own table', () => {
  const s = sql()
  assert.match(s, /alter table public\.session_invites add column link text check \(char_length\(link\) <= 2048\);/)
  const t = (s.match(/create table public\.workspace_invites \([\s\S]*?\n\);/) || [''])[0]
  for (const col of ['workspace_id uuid not null references public.workspaces (id) on delete cascade', "account text check (account ~ '^person:[A-Za-z0-9_-]{1,64}$')", "access text not null check (access in ('edit', 'view'))", 'accepted_at timestamptz', 'declined_at timestamptz', 'cancelled_at timestamptz', 'check ((email is null) <> (account is null))']) assert.ok(t.includes(col), col)
  assert.match(s, /create unique index workspace_invites_open_email on public\.workspace_invites \(workspace_id, email\) where accepted_at is null and declined_at is null and cancelled_at is null;/)
  assert.match(s, /create unique index workspace_invites_open_account on public\.workspace_invites \(workspace_id, account\) where accepted_at is null and declined_at is null and cancelled_at is null;/)
})

test('additive only, and clients never touch it', () => {
  const s = sql()
  assert.doesNotMatch(s, /\bdrop\b/i)
  assert.match(s, /alter table public\.workspace_invites enable row level security;/)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.workspace_invites from anon, authenticated;/)
  assert.match(s, /grant all on public\.workspace_invites to service_role;/)
})
