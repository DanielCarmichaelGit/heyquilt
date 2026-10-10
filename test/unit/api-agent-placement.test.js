// Where an agent reaches by its placement, who joins a session in a workspace, and the
// per-session keep-out, as workspace and room access see them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../../src/api/memory-store.js'
import { roomAccess } from '../../src/api/access.js'
import { workspaceAccess } from '../../src/api/workspace-access.js'
import { agentReach, agentJoinsSession, agentsJoiningSession, cleanPlacement, REACH, SESSIONS } from '../../src/api/agent-placement.js'
import { BUILTIN } from '../../src/api/permissions.js'

let eventId = 0
/** `room`, owned by `owner` (as the relay reports it), put in workspace `wsId` by its owner. */
async function ownedAndLinked (store, room, wsId, owner) {
  await store.ingestPresence([{ id: `e${++eventId}`, type: 'start', room, account: owner, owner: true, name: '', at: 1000 }], 1000)
  await store.setSessionWorkspace(room, wsId, { linkedBy: owner, at: 1000 })
}

const place = (store, agentId, p) => store.putAgentPlacement({ agentId, updatedBy: 'person:u1', ...p })

async function setup () {
  const store = createMemoryStore({ now: () => 1000 })
  store.addUser('u1', { name: 'Dan', email: 'd@x.com', confirmed: true })
  store.addUser('u2', { name: 'Bran', email: 'b@x.com', confirmed: true })
  const ws1 = await store.createWorkspace({ ownerUserId: 'u1', name: 'Launch', createdBy: 'person:u1' })
  const ws2 = await store.createWorkspace({ ownerUserId: 'u1', name: 'Notes', createdBy: 'person:u1' })
  const other = await store.createWorkspace({ ownerUserId: 'u2', name: 'Bran\'s', createdBy: 'person:u2' })
  const agent = await store.createAgent({ name: 'Larry', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u1' })
  return { store, ws1, ws2, other, agent }
}

async function makeOrg (store) {
  store.addUser('o1', { name: 'Owner', email: 'o@acme.com', confirmed: true, kind: 'org' })
  const org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerId: 'o1', grants: BUILTIN })
  const agent = await store.createAgent({ name: 'Orgbot', provider: 'Anthropic', type: 'coding agent', orgId: org.id })
  await store.addAgentMember({ orgId: org.id, agentId: agent.id })
  const ws = await store.createWorkspace({ orgId: org.id, name: 'Core', createdBy: 'person:o1' })
  return { org, agent, ws }
}

test('reach all: every personal workspace of the owner, none of anyone else', async () => {
  const { store, ws1, ws2, other, agent } = await setup()
  await place(store, agent.id, { reach: 'all', access: 'edit', sessions: 'all' })
  assert.deepEqual(await agentReach(store, ws1, agent.id), { access: 'edit', scopes: [], via: 'global', sessions: 'all' })
  assert.equal((await agentReach(store, ws2, agent.id)).via, 'global')
  assert.equal(await agentReach(store, other, agent.id), null)
  const wa = await workspaceAccess(store, ws1, `agent:${agent.id}`)
  assert.equal(wa.access, 'edit'); assert.equal(wa.admin, false); assert.equal(wa.via, 'global')
  assert.equal(await workspaceAccess(store, other, `agent:${agent.id}`), null)
})

test('reach workspaces: only the listed ones (an id for a workspace that is gone is ignored)', async () => {
  const { store, ws1, ws2, agent } = await setup()
  await place(store, agent.id, { reach: 'workspaces', workspaceIds: ['00000000-0000-4000-8000-000000000000', ws1.id], access: 'view' })
  assert.deepEqual(await agentReach(store, ws1, agent.id), { access: 'view', scopes: [], via: 'placed', sessions: 'invited' })
  assert.equal(await agentReach(store, ws2, agent.id), null)
  assert.equal((await workspaceAccess(store, ws1, `agent:${agent.id}`)).via, 'placed')
})

test('reach manual, or no placement at all: nowhere', async () => {
  const { store, ws1, agent } = await setup()
  assert.equal(await agentReach(store, ws1, agent.id), null)
  await place(store, agent.id, { reach: 'manual' })
  assert.equal(await agentReach(store, ws1, agent.id), null)
  assert.equal(await workspaceAccess(store, ws1, `agent:${agent.id}`), null)
})

