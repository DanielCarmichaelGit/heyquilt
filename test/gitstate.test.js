import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitDir, headKey, headRef, gitRuns, askTwice, lastCallTimedOut, GIT_TIMEOUT_MS, STALE_LOCK_MS, busy, leftoverLock, lockStamp, indexStamp, classify, fileAt, filesAt, changedBetween, changesBetween, treeState, branchTip, watchGit } from '../src/gitstate.js'
import { sha1 } from '../src/fsutil.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-git-${n}-`))
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }

/** A repo with one commit on main holding a.txt and b.txt. */
function repo () {
  const dir = tmp('repo')
  git(dir, 'init', '-q', '-b', 'main')
  write(dir, 'a.txt', 'a1\na2\na3\n'); write(dir, 'b.txt', 'b1\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'one')
  return dir
}

test('no git: everything says so', async () => {
  const dir = tmp('plain')
  assert.equal(gitDir(dir), null)
  assert.equal(await headKey(dir), null)
  assert.equal(busy(dir), null)
  assert.equal(indexStamp(dir), null)
  assert.equal((await classify(dir, { changed: ['x'], before: null })).kind, 'edit')
})

test('head key: branch, detached, and a worktree', async () => {
  const dir = repo()
  const h = await headKey(dir)
  assert.equal(h.branch, 'main'); assert.equal(h.key, 'main'); assert.match(h.sha, /^[0-9a-f]{40}$/)
  git(dir, 'checkout', '-q', '--detach')
  assert.equal((await headKey(dir)).key, `@${h.sha.slice(0, 12)}`)
  git(dir, 'checkout', '-q', 'main')
  const wt = path.join(tmp('wt'), 'w')
  git(dir, 'worktree', 'add', '-q', wt, '-b', 'feature')
  assert.ok(gitDir(wt).includes('worktrees'))
  assert.equal((await headKey(wt)).key, 'feature')
})

test('busy markers', async () => {
  const dir = repo()
  assert.equal(busy(dir), null)
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '')
  assert.equal(busy(dir), 'index-lock')
  fs.rmSync(path.join(dir, '.git', 'index.lock'))
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'x')
  assert.equal(busy(dir), 'merge')
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'))
  fs.mkdirSync(path.join(dir, '.git', 'rebase-merge'))
  assert.equal(busy(dir), 'rebase')
})

test('an index.lock older than a minute, with nothing else under way, is a leftover; the file is left alone', async () => {
  const dir = repo()
  const lock = path.join(dir, '.git', 'index.lock')
  fs.writeFileSync(lock, '')
  assert.equal(await leftoverLock(dir), null, 'a fresh lock: git may be at work')
  const old = (Date.now() - STALE_LOCK_MS - 60000) / 1000
  fs.utimesSync(lock, old, old)
  const stamp = await leftoverLock(dir)
  assert.equal(stamp, lockStamp(dir))
  assert.equal(busy(dir), 'index-lock')
  assert.equal(busy(dir, undefined, stamp), null, 'not counted once known to be left behind')
  const before = await headKey(dir)
  write(dir, 'a.txt', 'edit\n')
  assert.equal((await classify(dir, { changed: ['a.txt'], before, leftover: stamp })).kind, 'edit')
  assert.equal((await classify(dir, { changed: ['a.txt'], before })).kind, 'busy')
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'x')
  assert.equal(await leftoverLock(dir), null, 'a merge under way too: not a leftover')
  assert.equal(busy(dir, undefined, stamp), 'merge')
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'))
  assert.equal(await withGit(path.join(tmp('nogit'), 'git'), () => leftoverLock(dir)), null, 'git can\'t run: not a leftover')
  fs.utimesSync(lock, new Date(), new Date())
  assert.equal(busy(dir, undefined, stamp), 'index-lock', 'a new lock is another stamp')
  assert.ok(fs.existsSync(lock), 'never deleted')
})

