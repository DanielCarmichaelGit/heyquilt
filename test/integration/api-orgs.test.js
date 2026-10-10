import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, linkDevice } from '../helpers/api-helpers.js'
import { BUILTIN } from '../../src/api/permissions.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

test('creating an org makes you its owner, with a slug from the name', async () => {
  const a = await t.call('POST', '/v1/orgs', { name: 'Acme Rockets', first: true }, 'owner')
  assert.equal(a.status, 200)
  assert.equal(a.body.org.slug, 'acme-rockets')
  const list = await t.call('GET', '/v1/orgs', null, 'owner')
  const mine = list.body.orgs.find((o) => o.slug === 'acme-rockets')
  assert.deepEqual([mine.isOwner, mine.role], [true, 'Owner'])
  const me = await t.call('GET', '/v1/orgs/acme-rockets/me', null, 'owner')
  assert.deepEqual([me.body.isOwner, me.body.role.builtin, me.body.org.name], [true, 'owner', 'Acme Rockets'])
  assert.deepEqual(me.body.grants, BUILTIN.owner)
  assert.equal(typeof me.body.memberId, 'string')
  assert.equal((await t.call('GET', '/v1/orgs/ACME-ROCKETS/me', null, 'owner')).status, 200, 'slugs are case-insensitive')
  assert.equal((await t.call('POST', '/v1/orgs', { name: 'X' })).status, 401)
})

test('a second org with the same name gets the next slug', async () => {
  await t.store.addUser('rockets2', { kind: 'org' })
  const b = await t.call('POST', '/v1/orgs', { name: 'Acme Rockets', first: true }, 'rockets2')
  assert.equal(b.status, 200)
  assert.equal(b.body.org.slug, 'acme-rockets-2')
})

// Only an org account can create an org, and only when it isn't in one yet:
// a personal account is refused outright, and an org account needs first: true.
test('orgs are only made by an org account creating its first org', async () => {
  const solo = await t.call('POST', '/v1/orgs', { name: 'Solo Nope', first: true }, 'mem')
  assert.equal(solo.status, 403, 'a personal account, even with first: true')
  assert.match(solo.body.error, /signing up as an org/)
  assert.equal((await t.call('POST', '/v1/orgs', { name: 'Owner Nope' }, 'owner')).status, 403, 'an org account without first: true')
  assert.equal((await t.call('POST', '/v1/orgs', { name: '   ', first: true }, 'owner')).status, 400, 'name is still validated')
  assert.equal((await t.call('POST', '/v1/orgs', { name: 'Ghost Co', first: true }, 'ghost')).status, 403, 'no profile at all reads as not an org account')
})

test('first:true creates the org only once, even called twice (two tabs, or a double click)', async () => {
  await t.store.addUser('racer', { kind: 'org' })
  const a = await t.call('POST', '/v1/orgs', { name: 'Race Co', first: true }, 'racer')
  assert.equal(a.status, 200)
  const b = await t.call('POST', '/v1/orgs', { name: 'Race Co Two', first: true }, 'racer')
  assert.equal(b.status, 200)
  assert.equal(b.body.org.slug, a.body.org.slug, 'the second call gets the same org back, not a new one')
  const org = await t.store.orgBySlug(a.body.org.slug)
  const members = await t.store.listMembers(org.id)
  assert.equal(members.filter((m) => m.userId === 'racer').length, 1, 'racer ends up with exactly one membership')
})

test('first:true hands back an org you already belong to (e.g. you accepted an invite first)', async () => {
  await t.store.addUser('already', { kind: 'org' })
  const o = await makeOrg(t, 'Existing Co')
  await t.store.addMember({ orgId: o.org.id, userId: 'already', roleId: o.role('member').id })
  const r = await t.call('POST', '/v1/orgs', { name: 'New Co', first: true }, 'already')
  assert.equal(r.status, 200)
  assert.equal(r.body.org.slug, o.slug, 'gets the org they are already in, not a new one')
})

test('people outside an org get a 404 for it, the same as a missing org', async () => {
  const o = await makeOrg(t)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'out')).status, 404)
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}`, { name: 'Mine' }, 'out')).status, 404)
  assert.equal((await t.call('GET', '/v1/orgs/no-such-org/me', null, 'out')).status, 404)
})

test('a Member sees their grants and cannot change settings; an Admin can', async () => {
  const o = await makeOrg(t)
  const me = await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'mem')
  assert.deepEqual([me.body.isOwner, me.body.role.name, me.body.grants], [false, 'Member', { teams: { r: true }, workspaces: { r: true } }])
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}`, { name: 'Nope' }, 'mem')).status, 403)
  const ok = await t.call('PUT', `/v1/orgs/${o.slug}`, { name: 'Acme Two' }, 'admin')
  assert.deepEqual([ok.status, ok.body.org.name, ok.body.org.slug], [200, 'Acme Two', o.slug], 'renaming keeps the address')
})

