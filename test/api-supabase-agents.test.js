import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'

const ISO = '2026-09-30T00:00:00.000Z'
// A stand-in supabase client: records every query (the table plus the chain of
// calls on it) and answers each with answer(query).
function fakeDb (answer = () => null) {
  const calls = []
  const chain = (q) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res, rej) => Promise.resolve({ data: answer(q), error: null }).then(res, rej)
      return (...args) => { q.ops.push([op, ...args]); return chain(q) }
    }
  })
  const client = { from (table) { const q = { table, ops: [] }; calls.push(q); return chain(q) } }
  return { client, calls }
}
const has = (q, ...call) => q.ops.some((c) => JSON.stringify(c) === JSON.stringify(call))
const agentRow = { id: 'a1', name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: '', public_key: null, owner_user_id: 'u1', org_id: null, invited_by: 'u1', created_at: ISO, last_used_at: null, revoked_at: null }

test('supabase createAgent writes the profile and home, and selects no secrets', async () => {
  const { client, calls } = fakeDb(() => agentRow)
  const a = await createSupabaseStore({ client }).createAgent({ name: 'Larry', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u1', invitedBy: 'u1' })
  assert.deepEqual([a.id, a.provider, a.ownerUserId, a.orgId, a.createdAt], ['a1', 'Anthropic', 'u1', null, Date.parse(ISO)])
  assert.deepEqual(calls[0].ops.find(([op]) => op === 'insert')[1], { name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: '', public_key: null, resume_hash: null, owner_user_id: 'u1', org_id: null, invited_by: 'u1' })
  assert.equal(calls[0].ops.find(([op]) => op === 'select')[1], 'id, name, provider, type, description, public_key, owner_user_id, org_id, invited_by, created_at, last_used_at, revoked_at')
})

test('supabase agentByResume looks the agent up by the hash and selects no secrets', async () => {
  const { client, calls } = fakeDb(() => agentRow)
  const a = await createSupabaseStore({ client }).agentByResume('h1')
  assert.equal(a.id, 'a1')
  assert.ok(has(calls[0], 'eq', 'resume_hash', 'h1'))
  assert.equal(calls[0].ops.find(([op]) => op === 'select')[1].includes('resume'), false)
})

test("supabase listPersonalAgents reads only the person's live agents; agentByPublicKey skips empty keys", async () => {
  const { client, calls } = fakeDb(() => [agentRow])
  const s = createSupabaseStore({ client })
  const [a] = await s.listPersonalAgents('u1')
  assert.equal(a.name, 'Larry')
  assert.ok(has(calls[0], 'eq', 'owner_user_id', 'u1'))
  assert.ok(has(calls[0], 'is', 'revoked_at', null))
  assert.equal(await s.agentByPublicKey(null), null)
  assert.equal(calls.length, 1, 'no query for an empty key')
})

test('supabase revokeAgent revokes the agent once, then every key it holds', async () => {
  const { client, calls } = fakeDb((q) => (q.table === 'agents' ? [{ id: 'a1' }] : null))
  assert.equal(await createSupabaseStore({ client }).revokeAgent('a1'), true)
  assert.deepEqual(calls.map((c) => c.table), ['agents', 'agent_keys'])
  assert.ok(has(calls[0], 'is', 'revoked_at', null))
  assert.ok(has(calls[1], 'eq', 'agent_id', 'a1'))
  assert.ok(has(calls[1], 'is', 'revoked_at', null))
  assert.equal(await createSupabaseStore({ client: fakeDb(() => []).client }).revokeAgent('a1'), false)
})

test('supabase addAgentMember and memberByAgent work on agent_id', async () => {
  const row = { id: 'm2', org_id: 'o1', user_id: null, agent_id: 'a1', role_id: null, joined_at: ISO }
  const { client, calls } = fakeDb(() => row)
  const s = createSupabaseStore({ client })
  const m = await s.addAgentMember({ orgId: 'o1', agentId: 'a1' })
  assert.deepEqual([m.id, m.agentId, m.roleId], ['m2', 'a1', null])
  assert.deepEqual(calls[0].ops.find(([op]) => op === 'insert')[1], { org_id: 'o1', agent_id: 'a1', role_id: null })
  await s.memberByAgent('o1', 'a1')
  assert.ok(has(calls[1], 'eq', 'org_id', 'o1'))
  assert.ok(has(calls[1], 'eq', 'agent_id', 'a1'))
})

test('supabase member lists name agents from the agents table, with their profile', async () => {
  const { client, calls } = fakeDb((q) => q.table === 'org_members'
    ? [{ id: 'm2', org_id: 'o1', user_id: null, agent_id: 'a1', role_id: null, joined_at: ISO, profiles: null, agents: { name: 'Bot', provider: 'OpenAI', type: 'coding agent' } }]
    : [{ team_id: 't1', member_id: 'm2', access: 'viewer', scopes: ['src'], added_at: ISO, org_members: { user_id: null, agent_id: 'a1', profiles: null, agents: { name: 'Bot' } } }])
  const s = createSupabaseStore({ client })
  const [m] = await s.listMembers('o1')
  assert.deepEqual([m.name, m.provider, m.type, m.agentId, 'agents' in m, 'profiles' in m], ['Bot', 'OpenAI', 'coding agent', 'a1', false, false])
  assert.match(calls[0].ops.find(([op]) => op === 'select')[1], /agents \(name, provider, type, public_key\)/)
  const [tm] = await s.listTeamMembers('t1')
  assert.deepEqual([tm.name, tm.kind, tm.scopes], ['Bot', 'agent', ['src']])
})

test('supabase agent invites: ISO expiry, filtered lists, and check-and-set claim and cancel', async () => {
  const row = { id: 'i1', token_hash: 'h', owner_user_id: 'u1', org_id: null, created_by: 'u1', role_id: null, teams: [], expires_at: ISO, used_at: null, used_by_agent_id: null, cancelled_at: null, created_at: ISO }
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'update') ? [{ id: 'i1' }] : q.ops.some(([op]) => op === 'limit') ? [row] : row))
  const s = createSupabaseStore({ client })
  const made = await s.createAgentInvite({ tokenHash: 'h', ownerUserId: 'u1', createdBy: 'u1', expiresAt: Date.parse(ISO) })
  assert.deepEqual([made.expiresAt, made.usedAt, made.teams], [Date.parse(ISO), null, []])
  assert.equal(calls[0].ops.find(([op]) => op === 'insert')[1].expires_at, ISO)
  await s.agentInviteByToken('h')
  assert.ok(has(calls[1], 'eq', 'token_hash', 'h'))
  await s.listAgentInvites({ orgId: 'o1' })
  assert.ok(has(calls[2], 'eq', 'org_id', 'o1'))
  assert.ok(has(calls[2], 'order', 'created_at', { ascending: false }))
  assert.ok(has(calls[2], 'limit', 50))
  await s.listAgentInvites({ ownerUserId: 'u1' })
  assert.ok(has(calls[3], 'eq', 'owner_user_id', 'u1'))
  assert.equal(await s.claimAgentInvite('i1'), true)
  assert.ok(has(calls[4], 'is', 'used_at', null))
  assert.ok(has(calls[4], 'is', 'cancelled_at', null))
  assert.ok(calls[4].ops.some(([op, col]) => op === 'gt' && col === 'expires_at'), 'only while unexpired')
  assert.equal(await s.cancelAgentInvite('i1'), true)
  assert.ok(has(calls[5], 'is', 'used_at', null))
  assert.ok(has(calls[5], 'is', 'cancelled_at', null))
  assert.ok(calls[5].ops.some(([op, col]) => op === 'gt' && col === 'expires_at'), 'only a waiting invite is cancelled')
  await s.releaseAgentInvite('i1')
  assert.ok(has(calls[6], 'update', { used_at: null, used_by_agent_id: null }))
  await s.setInviteAgent('i1', 'a1')
  assert.ok(has(calls[7], 'update', { used_by_agent_id: 'a1' }))
})

