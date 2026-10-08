// The relay as it runs when hosted publicly: health, relay key, quotas,
// per-IP limits, unloading idle rooms, and expiring abandoned ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { encodeInvite, decodeInvite } from '../src/runner.js'
import { relayUrl } from '../src/settings.js'
import { Session } from '../src/session.js'
import { Connection } from '../src/connection.js'
import { generateIdentity } from '../src/identity.js'
import { PASS_KEYS, testPasses } from './pass-helpers.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-relay-${n}-`))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms = 5000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const quiet = () => {}
/** Cleanups that run last-in first-out when the test ends, even if it failed. */
function cleanups (t) {
  const fns = []
  t.after(async () => { for (const fn of fns.reverse()) await fn() })
  return (fn) => fns.push(fn)
}
// Sessions without an identity create one in ~/.quilt; keep that out of the real home.
process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = tmp('home')

test('health endpoint, and nothing else for visitors', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, relayKey: 'k' })
  defer(() => srv.close())
  const h = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json()
  assert.equal(h.ok, true)
  assert.equal(h.requiresKey, true)
  assert.deepEqual(Object.keys(h).sort(), ['ok', 'requiresKey', 'version'])
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/status`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/nope`)).status, 404)
})

test("the relay's old join page sends people to join.heyquilt.com", async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  defer(() => srv.close())
  const res = await fetch(`http://127.0.0.1:${srv.port}/join/room-abc`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://join.heyquilt.com/room-abc')
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/join/bad%20room`, { redirect: 'manual' })).status, 404)
  assert.equal(srv.rooms.has('room-abc'), false, 'following the link does not create a room')
})

test('invites are join.heyquilt.com links on the hosted relay, and older forms still work', () => {
  const hosted = { server: 'wss://relay.heyquilt.com', room: 'room-1a2b', secret: 'abc_D-9' }
  assert.equal(encodeInvite(hosted), 'https://join.heyquilt.com/room-1a2b#abc_D-9')
  assert.equal(encodeInvite({ ...hosted, server: 'wss://cowove-relay.fly.dev' }), 'https://join.heyquilt.com/room-1a2b#abc_D-9', 'the old address is the same relay')
  const joined = { ...hosted, server: relayUrl() }
  assert.deepEqual(decodeInvite('https://join.heyquilt.com/room-1a2b#abc_D-9'), joined)
  assert.deepEqual(decodeInvite('  quilt join https://join.heyquilt.com/room-1a2b/#abc_D-9\n'), joined)
  assert.deepEqual(decodeInvite('quilt:https://join.heyquilt.com/room-1a2b#abc_D-9'), joined)
  assert.throws(() => decodeInvite('https://join.heyquilt.com/room-1a2b'), /This link is missing part of it\. Ask for a new invite\./)

  // The relay form keeps its relay, but only Quilt's own (under either address) or the one in use.
  assert.deepEqual(decodeInvite('https://relay.heyquilt.com/join/room-1a2b#abc_D-9'), { server: 'wss://relay.heyquilt.com', room: 'room-1a2b', secret: 'abc_D-9' })
  assert.deepEqual(decodeInvite('https://cowove-relay.fly.dev/join/room-1a2b#abc_D-9'), { server: 'wss://cowove-relay.fly.dev', room: 'room-1a2b', secret: 'abc_D-9' })
  const hostedOld = Buffer.from(JSON.stringify({ s: 'wss://relay.heyquilt.com', r: 'room-1a2b', k: 'abc_D-9' })).toString('base64url')
  assert.deepEqual(decodeInvite(hostedOld), hosted)
  process.env.QUILT_SERVER = 'ws://192.168.1.4:4321'
  try {
    const dev = { server: 'ws://192.168.1.4:4321', room: 'r', secret: 's' }
    assert.equal(encodeInvite(dev), 'http://192.168.1.4:4321/join/r#s')
    assert.deepEqual(decodeInvite(encodeInvite(dev)), dev)
    assert.deepEqual(decodeInvite(`  quilt join ${encodeInvite(dev)}\n`), dev)
  } finally {
    delete process.env.QUILT_SERVER
  }
  assert.throws(() => decodeInvite('nonsense'), /invite link is not valid/)
  assert.throws(() => decodeInvite('https://join.heyquilt.com/'), /invite link is not valid/)
})

test('an invite can never name another relay, or a room that is a path', () => {
  const invalid = /That invite link is not valid\. Copy the whole link they sent\./
  // Any relay this computer doesn't already use is refused, in every form.
  assert.equal(encodeInvite({ server: 'wss://relay.example.com', room: 'room-1a2b', secret: 'abc_D-9' }), 'https://relay.example.com/join/room-1a2b#abc_D-9')
  assert.throws(() => decodeInvite('https://relay.example.com/join/room-1a2b#abc_D-9'), invalid)
  assert.throws(() => decodeInvite('http://192.168.1.4:4321/join/r#s'), invalid)
  assert.throws(() => decodeInvite('https://quiet-fox.trycloudflare.com/join/room-1a2b#s'), invalid)
  const evil = Buffer.from(JSON.stringify({ s: 'wss://evil.example', r: 'room-1a2b', k: 's' })).toString('base64url')
  assert.throws(() => decodeInvite(evil), invalid)
  // The reported attack: a path in the room, which would become the folder to sync.
  assert.throws(() => decodeInvite('https://evil.example/join/..%2F..%2F..#x'), invalid)
  assert.throws(() => decodeInvite('https://relay.heyquilt.com/join/..%2F..%2F..#x'), invalid)
  assert.throws(() => decodeInvite('https://relay.heyquilt.com/join/..#x'), invalid)
  for (const r of ['../../..', '..', '/etc', 'a/b', 'a\\b', '', 'x'.repeat(65)]) {
    const code = Buffer.from(JSON.stringify({ s: 'wss://relay.heyquilt.com', r, k: 's' })).toString('base64url')
    assert.throws(() => decodeInvite(code), invalid, JSON.stringify(r))
  }
  assert.throws(() => decodeInvite('https://join.heyquilt.com/..%2F..#x'), invalid)
})

test('a relay key is needed to create rooms, not to join them', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, relayKey: 'team-key' })
  defer(() => srv.close())
  const server = `ws://127.0.0.1:${srv.port}`
  const stranger = new Session({ dir: tmp('s'), server, room: 'r1', secret: 'x', name: 'stranger' })
  await assert.rejects(stranger.start({ waitTimeoutMs: 3000 }), /relay key/)
  await stranger.stop()
  assert.equal(srv.rooms.has('r1'), false, 'refused rooms are not kept')

  const host = new Session({ dir: tmp('h'), server, room: 'r1', secret: 'x', key: 'team-key', name: 'host' })
  defer(() => host.stop())
  await host.start({ waitTimeoutMs: 3000 })
  const guest = new Session({ dir: tmp('g'), server, room: 'r1', secret: 'x', name: 'guest' })
  defer(() => guest.stop())
  await guest.start({ waitTimeoutMs: 3000 })
  const up = await fetch(`http://127.0.0.1:${srv.port}/files/other-room`, { method: 'POST', headers: { 'x-quilt-secret': 'x' }, body: 'hi' })
  assert.equal(up.status, 403)
})

