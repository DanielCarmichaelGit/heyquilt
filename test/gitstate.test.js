import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitDir, headKey, busy, indexStamp, classify, fileAt, changedBetween, watchGit } from '../src/gitstate.js'

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

test('no git: everything says so', () => {
  const dir = tmp('plain')
  assert.equal(gitDir(dir), null)
  assert.equal(headKey(dir), null)
  assert.equal(busy(dir), null)
  assert.equal(indexStamp(dir), null)
  assert.equal(classify(dir, { changed: ['x'], before: null }).kind, 'edit')
})

test('head key: branch, detached, and a worktree', () => {
  const dir = repo()
  const h = headKey(dir)
  assert.equal(h.branch, 'main'); assert.equal(h.key, 'main'); assert.match(h.sha, /^[0-9a-f]{40}$/)
  git(dir, 'checkout', '-q', '--detach')
  assert.equal(headKey(dir).key, `@${h.sha.slice(0, 12)}`)
  git(dir, 'checkout', '-q', 'main')
  const wt = path.join(tmp('wt'), 'w')
  git(dir, 'worktree', 'add', '-q', wt, '-b', 'feature')
  assert.ok(gitDir(wt).includes('worktrees'))
  assert.equal(headKey(wt).key, 'feature')
})

test('busy markers', () => {
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

test('classify: edit, discard, advance, switch', () => {
  const dir = repo()
  const before = headKey(dir)
  write(dir, 'a.txt', 'a1\nEDIT\na3\n')
  assert.equal(classify(dir, { changed: ['a.txt'], before }).kind, 'edit')
  git(dir, 'stash', '-q')
  const d = classify(dir, { changed: ['a.txt'], before })
  assert.equal(d.kind, 'discard'); assert.equal(d.head.sha, before.sha)
  git(dir, 'stash', 'pop', '-q')
  git(dir, 'commit', '-qam', 'two')
  const a = classify(dir, { changed: ['a.txt'], before })
  assert.equal(a.kind, 'advance'); assert.notEqual(a.head.sha, before.sha); assert.equal(a.prevHead.sha, before.sha)
  git(dir, 'checkout', '-qb', 'feature')
  assert.equal(classify(dir, { changed: [], before: headKey(dir) }).kind, 'edit', 'same key, nothing changed')
  const s = classify(dir, { changed: ['a.txt'], before: a.head })
  assert.equal(s.kind, 'switch'); assert.equal(s.head.key, 'feature')
})

test('classify: busy wins, and a mix of clean and dirty paths is an edit', () => {
  const dir = repo()
  const before = headKey(dir)
  write(dir, 'a.txt', 'changed\n')
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'x')
  assert.equal(classify(dir, { changed: ['a.txt'], before }).kind, 'busy')
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'))
  assert.equal(classify(dir, { changed: ['a.txt', 'b.txt'], before }).kind, 'edit')
})

test('fileAt and changedBetween', () => {
  const dir = repo()
  const one = headKey(dir).sha
  write(dir, 'a.txt', 'a1\na2\na3\na4\n'); git(dir, 'commit', '-qam', 'two')
  const two = headKey(dir).sha
  assert.equal(fileAt(dir, one, 'a.txt'), 'a1\na2\na3\n')
  assert.equal(fileAt(dir, one, 'nope.txt'), null)
  assert.deepEqual(changedBetween(dir, one, two), ['a.txt'])
})

test('indexStamp changes when git touches the index, not when a file is edited', () => {
  const dir = repo()
  const s0 = indexStamp(dir)
  write(dir, 'a.txt', 'x\n')
  assert.equal(indexStamp(dir), s0)
  git(dir, 'add', 'a.txt')
  assert.notEqual(indexStamp(dir), s0)
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