test('supabase agent keys: ISO expiries, a refresh spent once, a family revoked together', async () => {
  const key = { id: 'k1', agent_id: 'a1', family_id: 'f1', access_hash: 'ah', refresh_hash: 'rh', access_expires_at: ISO, refresh_expires_at: ISO, refreshed_at: null, revoked_at: null, created_at: ISO }
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'update') ? [{ id: 'k1' }] : key))
  const s = createSupabaseStore({ client })
  const k = await s.createAgentKeys({ agentId: 'a1', familyId: 'f1', accessHash: 'ah', refreshHash: 'rh', accessExpiresAt: Date.parse(ISO), refreshExpiresAt: Date.parse(ISO) })
  assert.deepEqual([k.accessExpiresAt, k.refreshedAt], [Date.parse(ISO), null])
  const insert = calls[0].ops.find(([op]) => op === 'insert')[1]
  assert.deepEqual([insert.access_expires_at, insert.refresh_expires_at, insert.family_id], [ISO, ISO, 'f1'])
  await s.agentKeyByAccess('ah')
  assert.ok(has(calls[1], 'eq', 'access_hash', 'ah'))
  await s.agentKeyByRefresh('rh')
  assert.ok(has(calls[2], 'eq', 'refresh_hash', 'rh'))
  assert.equal(await s.claimRefresh('k1'), true)
  assert.ok(has(calls[3], 'is', 'refreshed_at', null))
  assert.ok(has(calls[3], 'is', 'revoked_at', null))
  await s.revokeFamily('f1')
  assert.ok(has(calls[4], 'eq', 'family_id', 'f1'))
  assert.ok(has(calls[4], 'is', 'revoked_at', null))
  await s.releaseRefresh('k1')
  assert.ok(has(calls[5], 'update', { refreshed_at: null }))
  assert.ok(has(calls[5], 'eq', 'id', 'k1'))
  assert.ok(has(calls[5], 'is', 'revoked_at', null))
})

test('supabase setTeamAccess changes folders only when given; teamsOfMember returns them', async () => {
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'update')
    ? { team_id: 't1', member_id: 'm1', access: 'viewer', scopes: ['src'], added_at: ISO }
    : [{ team_id: 't1', access: 'viewer', scopes: ['src'] }]))
  const s = createSupabaseStore({ client })
  await s.setTeamAccess('t1', 'm1', 'viewer')
  assert.ok(has(calls[0], 'update', { access: 'viewer' }))
  await s.setTeamAccess('t1', 'm1', 'viewer', ['src'])
  assert.ok(has(calls[1], 'update', { access: 'viewer', scopes: ['src'] }))
  assert.deepEqual(await s.teamsOfMember('m1'), [{ teamId: 't1', access: 'viewer', scopes: ['src'] }])
})
