// Time in sessions: merging visits, overlap with others, and weeks and months in a time zone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { merge, intersect, clip, total, isTimeZone, weekStart, monthStart, summarize, collaborators, myVisits } from '../../src/api/activity.js'

const T = (iso) => Date.parse(iso)
const MIN = 60 * 1000
const HOUR = 60 * MIN
const visit = (room, account, accountName, from, to, kind = account.split(':')[0]) => ({ room, account, accountName, kind, startedAt: T(from), endedAt: to == null ? null : T(to) })
const session = (room, extra = {}) => ({ room, name: room.toUpperCase(), ownerAccount: 'person:me', createdAt: T('2026-10-01T00:00:00Z'), lastActiveAt: T('2026-10-06T00:00:00Z'), renamedAt: null, ...extra })

test('merge joins overlapping and touching intervals and drops empty ones', () => {
  assert.deepEqual(merge([[5, 7], [1, 3], [2, 4], [4, 5], [9, 9], [10, 8]]), [[1, 7]])
  assert.deepEqual(merge([[1, 2], [3, 4]]), [[1, 2], [3, 4]])
  assert.deepEqual(merge([]), [])
})

test('intersect, clip and total', () => {
  assert.deepEqual(intersect([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]])
  assert.deepEqual(intersect([[0, 5]], [[5, 9]]), [], 'touching is not overlapping')
  assert.deepEqual(clip([[0, 10], [20, 30]], 5, 22), [[5, 10], [20, 22]])
  assert.equal(total([[0, 10], [20, 25]]), 15)
})

test('isTimeZone accepts IANA names and refuses anything else', () => {
  for (const tz of ['UTC', 'Europe/Paris', 'America/New_York']) assert.equal(isTimeZone(tz), true, tz)
  for (const tz of ['', 'Mars/Olympus', 'x'.repeat(65), null, 5]) assert.equal(isTimeZone(tz), false, String(tz))
})

test('a week starts on Monday 00:00 and a month on the 1st, in the given time zone', () => {
  // Tuesday 6 October, 23:00 in New York, is already Wednesday in UTC.
  const now = T('2026-10-07T03:00:00Z')
  assert.equal(weekStart(now, 'UTC'), T('2026-10-05T00:00:00Z'))
  assert.equal(weekStart(now, 'America/New_York'), T('2026-10-05T04:00:00Z'))
  // Sunday evening in Los Angeles is Monday in UTC: the week there began six days earlier.
  assert.equal(weekStart(T('2026-10-12T02:00:00Z'), 'America/Los_Angeles'), T('2026-10-05T07:00:00Z'))
  assert.equal(weekStart(T('2026-10-12T02:00:00Z'), 'UTC'), T('2026-10-12T00:00:00Z'))
  // 1 October, 02:00 UTC is still September in Los Angeles.
  assert.equal(monthStart(T('2026-10-01T02:00:00Z'), 'America/Los_Angeles'), T('2026-09-01T07:00:00Z'))
  assert.equal(monthStart(T('2026-10-01T02:00:00Z'), 'Asia/Tokyo'), T('2026-09-30T15:00:00Z'))
  // Across a daylight-saving change (Europe, 25 October): Monday 26 October starts at UTC+1.
  assert.equal(weekStart(T('2026-10-27T12:00:00Z'), 'Europe/Paris'), T('2026-10-25T23:00:00Z'))
})

test('time together is the overlap of my visits and theirs, never counting two connections twice', () => {
  const now = T('2026-10-06T12:00:00Z')
  const visits = [
    // Me on two computers at once: 09:00-11:00 and 10:00-12:00 merge to 09:00-12:00.
    visit('r1', 'person:me', 'Me', '2026-10-06T09:00:00Z', '2026-10-06T11:00:00Z'),
    visit('r1', 'person:me', 'Me', '2026-10-06T10:00:00Z', '2026-10-06T12:00:00Z'),
    // Dana, also on two connections, 08:00-09:30 and 09:15-10:00: 1h together.
    visit('r1', 'person:dana', 'Dana', '2026-10-06T08:00:00Z', '2026-10-06T09:30:00Z'),
    visit('r1', 'person:dana', 'Dana', '2026-10-06T09:15:00Z', '2026-10-06T10:00:00Z'),
    // An agent from 11:30, still there: open visits count up to now.
    visit('r1', 'agent:a1', 'Larry', '2026-10-06T11:30:00Z', null),
    // Eli came after I left: never shown.
    visit('r1', 'person:eli', 'Eli', '2026-10-06T12:00:00Z', null)
  ]
  const out = summarize({ me: 'person:me', sessions: [session('r1')], visits, now, tz: 'UTC' })
  const [s] = out.sessions
  assert.equal(s.myTotalMs, 3 * HOUR)
  assert.equal(s.lastActiveAt, now, 'someone is still there')
  assert.equal(s.mine, true)
  assert.deepEqual(s.owner, { name: 'Me' })
  assert.deepEqual(s.people, [
    { account: 'person:dana', name: 'Dana', kind: 'person', togetherMs: HOUR, lastTogetherAt: T('2026-10-06T10:00:00Z') },
    { account: 'agent:a1', name: 'Larry', kind: 'agent', togetherMs: 30 * MIN, lastTogetherAt: now }
  ])
  // Collaborating: 09:00-10:00 with Dana, 11:30-12:00 with Larry.
  assert.equal(out.totals.collaboratingThisWeek, 90 * MIN)
  assert.deepEqual(out.totals.topCollaborators.map((c) => [c.account, c.ms]), [['person:dana', HOUR], ['agent:a1', 30 * MIN]])
})

