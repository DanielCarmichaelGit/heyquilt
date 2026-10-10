import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose'
import { createUserVerifier } from '../../src/api/auth.js'

const URL_ = 'https://proj.supabase.co'
async function setup () {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }
  const verify = createUserVerifier({ supabaseUrl: URL_, jwks: createLocalJWKSet({ keys: [jwk] }) })
  const sign = (claims, opts = {}) => new SignJWT({ email: 'dana@x.test', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(opts.iss || `${URL_}/auth/v1`).setAudience(opts.aud || 'authenticated')
    .setSubject('user-123').setIssuedAt().setExpirationTime(opts.exp || '1h').sign(opts.key || privateKey)
  return { verify, sign }
}

test("a signed-in user's token is accepted", async () => {
  const { verify, sign } = await setup()
  assert.deepEqual(await verify(await sign({})), { userId: 'user-123', email: 'dana@x.test' })
})

test('forged, expired, wrong-issuer and missing tokens are rejected', async () => {
  const { verify, sign } = await setup()
  const other = (await generateKeyPair('ES256')).privateKey
  assert.equal(await verify(await sign({}, { key: other })), null)
  assert.equal(await verify(await sign({}, { exp: Math.floor(Date.now() / 1000) - 10 })), null)
  assert.equal(await verify(await sign({}, { iss: 'https://evil/auth/v1' })), null)
  assert.equal(await verify(await sign({}, { aud: 'anon' })), null)
  assert.equal(await verify(''), null)
})
