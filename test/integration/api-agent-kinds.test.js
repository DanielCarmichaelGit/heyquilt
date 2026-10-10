// test/api-agent-kinds.test.js
// The three kinds of agent invite (global, workspace, session) on the accounts API: a global
// invite places the agent in all its owner's workspaces when it joins; with workspaces off the
// personal invite is exactly as before. A session's owner lists the agents its workspace
// invites (and the ones kept out), and can hand the session's link to one of them again.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startTestApi, makeAgent } from '../helpers/api-helpers.js'

let t
const deliveries = []
before(async () => {
  t = await startTestApi({ workspaces: true, allowLocalWebhooks: true, webhookFetch: async (url, init) => { deliveries.push({ url, payload: JSON.parse(init.body) }); return { ok: true, status: 200 } } })
})
after(() => t.close())

const join = (link, name) => t.call('POST', `/v1/join/${link.split('/').pop()}`, { name, provider: 'Anthropic', type: 'coding agent' })
const newWs = async (who, name) => (await t.call('POST', '/v1/workspaces', { name }, who)).body.workspace
/** A room in `ws`, linked and owned by `owner` (a person id) as the relay reports it. */
async function startedRoom (h, ws, room, owner) {
  const linked = await h.call('POST', `/v1/workspaces/${ws.id}/sessions`, { room }, owner)
  assert.equal(linked.status, 200, JSON.stringify(linked.body))
  const at = Date.now()
  await h.store.ingestPresence([{ id: `${room}-s`, type: 'start', room, account: `person:${owner}`, owner: true, name: '', at }], at)
}

test('the migration adds agent_invites.global, additively', () => {
  const s = fs.readFileSync(new URL('../../supabase/migrations/20261008000001_agent_invite_global.sql', import.meta.url), 'utf8')
  assert.match(s, /alter table public\.agent_invites add column global boolean not null default false;/)
  assert.doesNotMatch(s, /\bdrop\b/i)
})

