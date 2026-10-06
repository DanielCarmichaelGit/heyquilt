// test/api-workspace-agents.test.js
// Agents in workspaces, over HTTP: placements (personal and org), a workspace's override,
// member `sessions`, workspace agent invites, per-session keep-outs, the agent's own webhook,
// and the agents a workspace page lists. All behind the workspaces flag.
import { test, before, after } from 'node:test'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from './api-helpers.js'
import { verifyWebhook } from '../src/webhooks.js'
import { newPassKeys, signPass, PASS_TTL_MS } from '../src/passes.js'

let t
before(async () => { t = await startTestApi({ workspaces: true }) })
after(() => t.close())

const asAgent = (accessKey) => ({ authorization: `Bearer ${accessKey}` })
const newWs = async (who, name, org) => (await t.call('POST', '/v1/workspaces', { name, ...(org ? { org } : {}) }, who)).body.workspace
let eventId = 0
/** `room`, owned by `owner` as the relay reports it. */
const ownedRoom = (room, owner) => t.store.ingestPresence([{ id: `wa${++eventId}`, type: 'start', room, account: owner, owner: true, name: '', at: Date.now() }], Date.now())

test('GET /v1/features answers either way, with no sign-in', async () => {
  assert.deepEqual((await t.call('GET', '/v1/features')).body, { workspaces: true })
  const off = await startTestApi()
  try { assert.deepEqual((await off.call('GET', '/v1/features')).body, { workspaces: false }) } finally { off.close() }
})

test('flag off: every new route answers a plain 404', async () => {
  const off = await startTestApi()
  try {
    const id = crypto.randomUUID()
    const o = await makeOrg(off, 'Off Co')
    const { accessKey } = await makeAgent(off, { ownerUserId: 'mem' })
    const cases = [
      ['GET', `/v1/me/agents/${id}/placement`, null, 'mem'],
      ['PUT', `/v1/me/agents/${id}/placement`, { reach: 'all', sessions: 'all', access: 'edit' }, 'mem'],
      ['GET', `/v1/orgs/${o.slug}/agents`, null, 'owner'],
      ['PUT', `/v1/orgs/${o.slug}/agents/${id}/placement`, { reach: 'all', sessions: 'all', access: 'edit' }, 'owner'],
      ['PUT', `/v1/workspaces/${id}/agents/${id}`, { excluded: true }, 'mem'],
      ['DELETE', `/v1/workspaces/${id}/agents/${id}`, null, 'mem'],
      ['POST', `/v1/workspaces/${id}/agent-invites`, { access: 'edit', sessions: 'all' }, 'mem'],
      ['PUT', `/v1/sessions/r1/agents/${id}/exclude`, null, 'mem'],
      ['DELETE', `/v1/sessions/r1/agents/${id}/exclude`, null, 'mem'],
      ['GET', '/v1/sessions/r1/agents/excluded', null, 'mem'],
      ['POST', `/v1/workspaces/${id}/sessions/r1/started`, { link: 'https://join.heyquilt.com/r1#s' }, 'mem']
    ]
    for (const [method, path, body, who] of cases) {
      const r = await off.call(method, path, body, who)
      assert.deepEqual([r.status, r.body], [404, { error: 'not found' }], `${method} ${path}`)
    }
    for (const method of ['PUT', 'DELETE']) {
      const r = await off.call(method, '/v1/agents/me/webhook', { url: 'https://hooks.example.com/q' }, null, asAgent(accessKey))
      assert.deepEqual([r.status, r.body], [404, { error: 'not found' }], `${method} webhook`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(off.store.listEvents().filter((e) => e.kind === 'http404'), [])
  } finally { off.close() }
})

test('personal placement: the owner reads a manual default, sets it, and only their own workspaces are accepted', async () => {
  const { agent } = await makeAgent(t, { name: 'Pia', ownerUserId: 'lim' })
  const mine = await newWs('lim', 'Lim one')
  const theirs = await newWs('out', 'Otto one')
  const path = `/v1/me/agents/${agent.id}/placement`
  const got = await t.call('GET', path, null, 'lim')
  assert.equal(got.status, 200, JSON.stringify(got.body))
  assert.deepEqual(got.body.placement, { agentId: agent.id, reach: 'manual', workspaceIds: [], sessions: 'invited', access: 'edit', scopes: [], updatedAt: null })
  assert.equal((await t.call('GET', path, null, 'out')).status, 404, "someone else's agent")
  assert.equal((await t.call('PUT', path, { reach: 'all', sessions: 'all', access: 'edit' }, 'out')).status, 404)
  assert.equal((await t.call('PUT', path, { reach: 'everywhere', sessions: 'all', access: 'edit' }, 'lim')).status, 400)
  const bad = await t.call('PUT', path, { reach: 'workspaces', workspaceIds: [theirs.id], sessions: 'all', access: 'edit' }, 'lim')
  assert.equal(bad.status, 400, "another owner's workspace")
  assert.equal((await t.call('PUT', path, { reach: 'workspaces', workspaceIds: [crypto.randomUUID()], sessions: 'all', access: 'edit' }, 'lim')).status, 400, 'a workspace that does not exist')
  const put = await t.call('PUT', path, { reach: 'workspaces', workspaceIds: [mine.id], sessions: 'all', access: 'view', scopes: ['docs'] }, 'lim')
  assert.equal(put.status, 200, JSON.stringify(put.body))
  assert.deepEqual([put.body.placement.reach, put.body.placement.workspaceIds, put.body.placement.sessions, put.body.placement.access, put.body.placement.scopes], ['workspaces', [mine.id], 'all', 'view', ['docs']])
  assert.ok(put.body.placement.updatedAt)
  assert.deepEqual((await t.call('GET', path, null, 'lim')).body.placement.workspaceIds, [mine.id])
  // An org workspace never counts as a personal agent's own, even for an org owner.
  const o = await makeOrg(t, 'Pers Co')
  const { agent: ownersAgent } = await makeAgent(t, { name: 'Oz', ownerUserId: 'owner' })
  const orgWs = await newWs('owner', 'Org thing', o.slug)
  assert.equal((await t.call('PUT', `/v1/me/agents/${ownersAgent.id}/placement`, { reach: 'workspaces', workspaceIds: [orgWs.id], sessions: 'all', access: 'edit' }, 'owner')).status, 400)
  // An org agent is not a personal one.
  const { agent: orgAgent } = await makeAgent(t, { orgId: o.org.id })
  assert.equal((await t.call('GET', `/v1/me/agents/${orgAgent.id}/placement`, null, 'owner')).status, 404)
})

test('org agents: Agents: Read lists them with their placement; Agents: Update places them in the org\'s workspaces only', async () => {
  const o = await makeOrg(t, 'Place Co')
  const { agent } = await makeAgent(t, { name: 'Bot', provider: 'OpenAI', type: 'coding agent', orgId: o.org.id })
  await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const ws = await newWs('admin', 'Core', o.slug)
  const other = await newWs('mem', 'Mo personal')
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/agents`, null, 'mem')).status, 403, 'Member has no Agents: Read')
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/agents`, null, 'out')).status, 404)
  const list = await t.call('GET', `/v1/orgs/${o.slug}/agents`, null, 'admin')
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.deepEqual(list.body.agents, [{ id: agent.id, name: 'Bot', provider: 'OpenAI', type: 'coding agent', hosted: true, placement: { agentId: agent.id, reach: 'manual', workspaceIds: [], sessions: 'invited', access: 'edit', scopes: [], updatedAt: null } }])
  const path = `/v1/orgs/${o.slug}/agents/${agent.id}/placement`
  assert.equal((await t.call('PUT', path, { reach: 'all', sessions: 'all', access: 'edit' }, 'mem')).status, 403)
  assert.equal((await t.call('PUT', path, { reach: 'workspaces', workspaceIds: [other.id], sessions: 'all', access: 'edit' }, 'admin')).status, 400, 'not the org\'s workspace')
  const { agent: personal } = await makeAgent(t, { ownerUserId: 'admin' })
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/agents/${personal.id}/placement`, { reach: 'all', sessions: 'all', access: 'edit' }, 'admin')).status, 404, 'not the org\'s agent')
  const put = await t.call('PUT', path, { reach: 'workspaces', workspaceIds: [ws.id], sessions: 'all', access: 'edit' }, 'admin')
  assert.equal(put.status, 200, JSON.stringify(put.body))
  assert.deepEqual(put.body.placement.workspaceIds, [ws.id])
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/agents`, null, 'owner')).body.agents[0].placement.reach, 'workspaces')
})

