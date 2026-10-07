import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261007030000_agent_app_keys.sql', import.meta.url), 'utf8')

test('app keys: hashes only, one agent each, gone with the agent, API-only', () => {
  assert.match(sql, /create table public\.agent_app_keys \(/)
  assert.match(sql, /agent_id uuid not null references public\.agents \(id\) on delete cascade/)
  assert.match(sql, /key_hash text not null unique/)
  assert.match(sql, /alter table public\.agent_app_keys enable row level security;/)
  assert.match(sql, /revoke all on public\.agent_app_keys from anon, authenticated;/)
  assert.doesNotMatch(sql, /\bgrant\b/, 'no client grants')
})
