import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMessage, fingerprint, cleanContext, cleanEvent, routeName } from '../../src/api/issues.js'

test('normalizeMessage replaces ids, numbers, quoted strings and paths so repeats match', () => {
  const a = normalizeMessage("Could not open '/Users/dana/code/app' for 3f2504e0-4f89-11d3-9a0c-0305e82c3301 (took 1234 ms)")
  const b = normalizeMessage("Could not open '/home/mo/other' for 7c9e6679-7425-40de-944b-e07fc1f90ae7 (took 9 ms)")
  assert.equal(a, b)
  assert.equal(normalizeMessage('ENOENT: no such file, open /tmp/x/y.txt'), 'enoent: no such file, open <path>')
  assert.equal(normalizeMessage('Hash deadbeefcafe1234 again'), 'hash <hex> again')
  assert.equal(normalizeMessage('  spaced   out  '), 'spaced out')
  assert.equal(normalizeMessage('x'.repeat(300)).length, 200)
})

test('fingerprint is stable for the same problem and differs by surface, kind and name', () => {
  const base = { surface: 'app', kind: 'action', name: 'open-in', message: 'Could not open it: spawn /a/b ENOENT' }
  assert.equal(fingerprint(base), fingerprint({ ...base, message: 'Could not open it: spawn /c/d ENOENT' }))
  assert.match(fingerprint(base), /^[0-9a-f]{64}$/)
  assert.notEqual(fingerprint(base), fingerprint({ ...base, surface: 'web' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, kind: 'error' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, name: 'start' }))
})

test('cleanContext keeps at most 16 flat scalar fields, cut to 200 characters, under 2 KB', () => {
  assert.deepEqual(cleanContext(null), {})
  assert.deepEqual(cleanContext('nope'), {})
  assert.deepEqual(cleanContext({ app: 'cursor', n: 2, ok: true, nested: { a: 1 }, list: [1], fn: () => {} }), { app: 'cursor', n: 2, ok: true })
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))
  assert.equal(Object.keys(cleanContext(many)).length, 16)
  assert.equal(cleanContext({ s: 'x'.repeat(500) }).s.length, 200)
  const big = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`key${i}`, 'y'.repeat(200)]))
  assert.ok(JSON.stringify(cleanContext(big)).length <= 2048)
})

test('cleanEvent fills defaults, cuts fields, and fingerprints anything that is not ok', () => {
  const now = () => Date.parse('2026-10-01T12:00:00Z')
  const e = cleanEvent({ kind: 'action', name: 'open-in', outcome: 'error', status: 500, durationMs: 12.7, message: 'boom', context: { app: 'cursor' } },
    { surface: 'app', appVersion: '0.3.2', platform: 'darwin', userId: 'u1', deviceId: 'd1', now })
  assert.equal(e.surface, 'app'); assert.equal(e.kind, 'action'); assert.equal(e.outcome, 'error')
  assert.equal(e.status, 500); assert.equal(e.durationMs, 13); assert.equal(e.message, 'boom')
  assert.deepEqual(e.context, { app: 'cursor' }); assert.equal(e.userId, 'u1'); assert.equal(e.deviceId, 'd1')
  assert.equal(e.occurredAt, now())
  assert.equal(e.fingerprint, fingerprint({ surface: 'app', kind: 'action', name: 'open-in', message: 'boom' }))
  const ok = cleanEvent({ kind: 'action', name: 'x' }, { surface: 'app', now })
  assert.equal(ok.outcome, 'ok'); assert.equal(ok.fingerprint, null); assert.equal(ok.status, null)
  assert.equal(ok.durationMs, null); assert.equal(ok.message, ''); assert.deepEqual(ok.context, {})
  assert.equal(ok.userId, null); assert.equal(ok.deviceId, null); assert.equal(ok.appVersion, ''); assert.equal(ok.platform, '')
  assert.equal(cleanEvent({ kind: 'action', name: 'n'.repeat(100), message: 'm'.repeat(600) }, { surface: 'app', now }).name.length, 80)
  assert.equal(cleanEvent({ kind: 'action', name: 'x', message: 'm'.repeat(600) }, { surface: 'app', now }).message.length, 500)
  // An invisible character in a name is stripped, like every other name the API takes.
  assert.equal(cleanEvent({ kind: 'action', name: 'op​en' }, { surface: 'app', now }).name, 'open')
})

test('cleanEvent clamps occurredAt to within a day of now and rejects unknown values', () => {
  const t = Date.parse('2026-10-01T12:00:00Z'); const now = () => t
  const day = 24 * 60 * 60 * 1000
  assert.equal(cleanEvent({ kind: 'action', name: 'x', occurredAt: t - 3 * day }, { surface: 'app', now }).occurredAt, t - day)
  assert.equal(cleanEvent({ kind: 'action', name: 'x', occurredAt: t + 3 * day }, { surface: 'app', now }).occurredAt, t + day)
  assert.equal(cleanEvent({ kind: 'action', name: 'x', occurredAt: 'yesterday' }, { surface: 'app', now }).occurredAt, t)
  for (const bad of [{ kind: 'nope', name: 'x' }, { kind: 'action', name: 'x', outcome: 'meh' }, { kind: 'action', name: '' }, { kind: 'action' }, null, 'str']) {
    assert.throws(() => cleanEvent(bad, { surface: 'app', now }), (err) => err.status === 400, JSON.stringify(bad))
  }
  assert.throws(() => cleanEvent({ kind: 'action', name: 'x' }, { surface: 'moon', now }), (err) => err.status === 400)
})

test('routeName replaces ids and tokens in a path so requests group', () => {
  assert.equal(routeName('GET', '/v1/orgs/3f2504e0-4f89-11d3-9a0c-0305e82c3301/members'), 'GET /v1/orgs/:id/members')
  assert.equal(routeName('GET', '/v1/join/' + 'a'.repeat(32)), 'GET /v1/join/:token')
  assert.equal(routeName('GET', '/v1/device/link/ABCD-1234'), 'GET /v1/device/link/:code')
  assert.equal(routeName('GET', '/healthz'), 'GET /healthz')
  assert.equal(routeName('GET', '/v1/' + 'x'.repeat(200)).length, 80)
})

test('routeName replaces an org slug too, so requests for different orgs group as one', () => {
  assert.equal(routeName('GET', '/v1/orgs/acme/members'), 'GET /v1/orgs/:slug/members')
  assert.equal(routeName('GET', '/v1/orgs/zeta/members'), 'GET /v1/orgs/:slug/members')
})

test('intOrNull clamps out-of-range and negative numbers to null, so a bad report is a 400, never a Postgres overflow', () => {
  const now = () => Date.parse('2026-10-01T12:00:00Z')
  assert.equal(cleanEvent({ kind: 'action', name: 'x', status: 1e12 }, { surface: 'app', now }).status, null)
  assert.equal(cleanEvent({ kind: 'action', name: 'x', durationMs: -5 }, { surface: 'app', now }).durationMs, null)
  assert.equal(cleanEvent({ kind: 'action', name: 'x', status: 404 }, { surface: 'app', now }).status, 404)
  assert.equal(cleanEvent({ kind: 'action', name: 'x', status: 2_147_483_647 }, { surface: 'app', now }).status, 2_147_483_647)
  assert.equal(cleanEvent({ kind: 'action', name: 'x', status: 2_147_483_648 }, { surface: 'app', now }).status, null)
})
