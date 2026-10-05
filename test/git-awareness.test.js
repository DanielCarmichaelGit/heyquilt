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
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), ...extra })
  t.after(() => close(s))
  if (process.env.GA_DEBUG) { s.on('log', (m) => console.error(`[${name}] ${m}`)); s.on('hold', (h) => console.error(`[${name}] hold ${JSON.stringify(h)}`)) }
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: s.tool, status: 'idle' }) // people typing by hand; their edits are not claimed for them
  return s
}
process.env.QUILT_MERGE_CMD = `${process.execPath} ${path.join(tmp('cli'), 'no.mjs')}`
fs.writeFileSync(process.env.QUILT_MERGE_CMD.split(' ')[1], "process.stdout.write('CONFLICT: no\\n')")

let rooms = 0
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 0xfe])
const LOGO2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 2, 0xfe, 0xff])
const readBuf = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel)) } catch { return null } }

/** A bare remote, two clones (alice, bob) with one commit, both in a fresh room. `extra`: more files for the commit. */
async function pairRepos (t, extra = {}) {
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
  const B = await open(t, dirB, 'bob', { room })
  await waitFor(() => A.status().connected && B.status().connected)
  return { A, B, dirA, dirB, bare, room }
}

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

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
  assert.ok(B.logs.some((l) => l.includes('Quilt kept the session\'s work')), B.logs.join('\n'))
  assert.equal(git(dirB, 'stash', 'list').split('\n').filter(Boolean).length, 1, 'the stash is untouched')
})

test('reset --hard by an agent is the same', async (t) => {
  const { dirA, dirB } = await pairRepos(t)
  write(dirA, 'README.md', 'hello from alice\n')
  await waitFor(() => read(dirB, 'README.md') === 'hello from alice\n')
  git(dirB, 'reset', '-q', '--hard')
  await never(() => read(dirA, 'README.md') !== 'hello from alice\n', 2500)
  await waitFor(() => read(dirB, 'README.md') === 'hello from alice\n', 8000)
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
  git(dirB, 'stash', '-q'); git(dirB, 'pull', '-q', '--ff-only')
  // The pop clashes on README.md (git exits 1, leaving its markers in the file); src/app.js pops cleanly.
  assert.throws(() => git(dirB, 'stash', 'pop', '-q'))
  await waitFor(() => read(dirA, 'src/app.js') === 'line1 (remote)\nline2\nline3\nline4\nline5 (alice)\n', 10000)
  const rec = await waitFor(() => A.mergeList().find((m) => m.path === 'README.md' && m.state === 'open'), 10000)
  assert.equal(rec.kind, 'conflict')
  assert.equal(read(dirA, 'README.md'), 'hello (alice)\n', 'git\'s markers never reach the room')
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
  const B2 = await open(t, dirB, 'bob', { room })
  await never(() => read(dirA, 'README.md') !== 'main work\n', 1500)
  await waitFor(() => read(dirB, 'README.md') === 'main work\n' && B2.status().git.hold === null, 10000)
  assert.equal(read(dirA, 'README.md'), 'main work\n')
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
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(dirB, '.quilt', 'state.json'), 'utf8')).gitHeld === true, 3000)
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
})
