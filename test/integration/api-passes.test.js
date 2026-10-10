// POST /v1/passes: a linked computer or a signed-in agent swaps its token for a
// short-lived pass the relay checks.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeAgent, linkDevice } from '../helpers/api-helpers.js'
import { newPassKeys, verifyPass, PASS_TTL_MS } from '../../src/passes.js'
import { generateIdentity } from '../../src/identity.js'

const KEYS = newPassKeys()
let t
before(async () => { t = await startTestApi({ passKey: KEYS.privateKey }) })
after(() => t.close())
const passFor = (bearer, via = t) => via.call('POST', '/v1/passes', null, null, bearer ? { authorization: `Bearer ${bearer}` } : {})

test('a linked computer gets a pass for its account, name and key', async () => {
  const { token, identity } = await linkDevice(t, 'mem')
  const r = await passFor(token)
  assert.equal(r.status, 200)
  const p = verifyPass(r.body.pass, KEYS.publicKey)
  assert.deepEqual(p, { v: 1, sub: 'mem', kind: 'person', name: 'Mo', key: identity.publicKey, exp: r.body.expiresAt })
  assert.deepEqual(Object.keys(p).sort(), ['exp', 'key', 'kind', 'name', 'sub', 'v'], 'no team fields yet')
  const left = r.body.expiresAt - Date.now()
  assert.ok(left > PASS_TTL_MS - 5000 && left <= PASS_TTL_MS, `expires in ${left} ms`)
})

test('an agent gets a pass with the key it registered when it joined', async () => {
  const identity = generateIdentity()
  const { agent, accessKey } = await makeAgent(t, { name: 'Larry', publicKey: identity.publicKey, ownerUserId: 'mem' })
  const r = await passFor(accessKey)
  assert.equal(r.status, 200)
  assert.deepEqual(verifyPass(r.body.pass, KEYS.publicKey), { v: 1, sub: agent.id, kind: 'agent', name: 'Larry', key: identity.publicKey, exp: r.body.expiresAt })
})

test('an agent with no registered key gets an HTTP-only pass (no key), for the hosted MCP', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Keyless', ownerUserId: 'mem' })
  const r = await passFor(accessKey)
  assert.equal(r.status, 200)
  assert.deepEqual(verifyPass(r.body.pass, KEYS.publicKey), { v: 1, sub: agent.id, kind: 'agent', name: 'Keyless', key: '', exp: r.body.expiresAt })
})

test('unknown, revoked and expired tokens get 401', async () => {
  for (const bad of [null, 'qd_nope', 'qa_nope', 'something']) assert.equal((await passFor(bad)).status, 401, String(bad))
  const { token } = await linkDevice(t, 'mem')
  await t.call('POST', '/v1/me/signout', {}, null, { authorization: `Bearer ${token}` })
  assert.equal((await passFor(token)).status, 401, 'signed-out computer')
  const revoked = await makeAgent(t, { name: 'Gone', publicKey: generateIdentity().publicKey, ownerUserId: 'mem' })
  await t.store.revokeAgent(revoked.agent.id)
  assert.equal((await passFor(revoked.accessKey)).status, 401, 'revoked agent')
  const stale = await makeAgent(t, { name: 'Stale', publicKey: generateIdentity().publicKey, ownerUserId: 'mem', accessTtl: -1000 })
  assert.equal((await passFor(stale.accessKey)).status, 401, 'expired access key')
})

test('each token gets 60 passes a minute', async () => {
  const { token } = await linkDevice(t, 'admin')
  for (let i = 0; i < 60; i++) assert.equal((await passFor(token)).status, 200, `pass ${i + 1}`)
  const over = await passFor(token)
  assert.equal(over.status, 429)
  assert.equal(over.body.error, 'too many passes; try again in a minute')
  const other = await linkDevice(t, 'admin')
  assert.equal((await passFor(other.token)).status, 200, 'another token has its own limit')
})

test('the public key is published, and an API without a pass key says passes are not set up', async () => {
  assert.deepEqual((await t.call('GET', '/v1/passes/key')).body, { publicKey: KEYS.publicKey })
  const bare = await startTestApi()
  try {
    const { token } = await linkDevice(bare, 'mem')
    const r = await passFor(token, bare)
    assert.equal(r.status, 503)
    assert.equal(r.body.error, 'passes are not set up on this server')
    assert.equal((await bare.call('GET', '/v1/passes/key')).status, 503)
  } finally { await bare.close() }
})
