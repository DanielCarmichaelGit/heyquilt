// The owner's controls with access types: approving someone as a type (the app sends the
// access it comes to), narrowing a person's access live (never past what their pass
// allows), and removing someone so an older pass can't bring them back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer } from '../../src/server.js'
import { generateIdentity, signChallenge } from '../../src/identity.js'
import { MSG_AUTH, MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, MSG_PASS, CLOSE_DENIED, decoding, bytesMessage, jsonMessage } from '../../src/protocol.js'
import { PASS_KEYS, makePass } from '../helpers/pass-helpers.js'
import { PASS_TTL_MS } from '../../src/passes.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-roa-home-'))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const EDIT_ALL = { files: 'edit', folders: [], foldersExcept: [], talk: true }
let rooms = 0

async function relay (t) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  t.after(() => srv.close())
  return srv
}
function connect (srv, r, { identity = generateIdentity(), pass, viewSecret } = {}) {
  const q = new URLSearchParams({ name: 'x', key: identity.publicKey, kind: 'human', features: 'large-files,branches' })
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/${r}?${q}`, { headers: { 'x-quilt-secret': 's', 'x-quilt-pass': pass, ...(viewSecret ? { 'x-quilt-view-secret': viewSecret } : {}) } })
  ws.binaryType = 'arraybuffer'
  const c = { ws, access: [], members: [] }
  c.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  return new Promise((resolve) => {
    ws.on('error', () => {})
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(dec)
      if (type === MSG_AUTH) ws.send(bytesMessage(MSG_AUTH, signChallenge(identity, r, decoding.readVarUint8Array(dec))))
      else if (type === MSG_ACCESS) { c.access.push(JSON.parse(decoding.readVarString(dec))); resolve(c) } else if (type === MSG_MEMBERS) c.members.push(JSON.parse(decoding.readVarString(dec)))
    })
  })
}
const last = (c) => c.access[c.access.length - 1]
let adminIds = 0
function admin (c, req) {
  const id = ++adminIds
  c.ws.send(jsonMessage(MSG_ADMIN, { id, ...req }))
  return waitFor(() => c.members.find((m) => m.reply && m.reply.id === id)?.reply)
}
/** A room with its owner connected, and a way to connect as someone with a room pass. */
async function ownedRoom (t) {
  const srv = await relay(t)
  const r = `roa-${++rooms}`
  const oid = generateIdentity()
  const owner = await connect(srv, r, { identity: oid, pass: makePass({ identity: oid, sub: 'olive', name: 'Olive' }), viewSecret: 'v' })
  assert.equal(last(owner).owner, true)
  const as = async (sub, access, extra = {}) => {
    const identity = extra.identity || generateIdentity()
    return connect(srv, r, { identity, pass: makePass({ identity, sub, name: sub, room: r, access, ...extra }) })
  }
  return { srv, r, owner, as }
}

test('approving with a type lets them in with the access it comes to, and asks their app for a fresh pass', async (t) => {
  const { srv, r, owner, as } = await ownedRoom(t)
  const sam = await as('sam', null)
  assert.equal(last(sam).state, 'pending')
  const reply = await admin(owner, { op: 'approve', key: 'person:sam', typeId: 'builtin:edit', access: { files: 'edit', folders: ['src'], foldersExcept: ['src/keys'], talk: false } })
  assert.equal(reply.ok, true)
  await waitFor(() => last(sam).state === 'approved' && last(sam).refresh)
  assert.deepEqual([last(sam).role, last(sam).scopes, last(sam).scopesExcept, last(sam).talk], ['editor', ['src'], ['src/keys'], false])
  const m = srv.rooms.get(r).meta.members['person:sam']
  assert.deepEqual([m.role, m.scopes, m.scopesExcept, m.talk], ['editor', ['src'], ['src/keys'], false])
  assert.equal((await admin(owner, { op: 'approve', key: 'person:nobody', access: { files: 'owner' } })).ok, false, 'bad access is refused')
})

test("the owner can narrow someone's access live, but never past what their pass allows", async (t) => {
  const { owner, as } = await ownedRoom(t)
  const identity = generateIdentity()
  const kim = await as('kim', { ...EDIT_ALL, folders: ['src'] }, { identity })
  assert.deepEqual(last(kim).scopes, ['src'])
  await admin(owner, { op: 'set', key: 'person:kim', access: EDIT_ALL })
  await waitFor(() => last(kim).refresh)
  assert.deepEqual([last(kim).role, last(kim).scopes], ['editor', ['src']], 'all folders asks for more than the pass allows')
  await admin(owner, { op: 'set', key: 'person:kim', access: { ...EDIT_ALL, folders: ['src'], talk: false } })
  await waitFor(() => last(kim).talk === false)
  // An older app's role change narrows the same way.
  await admin(owner, { op: 'set', key: 'person:kim', role: 'viewer' })
  await waitFor(() => last(kim).role === 'viewer')
  kim.ws.close()
  // Coming back with a pass issued before the change doesn't undo it...
  const back = await as('kim', { ...EDIT_ALL, folders: ['src'] }, { identity, iat: Date.now() - 60000 })
  assert.equal(last(back).role, 'viewer')
  back.ws.close()
  // ...but a newer pass from the API, which the owner's app updated, applies.
  const fresh = await as('kim', EDIT_ALL, { identity, iat: Date.now() + 1 })
  assert.deepEqual([last(fresh).role, last(fresh).scopes, last(fresh).talk], ['editor', [], true])
})

test("a fresh pass from the same moment as the owner's change is asked for again, so more access still arrives", async (t) => {
  const { srv, r, owner, as } = await ownedRoom(t)
  const identity = generateIdentity()
  const VIEW = { ...EDIT_ALL, files: 'view' }
  const kim = await as('kim', VIEW, { identity })
  assert.equal(last(kim).role, 'viewer')
  // The owner's app gives Kim more on the API, then tells the relay: it narrows at once, more waits for a fresh pass.
  await admin(owner, { op: 'set', key: 'person:kim', access: { ...EDIT_ALL, talk: false } })
  await waitFor(() => last(kim).refresh && last(kim).talk === false)
  const { setAt } = srv.rooms.get(r).meta.members['person:kim']
  const pass = (iat) => makePass({ identity, sub: 'kim', name: 'kim', room: r, access: { ...EDIT_ALL, talk: false }, iat })
  // Issued in the same millisecond as the change, so the relay can't tell it saw the change: it asks again.
  const seen = kim.access.length
  kim.ws.send(jsonMessage(MSG_PASS, { pass: pass(setAt) }))
  await waitFor(() => kim.access.length > seen)
  assert.deepEqual([last(kim).role, last(kim).refresh], ['viewer', true])
  // The next one is newer than the change, and brings the rest.
  kim.ws.send(jsonMessage(MSG_PASS, { pass: pass(setAt + 1) }))
  await waitFor(() => last(kim).role === 'editor')
  assert.equal(last(kim).talk, false)
  // Coming back with a pass from before the change asks for a newer one at once, too.
  kim.ws.close()
  const back = await as('kim', EDIT_ALL, { identity, iat: setAt - 1000 })
  assert.deepEqual([last(back).talk, last(back).refresh], [false, true])
})

test('someone the owner let in before access types can still be given more', async (t) => {
  const { owner, as } = await ownedRoom(t)
  const lee = await as('lee', null)
  await admin(owner, { op: 'approve', key: 'person:lee', role: 'viewer' })
  await waitFor(() => last(lee).state === 'approved')
  await admin(owner, { op: 'set', key: 'person:lee', access: EDIT_ALL })
  await waitFor(() => last(lee).role === 'editor')
})

test('a removed person cannot come back with a pass issued before the removal', async (t) => {
  const { owner, as } = await ownedRoom(t)
  const identity = generateIdentity()
  const old = Date.now() - 1000
  const pat = await as('pat', EDIT_ALL, { identity, iat: old })
  assert.equal(last(pat).state, 'approved')
  await admin(owner, { op: 'remove', key: 'person:pat' })
  assert.equal(await pat.closed, CLOSE_DENIED)
  const again = await as('pat', EDIT_ALL, { identity, iat: old })
  assert.equal(last(again).state, 'pending', 'their old pass still says edit, but they were removed since')
  again.ws.close()
  const invited = await as('pat', EDIT_ALL, { identity, iat: Date.now() + 1 })
  assert.equal(last(invited).state, 'approved', 'the owner gave them a grant again')
})

test('someone let in as a type waits again if they come back without a room pass, until a room pass or the owner lets them in', async (t) => {
  const { srv, r, owner, as } = await ownedRoom(t)
  const identity = generateIdentity()
  const sam = await as('sam', null, { identity })
  await admin(owner, { op: 'approve', key: 'person:sam', typeId: 'builtin:edit', access: EDIT_ALL })
  await waitFor(() => last(sam).state === 'approved')
  assert.equal(srv.rooms.get(r).meta.members['person:sam'].granted, true)
  sam.ws.close()
  // A pass with no room carries no grant: the stored record doesn't let them in.
  const bare = await connect(srv, r, { identity, pass: makePass({ identity, sub: 'sam', name: 'sam' }) })
  assert.equal(last(bare).state, 'pending')
  await waitFor(() => owner.members.some((m) => m.pending && m.pending.some((p) => p.key === 'person:sam')))
  // The owner lets them in again.
  await admin(owner, { op: 'approve', key: 'person:sam', typeId: 'builtin:view', access: { ...EDIT_ALL, files: 'view' } })
  await waitFor(() => last(bare).state === 'approved')
  assert.equal(last(bare).role, 'viewer')
  bare.ws.close()
  // A room pass with no grant (the API refused it) still finds the stored record.
  const room = await as('sam', null, { identity })
  assert.deepEqual([last(room).state, last(room).role], ['approved', 'viewer'])
  room.ws.close()
})

test('someone let in by a grant needs a room pass to use the session, on the socket and over HTTP', async (t) => {
  const { srv, r, as } = await ownedRoom(t)
  const identity = generateIdentity()
  const kim = await as('kim', { ...EDIT_ALL, folders: ['src'] }, { identity })
  assert.equal(last(kim).state, 'approved')
  kim.ws.close()
  const bare = makePass({ identity, sub: 'kim', name: 'kim' })
  const again = await connect(srv, r, { identity, pass: bare })
  assert.equal(last(again).state, 'pending')
  again.ws.close()
  const res = await fetch(`http://127.0.0.1:${srv.port}/files/${r}`, { method: 'POST', headers: { 'x-quilt-secret': 's', 'x-quilt-pass': bare }, body: 'hi' })
  assert.equal(res.status, 403)
})

