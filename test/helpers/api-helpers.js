// Shared setup for the org API tests: an API over a fresh memory store, a fake
// mailer that keeps what it sends, and a cast of people.
import crypto from 'node:crypto'
import { startApi } from '../../src/api/server.js'
import { createMemoryStore } from '../../src/api/memory-store.js'
import { BUILTIN } from '../../src/api/permissions.js'
import { uniqueSlug } from '../../src/api/slugs.js'
import { newToken, hashToken } from '../../src/api/tokens.js'
import { generateIdentity } from '../../src/identity.js'

export const SITE = 'https://quilt.test'
export const API_URL = 'https://api.quilt.test'
// A bearer "user:<id>" stands in for a website user's JWT.
const verifyUser = async (t) => (t && t.startsWith('user:') ? { userId: t.slice(5), email: '' } : null)

// "owner", "gm" and "unconf" are org accounts (they call POST /v1/orgs directly
// in api-orgs.test.js); everyone else is a plain personal account.
const CAST = [
  ['owner', 'Olive', 'olive@acme.com', true, 'org'], ['admin', 'Ada', 'ada@acme.com'], ['mem', 'Mo', 'mo@acme.com'],
  ['lim', 'Lin', 'lin@acme.com'], ['out', 'Otto', 'otto@else.com'], ['gm', 'Gee', 'gee@gmail.com', true, 'org'],
  ['unconf', 'Una', 'una@acme.com', false, 'org']
]

export async function startTestApi (opts = {}) {
  const store = createMemoryStore()
  for (const [id, name, email, confirmed = true, kind = 'personal'] of CAST) store.addUser(id, { name, email, confirmed, kind })
  const sent = []
  const mailer = { send: async (m) => { sent.push(m) } }
  // `wrapStore` lets a test see every call the API makes to its store (the cast is already in it).
  const { wrapStore = (s) => s, ...rest } = opts
  const api = await startApi({ store: wrapStore(store), verifyUser, siteUrl: SITE, apiUrl: API_URL, startLimit: 1000, inviteLimit: 1000, inviteSendLimit: 1000, tokenLimit: 1000, joinLimit: 1000, reportLimit: 1000, mailer, ...rest })
  const call = async (method, path, body, userId, headers = {}) => {
    const res = await fetch(api.url + path, {
      method,
      headers: { 'content-type': 'application/json', ...(userId ? { authorization: `Bearer user:${userId}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { api, store, sent, call, close: () => api.close() }
}

/** An org owned by "owner", with "admin" as Admin and "mem" as Member.
 * Goes straight through the store rather than POST /v1/orgs: this is test setup
 * for other endpoints, not a test of the sign-up-only enforcement itself, and it
 * needs to make a fresh org for "owner" every time it's called, first: true or not. */
export async function makeOrg (t, name = 'Acme') {
  const slug = await uniqueSlug(name, async (s) => !!await t.store.orgBySlug(s))
  const org = await t.store.createOrg({ name, slug, ownerId: 'owner', grants: BUILTIN })
  const roles = await t.store.listRoles(org.id)
  const role = (b) => roles.find((r) => r.builtin === b)
  const admin = await t.store.addMember({ orgId: org.id, userId: 'admin', roleId: role('admin').id })
  const mem = await t.store.addMember({ orgId: org.id, userId: 'mem', roleId: role('member').id })
  const owner = await t.store.memberOf(org.id, 'owner')
  return { slug: org.slug, org, role, owner, admin, mem }
}

/** A joined agent with a working key pair, made straight through the store. */
export async function makeAgent (t, { name = 'Larry', provider = 'Anthropic', type = 'coding agent', description = '', publicKey = null, ownerUserId = null, orgId = null, invitedBy = 'owner', accessTtl = 60 * 60 * 1000, refreshTtl = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const agent = await t.store.createAgent({ name, provider, type, description, publicKey, ownerUserId, orgId, invitedBy })
  const accessKey = newToken('qa_'); const refreshKey = newToken('qr_')
  const at = Date.now()
  await t.store.createAgentKeys({ agentId: agent.id, familyId: crypto.randomUUID(), accessHash: hashToken(accessKey), refreshHash: hashToken(refreshKey), accessExpiresAt: at + accessTtl, refreshExpiresAt: at + refreshTtl })
  return { agent, accessKey, refreshKey }
}

/** A computer linked to `userId`, made straight through the store: its identity and its qd_ token. */
export async function linkDevice (t, userId, identity = generateIdentity()) {
  const device = await t.store.upsertDevice({ userId, name: 'Mac', platform: 'darwin', publicKey: identity.publicKey })
  const token = newToken('qd_')
  await t.store.setDeviceToken(device.id, hashToken(token))
  return { device, token, identity }
}
