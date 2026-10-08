// Git operations in a synced folder are recognised, not broadcast: a stash on
// one machine never erases the room's work; pulled commits merge into it; a
// folder on another branch pauses. Real relay, two folders, real git.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { renderStatus } from '../src/status.js'
import { generateIdentity } from '../src/identity.js'

let srv, server
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-ga-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
async function waitFor (fn, ms = 8000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
/** Holds for `ms` and fails if `fn` ever becomes true meanwhile. */
async function never (fn, ms = 1500) {
  const start = Date.now()
  while (Date.now() - start < ms) { assert.ok(!(await fn()), 'happened but must not'); await new Promise((r) => setTimeout(r, 25)) }
}
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
const stopped = new Set()
const close = async (s) => { if (!stopped.has(s)) { stopped.add(s); await s.stop() } }
async function open (t, dir, name, extra) {
  // These tests are about a person's own git commands: commits come in only when they pull (see upstream.test.js).
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), bringInUpstream: false, ...extra })
  t.after(() => close(s))
  if (process.env.GA_DEBUG) { s.on('log', (m) => console.error(`[${name}] ${m}`)); s.on('hold', (h) => console.error(`[${name}] hold ${JSON.stringify(h)}`)) }
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: s.tool, status: 'idle' }) // people typing by hand; their edits are not claimed for them
  return s
}

let rooms = 0
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 0xfe])
const LOGO2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 2, 0xfe, 0xff])
const readBuf = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel)) } catch { return null } }

/** A bare remote, two clones (alice, bob) with one commit, both in a fresh room. `extra`: more files for the commit. */
async function pairRepos (t, extra = {}, bobOpts = {}) {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = tmp('seed'); git(seed, 'clone', '-q', bare, '.')
  write(seed, 'src/app.js', 'line1\nline2\nline3\nline4\nline5\n'); write(seed, 'README.md', 'hello\n')
  fs.writeFileSync(path.join(seed, 'assets-logo.png'), LOGO)
  for (const [rel, text] of Object.entries(extra)) write(seed, rel, text)
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  const dirA = tmp('a'); git(dirA, 'clone', '-q', bare, '.')
  const dirB = tmp('b'); git(dirB, 'clone', '-q', bare, '.')
  const room = `ga${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  const B = await open(t, dirB, 'bob', { room, ...bobOpts })
  await waitFor(() => A.status().connected && B.status().connected)
  return { A, B, dirA, dirB, bare, room }
}

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

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

test('a stash on one machine does not erase the room\'s work; it comes back after settling', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'src/app.js', 'line1 (alice)\nline2\nline3\nline4\nline5\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1 (alice)\nline2\nline3\nline4\nline5\n')
  git(dirB, 'stash', '-q') // bob's disk reverts to the commit
  await never(() => read(dirA, 'src/app.js') !== 'line1 (alice)\nline2\nline3\nline4\nline5\n', 2500)
  await waitFor(() => read(dirB, 'src/app.js') === 'line1 (alice)\nline2\nline3\nline4\nline5\n', 8000)
  assert.ok(B.logs.some((l) => l.includes('Quilt kept the session\'s work; your stash still has your copy')), B.logs.join('\n'))
  assert.equal(git(dirB, 'stash', 'list').split('\n').filter(Boolean).length, 1, 'the stash is untouched')
})

test('a stash landing in the same flush as an unrelated save is still not shared: the room keeps its work', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  const alice = 'line1 (alice)\nline2\nline3\nline4\nline5\n'
  write(dirA, 'src/app.js', alice)
  await waitFor(() => read(dirB, 'src/app.js') === alice)
  // An untracked scratch file saved in the same instant as the stash (an editor's autosave, a dev
  // server's output): queued here so both land in one flush, as they do on a busy machine.
  write(dirB, 'scratch.txt', 'notes\n'); git(dirB, 'stash', '-q')
  B.queue('scratch.txt'); B.queue('src/app.js')
  await never(() => read(dirA, 'src/app.js') !== alice, 2500)
  await waitFor(() => read(dirB, 'src/app.js') === alice && read(dirA, 'scratch.txt') === 'notes\n', 8000)
  assert.equal(read(dirA, 'src/app.js'), alice, 'the partner\'s file is untouched')
  assert.equal(git(dirB, 'stash', 'list').split('\n').filter(Boolean).length, 1, 'the stash is untouched')
})

/** Files just written into a new folder: lets bob's watcher (and its once-a-second scan) see them before they go. */
const settleWatcher = () => new Promise((resolve) => setTimeout(resolve, 1500))

test('git clean of many untracked files is shared as deletions', async (t) => {
  const { dirA, dirB } = await pairRepos(t)
  const many = Array.from({ length: 25 }, (_, i) => `scratch/f${i}.txt`)
  for (const rel of many) write(dirA, rel, `scratch ${rel}\n`)
  await waitFor(() => many.every((rel) => read(dirB, rel) === `scratch ${rel}\n`))
  await settleWatcher()
  git(dirB, 'clean', '-fdq') // untracked in bob's repo too: he meant to delete them
  assert.ok(fs.existsSync(path.join(dirB, '.quilt', 'state.json')), 'git clean leaves Quilt\'s state: .gitignore ignores it')
  await waitFor(() => many.every((rel) => read(dirA, rel) === null), 10000)
  await never(() => many.some((rel) => read(dirB, rel) !== null), 2500)
})

test('git stash -u of untracked files brings them back from the room, and leaves Quilt\'s state in place', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  const notes = ['notes/a.txt', 'notes/b.txt', 'notes/c.txt']
  for (const rel of notes) write(dirA, rel, `alice's ${rel}\n`)
  await waitFor(() => notes.every((rel) => read(dirB, rel) === `alice's ${rel}\n`))
  await settleWatcher()
  git(dirB, 'stash', '-uq')
  assert.ok(fs.existsSync(path.join(dirB, '.quilt', 'state.json')), '.gitignore ignores .quilt/: the stash leaves it')
  await never(() => notes.some((rel) => read(dirA, rel) !== `alice's ${rel}\n`), 2500)
  await waitFor(() => notes.every((rel) => read(dirB, rel) === `alice's ${rel}\n`), 8000)
  assert.equal(git(dirB, 'stash', 'list').split('\n').filter(Boolean).length, 1, 'the stash is untouched')
  assert.ok(fs.existsSync(path.join(dirB, '.quilt', 'state.json')))
  assert.equal(B.status().git.hold, null)
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
  const C = await open(t, dirC, 'carol', { room: `ga-own-${rooms}` })
  assert.equal(read(dirC, '.gitignore'), 'dist\r\n/.quilt\r\n')
  assert.ok(!C.logs.some((l) => l.startsWith('Added .quilt/')), C.logs.join('\n'))
})

