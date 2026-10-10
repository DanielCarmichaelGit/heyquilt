// The app's side of access types: a session asks for passes for its own room, fetches a
// fresh one when the owner changes its access, and keeps to what it may do (no posts when
// it may not post, no changes in folders it may not change).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'
import { generateIdentity } from '../../src/identity.js'
import { PassSource, personPasses } from '../../src/pass-source.js'
import { newPassKeys, verifyPass, PASS_TTL_MS } from '../../src/passes.js'
import { PASS_KEYS, makePass, testPasses } from '../helpers/pass-helpers.js'
import { startTestApi, linkDevice } from '../helpers/api-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-srp-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-srp-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 6000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}

test('forRoom gives one source per room, fetching with that room', async () => {
  const asked = []
  const base = new PassSource({ fetchPass: async (room) => { asked.push(room); return { pass: `p-${room || 'none'}`, expiresAt: Date.now() + PASS_TTL_MS } } })
  const a = base.forRoom('room-a')
  assert.equal(base.forRoom('room-a'), a)
  assert.equal(base.forRoom(''), base)
  assert.equal(a.forRoom('room-a'), a)
  assert.equal(await a.get(), 'p-room-a')
  assert.equal(await base.get(), 'p-none')
  assert.deepEqual(asked, ['room-a', ''])
})

test("a computer's room passes come from the API with the room in the body", async () => {
  const keys = newPassKeys()
  const t = await startTestApi({ passKey: keys.privateKey })
  try {
    await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room: 'srp-api', account: 'person:mem', name: 'Mo', owner: true, at: Date.now() }], Date.now())
    const { token } = await linkDevice(t, 'mem')
    const p = verifyPass(await personPasses({ token, api: t.api.url }).forRoom('srp-api').get(), keys.publicKey)
    assert.deepEqual([p.room, p.access.owner], ['srp-api', true])
  } finally { await t.close() }
})

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

/** A session with an owner, and someone whose passes (for the room it asks for) carry `access`. */
async function withMember (room, access) {
  const ownerDir = tmp('owner')
  fs.writeFileSync(path.join(ownerDir, 'README.md'), 'hello\n')
  fs.mkdirSync(path.join(ownerDir, 'secrets'))
  fs.writeFileSync(path.join(ownerDir, 'secrets/key.txt'), 'k\n')
  const oid = generateIdentity()
  const owner = new Session({ dir: ownerDir, server, room, secret: 'e', viewSecret: 'v', name: 'Olive', identity: oid, passes: testPasses(oid, { name: 'Olive', sub: 'olive' }) })
  sessions.push(owner)
  await owner.start({ waitTimeoutMs: 5000 })
  await waitFor(() => owner.isOwner)
  const mid = generateIdentity()
  const asked = []
  const passes = new PassSource({
    fetchPass: async (forRoom) => {
      asked.push(forRoom)
      const exp = Date.now() + PASS_TTL_MS
      return { pass: makePass({ identity: mid, name: 'Sam', sub: 'sam', room: forRoom, access: passes.access, exp }), expiresAt: exp }
    }
  })
  passes.access = access
  const dir = tmp('sam')
  const sam = new Session({ dir, server, room, secret: 'e', name: 'Sam', identity: mid, passes })
  sessions.push(sam)
  await sam.start({ waitTimeoutMs: 5000 })
  await waitFor(() => sam.access?.state === 'approved' && read(dir, 'README.md') === 'hello\n')
  return { owner, ownerDir, sam, dir, asked, passes }
}

test('a session asks for passes for its own room', async () => {
  const { asked } = await withMember('srp-1', { files: 'edit', folders: [], foldersExcept: [], talk: true })
  assert.deepEqual([...new Set(asked)], ['srp-1'])
})

test('without posting rights, the app refuses to post, and shares no AI chat', async () => {
  const { owner, sam } = await withMember('srp-2', { files: 'edit', folders: [], foldersExcept: [], talk: false })
  assert.equal(sam.mayTalk(), false)
  assert.throws(() => sam.say('hi'), { message: "You can't post in this session." })
  await assert.rejects(sam.sendFile('README.md'), { message: "You can't post in this session." })
  assert.equal(sam.pushAgentEntries([{ id: 'e1', kind: 'prompt', text: 'plan', ts: Date.now() }]), 0)
  sam.setAgentSharing(false)
  await wait(150)
  assert.deepEqual([sam.chat.length, sam.agentFeed.length, owner.agentFeed.length], [0, 0, 0])
})

test('a change in a folder it may not change is put back on its own disk', async () => {
  const { ownerDir, sam, dir } = await withMember('srp-3', { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: true })
  assert.equal(sam.writeRefusal('secrets/key.txt'), 'you may not change files in secrets')
  assert.equal(sam.writeRefusal('README.md'), null)
  await waitFor(() => read(dir, 'secrets/key.txt') === 'k\n')
  fs.writeFileSync(path.join(dir, 'secrets/key.txt'), 'leaked\n')
  await waitFor(() => read(dir, 'secrets/key.txt') === 'k\n')
  assert.equal(read(ownerDir, 'secrets/key.txt'), 'k\n')
})

test('when the owner changes its access, the app fetches a fresh pass at once', async () => {
  const { owner, sam, asked, passes } = await withMember('srp-4', { files: 'edit', folders: [], foldersExcept: [], talk: true })
  const before = asked.length
  // The owner's app wrote a narrower grant to the API, then tells the relay.
  passes.access = { files: 'view', folders: [], foldersExcept: [], talk: true }
  await owner.conn.adminRequest({ op: 'set', key: 'person:sam', access: passes.access })
  await waitFor(() => asked.length > before)
  await waitFor(() => sam.access.role === 'viewer')
})