test('an agent finds the workspaces it reaches by placement in GET /v1/me/workspaces; people\'s answers are unchanged', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Finder', ownerUserId: 'admin' })
  const a = await newWs('admin', 'Alpha')
  const b = await newWs('admin', 'Beta')
  const notMine = await newWs('out', 'Otto two')
  const ids = async () => (await t.call('GET', '/v1/me/workspaces', null, null, asAgent(accessKey))).body.workspaces.map((w) => w.id)
  assert.deepEqual(await ids(), [])
  await t.call('PUT', `/v1/me/agents/${agent.id}/placement`, { reach: 'workspaces', workspaceIds: [b.id], sessions: 'invited', access: 'view' }, 'admin')
  assert.deepEqual(await ids(), [b.id])
  await t.call('PUT', `/v1/me/agents/${agent.id}/placement`, { reach: 'all', sessions: 'invited', access: 'edit' }, 'admin')
  const all = await ids()
  assert.ok(all.includes(a.id) && all.includes(b.id) && !all.includes(notMine.id))
  const seen = (await t.call('GET', '/v1/me/workspaces', null, null, asAgent(accessKey))).body.workspaces.find((w) => w.id === a.id)
  assert.deepEqual([seen.access, seen.admin, seen.via], ['edit', false, 'global'])
  // A workspace's exclusion takes it off the list again.
  await t.call('PUT', `/v1/workspaces/${a.id}/agents/${agent.id}`, { excluded: true }, 'admin')
  assert.equal((await ids()).includes(a.id), false)
  // The owner's own list is what it always was.
  const owners = (await t.call('GET', '/v1/me/workspaces', null, 'admin')).body.workspaces.find((w) => w.id === a.id)
  assert.deepEqual([owners.access, owners.admin, owners.via], ['edit', true, 'owner'])
})

test('members: an agent\'s sessions round trip; a person cannot have one', async () => {
  const w = await newWs('mem', 'Sessions')
  const { agent } = await makeAgent(t, { ownerUserId: 'mem' })
  const put = (account, body) => t.call('PUT', `/v1/workspaces/${w.id}/members/${account}`, body, 'mem')
  assert.equal((await put(`agent:${agent.id}`, { access: 'edit' })).body.member.sessions, 'invited')
  assert.equal((await put(`agent:${agent.id}`, { access: 'edit', sessions: 'all' })).body.member.sessions, 'all')
  assert.equal((await put(`agent:${agent.id}`, { access: 'view' })).body.member.sessions, 'all', 'kept when omitted')
  assert.equal((await put(`agent:${agent.id}`, { access: 'view', sessions: 'sometimes' })).status, 400)
  assert.equal((await put('person:lim', { access: 'edit', sessions: 'all' })).status, 400)
  assert.equal((await put('person:lim', { access: 'edit' })).status, 200)
})

test('overrides: an admin keeps a placed agent out or changes its sessions; 404 for an agent that does not reach the workspace', async () => {
  const w = await newWs('mem', 'Override')
  const { agent } = await makeAgent(t, { name: 'Glob', ownerUserId: 'mem' })
  const { agent: stranger } = await makeAgent(t, { ownerUserId: 'out' })
  const path = (id) => `/v1/workspaces/${w.id}/agents/${id}`
  assert.equal((await t.call('PUT', path(agent.id), { excluded: true }, 'mem')).status, 404, 'manual: does not reach it')
  await t.call('PUT', `/v1/me/agents/${agent.id}/placement`, { reach: 'all', sessions: 'invited', access: 'edit' }, 'mem')
  assert.equal((await t.call('PUT', path(stranger.id), { excluded: true }, 'mem')).status, 404)
  assert.equal((await t.call('PUT', path(agent.id), { sessions: 'all' }, 'out')).status, 404, 'outsider')
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'edit' }, 'mem')
  assert.equal((await t.call('PUT', path(agent.id), { sessions: 'all' }, 'lim')).status, 403, 'members do not manage')
  assert.equal((await t.call('PUT', path(agent.id), { sessions: 'often' }, 'mem')).status, 400)
  assert.equal((await t.call('PUT', path(agent.id), { excluded: 'yes' }, 'mem')).status, 400)
  const s = await t.call('PUT', path(agent.id), { sessions: 'all' }, 'mem')
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.deepEqual(s.body.override, { workspaceId: w.id, agentId: agent.id, sessions: 'all', excluded: false })
  const x = await t.call('PUT', path(agent.id), { excluded: true }, 'mem')
  assert.deepEqual(x.body.override, { workspaceId: w.id, agentId: agent.id, sessions: 'all', excluded: true }, 'sessions kept when omitted')
  // Still reachable by placement for the admin, so the exclusion can be undone.
  assert.equal((await t.call('PUT', path(agent.id), { excluded: false, sessions: null }, 'mem')).body.override.sessions, null)
  assert.equal((await t.call('DELETE', path(agent.id), null, 'lim')).status, 403)
  assert.equal((await t.call('DELETE', path(agent.id), null, 'mem')).status, 200)
  assert.equal(await t.store.workspaceAgentOverride(w.id, agent.id), null)
})