test('a first join takes the room\'s .gitignore, then adds the line to it; a viewer\'s start leaves .gitignore alone', async (t) => {
  const room = `ga${++rooms}`
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

test('reset --hard by an agent is the same', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'hello from alice\n')
  await waitFor(() => read(dirB, 'README.md') === 'hello from alice\n')
  git(dirB, 'reset', '-q', '--hard')
  await never(() => read(dirA, 'README.md') !== 'hello from alice\n', 2500)
  await waitFor(() => read(dirB, 'README.md') === 'hello from alice\n', 8000)
  // Nothing was stashed, so the line doesn't say there is a stash.
  assert.ok(B.logs.some((l) => l.includes('git put 1 file back to your last commit on this computer only')), B.logs.join('\n'))
  assert.ok(!B.logs.some((l) => l.includes('your stash still has your copy')), B.logs.join('\n'))
})

test('a stash pop that clashes is git mid-conflict: the person resolves it, the partner never sees markers, and the resolution is shared', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  // Alice's uncommitted line 2 is the room's work; a commit elsewhere rewrites the same line.
  write(dirA, 'src/app.js', 'line1\nline2 (alice)\nline3\nline4\nline5\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1\nline2 (alice)\nline3\nline4\nline5\n')
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  write(c, 'src/app.js', 'line1\nline2 (remote)\nline3\nline4\nline5\n'); git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  git(dirB, 'stash', '-q'); git(dirB, 'pull', '-q', '--ff-only')
  assert.throws(() => git(dirB, 'stash', 'pop', '-q'), 'the pop clashes')
  assert.match(read(dirB, 'src/app.js'), /<<<<<<< /)
  // Held while git's conflict is there: bob keeps his markers, alice never gets them.
  await never(() => /<<<<<<< /.test(read(dirA, 'src/app.js') || '') || !/<<<<<<< /.test(read(dirB, 'src/app.js') || ''), 4000)
  await waitFor(() => B.status().git.hold?.conflict?.includes('src/app.js'))
  assert.ok(B.logs.some((l) => l.includes('git left a conflict in src/app.js on this computer')), B.logs.join('\n'))
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  // Bob resolves (both changes) and tells git: his resolution is the session's now, no record.
  write(dirB, 'src/app.js', 'line1\nline2 (remote, alice)\nline3\nline4\nline5\n'); git(dirB, 'add', 'src/app.js')
  await waitFor(() => read(dirA, 'src/app.js') === 'line1\nline2 (remote, alice)\nline3\nline4\nline5\n', 10000)
  await waitFor(() => B.status().git.hold === null)
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  assert.equal(B.mergeList().filter((m) => m.state === 'open').length, 0)
})

