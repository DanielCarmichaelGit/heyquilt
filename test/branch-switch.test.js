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

test('uncommitted work git carries over lands on the branch git puts it on; the old branch\'s work is untouched', async (t) => {
  const { A, B, dirA, dirB } = await repos(t)
  git(dirA, 'checkout', '-q', 'feature-x') // feature-x is in the session from here
  await waitFor(() => on(A, 'feature-x'), 10000)
  git(dirA, 'checkout', '-q', 'main')
  await waitFor(() => on(A, 'main'), 10000)
  write(dirA, 'src/app.js', 'main work\n') // the same in both commits: git carries it over
  await waitFor(() => read(dirB, 'src/app.js') === 'main work\n')
  git(dirA, 'checkout', '-q', 'feature-x')
  await waitFor(() => on(A, 'feature-x'), 10000)
  assert.equal(read(dirA, 'src/app.js'), 'main work\n', 'where git put it')
  await waitFor(() => A.files.get('src/app.js')?.toString() === 'main work\n')
  assert.ok(A.logs.some((l) => l.includes('git kept your uncommitted changes to src/app.js from main')), A.logs.join('\n'))
  write(dirA, 'src/app.js', 'feature edit\n')
  await waitFor(() => A.files.get('src/app.js')?.toString() === 'feature edit\n')
  await never(() => read(dirB, 'src/app.js') !== 'main work\n' || B.files.get('src/app.js')?.toString() !== 'main work\n', 1500)
  assert.equal(read(dirB, 'README.md'), 'hello\n')
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
