// test/api-issues.test.js
// Who may report issues, what a report must look like, and that repeats count up.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi } from '../helpers/api-helpers.js'
import { generateIdentity } from '../../src/identity.js'
import { newToken, hashToken } from '../../src/api/tokens.js'

const REPORT_KEY = 'rk_test_secret'
let t
before(async () => { t = await startTestApi({ reportKey: REPORT_KEY, reportLimit: 3 }) })
after(() => t.close())

/** A linked computer for "mem", and its bearer token. */
async function linkComputer () {
  const id = generateIdentity()
  const d = await t.store.upsertDevice({ userId: 'mem', name: 'Mac', platform: 'darwin', publicKey: id.publicKey })
  const token = newToken('qd_')
  await t.store.setDeviceToken(d.id, hashToken(token))
  return { device: d, token }
}
const batch = (events, extra = {}) => ({ surface: 'app', appVersion: '0.3.2', platform: 'darwin', events, ...extra })
const post = (body, headers) => t.call('POST', '/v1/issues', body, null, headers)

test('a linked computer reports as its account; repeats of one problem make one issue', async () => {
  const { device, token } = await linkComputer()
  const auth = { authorization: `Bearer ${token}` }
  const r = await post(batch([
    { kind: 'action', name: 'open-in', outcome: 'ok', durationMs: 50, context: { app: 'cursor' } },
    { kind: 'action', name: 'open-in', outcome: 'error', durationMs: 20, message: 'Could not open it: spawn /Users/a/Cursor ENOENT', context: { app: 'cursor' } }
  ]), auth)
  assert.deepEqual([r.status, r.body], [200, { ok: true, recorded: 2 }])
  await post(batch([{ kind: 'action', name: 'open-in', outcome: 'error', message: 'Could not open it: spawn /Users/b/Cursor ENOENT', context: { app: 'cursor' } }]), auth)
  const events = t.store.listEvents().filter((e) => e.name === 'open-in')
  assert.equal(events.length, 3)
  for (const e of events) {
    assert.equal(e.userId, 'mem'); assert.equal(e.deviceId, device.id); assert.equal(e.surface, 'app')
    assert.equal(e.appVersion, '0.3.2'); assert.equal(e.platform, 'darwin')
  }
  const issues = t.store.listIssues().filter((i) => i.name === 'open-in')
  assert.equal(issues.length, 1); assert.equal(issues[0].count, 2)
})

test('a linked computer may only report for the app, and the body cannot pick a user', async () => {
  const { token } = await linkComputer()
  const auth = { authorization: `Bearer ${token}` }
  assert.equal((await post(batch([{ kind: 'error', name: 'x' }], { surface: 'web' }), auth)).status, 400)
  await post(batch([{ kind: 'error', name: 'claimed', outcome: 'error' }], { userId: 'owner' }), auth)
  assert.equal(t.store.listEvents().find((e) => e.name === 'claimed').userId, 'mem')
})

test('a revoked computer is turned away', async () => {
  const { device, token } = await linkComputer()
  await t.store.revokeDevice(device.id)
  assert.equal((await post(batch([{ kind: 'error', name: 'x' }]), { authorization: `Bearer ${token}` })).status, 401)
})