test('the org domain must be your own confirmed email domain, and never a public one', async () => {
  const o = await makeOrg(t)
  const put = (who, body, slug = o.slug) => t.call('PUT', `/v1/orgs/${slug}`, body, who)
  assert.equal((await put('owner', { domainRequests: true })).status, 400, 'no domain yet')
  const set = await put('owner', { domain: 'ACME.com' })
  assert.deepEqual([set.status, set.body.org.domain], [200, 'acme.com'])
  assert.equal((await put('owner', { domain: 'else.com' })).status, 403, 'not your email domain')
  assert.equal((await put('owner', { domain: 'not a domain' })).status, 400)
  assert.equal((await put('owner', { domainRequests: true })).body.org.domainRequests, true)
  // Someone else with Org settings: Update can save other changes without re-proving the domain.
  await t.store.addMember({ orgId: o.org.id, userId: 'out', roleId: o.role('admin').id })
  assert.equal((await put('out', { name: 'Acme Three', domain: 'acme.com' })).status, 200)
  const off = await put('owner', { domain: null })
  assert.deepEqual([off.body.org.domain, off.body.org.domainRequests], [null, false], 'no domain, no requests')
  const g = (await t.call('POST', '/v1/orgs', { name: 'Gee Co', first: true }, 'gm')).body.org
  assert.equal((await put('gm', { domain: 'gmail.com' }, g.slug)).status, 400, 'public mail domain')
  const u = (await t.call('POST', '/v1/orgs', { name: 'Una Co', first: true }, 'unconf')).body.org
  assert.equal((await put('unconf', { domain: 'acme.com' }, u.slug)).status, 403, 'unconfirmed email')
})

