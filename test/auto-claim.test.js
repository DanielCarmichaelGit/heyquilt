// Claims follow edits in every tool: a local change to a file nobody holds claims it
// for this person; a change to someone else's file is undone and the AI is told; the
// claims Quilt made end when the AI goes idle, when the file goes quiet, or at stop.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { startControl, call, findDaemon } from '../src/control.js'

let srv, server, rooms = 0
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-autoclaim-${name}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) {
    try { last = await fn(); if (last) return last } catch (err) { last = err }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out; last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => { await srv.close() })

const stopped = new Set()
async function open (t, dir, name, extra = {}) {
  const s = new Session({ dir, server, secret: 'pw', name, ...extra })
  t.after(async () => { if (!stopped.has(s)) { stopped.add(s); await s.stop() } })
  await s.start({ waitTimeoutMs: 5000 })
  return s
}
async function pair (t, seed = {}, extra = {}) {
  const room = `auto${++rooms}`
  const dirA = tmp('a'); const dirB = tmp('b')
  for (const [rel, text] of Object.entries(seed)) write(dirA, rel, text)
  const A = await open(t, dirA, 'alice', { room, tool: 'cursor', ...extra })
  const B = await open(t, dirB, 'bob', { room, tool: 'codex', ...extra })
  for (const s of [A, B]) s.setAgentState({ tool: s.tool, status: 'working' }) // their AIs are at work
  await waitFor(() => read(dirB, Object.keys(seed)[0]) === Object.values(seed)[0])
  return { A, B, dirA, dirB }
}

test('editing a file nobody holds claims it for you, in any tool', async (t) => {
  const { A, B, dirA } = await pair(t, { 'src/app.js': 'a\n' })
  A.setFocus('wiring the login')
  write(dirA, 'src/app.js', 'a\nb\n')
  const claim = await waitFor(() => B.claimFor('src/app.js'))
  assert.equal(claim.by, 'alice')
  assert.equal(claim.note, 'editing: wiring the login')
  assert.deepEqual([...A.autoClaims.keys()], ['src/app.js'])
  // Editing it again keeps the one claim.
  write(dirA, 'src/app.js', 'a\nb\nc\n')
  await waitFor(() => read(B.root, 'src/app.js') === 'a\nb\nc\n')
  assert.equal(B.claims.size, 1)
})

test("a change to a file someone else holds is undone, and the AI is told who holds it", async (t) => {
  const { A, B, dirA, dirB } = await pair(t, { 'src/auth.js': 'x\n' })
  write(dirA, 'src/auth.js', 'x\ny\n')
  await waitFor(() => B.claimFor('src/auth.js'))
  await waitFor(() => read(dirB, 'src/auth.js') === 'x\ny\n')
  write(dirB, 'src/auth.js', 'bob was here\n')
  await waitFor(() => read(dirB, 'src/auth.js') === 'x\ny\n', 5000)
  assert.equal(B.claimFor('src/auth.js').by, 'alice', "bob's edit never claimed it")
  const notices = B.takeNotices()
  assert.equal(notices.length, 1)
  assert.match(notices[0], /src\/auth\.js was undone/)
  assert.match(notices[0], /claimed by alice \(editing\)/)
  assert.match(notices[0], /quilt_request_file/)
  assert.deepEqual(B.takeNotices(), [], 'told once')
  assert.equal(read(dirA, 'src/auth.js'), 'x\ny\n', "alice's version stands")
})

test('the local MCP server passes notices on with its next answer', async (t) => {
  const { A, B, dirA, dirB } = await pair(t, { 'lib/x.js': '1\n' })
  const control = await startControl(B, {})
  t.after(() => control.close())
  const d = findDaemon(dirB)
  write(dirA, 'lib/x.js', '1\n2\n')
  await waitFor(() => B.claimFor('lib/x.js'))
  await waitFor(() => read(dirB, 'lib/x.js') === '1\n2\n')
  write(dirB, 'lib/x.js', 'nope\n')
  await waitFor(() => B.notices.length === 1)
  const r = await call(d, 'POST', '/notices', {})
  assert.equal(r.notices.length, 1)
  assert.match(r.notices[0], /lib\/x\.js was undone/)
  assert.deepEqual((await call(d, 'POST', '/notices', {})).notices, [])
  assert.ok(A)
})