test('a workspace override: excluded hides the agent, sessions replaces the placement\'s', async () => {
  const { store, ws1, ws2, agent } = await setup()
  await place(store, agent.id, { reach: 'all', sessions: 'invited' })
  await store.putWorkspaceAgentOverride({ workspaceId: ws1.id, agentId: agent.id, excluded: true })
  assert.equal(await agentReach(store, ws1, agent.id), null)
  assert.equal(await workspaceAccess(store, ws1, `agent:${agent.id}`), null)
  await store.putWorkspaceAgentOverride({ workspaceId: ws2.id, agentId: agent.id, sessions: 'all' })
  assert.equal((await agentReach(store, ws2, agent.id)).sessions, 'all')
  await store.putWorkspaceAgentOverride({ workspaceId: ws2.id, agentId: agent.id, sessions: null })
  assert.equal((await agentReach(store, ws2, agent.id)).sessions, 'invited', 'no override sessions: the placement\'s')
})

test('an org agent reaches only its org\'s workspaces; a personal agent none of the org\'s', async () => {
  const { store, ws1, agent: personal } = await setup()
  const { agent, ws } = await makeOrg(store)
  await place(store, agent.id, { reach: 'all', sessions: 'all' })
  await place(store, personal.id, { reach: 'all' })
  assert.equal((await agentReach(store, ws, agent.id)).via, 'global')
  assert.equal(await agentReach(store, ws1, agent.id), null)
  assert.equal(await agentReach(store, ws, personal.id), null)
  // Listing another owner's workspace id never crosses owners either.
  await place(store, personal.id, { reach: 'workspaces', workspaceIds: [ws.id] })
  assert.equal(await agentReach(store, ws, personal.id), null)
})

test('a revoked agent reaches nothing and joins nothing', async () => {
  const { store, ws1, agent } = await setup()
  await place(store, agent.id, { reach: 'all', sessions: 'all' })
  await ownedAndLinked(store, 'room-r', ws1.id, 'person:u1')
  assert.equal(await agentJoinsSession(store, 'room-r', agent.id), true)
  await store.revokeAgent(agent.id)
  assert.equal(await agentReach(store, ws1, agent.id), null)
  assert.equal(await workspaceAccess(store, ws1, `agent:${agent.id}`), null)
  assert.equal(await agentJoinsSession(store, 'room-r', agent.id), false)
})

test('a member row beats placement: a view member with an edit placement is view', async () => {
  const { store, ws1, agent } = await setup()
  await place(store, agent.id, { reach: 'all', access: 'edit' })
  await store.putWorkspaceMember({ workspaceId: ws1.id, account: `agent:${agent.id}`, access: 'view', addedBy: 'person:u1' })
  assert.deepEqual(await workspaceAccess(store, ws1, `agent:${agent.id}`), { access: 'view', admin: false, via: 'member' })
})

