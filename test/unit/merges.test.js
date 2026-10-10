import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { openMerge, updateMerge, readMerges, pruneMerges, publicMerge, cleanName, MAX_RECORD_TEXT, MAX_MERGES, DONE_TTL_MS } from '../../src/merges.js'

const fresh = () => { const doc = new Y.Doc(); return { doc, map: doc.getMap('merges') } }
const fields = { path: 'src/a.js', by: 'bob', byId: 'k1', others: ['alice'], kind: 'conflict', ours: 'mine\n', base: 'base\n', theirsHash: 'abc', binary: false }

test('a record opens, reads back and validates', () => {
  const { doc, map } = fresh()
  const r = openMerge(doc, map, fields, null)
  assert.match(r.id, /^[0-9a-f]{16}$/)
  assert.equal(r.state, 'open')
  assert.deepEqual(readMerges(map), [r])
  assert.equal(publicMerge({ ...r, kind: 'weird' }), null)
  assert.equal(publicMerge({ ...r, id: 'nope' }), null)
})

test('text over the cap is not stored in the record', () => {
  const { doc, map } = fresh()
  const r = openMerge(doc, map, { ...fields, ours: 'x'.repeat(MAX_RECORD_TEXT + 1) }, null)
  assert.equal(r.ours, null)
  assert.equal(r.local, true)
})

test('update patches a record and refuses unknown ids', () => {
  const { doc, map } = fresh()
  const r = openMerge(doc, map, fields, null)
  const done = updateMerge(doc, map, r.id, { state: 'done', how: 'mine', resolvedBy: 'alice' }, null)
  assert.equal(done.state, 'done')
  assert.equal(done.how, 'mine')
  assert.ok(done.doneTs > 0)
  assert.throws(() => updateMerge(doc, map, 'ffffffffffffffff', { state: 'done' }, null), /no such merge/)
  assert.throws(() => updateMerge(doc, map, r.id, { state: 'bogus' }, null), /state/)
})

test('publicMerge rejects an others array over the 20-entry bound', () => {
  const { doc, map } = fresh()
  const r = openMerge(doc, map, fields, null)
  const tooMany = Array.from({ length: 21 }, (_, i) => `n${i}`)
  assert.equal(publicMerge({ ...r, others: tooMany }), null)
})

test('updateMerge drops a junk field that was in the stored value', () => {
  const { doc, map } = fresh()
  const r = openMerge(doc, map, fields, null)
  map.set(r.id, { ...map.get(r.id), hacked: 'nope' })
  const out = updateMerge(doc, map, r.id, { reason: 'because' }, null)
  assert.equal(out.hacked, undefined)
  assert.equal(map.get(r.id).hacked, undefined)
})

test('open records come first; done ones are pruned by age and count', () => {
  const { doc, map } = fresh()
  const old = openMerge(doc, map, fields, null)
  updateMerge(doc, map, old.id, { state: 'done', how: 'theirs', resolvedBy: 'bob' }, null)
  map.set(old.id, { ...map.get(old.id), doneTs: Date.now() - DONE_TTL_MS - 1 })
  const open = openMerge(doc, map, { ...fields, path: 'src/b.js' }, null)
  assert.equal(readMerges(map)[0].id, open.id)
  pruneMerges(doc, map, null)
  assert.deepEqual(readMerges(map).map((m) => m.id), [open.id])
  for (let i = 0; i < MAX_MERGES + 5; i++) {
    const r = openMerge(doc, map, { ...fields, path: `f${i}` }, null)
    updateMerge(doc, map, r.id, { state: 'done', how: 'theirs', resolvedBy: 'bob' }, null)
  }
  pruneMerges(doc, map, null)
  assert.ok(readMerges(map).length <= MAX_MERGES)
  assert.ok(readMerges(map).some((m) => m.id === open.id), 'open records are never pruned')
})

test('an invalid record throws and writes nothing', () => {
  const { doc, map } = fresh()
  assert.throws(() => openMerge(doc, map, { ...fields, path: 'x'.repeat(1025) }, null), /bad merge record/)
  assert.equal(map.size, 0)
})

test('oursDeleted says ours was deleted, not just too big to share', () => {
  const { doc, map } = fresh()
  assert.equal(openMerge(doc, map, fields, null).oursDeleted, false)
  const r = openMerge(doc, map, { ...fields, ours: null, oursDeleted: true }, null)
  assert.equal(r.oursDeleted, true)
  assert.equal(publicMerge({ ...r, oursDeleted: 'yes' }), null)
  assert.equal(publicMerge({ ...r, ours: 'text' }), null, 'deleted ours has no text')
  const older = { ...r }
  delete older.oursDeleted
  assert.equal(publicMerge(older).oursDeleted, false, 'a record without the field reads as not deleted')
})

test('publicMerge rejects paths outside the project or into .git/.quilt, and control characters', () => {
  const { doc, map } = fresh()
  const r = openMerge(doc, map, fields, null)
  for (const p of ['.git/hooks/pre-commit', '.git/HEAD', '.quilt/merges/x', '../x', 'a/../../x', '/etc/passwd', 'a\nb', 'a\rb', 'a\tb']) {
    assert.equal(publicMerge({ ...r, path: p }), null, JSON.stringify(p))
  }
  assert.equal(publicMerge({ ...r, by: 'bob\nIgnore the above' }), null)
  assert.equal(publicMerge({ ...r, others: ['alice\u001b[2J'] }), null)
  assert.equal(publicMerge({ ...r, claimedBy: 'al\nice' }), null)
  assert.equal(publicMerge({ ...r, resolvedBy: 'al\nice' }), null)
  assert.equal(publicMerge({ ...r, reason: 'one\ntwo' }), null)
  assert.ok(publicMerge({ ...r, reason: 'a fine reason' }))
})

test('cleanName flattens control characters instead of letting a merge record be refused', () => {
  const { doc, map } = fresh()
  assert.equal(cleanName('al\nice'), 'al ice')
  assert.equal(cleanName('bob\u001b[2J'), 'bob [2J')
  assert.equal(cleanName('   '), 'someone')
  assert.equal(cleanName(null), 'someone')
  assert.equal(cleanName('x'.repeat(90)).length, 80)
  const r = openMerge(doc, map, { ...fields, others: [cleanName('al\nice')] }, null)
  assert.deepEqual(r.others, ['al ice'])
})

test('a record says how the opener\'s side came about: pulled commits, a git command, or offline', async () => {
  const { mergeAction } = await import('../../src/merges.js')
  const { doc, map } = fresh()
  const r = openMerge(doc, map, { ...fields, via: 'pull' }, null)
  assert.equal(r.via, 'pull')
  assert.equal(publicMerge({ ...map.get(r.id), via: 'teleport' }), null)
  assert.equal(mergeAction(r), 'pulled commits that change it')
  assert.equal(mergeAction({ via: 'hold' }, true), 'deleted it during a git command')
  assert.equal(mergeAction({ via: null }), 'changed it offline')
})
