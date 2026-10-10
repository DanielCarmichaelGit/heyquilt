// test/api.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startApi } from '../../src/api/server.js'
import { createMemoryStore } from '../../src/api/memory-store.js'
import { generateIdentity, signDeviceLink } from '../../src/identity.js'

let api, store
const SITE = 'https://quilt.test'
// Website users are recognised by their JWT; here a bearer "user:<id>" stands in for one.
const verifyUser = async (t) => (t && t.startsWith('user:') ? { userId: t.slice(5), email: `${t.slice(5)}@x.test` } : null)
const call = async (method, path, body, token) => {
  const res = await fetch(api.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), origin: SITE },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }
}
// The app proves it holds the computer's key by signing the device code.
const sign = (identity, deviceCode) => signDeviceLink(identity, deviceCode)
const poll = (identity, deviceCode, via = call) => via('POST', '/v1/device/poll', { deviceCode, signature: sign(identity, deviceCode) })

before(async () => {
  store = createMemoryStore()
  store.addUser('u1', { name: 'Dana' }); store.addUser('u2', { name: 'Eli' })
  // Many tests start links from one address; the limiter has its own tests below.
  api = await startApi({ store, verifyUser, siteUrl: SITE, startLimit: 1000 })
})
after(() => api.close())

test('health', async () => {
  assert.equal((await call('GET', '/healthz')).body.ok, true)
})

test('linking a computer: start, see it on the website, approve, then the app gets its token once', async () => {
  const id = generateIdentity()
  const start = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: "Dana's MacBook", platform: 'darwin' })
  assert.equal(start.status, 200)
  assert.match(start.body.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal(start.body.verificationUrl, `${SITE}/link?code=${start.body.userCode}`)
  assert.equal(start.body.interval, 3)
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: start.body.deviceCode })).status, 202, 'pending polls need no signature')

  assert.equal((await call('GET', `/v1/device/link/${start.body.userCode}`)).status, 401, 'needs sign-in')
  const seen = await call('GET', `/v1/device/link/${start.body.userCode.replace('-', '').toLowerCase()}`, null, 'user:u1')
  assert.equal(seen.body.deviceName, "Dana's MacBook")

  assert.equal((await call('POST', '/v1/device/approve', { userCode: start.body.userCode, approve: true }, 'user:u1')).status, 200)
  const done = await poll(id, start.body.deviceCode)
  assert.equal(done.status, 200)
  assert.match(done.body.token, /^qd_/)
  assert.equal(done.body.profile.name, 'Dana')
  assert.equal((await poll(id, start.body.deviceCode)).status, 410, 'the token is handed out once')
})

test('two polls racing on the same approved link: only one wins a token', async () => {
  // Wrap the store so linkByDeviceCode awaits a tick, giving both concurrent
  // polls time to read 'approved' before either claims it, like a real DB round-trip.
  const slow = { ...store, linkByDeviceCode: async (h) => { const l = await store.linkByDeviceCode(h); await new Promise((r) => setImmediate(r)); return l } }
  const raceApi = await startApi({ store: slow, verifyUser, siteUrl: SITE })
  try {
    const raceCall = async (method, path, body, token) => {
      const res = await fetch(raceApi.url + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), origin: SITE },
        body: body ? JSON.stringify(body) : undefined
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const id = generateIdentity()
    const start = await raceCall('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Race', platform: 'linux' })
    await raceCall('POST', '/v1/device/approve', { userCode: start.body.userCode, approve: true }, 'user:u1')
    const [a, b] = await Promise.all([poll(id, start.body.deviceCode, raceCall), poll(id, start.body.deviceCode, raceCall)])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, [200, 410])
    const winner = a.status === 200 ? a : b
    assert.match(winner.body.token, /^qd_/)
  } finally {
    await raceApi.close()
  }
})

test('a denied or expired link never yields a token', async () => {
  const id = generateIdentity(); const { publicKey } = id
  const a = await call('POST', '/v1/device/start', { publicKey, deviceName: 'X', platform: 'linux' })
  await call('POST', '/v1/device/approve', { userCode: a.body.userCode, approve: false }, 'user:u1')
  assert.equal((await poll(id, a.body.deviceCode)).status, 403)
  const b = await call('POST', '/v1/device/start', { publicKey, deviceName: 'X', platform: 'linux' })
  const l = await store.linkByUserCode(b.body.userCode)
  await store.updateLink(l.id, { expiresAt: Date.now() - 1 })
  assert.equal((await poll(id, b.body.deviceCode)).status, 410)
  assert.equal((await call('POST', '/v1/device/approve', { userCode: b.body.userCode, approve: true }, 'user:u1')).status, 410)
})