test('only the owner transfers or deletes the org, and there is always exactly one owner', async () => {
  const o = await makeOrg(t)
  const transfer = (who, memberId) => t.call('POST', `/v1/orgs/${o.slug}/transfer`, { memberId }, who)
  assert.equal((await transfer('admin', o.mem.id)).status, 403)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}`, null, 'admin')).status, 403)
  assert.equal((await transfer('owner', o.owner.id)).status, 400, 'you already own it')
  assert.equal((await transfer('owner', 'not-a-uuid')).status, 404)
  assert.equal((await transfer('owner', o.admin.id)).status, 200)
  const now = await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'admin')
  assert.deepEqual([now.body.isOwner, now.body.role.builtin], [true, 'owner'])
  const before = await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'owner')
  assert.deepEqual([before.body.isOwner, before.body.role.builtin], [false, 'admin'])
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}`, null, 'owner')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}`, null, 'admin')).status, 200)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'admin')).status, 404)
})

test('a transfer refuses once ownership already moved, instead of moving it again', async () => {
  const o = await makeOrg(t, 'Race Transfer Co')
  // Simulate a second transfer landing between this request's org lookup (which
  // still sees "owner" as the owner, so needOwner passes) and its own write.
  const real = t.store.transferOrg.bind(t.store)
  t.store.transferOrg = async (orgId, fromUserId, toUserId) => {
    await real(orgId, fromUserId, 'mem')
    return real(orgId, fromUserId, toUserId)
  }
  try {
    const r = await t.call('POST', `/v1/orgs/${o.slug}/transfer`, { memberId: o.admin.id }, 'owner')
    assert.equal(r.status, 409)
    assert.match(r.body.error, /Ownership already changed/)
  } finally { t.store.transferOrg = real }
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'mem')).body.role.builtin, 'owner', 'the transfer that landed first still stands')
})

test('roles: listing is ordered, and people who hand out roles can list them', async () => {
  const o = await makeOrg(t)
  await t.store.createRole({ orgId: o.org.id, name: 'Zed', grants: {} })
  await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: {} })
  const r = await t.call('GET', `/v1/orgs/${o.slug}/roles`, null, 'admin')
  assert.deepEqual(r.body.roles.map((x) => x.name), ['Owner', 'Admin', 'Member', 'Lead', 'Zed'])
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/roles`, null, 'mem')).status, 403)
  const inviter = await t.store.createRole({ orgId: o.org.id, name: 'Inviter', grants: { invites: { c: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: inviter.id })
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/roles`, null, 'lim')).status, 200)
})

test('roles: you can only create a role within your own permissions', async () => {
  const o = await makeOrg(t)
  const made = await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'Lead', grants: { teams: { c: true, r: 'on' }, org: { c: true }, bogus: { r: true } } }, 'admin')
  assert.equal(made.status, 200)
  assert.deepEqual([made.body.role.name, made.body.role.builtin, made.body.role.grants], ['Lead', null, { teams: { c: true, r: true } }])
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'Lead', grants: {} }, 'admin')).status, 409)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'X', grants: {} }, 'mem')).status, 403)
  const maker = await t.store.createRole({ orgId: o.org.id, name: 'Maker', grants: { roles: { c: true, r: true }, teams: { r: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: maker.id })
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'Remover', grants: { members: { d: true } } }, 'lim')).status, 403)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'Reader', grants: { teams: { r: true } } }, 'lim')).status, 200)
})

test('roles: Owner is fixed, built-ins keep their names, and assigned roles are not deleted', async () => {
  const o = await makeOrg(t)
  const put = (id, body, who = 'admin') => t.call('PUT', `/v1/orgs/${o.slug}/roles/${id}`, body, who)
  const del = (id, who = 'admin') => t.call('DELETE', `/v1/orgs/${o.slug}/roles/${id}`, null, who)
  assert.equal((await put(o.role('owner').id, { grants: {} })).status, 403)
  assert.equal((await put(o.role('admin').id, { name: 'Boss' })).status, 400)
  assert.equal((await put(o.role('admin').id, { name: 'Admin' })).status, 200, 'the same name is fine')
  const edited = await put(o.role('member').id, { grants: { teams: { r: true, c: true } } })
  assert.deepEqual(edited.body.role.grants, { teams: { r: true, c: true } })
  assert.equal((await del(o.role('member').id)).status, 400, 'built-ins stay')
  const used = await t.store.createRole({ orgId: o.org.id, name: 'Used', grants: {} })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: used.id })
  assert.equal((await del(used.id)).status, 409)
  const spare = await t.store.createRole({ orgId: o.org.id, name: 'Spare', grants: {} })
  assert.equal((await del(spare.id, 'mem')).status, 403)
  assert.equal((await del(spare.id)).status, 200)
  assert.equal((await del(spare.id)).status, 404)
  assert.equal((await put('not-a-uuid', { grants: {} })).status, 404)
})

test('roles: a custom role cannot be named or renamed after a built-in role', async () => {
  const o = await makeOrg(t)
  const made = await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'Owner', grants: {} }, 'admin')
  assert.equal(made.status, 400)
  assert.match(made.body.error, /reserved for a built-in role/)
  // Case-insensitive, and after trimming/cleaning the name.
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: '  ADMIN  ', grants: {} }, 'admin')).status, 400)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'member', grants: {} }, 'admin')).status, 400)
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: {} })
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/roles/${lead.id}`, { name: 'Owner' }, 'admin')).status, 400)
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/roles/${lead.id}`, { name: 'Still Lead' }, 'admin')).status, 200)
})

test('roles: nobody edits a role with checkboxes they do not have', async () => {
  const o = await makeOrg(t)
  const editor = await t.store.createRole({ orgId: o.org.id, name: 'Editor', grants: { roles: { r: true, u: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: editor.id })
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/roles/${o.role('admin').id}`, { grants: {} }, 'lim')).status, 403)
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/roles/${editor.id}`, { grants: { roles: { r: true, u: true, d: true } } }, 'lim')).status, 403)
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/roles/${editor.id}`, { grants: { roles: { r: true } } }, 'lim')).status, 200, 'giving up checkboxes is fine')
})

test('an org owner must transfer or delete their orgs before deleting their account', async () => {
  const other = await startTestApi()
  try {
    await other.call('POST', '/v1/orgs', { name: 'Keep', first: true }, 'owner')
    assert.equal((await other.call('DELETE', '/v1/me/account', null, 'owner')).status, 409)
    assert.equal((await other.call('DELETE', '/v1/me/account', null, 'out')).status, 200)
  } finally { await other.close() }
})

test('GET /v1/orgs answers the app on a linked computer (a qd_ device token), not only the website', async () => {
  const { token } = await linkDevice(t, 'mem')
  const r = await t.call('GET', '/v1/orgs', null, null, { authorization: `Bearer ${token}` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(Array.isArray(r.body.orgs))
})