test('only sessions I was in, newest first, with the latest names; the week and month cut the totals', () => {
  const now = T('2026-10-07T12:00:00Z') // a Wednesday
  const visits = [
    // Last week (Thursday 1 October): counts for the month, not the week.
    visit('old', 'person:me', 'Me', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z'),
    visit('old', 'person:dana', 'Dana Old', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z'),
    // Last month: counts for neither.
    visit('older', 'person:me', 'Me', '2026-09-20T10:00:00Z', '2026-09-20T15:00:00Z'),
    visit('older', 'person:eli', 'Eli', '2026-09-20T10:00:00Z', '2026-09-20T15:00:00Z'),
    // This week, Monday: 30 minutes with Dana, now named "Dana C".
    visit('new', 'person:me', 'Me', '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'),
    visit('new', 'person:dana', 'Dana C', '2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z'),
    // A session I was never in.
    visit('theirs', 'person:dana', 'Dana C', '2026-10-06T09:00:00Z', '2026-10-06T11:00:00Z')
  ]
  const sessions = [
    session('old', { lastActiveAt: T('2026-10-01T12:00:00Z'), ownerAccount: 'person:dana' }),
    session('older', { lastActiveAt: T('2026-09-20T15:00:00Z'), ownerAccount: null, name: '' }),
    session('new', { lastActiveAt: T('2026-10-05T11:00:00Z') }),
    session('theirs', { lastActiveAt: T('2026-10-06T11:00:00Z'), ownerAccount: 'person:dana' })
  ]
  const out = summarize({ me: 'person:me', sessions, visits, now, tz: 'UTC' })
  assert.deepEqual(out.sessions.map((s) => s.room), ['new', 'old', 'older'])
  assert.deepEqual(out.sessions.map((s) => s.mine), [true, false, false])
  assert.deepEqual(out.sessions[1].owner, { name: 'Dana Old' })
  assert.deepEqual(out.sessions[2], { ...out.sessions[2], name: '', owner: { name: '' } })
  assert.equal(out.totals.collaboratingThisWeek, 30 * MIN)
  assert.deepEqual(out.totals.topCollaborators, [{ account: 'person:dana', name: 'Dana C', kind: 'person', ms: 2 * HOUR + 30 * MIN }])
})

test('the week boundary follows the time zone', () => {
  // Sunday 11 October 23:30 to Monday 00:30 in New York (03:30-04:30 UTC on the 12th).
  const visits = [
    visit('r', 'person:me', 'Me', '2026-10-12T03:30:00Z', '2026-10-12T04:30:00Z'),
    visit('r', 'person:dana', 'Dana', '2026-10-12T03:30:00Z', '2026-10-12T04:30:00Z')
  ]
  const now = T('2026-10-12T12:00:00Z')
  const sessions = [session('r', { lastActiveAt: T('2026-10-12T04:30:00Z') })]
  assert.equal(summarize({ me: 'person:me', sessions, visits, now, tz: 'America/New_York' }).totals.collaboratingThisWeek, 30 * MIN)
  assert.equal(summarize({ me: 'person:me', sessions, visits, now, tz: 'UTC' }).totals.collaboratingThisWeek, HOUR)
})

test('at most 100 sessions and 3 top collaborators', () => {
  const now = T('2026-10-07T12:00:00Z')
  const sessions = []
  const visits = []
  for (let i = 0; i < 105; i++) {
    const room = `r${i}`
    sessions.push(session(room, { lastActiveAt: now - i * MIN }))
    visits.push(visit(room, 'person:me', 'Me', '2026-10-07T10:00:00Z', '2026-10-07T11:00:00Z'))
    visits.push(visit(room, `person:p${i % 5}`, `P${i % 5}`, '2026-10-07T10:00:00Z', `2026-10-07T10:${String(10 + (i % 5) * 10).padStart(2, '0')}:00Z`))
  }
  const out = summarize({ me: 'person:me', sessions, visits, now, tz: 'UTC' })
  assert.equal(out.sessions.length, 100)
  assert.equal(out.sessions[0].room, 'r0')
  assert.deepEqual(out.totals.topCollaborators.map((c) => c.account), ['person:p4', 'person:p3', 'person:p2'])
})

test('collaborators: everyone I overlapped with, most recent first; my visits newest first', () => {
  const sessions = [
    { people: [{ account: 'person:a', name: 'A', kind: 'person', togetherMs: 1, lastTogetherAt: 10 }, { account: 'agent:b', name: 'B', kind: 'agent', togetherMs: 1, lastTogetherAt: 30 }] },
    { people: [{ account: 'person:a', name: 'A2', kind: 'person', togetherMs: 1, lastTogetherAt: 20 }] }
  ]
  assert.deepEqual(collaborators(sessions), [
    { account: 'agent:b', name: 'B', kind: 'agent', lastTogetherAt: 30 },
    { account: 'person:a', name: 'A2', kind: 'person', lastTogetherAt: 20 }
  ])
  const visits = Array.from({ length: 25 }, (_, i) => ({ room: 'r', account: i === 3 ? 'person:x' : 'person:me', startedAt: i, endedAt: i === 24 ? null : i + 1 }))
  const mine = myVisits({ me: 'person:me', visits })
  assert.equal(mine.length, 20)
  assert.deepEqual(mine[0], { startedAt: 24, endedAt: null })
  assert.equal(mine.some((v) => v.startedAt === 3), false)
})