test('classify: edit, discard, advance, switch', async () => {
  const dir = repo()
  const before = await headKey(dir)
  write(dir, 'a.txt', 'a1\nEDIT\na3\n')
  assert.equal((await classify(dir, { changed: ['a.txt'], before })).kind, 'edit')
  git(dir, 'stash', '-q')
  const d = await classify(dir, { changed: ['a.txt'], before })
  assert.equal(d.kind, 'discard'); assert.equal(d.head.sha, before.sha)
  git(dir, 'stash', 'pop', '-q')
  git(dir, 'commit', '-qam', 'two')
  const a = await classify(dir, { changed: ['a.txt'], before })
  assert.equal(a.kind, 'advance'); assert.notEqual(a.head.sha, before.sha); assert.equal(a.prevHead.sha, before.sha)
  git(dir, 'checkout', '-qb', 'feature')
  assert.equal((await classify(dir, { changed: [], before: await headKey(dir) })).kind, 'edit', 'same key, nothing changed')
  const s = await classify(dir, { changed: ['a.txt'], before: a.head })
  assert.equal(s.kind, 'switch'); assert.equal(s.head.key, 'feature')
})

test('classify: busy wins, and a mix of clean and dirty paths is an edit', async () => {
  const dir = repo()
  const before = await headKey(dir)
  write(dir, 'a.txt', 'changed\n')
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'x')
  assert.equal((await classify(dir, { changed: ['a.txt'], before })).kind, 'busy')
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'))
  const mixed = await classify(dir, { changed: ['a.txt', 'b.txt'], before })
  assert.equal(mixed.kind, 'edit')
  assert.deepEqual(mixed.putBack, ['b.txt'], 'b.txt matches the commit: git may have put it back')
  // An untracked file in the same burst as a stash: an edit, with the stashed file put back.
  git(dir, 'stash', '-q'); write(dir, 'new.txt', 'scratch\n')
  const stash = await classify(dir, { changed: ['a.txt', 'new.txt'], before })
  assert.equal(stash.kind, 'edit')
  assert.deepEqual(stash.putBack, ['a.txt'])
})

test('a gone untracked file is put away only when git wrote the index: stash -u is a discard, git clean a deletion', async () => {
  const dir = repo()
  const before = await headKey(dir)
  const many = Array.from({ length: 25 }, (_, i) => `scratch/f${i}.txt`)
  for (const rel of many) write(dir, rel, 'untracked\n')
  const stamp = indexStamp(dir)
  git(dir, 'clean', '-fdq')
  assert.equal(indexStamp(dir), stamp, 'git clean leaves the index alone')
  const cleaned = await classify(dir, { changed: many, before, indexWrote: false })
  assert.equal(cleaned.kind, 'edit')
  assert.deepEqual(cleaned.putBack, [], 'deleted, not put back')
  for (const rel of many.slice(0, 3)) write(dir, rel, 'untracked\n')
  git(dir, 'stash', '-uq')
  assert.notEqual(indexStamp(dir), stamp, 'stash -u writes the index')
  assert.equal((await classify(dir, { changed: many.slice(0, 3), before, indexWrote: true })).kind, 'discard')
  // In a burst with an edit, the stashed-away files are still told apart from it.
  write(dir, 'a.txt', 'edited\n')
  const mixed = await classify(dir, { changed: ['a.txt', ...many.slice(0, 3)], before, indexWrote: true })
  assert.equal(mixed.kind, 'edit')
  assert.deepEqual(mixed.putBack, many.slice(0, 3))
  assert.deepEqual((await classify(dir, { changed: ['a.txt', ...many.slice(0, 3)], before })).putBack, [], 'no index write: deletions')
})

test('fileAt and changedBetween', async () => {
  const dir = repo()
  const one = (await headKey(dir)).sha
  write(dir, 'a.txt', 'a1\na2\na3\na4\n'); git(dir, 'commit', '-qam', 'two')
  const two = (await headKey(dir)).sha
  assert.equal(await fileAt(dir, one, 'a.txt'), 'a1\na2\na3\n')
  assert.equal(await fileAt(dir, one, 'nope.txt'), null)
  assert.deepEqual(await changedBetween(dir, one, two), ['a.txt'])
})

