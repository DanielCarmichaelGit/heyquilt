// Commits made outside the session (a push from a worktree, a merge on
// GitHub, another worktree moving the branch) come into it without anyone
// pulling. Real relay, real git; the planner on its own at the end.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { planCatchUp, similarity } from '../src/upstream.js'

process.env.QUILT_UPSTREAM_MS = '400' // look often: the tests wait on it
const { startServer } = await import('../src/server.js')
const { Session } = await import('../src/session.js')
const { generateIdentity } = await import('../src/identity.js')

let srv, server
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-up-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
// What git says changed, leaving out the .gitignore Quilt writes (.quilt/ in it) at the start.
const changed = (dir) => git(dir, 'status', '--porcelain').split('\n').filter((l) => l && l !== '?? .gitignore').join('\n')
async function waitFor (fn, ms = 10000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
async function never (fn, ms = 1500) {
  const start = Date.now()
  while (Date.now() - start < ms) { assert.ok(!(await fn()), 'happened but must not'); await new Promise((r) => setTimeout(r, 25)) }
}
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
async function open (t, dir, name, extra) {
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), ...extra })
  t.after(() => s.stop())
  if (process.env.UP_DEBUG) s.on('log', (m) => console.error(`[${name}] ${m}`))
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: s.tool, status: 'idle' })
  return s
}

