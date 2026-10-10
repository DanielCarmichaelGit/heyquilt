// Access types in the app: the owner lets someone in as a type, changes and narrows it,
// invites people, and removes them. The grant goes to the API, the relay applies it, and
// the person's app follows.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-access-'))
process.env.HOME = home

const { startUi } = await import('../../src/ui-server.js')
const { startServer } = await import('../../src/server.js')
const { Session } = await import('../../src/session.js')
const { personPasses } = await import('../../src/pass-source.js')
const { startTestApi, linkDevice } = await import('../helpers/api-helpers.js')
const { newPassKeys } = await import('../../src/passes.js')

const SECRET = 'relay-secret-for-ui-access-tests'
let ui, accounts, relay, lin, lin2
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey, relaySecret: SECRET })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey, apiUrl: accounts.api.url, relayApiSecret: SECRET })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  ui = await startUi({ port: 0 })
})
after(async () => { await lin?.stop(); await lin2?.stop(); await ui.close(); await relay.close(); await accounts.close() })

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
const grants = async (room) => (await accounts.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')).body.grants

test('the owner lets someone in as a type, narrows it, invites people, and removes someone', async () => {
  const started = await api('POST', '/api/account/start')
  await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
  await waitFor(async () => (await api('GET', '/api/account')).body.signedIn)
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'site') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const { id } = s.body
  const room = s.body.status.room
  // The relay tells heyquilt.com who owns the session as soon as Mo is in.
  await waitFor(async () => (await accounts.store.sessionByRoom(room))?.ownerAccount === 'person:mem')

  const types = await api('GET', '/api/access-types')
  assert.deepEqual(types.body.types.map((x) => x.id), ['builtin:edit', 'builtin:view'])

  // Lin joins from her own computer and waits: she has no grant yet.
  const device = await linkDevice(accounts, 'lim')
  lin = new Session({ dir: fs.mkdtempSync(path.join(home, 'lin-')), server: process.env.QUILT_SERVER, room, secret: s.body.invite.split('#')[1], name: 'Lin', identity: device.identity, passes: personPasses({ token: device.token, api: accounts.api.url }) })
  await lin.start({ waitTimeoutMs: 5000 })
  await waitFor(() => lin.access?.state === 'pending')

  // The built-in types are known here: letting someone in as one doesn't need the type list.
  const listTypes = accounts.store.listAccessTypes
  accounts.store.listAccessTypes = async () => { throw new Error('the database is down') }
  let approved
  try { approved = await api('POST', `/api/sessions/${id}/members/approve`, { key: 'person:lim', typeId: 'builtin:view' }) } finally { accounts.store.listAccessTypes = listTypes }
  assert.deepEqual([approved.status, approved.body], [200, { ok: true }])
  await waitFor(() => lin.access?.state === 'approved' && lin.access.role === 'viewer')
  assert.deepEqual((await grants(room)).map((g) => [g.account, g.typeName]), [['person:lim', 'View only']])

  // Can edit, but no posting: the relay narrows at once, and Lin's fresh pass brings the rest.
  const changed = await api('POST', `/api/sessions/${id}/members/access`, { key: 'person:lim', typeId: 'builtin:edit', tighten: { talk: false } })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  assert.deepEqual(changed.body.grant.access, { files: 'edit', folders: [], foldersExcept: [], talk: false })
  await waitFor(() => lin.access.role === 'editor' && lin.access.talk === false)
  assert.equal((await api('POST', `/api/sessions/${id}/members/access`, { key: 'b3f1c0ffee', typeId: 'builtin:edit' })).status, 400, 'an older member has no account')

  // Lin is someone Mo has worked with now.
  await relay.presence.flush()
  const people = await api('GET', '/api/collaborators')
  assert.deepEqual(people.body.collaborators.map((c) => c.account), ['person:lim'])

  // An email invite carries the view link for a view-only type.
  accounts.sent.length = 0
  const invited = await api('POST', `/api/sessions/${id}/invites`, { typeId: 'builtin:view', to: { email: 'pat@example.com' } })
  assert.equal(invited.status, 200, JSON.stringify(invited.body))
  assert.ok(accounts.sent[0].text.includes(s.body.viewInvite), 'the view link')
  const list = await api('GET', `/api/sessions/${id}/invites`)
  assert.deepEqual(list.body.invites.map((i) => [i.email, i.status]), [['pat@example.com', 'waiting']])
  assert.deepEqual((await api('POST', `/api/sessions/${id}/invites/cancel`, { inviteId: invited.body.invite.id })).body, { ok: true })
  assert.equal((await api('POST', `/api/sessions/${id}/invites/cancel`, {})).status, 400, 'which invite?')
  assert.equal((await api('GET', `/api/sessions/${id}/invites`)).body.invites[0].status, 'cancelled')

  // Removing Lin takes her grant away too.
  const fatal = new Promise((resolve) => lin.once('fatal', resolve))
  assert.equal((await api('POST', `/api/sessions/${id}/members/remove`, { key: 'person:lim' })).status, 200)
  assert.match((await fatal).message, /removed you/)
  assert.deepEqual(await grants(room), [])

  // Removing someone holds only if their grant goes too. When heyquilt.com can't delete it,
  // the relay still removes them, and the owner is told they can get back in.
  assert.equal((await accounts.call('PUT', `/v1/sessions/${room}/grants/person:lim`, { typeId: 'builtin:edit' }, 'mem')).status, 200)
  lin2 = new Session({ dir: fs.mkdtempSync(path.join(home, 'lin2-')), server: process.env.QUILT_SERVER, room, secret: s.body.invite.split('#')[1], name: 'Lin', identity: device.identity, passes: personPasses({ token: device.token, api: accounts.api.url }) })
  await lin2.start({ waitTimeoutMs: 5000 })
  await waitFor(() => lin2.access?.state === 'approved')
  const realDelete = accounts.store.deleteGrant
  accounts.store.deleteGrant = async () => { throw new Error('the database is down') }
  const fatal2 = new Promise((resolve) => lin2.once('fatal', resolve))
  let failed
  try { failed = await api('POST', `/api/sessions/${id}/members/remove`, { key: 'person:lim' }) } finally { accounts.store.deleteGrant = realDelete }
  assert.equal(failed.status, 200)
  assert.match(failed.body.warning, /^Removed, but their access is still saved on heyquilt\.com, so they can get back in/)
  assert.match((await fatal2).message, /removed you/, 'the relay removal still happens')
  assert.deepEqual((await grants(room)).map((g) => g.account), ['person:lim'])
  await api('POST', `/api/sessions/${id}/stop`)
})
