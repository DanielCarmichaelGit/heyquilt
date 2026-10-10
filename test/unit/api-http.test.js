import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanName, stripInvisible, HttpError } from '../../src/api/http.js'

test('cleanName trims, caps length, and rejects an empty result', () => {
  assert.equal(cleanName('  Acme  ', 80, 'msg'), 'Acme')
  assert.equal(cleanName('Acme Rockets', 4, 'msg'), 'Acme')
  assert.throws(() => cleanName('   ', 80, 'msg'), (err) => err instanceof HttpError && err.status === 400 && err.message === 'msg')
  assert.throws(() => cleanName('', 80, 'msg'), HttpError)
})

test('cleanName strips C0/C1 controls, zero-width characters, and bidi overrides', () => {
  assert.equal(cleanName('a\u0000b\u001fc\u007fd\u0080e', 80, 'msg'), 'abcde')
  assert.equal(cleanName('Ada​ Lovelace', 80, 'msg'), 'Ada Lovelace')
  assert.equal(cleanName('‮Evil‬ Name', 80, 'msg'), 'Evil Name')
  assert.equal(cleanName('﻿Ada', 80, 'msg'), 'Ada')
  assert.equal(cleanName('Ada؜Lovelace', 80, 'msg'), 'AdaLovelace')
})

test('cleanName strips a byte-order mark in the middle of a name, not just at the edge', () => {
  // trim() alone would only catch a BOM at the very start or end; a mid-string
  // one needs the INVISIBLE strip to actually run on it.
  assert.equal(cleanName('Ada﻿Lovelace', 80, 'msg'), 'AdaLovelace')
})

test('cleanName slices by code point, so a surrogate pair at the cut point is never split', () => {
  const smiley = '\u{1F600}' // U+1F600, a surrogate pair in UTF-16 (2 code units, 1 code point)
  // Naive UTF-16 slicing at max=2 on "a<smiley>" would cut the emoji in half,
  // leaving a lone surrogate; code-point slicing keeps it whole or drops it whole.
  assert.equal(cleanName(`a${smiley}`, 2, 'msg'), `a${smiley}`)
  assert.equal(cleanName(`a${smiley}b`, 2, 'msg'), `a${smiley}`)
  assert.equal([...cleanName(`a${smiley}b`, 2, 'msg')].length, 2, 'two code points, not a lone surrogate plus "a"')
  assert.equal(cleanName(`a${smiley}b`, 1, 'msg'), 'a')
})

test('stripInvisible returns an array of code points with the invisible ones removed', () => {
  assert.deepEqual(stripInvisible('a​b'), ['a', 'b'])
  assert.deepEqual(stripInvisible(null), [])
  assert.deepEqual(stripInvisible(undefined), [])
})

test('stripInvisible removes a byte-order mark in the middle of a string', () => {
  assert.deepEqual(stripInvisible('Ada﻿Lovelace'), [...'AdaLovelace'])
})
