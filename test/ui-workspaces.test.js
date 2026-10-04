// The app's local workspace routes: list, create, members, a session started inside a
// workspace is linked on the accounts API and remembered on this computer.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-ws-'))
process.env.HOME = process.env.USERPROFILE = home

const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { startTestApi, linkDevice, makeOrg } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')
const { loadIdentity } = await import('../src/identity.js')
const { saveAccount } = await import('../src/account.js')

let ui, accounts, relay
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey, workspaces: true })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
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
