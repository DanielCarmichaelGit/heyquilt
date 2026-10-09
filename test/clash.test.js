// A clash between commits from outside and the session's uncommitted work is
// handed to ONE AI as a task, instead of every folder behind telling its AI to
// pull and resolve. Real relay, real git; the pure parts at the end.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { clashTaskId, clashCandidates, pickClashOwner, clashTitle, ownerLabel } from '../src/clash.js'
import { branchesMarkdown, upstreamLine } from '../src/branches.js'

process.env.QUILT_UPSTREAM_MS = '400' // look often: the tests wait on it
const { startServer } = await import('../src/server.js')
const { Session } = await import('../src/session.js')
const { generateIdentity } = await import('../src/identity.js')

let srv, server
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-clash-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV }).trim()
async function waitFor (fn, ms = 10000) {
  const start = Date.now(); let last
  while (Date.now() - start < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e }; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
const ids = new Map()
const identityOf = (n) => { if (!ids.has(n)) ids.set(n, generateIdentity()); return ids.get(n) }
async function open (t, dir, name, extra) {
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), ...extra })
  s.logs = []
  s.on('log', (m) => { s.logs.push(m); if (process.env.UP_DEBUG) console.error(`[${name}] ${m}`) })
  t.after(() => s.stop())
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: s.tool, status: 'idle' })
  return s
}

const APP = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n'
let rooms = 0
/** A bare remote, a pusher clone, and alice and bob in a room (sessions `extra` options). */
async function setup (t, extra = {}) {
  const bare = tmp('bare'); git(bare, 'init', '-q', '--bare', '-b', 'main')
  const pusher = tmp('pusher'); git(pusher, 'clone', '-q', bare, '.')
  write(pusher, 'src/app.js', APP); write(pusher, 'README.md', 'hello\n')
  git(pusher, 'add', '.'); git(pusher, 'commit', '-qm', 'one'); git(pusher, 'push', '-q', 'origin', 'main')
  const dirA = tmp('a'); git(dirA, 'clone', '-q', bare, '.')
  const dirB = tmp('b'); git(dirB, 'clone', '-q', bare, '.')
  const room = `clash${++rooms}`
  const A = await open(t, dirA, 'alice', { room, ...extra })
  const B = await open(t, dirB, 'bob', { room, ...extra })
  await waitFor(() => A.status().connected && B.status().connected)
  const push = (rel, text, msg = 'more') => { write(pusher, rel, text); git(pusher, 'add', '.'); git(pusher, 'commit', '-qm', msg); git(pusher, 'push', '-q', 'origin', 'main'); return git(pusher, 'rev-parse', 'HEAD') }
  return { A, B, dirA, dirB, push }
}

/** Alice's uncommitted change to line2 and a pushed commit changing line2 too: a clash in both folders. */
async function clash ({ A, B, dirA, dirB, push }) {
  const mine = APP.replace('line2', 'line2 (alice)')
  write(dirA, 'src/app.js', mine)
  await waitFor(() => read(dirB, 'src/app.js') === mine)
  const sha = push('src/app.js', APP.replace('line2', 'line2 (pushed)'))
  await waitFor(() => A.status().git.upstream?.conflicts?.length === 1 && B.status().git.upstream?.conflicts?.length === 1, 15000)
  return { sha, mine }
}
const clashTasks = (s) => s.taskList().filter((t) => /^Bring \d+ commits? from origin\/main into the session/.test(t.title))
const lowest = (A, B) => A.conn.awareness.clientID < B.conn.awareness.clientID ? [A, B] : [B, A]

/** Resolves the clash by hand in `dir` the way the task says: git pull, resolve, git add. */
async function resolveIn (s, dir, text) {
  git(dir, 'stash', 'push', '-q', '-m', 'clash-test')
  git(dir, 'pull', '-q', '--ff-only')
  try { git(dir, 'stash', 'pop', '-q') } catch {}
  await waitFor(() => s.status().git.hold?.conflict)
  write(dir, 'src/app.js', text)
  git(dir, 'add', 'src/app.js')
  git(dir, 'stash', 'drop', '-q')
}

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 }); server = `ws://127.0.0.1:${srv.port}` })
after(async () => { await srv.close() })

