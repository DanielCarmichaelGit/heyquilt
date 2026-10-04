import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, SITE } from './api-helpers.js'
import { hashToken } from '../src/api/tokens.js'
import { inviteEmail } from '../src/api/invite-email.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

const tokenIn = (mail) => mail.text.match(/\/invite\/(qi_[A-Za-z0-9_-]+)/)[1]
const invite = (o, email, who = 'admin', roleId) => t.call('POST', `/v1/orgs/${o.slug}/invites`, { email, ...(roleId ? { roleId } : {}) }, who)

test('the invite email names the org, the inviter and the role, and carries the link', () => {
  const m = inviteEmail({ orgName: 'Acme', inviterName: 'Ada', roleName: 'Member', link: 'https://quilt.test/invite/qi_x' })
  assert.equal(m.subject, 'Ada invited you to Acme on Quilt')
  assert.match(m.text, /join Acme on Quilt as Member/)
  assert.match(m.text, /https:\/\/quilt\.test\/invite\/qi_x/)
  assert.match(m.text, /7 days/)
  assert.equal(inviteEmail({ orgName: 'Acme', roleName: 'Member', link: 'l' }).subject, 'Someone invited you to Acme on Quilt')
})

test('inviting emails a qi_ link; only its hash is stored', async () => {
  const o = await makeOrg(t, 'Invite Co')
  const r = await invite(o, ' New@Acme.com ')
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.invite.email, r.body.invite.role, r.body.invite.expired], ['new@acme.com', 'Member', false])
  const mail = t.sent.at(-1)
  assert.equal(mail.to, 'new@acme.com')
  assert.equal(mail.subject, 'Ada invited you to Invite Co on Quilt')
  assert.ok(mail.text.includes(`${SITE}/invite/qi_`))
  const token = tokenIn(mail)
  const stored = await t.store.inviteByToken(hashToken(token))
  assert.equal(stored.id, r.body.invite.id)
  assert.notEqual(stored.tokenHash, token)
  assert.equal(JSON.stringify(r.body).includes(token), false, 'the token only travels by email')
  assert.ok(stored.expiresAt - Date.now() > 6.9 * 24 * 3600e3, 'about 7 days')
  assert.equal((await invite(o, 'x@acme.com', 'mem')).status, 403)
  assert.equal((await invite(o, 'not an email')).status, 400)
  assert.equal((await invite(o, 'x@acme.com', 'admin', o.role('owner').id)).status, 403)
})

test('accepting needs the invited address, confirmed', async () => {
  const o = await makeOrg(t, 'Accept Co')
  await invite(o, 'newbie@acme.com')
  const token = tokenIn(t.sent.at(-1))
  t.store.addUser('newbie', { name: 'Newbie', email: 'Newbie@Acme.com' })
  t.store.addUser('newbie-unconfirmed', { name: 'Newbie', email: 'newbie@acme.com', confirmed: false })
  const accept = (who) => t.call('POST', '/v1/invites/accept', { token }, who)
  assert.equal((await accept()).status, 401)
  const wrong = await accept('out')
  assert.equal(wrong.status, 403)
  assert.match(wrong.body.error, /newbie@acme\.com/)
  assert.equal((await accept('newbie-unconfirmed')).status, 403)
  const ok = await accept('newbie')
  assert.deepEqual([ok.status, ok.body.org.slug], [200, o.slug])
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'newbie')).body.role.builtin, 'member')
  assert.equal((await accept('newbie')).status, 410, 'used once')
  assert.equal((await t.call('POST', '/v1/invites/accept', { token: 'qi_nope' }, 'newbie')).status, 404)
})

test('looking up an invite shows the org, role and status; cancelling needs User invites: Delete', async () => {
  const o = await makeOrg(t, 'Look Co')
  const made = await invite(o, 'look@acme.com')
  const token = tokenIn(t.sent.at(-1))
  const seen = await t.call('GET', `/v1/invites/${token}`, null, 'out')
  assert.deepEqual(seen.body, { org: { name: 'Look Co', slug: o.slug }, email: 'look@acme.com', role: 'Member', status: 'pending' })
  assert.equal((await t.call('GET', `/v1/invites/${token}`)).status, 401)
  const cancel = (who) => t.call('DELETE', `/v1/orgs/${o.slug}/invites/${made.body.invite.id}`, null, who)
  assert.equal((await cancel('mem')).status, 403)
  assert.equal((await cancel('admin')).status, 200)
  assert.equal((await t.call('GET', `/v1/invites/${token}`, null, 'out')).body.status, 'cancelled')
  assert.equal((await cancel('admin')).status, 404)
})

