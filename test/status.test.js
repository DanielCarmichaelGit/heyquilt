// The Markdown status every tool reads: the changes section says who changed what.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderStatus } from '../src/status.js'

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
