// Reading session activity: GET /v1/me/sessions, one session, renaming, and collaborators.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi, linkDevice, makeAgent } from '../helpers/api-helpers.js'

const SECRET = 'test-relay-secret-0123456789'
const T = (iso) => Date.parse(iso)
const MIN = 60 * 1000
const HOUR = 60 * MIN
let clock = T('2026-10-07T12:00:00Z') // a Wednesday
let t
before(async () => { t = await startTestApi({ relaySecret: SECRET, now: () => clock }) })
after(() => t.close())
beforeEach(() => { clock = T('2026-10-07T12:00:00Z') })

let rooms = 0
const room = () => `sess-${++rooms}`
const report = (events) => t.call('POST', '/v1/relay/presence', { events }, null, { authorization: `Bearer ${SECRET}` })
const start = (r, account, name, at, extra = {}) => ({ id: crypto.randomUUID(), type: 'start', room: r, account, name, at: T(at), ...extra })
const end = (s, at) => ({ id: crypto.randomUUID(), type: 'end', start: s.id, room: s.room, account: s.account, at: T(at) })
const sessions = (userId, tz) => t.call('GET', `/v1/me/sessions${tz ? `?tz=${encodeURIComponent(tz)}` : ''}`, null, userId)
const sessionOf = async (userId, r) => (await sessions(userId)).body.sessions.find((s) => s.room === r)

test('my time, time together and the totals; open visits count up to now', async () => {
  const r = room()
  const me = start(r, 'person:mem', 'Mo', '2026-10-07T09:00:00Z', { owner: true })
  const ada = start(r, 'person:admin', 'Ada', '2026-10-07T09:30:00Z')
  const bot = start(r, 'agent:a1', 'Larry', '2026-10-07T11:00:00Z')
  await report([me, ada, bot, end(ada, '2026-10-07T10:30:00Z'), { id: crypto.randomUUID(), type: 'name', room: r, name: 'quilt-site', at: T('2026-10-07T09:01:00Z') }])
  const res = await sessions('mem')
  assert.equal(res.status, 200)
  const s = res.body.sessions.find((x) => x.room === r)
  assert.deepEqual([s.name, s.owner, s.mine, s.myTotalMs, s.lastActiveAt], ['quilt-site', { name: 'Mo' }, true, 3 * HOUR, clock])
  assert.deepEqual(s.people, [
    { account: 'person:admin', name: 'Ada', kind: 'person', togetherMs: HOUR, lastTogetherAt: T('2026-10-07T10:30:00Z') },
    { account: 'agent:a1', name: 'Larry', kind: 'agent', togetherMs: HOUR, lastTogetherAt: clock }
  ])
  assert.equal(res.body.totals.collaboratingThisWeek, 2 * HOUR)
  assert.deepEqual(res.body.totals.topCollaborators.map((c) => [c.account, c.ms]), [['person:admin', HOUR], ['agent:a1', HOUR]])
  const hers = await sessionOf('admin', r)
  assert.deepEqual([hers.mine, hers.myTotalMs, hers.people.map((p) => p.account)], [false, HOUR, ['person:mem']], 'Larry came after Ada left')
})

test('you see only sessions you were in, and only people who overlapped with you', async () => {
  const r = room()
  const olive = start(r, 'person:owner', 'Olive', '2026-10-07T08:00:00Z', { owner: true })
  await report([
    olive,
    start(r, 'person:lim', 'Lin', '2026-10-07T09:00:00Z'),
    end(olive, '2026-10-07T08:30:00Z'),
    start(r, 'person:mem', 'Mo', '2026-10-07T08:00:00Z')
  ])
  assert.deepEqual((await sessionOf('owner', r)).people.map((p) => p.name), ['Mo'], 'Lin came after Olive left')
  assert.equal(await sessionOf('out', r), undefined, 'Otto was never there')
  assert.equal((await t.call('GET', `/v1/me/sessions/${r}`, null, 'out')).status, 404)
  assert.equal((await t.call('GET', '/v1/me/sessions/no-such-room', null, 'owner')).status, 404)
  assert.equal((await t.call('GET', '/v1/me/sessions/bad%20room', null, 'owner')).status, 404)
  assert.equal((await t.call('GET', '/v1/me/sessions', null, null)).status, 401)
})

test('the week starts on Monday in the time zone the website passes', async () => {
  // Sunday 11 October, 23:00 to Monday 01:00 in New York; asked on Monday at noon.
  clock = T('2026-10-12T16:00:00Z')
  const r = room()
  await report([
    start(r, 'person:gm', 'Gee', '2026-10-12T03:00:00Z'),
    start(r, 'person:unconf', 'Una', '2026-10-12T03:00:00Z')
  ].flatMap((s) => [s, end(s, '2026-10-12T05:00:00Z')]))
  assert.equal((await sessions('gm', 'America/New_York')).body.totals.collaboratingThisWeek, HOUR)
  assert.equal((await sessions('gm')).body.totals.collaboratingThisWeek, 2 * HOUR, 'UTC by default')
  assert.deepEqual((await sessions('gm', 'America/New_York')).body.totals.topCollaborators, [{ account: 'person:unconf', name: 'Una', kind: 'person', ms: 2 * HOUR }])
  const bad = await sessions('gm', 'Mars/Olympus')
  assert.deepEqual([bad.status, bad.body.error], [400, 'tz must be an IANA time zone, like Europe/London'])
})