test("the owner's set stores what both allow, never a request wider than the pass", async (t) => {
  const { srv, r, owner, as } = await ownedRoom(t)
  const kim = await as('kim', { ...EDIT_ALL, folders: ['src'] })
  await admin(owner, { op: 'set', key: 'person:kim', access: { ...EDIT_ALL, talk: false } })
  await waitFor(() => last(kim).talk === false)
  const m = srv.rooms.get(r).meta.members['person:kim']
  assert.deepEqual([m.role, m.scopes, m.talk], ['editor', ['src'], false], 'all folders was more than the pass allowed')
})

test('someone the owner let in before access types still comes back without a room pass', async (t) => {
  const { srv, r, owner, as } = await ownedRoom(t)
  const identity = generateIdentity()
  const lee = await as('lee', null, { identity })
  await admin(owner, { op: 'approve', key: 'person:lee', role: 'viewer' })
  await waitFor(() => last(lee).state === 'approved')
  lee.ws.close()
  const back = await connect(srv, r, { identity, pass: makePass({ identity, sub: 'lee', name: 'lee' }) })
  assert.deepEqual([last(back).state, last(back).role], ['approved', 'viewer'])
  back.ws.close()
})

test('removals are kept only while a pass from before them could still be valid', async (t) => {
  const { srv, r, owner, as } = await ownedRoom(t)
  const rm = srv.rooms.get(r)
  rm.meta.removed = { 'person:long-ago': Date.now() - PASS_TTL_MS - 1000 }
  const pat = await as('pat', EDIT_ALL)
  await admin(owner, { op: 'remove', key: 'person:pat' })
  await pat.closed
  assert.deepEqual(Object.keys(rm.meta.removed), ['person:pat'], 'the old one could match no valid pass')
})
