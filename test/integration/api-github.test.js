// Connecting GitHub through Quilt's GitHub App (src/api/github-app.js, routes/github.js): the
// connect link, the callback that records who connected, and the relay's credentials for one
// repository, given only when the session owner's GitHub account may write to it. GitHub is a fake.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi } from '../helpers/api-helpers.js'
import { appJwt, appConfig, signState, readState } from '../../src/api/github-app.js'

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const cfg = { id: '123', key: privateKey.export({ type: 'pkcs1', format: 'pem' }), slug: 'quilt-test', clientId: 'Iv1.test', clientSecret: 'c'.repeat(40) }
const RELAY = 'relay-secret-for-tests-0123456789'
const roles = { mona: 'write', rita: 'read' }
const calls = []
const validJwt = (auth) => {
  const [h, b, s] = String(auth).replace(/^Bearer /, '').split('.')
  return !!s && crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')) && JSON.parse(Buffer.from(b, 'base64')).iss === '123'
}
async function githubFetch (url, init = {}) {
  const u = new URL(url)
  const auth = (init.headers || {}).authorization
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
  calls.push(`${init.method || 'GET'} ${u.pathname}`)
  if (u.pathname === '/login/oauth/access_token') {
    const b = JSON.parse(init.body)
    if (b.client_secret !== cfg.clientSecret) return json({ error: 'bad secret' })
    return json(b.code === 'mona-code' ? { access_token: 'u-mona' } : b.code === 'rita-code' ? { access_token: 'u-rita' } : { error: 'bad_verification_code' })
  }
  if (u.pathname === '/user') return auth === 'Bearer u-mona' ? json({ id: 1, login: 'mona' }) : auth === 'Bearer u-rita' ? json({ id: 2, login: 'rita' }) : json({}, 401)
  let m
  if ((m = /^\/repos\/acme\/(\w+)\/installation$/.exec(u.pathname))) return !validJwt(auth) ? json({}, 401) : m[1] === 'widgets' ? json({ id: 77 }) : json({ message: 'Not Found' }, 404)
  if (u.pathname === '/app/installations/77/access_tokens') {
    if (!validJwt(auth)) return json({}, 401)
    const b = JSON.parse(init.body)
    assert.deepEqual(b.repositories, ['widgets'])
    assert.equal(b.permissions.contents, 'write')
    return json({ token: 'ghs_repo_token', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201)
  }
  if ((m = /^\/repos\/acme\/widgets\/collaborators\/(\w+)\/permission$/.exec(u.pathname))) return auth === 'Bearer ghs_repo_token' ? json({ role_name: roles[m[1]] || 'none' }) : json({}, 401)
  return json({}, 404)
}

const t = await startTestApi({ github: cfg, githubFetch, relaySecret: RELAY })
after(() => t.close())
const relay = (body, secret = RELAY) => t.call('POST', '/v1/relay/github-token', body, null, { authorization: `Bearer ${secret}` })
const page = async (path) => { const r = await fetch(t.api.url + path); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() } }

test('the app signs in as itself; states are signed, short-lived and unforgeable; settings come from the environment', () => {
  assert.ok(validJwt(`Bearer ${appJwt(cfg)}`))
  const s = signState(cfg, 'mem', 1000)
  assert.equal(readState(cfg, s, 2000), 'mem')
  assert.equal(readState(cfg, s, 1000 + 11 * 60 * 1000), null, 'ten minutes at most')
  assert.equal(readState(cfg, s.replace('mem', 'own'), 2000), null)
  assert.equal(readState({ ...cfg, clientSecret: 'x'.repeat(40) }, s, 2000), null)
  const env = { GITHUB_APP_ID: '9', GITHUB_APP_SLUG: 'q', GITHUB_APP_CLIENT_ID: 'c', GITHUB_APP_CLIENT_SECRET: 's', GITHUB_APP_PRIVATE_KEY: Buffer.from(cfg.key).toString('base64') }
  assert.equal(appConfig(env).key, cfg.key, 'the key may be given as base64')
  assert.equal(appConfig({ ...env, GITHUB_APP_ID: '' }), null)
})