test('a clash seen by two folders becomes one task, for one AI; the other folder is told to leave it to them', async (t) => {
  const ctx = await setup(t)
  const { A, B } = ctx
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  const [owner, other] = lowest(A, B)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1 && other.status().git.upstream.mergedBy)
  await new Promise((r) => setTimeout(r, 1500)) // a few more looks: still one
  for (const s of [A, B]) assert.equal(clashTasks(s).length, 1)
  const task = clashTasks(A)[0]
  assert.equal(task.id, id)
  assert.equal(task.title, 'Bring 1 commit from origin/main into the session: src/app.js clashes')
  assert.equal(task.assignee, owner.name)
  assert.equal(task.forAi, true)
  assert.equal(task.column, 'todo')
  assert.deepEqual(task.files, ['src/app.js'])
  assert.match(task.comments[0].text, /src\/app\.js: changed in the same lines here and in the new commits/)
  assert.match(task.comments[0].text, /run git pull, resolve those files and git add them/)
  // The owner's AI is told the merge is its own; the other's to leave it alone, not to pull.
  const ownerTold = owner.takeNotices().join('\n')
  assert.match(ownerTold, /Run git pull in this folder and resolve those/)
  assert.match(ownerTold, new RegExp(`This merge is yours: task ${id}`))
  const otherTold = other.takeNotices().join('\n')
  assert.match(otherTold, new RegExp(`${owner.name}'s AI is merging the commits from origin/main \\(task ${id}\\); leave those files to them\\.`))
  assert.doesNotMatch(otherTold, /Run git pull/)
  // The branch list says who is merging it, for everyone.
  const row = other.status().branches.find((b) => b.name === 'main')
  assert.match(branchesMarkdown([row]), new RegExp(`being merged by ${owner.name}'s AI \\(task ${id}\\)`))
  assert.match(upstreamLine(other.status().git.upstream), /being merged by/)
})

test('resolving it in the assignee\'s folder closes the task; the other folder follows without merging again', async (t) => {
  const ctx = await setup(t)
  const { A, B, dirA, dirB } = ctx
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  const ownerName = clashTasks(A)[0].assignee
  const [owner, ownerDir, other, otherDir] = ownerName === 'alice' ? [A, dirA, B, dirB] : [B, dirB, A, dirA]
  const resolved = APP.replace('line2', 'line2 (pushed, and alice)')
  await resolveIn(owner, ownerDir, resolved)
  await waitFor(() => read(otherDir, 'src/app.js') === resolved, 10000)
  await waitFor(() => clashTasks(other).find((x) => x.id === id)?.column === 'done', 15000)
  const done = clashTasks(other).find((x) => x.id === id)
  assert.match(done.verified, new RegExp(`^Brought in at ${sha.slice(0, 7)}: `))
  // The other folder moves to the same commit, following the owner's folder, with no clash and no notice to pull.
  await waitFor(() => git(otherDir, 'rev-parse', 'HEAD') === sha && other.status().git.upstream?.behind === 0, 15000)
  assert.equal(read(otherDir, 'src/app.js'), resolved)
  assert.ok(other.logs.some((m) => /follows .*'s folder to/.test(m)), 'followed the owner\'s folder')
  assert.ok(!other.logs.some((m) => /brought in \d+ commit/.test(m)), 'no merge of its own')
  assert.doesNotMatch(other.takeNotices().join('\n'), /Run git pull/)
  assert.equal(other.status().git.upstream.mergedBy, null)
  assert.equal(clashTasks(A).length, 1)
})

test('when the assignee leaves the session, the clash task goes to the next member after a while', async (t) => {
  const ctx = await setup(t, { clashReassignMs: 1500 })
  const { A, B } = ctx
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  const ownerName = clashTasks(A)[0].assignee
  const [owner, other] = ownerName === 'alice' ? [A, B] : [B, A]
  other.takeNotices()
  const left = Date.now()
  await owner.stop()
  await waitFor(() => clashTasks(other)[0]?.assignee === other.name, 15000)
  assert.ok(Date.now() - left >= 1400, 'not before the assignee had been away a while')
  const task = clashTasks(other)[0]
  assert.equal(task.id, id)
  assert.equal(task.forAi, true)
  assert.match(task.comments.at(-1).text, new RegExp(`^Handed to ${other.name}'s AI: ${owner.name} has been away`))
  assert.match(other.takeNotices().join('\n'), new RegExp(`This merge is yours: task ${id}`))
  assert.equal(clashTasks(other).length, 1)
})

test('two members that race to hand out the same clash write one task', async (t) => {
  const ctx = await setup(t)
  const { A, B } = ctx
  // Each sees only itself reporting the clash (the other's presence not here yet): both take it.
  const hide = (s, name) => {
    const real = s.conn.awareness.getStates.bind(s.conn.awareness)
    s.conn.awareness.getStates = () => new Map([...real()].filter(([, st]) => !st || st.name !== name))
    return () => { s.conn.awareness.getStates = real }
  }
  const showA = hide(A, 'bob')
  const showB = hide(B, 'alice')
  // Neither looks until both folders report the clash; then both look in the same moment.
  A.reviewClash = B.reviewClash = () => null
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  delete A.reviewClash; delete B.reviewClash
  const [a, b] = [A.reviewClash(), B.reviewClash()]
  assert.deepEqual([a.task, a.mine, b.task, b.mine], [id, true, id, true], 'both took it')
  showA(); showB()
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1 && clashTasks(A)[0].assignee === clashTasks(B)[0].assignee)
  await new Promise((r) => setTimeout(r, 1500))
  assert.deepEqual(clashTasks(A).map((x) => x.id), [id])
  assert.deepEqual(clashTasks(B).map((x) => x.id), [id])
  // The one that lost is told who has it after all.
  const winner = clashTasks(A)[0].assignee
  const loser = winner === 'alice' ? B : A
  await waitFor(() => loser.status().git.upstream?.mergedBy === `${winner}'s AI`)
  assert.match(loser.takeNotices().join('\n'), new RegExp(`${winner}'s AI is merging the commits from origin/main \\(task ${id}\\)`))
})

