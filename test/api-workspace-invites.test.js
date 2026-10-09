// Workspace invites, the invites waiting for you (GET /v1/me/invites), and moving a session
// into a workspace bringing its people along.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi, makeOrg, makeAgent } from './api-helpers.js'

let t
before(async () => { t = await startTestApi({ workspaces: true }) })
after(() => t.close())
let rooms = 0
const start = (room, account, name, extra = {}) => ({ id: crypto.randomUUID(), type: 'start', room, account, name, at: Date.now() - 1000, ...extra })

/** Mo has worked with Lin (and Larry) before. */
async function workedTogether () {
  const room = `together-${++rooms}`
  await t.store.ingestPresence([start(room, 'person:mem', 'Mo', { owner: true }), start(room, 'person:lim', 'Lin')], Date.now())
}
const ws = async (name, who = 'mem', extra = {}) => (await t.call('POST', '/v1/workspaces', { name, ...extra }, who)).body.workspace
const mine = async (who) => (await t.call('GET', '/v1/me/invites', null, who)).body.invites

test('inviting someone you have worked with: it waits in their invites until they accept', async () => {
  await workedTogether()
  const w = await ws('Launch')
  t.sent.length = 0
  const res = await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { account: 'person:lim' }, access: 'view' }, 'mem')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual([res.body.invite.account, res.body.invite.name, res.body.invite.access, res.body.invite.status, res.body.invite.email], ['person:lim', 'Lin', 'view', 'waiting', undefined])
  assert.equal(t.sent.length, 1, 'they hear about it by email too')
  assert.equal(t.sent[0].to, 'lin@acme.com')
  assert.equal(t.sent[0].subject, 'Mo invited you to the Launch workspace on Quilt')
  assert.ok(t.sent[0].text.includes('https://quilt.test/dashboard'))
  assert.ok(!JSON.stringify((await t.call('GET', `/v1/workspaces/${w.id}/invites`, null, 'mem')).body).includes('lin@acme.com'), 'never shows their email')
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')).status, 404, 'nothing changes until they accept')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { account: 'person:lim' } }, 'mem')).status, 409)

  const waiting = await mine('lim')
  const inv = waiting.find((i) => i.kind === 'workspace' && i.workspace.id === w.id)
  assert.deepEqual([inv.workspace.name, inv.access, inv.from.name], ['Launch', 'view', 'Mo'])
  assert.equal((await t.call('POST', `/v1/me/invites/${inv.id}/accept`, {}, 'out')).status, 404, 'only theirs')
  const ok = await t.call('POST', `/v1/me/invites/${inv.id}/accept`, {}, 'lim')
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')).body.access, { access: 'view', admin: false, via: 'member' })
  assert.equal((await t.call('POST', `/v1/me/invites/${inv.id}/accept`, {}, 'lim')).status, 410)
  assert.equal((await mine('lim')).some((i) => i.id === inv.id), false)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { account: 'person:lim' } }, 'mem')).status, 409, 'already in')
})

test('only people you know, never yourself or an agent; only admins invite', async () => {
  const w = await ws('Strangers')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { account: 'person:out' } }, 'mem')).status, 404)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { account: 'person:mem' } }, 'mem')).status, 400)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { account: 'agent:x' } }, 'mem')).status, 400)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { email: 'nope' } }, 'mem')).status, 400)
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'edit' }, 'mem')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { email: 'a@b.com' } }, 'lim')).status, 403, 'members do not invite')
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}/invites`, null, 'lim')).status, 403)
})

test('an email invite: sent, waiting for whoever signs in with that address, declined, cancelled', async () => {
  const w = await ws('Mailroom')
  t.sent.length = 0
  const res = await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { email: ' Otto@Else.com ' } }, 'mem')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual([res.body.invite.email, res.body.invite.access], ['otto@else.com', 'edit'])
  assert.equal(t.sent[0].to, 'otto@else.com')
  assert.ok(t.sent[0].text.includes('https://quilt.test/signup'))
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { email: 'otto@else.com' } }, 'mem')).status, 409)
  const inv = (await mine('out')).find((i) => i.workspace?.id === w.id)
  assert.ok(inv, 'Otto signs in with that address and sees it')
  assert.equal((await t.call('POST', `/v1/me/invites/${inv.id}/decline`, {}, 'out')).status, 200)
  assert.equal((await mine('out')).some((i) => i.id === inv.id), false)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'out')).status, 404)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}/invites`, null, 'mem')).body.invites[0].status, 'declined')

  const again = (await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { email: 'otto@else.com' } }, 'mem')).body.invite
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/invites/${again.id}`, null, 'mem')).status, 200)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/invites/${again.id}`, null, 'mem')).status, 409)
  assert.equal((await mine('out')).some((i) => i.id === again.id), false)
})

test("an unconfirmed address doesn't count as yours", async () => {
  const w = await ws('Unconf')
  await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { email: 'una@acme.com' } }, 'mem')
  assert.equal((await mine('unconf')).some((i) => i.workspace?.id === w.id), false)
})

