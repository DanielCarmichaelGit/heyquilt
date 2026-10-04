// A session inside a workspace lets the workspace's members in at their workspace access.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'
import { roomAccess, OWNER_ACCESS } from '../src/api/access.js'
import { BUILTIN } from '../src/api/permissions.js'

async function setup () {
  const store = createMemoryStore({ now: () => 1000 })
  store.addUser('u1', { name: 'Dan', email: 'd@x.com', confirmed: true })
  store.addUser('u2', { name: 'Bran', email: 'b@x.com', confirmed: true })
  store.addUser('u3', { name: 'Jules', email: 'j@x.com', confirmed: true })
  const ws = await store.createWorkspace({ ownerUserId: 'u1', name: 'Launch', createdBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u2', access: 'view', addedBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'agent:a1', access: 'edit', addedBy: 'person:u1' })
  await store.setSessionWorkspace('room-1', ws.id, { ownerAccount: 'person:u1', at: 1000 })
  return { store, ws }
}

test('owner, members and outsiders of a personal workspace', async () => {
  const { store } = await setup()
  assert.deepEqual(await roomAccess(store, 'room-1', 'person:u1'), OWNER_ACCESS)
  assert.equal((await roomAccess(store, 'room-1', 'person:u2')).files, 'view')
  assert.equal((await roomAccess(store, 'room-1', 'agent:a1')).files, 'edit')
  assert.equal(await roomAccess(store, 'room-1', 'person:u3'), null)
})

test('a grant on the session itself wins over workspace membership', async () => {
  const { store } = await setup()
  await store.putGrant({ room: 'room-1', account: 'person:u2', typeId: 'builtin:edit', tighten: {}, grantedBy: 'person:u1' })
  assert.equal((await roomAccess(store, 'room-1', 'person:u2')).files, 'edit')
})

test('an org workspace: Workspaces: Update is edit, Read is view, non-members nothing', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  for (const [id, email] of [['u1', 'o@acme.com'], ['u2', 'a@acme.com'], ['u3', 'm@acme.com'], ['u4', 'x@else.com']]) store.addUser(id, { name: id, email, confirmed: true, kind: id === 'u1' ? 'org' : 'personal' })
  const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerId: 'u1', grants: BUILTIN })
  const roles = await store.listRoles(org.id)
  await store.addMember({ orgId: org.id, userId: 'u2', roleId: roles.find((r) => r.builtin === 'admin').id })
  await store.addMember({ orgId: org.id, userId: 'u3', roleId: roles.find((r) => r.builtin === 'member').id })
  const ws = await store.createWorkspace({ orgId: org.id, name: 'Core', createdBy: 'person:u1' })
  await store.setSessionWorkspace('room-2', ws.id, { ownerAccount: 'person:u2', at: 1000 })
  assert.deepEqual(await roomAccess(store, 'room-2', 'person:u2'), OWNER_ACCESS, 'the session owner')
  assert.equal((await roomAccess(store, 'room-2', 'person:u1')).files, 'edit', 'org owner')
  assert.equal((await roomAccess(store, 'room-2', 'person:u3')).files, 'view', 'Member has Workspaces: Read')
  assert.equal(await roomAccess(store, 'room-2', 'person:u4'), null)
})

test('a loose session is unchanged', async () => {
  const { store } = await setup()
  await store.setSessionWorkspace('room-1', null, { ownerAccount: 'person:u1', at: 1000 })
  assert.equal(await roomAccess(store, 'room-1', 'person:u2'), null)
})