test('too many connections from one address are refused', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxConnsPerIp: 2 })
  defer(() => srv.close())
  const open = () => new Promise((resolve) => {
    const id = generateIdentity()
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/cap?secret=s&name=n${Math.random()}&key=${id.publicKey}&features=large-files,branches`)
    ws.on('open', () => resolve({ ws, status: 101 }))
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode }))
  })
  const a = await open(); const b = await open(); const c = await open()
  defer(() => { a.ws?.close(); b.ws?.close() })
  assert.deepEqual([a.status, b.status, c.status], [101, 101, 429])
})

test('a room over its size quota refuses new edits', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomBytes: 4000 })
  defer(() => srv.close())
  const dir = tmp('big')
  const s = new Session({ dir, server: `ws://127.0.0.1:${srv.port}`, room: 'big', secret: 's', name: 'a' })
  let fatal = null
  s.on('fatal', (err) => { fatal = err })
  defer(() => s.stop())
  await s.start({ waitTimeoutMs: 3000 })
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(6000))
  await waitFor(() => srv.rooms.get('big')?.full)
  fs.writeFileSync(path.join(dir, 'b.txt'), 'more')
  await waitFor(() => fatal)
  assert.match(fatal.message, /size limit/)
})

test('a connection refused for the room being over its size limit settles quickly, instead of hanging', { timeout: 15000 }, async (t) => {
  // Joining an already-full room still runs the ordinary two-step Yjs handshake for the room
  // document; the step the new connection sends back (not itself new data) gets refused with
  // CLOSE_ROOM_FULL the same as a real edit would, but the underlying socket used to rely on
  // the 'ws' library's default ~30s close-handshake timeout to finish closing, because this is
  // a close the relay forces, not one a well-behaved peer necessarily acks right away. That
  // left the relay's socket for the connection half-closed (readable: false, writable: true)
  // for up to 30s. The relay now bounds this with closeSoon() in src/server.js.
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomBytes: 4000 })
  const seed = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'full2', secret: 's', name: 'seed', identity: generateIdentity(), doc: new Y.Doc() })
  await seed.waitForSync()
  srv.rooms.get('full2').full = true
  const start = Date.now()
  const a = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'full2', secret: 's', name: 'a', identity: generateIdentity(), doc: new Y.Doc() })
  let fatal = null
  a.on('fatal', (err) => { fatal = err })
  await waitFor(() => fatal, 10000) // well under the old ~30s default close timeout
  assert.match(fatal.message, /size limit/)
  assert.ok(Date.now() - start < 10000, 'settled well before the old 30s close-handshake timeout')
  assert.equal(a.closed, true, 'the connection settled instead of hanging or endlessly reconnecting')
  // Close everything (and give it a moment to finish) before the relay itself closes.
  a.close()
  seed.close()
  await wait(500)
  await srv.close()
})

