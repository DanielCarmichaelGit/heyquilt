// The app shows who's waiting even when the relay is older than "who can let people in":
// such a relay sends no canAdmit on access, and its owner must still see and let people in.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-admit-old-'))
process.env.HOME = home

const { startUi } = await import('../../src/ui-server.js')
const { startServer } = await import('../../src/server.js')
const { Session } = await import('../../src/session.js')
const { personPasses } = await import('../../src/pass-source.js')
const { startTestApi, linkDevice } = await import('../helpers/api-helpers.js')
const { newPassKeys } = await import('../../src/passes.js')

const SECRET = 'relay-secret-for-ui-admit-old-tests'
let ui, accounts, relay, agent
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey, relaySecret: SECRET })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey, apiUrl: accounts.api.url, relayApiSecret: SECRET })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  ui = await startUi({ port: 0 })
})
after(async () => { await agent?.stop(); await ui.close(); await relay.close(); await accounts.close() })

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

test('against a relay that sends no canAdmit, the owner still sees a waiting agent and lets it in', async () => {
  const started = await api('POST', '/api/account/start')
  await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
  await waitFor(async () => (await api('GET', '/api/account')).body.signedIn)

  // A first session brings the relay's Room class into being; make it talk like the deployed one.
  const first = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'first') })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const Room = Object.getPrototypeOf(relay.rooms.get(first.body.status.room))
  const newer = Room.accessMessage
  Room.accessMessage = function (a) { const { canAdmit, admitBy, ...older } = newer.call(this, a); return older }
  await api('POST', `/api/sessions/${first.body.id}/stop`)

  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'site') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const { id } = s.body
  const room = s.body.status.room
  await waitFor(async () => (await api('GET', '/api/state')).body.sessions.find((x) => x.id === id)?.status.access?.owner)
  assert.equal((await api('GET', '/api/state')).body.sessions.find((x) => x.id === id).status.access.canAdmit, undefined, 'the relay sent no canAdmit')

  const device = await linkDevice(accounts, 'sri')
  agent = new Session({ dir: fs.mkdtempSync(path.join(home, 'agent-')), server: process.env.QUILT_SERVER, room, secret: s.body.invite.split('#')[1], name: 'Sriram', kind: 'agent', identity: device.identity, passes: personPasses({ token: device.token, api: accounts.api.url }) })
  await agent.start({ waitTimeoutMs: 5000 })
  await waitFor(() => agent.access?.state === 'pending')

  // The owner's app lists the agent, so the request bar shows.
  const waiting = await waitFor(async () => (await api('GET', '/api/state')).body.sessions.find((x) => x.id === id)?.status.waiting?.length && (await api('GET', '/api/state')).body.sessions.find((x) => x.id === id).status.waiting)
  assert.deepEqual(waiting.map((p) => p.key), ['person:sri'])

  const approved = await api('POST', `/api/sessions/${id}/members/approve`, { key: waiting[0].key, role: 'editor' })
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  await waitFor(() => agent.access?.state === 'approved')
  await api('POST', `/api/sessions/${id}/stop`)
})
