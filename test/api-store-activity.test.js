// Session activity in the memory store, the reference for ingest_presence and the
// other functions in 20261002000000_session_activity.sql.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createMemoryStore } from '../src/api/memory-store.js'

const id = () => crypto.randomUUID()
const DAY = 24 * 60 * 60 * 1000
const start = (room, account, at, extra = {}) => ({ id: id(), type: 'start', room, account, name: account.split(':')[1].toUpperCase(), at, ...extra })
const end = (s, at) => ({ id: id(), type: 'end', start: s.id, room: s.room, account: s.account, at })
const named = (room, name, at) => ({ id: id(), type: 'name', room, name, at })

test('starts open visits and ends close them; the first owner start sets the owner', async () => {
  const s = createMemoryStore()
  const a = start('r1', 'person:dana', 1000)
  const b = start('r1', 'person:eli', 1500, { owner: true })
  const c = start('r1', 'person:fay', 1600, { owner: true })
  assert.equal(await s.ingestPresence([a, b, c, end(a, 3000)], 5000), 4)
  const session = await s.sessionByRoom('r1')
  assert.deepEqual({ ...session }, { room: 'r1', name: '', ownerAccount: 'person:eli', createdAt: 1000, lastActiveAt: 3000, renamedAt: null, workspaceId: null, workspaceLinkedBy: null })
  const visits = await s.visitsInRooms(['r1'])
  assert.deepEqual(visits.map((v) => [v.account, v.accountName, v.kind, v.startedAt, v.endedAt]), [
    ['person:dana', 'DANA', 'person', 1000, 3000],
    ['person:eli', 'ELI', 'person', 1500, null],
    ['person:fay', 'FAY', 'person', 1600, null]
  ])
  assert.equal(visits[0].eventStartId, a.id)
})

test('the same event twice applies once, and an end never moves a visit back before its start', async () => {
  const s = createMemoryStore()
  const a = start('r1', 'agent:a1', 1000)
  const e = end(a, 500)
  assert.equal(await s.ingestPresence([a, e], 1), 2)
  assert.equal(await s.ingestPresence([a, e, end(a, 9000)], 2), 1, 'only the new end is applied')
  const [v] = await s.visitsInRooms(['r1'])
  assert.deepEqual([v.kind, v.startedAt, v.endedAt], ['agent', 1000, 1000], 'the first end wins; a visit ends once')
})

test('the relay names a session until the owner renames it', async () => {
  const s = createMemoryStore()
  await s.ingestPresence([start('r1', 'person:me', 1000, { owner: true }), named('r1', 'quilt-site', 1100)], 1)
  assert.equal((await s.sessionByRoom('r1')).name, 'quilt-site')
  const renamed = await s.renameSession('r1', 'Pricing page', 2000)
  assert.deepEqual([renamed.name, renamed.renamedAt], ['Pricing page', 2000])
  await s.ingestPresence([named('r1', 'something else', 3000)], 2)
  assert.equal((await s.sessionByRoom('r1')).name, 'Pricing page')
  assert.equal(await s.renameSession('nope', 'x', 1), null)
})

test('accountSessions: only rooms the account was in, the newest `limit`, plus any active since `since`', async () => {
  const s = createMemoryStore()
  const events = []
  for (let i = 0; i < 5; i++) events.push(start(`r${i}`, 'person:me', 1000 + i * 100))
  events.push(start('theirs', 'person:dana', 5000))
  await s.ingestPresence(events, 1)
  assert.deepEqual((await s.accountSessions('person:me', { since: Infinity, limit: 2 })).map((x) => x.room), ['r4', 'r3'])
  assert.deepEqual((await s.accountSessions('person:me', { since: 1150, limit: 2 })).map((x) => x.room), ['r4', 'r3', 'r2'])
  assert.deepEqual((await s.accountSessions('person:nobody', { since: 0, limit: 10 })), [])
})

test('pruning drops visits that ended before the cutoff, emptied sessions, and old event ids', async () => {
  const s = createMemoryStore()
  const now = 400 * DAY
  const old = start('old', 'person:me', 1 * DAY)
  const kept = start('kept', 'person:me', 2 * DAY) // still open: never pruned
  const recent = start('recent', 'person:me', 390 * DAY)
  await s.ingestPresence([old, end(old, 2 * DAY), kept, recent, end(recent, 391 * DAY)], 1 * DAY)
  await s.pruneActivity({ before: now - 365 * DAY, seenBefore: now - 7 * DAY })
  assert.deepEqual((await s.visitsInRooms(['old', 'kept', 'recent'])).map((v) => v.room), ['kept', 'recent'])
  assert.equal(await s.sessionByRoom('old'), null)
  assert.ok(await s.sessionByRoom('kept'))
  // The event ids are forgotten, so a replay of the old start applies again.
  assert.equal(await s.ingestPresence([old], now), 1)
})

test("deleting an account deletes its visits, its agents' visits, and the sessions it owns", async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' })
  s.addUser('u2', { name: 'Eli' })
  const agent = await s.createAgent({ name: 'Larry', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u1', invitedBy: 'u1' })
  await s.ingestPresence([
    start('owned', 'person:u1', 1000, { owner: true }),
    start('owned', 'person:u2', 1100),
    start('shared', 'person:u2', 1000, { owner: true }),
    start('shared', 'person:u1', 1100),
    start('shared', `agent:${agent.id}`, 1200)
  ], 1)
  await s.deleteUser('u1')
  assert.equal(await s.sessionByRoom('owned'), null)
  assert.deepEqual(await s.visitsInRooms(['owned']), [], "everyone's visits in it go with it")
  assert.deepEqual((await s.visitsInRooms(['shared'])).map((v) => v.account), ['person:u2'])
})