test('workspace agent invites: an admin makes one, and joining makes the agent a member with that access and sessions', async () => {
  const w = await newWs('mem', 'Invites')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/agent-invites`, { access: 'view', sessions: 'all' }, 'out')).status, 404)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/agent-invites`, { access: 'admin', sessions: 'all' }, 'mem')).status, 400)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/agent-invites`, { access: 'view', sessions: 'never' }, 'mem')).status, 400)
  const made = await t.call('POST', `/v1/workspaces/${w.id}/agent-invites`, { access: 'view', sessions: 'all' }, 'mem')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.match(made.body.link, /\/v1\/join\/qj_/)
  assert.deepEqual([made.body.invite.kind, made.body.invite.status, made.body.invite.workspaceId, made.body.invite.workspaceAccess, made.body.invite.workspaceSessions], ['personal', 'waiting', w.id, 'view', 'all'])
  const token = made.body.link.split('/').pop()
  const joined = await t.call('POST', `/v1/join/${token}`, { name: 'Wendy', provider: 'Anthropic', type: 'coding agent' })
  assert.equal(joined.status, 200, JSON.stringify(joined.body))
  const agent = (await t.store.listPersonalAgents('mem')).find((a) => a.name === 'Wendy')
  const m = await t.store.workspaceMember(w.id, `agent:${agent.id}`)
  assert.deepEqual([m.access, m.sessions, m.addedBy], ['view', 'all', 'mem'])
})

test('a workspace invite join that fails after the member row is made leaves no member behind and the link usable', async () => {
  const w = await newWs('mem', 'Rollback')
  const made = await t.call('POST', `/v1/workspaces/${w.id}/agent-invites`, { access: 'edit', sessions: 'all' }, 'mem')
  const token = made.body.link.split('/').pop()
  const real = t.store.createAgentKeys
  t.store.createAgentKeys = async () => { throw new Error('keys down') }
  try {
    assert.equal((await t.call('POST', `/v1/join/${token}`, { name: 'Rolly', provider: 'Anthropic', type: 'coding agent' })).status, 500)
  } finally { t.store.createAgentKeys = real }
  assert.deepEqual((await t.store.listWorkspaceMembers(w.id)).filter((m) => m.account.startsWith('agent:')), [])
  assert.equal((await t.call('POST', `/v1/join/${token}`, { name: 'Rolly', provider: 'Anthropic', type: 'coding agent' })).status, 200)
  assert.equal((await t.store.listWorkspaceMembers(w.id)).filter((m) => m.account.startsWith('agent:')).length, 1)
})

test('workspace agent invites in an org workspace: the org\'s agent, needing Agents: Create', async () => {
  const o = await makeOrg(t, 'Invite Co')
  const w = await newWs('admin', 'Org invites', o.slug)
  // Mo manages the workspace (Workspaces: Update by role) but cannot create agents.
  const role = await t.store.createRole({ orgId: o.org.id, name: 'Ws admin', grants: { workspaces: { r: true, u: true } } })
  await t.store.setMemberRole(o.mem.id, role.id)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/agent-invites`, { access: 'edit', sessions: 'invited' }, 'mem')).status, 403)
  const made = await t.call('POST', `/v1/workspaces/${w.id}/agent-invites`, { access: 'edit', sessions: 'invited' }, 'admin')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.equal(made.body.invite.kind, 'org')
  const joined = await t.call('POST', `/v1/join/${made.body.link.split('/').pop()}`, { name: 'Orla', provider: 'Anthropic', type: 'coding agent' })
  assert.equal(joined.status, 200, JSON.stringify(joined.body))
  const agent = (await t.store.listOrgAgents(o.org.id)).find((a) => a.name === 'Orla')
  assert.ok(await t.store.memberByAgent(o.org.id, agent.id))
  const m = await t.store.workspaceMember(w.id, `agent:${agent.id}`)
  assert.deepEqual([m.access, m.sessions], ['edit', 'invited'])
  const seen = await t.call('GET', `/v1/workspaces/${w.id}`, null, null, asAgent(joined.body.accessKey))
  assert.deepEqual(seen.body.access, { access: 'edit', admin: false, via: 'member' })
})

test('per-session keep-out: only the session owner adds or removes it', async () => {
  const { agent } = await makeAgent(t, { ownerUserId: 'mem' })
  await ownedRoom('keepout-1', 'person:mem')
  const path = `/v1/sessions/keepout-1/agents/${agent.id}/exclude`
  assert.equal((await t.call('PUT', path, null, 'lim')).status, 403)
  assert.equal((await t.call('PUT', `/v1/sessions/nope-room/agents/${agent.id}/exclude`, null, 'mem')).status, 404)
  assert.equal((await t.call('PUT', `/v1/sessions/keepout-1/agents/${crypto.randomUUID()}/exclude`, null, 'mem')).status, 404)
  const put = await t.call('PUT', path, null, 'mem')
  assert.deepEqual([put.status, put.body], [200, { ok: true }])
  assert.equal(await t.store.sessionAgentExcluded('keepout-1', agent.id), true)
  assert.equal((await t.call('DELETE', path, null, 'lim')).status, 403)
  assert.deepEqual((await t.call('DELETE', path, null, 'mem')).body, { ok: true })
  assert.equal(await t.store.sessionAgentExcluded('keepout-1', agent.id), false)
})

