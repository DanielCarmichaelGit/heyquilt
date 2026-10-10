import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../../src/api/supabase-store.js'
import { BUILTIN } from '../../src/api/permissions.js'

const ISO = '2026-09-30T00:00:00.000Z'
// A stand-in supabase client: records every query (a table or an rpc, plus the
// chain of calls on it) and answers each with answer(query).
function fakeDb (answer = () => null) {
  const calls = []
  const chain = (q) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res, rej) => Promise.resolve({ data: answer(q), error: null }).then(res, rej)
      return (...args) => { q.ops.push([op, ...args]); return chain(q) }
    }
  })
  const users = {
    u1: { id: 'u1', email: 'dana@acme.com', email_confirmed_at: ISO },
    u2: { id: 'u2', email: 'eli@acme.com', email_confirmed_at: null }
  }
  const client = {
    from (table) { const q = { table, ops: [] }; calls.push(q); return chain(q) },
    rpc (fn, args) { const q = { rpc: fn, args, ops: [] }; calls.push(q); return chain(q) },
    auth: {
      admin: {
        getUserById: async (id) => users[id]
          ? { data: { user: users[id] }, error: null }
          : { data: { user: null }, error: { status: 404, message: 'User not found' } }
      }
    }
  }
  return { client, calls }
}
const has = (q, ...call) => q.ops.some((c) => JSON.stringify(c) === JSON.stringify(call))
const orgRow = (id, name) => ({ id, name, slug: name.toLowerCase(), owner_id: 'u1', domain: null, domain_requests: false, created_at: ISO })

test('supabase userEmail reads the auth user; unknown people are null', async () => {
  const s = createSupabaseStore({ client: fakeDb().client })
  assert.deepEqual(await s.userEmail('u1'), { email: 'dana@acme.com', confirmed: true })
  assert.deepEqual(await s.userEmail('u2'), { email: 'eli@acme.com', confirmed: false })
  assert.equal(await s.userEmail('u3'), null)
})

test('supabase createOrg and transferOrg go through the one-transaction functions', async () => {
  const { client, calls } = fakeDb((q) => (q.rpc === 'create_org' ? orgRow('o1', 'Acme') : null))
  const s = createSupabaseStore({ client })
  const org = await s.createOrg({ name: 'Acme', slug: 'acme', ownerId: 'u1', grants: BUILTIN })
  assert.deepEqual(calls[0].args, { p_name: 'Acme', p_slug: 'acme', p_owner: 'u1', p_owner_grants: BUILTIN.owner, p_admin_grants: BUILTIN.admin, p_member_grants: BUILTIN.member, p_first: false })
  assert.deepEqual([org.id, org.ownerId, org.domainRequests, org.createdAt], ['o1', 'u1', false, Date.parse(ISO)])
  await s.transferOrg('o1', 'u1', 'u2')
  assert.deepEqual([calls[1].rpc, calls[1].args], ['transfer_org', { p_org: 'o1', p_from: 'u1', p_to: 'u2' }])
})

test('supabase createOrg passes p_first through for first-org sign-ups', async () => {
  const { client, calls } = fakeDb((q) => (q.rpc === 'create_org' ? orgRow('o1', 'Acme') : null))
  const s = createSupabaseStore({ client })
  await s.createOrg({ name: 'Acme', slug: 'acme', ownerId: 'u1', grants: BUILTIN, first: true })
  assert.equal(calls[0].args.p_first, true)
})

test('supabase orgsForUser flattens the embedded org and sorts by name', async () => {
  const { client, calls } = fakeDb(() => [{ role_id: 'r2', orgs: orgRow('o2', 'Zeta') }, { role_id: 'r1', orgs: orgRow('o1', 'Acme') }])
  const s = createSupabaseStore({ client })
  const list = await s.orgsForUser('u1')
  assert.deepEqual(list.map((o) => [o.name, o.roleId]), [['Acme', 'r1'], ['Zeta', 'r2']])
  assert.ok(has(calls[0], 'eq', 'user_id', 'u1'))
})

test('supabase listMembers flattens the embedded profile name', async () => {
  const { client } = fakeDb(() => [{ id: 'm1', org_id: 'o1', user_id: 'u1', agent_id: null, role_id: 'r1', joined_at: ISO, profiles: { name: 'Dana' } }])
  const [m] = await createSupabaseStore({ client }).listMembers('o1')
  assert.deepEqual([m.id, m.userId, m.name, m.joinedAt, 'profiles' in m], ['m1', 'u1', 'Dana', Date.parse(ISO), false])
})