test('stash, pull, pop lands once with the pulled commit merged, no flicker', async (t) => {
  const { dirA, dirB } = await pairRepos(t)
  // Alice's uncommitted edit is shared; bob also has his own local commit to pull over.
  write(dirA, 'src/app.js', 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  // A commit on the remote touching line1, made elsewhere.
  const bareOf = git(dirA, 'remote', 'get-url', 'origin')
  const c = tmp('c'); git(c, 'clone', '-q', bareOf, '.')
  write(c, 'src/app.js', 'line1 (remote)\nline2\nline3\nline4\nline5\n'); git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  const flicker = []
  const watch = setInterval(() => flicker.push(read(dirA, 'src/app.js')), 20)
  git(dirB, 'stash', '-q'); git(dirB, 'pull', '-q', '--ff-only'); git(dirB, 'stash', 'pop', '-q')
  const want = 'line1 (remote)\nline2\nline3\nline4\nline5 (alice)\n'
  await waitFor(() => read(dirA, 'src/app.js') === want && read(dirB, 'src/app.js') === want, 10000)
  clearInterval(watch)
  assert.ok(!flicker.includes('line1\nline2\nline3\nline4\nline5\n'), 'alice never saw the committed state flash by')
})

test('a pull that changes a file the partner is editing merges three-way; an overlap becomes a merge record', async (t) => {
  const { A, dirA, dirB } = await pairRepos(t)
  write(dirA, 'src/app.js', 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  const bareOf = git(dirA, 'remote', 'get-url', 'origin')
  const c = tmp('c'); git(c, 'clone', '-q', bareOf, '.')
  write(c, 'src/app.js', 'line1 (remote)\nline2\nline3\nline4\nline5\n'); write(c, 'README.md', 'hello (remote)\n')
  git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  write(dirA, 'README.md', 'hello (alice)\n')
  await waitFor(() => read(dirB, 'README.md') === 'hello (alice)\n')
  // Stashed and pulled, never popped: the pulled commits meet the room's work in Quilt, not in git.
  git(dirB, 'stash', '-q'); git(dirB, 'pull', '-q', '--ff-only')
  await waitFor(() => read(dirA, 'src/app.js') === 'line1 (remote)\nline2\nline3\nline4\nline5 (alice)\n', 10000)
  const rec = await waitFor(() => A.mergeList().find((m) => m.path === 'README.md' && m.state === 'open'), 10000)
  assert.equal(rec.kind, 'conflict')
  assert.equal(rec.via, 'pull', 'the record says the commits were pulled, not edited offline')
  assert.equal(read(dirA, 'README.md'), 'hello (alice)\n', 'the room keeps its work')
})

test('a rebase with a conflict never shows git markers to the partner; continuing merges the result', async (t) => {
  const { dirA, dirB } = await pairRepos(t)
  const bareOf = git(dirA, 'remote', 'get-url', 'origin')
  const c = tmp('c'); git(c, 'clone', '-q', bareOf, '.')
  write(c, 'README.md', 'remote wins\n'); git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  // bob commits a conflicting change locally (the shared file changes for alice too, as an edit)
  write(dirB, 'README.md', 'bob wins\n')
  await waitFor(() => read(dirA, 'README.md') === 'bob wins\n')
  git(dirB, 'commit', '-qam', 'bob')
  let failed = false
  try { git(dirB, 'pull', '-q', '--rebase') } catch { failed = true }
  assert.ok(failed, 'the rebase stops on the conflict')
  assert.match(read(dirB, 'README.md'), /<<<<<<< /)
  await never(() => /<<<<<<< /.test(read(dirA, 'README.md') || ''), 2000)
  write(dirB, 'README.md', 'both win\n'); git(dirB, 'add', 'README.md')
  execFileSync('git', ['rebase', '--continue'], { cwd: dirB, env: { ...ENV, GIT_EDITOR: 'true' }, stdio: 'ignore' })
  await waitFor(() => read(dirA, 'README.md') === 'both win\n', 10000)
})

test('checking out another branch pauses that folder; coming back resumes and merges', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  git(dirB, 'checkout', '-qb', 'feature')
  await waitFor(() => B.status().git.hold?.kind === 'switching')
  assert.ok(B.logs.some((l) => l.includes("You're on feature; this session syncs main")), B.logs.join('\n'))
  write(dirB, 'src/app.js', 'feature work\n')
  write(dirA, 'README.md', 'main work\n')
  await never(() => read(dirA, 'src/app.js') === 'feature work\n', 2000)
  await never(() => read(dirB, 'README.md') === 'main work\n', 500)
  git(dirB, 'stash', '-q'); git(dirB, 'checkout', '-q', 'main')
  await waitFor(() => B.status().git.hold === null, 10000)
  await waitFor(() => read(dirB, 'README.md') === 'main work\n' && read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5\n')
  assert.ok(B.logs.some((l) => l.includes('Back on main: caught up with the session')), B.logs.join('\n'))
})

test('stopped while paused on another branch: the next start stays paused, then resumes on the way back', async (t) => {
  const { A, B, dirA, dirB, room } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'stash', '-q'); git(dirB, 'checkout', '-qb', 'feature') // the room's work is not on feature
  await waitFor(() => B.status().git.hold?.kind === 'switching')
  await close(B)
  write(dirB, 'src/app.js', 'feature work\n'); git(dirB, 'commit', '-qam', 'feature')
  write(dirA, 'src/app.js', 'line1\nline2 (alice, meanwhile)\nline3\nline4\nline5\n')
  const B2 = await open(t, dirB, 'bob', { room })
  assert.equal(B2.status().git.hold?.kind, 'switching')
  assert.equal(B2.status().git.key, 'main')
  assert.ok(B2.logs.some((l) => l.includes("You're on feature; this session syncs main")), B2.logs.join('\n'))
  await never(() => read(dirA, 'src/app.js') !== 'line1\nline2 (alice, meanwhile)\nline3\nline4\nline5\n' || read(dirA, 'README.md') !== 'main work\n', 2000)
  assert.equal(read(dirB, 'src/app.js'), 'feature work\n', 'nothing of main is written onto feature')
  git(dirB, 'checkout', '-q', 'main')
  await waitFor(() => B2.status().git.hold === null, 10000)
  await waitFor(() => read(dirB, 'README.md') === 'main work\n' && read(dirB, 'src/app.js') === 'line1\nline2 (alice, meanwhile)\nline3\nline4\nline5\n', 10000)
  assert.equal(read(dirA, 'README.md'), 'main work\n')
  assert.equal(A.status().git.hold, null)
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

test('restarted on a branch with no commits yet, with a hold saved: nothing in that tree is captured', async (t) => {
  const { A, B, dirA, dirB, room } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'checkout', '-q', '--orphan', 'scratch')
  await waitFor(() => B.status().git.hold?.kind === 'switching')
  await close(B)
  write(dirB, 'src/app.js', 'orphan work\n') // HEAD has no commit to read: headKey is null at the next start
  const B2 = await open(t, dirB, 'bob', { room })
  assert.equal(B2.status().git.hold?.kind, 'switching')
  assert.equal(B2.status().git.key, 'main')
  assert.ok(B2.logs.some((l) => l.includes("You're on scratch; this session syncs main")), B2.logs.join('\n'))
  await never(() => read(dirA, 'src/app.js') !== 'line1\nline2\nline3\nline4\nline5\n' || read(dirA, 'README.md') !== 'main work\n', 2500)
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  git(dirB, 'checkout', '-qf', 'main')
  await waitFor(() => B2.status().git.hold === null && read(dirB, 'README.md') === 'main work\n', 10000)
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
  const room = `ga${++rooms}`
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

test('a pulled commit changing a binary nobody edited lands on both disks, no record', async (t) => {
  const { A, dirA, dirB } = await pairRepos(t)
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  fs.writeFileSync(path.join(c, 'assets-logo.png'), LOGO2); git(c, 'commit', '-qam', 'new logo'); git(c, 'push', '-q', 'origin', 'main')
  git(dirB, 'pull', '-q', '--ff-only')
  await waitFor(() => LOGO2.equals(readBuf(dirA, 'assets-logo.png')) && LOGO2.equals(readBuf(dirB, 'assets-logo.png')), 10000)
  await never(() => A.mergeList().some((m) => m.state === 'open') || !LOGO2.equals(readBuf(dirB, 'assets-logo.png')), 2500)
})

test('a pulled commit with a binary and a text file merges the text file and takes the binary', async (t) => {
  const { A, dirA, dirB } = await pairRepos(t)
  write(dirA, 'src/app.js', 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'line1\nline2\nline3\nline4\nline5 (alice)\n')
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  fs.writeFileSync(path.join(c, 'assets-logo.png'), LOGO2); write(c, 'src/app.js', 'line1 (remote)\nline2\nline3\nline4\nline5\n')
  git(c, 'commit', '-qam', 'both'); git(c, 'push', '-q', 'origin', 'main')
  git(dirB, 'stash', '-q'); git(dirB, 'pull', '-q', '--ff-only'); git(dirB, 'stash', 'pop', '-q')
  const want = 'line1 (remote)\nline2\nline3\nline4\nline5 (alice)\n'
  await waitFor(() => read(dirA, 'src/app.js') === want && read(dirB, 'src/app.js') === want && LOGO2.equals(readBuf(dirA, 'assets-logo.png')), 10000)
  assert.ok(LOGO2.equals(readBuf(dirB, 'assets-logo.png')))
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
})

test('git unreachable when a hold settles: the folder stays held, nothing is shared, and it settles once git is back', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'stash', '-q')
  await waitFor(() => B.status().git.hold)
  process.env.QUILT_GIT = path.join(tmp('nogit'), 'git')
  try {
    await never(() => read(dirA, 'README.md') !== 'main work\n' || B.status().git.hold === null, 4500)
    assert.equal(B.status().git.hold.kind, 'busy')
  } finally { delete process.env.QUILT_GIT }
  await waitFor(() => read(dirB, 'README.md') === 'main work\n' && B.status().git.hold === null, 10000)
  assert.equal(read(dirA, 'README.md'), 'main work\n')
})

test('a hold resumed over 500 files settles without stalling the app', async (t) => {
  const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`many/f${i}.txt`, `file ${i}\n`]))
  const { B, dirA, dirB, room } = await pairRepos(t, many)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'stash', '-q')
  await waitFor(() => B.status().git.hold)
  await close(B)
  const B2 = await open(t, dirB, 'bob', { room })
  let last = Date.now(); let worst = 0
  const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now }, 5)
  try {
    await waitFor(() => read(dirB, 'README.md') === 'main work\n' && B2.status().git.hold === null, 15000)
  } finally { clearInterval(tick) }
  assert.ok(worst < 1000, `the event loop stalled for ${worst} ms`)
  assert.equal(read(dirA, 'README.md'), 'main work\n')
})

