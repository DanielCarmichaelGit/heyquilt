import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newToken, hashToken, newUserCode, normalizeUserCode, sameHash, CODE_ALPHABET } from '../../src/api/tokens.js'

test('tokens carry their prefix, are long and random, and hash stably', () => {
  const a = newToken('qd_'); const b = newToken('qd_')
  assert.match(a, /^qd_[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
  assert.equal(hashToken(a), hashToken(a))
  assert.match(hashToken(a), /^[0-9a-f]{64}$/)
  assert.ok(sameHash(hashToken(a), hashToken(a)))
  assert.ok(!sameHash(hashToken(a), hashToken(b)))
})

test('link codes use an unambiguous alphabet and normalise what people type', () => {
  for (let i = 0; i < 200; i++) {
    const c = newUserCode()
    assert.match(c, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    for (const ch of c.replace('-', '')) assert.ok(CODE_ALPHABET.includes(ch), ch)
  }
  assert.equal(normalizeUserCode(' 7f3k9qxm '), '7F3K-9QXM')
  assert.equal(normalizeUserCode('7F3K-9QXM'), '7F3K-9QXM')
  assert.equal(normalizeUserCode('7F3K-9QX0'), null, '0 is not in the alphabet')
  assert.equal(normalizeUserCode('short'), null)
})
