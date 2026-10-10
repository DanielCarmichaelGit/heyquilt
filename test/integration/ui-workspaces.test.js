// The app's local workspace routes: list, create, members, a session started inside a
// workspace is linked on the accounts API and remembered on this computer.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-ws-'))
process.env.HOME = process.env.USERPROFILE = home

const { startUi } = await import('../../src/ui-server.js')
const { startServer } = await import('../../src/server.js')
const { startTestApi, linkDevice, makeOrg, makeAgent } = await import('../helpers/api-helpers.js')
const { newPassKeys } = await import('../../src/passes.js')
const { loadIdentity } = await import('../../src/identity.js')
const { saveAccount } = await import('../../src/account.js')

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

let ui, accounts, relay
// What the API sent to agents' webhooks (session.started), recorded instead of sent.
const deliveries = []
before(async () => {
  const keys = newPassKeys()
  // The relay reports who owns each session to the API (as it does in production), which the
  // session-started hand-off waits for; the API knows the relay's address for join links.
  const relayPort = await freePort()
  const relaySecret = crypto.randomBytes(16).toString('hex')
  const webhookFetch = async (url, init) => { deliveries.push({ url, payload: JSON.parse(init.body) }); return { ok: true, status: 200 } }
  accounts = await startTestApi({ passKey: keys.privateKey, workspaces: true, relaySecret, relayUrl: `ws://127.0.0.1:${relayPort}`, webhookFetch, allowLocalWebhooks: true })
  relay = await startServer({ port: relayPort, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey, apiUrl: accounts.api.url, relayApiSecret: relaySecret })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  const { token } = await linkDevice(accounts, 'mem', loadIdentity())
  saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() })
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const api = (method, p, body) => fetch(`http://127.0.0.1:${ui.port}${p}`, {
  method, headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))

test('list, create, members', async () => {
  const first = await api('GET', '/api/workspaces')
  assert.deepEqual(first.body, { on: true, workspaces: [] })
  const made = await api('POST', '/api/workspaces', { name: 'Launch', color: 'lilac' })
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const id = made.body.workspace.id
  assert.equal((await api('GET', '/api/workspaces')).body.workspaces[0].name, 'Launch')
  assert.equal((await api('POST', `/api/workspaces/${id}/members`, { account: 'person:lim', access: 'view' })).body.member.access, 'view')
  const got = await api('GET', `/api/workspaces/${id}`)
  assert.deepEqual(got.body.members.map((m) => [m.account, m.access]), [['person:lim', 'view']])
  assert.deepEqual([got.body.running, got.body.recent], [[], []])
  assert.equal((await api('POST', `/api/workspaces/${id}/members/remove`, { account: 'person:lim' })).status, 200)
  assert.equal((await api('GET', '/api/state')).body.workspacesOn, true)
})

test('a session started inside a workspace is linked on the API and shows under the workspace', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Site' })).body.workspace.id
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'site'), workspace: id })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.workspace, id)
  const room = s.body.status.room
  const linked = await accounts.store.sessionByRoom(room)
  assert.equal(linked.workspaceId, id)
  const got = await api('GET', `/api/workspaces/${id}`)
  assert.deepEqual(got.body.running, [s.body.id])
  assert.deepEqual(got.body.sessions.map((x) => x.room), [room])
  await api('POST', `/api/sessions/${s.body.id}/stop`)
  assert.deepEqual((await api('GET', `/api/workspaces/${id}`)).body.recent.map((r) => r.dir), [path.join(home, 'site')])
})

test('a session started in a workspace sends its link to a placed agent with a webhook', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Handoff' })).body.workspace.id
  const { agent } = await makeAgent(accounts, { name: 'Pete', ownerUserId: 'mem' })
  const placed = await accounts.call('PUT', `/v1/me/agents/${agent.id}/placement`, { reach: 'workspaces', workspaceIds: [id], sessions: 'all', access: 'edit' }, 'mem')
  assert.equal(placed.status, 200, JSON.stringify(placed.body))
  await accounts.store.putAgentWebhook({ agentId: agent.id, url: 'https://hooks.example.com/pete', secret: 'pete-secret-0123456789' })
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'handoff'), workspace: id })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const room = s.body.status.room
  const until = Date.now() + 15_000
  while (!deliveries.some((d) => d.payload.room === room) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
  await accounts.api.flushWebhooks()
  const mine = deliveries.filter((d) => d.payload.room === room)
  assert.equal(mine.length, 1, JSON.stringify(deliveries))
  const p = mine[0].payload
  assert.deepEqual([mine[0].url, p.event, p.workspace, p.via, p.by], ['https://hooks.example.com/pete', 'session.started', { id, name: 'Handoff' }, 'placed', 'Mo'])
  const { decodeInvite } = await import('../../src/runner.js')
  const joined = decodeInvite(p.link)
  assert.deepEqual([joined.room, joined.server], [room, process.env.QUILT_SERVER])
  assert.ok(joined.secret)
  await api('POST', `/api/sessions/${s.body.id}/stop`)
})

