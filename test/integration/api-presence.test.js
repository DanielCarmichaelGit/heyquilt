// POST /v1/relay/presence: the relay reports who is in which session, and when.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi } from '../helpers/api-helpers.js'

const SECRET = 'test-relay-secret-0123456789'
const T = (iso) => Date.parse(iso)
let clock = T('2026-10-07T12:00:00Z')
let t
before(async () => { t = await startTestApi({ relaySecret: SECRET, now: () => clock }) })
after(() => t.close())
beforeEach(() => { clock = T('2026-10-07T12:00:00Z') })

let rooms = 0
const room = () => `pres-${++rooms}`
const report = (events, secret = SECRET) => t.call('POST', '/v1/relay/presence', { events }, null, secret === null ? {} : { authorization: `Bearer ${secret}` })
const start = (r, account, name, at, extra = {}) => ({ id: crypto.randomUUID(), type: 'start', room: r, account, name, at: T(at), ...extra })
const end = (s, at) => ({ id: crypto.randomUUID(), type: 'end', start: s.id, room: s.room, account: s.account, at: T(at) })
const named = (r, name, at) => ({ id: crypto.randomUUID(), type: 'name', room: r, name, at: T(at) })

test('only the relay, with RELAY_API_SECRET, may report presence', async () => {
  assert.equal((await report([], null)).status, 401)
  assert.equal((await report([], 'wrong')).status, 401)
  assert.equal((await report([], `${SECRET}x`)).status, 401)
  assert.deepEqual((await report([])).body, { ok: true, applied: 0, skipped: 0 })
  const off = await startTestApi()
  try {
    const r = await off.call('POST', '/v1/relay/presence', { events: [] }, null, { authorization: `Bearer ${SECRET}` })
    assert.equal(r.status, 503)
  } finally { await off.close() }
})

test('a report takes up to 500 events (more than the usual body limit), skips bad ones, and ignores replays', async () => {
  const r = room()
  const many = Array.from({ length: 500 }, (_, i) => start(r, `person:p${i}`, `Person ${i}`, '2026-10-07T10:00:00Z'))
  const first = await report(many)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.applied, 500)
  assert.equal((await report(many)).body.applied, 0, 'the same events again change nothing')
  assert.equal((await t.store.visitsInRooms([r])).length, 500)
  assert.equal((await report([...many, many[0]])).status, 413)
  const bad = [
    { ...start(r, 'person:x', 'X', '2026-10-07T10:00:00Z'), id: 'not-a-uuid' },
    start('bad room!', 'person:x', 'X', '2026-10-07T10:00:00Z'),
    start(r, 'robot:x', 'X', '2026-10-07T10:00:00Z'),
    start(r, 'person:x', 'X', '2025-09-01T00:00:00Z'), // older than 12 months
    named(r, '', '2026-10-07T10:00:00Z'),
    named(r, 'x'.repeat(81), '2026-10-07T10:00:00Z'),
    { id: crypto.randomUUID(), type: 'wave', room: r, at: clock },
    null
  ]
  assert.deepEqual((await report(bad)).body, { ok: true, applied: 0, skipped: 8 })
  assert.equal((await report({ not: 'a list' })).status, 400)
})

test('visits open and close, the owner is the first owner start, and the relay names the session', async () => {
  const r = room()
  const mo = start(r, 'person:mem', 'Mo', '2026-10-07T09:00:00Z', { owner: true })
  const ada = start(r, 'person:admin', '  Ada‮  ', '2026-10-07T09:30:00Z')
  const late = start(r, 'person:lim', 'Lin', '2026-10-07T09:40:00Z', { owner: true })
  // The relay's clock may run ahead of the API's: nothing is recorded in the future.
  await report([mo, ada, late, end(ada, '2026-10-07T10:30:00Z'), named(r, 'quilt-site', '2026-10-07T09:01:00Z'), end(late, '2026-10-07T13:00:00Z')])
  const s = await t.store.sessionByRoom(r)
  assert.deepEqual([s.name, s.ownerAccount, s.createdAt, s.lastActiveAt], ['quilt-site', 'person:mem', T('2026-10-07T09:00:00Z'), clock])
  const visits = await t.store.visitsInRooms([r])
  assert.deepEqual(visits.map((v) => [v.account, v.accountName, v.endedAt]), [
    ['person:mem', 'Mo', null],
    ['person:admin', 'Ada', T('2026-10-07T10:30:00Z')],
    ['person:lim', 'Lin', clock]
  ])
})

test('visits that ended over 12 months ago are deleted once a day, when the relay reports', async () => {
  const r = room()
  const s = start(r, 'person:lim', 'Lin', '2026-10-21T10:00:00Z')
  clock = T('2027-10-20T12:00:00Z') // over a day since the last prune: this report prunes
  await report([s, end(s, '2026-10-21T11:00:00Z')])
  assert.equal((await t.store.visitsInRooms([r])).length, 1, 'ended less than 12 months ago')
  clock = T('2027-10-21T11:30:00Z') // over 12 months now, but the last prune was under a day ago
  await report([])
  assert.equal((await t.store.visitsInRooms([r])).length, 1)
  clock = T('2027-10-21T12:00:00Z')
  await report([])
  assert.deepEqual(await t.store.visitsInRooms([r]), [])
  assert.equal(await t.store.sessionByRoom(r), null, 'and the session, now empty')
})

test('deleting an account deletes its visits and the sessions it owns', async () => {
  const r = room()
  const shared = room()
  t.store.addUser('gone', { name: 'Gwen', email: 'gwen@else.com' })
  await report([
    start(r, 'person:gone', 'Gwen', '2026-10-07T08:00:00Z', { owner: true }),
    start(r, 'person:lim', 'Lin', '2026-10-07T08:00:00Z'),
    start(shared, 'person:lim', 'Lin', '2026-10-07T08:00:00Z', { owner: true }),
    start(shared, 'person:gone', 'Gwen', '2026-10-07T08:00:00Z')
  ])
  assert.equal((await t.call('DELETE', '/v1/me/account', null, 'gone')).status, 200)
  assert.equal(await t.store.sessionByRoom(r), null, 'her session is gone, for everyone')
  assert.deepEqual((await t.store.visitsInRooms([r, shared])).map((v) => v.account), ['person:lim'])
})
