import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiskStore, SupabaseStore, makeFileStore, LINK_MS } from '../src/api/file-store.js'
import { startTestApi } from './api-helpers.js'

const KEY = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/1'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-fstore-'))

test('disk store links are signed, bound to method, key and size, and expire', async () => {
  const store = new DiskStore(tmp())
  const up = await store.uploadTarget(KEY, 4)
  assert.equal(up.method, 'PUT')
  const q = new URL(up.url, 'http://x').searchParams
  assert.ok(up.url.startsWith(`/v1/file-data/${KEY}?`))
  assert.equal(store.verify(KEY, 'PUT', q.get('exp'), q.get('sig'), 4), true)
  assert.equal(store.verify(KEY, 'PUT', q.get('exp'), q.get('sig'), 5), false)
  assert.equal(store.verify(KEY, 'GET', q.get('exp'), q.get('sig'), 4), false)
  assert.equal(store.verify(KEY.replace('/1', '/2'), 'PUT', q.get('exp'), q.get('sig'), 4), false)
  assert.equal(store.verify(KEY, 'PUT', String(Date.now() - 1), q.get('sig'), 4), false)
  const down = await store.downloadTarget(KEY, { name: 'a b.txt', type: 'text/plain' })
  assert.match(down.url, /m=GET/)
  assert.ok(Number(new URL(down.url, 'http://x').searchParams.get('exp')) <= Date.now() + LINK_MS)
  assert.throws(() => store.file('../etc/passwd'), /key/)
})

test('disk store: exists and remove', async () => {
  const store = new DiskStore(tmp())
  assert.equal(await store.exists(KEY), null)
  fs.mkdirSync(path.dirname(store.file(KEY)), { recursive: true })
  fs.writeFileSync(store.file(KEY), 'abcd')
  assert.deepEqual(await store.exists(KEY), { size: 4 })
  await store.remove([KEY])
  assert.equal(await store.exists(KEY), null)
})

test('the API serves disk-store links: PUT within the signed size, GET with name and type, 403 on a bad signature', async () => {
  const dir = tmp()
  const store = new DiskStore(dir)
  const t = await startTestApi({ fileStore: store })
  try {
    const up = await store.uploadTarget(KEY, 4)
    const bad = await fetch(t.api.url + up.url.replace(/sig=[0-9a-f]+/, 'sig=00'), { method: 'PUT', body: 'abcd' })
    assert.equal(bad.status, 403)
    const big = await fetch(t.api.url + up.url, { method: 'PUT', body: 'abcde' })
    assert.equal(big.status, 413)
    assert.equal(await store.exists(KEY), null, 'nothing kept from a refused upload')
    const ok = await fetch(t.api.url + up.url, { method: 'PUT', body: 'abcd' })
    assert.equal(ok.status, 200)
    assert.deepEqual(await store.exists(KEY), { size: 4 })
    const down = await store.downloadTarget(KEY, { name: 'a b.txt', type: 'text/plain' })
    const got = await fetch(t.api.url + down.url)
    assert.equal(got.status, 200)
    assert.equal(got.headers.get('content-type'), 'text/plain')
    assert.equal(got.headers.get('content-disposition'), 'attachment; filename="a b.txt"')
    assert.equal(await got.text(), 'abcd')
    assert.equal((await fetch(t.api.url + (await store.downloadTarget(KEY.replace('/1', '/9'), {})).url)).status, 404)
  } finally { t.close() }
})

test('Supabase store signs through the client and lists for exists', async () => {
  const calls = []
  const from = () => ({
    createSignedUploadUrl: async (k, o) => { calls.push(['up', k, o]); return { data: { signedUrl: 'https://s/up/' + k }, error: null } },
    createSignedUrl: async (k, secs, o) => { calls.push(['down', k, secs, o]); return { data: { signedUrl: 'https://s/down/' + k }, error: null } },
    list: async (prefix, o) => { calls.push(['list', prefix, o]); return { data: [{ name: '1', metadata: { size: 4 } }], error: null } },
    remove: async (keys) => { calls.push(['remove', keys]); return { data: keys.map((k) => ({ name: k })), error: null } }
  })
  const store = new SupabaseStore({ client: { storage: { from } }, bucket: 'workspace-files' })
  assert.deepEqual(await store.uploadTarget(KEY, 4), { method: 'PUT', url: 'https://s/up/' + KEY, headers: {} })
  assert.deepEqual(await store.downloadTarget(KEY, { name: 'a.txt', type: 'text/plain' }), { url: 'https://s/down/' + KEY })
  assert.deepEqual(await store.exists(KEY), { size: 4 })
  await store.remove([KEY])
  assert.deepEqual(calls.map((c) => c[0]), ['up', 'down', 'list', 'remove'])
  assert.deepEqual(calls[1].slice(1), [KEY, LINK_MS / 1000, { download: 'a.txt' }])
})

test('makeFileStore needs both or neither storage settings', () => {
  const dir = tmp()
  assert.ok(makeFileStore({}, dir) instanceof DiskStore)
  assert.throws(() => makeFileStore({ storageUrl: 'https://x' }, dir), /half set up/)
})