test('git at work on the other branch keeps the pause as it is, said once; the hold is in state.json at once', async (t) => {
  const { B, dirB } = await pairRepos(t)
  git(dirB, 'checkout', '-qb', 'feature')
  await waitFor(() => B.status().git.hold?.kind === 'switching')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirB, '.quilt', 'state.json'), 'utf8')).gitHeld, true, 'written as the hold starts')
  fs.writeFileSync(path.join(dirB, '.git', 'index.lock'), '')
  await never(() => B.status().git.hold?.kind !== 'switching', 2500)
  fs.rmSync(path.join(dirB, '.git', 'index.lock'))
  await never(() => B.status().git.hold?.kind !== 'switching', 2500)
  assert.equal(B.logs.filter((l) => l.includes("You're on feature")).length, 1, B.logs.join('\n'))
})

/** A git that runs, but fails any call with one of `failOn` in its arguments. */
function failingGit (...failOn) {
  const bin = path.join(tmp('fakegit'), 'git')
  fs.writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do case "$a" in ${failOn.map((f) => `'${f}'`).join('|')}) exit 1;; esac; done\nexec git "$@"\n`, { mode: 0o755 })
  return bin
}
const POINTER = (oid) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 123456789\n`

test('a commit git fails to list is not taken as seen; one it lists is', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirB, 'README.md', 'committed here\n')
  await waitFor(() => read(dirA, 'README.md') === 'committed here\n')
  const before = B.gitSeen.sha
  git(dirB, 'commit', '-qam', 'bob') // no file changes: no burst sees it
  process.env.QUILT_GIT = failingGit('diff')
  try { await B.noteCommits() } finally { delete process.env.QUILT_GIT }
  assert.equal(B.gitSeen.sha, before, 'what the commit changed is unknown: not taken as the session\'s work')
  await B.noteCommits()
  assert.equal(B.gitSeen.sha, git(dirB, 'rev-parse', 'HEAD'))
})

