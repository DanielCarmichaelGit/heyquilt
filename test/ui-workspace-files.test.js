// The app's local file routes: upload through the local server to the API's store, list, stream back, rename, delete.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-wsfiles-'))
process.env.HOME = process.env.USERPROFILE = home
const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { startTestApi, linkDevice } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')
const { loadIdentity } = await import('../src/identity.js')
const { saveAccount } = await import('../src/account.js')

let ui, accounts, relay
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey, workspaces: true })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  const { token } = await linkDevice(accounts, 'mem', loadIdentity())
  saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() })
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const base = () => `http://127.0.0.1:${ui.port}`
const api = (method, p, body) => fetch(base() + p, { method, headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }))

test('upload, list, stream, rename, delete through the app', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Lib' })).body.workspace.id
  const up = await fetch(`${base()}/api/workspaces/${id}/upload`, { method: 'PUT', headers: { 'x-quilt-token': ui.token, 'x-path': encodeURIComponent('notes/hello.txt'), 'x-note': encodeURIComponent('first'), 'content-type': 'text/plain' }, body: 'hello there' })
  const made = await up.json()
  assert.equal(up.status, 200, JSON.stringify(made))
  assert.deepEqual([made.file.path, made.file.size, made.file.version, made.file.note], ['notes/hello.txt', 11, 1, 'first'])
  const list = await api('GET', `/api/workspaces/${id}/files`)
  assert.deepEqual(list.body.files.map((f) => [f.path, f.kind]), [['notes', 'folder'], ['notes/hello.txt', 'file']])
  const data = await fetch(`${base()}/api/workspaces/${id}/files/${made.file.id}/data`, { headers: { 'x-quilt-token': ui.token } })
  assert.equal(data.status, 200)
  assert.equal(data.headers.get('content-type'), 'text/plain')
  assert.match(data.headers.get('content-disposition'), /inline; filename="hello.txt"/)
  assert.equal(await data.text(), 'hello there')
  const got = await api('GET', `/api/workspaces/${id}`)
  assert.equal(got.body.files.length, 2)
  assert.equal(got.body.usage.usedBytes, 11)
  assert.equal((await api('POST', `/api/workspaces/${id}/files/${made.file.id}/update`, { path: 'notes/hi.txt' })).body.file.name, 'hi.txt')
  assert.equal((await api('POST', `/api/workspaces/${id}/folders`, { path: 'raw' })).body.file.kind, 'folder')
  assert.equal((await api('POST', `/api/workspaces/${id}/files/${made.file.id}/delete`)).status, 200)
  assert.deepEqual((await api('GET', `/api/workspaces/${id}/files`)).body.files.map((f) => f.path), ['notes', 'raw'])
})

test('file bytes are never sniffed, and run sandboxed unless they are a PDF', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Guarded' })).body.workspace.id
  const put = async (p, type, body) => (await (await fetch(`${base()}/api/workspaces/${id}/upload`, { method: 'PUT', headers: { 'x-quilt-token': ui.token, 'x-path': encodeURIComponent(p), 'content-type': type }, body })).json()).file
  const txt = await put('a.txt', 'text/plain', '<script>alert(1)</script>')
  const pdf = await put('b.pdf', 'application/pdf', '%PDF-1.4 nothing much')
  const head = async (f) => (await fetch(`${base()}/api/workspaces/${id}/files/${f.id}/data?t=${ui.token}`)).headers
  const t = await head(txt)
  assert.equal(t.get('x-content-type-options'), 'nosniff')
  assert.equal(t.get('content-security-policy'), 'sandbox')
  const p = await head(pdf)
  assert.equal(p.get('content-type'), 'application/pdf')
  assert.equal(p.get('x-content-type-options'), 'nosniff')
  assert.equal(p.get('content-security-policy'), null, 'Chromium will not render a sandboxed PDF')
})

test('an upload over 500 MB is refused from its content-length, before the bytes', { timeout: 10000 }, async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Big' })).body.workspace.id
  const http = await import('node:http')
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ui.port, method: 'PUT', path: `/api/workspaces/${id}/upload`, headers: { 'x-quilt-token': ui.token, 'x-path': 'big.bin', 'content-length': String(600 * 1024 * 1024) } }, resolve)
    req.on('error', reject)
    req.flushHeaders()
  })
  let raw = ''
  for await (const c of res) raw += c
  res.socket?.destroy()
  assert.equal(res.statusCode, 413)
  assert.match(JSON.parse(raw).error, /500 MB at most/)
})

test('an upload the API refuses is reported with its message', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Lib2' })).body.workspace.id
  const bad = await fetch(`${base()}/api/workspaces/${id}/upload`, { method: 'PUT', headers: { 'x-quilt-token': ui.token, 'x-path': encodeURIComponent('../evil') }, body: 'x' })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /path/i)
})

test('attach from workspace sends the file into the session chat', async () => {
  const id = (await api('POST', '/api/workspaces', { name: 'Chat' })).body.workspace.id
  const up = await fetch(`${base()}/api/workspaces/${id}/upload`, { method: 'PUT', headers: { 'x-quilt-token': ui.token, 'x-path': encodeURIComponent('brief.txt'), 'content-type': 'text/plain' }, body: 'the brief' })
  const { file } = await up.json()
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'chatproj'), workspace: id })
  assert.equal(s.status, 200)
  const sent = await api('POST', `/api/sessions/${s.body.id}/attach-from-workspace`, { fileId: file.id, text: 'from the library' })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  const msgs = (await api('GET', `/api/sessions/${s.body.id}/messages`)).body.messages
  const m = msgs.find((x) => x.file && x.file.name === 'brief.txt')
  assert.ok(m, 'the attachment is in the chat')
  assert.equal(m.text, 'from the library')
  await api('POST', `/api/sessions/${s.body.id}/stop`)
})
