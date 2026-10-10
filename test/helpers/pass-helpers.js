// Test passes, signed with a key made for this test run, so relay and session
// tests never need the accounts API.
import { newPassKeys, signPass, PASS_TTL_MS } from '../../src/passes.js'
import { PassSource } from '../../src/pass-source.js'

export const PASS_KEYS = newPassKeys()

/** A pass for `identity`, like the API would sign it (any field can be overridden; others, like room and access, are added). */
export function makePass ({ identity, name = 'Dana', kind = 'person', sub = 'user-dana', exp = Date.now() + PASS_TTL_MS, v = 1, keys = PASS_KEYS, ...extra }) {
  return signPass({ v, sub, kind, name, key: identity.publicKey, exp, ...extra }, keys.privateKey)
}

/** Passes made locally for `identity`, the way the API would hand them out. */
export function testPasses (identity, fields = {}) {
  return new PassSource({
    fetchPass: async () => {
      const exp = Date.now() + PASS_TTL_MS
      return { pass: makePass({ identity, exp, ...fields }), expiresAt: exp }
    }
  })
}