test('while paused on another branch, a save asks no git (only .git/HEAD is read)', async (t) => {
  const { B, dirB } = await pairRepos(t)
  git(dirB, 'checkout', '-qb', 'feature')
  await waitFor(() => B.status().git.hold?.kind === 'switching')
  const calls = path.join(tmp('calls'), 'log')
  const bin = path.join(tmp('countgit'), 'git')
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${calls}'\nexec git "$@"\n`, { mode: 0o755 })
  process.env.QUILT_GIT = bin
  try {
    for (let i = 0; i < 5; i++) { write(dirB, 'src/app.js', `feature ${i}\n`); await new Promise((resolve) => setTimeout(resolve, 120)) }
    await new Promise((resolve) => setTimeout(resolve, 300))
  } finally { delete process.env.QUILT_GIT }
  assert.equal(B.status().git.hold?.kind, 'switching')
  assert.equal(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '', '', 'no git call while away')
})

test('a pull over a Git LFS file whose filter fails settles; nothing is parked', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t, { '.gitattributes': '*.lfs filter=lfs\n', 'model.lfs': POINTER('aaa') })
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  write(c, 'model.lfs', POINTER('bbb')); write(c, 'README.md', 'hello (remote)\n')
  git(c, 'commit', '-qam', 'new model'); git(c, 'push', '-q', 'origin', 'main')
  git(dirB, 'pull', '-q', '--ff-only')
  // The filter is set now (within the settle time): running it fails.
  git(dirB, 'config', 'filter.lfs.smudge', 'false'); git(dirB, 'config', 'filter.lfs.required', 'true')
  await waitFor(() => B.status().git.hold)
  await waitFor(() => B.status().git.hold === null && read(dirA, 'README.md') === 'hello (remote)\n', 10000)
})

test('a file git fails to read at the old commit settles as a record at worst, not a frozen folder', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  write(c, 'src/app.js', 'line1 (remote)\nline2\nline3\nline4\nline5\n'); git(c, 'commit', '-qam', 'remote'); git(c, 'push', '-q', 'origin', 'main')
  git(dirB, 'pull', '-q', '--ff-only')
  await waitFor(() => B.status().git.hold)
  process.env.QUILT_GIT = failingGit('--filters')
  try {
    await waitFor(() => B.status().git.hold === null, 10000)
  } finally { delete process.env.QUILT_GIT }
  assert.ok(B.logs.some((l) => l.includes('git could not read 1 file')), B.logs.join('\n'))
  await waitFor(() => read(dirA, 'src/app.js') === 'line1 (remote)\nline2\nline3\nline4\nline5\n' || A.mergeList().some((m) => m.path === 'src/app.js' && m.state === 'open'), 10000)
})

test('git status failing during a stash: held, then merged against the last commit, so the room keeps its work', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  process.env.QUILT_GIT = failingGit('status')
  try {
    git(dirB, 'stash', '-q')
    await never(() => read(dirA, 'README.md') !== 'main work\n', 2500)
    await waitFor(() => read(dirB, 'README.md') === 'main work\n' && B.status().git.hold === null, 10000)
  } finally { delete process.env.QUILT_GIT }
  assert.equal(read(dirA, 'README.md'), 'main work\n')
})

