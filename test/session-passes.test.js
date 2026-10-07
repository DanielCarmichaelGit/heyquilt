// Sessions on a relay that needs passes: they connect, sync, share files, keep
// their pass fresh, come back after a lapse, and stop when signed out.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { Connection } from '../src/connection.js'
import { runSession } from '../src/runner.js'
import { renderStatus } from '../src/status.js'
import { generateIdentity } from '../src/identity.js'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { PassSource, SignedOutError, personPasses } from '../src/pass-source.js'
import { PASS_KEYS, makePass, testPasses } from './pass-helpers.js'

process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-sp-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-sp-${n}-`))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
/**
 * Passes that run out after `ms`, counting how many were fetched. With `claimMs`, each is
 * said to last that long instead, so the client keeps using it after it has run out.
 */
function shortPasses (identity, ms, { claimMs = ms } = {}) {
  const ps = new PassSource({ earlyMs: 0, fetchPass: async () => { ps.count++; const exp = Date.now() + ms; return { pass: makePass({ identity, exp }), expiresAt: Date.now() + claimMs } } })
  ps.count = 0
  return ps
}
/** Resolves with the connection's first `fatal`, or fails after `ms` instead of hanging. */
const fatalOf = (conn, ms = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no fatal')), ms)
  conn.on('fatal', (err) => { clearTimeout(timer); resolve(err) })
})

let srv, server
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  server = `ws://127.0.0.1:${srv.port}`
})
after(() => srv.close())

test('two signed-in sessions sync files and share chat files through a relay that needs passes', async (t) => {
  const dana = generateIdentity()
  const eli = generateIdentity()
  const dirA = tmp('a')
  fs.writeFileSync(path.join(dirA, 'hello.txt'), 'hi')
  const a = new Session({ dir: dirA, server, room: 'sp-1', secret: 's', name: 'Dana', identity: dana, passes: testPasses(dana) })
  t.after(() => a.stop())
  await a.start({ waitTimeoutMs: 5000 })
  const dirB = tmp('b')
  const b = new Session({ dir: dirB, server, room: 'sp-1', secret: 's', name: 'Eli', identity: eli, passes: testPasses(eli, { name: 'Eli', sub: 'user-eli' }) })
  t.after(() => b.stop())
  await b.start({ waitTimeoutMs: 5000 })
  await waitFor(() => read(dirB, 'hello.txt') === 'hi')

  const notes = path.join(tmp('notes'), 'notes.txt')
  fs.writeFileSync(notes, 'shared notes')
  const sent = await a.sendFile(notes)
  await waitFor(() => b.chat.toArray().some((m) => m.id === sent.id))
  const got = await b.fetchFile(sent.id, path.join(tmp('dl'), 'notes.txt'))
  assert.equal(fs.readFileSync(got, 'utf8'), 'shared notes')
})

test('a session without a pass is told to update and sign in', async (t) => {
  const s = new Session({ dir: tmp('none'), server, room: 'sp-2', secret: 's', name: 'Old', identity: generateIdentity() })
  t.after(() => s.stop())
  await assert.rejects(s.start({ waitTimeoutMs: 5000 }), /Update Quilt and sign in to continue/)
})

test('a connection refreshes its pass while connected, so it never runs out', async (t) => {
  const id = generateIdentity()
  // Each pass lasts 1 s and a fresh one goes out every 150 ms: 10 passes take well past the first one's end.
  const passes = shortPasses(id, 1000)
  const conn = new Connection({ server, room: 'sp-3', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes, passRefreshMs: 150 })
  t.after(() => conn.close())
  const statuses = []
  conn.on('status', (s) => statuses.push(s))
  await conn.waitForSync()
  const since = Date.now()
  await waitFor(() => passes.count >= 10 && Date.now() - since > 1200)
  assert.deepEqual(statuses, ['connected'], 'never dropped')
})

test('a lapsed pass closes with 4419, and the connection comes back with a fresh one', async (t) => {
  const id = generateIdentity()
  // The client is told each pass lasts 10 minutes, so only the 4419 makes it fetch a new one.
  const passes = shortPasses(id, 400, { claimMs: 10 * 60_000 })
  const conn = new Connection({ server, room: 'sp-4', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes, passRefreshMs: 60_000 })
  t.after(() => conn.close())
  const statuses = []
  const warnings = []
  conn.on('status', (s) => statuses.push(s))
  conn.on('warn', (w) => warnings.push(w))
  await waitFor(() => statuses.filter((s) => s === 'connected').length >= 2)
  assert.deepEqual(statuses.slice(0, 3), ['connected', 'disconnected', 'connected'])
  assert.equal(passes.count, 2)
  assert.ok(warnings.includes('Your sign-in expired. Reconnecting.'), warnings.join('\n'))
  assert.ok(!warnings.some((w) => /turned the session pass away/.test(w)), 'reconnected with a fresh pass, not the lapsed one')
})

