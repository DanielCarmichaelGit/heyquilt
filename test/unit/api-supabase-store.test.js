import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { rowFrom, createSupabaseStore } from '../../src/api/supabase-store.js'

test('rowFrom camelCases columns and turns every *At field into epoch ms', () => {
  const iso = '2026-09-29T00:00:00.000Z'
  const row = {
    id: 'd1',
    user_id: 'u1',
    name: 'Mac',
    public_key: 'pk',
    token_hash: 'th',
    created_at: iso,
    last_seen_at: iso,
    last_used_at: null,
    joined_at: iso,
    last_active_at: iso,
    expires_at: iso,
    revoked_at: null
  }
  const out = rowFrom(row)
  assert.equal(out.id, 'd1')
  assert.equal(out.userId, 'u1')
  assert.equal(out.publicKey, 'pk')
  assert.equal(out.tokenHash, 'th')
  for (const k of ['createdAt', 'lastSeenAt', 'joinedAt', 'lastActiveAt', 'expiresAt']) {
    assert.equal(out[k], Date.parse(iso), `${k} should be epoch ms`)
  }
  assert.equal(out.lastUsedAt, null)
  assert.equal(out.revokedAt, null)
})

test('rowFrom passes through null rows', () => {
  assert.equal(rowFrom(null), null)
  assert.equal(rowFrom(undefined), undefined)
})

// A stand-in supabase client that records each query chain and answers with `data`.
function fakeClient (data = {}) {
  const calls = []
  const client = {
    from (table) {
      const q = { table, ops: [] }
      calls.push(q)
      const chain = new Proxy({}, {
        get (_, op) {
          if (op === 'then') return (res, rej) => Promise.resolve({ data: typeof data === 'function' ? data(q) : data, error: null }).then(res, rej)
          return (...args) => { q.ops.push([op, ...args]); return chain }
        }
      })
      return chain
    }
  }
  return { client, calls }
}

test('supabase upsertDevice: one row per (account, key), and a relink clears the old token', async () => {
  const { client, calls } = fakeClient({ id: 'd1', user_id: 'u1', token_hash: null })
  const s = createSupabaseStore({ client })
  await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  const upsert = calls[0].ops.find(([op]) => op === 'upsert')
  assert.equal(upsert[2].onConflict, 'user_id,public_key')
  assert.equal(upsert[1].token_hash, null)
  assert.equal(upsert[1].revoked_at, null)
})

test('supabase claimInvite only claims an invite that is unaccepted, uncancelled and unexpired', async () => {
  const { client, calls } = fakeClient({ id: 'i1' })
  const s = createSupabaseStore({ client })
  await s.claimInvite('i1')
  const update = calls[0]
  assert.ok(update.ops.some(([op, col]) => op === 'is' && col === 'accepted_at'))
  assert.ok(update.ops.some(([op, col]) => op === 'is' && col === 'cancelled_at'))
  const gt = update.ops.find(([op, col]) => op === 'gt' && col === 'expires_at')
  assert.ok(gt, 'claimInvite must also require expires_at to be in the future')
})

test('the migration keys devices on (user_id, public_key) and allows the approving status', () => {
  const sql = fs.readFileSync(new URL('../../supabase/migrations/20260929000000_accounts.sql', import.meta.url), 'utf8')
  const devices = sql.match(/create table public\.devices \(([\s\S]*?)\n\);/)[1]
  assert.doesNotMatch(devices, /public_key text not null unique/)
  assert.match(devices, /unique \(user_id, public_key\)/)
  assert.match(sql, /status in \('pending', 'approving', 'approved', 'denied', 'consumed'\)/)
})

test('supabase profileKind reads the kind column, and answers null for no row', async () => {
  const { client, calls } = fakeClient({ kind: 'org' })
  const s = createSupabaseStore({ client })
  assert.equal(await s.profileKind('u1'), 'org')
  assert.equal(calls[0].table, 'profiles')
  assert.ok(calls[0].ops.some(([op, col]) => op === 'select' && col === 'kind'))
  const none = createSupabaseStore({ client: fakeClient(null).client })
  assert.equal(await none.profileKind('gone'), null)
})

