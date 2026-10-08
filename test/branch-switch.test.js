// A folder following a checkout made in git, with a real relay and real git: the folder
// moves to that branch's document (made from the folder the first time), the branch it
// left keeps its work in the session, and the two never mix. Quilt itself never switches.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { MAX_BRANCHES } from '../src/branchdocs.js'

let srv, server
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-bs-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
async function waitFor (fn, ms = 8000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
async function never (fn, ms = 1500) {
  const start = Date.now()
  while (Date.now() - start < ms) { assert.ok(!(await fn()), 'happened but must not'); await new Promise((r) => setTimeout(r, 25)) }
}
process.env.HOME = process.env.USERPROFILE = tmp('home')
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
const stopped = new Set()
const close = async (s) => { if (!stopped.has(s)) { stopped.add(s); await s.stop() } }
async function open (t, dir, name, extra) {
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), ...extra })
  t.after(() => close(s))
  if (process.env.BS_DEBUG) s.on('log', (m) => console.error(`[${name}] ${m}`))
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: s.tool, status: 'idle' }) // people typing by hand
  return s
}
let rooms = 0
const MAIN_APP = 'app\n'

/** A remote with main (README.md, src/app.js) and feature-x (adds feature.txt, changes README.md); alice and bob on main in one room. */
async function repos (t) {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const seed = tmp('seed'); git(seed, 'clone', '-q', bare, '.')
  write(seed, 'README.md', 'hello\n'); write(seed, 'src/app.js', MAIN_APP)
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'main')
  git(seed, 'checkout', '-qb', 'feature-x'); write(seed, 'README.md', 'feature readme\n'); write(seed, 'feature.txt', 'feature\n')
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'f'); git(seed, 'push', '-q', 'origin', 'feature-x')
  const dirA = tmp('a'); git(dirA, 'clone', '-q', bare, '.')
  const dirB = tmp('b'); git(dirB, 'clone', '-q', bare, '.')
  const room = `bs${++rooms}`
  const A = await open(t, dirA, 'alice', { room })
  const B = await open(t, dirB, 'bob', { room })
  await waitFor(() => A.status().connected && B.status().connected)
  return { A, B, dirA, dirB, bare, room }
}
const on = (s, branch) => s.status().branch === branch && s.status().git && s.status().git.hold === null

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

test('a checkout in git moves that folder to the branch\'s document; the two branches never mix', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => on(A, 'feature-x'), 10000)
  assert.ok(A.logs.some((l) => l.includes("You're on feature-x now (you switched in git)")), A.logs.join('\n'))
  assert.equal(read(dirA, 'feature.txt'), 'feature\n')
  assert.equal(read(dirA, 'README.md'), 'feature readme\n')
  assert.equal(A.files.get('feature.txt')?.toString(), 'feature\n', 'the new branch\'s document is made from the folder')
  write(dirB, 'src/app.js', 'main edit\n')
  write(dirA, 'feature.txt', 'feature edit\n')
  await waitFor(() => A.files.get('feature.txt')?.toString() === 'feature edit\n' && B.files.get('src/app.js')?.toString() === 'main edit\n')
  await never(() => read(dirA, 'src/app.js') === 'main edit\n' || read(dirB, 'feature.txt') !== null, 2000)
  assert.equal(B.status().branch, 'main')
  assert.equal(read(dirB, 'README.md'), 'hello\n', 'main keeps its own README')
  // The room sees the move; partners see the branch in presence; the upstream is the new branch's.
  await waitFor(() => B.activity.toArray().some((e) => e.kind === 'switched' && e.by === 'alice' && e.branch === 'feature-x' && e.from === 'main'))
  await waitFor(() => [...B.conn.awareness.getStates().values()].some((st) => st.name === 'alice' && st.branch === 'feature-x'))
  await waitFor(() => A.upstream && A.upstream.name === 'origin/feature-x', 10000)
})

test('two folders on the same branch pair live there', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => on(A, 'feature-x'), 10000)
  write(dirA, 'feature.txt', 'from alice\n')
  await waitFor(() => A.files.get('feature.txt')?.toString() === 'from alice\n')
  git(dirB, 'checkout', '-q', 'feature-x')
  await waitFor(() => on(B, 'feature-x') && read(dirB, 'feature.txt') === 'from alice\n', 10000)
  write(dirB, 'feature.txt', 'from bob\n')
  await waitFor(() => read(dirA, 'feature.txt') === 'from bob\n')
})