test('passes that keep lapsing right after connecting stop with a clock warning', async (t) => {
  const id = generateIdentity()
  const passes = shortPasses(id, 150)
  const conn = new Connection({ server, room: 'sp-4b', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes, passRefreshMs: 60_000 })
  t.after(() => conn.close())
  let connects = 0
  conn.on('status', (s) => { if (s === 'connected') connects++ })
  const err = await fatalOf(conn, 30000)
  assert.equal(err.message, "Your computer's clock looks wrong, so Quilt can't stay signed in. Check the date and time.")
  assert.equal(connects, 5)
  assert.equal(conn.closed, true)
})

test('a pass the relay turns away is retried once with a fresh one', async (t) => {
  const id = generateIdentity()
  let n = 0
  // The first pass is already out of date by the relay's clock, though the client thinks it's fine.
  const passes = new PassSource({ fetchPass: async () => { n++; const exp = Date.now() + 600_000; return { pass: makePass({ identity: id, exp: n === 1 ? Date.now() - 1000 : exp }), expiresAt: exp } } })
  const conn = new Connection({ server, room: 'sp-4c', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes })
  t.after(() => conn.close())
  await conn.waitForSync()
  assert.equal(n, 2)
})

test('after a refused pass, a failed fetch is retried for a fresh pass, never the refused one', async (t) => {
  const id = generateIdentity()
  let n = 0
  const passes = new PassSource({
    fetchPass: async () => {
      n++
      if (n === 2) throw new Error('offline for a moment')
      const exp = Date.now() + 600_000
      // The first pass is out of date by the relay's clock, though the client thinks it's fine.
      return { pass: makePass({ identity: id, exp: n === 1 ? Date.now() - 1000 : exp }), expiresAt: exp }
    }
  })
  const conn = new Connection({ server, room: 'sp-4e', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes })
  t.after(() => conn.close())
  const warnings = []
  conn.on('warn', (w) => warnings.push(w))
  let fatal = null
  conn.on('fatal', (err) => { fatal = err })
  await conn.waitForSync()
  assert.equal(fatal, null)
  assert.equal(n, 3)
  assert.ok(!warnings.some((w) => /closed before the connection was established/.test(w)), warnings.join('\n'))
})

test('4419s that arrive before signing in finishes count toward the clock warning', async (t) => {
  // A relay that says the pass has expired the moment anyone connects.
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => wss.on('listening', resolve))
  wss.on('connection', (ws) => ws.close(4419, 'Your sign-in expired. Reconnecting.'))
  t.after(() => new Promise((resolve) => wss.close(resolve)))
  const id = generateIdentity()
  const conn = new Connection({ server: `ws://127.0.0.1:${wss.address().port}`, room: 'sp-4f', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes: testPasses(id) })
  t.after(() => conn.close())
  const err = await fatalOf(conn, 20000)
  assert.equal(err.message, "Your computer's clock looks wrong, so Quilt can't stay signed in. Check the date and time.")
})

test('a pass the relay turns away twice is fatal', async (t) => {
  const id = generateIdentity()
  const passes = new PassSource({ fetchPass: async () => ({ pass: makePass({ identity: id, exp: Date.now() - 1000 }), expiresAt: Date.now() + 600_000 }) })
  const conn = new Connection({ server, room: 'sp-4d', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes })
  t.after(() => conn.close())
  assert.match((await fatalOf(conn)).message, /Update Quilt and sign in to continue/)
})

test("a pass for another key (this computer's identity changed) stops before connecting, saying so", async () => {
  const id = generateIdentity()
  const conn = new Connection({ server, room: 'sp-4k', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes: testPasses(generateIdentity()) })
  const err = await fatalOf(conn)
  assert.equal(err.message, "This computer's Quilt identity changed. Sign out and sign in again.")
  assert.equal(conn.closed, true)
  assert.equal(conn.ws, null, 'never connected to the relay')
  assert.equal(srv.rooms.has('sp-4k'), false)
})

test('a relay address that is not valid is fatal, and the error never shows the secret or the pass', async () => {
  for (const withPasses of [false, true]) {
    const identity = generateIdentity()
    const passes = withPasses ? testPasses(identity) : null
    const conn = new Connection({ server: 'ws://bad host', room: 'sp-x', secret: 'TOPSECRET', name: 'Dana', identity, doc: new Y.Doc(), passes })
    const err = await fatalOf(conn)
    assert.equal(err.message, "Couldn't connect to the relay: the address isn't valid.")
    assert.ok(!/TOPSECRET|pass=/.test(String(err.stack)))
    assert.equal(conn.closed, true)
  }
})

test('once the API says this computer is signed out, the connection stops for good', async () => {
  const passes = new PassSource({ fetchPass: async () => { throw new SignedOutError('This computer was signed out. Sign in again.') } })
  const conn = new Connection({ server, room: 'sp-5', secret: 's', name: 'Dana', identity: generateIdentity(), doc: new Y.Doc(), passes })
  const err = await fatalOf(conn)
  assert.equal(err.signedOut, true)
  assert.equal(err.message, 'This computer was signed out. Sign in again.')
  assert.equal(conn.closed, true)
})

