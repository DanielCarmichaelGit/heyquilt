import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { startTestApi, API_URL, makeOrg } from './api-helpers.js'
import { DiskStore } from '../src/api/file-store.js'
import { removeObjects } from '../src/api/routes/workspace-files.js'

let t, store
before(async () => {
  store = new DiskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-wsfiles-')))
  t = await startTestApi({ workspaces: true, fileStore: store, maxFileBytes: 100, workspaceQuotaBytes: 250, maxWorkspaceFiles: 4 })
})
after(() => t.close())

async function upload (who, wsId, p, body, extra = {}) {
  const r = await t.call('POST', `/v1/workspaces/${wsId}/files`, { path: p, size: body.length, ...extra }, who)
  if (r.status !== 200) return r
  const put = await fetch(r.body.upload.url, { method: 'PUT', body })
  assert.equal(put.status, 200)
  const done = await t.call('POST', `/v1/workspaces/${wsId}/files/${r.body.file.id}/done`, {}, who)
  return done
}

test('upload, list, download, versions, rename, move folder, delete; viewers read only', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Files' }, 'mem')).body.workspace
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'view' }, 'mem')
  const made = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'cuts/teaser.txt', size: 5, note: 'first' }, 'mem')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.deepEqual([made.body.file.path, made.body.file.name, made.body.file.folder, made.body.file.version, made.body.file.mime, made.body.upload.method], ['cuts/teaser.txt', 'teaser.txt', 'cuts', 1, 'text/plain', 'PUT'])
  assert.equal('objectKey' in made.body.file, false)
  const before = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')
  assert.deepEqual(before.body.files.map((f) => [f.path, f.kind]), [['cuts', 'folder']], 'unconfirmed uploads are not listed; the parent folder is')
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/files/${made.body.file.id}/done`, {}, 'mem')).status, 409, 'nothing landed yet')
  assert.ok(made.body.upload.url.startsWith(t.api.url + '/v1/file-data/'), 'disk links are absolute, on the address the caller used')
  assert.equal((await fetch(made.body.upload.url, { method: 'PUT', body: 'hello' })).status, 200)
  const done = await t.call('POST', `/v1/workspaces/${w.id}/files/${made.body.file.id}/done`, {}, 'mem')
  assert.deepEqual([done.status, done.body.file.size], [200, 5])
  const got = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'lim')
  assert.deepEqual(got.body.files.map((f) => f.path), ['cuts', 'cuts/teaser.txt'])
  assert.deepEqual(got.body.usage, { usedBytes: 5, quotaBytes: 250, fileCount: 1, maxFiles: 4 })
  const inFolder = await t.call('GET', `/v1/workspaces/${w.id}/files?folder=cuts`, null, 'lim')
  assert.deepEqual(inFolder.body.files.map((f) => f.name), ['teaser.txt'])
  const dl = await t.call('GET', `/v1/workspaces/${w.id}/files/${made.body.file.id}/download`, null, 'lim')
  assert.deepEqual([dl.status, dl.body.name, dl.body.mime, dl.body.size], [200, 'teaser.txt', 'text/plain', 5])
  assert.ok(dl.body.url.startsWith(t.api.url + '/v1/file-data/'))
  assert.equal(await (await fetch(dl.body.url)).text(), 'hello')
  // A viewer cannot write.
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'x.txt', size: 1 }, 'lim')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/files/${made.body.file.id}`, null, 'lim')).status, 403)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}/files`, null, 'out')).status, 404)
  // A second upload to the same path is a new version.
  const v2 = await upload('mem', w.id, 'cuts/teaser.txt', 'hello world', { note: 'longer' })
  assert.deepEqual([v2.status, v2.body.file.id, v2.body.file.version, v2.body.file.size, v2.body.file.note], [200, made.body.file.id, 2, 11, 'longer'])
  const vs = await t.call('GET', `/v1/workspaces/${w.id}/files/${made.body.file.id}/versions`, null, 'lim')
  assert.deepEqual(vs.body.versions.map((v) => [v.version, v.size, v.note]), [[1, 5, 'first']])
  const old = await t.call('GET', `/v1/workspaces/${w.id}/files/${made.body.file.id}/download?version=1`, null, 'lim')
  assert.equal(await (await fetch(old.body.url)).text(), 'hello')
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.usage.usedBytes, 16)
  // Rename, move a folder, make a folder, delete.
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}/files/${made.body.file.id}`, { path: 'cuts/final.txt' }, 'mem')).body.file.name, 'final.txt')
  const folder = got.body.files.find((f) => f.kind === 'folder')
  assert.equal((await t.call('PATCH', `/v1/workspaces/${w.id}/files/${folder.id}`, { path: 'done' }, 'mem')).status, 200)
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}/files`, null, 'mem')).body.files.map((f) => f.path), ['done', 'done/final.txt'])
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/folders`, { path: 'done' }, 'mem')).status, 409)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/folders`, { path: 'raw' }, 'mem')).body.file.kind, 'folder')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/files/${folder.id}`, null, 'mem')).status, 200)
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}/files`, null, 'mem')).body.files.map((f) => f.path), ['raw'])
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.usage.usedBytes, 0)
})

test('the workspace list counts files once an upload lands', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Counted' }, 'mem')).body.workspace
  const count = async () => (await t.call('GET', '/v1/me/workspaces', null, 'mem')).body.workspaces.find((x) => x.id === w.id).counts.files
  assert.equal(await count(), 0)
  assert.equal((await upload('mem', w.id, 'a.txt', 'hello')).status, 200)
  assert.equal(await count(), 1)
})

test('limits: file size, workspace quota, file count, bad paths', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Limits' }, 'mem')).body.workspace
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'big.bin', size: 101 }, 'mem')).status, 413)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: '../x', size: 1 }, 'mem')).status, 400)
  assert.equal((await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'x', size: 0 }, 'mem')).status, 400)
  for (const n of [1, 2, 3]) assert.equal((await upload('mem', w.id, `f${n}.txt`, 'x'.repeat(80))).status, 200)
  const r = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'f4.txt', size: 20 }, 'mem')
  assert.deepEqual([r.status, r.body.error], [413, 'this workspace has used its storage'])
  assert.equal((await upload('mem', w.id, 'f4.txt', 'y')).status, 200)
  const r5 = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'f5.txt', size: 1 }, 'mem')
  assert.deepEqual([r5.status, r5.body.error], [413, 'this workspace has too many files'])
})

test('unconfirmed uploads are forgotten after an hour and deleted files swept after 30 days', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Sweep' }, 'mem')).body.workspace
  const stale = (await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'never.txt', size: 1 }, 'mem')).body.file
  const gone = await upload('mem', w.id, 'gone.txt', 'z')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/files/${gone.body.file.id}`, null, 'mem')).status, 200)
  await t.api.sweepFiles(Date.now() + 61 * 60 * 1000)
  assert.equal(await t.store.workspaceFileById(stale.id), null)
  assert.ok(await t.store.workspaceFileById(gone.body.file.id), 'kept 30 days')
  await t.api.sweepFiles(Date.now() + 31 * 24 * 60 * 60 * 1000)
  assert.equal(await t.store.workspaceFileById(gone.body.file.id), null)
  assert.equal(await store.exists(`${w.id}/${gone.body.file.id}/1`), null, 'bytes removed from storage')
})

