import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../../src/api/memory-store.js'
import { workspaceAccess, cleanColor, cleanDescription, cleanAccess, autoColor, COLORS } from '../../src/api/workspace-access.js'
import { orgGrantsFor } from '../../src/api/org-access.js'
import { BUILTIN } from '../../src/api/permissions.js'

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

test('an org workspace: a member row counts only while the person or agent is still in the org', async () => {
  const store = createMemoryStore()
  for (const id of ['u1', 'u2']) store.addUser(id, { name: id, email: `${id}@acme.com`, confirmed: true, kind: id === 'u1' ? 'org' : 'personal' })
  const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerId: 'u1', grants: BUILTIN })
  const noRole = await store.addMember({ orgId: org.id, userId: 'u2', roleId: null })
  const agent = await store.createAgent({ name: 'Larry', provider: 'Anthropic', type: 'coding agent', orgId: org.id })
  const agentRow = await store.addAgentMember({ orgId: org.id, agentId: agent.id })
  const ws = await store.createWorkspace({ orgId: org.id, name: 'Core', createdBy: 'person:u1' })
  for (const account of ['person:u2', `agent:${agent.id}`]) await store.putWorkspaceMember({ workspaceId: ws.id, account, access: 'edit', addedBy: 'person:u1' })
  const access = async (account) => workspaceAccess(store, ws, account, { orgGrants: await orgGrantsFor(store, org.id, account) })
  // orgGrantsFor: an agent in the org gets team access and no workspace permission; outside it, nothing.
  const agentGrants = await orgGrantsFor(store, org.id, `agent:${agent.id}`)
  assert.equal(agentGrants.can('workspaces', 'r'), false)
  assert.deepEqual(await access('person:u2'), { access: 'edit', admin: false, via: 'member' })
  assert.deepEqual(await access(`agent:${agent.id}`), { access: 'edit', admin: false, via: 'member' })
  assert.deepEqual(await workspaceAccess(store, ws, `agent:${agent.id}`), { access: 'edit', admin: false, via: 'member' }, 'the agent check needs no grants from the caller')
  await store.removeMember(noRole.id)
  await store.removeMember(agentRow.id)
  assert.equal(await orgGrantsFor(store, org.id, `agent:${agent.id}`), null)
  assert.equal(await access('person:u2'), null, 'removed from the org: the workspace row no longer counts')
  assert.equal(await access(`agent:${agent.id}`), null)
  // A personal workspace keeps its rows whatever orgs anyone is in.
  const mine = await store.createWorkspace({ ownerUserId: 'u1', name: 'Mine', createdBy: 'person:u1' })
  await store.putWorkspaceMember({ workspaceId: mine.id, account: `agent:${agent.id}`, access: 'view', addedBy: 'person:u1' })
  assert.deepEqual(await workspaceAccess(store, mine, `agent:${agent.id}`), { access: 'view', admin: false, via: 'member' })
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

test('autoColor: one of the palette, stable for a name, varied across names', () => {
  for (const n of ['Launch', 'Website', 'Quilt core', '']) assert.ok(COLORS.includes(autoColor(n)), n)
  assert.equal(autoColor('Launch'), autoColor('Launch'))
  assert.ok(new Set(['Launch', 'Website', 'Quilt core', 'Design', 'Ops', 'Docs', 'Sales'].map(autoColor)).size > 1)
})

