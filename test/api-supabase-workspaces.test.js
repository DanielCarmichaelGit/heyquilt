import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'

// A client that records every call and answers with canned rows (see api-supabase-access.test.js for the shape).
function fakeClient (answers = {}) {
  const calls = []
  const chain = (table) => {
    const c = { table, ops: [] }
    const q = new Proxy({}, {
      get (_, name) {
        if (name === 'then') return (res, rej) => Promise.resolve(answers[table] ?? { data: null, error: null }).then(res, rej)
        return (...args) => { c.ops.push([name, args]); return q }
      }
    })
    calls.push(c)
    return q
  }
  return { calls, from: (t) => chain(t), rpc: (name, args) => { calls.push({ rpc: name, args }); return Promise.resolve(answers[name] ?? { data: null, error: null }) } }
}

test('createWorkspace inserts snake_case columns and maps the row back', async () => {
  const row = { id: 'w1', owner_user_id: 'u1', org_id: null, name: 'Launch', description: '', color: 'mint', created_by: 'person:u1', created_at: '2026-10-04T00:00:00.000Z', archived_at: null }
  const client = fakeClient({ workspaces: { data: row, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.createWorkspace({ ownerUserId: 'u1', name: 'Launch', color: 'mint', createdBy: 'person:u1' })
  const ins = client.calls[0].ops.find(([op]) => op === 'insert')[1][0]
  assert.deepEqual(ins, { owner_user_id: 'u1', org_id: null, name: 'Launch', description: '', color: 'mint', created_by: 'person:u1' })
  assert.deepEqual([out.id, out.ownerUserId, out.createdAt, out.archivedAt], ['w1', 'u1', Date.parse(row.created_at), null])
})

test('setSessionWorkspace upserts the session row without touching the owner of an existing one', async () => {
  const client = fakeClient({ set_session_workspace: { data: { room: 'r', name: '', owner_account: 'person:u1', created_at: '2026-10-04T00:00:00.000Z', last_active_at: '2026-10-04T00:00:00.000Z', renamed_at: null, workspace_id: 'w1' }, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.setSessionWorkspace('r', 'w1', { ownerAccount: 'person:u1', at: Date.parse('2026-10-04T00:00:00.000Z') })
  assert.equal(out.workspaceId, 'w1')
  assert.deepEqual(client.calls[0], { rpc: 'set_session_workspace', args: { p_room: 'r', p_workspace: 'w1', p_owner: 'person:u1', p_at: '2026-10-04T00:00:00.000Z' } })
})

test('deleteWorkspace calls the service-role function', async () => {
  const client = fakeClient()
  await createSupabaseStore({ client }).deleteWorkspace('w1')
  assert.deepEqual(client.calls[0], { rpc: 'delete_workspace', args: { p_id: 'w1' } })
})
