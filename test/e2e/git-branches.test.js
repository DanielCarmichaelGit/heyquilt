// Git operations in a synced folder are recognised, not broadcast: a stash on
// one machine never erases the room's work; pulled commits merge into it; a
// folder on another branch pauses. Real relay, two folders, real git.
// Branches and holds: a folder on another branch pauses and resumes, a hold survives a restart, .gitignore gets .quilt/, and a folder without git is untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer } from '../../src/server.js'
import { useRelay, tmp, read, write, git, waitFor, never, close, open, nextRoom, pairRepos } from '../helpers/git-pair.js'

useRelay()

test('an index.lock a crashed git left behind holds the folder only until it is a minute old', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  const lock = path.join(dirB, '.git', 'index.lock')
  fs.writeFileSync(lock, '')
  await waitFor(() => B.status().git.hold?.kind === 'busy')
  write(dirB, 'src/app.js', 'line1 (bob)\nline2\nline3\nline4\nline5\n')
  await never(() => read(dirA, 'src/app.js') !== 'line1\nline2\nline3\nline4\nline5\n', 2500)
  const old = (Date.now() - 2 * 60 * 1000) / 1000
  fs.utimesSync(lock, old, old) // as if left two minutes ago
  // bob's save is under a minute old: a long checkout (Git LFS, say) writes files all along. Still held.
  await never(() => B.status().git.hold === null, 2500)
  B.lastFileEventAt -= 2 * 60 * 1000 // as if the tree had been quiet as long as the lock
  await waitFor(() => read(dirA, 'src/app.js') === 'line1 (bob)\nline2\nline3\nline4\nline5\n' && B.status().git.hold === null, 10000)
  write(dirB, 'README.md', 'after\n')
  await waitFor(() => read(dirA, 'README.md') === 'after\n')
  assert.equal(B.logs.filter((l) => l.includes('a leftover .git/index.lock is being ignored; delete it if git complains')).length, 1, B.logs.join('\n'))
  assert.ok(fs.existsSync(lock), 'Quilt never deletes it')
})

test('a git folder reports its branch; a plain folder reports none', async (t) => {
  const { A } = await pairRepos(t)
  assert.equal(A.status().git.branch, 'main')
  const plain = tmp('plain'); write(plain, 'x.txt', 'x\n')
  const P = await open(t, plain, 'pat', { room: 'ga-plain' })
  assert.equal(P.status().git, null)
})

test('a session in a git folder makes .gitignore ignore .quilt/, once, and partners get the line', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  const want = "# Quilt keeps this session's local state here\n.quilt/\n"
  assert.equal(read(dirA, '.gitignore'), want)
  await waitFor(() => read(dirB, '.gitignore') === want)
  for (const s of [A, B]) assert.ok(s.logs.filter((l) => l === 'Added .quilt/ to .gitignore so git leaves Quilt\'s state alone.').length <= 1, s.logs.join('\n'))
  assert.equal(A.logs.filter((l) => l.startsWith('Added .quilt/ to .gitignore')).length, 1)
  assert.equal(git(dirA, 'check-ignore', '.quilt/state.json'), '.quilt/state.json')
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  // Already ignored: left byte for byte at the next start.
  const dirC = tmp('c'); git(dirC, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  write(dirC, '.gitignore', 'dist\r\n/.quilt\r\n')
  const C = await open(t, dirC, 'carol', { room: `${nextRoom()}-own` })
  assert.equal(read(dirC, '.gitignore'), 'dist\r\n/.quilt\r\n')
  assert.ok(!C.logs.some((l) => l.startsWith('Added .quilt/')), C.logs.join('\n'))
})