test('invites expire after 7 days; resending sends a fresh link and retires the old one', async () => {
  let clock = Date.parse('2026-10-01T00:00:00Z')
  const c = await startTestApi({ now: () => clock })
  try {
    const o = await makeOrg(c, 'Clock Co')
    c.store.addUser('late', { name: 'Late', email: 'late@acme.com' })
    const made = await c.call('POST', `/v1/orgs/${o.slug}/invites`, { email: 'late@acme.com' }, 'admin')
    const first = tokenIn(c.sent.at(-1))
    clock += 7 * 24 * 3600e3 + 1
    assert.equal((await c.call('GET', `/v1/invites/${first}`, null, 'late')).body.status, 'expired')
    assert.equal((await c.call('POST', '/v1/invites/accept', { token: first }, 'late')).status, 410)
    assert.equal((await c.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'admin')).body.invites[0].expired, true)
    const resend = (who) => c.call('POST', `/v1/orgs/${o.slug}/invites/${made.body.invite.id}/resend`, {}, who)
    assert.equal((await resend('mem')).status, 403)
    const again = await resend('admin')
    assert.deepEqual([again.status, again.body.invite.expired], [200, false])
    const second = tokenIn(c.sent.at(-1))
    assert.notEqual(second, first)
    assert.equal((await c.call('POST', '/v1/invites/accept', { token: first }, 'late')).status, 404, 'the old link is gone')
    assert.equal((await c.call('POST', '/v1/invites/accept', { token: second }, 'late')).status, 200)
  } finally { await c.close() }
})

test('a second invite to an address that already has an open one is refused, not a replacement', async () => {
  const o = await makeOrg(t, 'Twice Co')
  await invite(o, 'twice@acme.com')
  const first = tokenIn(t.sent.at(-1))
  const again = await invite(o, 'twice@acme.com')
  assert.equal(again.status, 409)
  assert.match(again.body.error, /already has an open invite/)
  const list = await t.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'admin')
  assert.equal(list.body.invites.filter((i) => i.email === 'twice@acme.com').length, 1)
  t.store.addUser('twice', { name: 'Twice', email: 'twice@acme.com' })
  assert.equal((await t.call('POST', '/v1/invites/accept', { token: first }, 'twice')).status, 200, 'the first invite is still open')
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'mem')).status, 403)
})

test('a narrow inviter cannot replace someone else\'s pending invite by sending a new one', async () => {
  const o = await makeOrg(t, 'Guard Co')
  // A Member who can also send invites (create only, no update/delete on invites).
  // Member now holds Workspaces: Read, so a role that hands out Member must too.
  const inviter = await t.store.createRole({ orgId: o.org.id, name: 'Narrow Inviter', grants: { invites: { c: true }, teams: { r: true }, workspaces: { r: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: inviter.id })
  const owner = await invite(o, 'target@acme.com', 'owner', o.role('admin').id)
  assert.equal(owner.status, 200)
  const narrow = await invite(o, 'target@acme.com', 'lim')
  assert.equal(narrow.status, 409)
  const list = await t.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'admin')
  const stillOpen = list.body.invites.find((i) => i.email === 'target@acme.com')
  assert.deepEqual([stillOpen.id, stillOpen.role, stillOpen.expired], [owner.body.invite.id, 'Admin', false], 'the owner\'s Admin invite was never touched')
})

test('when the email fails to send, the invite is kept and the caller is told', async () => {
  const lines = []
  const c = await startTestApi({ mailer: { send: async () => { throw new Error('smtp down') } }, log: (l) => lines.push(l) })
  try {
    const o = await makeOrg(c, 'Mail Co')
    const r = await c.call('POST', `/v1/orgs/${o.slug}/invites`, { email: 'm@acme.com' }, 'admin')
    assert.equal(r.status, 502)
    assert.match(r.body.error, /Resend/)
    assert.equal((await c.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'admin')).body.invites.length, 1)
    assert.match(lines.join('\n'), /smtp down/)
  } finally { await c.close() }
})

