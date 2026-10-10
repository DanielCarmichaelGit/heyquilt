// The relay with sign-in on: every connection and session request needs a pass
// signed by the accounts API, and the relay takes who you are from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer, relayConfig } from '../../src/server.js'
import { generateIdentity, signChallenge } from '../../src/identity.js'
import * as Y from 'yjs'
import { updateMessage } from '../../src/protocol.js'
import { MSG_AUTH, MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, MSG_CLAIM, MSG_CLAIMS, MSG_PASS, CLOSE_PASS_EXPIRED, CLOSE_DENIED, decoding, bytesMessage, jsonMessage } from '../../src/protocol.js'
import { newPassKeys } from '../../src/passes.js'
import { PASS_KEYS, makePass } from '../helpers/pass-helpers.js'

process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-rp-home-'))
const SIGN_IN = 'Update Quilt and sign in to continue'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
let rooms = 0
const room = () => `rp-${++rooms}`

async function relay (t, opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey, ...opts })
  t.after(() => srv.close())
  return srv
}

/**
 * Connects the way the app does: signs the relay's challenge, then records what
 * the relay says. Resolves once let in (or told to wait for the owner), or with
 * { status, reason } when the upgrade is refused. Rejects if the relay closes
 * the connection first, so a slow round-trip fails instead of hanging.
 */
function connect (srv, r, { identity = generateIdentity(), pass, secret = 's', name = 'url-name', kind = 'human', viewSecret } = {}) {
  const q = new URLSearchParams({ secret, name, key: identity.publicKey, kind, features: 'large-files,branches' })
  if (pass) q.set('pass', pass)
  if (viewSecret) q.set('viewSecret', viewSecret)
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/${r}?${q}`)
  ws.binaryType = 'arraybuffer'
  const c = { ws, access: [], members: [], claims: [] }
  c.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })))
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode, reason: res.statusMessage }))
    c.closed.then(({ code, reason }) => reject(Object.assign(new Error(`closed with ${code} (${reason}) before being let in`), { code })))
    ws.on('error', () => {})
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(dec)
      if (type === MSG_AUTH) ws.send(bytesMessage(MSG_AUTH, signChallenge(identity, r, decoding.readVarUint8Array(dec))))
      else if (type === MSG_ACCESS) { c.access.push(JSON.parse(decoding.readVarString(dec))); resolve(c) } else if (type === MSG_MEMBERS) c.members.push(JSON.parse(decoding.readVarString(dec)))
      else if (type === MSG_CLAIMS) c.claims.push(JSON.parse(decoding.readVarString(dec)))
    })
  })
}
/** How the relay closed the connection, failing (not hanging) if it doesn't within `ms`. */
const closedWithin = (c, ms = 5000) => Promise.race([c.closed, wait(ms).then(() => { throw new Error('still open') })])
const refresh = (c, pass) => c.ws.send(jsonMessage(MSG_PASS, { pass }))
const http = (srv, p, init) => fetch(`http://127.0.0.1:${srv.port}${p}`, init)

test('a valid pass lets you in, under the name and kind it carries', async (t) => {
  const srv = await relay(t)
  const r = room()
  const identity = generateIdentity()
  const c = await connect(srv, r, { identity, pass: makePass({ identity, name: 'Dana' }), name: 'mallory' })
  assert.equal(c.access[0].state, 'approved')
  const bot = generateIdentity()
  await connect(srv, r, { identity: bot, pass: makePass({ identity: bot, name: 'helper', kind: 'agent', sub: 'agent-1' }), kind: 'human' })
  const rm = srv.rooms.get(r)
  assert.deepEqual([...rm.names.values()].sort(), ['Dana', 'helper'])
  assert.deepEqual([...rm.access.values()].map((a) => [a.name, a.kind]).sort(), [['Dana', 'human'], ['helper', 'agent']])
})

test("missing, expired, forged, wrong-version and someone else's passes are refused", async (t) => {
  const srv = await relay(t)
  const identity = generateIdentity()
  const bad = {
    missing: undefined,
    expired: makePass({ identity, exp: Date.now() - 1 }),
    forged: makePass({ identity, keys: newPassKeys() }),
    'wrong version': makePass({ identity, v: 2 }),
    'for another key': makePass({ identity: generateIdentity() }),
    garbage: 'not.a-pass'
  }
  for (const [why, pass] of Object.entries(bad)) {
    const res = await connect(srv, room(), { identity, pass })
    assert.equal(res.status, 401, why)
    assert.equal(res.reason, SIGN_IN, why)
  }
  assert.equal(srv.rooms.size, 0, 'refused before any room is loaded')
})

test('session HTTP routes need a pass in x-quilt-pass', async (t) => {
  const srv = await relay(t)
  const identity = generateIdentity()
  const r = room()
  const pass = makePass({ identity })
  const upload = (headers) => http(srv, `/files/${r}`, { method: 'POST', headers: { 'x-quilt-secret': 's', ...headers }, body: 'hi' })
  const none = await upload({})
  assert.equal(none.status, 401)
  assert.equal(await none.text(), SIGN_IN)
  assert.equal((await upload({ 'x-quilt-pass': makePass({ identity, exp: Date.now() - 1 }) })).status, 401)
  const ok = await upload({ 'x-quilt-pass': pass })
  assert.equal(ok.status, 201)
  const id = await ok.text()
  assert.equal((await http(srv, `/files/${r}/${id}`, { headers: { 'x-quilt-secret': 's' } })).status, 401)
  assert.equal(await (await http(srv, `/files/${r}/${id}`, { headers: { 'x-quilt-secret': 's', 'x-quilt-pass': pass } })).text(), 'hi')

  const blob = (headers) => http(srv, `/blobs/${r}/${'a'.repeat(32)}/upload`, { method: 'POST', headers: { 'x-quilt-secret': 's', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ size: 4 }) })
  assert.equal((await blob({})).status, 401)
  assert.equal((await blob({ 'x-quilt-pass': pass })).status, 200)

  const link = (headers) => http(srv, '/agent/link', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ token: 'tok_' + 'a'.repeat(30), room: r, secret: 's', name: 'x' }) })
  assert.equal((await link({})).status, 401)
  assert.equal((await link({ 'x-quilt-pass': pass })).status, 200)
})

