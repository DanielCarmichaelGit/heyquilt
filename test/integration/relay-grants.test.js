// The relay with room passes: a pass for one room carries what its holder may do there
// (their grant, from the accounts API). A grant lets them straight in with that access,
// a fresh pass changes it live, and the relay enforces view, folders and exceptions.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'
import { generateIdentity, signChallenge } from '../../src/identity.js'
import { MSG_AUTH, MSG_ACCESS, MSG_MEMBERS, MSG_PASS, MSG_ADMIN, decoding, bytesMessage, jsonMessage } from '../../src/protocol.js'
import { PASS_KEYS, makePass, testPasses } from '../helpers/pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-rg-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-rg-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 6000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const EDIT_ALL = { files: 'edit', folders: [], foldersExcept: [], talk: true }

let srv, server
const sessions = []
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => {
  for (const s of sessions) await s.stop().catch(() => {})
  await srv.close()
})

let rooms = 0
/** A session with an owner (Olive) and a few files; `join` brings someone in with a room pass. */
async function ownedRoom () {
  const room = `rg-${++rooms}`
  const ownerDir = tmp('owner')
  write(ownerDir, 'README.md', 'hello\n')
  write(ownerDir, 'src/app.js', 'app\n')
  write(ownerDir, 'secrets/key.txt', 'k\n')
  const id = generateIdentity()
  const owner = new Session({ dir: ownerDir, server, room, secret: 'edit', viewSecret: 'view', name: 'Olive', identity: id, passes: testPasses(id, { name: 'Olive', sub: 'olive' }) })
  sessions.push(owner)
  await owner.start({ waitTimeoutMs: 5000 })
  await waitFor(() => owner.isOwner)
  const join = async (name, access, { secret = 'view' } = {}) => {
    const dir = tmp(name)
    const me = generateIdentity()
    const s = new Session({ dir, server, room, secret, name, identity: me, passes: testPasses(me, { name, sub: name, room, access }) })
    sessions.push(s)
    await s.start({ waitTimeoutMs: 5000 })
    return { s, dir }
  }
  return { room, owner, ownerDir, join }
}

/** A bare connection (see relay-passes.test.js): resolves once the relay says where it stands. */
function connect (r, { identity = generateIdentity(), pass, secret = 'view' } = {}) {
  const q = new URLSearchParams({ name: 'x', key: identity.publicKey, kind: 'human', features: 'large-files,branches' })
  const ws = new WebSocket(`${server}/${r}?${q}`, { headers: { 'x-quilt-secret': secret, ...(pass ? { 'x-quilt-pass': pass } : {}) } })
  ws.binaryType = 'arraybuffer'
  const c = { ws, identity, access: [], members: [] }
  return new Promise((resolve) => {
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode }))
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

test('a grant in the pass lets you straight in, with its access, and the owner sees you on the list', async () => {
  const { owner, join } = await ownedRoom()
  const { s: sam } = await join('sam', { ...EDIT_ALL, foldersExcept: ['secrets'] })
  await waitFor(() => sam.access && sam.access.state === 'approved')
  assert.deepEqual([sam.access.role, sam.access.scopes, sam.access.scopesExcept, sam.access.talk], ['editor', [], ['secrets'], true])
  assert.equal(owner.waiting.length, 0, 'no prompt for the owner')
  const m = await waitFor(() => owner.members.find((x) => x.key === 'person:sam'))
  assert.deepEqual([m.name, m.role, m.scopesExcept], ['sam', 'editor', ['secrets']])
})

test('the relay enforces exceptions, folders and view-only from the pass', async () => {
  const { ownerDir, join } = await ownedRoom()
  const { s: sam, dir: samDir } = await join('sam', { ...EDIT_ALL, foldersExcept: ['secrets'] })
  await waitFor(() => read(samDir, 'secrets/key.txt') === 'k\n')
  sam.doc.transact(() => sam.files.get('secrets/key.txt').insert(0, 'EVIL '))
  await waitFor(() => sam.files.get('secrets/key.txt').toString() === 'k\n')
  sam.doc.transact(() => sam.files.get('src/app.js').insert(0, 'ok '))
  await waitFor(() => read(ownerDir, 'src/app.js') === 'ok app\n')
  assert.equal(read(ownerDir, 'secrets/key.txt'), 'k\n', 'the owner never saw it')

  const { s: bot, dir: botDir } = await join('bot', { ...EDIT_ALL, folders: ['src'] })
  await waitFor(() => read(botDir, 'README.md') === 'hello\n')
  bot.doc.transact(() => bot.files.get('README.md').insert(0, 'sneaky '))
  await waitFor(() => bot.files.get('README.md').toString() === 'hello\n')

  const { s: vic, dir: vicDir } = await join('vic', { ...EDIT_ALL, files: 'view' }, { secret: 'edit' })
  await waitFor(() => read(vicDir, 'README.md') === 'hello\n')
  assert.equal(vic.access.role, 'viewer', 'the pass, not the edit secret, decides')
  vic.doc.transact(() => vic.files.get('src/app.js').insert(0, 'EVIL '))
  await waitFor(() => vic.files.get('src/app.js').toString() === 'ok app\n')
  await wait(150)
  assert.equal(read(ownerDir, 'README.md'), 'hello\n')
  assert.equal(read(ownerDir, 'src/app.js'), 'ok app\n')
})