test('checking out main again brings the room\'s work on main, including edits made while away', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => on(A, 'feature-x'), 10000)
  write(dirB, 'README.md', 'bob on main\n')
  await waitFor(() => B.files.get('README.md')?.toString() === 'bob on main\n')
  await never(() => read(dirA, 'README.md') !== 'feature readme\n', 500)
  git(dirA, 'checkout', '-q', 'main')
  await waitFor(() => on(A, 'main') && read(dirA, 'README.md') === 'bob on main\n', 10000)
  assert.equal(read(dirA, 'feature.txt'), null)
  assert.equal(A.files.get('README.md')?.toString(), 'bob on main\n')
  assert.equal(A.mergeList().filter((m) => m.state === 'open').length, 0)
  write(dirA, 'src/app.js', 'back on main\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'back on main\n')
})

test('on a branch the session has, what git carried over gets that branch\'s version: a partner\'s main work never reaches feature-x', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  git(dirA, 'checkout', '-q', 'feature-x') // feature-x is in the session from here
  await waitFor(() => on(A, 'feature-x'), 10000)
  git(dirA, 'checkout', '-q', 'main')
  await waitFor(() => on(A, 'main'), 10000)
  write(dirB, 'src/app.js', 'bob on main\n') // the same file in both commits: git carries Quilt's copy over
  write(dirB, 'notes.txt', 'bob notes\n') // untracked: carried too
  await waitFor(() => read(dirA, 'src/app.js') === 'bob on main\n' && read(dirA, 'notes.txt') === 'bob notes\n')
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => on(A, 'feature-x'), 10000)
  assert.equal(read(dirA, 'src/app.js'), MAIN_APP, 'feature-x\'s version is on disk')
  assert.equal(read(dirA, 'notes.txt'), null, 'neither feature-x nor its commit has it')
  assert.ok(A.logs.some((l) => l.includes("git had carried main's uncommitted work in")), A.logs.join('\n'))
  await never(() => A.files.get('src/app.js')?.toString() !== MAIN_APP || A.files.has('notes.txt'), 1500)
  assert.equal(read(dirB, 'src/app.js'), 'bob on main\n', 'main keeps it')
  assert.equal(B.files.get('notes.txt')?.toString(), 'bob notes\n')
  git(dirA, 'checkout', '-q', 'main')
  await waitFor(() => on(A, 'main') && read(dirA, 'src/app.js') === 'bob on main\n' && read(dirA, 'notes.txt') === 'bob notes\n', 10000)
})

test('a deletion git carries over stays on the old branch: feature-x keeps the file', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  git(dirA, 'checkout', '-q', 'feature-x') // feature-x is in the session from here
  await waitFor(() => on(A, 'feature-x'), 10000)
  git(dirA, 'checkout', '-q', 'main')
  await waitFor(() => on(A, 'main'), 10000)
  fs.rmSync(path.join(dirB, 'src/app.js')) // the same in both commits: git carries the deletion over
  await waitFor(() => read(dirA, 'src/app.js') === null)
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => on(A, 'feature-x') && read(dirA, 'src/app.js') === MAIN_APP, 10000)
  await never(() => A.files.get('src/app.js')?.toString() !== MAIN_APP, 1000)
  assert.equal(B.files.has('src/app.js'), false, 'main keeps the deletion')
})

test('carried work edited before the move finished: only that edit reaches feature-x, never the partner\'s main work', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  git(dirA, 'checkout', '-q', 'feature-x') // feature-x is in the session from here
  await waitFor(() => on(A, 'feature-x'), 10000)
  git(dirA, 'checkout', '-q', 'main')
  await waitFor(() => on(A, 'main'), 10000)
  write(dirB, 'src/app.js', 'app\nbob line\n') // bob's uncommitted main work, on alice's disk too
  await waitFor(() => read(dirA, 'src/app.js') === 'app\nbob line\n')
  const release = holdJoin(A)
  git(dirA, 'checkout', '-q', 'feature-x') // carries src/app.js over
  await waitFor(() => A.status().git.hold?.kind === 'switching', 10000)
  write(dirA, 'src/app.js', 'alice line\napp\nbob line\n') // edited while the move is held
  await new Promise((resolve) => setTimeout(resolve, 300))
  release()
  await waitFor(() => on(A, 'feature-x') && A.files.get('src/app.js')?.toString() === 'alice line\napp\n', 10000)
  assert.equal(read(dirA, 'src/app.js'), 'alice line\napp\n')
  await never(() => (A.files.get('src/app.js')?.toString() || '').includes('bob line'), 1000)
  assert.equal(B.files.get('src/app.js')?.toString(), 'app\nbob line\n', 'main keeps bob\'s work, without alice\'s feature edit')
})