test('a stored room too big to load is refused instead of loaded', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('toobig')
  const big = new Y.Doc()
  big.getMap('files').set('a.txt', new Y.Text('x'.repeat(10000))) // over twice the limit
  fs.writeFileSync(path.join(dataDir, 'huge.ydoc'), Y.encodeStateAsUpdate(big))
  const logs = []
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: (m) => logs.push(m), dataDir, maxRoomBytes: 4000 })
  defer(() => srv.close())
  const s = new Session({ dir: tmp('toobig-client'), server: `ws://127.0.0.1:${srv.port}`, room: 'huge', secret: 's', name: 'a' })
  let fatal = null
  s.on('fatal', (err) => { fatal = err })
  defer(() => s.stop())
  s.start({ waitTimeoutMs: 3000 }).catch(() => {})
  await waitFor(() => fatal)
  assert.match(fatal.message, /size limit/)
  assert.equal(srv.rooms.get('huge'), undefined, 'the room is not kept in memory')
  assert.ok(logs.some((m) => /too big to load/.test(m)))
})

test('file storage quota per room', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomFileBytes: 1000 })
  defer(() => srv.close())
  const post = (body) => fetch(`http://127.0.0.1:${srv.port}/files/fq`, { method: 'POST', headers: { 'x-quilt-secret': 's' }, body })
  assert.equal((await post('x'.repeat(600))).status, 201)
  const r = await post('x'.repeat(600))
  assert.equal(r.status, 413)
  assert.match(await r.text(), /quota/)
  // Stored large files count against the same quota.
  const upload = await fetch(`http://127.0.0.1:${srv.port}/blobs/fq/${'a'.repeat(32)}/upload`, { method: 'POST', headers: { 'x-quilt-secret': 's' }, body: JSON.stringify({ size: 300 }) })
  assert.equal(upload.status, 200)
  assert.equal((await post('x'.repeat(200))).status, 413, 'chat files see the stored file')
  assert.equal((await post('x'.repeat(50))).status, 201)
})

test('idle rooms leave memory and come back intact', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('data')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir, idleUnloadMs: 50 })
  defer(() => srv.close())
  const doc = new Y.Doc()
  const identity = generateIdentity()
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'idle', secret: 's', name: 'idler', identity, doc })
  defer(() => { if (!c.closed) c.close() })
  await c.waitForSync()
  doc.getText('t').insert(0, 'kept')
  await waitFor(() => srv.rooms.get('idle')?.doc.getText('t').toString() === 'kept')
  c.close()
  await waitFor(() => !srv.rooms.has('idle'), 3000)
  const doc2 = new Y.Doc()
  const c2 = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'idle', secret: 's', name: 'idler', identity, doc: doc2 })
  defer(() => { if (!c2.closed) c2.close() })
  await c2.waitForSync()
  assert.equal(doc2.getText('t').toString(), 'kept')
})