test('fileAt keys a binary as Quilt does, reads files over 1 MB, and filesAt reads many in one go', async () => {
  const dir = repo()
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0xff])
  const big = 'x'.repeat(1500 * 1024) + '\n'
  fs.writeFileSync(path.join(dir, 'img.png'), png); write(dir, 'big.txt', big); write(dir, 'sp ace.txt', 'with a space\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'more')
  const sha = (await headKey(dir)).sha
  assert.equal(await fileAt(dir, sha, 'img.png'), `bin:${sha1(png)}`)
  assert.equal(await fileAt(dir, sha, 'big.txt'), big)
  const many = await filesAt(dir, sha, ['a.txt', 'img.png', 'nope.txt', 'sp ace.txt', 'big.txt'])
  assert.deepEqual([...many.entries()].sort(), [['a.txt', 'a1\na2\na3\n'], ['big.txt', big], ['img.png', `bin:${sha1(png)}`], ['nope.txt', null], ['sp ace.txt', 'with a space\n']])
})

/** A git that runs, but fails any call with one of `failOn` in its arguments. */
function failingGit (...failOn) {
  const bin = path.join(tmp('fakegit'), 'git')
  fs.writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do case "$a" in ${failOn.map((f) => `'${f}'`).join('|')}) exit 1;; esac; done\nexec git "$@"\n`, { mode: 0o755 })
  return bin
}
const withGit = async (bin, fn) => { process.env.QUILT_GIT = bin; try { return await fn() } finally { delete process.env.QUILT_GIT } }

/** A git that runs, but never answers a call with `slowOn` in its arguments (stopped at GIT_TIMEOUT_MS). */
function slowGit (slowOn) {
  const bin = path.join(tmp('slowgit'), 'git')
  fs.writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do case "$a" in '${slowOn}') exec sleep 30;; esac; done\nexec git "$@"\n`, { mode: 0o755 })
  return bin
}

test('a git call that times out says so, and is not asked again; one that fails is', async () => {
  const dir = repo()
  const sha = (await headKey(dir)).sha
  let asked = 0
  const started = Date.now()
  const r = await withGit(slowGit('diff'), () => askTwice(dir, () => { asked++; return changesBetween(dir, sha, sha) }))
  assert.equal(r, null)
  assert.equal(lastCallTimedOut(dir), true)
  assert.equal(asked, 1, 'a timeout is not retried')
  assert.ok(Date.now() - started < GIT_TIMEOUT_MS * 2 - 500, 'one timeout, not two')
  asked = 0
  assert.equal(await withGit(failingGit('diff'), () => askTwice(dir, () => { asked++; return changesBetween(dir, sha, sha) })), null)
  assert.equal(lastCallTimedOut(dir), false)
  assert.equal(asked, 2, 'a failure is asked once more')
  assert.deepEqual([...await askTwice(dir, () => changesBetween(dir, sha, sha))], [])
})

test('filesAt never reads a filtered path or an LFS pointer, and a failed read leaves files unread, not the call', async () => {
  const dir = repo()
  write(dir, '.gitattributes', '*.lfs filter=lfs\n')
  write(dir, 'pic.lfs', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9999999999\n')
  write(dir, 'loose.dat', 'version https://git-lfs.github.com/spec/v1\noid sha256:def\nsize 1\n') // a pointer with no filter set
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'lfs')
  git(dir, 'config', 'filter.lfs.smudge', 'false'); git(dir, 'config', 'filter.lfs.required', 'true') // running it would fail
  const sha = (await headKey(dir)).sha
  const got = await filesAt(dir, sha, ['pic.lfs', 'loose.dat', 'a.txt'])
  assert.equal(got.get('pic.lfs'), undefined); assert.ok(got.has('pic.lfs'))
  assert.equal(got.get('loose.dat'), undefined)
  assert.equal(got.get('a.txt'), 'a1\na2\na3\n')
  assert.equal(got.failed, 0)
  const failed = await withGit(failingGit('--filters'), () => filesAt(dir, sha, ['a.txt', 'b.txt']))
  assert.deepEqual([...failed.entries()], [['a.txt', undefined], ['b.txt', undefined]])
  assert.equal(failed.failed, 2)
  assert.equal(await withGit(path.join(tmp('nogit'), 'git'), () => filesAt(dir, sha, ['a.txt'])), null, 'no git at all: null')
})

