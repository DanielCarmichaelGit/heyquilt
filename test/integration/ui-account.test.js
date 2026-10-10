// The app's sign-in: until this computer is linked to an account the app only
// offers to sign in. Signing out, or being signed out from the website, brings
// that back.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { NO_POSIX_MODES } from '../helpers/platform.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-account-'))
process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = home

const { startUi } = await import('../../src/ui-server.js')
const { startServer } = await import('../../src/server.js')
const { startTestApi, SITE } = await import('../helpers/api-helpers.js')
const { newPassKeys } = await import('../../src/passes.js')

const accountFile = path.join(home, '.quilt', 'account.json')
const SIGNED_OUT = { signedIn: false, account: null, reason: null, link: null }
let ui, accounts, relay
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const call = (app, method, p, body) => fetch(`http://127.0.0.1:${app.port}${p}`, {
  method,
  headers: { 'x-quilt-token': app.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
const api = (method, p, body) => call(ui, method, p, body)
async function waitFor (fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error('timed out')
}
const tokenOnDisk = () => JSON.parse(fs.readFileSync(accountFile, 'utf8')).token
const revoke = (token) => accounts.call('POST', '/v1/me/signout', {}, null, { authorization: `Bearer ${token}` })

/** Signs this computer in through the app, approving it on the "website" as Mo. */
async function signIn () {
  const started = await api('POST', '/api/account/start')
  assert.equal(started.status, 200, JSON.stringify(started.body))
  await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
  return waitFor(async () => { const r = await api('GET', '/api/account'); return r.body.signedIn && r.body })
}

test('signed out, the app only offers to sign in', async () => {
  assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT)
  for (const [method, p, body] of [['GET', '/api/state'], ['GET', '/api/settings'], ['POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'x') }]]) {
    const r = await api(method, p, body)
    assert.equal(r.status, 401, p)
    assert.deepEqual(r.body, { error: 'Sign in to Quilt first.', signedOut: true }, p)
  }
  assert.match(await (await fetch(`http://127.0.0.1:${ui.port}/app.js`)).text(), /renderSignIn/)
  const screen = await (await fetch(`http://127.0.0.1:${ui.port}/signin.js`)).text()
  for (const copy of ['Sign in to Quilt', 'New to Quilt? <a', 'Create an account', 'https://heyquilt.com/signup', 'Approve this computer in your browser', 'Cancel', 'Open the page again', 'That sign-in was stopped. Start over to get a new code.']) {
    assert.ok(screen.includes(copy), copy)
  }
})

test('starting to sign in shows a code to approve, and cancelling forgets it', async () => {
  const started = await api('POST', '/api/account/start')
  assert.equal(started.body.link.state, 'waiting')
  assert.match(started.body.link.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal(started.body.link.verificationUrl, `${SITE}/link?code=${started.body.link.userCode}`)
  assert.equal((await api('POST', '/api/account/cancel')).body.link, null)
  assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT)
})

test('approving on the website signs the app in; your name is your account name', async () => {
  const acc = await signIn()
  assert.deepEqual(acc.account, { id: 'mem', name: 'Mo', email: 'mo@acme.com' })
  if (!NO_POSIX_MODES) assert.equal(fs.statSync(accountFile).mode & 0o777, 0o600)
  assert.equal((await api('GET', '/api/settings')).body.name, 'Mo')
  const renamed = await api('POST', '/api/settings', { name: 'Someone else' })
  assert.equal(renamed.status, 400)
  assert.equal(renamed.body.error, 'Change your name on heyquilt.com.')
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'proj') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.status.me.name, 'Mo')
  await api('POST', `/api/sessions/${s.body.id}/stop`)
})

test('signing out revokes this computer, stops its sessions and deletes account.json', async () => {
  const token = tokenOnDisk()
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'proj2') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.deepEqual((await api('POST', '/api/account/signout')).body, { ok: true })
  assert.equal(fs.existsSync(accountFile), false)
  assert.equal((await accounts.call('GET', '/v1/me', null, null, { authorization: `Bearer ${token}` })).status, 401, 'revoked on the server')
  assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT)
  await waitFor(() => [...relay.rooms.values()].every((r) => r.conns.size === 0))
})

test('a computer signed out from the website goes back to sign-in, saying so', async () => {
  await signIn()
  await revoke(tokenOnDisk())
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'proj3') })
  assert.equal(s.status, 401)
  assert.equal(s.body.signedOut, true)
  assert.equal(fs.existsSync(accountFile), false)
  assert.deepEqual((await api('GET', '/api/account')).body, { ...SIGNED_OUT, reason: 'revoked' })
})

test('opening the app notices a sign-out that happened while it was closed', async () => {
  await signIn()
  await revoke(tokenOnDisk())
  const again = await startUi({ port: 0 })
  try {
    const r = await call(again, 'GET', '/api/account')
    assert.deepEqual(r.body, { ...SIGNED_OUT, reason: 'revoked' })
    assert.equal(fs.existsSync(accountFile), false)
  } finally {
    await again.close()
  }
})

