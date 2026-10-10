// quilt login / whoami / logout, against a local accounts API.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startTestApi, SITE } from '../helpers/api-helpers.js'
import { NO_POSIX_MODES } from '../helpers/platform.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'quilt.js')
let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cli-account-'))
async function waitFor (fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 50)) }
  throw new Error('timed out')
}
/** Runs the CLI in the background: what it printed so far, and its exit code when done. */
function run (args, env) {
  const child = spawn(process.execPath, [BIN, ...args], { env })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  // 'close' (not 'exit'): fires once stdout/stderr have finished draining, so `out()` is final.
  return { out: () => out, done: new Promise((resolve) => child.on('close', resolve)) }
}
const quilt = (args, env) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
/** Like `quilt`, but doesn't block this process's event loop: needed for `logout`, which
 * calls back into this same process's test API. `spawnSync` would freeze that API's
 * server while waiting for the child, and the child's request would then never be served. */
async function quiltAsync (args, env) {
  const r = run(args, env)
  const status = await r.done
  return { stdout: r.out(), status }
}

test('quilt login links this computer, whoami shows the account, logout signs it out', async () => {
  const home = tmp()
  const env = { ...process.env, HOME: home, QUILT_API_URL: t.api.url }
  const login = run(['login', '--no-browser'], env)
  const code = await waitFor(() => (login.out().match(/code ([A-Z0-9]{4}-[A-Z0-9]{4})/) || [])[1])
  assert.ok(login.out().includes(`${SITE}/link?code=${code}`), login.out())
  await t.call('POST', '/v1/device/approve', { userCode: code, approve: true }, 'mem')
  assert.equal(await login.done, 0, login.out())
  assert.match(login.out(), /Signed in as Mo \(mo@acme\.com\)\./)

  const file = path.join(home, '.quilt', 'account.json')
  if (!NO_POSIX_MODES) assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.account, { id: 'mem', name: 'Mo', email: 'mo@acme.com' })
  assert.match(saved.token, /^qd_/)
  assert.equal(typeof saved.signedInAt, 'number')

  assert.equal(quilt(['whoami'], env).stdout.trim(), 'Mo (mo@acme.com)')
  assert.match(quilt(['login', '--no-browser'], env).stdout, /Already signed in as Mo/)
  assert.match((await quiltAsync(['logout'], env)).stdout, /Signed out of mo@acme\.com\./)
  assert.equal(fs.existsSync(file), false)
  assert.equal((await t.call('GET', '/v1/me', null, null, { authorization: `Bearer ${saved.token}` })).status, 401, 'the token was revoked')
  const who = quilt(['whoami'], env)
  assert.equal(who.status, 1)
  assert.equal(who.stdout.trim(), 'Not signed in')
})

test('a sign-in declined in the browser says so', async () => {
  const env = { ...process.env, HOME: tmp(), QUILT_API_URL: t.api.url }
  const login = run(['login', '--no-browser'], env)
  const code = await waitFor(() => (login.out().match(/code ([A-Z0-9]{4}-[A-Z0-9]{4})/) || [])[1])
  await t.call('POST', '/v1/device/approve', { userCode: code, approve: false }, 'mem')
  assert.equal(await login.done, 1)
  assert.match(login.out(), /Sign-in was declined in the browser\./)
})
