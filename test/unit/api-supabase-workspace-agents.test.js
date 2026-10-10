import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../../src/api/supabase-store.js'

// A client that records every call and answers with canned rows, keyed by table (see api-supabase-workspaces.test.js).
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

test('putAgentPlacement upserts the agent_placements columns, keyed on agent_id', async () => {
  const row = { agent_id: 'a1', reach: 'workspaces', workspace_ids: ['w1'], sessions: 'all', access: 'edit', scopes: ['src'], updated_by: 'person:u1', updated_at: '2026-10-07T00:00:00.000Z' }
  const client = fakeClient({ agent_placements: { data: row, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.putAgentPlacement({ agentId: 'a1', reach: 'workspaces', workspaceIds: ['w1'], sessions: 'all', access: 'edit', scopes: ['src'], updatedBy: 'person:u1' })
  const [payload, opts] = client.calls[0].ops.find(([op]) => op === 'upsert')[1]
  assert.equal(payload.agent_id, 'a1')
  assert.deepEqual([payload.reach, payload.workspace_ids, payload.sessions, payload.access, payload.scopes, payload.updated_by], ['workspaces', ['w1'], 'all', 'edit', ['src'], 'person:u1'])
  assert.deepEqual(opts, { onConflict: 'agent_id' })
  assert.deepEqual([out.agentId, out.reach, out.workspaceIds, out.updatedAt], ['a1', 'workspaces', ['w1'], Date.parse(row.updated_at)])
})

test('listAgentPlacements filters agent_placements by agent_id in()', async () => {
  const client = fakeClient({ agent_placements: { data: [], error: null } })
  await createSupabaseStore({ client }).listAgentPlacements(['a1', 'a2'])
  assert.ok(client.calls[0].ops.some(([op, args]) => op === 'in' && args[0] === 'agent_id' && JSON.stringify(args[1]) === JSON.stringify(['a1', 'a2'])))
})

test('workspaceAgentOverride: put upserts on (workspace_id, agent_id); delete answers whether a row went', async () => {
  const row = { workspace_id: 'w1', agent_id: 'a1', sessions: 'all', excluded: false }
  const client = fakeClient({ workspace_agent_overrides: { data: row, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.putWorkspaceAgentOverride({ workspaceId: 'w1', agentId: 'a1', sessions: 'all' })
  const [payload, opts] = client.calls[0].ops.find(([op]) => op === 'upsert')[1]
  assert.deepEqual(payload, { workspace_id: 'w1', agent_id: 'a1', sessions: 'all', excluded: false })
  assert.deepEqual(opts, { onConflict: 'workspace_id,agent_id' })
  assert.deepEqual([out.workspaceId, out.agentId, out.sessions], ['w1', 'a1', 'all'])
  const gone = fakeClient({ workspace_agent_overrides: { data: [{ agent_id: 'a1' }], error: null } })
  assert.equal(await createSupabaseStore({ client: gone }).deleteWorkspaceAgentOverride('w1', 'a1'), true)
  const notThere = fakeClient({ workspace_agent_overrides: { data: [], error: null } })
  assert.equal(await createSupabaseStore({ client: notThere }).deleteWorkspaceAgentOverride('w1', 'a1'), false)
})

test('session agent exclusions: upsert on (room, agent_id); sessionAgentExcluded answers true or false', async () => {
  const row = { room: 'r1', agent_id: 'a1', excluded_by: 'person:u1', created_at: '2026-10-07T00:00:00.000Z' }
  const client = fakeClient({ session_agent_exclusions: { data: row, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.addSessionAgentExclusion({ room: 'r1', agentId: 'a1', excludedBy: 'person:u1' })
  const [payload, opts] = client.calls[0].ops.find(([op]) => op === 'upsert')[1]
  assert.deepEqual(payload, { room: 'r1', agent_id: 'a1', excluded_by: 'person:u1' })
  assert.deepEqual(opts, { onConflict: 'room,agent_id' })
  assert.deepEqual([out.room, out.agentId, out.excludedBy], ['r1', 'a1', 'person:u1'])
  const found = fakeClient({ session_agent_exclusions: { data: { agent_id: 'a1' }, error: null } })
  assert.equal(await createSupabaseStore({ client: found }).sessionAgentExcluded('r1', 'a1'), true)
  const notFound = fakeClient({ session_agent_exclusions: { data: null, error: null } })
  assert.equal(await createSupabaseStore({ client: notFound }).sessionAgentExcluded('r1', 'a1'), false)
})

test('agent webhook upserts on agent_id; delete answers whether a row went', async () => {
  const row = { agent_id: 'a1', url: 'https://example.com/hook', secret: 's1', created_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z' }
  const client = fakeClient({ agent_webhooks: { data: row, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.putAgentWebhook({ agentId: 'a1', url: 'https://example.com/hook', secret: 's1' })
  const [payload, opts] = client.calls[0].ops.find(([op]) => op === 'upsert')[1]
  assert.deepEqual([payload.agent_id, payload.url, payload.secret], ['a1', 'https://example.com/hook', 's1'])
  assert.deepEqual(opts, { onConflict: 'agent_id' })
  assert.equal(out.secret, 's1')
  const deleted = fakeClient({ agent_webhooks: { data: [{ agent_id: 'a1' }], error: null } })
  assert.equal(await createSupabaseStore({ client: deleted }).deleteAgentWebhook('a1'), true)
  const none = fakeClient({ agent_webhooks: { data: [], error: null } })
  assert.equal(await createSupabaseStore({ client: none }).deleteAgentWebhook('a1'), false)
})

test('listOrgAgents filters by org_id and only live (not revoked) agents', async () => {
  const client = fakeClient({ agents: { data: [], error: null } })
  await createSupabaseStore({ client }).listOrgAgents('o1')
  const ops = client.calls[0].ops
  assert.ok(ops.some(([op, args]) => op === 'eq' && args[0] === 'org_id' && args[1] === 'o1'))
  assert.ok(ops.some(([op, args]) => op === 'is' && args[0] === 'revoked_at' && args[1] === null))
})

test('putWorkspaceMember writes sessions only when given, so an upsert that omits it never resets it', async () => {
  const row = { workspace_id: 'w1', account: 'agent:a1', access: 'edit', added_by: 'person:u1', sessions: 'invited', added_at: '2026-10-07T00:00:00.000Z' }
  const client = fakeClient({ workspace_members: { data: row, error: null } })
  const store = createSupabaseStore({ client })
  await store.putWorkspaceMember({ workspaceId: 'w1', account: 'agent:a1', access: 'edit', addedBy: 'person:u1' })
  const [payload] = client.calls[0].ops.find(([op]) => op === 'upsert')[1]
  assert.ok(!('sessions' in payload), 'omitted: never written, so the existing value survives the conflict update')
  await store.putWorkspaceMember({ workspaceId: 'w1', account: 'agent:a1', access: 'edit', addedBy: 'person:u1', sessions: 'all' })
  const [payload2] = client.calls[1].ops.find(([op]) => op === 'upsert')[1]
  assert.equal(payload2.sessions, 'all')
})

test('agent invites select and insert carry the workspace fields', async () => {
  const row = {
    id: 'i1',
    token_hash: 'h',
    owner_user_id: null,
    org_id: 'o1',
    created_by: 'u1',
    role_id: null,
    teams: [],
    expires_at: '2026-10-07T00:00:00.000Z',
    used_at: null,
    used_by_agent_id: null,
    cancelled_at: null,
    created_at: '2026-10-07T00:00:00.000Z',
    workspace_id: 'w1',
    workspace_access: 'edit',
    workspace_sessions: 'all'
  }
  const client = fakeClient({ agent_invites: { data: row, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.createAgentInvite({ tokenHash: 'h', orgId: 'o1', createdBy: 'u1', expiresAt: Date.parse(row.expires_at), workspaceId: 'w1', workspaceAccess: 'edit', workspaceSessions: 'all' })
  const ins = client.calls[0].ops.find(([op]) => op === 'insert')[1][0]
  assert.deepEqual([ins.workspace_id, ins.workspace_access, ins.workspace_sessions], ['w1', 'edit', 'all'])
  assert.deepEqual([out.workspaceId, out.workspaceAccess, out.workspaceSessions], ['w1', 'edit', 'all'])
  const sel = client.calls[0].ops.find(([op]) => op === 'select')[1][0]
  assert.ok(sel.includes('workspace_id') && sel.includes('workspace_access') && sel.includes('workspace_sessions'))
})

test('agent invites select global, and a global invite inserts it', async () => {
  const row = { id: 'i2', token_hash: 'h', owner_user_id: 'u1', org_id: null, created_by: 'u1', role_id: null, teams: [], expires_at: '2026-10-08T00:00:00.000Z', used_at: null, used_by_agent_id: null, cancelled_at: null, created_at: '2026-10-08T00:00:00.000Z', workspace_id: null, workspace_access: null, workspace_sessions: null, global: true }
  const client = fakeClient({ agent_invites: { data: row, error: null } })
  const store = createSupabaseStore({ client })
  const out = await store.createAgentInvite({ tokenHash: 'h', ownerUserId: 'u1', createdBy: 'u1', expiresAt: Date.parse(row.expires_at), global: true })
  assert.equal(client.calls[0].ops.find(([op]) => op === 'insert')[1][0].global, true)
  assert.equal(out.global, true)
  assert.ok(client.calls[0].ops.find(([op]) => op === 'select')[1][0].split(', ').includes('global'))
  // A plain invite sends no global at all (the column's default), as before.
  const plain = fakeClient({ agent_invites: { data: { ...row, global: false }, error: null } })
  await createSupabaseStore({ client: plain }).createAgentInvite({ tokenHash: 'h', ownerUserId: 'u1', createdBy: 'u1', expiresAt: Date.parse(row.expires_at) })
  assert.equal('global' in plain.calls[0].ops.find(([op]) => op === 'insert')[1][0], false)
})