test('connecting: the link installs the app and comes back to the callback, which records who connected', async () => {
  let r = await t.call('POST', '/v1/github/connect', {}, 'mem')
  assert.equal(r.status, 200)
  const state = new URL(r.body.url).searchParams.get('state')
  assert.match(r.body.url, /^https:\/\/github\.com\/apps\/quilt-test\/installations\/new\?state=/)
  assert.deepEqual((await t.call('GET', '/v1/me/github', null, 'mem')).body, { available: true, connected: false })
  // From GitHub with no state of ours (installed straight from GitHub): told to start from Quilt.
  let p = await page('/v1/github/callback?code=mona-code&installation_id=77&setup_action=install')
  assert.match(p.text, /Start from Quilt/)
  p = await page(`/v1/github/callback?code=mona-code&state=${encodeURIComponent(state.replace(/^mem/, 'own'))}`)
  assert.match(p.text, /Start from Quilt/, 'a forged state')
  p = await page(`/v1/github/callback?code=nope&state=${encodeURIComponent(state)}`)
  assert.match(p.text, /GitHub did not sign you in/)
  p = await page(`/v1/github/callback?code=mona-code&installation_id=77&setup_action=install&state=${encodeURIComponent(state)}`)
  assert.equal(p.status, 200)
  assert.match(p.type, /text\/html/)
  assert.match(p.text, /Connected as @mona/)
  assert.deepEqual((await t.call('GET', '/v1/me/github', null, 'mem')).body, { available: true, connected: true, login: 'mona' })
  assert.equal((await t.call('POST', '/v1/github/connect', {})).status, 401, 'signed in only')
})

test('the relay gets credentials for one repository only when the session owner\'s GitHub account may write to it', async () => {
  assert.equal((await relay({ account: 'person:mem', repo: 'acme/widgets' }, 'wrong')).status, 401)
  assert.equal((await relay({ account: 'person:own', repo: 'acme/widgets' })).body.state, 'not-connected')
  assert.equal((await relay({ account: 'person:mem', repo: 'acme/other' })).body.state, 'not-installed')
  let r = await relay({ account: 'person:mem', repo: 'acme/widgets' })
  assert.equal(r.body.state, 'ok')
  assert.equal(r.body.token, 'ghs_repo_token')
  assert.equal(r.body.login, 'mona')
  const n = calls.length
  r = await relay({ account: 'person:mem', repo: 'acme/widgets' })
  assert.equal(r.body.token, 'ghs_repo_token')
  assert.equal(calls.length, n, 'kept until near its expiry')
  // Rita can only read widgets: no credentials for a session she owns.
  const s2 = new URL((await t.call('POST', '/v1/github/connect', {}, 'lim')).body.url).searchParams.get('state')
  await page(`/v1/github/callback?code=rita-code&state=${encodeURIComponent(s2)}`)
  r = await relay({ account: 'person:lim', repo: 'acme/widgets' })
  assert.deepEqual([r.body.state, r.body.login, r.body.token], ['no-access', 'rita', undefined])
  assert.equal((await relay({ account: 'agent:x', repo: 'acme/widgets' })).status, 400, 'only a person owns a session')
  // Disconnecting forgets them.
  await t.call('DELETE', '/v1/me/github', null, 'mem')
  assert.equal((await relay({ account: 'person:mem', repo: 'acme/widgets' })).body.state, 'not-connected')
})

test('without the app set up, connecting says so', async () => {
  const bare = await startTestApi({ relaySecret: RELAY })
  try {
    assert.equal((await bare.call('POST', '/v1/github/connect', {}, 'mem')).status, 503)
    assert.deepEqual((await bare.call('GET', '/v1/me/github', null, 'mem')).body, { available: false, connected: false })
  } finally { await bare.close() }
})