const APP = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n'
let rooms = 0
/** A bare remote, a pusher clone (someone working outside the session), and alice and bob in a room. */
async function setup (t, files = {}) {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const pusher = tmp('pusher'); git(pusher, 'clone', '-q', bare, '.')
  write(pusher, 'src/app.js', APP); write(pusher, 'README.md', 'hello\n')
  for (const [rel, text] of Object.entries(files)) write(pusher, rel, text)
  git(pusher, 'add', '.'); git(pusher, 'commit', '-qm', 'one'); git(pusher, 'push', '-q', 'origin', 'main')
  const dirA = tmp('a'); git(dirA, 'clone', '-q', bare, '.')
  const dirB = tmp('b'); git(dirB, 'clone', '-q', bare, '.')
  const room = `up${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  const B = await open(t, dirB, 'bob', { room })
  await waitFor(() => A.status().connected && B.status().connected)
  const push = (rel, text, msg = 'more') => { write(pusher, rel, text); git(pusher, 'add', '.'); git(pusher, 'commit', '-qm', msg); git(pusher, 'push', '-q', 'origin', 'main'); return git(pusher, 'rev-parse', 'HEAD') }
  return { A, B, dirA, dirB, bare, pusher, push }
}

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

test('commits pushed from outside come into the session by themselves, merged with its uncommitted work', async (t) => {
  const { dirA, dirB, push, A } = await setup(t)
  const mine = APP.replace('line1', 'line1 (alice, not committed)')
  write(dirA, 'src/app.js', mine)
  await waitFor(() => read(dirB, 'src/app.js') === mine)
  const sha = push('src/app.js', APP.replace('line8', 'line8 (pushed)'))
  const merged = mine.replace('line8', 'line8 (pushed)')
  await waitFor(() => read(dirA, 'src/app.js') === merged && read(dirB, 'src/app.js') === merged)
  // Each folder's branch moved forward to the pushed commit; git sees only the session's own change.
  await waitFor(() => git(dirA, 'rev-parse', 'HEAD') === sha && git(dirB, 'rev-parse', 'HEAD') === sha)
  for (const dir of [dirA, dirB]) {
    await waitFor(() => changed(dir) === 'M src/app.js')
    assert.equal(git(dir, 'diff', '--cached'), '', 'nothing staged')
    assert.match(git(dir, 'diff'), /\+line1 \(alice, not committed\)/)
    assert.doesNotMatch(git(dir, 'diff'), /pushed/)
  }
  await waitFor(() => A.status().git.upstream?.behind === 0 && A.status().git.upstream.name === 'origin/main')
})

test('a new file and a deletion pushed from outside arrive too', async (t) => {
  const { dirA, dirB, pusher, bare } = await setup(t, { 'old.txt': 'old\n' })
  write(pusher, 'docs/new.md', 'new\n'); fs.rmSync(path.join(pusher, 'old.txt'))
  git(pusher, 'add', '-A'); git(pusher, 'commit', '-qm', 'two'); git(pusher, 'push', '-q', 'origin', 'main')
  await waitFor(() => read(dirA, 'docs/new.md') === 'new\n' && read(dirB, 'docs/new.md') === 'new\n' && read(dirA, 'old.txt') === null && read(dirB, 'old.txt') === null)
  await waitFor(() => changed(dirA) === '' && changed(dirB) === '')
  assert.ok(bare)
})

test('another worktree moving this branch brings its files into this folder, not a reverted-looking tree', async (t) => {
  const { dirA, dirB, A } = await setup(t)
  const wt = path.join(tmp('wt'), 'feature')
  git(dirA, 'worktree', 'add', '-q', '-b', 'feature', wt)
  write(wt, 'src/app.js', APP.replace('line4', 'line4 (from the worktree)'))
  git(wt, 'commit', '-qam', 'worktree work')
  const sha = git(wt, 'rev-parse', 'HEAD')
  git(wt, 'update-ref', 'refs/heads/main', sha) // landed on main from the worktree, as an AI does
  const want = APP.replace('line4', 'line4 (from the worktree)')
  await waitFor(() => read(dirA, 'src/app.js') === want && read(dirB, 'src/app.js') === want)
  await waitFor(() => changed(dirA) === '')
  assert.equal(A.status().git.hold, null)
})

test('commits that clash with the session\'s work change nothing; the AI is told which files and why', async (t) => {
  const { A, dirA, dirB, push } = await setup(t)
  const mine = APP.replace('line2', 'line2 (alice)')
  write(dirA, 'src/app.js', mine)
  await waitFor(() => read(dirB, 'src/app.js') === mine)
  const before = git(dirA, 'rev-parse', 'HEAD')
  push('src/app.js', APP.replace('line2', 'line2 (pushed)'))
  await waitFor(() => A.status().git.upstream?.conflicts?.length === 1, 10000)
  assert.equal(A.status().git.upstream.conflicts[0].path, 'src/app.js')
  assert.equal(git(dirA, 'rev-parse', 'HEAD'), before)
  assert.equal(read(dirA, 'src/app.js'), mine)
  assert.equal(read(dirB, 'src/app.js'), mine)
  const told = A.takeNotices().join('\n')
  assert.match(told, /main is 1 commit behind origin\/main/)
  assert.match(told, /src\/app\.js \(changed in the same lines here and in the new commits\)/)
})

test('a file the session moved takes the pushed change at its new place', async (t) => {
  const T = 'import x from "../src/x.js"\ntest one\ntest two\ntest three\ntest four\n'
  const { dirA, dirB, push } = await setup(t, { 'test/a.test.js': T })
  const moved = T.replace('"../src/x.js"', '"../../src/x.js"')
  fs.rmSync(path.join(dirA, 'test/a.test.js'))
  write(dirA, 'test/unit/a.test.js', moved)
  await waitFor(() => read(dirB, 'test/unit/a.test.js') === moved && read(dirB, 'test/a.test.js') === null)
  push('test/a.test.js', T.replace('test four', 'test four, fixed'))
  const want = moved.replace('test four', 'test four, fixed')
  await waitFor(() => read(dirA, 'test/unit/a.test.js') === want && read(dirB, 'test/unit/a.test.js') === want)
  assert.equal(read(dirA, 'test/a.test.js'), null, 'not brought back at the old place')
  await waitFor(() => /^ ?D test\/a\.test\.js$/m.test(changed(dirA)))
})

test('a branch with commits of its own that origin lacks is never merged; the AI is told', async (t) => {
  const { A, dirA, push } = await setup(t)
  write(dirA, 'README.md', 'hello from alice\n')
  await waitFor(() => A.status().git && true)
  git(dirA, 'commit', '-qam', 'local')
  const local = git(dirA, 'rev-parse', 'HEAD')
  push('src/app.js', APP.replace('line8', 'line8 (pushed)'))
  await waitFor(() => A.status().git.upstream?.diverged === true, 10000)
  assert.equal(git(dirA, 'rev-parse', 'HEAD'), local)
  assert.match(A.takeNotices().join('\n'), /have both moved on \(1 commit here, 1 commit there\)/)
})

test('every member sees each folder\'s branch, its upstream and the repository\'s branches and worktrees', async (t) => {
  const { A, B, dirA } = await setup(t)
  git(dirA, 'branch', 'feature-x')
  await waitFor(() => A.status().git.repo?.branches?.some((b) => b.name === 'feature-x'))
  const seen = () => [...B.conn.awareness.getStates().values()].find((s) => s.name === 'alice')?.git
  await waitFor(() => seen()?.repo?.branches?.some((b) => b.name === 'feature-x') && seen()?.upstream?.name === 'origin/main')
  assert.equal(seen().branch, 'main')
  assert.deepEqual(seen().repo.worktrees.map((w) => w.name), ['.'])
  assert.equal(seen().upstream.url.endsWith('bare') || seen().upstream.url.includes('quilt-up-bare'), true)
})

// ---------------------------------------------------------------- planner --

const plan = ({ base, theirs, disk, moved, emptied }) => planCatchUp({
  changes: new Map(Object.keys({ ...base, ...theirs }).map((k) => [k, 'M'])),
  base: new Map(Object.entries(base)),
  theirs: new Map(Object.entries(theirs)),
  disk: (rel) => (rel in disk ? disk[rel] : null),
  moved: new Map(Object.entries(moved || {})),
  emptied: new Set(emptied || [])
})

test('planner: untouched files take the commits; changed ones merge; one clash and nothing is written', () => {
  const p = plan({ base: { a: 'x\n', b: '1\n2\n3\n' }, theirs: { a: 'y\n', b: '1\n2\n3 there\n' }, disk: { a: 'x\n', b: '1 here\n2\n3\n' } })
  assert.deepEqual([...p.writes], [['a', 'y\n'], ['b', '1 here\n2\n3 there\n']])
  const q = plan({ base: { a: 'x\n', b: '1\n' }, theirs: { a: 'y\n', b: '1 there\n' }, disk: { a: 'x\n', b: '1 here\n' } })
  assert.equal(q.writes.size, 0)
  assert.deepEqual(q.conflicts.map((c) => c.path), ['b'])
})

test('planner: deleted here and changed there is a clash, unless the file was moved', () => {
  const gone = plan({ base: { 't/a.js': 'a\nb\nc\n' }, theirs: { 't/a.js': 'a\nb\nc!\n' }, disk: {} })
  assert.match(gone.conflicts[0].why, /deleted here/)
  const moved = plan({ base: { 't/a.js': 'a\nb\nc\n' }, theirs: { 't/a.js': 'a\nb\nc!\n' }, disk: {}, moved: { 't/u/a.js': 'A\nb\nc\n' } })
  assert.deepEqual(moved.moves, [{ from: 't/a.js', to: 't/u/a.js' }])
  assert.deepEqual([...moved.writes], [['t/u/a.js', 'A\nb\nc!\n']])
  const otherName = plan({ base: { 't/a.js': 'a\nb\nc\n' }, theirs: { 't/a.js': 'a\nb\nc!\n' }, disk: {}, moved: { 't/u/b.js': 'a\nb\nc\n' } })
  assert.equal(otherName.conflicts.length, 1)
})

test('planner: a new file in a folder the session emptied is flagged; binaries and unreadable files never merge', () => {
  const stray = plan({ base: { 't/new.js': null }, theirs: { 't/new.js': 'n\n' }, disk: {}, emptied: ['t'] })
  assert.deepEqual(stray.strays, ['t/new.js'])
  assert.deepEqual([...stray.writes], [['t/new.js', 'n\n']])
  const bin = plan({ base: { p: 'bin:1' }, theirs: { p: 'bin:2' }, disk: { p: 'bin:3' } })
  assert.match(bin.conflicts[0].why, /binary/)
  const lfs = plan({ base: { p: undefined }, theirs: { p: 'x' }, disk: { p: 'x' } })
  assert.match(lfs.conflicts[0].why, /could not read/)
  assert.ok(similarity('a\nb\nc\n', 'a\nb\nd\n') > 0.5)
})

test('a clash one member resolved by hand: the others\' folders follow it instead of reporting the clash again', async (t) => {
  const { A, B, dirA, dirB, push } = await setup(t)
  const mine = APP.replace('line2', 'line2 (alice)')
  write(dirA, 'src/app.js', mine)
  await waitFor(() => read(dirB, 'src/app.js') === mine)
  const sha = push('src/app.js', APP.replace('line2', 'line2 (pushed)'))
  await waitFor(() => A.status().git.upstream?.conflicts?.length === 1 && B.status().git.upstream?.conflicts?.length === 1, 10000)
  // Alice's AI pulls and resolves it by hand, as the advice says.
  git(dirA, 'stash', 'push', '-q', '-m', 'up-test')
  git(dirA, 'pull', '-q', '--ff-only')
  try { git(dirA, 'stash', 'pop', '-q') } catch {}
  await waitFor(() => A.status().git.hold?.conflict) // a person takes a moment to resolve it
  const resolved = APP.replace('line2', 'line2 (pushed, and alice)')
  write(dirA, 'src/app.js', resolved)
  git(dirA, 'add', 'src/app.js')
  git(dirA, 'stash', 'drop', '-q')
  await waitFor(() => read(dirB, 'src/app.js') === resolved, 10000)
  // Bob's folder moves to the same commit, its file untouched, and no clash is reported any more.
  await waitFor(() => git(dirB, 'rev-parse', 'HEAD') === sha && B.status().git.upstream?.behind === 0, 10000)
  assert.equal(read(dirB, 'src/app.js'), resolved)
  await waitFor(() => changed(dirB) === 'M src/app.js')
  assert.equal(B.status().git.upstream.conflicts.length, 0)
})
