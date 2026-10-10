import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { deriveWrapKey, newFileKey, wrapKey, unwrapKey, encryptBlob, decryptBlob, blobId } from '../../src/largefiles.js'

test('wrap keys depend on the secret and the room', () => {
  const a = deriveWrapKey('secret', 'room-1')
  assert.equal(a.length, 32)
  assert.deepEqual(a, deriveWrapKey('secret', 'room-1'))
  assert.notDeepEqual(a, deriveWrapKey('secret', 'room-2'))
  assert.notDeepEqual(a, deriveWrapKey('other', 'room-1'))
})

test('a wrapped file key opens only with the wrap key it was wrapped with', () => {
  const key = newFileKey()
  const edit = deriveWrapKey('edit', 'r')
  const view = deriveWrapKey('view', 'r')
  const wraps = [wrapKey(key, edit), wrapKey(key, view)]
  assert.deepEqual(unwrapKey(wraps[0], edit), key)
  assert.deepEqual(unwrapKey(wraps[1], view), key)
  assert.equal(unwrapKey(wraps[0], view), null)
  assert.equal(unwrapKey('not-a-wrap', edit), null)
})

test('files round-trip, and tampering is caught', () => {
  const key = newFileKey()
  const plain = crypto.randomBytes(300 * 1024)
  const sealed = encryptBlob(plain, key)
  assert.ok(!sealed.includes(plain.subarray(1000, 1064)), 'no plaintext in the sealed file')
  assert.deepEqual(decryptBlob(sealed, key), plain)
  sealed[sealed.length - 1] ^= 1
  assert.throws(() => decryptBlob(sealed, key), /could not be decrypted/)
  assert.throws(() => decryptBlob(encryptBlob(plain, key), newFileKey()), /could not be decrypted/)
})

test('ids are stable per key and content, and reveal nothing', () => {
  const key = newFileKey()
  const id = blobId(key, 'a'.repeat(40))
  assert.match(id, /^[a-f0-9]{32}$/)
  assert.equal(id, blobId(key, 'a'.repeat(40)))
  assert.notEqual(id, blobId(key, 'b'.repeat(40)))
  assert.notEqual(id, blobId(newFileKey(), 'a'.repeat(40)))
})