test('a first join takes the room\'s .gitignore, then adds the line to it; a viewer\'s start leaves .gitignore alone', async (t) => {
  const room = nextRoom()
  const plain = tmp('plain'); write(plain, '.gitignore', 'dist\n'); write(plain, 'x.txt', 'x\n')
  const P = await open(t, plain, 'pat', { room })
  const dirB = tmp('b'); git(dirB, 'init', '-q', '-b', 'main')
  write(dirB, '.gitignore', 'node_modules\n') // the room's version wins on a first join (prefer: remote)
  const B = await open(t, dirB, 'bob', { room })
  const want = "dist\n# Quilt keeps this session's local state here\n.quilt/\n"
  assert.equal(read(dirB, '.gitignore'), want)
  await waitFor(() => read(plain, '.gitignore') === want)
  assert.equal(P.mergeList().filter((m) => m.state === 'open').length, 0)
  // A viewer (as state.json last knew them): their edit would only be refused, so none is made.
  await close(B)
  write(dirB, '.gitignore', 'dist\n')
  const stateFile = path.join(dirB, '.quilt', 'state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), role: 'viewer' }))
  const B2 = await open(t, dirB, 'bob', { room })
  assert.equal(read(dirB, '.gitignore'), 'dist\n')
  assert.ok(!B2.logs.some((l) => l.includes('.gitignore')), B2.logs.join('\n'))
})

test('checking out another branch moves that folder to its document; coming back brings back main\'s work', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  git(dirB, 'checkout', '-qb', 'feature')
  await waitFor(() => B.status().branch === 'feature' && B.status().git.hold === null, 10000)
  assert.ok(B.logs.some((l) => l.includes("You're on feature now (you switched in git)")), B.logs.join('\n'))
  write(dirB, 'src/app.js', 'feature work\n')
  write(dirA, 'README.md', 'main work\n')
  await never(() => read(dirA, 'src/app.js') === 'feature work\n', 2000)
  await never(() => read(dirB, 'README.md') === 'main work\n', 500)
  git(dirB, 'commit', '-qam', 'feature'); git(dirB, 'checkout', '-q', 'main')
  await waitFor(() => B.status().branch === 'main' && B.status().git.hold === null, 10000)
  await waitFor(() => read(dirB, 'README.md') === 'main work\n' && read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5\n')
  await never(() => read(dirA, 'src/app.js') !== 'line1\nline2\nline3\nline4\nline5\n', 500)
})

test('stopped on main, restarted on a new branch: the folder moves there from the folder as git left it, and later main work never lands on it', async (t) => {
  const { A, B, dirA, dirB, room } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  await close(B)
  git(dirB, 'checkout', '-qb', 'feature') // carries README.md's change over
  write(dirB, 'src/app.js', 'feature work\n') // an edit on feature while Quilt was stopped
  write(dirA, 'src/app.js', 'line1\nline2 (alice, meanwhile)\nline3\nline4\nline5\n')
  const B2 = await open(t, dirB, 'bob', { room })
  await waitFor(() => B2.status().branch === 'feature' && B2.status().git.hold === null, 10000)
  assert.equal(B2.files.get('README.md')?.toString(), 'main work\n', 'a branch new to the session starts from the folder, carried work included')
  assert.equal(B2.files.get('src/app.js')?.toString(), 'feature work\n', 'the edit made on feature is feature\'s')
  await never(() => read(dirB, 'src/app.js') !== 'feature work\n' || read(dirA, 'src/app.js') !== 'line1\nline2 (alice, meanwhile)\nline3\nline4\nline5\n' || read(dirA, 'README.md') !== 'main work\n', 2000)
  assert.equal(A.status().branch, 'main')
})

test('stopped mid-hold on the same branch: the next start puts the room\'s work back instead of sharing the discard', async (t) => {
  const { B, dirA, dirB, room } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'stash', '-q')
  await waitFor(() => B.status().git.hold)
  await close(B) // within the settle time: the discard is still held
  assert.equal(read(dirB, 'README.md'), 'hello\n')
  // Bases an earlier offline merge left behind are none of this hold's: dropped, not read by a later start.
  const bases = path.join(dirB, '.quilt', 'merging.json')
  fs.writeFileSync(bases, JSON.stringify({ 'README.md': 'a stale base\n' }))
  const B2 = await open(t, dirB, 'bob', { room })
  assert.equal(fs.existsSync(bases), false)
  await never(() => read(dirA, 'README.md') !== 'main work\n', 1500)
  await waitFor(() => read(dirB, 'README.md') === 'main work\n' && B2.status().git.hold === null, 10000)
  assert.equal(read(dirA, 'README.md'), 'main work\n')
})

test('restarted on a branch with no commits yet: the folder moves to it, and main\'s work stays on main', async (t) => {
  const { A, B, dirA, dirB, room } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  await close(B)
  git(dirB, 'checkout', '-q', '--orphan', 'scratch')
  write(dirB, 'src/app.js', 'orphan work\n') // HEAD has no commit to read: headKey is null at the next start
  const B2 = await open(t, dirB, 'bob', { room })
  await waitFor(() => B2.status().branch === 'scratch' && B2.status().git.hold === null, 10000)
  await never(() => read(dirA, 'src/app.js') !== 'line1\nline2\nline3\nline4\nline5\n' || read(dirA, 'README.md') !== 'main work\n', 2500)
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  git(dirB, 'checkout', '-qf', 'main')
  await waitFor(() => B2.status().branch === 'main' && read(dirB, 'README.md') === 'main work\n', 10000)
  assert.equal(read(dirA, 'src/app.js'), 'line1\nline2\nline3\nline4\nline5\n')
})

