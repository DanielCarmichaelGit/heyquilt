// test/api-workspace-agents.test.js
// Agents in workspaces, over HTTP: placements (personal and org), a workspace's override,
// member `sessions`, workspace agent invites, per-session keep-outs, the agent's own webhook,
// and the agents a workspace page lists. All behind the workspaces flag.
import { test, before, after } from 'node:test'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from './api-helpers.js'

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
      ['DELETE', `/v1/sessions/r1/agents/${id}/exclude`, null, 'mem']
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
    { account: `agent:${member.id}`, agentId: member.id, name: 'Aaron', provider: 'Anthropic', via: 'member', access: 'view', sessions: 'all', managedBy: 'workspace', excluded: false },
    { account: `agent:${global.id}`, agentId: global.id, name: 'Gail', provider: 'OpenAI', via: 'global', access: 'edit', sessions: 'invited', managedBy: 'owner', excluded: false },
    { account: `agent:${placed.id}`, agentId: placed.id, name: 'Pete', provider: 'Cursor', via: 'placed', access: 'view', sessions: 'all', managedBy: 'owner', excluded: false },
    { account: `agent:${gone.id}`, agentId: gone.id, name: 'Xena', provider: 'Anthropic', via: 'global', access: 'edit', sessions: 'all', managedBy: 'owner', excluded: true }
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
