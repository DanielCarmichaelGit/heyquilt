import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startAgentReaders } from '../../src/agents/index.js'

test('a Cursor reader that is still working is not marked idle by the other', () => {
  let composer
  let transcripts
  const readers = [
    ['Cursor', ({ onState }) => {
      composer = onState
      onState({ tool: 'Cursor', status: 'working' })
      return { stop () {} }
    }],
    ['Cursor', ({ onState }) => {
      transcripts = onState
      onState({ tool: 'Cursor', status: 'idle' })
      return { stop () {} }
    }]
  ]
  const seen = []
  const handle = startAgentReaders({
    dir: process.cwd(),
    readers,
    onEntries () {},
    onState: (s) => seen.push({ tool: s.tool, status: s.status })
  })
  assert.equal(seen.at(-1).status, 'working')
  transcripts({ tool: 'Cursor', status: 'idle' })
  assert.deepEqual(seen.at(-1), { tool: 'Cursor', status: 'working' })
  composer({ tool: 'Cursor', status: 'idle' })
  assert.equal(seen.at(-1).status, 'idle')
  handle.stop()
})

test('historical feed entries do not pin Claude Code as the idle tool', () => {
  let pushEntries
  const readers = [
    ['Claude Code', ({ onEntries, onState }) => {
      pushEntries = onEntries
      onState({ tool: 'Claude Code', status: 'idle' })
      return { stop () {} }
    }],
    ['Cursor', ({ onState }) => {
      onState({ tool: 'Cursor', status: 'idle' })
      return { stop () {} }
    }]
  ]
  const seen = []
  const handle = startAgentReaders({
    dir: process.cwd(),
    readers,
    onEntries () {},
    onState: (s) => seen.push({ tool: s.tool, status: s.status })
  })
  // Simulate Claude Code backfilling old transcripts without ever going "working".
  pushEntries([{ id: 'old', tool: 'Claude Code', conv: 'c', kind: 'reply', text: 'hi', ts: 1 }])
  assert.deepEqual(seen.at(-1), { tool: null, status: 'idle' }, 'backfill alone must not claim Claude Code')
  handle.stop()
})
