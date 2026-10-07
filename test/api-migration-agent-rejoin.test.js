import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = fs.readFileSync(new URL('../supabase/migrations/20261007010000_agent_rejoin.sql', import.meta.url), 'utf8')

test('agent invites record whether they brought an existing agent back', () => {
  assert.match(sql, /alter table public\.agent_invites add column rejoined boolean not null default false;/)
  assert.doesNotMatch(sql, /\bgrant\b/, 'no new client grants: agent_invites stays API-only')
})
