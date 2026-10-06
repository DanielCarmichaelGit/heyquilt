// The app's local routes for agents in workspaces, end to end against the accounts API (with
// workspaces on) and a relay: placements from Settings › Agents, an org's agents, an added
// agent's Joins, a workspace's say over a placed agent, invite links for new agents, and an
// agent removed from a session in a workspace kept out of that session.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-ws-agents-'))
process.env.HOME = process.env.USERPROFILE = home

const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { startTestApi, linkDevice, makeOrg, makeAgent, API_URL } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')
const { loadIdentity } = await import('../src/identity.js')
const { saveAccount } = await import('../src/account.js')
const { agentJoin } = await import('../src/agent-join.js')

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let ui, accounts, relay, memToken
before(async () => {
  const keys = newPassKeys()
  const relayPort = await freePort()
  const relaySecret = crypto.randomBytes(16).toString('hex')
  accounts = await startTestApi({ passKey: keys.privateKey, workspaces: true, relaySecret, relayUrl: `ws://127.0.0.1:${relayPort}`, webhookFetch: async () => ({ ok: true, status: 200 }), allowLocalWebhooks: true })
  relay = await startServer({ port: relayPort, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey, apiUrl: accounts.api.url, relayApiSecret: relaySecret })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  memToken = (await linkDevice(accounts, 'mem', loadIdentity())).token
  signInAs('mem', memToken)
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

// This computer's sign-in: the app reads it on every call, so a test can be someone else for a while.
function signInAs (id, token) { saveAccount({ token, account: { id, name: id, email: `${id}@acme.com` }, signedInAt: Date.now() }) }

const api = (method, p, body) => fetch(`http://127.0.0.1:${ui.port}${p}`, {
  method, headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
const newWorkspace = async (name) => (await api('POST', '/api/workspaces', { name })).body.workspace.id
const agentsOf = async (id) => (await api('GET', `/api/workspaces/${id}`)).body.agents
// Someone the relay has let into `room` (as it records an agent or person let in by a pass), so
// the owner has someone to remove.
async function memberOfRoom (room, key, name) {
  const until = Date.now() + 10_000
  while (!relay.rooms.get(room) && Date.now() < until) await sleep(50)
  relay.rooms.get(room).meta.members[key] = { name, kind: key.split(':')[0], files: 'edit', since: Date.now(), granted: true }
}

test('Settings › Agents: an agent\'s placement reads as manual, saves, and comes back', async () => {
  const id = await newWorkspace('Placed')
  const { agent } = await makeAgent(accounts, { name: 'Pia', ownerUserId: 'mem' })
  const first = await api('GET', `/api/agents/${agent.id}/placement`)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.deepEqual([first.body.placement.reach, first.body.placement.sessions, first.body.placement.workspaceIds], ['manual', 'invited', []])
  const saved = await api('POST', `/api/agents/${agent.id}/placement`, { reach: 'workspaces', workspaceIds: [id], sessions: 'all', access: 'edit', scopes: [] })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.deepEqual([saved.body.placement.reach, saved.body.placement.workspaceIds, saved.body.placement.sessions], ['workspaces', [id], 'all'])
  assert.equal((await accounts.store.agentPlacement(agent.id)).reach, 'workspaces')
  assert.deepEqual((await api('GET', `/api/agents/${agent.id}/placement`)).body.placement.workspaceIds, [id])
  // It now shows on the workspace's page, placed there and joining every session.
  const listed = (await agentsOf(id)).find((a) => a.agentId === agent.id)
  assert.deepEqual([listed.via, listed.sessions, listed.managedBy], ['placed', 'all', 'owner'])
  // The API's own checks come through: someone else's workspace, or a bad agent id.
  const other = await accounts.call('POST', '/v1/workspaces', { name: 'Not mine' }, 'lim')
  assert.equal((await api('POST', `/api/agents/${agent.id}/placement`, { reach: 'workspaces', workspaceIds: [other.body.workspace.id], sessions: 'all', access: 'edit' })).status, 400)
  const bad = await api('GET', '/api/agents/nope/placement')
  assert.deepEqual([bad.status, bad.body.error], [400, 'Which agent?'])
})

test('adding an agent to a workspace: Also join every session sets its sessions, and access changes keep it', async () => {
  const id = await newWorkspace('Added')
  const { agent } = await makeAgent(accounts, { name: 'Ada', ownerUserId: 'mem' })
  const added = await api('POST', `/api/workspaces/${id}/members`, { account: `agent:${agent.id}`, access: 'edit', sessions: 'all' })
  assert.equal(added.status, 200, JSON.stringify(added.body))
  assert.equal(added.body.member.sessions, 'all')
  let a = (await agentsOf(id)).find((x) => x.agentId === agent.id)
  assert.deepEqual([a.via, a.sessions, a.access, a.managedBy], ['member', 'all', 'edit', 'workspace'])
  // The card's access select sends no sessions: the agent keeps joining every session.
  await api('POST', `/api/workspaces/${id}/members`, { account: `agent:${agent.id}`, access: 'view' })
  a = (await agentsOf(id)).find((x) => x.agentId === agent.id)
  assert.deepEqual([a.access, a.sessions], ['view', 'all'])
  // Joins on the card: when invited.
  await api('POST', `/api/workspaces/${id}/members`, { account: `agent:${agent.id}`, access: 'view', sessions: 'invited' })
  assert.equal((await agentsOf(id)).find((x) => x.agentId === agent.id).sessions, 'invited')
  // A person never has sessions; leaving it out adds them as before.
  assert.equal((await api('POST', `/api/workspaces/${id}/members`, { account: 'person:lim', access: 'edit', sessions: 'all' })).status, 400)
  assert.equal((await api('POST', `/api/workspaces/${id}/members`, { account: 'person:lim', access: 'edit' })).status, 200)
})

test('a placed agent\'s card: Joins writes the workspace\'s override, Not in this workspace keeps it out, Let back in clears it', async () => {
  const id = await newWorkspace('Override')
  const { agent } = await makeAgent(accounts, { name: 'Gil', ownerUserId: 'mem' })
  await api('POST', `/api/agents/${agent.id}/placement`, { reach: 'all', sessions: 'all', access: 'edit', scopes: [] })
  let a = (await agentsOf(id)).find((x) => x.agentId === agent.id)
  assert.deepEqual([a.via, a.sessions], ['global', 'all'])
  const set = await api('POST', `/api/workspaces/${id}/agents/${agent.id}`, { sessions: 'invited' })
  assert.equal(set.status, 200, JSON.stringify(set.body))
  assert.deepEqual([set.body.override.sessions, set.body.override.excluded], ['invited', false])
  assert.equal((await agentsOf(id)).find((x) => x.agentId === agent.id).sessions, 'invited')
  // Kept out: the override keeps its sessions, and the admin still sees the agent, marked.
  assert.equal((await api('POST', `/api/workspaces/${id}/agents/${agent.id}`, { excluded: true })).status, 200)
  a = (await agentsOf(id)).find((x) => x.agentId === agent.id)
  assert.deepEqual([a.excluded, a.sessions], [true, 'invited'])
  const back = await api('POST', `/api/workspaces/${id}/agents/${agent.id}/remove`)
  assert.deepEqual([back.status, back.body], [200, { ok: true }])
  assert.equal(await accounts.store.workspaceAgentOverride(id, agent.id), null)
  a = (await agentsOf(id)).find((x) => x.agentId === agent.id)
  assert.deepEqual([a.excluded, a.sessions], [false, 'all'])
  // An agent not placed here has no override to set.
  const { agent: loose } = await makeAgent(accounts, { name: 'Lou', ownerUserId: 'mem' })
  assert.equal((await api('POST', `/api/workspaces/${id}/agents/${loose.id}`, { sessions: 'all' })).status, 404)
  assert.equal((await api('POST', `/api/workspaces/${id}/agents/nope`, { sessions: 'all' })).status, 400)
})

test('Invite a new agent: a link that makes an agent a member of the workspace, at the access and sessions picked', async () => {
  const id = await newWorkspace('Invited')
  const made = await api('POST', `/api/workspaces/${id}/agent-invites`, { access: 'view', sessions: 'all' })
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.deepEqual(Object.keys(made.body), ['link'])
  assert.match(made.body.link, /\/v1\/join\/qj_[A-Za-z0-9_-]+$/)
  await agentJoin({ link: made.body.link.replace(API_URL, accounts.api.url), name: 'scribe', dir: path.join(home, 'scribe-home'), log: () => {} })
  const a = (await agentsOf(id)).find((x) => x.name === 'scribe')
  assert.deepEqual([a?.via, a?.access, a?.sessions], ['member', 'view', 'all'])
})

test('an org\'s agents for its workspace\'s Add dialog, for someone allowed to see them', async () => {
  const o = await makeOrg(accounts, 'Agents Co')
  const { agent } = await makeAgent(accounts, { name: 'Orla', provider: 'OpenAI', orgId: o.org.id })
  await accounts.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  signInAs('admin', (await linkDevice(accounts, 'admin', loadIdentity())).token)
  try {
    const r = await api('GET', `/api/orgs/${o.slug}/agents`)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.agents.map((x) => [x.id, x.name, x.provider, x.placement.reach]), [[agent.id, 'Orla', 'OpenAI', 'manual']])
    // Added to an org workspace with Also join every session.
    const ws = (await api('POST', '/api/workspaces', { name: 'Org room', org: o.slug })).body.workspace.id
    assert.equal((await api('POST', `/api/workspaces/${ws}/members`, { account: `agent:${agent.id}`, access: 'edit', sessions: 'all' })).status, 200)
    assert.deepEqual((await agentsOf(ws)).map((x) => [x.name, x.via, x.sessions]), [['Orla', 'member', 'all']])
    assert.equal((await api('GET', '/api/orgs/Not a slug/agents')).status, 400)
  } finally { signInAs('mem', memToken) }
})

test('removing an agent from a session in a workspace also keeps it out of that session; elsewhere, only the removal', async () => {
  const id = await newWorkspace('Kept out')
  const { agent } = await makeAgent(accounts, { name: 'Kip', ownerUserId: 'mem' })
  await api('POST', `/api/agents/${agent.id}/placement`, { reach: 'all', sessions: 'all', access: 'edit', scopes: [] })
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'kept'), workspace: id })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const room = s.body.status.room
  await memberOfRoom(room, `agent:${agent.id}`, 'Kip')
  await memberOfRoom(room, 'person:lim', 'Lim')
  const removed = await api('POST', `/api/sessions/${s.body.id}/members/remove`, { key: `agent:${agent.id}` })
  assert.deepEqual([removed.status, removed.body.ok], [200, true], JSON.stringify(removed.body))
  const until = Date.now() + 10_000
  while (!(await accounts.store.sessionAgentExcluded(room, agent.id)) && Date.now() < until) await sleep(50)
  assert.equal(await accounts.store.sessionAgentExcluded(room, agent.id), true)
  // A person removed from the same session: no exclusion is asked for.
  assert.equal((await api('POST', `/api/sessions/${s.body.id}/members/remove`, { key: 'person:lim' })).status, 200)
  assert.deepEqual((await accounts.store.listSessionAgentExclusions(room)).map((e) => e.agentId), [agent.id])
  await api('POST', `/api/sessions/${s.body.id}/stop`)

  // A session outside any workspace: the agent is removed, nothing else.
  const loose = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'loose') })
  await memberOfRoom(loose.body.status.room, `agent:${agent.id}`, 'Kip')
  const r = await api('POST', `/api/sessions/${loose.body.id}/members/remove`, { key: `agent:${agent.id}` })
  assert.deepEqual([r.status, r.body], [200, { ok: true }])
  await sleep(300)
  assert.equal(await accounts.store.sessionAgentExcluded(loose.body.status.room, agent.id), false)
  await api('POST', `/api/sessions/${loose.body.id}/stop`)
})

test('the removal answers at once even when the API turns the exclusion down, and the session log says so', async () => {
  const id = await newWorkspace('Refused')
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'refused'), workspace: id })
  // An agent the API has never heard of: the exclusion answers 404.
  const ghost = crypto.randomUUID()
  await memberOfRoom(s.body.status.room, `agent:${ghost}`, 'Ghost')
  const r = await api('POST', `/api/sessions/${s.body.id}/members/remove`, { key: `agent:${ghost}` })
  assert.deepEqual([r.status, r.body], [200, { ok: true }])
  const until = Date.now() + 10_000
  const logged = async () => (await api('GET', '/api/state')).body.sessions.find((x) => x.id === s.body.id)?.logs.some((l) => /could not keep that agent out of this session/.test(l.line))
  while (!(await logged()) && Date.now() < until) await sleep(50)
  assert.ok(await logged())
  await api('POST', `/api/sessions/${s.body.id}/stop`)
})
