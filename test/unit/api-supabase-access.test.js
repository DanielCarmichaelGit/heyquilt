// The Supabase store's access-type, grant and invite methods, against a stand-in client
// that records each call.
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

const TYPE_ROW = { id: 't1', owner_account: 'person:u1', name: 'Docs', files: 'edit', folders: ['docs'], talk: false, created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' }

test('access types are read and written by owner, with named columns', async () => {
  const { client, calls } = fakeClient((call) => (call.rpc ? true : call.ops.some(([op]) => op === 'single' || op === 'maybeSingle') ? TYPE_ROW : [TYPE_ROW]))
  const s = createSupabaseStore({ client })
  const [t] = await s.listAccessTypes('person:u1')
  assert.deepEqual([t.ownerAccount, t.folders, t.talk, t.createdAt], ['person:u1', ['docs'], false, Date.parse('2026-10-02T00:00:00Z')])
  assert.deepEqual(calls[0].ops, [['select', 'id, owner_account, name, files, folders, talk, created_at, updated_at'], ['eq', 'owner_account', 'person:u1'], ['order', 'created_at']])
  await s.createAccessType({ ownerAccount: 'person:u1', name: 'Docs', files: 'edit', folders: ['docs'], talk: false })
  assert.deepEqual(calls[1].ops[0], ['insert', { owner_account: 'person:u1', name: 'Docs', files: 'edit', folders: ['docs'], talk: false }])
  await s.updateAccessType('t1', { talk: true })
  const [op, patch] = calls[2].ops[0]
  assert.equal(op, 'update')
  assert.deepEqual(Object.keys(patch).sort(), ['talk', 'updated_at'], 'only what changed, and when')
  assert.equal(await s.deleteAccessType('t1', 'person:u1'), true)
  assert.deepEqual([calls[3].rpc, calls[3].args], ['delete_access_type', { p_id: 't1', p_owner: 'person:u1' }])
})

test('grants upsert on (room, account), and an email invite is claimed by one function call', async () => {
  const { client, calls } = fakeClient((call) => (call.rpc ? 1 : call.ops.some(([op]) => op === 'delete') ? [{ account: 'agent:a1' }] : { room: 'r1', account: 'agent:a1', type_id: 'builtin:view', tighten: { talk: false }, granted_by: 'person:u1', created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' }))
  const s = createSupabaseStore({ client })
  const g = await s.putGrant({ room: 'r1', account: 'agent:a1', typeId: 'builtin:view', tighten: { talk: false }, grantedBy: 'person:u1' })
  assert.deepEqual([g.typeId, g.tighten, g.grantedBy], ['builtin:view', { talk: false }, 'person:u1'])
  const [op, row, opts] = calls[0].ops[0]
  assert.equal(op, 'upsert')
  assert.deepEqual([row.room, row.account, row.type_id, row.tighten, row.granted_by, opts], ['r1', 'agent:a1', 'builtin:view', { talk: false }, 'person:u1', { onConflict: 'room,account' }])
  assert.equal(await s.deleteGrant('r1', 'agent:a1'), true)
  assert.equal(await s.claimEmailInvites('r1', 'lin@acme.com', 'person:lin'), 1)
  const claim = calls[2]
  assert.equal(claim.rpc, 'claim_email_invites')
  assert.deepEqual([claim.args.p_room, claim.args.p_email, claim.args.p_account], ['r1', 'lin@acme.com', 'person:lin'])
  assert.ok(!Number.isNaN(Date.parse(claim.args.p_now)))
})

test('session invites keep a lowercase email, and the link only in its own column', async () => {
  const { client, calls } = fakeClient(() => ({ id: 'i1', room: 'r1', email: 'lin@acme.com', account: null, account_name: '', type_id: 'builtin:edit', invited_by: 'person:u1', created_at: '2026-10-02T00:00:00Z', expires_at: '2026-10-09T00:00:00Z', used_at: null, used_by: null, cancelled_at: null }))
  const s = createSupabaseStore({ client })
  const i = await s.createSessionInvite({ room: 'r1', email: 'Lin@Acme.com', typeId: 'builtin:edit', invitedBy: 'person:u1', expiresAt: Date.parse('2026-10-09T00:00:00Z'), at: Date.parse('2026-10-02T00:00:00Z') })
  // That address's expired, unused invite goes first, so the unique index lets the new one in.
  assert.deepEqual(calls[0].ops, [['delete'], ['eq', 'room', 'r1'], ['eq', 'email', 'lin@acme.com'], ['is', 'used_at', null], ['is', 'cancelled_at', null], ['lte', 'expires_at', '2026-10-02T00:00:00.000Z']])
  assert.deepEqual(calls[1].ops[0], ['insert', { room: 'r1', email: 'lin@acme.com', account: null, account_name: '', type_id: 'builtin:edit', invited_by: 'person:u1', expires_at: '2026-10-09T00:00:00.000Z', link: null }])
  assert.doesNotMatch(calls[1].ops.find(([op]) => op === 'select')[1], /link/, 'the owner\'s reads never select it')
  assert.deepEqual([i.typeId, i.expiresAt, i.usedAt], ['builtin:edit', Date.parse('2026-10-09T00:00:00Z'), null])
})

test("the invites waiting for someone: one query by account or address, with the link and the session's name", async () => {
  const row = { id: 'i1', room: 'r1', email: null, account: 'person:lin', account_name: 'Lin', type_id: 'builtin:edit', invited_by: 'person:u1', created_at: '2026-10-02T00:00:00Z', expires_at: '2026-10-09T00:00:00Z', used_at: null, used_by: null, cancelled_at: null, link: 'https://join.heyquilt.com/r1#s', relay_sessions: { name: 'Pricing' } }
  const { client, calls } = fakeClient(() => [row])
  const s = createSupabaseStore({ client })
  const [i] = await s.sessionInvitesFor({ account: 'person:lin', email: 'lin@acme.com' }, Date.parse('2026-10-03T00:00:00Z'))
  assert.deepEqual([i.link, i.sessionName, i.room], ['https://join.heyquilt.com/r1#s', 'Pricing', 'r1'])
  assert.deepEqual(calls[0].ops.find(([op]) => op === 'or'), ['or', 'account.eq.person:lin,email.eq.lin@acme.com'])
  assert.deepEqual(await s.sessionInvitesFor({ account: null, email: 'a,b@x.com' }, 0), [], 'nothing that could break out of the filter')
})

test("an address or account's open invite is one query, not a page of the list", async () => {
  const row = { id: 'i1', room: 'r1', email: null, account: 'person:lin', account_name: 'Lin', type_id: 'builtin:edit', invited_by: 'person:u1', created_at: '2026-10-02T00:00:00Z', expires_at: '2026-10-09T00:00:00Z', used_at: null, used_by: null, cancelled_at: null }
  const { client, calls } = fakeClient(() => [row])
  const s = createSupabaseStore({ client })
  const i = await s.openSessionInvite('r1', { account: 'person:lin' }, Date.parse('2026-10-03T00:00:00Z'), 'i0')
  assert.equal(i.account, 'person:lin')
  assert.deepEqual(calls[0].ops.slice(1), [['eq', 'room', 'r1'], ['eq', 'account', 'person:lin'], ['is', 'used_at', null], ['is', 'cancelled_at', null], ['gt', 'expires_at', '2026-10-03T00:00:00.000Z'], ['neq', 'id', 'i0'], ['limit', 1]])
})

test('deleting a user removes its access before its activity, before the auth user', async () => {
  const { client, calls } = fakeClient((call) => (call.table === 'agents' ? [{ id: 'a1' }] : null))
  const s = createSupabaseStore({ client })
  await s.deleteUser('u1')
  assert.deepEqual(calls.slice(1).map((c) => c.rpc || (c.deletedUser && 'auth')), ['delete_account_access', 'delete_account_activity', 'auth'])
  assert.deepEqual(calls[1].args, { p_accounts: ['person:u1', 'agent:a1'] })
})

test("cancelling's grant delete is one function call that checks for open invites", async () => {
  const { client, calls } = fakeClient(() => true)
  const s = createSupabaseStore({ client })
  assert.equal(await s.deleteUnusedGrant('r1', 'email:pat@example.com', Date.parse('2026-10-03T00:00:00Z')), true)
  assert.deepEqual([calls[0].rpc, calls[0].args], ['delete_unused_grant', { p_room: 'r1', p_account: 'email:pat@example.com', p_now: '2026-10-03T00:00:00.000Z' }])
})
