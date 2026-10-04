import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'
import { BUILTIN } from '../src/api/permissions.js'

function setup () {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana', email: 'dana@acme.com' })
  s.addUser('u2', { name: 'Eli', email: 'eli@acme.com', confirmed: false })
  return s
}
const newOrg = (s, name = 'Acme', slug = 'acme', ownerId = 'u1') => s.createOrg({ name, slug, ownerId, grants: BUILTIN })

test('userEmail says whether the address is confirmed', async () => {
  const s = setup()
  assert.deepEqual(await s.userEmail('u1'), { email: 'dana@acme.com', confirmed: true })
  assert.deepEqual(await s.userEmail('u2'), { email: 'eli@acme.com', confirmed: false })
  assert.equal(await s.userEmail('nobody'), null)
})

test('creating an org makes the three built-in roles and the owner as a member', async () => {
  const s = setup()
  const org = await newOrg(s)
  assert.deepEqual([org.name, org.slug, org.ownerId, org.domain, org.domainRequests], ['Acme', 'acme', 'u1', null, false])
  const roles = await s.listRoles(org.id)
  assert.deepEqual(roles.map((r) => [r.name, r.builtin]).sort(), [['Admin', 'admin'], ['Member', 'member'], ['Owner', 'owner']])
  assert.deepEqual(roles.find((r) => r.builtin === 'member').grants, { teams: { r: true }, workspaces: { r: true } })
  const me = await s.memberOf(org.id, 'u1')
  assert.equal(me.roleId, roles.find((r) => r.builtin === 'owner').id)
  await assert.rejects(newOrg(s, 'Other', 'acme'), (err) => err.code === '23505')
  assert.equal((await s.orgBySlug('acme')).id, org.id)
  assert.equal((await s.orgById(org.id)).slug, 'acme')
  assert.equal(await s.orgBySlug('nope'), null)
})

test('orgsForUser lists each org with the person\'s role, by name', async () => {
  const s = setup()
  const zeta = await newOrg(s, 'Zeta', 'zeta')
  const acme = await newOrg(s, 'Acme', 'acme')
  const list = await s.orgsForUser('u1')
  assert.deepEqual(list.map((o) => o.slug), ['acme', 'zeta'])
  assert.equal(list[1].id, zeta.id)
  assert.equal(list[0].roleId, (await s.memberOf(acme.id, 'u1')).roleId)
  assert.deepEqual(await s.orgsForUser('u2'), [])
})

test('updating an org, and finding orgs open to join requests by domain', async () => {
  const s = setup()
  const org = await newOrg(s)
  assert.equal((await s.updateOrg(org.id, { name: 'Acme Co', domain: 'acme.com' })).name, 'Acme Co')
  assert.deepEqual(await s.orgsByDomain('acme.com'), [], 'requests are off')
  await s.updateOrg(org.id, { domainRequests: true })
  assert.deepEqual((await s.orgsByDomain('acme.com')).map((o) => o.id), [org.id])
  assert.equal((await s.updateOrg(org.id, { domain: null })).domain, null)
})

test('transferring an org: the new owner takes Owner and the old owner becomes Admin', async () => {
  const s = setup()
  const org = await newOrg(s)
  const roles = await s.listRoles(org.id)
  const role = (b) => roles.find((r) => r.builtin === b).id
  await s.addMember({ orgId: org.id, userId: 'u2', roleId: role('member') })
  await s.transferOrg(org.id, 'u1', 'u2')
  assert.equal((await s.orgById(org.id)).ownerId, 'u2')
  assert.equal((await s.memberOf(org.id, 'u2')).roleId, role('owner'))
  assert.equal((await s.memberOf(org.id, 'u1')).roleId, role('admin'))
})

