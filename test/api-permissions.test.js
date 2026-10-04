import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPS, ALLOWED, RESOURCES, LABELS, can, isSubset, normalizeGrants, BUILTIN } from '../src/api/permissions.js'
import { emailDomain, isDomain, isPublicDomain } from '../src/api/domains.js'
import { slugify, uniqueSlug } from '../src/api/slugs.js'

test('the grid has the spec rows, and only the cells the spec gives checkboxes', () => {
  assert.deepEqual(OPS, ['c', 'r', 'u', 'd'])
  assert.deepEqual(RESOURCES, ['org', 'members', 'agents', 'teams', 'team_members', 'invites', 'roles', 'workspaces', 'billing'])
  assert.deepEqual(ALLOWED.org, ['r', 'u'])
  assert.deepEqual(ALLOWED.members, ['r', 'u', 'd'])
  for (const r of ['agents', 'teams', 'team_members', 'invites', 'roles', 'workspaces']) assert.deepEqual(ALLOWED[r], ['c', 'r', 'u', 'd'], r)
  assert.deepEqual(ALLOWED.billing, [], 'reserved for per-seat plans')
  assert.equal(LABELS.team_members, 'Team membership')
  assert.equal(LABELS.invites, 'User invites')
})

test('can: only real cells, only when granted', () => {
  assert.equal(can({ org: { r: true } }, 'org', 'r'), true)
  assert.equal(can({ org: { c: true } }, 'org', 'c'), false, 'Org settings has no Create')
  assert.equal(can({ members: { c: true } }, 'members', 'c'), false, 'people join via invites')
  assert.equal(can({}, 'teams', 'r'), false)
  assert.equal(can(null, 'teams', 'r'), false)
  assert.equal(can({ nope: { r: true } }, 'nope', 'r'), false)
  assert.equal(can({ teams: { r: 'true' } }, 'teams', 'r'), true)
  assert.equal(can({ teams: { r: 'false' } }, 'teams', 'r'), false)
})

test('normalizeGrants drops unknown rows and ops and coerces checkbox values', () => {
  assert.deepEqual(
    normalizeGrants({ org: { r: 'on', u: false, c: true }, teams: { r: 1, x: true }, bogus: { r: true }, members: 'yes', billing: { r: true } }),
    { org: { r: true }, teams: { r: true } }
  )
  assert.deepEqual(normalizeGrants(null), {})
  assert.deepEqual(normalizeGrants([]), {})
  assert.deepEqual(normalizeGrants({ __proto__: { r: true } }), {})
})

test('isSubset is the no-self-promotion rule', () => {
  assert.equal(isSubset({ teams: { r: true } }, BUILTIN.admin), true)
  assert.equal(isSubset(BUILTIN.admin, { teams: { r: true } }), false)
  assert.equal(isSubset({}, {}), true)
  assert.equal(isSubset({ org: { c: true } }, {}), true, 'a cell that is not an op grants nothing')
  assert.equal(isSubset({ roles: { c: true, r: true } }, { roles: { r: true } }), false)
})

test('built-in roles: Owner and Admin hold every checkbox, Member only Teams: Read', () => {
  assert.deepEqual(BUILTIN.owner, BUILTIN.admin)
  for (const r of RESOURCES) for (const op of ALLOWED[r]) assert.equal(can(BUILTIN.admin, r, op), true, `${r}.${op}`)
  assert.equal('billing' in BUILTIN.admin, false)
  assert.deepEqual(BUILTIN.member, { teams: { r: true }, workspaces: { r: true } })
})

test('the Workspaces row is labelled', () => { assert.equal(LABELS.workspaces, 'Workspaces') })

test('emailDomain and isDomain', () => {
  assert.equal(emailDomain('Dana@Acme.COM'), 'acme.com')
  assert.equal(emailDomain(' a@b@c.io '), 'c.io')
  assert.equal(emailDomain('nope'), '')
  assert.equal(emailDomain('@acme.com'), '')
  assert.equal(emailDomain('x@localhost'), '')
  assert.equal(emailDomain(null), '')
  assert.equal(isDomain('eng.acme.co.uk'), true)
  assert.equal(isDomain('acme'), false)
  assert.equal(isDomain('-acme.com'), false)
})

test('public mail domains are never an org domain', () => {
  for (const d of ['gmail.com', 'GMAIL.COM', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'gmx.de', 'gmx.net', 'yandex.ru', 'yandex.com',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'mail.com',
    'zoho.com', 'fastmail.com', 'hey.com', 'qq.com', '163.com']) assert.equal(isPublicDomain(d), true, d)
  for (const d of ['acme.com', 'yahoo-inc.com', 'mygmail.com', 'eng.acme.io']) assert.equal(isPublicDomain(d), false, d)
})

test('slugify makes URL-safe slugs and avoids reserved words', () => {
  assert.equal(slugify('Acme, Inc.'), 'acme-inc')
  assert.equal(slugify('Café Ünïcode'), 'cafe-unicode')
  assert.equal(slugify('  '), 'org')
  assert.equal(slugify('---'), 'org')
  assert.equal(slugify('Personal'), 'personal-org')
  assert.equal(slugify('New'), 'new-org')
  assert.equal(slugify('Discover'), 'discover-org', '/v1/orgs/discover must never collide with an org slug')
  const long = slugify('a'.repeat(39) + ' b c')
  assert.ok(long.length <= 40 && !long.endsWith('-'), long)
  assert.match(slugify('Ω Rockets!! 2026'), /^[a-z0-9]+(-[a-z0-9]+)*$/)
})

test('uniqueSlug adds a number until the slug is free', async () => {
  const taken = new Set(['acme', 'acme-2'])
  assert.equal(await uniqueSlug('Acme', async (s) => taken.has(s)), 'acme-3')
  assert.equal(await uniqueSlug('Zeta', async (s) => taken.has(s)), 'zeta')
})
