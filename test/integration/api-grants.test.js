// Session grants: only a session's owner gives people and agents an access type there,
// narrowed or not, and the API works out what that comes to.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi, linkDevice } from '../helpers/api-helpers.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
let rooms = 0
/** A session the relay has reported, owned by `owner` (a user id in the test cast). */
async function session (owner = 'mem') {
  const room = `grants-${++rooms}`
  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room, account: `person:${owner}`, name: 'Owner', owner: true, at: Date.now() }], Date.now())
  return room
}
const put = (room, account, body, userId = 'mem') => t.call('PUT', `/v1/sessions/${room}/grants/${account}`, body, userId)

test('the owner gives an agent a type, narrows it, and lists what it comes to', async () => {
  const room = await session()
  const docs = (await t.call('POST', '/v1/access-types', { name: 'Docs', files: 'edit', folders: ['docs', 'web'] }, 'mem')).body.type
  const res = await put(room, 'agent:a1', { typeId: docs.id, tighten: { foldersRemove: ['web'], talk: false, files: 'edit' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.grant, { ...res.body.grant, account: 'agent:a1', typeId: docs.id, typeName: 'Docs', tighten: { foldersRemove: ['web'], talk: false }, access: { files: 'edit', folders: ['docs'], foldersExcept: [], talk: false } })
  await put(room, 'person:lim', { typeId: 'builtin:edit', tighten: { foldersRemove: ['secrets'] } })
  const list = await t.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')
  assert.deepEqual(list.body.grants.map((g) => [g.account, g.typeName, g.access.foldersExcept]), [['agent:a1', 'Docs', []], ['person:lim', 'Can edit', ['secrets']]])
  assert.deepEqual((await t.call('DELETE', `/v1/sessions/${room}/grants/agent:a1`, null, 'mem')).body, { ok: true })
  assert.equal((await t.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')).body.grants.length, 1)
})

test('only the owner, only in a session heyquilt.com knows, and only with their own types', async () => {
  const room = await session()
  const notMine = (await t.call('POST', '/v1/access-types', { name: 'Lins', files: 'edit' }, 'lim')).body.type
  const forbidden = await put(room, 'person:lim', { typeId: 'builtin:edit' }, 'lim')
  assert.deepEqual([forbidden.status, forbidden.body.error], [403, 'Only the session owner can change who gets in.'])
  assert.equal((await t.call('GET', `/v1/sessions/${room}/grants`, null, 'lim')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/sessions/${room}/grants/person:lim`, null, 'lim')).status, 403)
  const unknown = await put('never-reported', 'person:lim', { typeId: 'builtin:edit' })
  assert.deepEqual([unknown.status, unknown.body.error], [404, "That session hasn't reached heyquilt.com yet. Try again in a minute."])
  assert.equal((await put(room, 'person:lim', { typeId: notMine.id })).body.error, 'no such access type')
  assert.equal((await put(room, 'person:lim', { typeId: 'builtin:admin' })).status, 400)
  assert.equal((await put(room, 'Bob', { typeId: 'builtin:edit' })).status, 400, 'by account, never by name')
  assert.equal((await put(room, 'person:mem', { typeId: 'builtin:view' })).body.error, 'The owner always has full access.')
  assert.equal((await put(room, 'person:lim', { typeId: 'builtin:edit', tighten: { foldersRemove: ['/etc'] } })).status, 400)
  assert.equal((await t.call('GET', `/v1/sessions/${room}/grants`, null, null)).status, 401)
})

test('deleting a type leaves its grants on View only', async () => {
  const room = await session()
  const type = (await t.call('POST', '/v1/access-types', { name: 'Temp', files: 'edit' }, 'mem')).body.type
  await put(room, 'person:lim', { typeId: type.id, tighten: { talk: false } })
  await t.call('DELETE', `/v1/access-types/${type.id}`, null, 'mem')
  const [g] = (await t.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')).body.grants
  assert.deepEqual([g.typeId, g.typeName, g.access], ['builtin:view', 'View only', { files: 'view', folders: [], foldersExcept: [], talk: false }])
})

test("the owner's app sets grants with its computer token", async () => {
  const room = await session('admin')
  const { token } = await linkDevice(t, 'admin')
  const res = await t.call('PUT', `/v1/sessions/${room}/grants/agent:a9`, { typeId: 'builtin:view' }, null, { authorization: `Bearer ${token}` })
  assert.deepEqual([res.status, res.body.grant.access.files], [200, 'view'])
})
