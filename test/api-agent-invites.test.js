import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, API_URL } from './api-helpers.js'
import { newToken, hashToken } from '../src/api/tokens.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const LINK = new RegExp(`^${API_URL.replace(/\./g, '\\.')}/v1/join/qj_[A-Za-z0-9_-]{43}$`)

test('a person makes a personal invite: a one-time link that lasts an hour, stored only as a hash', async () => {
  assert.equal((await t.call('POST', '/v1/agent-invites', {})).status, 401)
  const r = await t.call('POST', '/v1/agent-invites', {}, 'mem')
  assert.equal(r.status, 200)
  assert.match(r.body.link, LINK)
  assert.deepEqual([r.body.invite.kind, r.body.invite.status, r.body.invite.usedBy, r.body.invite.role, r.body.invite.teams], ['personal', 'waiting', null, null, []])
  assert.ok(Math.abs(r.body.invite.expiresAt - (Date.now() + 60 * 60 * 1000)) < 5000)
  const token = r.body.link.split('/v1/join/')[1]
  const stored = await t.store.agentInviteById(r.body.invite.id)
  assert.equal(stored.tokenHash, hashToken(token))
  assert.equal(JSON.stringify(stored).includes(token), false)
  assert.ok((await t.call('GET', '/v1/agent-invites', null, 'mem')).body.invites.some((i) => i.id === r.body.invite.id))
  assert.equal((await t.call('GET', '/v1/agent-invites', null, 'lim')).body.invites.some((i) => i.id === r.body.invite.id), false)
})

test('a waiting personal invite is cancelled by its owner only, once', async () => {
  const { invite } = (await t.call('POST', '/v1/agent-invites', {}, 'mem')).body
  assert.equal((await t.call('DELETE', `/v1/agent-invites/${invite.id}`, null, 'lim')).status, 404)
  assert.equal((await t.call('DELETE', '/v1/agent-invites/not-a-uuid', null, 'mem')).status, 404)
  assert.equal((await t.call('DELETE', `/v1/agent-invites/${invite.id}`, null, 'mem')).status, 200)
  assert.equal((await t.call('DELETE', `/v1/agent-invites/${invite.id}`, null, 'mem')).status, 409)
  const listed = (await t.call('GET', '/v1/agent-invites', null, 'mem')).body.invites.find((i) => i.id === invite.id)
  assert.equal(listed.status, 'cancelled')
})

test('an invite past its hour shows as expired', async () => {
  const old = await t.store.createAgentInvite({ tokenHash: hashToken(newToken('qj_')), ownerUserId: 'out', createdBy: 'out', expiresAt: Date.now() - 1 })
  const listed = (await t.call('GET', '/v1/agent-invites', null, 'out')).body.invites.find((i) => i.id === old.id)
  assert.equal(listed.status, 'expired')
})

test('an expired invite cannot be cancelled', async () => {
  const old = await t.store.createAgentInvite({ tokenHash: hashToken(newToken('qj_')), ownerUserId: 'out', createdBy: 'out', expiresAt: Date.now() - 1 })
  assert.equal((await t.call('DELETE', `/v1/agent-invites/${old.id}`, null, 'out')).status, 409)
})

