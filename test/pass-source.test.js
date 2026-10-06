// Getting passes: cached until 2 minutes before they run out, shared between
// callers, and clear about a computer (or agent) that's signed out.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestApi, linkDevice, API_URL } from './api-helpers.js'
import { PassSource, SignedOutError, personPasses, agentPasses, sessionPasses } from '../src/pass-source.js'
import { newPassKeys, verifyPass } from '../src/passes.js'
import { agentJoin, agentFile } from '../src/agent-join.js'

process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ps-home-'))
const KEYS = newPassKeys()
let t
before(async () => { t = await startTestApi({ passKey: KEYS.privateKey }) })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ps-'))

test('a pass is reused until 2 minutes before it runs out, and callers share one request', async () => {
  let clock = 1_000_000
  let n = 0
  const ps = new PassSource({ now: () => clock, fetchPass: async () => { n++; return { pass: `p${n}`, expiresAt: clock + 10 * 60_000 } } })
  assert.deepEqual(await Promise.all([ps.get(), ps.get()]), ['p1', 'p1'])
  assert.equal(n, 1)
  clock += 8 * 60_000 - 1
  assert.equal(await ps.get(), 'p1', 'still more than 2 minutes left')
  clock += 1
  assert.equal(await ps.get(), 'p2', '2 minutes left: fetch a new one')
  assert.equal(await ps.fresh(), 'p3', 'fresh() always fetches')
})

test('newer() waits out a fetch already on its way and asks again, so the pass is issued after the call', async () => {
  let n = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ps = new PassSource({ fetchPass: async () => { const me = ++n; if (me === 1) await gate; return { pass: `p${me}`, expiresAt: Date.now() + 600_000 } } })
  const first = ps.fresh()
  const newer = ps.newer()
  release()
  assert.deepEqual([await first, await newer], ['p1', 'p2'])
  assert.equal(await ps.newer(), 'p3', 'with nothing on its way, it fetches')
})

test('a failed fetch is not cached', async () => {
  let fail = true
  const ps = new PassSource({ fetchPass: async () => { if (fail) throw new Error('offline'); return { pass: 'p', expiresAt: Date.now() + 600_000 } } })
  await assert.rejects(ps.get(), /offline/)
  fail = false
  assert.equal(await ps.get(), 'p')
})

test("a linked computer's passes, and a clear error once it's signed out", async () => {
  const { token, identity } = await linkDevice(t, 'mem')
  const ps = personPasses({ token, api: t.api.url })
  const p = verifyPass(await ps.get(), KEYS.publicKey)
  assert.deepEqual([p.kind, p.name, p.key], ['person', 'Mo', identity.publicKey])
  assert.equal(ps.payload.name, 'Mo')
  await t.call('POST', '/v1/me/signout', {}, null, { authorization: `Bearer ${token}` })
  await assert.rejects(ps.fresh(), (err) => err instanceof SignedOutError && err.signedOut === true && err.message === 'This computer was signed out. Sign in again.')
})

test("an agent's passes use its saved key, refreshing its access key first when it has run out", async () => {
  const dir = tmp()
  const link = (await t.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.replace(API_URL, t.api.url)
  const saved = await agentJoin({ link, name: 'helper', dir, log: () => {} })
  const file = agentFile('helper', dir)
  fs.writeFileSync(file, JSON.stringify({ ...saved, accessExpiresAt: Date.now() - 1 }))
  const p = verifyPass(await agentPasses({ name: 'helper', dir }).get(), KEYS.publicKey)
  assert.deepEqual([p.kind, p.name, p.sub, p.key], ['agent', 'helper', saved.agentId, saved.identity.publicKey])
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).refreshKey, saved.refreshKey, 'the keys were refreshed and saved')
  await t.store.revokeAgent(saved.agentId)
  await assert.rejects(agentPasses({ name: 'helper', dir }).get(), (err) => err.signedOut === true)
})

test('a session needs a signed-in account or a saved agent', () => {
  assert.throws(() => sessionPasses(), /^Error: Run quilt login first\.$/)
  assert.throws(() => sessionPasses({ agent: 'nobody', dir: tmp() }), /No agent called nobody/)
})

test("a pass request with no answer gives up, so the connection's retry runs", async () => {
  // A fetch that never answers, like one sent while a computer that just woke has no network.
  const hang = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  const ps = personPasses({ token: 'qd_x', api: 'http://quilt.invalid', fetch: hang, file: path.join(tmp(), 'account.json'), timeoutMs: 50 })
  const started = Date.now()
  await assert.rejects(ps.get(), /Couldn't reach Quilt \(ETIMEDOUT\)/)
  assert.ok(Date.now() - started < 2000, 'gave up after its timeout')
})