test('rooms unused for longer than the TTL are deleted', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('ttl')
  fs.writeFileSync(path.join(dataDir, 'old.json'), JSON.stringify({ secretHash: 'ab', lastActive: Date.now() - 40 * 86400e3 }))
  fs.writeFileSync(path.join(dataDir, 'old.ydoc'), Buffer.from([0, 0]))
  fs.mkdirSync(path.join(dataDir, 'files', 'old'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'fresh.json'), JSON.stringify({ secretHash: 'ab', lastActive: Date.now() }))
  fs.writeFileSync(path.join(dataDir, 'agent-links.json'), JSON.stringify({ abc: { room: 'old', name: 'a', tabSeenAt: Date.now() - 40 * 86400e3 } }))
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir, roomTtlDays: 30 })
  defer(() => srv.close())
  assert.equal(fs.existsSync(path.join(dataDir, 'old.json')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'old.ydoc')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'files', 'old')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'fresh.json')), true)
  assert.equal(fs.existsSync(path.join(dataDir, 'agent-links.json')), true, 'the relay\'s own link file is not mistaken for a room')
})

test('new sessions are rate-limited per address; joining existing ones is not', async () => {
  const { default: WebSocket } = await import('ws')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxNewRoomsPerHour: 2 })
  const id = generateIdentity()
  const open = (room) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/${room}?secret=s&name=a&key=${id.publicKey}&features=large-files,branches`)
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode))
  })
  assert.equal(await open('r1'), 'open')
  assert.equal(await open('r2'), 'open')
  assert.equal(await open('r3'), 429)
  assert.equal(await open('r1'), 'open', 'rejoining an existing room still works')
  await srv.close()
})

test('the owner can end a session: everyone is sent away, its data is deleted, and a tombstone is left', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('end')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  defer(() => srv.close())
  const server = `ws://127.0.0.1:${srv.port}`
  const ownerDoc = new Y.Doc()
  const owner = new Connection({ server, room: 'ending', secret: 's', viewSecret: 'v', name: 'olive', identity: generateIdentity(), doc: ownerDoc })
  defer(() => owner.close())
  await owner.waitForSync()
  await waitFor(() => owner.access && owner.access.owner)
  ownerDoc.getText('t').insert(0, 'bye')
  await waitFor(() => fs.existsSync(path.join(dataDir, 'ending.ydoc')))
  fs.mkdirSync(path.join(dataDir, 'blobs', 'ending'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'blobs', 'ending', 'a'.repeat(32)), 'x')

  const ended = new Promise((resolve) => owner.on('fatal', resolve))
  await owner.adminRequest({ op: 'end' })
  const err = await ended
  assert.equal(err.ended, true)
  await waitFor(() => !srv.rooms.has('ending'))
  assert.equal(fs.existsSync(path.join(dataDir, 'ending.ydoc')), false)
  await waitFor(() => !fs.existsSync(path.join(dataDir, 'blobs', 'ending')))
  const tombstone = JSON.parse(fs.readFileSync(path.join(dataDir, 'ending.json'), 'utf8'))
  assert.equal(tombstone.ended, true)
  const base = `http://127.0.0.1:${srv.port}`
  const id = 'a'.repeat(32)
  const headers = { 'x-quilt-secret': 's' }
  assert.equal((await fetch(`${base}/blobs/ending/${id}/upload`, { method: 'POST', headers, body: '{"size":1}' })).status, 410)
  assert.equal((await fetch(`${base}/blobs/ending/${id}/download`, { method: 'POST', headers, body: '{}' })).status, 410)
  assert.equal((await fetch(`${base}/blobs/ending/${id}/data?m=GET&exp=1&sig=00`)).status, 410)
  assert.equal((await fetch(`${base}/files/ending`, { method: 'POST', headers, body: 'x' })).status, 410)
  assert.equal((await fetch(`${base}/files/ending/${id}`, { headers })).status, 410)

  // Reconnecting to the same room, even with the right secret, is refused for good.
  const laterDoc = new Y.Doc()
  const later = new Connection({ server, room: 'ending', secret: 's', name: 'olive', identity: generateIdentity(), doc: laterDoc })
  defer(() => later.close())
  const laterErr = await new Promise((resolve) => later.on('fatal', resolve))
  assert.equal(laterErr.ended, true)
})

