// This computer's sign-in: account.json, and linking through the website.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startTestApi } from '../helpers/api-helpers.js'
import { readAccount, saveAccount, clearAccount, startLink, pollLink, waitForLink, fetchMe, signOut, accountFromProfile } from '../../src/account.js'
import { generateIdentity } from '../../src/identity.js'
import { NO_POSIX_MODES, NO_SYMLINKS } from '../helpers/platform.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-account-'))
const sample = { token: 'qd_test', account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: 1 }

test('account.json is written privately and atomically, and never through a symlink', { skip: NO_SYMLINKS }, () => {
  const dir = tmp()
  const file = path.join(dir, 'account.json')
  saveAccount(sample, file)
  if (!NO_POSIX_MODES) assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(readAccount(file), sample)
  assert.deepEqual(fs.readdirSync(dir), ['account.json'], 'no temp files left behind')

  const target = path.join(dir, 'elsewhere.json')
  fs.writeFileSync(target, '{}')
  const link = path.join(dir, 'linked.json')
  fs.symlinkSync(target, link)
  assert.throws(() => saveAccount(sample, link), /symlink/)
  assert.equal(fs.readFileSync(target, 'utf8'), '{}', 'the target was not written')
  fs.writeFileSync(target, JSON.stringify(sample))
  assert.equal(readAccount(link), null, 'a symlinked account.json is not trusted')

  clearAccount(file)
  assert.equal(readAccount(file), null)
  fs.writeFileSync(file, 'not json')
  assert.equal(readAccount(file), null)
})

test('saveAccount tightens permissions even when account.json already existed, loosely', { skip: NO_POSIX_MODES }, () => {
  const dir = tmp()
  const file = path.join(dir, 'account.json')
  fs.writeFileSync(file, '{}', { mode: 0o644 })
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'the test set up a loose file')
  saveAccount(sample, file)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(readAccount(file), sample)
})

test('linking this computer: start, approve on the website, collect the token and profile, sign out', async () => {
  const identity = generateIdentity()
  const link = await startLink({ identity, api: t.api.url })
  assert.match(link.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal((await pollLink({ identity, deviceCode: link.deviceCode, api: t.api.url })).status, 'pending')
  await t.call('POST', '/v1/device/approve', { userCode: link.userCode, approve: true }, 'mem')
  const r = await waitForLink({ identity, link: { ...link, interval: 0 }, api: t.api.url })
  assert.match(r.token, /^qd_/)
  assert.deepEqual(accountFromProfile(r.profile), { id: 'mem', name: 'Mo', email: 'mo@acme.com' })
  assert.equal((await fetchMe({ token: r.token, api: t.api.url })).email, 'mo@acme.com')

  const file = path.join(tmp(), 'account.json')
  saveAccount({ token: r.token, account: accountFromProfile(r.profile), signedInAt: Date.now() }, file)
  await signOut({ token: r.token, api: t.api.url, file })
  assert.equal(fs.existsSync(file), false)
  await assert.rejects(fetchMe({ token: r.token, api: t.api.url }), (err) => err.status === 401)
})

test('a transient 503 or 429 while waiting is retried, not treated as a failure', async () => {
  const identity = generateIdentity()
  const link = await startLink({ identity, api: t.api.url })
  await t.call('POST', '/v1/device/approve', { userCode: link.userCode, approve: true }, 'mem')
  let calls = 0
  // The first poll looks like the server is overloaded or rate-limiting; the rest go to the real API.
  const fetchImpl = async (url, opts) => {
    calls++
    if (calls === 1) return new Response(JSON.stringify({ error: 'busy' }), { status: 503 })
    return fetch(url, opts)
  }
  const r = await waitForLink({ identity, link: { ...link, interval: 0 }, api: t.api.url, fetch: fetchImpl })
  assert.match(r.token, /^qd_/)
  assert.ok(calls >= 2, 'the 503 should not have ended the wait')
})

test('a declined or expired link ends the wait clearly', async () => {
  const identity = generateIdentity()
  const declined = await startLink({ identity, api: t.api.url })
  await t.call('POST', '/v1/device/approve', { userCode: declined.userCode, approve: false }, 'mem')
  await assert.rejects(waitForLink({ identity, link: { ...declined, interval: 0 }, api: t.api.url }), (err) => err.denied === true)
  const expired = await startLink({ identity, api: t.api.url })
  let clock = Date.now()
  await assert.rejects(waitForLink({ identity, link: { ...expired, interval: 0 }, api: t.api.url, now: () => (clock += 60_000) }), (err) => err.expired === true)
  let stop = false
  const cancelled = waitForLink({ identity, link: { ...expired, interval: 0 }, api: t.api.url, stopped: () => stop })
  stop = true
  await assert.rejects(cancelled, (err) => err.cancelled === true)
})

test('signing out forgets the token even when Quilt cannot be reached', async () => {
  const file = path.join(tmp(), 'account.json')
  saveAccount(sample, file)
  await signOut({ token: sample.token, api: 'http://127.0.0.1:9', file })
  assert.equal(fs.existsSync(file), false)
})

test('signing out deletes account.json right away and does not wait long for a server that never answers', async () => {
  const file = path.join(tmp(), 'account.json')
  saveAccount(sample, file)
  // A promise gate: resolves once the request has arrived, so the test can tell the
  // file was already gone by then, without racing on timing.
  let requestArrived
  const arrived = new Promise((resolve) => { requestArrived = resolve })
  const stuck = http.createServer((req) => { requestArrived(!fs.existsSync(file)) /* never responds */ })
  await new Promise((resolve) => stuck.listen(0, '127.0.0.1', resolve))
  const port = stuck.address().port
  const start = Date.now()
  // A short, injected timeout: the real 5s default would also work, but there's no
  // reason to make this test (or a real signOut) wait that long to prove the point.
  await signOut({ token: sample.token, api: `http://127.0.0.1:${port}`, file, revokeTimeoutMs: 50 })
  const fileWasGoneAlready = await arrived
  assert.equal(fileWasGoneAlready, true, 'account.json was deleted before the revoke request was even sent')
  assert.ok(Date.now() - start < 6000, `signOut took ${Date.now() - start}ms, should not wait for a stuck server`)
  assert.equal(fs.existsSync(file), false)
  await new Promise((resolve) => stuck.close(resolve))
})

test('an unexpected reply from Quilt is reported clearly, not as a crash', async () => {
  const fetchImpl = async () => new Response('not json', { status: 200 })
  await assert.rejects(fetchMe({ token: 'qd_x', api: 'http://example.invalid', fetch: fetchImpl }), /unexpected reply/)
  assert.throws(() => accountFromProfile(null), /unexpected reply/)
  assert.throws(() => accountFromProfile(undefined), /unexpected reply/)
})
