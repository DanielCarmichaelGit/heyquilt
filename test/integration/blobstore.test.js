import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { DiskStore, SupabaseStore, makeStore } from '../../src/blobstore.js'
import { relayConfig, startServer } from '../../src/server.js'
import { Connection } from '../../src/connection.js'
import { generateIdentity } from '../../src/identity.js'
import * as Y from 'yjs'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-blob-${n}-`))
const ID = 'a'.repeat(32)

test('disk store links are signed, method-bound and expire', async () => {
  const store = new DiskStore(tmp('disk'))
  const up = await store.uploadTarget('room', ID)
  assert.equal(up.method, 'PUT')
  const q = new URL(up.url, 'http://x').searchParams
  assert.match(up.url, new RegExp(`^/blobs/room/${ID}/data\\?`))
  assert.equal(store.verify('room', ID, 'PUT', q.get('exp'), q.get('sig')), true)
  assert.equal(store.verify('room', ID, 'GET', q.get('exp'), q.get('sig')), false, 'bound to the method')
  assert.equal(store.verify('other', ID, 'PUT', q.get('exp'), q.get('sig')), false, 'bound to the room')
  assert.equal(store.verify('room', ID, 'PUT', String(Date.now() - 1), q.get('sig')), false, 'expired or altered')
  const up4 = await store.uploadTarget('room', ID, 4)
  const q4 = new URL(up4.url, 'http://x').searchParams
  assert.equal(store.verify('room', ID, 'PUT', q4.get('exp'), q4.get('sig'), 4), true)
  assert.equal(store.verify('room', ID, 'PUT', q4.get('exp'), q4.get('sig'), 5), false, 'bound to the declared size')
})

test('disk store removes files and whole rooms', async () => {
  const dir = tmp('rm')
  const store = new DiskStore(dir)
  fs.mkdirSync(path.dirname(store.file('room', ID)), { recursive: true })
  fs.writeFileSync(store.file('room', ID), 'x')
  fs.writeFileSync(store.file('room', 'b'.repeat(32)), 'y')
  await store.remove('room', [ID])
  assert.equal(fs.existsSync(store.file('room', ID)), false)
  assert.equal(fs.existsSync(store.file('room', 'b'.repeat(32))), true)
  await store.removeRoom('room')
  assert.equal(fs.existsSync(path.join(dir, 'room')), false)
})

test('the relay uses Supabase only when it has both a URL and a key', () => {
  assert.ok(makeStore(relayConfig({}), tmp('a')) instanceof DiskStore)
  const cfg = relayConfig({ storageUrl: 'https://x.supabase.co', storageKey: 'sb_secret_x' })
  assert.ok(makeStore(cfg, tmp('b')) instanceof SupabaseStore)
  assert.equal(cfg.storageBucket, 'session-files')
  assert.equal(relayConfig({}).maxStoredFileBytes, 100 * 1024 * 1024)
  assert.equal(relayConfig({ maxStoredFileBytes: 10 }).maxStoredFileBytes, 10)
})

test('a relay with only half of the Supabase settings refuses to start', () => {
  for (const half of [{ storageUrl: 'https://x.supabase.co' }, { storageKey: 'sb_secret_x' }]) {
    assert.throws(() => makeStore(relayConfig(half), tmp('h')), /QUILT_STORAGE_URL and QUILT_STORAGE_KEY/)
    assert.throws(() => startServer({ port: 0, host: '127.0.0.1', log: () => {}, ...half }), /half set up/)
  }
})

test('deleting a room\'s Supabase files stops instead of looping forever', async () => {
  const store = new SupabaseStore({ url: 'https://x.supabase.co', key: 'sb_secret_x', bucket: 'b' })
  // Something that can't be deleted (a folder) stays in the listing.
  store.bucket = { list: async () => ({ data: [{ name: 'folder' }], error: null }), remove: async () => ({ data: [], error: null }) }
  await assert.rejects(store.removeRoom('room'), /could not delete the stored files of room/)
  // A listing that never runs out is given up on after a bounded number of rounds.
  let rounds = 0
  store.bucket = { list: async () => { rounds++; return { data: [{ name: 'x' }], error: null } }, remove: async (paths) => ({ data: paths, error: null }) }
  await assert.rejects(store.removeRoom('room'), /gave up/)
  assert.equal(rounds, 1000)
})

async function relay (t, opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, ...opts })
  t.after(() => srv.close())
  return { srv, base: `http://127.0.0.1:${srv.port}` }
}
const ask = (base, room, id, action, secret, body = {}) => fetch(`${base}/blobs/${room}/${id}/${action}`, {
  method: 'POST', headers: { 'x-quilt-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body)
})

test('editors get an upload link, and anyone in the room can download', async (t) => {
  const { srv, base } = await relay(t)
  const up = await ask(base, 'r1', ID, 'upload', 's', { size: 5 })
  assert.equal(up.status, 200)
  const target = await up.json()
  const put = await fetch(new URL(target.url, base), { method: 'PUT', body: 'hello' })
  assert.equal(put.status, 201)
  assert.equal(fs.readFileSync(srv.store.file('r1', ID), 'utf8'), 'hello')
  assert.equal(srv.rooms.get('r1').meta.largeFiles, true)

  const down = await ask(base, 'r1', ID, 'download', 's')
  const { url } = await down.json()
  assert.equal(await (await fetch(new URL(url, base))).text(), 'hello')

  assert.equal((await ask(base, 'r1', ID, 'download', 'wrong')).status, 401)
  assert.equal((await ask(base, 'r1', 'c'.repeat(32), 'download', 's')).status, 404)
  assert.equal((await fetch(`${base}/blobs/r1/${ID}/data?m=GET&exp=1&sig=00`)).status, 403)
})

test('uploads are refused over the size cap or the room quota', async (t) => {
  const { base } = await relay(t, { maxStoredFileBytes: 10, maxRoomFileBytes: 15 })
  assert.equal((await ask(base, 'r2', ID, 'upload', 's', { size: 11 })).status, 413)
  assert.equal((await ask(base, 'r2', ID, 'upload', 's', { size: 10 })).status, 200)
  assert.equal((await ask(base, 'r2', 'b'.repeat(32), 'upload', 's', { size: 10 })).status, 413)
  // A PUT larger than the size it declared is cut off, even well under the global cap.
  const { base: b2 } = await relay(t)
  const target = await (await ask(b2, 'r3', ID, 'upload', 's', { size: 4 })).json()
  assert.equal((await fetch(new URL(target.url, b2), { method: 'PUT', body: 'x'.repeat(50) })).status, 413)
})

test('once a room stores files, apps without large-file support are turned away', async (t) => {
  const { base } = await relay(t)
  await ask(base, 'r4', ID, 'upload', 's', { size: 1 })
  const server = base.replace('http', 'ws')
  const refused = await new Promise((resolve) => {
    const c = new Connection({ server, room: 'r4', secret: 's', name: 'old', identity: generateIdentity(), doc: new Y.Doc(), features: 'branches' })
    c.on('fatal', (err) => { c.close(); resolve(err.message) })
  })
  assert.match(refused, /newer version of Quilt/)
  const c = new Connection({ server, room: 'r4', secret: 's', name: 'new', identity: generateIdentity(), doc: new Y.Doc() })
  t.after(() => c.close())
  await c.waitForSync()
})

test('ending a room while a file is being uploaded to the relay\'s disk does not crash the relay', { timeout: 5000 }, async (t) => {
  const { srv, base } = await relay(t)
  const server = base.replace('http', 'ws')
  const owner = new Connection({ server, room: 'r5', secret: 's', viewSecret: 'v', name: 'olive', identity: generateIdentity(), doc: new Y.Doc() })
  t.after(() => owner.close())
  await owner.waitForSync()
  while (!owner.access || !owner.access.owner) await new Promise((resolve) => owner.once('access', resolve))
  const target = await (await ask(base, 'r5', ID, 'upload', 's', { size: 10 })).json()
  const dir = path.dirname(srv.store.file('r5', ID))
  fs.mkdirSync(dir, { recursive: true })
  const reply = new Promise((resolve, reject) => {
    const req = http.request(new URL(target.url, base), { method: 'PUT', headers: { 'content-length': 10 } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.write('hello')
    // Ended once the relay has started writing the file, then the rest is sent. Polled,
    // not fs.watch: file events can be late or never come (sandboxes, some file systems).
    // Stops when the test does, so a stuck run fails at its timeout instead of hanging.
    const wait = () => { if (t.signal.aborted) throw new Error('stopped'); return new Promise((resolve) => setTimeout(resolve, 5)) }
    ;(async () => {
      while (!fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))) await wait()
      const ended = new Promise((resolve) => owner.once('fatal', resolve))
      owner.adminRequest({ op: 'end' }).catch(() => {})
      await ended
      while (fs.existsSync(dir)) await wait()
      req.end('world')
    })().catch(reject)
  })
  assert.equal(await reply, 500)
  assert.equal((await (await fetch(`${base}/healthz`)).json()).ok, true, 'the relay is still running')
})

test('apps without large-file support already in the room are sent away when it first stores a file', async (t) => {
  const { base } = await relay(t)
  const server = base.replace('http', 'ws')
  const old = new Connection({ server, room: 'r6', secret: 's', name: 'old', identity: generateIdentity(), doc: new Y.Doc(), features: 'branches' })
  t.after(() => old.close())
  const current = new Connection({ server, room: 'r6', secret: 's', name: 'new', identity: generateIdentity(), doc: new Y.Doc() })
  t.after(() => current.close())
  await Promise.all([old.waitForSync(), current.waitForSync()])
  const sentAway = new Promise((resolve) => old.on('fatal', resolve))
  let currentLeft = false
  current.on('status', (s) => { if (s === 'disconnected') currentLeft = true })
  assert.equal((await ask(base, 'r6', ID, 'upload', 's', { size: 1 })).status, 200)
  assert.match((await sentAway).message, /newer version of Quilt/)
  await roundTrip(current)
  assert.equal(currentLeft, false, 'apps that support large files stay')
})

test('an app without large-file support needs the right secret to learn the session stores files', async (t) => {
  const { base } = await relay(t)
  await ask(base, 'r7', ID, 'upload', 's', { size: 1 })
  const server = base.replace('http', 'ws')
  const refused = await new Promise((resolve) => {
    const c = new Connection({ server, room: 'r7', secret: 'wrong', name: 'old', identity: generateIdentity(), doc: new Y.Doc(), features: 'branches' })
    c.on('fatal', (err) => { c.close(); resolve(err.message) })
  })
  assert.match(refused, /Wrong room secret/)
})

/** Resolves once the relay has answered a request from `c`, so everything it sent before has arrived. */
function roundTrip (c) {
  return c.claimRequest({ op: 'release', pattern: '*' })
}

test('stored files are written once', async (t) => {
  const { srv, base } = await relay(t)
  const put = async (body) => {
    const target = await (await ask(base, 'r8', ID, 'upload', 's', { size: body.length })).json()
    return fetch(new URL(target.url, base), { method: 'PUT', body })
  }
  assert.equal((await put('first')).status, 201)
  const again = await put('other')
  assert.equal(again.status, 409)
  assert.equal(fs.readFileSync(srv.store.file('r8', ID), 'utf8'), 'first')
})

test('Supabase upload links never replace a stored file', async () => {
  const store = new SupabaseStore({ url: 'https://x.supabase.co', key: 'sb_secret_x', bucket: 'b' })
  const seen = []
  store.bucket = {
    async createSignedUploadUrl (p, opts) {
      seen.push(opts)
      if (p.endsWith(ID)) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } }
      return { data: { signedUrl: 'https://x.supabase.co/sign' }, error: null }
    }
  }
  assert.deepEqual(await store.uploadTarget('room', 'b'.repeat(32), 1), { method: 'PUT', url: 'https://x.supabase.co/sign' })
  assert.deepEqual(await store.uploadTarget('room', ID, 1), { exists: true })
  assert.deepEqual(seen.map((o) => o.upsert), [false, false])
})

test('people who can only view get no upload link', async (t) => {
  const { base } = await relay(t)
  const owner = new Connection({ server: base.replace('http', 'ws'), room: 'r9', secret: 's', viewSecret: 'v', name: 'olive', identity: generateIdentity(), doc: new Y.Doc() })
  t.after(() => owner.close())
  await owner.waitForSync()
  const r = await ask(base, 'r9', ID, 'upload', 'v', { size: 1 })
  assert.equal(r.status, 403)
  assert.match(await r.text(), /only view/)
  assert.equal((await ask(base, 'r9', ID, 'upload', 's', { size: 1 })).status, 200)
  assert.equal((await ask(base, 'r9', ID, 'download', 'v')).status, 200, 'but they can download')
})