test('ending a session sends everyone away, not just the owner, even if they were only part-way admitted', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  defer(() => srv.close())
  const server = `ws://127.0.0.1:${srv.port}`
  const ownerDoc = new Y.Doc()
  const owner = new Connection({ server, room: 'end-everyone', secret: 's', viewSecret: 'v', name: 'olive', identity: generateIdentity(), doc: ownerDoc })
  defer(() => owner.close())
  await owner.waitForSync()
  await waitFor(() => owner.access && owner.access.owner)

  const guestIdentity = generateIdentity()
  const guestDoc = new Y.Doc()
  const guest = new Connection({ server, room: 'end-everyone', secret: 's', name: 'gus', identity: guestIdentity, doc: guestDoc })
  defer(() => guest.close())
  await waitFor(() => guest.access && guest.access.state === 'pending')
  await owner.adminRequest({ op: 'approve', key: guestIdentity.publicKey })
  await waitFor(() => guest.access && guest.access.state === 'approved')

  const ownerEnded = new Promise((resolve) => owner.on('fatal', resolve))
  const guestEnded = new Promise((resolve) => guest.on('fatal', resolve))
  await owner.adminRequest({ op: 'end' })
  const [ownerErr, guestErr] = await Promise.all([ownerEnded, guestEnded])
  assert.equal(ownerErr.ended, true)
  assert.equal(guestErr.ended, true)
})

test('only the owner can end a session', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir: tmp('end2') })
  defer(() => srv.close())
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'open-room', secret: 's', name: 'eve', identity: generateIdentity(), doc: new Y.Doc() })
  defer(() => c.close())
  await c.waitForSync()
  await assert.rejects(c.adminRequest({ op: 'end' }), /only the session owner/)
})

test('stored files go with their room when it expires, and unreferenced ones when it unloads', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('gc')
  fs.writeFileSync(path.join(dataDir, 'old.json'), JSON.stringify({ secretHash: 'ab', lastActive: Date.now() - 40 * 86400e3 }))
  fs.mkdirSync(path.join(dataDir, 'blobs', 'old'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'blobs', 'old', 'a'.repeat(32)), 'x')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir, roomTtlDays: 30, idleUnloadMs: 50 })
  defer(() => srv.close())
  await waitFor(() => !fs.existsSync(path.join(dataDir, 'blobs', 'old')))

  // A room that stored two files but only references one of them now.
  const doc = new Y.Doc()
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'gc', secret: 's', name: 'gil', identity: generateIdentity(), doc })
  defer(() => { if (!c.closed) c.close() })
  await c.waitForSync()
  const keep = 'a'.repeat(32)
  const drop = 'b'.repeat(32)
  const room = srv.rooms.get('gc')
  const old = Date.now() - 25 * 60 * 60 * 1000
  const recent = 'c'.repeat(32)
  room.meta.blobs = { [keep]: { size: 1, ts: old }, [drop]: { size: 1, ts: old }, [recent]: { size: 1, ts: Date.now() - 2 * 60 * 60 * 1000 } }
  for (const id of [keep, drop]) { fs.mkdirSync(path.join(dataDir, 'blobs', 'gc'), { recursive: true }); fs.writeFileSync(path.join(dataDir, 'blobs', 'gc', id), 'x') }
  doc.getMap('blobs').set('img.png', { hash: 'h', size: 1, stored: { id: keep, key: 'k1' } })
  await waitFor(() => room.doc.getMap('blobs').has('img.png'))
  c.close()
  await waitFor(() => !srv.rooms.has('gc'), 3000)
  await waitFor(() => !fs.existsSync(path.join(dataDir, 'blobs', 'gc', drop)))
  assert.equal(fs.existsSync(path.join(dataDir, 'blobs', 'gc', keep)), true)
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'gc.json'), 'utf8'))
  assert.deepEqual(Object.keys(meta.blobs).sort(), [keep, recent], 'unreferenced uploads get a day\'s grace')
})

