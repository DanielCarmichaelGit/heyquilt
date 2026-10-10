// Passes for one room carry what their holder may do there: the owner's access, their
// grant's, or nothing yet. An email invite turns into a grant on the invited person's
// first room pass.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi, makeAgent, linkDevice } from '../helpers/api-helpers.js'
import { newPassKeys, verifyPass } from '../../src/passes.js'
import { generateIdentity } from '../../src/identity.js'

const KEYS = newPassKeys()
let t
before(async () => { t = await startTestApi({ passKey: KEYS.privateKey }) })
after(() => t.close())
let rooms = 0
async function session (owner = 'mem') {
  const room = `rp-${++rooms}`
  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room, account: `person:${owner}`, name: 'Owner', owner: true, at: Date.now() }], Date.now())
  return room
}
async function roomPass (bearer, room) {
  const r = await t.call('POST', '/v1/passes', room === undefined ? {} : { room }, null, { authorization: `Bearer ${bearer}` })
  return r.status === 200 ? verifyPass(r.body.pass, KEYS.publicKey) : r
}

test("the owner's room pass says so, with the room, when it was issued and their email", async () => {
  const room = await session('mem')
  const { token } = await linkDevice(t, 'mem')
  const p = await roomPass(token, room)
  assert.deepEqual([p.room, p.email, p.access], [room, 'mo@acme.com', { owner: true, files: 'edit', folders: [], foldersExcept: [], talk: true }])
  assert.ok(p.iat <= Date.now() && p.exp - p.iat === 10 * 60 * 1000)
  const plain = await roomPass(token, undefined)
  assert.deepEqual(Object.keys(plain).sort(), ['exp', 'key', 'kind', 'name', 'sub', 'v'], 'without a room, a pass is as before')
})

test('a grant comes through as access; no grant is null; an unknown session is null', async () => {
  const room = await session('mem')
  const { token } = await linkDevice(t, 'lim')
  assert.equal((await roomPass(token, room)).access, null, 'not let in yet')
  await t.call('PUT', `/v1/sessions/${room}/grants/person:lim`, { typeId: 'builtin:edit', tighten: { foldersRemove: ['secrets'], talk: false } }, 'mem')
  assert.deepEqual((await roomPass(token, room)).access, { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: false })
  assert.equal((await roomPass(token, 'never-reported')).access, null)
  assert.equal((await roomPass(token, 'bad room')).status, 400)
})

test('an agent has no email in its pass, and its grant applies', async () => {
  const room = await session('mem')
  const identity = generateIdentity()
  const { agent, accessKey } = await makeAgent(t, { name: 'Larry', publicKey: identity.publicKey, ownerUserId: 'mem' })
  await t.call('PUT', `/v1/sessions/${room}/grants/agent:${agent.id}`, { typeId: 'builtin:view' }, 'mem')
  const p = await roomPass(accessKey, room)
  assert.equal(p.email, undefined)
  assert.equal(p.access.files, 'view')
})

test('an email invite lets in whoever signs in with that confirmed email, once', async () => {
  const room = await session('mem')
  const link = `https://join.heyquilt.com/${room}#s`
  await t.call('POST', `/v1/sessions/${room}/invites`, { to: { email: 'Lin@acme.com' }, typeId: 'builtin:view', link }, 'mem')
  await t.call('POST', `/v1/sessions/${room}/invites`, { to: { email: 'una@acme.com' }, typeId: 'builtin:edit', link }, 'mem')
  const lin = await linkDevice(t, 'lim')
  assert.equal((await roomPass(lin.token, room)).access.files, 'view')
  const [invite] = (await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body.invites.filter((i) => i.email === 'lin@acme.com')
  assert.equal(invite.status, 'used')
  const grants = (await t.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')).body.grants.map((g) => g.account)
  assert.deepEqual(grants.sort(), ['email:una@acme.com', 'person:lim'])
  const una = await linkDevice(t, 'unconf')
  assert.equal((await roomPass(una.token, room)).access, null, "Una hasn't confirmed her email, so it can't be hers yet")
})

test('an account invite is marked used when its account first gets a room pass', async () => {
  const room = await session('admin')
  // Ada and Otto worked together a minute ago, so she may invite him by account.
  const before = Date.now() - 60000
  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room: 'shared-before', account: 'person:admin', name: 'Ada', owner: true, at: before }, { id: crypto.randomUUID(), type: 'start', room: 'shared-before', account: 'person:out', name: 'Otto', at: before }], Date.now())
  await t.call('POST', `/v1/sessions/${room}/invites`, { to: { account: 'person:out' }, typeId: 'builtin:edit', link: `https://join.heyquilt.com/${room}#s` }, 'admin')
  const { token } = await linkDevice(t, 'out')
  assert.equal((await roomPass(token, room)).access.files, 'edit')
  assert.deepEqual((await t.call('GET', `/v1/sessions/${room}/invites`, null, 'admin')).body.invites.map((i) => i.status), ['used'])
})
