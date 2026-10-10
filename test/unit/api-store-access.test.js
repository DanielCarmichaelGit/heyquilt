// Access types, grants and session invites in the memory store, the reference for
// the functions in 20261002010000_access_types_and_invites.sql.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createMemoryStore } from '../../src/api/memory-store.js'

const DAY = 24 * 60 * 60 * 1000
async function storeWithRoom (room = 'r1', owner = 'person:olive') {
  let clock = 1000
  const s = createMemoryStore({ now: () => clock })
  await s.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room, account: owner, name: 'Olive', owner: true, at: 500 }], 500)
  return { s, tick: (ms) => { clock += ms }, at: () => clock }
}

test('access types: create, list in order, change, and only the owner deletes', async () => {
  const { s, tick } = await storeWithRoom()
  const a = await s.createAccessType({ ownerAccount: 'person:olive', name: 'Docs', files: 'edit', folders: ['docs'], talk: true })
  tick(1)
  await s.createAccessType({ ownerAccount: 'person:olive', name: 'Quiet', files: 'view', folders: [], talk: false })
  await s.createAccessType({ ownerAccount: 'person:otto', name: 'Not mine', files: 'edit' })
  assert.deepEqual((await s.listAccessTypes('person:olive')).map((t) => t.name), ['Docs', 'Quiet'])
  tick(5)
  const changed = await s.updateAccessType(a.id, { name: 'Docs writer', folders: ['docs', 'web'] })
  assert.deepEqual([changed.name, changed.files, changed.folders, changed.updatedAt > changed.createdAt], ['Docs writer', 'edit', ['docs', 'web'], true])
  assert.equal(await s.updateAccessType(crypto.randomUUID(), { name: 'x' }), null)
  assert.equal(await s.deleteAccessType(a.id, 'person:otto'), false)
  assert.ok(await s.accessTypeById(a.id))
})

test('deleting a type moves its grants and invites to View only', async () => {
  const { s, at } = await storeWithRoom()
  const t = await s.createAccessType({ ownerAccount: 'person:olive', name: 'Docs', files: 'edit', folders: ['docs'] })
  await s.putGrant({ room: 'r1', account: 'person:mo', typeId: t.id, tighten: { talk: false }, grantedBy: 'person:olive' })
  const inv = await s.createSessionInvite({ room: 'r1', email: 'Lin@Acme.com', typeId: t.id, invitedBy: 'person:olive', expiresAt: at() + DAY })
  assert.equal(inv.email, 'lin@acme.com')
  assert.equal(await s.deleteAccessType(t.id, 'person:olive'), true)
  assert.equal(await s.accessTypeById(t.id), null)
  const g = await s.grantFor('r1', 'person:mo')
  assert.deepEqual([g.typeId, g.tighten], ['builtin:view', { talk: false }])
  assert.equal((await s.sessionInviteById('r1', inv.id)).typeId, 'builtin:view')
})

test('grants: one per room and account, replaced in place, only in a session that exists', async () => {
  const { s, tick } = await storeWithRoom()
  const first = await s.putGrant({ room: 'r1', account: 'agent:a1', typeId: 'builtin:edit', grantedBy: 'person:olive' })
  tick(10)
  const again = await s.putGrant({ room: 'r1', account: 'agent:a1', typeId: 'builtin:view', tighten: { files: 'view' }, grantedBy: 'person:olive' })
  assert.deepEqual([again.typeId, again.createdAt, again.updatedAt], ['builtin:view', first.createdAt, first.createdAt + 10])
  assert.equal((await s.listGrants('r1')).length, 1)
  await assert.rejects(s.putGrant({ room: 'nope', account: 'agent:a1', typeId: 'builtin:edit', grantedBy: 'x' }), { code: '23503' })
  assert.equal(await s.deleteGrant('r1', 'agent:a1'), true)
  assert.equal(await s.grantFor('r1', 'agent:a1'), null)
})