test('bad requests are refused', async () => {
  assert.equal((await call('POST', '/v1/device/start', { publicKey: 'nope', deviceName: 'X' })).status, 400)
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: 'nope' })).status, 404)
  assert.equal((await call('GET', '/v1/device/link/AAAA-AAAA', null, 'user:u1')).status, 404)
})

async function linkedDevice (userId, id = generateIdentity()) {
  const s = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Mac', platform: 'darwin' })
  await call('POST', '/v1/device/approve', { userCode: s.body.userCode, approve: true }, `user:${userId}`)
  return (await poll(id, s.body.deviceCode)).body.token
}

test('the app reads and edits its profile with its device token, and signing out revokes it', async () => {
  const token = await linkedDevice('u2')
  assert.equal((await call('GET', '/v1/me', null, token)).body.profile.name, 'Eli')
  const put = await call('PUT', '/v1/me/profile', { name: 'Eli M', color: '#2F5D62', tool: 'Cursor', extra: 'ignored' }, token)
  assert.deepEqual([put.body.profile.name, put.body.profile.color, put.body.profile.tool], ['Eli M', '#2F5D62', 'Cursor'])
  assert.equal((await call('PUT', '/v1/me/profile', { color: 'red' }, token)).status, 400)
  assert.equal((await call('POST', '/v1/me/signout', {}, token)).status, 200)
  assert.equal((await call('GET', '/v1/me', null, token)).status, 401)
})

test('personal agents: listed for their owner, revoked only by them; the website no longer makes agents', async () => {
  const a = await store.createAgent({ name: 'Larry', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u1', invitedBy: 'u1' })
  const list = await call('GET', '/v1/agents', null, 'user:u1')
  assert.deepEqual(list.body.agents.map((x) => [x.id, x.name, x.provider, x.type]), [[a.id, 'Larry', 'Anthropic', 'coding agent']])
  assert.equal((await call('GET', '/v1/agents', null, 'user:u2')).body.agents.length, 0)
  assert.equal((await call('DELETE', `/v1/agents/${a.id}`, null, 'user:u2')).status, 404)
  assert.equal((await call('DELETE', `/v1/agents/${a.id}`, null, 'user:u1')).status, 200)
  assert.equal((await call('DELETE', `/v1/agents/${a.id}`, null, 'user:u1')).status, 404, 'already revoked')
  assert.equal((await call('GET', '/v1/agents', null, 'user:u1')).body.agents.length, 0)
  assert.equal((await call('POST', '/v1/agents', { name: 'x' }, 'user:u1')).status, 404)
  assert.equal((await call('GET', '/v1/agents')).status, 401)
})

test('browsers: only the website origin gets CORS headers', async () => {
  const ok = await fetch(api.url + '/v1/agents', { method: 'OPTIONS', headers: { origin: SITE } })
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE)
  const other = await fetch(api.url + '/v1/agents', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } })
  assert.equal(other.headers.get('access-control-allow-origin'), null)
})

test('join links are never cached or indexed, by their parsed path rather than the raw url', async () => {
  // The parsed pathname normalizes dot segments, so a path that only looks like it's
  // escaping /v1/join/ still gets the same treatment as a plain one.
  for (const path of ['/v1/join/qj_nope', '/v1/../v1/join/qj_nope', '/v1/orgs/../join/qj_nope']) {
    const r = await fetch(api.url + path)
    assert.equal(r.headers.get('cache-control'), 'no-store', path)
    assert.equal(r.headers.get('x-robots-tag'), 'noindex', path)
  }
  const notJoin = await fetch(api.url + '/healthz')
  assert.equal(notJoin.headers.get('x-robots-tag'), null)
  for (const path of ['/v1/join/qj_nope', '/v1/../v1/join/qj_nope']) {
    const opt = await fetch(api.url + path, { method: 'OPTIONS' })
    assert.equal(opt.headers.get('cache-control'), 'no-store', `OPTIONS ${path}`)
    assert.equal(opt.headers.get('x-robots-tag'), 'noindex', `OPTIONS ${path}`)
  }
  const optOther = await fetch(api.url + '/v1/agents', { method: 'OPTIONS' })
  assert.equal(optOther.headers.get('x-robots-tag'), null)
})