test('a new branch with no commits yet (checkout --orphan) is a switch, not git gone missing', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  git(dirB, 'checkout', '-q', '--orphan', 'scratch')
  await waitFor(() => B.status().git.hold?.kind === 'switching')
  assert.ok(B.logs.some((l) => l.includes("You're on scratch; this session syncs main")), B.logs.join('\n'))
  write(dirA, 'README.md', 'main work\n')
  await never(() => read(dirB, 'README.md') === 'main work\n', 1000)
  git(dirB, 'checkout', '-q', 'main')
  await waitFor(() => B.status().git.hold === null && read(dirB, 'README.md') === 'main work\n', 10000)
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

/** A git that answers every call, `secs` seconds late. */
function slowGit (secs) {
  const bin = path.join(tmp('slowgit'), 'git')
  fs.writeFileSync(bin, `#!/bin/sh\nsleep ${secs}\nexec git "$@"\n`, { mode: 0o755 })
  return bin
}

test('a slow git never stalls the app: the folder is held while git is asked, then settles', async (t) => {
  const { B, dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  let last = Date.now(); let worst = 0
  const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now }, 10)
  process.env.QUILT_GIT = slowGit(3)
  try {
    git(dirB, 'stash', '-q')
    // Every git call takes 3 s: the stash is classified, then settled, all the while held.
    await never(() => read(dirA, 'README.md') !== 'main work\n', 5000)
    await waitFor(() => read(dirB, 'README.md') === 'main work\n' && B.status().git.hold === null, 60000)
  } finally { delete process.env.QUILT_GIT; clearInterval(tick) }
  assert.ok(worst < 200, `the event loop stalled for ${worst} ms`)
  assert.equal(read(dirA, 'README.md'), 'main work\n')
  assert.ok(B.logs.some((l) => l.includes('Quilt kept the session\'s work')), B.logs.join('\n'))
})

test('a change from the room while git is asked about a burst is merged with it, not lost', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  process.env.QUILT_GIT = slowGit(1)
  try {
    // bob stages his edit (git writes the index: a burst, asked of git); alice edits another line meanwhile.
    write(dirB, 'src/app.js', 'line1 (bob)\nline2\nline3\nline4\nline5\n'); git(dirB, 'add', 'src/app.js')
    await waitFor(() => B.classifying)
    write(dirA, 'src/app.js', 'line1\nline2\nline3\nline4\nline5 (alice)\n')
    await waitFor(() => B.heldPaths.has('src/app.js'))
    assert.equal(read(dirB, 'src/app.js'), 'line1 (bob)\nline2\nline3\nline4\nline5\n', 'nothing written over bob\'s file while git is asked')
    const both = 'line1 (bob)\nline2\nline3\nline4\nline5 (alice)\n'
    await waitFor(() => read(dirA, 'src/app.js') === both && read(dirB, 'src/app.js') === both, 30000)
  } finally { delete process.env.QUILT_GIT }
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
})

test('new files from the room while git is asked about a burst land as they are: no merge records', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  process.env.QUILT_GIT = slowGit(1)
  const mine = Array.from({ length: 25 }, (_, i) => `bob/f${i}.txt`)
  const theirs = Array.from({ length: 40 }, (_, i) => `alice/f${i}.txt`)
  try {
    for (const rel of mine) write(dirB, rel, `bob ${rel}\n`) // 20 paths or more in a flush: asked of git
    await waitFor(() => B.classifying)
    for (const rel of theirs) write(dirA, rel, `alice ${rel}\n`)
    await waitFor(() => theirs.some((rel) => B.heldPaths.has(rel)))
    await waitFor(() => theirs.every((rel) => read(dirB, rel) === `alice ${rel}\n`) && mine.every((rel) => read(dirA, rel) === `bob ${rel}\n`), 30000)
  } finally { delete process.env.QUILT_GIT }
  await never(() => A.mergeList().some((m) => m.state === 'open') || B.mergeList().some((m) => m.state === 'open'), 1500)
})

test('a resumed hold settles while a partner keeps typing, even with git slow to answer', async (t) => {
  const { A, B, dirA, dirB, room } = await pairRepos(t)
  write(dirA, 'README.md', 'main work\n')
  await waitFor(() => read(dirB, 'README.md') === 'main work\n')
  git(dirB, 'stash', '-q')
  await waitFor(() => B.status().git.hold)
  await close(B)
  process.env.QUILT_GIT = slowGit(1)
  let n = 0
  const typing = setInterval(() => write(dirA, 'src/app.js', `line1 (alice ${++n})\nline2\nline3\nline4\nline5\n`), 150)
  try {
    const B2 = await open(t, dirB, 'bob', { room })
    await waitFor(() => B2.status().git.hold === null && read(dirB, 'README.md') === 'main work\n', 30000)
  } finally { clearInterval(typing); delete process.env.QUILT_GIT }
  const last = read(dirA, 'src/app.js')
  await waitFor(() => read(dirB, 'src/app.js') === last)
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
})

/**
 * The session put two new files in bob's folder (untracked there), and a commit
 * elsewhere adds the same two. Bob also has the room's uncommitted work in README.md.
 * His first pull fetches, then git refuses: untracked files would be overwritten.
 */