test('the website reports with the key, for the web surface, naming the signed-in person when it knows one', async () => {
  const key = { 'x-quilt-report-key': REPORT_KEY }
  const r = await post({ surface: 'web', appVersion: '', platform: 'safari', userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', events: [{ kind: 'http404', name: '/pricing/old', outcome: 'error', status: 404 }] }, key)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const e = t.store.listEvents().find((x) => x.name === '/pricing/old')
  assert.equal(e.surface, 'web'); assert.equal(e.userId, '3f2504e0-4f89-11d3-9a0c-0305e82c3301'); assert.equal(e.platform, 'safari')
  // A user id that isn't a uuid is dropped, not stored.
  await post({ surface: 'web', userId: 'not-a-uuid', events: [{ kind: 'error', name: '/x', outcome: 'error' }] }, key)
  assert.equal(t.store.listEvents().find((x) => x.name === '/x').userId, null)
  assert.equal((await post({ surface: 'app', events: [{ kind: 'error', name: '/y' }] }, key)).status, 400, 'the key is for the website only')
  assert.equal((await post({ surface: 'web', events: [{ kind: 'error', name: '/z' }] }, { 'x-quilt-report-key': 'wrong' })).status, 401)
})

test('without a token or key only app reports are taken, with no user, and only a few a minute', async () => {
  const r = await post(batch([{ kind: 'error', name: 'before-sign-in', outcome: 'error', message: 'Couldn\'t reach Quilt (ECONNREFUSED).' }]))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(t.store.listEvents().find((e) => e.name === 'before-sign-in').userId, null)
  assert.equal((await post(batch([{ kind: 'error', name: 'w' }], { surface: 'web' }))).status, 401)
  await post(batch([{ kind: 'error', name: 'two' }]))
  await post(batch([{ kind: 'error', name: 'three' }]))
  assert.equal((await post(batch([{ kind: 'error', name: 'four' }]))).status, 429)
})

test('a bad batch is a 400 and records nothing', async () => {
  const { token } = await linkComputer()
  const auth = { authorization: `Bearer ${token}` }
  const before = t.store.listEvents().length
  for (const body of [
    batch([]), batch('nope'), batch(Array.from({ length: 21 }, () => ({ kind: 'error', name: 'x' }))),
    batch([{ kind: 'nope', name: 'x' }]), batch([{ kind: 'error', name: 'x', outcome: 'meh' }]), batch([{ kind: 'error' }]),
    batch([{ kind: 'error', name: 'ok' }, 'junk'])
  ]) {
    const r = await post(body, auth)
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80))
  }
  assert.equal(t.store.listEvents().length, before)
})

test('a report key header the same JS-string length but a different byte length answers 401, not a 500', async () => {
  // REPORT_KEY is 14 characters; this header is also 14 characters (13 'a's and one 'é'),
  // but 'é' is two bytes in UTF-8, so the buffers differ in byte length.
  assert.equal(REPORT_KEY.length, 14)
  const key = 'a'.repeat(13) + 'é'
  assert.equal(key.length, 14)
  const r = await post({ surface: 'web', events: [{ kind: 'error', name: '/x' }] }, { 'x-quilt-report-key': key })
  assert.equal(r.status, 401)
})

test('with no report key configured, the website header is just a missing key', async () => {
  const bare = await startTestApi()
  try {
    const r = await bare.call('POST', '/v1/issues', { surface: 'web', events: [{ kind: 'error', name: '/x' }] }, null, { 'x-quilt-report-key': '' })
    assert.equal(r.status, 401)
  } finally { await bare.close() }
})

test('the API records an unknown route as a 404 event, grouped by its path shape', async () => {
  await t.call('GET', '/v1/nothing/3f2504e0-4f89-11d3-9a0c-0305e82c3301')
  await t.call('GET', '/v1/nothing/7c9e6679-7425-40de-944b-e07fc1f90ae7')
  await new Promise((r) => setTimeout(r, 20)) // recording is fire-and-forget
  const own = t.store.listEvents().filter((e) => e.surface === 'api' && e.kind === 'http404')
  assert.equal(own.length, 2)
  assert.equal(own[0].name, 'GET /v1/nothing/:id'); assert.equal(own[0].status, 404); assert.equal(own[0].outcome, 'error')
  assert.equal(t.store.listIssues().find((i) => i.name === 'GET /v1/nothing/:id').count, 2)
})

test('an unknown route outside /v1/ (a scanner) is collapsed to one name, not one issue per path', async () => {
  await t.call('GET', '/wp-login.php')
  await t.call('GET', '/.env')
  await new Promise((r) => setTimeout(r, 20))
  const own = t.store.listEvents().filter((e) => e.surface === 'api' && e.name === 'GET (no route)')
  assert.equal(own.length, 2)
  for (const e of own) { assert.equal(e.kind, 'http404'); assert.equal(e.outcome, 'error'); assert.equal(e.status, 404) }
  assert.equal(t.store.listIssues().find((i) => i.name === 'GET (no route)').count, 2)
})

test('a deliberate 404 (a route answering on purpose) is not recorded, unless it was slow', async () => {
  const before = t.store.listEvents().length
  const r = await t.call('POST', '/v1/device/poll', { deviceCode: 'dc_unknown' })
  assert.equal(r.status, 404)
  await new Promise((res) => setTimeout(res, 20))
  assert.equal(t.store.listEvents().length, before, 'a deliberate 404 is the route working as designed, not an issue')

  const slow = await startTestApi({ slowMs: -1 }) // everything is "slow"
  try {
    const r2 = await slow.call('POST', '/v1/device/poll', { deviceCode: 'dc_unknown' })
    assert.equal(r2.status, 404)
    await new Promise((res) => setTimeout(res, 20))
    const e = slow.store.listEvents().find((x) => x.surface === 'api' && x.name === 'POST /v1/device/poll')
    assert.equal(e.outcome, 'slow'); assert.equal(e.status, 404); assert.equal(e.kind, 'action')
  } finally { await slow.close() }
})

