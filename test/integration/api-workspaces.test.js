// test/api-workspaces.test.js
import { test, before, after } from 'node:test'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from '../helpers/api-helpers.js'

let t
before(async () => { t = await startTestApi({ workspaces: true }) })
after(() => t.close())

test('flag off: every workspace route answers a plain 404, and the API does not file it as a missing route', async () => {
  const off = await startTestApi()
  try {
    for (const [method, path, body] of [['GET', '/v1/me/workspaces'], ['POST', '/v1/workspaces', { name: 'x' }], ['GET', `/v1/workspaces/${crypto.randomUUID()}`], ['POST', `/v1/workspaces/${crypto.randomUUID()}/sessions`, { room: 'r1' }], ['GET', '/v1/workspaces/x/files'], ['POST', '/v1/workspaces/x/folders', { path: 'a' }]]) {
      const r = await off.call(method, path, body, 'mem')
      assert.deepEqual([r.status, r.body], [404, { error: 'not found' }], `${method} ${path}`)
    }
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(off.store.listEvents().filter((e) => e.kind === 'http404'), [])
  } finally { off.close() }
})

test('a person makes a personal workspace, sees it, edits it, deletes it', async () => {
  const made = await t.call('POST', '/v1/workspaces', { name: '  Launch ', description: 'Teaser video', color: 'lilac' }, 'mem')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const w = made.body.workspace
  assert.deepEqual([w.name, w.description, w.color, w.ownerUserId, w.orgId], ['Launch', 'Teaser video', 'lilac', 'mem', null])
  const list = await t.call('GET', '/v1/me/workspaces', null, 'mem')
  const mine = list.body.workspaces.find((x) => x.id === w.id)
  assert.deepEqual([mine.space, mine.access, mine.admin, mine.via, mine.counts], [{ kind: 'personal' }, 'edit', true, 'owner', { sessions: 0, members: 0, open: 0, files: 0 }])
  assert.equal((await t.call('GET', '/v1/me/workspaces', null, 'out')).body.workspaces.some((x) => x.id === w.id), false)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'out')).status, 404, 'outsiders get the same as a missing workspace')
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')
  assert.deepEqual([got.body.access, got.body.owner], [{ access: 'edit', admin: true, via: 'owner' }, { account: 'person:mem', name: 'Mo' }])
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}`, { name: 'Launch 2', color: 'red' }, 'mem')).status, 400)
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}`, { name: 'Launch 2', archived: true }, 'mem')).body.workspace.name, 'Launch 2')
  assert.ok((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.workspace.archivedAt)
  assert.equal((await t.call('POST', '/v1/workspaces', { name: '' }, 'mem')).status, 400)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, 'out')).status, 404)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, 'mem')).status, 200)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).status, 404)
})

test('members: the owner adds people and agents with edit or view, changes and removes them; members see the workspace', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Team' }, 'mem')).body.workspace
  const { agent } = await makeAgent(t, { name: 'Larry', ownerUserId: 'mem' })
  const put = (who, account, access) => t.call('PUT', `/v1/workspaces/${w.id}/members/${account}`, { access }, who)
  assert.equal((await put('out', 'person:lim', 'edit')).status, 404)
  assert.equal((await put('mem', 'person:nobody', 'edit')).status, 404, 'no such account')
  assert.equal((await put('mem', 'person:lim', 'owner')).status, 400)
  assert.deepEqual((await put('mem', 'person:lim', 'view')).body.member.access, 'view')
  assert.deepEqual((await put('mem', `agent:${agent.id}`, 'edit')).body.member.access, 'edit')
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')
  assert.equal(got.status, 200)
  assert.deepEqual(got.body.access, { access: 'view', admin: false, via: 'member' })
  assert.deepEqual(got.body.members.map((m) => [m.account, m.name, m.kind, m.access]), [['person:lim', 'Lin', 'person', 'view'], [`agent:${agent.id}`, 'Larry', 'agent', 'edit']])
  assert.equal((await put('lim', 'person:out', 'edit')).status, 403, 'members do not manage')
  assert.equal((await put('mem', 'person:lim', 'edit')).body.member.access, 'edit')
  assert.equal((await t.call('GET', '/v1/me/workspaces', null, 'lim')).body.workspaces.find((x) => x.id === w.id).access, 'edit')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/members/person:lim`, null, 'mem')).status, 200)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/members/person:lim`, null, 'mem')).status, 404)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')).status, 404)
})

