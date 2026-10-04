import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg } from './api-helpers.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

test('the member list shows names, emails, roles and teams to people with Members: Read', async () => {
  const o = await makeOrg(t, 'List Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  await t.store.addTeamMember({ teamId: core.id, memberId: o.mem.id, access: 'editor' })
  const r = await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'admin')
  assert.equal(r.status, 200)
  const mo = r.body.members.find((m) => m.userId === 'mem')
  assert.deepEqual([mo.name, mo.email, mo.role, mo.isOwner, mo.isYou], ['Mo', 'mo@acme.com', 'Member', false, false])
  assert.deepEqual(mo.teams, [{ id: core.id, name: 'Core', access: 'editor', scopes: [] }])
  assert.equal(mo.kind, 'person')
  assert.equal(r.body.members.find((m) => m.userId === 'owner').isOwner, true)
  assert.equal(r.body.members.find((m) => m.userId === 'admin').isYou, true)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'mem')).status, 403)
})

test('changing roles: Members and Roles Update, never your own, never the owner, only within your grid', async () => {
  const o = await makeOrg(t, 'Roles Co')
  // Member now holds Workspaces: Read, so a role that hands out Member must too.
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { members: { r: true, u: true }, roles: { r: true, u: true }, teams: { r: true }, workspaces: { r: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: lead.id })
  const put = (who, id, roleId) => t.call('PUT', `/v1/orgs/${o.slug}/members/${id}`, { roleId }, who)
  const ok = await put('admin', o.mem.id, lead.id)
  assert.deepEqual([ok.status, ok.body.member.roleId], [200, lead.id])
  assert.equal((await put('admin', o.mem.id, o.role('member').id)).status, 200)
  assert.equal((await put('admin', o.admin.id, o.role('member').id)).status, 403, 'not your own role')
  assert.equal((await put('admin', o.owner.id, o.role('member').id)).status, 403, 'not the owner')
  assert.equal((await put('admin', o.mem.id, o.role('owner').id)).status, 403, 'nobody is given Owner')
  assert.equal((await put('lim', o.mem.id, o.role('admin').id)).status, 403, 'Admin holds more than Lead')
  assert.equal((await put('lim', o.admin.id, o.role('member').id)).status, 403, 'the admin outranks Lead')
  assert.equal((await put('lim', o.mem.id, lead.id)).status, 200, 'Lead can hand out Lead')
  assert.equal((await put('admin', 'not-a-uuid', o.role('member').id)).status, 404)
  assert.equal((await put('admin', o.mem.id, 'not-a-uuid')).status, 404)
})

test('removing people needs Members: Delete; anyone but the owner may leave', async () => {
  const o = await makeOrg(t, 'Leave Co')
  const del = (who, id) => t.call('DELETE', `/v1/orgs/${o.slug}/members/${id}`, null, who)
  assert.equal((await del('mem', o.admin.id)).status, 403)
  assert.equal((await del('admin', o.owner.id)).status, 403)
  assert.equal((await del('owner', o.owner.id)).status, 403, 'the owner transfers first')
  assert.equal((await del('mem', o.mem.id)).status, 200, 'leaving')
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'mem')).status, 404)
  assert.equal((await del('owner', o.admin.id)).status, 200)
  assert.equal((await del('owner', o.admin.id)).status, 404)
})