/** Holds A's next branch join until the returned function is called (the move waits there, held). */
function holdJoin (A) {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const join = A.conn.joinBranch.bind(A.conn)
  A.conn.joinBranch = async (...args) => { await gate; A.conn.joinBranch = join; return join(...args) }
  return release
}
const copiesOf = (dir, rel) => {
  const root = path.join(dir, '.quilt', 'conflicts')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).map((d) => read(path.join(root, d), rel)).filter((x) => x !== null)
}

test('carried work edited after the checkout that clashes with the branch is set aside: no merge record, nothing of main in feature-x', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => on(A, 'feature-x'), 10000)
  write(dirA, 'src/app.js', 'feature app\n') // feature-x's own work on the file
  await waitFor(() => A.files.get('src/app.js')?.toString() === 'feature app\n')
  git(dirA, 'checkout', '-q', 'main')
  await waitFor(() => on(A, 'main') && read(dirA, 'src/app.js') === MAIN_APP, 10000)
  write(dirB, 'src/app.js', 'app\nbob line\n')
  await waitFor(() => read(dirA, 'src/app.js') === 'app\nbob line\n')
  const release = holdJoin(A)
  git(dirA, 'checkout', '-q', 'feature-x') // carries bob's main work over
  await waitFor(() => A.status().git.hold?.kind === 'switching', 10000)
  write(dirA, 'src/app.js', 'app\nbob line\nalice line\n') // an edit after switching, on top of it
  await new Promise((resolve) => setTimeout(resolve, 300))
  release()
  await waitFor(() => on(A, 'feature-x') && read(dirA, 'src/app.js') === 'feature app\n' && A.logs.some((l) => l.includes('clashed with feature-x')), 10000)
  assert.ok(A.notices.some((n) => n.includes('Your edit to src/app.js after switching to feature-x clashed')), A.notices.join('\n'))
  assert.ok(copiesOf(dirA, 'src/app.js').includes('app\nbob line\nalice line\n'), 'the folder\'s copy is kept')
  await never(() => A.files.get('src/app.js')?.toString() !== 'feature app\n' || A.mergeList().length, 1000)
  assert.equal(B.files.get('src/app.js')?.toString(), 'app\nbob line\n')
})

test('the same clash on a file feature-x\'s document hasn\'t: HEAD\'s file goes back, never deleted', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => on(A, 'feature-x'), 10000)
  fs.rmSync(path.join(dirA, 'src/app.js')) // the session deletes it on feature-x (it stays in the commit)
  await waitFor(() => !A.files.has('src/app.js'))
  git(dirA, 'checkout', '-q', 'main')
  await waitFor(() => on(A, 'main') && read(dirA, 'src/app.js') === MAIN_APP, 10000)
  write(dirB, 'src/app.js', 'app\nbob line\n')
  await waitFor(() => read(dirA, 'src/app.js') === 'app\nbob line\n')
  const release = holdJoin(A)
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => A.status().git.hold?.kind === 'switching', 10000)
  write(dirA, 'src/app.js', 'app\nbob line\nalice line\n')
  await new Promise((resolve) => setTimeout(resolve, 300))
  release()
  await waitFor(() => on(A, 'feature-x') && A.logs.some((l) => l.includes('clashed with feature-x')), 10000)
  assert.equal(read(dirA, 'src/app.js'), MAIN_APP, 'HEAD\'s committed file, not deleted')
  assert.ok(copiesOf(dirA, 'src/app.js').includes('app\nbob line\nalice line\n'))
  await never(() => A.files.has('src/app.js') || A.mergeList().length || read(dirA, 'src/app.js') !== MAIN_APP, 1000)
  assert.equal(B.files.get('src/app.js')?.toString(), 'app\nbob line\n')
})

test('a checkout while the relay is unreachable moves the folder as soon as it reconnects', async (t) => {
  const { A, dirA } = await repos(t)
  git(dirA, 'checkout', '-q', 'feature-x') // feature-x is in the session from here
  await waitFor(() => on(A, 'feature-x'), 10000)
  git(dirA, 'checkout', '-q', 'main')
  await waitFor(() => on(A, 'main'), 10000)
  const reconnect = A.conn.connect.bind(A.conn)
  A.conn.connect = () => {} // stays offline until the test reconnects it
  A.conn.ws.terminate()
  await waitFor(() => !A.status().connected)
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => A.status().git.hold?.waiting === 'retrying', 10000)
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(A.moveTries, 0, 'failing offline is no try')
  A.conn.connect = reconnect
  reconnect()
  await waitFor(() => on(A, 'feature-x') && read(dirA, 'feature.txt') === 'feature\n', 5000) // well within the 30 s retry
})