test('a pass for another room is refused, on the socket and over HTTP', async () => {
  const { room } = await ownedRoom()
  const identity = generateIdentity()
  const other = makePass({ identity, sub: 'sam', room: 'some-other-room', access: EDIT_ALL })
  assert.equal((await connect(room, { identity, pass: other })).status, 401)
  const res = await fetch(`http://127.0.0.1:${srv.port}/files/${room}`, { method: 'POST', headers: { 'x-quilt-secret': 'edit', 'x-quilt-pass': other }, body: 'hi' })
  assert.equal(res.status, 401)
})

test('without a grant you wait for the owner; a fresh pass with one lets you in', async () => {
  const { room, owner } = await ownedRoom()
  const identity = generateIdentity()
  const c = await connect(room, { identity, pass: makePass({ identity, sub: 'pat', name: 'Pat', room, access: null }) })
  assert.equal(last(c).state, 'pending')
  await waitFor(() => owner.waiting.some((p) => p.key === 'person:pat'))
  c.ws.send(jsonMessage(MSG_PASS, { pass: makePass({ identity, sub: 'pat', name: 'Pat', room, access: { ...EDIT_ALL, talk: false } }) }))
  await waitFor(() => last(c).state === 'approved')
  assert.deepEqual([last(c).role, last(c).talk], ['editor', false])
  await waitFor(() => !owner.waiting.length && owner.members.some((m) => m.key === 'person:pat'))
  c.ws.close()
})

test('a fresh pass changes access live; one for another room is ignored', async () => {
  const { room } = await ownedRoom()
  const identity = generateIdentity()
  const pass = (access, extra = {}) => makePass({ identity, sub: 'kim', name: 'Kim', room, access, ...extra })
  const c = await connect(room, { identity, pass: pass(EDIT_ALL) })
  assert.equal(last(c).role, 'editor')
  c.ws.send(jsonMessage(MSG_PASS, { pass: pass({ ...EDIT_ALL, files: 'view' }) }))
  await waitFor(() => last(c).role === 'viewer')
  c.ws.send(jsonMessage(MSG_PASS, { pass: pass(EDIT_ALL, { room: 'elsewhere' }) }))
  await wait(150)
  assert.equal(last(c).role, 'viewer')
  assert.equal(srv.rooms.get(room).meta.members['person:kim'].role, 'viewer', 'kept for the member list')
  c.ws.close()
})

test("a pass's grant wins over a role the owner gave before access types", async () => {
  const { room } = await ownedRoom()
  const identity = generateIdentity()
  const first = await connect(room, { identity, pass: makePass({ identity, sub: 'lee', name: 'Lee', room, access: null }) })
  assert.equal(last(first).state, 'pending')
  // The owner's older app approves Lee as a viewer (no access types).
  const rm = srv.rooms.get(room)
  const ownerWs = [...rm.access].find(([, a]) => a.owner)[0]
  rm.handle(ownerWs, jsonMessage(MSG_ADMIN, { id: 'a1', op: 'approve', key: 'person:lee', role: 'viewer' }))
  await waitFor(() => last(first).state === 'approved')
  assert.equal(last(first).role, 'viewer')
  first.ws.close()
  // Lee comes back with a room pass whose grant says edit: the pass wins.
  const again = await connect(room, { identity, pass: makePass({ identity, sub: 'lee', name: 'Lee', room, access: EDIT_ALL }) })
  assert.equal(last(again).role, 'editor')
  again.ws.close()
  // And with no grant at all, the role the owner gave still holds.
  const plain = await connect(room, { identity, pass: makePass({ identity, sub: 'lee', name: 'Lee', room, access: null }) })
  assert.equal(last(plain).role, 'editor', 'the last access the relay saw')
  plain.ws.close()
})
