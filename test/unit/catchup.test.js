// "While you were away": the changes others made between a stop and a rejoin,
// worked out from the shared history alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { historyMarks, awayChanges, mergeCatchUp, emptyCatchUp, catchUpMarkdown } from '../../src/catchup.js'
import { renderStatus } from '../../src/status.js'

const e = (id, by, path, kind, ts, added = 1, removed = 0, extra = {}) => ({ id, by, path, kind, ts, added, removed, ...extra })

test('awayChanges lists only entries the saved doc had not seen, by others, grouped by person', () => {
  const before = [e('a', 'bob', 'x.js', 'edited', 1)]
  const marks = historyMarks(before)
  const now = [
    ...before,
    e('b', 'bob', 'y.js', 'created', 5, 3),
    e('c', 'bob', 'y.js', 'edited', 6, 2, 1),
    e('d', 'carol', 'z.js', 'edited', 7, 4, 4),
    e('m', 'me', 'mine.js', 'edited', 8)
  ]
  const { people, partial } = awayChanges(now, marks, 'me')
  assert.equal(partial, false)
  assert.deepEqual(people.map((p) => p.name), ['carol', 'bob'], 'newest first, never me')
  const bob = people[1]
  assert.deepEqual(bob.files, [{ path: 'y.js', kind: 'created', added: 5, removed: 1, ts: 6 }], 'created then edited is still new')
  assert.equal(bob.added, 5)
})

test('a folded entry (same id, later ts) counts as new; a file deleted last is deleted', () => {
  const marks = historyMarks([e('a', 'bob', 'x.js', 'edited', 1)])
  const { people } = awayChanges([e('a', 'bob', 'x.js', 'edited', 9, 7), e('b', 'bob', 'x.js', 'deleted', 10, 0, 0)], marks, 'me')
  assert.equal(people[0].files[0].kind, 'deleted')
  assert.equal(people[0].files[0].added, 7)
})

test('partial when the history no longer reaches where we left off', () => {
  const marks = historyMarks([e('old', 'bob', 'x.js', 'edited', 1)])
  assert.equal(awayChanges([e('n', 'bob', 'x.js', 'edited', 9)], marks, 'me').partial, true)
  assert.equal(awayChanges([e('n', 'bob', 'x.js', 'edited', 9)], new Map(), 'me').partial, false)
})

test('mergeCatchUp adds a second absence to one not yet dismissed', () => {
  const one = { at: 1, since: 100, people: [{ name: 'bob', added: 1, removed: 0, ts: 5, fileCount: 1, files: [{ path: 'a', kind: 'edited', added: 1, removed: 0, ts: 5 }] }], backups: [{ path: 'r', copy: '.quilt/conflicts/1/r' }], mine: { shared: 1, merged: ['m'], conflicts: [] } }
  const two = { at: 2, since: 200, people: [{ name: 'bob', added: 2, removed: 1, ts: 9, fileCount: 2, files: [{ path: 'a', kind: 'edited', added: 2, removed: 1, ts: 9 }, { path: 'b', kind: 'created', added: 3, removed: 0, ts: 8 }] }], backups: [], mine: { shared: 2, merged: ['m'], conflicts: ['c'] } }
  const c = mergeCatchUp(one, two)
  assert.equal(c.since, 100, 'since the first time we left')
  assert.equal(c.people[0].added, 3)
  assert.equal(c.people[0].fileCount, 2)
  assert.deepEqual(c.people[0].files.map((f) => [f.path, f.added]), [['a', 3], ['b', 3]])
  assert.deepEqual(c.mine, { shared: 3, merged: ['m'], conflicts: ['c'] })
  assert.equal(c.backups.length, 1)
})

test('quilt_status shows the catch-up first, for every tool', () => {
  const c = { at: 1, since: Date.now() - 3 * 3600e3, people: [{ name: 'bob', added: 4, removed: 1, ts: 1, fileCount: 1, files: [{ path: 'src/a.js', kind: 'edited', added: 4, removed: 1, ts: 1 }] }], backups: [{ path: 'README.md', copy: '.quilt/conflicts/1/README.md' }], mine: { shared: 0, merged: [], conflicts: ['same.txt'] } }
  assert.equal(emptyCatchUp(c), false)
  assert.equal(emptyCatchUp({ people: [], backups: [], mine: {} }), true)
  const md = catchUpMarkdown(c, { ago: () => '3h ago' }).join('\n')
  assert.match(md, /## While you were away \(you left 3h ago\)/)
  assert.match(md, /\*\*bob\*\* changed 1 file, \+4 -1: `src\/a\.js` \(\+4 -1\)/)
  assert.match(md, /`same\.txt`/)
  assert.match(md, /`README\.md` → `\.quilt\/conflicts\/1\/README\.md`/)
  const st = { room: 'r', connected: true, fileCount: 1, me: { name: 'me', tool: 'x' }, peers: [], tasks: [], claims: [], activity: [], chat: [], catchUp: c }
  const out = renderStatus(st)
  assert.ok(out.indexOf('While you were away') < out.indexOf('Partners online'))
  assert.doesNotMatch(renderStatus({ ...st, catchUp: null }), /While you were away/)
})