test('runSession takes your name, and an agent badge, from the pass', async (t) => {
  const id = generateIdentity()
  const run = await runSession({ dir: tmp('run'), conn: { server, room: 'sp-6', secret: 's', viewSecret: 'v' }, name: 'ignored', identity: id, passes: testPasses(id, { name: 'helper', kind: 'agent', sub: 'agent-1' }), agentFeed: false })
  t.after(() => run.stop())
  assert.equal(run.session.name, 'helper')
  assert.equal(run.session.kind, 'agent')
  await waitFor(() => srv.rooms.get('sp-6')?.access.size)
  assert.deepEqual([...srv.rooms.get('sp-6').access.values()].map((a) => [a.name, a.kind]), [['helper', 'agent']])
})

test('a pass that cannot be fetched says why (once, in the log and status), and clears when one arrives', async (t) => {
  const id = generateIdentity()
  const dir = tmp('why')
  const first = await runSession({ dir, conn: { server, room: 'sp-9', secret: 's' }, name: 'Dana', identity: id, passes: testPasses(id), agentFeed: false })
  await first.stop()
  let up = false
  const passes = new PassSource({
    fetchPass: async () => {
      if (!up) throw new Error("Couldn't reach Quilt (CERT_HAS_EXPIRED).")
      const exp = Date.now() + 600_000
      return { pass: makePass({ identity: id, name: 'Dana', exp }), expiresAt: exp }
    }
  })
  const logs = []
  const run = await runSession({ dir, conn: { server, room: 'sp-9', secret: 's' }, name: 'Dana', identity: id, passes, agentFeed: false, onLog: (l) => logs.push(l) })
  t.after(() => run.stop())
  await waitFor(() => run.session.status().problem)
  assert.equal(run.session.status().problem, "Couldn't get a session pass: Couldn't reach Quilt (CERT_HAS_EXPIRED).")
  assert.match(renderStatus(run.session.status()), /⚠️ Couldn't get a session pass: Couldn't reach Quilt \(CERT_HAS_EXPIRED\)\./)
  await new Promise((resolve) => setTimeout(resolve, 1700)) // a few retries
  assert.equal(logs.filter((l) => /session pass/.test(l)).length, 1, 'logged once, not on every retry')
  up = true
  await waitFor(() => run.session.status().connected, 15000)
  assert.equal(run.session.status().problem, undefined)
})

test('runSession does not wait for a pass: a folder synced before starts offline under the saved name, then takes the pass name', async (t) => {
  const id = generateIdentity()
  const dir = tmp('offline')
  const first = await runSession({ dir, conn: { server, room: 'sp-7', secret: 's' }, name: 'Dana', identity: id, passes: testPasses(id), agentFeed: false })
  await first.stop()
  // The accounts API isn't up yet: fetching a pass fails for real until it is.
  const api = http.createServer((req, res) => {
    const exp = Date.now() + 600_000
    res.writeHead(req.method === 'POST' && req.url === '/v1/passes' ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ pass: makePass({ identity: id, name: 'Dana Smith', exp }), expiresAt: exp }))
  })
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
  const port = api.address().port
  await new Promise((resolve) => api.close(resolve))
  const passes = personPasses({ token: 'qd_test', api: `http://127.0.0.1:${port}` })
  const run = await runSession({ dir, conn: { server, room: 'sp-7', secret: 's' }, name: 'Dana', identity: id, passes, agentFeed: false })
  t.after(async () => { await run.stop(); api.close() })
  const debug = []
  run.session.on('debug', (m) => debug.push(m))
  assert.equal(run.session.name, 'Dana', 'started before any pass, with the saved name')
  await waitFor(() => debug.some((m) => /couldn't get a session pass: Couldn't reach Quilt/.test(m)))
  await new Promise((resolve) => api.listen(port, '127.0.0.1', resolve))
  await waitFor(() => run.session.name === 'Dana Smith', 15000)
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(dir, '.quilt', 'config.json'), 'utf8')).name === 'Dana Smith')
  assert.equal(fs.statSync(path.join(dir, '.quilt', 'config.json')).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(path.join(dir, '.quilt')).filter((f) => f.includes('.tmp-')), [], 'no temp files left')
})

test('runSession stops when the API says this computer is signed out', async () => {
  const passes = new PassSource({ fetchPass: async () => { throw new SignedOutError('This computer was signed out. Sign in again.') } })
  await assert.rejects(
    runSession({ dir: tmp('out'), conn: { server, room: 'sp-8', secret: 's' }, name: 'Dana', identity: generateIdentity(), passes, agentFeed: false }),
    (err) => err.signedOut === true
  )
})
