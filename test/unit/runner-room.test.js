import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newConn } from '../../src/runner.js'

test('a new session gets a room name with 64 random bits', () => {
  const names = new Set(Array.from({ length: 200 }, () => newConn('ws://x').room))
  assert.equal(names.size, 200)
  for (const n of names) assert.match(n, /^room-[0-9a-f]{16}$/)
})