test('kept-out agents: the session owner lists them by name, and letting one in again by a grant or an invite ends it', async () => {
  const { agent } = await makeAgent(t, { name: 'Kit', ownerUserId: 'mem' })
  const { agent: other } = await makeAgent(t, { name: 'Ola', ownerUserId: 'mem' })
  await ownedRoom('keepout-2', 'person:mem')
  for (const a of [agent, other]) await t.call('PUT', `/v1/sessions/keepout-2/agents/${a.id}/exclude`, null, 'mem')
  const list = await t.call('GET', '/v1/sessions/keepout-2/agents/excluded', null, 'mem')
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.deepEqual(list.body.agents.map((a) => [a.agentId, a.name]).sort((x, y) => x[1].localeCompare(y[1])), [[agent.id, 'Kit'], [other.id, 'Ola']])
  assert.equal((await t.call('GET', '/v1/sessions/keepout-2/agents/excluded', null, 'lim')).status, 403)
  assert.equal((await t.call('GET', '/v1/sessions/nope-room/agents/excluded', null, 'mem')).status, 404)
  // The owner gives the agent access again: it is no longer kept out. The other one still is.
  const g = await t.call('PUT', `/v1/sessions/keepout-2/grants/agent:${agent.id}`, { typeId: 'builtin:edit' }, 'mem')
  assert.equal(g.status, 200, JSON.stringify(g.body))
  assert.equal(await t.store.sessionAgentExcluded('keepout-2', agent.id), false)
  assert.deepEqual((await t.call('GET', '/v1/sessions/keepout-2/agents/excluded', null, 'mem')).body.agents.map((a) => a.agentId), [other.id])
  // Inviting it to the session by account (it was in the session before) does the same.
  const at = Date.now() - 60000
  await t.store.ingestPresence([
    { id: `wa${++eventId}`, type: 'start', room: 'keepout-old', account: 'person:mem', name: 'Mo', owner: true, at },
    { id: `wa${++eventId}`, type: 'start', room: 'keepout-old', account: `agent:${other.id}`, name: 'Ola', at }
  ], Date.now())
  const sent = await t.call('POST', '/v1/sessions/keepout-2/invites', { typeId: 'builtin:edit', to: { account: `agent:${other.id}` }, link: 'https://join.heyquilt.com/keepout-2#s' }, 'mem')
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  assert.equal(await t.store.sessionAgentExcluded('keepout-2', other.id), false)
  assert.deepEqual((await t.call('GET', '/v1/sessions/keepout-2/agents/excluded', null, 'mem')).body.agents, [])
})

test('with workspaces off, a grant leaves an exclusion row alone', async () => {
  const off = await startTestApi()
  try {
    const { agent } = await makeAgent(off, { ownerUserId: 'mem' })
    await off.store.ingestPresence([{ id: 'off-1', type: 'start', room: 'keepout-off', account: 'person:mem', owner: true, name: '', at: Date.now() }], Date.now())
    await off.store.addSessionAgentExclusion({ room: 'keepout-off', agentId: agent.id, excludedBy: 'person:mem' })
    assert.equal((await off.call('PUT', `/v1/sessions/keepout-off/grants/agent:${agent.id}`, { typeId: 'builtin:edit' }, 'mem')).status, 200)
    assert.equal(await off.store.sessionAgentExcluded('keepout-off', agent.id), true)
  } finally { off.close() }
})

test('agent webhook: an agent sets an https URL and gets a new secret each time; people cannot; it can be removed', async () => {
  const { agent, accessKey } = await makeAgent(t, { ownerUserId: 'mem' })
  const put = (url) => t.call('PUT', '/v1/agents/me/webhook', { url }, null, asAgent(accessKey))
  assert.equal((await put('http://hooks.example.com/q')).status, 400, 'https only')
  assert.equal((await put('https://192.168.1.4/q')).status, 400, 'no private addresses')
  assert.equal((await put('')).status, 400)
  assert.equal((await t.call('PUT', '/v1/agents/me/webhook', { url: 'https://hooks.example.com/q' }, 'mem')).status, 403, 'a person')
  assert.equal((await t.call('PUT', '/v1/agents/me/webhook', { url: 'https://hooks.example.com/q' })).status, 401)
  const one = await put('https://hooks.example.com/q')
  assert.equal(one.status, 200, JSON.stringify(one.body))
  assert.deepEqual([one.body.url, one.body.events], ['https://hooks.example.com/q', ['session.started']])
  assert.ok(one.body.secret.length >= 32)
  const two = await put('https://hooks.example.com/q2')
  assert.notEqual(two.body.secret, one.body.secret)
  assert.deepEqual(await t.store.agentWebhook(agent.id).then((h) => [h.url, h.secret]), ['https://hooks.example.com/q2', two.body.secret])
  const del = await t.call('DELETE', '/v1/agents/me/webhook', null, null, asAgent(accessKey))
  assert.deepEqual([del.status, del.body], [200, { ok: true }])
  assert.equal(await t.store.agentWebhook(agent.id), null)
})

test('GET /v1/workspaces/:id lists member and placed agents with via, access, sessions and who manages them', async () => {
  const w = await newWs('gm', 'Who is here')
  const { agent: member } = await makeAgent(t, { name: 'Aaron', provider: 'Anthropic', ownerUserId: 'gm' })
  const { agent: global } = await makeAgent(t, { name: 'Gail', provider: 'OpenAI', ownerUserId: 'gm' })
  const { agent: placed } = await makeAgent(t, { name: 'Pete', provider: 'Cursor', ownerUserId: 'gm' })
  const { agent: gone } = await makeAgent(t, { name: 'Xena', ownerUserId: 'gm' })
  const { agent: manual } = await makeAgent(t, { name: 'Manny', ownerUserId: 'gm' })
  await t.call('PUT', `/v1/workspaces/${w.id}/members/agent:${member.id}`, { access: 'view', sessions: 'all' }, 'gm')
  await t.call('PUT', `/v1/me/agents/${global.id}/placement`, { reach: 'all', sessions: 'invited', access: 'edit' }, 'gm')
  await t.call('PUT', `/v1/me/agents/${placed.id}/placement`, { reach: 'workspaces', workspaceIds: [w.id], sessions: 'invited', access: 'view' }, 'gm')
  await t.call('PUT', `/v1/me/agents/${gone.id}/placement`, { reach: 'all', sessions: 'all', access: 'edit' }, 'gm')
  await t.call('PUT', `/v1/workspaces/${w.id}/agents/${placed.id}`, { sessions: 'all' }, 'gm')
  await t.call('PUT', `/v1/workspaces/${w.id}/agents/${gone.id}`, { excluded: true }, 'gm')
  assert.ok(manual)
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'gm')
  assert.equal(got.status, 200, JSON.stringify(got.body))
  assert.deepEqual(got.body.agents, [
    { account: `agent:${member.id}`, agentId: member.id, name: 'Aaron', provider: 'Anthropic', via: 'member', access: 'view', sessions: 'all', managedBy: 'workspace', excluded: false, foreign: false },
    { account: `agent:${global.id}`, agentId: global.id, name: 'Gail', provider: 'OpenAI', via: 'global', access: 'edit', sessions: 'invited', managedBy: 'owner', excluded: false, foreign: false },
    { account: `agent:${placed.id}`, agentId: placed.id, name: 'Pete', provider: 'Cursor', via: 'placed', access: 'view', sessions: 'all', managedBy: 'owner', excluded: false, foreign: false },
    { account: `agent:${gone.id}`, agentId: gone.id, name: 'Xena', provider: 'Anthropic', via: 'global', access: 'edit', sessions: 'all', managedBy: 'owner', excluded: true, foreign: false }
  ])
  // A reader who doesn't manage it never sees the excluded one.
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'view' }, 'gm')
  const reader = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')
  assert.deepEqual(reader.body.agents.map((a) => a.name), ['Aaron', 'Gail', 'Pete'])
})

