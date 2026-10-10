import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../../src/api/memory-store.js'

test('create, read, list by owner, org and member; update; archive', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  const a = await store.createWorkspace({ ownerUserId: 'u1', name: 'Launch', description: 'Teaser', color: 'lilac', createdBy: 'person:u1' })
  const b = await store.createWorkspace({ orgId: 'o1', name: 'Core', createdBy: 'person:u2' })
  assert.deepEqual(a, { id: a.id, ownerUserId: 'u1', orgId: null, name: 'Launch', description: 'Teaser', color: 'lilac', createdBy: 'person:u1', createdAt: 1000, archivedAt: null, quotaBytes: 5368709120, usedBytes: 0, fileCount: 0 })
  assert.deepEqual(await store.workspaceById(a.id), a)
  assert.equal(await store.workspaceById('nope'), null)
  assert.deepEqual((await store.listWorkspacesOwnedBy('u1')).map((w) => w.id), [a.id])
  assert.deepEqual((await store.listWorkspacesOfOrg('o1')).map((w) => w.id), [b.id])
  await store.putWorkspaceMember({ workspaceId: b.id, account: 'person:u1', access: 'view', addedBy: 'person:u2' })
  assert.deepEqual((await store.listWorkspacesForMember('person:u1')).map((w) => [w.id, w.memberAccess]), [[b.id, 'view']])
  const up = await store.updateWorkspace(a.id, { name: 'Launch 2', color: 'mint' })
  assert.deepEqual([up.name, up.color, up.description], ['Launch 2', 'mint', 'Teaser'])
  assert.equal((await store.updateWorkspace(a.id, { archivedAt: 2000 })).archivedAt, 2000)
  assert.equal(await store.updateWorkspace('nope', { name: 'x' }), null)
})

test('members: put upserts and keeps addedAt, list sorts, remove answers whether it was there', async () => {
  let t = 1000
  const store = createMemoryStore({ now: () => t })
  const ws = await store.createWorkspace({ ownerUserId: 'u1', name: 'W', createdBy: 'person:u1' })
  const m1 = await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u2', access: 'view', addedBy: 'person:u1' })
  t = 2000
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'agent:a1', access: 'edit', addedBy: 'person:u1' })
  const m1b = await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u2', access: 'edit', addedBy: 'person:u1' })
  assert.deepEqual([m1.addedAt, m1b.addedAt, m1b.access], [1000, 1000, 'edit'])
  assert.deepEqual((await store.listWorkspaceMembers(ws.id)).map((m) => m.account), ['person:u2', 'agent:a1'])
  assert.deepEqual(await store.workspaceMember(ws.id, 'agent:a1'), { workspaceId: ws.id, account: 'agent:a1', access: 'edit', addedBy: 'person:u1', sessions: 'invited', addedAt: 2000 })
  assert.equal(await store.removeWorkspaceMember(ws.id, 'agent:a1'), true)
  assert.equal(await store.removeWorkspaceMember(ws.id, 'agent:a1'), false)
  assert.equal(await store.workspaceMember(ws.id, 'agent:a1'), null)
})

test('sessions: link a room before or after the relay reports it; delete makes sessions loose', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  const ws = await store.createWorkspace({ ownerUserId: 'u1', name: 'W', createdBy: 'person:u1' })
  // Before the relay reports the room: the API makes the row, with no owner (only the relay sets that).
  const s1 = await store.setSessionWorkspace('room-a', ws.id, { linkedBy: 'person:u1', at: 1000 })
  assert.deepEqual(s1, { room: 'room-a', name: '', ownerAccount: null, createdAt: 1000, lastActiveAt: 1000, renamedAt: null, workspaceId: ws.id, workspaceLinkedBy: 'person:u1' })
  // The relay's start event then sets the owner and keeps the link (ingestPresence mirrors on conflict).
  await store.ingestPresence([{ id: 'e1', type: 'start', room: 'room-a', account: 'person:u1', owner: true, name: 'Mo', at: 1500 }], 1500)
  assert.deepEqual(await store.sessionByRoom('room-a'), { room: 'room-a', name: '', ownerAccount: 'person:u1', createdAt: 1000, lastActiveAt: 1500, renamedAt: null, workspaceId: ws.id, workspaceLinkedBy: 'person:u1' })
  // After: an existing row only gets the two workspace columns.
  await store.ingestPresence([{ id: 'e2', type: 'start', room: 'room-b', account: 'person:u1', owner: true, name: 'Mo', at: 1600 }], 1600)
  assert.equal((await store.sessionByRoom('room-b')).workspaceLinkedBy, null)
  const s2 = await store.setSessionWorkspace('room-b', ws.id, { linkedBy: 'person:u9', at: 1700 })
  assert.deepEqual([s2.ownerAccount, s2.workspaceId, s2.workspaceLinkedBy, s2.createdAt], ['person:u1', ws.id, 'person:u9', 1600])
  assert.deepEqual((await store.listWorkspaceSessions(ws.id)).map((s) => s.room), ['room-b', 'room-a'])
  await store.setSessionWorkspace('room-b', null, { linkedBy: null, at: 1800 })
  assert.deepEqual([(await store.sessionByRoom('room-b')).workspaceId, (await store.sessionByRoom('room-b')).workspaceLinkedBy], [null, null])
  // A name event for an unknown room makes a row with no link either.
  await store.ingestPresence([{ id: 'e3', type: 'name', room: 'room-c', name: 'C', at: 1900 }], 1900)
  assert.equal((await store.sessionByRoom('room-c')).workspaceLinkedBy, null)
  await store.deleteWorkspace(ws.id)
  assert.equal(await store.workspaceById(ws.id), null)
  assert.equal((await store.sessionByRoom('room-a')).workspaceId, null)
  assert.deepEqual(await store.listWorkspaceMembers(ws.id), [])
})