test('the sweep removes the tombstone of a session ended long ago', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('tomb')
  const long = Date.now() - 40 * 86400e3
  fs.writeFileSync(path.join(dataDir, 'gone.json'), JSON.stringify({ ended: true, endedAt: long, lastActive: long }))
  fs.writeFileSync(path.join(dataDir, 'recent.json'), JSON.stringify({ ended: true, endedAt: Date.now(), lastActive: Date.now() }))
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir, roomTtlDays: 30 })
  defer(() => srv.close())
  assert.equal(fs.existsSync(path.join(dataDir, 'gone.json')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'recent.json')), true, 'a recently ended session stays refused')
})

test('a malformed path in an upgrade request is refused, not fatal', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, relayKey: 'k' })
  defer(() => srv.close())
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(srv.port, '127.0.0.1', () => {
      sock.write('GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
    })
    let buf = ''
    sock.on('data', (d) => { buf += d })
    sock.on('close', () => resolve(buf))
    sock.on('error', reject)
    setTimeout(() => { sock.destroy(); resolve(buf) }, 2000)
  })
  assert.match(reply, /^HTTP\/1\.1 400/)
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200, 'the relay is still up')
})

test('a client that sends more than the relay accepts is dropped, not fatal', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomBytes: 4000 })
  defer(() => srv.close())
  const id = generateIdentity()
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/big?secret=s&name=n&key=${id.publicKey}&features=large-files,branches`)
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  ws.on('error', () => {})
  ws.send(Buffer.alloc(2 * 1024 * 1024)) // maxPayload is at least 1 MB, here exactly 1 MB
  assert.equal(await closed, 1009, 'closed for being too big')
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200, 'the relay is still up')
})

// Issue 011: secrets must not travel in the URL, where proxies log them.
test('secrets go in the upgrade request headers, never in its URL, and the relay takes either form', async (t) => {
  const defer = cleanups(t)
  // A stand-in for a proxy in front of the relay: it records the upgrade request and refuses it.
  let seen = null
  const proxy = http.createServer((req, res) => { res.writeHead(404); res.end() })
  proxy.on('upgrade', (req, socket) => {
    seen = { url: req.url, headers: req.headers }
    socket.write('HTTP/1.1 400 Nope\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  defer(() => new Promise((resolve) => proxy.close(resolve)))
  const identity = generateIdentity()
  const c = new Connection({ server: `ws://127.0.0.1:${proxy.address().port}`, room: 'r', secret: 'EDIT-SECRET', viewSecret: 'VIEW-SECRET', key: 'RELAY-KEY', name: 'olive', identity, doc: new Y.Doc(), passes: testPasses(identity) })
  defer(() => c.close())
  await new Promise((resolve) => c.on('fatal', resolve))
  assert.ok(seen, 'the request reached the proxy')
  assert.doesNotMatch(seen.url, /EDIT-SECRET|VIEW-SECRET|RELAY-KEY|pass=|secret=|relayKey=/i, `the URL carries no secrets: ${seen.url}`)
  assert.match(seen.url, /name=olive/, 'the name may stay in the URL')
  assert.match(seen.url, new RegExp(`key=${identity.publicKey}`), 'so may the public key')
  assert.equal(seen.headers['x-quilt-secret'], 'EDIT-SECRET')
  assert.equal(seen.headers['x-quilt-view-secret'], 'VIEW-SECRET')
  assert.equal(seen.headers['x-quilt-key'], 'RELAY-KEY')
  assert.ok(seen.headers['x-quilt-pass'], 'the pass is a header too')

  // The relay reads the headers: a relay key, a pass, and the room's secrets all arrive that way.
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, relayKey: 'RELAY-KEY', passPublicKey: PASS_KEYS.publicKey })
  defer(() => srv.close())
  const server = `ws://127.0.0.1:${srv.port}`
  const owner = new Connection({ server, room: 'hdr', secret: 'EDIT-SECRET', viewSecret: 'VIEW-SECRET', key: 'RELAY-KEY', name: 'olive', identity, doc: new Y.Doc(), passes: testPasses(identity) })
  defer(() => owner.close())
  await owner.waitForSync()
  await waitFor(() => owner.access && owner.access.owner)
  const viewerId = generateIdentity()
  const viewer = new Connection({ server, room: 'hdr', secret: 'VIEW-SECRET', name: 'vic', identity: viewerId, doc: new Y.Doc(), passes: testPasses(viewerId, { name: 'Vic', sub: 'user-vic' }) })
  defer(() => viewer.close())
  await waitFor(() => viewer.access && viewer.access.state === 'pending')
  assert.equal(viewer.access.invitedAs, 'viewer', 'the view secret in the header was matched')

  // Older clients still send everything in the query string; that keeps working for one release.
  const oldId = generateIdentity()
  const pass = await testPasses(oldId, { name: 'Old', sub: 'user-old' }).get()
  const q = new URLSearchParams({ secret: 's', name: 'old', key: oldId.publicKey, relayKey: 'RELAY-KEY', features: 'large-files,branches', pass })
  const ws = new WebSocket(`${server}/old-style?${q}`)
  ws.on('error', () => {})
  const status = await new Promise((resolve) => {
    ws.on('open', () => resolve(101))
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode))
  })
  defer(() => ws.terminate())
  assert.equal(status, 101)
})

