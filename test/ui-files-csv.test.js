// The CSV preview's parser: quoted commas, "" inside quotes, CRLF line ends, the row cap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from '../src/ui/csv.js'

test('quoted commas, doubled quotes and CRLF', () => {
  assert.deepEqual(parseCsv('name,role,quote\r\nMo,"owner, lead","said ""hi"""\r\nLin,editor,plain\r\n'), [
    ['name', 'role', 'quote'],
    ['Mo', 'owner, lead', 'said "hi"'],
    ['Lin', 'editor', 'plain']
  ])
})

test('a quoted field can hold a line break, and a last line without one still counts', () => {
  assert.deepEqual(parseCsv('a,"two\nlines"\nb,c'), [['a', 'two\nlines'], ['b', 'c']])
  assert.deepEqual(parseCsv('x,,y'), [['x', '', 'y']])
})

test('stops at the row cap', () => {
  const text = Array.from({ length: 500 }, (_, i) => `${i},row`).join('\n')
  assert.equal(parseCsv(text).length, 200)
  assert.equal(parseCsv(text, 3).length, 3)
})
