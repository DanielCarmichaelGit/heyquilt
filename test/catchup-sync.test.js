// Leaving and coming back: nothing anyone did is lost, and the one who comes
// back is told what changed while they were away ("catch-up").
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'

let srv, server
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-${name}-`))
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

const identities = new Map()
const identityOf = (name) => { if (!identities.has(name)) identities.set(name, generateIdentity()); return identities.get(name) }
const stopped = new Set()
const close = async (s) => { if (!stopped.has(s)) { stopped.add(s); await s.stop() } }

async function open (t, dir, name, extra) {
  const s = new Session({ dir, server, secret: 'pw', name, identity: identityOf(name), ...extra })
  t.after(() => close(s))
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: s.tool, status: 'idle' })
  return s
}

let rooms = 0
async function pair (t, seed = {}) {
  const room = `catchup${++rooms}`
  const dirA = tmp('a')
  const dirB = tmp('b')
  for (const [rel, text] of Object.entries(seed)) write(dirA, rel, text)
  const A = await open(t, dirA, 'alice', { room })
  const B = await open(t, dirB, 'bob', { room })
  B.dismissCatchUp() // "the session put N files here": not what these tests are about
  return { A, B, dirA, dirB, room }
}

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, maxNewRoomsPerHour: 0 })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => { await srv.close() })

test('bob works, leaves, alice works, bob returns: both keep their work and bob is told what alice did', async (t) => {
  const p = await pair(t, { 'app.js': 'one\n' })
  await waitFor(() => read(p.dirB, 'app.js') === 'one\n')
  write(p.dirB, 'bob.js', 'bob wrote this in the session\n')
  await waitFor(() => read(p.dirA, 'bob.js'))
  await close(p.B)
  write(p.dirA, 'app.js', 'one\ntwo\nthree\n')
  write(p.dirA, 'lib/new.js', 'new\n')
  await waitFor(() => p.A.sharedKey('app.js') === 'one\ntwo\nthree\n' && p.A.sharedKey('lib/new.js') === 'new\n')
  const B = await open(t, p.dirB, 'bob', { room: p.room })
  await waitFor(() => read(p.dirB, 'lib/new.js') === 'new\n')
  assert.equal(read(p.dirB, 'bob.js'), 'bob wrote this in the session\n', "bob's in-session work is still there")
  assert.equal(read(p.dirA, 'bob.js'), 'bob wrote this in the session\n')
  const c = await waitFor(() => B.catchUp)
  assert.deepEqual(c.people.map((x) => x.name), ['alice'])
  assert.deepEqual(c.people[0].files.map((f) => [f.path, f.kind]).sort(), [['app.js', 'edited'], ['lib/new.js', 'created']])
  assert.ok(c.since && c.since <= Date.now())
  assert.match(B.status().catchUp.people[0].name, /alice/)
  assert.equal(p.A.catchUp, null, 'alice never left: nothing to catch up on')
})

test("bob's offline edits are shared or merged, and the catch-up says which clashed", async (t) => {
  const p = await pair(t, { 'same.txt': 'top\nmiddle\nbottom\n', 'solo.txt': 'one\n' })
  await waitFor(() => read(p.dirB, 'same.txt') && read(p.dirB, 'solo.txt'))
  await close(p.B)
  write(p.dirB, 'same.txt', 'top\nmiddle (bob)\nbottom\n')
  write(p.dirB, 'solo.txt', 'one\ntwo\n')
  write(p.dirA, 'same.txt', 'top\nmiddle (alice)\nbottom\n')
  await waitFor(() => p.A.sharedKey('same.txt') === 'top\nmiddle (alice)\nbottom\n')
  const B = await open(t, p.dirB, 'bob', { room: p.room })
  const c = await waitFor(() => B.catchUp)
  assert.equal(c.mine.shared, 1)
  assert.deepEqual(c.mine.conflicts, ['same.txt'])
  assert.deepEqual(c.people[0].files.map((f) => f.path), ['same.txt'])
  await waitFor(() => read(p.dirA, 'solo.txt') === 'one\ntwo\n')
})

test('a first join that replaces your copy says where it was kept', async (t) => {
  const { room } = await pair(t, { 'README.md': '# hello\n', 'b.txt': 'b\n' })
  const dirC = tmp('c')
  write(dirC, 'README.md', 'my own readme\n')
  const C = await open(t, dirC, 'carol', { room })
  const c = C.catchUp
  assert.equal(c.first, true)
  assert.equal(c.pulled, 2)
  assert.equal(c.backups.length, 1)
  assert.equal(c.backups[0].path, 'README.md')
  assert.equal(read(dirC, c.backups[0].copy), 'my own readme\n')
})

test('the catch-up survives a restart until dismissed', async (t) => {
  const p = await pair(t, { 'x.txt': 'x\n' })
  await waitFor(() => read(p.dirB, 'x.txt'))
  await close(p.B)
  write(p.dirA, 'x.txt', 'x\ny\n')
  await waitFor(() => p.A.sharedKey('x.txt') === 'x\ny\n')
  const B1 = await open(t, p.dirB, 'bob', { room: p.room })
  await waitFor(() => B1.catchUp)
  await close(B1)
  const B2 = await open(t, p.dirB, 'bob', { room: p.room })
  assert.deepEqual(B2.catchUp.people.map((x) => x.name), ['alice'], 'still there after a restart')
  B2.dismissCatchUp()
  assert.equal(B2.catchUp, null)
  await close(B2)
  const B3 = await open(t, p.dirB, 'bob', { room: p.room })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(B3.catchUp, null, 'gone once dismissed, and nothing new happened')
})

test('bob leaves agents working, edits offline, returns: file by file, nobody\'s work is dropped', async (t) => {
  const p = await pair(t, { 'mine.txt': 'a\n', 'theirs.txt': 'a\n', 'both.txt': 'top\nmiddle\nbottom\n', 'apart.txt': 'top\nmiddle\nbottom\n' })
  const agents = []
  for (const n of ['agent1', 'agent2']) {
    const dir = tmp(n)
    agents.push({ s: await open(t, dir, n, { room: p.room, kind: 'agent' }), dir })
  }
  await waitFor(() => agents.every((a) => read(a.dir, 'both.txt')) && read(p.dirB, 'apart.txt'))
  await close(p.B)
  write(p.dirB, 'mine.txt', 'a\nbob offline\n')
  write(p.dirB, 'both.txt', 'top\nmiddle (bob)\nbottom\n')
  write(p.dirB, 'apart.txt', 'top (bob)\nmiddle\nbottom\n')
  const [one, two] = agents
  write(one.dir, 'theirs.txt', 'a\nagent1\n')
  write(one.dir, 'both.txt', 'top\nmiddle (agent1)\nbottom\n')
  write(two.dir, 'apart.txt', 'top\nmiddle\nbottom (agent2)\n')
  await waitFor(() => p.A.sharedKey('theirs.txt') === 'a\nagent1\n' && p.A.sharedKey('both.txt') === 'top\nmiddle (agent1)\nbottom\n' && p.A.sharedKey('apart.txt') === 'top\nmiddle\nbottom (agent2)\n')
  // agent2 is done with apart.txt; agent1 still holds both.txt.
  await waitFor(() => p.A.claims.has('apart.txt'))
  await two.s.release('apart.txt')
  await waitFor(() => !p.A.claims.has('apart.txt'))
  const B = await open(t, p.dirB, 'bob', { room: p.room })
  const c = await waitFor(() => B.catchUp && B.catchUp.mine.conflicts.length && B.catchUp)
  await waitFor(() => read(one.dir, 'mine.txt') === 'a\nbob offline\n') // only bob changed it: his goes in
  assert.equal(read(p.dirB, 'theirs.txt'), 'a\nagent1\n') // only the agent changed it: theirs comes down
  await waitFor(() => read(two.dir, 'apart.txt') === 'top (bob)\nmiddle\nbottom (agent2)\n') // different lines: combined
  assert.equal(read(p.dirB, 'both.txt'), 'top\nmiddle (agent1)\nbottom\n') // agent1 holds it: the session's stays in the file…
  const rec = B.mergeList().find((m) => m.path === 'both.txt')
  assert.equal(rec.ours, 'top\nmiddle (bob)\nbottom\n') // …and bob's waits in the merge
  assert.deepEqual(c.mine, { shared: 1, merged: ['apart.txt'], conflicts: ['both.txt'] })
  assert.deepEqual(c.people.map((x) => x.name).sort(), ['agent1', 'agent2'])
})

test('an offline edit held back by an agent\'s claim is combined once the agent lets go', async (t) => {
  const p = await pair(t, { 'held.txt': 'top\nmiddle\nbottom\n' })
  const dir = tmp('agent')
  const agent = await open(t, dir, 'agent3', { room: p.room, kind: 'agent' })
  await waitFor(() => read(dir, 'held.txt') && read(p.dirB, 'held.txt'))
  await close(p.B)
  write(p.dirB, 'held.txt', 'top (bob)\nmiddle\nbottom\n')
  write(dir, 'held.txt', 'top\nmiddle\nbottom (agent3)\n')
  await waitFor(() => p.A.sharedKey('held.txt') === 'top\nmiddle\nbottom (agent3)\n' && p.A.claims.has('held.txt'))
  const B = await open(t, p.dirB, 'bob', { room: p.room })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'held.txt'))
  assert.equal(rec.kind, 'claimed')
  assert.deepEqual((await waitFor(() => B.catchUp)).mine.conflicts, ['held.txt'])
  assert.equal(read(p.dirB, 'held.txt'), 'top\nmiddle\nbottom (agent3)\n', 'held: the session\'s version meanwhile')
  await agent.release('held.txt')
  const both = 'top (bob)\nmiddle\nbottom (agent3)\n'
  await waitFor(() => read(p.dirB, 'held.txt') === both && read(dir, 'held.txt') === both && read(p.dirA, 'held.txt') === both)
  const done = await waitFor(() => B.mergeList().find((m) => m.id === rec.id && m.state === 'done'))
  assert.match(done.reason, /Combined automatically once agent3 let go/)
  assert.deepEqual(B.catchUp.mine, { shared: 0, merged: ['held.txt'], conflicts: [] })
})

test('a clash held back by a claim stays open for the person once the claim goes', async (t) => {
  const p = await pair(t, { 'clash.txt': 'top\nmiddle\nbottom\n' })
  const dir = tmp('agent')
  const agent = await open(t, dir, 'agent4', { room: p.room, kind: 'agent' })
  await waitFor(() => read(dir, 'clash.txt') && read(p.dirB, 'clash.txt'))
  await close(p.B)
  write(p.dirB, 'clash.txt', 'top\nmiddle (bob)\nbottom\n')
  write(dir, 'clash.txt', 'top\nmiddle (agent4)\nbottom\n')
  await waitFor(() => p.A.sharedKey('clash.txt') === 'top\nmiddle (agent4)\nbottom\n' && p.A.claims.has('clash.txt'))
  const B = await open(t, p.dirB, 'bob', { room: p.room })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'clash.txt'))
  await agent.release('clash.txt')
  await waitFor(() => !B.claims.has('clash.txt'))
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(B.mergeList().find((m) => m.id === rec.id).state, 'open')
  assert.equal(read(p.dirB, 'clash.txt'), 'top\nmiddle (agent4)\nbottom\n')
})
