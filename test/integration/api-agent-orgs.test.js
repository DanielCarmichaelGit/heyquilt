import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from '../helpers/api-helpers.js'
import { generateIdentity } from '../../src/identity.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const bearer = (key) => ({ authorization: `Bearer ${key}` })

test('org agents are listed with people as kind agent, with their profile, for those who may read agents', async () => {
  const o = await makeOrg(t, 'Listing Co')
  const { agent } = await makeAgent(t, { name: 'Bot', provider: 'OpenAI', orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  await t.store.addTeamMember({ teamId: core.id, memberId: m.id, access: 'viewer', scopes: ['src'] })
  const r = await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'admin')
  const bot = r.body.members.find((x) => x.id === m.id)
  assert.deepEqual(
    [bot.kind, bot.name, bot.provider, bot.type, bot.agentId, bot.email, bot.role, bot.userId, bot.isYou, bot.isOwner],
    ['agent', 'Bot', 'OpenAI', 'coding agent', agent.id, '', null, null, false, false]
  )
  assert.deepEqual(bot.teams, [{ id: core.id, name: 'Core', access: 'viewer', scopes: ['src'] }])
  assert.deepEqual([bot.canJoinSessions, bot.hosted], [true, true], 'no key, so it joins through the hosted MCP')
  assert.equal('publicKey' in bot, false, 'never expose the key itself')
  const mo = r.body.members.find((x) => x.userId === 'mem')
  assert.deepEqual([mo.kind, mo.provider, mo.type, mo.canJoinSessions, mo.hosted], ['person', null, null, null, null])
  const watcher = await t.store.createRole({ orgId: o.org.id, name: 'Watcher', grants: { agents: { r: true } } })
  await t.store.setMemberRole(o.mem.id, watcher.id)
  assert.deepEqual((await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'mem')).body.members.map((x) => x.kind), ['agent'], 'Agents: Read alone shows only agents')
  const people = await t.store.createRole({ orgId: o.org.id, name: 'People', grants: { members: { r: true } } })
  await t.store.setMemberRole(o.mem.id, people.id)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'mem')).body.members.some((x) => x.kind === 'agent'), false, 'Members: Read alone shows only people')
})

test('an org agent with a public key is not hosted in the member list', async () => {
  const o = await makeOrg(t, 'Keyed Listing Co')
  const id = generateIdentity()
  const { agent } = await makeAgent(t, { name: 'KeyedBot', provider: 'Anthropic', publicKey: id.publicKey, orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const r = await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'admin')
  const bot = r.body.members.find((x) => x.id === m.id)
  assert.deepEqual([bot.canJoinSessions, bot.hosted], [true, false])
})

test("an org agent's role needs Agents: Update and stays within your grid; no role is allowed", async () => {
  const o = await makeOrg(t, 'Role Bot Co')
  const { agent } = await makeAgent(t, { orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const put = (who, roleId) => t.call('PUT', `/v1/orgs/${o.slug}/members/${m.id}`, { roleId }, who)
  assert.equal((await put('mem', o.role('member').id)).status, 403)
  assert.equal((await put('admin', o.role('member').id)).body.member.roleId, o.role('member').id)
  assert.equal((await put('admin', null)).body.member.roleId, null)
  assert.equal((await put('admin', o.role('owner').id)).status, 403)
  const tender = await t.store.createRole({ orgId: o.org.id, name: 'Tender', grants: { agents: { u: true } } })
  await t.store.setMemberRole(o.mem.id, tender.id)
  assert.equal((await put('mem', o.role('admin').id)).status, 403, 'Admin holds more than Tender')
  assert.equal((await put('mem', null)).status, 200, 'Tender can take a role away')
})

test("an org agent's role is left alone by a PUT body that leaves roleId out entirely", async () => {
  const o = await makeOrg(t, 'Partial Body Co')
  const { agent } = await makeAgent(t, { orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id, roleId: o.role('member').id })
  const r = await t.call('PUT', `/v1/orgs/${o.slug}/members/${m.id}`, {}, 'admin')
  assert.deepEqual([r.status, r.body.error], [400, 'roleId is required; use null to clear the role'])
  assert.equal((await t.store.memberById(o.org.id, m.id)).roleId, o.role('member').id, "a missing roleId never clears the agent's role")
})

test("an agent's team folders change with Team membership; people have no folders", async () => {
  const o = await makeOrg(t, 'Folder Co')
  const core = (await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Core' }, 'admin')).body.team
  const { agent } = await makeAgent(t, { name: 'Bot', orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const base = `/v1/orgs/${o.slug}/teams/${core.id}/members`
  const added = await t.call('POST', base, { memberId: m.id, access: 'editor', scopes: ['src'] }, 'admin')
  assert.deepEqual(added.body.member, { memberId: m.id, access: 'editor', scopes: ['src'] })
  assert.equal((await t.call('POST', base, { memberId: o.mem.id, access: 'viewer', scopes: ['src'] }, 'admin')).status, 400, 'folders are for agents')
  const changed = await t.call('PUT', `${base}/${m.id}`, { access: 'viewer', scopes: ['docs/', 'web'] }, 'admin')
  assert.deepEqual(changed.body.member, { memberId: m.id, access: 'viewer', scopes: ['docs', 'web'] })
  assert.deepEqual((await t.call('PUT', `${base}/${m.id}`, { access: 'editor' }, 'admin')).body.member.scopes, ['docs', 'web'], 'access alone keeps the folders')
  assert.equal((await t.call('PUT', `${base}/${m.id}`, { access: 'viewer', scopes: ['/etc'] }, 'admin')).status, 400)
  assert.equal((await t.call('PUT', `${base}/${m.id}`, { access: 'viewer', scopes: ['x'] }, 'mem')).status, 403)
  const listed = (await t.call('GET', `/v1/orgs/${o.slug}/teams`, null, 'admin')).body
  assert.deepEqual(listed.teams[0].members, [{ memberId: m.id, name: 'Bot', access: 'editor', kind: 'agent', scopes: ['docs', 'web'] }])
  assert.equal(listed.people.find((p) => p.memberId === m.id).kind, 'agent')
})

test('removing an org agent needs Agents: Delete, and revokes it', async () => {
  const o = await makeOrg(t, 'Revoke Co')
  const { agent, accessKey } = await makeAgent(t, { orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const remover = await t.store.createRole({ orgId: o.org.id, name: 'Remover', grants: { members: { r: true, d: true } } })
  await t.store.setMemberRole(o.mem.id, remover.id)
  const del = (who) => t.call('DELETE', `/v1/orgs/${o.slug}/members/${m.id}`, null, who)
  assert.equal((await del('mem')).status, 403, 'Members: Delete is for people')
  assert.equal((await del('admin')).status, 200)
  assert.ok((await t.store.agentById(agent.id)).revokedAt > 0)
  assert.equal(await t.store.memberByAgent(o.org.id, agent.id), null)
  assert.equal((await t.call('GET', '/v1/agents/me', null, null, bearer(accessKey))).status, 401)
})
