import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowed, assignableRoles, inviteGone, isInviteToken, orgTabs, peopleNotIn, safeMessage, when } from '../lib/org-view.js'

const owner = { isOwner: true, grants: {} }
const member = { isOwner: false, grants: { teams: { r: true } } }

test('allowed: the owner may do everything, others what their grid says', () => {
  assert.equal(allowed(owner, 'roles', 'd'), true)
  assert.equal(allowed(member, 'teams', 'r'), true)
  assert.equal(allowed(member, 'teams', 'c'), false)
  assert.equal(allowed(null, 'teams', 'r'), false)
})

test('orgTabs shows only what the viewer can read', () => {
  assert.deepEqual(orgTabs('acme', member).map((t) => t.label), ['Overview', 'Teams'])
  assert.deepEqual(orgTabs('acme', owner).map((t) => t.label), ['Overview', 'People', 'Teams', 'Workspaces', 'Roles', 'Invites', 'Settings'])
  assert.deepEqual(orgTabs('acme', owner).map((t) => t.href), ['/org/acme', '/org/acme/people', '/org/acme/teams', '/org/acme/workspaces', '/org/acme/roles', '/org/acme/invites', '/org/acme/settings'])
})

test('orgTabs shows Workspaces only to those who can read it', () => {
  const canSee = { isOwner: false, grants: { workspaces: { r: true } } }
  assert.deepEqual(orgTabs('acme', canSee).map((t) => t.label), ['Overview', 'Teams', 'Workspaces'])
  assert.equal(orgTabs('acme', canSee).find((t) => t.label === 'Workspaces').href, '/org/acme/workspaces')
  assert.equal(orgTabs('acme', member).some((t) => t.label === 'Workspaces'), false)
})

test('orgTabs shows People to those who may read agents, even without Members: Read', () => {
  const watcher = { isOwner: false, grants: { agents: { r: true } } }
  assert.deepEqual(orgTabs('acme', watcher).map((t) => t.label), ['Overview', 'People', 'Teams'])
})

test('safeMessage shows our own messages and nothing odd', () => {
  assert.equal(safeMessage(undefined), null)
  assert.equal(safeMessage("your role doesn't allow that"), "your role doesn't allow that")
  assert.equal(safeMessage('this invite is for a@acme.com; sign in with that address'), 'this invite is for a@acme.com; sign in with that address')
  assert.equal(safeMessage('<script>x</script>'), 'Something went wrong. Try again.')
  assert.equal(safeMessage('x'.repeat(201)), 'Something went wrong. Try again.')
  assert.equal(safeMessage(['a']), 'Something went wrong. Try again.')
})

test('when shows a labelled UTC time for epoch ms or ISO strings, without throwing', () => {
  const ms = Date.parse('2026-10-01T12:00:00Z')
  assert.equal(when(ms), 'Oct 1, 2026, 12:00 PM UTC')
  assert.equal(when('2026-10-01T12:00:00Z'), when(ms))
  assert.equal(when(null), 'never')
})

test('assignableRoles: never Owner, and only roles within your own grid', () => {
  const roles = [
    { id: 'o', builtin: 'owner', grants: {} },
    { id: 'a', builtin: 'admin', grants: { roles: { r: true, u: true }, members: { d: true } } },
    { id: 'm', builtin: 'member', grants: { teams: { r: true } } },
    { id: 'l', builtin: null, grants: { teams: { r: true, c: true } } }
  ]
  assert.deepEqual(assignableRoles(roles, owner).map((r) => r.id), ['a', 'm', 'l'])
  const lead = { isOwner: false, grants: { teams: { r: true, c: true }, roles: { r: true, u: true } } }
  assert.deepEqual(assignableRoles(roles, lead).map((r) => r.id), ['m', 'l'])
  assert.deepEqual(assignableRoles(undefined, lead), [])
})

test('inviteGone explains an invite that can no longer be used', () => {
  assert.equal(inviteGone('pending'), null)
  assert.equal(inviteGone('accepted'), 'This invite was already used.')
  assert.equal(inviteGone('cancelled'), 'This invite was cancelled.')
  assert.equal(inviteGone('expired'), 'This invite has expired. Ask for a new one.')
  assert.equal(inviteGone('toString'), null)
})

test('isInviteToken checks the shape before it reaches the API', () => {
  const valid = `qi_${'A'.repeat(43)}`
  assert.equal(isInviteToken(valid), true)
  assert.equal(isInviteToken('..'), false)
  assert.equal(isInviteToken('.'), false)
  assert.equal(isInviteToken(`xx_${'A'.repeat(43)}`), false)
  assert.equal(isInviteToken(`qi_${'A'.repeat(42)}`), false)
  assert.equal(isInviteToken(`qi_${'A'.repeat(44)}`), false)
  assert.equal(isInviteToken(`qi_${'A'.repeat(42)}!`), false)
  assert.equal(isInviteToken(undefined), false)
})

test('peopleNotIn leaves out people already in the team', () => {
  const people = [{ memberId: 'a', name: 'Ada' }, { memberId: 'b', name: 'Bo' }]
  assert.deepEqual(peopleNotIn(people, [{ memberId: 'a', access: 'editor' }]), [{ memberId: 'b', name: 'Bo' }])
  assert.deepEqual(peopleNotIn(people, null), people)
  assert.deepEqual(peopleNotIn(null, []), [])
})
