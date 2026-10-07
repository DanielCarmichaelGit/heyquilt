// The switch's git commands, against real repositories: park keeps the work in
// refs/quilt/parked/<branch> (index, tree and stash untouched), clear puts paths
// back to HEAD, switchTo finds a branch locally or on the remote, or starts it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { park, parkedRef, clear, switchTo, startBranch, localBranches, busyRefusal } from '../src/gitswitch.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-gs-${n}-`))
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }

/** A bare remote with main (app.js, README.md) and `pushed` (adds pushed.txt), and a clone of it on main. */
function repo () {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = tmp('seed'); git(seed, 'clone', '-q', bare, '.')
  write(seed, 'app.js', 'one\n'); write(seed, 'README.md', 'hello\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  git(seed, 'checkout', '-qb', 'pushed'); write(seed, 'pushed.txt', 'p\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'p'); git(seed, 'push', '-q', 'origin', 'pushed')
  const dir = tmp('clone'); git(dir, 'clone', '-q', bare, '.')
  return { bare, dir, base: git(dir, 'rev-parse', 'HEAD') }
}

test('park keeps tracked and untracked work in a ref, leaving the index, the tree and the stash alone', async () => {
  const { dir } = repo()
  write(dir, 'app.js', 'changed\n'); write(dir, 'new.txt', 'untracked\n'); git(dir, 'add', 'app.js')
  const status = git(dir, 'status', '--porcelain')
  const sha = await park(dir, 'main')
  assert.match(sha, /^[0-9a-f]{40}$/)
  assert.equal(git(dir, 'rev-parse', parkedRef('main')), sha)
  assert.equal(git(dir, 'show', `${sha}:app.js`), 'changed')
  assert.equal(git(dir, 'show', `${sha}:new.txt`), 'untracked')
  assert.equal(git(dir, 'rev-parse', `${sha}^`), git(dir, 'rev-parse', 'HEAD'))
  assert.equal(git(dir, 'status', '--porcelain'), status, 'the index and the tree are as they were')
  assert.equal(git(dir, 'stash', 'list'), '')
  write(dir, 'app.js', 'again\n')
  const next = await park(dir, 'main')
  assert.equal(git(dir, 'rev-parse', parkedRef('main')), next, 'replaced on the next park of the same branch')
})

test('park on a clean tree keeps nothing', async () => {
  const { dir } = repo()
  assert.equal(await park(dir, 'main'), null)
  assert.throws(() => git(dir, 'rev-parse', '--verify', '-q', parkedRef('main')))
})

test('park throws when git can\'t write', async () => {
  const dir = tmp('notrepo')
  write(dir, 'x.txt', 'x\n')
  await assert.rejects(park(dir, 'main'))
})

test('clear puts paths back to HEAD: changes restored, files HEAD has not got removed', async () => {
  const { dir } = repo()
  write(dir, 'app.js', 'changed\n'); write(dir, 'new.txt', 'n\n'); write(dir, 'sub/staged.txt', 's\n'); git(dir, 'add', 'sub/staged.txt')
  write(dir, 'other.txt', 'not the session\'s\n')
  fs.rmSync(path.join(dir, 'README.md'))
  const r = await clear(dir, ['app.js', 'new.txt', 'sub/staged.txt', 'README.md'])
  assert.deepEqual(r, { restored: 2, removed: 2 })
  assert.equal(read(dir, 'app.js'), 'one\n')
  assert.equal(read(dir, 'README.md'), 'hello\n')
  assert.equal(read(dir, 'new.txt'), null)
  assert.equal(read(dir, 'sub/staged.txt'), null)
  assert.equal(fs.existsSync(path.join(dir, 'sub')), false, 'a folder left empty goes too')
  assert.equal(read(dir, 'other.txt'), 'not the session\'s\n', 'paths it was not given stay')
  assert.equal(git(dir, 'status', '--porcelain'), '?? other.txt')
})

test('switchTo: a local branch, then one only the remote has (fetched and tracked)', async () => {
  const { dir } = repo()
  git(dir, 'branch', 'local-one')
  assert.deepEqual(await switchTo(dir, 'local-one'), { how: 'local' })
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'local-one')
  git(dir, 'checkout', '-q', 'main')
  git(dir, 'branch', '-rd', 'origin/pushed') // as if never fetched
  assert.deepEqual(await switchTo(dir, 'pushed'), { how: 'remote' })
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/pushed')
  assert.equal(read(dir, 'pushed.txt'), 'p\n')
})

test('switchTo: a branch nowhere in git starts from base when this repo has it, else from HEAD', async () => {
  const { dir, base } = repo()
  write(dir, 'later.txt', 'l\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'later')
  assert.deepEqual(await switchTo(dir, 'spike', { base }), { how: 'created', from: base })
  assert.equal(git(dir, 'rev-parse', 'HEAD'), base)
  git(dir, 'checkout', '-q', 'main')
  const head = git(dir, 'rev-parse', 'HEAD')
  assert.deepEqual(await switchTo(dir, 'spike2', { base: 'f'.repeat(40) }), { how: 'created', from: null })
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head)
})

test('switchTo says what git said when it refuses; startBranch carries the work; the repo\'s branches are listed', async () => {
  const { dir } = repo()
  const other = tmp('wt'); git(dir, 'worktree', 'add', '-q', other, '-b', 'taken')
  await assert.rejects(switchTo(dir, 'taken'), /taken/)
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  write(dir, 'app.js', 'wip\n')
  assert.equal(await startBranch(dir, 'try-it'), 'try-it')
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'try-it')
  assert.equal(read(dir, 'app.js'), 'wip\n')
  await assert.rejects(startBranch(dir, 'bad..name'), /isn't a valid branch name/)
  assert.deepEqual((await localBranches(dir)).sort(), ['main', 'taken', 'try-it'])
  assert.equal(busyRefusal('merge'), 'Finish the git merge first')
  assert.equal(busyRefusal('index-lock'), 'git is busy in this folder; try again when it finishes')
})