test('the account_kind migration sets kind from sign-up metadata, and keeps the trigger locked down', () => {
  const sql = fs.readFileSync(new URL('../../supabase/migrations/20260930010000_account_kind.sql', import.meta.url), 'utf8')
  assert.match(sql, /check \(kind in \('personal', 'org'\)\)/)
  const fn = sql.match(/create or replace function public\.handle_new_user[\s\S]*?\$\$;/)[0]
  assert.match(fn, /when new\.raw_user_meta_data ->> 'account' = 'org' then 'org' else 'personal' end/)
  assert.match(sql, /revoke execute on function public\.handle_new_user\(\) from public, anon, authenticated/)
  assert.match(sql, /grant select \(kind\) on public\.profiles to authenticated/)
})

// The stand-in client above only has from(); record_events is an rpc, so give it one too.
function fakeRpcClient (data = 1) {
  const calls = []
  const base = fakeClient([])
  base.client.rpc = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data, error: null }) }
  return { client: base.client, calls, fromCalls: base.calls }
}

test('supabase recordEvents sends one record_events call with snake_case rows and ISO times', async () => {
  const { client, calls } = fakeRpcClient(2)
  const s = createSupabaseStore({ client })
  const t = Date.parse('2026-10-01T10:00:00Z')
  const n = await s.recordEvents([
    { surface: 'app', kind: 'action', name: 'open-in', outcome: 'error', status: null, durationMs: 12, message: 'boom', appVersion: '0.3.2', platform: 'darwin', userId: 'u1', deviceId: 'd1', context: { app: 'cursor' }, occurredAt: t, fingerprint: 'f'.repeat(64) },
    { surface: 'app', kind: 'action', name: 'open-in', outcome: 'ok', status: null, durationMs: 3, message: '', appVersion: '0.3.2', platform: 'darwin', userId: 'u1', deviceId: 'd1', context: {}, occurredAt: t, fingerprint: null }
  ])
  assert.equal(n, 2)
  assert.equal(calls.length, 1)
  const [fn, { events }] = calls[0]
  assert.equal(fn, 'record_events')
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { surface: 'app', kind: 'action', name: 'open-in', outcome: 'error', status: null, duration_ms: 12, message: 'boom', app_version: '0.3.2', platform: 'darwin', user_id: 'u1', device_id: 'd1', context: { app: 'cursor' }, occurred_at: '2026-10-01T10:00:00.000Z', fingerprint: 'f'.repeat(64) })
  assert.equal(events[1].fingerprint, null)
})

test('supabase recordEvents with nothing to record makes no call', async () => {
  const { client, calls } = fakeRpcClient()
  assert.equal(await createSupabaseStore({ client }).recordEvents([]), 0)
  assert.equal(calls.length, 0)
})

test('supabase pruneEvents deletes events that occurred before the cut-off', async () => {
  const { client, fromCalls } = fakeRpcClient()
  await createSupabaseStore({ client }).pruneEvents(Date.parse('2026-09-01T00:00:00Z'))
  const q = fromCalls.at(-1)
  assert.equal(q.table, 'events')
  assert.deepEqual(q.ops[0], ['delete'])
  assert.deepEqual(q.ops[1], ['lt', 'occurred_at', '2026-09-01T00:00:00.000Z'])
})

test('supabase pruneIssues deletes issues last seen before the cut-off', async () => {
  const { client, fromCalls } = fakeRpcClient()
  await createSupabaseStore({ client }).pruneIssues(Date.parse('2026-09-01T00:00:00Z'))
  const q = fromCalls.at(-1)
  assert.equal(q.table, 'issues')
  assert.deepEqual(q.ops[0], ['delete'])
  assert.deepEqual(q.ops[1], ['lt', 'last_seen_at', '2026-09-01T00:00:00.000Z'])
})