test('an open email invite moves its grant to whoever signs in with that email, once', async () => {
  const { s, tick, at } = await storeWithRoom()
  await s.putGrant({ room: 'r1', account: 'email:lin@acme.com', typeId: 'builtin:view', grantedBy: 'person:olive' })
  const inv = await s.createSessionInvite({ room: 'r1', email: 'lin@acme.com', typeId: 'builtin:view', invitedBy: 'person:olive', expiresAt: at() + DAY })
  assert.equal(await s.claimEmailInvites('r1', 'lin@acme.com', 'person:lin'), 1)
  assert.equal(await s.grantFor('r1', 'email:lin@acme.com'), null)
  assert.equal((await s.grantFor('r1', 'person:lin')).typeId, 'builtin:view')
  const used = await s.sessionInviteById('r1', inv.id)
  assert.deepEqual([used.usedBy, used.usedAt > 0], ['person:lin', true])
  assert.equal(await s.claimEmailInvites('r1', 'lin@acme.com', 'person:lin'), 0, 'used once')

  await s.putGrant({ room: 'r1', account: 'email:old@acme.com', typeId: 'builtin:edit', grantedBy: 'person:olive' })
  await s.createSessionInvite({ room: 'r1', email: 'old@acme.com', typeId: 'builtin:edit', invitedBy: 'person:olive', expiresAt: at() + DAY })
  tick(DAY + 1)
  assert.equal(await s.claimEmailInvites('r1', 'old@acme.com', 'person:old'), 0, 'expired')
  assert.equal(await s.grantFor('r1', 'person:old'), null)
})

test('cancelling: only a waiting invite; account invites are used when the account comes in', async () => {
  const { s, at } = await storeWithRoom()
  const a = await s.createSessionInvite({ room: 'r1', account: 'agent:a1', accountName: 'Larry', typeId: 'builtin:edit', invitedBy: 'person:olive', expiresAt: at() + DAY })
  const b = await s.createSessionInvite({ room: 'r1', account: 'person:mo', accountName: 'Mo', typeId: 'builtin:edit', invitedBy: 'person:olive', expiresAt: at() + DAY })
  await assert.rejects(s.createSessionInvite({ room: 'r1', typeId: 'builtin:edit', invitedBy: 'x', expiresAt: 1 }), { code: '23514' })
  await s.useAccountInvites('r1', 'agent:a1')
  assert.equal((await s.sessionInviteById('r1', a.id)).usedBy, 'agent:a1')
  assert.equal(await s.cancelSessionInvite(a.id), false, 'already used')
  assert.equal(await s.cancelSessionInvite(b.id), true)
  assert.equal(await s.cancelSessionInvite(b.id), false, 'once')
  assert.deepEqual((await s.listSessionInvites('r1')).map((i) => i.accountName).sort(), ['Larry', 'Mo'], 'used and cancelled ones are still listed')
  assert.equal(await s.sessionInviteById('other', a.id), null)
})

test("deleting an account takes its types, its grants and its sessions' grants and invites", async () => {
  const { s, at } = await storeWithRoom('r1', 'person:olive')
  s.addUser('olive', { name: 'Olive' })
  s.addUser('mo', { name: 'Mo' })
  await s.createAccessType({ ownerAccount: 'person:mo', name: 'Mine', files: 'edit' })
  await s.putGrant({ room: 'r1', account: 'person:mo', typeId: 'builtin:edit', grantedBy: 'person:olive' })
  await s.createSessionInvite({ room: 'r1', email: 'x@y.com', typeId: 'builtin:edit', invitedBy: 'person:olive', expiresAt: at() + DAY })
  await s.deleteUser('mo')
  assert.deepEqual([(await s.listAccessTypes('person:mo')).length, await s.grantFor('r1', 'person:mo')], [0, null])
  assert.equal((await s.listSessionInvites('r1')).length, 1)
  await s.deleteUser('olive')
  assert.equal((await s.listSessionInvites('r1')).length, 0, 'her session went, and its invites with it')
})