test('one session: the same details, plus my last 20 visits', async () => {
  const r = room()
  const visits = []
  for (let i = 0; i < 22; i++) {
    const s = { ...start(r, 'person:lim', 'Lin', '2026-10-06T00:00:00Z'), at: T('2026-10-06T00:00:00Z') + i * HOUR }
    visits.push(s, { ...end(s, '2026-10-06T00:00:00Z'), at: s.at + 30 * MIN })
  }
  await report(visits)
  const res = await t.call('GET', `/v1/me/sessions/${r}`, null, 'lim')
  assert.equal(res.status, 200)
  assert.deepEqual([res.body.session.room, res.body.session.myTotalMs, res.body.session.createdAt], [r, 22 * 30 * MIN, T('2026-10-06T00:00:00Z')])
  assert.equal(res.body.session.visits.length, 20)
  assert.deepEqual(res.body.session.visits[0], { startedAt: T('2026-10-06T21:00:00Z'), endedAt: T('2026-10-06T21:30:00Z') })
})

test('only the owner renames, from the website or a linked computer; the relay never undoes it', async () => {
  const r = room()
  await report([
    start(r, 'person:owner', 'Olive', '2026-10-07T08:00:00Z', { owner: true }),
    start(r, 'person:admin', 'Ada', '2026-10-07T08:30:00Z'),
    { id: crypto.randomUUID(), type: 'name', room: r, name: 'folder-name', at: T('2026-10-07T08:01:00Z') }
  ])
  const rename = (userId, name, headers) => t.call('PUT', `/v1/me/sessions/${r}`, { name }, userId, headers)
  const notOwner = await rename('admin', 'Mine now')
  assert.deepEqual([notOwner.status, notOwner.body.error], [403, 'Only the session owner can rename it.'])
  assert.equal((await rename('out', 'Mine now')).status, 404)
  for (const bad of ['   ', 'a\nb', 'x'.repeat(81)]) {
    const res = await rename('owner', bad)
    assert.deepEqual([res.status, res.body.error], [400, 'Give the session a name of 1 to 80 characters.'], JSON.stringify(bad))
  }
  assert.deepEqual((await rename('owner', '  Pricing page  ')).body, { session: { room: r, name: 'Pricing page' } })
  assert.equal((await sessionOf('admin', r)).name, 'Pricing page', 'everyone sees it')
  await report([{ id: crypto.randomUUID(), type: 'name', room: r, name: 'folder-name', at: clock }])
  assert.equal((await sessionOf('owner', r)).name, 'Pricing page')
  const { token } = await linkDevice(t, 'owner')
  const fromApp = await t.call('PUT', `/v1/me/sessions/${r}`, { name: 'From the app' }, null, { authorization: `Bearer ${token}` })
  assert.equal(fromApp.status, 200)
  assert.equal((await sessionOf('owner', r)).name, 'From the app')
})

test('collaborators: people and agents you overlapped with, most recent first, with a computer token too', async () => {
  const r1 = room()
  const r2 = room()
  const { agent } = await makeAgent(t, { name: 'Larry', ownerUserId: 'out', invitedBy: 'out' })
  await report([
    start(r1, 'person:out', 'Otto', '2026-10-07T08:00:00Z', { owner: true }),
    start(r1, 'person:mem', 'Mo', '2026-10-07T08:00:00Z'),
    start(r2, 'person:out', 'Otto', '2026-10-06T08:00:00Z'),
    start(r2, `agent:${agent.id}`, 'Larry', '2026-10-06T08:00:00Z')
  ].flatMap((s) => [s, end(s, s.room === r1 ? '2026-10-07T09:00:00Z' : '2026-10-06T09:00:00Z')]))
  const { token } = await linkDevice(t, 'out')
  const res = await t.call('GET', '/v1/me/collaborators', null, null, { authorization: `Bearer ${token}` })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.collaborators, [
    { account: 'person:mem', name: 'Mo', kind: 'person', lastTogetherAt: T('2026-10-07T09:00:00Z') },
    { account: `agent:${agent.id}`, name: 'Larry', kind: 'agent', lastTogetherAt: T('2026-10-06T09:00:00Z') }
  ])
  assert.equal((await t.call('GET', '/v1/me/collaborators', null, null, { authorization: 'Bearer qd_nope' })).status, 401)
})
