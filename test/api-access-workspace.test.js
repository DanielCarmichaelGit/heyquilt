// A session inside a workspace lets the workspace's members in at their workspace access.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'
import { roomAccess, OWNER_ACCESS } from '../src/api/access.js'
import { BUILTIN } from '../src/api/permissions.js'

let eventId = 0
/** The relay reports `owner` starting `room`, as its owner. */
const ownerStarts = (store, room, owner) => store.ingestPresence([{ id: `e${++eventId}`, type: 'start', room, account: owner, owner: true, name: '', at: 1000 }], 1000)
/** `room`, owned by `owner` (as the relay reports it), put in workspace `wsId` by its owner. */
async function ownedAndLinked (store, room, wsId, owner) {
  await ownerStarts(store, room, owner)
  await store.setSessionWorkspace(room, wsId, { linkedBy: owner, at: 1000 })
}

async function setup () {
  const store = createMemoryStore({ now: () => 1000 })
  store.addUser('u1', { name: 'Dan', email: 'd@x.com', confirmed: true })
  store.addUser('u2', { name: 'Bran', email: 'b@x.com', confirmed: true })
  store.addUser('u3', { name: 'Jules', email: 'j@x.com', confirmed: true })
  const ws = await store.createWorkspace({ ownerUserId: 'u1', name: 'Launch', createdBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u2', access: 'view', addedBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'agent:a1', access: 'edit', addedBy: 'person:u1' })
  await ownedAndLinked(store, 'room-1', ws.id, 'person:u1')
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
  await ownedAndLinked(store, 'room-2', ws.id, 'person:u2')
  assert.deepEqual(await roomAccess(store, 'room-2', 'person:u2'), OWNER_ACCESS, 'the session owner')
  assert.equal((await roomAccess(store, 'room-2', 'person:u1')).files, 'edit', 'org owner')
  assert.equal((await roomAccess(store, 'room-2', 'person:u3')).files, 'view', 'Member has Workspaces: Read')
  assert.equal(await roomAccess(store, 'room-2', 'person:u4'), null)
})

test('a loose session is unchanged', async () => {
  const { store } = await setup()
  await store.setSessionWorkspace('room-1', null, { linkedBy: null, at: 1000 })
  assert.equal(await roomAccess(store, 'room-1', 'person:u2'), null)
})

test('linking a room the API has not seen does not claim it: members get in only once its owner links it', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  for (const id of ['mem', 'out', 'lim']) store.addUser(id, { name: id, email: `${id}@x.com`, confirmed: true })
  const ws = await store.createWorkspace({ ownerUserId: 'out', name: 'Outs', createdBy: 'person:out' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:lim', access: 'view', addedBy: 'person:out' })
  // (a) out links someone else's room before the relay has reported it; then the relay says mem owns it.
  await store.setSessionWorkspace('room-x', ws.id, { linkedBy: 'person:out', at: 1000 })
  assert.equal((await store.sessionByRoom('room-x')).ownerAccount, null, 'the link never sets the owner')
  await ownerStarts(store, 'room-x', 'person:mem')
  assert.equal(await roomAccess(store, 'room-x', 'person:out'), null, 'the linker is not the owner')
  assert.deepEqual(await roomAccess(store, 'room-x', 'person:mem'), OWNER_ACCESS)
  assert.equal(await roomAccess(store, 'room-x', 'person:lim'), null, 'a workspace member gets nothing from a link the owner did not make')
  // (b) the owner links it: now the workspace's members get in.
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:mem', access: 'edit', addedBy: 'person:out' })
  await store.setSessionWorkspace('room-x', ws.id, { linkedBy: 'person:mem', at: 1000 })
  assert.equal((await roomAccess(store, 'room-x', 'person:lim')).files, 'view')
  assert.equal((await roomAccess(store, 'room-x', 'person:out')).files, 'edit', 'the workspace owner, through the workspace')
})

test('(c) a room linked by its creator before the relay reports it admits members once the relay names the creator as owner', async () => {
  const { store, ws } = await setup()
  await store.setSessionWorkspace('room-c', ws.id, { linkedBy: 'person:u1', at: 1000 })
  assert.equal(await roomAccess(store, 'room-c', 'person:u2'), null, 'no owner yet')
  assert.equal(await roomAccess(store, 'room-c', 'agent:a1'), null)
  await ownerStarts(store, 'room-c', 'person:u1')
  assert.deepEqual(await roomAccess(store, 'room-c', 'person:u1'), OWNER_ACCESS)
  assert.equal((await roomAccess(store, 'room-c', 'person:u2')).files, 'view')
  assert.equal((await roomAccess(store, 'room-c', 'agent:a1')).files, 'edit')
})

test('removed from the org: no way into its workspaces\' sessions, for a person or an agent', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  for (const id of ['u1', 'u2']) store.addUser(id, { name: id, email: `${id}@acme.com`, confirmed: true, kind: id === 'u1' ? 'org' : 'personal' })
  const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerId: 'u1', grants: BUILTIN })
  const member = await store.addMember({ orgId: org.id, userId: 'u2', roleId: (await store.listRoles(org.id)).find((r) => r.builtin === 'member').id })
  const agent = await store.createAgent({ name: 'Larry', provider: 'Anthropic', type: 'coding agent', orgId: org.id })
  const agentRow = await store.addAgentMember({ orgId: org.id, agentId: agent.id })
  const ws = await store.createWorkspace({ orgId: org.id, name: 'Core', createdBy: 'person:u1' })
  for (const account of ['person:u2', `agent:${agent.id}`]) await store.putWorkspaceMember({ workspaceId: ws.id, account, access: 'edit', addedBy: 'person:u1' })
  await ownedAndLinked(store, 'room-o', ws.id, 'person:u1')
  assert.equal((await roomAccess(store, 'room-o', 'person:u2')).files, 'edit')
  assert.equal((await roomAccess(store, 'room-o', `agent:${agent.id}`)).files, 'edit')
  await store.removeMember(member.id)
  await store.removeMember(agentRow.id)
  assert.equal(await roomAccess(store, 'room-o', 'person:u2'), null)
  assert.equal(await roomAccess(store, 'room-o', `agent:${agent.id}`), null)
})