// fetch() won't send a made-up Host header, so this goes through node:http.
function callWithHost (method, p, body, userId, host) {
  const u = new URL(t.api.url + p)
  return new Promise((resolve, reject) => {
    const req = http.request({ agent: false, hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { host, 'content-type': 'application/json', authorization: `Bearer user:${userId}` } }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

test('links are on apiUrl unless the caller used a loopback address; a forged Host header is ignored', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Hosts' }, 'mem')).body.workspace
  const made = await upload('mem', w.id, 'a.txt', 'a')
  const evil = await callWithHost('GET', `/v1/workspaces/${w.id}/files/${made.body.file.id}/download`, null, 'mem', 'evil.example')
  assert.equal(evil.status, 200)
  assert.ok(evil.body.url.startsWith(API_URL + '/v1/file-data/'), evil.body.url)
  const up = await callWithHost('POST', `/v1/workspaces/${w.id}/files`, { path: 'b.txt', size: 1 }, 'mem', 'evil.example:8080')
  assert.ok(up.body.upload.url.startsWith(API_URL + '/v1/file-data/'), up.body.upload.url)
  const local = await callWithHost('GET', `/v1/workspaces/${w.id}/files/${made.body.file.id}/download`, null, 'mem', `localhost:${t.api.port}`)
  assert.ok(local.body.url.startsWith(`http://localhost:${t.api.port}/v1/file-data/`), local.body.url)
})

test('a file whose new version is still uploading stays listed and downloadable as the version before', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Pending' }, 'mem')).body.workspace
  const v1 = await upload('mem', w.id, 'doc.txt', 'one', { note: 'v1' })
  const pending = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'doc.txt', size: 5, note: 'v2' }, 'mem')
  assert.deepEqual([pending.status, pending.body.file.version], [200, 2])
  for (const got of [(await t.call('GET', `/v1/workspaces/${w.id}/files`, null, 'mem')).body.files, (await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.files]) {
    const f = got.find((x) => x.id === v1.body.file.id)
    assert.ok(f, 'still listed')
    assert.deepEqual([f.version, f.size, f.note, f.uploadedAt], [1, 3, 'v1', v1.body.file.uploadedAt])
  }
  const dl = await t.call('GET', `/v1/workspaces/${w.id}/files/${v1.body.file.id}/download`, null, 'mem')
  assert.deepEqual([dl.status, dl.body.size], [200, 3])
  assert.equal(await (await fetch(dl.body.url)).text(), 'one')
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}/files/${v1.body.file.id}/download?version=2`, null, 'mem')).status, 409)
})

/** Puts bytes straight into the disk store, as storage that doesn't hold an upload to its declared size would. */
function land (key, bytes) {
  fs.mkdirSync(path.dirname(store.file(key)), { recursive: true })
  fs.writeFileSync(store.file(key), bytes)
}

test('done refuses an upload whose bytes do not match the declared size, and forgets it', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Sizes' }, 'mem')).body.workspace
  const short = (await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'short.txt', size: 5 }, 'mem')).body
  assert.equal((await fetch(short.upload.url, { method: 'PUT', body: 'abc' })).status, 200)
  const r1 = await t.call('POST', `/v1/workspaces/${w.id}/files/${short.file.id}/done`, {}, 'mem')
  assert.deepEqual([r1.status, r1.body.error], [409, 'the upload did not match its declared size'])
  assert.equal(await t.store.workspaceFileById(short.file.id), null, 'the row is gone')
  assert.equal(await store.exists(`${w.id}/${short.file.id}/1`), null, 'the bytes are gone')
  const long = (await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'long.txt', size: 1 }, 'mem')).body
  land(`${w.id}/${long.file.id}/1`, 'more than one byte')
  const r2 = await t.call('POST', `/v1/workspaces/${w.id}/files/${long.file.id}/done`, {}, 'mem')
  assert.deepEqual([r2.status, r2.body.error], [409, 'the upload did not match its declared size'])
  assert.equal(await t.store.workspaceFileById(long.file.id), null)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.usage.usedBytes, 0)
})

test('done re-checks the file size and the quota against what actually landed', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Recheck' }, 'mem')).body.workspace
  const big = (await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'big.bin', size: 1 }, 'mem')).body
  land(`${w.id}/${big.file.id}/1`, 'x'.repeat(101))
  const r1 = await t.call('POST', `/v1/workspaces/${w.id}/files/${big.file.id}/done`, {}, 'mem')
  assert.deepEqual([r1.status, r1.body.error], [413, 'file too large'])
  assert.equal(await t.store.workspaceFileById(big.file.id), null)
  for (const n of [1, 2, 3]) assert.equal((await upload('mem', w.id, `f${n}.txt`, 'x'.repeat(80))).status, 200)
  const over = (await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'over.txt', size: 1 }, 'mem')).body
  land(`${w.id}/${over.file.id}/1`, 'y'.repeat(20))
  const r2 = await t.call('POST', `/v1/workspaces/${w.id}/files/${over.file.id}/done`, {}, 'mem')
  assert.deepEqual([r2.status, r2.body.error], [413, 'this workspace has used its storage'])
  assert.equal(await t.store.workspaceFileById(over.file.id), null)
  assert.equal(await store.exists(`${w.id}/${over.file.id}/1`), null)
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.usage.usedBytes, 240)
})

test('moving a folder never asks the store for an empty update (Supabase refuses one)', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Moves' }, 'mem')).body.workspace
  const folder = (await t.call('POST', `/v1/workspaces/${w.id}/folders`, { path: 'old' }, 'mem')).body.file
  const real = t.store.updateWorkspaceFile
  const patches = []
  t.store.updateWorkspaceFile = async (id, patch) => { patches.push(patch); return real.call(t.store, id, patch) }
  try {
    const moved = await t.call('PATCH', `/v1/workspaces/${w.id}/files/${folder.id}`, { path: 'new' }, 'mem')
    assert.deepEqual([moved.status, moved.body.file.path, moved.body.file.kind], [200, 'new', 'folder'])
  } finally { t.store.updateWorkspaceFile = real }
  assert.equal(patches.some((p) => !Object.keys(p).length), false, JSON.stringify(patches))
})

test('a file named outside Latin-1 downloads, with its UTF-8 name in the header', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Names' }, 'mem')).body.workspace
  const name = 'Shot 9.41 PM \u{1F3AC}.txt'
  const made = await upload('mem', w.id, name, 'hi')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const dl = await t.call('GET', `/v1/workspaces/${w.id}/files/${made.body.file.id}/download`, null, 'mem')
  const res = await fetch(dl.body.url)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="Shot 9\.41_PM _\.txt"; filename\*=UTF-8''Shot%209\.41%E2%80%AFPM%20%F0%9F%8E%AC\.txt$/)
  assert.equal(await res.text(), 'hi')
})

test('deleting a workspace removes its stored bytes, every version and deleted file included', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Doomed' }, 'mem')).body.workspace
  const a = await upload('mem', w.id, 'a.txt', 'one')
  assert.equal((await upload('mem', w.id, 'a.txt', 'two')).status, 200)
  const b = await upload('mem', w.id, 'b.txt', 'bee')
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}/files/${b.body.file.id}`, null, 'mem')).status, 200)
  const keys = [`${w.id}/${a.body.file.id}/1`, `${w.id}/${a.body.file.id}/2`, `${w.id}/${b.body.file.id}/1`]
  for (const k of keys) assert.ok(await store.exists(k), k)
  assert.equal((await t.call('DELETE', `/v1/workspaces/${w.id}`, null, 'mem')).status, 200)
  for (const k of keys) assert.equal(await store.exists(k), null, k)
})