test('the API records a crash in a handler as a 500 event with the real message, and still answers "internal error"', async () => {
  const saved = t.store.linkByDeviceCode
  t.store.linkByDeviceCode = async () => { throw new Error('db down') }
  try {
    const r = await t.call('POST', '/v1/device/poll', { deviceCode: 'dc_x' })
    assert.deepEqual([r.status, r.body], [500, { error: 'internal error' }])
  } finally { t.store.linkByDeviceCode = saved }
  await new Promise((r) => setTimeout(r, 20))
  const e = t.store.listEvents().find((x) => x.surface === 'api' && x.name === 'POST /v1/device/poll')
  assert.equal(e.status, 500); assert.equal(e.outcome, 'error'); assert.equal(e.message, 'db down'); assert.equal(e.kind, 'action')
})

test('the API does not record the 4xx it answers on purpose', async () => {
  await t.call('GET', '/v1/me') // 401: no token
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(t.store.listEvents().filter((e) => e.surface === 'api' && e.name === 'GET /v1/me').length, 0)
})

test('a request over the slow threshold is recorded as slow, and a store that fails to record never fails the request', async () => {
  const slow = await startTestApi({ slowMs: -1 }) // everything is "slow"
  try {
    const r = await slow.call('GET', '/healthz')
    assert.equal(r.status, 200)
    await new Promise((res) => setTimeout(res, 20))
    const e = slow.store.listEvents().find((x) => x.name === 'GET /healthz')
    assert.equal(e.outcome, 'slow'); assert.equal(e.status, 200); assert.equal(typeof e.durationMs, 'number')
    slow.store.recordEvents = async () => { throw new Error('no db') }
    assert.equal((await slow.call('GET', '/healthz')).status, 200)
  } finally { await slow.close() }
})

test('old events and old issues are pruned on the API\'s timer, and once shortly after start', async () => {
  let events = 0; let issues = 0
  const api = await startTestApi({ pruneEveryMs: 1_000_000, pruneStartMs: 10 })
  // startTestApi builds its own store; swap the prune methods so the timer is observable.
  api.store.pruneEvents = async () => { events++; return 0 }
  api.store.pruneIssues = async () => { issues++; return 0 }
  try {
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(events >= 1, 'pruneEvents ran on the startup timer')
    assert.ok(issues >= 1, 'pruneIssues ran on the startup timer')
  } finally { await api.close() }
})

test('the hourly prune timer also runs both prune methods', async () => {
  let events = 0; let issues = 0
  const api = await startTestApi({ pruneEveryMs: 10, pruneStartMs: 1_000_000 })
  api.store.pruneEvents = async () => { events++; return 0 }
  api.store.pruneIssues = async () => { issues++; return 0 }
  try {
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(events >= 1, 'pruneEvents ran on the hourly timer')
    assert.ok(issues >= 1, 'pruneIssues ran on the hourly timer')
  } finally { await api.close() }
})

test('a slow 4xx the route throws on purpose is still recorded, but as slow, not an error', async () => {
  const slow = await startTestApi({ slowMs: -1 }) // everything is "slow"
  try {
    const r = await slow.call('GET', '/v1/me') // a deliberate 401: no token
    assert.equal(r.status, 401)
    await new Promise((res) => setTimeout(res, 20))
    const e = slow.store.listEvents().find((x) => x.surface === 'api' && x.name === 'GET /v1/me')
    assert.equal(e.outcome, 'slow'); assert.equal(e.status, 401); assert.equal(e.kind, 'action')
  } finally { await slow.close() }
})

test('a store that throws synchronously while recording never breaks the reply', async () => {
  const saved = t.store.recordEvents
  t.store.recordEvents = () => { throw new Error('sync no db') }
  try {
    const r = await t.call('GET', '/v1/nothing')
    assert.equal(r.status, 404)
  } finally { t.store.recordEvents = saved }
})
