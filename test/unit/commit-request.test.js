// quilt_request_commit: the request (files and a description) and the message that tells the owner.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanCommitFiles, ownerName, makeCommitRequest, commitRequestText, commitRequestMessage, commitRequestNote, MAX_COMMIT_FILES } from '../../src/commit-request.js'
import { scanInbox, describeEvent } from '../../src/inbox.js'
import { waitingOn, unanswered } from '../../src/duties.js'

test('the files an agent lists are cleaned: relative, no duplicates, nothing outside the project', () => {
  assert.deepEqual(cleanCommitFiles(undefined), [])
  assert.deepEqual(cleanCommitFiles(['./src/a.js', 'src\\b.js', 'src/a.js', ' ', 'docs/']), ['src/a.js', 'src/b.js', 'docs'])
  assert.throws(() => cleanCommitFiles(['../etc/passwd']), /not a path in the project/)
  assert.throws(() => cleanCommitFiles(['/abs/path']), /not a path in the project/)
  assert.throws(() => cleanCommitFiles(['.quilt/daemon.json']), /not a path in the project/)
  assert.throws(() => cleanCommitFiles('src/a.js'), /list of paths/)
  assert.throws(() => cleanCommitFiles(Array.from({ length: MAX_COMMIT_FILES + 1 }, (_, i) => `f${i}.js`)), /at most 100 files/)
})

test('a request carries the message, the description and the files; an empty message is refused', () => {
  const r = makeCommitRequest({ id: 'abc123abc123', by: 'Duncan', message: '  Blog page  ', description: 'Adds /blog.', files: ['web/app/blog/page.js'], branch: 'main', ts: 5 })
  assert.deepEqual(r, { id: 'abc123abc123', by: 'Duncan', message: 'Blog page', description: 'Adds /blog.', files: ['web/app/blog/page.js'], branch: 'main', ts: 5, state: 'open' })
  const bare = makeCommitRequest({ id: 'x', by: 'D', message: 'm', ts: 1 })
  assert.equal('files' in bare, false)
  assert.equal('description' in bare, false)
  assert.throws(() => makeCommitRequest({ id: 'x', by: 'D', message: '  ' }), /say what the commit is for/)
})

test('the owner is told who wants a commit, what for, which files, and how to settle it; never themselves', () => {
  assert.equal(ownerName([{ name: 'Sam', role: 'editor' }, { name: 'Daniel Carmichael', role: 'owner' }]), 'Daniel Carmichael')
  assert.equal(ownerName([]), '')
  const r = makeCommitRequest({ id: 'abc123abc123', by: 'Duncan', message: 'Blog page.', description: 'Adds /blog\nand the nav link.', files: ['a.js', 'b.js'], branch: 'main', ts: 7 })
  const t = commitRequestText(r)
  assert.equal(t, '📌 Commit requested (abc123abc123): Blog page. Adds /blog and the nav link. Files (2): a.js, b.js. Commit with git when it is a good moment (quilt_commit_status), then mark it done with quilt_commit_request_done.')
  assert.ok(!t.includes('\u2014'), 'no em dashes')
  assert.match(commitRequestText({ ...r, branch: 'feature' }), /^📌 Commit requested on `feature`/)
  const many = commitRequestText({ ...r, files: Array.from({ length: 25 }, (_, i) => `f${i}`) })
  assert.match(many, /Files \(25\): f0, .*f19, and 5 more\./)
  const m = commitRequestMessage(r, { owner: 'Daniel Carmichael', id: 'feedfeedfeedfeed' })
  assert.deepEqual(m, { id: 'feedfeedfeedfeed', by: 'Duncan', to: 'Daniel Carmichael', text: t, ts: 7, kind: 'commit', commit: 'abc123abc123' })
  assert.ok(commitRequestNote(m))
  assert.equal(commitRequestMessage(r, { owner: 'Duncan', id: 'x' }), null, 'the owner asking tells nobody')
  assert.equal(commitRequestMessage(r, { owner: '', id: 'x' }), null, 'no owner, nobody to tell')
})
