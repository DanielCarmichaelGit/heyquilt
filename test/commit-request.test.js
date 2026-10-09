// A commit request committed in a person's folder (commit.js): exactly its files, nothing else
// that is uncommitted or staged there; and who made each uncommitted change, for the app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { commitFiles, uncommitted, cleanFiles, editorsSince, uncommittedByPerson, requestWarning, commitMessage, describeCommitRequests, REQUEST_SETTLE_MS } from '../src/commit.js'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV }).trim()
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }

function repo () {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cr-bare-'))
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cr-'))
  git(dir, 'clone', '-q', bare, '.')
  for (const f of ['a.txt', 'b.txt', 'c.txt']) write(dir, f, `${f}\n`)
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'one'); git(dir, 'push', '-q', '-u', 'origin', 'main')
  return { bare, dir }
}

test('commits exactly the asked files (changed, new, deleted), leaves the rest as it was, and pushes', async () => {
  const { bare, dir } = repo()
  write(dir, 'a.txt', 'A\n'); fs.rmSync(path.join(dir, 'b.txt')); write(dir, 'new/n.txt', 'n\n')
  write(dir, 'c.txt', 'someone else\'s unfinished work\n')
  write(dir, 'staged.txt', 's\n'); git(dir, 'add', 'staged.txt')
  assert.deepEqual([...(await uncommitted(dir)).entries()].sort(), [['a.txt', 'M'], ['b.txt', 'D'], ['c.txt', 'M'], ['new/n.txt', 'A'], ['staged.txt', 'A']])
  const r = await commitFiles(dir, { files: ['a.txt', 'b.txt', 'new/n.txt', 'not-there.txt'], message: 'Mine', upstream: { remote: 'origin', name: 'origin/main' }, branch: 'main' })
  assert.deepEqual([r.files, r.pushed, r.pushError], [['a.txt', 'b.txt', 'new/n.txt'], true, null])
  assert.equal(git(bare, 'rev-parse', 'main'), r.hash)
  assert.deepEqual(git(dir, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort(), ['A\tnew/n.txt', 'D\tb.txt', 'M\ta.txt'])
  assert.equal(git(dir, 'status', '--porcelain'), 'M c.txt\nA  staged.txt', 'the rest is as it was, staged included (the first line\'s leading space is trimmed)')
  assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'someone else\'s unfinished work\n')
  const again = await commitFiles(dir, { files: ['a.txt'], message: 'x' })
  assert.ok(again.nothing)
})

test('a refused push is said in plain words; a failing hook leaves nothing half-done', async () => {
  const { bare, dir } = repo()
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cr-o-'))
  git(other, 'clone', '-q', bare, '.'); write(other, 'c.txt', 'theirs\n'); git(other, 'commit', '-qam', 'theirs'); git(other, 'push', '-q')
  write(dir, 'a.txt', 'A\n')
  const r = await commitFiles(dir, { files: ['a.txt'], message: 'Mine', upstream: { remote: 'origin', name: 'origin/main' }, branch: 'main' })
  assert.equal(r.pushed, false)
  assert.match(r.pushError, /has commits this folder doesn't have yet/)
  write(dir, 'n2.txt', 'n\n')
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho no >&2\nexit 1\n', { mode: 0o755 })
  if (process.platform !== 'win32') {
    await assert.rejects(commitFiles(dir, { files: ['n2.txt'], message: 'x', push: false }), /git commit failed/)
    assert.match(git(dir, 'status', '--porcelain'), /\?\? n2\.txt/, 'the new file is untracked again')
  }
})

test('who made each uncommitted change, grouped; what a person should know before committing a request', () => {
  assert.deepEqual(cleanFiles(['./a.js', 'a.js', '../x', '.git/config', '.quilt/state.json', 'b\\c.js']), ['a.js', 'b/c.js'])
  const history = [
    { path: 'a.js', by: 'Duncan', ts: 10 }, { path: 'a.js', by: 'Brandon', ts: 20 }, { path: 'a.js', by: 'Duncan', ts: 30 },
    { path: 'b.js', by: 'Duncan', ts: 5 }, { path: 'c.js', by: 'git', ts: 40, pulled: true }, { path: 'd.js', by: 'Ivy', ts: 1 }
  ]
  const editors = editorsSince(['a.js', 'b.js', 'c.js', 'd.js'], history, new Map([['b.js', 7], ['d.js', 2]]))
  assert.deepEqual(Object.fromEntries(editors), { 'a.js': ['Brandon', 'Duncan'], 'b.js': [], 'c.js': [], 'd.js': [] })
  assert.deepEqual(uncommittedByPerson(editors), [{ by: '', files: ['b.js', 'c.js', 'd.js'] }, { by: 'Brandon', files: ['a.js'] }, { by: 'Duncan', files: ['a.js'] }])
  const r = { by: 'Duncan', ts: 0 }
  const now = REQUEST_SETTLE_MS + 1
  assert.equal(requestWarning(r, { editors: new Map([['a.js', ['Brandon', 'Duncan']]]), now }), 'a.js also has uncommitted changes by Brandon')
  assert.equal(requestWarning(r, { editors: new Map([['a.js', ['Duncan']]]), claims: [{ by: 'Ivy', pattern: 'a.*' }], now }), 'Ivy holds a.js')
  assert.equal(requestWarning(r, { editors: new Map([['a.js', ['Duncan']]]), markers: new Set(['a.js']), now }), 'a.js has conflict markers')
  assert.equal(requestWarning(r, { editors: new Map([['a.js', ['Duncan']]]), now }), '')
  assert.equal(commitMessage({ message: 'Blog covers\nwith OG images', by: 'Duncan', task: { id: 't1', title: 'Blog' } }), 'Blog covers\n\nwith OG images\n\nAsked for by Duncan in Quilt (task t1: Blog).')
  assert.match(describeCommitRequests({ open: [{ id: 'r1', by: 'Duncan', message: 'Covers', files: ['a', 'b'] }], recent: [{ hash: 'abcdef12', message: 'Old', by: 'Sri', pushed: false, pushError: 'no network' }] }),
    /\[r1\] Duncan: Covers \(2 files: a, b\)[\s\S]*abcdef1 Old \(Sri; not pushed: no network\)/)
})
