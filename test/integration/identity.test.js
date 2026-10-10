// Identity signatures: relay sign-ins and computer links use separate contexts,
// so a signature made for one can never be used for the other.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { generateIdentity, parsePublicKey, signChallenge, verifyChallenge, signDeviceLink, verifyDeviceLink } from '../../src/identity.js'
import { Connection } from '../../src/connection.js'

test('device links have their own signature context', () => {
  const id = generateIdentity()
  const key = parsePublicKey(id.publicKey)
  const sig = signDeviceLink(id, 'dc_abc')
  assert.equal(verifyDeviceLink(key, 'dc_abc', sig), true)
  assert.equal(verifyDeviceLink(key, 'dc_other', sig), false, 'bound to the device code')
  assert.equal(verifyDeviceLink(parsePublicKey(generateIdentity().publicKey), 'dc_abc', sig), false, 'bound to the key')
  assert.equal(verifyDeviceLink(key, 'dc_abc', 'not a signature'), false)
  assert.equal(verifyDeviceLink(null, 'dc_abc', sig), false)
  // Neither kind of signature verifies as the other.
  assert.equal(verifyChallenge(key, 'device-link', Buffer.from('dc_abc'), Buffer.from(sig, 'base64url')), false)
  const relaySig = Buffer.from(signChallenge(id, 'room-1', Buffer.from('dc_abc'))).toString('base64url')
  assert.equal(verifyDeviceLink(key, 'dc_abc', relaySig), false)
})

test('the relay client never signs a challenge for a room named device-link', () => {
  const identity = generateIdentity()
  assert.throws(() => signChallenge(identity, 'device-link', Buffer.from('x')), /"device-link" is not a session name/)
  assert.throws(() => new Connection({ server: 'ws://127.0.0.1:9', room: 'device-link', secret: 's', name: 'n', identity, doc: new Y.Doc() }), /"device-link" is not a session name/)
})