test('roles: create, update, delete, and in-use checks', async () => {
  const s = setup()
  const org = await newOrg(s)
  const lead = await s.createRole({ orgId: org.id, name: 'Lead', grants: { teams: { c: true } } })
  assert.equal(lead.builtin, null)
  await assert.rejects(s.createRole({ orgId: org.id, name: 'Lead', grants: {} }), (err) => err.code === '23505')
  assert.deepEqual((await s.updateRole(lead.id, { grants: { teams: { r: true } } })).grants, { teams: { r: true } })
  assert.equal((await s.updateRole(lead.id, { name: 'Leads' })).name, 'Leads')
  assert.equal((await s.roleById(org.id, lead.id)).name, 'Leads')
  const other = await newOrg(s, 'Other', 'other')
  assert.equal(await s.roleById(other.id, lead.id), null, 'roles are scoped to their org')
  assert.equal(await s.roleInUse(lead.id), false)
  const m = await s.addMember({ orgId: org.id, userId: 'u2', roleId: lead.id })
  assert.equal(await s.roleInUse(lead.id), true)
  await s.setMemberRole(m.id, (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id)
  assert.equal(await s.roleInUse(lead.id), false)
  await s.deleteRole(lead.id)
  assert.equal(await s.roleById(org.id, lead.id), null)
})

test('members: add once, list with names, change role, remove', async () => {
  const s = setup()
  const org = await newOrg(s)
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  const a = await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  const again = await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  assert.equal(again.id, a.id)
  assert.deepEqual((await s.listMembers(org.id)).map((m) => m.name).sort(), ['Dana', 'Eli'])
  assert.equal((await s.memberById(org.id, a.id)).userId, 'u2')
  const other = await newOrg(s, 'Other', 'other')
  assert.equal(await s.memberById(other.id, a.id), null)
  await s.removeMember(a.id)
  assert.equal(await s.memberOf(org.id, 'u2'), null)
})

test('deleting an org removes its roles and members; deleting a person removes their memberships', async () => {
  const s = setup()
  const org = await newOrg(s)
  const other = await newOrg(s, 'Other', 'other', 'u2')
  await s.addMember({ orgId: other.id, userId: 'u1', roleId: (await s.listRoles(other.id)).find((r) => r.builtin === 'member').id })
  await s.deleteOrg(org.id)
  assert.equal(await s.orgById(org.id), null)
  assert.deepEqual(await s.listRoles(org.id), [])
  assert.deepEqual(await s.listMembers(org.id), [])
  await s.deleteUser('u1')
  assert.equal(await s.memberOf(other.id, 'u1'), null)
  assert.equal(await s.userEmail('u1'), null)
})

test('deleting a role clears its closed invites first, and refuses while one is open', async () => {
  const s = setup()
  const org = await newOrg(s)
  const lead = await s.createRole({ orgId: org.id, name: 'Lead', grants: {} })
  await s.createInvite({ orgId: org.id, email: 'x@acme.com', roleId: lead.id, tokenHash: 'h1', invitedBy: 'u1', expiresAt: Date.now() - 1000 })
  assert.equal(await s.roleInUse(lead.id), false, 'an expired invite does not count as open')
  await s.deleteRole(lead.id)
  assert.equal(await s.roleById(org.id, lead.id), null, 'a role with only an expired (closed) invite can be deleted')

  const lead2 = await s.createRole({ orgId: org.id, name: 'Lead2', grants: {} })
  await s.createInvite({ orgId: org.id, email: 'y@acme.com', roleId: lead2.id, tokenHash: 'h2', invitedBy: 'u1', expiresAt: Date.now() + 1000 * 60 * 60 })
  assert.equal(await s.roleInUse(lead2.id), true, 'an open invite is reported in use')
  await assert.rejects(s.deleteRole(lead2.id), (err) => err.code === '23503')
  assert.ok(await s.roleById(org.id, lead2.id), 'the role survives the refused delete')
})

test('transferOrg reports QO003/QO002/QO001 like transfer_org, instead of throwing a plain error', async () => {
  const s = setup()
  const org = await newOrg(s)
  await assert.rejects(s.transferOrg(org.id, 'u2', 'u1'), (err) => err.code === 'QO003', 'caller is not the current owner')
  await assert.rejects(s.transferOrg(org.id, 'u1', 'u2'), (err) => err.code === 'QO002', 'target not a member')
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  await s.removeMember((await s.memberOf(org.id, 'u1')).id)
  await assert.rejects(s.transferOrg(org.id, 'u1', 'u2'), (err) => err.code === 'QO001', 'current owner no longer a member')
})

test('a role from another org cannot be attached to a member (composite FK)', async () => {
  const s = setup()
  const org = await newOrg(s)
  const other = await newOrg(s, 'Other', 'other', 'u2')
  const otherRole = (await s.listRoles(other.id)).find((r) => r.builtin === 'member').id
  await assert.rejects(s.addMember({ orgId: org.id, userId: 'u2', roleId: otherRole }), (err) => err.code === '23503')
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  const m = await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  await assert.rejects(s.setMemberRole(m.id, otherRole), (err) => err.code === '23503')
})

test('listMembers is sorted by joinedAt', async () => {
  let t = 1000
  const s = createMemoryStore({ now: () => t })
  s.addUser('u1', { name: 'Dana', email: 'dana@acme.com' })
  s.addUser('u2', { name: 'Eli', email: 'eli@acme.com' })
  s.addUser('u3', { name: 'Cal', email: 'cal@acme.com' })
  const org = await newOrg(s)
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  t = 3000; await s.addMember({ orgId: org.id, userId: 'u3', roleId: memberRole })
  t = 2000; await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  assert.deepEqual((await s.listMembers(org.id)).map((m) => m.userId), ['u1', 'u2', 'u3'])
})

test('teams: unique names per org, membership with access, and cleanup', async () => {
  const s = setup()
  const org = await newOrg(s)
  const web = await s.createTeam({ orgId: org.id, name: 'Web' })
  const api = await s.createTeam({ orgId: org.id, name: 'API' })
  await assert.rejects(s.createTeam({ orgId: org.id, name: 'Web' }), (err) => err.code === '23505')
  await assert.rejects(s.renameTeam(api.id, 'Web'), (err) => err.code === '23505')
  assert.deepEqual((await s.listTeams(org.id)).map((t) => t.name), ['API', 'Web'])
  assert.equal((await s.renameTeam(api.id, 'Platform')).name, 'Platform')
  const other = await newOrg(s, 'Other', 'other')
  assert.equal(await s.teamById(other.id, web.id), null)
  const dana = await s.memberOf(org.id, 'u1')
  await s.addTeamMember({ teamId: web.id, memberId: dana.id, access: 'viewer' })
  await s.addTeamMember({ teamId: web.id, memberId: dana.id, access: 'editor' })
  assert.deepEqual((await s.listTeamMembers(web.id)).map((m) => [m.name, m.access, m.scopes]), [['Dana', 'editor', []]])
  assert.deepEqual(await s.teamsOfMember(dana.id), [{ teamId: web.id, access: 'editor', scopes: [] }])
  assert.equal((await s.setTeamAccess(web.id, dana.id, 'viewer')).access, 'viewer')
  assert.equal(await s.setTeamAccess(api.id, dana.id, 'viewer'), null)
  assert.equal(await s.removeTeamMember(web.id, dana.id), true)
  assert.equal(await s.removeTeamMember(web.id, dana.id), false)
  await s.addTeamMember({ teamId: web.id, memberId: dana.id, access: 'editor' })
  await s.removeMember(dana.id)
  assert.deepEqual(await s.listTeamMembers(web.id), [], 'leaving the org leaves its teams')
  await s.deleteTeam(web.id)
  assert.equal(await s.teamById(org.id, web.id), null)
})

test('invites: stored by hash, listed while open, claimed once, never after cancelling', async () => {
  const s = setup()
  const org = await newOrg(s)
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  const i = await s.createInvite({ orgId: org.id, email: 'new@acme.com', roleId: memberRole, tokenHash: 'h1', invitedBy: 'u1', expiresAt: Date.now() + 1000 })
  assert.deepEqual([i.acceptedAt, i.cancelledAt], [null, null])
  assert.equal((await s.inviteByToken('h1')).id, i.id)
  assert.equal((await s.inviteById(org.id, i.id)).email, 'new@acme.com')
  assert.equal(await s.roleInUse(memberRole), true, 'an open invite holds its role')
  assert.equal((await s.updateInvite(i.id, { tokenHash: 'h2' })).tokenHash, 'h2')
  assert.equal(await s.inviteByToken('h1'), null)
  assert.equal(await s.claimInvite(i.id), true)
  assert.equal(await s.claimInvite(i.id), false)
  assert.deepEqual(await s.listInvites(org.id), [])
  const j = await s.createInvite({ orgId: org.id, email: 'x@acme.com', roleId: memberRole, tokenHash: 'h3', invitedBy: 'u1', expiresAt: Date.now() + 1000 })
  assert.deepEqual((await s.listInvites(org.id)).map((x) => x.id), [j.id])
  await s.updateInvite(j.id, { cancelledAt: Date.now() })
  assert.equal(await s.claimInvite(j.id), false)
})

test('claimInvite refuses an invite once it has expired, even if it was never cancelled', async () => {
  let clock = Date.now()
  const s = createMemoryStore({ now: () => clock })
  s.addUser('u1', { name: 'Dana', email: 'dana@acme.com' })
  const org = await newOrg(s)
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  const i = await s.createInvite({ orgId: org.id, email: 'late@acme.com', roleId: memberRole, tokenHash: 'hlate', invitedBy: 'u1', expiresAt: clock + 1000 })
  clock += 1001
  assert.equal(await s.claimInvite(i.id), false, 'an expired invite cannot be claimed, even though it was neither accepted nor cancelled')
})

test('join requests: one pending per person per org, decided once', async () => {
  const s = setup()
  const org = await newOrg(s)
  const r = await s.createJoinRequest({ orgId: org.id, userId: 'u2', email: 'eli@acme.com' })
  assert.equal(r.status, 'pending')
  assert.equal((await s.createJoinRequest({ orgId: org.id, userId: 'u2', email: 'eli@acme.com' })).id, r.id)
  assert.deepEqual((await s.listJoinRequests(org.id)).map((x) => [x.name, x.email]), [['Eli', 'eli@acme.com']])
  assert.equal((await s.joinRequestById(org.id, r.id)).userId, 'u2')
  assert.equal(await s.decideJoinRequest(r.id, { status: 'denied', decidedBy: 'u1' }), true)
  assert.equal(await s.decideJoinRequest(r.id, { status: 'approved', decidedBy: 'u1' }), false)
  assert.deepEqual(await s.listJoinRequests(org.id), [])
  assert.deepEqual((await s.joinRequestsForUser('u2')).map((x) => x.status), ['denied'])
  assert.notEqual((await s.createJoinRequest({ orgId: org.id, userId: 'u2', email: 'eli@acme.com' })).id, r.id, 'can ask again after a decision')
})