test('starting links is rate-limited per address', async () => {
  const limited = await startApi({ store: createMemoryStore(), verifyUser, siteUrl: SITE, startLimit: 2 })
  try {
    const { publicKey } = generateIdentity()
    const go = () => fetch(limited.url + '/v1/device/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey, deviceName: 'X' }) })
    assert.equal((await go()).status, 200)
    assert.equal((await go()).status, 200)
    assert.equal((await go()).status, 429)
  } finally { await limited.close() }
})

// Starts a second API (e.g. over a wrapped store) and hands the test a caller for it.
async function withApi (opts, fn) {
  const other = await startApi({ store, verifyUser, siteUrl: SITE, startLimit: 1000, ...opts })
  const via = async (method, path, body, token, headers = {}) => {
    const res = await fetch(other.url + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined || body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  try { return await fn(via, other) } finally { await other.close() }
}

test("only the computer holding the key can collect the token: a missing or wrong signature is refused", async () => {
  const id = generateIdentity(); const thief = generateIdentity()
  const s = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Mac', platform: 'darwin' })
  await call('POST', '/v1/device/approve', { userCode: s.body.userCode, approve: true }, 'user:u1')
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: s.body.deviceCode })).status, 401, 'no signature')
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: s.body.deviceCode, signature: 'garbage' })).status, 401, 'junk signature')
  assert.equal((await poll(thief, s.body.deviceCode)).status, 401, "another identity's signature")
  const ok = await poll(id, s.body.deviceCode)
  assert.equal(ok.status, 200, 'the real computer still gets its token')
  assert.match(ok.body.token, /^qd_/)
})

test('a signature in the old relay-challenge format no longer collects a token', async () => {
  const id = generateIdentity()
  const s = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Mac', platform: 'darwin' })
  await call('POST', '/v1/device/approve', { userCode: s.body.userCode, approve: true }, 'user:u1')
  // Exactly what the app used to send: a relay challenge for the room "device-link".
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(id.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
  const payload = Buffer.concat([Buffer.from('cowove-auth-v1\0device-link\0'), Buffer.from(s.body.deviceCode)])
  const old = crypto.sign(null, payload, privateKey).toString('base64url')
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: s.body.deviceCode, signature: old })).status, 401)
  assert.equal((await poll(id, s.body.deviceCode)).status, 200, 'the new signature still works')
})

test("someone who knows a computer's public key can't take over its device: their approval makes their own row", async () => {
  const id = generateIdentity()
  const dana = await linkedDevice('u1', id)
  const before = await call('GET', '/v1/me', null, dana)
  // Eli starts and approves a link with Dana's public key (public keys are shared with session members).
  const s = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Stolen', platform: 'darwin' })
  const approved = await call('POST', '/v1/device/approve', { userCode: s.body.userCode, approve: true }, 'user:u2')
  assert.equal(approved.status, 200)
  assert.notEqual(approved.body.device.id, before.body.device.id, 'a separate row for Eli')
  const after = await call('GET', '/v1/me', null, dana)
  assert.equal(after.status, 200, "Dana's token still works")
  assert.equal(after.body.profile.id, 'u1')
  assert.deepEqual(after.body.device, before.body.device, "Dana's row is untouched")
})

test('relinking a computer kills its old token, even before the new one is collected', async () => {
  const id = generateIdentity()
  const old = await linkedDevice('u1', id)
  assert.equal((await call('POST', '/v1/me/signout', {}, old)).status, 200)
  const s = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Mac', platform: 'darwin' })
  await call('POST', '/v1/device/approve', { userCode: s.body.userCode, approve: true }, 'user:u1')
  assert.equal((await call('GET', '/v1/me', null, old)).status, 401, 'revoked token stays dead after relink')
  const fresh = (await poll(id, s.body.deviceCode)).body.token
  assert.equal((await call('GET', '/v1/me', null, fresh)).status, 200)
  assert.equal((await call('GET', '/v1/me', null, old)).status, 401)
})

test('an approved link that is never collected expires 5 minutes after the code does', async () => {
  const id = generateIdentity()
  const s = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Mac', platform: 'darwin' })
  await call('POST', '/v1/device/approve', { userCode: s.body.userCode, approve: true }, 'user:u1')
  const l = await store.linkByUserCode(s.body.userCode)
  await store.updateLink(l.id, { expiresAt: Date.now() - 4 * 60_000 })
  // Still inside the grace period: a poll would work, but check the boundary with a second link below.
  const s2 = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Mac', platform: 'darwin' })
  await call('POST', '/v1/device/approve', { userCode: s2.body.userCode, approve: true }, 'user:u1')
  const l2 = await store.linkByUserCode(s2.body.userCode)
  await store.updateLink(l2.id, { expiresAt: Date.now() - 5 * 60_000 - 1000 })
  assert.equal((await poll(id, s2.body.deviceCode)).status, 410)
  assert.equal((await poll(id, s.body.deviceCode)).status, 200)
})

test('two concurrent approvals of the same code: only one succeeds', async () => {
  // A barrier on the lookup: both approvals read 'pending' before either one writes.
  let gate = null
  const slow = {
    ...store,
    linkByUserCode: async (c) => {
      const l = await store.linkByUserCode(c)
      if (gate) await new Promise((resolve) => { gate.push(resolve); if (gate.length === 2) gate.forEach((r) => r()) })
      return l
    }
  }
  await withApi({ store: slow }, async (via) => {
    const id = generateIdentity()
    const s = await via('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Mac', platform: 'darwin' })
    gate = []
    const [a, b] = await Promise.all([
      via('POST', '/v1/device/approve', { userCode: s.body.userCode, approve: true }, 'user:u1'),
      via('POST', '/v1/device/approve', { userCode: s.body.userCode, approve: true }, 'user:u2')
    ])
    assert.deepEqual([a.status, b.status].sort(), [200, 410])
    assert.equal((await store.linkByUserCode(s.body.userCode)).status, 'approved')
  })
})