test('org workspaces: Workspaces: Create makes, Update manages, Read sees; the org owns it', async () => {
  const o = await makeOrg(t, 'Ws Co')
  assert.equal((await t.call('POST', '/v1/workspaces', { name: 'Core', org: o.slug }, 'mem')).status, 403, 'Member has only Read')
  assert.equal((await t.call('POST', '/v1/workspaces', { name: 'Core', org: o.slug }, 'out')).status, 404, 'not in the org')
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Core', org: o.slug }, 'admin')).body.workspace
  assert.deepEqual([w.orgId, w.ownerUserId], [o.org.id, null])
  const seen = (await t.call('GET', '/v1/me/workspaces', null, 'mem')).body.workspaces.find((x) => x.id === w.id)
  assert.deepEqual([seen.space, seen.access, seen.admin, seen.via], [{ kind: 'org', slug: o.slug, name: 'Ws Co' }, 'view', false, 'org'])
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}`, { name: 'Core 2' }, 'mem')).status, 403)
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}`, { name: 'Core 2' }, 'admin')).status, 200)
  assert.equal((await t.call('PUT', `/v1/workspaces/${w.id}/members/person:out`, { access: 'edit' }, 'admin')).status, 404, 'people must be in the org')
  assert.equal((await t.call('PUT', `/v1/workspaces/${w.id}/members/person:mem`, { access: 'edit' }, 'admin')).status, 200)
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.access, { access: 'edit', admin: false, via: 'member' })
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, 'mem')).status, 403)
  const { agent, accessKey } = await makeAgent(t, { orgId: o.org.id })
  const notJoined = await t.call('PUT', `/v1/workspaces/${w.id}/members/agent:${agent.id}`, { access: 'edit' }, 'admin')
  assert.deepEqual([notJoined.status, notJoined.body.error], [404, 'that agent is not in the org'])
  const { agent: someonesAgent } = await makeAgent(t, { name: 'Pat', ownerUserId: 'out' })
  assert.equal((await t.call('PUT', `/v1/workspaces/${w.id}/members/agent:${someonesAgent.id}`, { access: 'edit' }, 'admin')).status, 404, "a person's own agent is not in the org")
  await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  assert.equal((await t.call('PUT', `/v1/workspaces/${w.id}/members/agent:${agent.id}`, { access: 'edit' }, 'admin')).status, 200)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, null, { authorization: `Bearer ${accessKey}` })).status, 403, 'agents do not delete org workspaces')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, 'owner')).status, 200)
})

test('sessions: link a room (before the relay reports it), list it, make it loose again', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'S' }, 'mem')).body.workspace
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'view' }, 'mem')
  const linked = await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'room-new1' }, 'mem')
  assert.equal(linked.status, 200, JSON.stringify(linked.body))
  assert.deepEqual([linked.body.session.room, linked.body.session.workspaceId, linked.body.session.ownerAccount, linked.body.session.workspaceLinkedBy], ['room-new1', w.id, null, 'person:mem'], 'the link never sets the owner')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'room-new1' }, 'lim')).status, 403, 'only view')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'bad room!' }, 'mem')).status, 400)
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')
  assert.deepEqual(got.body.sessions.map((s) => s.room), ['room-new1'])
  assert.equal((await t.call('GET', '/v1/me/workspaces', null, 'mem')).body.workspaces.find((x) => x.id === w.id).counts.sessions, 1)
  // Once the relay reports mem as the owner, the room's pass lets the viewer in.
  const { roomAccess } = await import('../../src/api/access.js')
  assert.equal(await roomAccess(t.store, 'room-new1', 'person:lim'), null, 'no owner reported yet')
  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room: 'room-new1', account: 'person:mem', owner: true, name: 'Mo', at: Date.now() }], Date.now())
  assert.equal((await roomAccess(t.store, 'room-new1', 'person:lim')).files, 'view')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/sessions/room-new1`, null, 'lim')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/sessions/room-new1`, null, 'mem')).status, 200)
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.sessions, [])
})

test('linking a room the API has not seen does not claim it; its owner can still link it', async () => {
  const { roomAccess, OWNER_ACCESS } = await import('../../src/api/access.js')
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Outs' }, 'out')).body.workspace
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'view' }, 'out')
  const linked = await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'room-claim1' }, 'out')
  assert.equal(linked.status, 200, JSON.stringify(linked.body))
  assert.equal(linked.body.session.ownerAccount, null)
  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room: 'room-claim1', account: 'person:mem', owner: true, name: 'Mo', at: Date.now() }], Date.now())
  assert.equal(await roomAccess(t.store, 'room-claim1', 'person:out'), null)
  assert.deepEqual(await roomAccess(t.store, 'room-claim1', 'person:mem'), OWNER_ACCESS)
  assert.equal(await roomAccess(t.store, 'room-claim1', 'person:lim'), null)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'room-claim1' }, 'out')).status, 403, 'now the relay has named its owner')
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:mem`, { access: 'edit' }, 'out')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'room-claim1' }, 'mem')).status, 200)
  assert.equal((await roomAccess(t.store, 'room-claim1', 'person:lim')).files, 'view')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/sessions/room-claim1`, null, 'mem')).status, 200)
  const loose = await t.store.sessionByRoom('room-claim1')
  assert.deepEqual([loose.workspaceId, loose.workspaceLinkedBy, loose.ownerAccount], [null, null, 'person:mem'])
})