test('a global agent invite: the agent joins placed in all its owner\'s workspaces, invited to every session', async () => {
  const w = await newWs('lim', 'Lin\'s')
  const made = await t.call('POST', '/v1/agent-invites', { global: true }, 'lim')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.equal(made.body.invite.global, true)
  assert.equal((await t.store.agentInviteById(made.body.invite.id)).global, true)
  const joined = await join(made.body.link, 'Gus')
  assert.equal(joined.status, 200, JSON.stringify(joined.body))
  const agent = (await t.store.listPersonalAgents('lim')).find((a) => a.name === 'Gus')
  const p = await t.store.agentPlacement(agent.id)
  assert.deepEqual([p.reach, p.workspaceIds, p.sessions, p.access, p.scopes, p.updatedBy], ['all', [], 'all', 'edit', [], 'person:lim'])
  // So the workspace's page lists it as Global.
  const listed = (await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')).body.agents.find((a) => a.agentId === agent.id)
  assert.deepEqual([listed.via, listed.sessions], ['global', 'all'])
  // A plain invite (a session agent) places nothing and says nothing about global.
  const plain = await t.call('POST', '/v1/agent-invites', {}, 'lim')
  assert.equal('global' in plain.body.invite, false)
  await join(plain.body.link, 'Sid')
  const sid = (await t.store.listPersonalAgents('lim')).find((a) => a.name === 'Sid')
  assert.equal(await t.store.agentPlacement(sid.id), null)
  // Only true counts.
  const odd = await t.call('POST', '/v1/agent-invites', { global: 'yes' }, 'lim')
  assert.equal((await t.store.agentInviteById(odd.body.invite.id)).global, false)
})

test('a global invite join that fails after the placement is made leaves no placement and the link usable', async () => {
  const made = await t.call('POST', '/v1/agent-invites', { global: true }, 'lim')
  const real = t.store.createAgentKeys
  t.store.createAgentKeys = async () => { throw new Error('keys down') }
  try { assert.equal((await join(made.body.link, 'Rolly')).status, 500) } finally { t.store.createAgentKeys = real }
  assert.equal((await t.store.listPersonalAgents('lim')).some((a) => a.name === 'Rolly'), false)
  assert.equal((await join(made.body.link, 'Rolly')).status, 200)
  const agent = (await t.store.listPersonalAgents('lim')).find((a) => a.name === 'Rolly')
  assert.equal((await t.store.agentPlacement(agent.id)).reach, 'all')
})

test('with workspaces off, global is ignored: the invite and the join are exactly as before', async () => {
  const off = await startTestApi()
  try {
    const made = await off.call('POST', '/v1/agent-invites', { global: true }, 'mem')
    assert.equal(made.status, 200)
    assert.deepEqual(Object.keys(made.body.invite).sort(), ['createdAt', 'expiresAt', 'id', 'kind', 'rejoined', 'role', 'status', 'teams', 'usedAt', 'usedBy'])
    assert.equal((await off.store.agentInviteById(made.body.invite.id)).global, false)
    const joined = await off.call('POST', `/v1/join/${made.body.link.split('/').pop()}`, { name: 'Off', provider: 'Anthropic', type: 'coding agent' })
    assert.equal(joined.status, 200, JSON.stringify(joined.body))
    const agent = (await off.store.listPersonalAgents('mem')).find((a) => a.name === 'Off')
    assert.equal(await off.store.agentPlacement(agent.id), null)
    // The session agents list is a workspaces route: 404 with the flag off.
    const r = await off.call('GET', '/v1/sessions/r1/agents', null, 'mem')
    assert.deepEqual([r.status, r.body], [404, { error: 'not found' }])
  } finally { off.close() }
})

test('GET /v1/sessions/:room/agents: the agents the workspace invites, why, and the kept out, for the session owner only', async () => {
  const w = await newWs('gm', 'Invites')
  const mk = async (name) => (await makeAgent(t, { name, ownerUserId: 'gm' })).agent
  const member = await mk('Mia')
  const global = await mk('Gale')
  const placed = await mk('Pip')
  const notAuto = await mk('Nell')
  const kept = await mk('Kurt')
  await t.call('PUT', `/v1/workspaces/${w.id}/members/agent:${member.id}`, { access: 'edit', sessions: 'all' }, 'gm')
  await t.call('PUT', `/v1/me/agents/${global.id}/placement`, { reach: 'all', sessions: 'all', access: 'edit' }, 'gm')
  await t.call('PUT', `/v1/me/agents/${placed.id}/placement`, { reach: 'workspaces', workspaceIds: [w.id], sessions: 'all', access: 'view' }, 'gm')
  await t.call('PUT', `/v1/me/agents/${notAuto.id}/placement`, { reach: 'all', sessions: 'invited', access: 'edit' }, 'gm')
  await t.call('PUT', `/v1/me/agents/${kept.id}/placement`, { reach: 'all', sessions: 'all', access: 'edit' }, 'gm')
  await startedRoom(t, w, 'kinds-1', 'gm')
  assert.equal((await t.call('PUT', `/v1/sessions/kinds-1/agents/${kept.id}/exclude`, null, 'gm')).status, 200)
  const r = await t.call('GET', '/v1/sessions/kinds-1/agents', null, 'gm')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.agents, [
    { agentId: global.id, name: 'Gale', via: 'global', managedBy: 'owner', excluded: false },
    { agentId: kept.id, name: 'Kurt', via: 'global', managedBy: 'owner', excluded: true },
    { agentId: member.id, name: 'Mia', via: 'member', managedBy: 'workspace', excluded: false },
    { agentId: placed.id, name: 'Pip', via: 'placed', managedBy: 'owner', excluded: false }
  ])
  // Someone else, and a session nobody reported: no.
  assert.equal((await t.call('GET', '/v1/sessions/kinds-1/agents', null, 'lim')).status, 403)
  assert.equal((await t.call('GET', '/v1/sessions/nope-room/agents', null, 'gm')).status, 404)
  // A session outside any workspace invites nobody, kept out or not.
  await t.store.ingestPresence([{ id: 'loose-s', type: 'start', room: 'kinds-loose', account: 'person:gm', owner: true, name: '', at: Date.now() }], Date.now())
  await t.call('PUT', `/v1/sessions/kinds-loose/agents/${member.id}/exclude`, null, 'gm')
  assert.deepEqual((await t.call('GET', '/v1/sessions/kinds-loose/agents', null, 'gm')).body, { agents: [] })
})

test('session.started with agents: the link goes to just those agents (inviting one again after Don\'t invite)', async () => {
  const w = await newWs('gm', 'Again')
  const a = (await makeAgent(t, { name: 'Ana', ownerUserId: 'gm' })).agent
  const b = (await makeAgent(t, { name: 'Bo', ownerUserId: 'gm' })).agent
  for (const x of [a, b]) {
    await t.call('PUT', `/v1/me/agents/${x.id}/placement`, { reach: 'all', sessions: 'all', access: 'edit' }, 'gm')
    await t.store.putAgentWebhook({ agentId: x.id, url: `http://127.0.0.1:9/${x.name}`, secret: 'secret-0123456789abcdef' })
  }
  await startedRoom(t, w, 'kinds-2', 'gm')
  const link = 'https://join.heyquilt.com/kinds-2#s3cret'
  deliveries.length = 0
  const r = await t.call('POST', `/v1/workspaces/${w.id}/sessions/kinds-2/started`, { link, agents: [a.id] }, 'gm')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual([r.body.notified, r.body.withoutWebhook], [[a.id], []])
  await t.api.flushWebhooks()
  assert.deepEqual(deliveries.map((d) => d.url), [`http://127.0.0.1:9/${a.name}`])
  assert.equal(deliveries[0].payload.link, link)
  // An agent it doesn't invite (kept out) is not sent it, even when named.
  await t.call('PUT', `/v1/sessions/kinds-2/agents/${b.id}/exclude`, null, 'gm')
  assert.deepEqual((await t.call('POST', `/v1/workspaces/${w.id}/sessions/kinds-2/started`, { link, agents: [b.id] }, 'gm')).body, { notified: [], withoutWebhook: [] })
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/sessions/kinds-2/started`, { link, agents: 'all' }, 'gm')).status, 400)
})