test('teams: create, rename and delete need the Teams checkboxes; names are unique in an org', async () => {
  const o = await makeOrg(t, 'Team Co')
  const made = await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Core' }, 'admin')
  assert.deepEqual([made.status, made.body.team.name], [200, 'Core'])
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Core' }, 'admin')).status, 409)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: '' }, 'admin')).status, 400)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Mine' }, 'mem')).status, 403)
  const id = made.body.team.id
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/teams/${id}`, { name: 'Platform' }, 'mem')).status, 403)
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/teams/${id}`, { name: 'Platform' }, 'admin')).body.team.name, 'Platform')
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/teams/${id}`, null, 'mem')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/teams/${id}`, null, 'admin')).status, 200)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/teams/${id}`, null, 'admin')).status, 404)
})

test('team membership: add, change access and remove; people always see their own teams', async () => {
  const o = await makeOrg(t, 'Web Co')
  const web = (await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Web' }, 'admin')).body.team
  const ops = (await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Ops' }, 'admin')).body.team
  const base = `/v1/orgs/${o.slug}/teams/${web.id}/members`
  assert.equal((await t.call('POST', base, { memberId: o.mem.id, access: 'owner' }, 'admin')).status, 400)
  assert.equal((await t.call('POST', base, { memberId: o.mem.id, access: 'viewer' }, 'mem')).status, 403)
  assert.equal((await t.call('POST', base, { memberId: o.mem.id }, 'admin')).body.member.access, 'viewer', 'viewer by default')
  const other = await makeOrg(t, 'Other Co')
  assert.equal((await t.call('POST', base, { memberId: other.mem.id, access: 'viewer' }, 'admin')).status, 404, 'only members of this org')

  const seen = await t.call('GET', `/v1/orgs/${o.slug}/teams`, null, 'mem')
  const w = seen.body.teams.find((x) => x.id === web.id)
  assert.equal(w.access, 'viewer')
  assert.deepEqual(w.members, [{ memberId: o.mem.id, name: 'Mo', access: 'viewer', kind: 'person', scopes: [] }])
  assert.equal(seen.body.teams.find((x) => x.id === ops.id).members, null, "Members see other teams' names, not who's in them")
  assert.equal(seen.body.people, null)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/teams`, null, 'admin')).body.people.length, 3)

  // Without Teams: Read, you see only the teams you're in.
  await t.store.updateRole(o.role('member').id, { grants: {} })
  assert.deepEqual((await t.call('GET', `/v1/orgs/${o.slug}/teams`, null, 'mem')).body.teams.map((x) => x.name), ['Web'])

  assert.equal((await t.call('PUT', `${base}/${o.mem.id}`, { access: 'editor' }, 'admin')).body.member.access, 'editor')
  assert.equal((await t.call('PUT', `${base}/${o.admin.id}`, { access: 'editor' }, 'admin')).status, 404, 'not in the team')
  assert.equal((await t.call('DELETE', `${base}/${o.mem.id}`, null, 'admin')).status, 200)
  assert.equal((await t.call('DELETE', `${base}/${o.mem.id}`, null, 'admin')).status, 404)
  assert.equal((await t.call('POST', `/v1/orgs/${other.slug}/teams/${web.id}/members`, { memberId: other.mem.id, access: 'viewer' }, 'owner')).status, 404, "another org's team")
})