test('supabase addMember returns the existing row when the person is already in', async () => {
  const row = { id: 'm1', org_id: 'o1', user_id: 'u2', agent_id: null, role_id: 'r1', joined_at: ISO }
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'upsert') ? null : row))
  const m = await createSupabaseStore({ client }).addMember({ orgId: 'o1', userId: 'u2', roleId: 'r1' })
  assert.equal(m.id, 'm1')
  const upsert = calls[0].ops.find(([op]) => op === 'upsert')
  assert.deepEqual(upsert[2], { onConflict: 'org_id,user_id', ignoreDuplicates: true })
})

test('supabase roleInUse counts members, then open invites only', async () => {
  const { client, calls } = fakeDb((q) => (q.table === 'org_invites' ? [{ id: 'i1' }] : []))
  assert.equal(await createSupabaseStore({ client }).roleInUse('r1'), true)
  const invites = calls.find((q) => q.table === 'org_invites')
  assert.ok(has(invites, 'is', 'accepted_at', null) && has(invites, 'is', 'cancelled_at', null))
  assert.ok(invites.ops.some(([op, col]) => op === 'gt' && col === 'expires_at'), 'excludes expired invites too, like deleteRole')
})

test('supabase roleInUse treats an expired invite as closed, matching deleteRole', async () => {
  // Simulates the real `.gt('expires_at', now)` filtering the expired invite out.
  const { client } = fakeDb((q) => {
    if (q.table !== 'org_invites') return []
    const filtersExpired = q.ops.some(([op, col]) => op === 'gt' && col === 'expires_at')
    return filtersExpired ? [] : [{ id: 'i1' }]
  })
  assert.equal(await createSupabaseStore({ client }).roleInUse('r1'), false)
})

test('supabase deleteRole clears closed invites before deleting the role', async () => {
  const { client, calls } = fakeDb(() => null)
  await createSupabaseStore({ client }).deleteRole('r1')
  assert.equal(calls[0].table, 'org_invites')
  assert.ok(has(calls[0], 'eq', 'role_id', 'r1'))
  assert.ok(calls[0].ops.some(([op, filter]) => op === 'or' &&
    /accepted_at\.not\.is\.null/.test(filter) && /cancelled_at\.not\.is\.null/.test(filter) && /expires_at\.lte\./.test(filter)))
  assert.equal(calls[1].table, 'roles')
  assert.ok(has(calls[1], 'eq', 'id', 'r1'), 'roles delete only runs after the invites are cleared')
})

test('supabase deleteRole lets the foreign-key error propagate when an invite is still open', async () => {
  const chain = (q) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') {
        const error = q.table === 'roles' ? { code: '23503', message: 'still referenced' } : null
        return (res, rej) => Promise.resolve({ data: null, error }).then(res, rej)
      }
      return (...args) => { q.ops.push([op, ...args]); return chain(q) }
    }
  })
  const client = { from (table) { const q = { table, ops: [] }; return chain(q) } }
  await assert.rejects(createSupabaseStore({ client }).deleteRole('r1'), (err) => err.code === '23503')
})

test('supabase transferOrg lets the RPC\'s errcode propagate (QO001/QO002)', async () => {
  const chain = (q) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res, rej) => Promise.resolve({ data: null, error: { code: 'QO002', message: 'target is not a member of this org' } }).then(res, rej)
      return (...args) => { q.ops.push([op, ...args]); return chain(q) }
    }
  })
  const client = { rpc (fn, args) { const q = { rpc: fn, args, ops: [] }; return chain(q) } }
  await assert.rejects(createSupabaseStore({ client }).transferOrg('o1', 'u1', 'u2'), (err) => err.code === 'QO002')
})

test('supabase claimInvite only claims an open invite', async () => {
  const { client, calls } = fakeDb(() => [{ id: 'i1' }])
  assert.equal(await createSupabaseStore({ client }).claimInvite('i1'), true)
  assert.ok(has(calls[0], 'is', 'accepted_at', null) && has(calls[0], 'is', 'cancelled_at', null))
  const none = fakeDb(() => [])
  assert.equal(await createSupabaseStore({ client: none.client }).claimInvite('i1'), false)
})

test('supabase createInvite sends timestamps as ISO strings', async () => {
  const { client, calls } = fakeDb(() => ({ id: 'i1', expires_at: ISO }))
  const i = await createSupabaseStore({ client }).createInvite({ orgId: 'o1', email: 'a@acme.com', roleId: 'r1', tokenHash: 'h', invitedBy: 'u1', expiresAt: Date.parse(ISO) })
  const insert = calls[0].ops.find(([op]) => op === 'insert')[1]
  assert.deepEqual(insert, { org_id: 'o1', email: 'a@acme.com', role_id: 'r1', token_hash: 'h', invited_by: 'u1', expires_at: ISO })
  assert.equal(i.expiresAt, Date.parse(ISO))
})