test('gitRuns tells git missing from a call failing; headRef names an unborn branch; classify holds when status fails', async () => {
  const dir = repo()
  assert.equal(await gitRuns(dir), true)
  assert.equal(await withGit(path.join(tmp('nogit'), 'git'), () => gitRuns(dir)), false)
  assert.equal(await withGit(failingGit('status'), () => gitRuns(dir)), true)
  const before = await headKey(dir)
  write(dir, 'a.txt', 'x\n'); git(dir, 'checkout', '-q', '--', 'a.txt')
  assert.equal(await withGit(failingGit('status'), async () => (await classify(dir, { changed: ['a.txt'], before })).kind), 'busy')
  assert.equal(headRef(dir), 'main')
  git(dir, 'checkout', '-q', '--orphan', 'fresh')
  assert.equal(await headKey(dir), null)
  assert.equal(headRef(dir), 'fresh')
  git(dir, 'checkout', '-q', '--detach', before.sha)
  assert.equal(headRef(dir), null)
  assert.equal(headRef(tmp('plain')), null)
})

test('changesBetween gives each path\'s status; treeState says what is dirty and what is tracked', async () => {
  const dir = repo()
  const one = (await headKey(dir)).sha
  write(dir, 'c.txt', 'c\n'); write(dir, 'a.txt', 'changed\n'); git(dir, 'rm', '-q', 'b.txt'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'two')
  assert.deepEqual([...await changesBetween(dir, one, (await headKey(dir)).sha)].sort(), [['a.txt', 'M'], ['b.txt', 'D'], ['c.txt', 'A']])
  write(dir, 'a.txt', 'dirty\n'); write(dir, 'new.txt', 'untracked\n'); write(dir, '*.txt', 'a glob-looking name\n')
  const st = await treeState(dir, ['a.txt', 'c.txt', 'new.txt', 'gone.txt', '*.txt'])
  assert.deepEqual([...st.dirty].sort(), ['*.txt', 'a.txt', 'new.txt'])
  assert.deepEqual([...st.tracked].sort(), ['a.txt', 'c.txt'])
  const all = await treeState(dir, Array.from({ length: 300 }, (_, i) => `f${i}`)) // past the pathspec limit: the whole tree
  assert.ok(all.dirty.has('a.txt') && all.tracked.has('c.txt'))
})

test('branchTip: where a branch points, even while HEAD is elsewhere', async () => {
  const dir = repo()
  const one = (await headKey(dir)).sha
  assert.equal(await branchTip(dir, 'main'), one)
  git(dir, 'checkout', '-q', '--detach')
  write(dir, 'a.txt', 'x\n'); git(dir, 'commit', '-qam', 'detached')
  assert.equal(await branchTip(dir, 'main'), one, 'the branch did not move')
  assert.equal(await branchTip(dir, 'nope'), null)
  assert.equal(await branchTip(tmp('plain'), 'main'), null)
})

test('indexStamp changes when git touches the index, not when a file is edited', async () => {
  const dir = repo()
  const s0 = indexStamp(dir)
  write(dir, 'a.txt', 'x\n')
  assert.equal(indexStamp(dir), s0)
  git(dir, 'add', 'a.txt')
  assert.notEqual(indexStamp(dir), s0)
})

test('headKey and classify when git itself is unreachable: not advance, just not git', async () => {
  const dir = repo()
  const before = await headKey(dir)
  const prevGit = process.env.QUILT_GIT
  process.env.QUILT_GIT = path.join(tmp('no-git'), 'missing-git-binary')
  try {
    assert.equal(await headKey(dir), null)
    assert.equal((await classify(dir, { changed: ['a.txt'], before })).kind, 'edit')
  } finally {
    if (prevGit === undefined) delete process.env.QUILT_GIT
    else process.env.QUILT_GIT = prevGit
  }
})

test('headKey on an unborn branch (fresh init, no commits) is null', async () => {
  const dir = tmp('unborn')
  git(dir, 'init', '-q', '-b', 'main')
  assert.equal(await headKey(dir), null)
})

test('watchGit reports head, busy and idle', async () => {
  const dir = repo()
  const seen = []
  const w = watchGit(dir, (e) => seen.push(e.type))
  await new Promise((r) => setTimeout(r, 300))
  git(dir, 'checkout', '-qb', 'feature')
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'x')
  await new Promise((r) => setTimeout(r, 400))
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'))
  await new Promise((r) => setTimeout(r, 400))
  await w.close()
  assert.ok(seen.includes('head'), `head seen: ${seen}`)
  assert.ok(seen.includes('busy') && seen.includes('idle'), `busy/idle seen: ${seen}`)
})