test('with sign-in on, AI links (/mcp/<token>) are refused, even ones made before', async (t) => {
  const srv = await relay(t)
  const identity = generateIdentity()
  const r = room()
  await connect(srv, r, { identity, pass: makePass({ identity }) })
  const token = 'tok_' + 'b'.repeat(30)
  const made = await http(srv, '/agent/link', { method: 'POST', headers: { 'content-type': 'application/json', 'x-quilt-pass': makePass({ identity }) }, body: JSON.stringify({ token, room: r, secret: 's', name: 'x' }) })
  assert.equal(made.status, 200, 'a live link, like the ones saved in agent-links.json')
  const mcp = await http(srv, `/mcp/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) })
  assert.equal(mcp.status, 401)
  assert.equal(await mcp.text(), SIGN_IN)
  assert.equal((await http(srv, `/mcp/${'c'.repeat(30)}`)).status, 401)
})

test('a pass that runs out closes the connection with 4419', async (t) => {
  const srv = await relay(t)
  const identity = generateIdentity()
  const c = await connect(srv, room(), { identity, pass: makePass({ identity, exp: Date.now() + 400 }) })
  assert.deepEqual(await c.closed, { code: CLOSE_PASS_EXPIRED, reason: 'Your sign-in expired. Reconnecting.' })
})

test("a fresh pass in MSG_PASS keeps a connection open; someone else's pass does not", async (t) => {
  const srv = await relay(t)
  const r = room()
  const dana = generateIdentity()
  const kept = await connect(srv, r, { identity: dana, pass: makePass({ identity: dana, exp: Date.now() + 500 }) })
  refresh(kept, makePass({ identity: dana, exp: Date.now() + 60_000 }))
  const eli = generateIdentity()
  const swapped = await connect(srv, r, { identity: eli, pass: makePass({ identity: eli, sub: 'user-eli', name: 'Eli', exp: Date.now() + 500 }) })
  refresh(swapped, makePass({ identity: dana, exp: Date.now() + 60_000 })) // Dana's pass on Eli's connection
  assert.equal((await swapped.closed).code, CLOSE_PASS_EXPIRED)
  assert.equal(kept.ws.readyState, WebSocket.OPEN, 'the refreshed connection is still open')
})

test('someone waiting for the owner can refresh their pass too', async (t) => {
  const srv = await relay(t)
  const r = room()
  const owner = generateIdentity()
  await connect(srv, r, { identity: owner, pass: makePass({ identity: owner, name: 'Olive', sub: 'user-olive' }), viewSecret: 'v' })
  const guest = generateIdentity()
  const g = await connect(srv, r, { identity: guest, pass: makePass({ identity: guest, name: 'Gus', sub: 'user-gus', exp: Date.now() + 500 }) })
  assert.equal(g.access[0].state, 'pending')
  refresh(g, makePass({ identity: guest, name: 'Gus', sub: 'user-gus', exp: Date.now() + 60_000 }))
  await wait(800)
  assert.equal(g.ws.readyState, WebSocket.OPEN)
})

test('the owner sees account names and agent badges', async (t) => {
  const srv = await relay(t)
  const r = room()
  const owner = generateIdentity()
  const o = await connect(srv, r, { identity: owner, pass: makePass({ identity: owner, name: 'Olive', sub: 'user-olive' }), viewSecret: 'v', name: 'olive-laptop' })
  const bot = generateIdentity()
  await connect(srv, r, { identity: bot, pass: makePass({ identity: bot, name: 'helper', kind: 'agent', sub: 'agent-1' }), name: 'pretend-human' })
  const msg = await waitFor(() => o.members.find((m) => m.pending && m.pending.length))
  assert.deepEqual(msg.pending.map((p) => [p.name, p.kind]), [['helper', 'agent']])
  assert.deepEqual(msg.members.map((m) => [m.name, m.role]), [['Olive', 'owner']])
})

test('new sessions are limited per account, not per address', async (t) => {
  const srv = await relay(t, { maxNewRoomsPerHour: 2 })
  const dana = generateIdentity()
  const asDana = () => makePass({ identity: dana })
  assert.equal((await connect(srv, room(), { identity: dana, pass: asDana() })).access[0].state, 'approved')
  assert.equal((await connect(srv, room(), { identity: dana, pass: asDana() })).access[0].state, 'approved')
  assert.equal((await connect(srv, room(), { identity: dana, pass: asDana() })).status, 429)
  const files = await http(srv, `/files/${room()}`, { method: 'POST', headers: { 'x-quilt-secret': 's', 'x-quilt-pass': asDana() }, body: 'x' })
  assert.equal(files.status, 429)
  const eli = generateIdentity()
  const other = await connect(srv, room(), { identity: eli, pass: makePass({ identity: eli, sub: 'user-eli', name: 'Eli' }) })
  assert.equal(other.access[0].state, 'approved', 'another account on the same address can still start one')
})

test('with passes on the relay key is not used, and a bad public key stops the relay', async (t) => {
  assert.equal(relayConfig({ relayKey: 'k', passPublicKey: PASS_KEYS.publicKey }).relayKey, '')
  assert.equal(relayConfig({ relayKey: 'k' }).relayKey, 'k')
  assert.throws(() => startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: 'nope' }), /QUILT_PASS_PUBLIC_KEY/)
  const srv = await relay(t, { relayKey: 'k' })
  const identity = generateIdentity()
  assert.equal((await connect(srv, room(), { identity, pass: makePass({ identity }) })).access[0].state, 'approved', 'no relay key needed')
})

test('without QUILT_PASS_PUBLIC_KEY the relay works as before', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  t.after(() => srv.close())
  const r = room()
  const c = await connect(srv, r, { name: 'plain' })
  assert.equal(c.access[0].state, 'approved')
  assert.deepEqual([...srv.rooms.get(r).names.values()], ['plain'])
  assert.equal((await http(srv, `/files/${r}`, { method: 'POST', headers: { 'x-quilt-secret': 's' }, body: 'x' })).status, 201)
})

// With sign-in on, who you are in a room is your account (kind + sub), not your computer's key.
let adminIds = 0
function admin (c, req) {
  const id = ++adminIds
  c.ws.send(jsonMessage(MSG_ADMIN, { id, ...req }))
  return waitFor(() => c.members.find((m) => m.reply && m.reply.id === id)?.reply)
}
const latest = (c) => c.members[c.members.length - 1]

test('the same account on two computers is the same owner and the same member', async (t) => {
  const srv = await relay(t)
  const r = room()
  const asOlive = (identity) => makePass({ identity, name: 'Olive', sub: 'user-olive' })
  const laptop = generateIdentity()
  const o = await connect(srv, r, { identity: laptop, pass: asOlive(laptop), viewSecret: 'v' })
  assert.equal(o.access[0].owner, true)
  const desktop = generateIdentity()
  const o2 = await connect(srv, r, { identity: desktop, pass: asOlive(desktop) })
  assert.deepEqual([o2.access[0].state, o2.access[0].owner], ['approved', true], 'the owner on another computer')

  const asGus = (identity) => makePass({ identity, name: 'Gus', sub: 'user-gus' })
  const gusA = generateIdentity()
  const g1 = await connect(srv, r, { identity: gusA, pass: asGus(gusA) })
  assert.equal(g1.access[0].state, 'pending')
  const waiting = await waitFor(() => latest(o).pending?.find((p) => p.name === 'Gus'))
  assert.equal(waiting.key, 'person:user-gus')
  assert.deepEqual(await admin(o, { op: 'approve', key: waiting.key, role: 'viewer' }), { id: adminIds, ok: true })
  await waitFor(() => g1.access.find((a) => a.state === 'approved'))

  const gusB = generateIdentity()
  const g2 = await connect(srv, r, { identity: gusB, pass: asGus(gusB) })
  assert.deepEqual([g2.access[0].state, g2.access[0].role], ['approved', 'viewer'], 'approved once, on any computer')
  const list = await waitFor(() => { const m = latest(o).members; return m.filter((x) => x.name === 'Gus' && x.online).length ? m : null })
  assert.deepEqual(list.map((m) => [m.key, m.name, m.role]), [['person:user-olive', 'Olive', 'owner'], ['person:user-gus', 'Gus', 'viewer']])

  // The key the owner's app got back works for changes too, on every computer.
  assert.equal((await admin(o2, { op: 'set', key: 'person:user-gus', role: 'editor' })).ok, true)
  await waitFor(() => g2.access.find((a) => a.role === 'editor'))
  assert.equal((await admin(o, { op: 'remove', key: 'person:user-gus' })).ok, true)
  assert.equal((await g1.closed).code, CLOSE_DENIED)
  assert.equal((await g2.closed).code, CLOSE_DENIED)
})

test('two accounts with the same name can both be in a room', async (t) => {
  const srv = await relay(t)
  const r = room()
  const a = generateIdentity()
  const b = generateIdentity()
  const ca = await connect(srv, r, { identity: a, pass: makePass({ identity: a, name: 'Sam', sub: 'user-sam-1' }) })
  const cb = await connect(srv, r, { identity: b, pass: makePass({ identity: b, name: 'Sam', sub: 'user-sam-2' }) })
  assert.equal(ca.access[0].state, 'approved')
  assert.equal(cb.access[0].state, 'approved')
  assert.deepEqual([...srv.rooms.get(r).names.values()], ['Sam', 'Sam'])
})

test('a person and an agent with the same sub are different identities', async (t) => {
  const srv = await relay(t)
  const r = room()
  const owner = generateIdentity()
  const o = await connect(srv, r, { identity: owner, pass: makePass({ identity: owner, name: 'Olive', sub: 'same' }), viewSecret: 'v' })
  const bot = generateIdentity()
  const b = await connect(srv, r, { identity: bot, pass: makePass({ identity: bot, name: 'helper', kind: 'agent', sub: 'same' }) })
  assert.equal(b.access[0].state, 'pending', 'the agent is not the owner')
  const waiting = await waitFor(() => latest(o).pending?.find((p) => p.name === 'helper'))
  assert.equal(waiting.key, 'agent:same')
  assert.equal((await admin(o, { op: 'approve', key: waiting.key })).ok, true)
  const list = await waitFor(() => latest(o).members.length === 2 && latest(o).members)
  assert.deepEqual(list.map((m) => [m.key, m.role]), [['person:same', 'owner'], ['agent:same', 'editor']])
})

test("a room owned by a computer key gets its owner's account the first time they sign in", async (t) => {
  const srv = await relay(t)
  const r = room()
  const laptop = generateIdentity()
  const old = generateIdentity()
  // An older room: owned by a key, with a member approved by key.
  await connect(srv, r, { identity: laptop, pass: makePass({ identity: laptop, name: 'Olive', sub: 'user-olive' }), viewSecret: 'v' })
  const rm = srv.rooms.get(r)
  delete rm.meta.ownerSub
  rm.meta.members[old.publicKey] = { name: 'Gus', kind: 'human', role: 'viewer', scopes: [], since: 1 }
  const again = await connect(srv, r, { identity: laptop, pass: makePass({ identity: laptop, name: 'Olive', sub: 'user-olive' }) })
  assert.equal(again.access[0].owner, true)
  assert.equal(rm.meta.ownerSub, 'person:user-olive')
  const g = await connect(srv, r, { identity: old, pass: makePass({ identity: old, name: 'Gus', sub: 'user-gus' }) })
  assert.deepEqual([g.access[0].state, g.access[0].role], ['approved', 'viewer'], 'members approved by key still match by key')
  const desktop = generateIdentity()
  const d = await connect(srv, r, { identity: desktop, pass: makePass({ identity: desktop, name: 'Olive', sub: 'user-olive' }) })
  assert.equal(d.access[0].owner, true, 'and then on any computer')
})

let claimIds = 0
function claim (c, req) {
  const id = ++claimIds
  c.ws.send(jsonMessage(MSG_CLAIM, { id, ...req }))
  return waitFor(() => c.claims.find((m) => m.reply && m.reply.id === id)?.reply)
}

test('claims belong to the account: two people named Sam cannot release each other\'s', async (t) => {
  const srv = await relay(t)
  const r = room()
  const asSam = (identity, sub) => makePass({ identity, name: 'Sam', sub })
  const k1 = generateIdentity()
  const k2 = generateIdentity()
  const k3 = generateIdentity()
  const sam1 = await connect(srv, r, { identity: k1, pass: asSam(k1, 'user-sam-1') })
  const sam2 = await connect(srv, r, { identity: k2, pass: asSam(k2, 'user-sam-2') })
  assert.equal((await claim(sam1, { op: 'claim', pattern: 'src/a.js' })).ok, true)
  assert.deepEqual(srv.rooms.get(r).meta.claims['src/a.js'].byId, 'person:user-sam-1')
  const theirs = await claim(sam2, { op: 'release', pattern: 'src/a.js' })
  assert.equal(theirs.ok, false)
  assert.match(theirs.error, /only they can release it/)
  assert.equal((await claim(sam2, { op: 'claim', pattern: 'src/a.js' })).ok, false, 'nor claim it over them')
  assert.deepEqual(await claim(sam2, { op: 'release', pattern: '*' }), { id: claimIds, ok: true, released: 0 })
  // The same account on another computer can.
  const sam1b = await connect(srv, r, { identity: k3, pass: asSam(k3, 'user-sam-1') })
  assert.deepEqual(await claim(sam1b, { op: 'release', pattern: 'src/a.js' }), { id: claimIds, ok: true, released: 1 })
})

test('older claims with no account: the owner, or someone with the same name, can release them', async (t) => {
  const srv = await relay(t)
  const r = room()
  const owner = generateIdentity()
  const o = await connect(srv, r, { identity: owner, pass: makePass({ identity: owner, name: 'Olive', sub: 'user-olive' }), viewSecret: 'v' })
  const rm = srv.rooms.get(r)
  for (const p of ['old.js', 'kept.js', 'mine.js']) rm.meta.claims[p] = { by: 'Sam', pattern: p, note: '', ts: 1 }
  rm.meta.claims['pat.js'] = { by: 'Pat', pattern: 'pat.js', note: '', ts: 1 }
  rm.meta.members['person:user-sam'] = { name: 'Sam', kind: 'human', role: 'editor', scopes: [], since: 1 }
  const k = generateIdentity()
  const sam = await connect(srv, r, { identity: k, pass: makePass({ identity: k, name: 'Sam', sub: 'user-sam' }) })
  // Someone else's older claim is still theirs.
  const pats = await claim(sam, { op: 'release', pattern: 'pat.js' })
  assert.equal(pats.ok, false)
  assert.match(pats.error, /only they can release it/)
  // Sam's own older claims: released, or claimed again and adopted by Sam's account.
  assert.equal((await claim(sam, { op: 'release', pattern: 'old.js' })).released, 1)
  assert.equal((await claim(sam, { op: 'claim', pattern: 'mine.js', note: 'again' })).ok, true)
  assert.equal(rm.meta.claims['mine.js'].byId, 'person:user-sam', 'adopted')
  // Once adopted, the name alone is no longer enough: another Sam can't release it.
  rm.meta.members['person:user-sam-2'] = { name: 'Sam', kind: 'human', role: 'editor', scopes: [], since: 1 }
  const k2 = generateIdentity()
  const sam2 = await connect(srv, r, { identity: k2, pass: makePass({ identity: k2, name: 'Sam', sub: 'user-sam-2' }) })
  assert.equal((await claim(sam2, { op: 'release', pattern: 'mine.js' })).ok, false)
  // The owner can release any older claim.
  assert.equal((await claim(o, { op: 'release', pattern: 'pat.js' })).released, 1)
  assert.equal((await claim(o, { op: 'release', pattern: 'kept.js' })).released, 1)
})

test('removing an account also removes its older key entries', async (t) => {
  const srv = await relay(t)
  const r = room()
  const owner = generateIdentity()
  const o = await connect(srv, r, { identity: owner, pass: makePass({ identity: owner, name: 'Olive', sub: 'user-olive' }), viewSecret: 'v' })
  const rm = srv.rooms.get(r)
  const old = generateIdentity()
  rm.meta.members[old.publicKey] = { name: 'Gus', kind: 'human', role: 'editor', scopes: [], since: 1 }
  const asGus = (identity) => makePass({ identity, name: 'Gus', sub: 'user-gus' })
  const g = await connect(srv, r, { identity: old, pass: asGus(old) })
  assert.equal(g.access[0].state, 'approved', 'let in by the key-keyed entry')
  rm.meta.members['person:user-gus'] = { name: 'Gus', kind: 'human', role: 'editor', scopes: [], since: 2 }
  assert.equal((await admin(o, { op: 'remove', key: 'person:user-gus' })).ok, true)
  assert.equal((await closedWithin(g)).code, CLOSE_DENIED)
  assert.equal(rm.meta.members[old.publicKey], undefined)
  const back = await connect(srv, r, { identity: old, pass: asGus(old) })
  assert.equal(back.access[0].state, 'pending', "can't get back in by key")
})

test('without passes, claims still belong to names', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  t.after(() => srv.close())
  const r = room()
  const c = await connect(srv, r, { name: 'plain' })
  assert.equal((await claim(c, { op: 'claim', pattern: 'x.js' })).ok, true)
  assert.deepEqual(Object.keys(srv.rooms.get(r).meta.claims['x.js']).sort(), ['by', 'note', 'pattern', 'ts'])
})

test("in a session with an owner, files and stored files need the owner's approval, not just the secret", async (t) => {
  const srv = await relay(t)
  const r = room()
  const owner = generateIdentity()
  const ownerPass = makePass({ identity: owner, name: 'Olive', sub: 'user-olive' })
  const o = await connect(srv, r, { identity: owner, pass: ownerPass, viewSecret: 'v' })
  const NOT_LET_IN = "The session owner hasn't let you in yet."
  const blobId = 'b'.repeat(32)
  const routes = (pass) => ({
    upload: () => http(srv, `/files/${r}`, { method: 'POST', headers: { 'x-quilt-secret': 's', 'x-quilt-pass': pass }, body: 'hi' }),
    download: (id) => http(srv, `/files/${r}/${id}`, { headers: { 'x-quilt-secret': 's', 'x-quilt-pass': pass } }),
    blob: (action) => http(srv, `/blobs/${r}/${blobId}/${action}`, { method: 'POST', headers: { 'x-quilt-secret': 's', 'x-quilt-pass': pass, 'content-type': 'application/json' }, body: JSON.stringify({ size: 4 }) })
  })
  const mine = routes(ownerPass)
  const up = await mine.upload()
  assert.equal(up.status, 201, 'the owner can')
  const fileId = await up.text()
  assert.equal((await mine.blob('upload')).status, 200)

  const gus = generateIdentity()
  const gusPass = makePass({ identity: gus, name: 'Gus', sub: 'user-gus' })
  const g = await connect(srv, r, { identity: gus, pass: gusPass })
  assert.equal(g.access[0].state, 'pending')
  const theirs = routes(gusPass)
  for (const res of [await theirs.upload(), await theirs.download(fileId), await theirs.blob('upload'), await theirs.blob('download')]) {
    assert.equal(res.status, 403)
    assert.equal(await res.text(), NOT_LET_IN)
  }
  const waiting = await waitFor(() => latest(o).pending?.find((p) => p.name === 'Gus'))
  assert.equal((await admin(o, { op: 'approve', key: waiting.key })).ok, true)
  assert.equal((await theirs.upload()).status, 201)
  assert.equal(await (await theirs.download(fileId)).text(), 'hi')
  assert.equal((await theirs.blob('upload')).status, 200)
  assert.equal((await theirs.blob('download')).status, 200)

  // A member approved before sign-in, under their computer's key, still counts.
  const old = generateIdentity()
  srv.rooms.get(r).meta.members[old.publicKey] = { name: 'Lee', kind: 'human', role: 'editor', scopes: [], since: 1 }
  assert.equal((await routes(makePass({ identity: old, name: 'Lee', sub: 'user-lee' })).upload()).status, 201)
})

// Claims from accounts that are gone (a revoked or re-invited agent, someone removed) must not
// hold files for good.
async function claimRoom (t, opts = {}) {
  const srv = await relay(t, opts)
  const r = room()
  const owner = generateIdentity()
  const o = await connect(srv, r, { identity: owner, pass: makePass({ identity: owner, name: 'Olive', sub: 'user-olive' }), viewSecret: 'v' })
  const rm = srv.rooms.get(r)
  const agent = async (sub, name = 'Duncan') => {
    rm.meta.members[`agent:${sub}`] = { name, kind: 'agent', role: 'editor', scopes: [], since: 1 }
    const k = generateIdentity()
    return connect(srv, r, { identity: k, kind: 'agent', pass: makePass({ identity: k, name, kind: 'agent', sub }) })
  }
  return { srv, r, o, rm, agent }
}

test('removing an agent releases its claims', async (t) => {
  const { o, rm, agent } = await claimRoom(t)
  const d = await agent('dd5b7a3a')
  assert.equal((await claim(d, { op: 'claim', pattern: 'src/mcp.js' })).ok, true)
  assert.equal((await claim(o, { op: 'claim', pattern: 'README.md' })).ok, true)
  assert.equal((await admin(o, { op: 'remove', key: 'agent:dd5b7a3a' })).ok, true)
  assert.deepEqual(Object.keys(rm.meta.claims), ['README.md'], "only the owner's claim is left")
  await waitFor(() => o.claims.some((m) => m.claims && !m.claims.some((c) => c.pattern === 'src/mcp.js')))
})

test('a re-invited agent under the same name does not inherit the old claims, but may release them', async (t) => {
  const { rm, agent } = await claimRoom(t)
  const old = await agent('dd5b7a3a')
  assert.equal((await claim(old, { op: 'claim', pattern: 'src/mcp.js' })).ok, true)
  assert.equal((await claim(old, { op: 'claim', pattern: 'src/ui/app.css' })).ok, true)
  old.ws.close()
  await waitFor(() => rm.claimList().every((c) => !c.active))
  const fresh = await agent('509a3f23')
  assert.equal((await claim(fresh, { op: 'release', pattern: '*' })).released, 0, 'not its claims')
  assert.equal(rm.meta.claims['src/mcp.js'].byId, 'agent:dd5b7a3a', 'nor adopted')
  assert.equal((await claim(fresh, { op: 'claim', pattern: 'src/mcp.js' })).ok, false, 'claiming over it is refused')
  assert.equal((await claim(fresh, { op: 'release', pattern: 'src/mcp.js' })).released, 1, 'but it may let go of one left under its name')
  assert.equal((await claim(fresh, { op: 'claim', pattern: 'src/mcp.js' })).ok, true)
  assert.equal(rm.meta.claims['src/mcp.js'].byId, 'agent:509a3f23')
})

test('a claim goes once its holder has done nothing for a while, even if still connected', async (t) => {
  const { rm, agent, o } = await claimRoom(t, { claimIdleMs: 60 * 1000 })
  const idle = await agent('idle', 'Idle')
  const busy = await agent('busy', 'Busy')
  assert.equal((await claim(idle, { op: 'claim', pattern: 'a.js' })).ok, true)
  assert.equal((await claim(busy, { op: 'claim', pattern: 'b.js' })).ok, true)
  assert.deepEqual(rm.claimList().map((c) => c.active), [true, true], 'both in the session')
  const t0 = Date.now()
  // Busy changes the document (a file, a message, its feed) 50s later; Idle does nothing.
  const doc = new Y.Doc()
  doc.getMap('files').set('b.js', new Y.Text('x'))
  busy.ws.send(updateMessage(Y.encodeStateAsUpdate(doc)))
  await waitFor(() => rm.meta.seen['agent:busy'] >= t0)
  rm.meta.seen['agent:busy'] = t0 + 50 * 1000
  assert.equal(rm.sweepClaims(t0 + 30 * 1000), 0, 'not yet')
  assert.equal(rm.sweepClaims(t0 + 61 * 1000), 1)
  assert.deepEqual(Object.keys(rm.meta.claims), ['b.js'], 'activity keeps a claim')
  await waitFor(() => o.claims.some((m) => m.claims && m.claims.length === 1 && m.claims[0].pattern === 'b.js'))
  // A claim left from before the relay loaded the room counts from when it loaded.
  rm.meta.claims['old.js'] = { by: 'Ghost', byId: 'agent:ghost', pattern: 'old.js', note: '', ts: 1 }
  rm.loadedAt = Date.now() - 61 * 1000
  assert.equal(rm.sweepClaims(t0 + 70 * 1000), 1)
  assert.equal(rm.meta.claims['old.js'], undefined)
})

const chatOf = (rm) => rm.doc.getArray('chat').toArray()

test('the file queue: ask for a claimed file, and its holder must hand it off with context', async (t) => {
  const { rm, agent } = await claimRoom(t)
  const mine = await agent('mine', 'Mine')
  const other = await agent('other', 'Other')
  const third = await agent('third', 'Third')
  assert.equal((await claim(mine, { op: 'claim', pattern: 'src/**' })).ok, true)
  assert.match((await claim(other, { op: 'request', path: 'free.js', title: 'x' })).error, /not claimed/)
  assert.match((await claim(other, { op: 'request', path: 'src/mcp.js', title: '' })).error, /title required/)
  const r = await claim(other, { op: 'request', path: 'src/mcp.js', title: 'Working on tools for task 12', description: 'Add quilt_handoff. '.repeat(30), task: '12' })
  assert.deepEqual([r.ok, r.position, r.holder, r.pattern], [true, 1, 'Mine', 'src/**'])
  assert.equal(rm.meta.claims['src/**'].queue[0].description.length, 300, 'kept to 300 characters')
  assert.equal((await claim(third, { op: 'request', path: 'src/ui/app.css', title: 'Restyle' })).position, 2)
  assert.equal((await claim(other, { op: 'request', path: 'src/mcp.js', title: 'Tools, again' })).position, 1, 'asking again keeps its place')
  // The holder hears about it in a direct message that asks for no answer.
  const told = chatOf(rm).filter((m) => m.kind === 'queue' && m.to === 'Mine')
  assert.equal(told.length, 3)
  assert.match(told[0].text, /src\/mcp\.js: Working on tools/)
  // It can't just let go of the file now.
  assert.match((await claim(mine, { op: 'release', pattern: 'src/**' })).error, /Other, Third are waiting for src\/\*\* in its file queue/)
  assert.deepEqual(await claim(mine, { op: 'release', pattern: '*' }), { id: claimIds, ok: true, released: 0, held: ['src/**'] })
  assert.match((await claim(mine, { op: 'handoff', pattern: 'src/**' })).error, /context required/)
  assert.match((await claim(other, { op: 'handoff', pattern: 'src/**', context: 'mine now' })).error, /Mine's to hand off/)
  const h = await claim(mine, { op: 'handoff', pattern: 'src/**', context: 'Changed the claim ops; tests in relay-passes still to update.' })
  assert.deepEqual([h.ok, h.to, h.waiting], [true, 'Other', 1])
  const c = rm.meta.claims['src/**']
  assert.deepEqual([c.by, c.byId, c.note, c.from, c.queue.map((x) => x.by)], ['Other', 'agent:other', 'Tools, again', 'Mine', ['Third']])
  const dm = chatOf(rm).find((m) => m.kind === 'handoff')
  assert.deepEqual([dm.by, dm.to, dm.path], ['Mine', 'Other', 'src/**'])
  assert.match(dm.text, /My context: Changed the claim ops/)
  // Third withdraws; then Other can release it.
  const rid = c.queue[0].id
  assert.match((await claim(other, { op: 'withdraw', request: rid })).error, /not yours/)
  assert.equal((await claim(third, { op: 'withdraw', request: rid })).withdrawn, 1)
  assert.equal((await claim(other, { op: 'release', pattern: 'src/**' })).released, 1)
  assert.deepEqual(rm.meta.claims, {})
})

test('an idle, removed or released-by-owner holder passes the file to the first one waiting', async (t) => {
  const { rm, agent, o } = await claimRoom(t, { claimIdleMs: 60 * 1000 })
  const a = await agent('a1', 'Ann')
  const b = await agent('b1', 'Bob')
  const c = await agent('c1', 'Cal')
  assert.equal((await claim(a, { op: 'claim', pattern: 'x.js' })).ok, true)
  await claim(b, { op: 'request', path: 'x.js', title: 'Bob next' })
  await claim(c, { op: 'request', path: 'x.js', title: 'Cal after' })
  rm.meta.seen['agent:b1'] = Date.now()
  assert.equal(rm.sweepClaims(Date.now() + 61 * 1000), 1)
  assert.equal(rm.meta.claims['x.js'].by, 'Bob', 'idle Ann: handed to Bob')
  assert.match(chatOf(rm).filter((m) => m.kind === 'handoff').pop().text, /Ann had done nothing in the session for 1 minutes/)
  assert.equal((await claim(o, { op: 'release', pattern: 'x.js' })).released, 1)
  assert.equal(rm.meta.claims['x.js'].by, 'Cal', "the owner's release: handed to Cal")
  await claim(a, { op: 'request', path: 'x.js', title: 'Ann again' })
  await claim(b, { op: 'request', path: 'x.js', title: 'Bob again' })
  assert.equal((await admin(o, { op: 'remove', key: 'agent:a1' })).ok, true)
  assert.deepEqual(rm.meta.claims['x.js'].queue.map((r) => r.by), ['Bob'], "a removed member's requests go")
  assert.equal((await admin(o, { op: 'remove', key: 'agent:c1' })).ok, true)
  assert.equal(rm.meta.claims['x.js'].by, 'Bob', 'removed Cal: handed to Bob')
})

test("an agent can't release another agent's claim; the owner can, and can clear everyone away", async (t) => {
  const { rm, agent, o } = await claimRoom(t)
  const a = await agent('aaa', 'Ann')
  const b = await agent('bbb', 'Bob')
  const c = await agent('ccc', 'Cal')
  assert.equal((await claim(a, { op: 'claim', pattern: 'a.js' })).ok, true)
  assert.equal((await claim(b, { op: 'claim', pattern: 'b.js' })).ok, true)
  assert.equal((await claim(c, { op: 'claim', pattern: 'c.js' })).ok, true)
  const refused = await claim(b, { op: 'release', pattern: 'a.js' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /only they can release it/)
  assert.equal((await claim(b, { op: 'clear-inactive' })).ok, false, 'only the owner clears')
  assert.equal((await claim(o, { op: 'release', pattern: 'a.js' })).released, 1, 'the owner may release an active claim')
  c.ws.close()
  await waitFor(() => rm.claimList().find((x) => x.pattern === 'c.js').active === false)
  assert.equal((await claim(o, { op: 'clear-inactive' })).released, 1)
  assert.deepEqual(Object.keys(rm.meta.claims), ['b.js'])
})
