// The pass format: signed by the accounts API, checked by the relay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newPassKeys, passPublicKey, signPass, readPass, verifyPass, PASS_TTL_MS } from '../../src/passes.js'
import { generateIdentity } from '../../src/identity.js'

const keys = newPassKeys()
const id = generateIdentity()
const fields = (over = {}) => ({ v: 1, sub: 'user-1', kind: 'person', name: 'Dana', key: id.publicKey, exp: Date.now() + PASS_TTL_MS, ...over })

test('a signed pass verifies with the public key and gives back its payload', () => {
  const payload = fields()
  const pass = signPass(payload, keys.privateKey)
  assert.match(pass, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.deepEqual(verifyPass(pass, keys.publicKey), payload)
  assert.deepEqual(readPass(pass), payload)
  assert.equal(passPublicKey(keys.privateKey), keys.publicKey)
})

test('forged, altered, expired, wrong-version and malformed passes are refused', () => {
  assert.equal(verifyPass(signPass(fields(), newPassKeys().privateKey), keys.publicKey), null, 'another signing key')
  const [body, sig] = signPass(fields(), keys.privateKey).split('.')
  const altered = Buffer.from(JSON.stringify({ ...fields(), name: 'Mallory' })).toString('base64url')
  assert.equal(verifyPass(`${altered}.${sig}`, keys.publicKey), null, 'altered payload')
  assert.equal(verifyPass(`${body}.${sig}x`, keys.publicKey), null, 'altered signature')
  assert.equal(verifyPass(signPass(fields({ exp: Date.now() - 1 }), keys.privateKey), keys.publicKey), null, 'expired')
  assert.equal(verifyPass(signPass(fields({ v: 2 }), keys.privateKey), keys.publicKey), null, 'wrong version')
  assert.equal(verifyPass(signPass(fields({ kind: 'robot' }), keys.privateKey), keys.publicKey), null, 'unknown kind')
  assert.equal(verifyPass(signPass(fields({ name: 'x'.repeat(65) }), keys.privateKey), keys.publicKey), null, 'name too long')
  assert.equal(verifyPass(signPass(fields({ key: 'nope' }), keys.privateKey), keys.publicKey), null, 'not a key')
  for (const junk of ['', 'abc', 'a.b.c', '.', null, undefined]) assert.equal(verifyPass(junk, keys.publicKey), null, String(junk))
  assert.equal(readPass('not a pass'), null)
})

test('a pass is checked against the time it is given', () => {
  const pass = signPass(fields({ exp: 2000 }), keys.privateKey)
  assert.ok(verifyPass(pass, keys.publicKey, { now: 1999 }))
  assert.equal(verifyPass(pass, keys.publicKey, { now: 2000 }), null)
})

test('a pass with no key is a valid HTTP-only pass; a pass with a bad key is not', () => {
  const exp = Date.now() + PASS_TTL_MS
  const hosted = signPass({ v: 1, sub: 'agent-1', kind: 'agent', name: 'Grok-Bot', key: '', exp }, keys.privateKey)
  assert.equal(verifyPass(hosted, keys.publicKey).key, '')
  const bad = signPass({ v: 1, sub: 'agent-1', kind: 'agent', name: 'Grok-Bot', key: 'not-a-key', exp }, keys.privateKey)
  assert.equal(verifyPass(bad, keys.publicKey), null)
})

test('a room pass names its room as a session name, and keeps its access and email', () => {
  const room = fields({ room: 'room-1', iat: Date.now(), access: { files: 'view', folders: [], foldersExcept: [], talk: false }, email: 'dana@acme.com' })
  assert.deepEqual(verifyPass(signPass(room, keys.privateKey), keys.publicKey), room)
  for (const bad of ['', 'a room', '../x', 7]) assert.equal(verifyPass(signPass(fields({ room: bad }), keys.privateKey), keys.publicKey), null, JSON.stringify(bad))
})