test('an org invite needs Agents: Create, and carries a role and teams; access defaults to viewer', async () => {
  const o = await makeOrg(t, 'Invite Bots Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const web = await t.store.createTeam({ orgId: o.org.id, name: 'Web' })
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const base = `/v1/orgs/${o.slug}/agent-invites`
  assert.equal((await t.call('POST', base, {}, 'mem')).status, 403, 'Member has no Agents: Create')
  assert.equal((await t.call('POST', base, {}, 'out')).status, 404, 'not in the org')
  const r = await t.call('POST', base, { roleId: lead.id, teams: [{ teamId: core.id, access: 'editor', scopes: ['src/', './docs'] }, { teamId: web.id }] }, 'admin')
  assert.equal(r.status, 200)
  assert.match(r.body.link, LINK)
  assert.deepEqual([r.body.invite.kind, r.body.invite.role], ['org', 'Lead'])
  assert.deepEqual(r.body.invite.teams, [{ id: core.id, name: 'Core', access: 'editor', scopes: ['src', 'docs'] }, { id: web.id, name: 'Web', access: 'viewer', scopes: [] }])
  const stored = await t.store.agentInviteById(r.body.invite.id)
  assert.deepEqual([stored.orgId, stored.roleId, stored.createdBy, stored.ownerUserId], [o.org.id, lead.id, 'admin', null])
  const none = await t.call('POST', base, {}, 'admin')
  assert.deepEqual([none.body.invite.role, none.body.invite.teams], [null, []], 'no role and no teams is fine')
  const listed = (await t.call('GET', base, null, 'admin')).body.invites
  assert.deepEqual(listed.map((i) => i.id).sort(), [r.body.invite.id, none.body.invite.id].sort())
  assert.equal((await t.call('GET', base, null, 'mem')).status, 403)
})

test('org invite choices are checked against the inviter: roles within their grid, teams they may add to', async () => {
  const o = await makeOrg(t, 'Invite Rights Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  // Member now holds Workspaces: Read, so a role that hands out Member must too.
  const inviter = await t.store.createRole({ orgId: o.org.id, name: 'Inviter', grants: { agents: { c: true }, teams: { r: true }, workspaces: { r: true } } })
  await t.store.setMemberRole(o.mem.id, inviter.id)
  const go = (body, who = 'mem') => t.call('POST', `/v1/orgs/${o.slug}/agent-invites`, body, who)
  assert.equal((await go({ teams: [{ teamId: core.id }] })).status, 403, 'no Team membership: Create')
  assert.equal((await go({ roleId: o.role('admin').id })).status, 403, 'Admin holds more than Inviter')
  assert.equal((await go({ roleId: o.role('owner').id }, 'owner')).status, 403, 'never Owner')
  assert.equal((await go({ roleId: 'not-a-uuid' })).status, 404)
  assert.equal((await go({ roleId: o.role('member').id })).status, 200, 'Member is within Inviter')
})

test('org invite teams are real teams of this org, once each, editor or viewer, folders inside the project', async () => {
  const o = await makeOrg(t, 'Invite Check Co'); const other = await makeOrg(t, 'Invite Elsewhere Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const theirs = await t.store.createTeam({ orgId: other.org.id, name: 'Theirs' })
  const go = (teams) => t.call('POST', `/v1/orgs/${o.slug}/agent-invites`, { teams }, 'admin')
  assert.equal((await go([{ teamId: theirs.id }])).status, 404)
  assert.equal((await go([{ teamId: core.id }, { teamId: core.id, access: 'editor' }])).status, 400)
  assert.equal((await go([{ teamId: core.id, access: 'owner' }])).status, 400)
  assert.equal((await go([{ teamId: core.id, scopes: ['../secrets'] }])).status, 400)
  assert.equal((await go([{ teamId: core.id, scopes: Array.from({ length: 21 }, (_, i) => `d${i}`) }])).status, 400)
  assert.equal((await go('Core')).status, 400)
  assert.equal((await go([{ teamId: core.id, scopes: ['src'] }])).status, 200)
})

test('making agent invites is rate-limited per caller, personal and org share the budget', async () => {
  const c = await startTestApi({ inviteSendLimit: 2 })
  try {
    const o = await makeOrg(c, 'Agent Rate Co')
    assert.equal((await c.call('POST', '/v1/agent-invites', {}, 'admin')).status, 200)
    assert.equal((await c.call('POST', `/v1/orgs/${o.slug}/agent-invites`, {}, 'admin')).status, 200)
    assert.equal((await c.call('POST', '/v1/agent-invites', {}, 'admin')).status, 429)
  } finally { await c.close() }
})

test('org invites are cancelled with Agents: Create, and only in their own org', async () => {
  const o = await makeOrg(t, 'Invite Cancel Co'); const other = await makeOrg(t, 'Invite Cancel Other')
  const { invite } = (await t.call('POST', `/v1/orgs/${o.slug}/agent-invites`, {}, 'admin')).body
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/agent-invites/${invite.id}`, null, 'mem')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/orgs/${other.slug}/agent-invites/${invite.id}`, null, 'owner')).status, 404)
  assert.equal((await t.call('DELETE', `/v1/agent-invites/${invite.id}`, null, 'admin')).status, 404, 'not a personal invite')
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/agent-invites/${invite.id}`, null, 'admin')).status, 200)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/agent-invites/${invite.id}`, null, 'admin')).status, 409)
})

// The Quilt app invites agents too, with the computer's own qd_ token rather than a website JWT.
test('a linked computer makes, lists and cancels personal invites, and lists agents, for its account', async () => {
  const { linkDevice } = await import('./api-helpers.js')
  const { token } = await linkDevice(t, 'mem')
  const auth = { authorization: `Bearer ${token}` }
  const made = await t.call('POST', '/v1/agent-invites', {}, null, auth)
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.match(made.body.link, LINK)
  assert.equal(made.body.invite.kind, 'personal')
  const mine = (await t.call('GET', '/v1/agent-invites', null, 'mem')).body.invites
  assert.ok(mine.some((i) => i.id === made.body.invite.id), 'the website sees the invite the app made')
  assert.ok((await t.call('GET', '/v1/agent-invites', null, null, auth)).body.invites.some((i) => i.id === made.body.invite.id), 'and so does the app')
  assert.equal((await t.call('GET', '/v1/agents', null, null, auth)).status, 200)
  assert.equal((await t.call('DELETE', `/v1/agent-invites/${made.body.invite.id}`, null, null, auth)).status, 200)
  // A revoked computer is signed out everywhere.
  await t.call('POST', '/v1/me/signout', {}, null, auth)
  assert.equal((await t.call('POST', '/v1/agent-invites', {}, null, auth)).status, 401)
  assert.equal((await t.call('GET', '/v1/agents', null, null, auth)).status, 401)
})

test('org agent invites still need the website sign-in, not a computer token', async () => {
  const { linkDevice } = await import('./api-helpers.js')
  const o = await makeOrg(t, 'Device Bots Co')
  const { token } = await linkDevice(t, 'admin')
  const auth = { authorization: `Bearer ${token}` }
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/agent-invites`, {}, null, auth)).status, 401)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/agent-invites`, null, null, auth)).status, 401)
})
