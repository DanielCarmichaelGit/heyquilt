// renderStatus: the "Merges to settle" section must say when the offline
// side deleted a file, or when the session side deleted it, not just
// "changed it" either way (an agent could otherwise write merged content
// for a file that should stay deleted).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderStatus } from '../src/status.js'

const baseStatus = (merges) => ({
  room: 'pair',
  connected: true,
  fileCount: 1,
  me: { name: 'helper', tool: 'Claude Code', focus: null },
  peers: [],
  claims: [],
  merges,
  activity: [],
  chat: [],
  unread: 0
})

test('renderStatus marks an offline deletion as a deletion, not a change', () => {
  const md = renderStatus(baseStatus([
    { id: 'abc123', path: 'src/gone.js', by: 'dana', others: ['helper'], kind: 'conflict', state: 'open', oursDeleted: true, theirsHash: 'y' }
  ]))
  assert.match(md, /## Merges to settle/)
  assert.match(md, /dana deleted it offline, you changed it in the session/)
  assert.doesNotMatch(md, /dana changed it offline/)
})

test('renderStatus marks a session-side deletion distinctly from an ordinary conflict', () => {
  const md = renderStatus(baseStatus([
    { id: 'def456', path: 'src/also-gone.js', by: 'dana', others: ['someone-else'], kind: 'conflict', state: 'open', oursDeleted: false, theirsHash: null }
  ]))
  assert.match(md, /dana changed it offline, it was deleted in the session/)
})

test('a session in a workspace says so in STATUS.md', () => {
  const text = renderStatus({ ...baseStatus(), workspace: 'ws-1', workspaceName: 'Launch' })
  assert.match(text, /Workspace: Launch/)
})

test('a session in a workspace with no known name falls back to the id', () => {
  const text = renderStatus({ ...baseStatus(), workspace: 'ws-1' })
  assert.match(text, /Workspace: ws-1/)
})

test('a session in no workspace prints no Workspace line', () => {
  const text = renderStatus(baseStatus())
  assert.doesNotMatch(text, /Workspace:/)
})
