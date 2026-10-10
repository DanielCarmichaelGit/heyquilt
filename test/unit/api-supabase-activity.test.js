// The Supabase store's session-activity methods, against a stand-in client that
// records each call: they go through the SQL functions, a page at a time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../../src/api/supabase-store.js'

// A stand-in supabase client. `answer(call)` gives each query's rows; every call is kept.
function fakeClient (answer = () => []) {
  const calls = []
  const chain = (call) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res, rej) => Promise.resolve({ data: answer(call), error: null }).then(res, rej)
      return (...args) => { call.ops.push([op, ...args]); return chain(call) }
    }
  })
  const client = {
    from (table) { const call = { table, ops: [] }; calls.push(call); return chain(call) },
    rpc (fn, args) { const call = { rpc: fn, args, ops: [] }; calls.push(call); return chain(call) },
    auth: { admin: { deleteUser: async (id) => { calls.push({ deletedUser: id }); return { error: null } } } }
  }
  return { client, calls }
}

test('ingestPresence hands the events to ingest_presence with the time they arrived', async () => {
  const { client, calls } = fakeClient(() => 2)
  const s = createSupabaseStore({ client })
  const events = [{ id: 'e1', type: 'start', room: 'r1', account: 'person:u1', name: 'Dana', at: 1000 }]
  assert.equal(await s.ingestPresence(events, Date.parse('2026-10-02T00:00:00Z')), 2)
  assert.deepEqual(calls[0], { rpc: 'ingest_presence', args: { p_events: events, p_received_at: '2026-10-02T00:00:00.000Z' }, ops: [] })
})

test('visits are read a page of 1000 at a time until a short page', async () => {
  const row = (i) => ({ id: `v${i}`, event_start_id: `e${i}`, room: 'r1', account: 'person:u1', account_name: 'Dana', kind: 'person', started_at: '2026-10-01T00:00:00Z', ended_at: null })
  const { client, calls } = fakeClient((call) => {
    const [, from] = call.ops.find(([op]) => op === 'range')
    return Array.from({ length: from === 0 ? 1000 : 3 }, (_, i) => row(from + i))
  })
  const s = createSupabaseStore({ client })
  const visits = await s.visitsInRooms(['r1'])
  assert.equal(visits.length, 1003)
  assert.deepEqual(calls.map((c) => [c.rpc, c.args.p_rooms, c.ops]), [
    ['visits_in_rooms', ['r1'], [['range', 0, 999]]],
    ['visits_in_rooms', ['r1'], [['range', 1000, 1999]]]
  ])
  assert.deepEqual([visits[0].eventStartId, visits[0].accountName, visits[0].startedAt, visits[0].endedAt], ['e0', 'Dana', Date.parse('2026-10-01T00:00:00Z'), null])
  assert.deepEqual(await s.visitsInRooms([]), [], 'no rooms, no query')
  assert.equal(calls.length, 2)
})

test('accountSessions, renameSession and pruneActivity call their functions with ISO times', async () => {
  const { client, calls } = fakeClient((call) => (call.rpc === 'account_sessions' ? [{ room: 'r1', name: 'x', owner_account: null, created_at: '2026-10-01T00:00:00Z', last_active_at: '2026-10-01T00:00:00Z', renamed_at: null }] : { room: 'r1', name: 'New', renamed_at: '2026-10-02T00:00:00Z' }))
  const s = createSupabaseStore({ client })
  const [row] = await s.accountSessions('person:u1', { since: Date.parse('2026-09-28T00:00:00Z'), limit: 100 })
  assert.equal(row.lastActiveAt, Date.parse('2026-10-01T00:00:00Z'))
  assert.deepEqual(calls[0].args, { p_account: 'person:u1', p_since: '2026-09-28T00:00:00.000Z', p_limit: 100 })
  await s.renameSession('r1', 'New', Date.parse('2026-10-02T00:00:00Z'))
  assert.equal(calls[1].table, 'relay_sessions')
  assert.deepEqual(calls[1].ops[0], ['update', { name: 'New', renamed_at: '2026-10-02T00:00:00.000Z' }])
  assert.deepEqual(calls[1].ops[1], ['eq', 'room', 'r1'])
  await s.pruneActivity({ before: 0, seenBefore: 1000 })
  assert.deepEqual(calls[2], { rpc: 'prune_activity', args: { p_before: '1970-01-01T00:00:00.000Z', p_seen_before: '1970-01-01T00:00:01.000Z' }, ops: [] })
})

test("deleting a user removes its activity and its agents' before the auth user", async () => {
  const { client, calls } = fakeClient((call) => (call.table === 'agents' ? [{ id: 'a1' }, { id: 'a2' }] : null))
  const s = createSupabaseStore({ client })
  await s.deleteUser('u1')
  assert.deepEqual(calls[0].ops, [['select', 'id'], ['eq', 'owner_user_id', 'u1']])
  // delete_account_access (access types and grants) goes first; see api-supabase-access.test.js.
  assert.deepEqual([calls[2].rpc, calls[2].args], ['delete_account_activity', { p_accounts: ['person:u1', 'agent:a1', 'agent:a2'] }])
  assert.deepEqual(calls[3], { deletedUser: 'u1' })
})
