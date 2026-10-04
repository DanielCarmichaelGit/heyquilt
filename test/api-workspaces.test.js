// test/api-workspaces.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from './api-helpers.js'

let t
before(async () => { t = await startTestApi({ workspaces: true }) })
after(() => t.close())

test('flag off: the routes do not exist', async () => {
  const off = await startTestApi()
  try {
    assert.equal((await off.call('GET', '/v1/me/workspaces', null, 'mem')).status, 404)
    assert.equal((await off.call('POST', '/v1/workspaces', { name: 'x' }, 'mem')).status, 404)
  } finally { off.close() }
})

test('a person makes a personal workspace, sees it, edits it, deletes it', async () => {
  const made = await t.call('POST', '/v1/workspaces', { name: '  Launch ', description: 'Teaser video', color: 'lilac' }, 'mem')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const w = made.body.workspace
  assert.deepEqual([w.name, w.description, w.color, w.ownerUserId, w.orgId], ['Launch', 'Teaser video', 'lilac', 'mem', null])
  const list = await t.call('GET', '/v1/me/workspaces', null, 'mem')
  const mine = list.body.workspaces.find((x) => x.id === w.id)
  assert.deepEqual([mine.space, mine.access, mine.admin, mine.via, mine.counts], [{ kind: 'personal' }, 'edit', true, 'owner', { sessions: 0, members: 0, open: 0 }])
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
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, 'owner')).status, 200)
})

test('sessions: link a room (before the relay reports it), list it, make it loose again', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'S' }, 'mem')).body.workspace
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'view' }, 'mem')
  const linked = await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'room-new1' }, 'mem')
  assert.equal(linked.status, 200, JSON.stringify(linked.body))
  assert.deepEqual([linked.body.session.room, linked.body.session.workspaceId, linked.body.session.ownerAccount], ['room-new1', w.id, 'person:mem'])
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'room-new1' }, 'lim')).status, 403, 'not the owner, and only view')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'bad room!' }, 'mem')).status, 400)
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')
  assert.deepEqual(got.body.sessions.map((s) => s.room), ['room-new1'])
  assert.equal((await t.call('GET', '/v1/me/workspaces', null, 'mem')).body.workspaces.find((x) => x.id === w.id).counts.sessions, 1)
  // The room's pass now lets the viewer in.
  const { roomAccess } = await import('../src/api/access.js')
  assert.equal((await roomAccess(t.store, 'room-new1', 'person:lim')).files, 'view')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/sessions/room-new1`, null, 'lim')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/sessions/room-new1`, null, 'mem')).status, 200)
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.sessions, [])
})