test('moving an open session into a workspace brings the people who were in it', async () => {
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'movable') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const room = s.body.status.room
  const until = Date.now() + 15_000
  while (!(await accounts.store.sessionByRoom(room))?.ownerAccount && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
  await accounts.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room, account: 'person:lim', name: 'Lin', at: Date.now() }], Date.now())
  const id = (await api('POST', '/api/workspaces', { name: 'Destination' })).body.workspace.id
  assert.equal((await api('POST', `/api/workspaces/${id}/sessions/move`, { session: 'nope' })).status, 404)
  const moved = await api('POST', `/api/workspaces/${id}/sessions/move`, { session: s.body.id })
  assert.equal(moved.status, 200, JSON.stringify(moved.body))
  assert.deepEqual(moved.body.added.map((a) => [a.account, a.name, a.access]), [['person:lim', 'Lin', 'edit']])
  assert.equal((await accounts.store.sessionByRoom(room)).workspaceId, id)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'movable', '.quilt', 'config.json'), 'utf8')).workspace, id)
  const st = await api('GET', '/api/state')
  assert.equal(st.body.sessions.find((x) => x.id === s.body.id).workspace, id)
  await api('POST', `/api/sessions/${s.body.id}/stop`)
})

test('workspace invites from the app, and the invites waiting for you: accept and decline', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Inviting' })).body.workspace.id
  const sent = await api('POST', `/api/workspaces/${id}/invites`, { to: { email: 'pat@example.com' }, access: 'view' })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  assert.deepEqual((await api('GET', `/api/workspaces/${id}/invites`)).body.invites.map((i) => [i.email, i.access, i.status]), [['pat@example.com', 'view', 'waiting']])
  assert.equal((await api('POST', `/api/workspaces/${id}/invites/${sent.body.invite.id}/cancel`, {})).status, 200)
  assert.equal((await api('GET', `/api/workspaces/${id}/invites`)).body.invites[0].status, 'cancelled')
  assert.equal((await api('POST', `/api/workspaces/${id}/invites/not-an-id/cancel`, {})).status, 400)

  // Someone invites Mo (this computer's account) to two of theirs.
  const theirs = (await accounts.call('POST', '/v1/workspaces', { name: 'Theirs' }, 'lim')).body.workspace
  const other = (await accounts.call('POST', '/v1/workspaces', { name: 'Other' }, 'lim')).body.workspace
  for (const w of [theirs, other]) assert.equal((await accounts.call('POST', `/v1/workspaces/${w.id}/invites`, { to: { email: 'mo@acme.com' } }, 'lim')).status, 200)
  const mine = (await api('GET', '/api/invites')).body.invites
  const a = mine.find((i) => i.workspace?.id === theirs.id)
  const b = mine.find((i) => i.workspace?.id === other.id)
  assert.deepEqual([a.kind, a.from.name], ['workspace', 'Lin'])
  assert.equal((await api('POST', `/api/invites/${a.id}/accept`, {})).status, 200)
  assert.equal((await api('POST', `/api/invites/${b.id}/decline`, {})).status, 200)
  const names = (await api('GET', '/api/workspaces')).body.workspaces.map((w) => w.name)
  assert.ok(names.includes('Theirs') && !names.includes('Other'), names.join(', '))
  assert.equal((await api('GET', '/api/invites')).body.invites.some((i) => i.id === a.id || i.id === b.id), false)
})

test('a session the API will not put in its workspace starts outside any workspace', async () => {
  const dir = path.join(home, 'nowhere')
  const s = await api('POST', '/api/sessions', { mode: 'create', dir, workspace: crypto.randomUUID() })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.workspace, '')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.quilt', 'config.json'), 'utf8')).workspace, undefined)
  assert.ok(s.body.logs.some((l) => /could not add this session to its workspace/.test(l.line)), JSON.stringify(s.body.logs))
  assert.equal((await accounts.store.sessionByRoom(s.body.status.room))?.workspaceId ?? null, null)
  await api('POST', `/api/sessions/${s.body.id}/stop`)
  const { recentSessions } = await import('../../src/runner.js')
  assert.equal(recentSessions().find((r) => r.dir === dir)?.workspace, '')
})

test('saving settings without the archived toggle keeps when it was archived; the page says who may delete', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Old' })).body.workspace.id
  const archivedAt = (await api('POST', `/api/workspaces/${id}/update`, { name: 'Old', archived: true })).body.workspace.archivedAt
  assert.ok(archivedAt)
  const saved = await api('POST', `/api/workspaces/${id}/update`, { name: 'Older', description: '', color: 'mint' })
  assert.deepEqual([saved.body.workspace.name, saved.body.workspace.archivedAt], ['Older', archivedAt])
  assert.equal((await api('GET', `/api/workspaces/${id}`)).body.canDelete, true)
})

// Before the flag-off case: that one leaves account.json pointing at its own API.
test('GET /api/orgs lists the orgs this account is in, for the Add workspace form', async () => {
  assert.deepEqual((await api('GET', '/api/orgs')).body, { orgs: [] })
  await makeOrg(accounts, 'Ws Co')
  const r = await api('GET', '/api/orgs')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.orgs.map((o) => o.name), ['Ws Co'])
  assert.ok(r.body.orgs[0].slug)
})

test('with the flag off on the API, the app says workspaces are off', async () => {
  const off = await startTestApi({ passKey: newPassKeys().privateKey })
  const was = process.env.QUILT_API_URL
  process.env.QUILT_API_URL = off.api.url
  try {
    const { token } = await linkDevice(off, 'mem', loadIdentity())
    saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() })
    const ui2 = await startUi({ port: 0 })
    try {
      const r = await fetch(`http://127.0.0.1:${ui2.port}/api/workspaces`, { headers: { 'x-quilt-token': ui2.token } }).then((x) => x.json())
      assert.deepEqual(r, { on: false, workspaces: [] })
    } finally { await ui2.close() }
  } finally { process.env.QUILT_API_URL = was; off.close() }
})