test('GET /v1/workspaces/:id in an org workspace: placed org agents are managed by the org', async () => {
  const o = await makeOrg(t, 'List Co')
  const w = await newWs('admin', 'Org list', o.slug)
  const { agent } = await makeAgent(t, { name: 'Orgy', orgId: o.org.id })
  await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  await t.call('PUT', `/v1/orgs/${o.slug}/agents/${agent.id}/placement`, { reach: 'all', sessions: 'all', access: 'edit' }, 'admin')
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')
  assert.deepEqual(got.body.agents.map((a) => [a.name, a.via, a.managedBy, a.sessions]), [['Orgy', 'global', 'org', 'all']])
})

// The session-started hand-off. Deliveries go through a recorded fetch; host names resolve
// through a table, so nothing here touches the network.
const RESOLVES = { 'hooks.example.com': ['93.184.216.34'], 'inside.example.com': ['93.184.216.34', '10.0.0.5'], 'six.example.com': ['2606:2800:220:1::1', '::ffff:127.0.0.1'] }
async function handoffApi (opts = {}) {
  const deliveries = []; const lookups = []; const logs = []; const storeCalls = []
  const webhookFetch = async (url, init) => { deliveries.push({ url, init, payload: JSON.parse(init.body) }); return { ok: true, status: 200 } }
  const webhookLookup = async (host, o) => {
    lookups.push([host, o])
    if (!RESOLVES[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
    return RESOLVES[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  // Every argument the API hands its store, to show the link never reaches it.
  const wrapStore = (store) => new Proxy(store, {
    get (target, k) {
      const v = target[k]
      return typeof v === 'function' ? (...args) => { storeCalls.push(JSON.stringify(args)); return v.apply(target, args) } : v
    }
  })
  const h = await startTestApi({ workspaces: true, webhookFetch, webhookLookup, wrapStore, log: (l) => logs.push(String(l)), ...opts })
  /** A room in `ws` linked and owned by `owner` (a person id), as the relay reports it, named `name`. */
  const startedRoom = async (ws, room, owner, name = '') => {
    const linked = await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, { room }, owner)
    assert.equal(linked.status, 200, JSON.stringify(linked.body))
    const at = Date.now()
    await h.store.ingestPresence([{ id: `${room}-s`, type: 'start', room, account: `person:${owner}`, owner: true, name: '', at }, ...(name ? [{ id: `${room}-n`, type: 'name', room, name, at }] : [])], at)
  }
  const place = (agent, owner, body) => h.call('PUT', `/v1/me/agents/${agent.id}/placement`, body, owner)
  return { h, deliveries, lookups, logs, storeCalls, startedRoom, place, close: () => h.close() }
}

test('session.started: each agent that joins and has a webhook is sent the link, signed; the link is never kept', async () => {
  const x = await handoffApi()
  const { h } = x
  try {
    const w = (await h.call('POST', '/v1/workspaces', { name: 'Teaser' }, 'gm')).body.workspace
    const { agent: member } = await makeAgent(h, { name: 'Aaron', ownerUserId: 'gm' })
    const { agent: placed } = await makeAgent(h, { name: 'Pete', ownerUserId: 'gm' })
    const { agent: global } = await makeAgent(h, { name: 'Gail', ownerUserId: 'gm' })
    const { agent: kept } = await makeAgent(h, { name: 'Xena', ownerUserId: 'gm' })
    const { agent: invited } = await makeAgent(h, { name: 'Ivy', ownerUserId: 'gm' })
    await h.call('PUT', `/v1/workspaces/${w.id}/members/agent:${member.id}`, { access: 'edit', sessions: 'all' }, 'gm')
    await x.place(placed, 'gm', { reach: 'workspaces', workspaceIds: [w.id], sessions: 'all', access: 'edit' })
    await x.place(global, 'gm', { reach: 'all', sessions: 'all', access: 'edit' })
    await x.place(kept, 'gm', { reach: 'all', sessions: 'all', access: 'edit' })
    await x.place(invited, 'gm', { reach: 'all', sessions: 'invited', access: 'edit' })
    const hooks = {}
    for (const a of [member, placed, kept, invited]) hooks[a.id] = await h.store.putAgentWebhook({ agentId: a.id, url: `https://hooks.example.com/${a.name.toLowerCase()}`, secret: `secret-of-${a.name}-0123456789` })
    const room = 'teaser-1'
    await x.startedRoom(w, room, 'gm', 'Teaser site')
    assert.equal((await h.call('PUT', `/v1/sessions/${room}/agents/${kept.id}/exclude`, null, 'gm')).status, 200)

    const SECRET = 'link-secret-' + crypto.randomBytes(8).toString('hex')
    const link = `https://join.heyquilt.com/${room}#${SECRET}`
    x.storeCalls.length = 0
    // As pasted, with the CLI's words around it: sent on as the plain link.
    const r = await h.call('POST', `/v1/workspaces/${w.id}/sessions/${room}/started`, { link: ` quilt join ${link} ` }, 'gm')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.notified.slice().sort(), r.body.withoutWebhook], [[member.id, placed.id].sort(), [global.id]])
    await h.api.flushWebhooks()
    assert.equal(x.deliveries.length, 2)
    const byUrl = Object.fromEntries(x.deliveries.map((d) => [d.url, d]))
    for (const [agent, via] of [[member, 'member'], [placed, 'placed']]) {
      const d = byUrl[hooks[agent.id].url]
      assert.ok(d, `${agent.name} was sent it`)
      const hd = d.init.headers
      assert.equal(d.init.method, 'POST')
      assert.equal(hd['x-quilt-event'], 'session.started')
      assert.ok(verifyWebhook(hooks[agent.id].secret, hd['x-quilt-timestamp'], d.init.body, hd['x-quilt-signature']), 'signed with its own secret')
      const { id, ts, ...rest } = d.payload
      assert.match(id, /^[0-9a-f-]{36}$/)
      assert.equal(typeof ts, 'number')
      assert.deepEqual(rest, { event: 'session.started', workspace: { id: w.id, name: 'Teaser' }, room, name: 'Teaser site', link, by: 'Gee', via })
    }
    // Looked up before sending, every address at once.
    assert.deepEqual(x.lookups.map(([host, o]) => [host, o.all]), [['hooks.example.com', true], ['hooks.example.com', true]])
    // Nothing about the link reached the store, the request log or the API's own log.
    assert.ok(x.storeCalls.length > 0)
    assert.ok(!x.storeCalls.some((c) => c.includes(SECRET)), 'not handed to the store')
    assert.ok(!JSON.stringify(h.store.listEvents()).includes(SECRET), 'not in request events')
    assert.ok(!x.logs.some((l) => l.includes(SECRET)), 'not logged')
  } finally { x.close() }
})

test('session.started: only the owner who linked it, for this workspace, with a link to that room on this relay', async () => {
  const x = await handoffApi()
  const { h } = x
  try {
    const w = (await h.call('POST', '/v1/workspaces', { name: 'Gate' }, 'gm')).body.workspace
    const other = (await h.call('POST', '/v1/workspaces', { name: 'Other' }, 'gm')).body.workspace
    await h.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'edit' }, 'gm')
    const { agent } = await makeAgent(h, { name: 'Pete', ownerUserId: 'gm' })
    await x.place(agent, 'gm', { reach: 'all', sessions: 'all', access: 'edit' })
    await h.store.putAgentWebhook({ agentId: agent.id, url: 'https://hooks.example.com/p', secret: 'pete-secret-0123456789' })
    await x.startedRoom(w, 'gate-1', 'gm')
    const post = (room, link, who = 'gm', ws = w) => h.call('POST', `/v1/workspaces/${ws.id}/sessions/${room}/started`, link === undefined ? {} : { link }, who)
    const good = 'https://join.heyquilt.com/gate-1#abc'
    assert.equal((await post('gate-1', good, 'lim')).status, 403, 'a member who does not own it')
    assert.equal((await post('gate-1', good, 'out')).status, 404, 'an outsider cannot find the workspace')
    assert.equal((await post('gate-1', good, 'gm', other)).status, 404, 'another workspace')
    assert.equal((await post('gate-1', 'https://join.heyquilt.com/gate-2#abc')).status, 400, 'a link for another room')
    assert.equal((await post('gate-1', 'https://join.heyquilt.com/gate-1')).status, 400, 'no secret')
    assert.equal((await post('gate-1', 'https://evil.example.com/join/gate-1#abc')).status, 400, 'a relay that is not this one')
    assert.equal((await post('gate-1', 'not a link')).status, 400)
    assert.equal((await post('gate-1')).status, 400, 'no link')
    assert.equal((await post('../x', good)).status, 404)
    // Linked by gm, but the relay says someone else owns it.
    await h.store.ingestPresence([{ id: 'gate-3-s', type: 'start', room: 'gate-3', account: 'person:out', owner: true, name: '', at: Date.now() }], Date.now())
    await h.store.setSessionWorkspace('gate-3', w.id, { linkedBy: 'person:gm', at: Date.now() })
    assert.equal((await post('gate-3', 'https://join.heyquilt.com/gate-3#abc')).status, 403, 'not the owner the relay reported')
    // Linked, but the relay has not said who owns it yet: try again shortly.
    assert.equal((await h.call('POST', `/v1/workspaces/${w.id}/sessions`, { room: 'gate-4' }, 'gm')).status, 200)
    const early = await post('gate-4', 'https://join.heyquilt.com/gate-4#abc')
    assert.equal(early.status, 409, JSON.stringify(early.body))
    await h.api.flushWebhooks()
    assert.equal(x.deliveries.length, 0)
    assert.equal((await post('gate-1', good)).status, 200)
    await h.api.flushWebhooks()
    assert.equal(x.deliveries.length, 1)
  } finally { x.close() }
})

