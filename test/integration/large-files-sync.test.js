// Big binary files travel encrypted through storage, not inside the session document.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { startServer } from '../../src/server.js'
import { Session } from '../../src/session.js'
import { generateIdentity } from '../../src/identity.js'
import { NO_SYMLINKS } from '../helpers/platform.js'

let srv, server, dataDir
const sessions = []
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-lf-${n}-`))
const bytes = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel)) } catch { return null } }
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) {
    try { last = await fn(); if (last) return last } catch (err) { last = err }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out; last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
async function open (dir, name, extra) {
  const s = new Session({ dir, server, secret: 'edit', name, identity: generateIdentity(), ...extra })
  sessions.push(s)
  await s.start({ waitTimeoutMs: 5000 })
  s.setAgentState({ tool: null, status: 'idle' }) // people typing by hand; their edits are not claimed for them
  return s
}
let n = 0
const big = () => crypto.randomBytes(300 * 1024)

before(async () => {
  dataDir = tmp('relay')
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: () => {} })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => {
  for (const s of sessions) await s.stop().catch(() => {})
  await srv.close()
})

test('a large file reaches the other app, stored encrypted and not in the document', async () => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))

  const entry = A.blobs.get('photo.png')
  assert.ok(entry.stored && entry.stored.id, 'stored, not inline')
  assert.equal(entry.data, undefined)
  assert.equal(entry.size, img.length)
  const onRelay = fs.readFileSync(path.join(dataDir, 'blobs', room, entry.stored.id))
  assert.ok(!onRelay.includes(img.subarray(5000, 5064)), 'the relay only has ciphertext')
  await waitFor(() => fs.existsSync(path.join(dataDir, `${room}.ydoc`)))
  assert.ok(fs.statSync(path.join(dataDir, `${room}.ydoc`)).size < 64 * 1024, 'the document stays small')

  const next = big()
  fs.writeFileSync(path.join(dirB, 'photo.png'), next)
  await waitFor(() => bytes(dirA, 'photo.png')?.equals(next))
  fs.rmSync(path.join(dirA, 'photo.png'))
  await waitFor(() => bytes(dirB, 'photo.png') === null)
  assert.equal(B.readShared('photo.png'), null)
})

test('small binary files and text still travel inside the document', async () => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const icon = crypto.randomBytes(4 * 1024)
  fs.writeFileSync(path.join(dirA, 'icon.png'), icon)
  fs.writeFileSync(path.join(dirA, 'big.txt'), 'x'.repeat(400 * 1024))
  const A = await open(dirA, 'alice', { room })
  await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'icon.png')?.equals(icon))
  await waitFor(() => bytes(dirB, 'big.txt')?.length === 400 * 1024)
  assert.ok(A.blobs.get('icon.png').data, 'small files stay inline')
  assert.ok(A.files.get('big.txt'), 'text stays text')
})

test('people who can only view can open large files', async () => {
  const room = `lf-${++n}`
  const ownerDir = tmp('owner')
  const img = big()
  fs.writeFileSync(path.join(ownerDir, 'hero.jpg'), img)
  const owner = await open(ownerDir, 'olive', { room, viewSecret: 'view' })
  await waitFor(() => owner.access && owner.access.owner)
  await waitFor(() => owner.blobs.get('hero.jpg')?.stored)
  const viewerDir = tmp('viewer')
  const viewer = await open(viewerDir, 'vic', { room, secret: 'view' })
  const req = await waitFor(() => owner.waiting.find((p) => p.name === 'vic'))
  await owner.approve(req.key, { role: 'viewer' })
  await waitFor(() => viewer.access && viewer.access.state === 'approved')
  await waitFor(() => bytes(viewerDir, 'hero.jpg')?.equals(img))
})

test('an owner can end the session for everyone', async () => {
  const room = `lf-${++n}`
  const ownerDir = tmp('owner')
  fs.writeFileSync(path.join(ownerDir, 'a.bin'), big())
  const owner = await open(ownerDir, 'olive', { room, viewSecret: 'view' })
  await waitFor(() => owner.blobs.get('a.bin')?.stored)
  const fatal = new Promise((resolve) => owner.on('fatal', resolve))
  await owner.endForEveryone()
  assert.equal((await fatal).ended, true)
  await waitFor(() => !fs.existsSync(path.join(dataDir, 'blobs', room)))
})

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')
// Holds every download until released (only the receiving app downloads).
function holdDownloads (t) {
  const real = globalThis.fetch
  let release
  const gate = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/download') && (await gate) === 'fail') throw new Error('connection lost')
    return real(url, opts)
  }
  const restore = () => { globalThis.fetch = real }
  t.after(restore)
  return { release: (how = 'go') => release(how), restore }
}
// Every update before it has reached `to` once `to` sees this marker.
async function roundTrip (from, to) {
  const name = `marker-${crypto.randomBytes(3).toString('hex')}.txt`
  fs.writeFileSync(path.join(from.root, name), 'marker')
  await waitFor(() => to.files.get(name))
  return name
}

test('an older relay without file storage: large files travel inside the document', async (t) => {
  const real = globalThis.fetch
  globalThis.fetch = (url, opts) => String(url).includes('/blobs/') ? Promise.resolve(new Response('not found', { status: 404 })) : real(url, opts)
  t.after(() => { globalThis.fetch = real })
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))
  const entry = A.blobs.get('photo.png')
  assert.ok(entry.data, 'inline')
  assert.equal(entry.stored, undefined)
})

test('restarting before a download finished fetches the file instead of deleting it', async () => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img) && B.storedOnDisk.get('photo.png'))
  await B.stop()
  // As if the download never finished: no file, and no record of one.
  fs.rmSync(path.join(dirB, 'photo.png'))
  const stateJson = path.join(B.stateDir, 'state.json')
  const meta = JSON.parse(fs.readFileSync(stateJson, 'utf8'))
  delete meta.storedOnDisk
  fs.writeFileSync(stateJson, JSON.stringify(meta))

  const B2 = await open(dirB, 'bob', { room, identity: B.identity })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))
  await roundTrip(B2, A)
  assert.ok(A.blobs.get('photo.png')?.stored, 'still shared')
  assert.ok(bytes(dirA, 'photo.png')?.equals(img))
})

test('restarting with an older version still on disk downloads the newer one instead of sharing the old', async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img) && B.storedOnDisk.get('photo.png'))

  const hold = holdDownloads(t)
  const next = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), next)
  await waitFor(() => B.blobs.get('photo.png')?.hash === sha1(next) && B.downloading.has('photo.png'))
  await B.stop()
  hold.release('fail')
  hold.restore()

  const B2 = await open(dirB, 'bob', { room, identity: B.identity })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(next))
  await roundTrip(B2, A)
  assert.equal(A.blobs.get('photo.png').hash, sha1(next), 'the old version was not shared again')
  assert.ok(bytes(dirA, 'photo.png')?.equals(next))
  assert.ok(!fs.existsSync(path.join(B2.stateDir, 'conflicts')), 'nothing was edited, so no conflict copy')
})

test('an edit made while a download is in flight is kept as a conflict copy', async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img) && B.storedOnDisk.get('photo.png'))

  const hold = holdDownloads(t)
  const next = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), next)
  await waitFor(() => B.downloading.has('photo.png'))
  const mine = big()
  fs.writeFileSync(path.join(dirB, 'photo.png'), mine)
  hold.release()
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(next))
  const conflicts = path.join(B.stateDir, 'conflicts')
  const [stamp] = fs.readdirSync(conflicts)
  assert.ok(fs.readFileSync(path.join(conflicts, stamp, 'photo.png')).equals(mine))
  await roundTrip(B, A)
  assert.equal(A.blobs.get('photo.png').hash, sha1(next))
})

test('uploading a file that is already stored counts as done', async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))
  const id = A.blobs.get('photo.png').stored.id
  fs.rmSync(path.join(dirA, 'photo.png'))
  await waitFor(() => !B.blobs.has('photo.png') && bytes(dirB, 'photo.png') === null)

  // The same file again has the same id, and the relay already has it.
  const real = globalThis.fetch
  const puts = []
  globalThis.fetch = async (url, opts) => {
    const res = await real(url, opts)
    if (opts && opts.method === 'PUT') puts.push(res.status)
    return res
  }
  t.after(() => { globalThis.fetch = real })
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))
  assert.deepEqual(puts, [409])
  assert.equal(A.blobs.get('photo.png').stored.id, id)
})

/** Replaces fetch for this test: `fn(url, opts, real)` answers each request. */
function stubFetch (t, fn) {
  const real = globalThis.fetch
  globalThis.fetch = (url, opts) => fn(String(url), opts || {}, real)
  t.after(() => { globalThis.fetch = real })
}
const gate = () => { let open; const p = new Promise((resolve) => { open = resolve }); return { p, open } }

test('an upload that finishes after a partner\'s newer version arrived does not replace it', async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img) && B.storedOnDisk.get('photo.png'))

  // Bob's next upload and every download wait until released.
  const put = gate(); const downloads = gate()
  let held = null
  stubFetch(t, async (url, opts, real) => {
    if (opts.method === 'PUT' && !held) { held = url; await put.p }
    if (url.includes('/download')) await downloads.p
    return real(url, opts)
  })
  const mine = big()
  fs.writeFileSync(path.join(dirB, 'photo.png'), mine)
  await waitFor(() => held)
  const next = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), next)
  await waitFor(() => B.blobs.get('photo.png')?.hash === sha1(next) && B.downloading.has('photo.png'))
  put.open()
  await waitFor(() => !B.uploading.has('photo.png'))
  await roundTrip(B, A)
  assert.equal(A.blobs.get('photo.png').hash, sha1(next), 'Alice\'s newer version stays')
  downloads.open()
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(next))
  const conflicts = path.join(B.stateDir, 'conflicts')
  assert.ok(fs.readdirSync(conflicts).some((d) => bytes(path.join(conflicts, d), 'photo.png')?.equals(mine)), 'Bob\'s version was kept aside')
})

test('a file the relay refuses as too big is skipped until it changes', async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a')
  const A = await open(dirA, 'alice', { room })
  const logs = []
  A.on('log', (m) => logs.push(m))
  let asked = 0
  stubFetch(t, (url, opts, real) => {
    if (url.endsWith('/upload')) { asked++; return Promise.resolve(new Response('files over 1 MB can\'t be shared', { status: 413 })) }
    return real(url, opts)
  })
  fs.writeFileSync(path.join(dirA, 'huge.bin'), big())
  await waitFor(() => logs.some((m) => /skipping huge\.bin: the relay won't store it \(files over 1 MB/.test(m)))
  assert.equal(A.retry.has('huge.bin'), false, 'not retried')
  A.retryFailed()
  A.ingest('huge.bin')
  assert.equal(asked, 1)
  assert.equal(A.blobs.has('huge.bin'), false)
  assert.equal(logs.filter((m) => m.includes('skipping huge.bin')).length, 1, 'warned once')
  fs.writeFileSync(path.join(dirA, 'huge.bin'), big())
  await waitFor(() => asked === 2)
})

test('an app whose invite only lets it view shares large files inside the document, up to 8 MB', async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const A = await open(dirA, 'alice', { room })
  await open(dirB, 'bob', { room })
  const logs = []
  A.on('log', (m) => logs.push(m))
  stubFetch(t, (url, opts, real) => {
    if (url.endsWith('/upload')) return Promise.resolve(new Response('you can only view this session', { status: 403 }))
    return real(url, opts)
  })
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))
  assert.ok(A.blobs.get('photo.png').data, 'inline')
  fs.writeFileSync(path.join(dirA, 'video.bin'), crypto.randomBytes(9 * 1024 * 1024))
  await waitFor(() => logs.some((m) => /skipping video\.bin: you joined with a view-only invite/.test(m)))
  assert.equal(A.retry.has('video.bin'), false, 'not retried')
  assert.equal(A.blobs.has('video.bin'), false)
})

test('at most two large files move at once; the rest wait their turn', async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const A = await open(dirA, 'alice', { room })
  await open(dirB, 'bob', { room })
  const puts = gate()
  let running = 0; let most = 0
  stubFetch(t, async (url, opts, real) => {
    if (opts.method !== 'PUT') return real(url, opts)
    running++; most = Math.max(most, running)
    try { await puts.p; return await real(url, opts) } finally { running-- }
  })
  const files = ['a.bin', 'b.bin', 'c.bin', 'd.bin'].map((name) => [name, big()])
  for (const [name, buf] of files) fs.writeFileSync(path.join(dirA, name), buf)
  await waitFor(() => running === 2 && A.transferQueue.length === 2)
  puts.open()
  for (const [name, buf] of files) await waitFor(() => bytes(dirB, name)?.equals(buf))
  assert.equal(most, 2)
})

test('a download never writes through a link, and keeps a local file it cannot read as content', { skip: NO_SYMLINKS }, async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b'); const outside = tmp('outside')
  fs.writeFileSync(path.join(dirA, 'photo.png'), big())
  fs.writeFileSync(path.join(dirA, 'linked.png'), big())
  await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => B.storedOnDisk.get('photo.png') && B.storedOnDisk.get('linked.png'))
  // Alice changes both, and Bob stops before downloading them. Meanwhile one
  // becomes a huge text file on his disk, and the other a link out of the project.
  const hold = holdDownloads(t)
  const photo = big(); const linked = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), photo)
  fs.writeFileSync(path.join(dirA, 'linked.png'), linked)
  await waitFor(() => B.blobs.get('photo.png')?.hash === sha1(photo) && B.blobs.get('linked.png')?.hash === sha1(linked) &&
    B.downloading.has('photo.png') && B.downloading.has('linked.png'))
  await B.stop()
  hold.release('fail')
  hold.restore()
  const huge = 'x'.repeat(3 * 1024 * 1024)
  fs.writeFileSync(path.join(dirB, 'photo.png'), huge)
  fs.writeFileSync(path.join(outside, 'target.png'), 'outside')
  fs.rmSync(path.join(dirB, 'linked.png'))
  fs.symlinkSync(path.join(outside, 'target.png'), path.join(dirB, 'linked.png'))

  const logs = []
  const B2 = new Session({ dir: dirB, server, secret: 'edit', name: 'bob', room, identity: B.identity })
  B2.setAgentState({ tool: null, status: 'idle' })
  sessions.push(B2)
  B2.on('log', (m) => logs.push(m))
  await B2.start({ waitTimeoutMs: 5000 })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(photo))
  const conflicts = path.join(B2.stateDir, 'conflicts')
  assert.ok(fs.readdirSync(conflicts).some((d) => bytes(path.join(conflicts, d), 'photo.png')?.toString() === huge), 'the huge file was kept')
  await waitFor(() => logs.some((m) => /not writing linked\.png/.test(m)))
  assert.equal(fs.readFileSync(path.join(outside, 'target.png'), 'utf8'), 'outside')
  assert.ok(fs.lstatSync(path.join(dirB, 'linked.png')).isSymbolicLink())
})