test('removeObjects asks storage in batches of 100 and carries on past a failed batch', async () => {
  const calls = []
  const logged = []
  const fake = { remove: async (keys) => { calls.push(keys.length); if (calls.length === 2) throw new Error('storage: nope') } }
  await removeObjects(fake, Array.from({ length: 250 }, (_, i) => `k${i}`), (m) => logged.push(m))
  assert.deepEqual(calls, [100, 100, 50])
  assert.deepEqual(logged, ['file store: storage: nope'])
  await removeObjects(fake, [], () => {})
  assert.equal(calls.length, 3, 'nothing to remove, no call')
})

test('an org member with Workspaces: Read alone sees the workspace but not its files; members and admins do', async () => {
  const o = await makeOrg(t, 'Files Co')
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Org files', org: o.slug }, 'owner')).body.workspace
  const f = await upload('owner', w.id, 'plan.txt', 'secret')
  assert.equal(f.status, 200, JSON.stringify(f.body))
  const page = await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')
  assert.deepEqual([page.status, page.body.access.via, page.body.access.access, page.body.files], [200, 'org', 'view', []])
  assert.equal(page.body.usage.usedBytes, 6, 'usage still shows')
  for (const [method, p] of [['GET', '/files'], ['GET', `/files/${f.body.file.id}/download`], ['GET', `/files/${f.body.file.id}/versions`], ['POST', '/folders'], ['POST', '/files'], ['PATCH', `/files/${f.body.file.id}`], ['DELETE', `/files/${f.body.file.id}`], ['POST', `/files/${f.body.file.id}/done`]]) {
    const r = await t.call(method, `/v1/workspaces/${w.id}${p}`, method === 'GET' || method === 'DELETE' ? null : { path: 'x.txt', size: 1 }, 'mem')
    assert.deepEqual([r.status, r.body.error], [404, 'not found'], `${method} ${p}`)
  }
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'admin')).body.files.map((x) => x.path), ['plan.txt'], 'an org admin sees them')
  assert.equal((await t.call('PUT', `/v1/workspaces/${w.id}/members/person:mem`, { access: 'view' }, 'owner')).status, 200)
  assert.deepEqual((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.files.map((x) => x.path), ['plan.txt'], 'a view member sees them')
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}/files`, null, 'mem')).status, 200)
})

test('a re-upload names its object after the version the store gave it, not one guessed beforehand', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Race' }, 'mem')).body.workspace
  const v1 = await upload('mem', w.id, 'r.txt', 'one')
  assert.equal((await upload('mem', w.id, 'r.txt', 'two')).status, 200)
  // Another upload got in between this one reading the row and asking for a new version.
  const real = t.store.workspaceFileByPath
  t.store.workspaceFileByPath = async (...a) => { const f = await real.apply(t.store, a); return f && f.path === 'r.txt' ? { ...f, version: 1 } : f }
  let made
  try { made = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'r.txt', size: 5 }, 'mem') } finally { t.store.workspaceFileByPath = real }
  assert.deepEqual([made.status, made.body.file.version], [200, 3])
  assert.ok(made.body.upload.url.includes(`/v1/file-data/${w.id}/${v1.body.file.id}/3?`), made.body.upload.url)
  assert.equal((await t.store.workspaceFileById(v1.body.file.id)).objectKey, `${w.id}/${v1.body.file.id}/3`)
})

test('an upload to a path someone is still uploading to waits its turn, unless that upload is stale', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Turns' }, 'mem')).body.workspace
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'edit' }, 'mem')
  const first = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'busy.txt', size: 3 }, 'mem')
  assert.equal(first.status, 200)
  // Someone else must wait; the uploader may retry their own attempt at once (tested below).
  const second = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'busy.txt', size: 3 }, 'lim')
  assert.deepEqual([second.status, second.body.error], [409, 'someone is uploading this file right now; try again in a moment'])
  assert.ok(await t.store.workspaceFileById(first.body.file.id), 'the first upload is left alone')
  // Eleven minutes on, its link has expired: the next upload takes over.
  const real = t.store.workspaceFileByPath
  t.store.workspaceFileByPath = async (...a) => { const f = await real.apply(t.store, a); return f && f.path === 'busy.txt' ? { ...f, uploadedAt: f.uploadedAt - 11 * 60 * 1000 } : f }
  let third
  try { third = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'busy.txt', size: 3 }, 'lim') } finally { t.store.workspaceFileByPath = real }
  assert.equal(third.status, 200, JSON.stringify(third.body))
  assert.equal(await t.store.workspaceFileById(first.body.file.id), null, 'the stale upload was forgotten')
})

test('the disk store never overwrites an object that has landed, as Supabase would not', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Once' }, 'mem')).body.workspace
  const made = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'once.txt', size: 5 }, 'mem')
  assert.equal((await fetch(made.body.upload.url, { method: 'PUT', body: 'first' })).status, 200)
  const again = await fetch(made.body.upload.url, { method: 'PUT', body: 'other' })
  assert.deepEqual([again.status, (await again.json()).error], [409, 'already stored'])
  assert.equal(fs.readFileSync(store.file(`${w.id}/${made.body.file.id}/1`), 'utf8'), 'first')
})

test('a mime type that is not one falls back to the one the name suggests', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Types' }, 'mem')).body.workspace
  // Four at most: this API allows four files a workspace, and each started upload counts.
  const mimeFor = async (p, mime) => (await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: p, size: 1, mime }, 'mem')).body.file.mime
  assert.equal(await mimeFor('a.bin', 'image/png'), 'image/png')
  assert.equal(await mimeFor('c.txt', 'text/html; charset=utf-8'), 'text/plain')
  assert.equal(await mimeFor('d.txt', 'text/html\r\nx-evil: 1'), 'text/plain')
  assert.equal(await mimeFor('f.txt', `text/${'x'.repeat(100)}`), 'text/plain')
})

test('done twice is harmless, and the same uploader may retry their own unlanded upload', async () => {
  const w = (await t.call('POST', '/v1/workspaces', { name: 'Retry' }, 'mem')).body.workspace
  await t.call('PUT', `/v1/workspaces/${w.id}/members/person:lim`, { access: 'edit' }, 'mem')
  const first = await upload('mem', w.id, 'a.txt', 'x'.repeat(90))
  assert.equal(first.status, 200)
  const again = await t.call('POST', `/v1/workspaces/${w.id}/files/${first.body.file.id}/done`, {}, 'mem')
  assert.deepEqual([again.status, again.body.file.size, again.body.file.version], [200, 90, 1], 'a repeat done confirms nothing twice and abandons nothing')
  assert.equal((await t.call('GET', `/v1/workspaces/${w.id}`, null, 'mem')).body.usage.usedBytes, 90)
  // A re-upload that never lands: the uploader retries at once; someone else must wait.
  const pending = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'a.txt', size: 5 }, 'mem')
  assert.equal(pending.status, 200)
  const other = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'a.txt', size: 5 }, 'lim')
  assert.equal(other.status, 409)
  const retry = await t.call('POST', `/v1/workspaces/${w.id}/files`, { path: 'a.txt', size: 5 }, 'mem')
  assert.equal(retry.status, 200, JSON.stringify(retry.body))
  assert.equal(retry.body.file.version, 2, 'the abandoned attempt was reverted to version 1, and the retry starts version 2 again')
  assert.equal((await t.store.workspaceFileById(first.body.file.id)).objectKey, `${w.id}/${first.body.file.id}/2`)
})