test("claims Quilt made end when the person's AI goes idle; claims made by hand stay", async (t) => {
  const { A, B, dirA } = await pair(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await A.claim('b.txt', 'mine for a while')
  A.setAgentState({ tool: 'cursor', status: 'working' })
  write(dirA, 'a.txt', 'a\na\n')
  await waitFor(() => B.claimFor('a.txt'))
  A.setAgentState({ tool: 'cursor', status: 'idle' })
  await waitFor(() => !B.claimFor('a.txt'))
  assert.equal(B.claimFor('b.txt').by, 'alice')
  assert.equal(A.autoClaims.size, 0)
})

test('claiming by hand what Quilt claimed for you makes it yours to keep', async (t) => {
  const { A, B, dirA } = await pair(t, { 'k.txt': 'k\n' })
  write(dirA, 'k.txt', 'k\nk\n')
  await waitFor(() => B.claimFor('k.txt'))
  await A.claim('k.txt', 'keeping this')
  await waitFor(() => B.claimFor('k.txt')?.note === 'keeping this')
  A.setAgentState({ tool: 'cursor', status: 'working' })
  A.setAgentState({ tool: 'cursor', status: 'idle' })
  await settle()
  assert.equal(B.claimFor('k.txt').by, 'alice')
})

test('a file that goes quiet is released after the quiet time', async (t) => {
  const { A, B, dirA } = await pair(t, { 'q.txt': 'q\n' }, { autoClaimQuietMs: 300 })
  write(dirA, 'q.txt', 'q\nq\n')
  await waitFor(() => B.claimFor('q.txt'))
  await waitFor(() => !B.claimFor('q.txt'), 3000)
  assert.ok(A)
})

test('stopping releases the claims Quilt made, not the ones you made', async (t) => {
  const { A, B, dirA } = await pair(t, { 's.txt': 's\n', 't.txt': 't\n' })
  await A.claim('t.txt', 'hand made')
  write(dirA, 's.txt', 's\ns\n')
  await waitFor(() => B.claimFor('s.txt'))
  stopped.add(A)
  await A.stop()
  await waitFor(() => !B.claimFor('s.txt'))
  assert.equal(B.claimFor('t.txt').by, 'alice')
})

test("a person typing by hand while their AI is idle is not claimed for; an agent session always is", async (t) => {
  const { A, B, dirA, dirB } = await pair(t, { 'h.txt': 'h\n' })
  A.setAgentState({ tool: 'cursor', status: 'idle' })
  write(dirA, 'h.txt', 'h\nby hand\n')
  await waitFor(() => read(dirB, 'h.txt') === 'h\nby hand\n')
  await settle()
  assert.equal(B.claims.size, 0)
  B.setAgentState(null) // nothing can tell: the edit may be an AI's, so it is claimed
  write(dirB, 'h.txt', 'h\nby hand\nunknown\n')
  assert.equal((await waitFor(() => A.claimFor('h.txt'))).by, 'bob')
})

test('files Quilt does not sync are never claimed', async (t) => {
  const { A, B, dirA } = await pair(t, { 'ok.txt': 'ok\n', '.gitignore': 'dist/\n' })
  write(dirA, 'dist/out.js', 'built\n')
  write(dirA, '.quilt/notes.md', 'private\n')
  await settle()
  assert.equal(B.claims.size, 0)
  assert.equal(A.autoClaims.size, 0)
})

test('an edit check claims for an agent no chat reader can see, and its "working" lapses with its files', async (t) => {
  const { A, B } = await pair(t, { 'src/app.js': 'a\n' }, { autoClaimQuietMs: 300 })
  A.setAgentState(null) // a tool Quilt can't read: only the edit check says it is working
  const r = await A.prepareEdit(['src/app.js', '.quilt/notes.md'])
  assert.deepEqual(r.files.map((f) => [f.path, f.ok, !!f.claimed]), [['src/app.js', true, true], ['.quilt/notes.md', undefined, false]])
  assert.equal((await waitFor(() => B.claimFor('src/app.js'))).by, 'alice')
  assert.ok(B.commitStatus().busy.some((b) => b.name === 'alice'), 'the host waits for alice')
  // Never said done: once the file is quiet, the claim and the "working" both end.
  await waitFor(() => !B.claimFor('src/app.js'))
  await waitFor(() => !B.commitStatus().busy.some((b) => b.name === 'alice'))
  // Someone else's file is refused, with who holds it.
  await B.claim('src/app.js', 'mine now')
  await waitFor(() => A.claimFor('src/app.js'))
  const held = await A.prepareEdit(['src/app.js'])
  assert.deepEqual(held.files[0].claim, { by: 'bob', pattern: 'src/app.js', note: 'mine now', queue: [] })
})

test('the file queue: a file someone waits for is kept, its holder told on each change, and handed off with context', async (t) => {
  const { A, B, dirA } = await pair(t, { 'src/app.js': 'a\n' })
  write(dirA, 'src/app.js', 'a\nb\n')
  await waitFor(() => B.claimFor('src/app.js')?.by === 'alice')
  const r = await B.requestFile('src/app.js', { title: 'Working on sign-in for task 3', description: 'Add the form.' })
  assert.deepEqual([r.position, r.holder], [1, 'alice'])
  await waitFor(() => A.queued().length === 1)
  assert.equal(B.duties().waiting.length, 0)
  assert.equal(A.duties().waiting.length, 0, 'a queue request asks for a handoff, not a reply')
  // Alice's AI hears about it the next time it changes the file, and can't let go of it by finishing.
  A.takeNotices()
  write(dirA, 'src/app.js', 'a\nb\nc\n')
  const notice = await waitFor(() => A.notices.find((n) => /Waiting in the file queue/.test(n)))
  assert.match(notice, /- src\/app\.js: bob \(for src\/app\.js\): "Working on sign-in for task 3" — Add the form\./)
  assert.equal((await A.finishEditing()).released, 0)
  assert.equal(B.claimFor('src/app.js').by, 'alice', 'still hers: kept for the handoff')
  await assert.rejects(A.release('src/app.js'), /bob is waiting for src\/app\.js in its file queue/)
  const h = await A.handoff('src/app.js', { context: 'Wired the route; the form is yours.' })
  assert.equal(h.to, 'bob')
  await waitFor(() => B.claimFor('src/app.js')?.by === 'bob')
  assert.deepEqual([...A.autoClaims.keys()], [])
  const ev = await waitFor(() => B.inbox().events.find((e) => e.queue === 'handoff'))
  assert.match(ev.text, /My context: Wired the route; the form is yours\./)
})

test('an AI that stops without handing on a file someone waits for: Quilt hands it on for it, with context', async (t) => {
  const { A, B, dirA } = await pair(t, { 'src/app.js': 'a\n' }, { handoffGraceMs: 150, autoClaimQuietMs: 60_000 })
  A.focus = 'adding the login form'
  write(dirA, 'src/app.js', 'a\nb\n')
  await waitFor(() => B.claimFor('src/app.js')?.by === 'alice')
  await B.requestFile('src/app.js', { title: 'Working on sign-in' })
  await waitFor(() => A.queued().length === 1)
  // Still working: kept for her AI to hand on itself.
  await settle(300)
  assert.equal(await A.handOnForgotten(), 0)
  // Her AI goes idle and doesn't hand it on: after the grace time, Quilt does.
  A.setAgentState({ tool: 'cursor', status: 'idle' })
  assert.equal(B.claimFor('src/app.js').by, 'alice', 'kept at idle: someone is waiting')
  await settle(200)
  assert.equal(await A.handOnForgotten(), 1)
  await waitFor(() => B.claimFor('src/app.js')?.by === 'bob')
  const ev = await waitFor(() => B.inbox().events.find((e) => e.queue === 'handoff'))
  assert.match(ev.text, /Handed on by Quilt: alice's AI stopped working on src\/app\.js without handing it on\. It was working on: adding the login form\./)
  assert.ok(A.notices.some((n) => /Quilt handed src\/app\.js to bob/.test(n)), 'her AI hears about it')
})

test('with no chat reader to say the AI stopped, the queue moves once the file has been quiet for the quiet time', async (t) => {
  const { A, B, dirA } = await pair(t, { 'src/app.js': 'a\n' }, { handoffGraceMs: 10, autoClaimQuietMs: 400 })
  A.setAgentState(null) // no reader sees this AI (Codex, say): only quiet time tells
  A.work = { state: 'working', note: '', ts: Date.now() }
  write(dirA, 'src/app.js', 'a\nb\n')
  await waitFor(() => B.claimFor('src/app.js')?.by === 'alice')
  await B.requestFile('src/app.js', { title: 'Working on sign-in' })
  await waitFor(() => A.queued().length === 1)
  assert.equal(await A.handOnForgotten(), 0, 'edited moments ago')
  await waitFor(() => B.claimFor('src/app.js')?.by === 'bob', 3000) // the session's own timer
})