// Issue 013: a refusal that isn't final must end the handshake so the backoff reconnect runs.
test('a connection refused with 429 keeps trying and gets in once a slot frees up', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxConnsPerIp: 1 })
  defer(() => srv.close())
  const holder = new WebSocket(`ws://127.0.0.1:${srv.port}/x?secret=s&name=h&key=${generateIdentity().publicKey}&features=large-files,branches`)
  await new Promise((resolve, reject) => { holder.on('open', resolve); holder.on('error', reject) })
  const warnings = []
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'x', secret: 's', name: 'dana', identity: generateIdentity(), doc: new Y.Doc() })
  defer(() => c.close())
  c.on('warn', (w) => warnings.push(w))
  await waitFor(() => warnings.some((w) => /too many connections/.test(w)))
  holder.close()
  await waitFor(() => c.connected, 5000)
  assert.equal(c.ws.readyState, WebSocket.OPEN)
})

test('a 503 from a proxy while the relay restarts is retried until the relay is back', async (t) => {
  const defer = cleanups(t)
  // The proxy answers 503 once (the relay is restarting), then the relay itself takes the port.
  let refusals = 0
  const proxy = http.createServer((req, res) => { res.writeHead(503); res.end() })
  proxy.on('upgrade', (req, socket) => {
    refusals++
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const port = proxy.address().port
  const c = new Connection({ server: `ws://127.0.0.1:${port}`, room: 'r', secret: 's', name: 'dana', identity: generateIdentity(), doc: new Y.Doc() })
  defer(() => c.close())
  await waitFor(() => refusals > 0)
  await new Promise((resolve) => proxy.close(resolve))
  const srv = await startServer({ port, host: '127.0.0.1', log: quiet })
  defer(() => srv.close())
  await waitFor(() => c.connected, 5000)
  assert.equal(refusals, 1)
})

// Issue 014: whoever created the room is its owner, not whoever signs in first.
test('only the creator of a session becomes its owner, even if an invitee signs in first', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  defer(() => srv.close())
  const server = `ws://127.0.0.1:${srv.port}`
  const creator = generateIdentity()
  // The app's first connection: the upgrade creates the room, then the link drops before the challenge is answered.
  const first = new WebSocket(`${server}/room?secret=EDIT&viewSecret=VIEW&name=olive&key=${creator.publicKey}&features=large-files,branches`)
  await new Promise((resolve, reject) => { first.on('open', resolve); first.on('error', reject) })
  first.close()
  await new Promise((resolve) => first.on('close', resolve))
  assert.equal(srv.rooms.get('room').controlled, true)

  // Someone with the view-only link, and someone with the edit link, both get there before the creator reconnects.
  const mallory = new Connection({ server, room: 'room', secret: 'VIEW', name: 'mallory', identity: generateIdentity(), doc: new Y.Doc() })
  defer(() => mallory.close())
  await waitFor(() => mallory.access)
  assert.equal(mallory.access.state, 'pending', `a view-only invitee waits for the owner: ${JSON.stringify(mallory.access)}`)
  const eddieId = generateIdentity()
  const eddie = new Connection({ server, room: 'room', secret: 'EDIT', name: 'eddie', identity: eddieId, doc: new Y.Doc() })
  defer(() => eddie.close())
  await waitFor(() => eddie.access)
  assert.equal(eddie.access.state, 'pending', `an editor invitee waits too: ${JSON.stringify(eddie.access)}`)

  const olive = new Connection({ server, room: 'room', secret: 'EDIT', name: 'olive', identity: creator, doc: new Y.Doc() })
  defer(() => olive.close())
  await waitFor(() => olive.access)
  assert.equal(olive.access.owner, true, `the creator is the owner: ${JSON.stringify(olive.access)}`)
  await olive.adminRequest({ op: 'approve', key: eddieId.publicKey })
  await waitFor(() => eddie.access.state === 'approved')
  assert.equal(eddie.access.role, 'editor')
  assert.equal(mallory.access.state, 'pending')
})

// Issue 015: disk trouble must not stop the relay or lose sessions.
test('a data folder that stops taking writes makes sessions read-only instead of stopping the relay', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('ro')
  const logs = []
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: (m) => logs.push(m), dataDir })
  defer(() => srv.close())
  fs.chmodSync(dataDir, 0o500)
  defer(() => fs.chmodSync(dataDir, 0o700))
  const doc = new Y.Doc()
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'ro', secret: 's', name: 'ron', identity: generateIdentity(), doc })
  defer(() => c.close())
  await c.waitForSync()
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200, 'the relay is still up')
  const room = srv.rooms.get('ro')
  assert.equal(room.full, true, 'the session is read-only')
  assert.ok(logs.some((m) => /\[ro\].*could not save/.test(m)), `the failure is logged: ${logs.join(' | ')}`)
  doc.getText('t').insert(0, 'x')
  await wait(1500) // the save timer
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200, 'a failed save does not stop it either')
})