test('supabase decideJoinRequest only decides a pending request', async () => {
  const { client, calls } = fakeDb(() => [{ id: 'j1' }])
  assert.equal(await createSupabaseStore({ client }).decideJoinRequest('j1', { status: 'approved', decidedBy: 'u1' }), true)
  assert.ok(has(calls[0], 'eq', 'status', 'pending'))
  const update = calls[0].ops.find(([op]) => op === 'update')[1]
  assert.deepEqual([update.status, update.decided_by], ['approved', 'u1'])
})

test('supabase listTeamMembers flattens the nested member name; addTeamMember looks up the team and sets org_id', async () => {
  const { client, calls } = fakeDb((q) => {
    if (q.table === 'teams') return { org_id: 'o1' }
    if (q.ops.some(([op]) => op === 'upsert')) return { team_id: 't1', member_id: 'm1', access: 'editor', scopes: [], added_at: ISO }
    return [{ team_id: 't1', member_id: 'm1', access: 'viewer', scopes: [], added_at: ISO, org_members: { user_id: 'u1', profiles: { name: 'Dana' } } }]
  })
  const s = createSupabaseStore({ client })
  const [m] = await s.listTeamMembers('t1')
  assert.deepEqual([m.memberId, m.access, m.name, 'orgMembers' in m], ['m1', 'viewer', 'Dana', false])
  await s.addTeamMember({ teamId: 't1', memberId: 'm1', access: 'editor' })
  assert.equal(calls[1].table, 'teams')
  assert.ok(has(calls[1], 'eq', 'id', 't1'))
  const upsert = calls[2].ops.find(([op]) => op === 'upsert')
  assert.deepEqual(upsert[1], { team_id: 't1', member_id: 'm1', access: 'editor', scopes: [], org_id: 'o1' })
  assert.deepEqual(upsert[2], { onConflict: 'team_id,member_id' })
})

test('supabase addTeamMember throws a 23503 like a foreign-key violation when the team does not exist', async () => {
  const { client } = fakeDb(() => null)
  await assert.rejects(createSupabaseStore({ client }).addTeamMember({ teamId: 'nope', memberId: 'm1', access: 'viewer' }), (err) => err.code === '23503')
})

test('supabase createInvite and createJoinRequest lowercase the stored email', async () => {
  const { client: c1, calls: i1 } = fakeDb(() => ({ id: 'i1' }))
  await createSupabaseStore({ client: c1 }).createInvite({ orgId: 'o1', email: 'A@Acme.com', roleId: 'r1', tokenHash: 'h', invitedBy: 'u1', expiresAt: Date.now() })
  assert.equal(i1[0].ops.find(([op]) => op === 'insert')[1].email, 'a@acme.com')

  const { client: c2, calls: i2 } = fakeDb((q) => (q.ops.some(([op]) => op === 'insert') ? { id: 'j1' } : null))
  await createSupabaseStore({ client: c2 }).createJoinRequest({ orgId: 'o1', userId: 'u2', email: 'B@Acme.com' })
  assert.equal(i2[1].ops.find(([op]) => op === 'insert')[1].email, 'b@acme.com')
})

test('supabase createJoinRequest is race-safe: a 23505 on insert means someone else already won, so it re-selects their row', async () => {
  const existing = { id: 'j1', org_id: 'o1', user_id: 'u2', email: 'eli@acme.com', status: 'pending', decided_by: null, decided_at: null, created_at: ISO }
  let selects = 0
  const chain = (q) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') {
        if (q.ops.some(([o]) => o === 'insert')) {
          const error = { code: '23505', message: 'duplicate key value violates unique constraint "join_requests_one_pending"' }
          return (res, rej) => Promise.resolve({ data: null, error }).then(res, rej)
        }
        // Both the fast-path select (before the insert) and the re-select
        // (after losing the race) land here; only the second sees the row
        // the other concurrent caller just inserted.
        selects += 1
        return (res, rej) => Promise.resolve({ data: selects === 1 ? null : existing, error: null }).then(res, rej)
      }
      return (...args) => { q.ops.push([op, ...args]); return chain(q) }
    }
  })
  const calls = []
  const client = { from (table) { const q = { table, ops: [] }; calls.push(q); return chain(q) } }
  const r = await createSupabaseStore({ client }).createJoinRequest({ orgId: 'o1', userId: 'u2', email: 'Eli@Acme.com' })
  assert.equal(r.id, 'j1')
  assert.equal(calls.length, 3, 'fast-path select, the losing insert, then the re-select')
})