/** A relay address whose connections wait until release(): holds a session start mid-way. */
async function gatedRelay (port) {
  let release
  const released = new Promise((resolve) => { release = resolve })
  let arrived
  const connected = new Promise((resolve) => { arrived = resolve })
  const sockets = new Set()
  const server = net.createServer((client) => {
    sockets.add(client)
    client.pause()
    arrived()
    released.then(() => {
      const up = net.connect(port, '127.0.0.1')
      sockets.add(up)
      up.on('error', () => client.destroy())
      client.on('error', () => up.destroy())
      client.pipe(up).pipe(client)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    connected,
    release,
    close: () => { for (const s of sockets) s.destroy(); return new Promise((resolve) => server.close(resolve)) }
  }
}

/** The accounts API behind a proxy that can hold the next device poll, and reports tokens it hands out. */
async function gatedApi (target) {
  let hold = null
  let gotToken
  const token = new Promise((resolve) => { gotToken = resolve })
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const poll = req.url === '/v1/device/poll'
    if (poll && hold) { const h = hold; hold = null; h.arrive(); await h.released }
    const headers = {}
    for (const h of ['content-type', 'authorization']) if (req.headers[h]) headers[h] = req.headers[h]
    const r = await fetch(target + req.url, { method: req.method, headers, body: body || undefined })
    const text = await r.text()
    if (poll) { try { const j = JSON.parse(text); if (j.token) gotToken(j.token) } catch {} }
    res.writeHead(r.status, { 'content-type': 'application/json' })
    res.end(text)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    holdNextPoll () {
      let arrive, release
      const arrived = new Promise((resolve) => { arrive = resolve })
      const released = new Promise((resolve) => { release = resolve })
      hold = { arrive, released }
      return { arrived, release }
    },
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

test('a session still starting when you sign out does not survive it, or sign out the next account', async () => {
  await signIn()
  const gate = await gatedRelay(relay.port)
  process.env.QUILT_SERVER = gate.url
  try {
    const starting = api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'slow') })
    await gate.connected
    assert.deepEqual((await api('POST', '/api/account/signout')).body, { ok: true })
    gate.release()
    const s = await starting
    assert.equal(s.status, 401, JSON.stringify(s.body))
    assert.equal(s.body.signedOut, true)
    assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT, 'a sign-out you asked for, not a revocation')
    // Checked before the gate closes, which would drop its connections by itself.
    await waitFor(() => [...relay.rooms.values()].every((r) => r.conns.size === 0))
  } finally {
    process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
    await gate.close()
  }
  await signIn()
  assert.deepEqual((await api('GET', '/api/state')).body.sessions, [], 'no run left over from before')
  assert.equal((await api('GET', '/api/account')).body.signedIn, true)
})

test('signing in twice is refused, and an approval that lands after cancelling is revoked', async () => {
  const again = await api('POST', '/api/account/start')
  assert.equal(again.status, 409)
  assert.equal(again.body.error, 'Already signed in.')
  await api('POST', '/api/account/signout')

  const proxy = await gatedApi(accounts.api.url)
  process.env.QUILT_API_URL = proxy.url
  try {
    const hold = proxy.holdNextPoll()
    const started = await api('POST', '/api/account/start')
    assert.equal(started.status, 200, JSON.stringify(started.body))
    await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
    await hold.arrived
    await api('POST', '/api/account/cancel')
    hold.release()
    const token = await proxy.token
    await waitFor(async () => (await accounts.call('GET', '/v1/me', null, null, { authorization: `Bearer ${token}` })).status === 401)
    assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT)
    assert.equal(fs.existsSync(accountFile), false)
  } finally {
    process.env.QUILT_API_URL = accounts.api.url
    await proxy.close()
  }
})

test("a sign-in this computer can't save fails clearly, and its token is revoked", async () => {
  assert.equal((await api('GET', '/api/account')).body.signedIn, false)
  // A folder where account.json goes: saving the sign-in fails.
  fs.mkdirSync(path.join(accountFile, 'blocked'), { recursive: true })
  const proxy = await gatedApi(accounts.api.url)
  process.env.QUILT_API_URL = proxy.url
  try {
    const started = await api('POST', '/api/account/start')
    assert.equal(started.status, 200, JSON.stringify(started.body))
    await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
    const failed = await waitFor(async () => { const r = await api('GET', '/api/account'); return r.body.link && r.body.link.state === 'failed' && r.body })
    assert.equal(failed.signedIn, false)
    assert.equal(failed.link.error, "Quilt couldn't save your sign-in on this computer.")
    const token = await proxy.token
    await waitFor(async () => (await accounts.call('GET', '/v1/me', null, null, { authorization: `Bearer ${token}` })).status === 401)
  } finally {
    process.env.QUILT_API_URL = accounts.api.url
    fs.rmSync(accountFile, { recursive: true, force: true })
    await api('POST', '/api/account/cancel')
    await proxy.close()
  }
})

test('a session started while signing out stops the others does not survive it', async () => {
  await signIn()
  // Several running sessions make the sign-out's stop window wide enough for a start to land in it.
  for (const n of [1, 2, 3]) {
    const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, `busy-${n}`) })
    assert.equal(s.status, 200, JSON.stringify(s.body))
  }
  const signingOut = api('POST', '/api/account/signout')
  const late = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'late') })
  assert.deepEqual((await signingOut).body, { ok: true })
  // Refused, or (if it got in before the sign-out began) stopped along with the rest.
  if (late.status !== 200) assert.equal(late.body.signedOut, true, JSON.stringify(late.body))
  await waitFor(() => [...relay.rooms.values()].every((r) => r.conns.size === 0))
  await signIn()
  assert.deepEqual((await api('GET', '/api/state')).body.sessions, [], 'nothing kept running on the old sign-in')
  await api('POST', '/api/account/signout')
})