test('agentJoinsSession: exclusion first, then the member row, then placement, else no', async () => {
  const { store, ws1, agent } = await setup()
  const id = agent.id
  assert.equal(await agentJoinsSession(store, 'nowhere', id), false, 'unknown room')
  await store.ingestPresence([{ id: `e${++eventId}`, type: 'start', room: 'loose', account: 'person:u1', owner: true, name: '', at: 1000 }], 1000)
  await place(store, id, { reach: 'all', sessions: 'all' })
  assert.equal(await agentJoinsSession(store, 'loose', id), false, 'a session outside any workspace')
  await ownedAndLinked(store, 'room-1', ws1.id, 'person:u1')
  assert.equal(await agentJoinsSession(store, 'room-1', id), true, 'placement all')
  await place(store, id, { reach: 'all', sessions: 'invited' })
  assert.equal(await agentJoinsSession(store, 'room-1', id), false, 'placement invited')
  await store.putWorkspaceMember({ workspaceId: ws1.id, account: `agent:${id}`, access: 'edit', addedBy: 'person:u1', sessions: 'all' })
  assert.equal(await agentJoinsSession(store, 'room-1', id), true, 'member all')
  await place(store, id, { reach: 'all', sessions: 'all' })
  await store.putWorkspaceMember({ workspaceId: ws1.id, account: `agent:${id}`, access: 'edit', addedBy: 'person:u1', sessions: 'invited' })
  assert.equal(await agentJoinsSession(store, 'room-1', id), false, 'the member row decides over the placement')
  await store.putWorkspaceMember({ workspaceId: ws1.id, account: `agent:${id}`, access: 'edit', addedBy: 'person:u1', sessions: 'all' })
  await store.addSessionAgentExclusion({ room: 'room-1', agentId: id, excludedBy: 'person:u1' })
  assert.equal(await agentJoinsSession(store, 'room-1', id), false, 'kept out of this session')
  await store.removeSessionAgentExclusion('room-1', id)
  assert.equal(await agentJoinsSession(store, 'room-1', id), true)
  // Someone else's agent with a member row saying all: no.
  const stranger = await store.createAgent({ name: 'Stranger', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u2' })
  await store.putWorkspaceMember({ workspaceId: ws1.id, account: `agent:${stranger.id}`, access: 'edit', addedBy: 'person:u1', sessions: 'all' })
  assert.equal(await agentJoinsSession(store, 'room-1', stranger.id), false, "someone else's agent")
  // Linked by someone other than the owner the relay reports: nobody joins, as roomAccess admits nobody.
  await store.ingestPresence([{ id: `e${++eventId}`, type: 'start', room: 'room-2', account: 'person:u1', owner: true, name: '', at: 1000 }], 1000)
  await store.setSessionWorkspace('room-2', ws1.id, { linkedBy: 'person:someone-else', at: 1000 })
  assert.equal(await agentJoinsSession(store, 'room-2', id), false, 'linked by someone other than the owner')
  assert.deepEqual(await agentsJoiningSession(store, 'room-2'), [])
})

test('agentsJoiningSession: members with all and placed agents with all, minus the kept out, with via', async () => {
  const { store, ws1, agent: global } = await setup()
  const mk = (name) => store.createAgent({ name, provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u1' })
  const member = await mk('Member')
  const placed = await mk('Placed')
  const invitedOnly = await mk('Invited')
  const kept = await mk('Kept')
  const elsewhere = await mk('Elsewhere')
  const strangers = await store.createAgent({ name: 'Stranger', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u2' })
  await place(store, global.id, { reach: 'all', sessions: 'all' })
  await store.putWorkspaceMember({ workspaceId: ws1.id, account: `agent:${member.id}`, access: 'edit', addedBy: 'person:u1', sessions: 'all' })
  await place(store, placed.id, { reach: 'workspaces', workspaceIds: [ws1.id], sessions: 'all' })
  await place(store, invitedOnly.id, { reach: 'all', sessions: 'invited' })
  await place(store, kept.id, { reach: 'all', sessions: 'all' })
  await place(store, elsewhere.id, { reach: 'workspaces', workspaceIds: [], sessions: 'all' })
  await store.putWorkspaceMember({ workspaceId: ws1.id, account: `agent:${strangers.id}`, access: 'edit', addedBy: 'person:u1', sessions: 'all' })
  await place(store, strangers.id, { reach: 'all', sessions: 'all' })
  await ownedAndLinked(store, 'room-1', ws1.id, 'person:u1')
  await store.addSessionAgentExclusion({ room: 'room-1', agentId: kept.id, excludedBy: 'person:u1' })
  const got = (await agentsJoiningSession(store, 'room-1')).sort((a, b) => a.agentId.localeCompare(b.agentId))
  const want = [
    { agentId: global.id, via: 'global' },
    { agentId: member.id, via: 'member' },
    { agentId: placed.id, via: 'placed' }
    // Someone else's agent added as a member here with sessions all never joins by itself:
    // only an agent's owner makes it join every session.
  ].sort((a, b) => a.agentId.localeCompare(b.agentId))
  assert.deepEqual(got, want)
  assert.deepEqual(await agentsJoiningSession(store, 'nowhere'), [])
})

test('agentsJoiningSession in an org workspace finds the org\'s agents', async () => {
  const store = createMemoryStore({ now: () => 1000 })
  const { agent, ws } = await makeOrg(store)
  await place(store, agent.id, { reach: 'workspaces', workspaceIds: [ws.id], sessions: 'all' })
  await ownedAndLinked(store, 'room-o', ws.id, 'person:o1')
  assert.deepEqual(await agentsJoiningSession(store, 'room-o'), [{ agentId: agent.id, via: 'placed' }])
})

test('roomAccess: a workspace invites its agents but never lets them in; a session grant does', async () => {
  const { store, ws1, agent } = await setup()
  await place(store, agent.id, { reach: 'all', access: 'view', sessions: 'all' })
  await ownedAndLinked(store, 'room-1', ws1.id, 'person:u1')
  const account = `agent:${agent.id}`
  // Placed (global): invited to the session, but it waits for the owner like anyone with a link.
  assert.equal(await roomAccess(store, 'room-1', account), null)
  // A member row is an invitation too, never admission.
  await store.putWorkspaceMember({ workspaceId: ws1.id, account, access: 'edit', addedBy: 'person:u1', sessions: 'all' })
  assert.equal(await roomAccess(store, 'room-1', account), null)
  // The owner letting it in writes a grant: that is what admits it, kept out or not.
  await store.addSessionAgentExclusion({ room: 'room-1', agentId: agent.id, excludedBy: 'person:u1' })
  await store.putGrant({ room: 'room-1', account, typeId: 'builtin:edit', tighten: {}, grantedBy: 'person:u1' })
  assert.equal((await roomAccess(store, 'room-1', account)).files, 'edit', 'the session owner\'s own grant')
})

test('roomAccess: people still get in through the workspace; owners are unchanged', async () => {
  const { store, ws1, agent } = await setup()
  await place(store, agent.id, { reach: 'all', access: 'edit', scopes: ['src', 'docs'] })
  await ownedAndLinked(store, 'room-1', ws1.id, 'person:u1')
  assert.equal(await roomAccess(store, 'room-1', `agent:${agent.id}`), null)
  await store.putWorkspaceMember({ workspaceId: ws1.id, account: 'person:u2', access: 'edit', addedBy: 'person:u1' })
  assert.deepEqual(await roomAccess(store, 'room-1', 'person:u2'), { files: 'edit', folders: [], foldersExcept: [], talk: true })
})

test('cleanPlacement: checks every field, keeps workspace ids only for reach workspaces', () => {
  assert.deepEqual(REACH, ['all', 'workspaces', 'manual'])
  assert.deepEqual(SESSIONS, ['all', 'invited'])
  const id = '11111111-1111-4111-8111-111111111111'
  assert.deepEqual(cleanPlacement({ reach: 'workspaces', workspaceIds: [id, id], sessions: 'all', access: 'view', scopes: ['./src/', 'docs'] }),
    { reach: 'workspaces', workspaceIds: [id], sessions: 'all', access: 'view', scopes: ['src', 'docs'] })
  assert.deepEqual(cleanPlacement({ reach: 'all', workspaceIds: [id], sessions: 'invited', access: 'edit' }),
    { reach: 'all', workspaceIds: [], sessions: 'invited', access: 'edit', scopes: [] })
  const bad = (body) => assert.throws(() => cleanPlacement(body), (e) => e.status === 400, JSON.stringify(body))
  bad({ reach: 'everywhere', sessions: 'all', access: 'edit' })
  bad({ reach: 'all', sessions: 'some', access: 'edit' })
  bad({ reach: 'all', sessions: 'all', access: 'admin' })
  bad({ reach: 'workspaces', workspaceIds: 'abc', sessions: 'all', access: 'edit' })
  bad({ reach: 'workspaces', workspaceIds: ['not-a-uuid'], sessions: 'all', access: 'edit' })
  bad({ reach: 'workspaces', workspaceIds: Array.from({ length: 101 }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`), sessions: 'all', access: 'edit' })
  bad({ reach: 'all', sessions: 'all', access: 'edit', scopes: ['../etc'] })
  bad({ reach: 'all', sessions: 'all', access: 'edit', scopes: 'src' })
  bad(null)
})