test('session.started: a webhook whose host is or resolves to a private address is skipped and logged', async () => {
  const x = await handoffApi()
  const { h } = x
  try {
    const w = (await h.call('POST', '/v1/workspaces', { name: 'Hosts' }, 'gm')).body.workspace
    const urls = ['https://inside.example.com/a', 'https://six.example.com/b', 'https://localhost./c', 'https://nowhere.example.com/d', 'https://127.0.0.1./e', 'https://hooks.example.com/ok']
    for (const [i, url] of urls.entries()) {
      const { agent } = await makeAgent(h, { name: `Hook${i}`, ownerUserId: 'gm' })
      await x.place(agent, 'gm', { reach: 'all', sessions: 'all', access: 'edit' })
      await h.store.putAgentWebhook({ agentId: agent.id, url, secret: `secret-${i}-0123456789abcdef` })
    }
    await x.startedRoom(w, 'hosts-1', 'gm')
    const r = await h.call('POST', `/v1/workspaces/${w.id}/sessions/hosts-1/started`, { link: 'https://join.heyquilt.com/hosts-1#abc' }, 'gm')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.notified.length, urls.length)
    await h.api.flushWebhooks()
    assert.deepEqual(x.deliveries.map((d) => d.url), ['https://hooks.example.com/ok'])
    // A trailing dot is the same host: local without asking DNS.
    assert.deepEqual(x.lookups.map(([host]) => host).sort(), ['hooks.example.com', 'inside.example.com', 'nowhere.example.com', 'six.example.com'])
    for (const host of ['inside.example.com', 'six.example.com', 'localhost.', 'nowhere.example.com', '127.0.0.1.']) {
      assert.ok(x.logs.some((l) => /session\.started/.test(l) && l.includes(host)), `${host} logged: ${x.logs.join(' | ')}`)
    }
  } finally { x.close() }
})