test('git checkout -b: a branch new to the session starts from the folder, its uncommitted work included', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  write(dirA, 'src/app.js', 'wip\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'wip\n')
  git(dirA, 'checkout', '-qb', 'try-it')
  await waitFor(() => on(A, 'try-it'), 10000)
  assert.equal(read(dirA, 'src/app.js'), 'wip\n')
  assert.equal(A.files.get('src/app.js')?.toString(), 'wip\n')
  await waitFor(() => A.branchList.some((b) => b.key === 'try-it'))
  write(dirA, 'src/app.js', 'wip 2\n')
  await waitFor(() => A.files.get('src/app.js')?.toString() === 'wip 2\n')
  await never(() => read(dirB, 'src/app.js') !== 'wip\n', 1500)
})

test('a checkout straight back: nothing of either branch ends up in the other', async (t) => {
  const { A, B, dirA, dirB, room } = await repos(t)
  git(dirB, 'checkout', '-q', 'feature-x') // feature-x is in the session
  await waitFor(() => on(B, 'feature-x'), 10000)
  git(dirB, 'checkout', '-q', 'main')
  await waitFor(() => on(B, 'main'), 10000)
  write(dirB, 'src/app.js', 'main work\n')
  await waitFor(() => read(dirA, 'src/app.js') === 'main work\n')
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => A.status().git.hold?.kind === 'switching', 10000) // the folder has started moving
  git(dirA, 'checkout', '-q', 'main') // back before it got there
  await waitFor(() => on(A, 'main') && read(dirA, 'src/app.js') === 'main work\n', 15000)
  await never(() => !on(A, 'main'), 1500)
  assert.equal(read(dirA, 'feature.txt'), null)
  assert.equal(read(dirA, 'README.md'), 'hello\n')
  assert.equal(A.files.has('feature.txt'), false)
  assert.equal(A.files.get('README.md')?.toString(), 'hello\n')
  assert.equal(B.files.has('feature.txt'), false)
  const fx = srv.rooms.get(room).store.load('feature-x').doc.getMap('files')
  assert.equal(fx.get('src/app.js')?.toString(), MAIN_APP, 'main\'s work is not in feature-x')
  assert.equal(fx.get('feature.txt')?.toString(), 'feature\n')
  write(dirA, 'src/app.js', 'still live\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'still live\n')
})

test('a branch the relay refuses is said once; checking the old branch back out resumes sync', async (t) => {
  const { A, B, dirA, dirB, room } = await repos(t)
  const r = srv.rooms.get(room)
  let i = 0
  while (Object.keys(r.meta.branches).length < MAX_BRANCHES) r.noteBranch(`filler-${i++}`)
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => A.status().git.hold?.waiting === 'refused', 10000)
  const said = A.logs.filter((l) => l.includes("The session can't take feature-x"))
  assert.equal(said.length, 1, A.logs.join('\n'))
  assert.match(said[0], /check out main again in git to keep syncing there/)
  assert.ok(A.notices.some((n) => n.includes("The session can't take feature-x")))
  write(dirB, 'src/app.js', 'bob meanwhile\n')
  await never(() => read(dirA, 'src/app.js') === 'bob meanwhile\n' || B.files.has('feature.txt'), 1500)
  git(dirA, 'checkout', '-q', 'main')
  await waitFor(() => on(A, 'main') && read(dirA, 'src/app.js') === 'bob meanwhile\n', 10000)
  write(dirA, 'README.md', 'alice again\n')
  await waitFor(() => read(dirB, 'README.md') === 'alice again\n')
  assert.equal(B.files.has('feature.txt'), false)
})

test('a checkout git refuses mid-merge changes nothing', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  write(dirA, 'README.md', 'mine\n')
  await waitFor(() => read(dirB, 'README.md') === 'mine\n')
  git(dirA, 'commit', '-qam', 'mine')
  assert.throws(() => git(dirA, 'merge', '-q', 'origin/feature-x')) // README.md clashes
  await waitFor(() => A.status().git.hold?.kind === 'busy', 10000)
  assert.throws(() => git(dirA, 'checkout', '-q', 'feature-x'), /resolve your current index first|needs merge/)
  assert.equal(git(dirA, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  await never(() => A.status().branch !== 'main' || (read(dirB, 'README.md') || '').includes('<<<<<<<'), 1500)
  git(dirA, 'merge', '--abort')
  await waitFor(() => on(A, 'main'), 10000)
  write(dirA, 'src/app.js', 'still live\n')
  await waitFor(() => read(dirB, 'src/app.js') === 'still live\n')
  assert.equal(B.status().branch, 'main')
})