test('a link mid-approval polls as pending', async () => {
  const id = generateIdentity()
  const s = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Mac', platform: 'darwin' })
  const l = await store.linkByUserCode(s.body.userCode)
  await store.updateLink(l.id, { status: 'approving' })
  assert.equal((await poll(id, s.body.deviceCode)).status, 202)
})

test('the start limit keys on Fly-Client-IP behind the proxy, so a forged X-Forwarded-For does not reset it', async () => {
  await withApi({ store: createMemoryStore(), startLimit: 2, trustProxy: true }, async (via) => {
    const { publicKey } = generateIdentity()
    const go = (xff, ip = '203.0.113.7') => via('POST', '/v1/device/start', { publicKey, deviceName: 'X' }, null, { 'x-forwarded-for': xff, 'fly-client-ip': ip })
    assert.equal((await go('1.1.1.1')).status, 200)
    assert.equal((await go('2.2.2.2')).status, 200)
    assert.equal((await go('3.3.3.3')).status, 429)
    assert.equal((await go('3.3.3.3', '203.0.113.8')).status, 200, 'another real address has its own limit')
  })
})

test('the start limiter forgets idle addresses once it tracks too many', async () => {
  let t = 1_000_000
  await withApi({ store: createMemoryStore(), trustProxy: true, now: () => t, maxStartKeys: 5 }, async (via, other) => {
    const { publicKey } = generateIdentity()
    const go = (ip) => via('POST', '/v1/device/start', { publicKey, deviceName: 'X' }, null, { 'fly-client-ip': ip })
    for (let i = 0; i < 5; i++) await go(`10.0.0.${i}`)
    assert.equal(other.startKeys(), 5)
    t += 61_000
    await go('10.0.1.1')
    assert.equal(other.startKeys(), 1, 'the idle addresses were dropped')
    for (let i = 0; i < 20; i++) { t += 61_000; await go(`10.0.2.${i}`) }
    assert.ok(other.startKeys() <= 6, `bounded, got ${other.startKeys()}`)
  })
})

test('revoking an agent with an id that is not a uuid is a 404 without asking the store', async () => {
  const strict = { ...store, revokeAgent: async () => { throw new Error('should not be called') } }
  await withApi({ store: strict }, async (via) => {
    assert.equal((await via('DELETE', '/v1/agents/not-a-uuid', undefined, 'user:u1')).status, 404)
  })
})

test('a profile update with nothing to change returns the profile without writing', async () => {
  const id = generateIdentity()
  const token = await linkedDevice('u1', id)
  const strict = { ...store, updateProfile: async () => { throw new Error('should not be called') } }
  await withApi({ store: strict }, async (via) => {
    const r = await via('PUT', '/v1/me/profile', { extra: 'ignored' }, token)
    assert.equal(r.status, 200)
    assert.equal(r.body.profile.id, 'u1')
    assert.equal((await via('PUT', '/v1/me/profile', 'null', token)).status, 200)
  })
})

test('odd bodies and paths are 400s, not 500s', async () => {
  await withApi({}, async (via) => {
    assert.equal((await via('POST', '/v1/device/start', 'null')).status, 400)
    assert.equal((await via('POST', '/v1/device/start', '"hello"')).status, 400)
    assert.equal((await via('POST', '/v1/device/start', '[1,2]')).status, 400)
    assert.equal((await via('POST', '/v1/device/poll', '42')).status, 404)
    assert.equal((await via('GET', '/v1/device/link/%E0%A4%A', undefined, 'user:u1')).status, 400)
  })
})

test('unexpected errors are logged even when they are not Error objects', async () => {
  const lines = []
  const broken = { ...store, deviceByToken: async () => { throw { code: 'PGRST301', details: 'db down' } } } // eslint-disable-line no-throw-literal
  await withApi({ store: broken, log: (l) => lines.push(l) }, async (via) => {
    assert.equal((await via('GET', '/v1/me', undefined, 'qd_x')).status, 500)
  })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /PGRST301/)
  assert.match(lines[0], /db down/)
})

test('a signed-in person can delete their account', async () => {
  store.addUser('bye', { name: 'Bye' })
  assert.equal((await call('DELETE', '/v1/me/account', null)).status, 401)
  assert.equal((await call('DELETE', '/v1/me/account', null, 'user:bye')).status, 200)
  assert.equal(await store.profile('bye'), null)
})
