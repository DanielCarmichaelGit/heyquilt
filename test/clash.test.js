// A clash between commits from outside and the session's uncommitted work is
// handed to ONE AI as a task, instead of every folder behind telling its AI to
// pull and resolve. Real relay, real git; the pure parts at the end.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { clashTaskId, clashCandidates, clashOrder, pickClashOwner, holderOf, clashTitle, ownerLabel } from '../src/clash.js'
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
  // Everything told to this member's AI, kept for the test (takeNotices empties the queue).
  s.told = []
  const notice = s.notice.bind(s)
  s.notice = (text) => { s.told.push(text); notice(text) }
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
  const A = await open(t, dirA, 'alice', { room, clashSettleMs: 500, ...extra, ...(extra.alice || {}) })
  const B = await open(t, dirB, 'bob', { room, clashSettleMs: 500, ...extra, ...(extra.bob || {}) })
  await waitFor(() => A.status().connected && B.status().connected)
  const push = (rel, text, msg = 'more') => { write(pusher, rel, text); git(pusher, 'add', '.'); git(pusher, 'commit', '-qm', msg); git(pusher, 'push', '-q', 'origin', 'main'); return git(pusher, 'rev-parse', 'HEAD') }
  return { A, B, dirA, dirB, push, pusher }
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
const yours = (s) => s.told.filter((n) => n.includes('This merge is yours'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

test('a clash seen by two folders becomes one task, for one member; the other folder is told to leave it to them', async (t) => {
  const ctx = await setup(t)
  const { A, B } = ctx
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  // The first in line among the folders reporting it when it was written (the lowest id; the order itself is tested below).
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  const [owner, other] = clashTasks(A)[0].assignee === 'alice' ? [A, B] : [B, A]
  await waitFor(() => other.status().git.upstream.mergedBy && yours(owner).length)
  await sleep(1500) // a few more looks: still one
  for (const s of [A, B]) assert.equal(clashTasks(s).length, 1)
  const task = clashTasks(A)[0]
  assert.equal(task.id, id)
  assert.equal(task.title, 'Bring 1 commit from origin/main into the session: src/app.js clashes')
  // Neither has an AI session: it goes to the person, as a person.
  assert.equal(task.assignee, owner.name)
  assert.equal(task.forAi, false)
  assert.equal(task.column, 'todo')
  assert.deepEqual(task.files, ['src/app.js'])
  assert.match(task.comments[0].text, /src\/app\.js: changed in the same lines here and in the new commits/)
  assert.match(task.comments[0].text, /run git pull, resolve those files and git add them/)
  assert.match(task.comments[0].text, /Quilt closes this task by itself once the merge lands/)
  // The owner is told the merge is its own; the other to leave it alone, not to pull.
  const ownerTold = owner.told.join('\n')
  assert.match(ownerTold, /Run git pull in this folder and resolve those/)
  assert.match(ownerTold, new RegExp(`This merge is yours: task ${id}`))
  const otherTold = other.told.join('\n')
  assert.match(otherTold, new RegExp(`${owner.name} is merging the commits from origin/main \\(task ${id}\\); leave those files to them\\.`))
  assert.doesNotMatch(otherTold, /Run git pull/)
  assert.equal(yours(other).length, 0)
  // The branch list says who is merging it, for everyone.
  const row = other.status().branches.find((b) => b.name === 'main')
  assert.match(branchesMarkdown([row]), new RegExp(`being merged by ${owner.name} \\(task ${id}\\)`))
  assert.match(upstreamLine(other.status().git.upstream), /being merged by/)
  // Its assignee holds the clashing file while it merges: a partner's edit is refused with the usual claim.
  const held = await waitFor(() => other.claimFor('src/app.js'))
  assert.equal(held.by, owner.name)
  assert.equal(held.clash, id)
  assert.equal(held.note, `Merging commits from origin/main (task ${id})`)
  const before = await other.prepareEdit(['src/app.js'])
  assert.equal(before.files[0].ok, false)
  assert.equal(before.files[0].claim.by, owner.name)
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
  await waitFor(() => git(otherDir, 'rev-parse', 'HEAD') === sha && other.status().git.upstream?.behind === 0, 15000)
  assert.equal(read(otherDir, 'src/app.js'), resolved)
  assert.ok(other.logs.some((m) => /follows .*'s folder to/.test(m)), 'followed the owner\'s folder')
  assert.ok(!other.logs.some((m) => /brought in \d+ commit/.test(m)), 'no merge of its own')
  assert.doesNotMatch(other.told.join('\n'), /Run git pull/)
  await waitFor(() => other.status().git.upstream.mergedBy === null)
  await sleep(1000) // not opened again
  assert.equal(clashTasks(A).length, 1)
  assert.equal(clashTasks(A)[0].column, 'done')
  // The merge is done: the file it was held for is let go of, and a partner may edit it again.
  await waitFor(() => !other.claimFor('src/app.js')?.clash)
  assert.equal((await other.prepareEdit(['src/app.js'])).files[0].ok, true)
})

test('when the assignee leaves the session, the clash task goes to the next member after a while', async (t) => {
  const ctx = await setup(t, { clashReassignMs: 1500 })
  const { A, B } = ctx
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  const ownerName = clashTasks(A)[0].assignee
  const [owner, other] = ownerName === 'alice' ? [A, B] : [B, A]
  const left = Date.now()
  await owner.stop()
  await waitFor(() => clashTasks(other)[0]?.assignee === other.name, 15000)
  assert.ok(Date.now() - left >= 1400, 'not before the assignee had been away a while')
  await waitFor(() => yours(other).some((n) => n.includes(`task ${id}`)))
  const task = clashTasks(other)[0]
  assert.equal(task.id, id)
  assert.match(task.comments.at(-1).text, new RegExp(`^Handed to ${other.name}: ${owner.name} has been away from \`main\``))
  assert.equal(clashTasks(other).length, 1)
  // The file held for the merge moved with the task: the new assignee holds it now.
  const held = await waitFor(() => other.claimFor('src/app.js')?.by === other.name && other.claimFor('src/app.js'))
  assert.equal(held.clash, id)
})

test('a bring-in never writes a file someone else holds: it waits until they let go of it', async (t) => {
  // Alice's Quilt doesn't bring commits in itself here, so only Bob's folder could.
  const ctx = await setup(t, { alice: { bringInUpstream: false } })
  const { A, B, dirB, push } = ctx
  await A.claim('README.md', 'editing the intro')
  await waitFor(() => B.claimFor('README.md')?.by === 'alice')
  const sha = push('README.md', 'hello, pushed\n')
  await waitFor(() => B.status().git.upstream?.waiting === 'alice holds README.md', 15000)
  assert.equal(read(dirB, 'README.md'), 'hello\n', 'not written under her')
  assert.notEqual(git(dirB, 'rev-parse', 'HEAD'), sha)
  await A.release('README.md')
  await waitFor(() => read(dirB, 'README.md') === 'hello, pushed\n' && git(dirB, 'rev-parse', 'HEAD') === sha, 15000)
})

test('two members that race to hand out the same clash write one task, and exactly one AI is told it is theirs', async (t) => {
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
  const [a, b] = await Promise.all([A.reviewClash(), B.reviewClash()])
  assert.deepEqual([a.task, a.mine, b.task, b.mine], [id, true, id, true], 'both took it')
  showA(); showB()
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1 && clashTasks(A)[0].assignee === clashTasks(B)[0].assignee)
  await sleep(2000) // past the settle, and a few more looks
  assert.deepEqual(clashTasks(A).map((x) => x.id), [id])
  assert.deepEqual(clashTasks(B).map((x) => x.id), [id])
  const winner = clashTasks(A)[0].assignee
  const [won, lost] = winner === 'alice' ? [A, B] : [B, A]
  assert.equal(yours(won).length, 1, 'the one whose write stayed is told')
  assert.equal(yours(lost).length, 0, 'the other never is')
  assert.match(lost.told.join('\n'), new RegExp(`${winner} is merging the commits from origin/main \\(task ${id}\\)`))
  // Its description is posted once, by the writer whose task stayed.
  const briefs = clashTasks(A)[0].comments.filter((c) => /^1 commit on origin\/main/.test(c.text))
  assert.deepEqual(briefs.map((c) => c.by), [winner])
  await waitFor(() => lost.status().git.upstream?.mergedBy === winner)
})

test('newer commits that follow the clash\'s update the open task instead of adding another', async (t) => {
  const ctx = await setup(t)
  const { A, B, push } = ctx
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  const sha2 = push('README.md', 'hello again\n', 'readme')
  await waitFor(() => clashTasks(A)[0]?.title === 'Bring 2 commits from origin/main into the session: src/app.js clashes', 15000)
  await waitFor(() => A.clashes.get('main')?.sha === sha2)
  await sleep(1000)
  assert.deepEqual(clashTasks(A).map((x) => x.id), [id])
  assert.deepEqual(clashTasks(B).map((x) => x.id), [id])
  assert.match(clashTasks(A)[0].comments.at(-1).text, new RegExp(`origin/main moved on to ${sha2.slice(0, 7)}`))
})

test('an upstream rewritten without the clash\'s commit: the task is closed as superseded and the new clash gets its own', async (t) => {
  const ctx = await setup(t)
  const { A, B, pusher } = ctx
  const { sha } = await clash(ctx)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  // Force-pushed: line2 changed differently, still clashing.
  git(pusher, 'reset', '-q', '--hard', 'HEAD~1')
  write(pusher, 'src/app.js', APP.replace('line2', 'line2 (rewritten)'))
  git(pusher, 'commit', '-qam', 'rewritten'); git(pusher, 'push', '-q', '-f', 'origin', 'main')
  const sha2 = git(pusher, 'rev-parse', 'HEAD')
  const id2 = clashTaskId('main', sha2)
  await waitFor(() => clashTasks(A).some((x) => x.id === id2) && clashTasks(B).some((x) => x.id === id2), 15000)
  const old = clashTasks(A).find((x) => x.id === clashTaskId('main', sha))
  assert.equal(old.column, 'done')
  assert.match(old.verified, new RegExp(`^Superseded: origin/main was rewritten without ${sha.slice(0, 7)}`))
  await sleep(1000)
  assert.equal(clashTasks(A).filter((x) => x.column !== 'done').length, 1)
})

test('an upstream rewritten without the clash\'s commit, that now comes in cleanly: the task is closed as superseded', async (t) => {
  const ctx = await setup(t)
  const { A, B, pusher, dirA } = ctx
  const { sha, mine } = await clash(ctx)
  const id = clashTaskId('main', sha)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  git(pusher, 'reset', '-q', '--hard', 'HEAD~1')
  write(pusher, 'README.md', 'hello, rewritten\n')
  git(pusher, 'commit', '-qam', 'rewritten'); git(pusher, 'push', '-q', '-f', 'origin', 'main')
  await waitFor(() => read(dirA, 'README.md') === 'hello, rewritten\n', 15000)
  await waitFor(() => clashTasks(B).find((x) => x.id === id)?.column === 'done', 15000)
  assert.match(clashTasks(B).find((x) => x.id === id).verified, /^Superseded: origin\/main was rewritten without/)
  assert.equal(read(dirA, 'src/app.js'), mine)
})

test('a member whose Quilt does not hand clashes out is never chosen, even an agent', async (t) => {
  const ctx = await setup(t, { clashWaitMs: 60000, bob: { kind: 'agent' } })
  const { A, B } = ctx
  // Bob's Quilt is older: no clash support in its presence, and it never writes a clash task.
  const summary = B.gitSummary.bind(B)
  B.gitSummary = () => { const g = summary(); if (g) delete g.clash; return g }
  B.reviewClash = () => null
  B.shareGit()
  const { sha } = await clash(ctx)
  await waitFor(() => clashTasks(A).length === 1, 5000)
  assert.equal(clashTasks(A)[0].id, clashTaskId('main', sha))
  assert.equal(clashTasks(A)[0].assignee, 'alice')
})

test('the first in line that never writes the task is passed over after a while, the wait counted per commit', async (t) => {
  const ctx = await setup(t, { clashWaitMs: 1500, bob: { kind: 'agent' } })
  const { A, B } = ctx
  // Bob, an agent member, is first in line and advertises clash support, but its Quilt never writes the task.
  B.reviewClash = () => null
  A.clashWait = { sha: '0000000', since: 0 } // a wait for an older commit long over: it must not count for this one
  // Alice looks once both folders report the clash (else she alone would be in line, and take it).
  A.reviewClash = () => null
  const { sha } = await clash(ctx)
  delete A.reviewClash
  const from = Date.now()
  A.reviewClash()
  await waitFor(() => A.told.some((n) => n.includes(`bob is merging the commits from origin/main (task ${clashTaskId('main', sha)})`)))
  await waitFor(() => clashTasks(A).length === 1, 10000)
  assert.ok(Date.now() - from >= 1000, 'alice waited for bob first')
  assert.equal(clashTasks(A)[0].assignee, 'alice')
})

test('the task goes to one AI session of the chosen member, and from a person without an AI to a member with one', async (t) => {
  const ctx = await setup(t)
  const { A, B } = ctx
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  const ownerName = clashTasks(A)[0].assignee
  const other = ownerName === 'alice' ? B : A
  // The other member's AI sessions show up: the task is handed to the one active last, by name.
  other.registerPersona({ via: 'aaaaaaaa', tool: 'Claude Code', cwd: tmp('x') })
  other.registerPersona({ via: 'bbbbbbbb', tool: 'Codex', cwd: tmp('y') })
  other.persona('aaaaaaaa').seenAt = Date.now() - 60 * 1000
  other.publishPersonas()
  const lead = other.persona('bbbbbbbb').name
  await waitFor(() => clashTasks(A)[0]?.assignee === lead && clashTasks(B)[0]?.assignee === lead, 10000)
  await waitFor(() => clashTasks(A)[0].comments.some((c) => c.text.startsWith('Handed to')))
  const task = clashTasks(A)[0]
  assert.equal(task.id, id)
  assert.equal(task.forAi, false)
  assert.match(task.comments.at(-1).text, new RegExp(`^Handed to ${lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ${ownerName} has no AI session`))
  // That session is woken for it (once the write settled); the other session is not.
  await waitFor(() => other.inbox({ via: 'bbbbbbbb' }).events.some((e) => e.kind === 'task' && e.id === id))
  assert.ok(!other.inbox({ via: 'aaaaaaaa' }).events.some((e) => e.kind === 'task'))
})

/** Everything handed to one AI session of `s` (its own notices and this member's), kept across calls. */
function sessionNotices (s, via) {
  s.byVia = s.byVia || {}
  s.byVia[via] = [...(s.byVia[via] || []), ...s.takeNotices(via)]
  return s.byVia[via].join('\n')
}

test('of a member with two AI sessions, only the one the clash task went to is told the merge is its own', async (t) => {
  const ctx = await setup(t)
  const { A, B } = ctx
  // Alice has two AI sessions (Codex active last), so she is first in line; bob has none.
  A.registerPersona({ via: 'aaaaaaaa', tool: 'Claude Code', cwd: tmp('x') })
  A.registerPersona({ via: 'bbbbbbbb', tool: 'Codex', cwd: tmp('y') })
  A.persona('aaaaaaaa').seenAt = Date.now() - 60 * 1000
  A.publishPersonas()
  const lead = A.persona('bbbbbbbb').name
  const quiet = A.persona('aaaaaaaa').name
  await waitFor(() => B.status().peers.filter((p) => p.persona).length === 2)
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  await waitFor(() => clashTasks(B)[0]?.assignee === lead, 10000)
  await waitFor(() => /This merge is yours/.test(sessionNotices(A, 'bbbbbbbb')), 10000)
  await waitFor(() => sessionNotices(A, 'aaaaaaaa').includes(`${lead} is merging the commits from origin/main (task ${id}); leave those files to them.`))
  await sleep(1000)
  assert.doesNotMatch(sessionNotices(A, 'aaaaaaaa'), /This merge is yours/)
  assert.match(sessionNotices(A, 'bbbbbbbb'), new RegExp(`This merge is yours: task ${id}`))
  assert.ok(A.inbox({ via: 'bbbbbbbb' }).events.some((e) => e.kind === 'task' && e.id === id))
  assert.ok(!A.inbox({ via: 'aaaaaaaa' }).events.some((e) => e.kind === 'task'), `${quiet} is not woken`)
  assert.match(B.told.join('\n'), new RegExp(`${lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is merging`))
})

test('a clash task its own AI moved to Done too early is opened again, and that AI is woken and told again', async (t) => {
  const ctx = await setup(t)
  const { A } = ctx
  A.registerPersona({ via: 'aaaaaaaa', tool: 'Codex', cwd: tmp('x') })
  A.publishPersonas()
  const ai = A.persona('aaaaaaaa').name
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  const woken = () => A.inbox({ via: 'aaaaaaaa' }).events.filter((e) => e.kind === 'task' && e.id === id).length
  const toldYours = () => (sessionNotices(A, 'aaaaaaaa').match(/This merge is yours/g) || []).length
  await waitFor(() => clashTasks(A)[0]?.assignee === ai && woken() === 1 && toldYours() === 1, 10000)
  // Its AI moves it to Done before the merge has landed.
  A.updateTask({ id, column: 'done', verified: 'merged, I think' })
  await waitFor(() => clashTasks(A)[0].column === 'doing', 10000)
  assert.equal(clashTasks(A)[0].assignee, ai)
  await waitFor(() => woken() === 2 && toldYours() === 2, 10000)
})

test('a diverged branch is its own folder\'s history: never handed out, and told as before', async (t) => {
  const ctx = await setup(t)
  const { A, B, dirA, dirB, push } = ctx
  write(dirA, 'README.md', 'hello from alice\n')
  await waitFor(() => read(dirB, 'README.md') === 'hello from alice\n')
  git(dirA, 'commit', '-qam', 'local')
  push('src/app.js', APP.replace('line8', 'line8 (pushed)'))
  await waitFor(() => A.status().git.upstream?.diverged === true, 10000)
  // Bob's folder (README uncommitted there) takes the commit in by itself; alice's stays diverged.
  await waitFor(() => read(dirB, 'src/app.js') === APP.replace('line8', 'line8 (pushed)') && B.status().git.upstream?.behind === 0, 10000)
  await sleep(1000)
  assert.equal(clashTasks(A).length, 0)
  assert.equal(A.status().git.upstream.diverged, true)
  assert.equal(A.status().git.upstream.mergedBy, null)
  assert.match(A.told.join('\n'), /have both moved on \(1 commit here, 1 commit there\)/)
})

test('a clash task moved to Done by hand while the commit still clashes is opened again, same assignee', async (t) => {
  const ctx = await setup(t)
  const { A, B } = ctx
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  const assignee = clashTasks(A)[0].assignee
  const other = assignee === 'alice' ? B : A
  other.updateTask({ id, column: 'done', verified: 'looked done to me' })
  await waitFor(() => clashTasks(A)[0].column === 'doing' && clashTasks(B)[0].column === 'doing', 10000)
  await waitFor(() => clashTasks(A)[0].comments.some((c) => c.text.startsWith('Open again')))
  assert.equal(clashTasks(A)[0].assignee, assignee)
  assert.match(clashTasks(A)[0].comments.at(-1).text, /^Open again: .* Quilt closes this task by itself once the merge lands/)
  assert.equal(other.status().git.upstream.mergedBy, assignee)
})

test('a clash task taken off the board is not written again for the same commit; a newer commit gets one', async (t) => {
  const ctx = await setup(t)
  const { A, B, push } = ctx
  const { sha } = await clash(ctx)
  const id = clashTaskId('main', sha)
  await waitFor(() => clashTasks(A).length === 1 && clashTasks(B).length === 1)
  A.deleteTask(id)
  await waitFor(() => clashTasks(B).length === 0)
  await sleep(2000)
  assert.equal(clashTasks(A).length, 0)
  assert.equal(clashTasks(B).length, 0)
  // Each folder is told as before, since nobody has it.
  await waitFor(() => A.told.some((n) => /Run git pull in this folder/.test(n)) && B.told.some((n) => /Run git pull in this folder/.test(n)))
  // A newer commit is a new clash, with a task of its own.
  const sha2 = push('src/app.js', APP.replace('line2', 'line2 (pushed again)'))
  await waitFor(() => clashTasks(A).some((x) => x.id === clashTaskId('main', sha2)), 15000)
})

test('a presence change that has nothing to do with git does not look at the clash again', async (t) => {
  const { A, B } = await setup(t)
  let looks = 0
  const soon = A.reviewClashSoon.bind(A)
  A.reviewClashSoon = (ms) => { looks++; return soon(ms) }
  await sleep(300)
  looks = 0
  B.conn.awareness.setLocalStateField('focus', 'something else')
  B.conn.awareness.setLocalStateField('editing', { 'x.js': Date.now() })
  await sleep(500)
  assert.equal(looks, 0)
  B.conn.awareness.setLocalStateField('git', { ...B.gitSummary(), held: 'busy' })
  await waitFor(() => looks > 0)
})

// ---------------------------------------------------------------- pure --

test('the order: only members with clash support who may write the files and report a file clash; agent, AI, person; lowest id', () => {
  const st = (name, extra = {}, up = {}) => ({ name, git: { clash: 1, branch: 'main', upstream: { name: 'origin/main', conflicts: 1, mayWrite: true, ...up } }, ...extra })
  const states = [
    [1, st('ann')],
    [5, st('cat', { personas: [{ name: 'cat · Cursor' }] })],
    [7, st('bot', { kind: 'agent' })],
    [2, st('dan', { git: { clash: 1, branch: 'feature', upstream: { name: 'origin/main', conflicts: 1, mayWrite: true } } })],
    [3, st('eve', {}, { conflicts: 0 })],
    [4, st('fay', {}, { diverged: true })],
    [6, st('gus', {}, { mayWrite: false })],
    [8, { ...st('old', { kind: 'agent' }), git: { branch: 'main', upstream: { name: 'origin/main', conflicts: 1, mayWrite: true } } }],
    [0, st('hal', { agent: { tool: 'Cursor' } })]
  ]
  const c = clashCandidates(states, { branch: 'main', upstream: 'origin/main' })
  assert.deepEqual(clashOrder(c).map((x) => x.name), ['bot', 'cat', 'hal', 'ann'])
  assert.equal(pickClashOwner(c).name, 'bot')
  assert.equal(pickClashOwner(c, { except: ['bot'] }).name, 'cat')
  assert.equal(pickClashOwner(c, { except: ['bot', 'cat'] }).name, 'hal')
  // Whoever has the task counts as here only while their folder is on that branch.
  assert.equal(holderOf(states, 'cat · Cursor', 'main').st.name, 'cat')
  assert.equal(holderOf(states, 'dan', 'main'), null)
  assert.equal(holderOf(states, 'dan', 'feature').st.name, 'dan')
  assert.equal(ownerLabel({ assignee: 'bot', forAi: false }), 'bot')
  assert.equal(ownerLabel({ assignee: 'ann', forAi: true }), "ann's AI")
  assert.equal(clashTaskId('main', 'abc1234'), clashTaskId('main', 'abc1234'))
  assert.notEqual(clashTaskId('main', 'abc1234'), clashTaskId('dev', 'abc1234'))
  assert.equal(clashTitle({ upstream: 'origin/main', behind: 4, conflicts: [{ path: 'src/a.js' }, { path: 'src/b.js' }] }), 'Bring 4 commits from origin/main into the session: src/a.js, src/b.js clash')
  const many = Array.from({ length: 30 }, (_, i) => ({ path: `src/some/long/folder/file-${i}.js` }))
  const long = clashTitle({ upstream: 'origin/main', behind: 2, conflicts: many })
  assert.ok(long.length <= 200 && / and \d+ more clash$/.test(long), long)
})

test('a sooner look moves the clash timer earlier; a later one leaves it', () => {
  const fake = { stopped: false, clashTimer: null, clashDue: 0, reviewClash () {} }
  Session.prototype.reviewClashSoon.call(fake, 10000)
  const due = fake.clashDue
  Session.prototype.reviewClashSoon.call(fake, 20000)
  assert.equal(fake.clashDue, due)
  Session.prototype.reviewClashSoon.call(fake, 10)
  assert.ok(fake.clashDue < due)
  clearTimeout(fake.clashTimer)
})

test('old finished clash records are pruned when a new one is written', () => {
  const doc = new Y.Doc()
  const fake = { doc, tasks: doc.getMap('tasks'), clashes: doc.getMap('clashes') }
  const old = Date.now() - 4 * 24 * 60 * 60 * 1000
  fake.clashes.set('gone', { task: 'a'.repeat(16), sha: 'b'.repeat(40), upstream: 'origin/gone', ts: old })
  fake.clashes.set('recent', { task: 'c'.repeat(16), sha: 'd'.repeat(40), upstream: 'origin/recent', ts: Date.now() })
  fake.clashes.set('junk', { nope: true })
  Session.prototype.writeClashRecord.call(fake, 'main', { task: 'e'.repeat(16), sha: 'f'.repeat(40), upstream: 'origin/main' })
  assert.deepEqual([...fake.clashes.keys()].sort(), ['main', 'recent'])
})