test('session.started: allowLocalWebhooks (tests only) delivers to this computer without a lookup', async () => {
  const x = await handoffApi({ allowLocalWebhooks: true })
  const { h } = x
  try {
    const w = (await h.call('POST', '/v1/workspaces', { name: 'Local' }, 'gm')).body.workspace
    const { agent, accessKey } = await makeAgent(h, { name: 'Lo', ownerUserId: 'gm' })
    await x.place(agent, 'gm', { reach: 'all', sessions: 'all', access: 'edit' })
    const put = await h.call('PUT', '/v1/agents/me/webhook', { url: 'http://127.0.0.1:9/hook' }, null, asAgent(accessKey))
    assert.equal(put.status, 200, JSON.stringify(put.body))
    await x.startedRoom(w, 'local-1', 'gm')
    assert.equal((await h.call('POST', `/v1/workspaces/${w.id}/sessions/local-1/started`, { link: 'https://join.heyquilt.com/local-1#abc' }, 'gm')).status, 200)
    await h.api.flushWebhooks()
    assert.deepEqual([x.deliveries.map((d) => d.url), x.lookups], [['http://127.0.0.1:9/hook'], []])
  } finally { x.close() }
})

// Hosted agents reach the library through the relay, which holds the agent's pass (not its
// key): the workspace routes, and only they, take `Authorization: QuiltPass <pass>`.
test('an agent pass reaches the workspace routes and nothing else; person, expired, forged and revoked passes are refused', async () => {
  const keys = newPassKeys()
  const p = await startTestApi({ workspaces: true, passKey: keys.privateKey })
  try {
    const w = (await p.call('POST', '/v1/workspaces', { name: 'Pass place' }, 'mem')).body.workspace
    const { agent, accessKey } = await makeAgent(p, { name: 'Hosty', ownerUserId: 'mem' })
    await p.store.putAgentPlacement({ agentId: agent.id, reach: 'all', access: 'edit', sessions: 'invited', updatedBy: 'person:mem' })
    const minted = await p.call('POST', '/v1/passes', {}, null, asAgent(accessKey))
    assert.equal(minted.status, 200, JSON.stringify(minted.body))
    const asPass = (pass) => ({ authorization: `QuiltPass ${pass}` })
    const mine = await p.call('GET', '/v1/me/workspaces', null, null, asPass(minted.body.pass))
    assert.equal(mine.status, 200, JSON.stringify(mine.body))
    assert.deepEqual(mine.body.workspaces.map((x) => x.id), [w.id])
    // A room pass (what the API's /mcp hands the relay while the agent is in a session) works too.
    const roomPass = await p.call('POST', '/v1/passes', { room: 'pass-room' }, null, asAgent(accessKey))
    assert.equal((await p.call('GET', '/v1/me/workspaces', null, null, asPass(roomPass.body.pass))).status, 200)
    // The library and the agent's webhook take it as well.
    assert.equal((await p.call('GET', `/v1/workspaces/${w.id}/files`, null, null, asPass(minted.body.pass))).status, 200)
    assert.equal((await p.call('DELETE', '/v1/agents/me/webhook', null, null, asPass(minted.body.pass))).status, 200)

    // Not on any other route: the agent's own page, its keys, passes, the hosted MCP.
    for (const [method, path] of [['GET', '/v1/agents/me'], ['POST', '/v1/passes'], ['GET', '/v1/me'], ['GET', `/v1/me/agents/${agent.id}/placement`]]) {
      const r = await p.call(method, path, method === 'POST' ? {} : null, null, asPass(minted.body.pass))
      assert.equal(r.status, 401, `${method} ${path}: ${JSON.stringify(r.body)}`)
    }

    const sign = (over, key = keys.privateKey) => signPass({ v: 1, sub: agent.id, kind: 'agent', name: 'Hosty', key: '', exp: Date.now() + PASS_TTL_MS, ...over }, key)
    const refused = async (pass, why) => {
      const r = await p.call('GET', '/v1/me/workspaces', null, null, asPass(pass))
      assert.equal(r.status, 401, `${why}: ${JSON.stringify(r.body)}`)
    }
    await refused(sign({ kind: 'person', sub: 'mem' }), "a person's pass")
    await refused(sign({ exp: Date.now() - 1000 }), 'an expired pass')
    await refused(sign({}, newPassKeys().privateKey), 'a pass signed by someone else')
    await refused(sign({ sub: 'not-a-uuid' }), 'a pass for no agent id')
    await refused(sign({ sub: crypto.randomUUID() }), 'a pass for an agent that does not exist')
    await refused('garbage', 'not a pass')
    await p.store.revokeAgent(agent.id)
    await refused(minted.body.pass, 'a revoked agent')
  } finally { p.close() }

  // An API without a pass key takes no passes at all; with the flag off, the routes stay a plain 404.
  const noKey = await startTestApi({ workspaces: true })
  try {
    const pass = signPass({ v: 1, sub: crypto.randomUUID(), kind: 'agent', name: 'X', key: '', exp: Date.now() + PASS_TTL_MS }, newPassKeys().privateKey)
    assert.equal((await noKey.call('GET', '/v1/me/workspaces', null, null, { authorization: `QuiltPass ${pass}` })).status, 401)
  } finally { noKey.close() }
  const off = await startTestApi({ passKey: keys.privateKey })
  try {
    const { accessKey } = await makeAgent(off, { name: 'Offy', ownerUserId: 'mem' })
    const pass = (await off.call('POST', '/v1/passes', {}, null, asAgent(accessKey))).body.pass
    const r = await off.call('GET', '/v1/me/workspaces', null, null, { authorization: `QuiltPass ${pass}` })
    assert.deepEqual([r.status, r.body], [404, { error: 'not found' }])
  } finally { off.close() }
})

test('letAgentBackIn logs a failed clean-up instead of failing the grant', async () => {
  const { letAgentBackIn } = await import('../src/api/routes/grants.js')
  const logs = []
  const store = { removeSessionAgentExclusion: async () => { throw new Error('table missing') } }
  await letAgentBackIn(store, 'room-x', 'agent:5983184b-937a-469c-9728-c2ec96030f93', true, (m) => logs.push(m))
  assert.equal(logs.length, 1)
  assert.match(logs[0], /table missing/)
})

