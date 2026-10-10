import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../../src/api/supabase-store.js'

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

test('setSessionWorkspace upserts the session row with who linked it, never its owner', async () => {
  const client = fakeClient({ set_session_workspace: { data: { room: 'r', name: '', owner_account: null, created_at: '2026-10-04T00:00:00.000Z', last_active_at: '2026-10-04T00:00:00.000Z', renamed_at: null, workspace_id: 'w1', workspace_linked_by: 'person:u1' }, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.setSessionWorkspace('r', 'w1', { linkedBy: 'person:u1', at: Date.parse('2026-10-04T00:00:00.000Z') })
  assert.deepEqual([out.workspaceId, out.workspaceLinkedBy, out.ownerAccount], ['w1', 'person:u1', null])
  assert.deepEqual(client.calls[0], { rpc: 'set_session_workspace', args: { p_room: 'r', p_workspace: 'w1', p_linked_by: 'person:u1', p_at: '2026-10-04T00:00:00.000Z' } })
  await store.setSessionWorkspace('r', null, { linkedBy: null, at: Date.parse('2026-10-04T00:00:00.000Z') })
  assert.deepEqual(client.calls[1].args, { p_room: 'r', p_workspace: null, p_linked_by: null, p_at: '2026-10-04T00:00:00.000Z' })
})

test('session reads carry who linked the room', async () => {
  const client = fakeClient()
  await createSupabaseStore({ client }).sessionByRoom('r')
  assert.ok(client.calls[0].ops.find(([op]) => op === 'select')[1][0].split(', ').includes('workspace_linked_by'))
})

test('deleteWorkspace calls the service-role function', async () => {
  const client = fakeClient()
  await createSupabaseStore({ client }).deleteWorkspace('w1')
  assert.deepEqual(client.calls[0], { rpc: 'delete_workspace', args: { p_id: 'w1' } })
})

test('workspace invites: insert after clearing that key\'s expired ones; answering is check-and-set', async () => {
  const row = { id: 'i1', workspace_id: 'w1', email: 'pat@x.com', account: null, account_name: '', access: 'edit', invited_by: 'person:u1', created_at: '2026-10-09T00:00:00Z', expires_at: '2026-10-16T00:00:00Z', accepted_at: null, accepted_by: null, declined_at: null, cancelled_at: null }
  const client = fakeClient({ workspace_invites: { data: row, error: null } })
  const store = createSupabaseStore({ client })
  const i = await store.createWorkspaceInvite({ workspaceId: 'w1', email: 'Pat@X.com', access: 'edit', invitedBy: 'person:u1', expiresAt: Date.parse('2026-10-16T00:00:00Z'), at: Date.parse('2026-10-09T00:00:00Z') })
  assert.deepEqual(client.calls[0].ops.map(([op]) => op), ['delete', 'eq', 'eq', 'is', 'is', 'is', 'lte'])
  assert.deepEqual(client.calls[1].ops.find(([op]) => op === 'insert')[1][0], { workspace_id: 'w1', email: 'pat@x.com', account: null, account_name: '', access: 'edit', invited_by: 'person:u1', expires_at: '2026-10-16T00:00:00.000Z' })
  assert.deepEqual([i.workspaceId, i.expiresAt, i.acceptedAt], ['w1', Date.parse('2026-10-16T00:00:00Z'), null])

  const answer = fakeClient({ workspace_invites: { data: [{ id: 'i1' }], error: null } })
  assert.equal(await createSupabaseStore({ client: answer }).answerWorkspaceInvite('i1', 'accepted', 'person:u2'), true)
  const ops = answer.calls[0].ops
  const patch = ops.find(([op]) => op === 'update')[1][0]
  assert.deepEqual([Object.keys(patch).sort(), patch.accepted_by], [['accepted_at', 'accepted_by'], 'person:u2'])
  assert.deepEqual(ops.filter(([op]) => op === 'is').map(([, [col]]) => col), ['accepted_at', 'declined_at', 'cancelled_at'])
  await assert.rejects(createSupabaseStore({ client: answer }).answerWorkspaceInvite('i1', 'deleted'))
})