test('newer commits on the upstream update the open clash task instead of adding another', async (t) => {
  const ctx = await setup(t)
  const { A, B, push } = ctx
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  const sha2 = push('README.md', 'hello again\n', 'readme')
  await waitFor(() => clashTasks(A)[0]?.title === 'Bring 2 commits from origin/main into the session: src/app.js clashes', 15000)
  await waitFor(() => A.clashes.get('main')?.sha === sha2)
  await new Promise((r) => setTimeout(r, 1000))
  assert.deepEqual(clashTasks(A).map((x) => x.id), [id])
  assert.deepEqual(clashTasks(B).map((x) => x.id), [id])
  assert.match(clashTasks(A)[0].comments.at(-1).text, new RegExp(`origin/main moved on to ${sha2.slice(0, 7)}`))
})

// ---------------------------------------------------------------- pure --

test('the owner: an agent member first, then a person with an AI, then the lowest client id', () => {
  const st = (name, extra = {}) => ({ name, git: { branch: 'main', upstream: { name: 'origin/main', conflicts: 1 } }, ...extra })
  const states = [
    [1, st('ann')],
    [5, st('cat', { agent: { tool: 'Cursor' } })],
    [7, st('bot', { kind: 'agent' })],
    [2, st('dan', { git: { branch: 'feature', upstream: { name: 'origin/main', conflicts: 1 } } })],
    [3, st('eve', { git: { branch: 'main', upstream: { name: 'origin/main', conflicts: 0 } } })]
  ]
  const c = clashCandidates(states, { branch: 'main', upstream: 'origin/main' })
  assert.deepEqual(c.map((x) => x.name).sort(), ['ann', 'bot', 'cat'])
  assert.equal(pickClashOwner(c).name, 'bot')
  assert.equal(pickClashOwner(c, { except: ['bot'] }).name, 'cat')
  assert.equal(pickClashOwner(c, { except: ['bot', 'cat'] }).name, 'ann')
  assert.equal(ownerLabel({ assignee: 'bot', forAi: false }), 'bot')
  assert.equal(ownerLabel({ assignee: 'ann', forAi: true }), "ann's AI")
  assert.equal(clashTaskId('main', 'abc1234'), clashTaskId('main', 'abc1234'))
  assert.notEqual(clashTaskId('main', 'abc1234'), clashTaskId('dev', 'abc1234'))
  assert.equal(clashTitle({ upstream: 'origin/main', behind: 4, conflicts: [{ path: 'src/a.js' }, { path: 'src/b.js' }] }), 'Bring 4 commits from origin/main into the session: src/a.js, src/b.js clash')
  const many = Array.from({ length: 30 }, (_, i) => ({ path: `src/some/long/folder/file-${i}.js` }))
  const long = clashTitle({ upstream: 'origin/main', behind: 2, conflicts: many })
  assert.ok(long.length <= 200 && / and \d+ more clash$/.test(long), long)
})