test('re-adding someone already in the team is refused, even with Create alone', async () => {
  const o = await makeOrg(t, 'Readd Co')
  const web = (await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Web' }, 'admin')).body.team
  const base = `/v1/orgs/${o.slug}/teams/${web.id}/members`
  assert.equal((await t.call('POST', base, { memberId: o.mem.id, access: 'viewer' }, 'admin')).status, 200)
  const again = await t.call('POST', base, { memberId: o.mem.id, access: 'editor' }, 'admin')
  assert.equal(again.status, 409)
  // Create alone (no Update) must not be able to restyle access by re-adding.
  const creator = await t.store.createRole({ orgId: o.org.id, name: 'Adder', grants: { team_members: { c: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: creator.id })
  assert.equal((await t.call('POST', base, { memberId: o.mem.id, access: 'editor' }, 'lim')).status, 409)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/teams`, null, 'admin')).body.teams.find((x) => x.id === web.id).members[0].access, 'viewer', 'access is unchanged')
})

test('removing someone who outranks you is refused even with Members: Delete', async () => {
  const o = await makeOrg(t, 'Guard Co')
  const guard = await t.store.createRole({ orgId: o.org.id, name: 'Guard', grants: { members: { d: true }, teams: { r: true }, workspaces: { r: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: guard.id })
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/members/${o.admin.id}`, null, 'lim')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/members/${o.mem.id}`, null, 'lim')).status, 200, "a peer within Guard's grid can still be removed")
})

test('team membership: Update and Delete each need their own checkbox', async () => {
  const o = await makeOrg(t, 'Checkbox Co')
  const web = (await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Web' }, 'admin')).body.team
  const base = `/v1/orgs/${o.slug}/teams/${web.id}/members`
  await t.call('POST', base, { memberId: o.mem.id, access: 'viewer' }, 'admin')
  assert.equal((await t.call('PUT', `${base}/${o.mem.id}`, { access: 'editor' }, 'mem')).status, 403, 'no Team membership: Update')
  assert.equal((await t.call('DELETE', `${base}/${o.mem.id}`, null, 'mem')).status, 403, 'no Team membership: Delete')
})

test('invalid access on PUT team member is a 400', async () => {
  const o = await makeOrg(t, 'Badaccess Co')
  const web = (await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Web' }, 'admin')).body.team
  const base = `/v1/orgs/${o.slug}/teams/${web.id}/members`
  await t.call('POST', base, { memberId: o.mem.id, access: 'viewer' }, 'admin')
  assert.equal((await t.call('PUT', `${base}/${o.mem.id}`, { access: 'owner' }, 'admin')).status, 400)
})

test('the member list only shows teams to people with Team membership: Read', async () => {
  const o = await makeOrg(t, 'Teamsview Co')
  const web = await t.store.createTeam({ orgId: o.org.id, name: 'Web' })
  await t.store.addTeamMember({ teamId: web.id, memberId: o.mem.id, access: 'editor' })
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { members: { r: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: lead.id })
  const r = await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'lim')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.members.find((m) => m.userId === 'mem').teams, [])
})

test('cross-org ids answer 404 on every id-taking member and team route', async () => {
  const o = await makeOrg(t, 'Cross Co')
  const other = await makeOrg(t, 'Cross Other Co')
  const web = (await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Web' }, 'admin')).body.team
  const otherTeam = (await t.call('POST', `/v1/orgs/${other.slug}/teams`, { name: 'Other Team' }, 'admin')).body.team
  await t.call('POST', `/v1/orgs/${o.slug}/teams/${web.id}/members`, { memberId: o.mem.id, access: 'viewer' }, 'admin')

  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/members/${other.mem.id}`, { roleId: o.role('member').id }, 'admin')).status, 404, "another org's member, PUT")
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/members/${other.mem.id}`, null, 'admin')).status, 404, "another org's member, DELETE")
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/teams/${otherTeam.id}`, { name: 'Renamed' }, 'admin')).status, 404, "another org's team, PUT")
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/teams/${otherTeam.id}`, null, 'admin')).status, 404, "another org's team, DELETE")
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/teams/${otherTeam.id}/members/${o.mem.id}`, { access: 'editor' }, 'admin')).status, 404, "another org's team in the path, PUT")
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/teams/${otherTeam.id}/members/${o.mem.id}`, null, 'admin')).status, 404, "another org's team in the path, DELETE")
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/teams/${web.id}/members/${other.mem.id}`, { access: 'editor' }, 'admin')).status, 404, "another org's member in the path, PUT")
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/teams/${web.id}/members/${other.mem.id}`, null, 'admin')).status, 404, "another org's member in the path, DELETE")
})

test('PUT /members/:id with no roleId is a 404 and leaves the role unchanged', async () => {
  const o = await makeOrg(t, 'Noroleid Co')
  const before = await t.store.memberById(o.org.id, o.mem.id)
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/members/${o.mem.id}`, {}, 'admin')).status, 404)
  const after = await t.store.memberById(o.org.id, o.mem.id)
  assert.equal(after.roleId, before.roleId)
})
