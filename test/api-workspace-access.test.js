import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'
import { workspaceAccess, cleanColor, cleanDescription, cleanAccess, COLORS } from '../src/api/workspace-access.js'

const can = (...ok) => ({ can: (r, op) => ok.includes(`${r}:${op}`) })

test('a personal workspace: the owner is admin, members have their access, others nothing', async () => {
  const store = createMemoryStore()
  const ws = await store.createWorkspace({ ownerUserId: 'u1', name: 'Launch', createdBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u2', access: 'view', addedBy: 'person:u1' })
  assert.deepEqual(await workspaceAccess(store, ws, 'person:u1'), { access: 'edit', admin: true, via: 'owner' })
  assert.deepEqual(await workspaceAccess(store, ws, 'person:u2'), { access: 'view', admin: false, via: 'member' })
  assert.equal(await workspaceAccess(store, ws, 'person:u3'), null)
  assert.equal(await workspaceAccess(store, ws, 'agent:a1'), null)
})

test('an org workspace: Workspaces: Update is admin, Read alone is view, a member row wins over Read', async () => {
  const store = createMemoryStore()
  const ws = await store.createWorkspace({ orgId: 'o1', name: 'Core', createdBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: ws.id, account: 'person:u3', access: 'edit', addedBy: 'person:u1' })
  assert.deepEqual(await workspaceAccess(store, ws, 'person:u1', { orgGrants: can('workspaces:r', 'workspaces:u') }), { access: 'edit', admin: true, via: 'org' })
  assert.deepEqual(await workspaceAccess(store, ws, 'person:u2', { orgGrants: can('workspaces:r') }), { access: 'view', admin: false, via: 'org' })
  assert.deepEqual(await workspaceAccess(store, ws, 'person:u3', { orgGrants: can('workspaces:r') }), { access: 'edit', admin: false, via: 'member' })
  assert.equal(await workspaceAccess(store, ws, 'person:u4', { orgGrants: can() }), null)
  assert.equal(await workspaceAccess(store, ws, 'person:u4', { orgGrants: null }), null, 'not in the org')
  assert.deepEqual(await workspaceAccess(store, ws, 'agent:a1', { orgGrants: null }), null)
})

test('cleaners', () => {
  assert.equal(cleanColor(undefined), '')
  assert.equal(cleanColor('mint'), 'mint')
  assert.throws(() => cleanColor('red'), /Pick one of the workspace colours\./)
  assert.equal(COLORS.length, 6)
  assert.equal(cleanDescription('  hi ​'), 'hi')
  assert.throws(() => cleanDescription('x'.repeat(501)), /500/)
  // 400 emoji are 400 characters (code points) and pass the 500 limit
  assert.equal(cleanDescription('😀'.repeat(400)).length, 800)
  assert.throws(() => cleanDescription('😀'.repeat(501)), /500/)
  assert.equal(cleanAccess('view'), 'view')
  assert.throws(() => cleanAccess('owner'), /Access is edit or view\./)
})