async function sessionFilesCommitted (t, { same = true, bobOpts = {} } = {}) {
  const p = await pairRepos(t, {}, bobOpts)
  write(p.dirA, 'README.md', 'hello, edited in the session\n')
  write(p.dirA, 'docs/notes.md', 'notes from the session\n')
  write(p.dirA, 'docs/todo.md', 'todo from the session\n')
  await waitFor(() => read(p.dirB, 'docs/notes.md') && read(p.dirB, 'docs/todo.md') && read(p.dirB, 'README.md') === 'hello, edited in the session\n')
  const c = tmp('c'); git(c, 'clone', '-q', p.bare, '.')
  write(c, 'docs/notes.md', same ? 'notes from the session\n' : 'notes, committed differently\n')
  write(c, 'docs/todo.md', 'todo from the session\n')
  git(c, 'add', '.'); git(c, 'commit', '-qm', 'docs'); git(c, 'push', '-q', 'origin', 'main')
  assert.throws(() => git(p.dirB, '-c', 'pull.rebase=true', 'pull', '-q', '--autostash'), /untracked working tree files would be overwritten/)
  return p
}
const pullingPaths = (B) => (B.status().git.pull?.adds || []).map((a) => `${a.path}:${a.same ? 'same' : 'differs'}${a.waiting ? ':waiting' : ''}`).sort()

