// Session names in the app: a new session is named after its folder, and its owner
// can rename it for everyone, in the app and on heyquilt.com.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-names-'))
process.env.HOME = home

const { startUi } = await import('../../src/ui-server.js')
const { startServer } = await import('../../src/server.js')
const { startTestApi } = await import('../helpers/api-helpers.js')
const { newPassKeys } = await import('../../src/passes.js')

const SECRET = 'relay-secret-for-ui-tests'
let ui, accounts, relay
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey, relaySecret: SECRET })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey, apiUrl: accounts.api.url, relayApiSecret: SECRET })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const api = (method, p, body) => fetch(`http://127.0.0.1:${ui.port}${p}`, {
  method,
  headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
async function waitFor (fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error('timed out')
}
const nameInApp = async (id) => (await api('GET', '/api/state')).body.sessions.find((s) => s.id === id)?.status.sessionName
const onDashboard = async (room) => (await accounts.call('GET', '/v1/me/sessions', null, 'mem')).body.sessions.find((s) => s.room === room)

test('a new session is named after its folder, and its owner renames it in the app and on heyquilt.com', async () => {
  const started = await api('POST', '/api/account/start')
  await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
  await waitFor(async () => (await api('GET', '/api/account')).body.signedIn)

  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'quilt-site') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const { id } = s.body
  const room = s.body.status.room
  assert.equal(await waitFor(() => nameInApp(id)), 'quilt-site')

  assert.equal((await api('POST', `/api/sessions/${id}/rename`, { name: '  ' })).status, 400)
  // Before the relay has reported the session, heyquilt.com doesn't know it yet: that's fine.
  const early = await api('POST', `/api/sessions/${id}/rename`, { name: 'Pricing page' })
  assert.deepEqual([early.status, early.body], [200, { name: 'Pricing page' }])
  assert.equal(await waitFor(async () => (await nameInApp(id)) === 'Pricing page' && 'Pricing page'), 'Pricing page')
  await relay.presence.flush()
  assert.equal((await onDashboard(room)).name, 'Pricing page', "the relay's report carries the name")

  // Now heyquilt.com knows the session, and the rename goes there directly.
  relay.rooms.get(room).lastRenameAt -= 2000 // the relay takes one rename every 2 seconds
  assert.equal((await api('POST', `/api/sessions/${id}/rename`, { name: 'Launch' })).status, 200)
  assert.equal((await onDashboard(room)).name, 'Launch')
  await api('POST', `/api/sessions/${id}/stop`)
})

test('the app has Rename for the owner, and shows the name in its session tabs', async () => {
  const session = await (await fetch(`http://127.0.0.1:${ui.port}/session.js`)).text()
  assert.ok(session.includes('Rename session…'))
  assert.ok(session.includes("$('#rename-btn').hidden = !st.access?.owner"))
  const app = await (await fetch(`http://127.0.0.1:${ui.port}/app.js`)).text()
  assert.ok(app.includes('s.status.sessionName || basename(s.dir)'))
})