test('domain requests: people on the org domain find it, ask once, and an approver lets them in', async () => {
  const o = await makeOrg(t, 'Domain Co')
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}`, { domain: 'acme.com', domainRequests: true }, 'owner')).status, 200)
  t.store.addUser('jo', { name: 'Jo', email: 'Jo@Acme.com' })
  const found = await t.call('GET', '/v1/orgs/discover', null, 'jo')
  assert.equal(found.body.domain, 'acme.com')
  assert.deepEqual(found.body.orgs.find((x) => x.slug === o.slug), { name: 'Domain Co', slug: o.slug, requested: false })
  const asked = await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, 'jo')
  assert.deepEqual([asked.status, asked.body.request.status], [200, 'pending'])
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, 'jo')).body.request.id, asked.body.request.id, 'asking twice is one request')
  assert.equal((await t.call('GET', '/v1/orgs/discover', null, 'jo')).body.orgs.find((x) => x.slug === o.slug).requested, true)
  const list = await t.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'admin')
  assert.deepEqual(list.body.requests.map((r) => [r.name, r.email]), [['Jo', 'jo@acme.com']])
  const decide = (who, body) => t.call('POST', `/v1/orgs/${o.slug}/requests/${asked.body.request.id}`, body, who)
  assert.equal((await decide('mem', { approve: true })).status, 403)
  assert.equal((await decide('admin', { approve: true, roleId: o.role('owner').id })).status, 403, 'never Owner')
  assert.equal((await decide('admin', { approve: true })).body.status, 'approved')
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'jo')).body.role.builtin, 'member')
  assert.equal((await decide('admin', { approve: true })).status, 404, 'decided once')
  assert.equal((await t.call('GET', '/v1/orgs/discover', null, 'jo')).body.orgs.some((x) => x.slug === o.slug), false, 'joined orgs drop out')
})

test('public, unconfirmed or other-domain people never see or ask to join', async () => {
  const o = await makeOrg(t, 'Closed Co')
  await t.call('PUT', `/v1/orgs/${o.slug}`, { domain: 'acme.com', domainRequests: true }, 'owner')
  assert.deepEqual((await t.call('GET', '/v1/orgs/discover', null, 'gm')).body, { domain: null, orgs: [] })
  assert.deepEqual((await t.call('GET', '/v1/orgs/discover', null, 'unconf')).body, { domain: null, orgs: [] })
  assert.deepEqual((await t.call('GET', '/v1/orgs/discover', null, 'out')).body.orgs, [])
  for (const who of ['gm', 'unconf', 'out']) assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, who)).status, 404, who)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, 'mem')).status, 409, 'already in')
  const quiet = await makeOrg(t, 'Quiet Co')
  await t.call('PUT', `/v1/orgs/${quiet.slug}`, { domain: 'acme.com' }, 'owner')
  t.store.addUser('q', { name: 'Q', email: 'q@acme.com' })
  assert.equal((await t.call('POST', `/v1/orgs/${quiet.slug}/requests`, {}, 'q')).status, 404, 'requests are off')
})

test('denying a request needs User invites: Delete, and adds no one', async () => {
  const o = await makeOrg(t, 'Deny Co')
  await t.call('PUT', `/v1/orgs/${o.slug}`, { domain: 'acme.com', domainRequests: true }, 'owner')
  t.store.addUser('nope', { name: 'Nope', email: 'nope@acme.com' })
  const asked = await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, 'nope')
  const decide = (who, approve) => t.call('POST', `/v1/orgs/${o.slug}/requests/${asked.body.request.id}`, { approve }, who)
  const inviter = await t.store.createRole({ orgId: o.org.id, name: 'Inviter', grants: { invites: { c: true, r: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: inviter.id })
  assert.equal((await decide('lim', false)).status, 403, 'denying is Delete')
  assert.equal((await decide('admin', false)).body.status, 'denied')
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'nope')).status, 404)
  assert.equal((await decide('admin', true)).status, 404, 'already decided')
})

test('an invite address must be exactly one recipient, never a list', async () => {
  const o = await makeOrg(t, 'Strict Co')
  assert.equal((await invite(o, 'a@x.com,b@y.com')).status, 400, 'comma-joined addresses are refused')
  assert.equal((await invite(o, 'a@x.com;b@y.com')).status, 400, 'semicolon-joined addresses are refused')
  assert.equal((await invite(o, '<a@x.com>')).status, 400, 'angle brackets are refused')
  assert.equal((await invite(o, 'a@x.com@y.com')).status, 400, 'two @ signs are refused')
})

test('inviting or accepting into a membership you already hold is refused', async () => {
  const o = await makeOrg(t, 'Belong Co')
  // mem is already a member, under mo@acme.com: inviting that address again is refused.
  assert.equal((await invite(o, 'Mo@Acme.com')).status, 409)
  // A pending invite still can't be accepted by someone who joined the org some other way first.
  const made = await invite(o, 'joined@acme.com')
  const token = tokenIn(t.sent.at(-1))
  t.store.addUser('joined', { name: 'Joined', email: 'joined@acme.com' })
  await t.store.addMember({ orgId: o.org.id, userId: 'joined', roleId: o.role('member').id })
  assert.equal((await t.call('POST', '/v1/invites/accept', { token }, 'joined')).status, 409)
})

test('resending needs the invite\'s role to still exist and to be within the caller\'s own grants', async () => {
  const o = await makeOrg(t, 'Cover Co')
  const inviter = await t.store.createRole({ orgId: o.org.id, name: 'Inviter3', grants: { invites: { c: true, r: true, u: true, d: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: inviter.id })
  const made = await t.call('POST', `/v1/orgs/${o.slug}/invites`, { email: 'cover@acme.com', roleId: o.role('admin').id }, 'owner')
  const resend = (who) => t.call('POST', `/v1/orgs/${o.slug}/invites/${made.body.invite.id}/resend`, {}, who)
  assert.equal((await resend('lim')).status, 403, 'lim cannot resend an invite for a role bigger than their own')
  await t.store.updateInvite(made.body.invite.id, { roleId: '00000000-0000-0000-0000-000000000000' })
  assert.equal((await resend('admin')).status, 404, 'the role behind the invite is gone')
})

test('approving or denying a join request needs an explicit true or false', async () => {
  const o = await makeOrg(t, 'Bool Co')
  await t.call('PUT', `/v1/orgs/${o.slug}`, { domain: 'acme.com', domainRequests: true }, 'owner')
  t.store.addUser('boolguy', { name: 'Bool', email: 'boolguy@acme.com' })
  const asked = await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, 'boolguy')
  const decide = (body) => t.call('POST', `/v1/orgs/${o.slug}/requests/${asked.body.request.id}`, body, 'admin')
  assert.equal((await decide({})).status, 400)
  assert.equal((await decide({ approve: 'yes' })).status, 400)
  assert.equal((await decide({ approve: 1 })).status, 400)
})

test('sending or resending invites is rate-limited per caller, not per org', async () => {
  const c = await startTestApi({ inviteSendLimit: 2 })
  try {
    const o = await makeOrg(c, 'Rate Co')
    const send = (email) => c.call('POST', `/v1/orgs/${o.slug}/invites`, { email }, 'admin')
    assert.equal((await send('one@acme.com')).status, 200)
    assert.equal((await send('two@acme.com')).status, 200)
    assert.equal((await send('three@acme.com')).status, 429)
    // A different org, same caller: still the same per-caller budget.
    const o2 = await makeOrg(c, 'Rate Co Two')
    assert.equal((await c.call('POST', `/v1/orgs/${o2.slug}/invites`, { email: 'four@acme.com' }, 'admin')).status, 429)
  } finally { await c.close() }
})

test('invite lookups and acceptances are rate-limited per address', async () => {
  const c = await startTestApi({ inviteLimit: 2, trustProxy: true })
  try {
    const go = (ip) => c.call('POST', '/v1/invites/accept', { token: 'qi_nope' }, 'out', { 'fly-client-ip': ip })
    assert.equal((await go('203.0.113.9')).status, 404)
    assert.equal((await go('203.0.113.9')).status, 404)
    assert.equal((await go('203.0.113.9')).status, 429)
    assert.equal((await go('203.0.113.10')).status, 404, 'another address has its own limit')
  } finally { await c.close() }
})