test('files the session put here that pulled commits add are named to the AI: the same, and how to pull', async (t) => {
  const { B } = await sessionFilesCommitted(t)
  await waitFor(() => pullingPaths(B).length === 2)
  assert.deepEqual(pullingPaths(B), ['docs/notes.md:same', 'docs/todo.md:same'])
  const notes = B.takeNotices().join('\n')
  assert.match(notes, /docs\/notes\.md/)
  assert.match(notes, /same content/)
  assert.match(notes, /rm docs\/notes\.md docs\/todo\.md && git pull --autostash/)
  const md = renderStatus(B.status())
  assert.match(md, /## Pulling/)
  assert.match(md, /`docs\/todo\.md`: same content as the session's/)
})

test('removing them to make way for the pull never removes them from the session, and the pull lands them', async (t) => {
  const { A, B, dirA, dirB } = await sessionFilesCommitted(t)
  await waitFor(() => pullingPaths(B).length === 2)
  fs.rmSync(path.join(dirB, 'docs/notes.md')); fs.rmSync(path.join(dirB, 'docs/todo.md'))
  await never(() => read(dirA, 'docs/notes.md') === null || read(dirA, 'docs/todo.md') === null, 2500)
  await waitFor(() => pullingPaths(B).every((p) => p.endsWith(':waiting')))
  git(dirB, '-c', 'pull.rebase=true', 'pull', '-q', '--autostash')
  await waitFor(() => read(dirB, 'docs/notes.md') === 'notes from the session\n' && read(dirB, 'docs/todo.md') === 'todo from the session\n')
  await never(() => read(dirA, 'docs/notes.md') === null || read(dirA, 'docs/todo.md') === null, 2500)
  await waitFor(() => read(dirB, 'README.md') === 'hello, edited in the session\n')
  await waitFor(() => pullingPaths(B).length === 0)
  assert.equal(git(dirB, 'status', '--porcelain', '--', 'docs'), '', 'the pulled files are tracked and match')
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  assert.equal(B.mergeList().filter((m) => m.state === 'open').length, 0)
})

test('removed and the pull never comes: shared as a deletion once the wait is over', async (t) => {
  const { B, dirA, dirB } = await sessionFilesCommitted(t, { bobOpts: { pullWaitMs: 2000 } })
  fs.rmSync(path.join(dirB, 'docs/notes.md'))
  await never(() => read(dirA, 'docs/notes.md') === null, 1200)
  await waitFor(() => read(dirA, 'docs/notes.md') === null, 10000)
  assert.ok(B.logs.some((l) => l.includes('No pull came: docs/notes.md is deleted for everyone')), B.logs.join('\n'))
  assert.equal(read(dirA, 'docs/todo.md'), 'todo from the session\n', 'only the removed file goes')
})

test('stashed away with stash -u to make way: kept for the session, not put back before the pull, landed by it', async (t) => {
  const { A, dirA, dirB } = await sessionFilesCommitted(t)
  git(dirB, 'stash', '-u', '-q')
  await new Promise((resolve) => setTimeout(resolve, 3000)) // past a settle: the files must not come back and block the pull
  assert.equal(read(dirB, 'docs/notes.md'), null)
  // The session's work in README.md came back meanwhile, as after any stash: --autostash carries it over the pull.
  git(dirB, '-c', 'pull.rebase=true', 'pull', '-q', '--autostash')
  git(dirB, 'stash', 'drop', '-q')
  await waitFor(() => read(dirB, 'docs/notes.md') === 'notes from the session\n' && read(dirB, 'README.md') === 'hello, edited in the session\n', 10000)
  assert.equal(read(dirA, 'docs/notes.md'), 'notes from the session\n')
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
})

test('a committed file that differs from the session\'s: said so; after the pull the two are merged, a record when they clash', async (t) => {
  const { A, B, dirA, dirB } = await sessionFilesCommitted(t, { same: false })
  await waitFor(() => pullingPaths(B).length === 2)
  assert.deepEqual(pullingPaths(B), ['docs/notes.md:differs', 'docs/todo.md:same'])
  assert.match(B.takeNotices().join('\n'), /docs\/notes\.md differs from the session's/)
  fs.rmSync(path.join(dirB, 'docs/notes.md')); fs.rmSync(path.join(dirB, 'docs/todo.md'))
  git(dirB, '-c', 'pull.rebase=true', 'pull', '-q', '--autostash')
  const rec = await waitFor(() => A.mergeList().find((m) => m.path === 'docs/notes.md' && m.state === 'open'), 10000)
  assert.equal(rec.via, 'pull')
  assert.equal(read(dirA, 'docs/notes.md'), 'notes from the session\n', 'the session keeps its version until someone settles it')
})

/** A third clone pushes `commits` (each a map of path -> text, or null to delete) to the pair's remote. */
function pushCommits (dirA, commits) {
  const c = tmp('c'); git(c, 'clone', '-q', git(dirA, 'remote', 'get-url', 'origin'), '.')
  commits.forEach((files, i) => {
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) git(c, 'rm', '-q', rel)
      else { write(c, rel, text); git(c, 'add', rel) }
    }
    git(c, 'commit', '-qm', `change ${i + 1}`)
  })
  git(c, 'push', '-q', 'origin', 'main')
}

test('a pull is one "pulled" event: no claims, no per-file edits, and its own group in Changes', async (t) => {
  const { A, B, dirA, dirB } = await pairRepos(t)
  pushCommits(dirA, [
    { 'src/app.js': 'line1\nline2\nline3\nline4\nline5\nline6\n', 'docs/new.md': 'new\nfile\n' },
    { 'README.md': null }
  ])
  // Bob's AI is at work, so a hand edit of his would be claimed for him. A pull must not be.
  B.setAgentState({ tool: B.tool, status: 'working' })
  git(dirB, 'pull', '-q', '--ff-only')
  await waitFor(() => read(dirA, 'docs/new.md') === 'new\nfile\n' && read(dirA, 'README.md') === null && read(dirA, 'src/app.js').endsWith('line6\n'), 10000)

  const pulled = await waitFor(() => A.status().activity.find((a) => a.kind === 'pulled'))
  assert.equal(pulled.by, 'bob')
  assert.equal(pulled.detail, '2 commits from main · 3 files')
  assert.ok(!A.status().activity.some((a) => a.by === 'bob' && a.kind !== 'pulled'), 'no per-file entries for what the pull brought')
  await never(() => A.status().claims.some((c) => c.by === 'bob'), 1500)

  const bob = A.changes().people.find((p) => p.name === 'bob')
  assert.deepEqual(bob.files.filter((f) => f.path !== '.gitignore'), [], 'a pull is not bob\'s own work (Quilt\'s .quilt/ line in .gitignore aside)')
  assert.equal(bob.pulled.fileCount, 3)
  assert.deepEqual(bob.pulled.files.map((f) => [f.path, f.kind]).sort(), [['README.md', 'deleted'], ['docs/new.md', 'created'], ['src/app.js', 'edited']])
  assert.equal(bob.pulled.added, 3)
  assert.equal(bob.pulled.removed, 1)
  assert.ok(A.changes().files.find((f) => f.path === 'src/app.js').by.every((b) => b.pulled === true))

  const md = renderStatus(A.status())
  assert.match(md, /bob pulled 2 commits from main · 3 files/)
  assert.match(md, /\*\*bob\*\* pulled from git: 3 files, \+3 -1/)
  assert.doesNotMatch(md, /bob edited `src\/app\.js`/)
  const h = A.historyQuery({ path: 'src/app.js' }).find((e) => e.by === 'bob')
  assert.equal(h.pulled, true, 'the chronology says the change came from a pull')

  // A hand edit afterwards is bob's own again, claimed while his AI works.
  write(dirB, 'src/app.js', 'line1\nline2\nline3\nline4\nline5\nline6\nline7 by bob\n')
  B.ingest('src/app.js')
  await waitFor(() => A.status().claims.some((c) => c.by === 'bob' && c.pattern === 'src/app.js'))
  const after = await waitFor(() => { const p = A.changes().people.find((x) => x.name === 'bob'); return p.files.some((f) => f.path === 'src/app.js') && p })
  assert.deepEqual(after.files.filter((f) => f.path === 'src/app.js').map((f) => [f.path, f.added]), [['src/app.js', 1]])
  assert.equal(after.pulled.fileCount, 3)
})

test('a commit of your own is not a pull: nothing is recorded when HEAD moves over work already shared', async (t) => {
  const { A, B, dirB } = await pairRepos(t)
  write(dirB, 'src/app.js', 'line1\nline2 edited\nline3\nline4\nline5\n')
  const bobsOwn = (S) => (S.changes().people.find((p) => p.name === 'bob')?.files || []).filter((f) => f.path !== '.gitignore') // Quilt's .quilt/ line aside
  await waitFor(() => bobsOwn(A).some((f) => f.path === 'src/app.js'))
  git(dirB, 'commit', '-qam', 'mine')
  await never(() => A.status().activity.some((a) => a.kind === 'pulled'), 3000)
  assert.equal(B.changes().people.find((p) => p.name === 'bob').pulled, null)
})
