// The app makes a chat link for its owner, with sign-in on as in production, and a chat AI
// works in the session through it without a pass of its own.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-chat-'))
process.env.HOME = home

const { startUi } = await import('../../src/ui-server.js')
const { startServer } = await import('../../src/server.js')
const { startTestApi } = await import('../helpers/api-helpers.js')
const { newPassKeys } = await import('../../src/passes.js')

const SECRET = 'relay-secret-for-ui-tests'
let ui, accounts, relay
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey, relaySecret: SECRET })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey, apiUrl: accounts.api.url, relayApiSecret: SECRET })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const api = (method, p, body) => fetch(`http://127.0.0.1:${ui.port}${p}`, {
  method,
  headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
async function waitFor (fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error('timed out')
}

test('the owner makes a chat link in the app; the chat AI reads and talks through it, with no pass', async () => {
  const started = await api('POST', '/api/account/start')
  await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
  await waitFor(async () => (await api('GET', '/api/account')).body.signedIn)
  const dir = path.join(home, 'quilt-site')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), '# Site\n')
  const s = await api('POST', '/api/sessions', { mode: 'create', dir })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const { id } = s.body
  await waitFor(async () => (await api('GET', '/api/state')).body.sessions.find((x) => x.id === id)?.status.access?.owner)

  const made = await api('POST', `/api/sessions/${id}/chat-link`, {})
  assert.equal(made.status, 200, JSON.stringify(made.body))
  assert.equal(made.body.name, 'Chat AI')
  assert.match(made.body.url, /^http:\/\/127\.0\.0\.1:\d+\/c\/[^/]+\/[A-Za-z0-9_-]{32}$/)

  const page = await fetch(made.body.url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /You are Chat AI/)
  assert.equal((await (await fetch(`${made.body.url}/file?path=README.md`)).text()), '# Site\n')
  assert.match(await (await fetch(`${made.body.url}/say?text=hello%20from%20the%20chat&everyone=1`)).text(), /^Sent to everyone\./)
  const msgs = await waitFor(async () => {
    const r = await api('GET', `/api/sessions/${id}/messages`)
    return r.status === 200 && (r.body.messages || []).some((m) => m.by === 'Chat AI') && r.body.messages
  })
  assert.equal(msgs.find((m) => m.by === 'Chat AI').text, 'hello from the chat')
})
