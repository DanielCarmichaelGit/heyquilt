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

// The changes section says who changed what.
const base = {
  room: 'r1',
  connected: true,
  fileCount: 3,
  me: { name: 'alice', tool: 'claude' },
  peers: [],
  claims: [],
  activity: [],
  chat: [],
  unread: 0
}

test('status lists each person\'s changed files with line counts', () => {
  const now = Date.now()
  const md = renderStatus({
    ...base,
    changes: [
      { name: 'bob', added: 12, removed: 3, edits: 4, fileCount: 2, ts: now, files: [{ path: 'src/a.js', added: 12, removed: 1, edits: 3, kind: 'edited', ts: now }, { path: 'old.txt', added: 0, removed: 2, edits: 1, kind: 'deleted', ts: now }] },
      { name: 'alice', added: 5, removed: 0, edits: 1, fileCount: 1, ts: now, files: [{ path: 'README.md', added: 5, removed: 0, edits: 1, kind: 'created', ts: now }] }
    ]
  })
  assert.match(md, /## Changes/)
  assert.match(md, /\*\*bob\*\*: 2 files, \+12 -3/)
  assert.match(md, /`src\/a\.js` \(\+12 -1\)/)
  assert.match(md, /`old\.txt` \(deleted\)/)
  assert.match(md, /you: 1 file, \+5 -0/)
  assert.match(md, /`README\.md` \(new, \+5\)/)
})

test('status says when nothing has changed yet', () => {
  const md = renderStatus({ ...base, changes: [] })
  assert.match(md, /## Changes\n_No changes yet\._/)
})

test('status shows a pull as one line and its files as their own group', () => {
  const now = Date.now()
  const md = renderStatus({
    ...base,
    activity: [{ by: 'bob', path: '', kind: 'pulled', detail: '45 commits from main · 269 files', ts: now }],
    changes: [{ name: 'bob', added: 0, removed: 0, edits: 0, fileCount: 0, ts: now, files: [], pulled: { added: 120, removed: 30, fileCount: 2, ts: now, files: [{ path: 'src/a.js', added: 100, removed: 30, kind: 'edited', ts: now }, { path: 'b.md', added: 20, removed: 0, kind: 'created', ts: now }] } }]
  })
  assert.match(md, /: bob pulled 45 commits from main · 269 files/)
  assert.doesNotMatch(md, /pulled ``/)
  assert.match(md, /\*\*bob\*\* pulled from git: 2 files, \+120 -30 \([^)]*\): `src\/a\.js` \(\+100 -30\), `b\.md` \(new, \+20\)/)
  assert.doesNotMatch(md, /\*\*bob\*\*: 0 files/, 'no empty line for own edits')
})