test('a hold resumed at start settles only once the relay has synced', async (t) => {
  const dataDir = tmp('relay2')
  const relay = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: () => {}, maxNewRoomsPerHour: 0 })
  const url = `ws://127.0.0.1:${relay.port}`
  let restarted = null
  t.after(async () => { await (restarted || relay).close().catch(() => {}) })
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = tmp('seed'); git(seed, 'clone', '-q', bare, '.')
  write(seed, 'README.md', 'hello\n'); git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  const dirA = tmp('a'); git(dirA, 'clone', '-q', bare, '.')
  const dirB = tmp('b'); git(dirB, 'clone', '-q', bare, '.')
  const room = nextRoom()
  const A = await open(t, dirA, 'alice', { room, server: url })
  const B = await open(t, dirB, 'bob', { room, server: url })
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'stash', '-q')
  await waitFor(() => B.status().git.hold)
  await close(B)
  await close(A)
  await relay.close()
  const B2 = await open(t, dirB, 'bob', { room, server: url })
  assert.ok(B2.status().git.hold)
  // The relay is down: the doc on disk is the room as of the last stop, so nothing settles against it.
  await never(() => B2.status().git.hold === null || read(dirB, 'README.md') !== 'hello\n', 3000)
  restarted = await startServer({ port: relay.port, host: '127.0.0.1', dataDir, log: () => {}, maxNewRoomsPerHour: 0 })
  await waitFor(() => B2.status().git.hold === null && read(dirB, 'README.md') === 'main work\n', 20000)
})

test('an edit made while git holds the folder is shared once it settles, never reverted', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  // A git command holding the index lock (an agent's `git status`, a commit) while bob keeps typing.
  fs.writeFileSync(path.join(dirB, '.git', 'index.lock'), '')
  await waitFor(() => B.status().git.hold?.kind === 'busy')
  write(dirB, 'src/app.js', 'line1\nline2 (bob, during)\nline3\nline4\nline5\n')
  write(dirB, 'notes.txt', 'new while held\n')
  await new Promise((resolve) => setTimeout(resolve, 300))
  fs.rmSync(path.join(dirB, '.git', 'index.lock'))
  await waitFor(() => read(dirA, 'src/app.js') === 'line1\nline2 (bob, during)\nline3\nline4\nline5\n' && read(dirA, 'notes.txt') === 'new while held\n', 10000)
  assert.equal(read(dirB, 'src/app.js'), 'line1\nline2 (bob, during)\nline3\nline4\nline5\n', 'bob\'s edit is still on his disk')
  assert.equal(B.status().git.hold, null)
})

test('a new branch with no commits yet (checkout --orphan) is a switch, not git gone missing', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  git(dirB, 'checkout', '-q', '--orphan', 'scratch')
  await waitFor(() => B.status().branch === 'scratch' && B.status().git.hold === null, 10000)
  assert.ok(B.logs.some((l) => l.includes("You're on scratch now")), B.logs.join('\n'))
  write(dirA, 'README.md', 'main work\n')
  await never(() => read(dirB, 'README.md') === 'main work\n', 1000)
  write(dirB, 'notes.txt', 'on scratch\n') // a branch with no commits: a change is an edit there
  await waitFor(() => B.files.get('notes.txt')?.toString() === 'on scratch\n')
  git(dirB, 'checkout', '-qf', 'main')
  await waitFor(() => B.status().branch === 'main' && read(dirB, 'README.md') === 'main work\n', 10000)
})

test('a folder without git is untouched by all of this', async (t) => {
  const dirA = tmp('pa'); const dirB = tmp('pb'); write(dirA, 'x.txt', 'x\n')
  const A = await open(t, dirA, 'alice', { room: 'ga-plain2' })
  await open(t, dirB, 'bob', { room: 'ga-plain2' })
  await waitFor(() => read(dirB, 'x.txt') === 'x\n')
  write(dirB, 'x.txt', 'y\n')
  await waitFor(() => read(dirA, 'x.txt') === 'y\n')
  assert.equal(A.status().git, null)
  assert.equal(read(dirA, '.gitignore'), null, 'no .gitignore written where there is no git')
  assert.equal(read(dirB, '.gitignore'), null)
})
