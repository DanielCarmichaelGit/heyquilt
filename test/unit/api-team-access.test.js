import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessOf, cleanScopes, MAX_SCOPES, MAX_SCOPE_LENGTH } from '../../src/api/team-access.js'

test('accessOf allows editor and viewer only', () => {
  assert.equal(accessOf('editor'), 'editor')
  assert.equal(accessOf('viewer'), 'viewer')
  for (const bad of ['owner', '', undefined, null]) assert.throws(() => accessOf(bad), (err) => err.status === 400)
})

test('cleanScopes tidies folders the way the relay does', () => {
  assert.deepEqual([MAX_SCOPES, MAX_SCOPE_LENGTH], [20, 200])
  assert.deepEqual(cleanScopes(['src/', './docs', ' web/app ', 'src', '', 'a/b/']), ['src', 'docs', 'web/app', 'a/b'])
  assert.deepEqual(cleanScopes([]), [])
  assert.equal(cleanScopes(Array.from({ length: 20 }, (_, i) => `d${i}`)).length, 20)
  assert.equal(cleanScopes(['x'.repeat(200)]).length, 1)
})

test('cleanScopes refuses paths outside the project, odd input and too many folders', () => {
  for (const bad of [['/etc'], ['../x'], ['a/../../b'], ['a\\b'], ['x'.repeat(201)], [42], 'src', null, undefined, ['.'], ['a//b'], ['a/./b'], ['C:/x']]) {
    assert.throws(() => cleanScopes(bad), (err) => err.status === 400, JSON.stringify(bad))
  }
  assert.throws(() => cleanScopes(Array.from({ length: 21 }, (_, i) => `d${i}`)), (err) => err.status === 400 && /20 folders/.test(err.message))
})
