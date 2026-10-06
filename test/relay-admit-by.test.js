// Who may let people into a controlled room: the owner's admitBy setting, pending
// lists for admitters, and approve/deny under each policy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer } from '../src/server.js'
import { generateIdentity, signChallenge } from '../src/identity.js'
import { MSG_AUTH, MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, decoding, bytesMessage, jsonMessage } from '../src/protocol.js'
import { PASS_KEYS, makePass } from './pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-admit-home-'))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}

let rooms = 0
async function relay (t) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  t.after(() => srv.close())
  return srv
}
function connect (srv, r, { identity = generateIdentity(), pass, viewSecret, name = 'x' } = {}) {
  const q = new URLSearchParams({ name, key: identity.publicKey, kind: 'human', features: 'large-files' })
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
      else if (type === MSG_ACCESS) { c.access.push(JSON.parse(decoding.readVarString(dec))); resolve(c) }
      else if (type === MSG_MEMBERS) c.members.push(JSON.parse(decoding.readVarString(dec)))
    })
  })
}
const last = (c) => c.access[c.access.length - 1]
const lastMembers = (c) => c.members[c.members.length - 1]
let adminIds = 0
function admin (c, req) {
  const id = ++adminIds
  c.ws.send(jsonMessage(MSG_ADMIN, { id, ...req }))
  return waitFor(() => c.members.find((m) => m.reply && m.reply.id === id)?.reply)
}

async function ownedRoom (t) {
  const srv = await relay(t)
  const r = `admit-${++rooms}`
  const oid = generateIdentity()
  const owner = await connect(srv, r, { identity: oid, pass: makePass({ identity: oid, sub: 'olive', name: 'Olive' }), viewSecret: 'v', name: 'Olive' })
  assert.equal(last(owner).owner, true)
  assert.equal(last(owner).admitBy, 'owner')
  assert.equal(last(owner).canAdmit, true)
  const as = async (sub, { role = 'editor', access } = {}) => {
    const identity = generateIdentity()
    // Approved member: grant in the pass; pending: null access.
    const pass = makePass({ identity, sub, name: sub, room: r, ...(access === null ? {} : { access: access || { files: role === 'viewer' ? 'view' : 'edit', folders: [], foldersExcept: [], talk: true } }) })
    return connect(srv, r, { identity, pass, name: sub })
  }
  return { srv, r, owner, as }
}

test('default admitBy is owner-only: an editor cannot approve', async (t) => {
  const { owner, as } = await ownedRoom(t)
  const ed = await as('ed')
  assert.equal(last(ed).canAdmit, false)
  assert.equal(last(ed).admitBy, 'owner')
  const pending = await as('sam', { access: null })
  assert.equal(last(pending).state, 'pending')
  await waitFor(() => lastMembers(owner)?.pending?.some((p) => p.name === 'sam'))
  assert.deepEqual(lastMembers(ed)?.pending || [], [], 'editor does not see waiting under owner-only')
  const reply = await admin(ed, { op: 'approve', key: 'person:sam', role: 'editor' })
  assert.equal(reply.ok, false)
  assert.match(reply.error, /cannot let people/)
})

test('owner can open admitting to editors; they see pending and can approve', async (t) => {
  const { owner, as } = await ownedRoom(t)
  assert.equal((await admin(owner, { op: 'admitBy', admitBy: 'editors' })).ok, true)
  await waitFor(() => last(owner).admitBy === 'editors')
  const ed = await as('ed')
  assert.equal(last(ed).canAdmit, true)
  assert.equal(last(ed).admitBy, 'editors')
  const viewer = await as('vic', { role: 'viewer' })
  assert.equal(last(viewer).canAdmit, false)
  const pending = await as('sam', { access: null })
  assert.equal(last(pending).state, 'pending')
  await waitFor(() => lastMembers(ed)?.pending?.some((p) => p.name === 'sam'))
  assert.ok(!(lastMembers(viewer)?.pending || []).some((p) => p.name === 'sam'), 'viewer does not see waiting under editors')
  const reply = await admin(ed, { op: 'approve', key: 'person:sam', role: 'editor' })
  assert.equal(reply.ok, true)
  await waitFor(() => last(pending).state === 'approved')
  const denyTry = await admin(viewer, { op: 'deny', key: 'person:nobody' })
  assert.equal(denyTry.ok, false)
})

test('members may admit when the setting is anyone in the session', async (t) => {
  const { owner, as } = await ownedRoom(t)
  assert.equal((await admin(owner, { op: 'admitBy', admitBy: 'members' })).ok, true)
  const viewer = await as('vic', { role: 'viewer' })
  await waitFor(() => last(viewer).admitBy === 'members' && last(viewer).canAdmit === true)
  const pending = await as('sam', { access: null })
  await waitFor(() => lastMembers(viewer)?.pending?.some((p) => p.name === 'sam'))
  assert.equal((await admin(viewer, { op: 'approve', key: 'person:sam', role: 'viewer' })).ok, true)
  await waitFor(() => last(pending).state === 'approved')
})

test('only the owner may change admitBy; bad values are refused', async (t) => {
  const { owner, as } = await ownedRoom(t)
  const ed = await as('ed')
  assert.equal((await admin(ed, { op: 'admitBy', admitBy: 'editors' })).ok, false)
  assert.match((await admin(ed, { op: 'admitBy', admitBy: 'editors' })).error, /only the session owner/)
  assert.equal((await admin(owner, { op: 'admitBy', admitBy: 'nope' })).ok, false)
  assert.equal(last(owner).admitBy, 'owner')
})

test('closing admitBy to owner clears pending from former admitters', async (t) => {
  const { owner, as } = await ownedRoom(t)
  await admin(owner, { op: 'admitBy', admitBy: 'editors' })
  const ed = await as('ed')
  await as('sam', { access: null })
  await waitFor(() => (lastMembers(ed)?.pending || []).length > 0)
  await admin(owner, { op: 'admitBy', admitBy: 'owner' })
  await waitFor(() => last(ed).canAdmit === false)
  await waitFor(() => Array.isArray(lastMembers(ed)?.pending) && lastMembers(ed).pending.length === 0)
})

test('a chat link lets a chat AI in, so whoever may let people in makes and extends one; only the owner removes it', async (t) => {
  const { owner, as } = await ownedRoom(t)
  const ed = await as('ed')
  const viewer = await as('vic', { role: 'viewer' })
  // Owner only, at first: an editor is refused.
  assert.match((await admin(ed, { op: 'chatlink', name: 'ChatGPT' })).error, /cannot let people into this session/)
  assert.equal((await admin(owner, { op: 'admitBy', admitBy: 'editors' })).ok, true)
  await waitFor(() => last(ed).canAdmit === true)
  const made = await admin(ed, { op: 'chatlink', name: 'ChatGPT', minutes: 10 })
  assert.equal(made.ok, true, made.error)
  assert.match(made.token, /^[A-Za-z0-9_-]{32}$/)
  const key = (await waitFor(() => lastMembers(ed)?.members.find((m) => m.chat)))?.key
  const extended = await admin(ed, { op: 'chatextend', key, minutes: 60 })
  assert.ok(extended.expiresAt > Date.now() + 59 * 60000, 'an hour from now')
  // A viewer may not, and only the owner removes a member.
  assert.match((await admin(viewer, { op: 'chatextend', key, minutes: 60 })).error, /cannot let people into this session/)
  assert.match((await admin(ed, { op: 'remove', key })).error, /only the session owner/)
  assert.equal((await admin(owner, { op: 'remove', key })).ok, true)
})