test("an org's workspace invites its own people; accepting needs the org", async () => {
  const o = await makeOrg(t, 'Invite Co')
  const w = await ws('Core', 'admin', { org: o.slug })
  const inv = await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { account: 'person:mem' } }, 'admin')
  assert.equal(inv.status, 200, JSON.stringify(inv.body))
  const mail = (await t.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { email: 'otto@else.com' } }, 'admin')).body.invite
  const otto = (await mine('out')).find((i) => i.id === mail.id)
  assert.equal(otto.workspace.org, 'Invite Co')
  const refused = await t.call('POST', `/v1/me/invites/${mail.id}/accept`, {}, 'out')
  assert.deepEqual([refused.status, refused.body.error], [403, 'This workspace belongs to Invite Co. Ask them to add you to the org, then accept again.'])
  assert.equal((await t.call('POST', `/v1/me/invites/${inv.body.invite.id}/accept`, {}, 'mem')).status, 200)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.access.via, 'member')
})

test('session invites wait in your invites with their link; declining takes the access back', async () => {
  const room = `sess-${++rooms}`
  await t.store.ingestPresence([start(`old-${room}`, 'person:mem', 'Mo', { owner: true }), start(`old-${room}`, 'person:lim', 'Lin'), start(room, 'person:mem', 'Mo', { owner: true }), { id: crypto.randomUUID(), type: 'name', room, name: 'Pricing', at: Date.now() }], Date.now())
  const link = `https://join.heyquilt.com/${room}#sekrit`
  const sent = await t.call('POST', `/v1/sessions/${room}/invites`, { link, typeId: 'builtin:view', to: { account: 'person:lim' } }, 'mem')
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  assert.ok(!JSON.stringify((await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body).includes('sekrit'), 'the owner never sees it again')
  const inv = (await mine('lim')).find((i) => i.kind === 'session' && i.session.room === room)
  assert.deepEqual([inv.session.name, inv.link, inv.access, inv.from.name], ['Pricing', link, 'View only', 'Mo'])
  assert.equal((await mine('out')).some((i) => i.id === inv.id), false)
  assert.equal((await t.call('POST', `/v1/me/invites/${inv.id}/decline`, {}, 'out')).status, 404)
  assert.ok(await t.store.grantFor(room, 'person:lim'))
  assert.equal((await t.call('POST', `/v1/me/invites/${inv.id}/decline`, {}, 'lim')).status, 200)
  assert.equal(await t.store.grantFor(room, 'person:lim'), null)
  assert.equal((await mine('lim')).some((i) => i.id === inv.id), false)
})

test("moving a session into a workspace brings its people and agents, with their session's access", async () => {
  const room = `move-${++rooms}`
  const { agent } = await makeAgent(t, { name: 'Larry', ownerUserId: 'mem' })
  const { agent: kept } = await makeAgent(t, { name: 'Kept', ownerUserId: 'mem' })
  await t.store.ingestPresence([
    start(room, 'person:mem', 'Mo', { owner: true }), start(room, 'person:lim', 'Lin'), start(room, `agent:${agent.id}`, 'Larry'),
    start(room, 'person:admin', 'Ada'), start(room, `agent:${kept.id}`, 'Kept')
  ], Date.now())
  await t.store.putGrant({ room, account: 'person:lim', typeId: 'builtin:view', grantedBy: 'person:mem' })
  await t.store.putGrant({ room, account: 'email:new@x.com', typeId: 'builtin:edit', grantedBy: 'person:mem' })
  await t.store.addSessionAgentExclusion({ room, agentId: kept.id, excludedBy: 'person:mem' })
  const w = await ws('Moved')
  const moved = await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room }, 'mem')
  assert.equal(moved.status, 200, JSON.stringify(moved.body))
  assert.deepEqual(moved.body.added.map((a) => [a.account, a.access, a.kind]).sort(), [['person:admin', 'edit', 'person'], ['person:lim', 'view', 'person'], [`agent:${agent.id}`, 'edit', 'agent']].sort())
  const members = (await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.members.map((m) => [m.account, m.access]).sort()
  assert.deepEqual(members, [['person:admin', 'edit'], ['person:lim', 'view'], [`agent:${agent.id}`, 'edit']].sort())
  // Moving it again changes nothing, and never lowers anyone.
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'edit' }, 'mem')
  assert.deepEqual((await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room }, 'mem')).body.added, [])
  assert.equal((await t.store.workspaceMember(w.id, 'person:lim')).access, 'edit')
})

test("an editor who isn't an admin can move their own session, but its people stay out", async () => {
  const room = `edmove-${++rooms}`
  await t.store.ingestPresence([start(room, 'person:lim', 'Lin', { owner: true }), start(room, 'person:out', 'Otto')], Date.now())
  const w = await ws('Editors')
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'edit' }, 'mem')
  const r = await t.call('POST', `/v1/workspaces/${w.id}/sessions`, { room }, 'lim')
  assert.deepEqual([r.status, r.body.added, r.body.peopleNeedAdmin], [200, [], true])
  assert.equal(await t.store.workspaceMember(w.id, 'person:out'), null)
})

test('flag off: workspace invites are 404; session invites still list', async () => {
  const off = await startTestApi()
  try {
    assert.equal((await off.call('GET', `/v1/workspaces/${crypto.randomUUID()}/invites`, null, 'mem')).status, 404)
    assert.equal((await off.call('POST', `/v1/me/invites/${crypto.randomUUID()}/accept`, {}, 'mem')).status, 404)
    const r = await off.call('GET', '/v1/me/invites', null, 'mem')
    assert.deepEqual([r.status, r.body.invites], [200, []])
  } finally { off.close() }
})
