// Session invites: the owner invites anyone by email, or people and agents they've
// worked with, as an access type. The grant is made at once; the link only goes into
// the email; a person's email is never shown.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi } from '../helpers/api-helpers.js'

let t
let clock = Date.parse('2026-10-02T12:00:00Z')
before(async () => { t = await startTestApi({ now: () => clock }) })
after(() => t.close())
const DAY = 24 * 60 * 60 * 1000
let rooms = 0
const start = (room, account, name, extra = {}) => ({ id: crypto.randomUUID(), type: 'start', room, account, name, at: clock - 60000, ...extra })

/** A session owned by Mo, where Lin and the agent Larry worked with him before. */
async function session () {
  const room = `inv-${++rooms}`
  const old = `old-${rooms}`
  await t.store.ingestPresence([
    start(old, 'person:mem', 'Mo', { owner: true }), start(old, 'person:lim', 'Lin'), start(old, 'agent:a1', 'Larry'),
    start(room, 'person:mem', 'Mo', { owner: true }),
    { id: crypto.randomUUID(), type: 'name', room, name: 'Pricing page', at: clock - 60000 }
  ], clock)
  return room
}
const link = (room) => `https://join.heyquilt.com/${room}#the-room-secret`
const invite = (room, body, userId = 'mem') => t.call('POST', `/v1/sessions/${room}/invites`, { link: link(room), typeId: 'builtin:edit', ...body }, userId)
const grants = async (room) => (await t.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')).body.grants.map((g) => [g.account, g.typeName])

test('an email invite makes a grant for the address and sends the link from hello@', async () => {
  const room = await session()
  t.sent.length = 0
  const res = await invite(room, { to: { email: ' Pat@Example.com ' }, typeId: 'builtin:view' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual({ ...res.body.invite, id: 'x', createdAt: 0 }, { id: 'x', email: 'pat@example.com', typeId: 'builtin:view', typeName: 'View only', status: 'waiting', createdAt: 0, expiresAt: clock + 7 * DAY })
  assert.deepEqual(await grants(room), [['email:pat@example.com', 'View only']])
  assert.equal(t.sent.length, 1)
  const [mail] = t.sent
  assert.equal(mail.to, 'pat@example.com')
  assert.equal(mail.from, 'Quilt <hello@hq.heyquilt.com>')
  assert.equal(mail.subject, 'Mo invited you to Pricing page on Quilt')
  for (const line of [`Join the session: ${link(room)}`, 'This invite expires in 7 days.', 'New to Quilt? Download the app from https://quilt.test, sign in with this email address, then open the link again.']) assert.ok(mail.text.includes(line), line)
  assert.doesNotMatch(mail.subject + mail.text, /—/)
  const again = await invite(room, { to: { email: 'pat@example.com' } })
  assert.deepEqual([again.status, again.body.error], [409, 'That address already has an open invite. Cancel it first.'])
  assert.ok(!JSON.stringify((await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body).includes('the-room-secret'), 'the link is never kept')
})

test("inviting someone you've worked with emails them, but never shows their email", async () => {
  const room = await session()
  t.sent.length = 0
  const res = await invite(room, { to: { account: 'person:lim' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual([res.body.invite.account, res.body.invite.name, res.body.invite.email], ['person:lim', 'Lin', undefined])
  assert.equal(t.sent[0].to, 'lin@acme.com')
  const list = await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')
  assert.ok(!JSON.stringify(list.body).includes('lin@acme.com'))
  assert.deepEqual(await grants(room), [['person:lim', 'Can edit']])
})

test('an agent you worked with gets a grant and no email', async () => {
  const room = await session()
  t.sent.length = 0
  const res = await invite(room, { to: { account: 'agent:a1' }, typeId: 'builtin:view' })
  assert.deepEqual([res.status, res.body.invite.name], [200, 'Larry'])
  assert.equal(t.sent.length, 0)
  assert.deepEqual(await grants(room), [['agent:a1', 'View only']])
})

test('only the owner invites, only people they worked with or by email, and only with this session\'s link', async () => {
  const room = await session()
  const notOwner = await invite(room, { to: { email: 'x@y.com' } }, 'lim')
  assert.deepEqual([notOwner.status, notOwner.body.error], [403, 'Only the session owner can invite people.'])
  const stranger = await invite(room, { to: { account: 'person:out' } })
  assert.deepEqual([stranger.status, stranger.body.error], [404, "You can invite people you've worked with, or anyone by email."])
  assert.equal((await invite(room, { to: { account: 'person:mem' } })).body.error, "That's you.")
  assert.equal((await invite(room, { to: { email: 'a@b.c,d@e.f' } })).body.error, "That email doesn't look right.")
  assert.equal((await t.call('POST', `/v1/sessions/${room}/invites`, { to: { email: 'x@y.com' }, typeId: 'builtin:edit', link: link('another-room') }, 'mem')).body.error, "Send this session's invite link.")
  assert.equal((await invite(room, { to: { email: 'x@y.com' }, typeId: 'nope' })).body.error, 'no such access type')
  assert.equal((await invite(room, { to: {} })).status, 400)
})

test('cancelling takes back the grant; used and expired invites show as such', async () => {
  const room = await session()
  const a = (await invite(room, { to: { email: 'pat@example.com' } })).body.invite
  const b = (await invite(room, { to: { account: 'agent:a1' } })).body.invite
  assert.deepEqual((await t.call('DELETE', `/v1/sessions/${room}/invites/${a.id}`, null, 'mem')).body, { ok: true })
  assert.equal((await t.call('DELETE', `/v1/sessions/${room}/invites/${a.id}`, null, 'mem')).status, 409)
  assert.equal((await t.call('DELETE', `/v1/sessions/${room}/invites/not-an-id`, null, 'mem')).status, 404)
  assert.deepEqual(await grants(room), [['agent:a1', 'Can edit']])
  clock += 8 * DAY
  try {
    const list = (await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body.invites
    assert.deepEqual(list.map((i) => [i.id, i.status]).sort(), [[a.id, 'cancelled'], [b.id, 'expired']].sort())
  } finally { clock -= 8 * DAY }
})

test('a failed email keeps the invite and says what to do', async () => {
  const room = await session()
  // The test mailer keeps what it sends in t.sent; make it fail instead.
  const send = t.sent.push
  t.sent.push = () => { throw new Error('smtp down') }
  try {
    const res = await invite(room, { to: { email: 'pat@example.com' } })
    assert.deepEqual([res.status, res.body.error], [502, "The invite was saved, but the email didn't send. Cancel it and invite them again."])
  } finally { t.sent.push = send }
  assert.equal((await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body.invites.length, 1)
})

test('an open invite is found however many invites the session has', async () => {
  const room = await session()
  assert.equal((await invite(room, { to: { email: 'pat@example.com' } })).status, 200)
  // 50 newer invites (straight into the store: the route limits how fast the owner sends).
  for (let i = 0; i < 50; i++) await t.store.createSessionInvite({ room, email: `p${i}@example.com`, typeId: 'builtin:edit', invitedBy: 'person:mem', expiresAt: clock + DAY, at: clock })
  const again = await invite(room, { to: { email: 'pat@example.com' } })
  assert.deepEqual([again.status, again.body.error], [409, 'That address already has an open invite. Cancel it first.'])
})

test('the database refuses a second open invite, which reads as the usual message', async () => {
  const room = await session()
  assert.equal((await invite(room, { to: { email: 'pat@example.com' } })).status, 200)
  await assert.rejects(t.store.createSessionInvite({ room, email: 'pat@example.com', typeId: 'builtin:edit', invitedBy: 'person:mem', expiresAt: clock + DAY, at: clock }), (err) => err.code === '23505')
  // Two requests at once both pass the check; the second insert loses.
  const real = t.store.openSessionInvite
  t.store.openSessionInvite = async () => null
  try {
    const raced = await invite(room, { to: { email: 'pat@example.com' }, typeId: 'builtin:view' })
    assert.deepEqual([raced.status, raced.body.error], [409, 'That address already has an open invite. Cancel it first.'])
  } finally { t.store.openSessionInvite = real }
  assert.deepEqual(await grants(room), [['email:pat@example.com', 'Can edit']], 'the losing request changed nothing')
})

test('an expired invite does not block a new one', async () => {
  const room = await session()
  assert.equal((await invite(room, { to: { email: 'pat@example.com' } })).status, 200)
  clock += 8 * DAY
  try {
    const again = await invite(room, { to: { email: 'pat@example.com' }, typeId: 'builtin:view' })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.deepEqual(await grants(room), [['email:pat@example.com', 'View only']])
  } finally { clock -= 8 * DAY }
})

test('someone who already has access is changed in Session settings, not invited again', async () => {
  const room = await session()
  assert.equal((await t.call('PUT', `/v1/sessions/${room}/grants/person:lim`, { typeId: 'builtin:view' }, 'mem')).status, 200)
  const res = await invite(room, { to: { account: 'person:lim' } })
  assert.deepEqual([res.status, res.body.error], [409, 'They already have access to this session. Change it in Session settings.'])
  assert.deepEqual(await grants(room), [['person:lim', 'View only']], 'their grant is untouched')
})

test('taking away a grant also closes its open invite; only account and email grants can be taken', async () => {
  const room = await session()
  const inv = (await invite(room, { to: { account: 'agent:a1' } })).body.invite
  assert.deepEqual((await t.call('DELETE', `/v1/sessions/${room}/grants/agent:a1`, null, 'mem')).body, { ok: true })
  const list = (await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body.invites
  assert.deepEqual(list.map((i) => [i.id, i.status]), [[inv.id, 'cancelled']])
  // An email invite's grant can be taken away too, which closes that invite.
  const byMail = (await invite(room, { to: { email: 'pat@example.com' } })).body.invite
  assert.deepEqual((await t.call('DELETE', `/v1/sessions/${room}/grants/email:pat@example.com`, null, 'mem')).body, { ok: true })
  assert.equal((await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body.invites.find((i) => i.id === byMail.id).status, 'cancelled')
  assert.equal((await t.call('DELETE', `/v1/sessions/${room}/grants/nonsense`, null, 'mem')).status, 400)
})

test('a grant that fails to save leaves no open invite behind to block inviting them again', async () => {
  const room = await session()
  const real = t.store.putGrant
  t.store.putGrant = async () => { throw new Error('the database is down') }
  let failed
  try { failed = await invite(room, { to: { email: 'pat@example.com' } }) } finally { t.store.putGrant = real }
  assert.equal(failed.status, 500)
  const again = await invite(room, { to: { email: 'pat@example.com' } })
  assert.equal(again.status, 200, JSON.stringify(again.body))
})

test('cancelling never takes a grant another open invite still needs, whatever the timing', async () => {
  const room = await session()
  const a = (await invite(room, { to: { email: 'pat@example.com' } })).body.invite
  // A new invite for Pat lands between the cancel's check and its delete: the store's one
  // conditional delete sees it, and leaves the grant.
  assert.equal(await t.store.cancelSessionInvite(a.id), true)
  const b = await t.store.createSessionInvite({ room, email: 'pat@example.com', typeId: 'builtin:view', invitedBy: 'person:mem', expiresAt: clock + DAY, at: clock })
  await t.store.putGrant({ room, account: 'email:pat@example.com', typeId: 'builtin:view', grantedBy: 'person:mem' })
  assert.equal(await t.store.deleteUnusedGrant(room, 'email:pat@example.com', clock), false)
  assert.deepEqual(await grants(room), [['email:pat@example.com', 'View only']])
  assert.equal(await t.store.cancelSessionInvite(b.id), true)
  assert.equal(await t.store.deleteUnusedGrant(room, 'email:pat@example.com', clock), true)
  assert.deepEqual(await grants(room), [])
})
