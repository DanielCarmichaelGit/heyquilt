// A linked computer stays signed in: losing its token (or another app on it replacing it)
// signs it back in with its key, and the website doesn't ask to approve it again.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestApi, linkDevice } from '../helpers/api-helpers.js'
import { readAccount, saveAccount, clearAccountIf, resumeAccount, signOut, fetchMe, startLink } from '../../src/account.js'
import { personPasses } from '../../src/pass-source.js'
import { generateIdentity, signDeviceResume } from '../../src/identity.js'

let t
before(async () => { t = await startTestApi({ passKey: (await import('node:crypto')).generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url') }) })
after(() => t.close())
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-stay-')), 'account.json')

test('a linked computer signs back in with its key, and its old token stops working', async () => {
  const { identity, token } = await linkDevice(t, 'mem')
  const file = tmpFile()
  const back = await resumeAccount({ identity, api: t.api.url, file })
  assert.match(back.token, /^qd_/)
  assert.notEqual(back.token, token)
  assert.deepEqual(back.account, { id: 'mem', name: 'Mo', email: 'mo@acme.com' })
  assert.deepEqual(readAccount(file), back, 'saved')
  assert.equal((await fetchMe({ token: back.token, api: t.api.url })).id, 'mem')
  await assert.rejects(fetchMe({ token, api: t.api.url }), (err) => err.status === 401)
})

test('an unknown or unlinked computer gets null (the website has to approve it)', async () => {
  assert.equal(await resumeAccount({ identity: generateIdentity(), api: t.api.url, file: tmpFile() }), null)
  const { identity, token } = await linkDevice(t, 'lim')
  const file = tmpFile()
  saveAccount({ token, account: { id: 'lim', name: 'Lin', email: '' }, signedInAt: 1 }, file)
  await signOut({ token, api: t.api.url, file })
  assert.equal(await resumeAccount({ identity, api: t.api.url, file, asked: true }), null, 'unlinked on the server')
})

test('after Sign out the computer does not sign itself back in until someone asks', async () => {
  const { identity, token } = await linkDevice(t, 'out')
  const file = tmpFile()
  // Sign out while Quilt can't be told: the device stays linked on the server.
  saveAccount({ token, account: { id: 'out', name: 'Otto', email: '' }, signedInAt: 1 }, file)
  await signOut({ token, api: 'http://127.0.0.1:9', file })
  assert.equal(await resumeAccount({ identity, api: t.api.url, file }), null)
  const back = await resumeAccount({ identity, api: t.api.url, file, asked: true })
  assert.equal(back.account.id, 'out')
  assert.equal(await resumeAccount({ identity, api: t.api.url, file }) !== null, true, 'signing in again clears the mark')
})

test('the API refuses a bad signature, a replayed one and a far-off clock', async () => {
  const { identity } = await linkDevice(t, 'gm')
  const at = Date.now()
  const signature = signDeviceResume(identity, at)
  const other = generateIdentity()
  assert.equal((await t.call('POST', '/v1/device/resume', { publicKey: identity.publicKey, at, signature: signDeviceResume(other, at) })).status, 401)
  assert.equal((await t.call('POST', '/v1/device/resume', { publicKey: identity.publicKey, at, signature })).status, 200)
  assert.equal((await t.call('POST', '/v1/device/resume', { publicKey: identity.publicKey, at, signature })).status, 401, 'replayed')
  const old = at - 60 * 60 * 1000
  assert.equal((await t.call('POST', '/v1/device/resume', { publicKey: identity.publicKey, at: old, signature: signDeviceResume(identity, old) })).status, 400)
})

test('clearAccountIf keeps a newer sign-in saved by another app', () => {
  const file = tmpFile()
  saveAccount({ token: 'qd_new', account: { id: 'mem', name: 'Mo', email: '' }, signedInAt: 1 }, file)
  assert.equal(clearAccountIf('qd_old', file), false)
  assert.equal(readAccount(file).token, 'qd_new')
  assert.equal(clearAccountIf('qd_new', file), true)
  assert.equal(readAccount(file), null)
})

test("passes carry on when the token is replaced or lost, and stop only once the computer is unlinked", async () => {
  const { identity, token } = await linkDevice(t, 'mem')
  const file = tmpFile()
  saveAccount({ token, account: { id: 'mem', name: 'Mo', email: '' }, signedInAt: 1 }, file)
  const passes = personPasses({ token, api: t.api.url, file, resume: (o) => resumeAccount({ ...o, identity }) })
  assert.ok(await passes.fresh())
  // Another app on this computer signs back in: our token is gone, theirs is in account.json.
  await resumeAccount({ identity, api: t.api.url, file })
  assert.ok(await passes.fresh(), 'picked up the saved token')
  // The token is lost on the server side too (rotated by a resume whose save we never saw).
  const at = Date.now()
  assert.equal((await t.call('POST', '/v1/device/resume', { publicKey: identity.publicKey, at, signature: signDeviceResume(identity, at) })).status, 200)
  assert.ok(await passes.fresh(), 'signed back in with the key')
  // Unlinked on the website: now it's over.
  await signOut({ token: readAccount(file).token, api: t.api.url, file: tmpFile() })
  await assert.rejects(passes.fresh(), (err) => err.signedOut)
})

test('the website is told when this account linked the computer before', async () => {
  const { identity } = await linkDevice(t, 'mem')
  const link = await startLink({ identity, api: t.api.url })
  assert.equal((await t.call('GET', `/v1/device/link/${link.userCode}`, null, 'mem')).body.known, true)
  assert.equal((await t.call('GET', `/v1/device/link/${link.userCode}`, null, 'lim')).body.known, false, 'not for another account')
  const fresh = await startLink({ identity: generateIdentity(), api: t.api.url })
  assert.equal((await t.call('GET', `/v1/device/link/${fresh.userCode}`, null, 'mem')).body.known, false)
})