test('someone else\'s agent added to a workspace: it may be added, but only its owner makes it join every session', async () => {
  // Otto adds Mo's agent to his own workspace (allowed, as in phase 1, for access).
  const w = await newWs('out', 'Otto summons')
  const { agent } = await makeAgent(t, { name: 'Mos bot', ownerUserId: 'mem' })
  const put = (body) => t.call('PUT', `/v1/workspaces/${w.id}/members/agent:${agent.id}`, body, 'out')
  const all = await put({ access: 'edit', sessions: 'all' })
  assert.deepEqual([all.status, all.body], [400, { error: 'Only its owner can make an agent join every session.' }])
  assert.equal(await t.store.workspaceMember(w.id, `agent:${agent.id}`), null, 'nothing was written')
  assert.equal((await put({ access: 'edit' })).status, 200, 'added for access, as before')
  assert.equal((await put({ access: 'view', sessions: 'invited' })).status, 200)
  assert.equal((await put({ access: 'view', sessions: 'all' })).status, 400, 'nor later')
  // Its card says it never joins by itself here, and why.
  const listed = (await t.call('GET', `/v1/workspaces/${w.id}`, null, 'out')).body.agents.find((a) => a.agentId === agent.id)
  assert.deepEqual([listed.via, listed.sessions, listed.foreign], ['member', 'invited', true])
  // The agent's owner may in her own workspace.
  const mine = await newWs('mem', 'Mo summons')
  assert.equal((await t.call('PUT', `/v1/workspaces/${mine.id}/members/agent:${agent.id}`, { access: 'edit', sessions: 'all' }, 'mem')).status, 200)
  assert.equal((await t.call('GET', `/v1/workspaces/${mine.id}`, null, 'mem')).body.agents.find((a) => a.agentId === agent.id).foreign, false)
  // In an org workspace only the org's own agents can be members (a person's agent is never in
  // the org), and they may join every session.
  const o = await makeOrg(t, 'Summon Co')
  const ow = await newWs('admin', 'Org summons', o.slug)
  const { agent: orgBot } = await makeAgent(t, { name: 'Org bot', orgId: o.org.id })
  await t.store.addAgentMember({ orgId: o.org.id, agentId: orgBot.id })
  assert.equal((await t.call('PUT', `/v1/workspaces/${ow.id}/members/agent:${orgBot.id}`, { access: 'edit', sessions: 'all' }, 'admin')).status, 200)
  assert.equal((await t.call('PUT', `/v1/workspaces/${ow.id}/members/agent:${agent.id}`, { access: 'edit', sessions: 'all' }, 'admin')).status, 404, "a person's agent is not in the org")
})

test('session.started: a member row for someone else\'s agent with sessions all (written before this rule) sends it nothing', async () => {
  const x = await handoffApi()
  const { h } = x
  try {
    const w = (await h.call('POST', '/v1/workspaces', { name: 'Old row' }, 'out')).body.workspace
    const { agent: foreign } = await makeAgent(h, { name: 'Mos bot', ownerUserId: 'mem' })
    const { agent: own } = await makeAgent(h, { name: 'Ottos bot', ownerUserId: 'out' })
    await h.store.putWorkspaceMember({ workspaceId: w.id, account: `agent:${foreign.id}`, access: 'edit', addedBy: 'person:out', sessions: 'all' })
    await h.store.putWorkspaceMember({ workspaceId: w.id, account: `agent:${own.id}`, access: 'edit', addedBy: 'person:out', sessions: 'all' })
    for (const a of [foreign, own]) await h.store.putAgentWebhook({ agentId: a.id, url: `https://hooks.example.com/${a.id}`, secret: `secret-${a.id}` })
    await x.startedRoom(w, 'old-row-1', 'out')
    const r = await h.call('POST', `/v1/workspaces/${w.id}/sessions/old-row-1/started`, { link: 'https://join.heyquilt.com/old-row-1#abc' }, 'out')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.notified, r.body.withoutWebhook], [[own.id], []])
    await h.api.flushWebhooks()
    assert.deepEqual(x.deliveries.map((d) => d.url), [`https://hooks.example.com/${own.id}`])
  } finally { x.close() }
})

test('org placement needs Workspaces: Update as well as Agents: Update', async () => {
  const o = await makeOrg(t, 'Rights Co')
  const { agent } = await makeAgent(t, { name: 'Placid', orgId: o.org.id })
  await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const path = `/v1/orgs/${o.slug}/agents/${agent.id}/placement`
  const body = { reach: 'all', sessions: 'all', access: 'edit' }
  const tender = await t.store.createRole({ orgId: o.org.id, name: 'Agent tender', grants: { agents: { r: true, u: true }, workspaces: { r: true } } })
  await t.store.setMemberRole(o.mem.id, tender.id)
  const refused = await t.call('PUT', path, body, 'mem')
  assert.equal(refused.status, 403, JSON.stringify(refused.body))
  assert.equal((await t.store.agentPlacement(agent.id)), null, 'nothing was placed')
  const both = await t.store.createRole({ orgId: o.org.id, name: 'Placer', grants: { agents: { r: true, u: true }, workspaces: { r: true, u: true } } })
  await t.store.setMemberRole(o.mem.id, both.id)
  assert.equal((await t.call('PUT', path, body, 'mem')).status, 200)
})

test('session.started: the agent that started the session is not sent its own session', async () => {
  const x = await handoffApi()
  const { h } = x
  try {
    const w = (await h.call('POST', '/v1/workspaces', { name: 'Self' }, 'gm')).body.workspace
    const { agent: starter, accessKey } = await makeAgent(h, { name: 'Starter', ownerUserId: 'gm' })
    const { agent: other } = await makeAgent(h, { name: 'Other', ownerUserId: 'gm' })
    for (const a of [starter, other]) {
      await x.place(a, 'gm', { reach: 'all', sessions: 'all', access: 'edit' })
      await h.store.putAgentWebhook({ agentId: a.id, url: `https://hooks.example.com/${a.id}`, secret: `secret-${a.id}` })
    }
    const room = 'self-1'
    assert.equal((await h.call('POST', `/v1/workspaces/${w.id}/sessions`, { room }, null, asAgent(accessKey))).status, 200)
    await h.store.ingestPresence([{ id: `${room}-s`, type: 'start', room, account: `agent:${starter.id}`, owner: true, name: '', at: Date.now() }], Date.now())
    const r = await h.call('POST', `/v1/workspaces/${w.id}/sessions/${room}/started`, { link: `https://join.heyquilt.com/${room}#abc` }, null, asAgent(accessKey))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.notified, r.body.withoutWebhook], [[other.id], []])
    await h.api.flushWebhooks()
    assert.deepEqual(x.deliveries.map((d) => d.url), [`https://hooks.example.com/${other.id}`])
  } finally { x.close() }
})
