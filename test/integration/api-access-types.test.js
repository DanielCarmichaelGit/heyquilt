// Access types over the API: the built-ins, your own (up to 50), changing and deleting
// them, from the website (a JWT) or the app (a computer token).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, linkDevice } from '../helpers/api-helpers.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const types = (userId) => t.call('GET', '/v1/access-types', null, userId)

test('everyone has the two built-ins first', async () => {
  const res = await types('lim')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.types, [
    { id: 'builtin:edit', name: 'Can edit', files: 'edit', folders: [], talk: true, builtin: true },
    { id: 'builtin:view', name: 'View only', files: 'view', folders: [], talk: true, builtin: true }
  ])
  assert.equal((await t.call('GET', '/v1/access-types')).status, 401)
})

test('create, list, change and delete your own; nobody else sees or touches them', async () => {
  const made = await t.call('POST', '/v1/access-types', { name: ' Docs writer ', files: 'edit', folders: ['./docs/', 'web'], talk: false }, 'mem')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const { type } = made.body
  assert.deepEqual([type.name, type.files, type.folders, type.talk, type.builtin], ['Docs writer', 'edit', ['docs', 'web'], false, false])
  assert.deepEqual((await types('mem')).body.types.map((x) => x.name), ['Can edit', 'View only', 'Docs writer'])
  assert.equal((await types('lim')).body.types.length, 2, "Lin doesn't see Mo's types")

  const changed = await t.call('PUT', `/v1/access-types/${type.id}`, { talk: true }, 'mem')
  assert.deepEqual([changed.status, changed.body.type.talk, changed.body.type.name, changed.body.type.folders], [200, true, 'Docs writer', ['docs', 'web']])
  assert.equal((await t.call('PUT', `/v1/access-types/${type.id}`, { name: 'Mine now' }, 'lim')).status, 404)
  assert.equal((await t.call('DELETE', `/v1/access-types/${type.id}`, null, 'lim')).status, 404)
  assert.equal((await t.call('PUT', '/v1/access-types/not-a-uuid', { name: 'x' }, 'mem')).status, 404)

  assert.deepEqual((await t.call('DELETE', `/v1/access-types/${type.id}`, null, 'mem')).body, { ok: true })
  assert.equal((await types('mem')).body.types.length, 2)
  assert.equal((await t.call('DELETE', `/v1/access-types/${type.id}`, null, 'mem')).status, 404)
})

test('the built-ins cannot be changed or deleted', async () => {
  for (const [method, body] of [['PUT', { name: 'Admin' }], ['DELETE', null]]) {
    const res = await t.call(method, '/v1/access-types/builtin:edit', body, 'mem')
    assert.deepEqual([res.status, res.body.error], [403, "Built-in access types can't be changed or deleted."], method)
  }
})

test('plain messages for bad fields', async () => {
  const bad = async (body) => (await t.call('POST', '/v1/access-types', body, 'mem')).body.error
  assert.equal(await bad({ name: '', files: 'edit' }), 'Give the access type a name of 1 to 40 characters.')
  assert.equal(await bad({ name: 'x'.repeat(41), files: 'edit' }), 'Give the access type a name of 1 to 40 characters.')
  assert.equal(await bad({ name: 'x', files: 'owner' }), 'files must be edit or view.')
  assert.equal(await bad({ name: 'x', files: 'edit', folders: ['../up'] }), 'Folders must be paths inside the project, like src or docs.')
  assert.equal(await bad({ name: 'x', files: 'edit', folders: Array.from({ length: 21 }, (_, i) => `f${i}`) }), 'An access type can list at most 20 folders.')
  assert.equal(await bad({ name: 'x', files: 'edit', talk: 'no' }), 'talk must be true or false.')
  for (const e of [await bad({ name: '' }), await bad({ name: 'x', files: 'x' })]) assert.doesNotMatch(e, /—/)
})

test('at most 50 of your own', async () => {
  for (let i = 0; i < 50; i++) assert.equal((await t.call('POST', '/v1/access-types', { name: `T${i}`, files: 'view' }, 'out')).status, 200)
  const over = await t.call('POST', '/v1/access-types', { name: 'One more', files: 'view' }, 'out')
  assert.deepEqual([over.status, over.body.error], [409, 'You can have at most 50 access types. Delete one first.'])
})

test("the app's computer token works too", async () => {
  const { token } = await linkDevice(t, 'gm')
  const res = await t.call('POST', '/v1/access-types', { name: 'From the app', files: 'view' }, null, { authorization: `Bearer ${token}` })
  assert.equal(res.status, 200)
  assert.deepEqual((await t.call('GET', '/v1/access-types', null, null, { authorization: `Bearer ${token}` })).body.types.map((x) => x.name), ['Can edit', 'View only', 'From the app'])
})