test('removed from the org: the workspace is gone for them, person or agent', async () => {
  const o = await makeOrg(t, 'Leavers')
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Core', org: o.slug }, 'admin')).body.workspace
  const { agent, accessKey } = await makeAgent(t, { orgId: o.org.id })
  const agentRow = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  assert.equal((await t.call('PUT', `/v1/workspaces/${w.id}/members/person:mem`, { access: 'edit' }, 'admin')).status, 200)
  assert.equal((await t.call('PUT', `/v1/workspaces/${w.id}/members/agent:${agent.id}`, { access: 'edit' }, 'admin')).status, 200)
  const asAgent = { authorization: `Bearer ${accessKey}` }
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).status, 200)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, null, asAgent)).status, 200)
  await t.store.removeMember(o.mem.id)
  await t.store.removeMember(agentRow.id)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).status, 404)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, null, asAgent)).status, 404)
  assert.equal((await t.call('GET', '/v1/me/workspaces', null, 'mem')).body.workspaces.some((x) => x.id === w.id), false)
})

test('an edit member cannot link someone else\'s session; a personal workspace takes any agent', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Edits' }, 'mem')).body.workspace
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'edit' }, 'mem')
  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room: 'room-mo1', account: 'person:mem', owner: true, name: 'Mo', at: Date.now() }], Date.now())
  const r = await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'room-mo1' }, 'lim')
  assert.deepEqual([r.status, r.body.error], [403, 'only the session owner can move it'])
  assert.equal((await t.store.sessionByRoom('room-mo1')).workspaceId, null)
  const { agent } = await makeAgent(t, { name: 'Ola', ownerUserId: 'out' })
  assert.equal((await t.call('PUT', `/v1/workspaces/${w.id}/members/agent:${agent.id}`, { access: 'view' }, 'mem')).status, 200)
})

test('agents: list the workspaces they are members of, never make one', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'For Larry' }, 'mem')).body.workspace
  const { agent, accessKey } = await makeAgent(t, { name: 'Larry', ownerUserId: 'mem' })
  const asAgent = { authorization: `Bearer ${accessKey}` }
  assert.deepEqual((await t.call('GET', '/v1/me/workspaces', null, null, asAgent)).body, { workspaces: [] })
  await t.call('PUT', `/v1/workspaces/${w.id}/members/agent:${agent.id}`, { access: 'view' }, 'mem')
  const list = await t.call('GET', '/v1/me/workspaces', null, null, asAgent)
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.workspaces.map((x) => [x.id, x.access, x.via]), [[w.id, 'view', 'member']])
  const made = await t.call('POST', '/v1/workspaces', { name: 'Mine' }, null, asAgent)
  assert.deepEqual([made.status, made.body.error], [403, 'agents do not make workspaces'])
})

test('GET a workspace says whether the caller may delete it', async () => {
  const canDelete = async (id, who, headers) => (await t.call('GET', `/v1/workspaces/${id}`, null, who, headers)).body.canDelete
  const mine = (await t.call('POST', '/v1/workspaces', { name: 'Del' }, 'mem')).body.workspace
  await t.call('PUT', `/v1/workspaces/${mine.id}/members/person:lim`, { access: 'edit' }, 'mem')
  assert.equal(await canDelete(mine.id, 'mem'), true, 'the owner')
  assert.equal(await canDelete(mine.id, 'lim'), false, 'an edit member')
  const o = await makeOrg(t, 'Del Co')
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Core', org: o.slug }, 'admin')).body.workspace
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:mem`, { access: 'edit' }, 'admin')
  const { agent, accessKey } = await makeAgent(t, { orgId: o.org.id })
  await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  await t.call('PUT', `/v1/workspaces/${w.id}/members/agent:${agent.id}`, { access: 'edit' }, 'admin')
  assert.equal(await canDelete(w.id, 'owner'), true, 'the org owner')
  assert.equal(await canDelete(w.id, 'admin'), true, 'Admin holds Workspaces: Delete')
  assert.equal(await canDelete(w.id, 'mem'), false, 'Member does not, whatever its member row says')
  assert.equal(await canDelete(w.id, null, { authorization: `Bearer ${accessKey}` }), false, 'agents never')
})
