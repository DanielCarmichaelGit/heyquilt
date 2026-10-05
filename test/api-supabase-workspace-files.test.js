import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'

// Records every call; answers come from `answers[table or rpc]`. Same shape as api-supabase-workspaces.test.js.
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

test('createWorkspaceFile inserts snake_case columns and maps the row back', async () => {
  const row = { id: 'f1', workspace_id: 'w1', path: 'a.txt', kind: 'file', size: 0, mime: 'text/plain', sha256: '', version: 1, object_key: 'w1/f1/1', note: '', uploaded_by: 'person:u1', uploaded_at: '2026-10-05T00:00:00.000Z', confirmed_at: null, deleted_at: null }
  const client = fakeClient({ workspace_files: { data: row, error: null } })
  const out = await createSupabaseStore({ client }).createWorkspaceFile({ workspaceId: 'w1', path: 'a.txt', kind: 'file', mime: 'text/plain', objectKey: 'w1/f1/1', uploadedBy: 'person:u1' })
  const ins = client.calls[0].ops.find(([op]) => op === 'insert')[1][0]
  assert.deepEqual(ins, { workspace_id: 'w1', path: 'a.txt', kind: 'file', size: 0, mime: 'text/plain', sha256: '', object_key: 'w1/f1/1', note: '', uploaded_by: 'person:u1' })
  assert.deepEqual([out.id, out.workspaceId, out.objectKey, out.uploadedAt, out.confirmedAt], ['f1', 'w1', 'w1/f1/1', Date.parse(row.uploaded_at), null])
})

test('newWorkspaceFileVersion and sweep go through service-role functions', async () => {
  const client = fakeClient({ new_workspace_file_version: { data: { file: { id: 'f1', version: 2 }, dropped_keys: ['w1/f1/1'] }, error: null }, sweep_deleted_workspace_files: { data: ['w1/a/1'], error: null } })
  const store = createSupabaseStore({ client })
  const r = await store.newWorkspaceFileVersion('f1', { size: 3, mime: 'text/plain', sha256: 's', objectKey: 'w1/f1/2', note: 'n', uploadedBy: 'person:u2', at: Date.parse('2026-10-05T00:00:00.000Z') })
  assert.deepEqual(client.calls[0], { rpc: 'new_workspace_file_version', args: { p_id: 'f1', p_size: 3, p_mime: 'text/plain', p_sha256: 's', p_object_key: 'w1/f1/2', p_note: 'n', p_uploaded_by: 'person:u2', p_at: '2026-10-05T00:00:00.000Z', p_keep: 10 } })
  assert.deepEqual(r, { file: { id: 'f1', version: 2 }, droppedKeys: ['w1/f1/1'] })
  assert.deepEqual(await store.sweepDeletedWorkspaceFiles(Date.parse('2026-10-05T00:00:00.000Z')), ['w1/a/1'])
  assert.deepEqual(client.calls[1], { rpc: 'sweep_deleted_workspace_files', args: { p_before: '2026-10-05T00:00:00.000Z' } })
})

test('setWorkspaceFileObjectKey updates the row, revertWorkspaceFileVersion goes through its service-role function', async () => {
  const updated = { id: 'f1', workspace_id: 'w1', path: 'a.txt', kind: 'file', size: 0, mime: 'text/plain', sha256: '', version: 1, object_key: 'w1/f1/2', note: '', uploaded_by: 'person:u1', uploaded_at: '2026-10-05T00:00:00.000Z', confirmed_at: null, deleted_at: null }
  const reverted = { ...updated, object_key: 'w1/f1/1', version: 1, confirmed_at: '2026-10-05T00:00:00.000Z' }
  const client = fakeClient({ workspace_files: { data: updated, error: null }, revert_workspace_file_version: { data: reverted, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.setWorkspaceFileObjectKey('f1', 'w1/f1/2')
  assert.deepEqual(client.calls[0].ops.find(([op]) => op === 'update')[1][0], { object_key: 'w1/f1/2' })
  assert.equal(out.objectKey, 'w1/f1/2')
  const r = await store.revertWorkspaceFileVersion('f1')
  assert.deepEqual(client.calls[1], { rpc: 'revert_workspace_file_version', args: { p_id: 'f1' } })
  assert.deepEqual([r.id, r.objectKey, r.confirmedAt], ['f1', 'w1/f1/1', Date.parse(reverted.confirmed_at)])
})