test('a session whose metadata is unreadable is refused and left on disk, not deleted', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('trunc')
  fs.writeFileSync(path.join(dataDir, 'r3.json'), '{"secretHash":"ab","created') // cut off mid-write
  fs.writeFileSync(path.join(dataDir, 'r3.ydoc'), Buffer.from([0, 0]))
  fs.mkdirSync(path.join(dataDir, 'files', 'r3'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'files', 'r3', 'a'.repeat(32)), 'chat file')
  const logs = []
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: (m) => logs.push(m), dataDir, roomTtlDays: 30 })
  defer(() => srv.close())
  srv.sweep()
  const intact = () => ['r3.json', 'r3.ydoc', path.join('files', 'r3')].every((f) => fs.existsSync(path.join(dataDir, f)))
  assert.equal(intact(), true, 'the sweep leaves what it cannot read')
  assert.ok(logs.some((m) => /\[r3\].*could not read/.test(m)), `and says so: ${logs.join(' | ')}`)

  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/r3?secret=s&name=n&key=${generateIdentity().publicKey}&features=large-files,branches`)
  ws.on('error', () => {})
  const status = await new Promise((resolve) => {
    ws.on('open', () => resolve(101))
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode))
  })
  defer(() => ws.terminate())
  assert.notEqual(status, 101, 'the session is refused')
  assert.equal(srv.rooms.has('r3'), false, 'and not kept in memory')
  assert.equal(intact(), true, 'its files are still there for the operator')
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200, 'the relay is still up')

  // Metadata is written atomically: a crash can only ever leave a .tmp behind, never a cut-off .json.
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'ok', secret: 's', name: 'n', identity: generateIdentity(), doc: new Y.Doc() })
  defer(() => c.close())
  await c.waitForSync()
  await waitFor(() => fs.existsSync(path.join(dataDir, 'ok.json')))
  assert.equal(fs.readdirSync(dataDir).some((f) => f.endsWith('.tmp')), false)
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'ok.json'), 'utf8')).secretHash)
})
