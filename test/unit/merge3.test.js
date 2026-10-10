import { test } from 'node:test'
import assert from 'node:assert/strict'
import { merge3, withMarkers, hasMarkers } from '../../src/merge3.js'

const base = 'top\nmiddle\nbottom\n'

test('changes to different lines merge cleanly', () => {
  const r = merge3(base, 'top (bob)\nmiddle\nbottom\n', 'top\nmiddle\nbottom (alice)\n')
  assert.equal(r.text, 'top (bob)\nmiddle\nbottom (alice)\n')
  assert.deepEqual(r.conflicts, [])
})

test('one side unchanged takes the other side whole', () => {
  assert.equal(merge3(base, base, 'x\n').text, 'x\n')
  assert.equal(merge3(base, 'y\n', base).text, 'y\n')
})

test('both sides changing the same line is a conflict', () => {
  const r = merge3(base, 'top\nmiddle (bob)\nbottom\n', 'top\nmiddle (alice)\nbottom\n')
  assert.equal(r.conflicts.length, 1)
  assert.deepEqual(r.conflicts[0], { base: ['middle'], ours: ['middle (bob)'], theirs: ['middle (alice)'] })
})

test('both sides making the same change is not a conflict', () => {
  const same = 'top\nmiddle!\nbottom\n'
  const r = merge3(base, same, same)
  assert.equal(r.text, same)
  assert.deepEqual(r.conflicts, [])
})

test('an empty base (both sides created the file) conflicts unless identical', () => {
  assert.equal(merge3('', 'a\n', 'a\n').conflicts.length, 0)
  assert.equal(merge3('', 'a\n', 'b\n').conflicts.length, 1)
})

test('CRLF files keep their line endings', () => {
  const b = 'top\r\nmiddle\r\nbottom\r\n'
  const r = merge3(b, 'top (bob)\r\nmiddle\r\nbottom\r\n', 'top\r\nmiddle\r\nbottom (alice)\r\n')
  assert.equal(r.text, 'top (bob)\r\nmiddle\r\nbottom (alice)\r\n')
})

test('a file without a trailing newline stays that way', () => {
  // A middle line is needed as an anchor: with only two lines changed on
  // both ends and no common line between them, real three-way merge (git
  // merge-file included) calls that a conflict, not a clean merge.
  const r = merge3('a\nmid\nb', 'a!\nmid\nb', 'a\nmid\nb!')
  assert.equal(r.text, 'a!\nmid\nb!')
  assert.deepEqual(r.conflicts, [])
})

test('markers are git style and labelled with names', () => {
  const text = withMarkers(base, 'top\nmiddle (bob)\nbottom\n', 'top\nmiddle (alice)\nbottom\n', { mine: 'bob', theirs: 'alice' })
  assert.equal(text, 'top\n<<<<<<< mine (bob)\nmiddle (bob)\n=======\nmiddle (alice)\n>>>>>>> session (alice)\nbottom\n')
  assert.ok(hasMarkers(text))
  assert.ok(!hasMarkers(base))
  assert.ok(!hasMarkers('<<<<<<< not ours\nx\n'), 'only Quilt’s own markers count')
})
